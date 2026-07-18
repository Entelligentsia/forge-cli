// Unit tests for ask-broker — the subagent→orchestrator-TUI bridge.
//
// Coverage:
//   binding:
//     1. isBound false initially; bind → true; unbind → false
//     2. refcounted: overlapping binds stay bound until the last unbind
//     3. withUI binds for the duration and releases on return
//     4. withUI releases on throw
//   ask:
//     5. throws when no UI is bound (Iron Law 7 — never silent default)
//     6. confirm routes to bound UI → "Y" / "N"
//     7. choice routes to bound UI → selected value
//     8. text routes to bound UI → entered value
//     9. cancellation (UI returns undefined) → { ok: false }
//    10. pre-aborted signal → { ok: false } without touching the UI
//    11. concurrent asks are serialised — one dialog at a time, in order

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskBroker } from "../../../src/extensions/forgecli/ask-broker.js";
import type { AskUI } from "../../../src/extensions/forgecli/ask-user-render.js";

function makeUI(overrides?: Partial<AskUI>): AskUI {
	return {
		confirm: overrides?.confirm ?? vi.fn().mockResolvedValue(true),
		select: overrides?.select ?? vi.fn().mockResolvedValue(undefined),
		input: overrides?.input ?? vi.fn().mockResolvedValue(undefined),
		notify: overrides?.notify ?? vi.fn(),
	} as unknown as AskUI;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AskBroker", () => {
	beforeEach(() => {
		AskBroker._resetForTest();
	});
	afterEach(() => {
		AskBroker._resetForTest();
	});

	describe("binding", () => {
		it("isBound flips with bind/unbind (test 1)", () => {
			expect(AskBroker.isBound()).toBe(false);
			AskBroker.bind(makeUI());
			expect(AskBroker.isBound()).toBe(true);
			AskBroker.unbind();
			expect(AskBroker.isBound()).toBe(false);
		});

		it("is refcounted — stays bound until the last overlapping unbind (test 2)", () => {
			AskBroker.bind(makeUI());
			AskBroker.bind(makeUI());
			expect(AskBroker.isBound()).toBe(true);
			AskBroker.unbind();
			expect(AskBroker.isBound()).toBe(true); // one scope still active
			AskBroker.unbind();
			expect(AskBroker.isBound()).toBe(false);
		});

		it("withUI binds for the duration and releases on return (test 3)", async () => {
			expect(AskBroker.isBound()).toBe(false);
			const out = await AskBroker.withUI(makeUI(), async () => {
				expect(AskBroker.isBound()).toBe(true);
				return 42;
			});
			expect(out).toBe(42);
			expect(AskBroker.isBound()).toBe(false);
		});

		it("withUI releases even when fn throws (test 4)", async () => {
			await expect(
				AskBroker.withUI(makeUI(), async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(AskBroker.isBound()).toBe(false);
		});
	});

	describe("ask", () => {
		it("throws when no UI is bound (test 5)", async () => {
			await expect(AskBroker.ask({ question: "q", type: "confirm" })).rejects.toThrow(/no orchestrator UI bound/);
		});

		it("routes confirm to the bound UI → Y / N (test 6)", async () => {
			const ui = makeUI({ confirm: vi.fn().mockResolvedValue(true) });
			AskBroker.bind(ui);
			expect(await AskBroker.ask({ question: "ok?", type: "confirm" })).toEqual({ ok: true, value: "Y" });

			const uiNo = makeUI({ confirm: vi.fn().mockResolvedValue(false) });
			AskBroker.bind(uiNo);
			expect(await AskBroker.ask({ question: "ok?", type: "confirm" })).toEqual({ ok: true, value: "N" });
		});

		it("routes choice to the bound UI → selected value (test 7)", async () => {
			const ui = makeUI({ select: vi.fn().mockResolvedValue("beta") });
			AskBroker.bind(ui);
			expect(await AskBroker.ask({ question: "pick", type: "choice", options: ["alpha", "beta"] })).toEqual({
				ok: true,
				value: "beta",
			});
		});

		it("routes text to the bound UI → entered value (test 8)", async () => {
			const ui = makeUI({ input: vi.fn().mockResolvedValue("hello") });
			AskBroker.bind(ui);
			expect(await AskBroker.ask({ question: "name?", type: "text" })).toEqual({ ok: true, value: "hello" });
		});

		it("surfaces cancellation as { ok: false } (test 9)", async () => {
			const ui = makeUI({ confirm: vi.fn().mockResolvedValue(undefined) });
			AskBroker.bind(ui);
			const r = await AskBroker.ask({ question: "ok?", type: "confirm" });
			expect(r.ok).toBe(false);
		});

		it("short-circuits a pre-aborted signal without touching the UI (test 10)", async () => {
			const confirm = vi.fn().mockResolvedValue(true);
			const ui = makeUI({ confirm });
			AskBroker.bind(ui);
			const controller = new AbortController();
			controller.abort();
			const r = await AskBroker.ask({ question: "ok?", type: "confirm" }, controller.signal);
			expect(r.ok).toBe(false);
			expect(confirm).not.toHaveBeenCalled();
		});

		it("serialises concurrent asks — one dialog at a time, in order (test 11)", async () => {
			const order: string[] = [];
			let release1: (v: boolean) => void = () => {};
			const confirm = vi
				.fn()
				.mockImplementationOnce(() => {
					order.push("q1-start");
					return new Promise<boolean>((res) => {
						release1 = res;
					});
				})
				.mockImplementationOnce(() => {
					order.push("q2-start");
					return Promise.resolve(true);
				});
			const ui = makeUI({ confirm });
			AskBroker.bind(ui);

			const p1 = AskBroker.ask({ question: "q1", type: "confirm" });
			const p2 = AskBroker.ask({ question: "q2", type: "confirm" });

			await flush();
			// Only the first dialog has opened; the second is queued behind it.
			expect(order).toEqual(["q1-start"]);

			release1(true);
			await p1;
			await p2;
			expect(order).toEqual(["q1-start", "q2-start"]);
		});
	});

	// ── overlay renderer seam (Plan 16 Slice 3) ──────────────────────────────

	describe("overlay renderer", () => {
		it("hasOverlayRenderer flips with set/clear", () => {
			expect(AskBroker.hasOverlayRenderer()).toBe(false);
			AskBroker.setOverlayRenderer(async () => ({ ok: true, value: "Y" }));
			expect(AskBroker.hasOverlayRenderer()).toBe(true);
			AskBroker.setOverlayRenderer(null);
			expect(AskBroker.hasOverlayRenderer()).toBe(false);
		});

		it("ask() routes to the overlay renderer instead of the bound UI when one is registered", async () => {
			const uiConfirm = vi.fn().mockResolvedValue(true);
			AskBroker.bind(makeUI({ confirm: uiConfirm }));
			const overlay = vi.fn().mockResolvedValue({ ok: true, value: "overlay-answer" });
			AskBroker.setOverlayRenderer(overlay);

			const r = await AskBroker.ask({ question: "Ratify?", type: "choice", options: ["a", "b"] });

			expect(r).toEqual({ ok: true, value: "overlay-answer" });
			expect(overlay).toHaveBeenCalledTimes(1);
			expect(uiConfirm).not.toHaveBeenCalled(); // editor-slot path bypassed
		});

		it("ask() works with ONLY an overlay renderer bound (no UI) — does not throw", async () => {
			AskBroker.setOverlayRenderer(async () => ({ ok: true, value: "ok" }));
			await expect(AskBroker.ask({ question: "q", type: "confirm" })).resolves.toEqual({ ok: true, value: "ok" });
		});

		it("renderer is chosen at run-time: registering after enqueue still routes the queued ask to the overlay", async () => {
			// Hold the tail with a first ask on the bound UI, register the overlay
			// while it is in flight, then confirm the SECOND ask uses the overlay.
			let release1: (v: boolean) => void = () => {};
			const uiConfirm = vi
				.fn()
				.mockImplementationOnce(() => new Promise<boolean>((res) => (release1 = res)))
				.mockResolvedValue(true);
			AskBroker.bind(makeUI({ confirm: uiConfirm }));

			const p1 = AskBroker.ask({ question: "q1", type: "confirm" });
			const overlay = vi.fn().mockResolvedValue({ ok: true, value: "via-overlay" });
			const p2 = AskBroker.ask({ question: "q2", type: "confirm" });

			// Let p1's render commit to the (held) editor-slot UI before the overlay
			// registers — so only the still-queued p2 sees the overlay at run-time.
			await flush();
			AskBroker.setOverlayRenderer(overlay);

			release1(true);
			await p1;
			const r2 = await p2;

			expect(r2).toEqual({ ok: true, value: "via-overlay" });
			expect(overlay).toHaveBeenCalledTimes(1);
		});

		it("clearing the renderer falls back to the editor-slot bound UI", async () => {
			const uiConfirm = vi.fn().mockResolvedValue(true);
			AskBroker.bind(makeUI({ confirm: uiConfirm }));
			AskBroker.setOverlayRenderer(async () => ({ ok: true, value: "overlay" }));
			AskBroker.setOverlayRenderer(null);

			const r = await AskBroker.ask({ question: "q", type: "confirm" });
			expect(r).toEqual({ ok: true, value: "Y" });
			expect(uiConfirm).toHaveBeenCalledTimes(1);
		});
	});
});
