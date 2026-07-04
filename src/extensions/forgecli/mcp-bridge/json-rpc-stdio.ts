// Generic newline-delimited JSON-RPC 2.0 stdio client (FORGE-S34 — grove bridge).
//
// A minimal client for talking to a child process that speaks JSON-RPC 2.0 over
// stdio with one JSON object per line (the framing MCP stdio servers use — see
// grove's `serve` mode). This is transport only: it knows nothing about MCP
// methods. mcp-session.ts layers MCP semantics (initialize / tools/list /
// tools/call) on top.
//
// Iron Law 6: the child is spawned with an explicit argv array — never a shell
// string. Iron Law 7: every failure rejects a pending request or surfaces on a
// listener; nothing is swallowed.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcStdioOptions {
	/** Executable to spawn (resolved against PATH by child_process). */
	command: string;
	/** Argument vector — never a shell string. */
	args: string[];
	/** Working directory for the child. */
	cwd?: string;
	/** Extra environment; merged over process.env. */
	env?: NodeJS.ProcessEnv;
	/** Per-request timeout in ms (default 15000). */
	requestTimeoutMs?: number;
	/** Called once if the child exits (for any reason). */
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
	/** Called for each stderr chunk (diagnostics). */
	onStderr?: (chunk: string) => void;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number | string | null;
	/** Present on server-initiated notifications (e.g. notifications/progress). */
	method?: string;
	/** Notification payload — for progress: `{ progressToken, progress, ... }`. */
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

/** Payload of an MCP `notifications/progress` message. */
export interface ProgressNotification {
	progressToken: number | string;
	progress?: number;
	total?: number;
	message?: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Method name, for the timeout diagnostic. */
	method: string;
	/** Invoked for each `notifications/progress` carrying this request's token. */
	onProgress?: (p: ProgressNotification) => void;
	/**
	 * Restart the inactivity timer. Called when a `notifications/progress` for
	 * this request arrives, so a long server-side operation that keeps reporting
	 * liveness is never killed by the flat deadline (grove's delegated explore
	 * runs a multi-turn local-LLM loop that far exceeds a single request window).
	 */
	reset: () => void;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * A live JSON-RPC 2.0 session over a child process's stdio.
 *
 * Lifecycle: construct → start() → request()/notify()* → close().
 * A crashed or exited child rejects all in-flight requests so callers never
 * hang. `start()` is idempotent-guarded (throws if called twice).
 */
export class JsonRpcStdioClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private stdoutBuf = "";
	private exited = false;
	private exitError: Error | null = null;
	private readonly timeoutMs: number;

	constructor(private readonly opts: JsonRpcStdioOptions) {
		this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Spawn the child and begin reading responses. */
	start(): void {
		if (this.child) throw new Error("JsonRpcStdioClient already started");
		const child = spawn(this.opts.command, this.opts.args, {
			cwd: this.opts.cwd,
			env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.child = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.opts.onStderr?.(chunk));

		child.on("error", (err: Error) => this.fail(err));
		child.on("exit", (code, signal) => {
			this.exited = true;
			if (!this.exitError) {
				this.exitError = new Error(
					`process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
				);
			}
			this.rejectAll(this.exitError);
			this.opts.onExit?.(code, signal);
		});

		// Never keep the event loop alive on the bridge's account, and make a
		// best-effort kill if the parent exits without an explicit close().
		child.unref?.();
		process.once("exit", () => {
			try {
				child.kill();
			} catch {
				/* parent is exiting anyway */
			}
		});
	}

	/**
	 * Send a request and await its result. Rejects on error / timeout / exit.
	 * `onProgress`, if given, fires for each `notifications/progress` the server
	 * emits for this request (and each one also resets the inactivity timer).
	 */
	request(
		method: string,
		params?: unknown,
		onProgress?: (p: ProgressNotification) => void,
	): Promise<unknown> {
		if (!this.child) return Promise.reject(new Error("client not started"));
		if (this.exited) {
			return Promise.reject(this.exitError ?? new Error("client closed"));
		}
		const id = this.nextId++;
		// Opt into MCP progress: servers emit `notifications/progress` keyed off
		// this token. We use the request id itself so a progress notification maps
		// straight back to its pending entry. Without a token grove never emits
		// progress and a long delegated call dies at the flat deadline.
		const withMeta = this.withProgressToken(params, id);
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: withMeta }) + "\n";
		return new Promise<unknown>((resolve, reject) => {
			const pending: Pending = {
				resolve,
				reject,
				method,
				onProgress,
				timer: undefined as unknown as ReturnType<typeof setTimeout>,
				reset: () => {
					clearTimeout(pending.timer);
					pending.timer = setTimeout(() => {
						this.pending.delete(id);
						reject(
							new Error(
								`request "${method}" timed out after ${this.timeoutMs}ms without activity`,
							),
						);
					}, this.timeoutMs);
					// Don't let a pending timer hold the process open.
					(pending.timer as { unref?: () => void }).unref?.();
				},
			};
			pending.reset();
			this.pending.set(id, pending);
			this.child!.stdin.write(payload, (err) => {
				if (err) {
					this.pending.delete(id);
					clearTimeout(pending.timer);
					reject(err);
				}
			});
		});
	}

	/**
	 * Return a shallow copy of `params` with `_meta.progressToken` set to `token`,
	 * without mutating the caller's object. MCP reserves `params._meta` for this;
	 * servers that don't emit progress simply ignore it.
	 */
	private withProgressToken(params: unknown, token: number): unknown {
		const base =
			params && typeof params === "object" ? (params as Record<string, unknown>) : {};
		const meta =
			base._meta && typeof base._meta === "object"
				? (base._meta as Record<string, unknown>)
				: {};
		return { ...base, _meta: { ...meta, progressToken: token } };
	}

	/** Fire-and-forget notification (no id, no response expected). */
	notify(method: string, params?: unknown): void {
		if (!this.child || this.exited) return;
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		this.child.stdin.write(payload);
	}

	/** Close stdin and terminate the child; rejects any stragglers. */
	async close(): Promise<void> {
		const child = this.child;
		if (!child || this.exited) {
			this.rejectAll(new Error("client closed"));
			return;
		}
		this.rejectAll(new Error("client closed"));
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			try {
				child.stdin.end();
				child.kill();
			} catch {
				resolve();
			}
			// Hard backstop so close() never hangs.
			const t = setTimeout(() => resolve(), 2000);
			(t as { unref?: () => void }).unref?.();
		});
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line.length === 0) continue;
			this.dispatch(line);
		}
	}

	private dispatch(line: string): void {
		let msg: JsonRpcResponse;
		try {
			msg = JSON.parse(line) as JsonRpcResponse;
		} catch {
			// Non-JSON line (a server log to stdout); ignore.
			return;
		}
		// Notifications / server-initiated messages carry no id we issued — a
		// progress notification refreshes its request's inactivity timer.
		if (msg.id === undefined || msg.id === null) {
			this.onNotification(msg);
			return;
		}
		if (typeof msg.id !== "number") return;
		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);
		clearTimeout(pending.timer);
		if (msg.error) {
			pending.reject(
				new Error(
					`JSON-RPC error ${msg.error.code ?? ""}: ${msg.error.message ?? "unknown error"}`.trim(),
				),
			);
			return;
		}
		pending.resolve(msg.result);
	}

	/**
	 * Handle a server-initiated notification. Only `notifications/progress` is
	 * actioned: it restarts the inactivity timer of the request whose
	 * `progressToken` it carries (the request id we assigned), turning the flat
	 * request deadline into an idle timeout that survives long, live operations.
	 */
	private onNotification(msg: JsonRpcResponse): void {
		if (msg.method !== "notifications/progress") return;
		const params = msg.params as ProgressNotification | undefined;
		const token = params?.progressToken;
		if (typeof token !== "number") return;
		const pending = this.pending.get(token);
		if (!pending) return;
		pending.reset();
		if (params) pending.onProgress?.(params);
	}

	private fail(err: Error): void {
		if (!this.exitError) this.exitError = err;
		this.rejectAll(err);
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}
