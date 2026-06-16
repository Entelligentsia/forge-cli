// Stream idle-timeout + retry wrapper around the per-turn model call (`streamFn`).
//
// Motivation: on the uncached ollama-cloud rail, the streaming endpoint
// intermittently goes silent mid-request — the HTTP connection stays open but no
// tokens arrive, and pi has no idle timeout, so the agent loop hangs forever
// (observed: 2–6 min stalls on deep git fix-bug contexts). This wraps the Agent's
// streamFn so a silent stream is detected and retried.
//
// Safety invariant: we retry ONLY when no event has been delivered yet
// (time-to-first-token stall — the common case). Once any delta has flowed to the
// consumer we never restart (that would duplicate/corrupt output); instead we fail
// the turn with a terminal error event, which the agent loop / forge recovery
// handles cleanly.
//
// Gated by FORGE_STREAM_IDLE_MS (off when 0/unset) — no behaviour change otherwise.

import type { StreamFn } from "@earendil-works/pi-agent-core";

const IDLE = Symbol("idle");

export interface IdleTimeoutOptions {
	/** No stream event within this many ms ⇒ considered stalled. */
	idleMs: number;
	/** Max retries for pre-first-token stalls. */
	maxRetries: number;
	/** Optional diagnostic sink. */
	log?: (message: string) => void;
}

/**
 * Minimal drop-in for pi-ai's AssistantMessageEventStream — async-iterable plus a
 * `result()` promise. Mirrors its completion semantics: a `done` event resolves the
 * result to `event.message`, an `error` event to `event.error`. Hand-rolled to keep
 * full control of the failure path and avoid a deep import into pi-ai internals.
 */
class ProxyEventStream {
	private queue: unknown[] = [];
	private waiting: Array<(r: IteratorResult<unknown>) => void> = [];
	private done = false;
	private resolveFinal!: (v: unknown) => void;
	private readonly finalResult: Promise<unknown>;

	constructor() {
		this.finalResult = new Promise((res) => {
			this.resolveFinal = res;
		});
	}

	push(event: { type?: string; message?: unknown; error?: unknown }): void {
		if (this.done) return;
		if (event?.type === "done") {
			this.done = true;
			this.resolveFinal(event.message);
		} else if (event?.type === "error") {
			this.done = true;
			this.resolveFinal(event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	/** Terminate iteration without a terminal event (abnormal-end safety net). */
	end(): void {
		this.done = true;
		while (this.waiting.length > 0) {
			const w = this.waiting.shift();
			w?.({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const r = await new Promise<IteratorResult<unknown>>((res) => this.waiting.push(res));
				if (r.done) return;
				yield r.value;
			}
		}
	}

	result(): Promise<unknown> {
		return this.finalResult;
	}
}

/** Build the terminal `error` AssistantMessage the agent loop treats as a failed turn. */
function synthErrorEvent(model: unknown, errorMessage: string): { type: "error"; error: unknown } {
	const m = model as { api?: unknown; provider?: unknown; id?: string; model?: string };
	return {
		type: "error",
		error: {
			role: "assistant",
			content: [],
			api: m?.api,
			provider: m?.provider,
			model: m?.id ?? m?.model ?? "unknown",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		},
	};
}

/**
 * Wrap a streamFn so each per-turn model stream is guarded by an idle watchdog with
 * bounded retries. The returned function has the same (model, context, options)
 * signature and returns the same async-iterable + result() shape.
 */
export function wrapStreamFnWithIdleTimeout(inner: StreamFn, opts: IdleTimeoutOptions): StreamFn {
	const { idleMs, maxRetries, log } = opts;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return ((model: any, context: any, options: any) => {
		const out = new ProxyEventStream();
		void (async () => {
			let attempt = 0;
			for (;;) {
				const ac = new AbortController();
				const callerSignal: AbortSignal | undefined = options?.signal;
				const onAbort = () => ac.abort();
				if (callerSignal) {
					if (callerSignal.aborted) ac.abort();
					else callerSignal.addEventListener("abort", onAbort, { once: true });
				}
				let sawEvent = false;
				let stalled = false;
				try {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const stream: any = await inner(model, context, { ...options, signal: ac.signal });
					const it = stream[Symbol.asyncIterator]();
					for (;;) {
						let timer: ReturnType<typeof setTimeout> | undefined;
						const idle = new Promise<typeof IDLE>((res) => {
							timer = setTimeout(() => res(IDLE), idleMs);
						});
						let r: IteratorResult<unknown> | typeof IDLE;
						try {
							r = await Promise.race([it.next(), idle]);
						} finally {
							if (timer) clearTimeout(timer);
						}
						if (r === IDLE) {
							stalled = true;
							break;
						}
						if (r.done) {
							out.end();
							return;
						}
						sawEvent = true;
						out.push(r.value as { type?: string });
						const t = (r.value as { type?: string })?.type;
						if (t === "done" || t === "error") return; // terminal forwarded
					}
				} catch {
					stalled = true; // inner threw (network/abort) — treat as a stall
				} finally {
					if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
				}
				ac.abort(); // cancel the stalled underlying request
				if (stalled && !sawEvent && attempt < maxRetries && !callerSignal?.aborted) {
					attempt++;
					log?.(`idle ${idleMs}ms before first token — retry ${attempt}/${maxRetries}`);
					continue;
				}
				if (callerSignal?.aborted) {
					out.end();
					return;
				}
				log?.(`stream failed (sawEvent=${sawEvent}, attempts=${attempt}) — failing turn`);
				out.push(synthErrorEvent(model, `forge stream idle timeout after ${idleMs}ms`));
				return;
			}
		})();
		return out as unknown as ReturnType<StreamFn>;
	}) as StreamFn;
}
