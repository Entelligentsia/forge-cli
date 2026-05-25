// Tests for ForgeInputRouter — central interception layer for global
// onTerminalInput listeners with overlay awareness.
//
// Plan 16 Slice 4c. Mirrors pi-mono/packages/tui/src/tui.ts:544-560
// listener-chain semantics, adds skipWhenOverlayActive flag for arrow
// activators that must yield while an overlay is mounted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeInputRouter, type RouterListener } from "../../../src/extensions/forgecli/input-router.js";

let router: ForgeInputRouter;

beforeEach(() => {
	router = new ForgeInputRouter();
});

afterEach(() => {
	// Defensive — clean any overlay state between tests.
	while (router.isOverlayActive()) router.popOverlay();
});

describe("ForgeInputRouter — registration", () => {
	it("calls each listener in registration order", () => {
		const calls: string[] = [];
		const a: RouterListener = (data) => {
			calls.push(`a:${data}`);
			return undefined;
		};
		const b: RouterListener = (data) => {
			calls.push(`b:${data}`);
			return undefined;
		};
		router.register(a, { name: "a" });
		router.register(b, { name: "b" });
		router.dispatch("x");
		expect(calls).toEqual(["a:x", "b:x"]);
	});

	it("unsubscribe removes the listener", () => {
		const calls: string[] = [];
		const unsub = router.register(
			(data) => {
				calls.push(data);
				return undefined;
			},
			{ name: "a" },
		);
		router.dispatch("first");
		unsub();
		router.dispatch("second");
		expect(calls).toEqual(["first"]);
	});

	it("listener returning {consume: true} stops the chain", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`a:${data}`);
				return { consume: true };
			},
			{ name: "a" },
		);
		router.register(
			(data) => {
				calls.push(`b:${data}`);
				return undefined;
			},
			{ name: "b" },
		);
		const result = router.dispatch("x");
		expect(calls).toEqual(["a:x"]);
		expect(result?.consume).toBe(true);
	});

	it("listener rewriting {data: y} passes the rewritten value to next", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`a:${data}`);
				return { data: "Y" };
			},
			{ name: "a" },
		);
		router.register(
			(data) => {
				calls.push(`b:${data}`);
				return undefined;
			},
			{ name: "b" },
		);
		const result = router.dispatch("x");
		expect(calls).toEqual(["a:x", "b:Y"]);
		expect(result?.data).toBe("Y");
	});
});

describe("ForgeInputRouter — overlay awareness", () => {
	it("when no overlay active, listeners with skipWhenOverlayActive run normally", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`activator:${data}`);
				return { consume: true };
			},
			{ name: "thread-switcher-down", skipWhenOverlayActive: true },
		);
		router.dispatch("\x1b[B");
		expect(calls).toEqual(["activator:\x1b[B"]);
	});

	it("when overlay is active, skipWhenOverlayActive listeners are bypassed", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`activator:${data}`);
				return { consume: true };
			},
			{ name: "thread-switcher-down", skipWhenOverlayActive: true },
		);
		router.pushOverlay();
		const result = router.dispatch("\x1b[B");
		expect(calls).toEqual([]); // listener never ran
		expect(result?.consume).toBeFalsy(); // dispatch passes through
	});

	it("when overlay is active, listeners WITHOUT skipWhenOverlayActive still run", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`always:${data}`);
				return undefined;
			},
			{
				name: "always-on",
				skipWhenOverlayActive: false,
			},
		);
		router.register(
			(data) => {
				calls.push(`skip:${data}`);
				return undefined;
			},
			{
				name: "skip",
				skipWhenOverlayActive: true,
			},
		);
		router.pushOverlay();
		router.dispatch("x");
		expect(calls).toEqual(["always:x"]);
	});

	it("default skipWhenOverlayActive is false (listeners run regardless)", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(data);
				return undefined;
			},
			{ name: "default" },
		);
		router.pushOverlay();
		router.dispatch("y");
		expect(calls).toEqual(["y"]);
	});

	it("pushOverlay / popOverlay are reference-counted (nested overlays)", () => {
		expect(router.isOverlayActive()).toBe(false);
		router.pushOverlay();
		expect(router.isOverlayActive()).toBe(true);
		router.pushOverlay();
		expect(router.isOverlayActive()).toBe(true);
		router.popOverlay();
		expect(router.isOverlayActive()).toBe(true); // still 1 active
		router.popOverlay();
		expect(router.isOverlayActive()).toBe(false);
	});

	it("popOverlay never goes negative", () => {
		router.popOverlay();
		router.popOverlay();
		expect(router.isOverlayActive()).toBe(false);
		router.pushOverlay();
		expect(router.isOverlayActive()).toBe(true);
	});

	it("after popOverlay restores, skipWhenOverlayActive listeners resume", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(data);
				return { consume: true };
			},
			{ name: "down-activator", skipWhenOverlayActive: true },
		);
		router.pushOverlay();
		router.dispatch("\x1b[B"); // skipped
		router.popOverlay();
		router.dispatch("\x1b[B"); // runs
		expect(calls).toEqual(["\x1b[B"]);
	});
});

describe("ForgeInputRouter — realistic overlay scenario", () => {
	it("two activator listeners + an overlay = neither fires for ↓", () => {
		const calls: string[] = [];
		router.register(
			(data) => {
				calls.push(`thread-switcher:${data}`);
				if (data === "\x1b[B") return { consume: true };
				return undefined;
			},
			{ name: "thread-switcher", skipWhenOverlayActive: true },
		);
		router.register(
			(data) => {
				calls.push(`whats-new:${data}`);
				if (data === "\x1b[B") return { consume: true };
				return undefined;
			},
			{ name: "whats-new", skipWhenOverlayActive: true },
		);

		// Without overlay, the first listener consumes ↓.
		router.dispatch("\x1b[B");
		expect(calls).toEqual(["thread-switcher:\x1b[B"]);

		// With overlay mounted, both activators are bypassed — focused overlay gets ↓.
		calls.length = 0;
		router.pushOverlay();
		const result = router.dispatch("\x1b[B");
		expect(calls).toEqual([]);
		expect(result?.consume).toBeFalsy();
	});
});

describe("ForgeInputRouter — dispatch return value", () => {
	it("returns {consume: true} when a listener consumed", () => {
		router.register(() => ({ consume: true }), { name: "a" });
		expect(router.dispatch("x")).toEqual({ consume: true });
	});

	it("returns {data: rewritten} when a listener rewrote without consuming", () => {
		router.register((data) => ({ data: data.toUpperCase() }), { name: "a" });
		const result = router.dispatch("hello");
		expect(result).toEqual({ data: "HELLO" });
	});

	it("returns undefined when no listener consumed or rewrote", () => {
		router.register(() => undefined, { name: "a" });
		expect(router.dispatch("x")).toBeUndefined();
	});

	it("returns undefined when no listeners are registered", () => {
		expect(router.dispatch("x")).toBeUndefined();
	});
});
