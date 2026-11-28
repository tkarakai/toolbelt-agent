// Keeps the Model API agent's local model loaded while ToolBelt runs, when the person asks for it
// ("Keep the model loaded"): every minute it asks the model for a one-token answer. A server that
// dropped the model loads it again, and one that unloads idle models sees it in use, so the first
// question of a chat doesn't wait for loading.
//
// The person also runs the server themselves: they stop, upgrade or quit it, load other models,
// unload this one, or keep it busy. So checks back off exponentially while they fail (the server is
// gone, or can't load the model), and also while every check has to load the model again (something
// else keeps unloading it: reloading it each minute would fight that, a 20–40 s load each time).
// A quick, successful check goes back to every minute.

/** How it's going. `loaded`: the last check was slow enough that the server (re)loaded the model. */
export type KeepState =
	| { state: "off" }
	| { state: "checking"; since: number }
	| {
			state: "ready";
			at: number;
			ms: number;
			loaded: boolean;
			since: number;
			/** Checks in a row, after the first, that had to load the model again. */
			reloads: number;
			/** When the next check runs. */
			next: number;
	  }
	| { state: "failed"; at: number; text: string; since: number; attempts: number; next: number };

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

/** Time between checks while all is well, and the first retry. */
export const KEEP_INTERVAL_MS = 60_000;
/** The longest wait between checks while backing off. */
export const KEEP_MAX_INTERVAL_MS = 15 * 60_000;
/** A check slower than this means the server loaded the model for it (or was busy). */
export const LOADED_AFTER_MS = 5_000;
/** Failures in a row before the person is told: a server restarting (an upgrade) misses one check. */
export const NOTIFY_AFTER = 2;

/** The wait after `n` setbacks in a row: one minute, then 2, 4, 8, up to 15. */
export const backoff = (n: number) => Math.min(KEEP_INTERVAL_MS * 2 ** Math.max(0, n - 1), KEEP_MAX_INTERVAL_MS);

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
		this.set({ state: "checking", since: this.now() });
		void this.check();
	}

	stop() {
		this.generation++;
		this.target = null;
		this.clear();
		this.running = false;
		this.set({ state: "off" });
	}

	/** Checks now instead of at the next scheduled time: the person asked, or a chat just worked. */
	retry() {
		if (this.target !== null && !this.running) void this.check();
	}

	private now() {
		return (this.o.now ?? Date.now)();
	}

	private clear() {
		if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as never);
		this.timer = null;
	}

	private async check() {
		this.clear();
		const generation = this.generation;
		if (this.o.busy?.()) return this.schedule(KEEP_INTERVAL_MS);
		this.running = true;
		const previous = this.state;
		try {
			const { ms } = await this.o.ping();
			if (generation !== this.generation) return;
			const loaded = ms >= LOADED_AFTER_MS;
			const wasLoaded = previous.state === "ready" && previous.loaded;
			// The first load after starting (or after a failure) is expected; loads in a row aren't.
			const reloads = loaded && wasLoaded ? previous.reloads + 1 : 0;
			const wait = reloads ? backoff(reloads + 1) : KEEP_INTERVAL_MS;
			const since = previous.state === "ready" ? previous.since : this.now();
			this.set({ state: "ready", at: this.now(), ms, loaded, since, reloads, next: this.now() + wait });
			this.schedule(wait);
		} catch (e) {
			if (generation !== this.generation) return;
			const attempts = previous.state === "failed" ? previous.attempts + 1 : 1;
			const since = previous.state === "failed" ? previous.since : this.now();
			const wait = backoff(attempts);
			this.set({ state: "failed", at: this.now(), text: (e as Error).message, since, attempts, next: this.now() + wait });
			this.schedule(wait);
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
