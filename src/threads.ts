// Saved conversations, in the plugin's data folder: `threads/index.json` lists them (title, times,
// pinned, agent, size) and `threads/<id>.json` holds each one's messages and the agent's session
// id. Written atomically. How long they're kept is the person's choice (`Settings.keep`); pinned
// ones are kept until deleted, and at most `MAX_THREADS` unpinned ones are kept.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@toolbelt/sdk";

export const MAX_THREADS = 200;
export const TITLE_LENGTH = 60;
const DAY = 86_400_000;

export type Keep = "off" | "30" | "90" | "forever";
export type ThreadMeta = {
	id: string;
	title: string;
	created: number;
	updated: number;
	pinned: boolean;
	/** The agent the chat is with (a settings connection id). */
	agent: string | null;
	/** The agent's name when the chat was saved. */
	agentName: string;
	count: number;
};
export type Thread = ThreadMeta & { messages: Message[]; sessionId: string | null };

/** A chat's title: its first question on one line, shortened. */
export function titleOf(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line || "New chat";
}

const ID = /^[a-z0-9]{6,24}$/;

export class Threads {
	private index: ThreadMeta[] = [];
	private readonly dir: string;

	constructor(data: string) {
		this.dir = join(data, "threads");
		this.index = this.read();
	}

	/** Every saved chat, newest first. */
	list(): ThreadMeta[] {
		return [...this.index].sort((a, b) => b.updated - a.updated);
	}

	get(id: string): ThreadMeta | undefined {
		return this.index.find((t) => t.id === id);
	}

	load(id: string): Thread | null {
		const meta = this.get(id);
		if (!meta || !ID.test(id)) return null;
		try {
			const raw = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as { messages?: unknown; sessionId?: unknown };
			const messages = Array.isArray(raw.messages) ? (raw.messages as Message[]).filter((m) => m && typeof m.text === "string" && typeof m.role === "string") : [];
			return { ...meta, messages, sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null };
		} catch {
			return null;
		}
	}

	save(thread: Thread) {
		if (!ID.test(thread.id)) throw new Error("Bad chat id");
		mkdirSync(this.dir, { recursive: true });
		write(join(this.dir, `${thread.id}.json`), { messages: thread.messages, sessionId: thread.sessionId });
		const { messages, sessionId, ...meta } = thread;
		void messages;
		void sessionId;
		this.index = [...this.index.filter((t) => t.id !== thread.id), meta];
		this.writeIndex();
	}

	update(id: string, change: Partial<Pick<ThreadMeta, "title" | "pinned">>) {
		const meta = this.get(id);
		if (!meta) return;
		this.index = this.index.map((t) => (t.id === id ? { ...t, ...change } : t));
		this.writeIndex();
	}

	remove(id: string) {
		if (!this.get(id)) return;
		this.index = this.index.filter((t) => t.id !== id);
		this.writeIndex();
		if (ID.test(id)) rmSync(join(this.dir, `${id}.json`), { force: true });
	}

	/** Deletes every saved chat, pinned ones too. */
	clear() {
		for (const t of this.index) this.remove(t.id);
		rmSync(this.dir, { recursive: true, force: true });
		this.index = [];
	}

	/** Removes chats older than the person keeps them, and the oldest beyond `MAX_THREADS`. */
	prune(keep: Keep, now = Date.now()): string[] {
		const days = keep === "30" ? 30 : keep === "90" ? 90 : null;
		const unpinned = this.list().filter((t) => !t.pinned);
		const gone = unpinned.filter((t, i) => (days !== null && now - t.updated > days * DAY) || i >= MAX_THREADS).map((t) => t.id);
		for (const id of gone) this.remove(id);
		return gone;
	}

	private read(): ThreadMeta[] {
		const file = join(this.dir, "index.json");
		if (!existsSync(file)) return [];
		try {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(raw)) return [];
			const seen = new Set<string>();
			return raw.flatMap((t: Partial<ThreadMeta>) => {
				if (typeof t?.id !== "string" || !ID.test(t.id) || seen.has(t.id) || typeof t.updated !== "number" || !existsSync(join(this.dir, `${t.id}.json`))) return [];
				seen.add(t.id);
				return [{ id: t.id, title: typeof t.title === "string" ? t.title : "Chat", created: typeof t.created === "number" ? t.created : t.updated, updated: t.updated, pinned: t.pinned === true, agent: typeof t.agent === "string" ? t.agent : null, agentName: typeof t.agentName === "string" ? t.agentName : "", count: typeof t.count === "number" ? t.count : 0 }];
			});
		} catch {
			return [];
		}
	}

	private writeIndex() {
		mkdirSync(this.dir, { recursive: true });
		write(join(this.dir, "index.json"), this.index);
	}
}

function write(file: string, value: unknown) {
	writeFileSync(`${file}.tmp`, JSON.stringify(value) + "\n");
	renameSync(`${file}.tmp`, file);
}

/** A new chat id. */
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
