import { describe, expect, it } from "vitest";
import { wrapStreamFnWithIdleTimeout } from "../../../src/extensions/forgecli/stream-resilience.js";

const delta = { type: "text-delta", text: "x" };
const done = (msg = "ok") => ({ type: "done", message: { role: "assistant", content: [{ type: "text", text: msg }] } });

// healthy stream: yields all events then completes
function healthy(events: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const e of events) yield e;
		},
		result: () => Promise.resolve(events.find((e) => (e as { type?: string }).type === "done")),
	};
}
// stalling stream: yields `before` events, then next() hangs forever (silent stall)
function stalling(before: unknown[]) {
	let i = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (i < before.length) return Promise.resolve({ value: before[i++], done: false });
					return new Promise<never>(() => {});
				},
			};
		},
		result: () => new Promise<never>(() => {}),
	};
}

async function collect(stream: AsyncIterable<unknown>, max = 12): Promise<Array<{ type?: string; error?: { stopReason?: string } }>> {
	const out: Array<{ type?: string }> = [];
	for await (const e of stream) {
		out.push(e as { type?: string });
		if (out.length >= max) break;
	}
	return out;
}

// biome-ignore lint/suspicious/noExplicitAny: test doubles for the streamFn seam
const run = (inner: any, opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	collect((wrapStreamFnWithIdleTimeout(inner, opts) as any)({}, {}, {}) as AsyncIterable<unknown>);

describe("wrapStreamFnWithIdleTimeout", () => {
	it("forwards a healthy stream unchanged", async () => {
		const evs = await run(() => healthy([delta, delta, done()]), { idleMs: 1000, maxRetries: 2 });
		expect(evs.map((e) => e.type)).toEqual(["text-delta", "text-delta", "done"]);
	});

	it("retries a pre-first-token stall, then succeeds on the retry", async () => {
		let call = 0;
		const evs = await run(
			() => {
				call++;
				return call === 1 ? stalling([]) : healthy([delta, done()]);
			},
			{ idleMs: 30, maxRetries: 3 },
		);
		expect(call).toBe(2); // one retry
		expect(evs.map((e) => e.type)).toEqual(["text-delta", "done"]);
	});

	it("does NOT retry once a token has flowed; fails the turn with a terminal error", async () => {
		let call = 0;
		const evs = await run(
			() => {
				call++;
				return stalling([delta]); // one delta, then silent
			},
			{ idleMs: 30, maxRetries: 3 },
		);
		expect(call).toBe(1); // no restart after partial output (no corruption)
		expect(evs[0].type).toBe("text-delta");
		expect(evs.at(-1)?.type).toBe("error");
		expect(evs.at(-1)?.error?.stopReason).toBe("error");
	});

	it("fails with an error event after exhausting retries on a persistent stall", async () => {
		let call = 0;
		const evs = await run(
			() => {
				call++;
				return stalling([]);
			},
			{ idleMs: 20, maxRetries: 2 },
		);
		expect(call).toBe(3); // initial + 2 retries
		expect(evs.at(-1)?.type).toBe("error");
	});
});
