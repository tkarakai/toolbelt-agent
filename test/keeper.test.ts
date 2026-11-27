import { expect, test } from "bun:test";
import { KEEP_FAST_RETRIES, KEEP_INTERVAL_MS, KEEP_SLOW_INTERVAL_MS, ModelKeeper, type KeepState } from "../src/keeper";

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

test("failures are retried every minute, then every five; the next success ends them", async () => {
	const fail = new Error("Couldn't reach http://127.0.0.1:8000/v1: is the server running?");
	const { k, timers, changes, tick } = keeper(Array(KEEP_FAST_RETRIES).fill(fail).concat([20]));
	k.start("omlx|Qwen");
	await Bun.sleep(0);
	expect(k.state).toMatchObject({ state: "failed", attempts: 1, text: fail.message });
	for (let i = 1; i < KEEP_FAST_RETRIES; i++) {
		expect(timers.at(-1)!.ms).toBe(KEEP_INTERVAL_MS);
		await tick();
	}
	expect(k.state).toMatchObject({ state: "failed", attempts: KEEP_FAST_RETRIES, since: 1_000 });
	expect(timers.at(-1)!.ms).toBe(KEEP_SLOW_INTERVAL_MS);
	await tick();
	expect(k.state.state).toBe("ready");
	expect(changes.filter(([a, b]) => a !== b)).toEqual([["off", "checking"], ["checking", "failed"], ["failed", "ready"]]);
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
