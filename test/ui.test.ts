import { expect, test } from "bun:test";
import { validateTree } from "@toolbelt/sdk/validation";
import { DEFAULTS } from "../src/settings";
import { floating, SUGGESTIONS, type ViewState } from "../src/ui";

const base: ViewState = { settings: { ...DEFAULTS, agent: "claude" }, editing: false, collapsed: false, status: "idle", problem: null, messages: [], lastAnswer: null, found: { claude: "/bin/claude-agent-acp" }, test: null };
const view = (s: Partial<ViewState>) => {
	const tree = floating({ ...base, ...s });
	validateTree(tree);
	return tree as Extract<ReturnType<typeof floating>, { type: "floating" }>;
};

test("first run opens the settings, which offer every agent", () => {
	const t = view({ settings: DEFAULTS });
	expect(t).toMatchObject({ mode: "panel", subtitle: "Settings", actions: [] });
	const form = t.children[0] as any;
	expect(form.fields[0].options.map((o: any) => o.label)).toEqual(["Choose an agent…", "Claude Code", "Codex", "Gemini CLI", "Another ACP agent…"]);
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

test("settings for a missing agent say how to install it; a custom agent takes a command and environment", () => {
	const missing = view({ editing: true, settings: { ...DEFAULTS, agent: "codex" }, found: { codex: null } });
	expect((missing.children[1] as any).text).toContain("npm install -g @agentclientprotocol/codex-acp");
	const custom = view({ editing: true, settings: { ...DEFAULTS, agent: "custom" } });
	expect((custom.children[0] as any).fields.map((f: any) => f.id)).toEqual(["agent", "customName", "customCommand", "customEnv"]);
	expect(custom.actions!.map((a) => a.id)).toEqual(["done"]);
});
