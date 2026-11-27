// Keeps the Model API agent's local model loaded while ToolBelt runs, when the person asks for it
// ("Keep the model loaded"): every minute it asks the model for a one-token answer. A server that
// dropped the model loads it again, and one that unloads idle models sees it in use, so the first
// question of a chat doesn't wait for loading. Failures are retried; the plugin tells the person
// when keeping it loaded starts failing and when it works again.

/** How it's going. `loaded`: the last check took long enough that the server (re)loaded the model. */
export type KeepState =
	| { state: "off" }
	| { state: "checking"; since: number }
	| { state: "ready"; at: number; ms: number; loaded: boolean; since: number }
	| { state: "failed"; at: number; text: string; since: number; attempts: number };

export type KeeperOptions = {
	/** One request to the model: resolves with how long it took, or throws why it failed. */
	ping: () => Promise<{ ms: number }>;
	/** A chat is being answered: the model is in use, so this round is skipped. */
	busy?: () => boolean;
	/** The state changed; `previous` tells a new failure from a continuing one. */
	changed: (next: KeepState, previous: KeepState) => void;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
};

/** Time between checks. */
export const KEEP_INTERVAL_MS = 60_000;
/** After this many failures in a row, checks slow down (the server is probably not running). */
export const KEEP_FAST_RETRIES = 5;
export const KEEP_SLOW_INTERVAL_MS = 5 * 60_000;
/** A check slower than this means the server loaded the model for it. */
export const LOADED_AFTER_MS = 5_000;

export class ModelKeeper {
	state: KeepState = { state: "off" };
	/** What it's keeping loaded (server, model, key): a different target starts over. */
	private target: string | null = null;
	private timer: unknown = null;
	private running = false;
	private generation = 0;

	constructor(private readonly o: KeeperOptions) {}

	/** Keeps `target` loaded, checking now; the same target again changes nothing. */
	start(target: string) {
		if (this.target === target) return;
		this.stop();
		this.target = target;
		this.set({ state: "checking", since: (this.o.now ?? Date.now)() });
		void this.check();
	}

	stop() {
		this.generation++;
		this.target = null;
		if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as never);
		this.timer = null;
		this.running = false;
		this.set({ state: "off" });
	}

	/** Checks now (the person asked to retry): the timer starts over from here. */
	retry() {
		if (this.target !== null && !this.running) void this.check();
	}

	private async check() {
		if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as never);
		this.timer = null;
		const generation = this.generation;
		const now = this.o.now ?? Date.now;
		if (this.o.busy?.()) return this.schedule(KEEP_INTERVAL_MS);
		this.running = true;
		const previous = this.state;
		try {
			const { ms } = await this.o.ping();
			if (generation !== this.generation) return;
			const since = previous.state === "ready" ? previous.since : now();
			this.set({ state: "ready", at: now(), ms, loaded: ms >= LOADED_AFTER_MS, since });
			this.schedule(KEEP_INTERVAL_MS);
		} catch (e) {
			if (generation !== this.generation) return;
			const attempts = previous.state === "failed" ? previous.attempts + 1 : 1;
			const since = previous.state === "failed" ? previous.since : now();
			this.set({ state: "failed", at: now(), text: (e as Error).message, since, attempts });
			this.schedule(attempts >= KEEP_FAST_RETRIES ? KEEP_SLOW_INTERVAL_MS : KEEP_INTERVAL_MS);
		} finally {
			if (generation === this.generation) this.running = false;
		}
	}

	private schedule(ms: number) {
		this.timer = (this.o.setTimer ?? setTimeout)(() => void this.check(), ms);
	}

	private set(next: KeepState) {
		const previous = this.state;
		this.state = next;
		if (previous.state !== next.state || next.state !== "off") this.o.changed(next, previous);
	}
}
