import { expect, test } from "bun:test";
import { backoff, KEEP_INTERVAL_MS, KEEP_MAX_INTERVAL_MS, ModelKeeper, type KeepState } from "../src/keeper";

/** A keeper with a hand-driven clock and timer. */
function keeper(results: (number | Error)[], busy = () => false) {
	let clock = 1_000;
	const timers: { fn: () => void; ms: number }[] = [];
	const changes: [KeepState["state"], KeepState["state"]][] = [];
	let pings = 0;
	const k = new ModelKeeper({
		ping: async () => {
			pings++;
			const r = results.shift() ?? 10;
			if (r instanceof Error) throw r;
			return { ms: r };
		},
		busy,
		changed: (next, prev) => changes.push([prev.state, next.state]),
		now: () => clock,
		setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
		clearTimer: () => {},
	});
	/** Fires the latest timer and waits for its check. */
	const tick = async () => {
		const t = timers.at(-1)!;
		clock += t.ms;
		t.fn();
		await Bun.sleep(0);
	};
	return { k, timers, changes, tick, pings: () => pings };
}

test("checks at once, then every minute; a slow answer means the server loaded the model", async () => {
	const { k, timers, tick, pings } = keeper([40_000, 12]);
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	expect(k.state).toMatchObject({ state: "ready", ms: 40_000, loaded: true });
	expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
	await tick();
	expect(k.state).toMatchObject({ state: "ready", ms: 12, loaded: false, since: 1_000 });
	expect(pings()).toBe(2);
	// The same target again doesn't start over.
	k.start("omlx|Qwen");
	expect(pings()).toBe(2);
});

test("failures back off exponentially: 1, 2, 4, 8 minutes, then every 15; the next success ends them", async () => {
	const fail = new Error("Couldn't reach http://127.0.0.1:8000/v1: is the server running?");
	const { k, timers, changes, tick } = keeper([fail, fail, fail, fail, fail, fail, 20, 20]);
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	expect(k.state).toMatchObject({ state: "failed", attempts: 1, text: fail.message, next: 1_000 + KEEP_INTERVAL_MS });
	const waits = [timers.at(-1)!.ms];
	for (let i = 0; i < 5; i++) {
		await tick();
		waits.push(timers.at(-1)!.ms);
	}
	expect(waits.map((ms) => ms / 60_000)).toEqual([1, 2, 4, 8, 15, 15]);
	expect(k.state).toMatchObject({ state: "failed", attempts: 6, since: 1_000 });
	await tick();
	expect(k.state.state).toBe("ready");
	expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
	expect(changes.filter(([a, b]) => a !== b)).toEqual([["off", "checking"], ["checking", "failed"], ["failed", "ready"]]);
	expect(backoff(50)).toBe(KEEP_MAX_INTERVAL_MS);
});

test("a model that has to be loaded again check after check backs off too, instead of fighting what unloads it", async () => {
	// Start (a load is expected), then reloads every time: something else keeps unloading it.
	const { k, timers, tick } = keeper([30_000, 30_000, 30_000, 30_000, 40, 40]);
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	expect(k.state).toMatchObject({ state: "ready", loaded: true, reloads: 0 });
	expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
	await tick();
	expect(k.state).toMatchObject({ reloads: 1 });
	expect(timers.at(-1)!.ms).toBe(2 * 60_000);
	await tick();
	await tick();
	expect(k.state).toMatchObject({ reloads: 3 });
	expect(timers.at(-1)!.ms).toBe(8 * 60_000);
	// It stays loaded again: back to every minute.
	await tick();
	expect(k.state).toMatchObject({ state: "ready", loaded: false, reloads: 0 });
	expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
});

test("retry checks at once, between scheduled checks", async () => {
	const { k, pings } = keeper([new Error("down"), 10]);
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	k.retry();
	await Bun.sleep(0);
	expect(pings()).toBe(2);
	expect(k.state.state).toBe("ready");
});

test("skips a round while a chat is being answered", async () => {
	let busy = true;
	const { k, timers, tick, pings } = keeper([10, 10], () => busy);
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	expect(pings()).toBe(0);
	expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
	busy = false;
	await tick();
	expect(pings()).toBe(1);
});

test("stopping (or another target) drops a check still in flight", async () => {
	let finish: (v: { ms: number }) => void = () => {};
	const changes: KeepState["state"][] = [];
	const k = new ModelKeeper({ ping: () => new Promise((r) => (finish = r)), changed: (n) => changes.push(n.state), setTimer: () => 1, clearTimer: () => {} });
	k.start("a");
	k.stop();
	finish({ ms: 5 });
	await Bun.sleep(0);
	expect(k.state).toEqual({ state: "off" });
	expect(changes).toEqual(["checking", "off"]);
});
