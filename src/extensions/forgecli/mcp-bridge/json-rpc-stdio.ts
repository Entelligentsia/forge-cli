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
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
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

	/** Send a request and await its result. Rejects on error / timeout / exit. */
	request(method: string, params?: unknown): Promise<unknown> {
		if (!this.child) return Promise.reject(new Error("client not started"));
		if (this.exited) {
			return Promise.reject(this.exitError ?? new Error("client closed"));
		}
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`request "${method}" timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			// Don't let a pending timer hold the process open.
			(timer as { unref?: () => void }).unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.child!.stdin.write(payload, (err) => {
				if (err) {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(err);
				}
			});
		});
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
		// Notifications / server-initiated messages carry no id we issued.
		if (msg.id === undefined || msg.id === null) return;
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
