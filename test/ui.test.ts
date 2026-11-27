import { expect, test } from "bun:test";
import { validateTree } from "@toolbelt/sdk/validation";
import type { Node } from "@toolbelt/sdk";
import { DEFAULTS, type Settings } from "../src/settings";
import { askSuggestions, floating, SUGGESTIONS, type ViewState } from "../src/ui";
import type { ThreadMeta } from "../src/threads";

const base: ViewState = {
	settings: { ...DEFAULTS, active: "claude" },
	page: { view: "chat" },
	collapsed: false,
	status: "idle",
	problem: null,
	messages: [],
	lastAnswer: null,
	found: { claude: "/bin/claude-agent-acp", codex: null, gemini: null },
	drafts: new Map(),
	tests: {},
	threads: [],
	thread: null,
	search: "",
	now: new Date(2026, 10, 26, 15).getTime(),
};
const view = (s: Partial<ViewState>) => {
	const tree = floating({ ...base, ...s });
	validateTree(tree);
	return tree as Extract<ReturnType<typeof floating>, { type: "floating" }>;
};
const list = (t: ReturnType<typeof view>) => t.children.find((c) => c.type === "list") as Extract<Node, { type: "list" }>;
const card = (t: ReturnType<typeof view>) => t.children.find((c) => c.type === "card") as Extract<Node, { type: "card" }>;

test("first run lists every agent, with no way back to a chat yet", () => {
	const t = view({ settings: DEFAULTS });
	expect(t).toMatchObject({ mode: "panel", subtitle: "Agents", actions: [] });
	const items = list(t).items;
	expect(items.map((i) => i.title)).toEqual(["Claude Code", "Codex", "Gemini CLI", "Add an ACP agent…"]);
	expect(items[0]).toMatchObject({ subtitle: "Installed", actions: [{ id: "use", inline: true }] });
	expect(items[1]).toMatchObject({ subtitle: "Not installed", actions: [] });
});

test("the agents list marks the one in use and remembers each agent's last start", () => {
	const settings: Settings = {
		...DEFAULTS,
		active: "custom:1",
		custom: [{ id: "1", name: "oMLX", command: "codex-acp --profile local", env: "" }],
		tested: { "custom:1": { ok: true, at: base.now - 5 * 60_000, text: "ok" }, claude: { ok: false, at: base.now, text: "Not logged in. Run claude." } },
	};
	const t = view({ settings, page: { view: "agents" } });
	expect(t.actions!.map((a) => a.id)).toEqual(["done"]);
	const items = list(t).items;
	const omlx = items.find((i) => i.id === "custom:1")!;
	expect(omlx).toMatchObject({ title: "oMLX", meta: "In use", subtitle: "Worked 5 min ago", actions: [] });
	const claude = items.find((i) => i.id === "claude")!;
	expect(claude.subtitle).toBe("Didn't start: Not logged in.");
	expect(claude.actions!.map((a) => a.id)).toEqual(["use"]);
});

test("an inactive custom agent can be deleted, after a confirmation", () => {
	const settings: Settings = { ...DEFAULTS, active: "claude", custom: [{ id: "2", name: "", command: "x --acp", env: "" }], tested: {} };
	const row = list(view({ settings, page: { view: "agents" } })).items.find((i) => i.id === "custom:2")!;
	expect(row.title).toBe("Custom agent");
	expect(row.actions!.find((a) => a.id === "delete")).toMatchObject({ tone: "destructive", confirm: expect.stringContaining("Delete Custom agent?") });
});

test("a custom agent's page edits a draft; saving the one in use starts it first", () => {
	const settings: Settings = { ...DEFAULTS, active: "custom:1", custom: [{ id: "1", name: "Local", command: "a --acp", env: "" }], tested: {} };
	const clean = view({ settings, page: { view: "agent", id: "custom:1" } });
	expect(clean).toMatchObject({ subtitle: "Local", actions: [{ id: "back" }] });
	expect((clean.children[0] as any).fields.map((f: any) => f.id)).toEqual(["name", "command", "env"]);
	expect(card(clean).actions!.map((a) => a.id)).toEqual(["test"]);
	const drafts = new Map([["custom:1" as const, { id: "1", name: "Local", command: "b --acp", env: "" }]]);
	const edited = view({ settings, drafts, page: { view: "agent", id: "custom:1" } });
	expect((edited.children[0] as any).fields[1].value).toBe("b --acp");
	expect(card(edited).actions!.map((a) => a.id)).toEqual(["test", "discard", "use"]);
	expect(card(edited).description).toContain("If it doesn't start, the saved setup stays");
	expect(list(view({ settings, drafts, page: { view: "agents" } })).items.find((i) => i.id === "custom:1")!.subtitle).toBe("Unsaved changes");
});

test("another agent's page offers to use it, keeping the one in use if it fails", () => {
	const t = view({ page: { view: "agent", id: "codex" }, found: { ...base.found, codex: null } });
	expect((t.children[0] as any).text).toContain("npm install -g @agentclientprotocol/codex-acp");
	const use = card(t).actions!.find((a) => a.id === "use")!;
	expect(use).toMatchObject({ label: "Use Codex", primary: true, disabled: true });
	expect(card(t).description).toContain("you keep Claude Code");
	const failed = view({ page: { view: "agent", id: "codex" }, tests: { codex: { state: "failed", text: "Codex's ACP mode isn't installed." } } });
	expect(card(failed).children[0]).toEqual({ type: "text", text: "Codex's ACP mode isn't installed.", tone: "danger" });
	const running = view({ page: { view: "agent", id: "claude" }, settings: { ...DEFAULTS, active: "codex" }, tests: { claude: { state: "running", use: true } } });
	expect(card(running).actions!.find((a) => a.id === "use")).toMatchObject({ label: "Starting…", disabled: true });
});

test("an empty chat is an ask bar with suggestions", () => {
	const t = view({});
	expect(t).toMatchObject({ mode: "bar", subtitle: "Claude Code", suggestions: SUGGESTIONS, busy: false });
	expect(t.children.map((c) => c.type)).toEqual(["composer"]);
});

test("a conversation is a panel; working shows Stop and disables the composer", () => {
	const messages = [{ role: "user" as const, text: "hi" }, { role: "assistant" as const, text: "Hello" }];
	const idle = view({ messages, lastAnswer: "Hello" });
	expect(idle).toMatchObject({ mode: "panel", busy: false });
	expect(idle.actions!.map((a) => a.id)).toEqual(["new-chat", "collapse", "settings"]);
	const busy = view({ messages, status: "working" });
	expect(busy).toMatchObject({ busy: true, subtitle: "Claude Code · working…" });
	expect(busy.actions!.map((a) => a.id)).toEqual(["stop", "settings"]);
	expect((busy.children.at(-1) as any).action.disabled).toBe(true);
});

test("folded back, the bar shows the last answer's first line", () => {
	const t = view({ messages: [{ role: "assistant", text: "**You have 3 overdue tasks:**\n- a" }], lastAnswer: "**You have 3 overdue tasks:**\n- a", collapsed: true });
	expect(t.mode).toBe("bar");
	expect(t.children[0]).toEqual({ type: "text", text: "You have 3 overdue tasks:", tone: "muted" });
	expect(t.actions!.map((a) => a.id)).toEqual(["expand", "settings"]);
});

test("problems show with what to do", () => {
	const t = view({ messages: [{ role: "user", text: "hi" }], problem: { text: "Codex's ACP mode isn't installed.", install: "npm install -g @agentclientprotocol/codex-acp", settings: true } });
	const card = t.children.find((c) => c.type === "card") as any;
	expect(card.children[1].text).toContain("npm install -g @agentclientprotocol/codex-acp");
	expect(card.actions[0].id).toBe("settings");
});


test("on first run, an agent's page opens from the list", () => {
	const drafts = new Map([["custom:1" as const, { id: "1", name: "", command: "", env: "" }]]);
	const t = view({ settings: DEFAULTS, drafts, page: { view: "agent", id: "custom:1" } });
	expect(t.subtitle).toBe("Custom agent");
	expect(card(t).actions!.map((a) => a.id)).toEqual(["test", "discard", "use"]);
	expect(card(t).actions!.find((a) => a.id === "use")!.disabled).toBe(true);
});

const thread = (id: string, hoursAgo: number, extra: Partial<ThreadMeta> = {}): ThreadMeta => ({ id, title: `Chat ${id}`, created: 0, updated: base.now - hoursAgo * 3_600_000, pinned: false, agent: "claude", agentName: "Claude Code", count: 2, ...extra });

test("the ask bar offers recent chats under Continue, then questions to try", () => {
	const threads = [thread("aaaaaa1", 1), thread("aaaaaa2", 30), thread("aaaaaa3", 50), thread("aaaaaa4", 90)];
	const t = view({ threads });
	expect(t.suggestions!.map((x) => [x.id, x.group])).toEqual([
		["thread:aaaaaa1", "Continue"],
		["thread:aaaaaa2", "Continue"],
		["thread:aaaaaa3", "Continue"],
		["history", "Continue"],
		...SUGGESTIONS.map((x) => [x.id, "Try asking"]),
	]);
	expect(t.suggestions![0].metaAt).toBe(threads[0].updated);
	expect(t.actions!.map((a) => a.id)).toEqual(["history", "settings"]);
	expect(askSuggestions({ settings: { ...base.settings, recent: false }, threads })).toEqual(SUGGESTIONS);
	expect(view({}).actions!.map((a) => a.id)).toEqual(["settings"]);
});

test("the history groups chats by when they were used, pinned first, and searches titles", () => {
	const threads = [thread("bbbbbb1", 1), thread("bbbbbb2", 20), thread("bbbbbb3", 24 * 40, { pinned: true, title: "Weekly cleanup" })];
	const t = view({ threads, thread: "bbbbbb1", page: { view: "history" } });
	expect(t).toMatchObject({ subtitle: "Chats · 3", actions: [{ id: "chat" }, { id: "new-chat" }] });
	const groups = t.children.filter((c) => c.type === "stack") as any[];
	expect(groups.map((c) => c.children[0].text)).toEqual(["Today", "Yesterday", "Pinned"]);
	const row = groups[0].children[1].items[0];
	expect(row).toMatchObject({ id: "bbbbbb1", dot: { color: "info" }, metaAt: threads[0].updated });
	expect(row.actions.map((a: any) => a.id)).toEqual(["rename", "pin", "delete-thread"]);
	expect(groups[2].children[1].items[0].actions[1].id).toBe("unpin");
	const found = view({ threads, page: { view: "history" }, search: "weekly" });
	expect((found.children.filter((c) => c.type === "stack") as any[]).map((c) => c.children[0].text)).toEqual(["Pinned"]);
	const none = view({ threads, page: { view: "history" }, search: "zzz" });
	expect(none.children.find((c) => c.type === "empty")).toMatchObject({ title: "No chats match" });
});

test("the agents settings say how long chats are kept and offer Delete all", () => {
	const t = view({ page: { view: "agents" }, threads: [thread("cccccc1", 1)] });
	const form = t.children.find((c) => c.type === "form") as any;
	expect(form.fields.map((f: any) => [f.id, f.value])).toEqual([["keep", "30"], ["recent", true]]);
	expect((t.children.find((c) => c.type === "card" && (c as any).id === "saved") as any).actions[0]).toMatchObject({ id: "clear-threads", tone: "destructive" });
});

test("Claude Code's page edits its environment lines as a draft; saving the one in use starts it first", () => {
	const settings: Settings = { ...DEFAULTS, active: "claude", env: { claude: "ANTHROPIC_MODEL=a" } };
	const clean = view({ settings, page: { view: "agent", id: "claude" } });
	const form = clean.children.find((c) => c.type === "form") as any;
	expect(form.fields).toMatchObject([{ type: "textarea", id: "env", value: "ANTHROPIC_MODEL=a" }]);
	expect(card(clean).actions!.map((a) => a.id)).toEqual(["test"]);
	const drafts = new Map([["claude" as const, { id: "claude", name: "", command: "", env: "ANTHROPIC_MODEL=b" }]]);
	const edited = view({ settings, drafts, page: { view: "agent", id: "claude" } });
	expect((edited.children.find((c) => c.type === "form") as any).fields[0].value).toBe("ANTHROPIC_MODEL=b");
	expect(card(edited).actions!.map((a) => a.id)).toEqual(["test", "discard", "use"]);
	expect(card(edited).actions!.find((a) => a.id === "use")!.label).toBe("Save");
	const row = list(view({ settings, drafts, page: { view: "agents" } })).items.find((i) => i.id === "claude")!;
	expect(row.subtitle).toBe("Unsaved changes");
	expect(list(view({ settings, drafts, page: { view: "agents" } })).items.map((i) => i.id)).toEqual(["claude", "codex", "gemini", "add"]);
	// Agents that don't take environment lines have no form.
	expect(view({ page: { view: "agent", id: "gemini" } }).children.some((c) => c.type === "form")).toBe(false);
});
