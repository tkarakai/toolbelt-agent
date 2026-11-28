import { expect, test } from "bun:test";
import { validateTree } from "@toolbelt/sdk/validation";
import type { Node } from "@toolbelt/sdk";
import { DEFAULTS, MODEL_API_DEFAULTS, type Settings } from "../src/settings";
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
	expect(t).toMatchObject({ mode: "panel", subtitle: "Agent settings", actions: [] });
	const items = list(t).items;
	expect(items.map((i) => i.title)).toEqual(["Model API", "Claude Code", "Codex", "Gemini CLI", "Add an ACP agent…"]);
	// The Model API agent needs a model before it can be used.
	expect(items[0]).toMatchObject({ subtitle: "oMLX · no model yet", actions: [] });
	expect(items[1]).toMatchObject({ subtitle: "Installed", actions: [{ id: "use", inline: true }] });
	expect(items[2]).toMatchObject({ subtitle: "Not installed", actions: [] });
});

test("the agents list marks the one in use and remembers each agent's last start", () => {
	const settings: Settings = {
		...DEFAULTS,
		active: "custom:1",
		custom: [{ id: "1", name: "oMLX", command: "codex-acp --profile local", vars: [] }],
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
	const settings: Settings = { ...DEFAULTS, active: "claude", custom: [{ id: "2", name: "", command: "x --acp", vars: [] }], tested: {} };
	const row = list(view({ settings, page: { view: "agents" } })).items.find((i) => i.id === "custom:2")!;
	expect(row.title).toBe("Custom agent");
	expect(row.actions!.find((a) => a.id === "delete")).toMatchObject({ tone: "destructive", confirm: expect.stringContaining("Delete Custom agent?") });
});

test("a custom agent's page edits a draft; saving the one in use starts it first", () => {
	const settings: Settings = { ...DEFAULTS, active: "custom:1", custom: [{ id: "1", name: "Local", command: "a --acp", vars: [] }], tested: {} };
	const clean = view({ settings, page: { view: "agent", id: "custom:1" } });
	expect(clean).toMatchObject({ subtitle: "Local settings", actions: [{ id: "back" }] });
	expect((clean.children[0] as any).fields.map((f: any) => f.id)).toEqual(["name", "command", "env"]);
	expect(card(clean).actions!.map((a) => a.id)).toEqual(["test"]);
	const drafts = new Map([["custom:1" as const, { id: "1", name: "Local", command: "b --acp", vars: [] }]]);
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
	const drafts = new Map([["custom:1" as const, { id: "1", name: "", command: "", vars: [] }]]);
	const t = view({ settings: DEFAULTS, drafts, page: { view: "agent", id: "custom:1" } });
	expect(t.subtitle).toBe("Custom agent settings");
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

const v = (key: string, value: string, secret = false) => ({ key, value, selected: true, secret });

test("Claude Code's page edits its environment variables as a draft, secret ones in the Keychain", () => {
	const settings: Settings = { ...DEFAULTS, active: "claude", vars: { claude: [v("ANTHROPIC_MODEL", "a"), v("ANTHROPIC_AUTH_TOKEN", "", true)] } };
	const clean = view({ settings, page: { view: "agent", id: "claude" } });
	const form = clean.children.find((c) => c.type === "form") as any;
	expect(form.fields).toMatchObject([{ type: "environment", id: "env", secretPrefix: "agents/claude/env", value: [v("ANTHROPIC_MODEL", "a"), v("ANTHROPIC_AUTH_TOKEN", "", true)] }]);
	expect(card(clean).actions!.map((a) => a.id)).toEqual(["test"]);
	const drafts = new Map([["claude" as const, { id: "claude", name: "", command: "", vars: [v("ANTHROPIC_MODEL", "b"), v("ANTHROPIC_AUTH_TOKEN", "", true)] }]]);
	const edited = view({ settings, drafts, page: { view: "agent", id: "claude" } });
	expect((edited.children.find((c) => c.type === "form") as any).fields[0].value[0].value).toBe("b");
	expect(card(edited).actions!.map((a) => a.id)).toEqual(["test", "discard", "use"]);
	expect(card(edited).actions!.find((a) => a.id === "use")!.label).toBe("Save");
	const row = list(view({ settings, drafts, page: { view: "agents" } })).items.find((i) => i.id === "claude")!;
	expect(row.subtitle).toBe("Unsaved changes");
	expect(list(view({ settings, drafts, page: { view: "agents" } })).items.map((i) => i.id)).toEqual(["model-api", "claude", "codex", "gemini", "add"]);
	// Agents that don't take environment lines have no form.
	expect(view({ page: { view: "agent", id: "gemini" } }).children.some((c) => c.type === "form")).toBe(false);
});

const modelApi = (m: Partial<typeof MODEL_API_DEFAULTS> = {}) => ({ ...MODEL_API_DEFAULTS, ...m });
const cardById = (t: ReturnType<typeof view>, id: string) => t.children.find((c) => c.type === "card" && (c as any).id === id) as any;

test("the Model API page: server, key in the Keychain, models, thinking, and where chats go", () => {
	const settings: Settings = { ...DEFAULTS, modelApi: modelApi({ preset: "omlx", model: "Qwen3.8-27B-4bit" }) };
	const t = view({ settings, page: { view: "agent", id: "model-api" }, models: { state: "ok", list: [{ id: "Qwen3.8-27B-4bit", context: 65536 }, { id: "small" }] } });
	expect(t.subtitle).toBe("Model API settings");
	expect(cardById(t, "server").actions).toMatchObject([{ id: "refresh-models", label: "Refresh models" }]);
	const server = cardById(t, "server");
	expect(server).toMatchObject({ title: "oMLX", description: "Stays on this Mac" });
	const fields = server.children[0].fields;
	expect(fields.map((f: any) => f.id)).toEqual(["preset", "url", "key", "model", "thinking", "keepLoaded"]);
	expect(fields[2]).toMatchObject({ type: "text", secret: "model-api/key", value: "" });
	expect(fields[3].options).toEqual([{ value: "Qwen3.8-27B-4bit", label: "Qwen3.8-27B-4bit", sub: "66k context" }, { value: "small", label: "small" }]);
	expect(cardById(t, "advanced")).toMatchObject({ collapsible: true, description: "Chat Completions (automatic) · up to 12 tool steps per answer" });
	expect(cardById(t, "guide")).toMatchObject({ collapsible: true, description: "Running a model on this Mac" });
	expect(cardById(t, "guide").open).toBeUndefined();
	// Hosted: where chats go, and a server without keys has no key field.
	const hosted = view({ settings: { ...DEFAULTS, modelApi: modelApi({ preset: "openrouter" }) }, page: { view: "agent", id: "model-api" } });
	expect(cardById(hosted, "server").description).toBe("Sends chats to openrouter.ai");
	expect(cardById(hosted, "guide").description).toBe("Using a hosted model");
	const ollama = view({ settings: { ...DEFAULTS, modelApi: modelApi({ preset: "ollama" }) }, page: { view: "agent", id: "model-api" } });
	expect(cardById(ollama, "server").children[0].fields.map((f: any) => f.id)).toEqual(["preset", "url", "model", "thinking", "keepLoaded"]);
	// Keeping the model loaded is only offered for a server on this Mac.
	expect(cardById(hosted, "server").children[0].fields.map((f: any) => f.id)).not.toContain("keepLoaded");
	expect(cardById(ollama, "guide").children[0].text).toContain("OLLAMA_CONTEXT_LENGTH");
});

test("keeping the model loaded: the switch, how it's going, and a warning above the composer when it fails", () => {
	const settings: Settings = { ...DEFAULTS, active: "model-api", modelApi: modelApi({ model: "Qwen3.8-27B-4bit", keepLoaded: "on" }) };
	const page = { view: "agent", id: "model-api" } as const;
	const at = base.now - 2 * 60_000;
	const fields = (t: ReturnType<typeof view>) => cardById(t, "server").children[0].fields;
	const off = view({ settings: { ...settings, modelApi: modelApi({ model: "q" }) }, page });
	expect(fields(off).find((f: any) => f.id === "keepLoaded")).toMatchObject({ type: "switch", value: false });
	expect(cardById(off, "server").children).toHaveLength(1);

	const ready = view({ settings, page, keep: { state: "ready", at, ms: 38_000, loaded: true, since: at, reloads: 0, next: at + 60_000 } });
	expect(fields(ready).find((f: any) => f.id === "keepLoaded").value).toBe(true);
	expect(cardById(ready, "server").children[1]).toMatchObject({ type: "text", tone: "success", text: "Kept loaded: checked 2 min ago. The server loaded it for the last check (38 s), or was busy." });
	expect(cardById(ready, "server").actions.map((a: any) => a.id)).toEqual(["refresh-models"]);
	const fought = view({ settings, page, keep: { state: "ready", at, ms: 30_000, loaded: true, since: at, reloads: 2, next: at + 4 * 60_000 } });
	expect(cardById(fought, "server").children[1]).toMatchObject({ tone: "warning", text: expect.stringContaining("for the last 3 checks: something else keeps unloading it") });

	// One failed check (a server restarting) is shown in the settings only.
	const once = { state: "failed", at, text: "Couldn't reach http://127.0.0.1:8000/v1: is the server running?", since: at, attempts: 1, next: at + 60_000 } as const;
	expect(cardById(view({ settings, page, keep: once }), "server").children[1]).toMatchObject({ tone: "danger", text: expect.stringContaining("Next try at") });
	expect(view({ settings, keep: once }).children.some((c: any) => c.tone === "danger")).toBe(false);
	const failed = { ...once, attempts: 5, next: at + 15 * 60_000 } as const;
	const failing = view({ settings, page, keep: failed });
	expect(cardById(failing, "server").children[1]).toMatchObject({ tone: "danger", text: expect.stringContaining("waiting longer after each try. Turn this off if you stopped using this server.") });
	expect(cardById(failing, "server").actions[0]).toMatchObject({ id: "keep-retry", label: "Try now" });
	const bar = view({ settings, keep: failed });
	expect(bar.mode).toBe("bar");
	expect(bar.children.at(-2)).toMatchObject({ type: "text", tone: "danger", text: "The model isn't loaded: Couldn't reach http://127.0.0.1:8000/v1: is the server running?" });
	// Another agent in use: nothing about the Model API's model in the chat.
	expect(view({ settings: { ...settings, active: "claude" }, keep: failed }).children.some((c: any) => c.tone === "danger")).toBe(false);
});

test("a failed Model API test opens “Before you start” at what went wrong", () => {
	const settings: Settings = { ...DEFAULTS, modelApi: modelApi({ model: "tiny" }) };
	const t = view({ settings, page: { view: "agent", id: "model-api" }, tests: { "model-api": { state: "failed", text: "tiny answered without calling a tool.", guide: "tools" } } });
	expect(cardById(t, "guide").open).toBe(true);
	expect(cardById(t, "guide").children[0].text).toStartWith("**The model answered without calling a tool.**");
	expect(cardById(t, "connection").children[0]).toMatchObject({ tone: "danger", text: expect.stringContaining("See “Before you start”") });
	// The model list's state shows under the model field.
	const failed = view({ settings, page: { view: "agent", id: "model-api" }, models: { state: "failed", text: "The server refused the API key." } });
	expect(cardById(failed, "server").children[0].fields.find((f: any) => f.id === "model").description).toContain("refused the API key");
});
