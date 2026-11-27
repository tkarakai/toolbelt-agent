import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_THREADS, Threads, titleOf, type Thread } from "../src/threads";

const DAY = 86_400_000;
const make = (id: string, updated: number, extra: Partial<Thread> = {}): Thread => ({ id, title: titleOf(`Question ${id}`), created: updated, updated, pinned: false, agent: "claude", agentName: "Claude Code", count: 2, messages: [{ role: "user", text: `Question ${id}` }, { role: "assistant", text: "Answer" }], sessionId: `s-${id}`, ...extra });

test("titles are the first question on one line, shortened", () => {
	expect(titleOf("  What's\n overdue?  ")).toBe("What's overdue?");
	expect(titleOf("x".repeat(100))).toHaveLength(60);
	expect(titleOf("   ")).toBe("New chat");
});

test("chats are saved, listed newest first, reloaded, renamed, pinned and deleted", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-threads-"));
	const t = new Threads(dir);
	t.save(make("aaaaaa1", 1000));
	t.save(make("aaaaaa2", 2000));
	expect(t.list().map((x) => x.id)).toEqual(["aaaaaa2", "aaaaaa1"]);
	const again = new Threads(dir);
	expect(again.load("aaaaaa1")).toMatchObject({ sessionId: "s-aaaaaa1", messages: [{ text: "Question aaaaaa1" }, { text: "Answer" }] });
	again.update("aaaaaa1", { title: "Renamed", pinned: true });
	expect(new Threads(dir).get("aaaaaa1")).toMatchObject({ title: "Renamed", pinned: true });
	again.remove("aaaaaa1");
	expect(existsSync(join(dir, "threads", "aaaaaa1.json"))).toBe(false);
	expect(new Threads(dir).list().map((x) => x.id)).toEqual(["aaaaaa2"]);
	again.clear();
	expect(new Threads(dir).list()).toEqual([]);
});

test("pruning drops chats older than the person keeps them, and the oldest beyond the limit, never pinned ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-threads-"));
	const t = new Threads(dir);
	const now = 100 * DAY;
	t.save(make("old0001", now - 40 * DAY));
	t.save(make("pinned1", now - 400 * DAY, { pinned: true }));
	t.save(make("new0001", now - DAY));
	expect(t.prune("forever", now)).toEqual([]);
	expect(t.prune("90", now)).toEqual([]);
	expect(t.prune("30", now)).toEqual(["old0001"]);
	expect(t.list().map((x) => x.id)).toEqual(["new0001", "pinned1"]);
	for (let i = 0; i < MAX_THREADS + 2; i++) t.save(make(`many${String(i).padStart(4, "0")}`, now - i * 1000));
	t.prune("forever", now);
	expect(t.list().filter((x) => !x.pinned)).toHaveLength(MAX_THREADS);
	expect(t.get("pinned1")).toBeDefined();
	expect(t.get("new0001")).toBeUndefined();
});

test("a damaged index or bad entries load as nothing rather than failing", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-threads-"));
	const t = new Threads(dir);
	t.save(make("aaaaaa1", 1000));
	writeFileSync(join(dir, "threads", "index.json"), JSON.stringify([{ id: "../etc" , updated: 1 }, { id: "missing1", updated: 2 }, { id: "aaaaaa1", updated: 3, title: 5 }]));
	expect(new Threads(dir).list()).toMatchObject([{ id: "aaaaaa1", title: "Chat" }]);
	writeFileSync(join(dir, "threads", "index.json"), "{");
	expect(new Threads(dir).list()).toEqual([]);
	expect(() => t.save(make("../x", 1))).toThrow();
});
