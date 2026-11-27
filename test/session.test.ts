import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, CLAUDE_ISOLATION, PREAMBLE, isToolbeltTool, type SessionOptions } from "../src/session";
import { FakeAgent, type Turn } from "./fake-agent";

const root = mkdtempSync(join(tmpdir(), "agent-session-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const socket = join(root, "agent.sock");
writeFileSync(socket, "");

function session(turn?: Turn, options: Partial<SessionOptions> = {}) {
	const agent = new FakeAgent(turn);
	let changes = 0;
	let spawned: { command: string[]; env: Record<string, string> } | null = null;
	const s = new AgentSession({
		resolve: async () => ({ ok: true, id: "claude", name: "Claude Code", command: ["/bin/claude-agent-acp"], env: {} }),
		workdir: join(root, "workspace"),
		agentCommand: ["/bun", "/app/cli.js", "--socket", socket],
		path: async () => "/usr/bin:/bin",
		changed: () => changes++,
		transport: (command, o) => ((spawned = { command, env: o.env }), agent.transport()),
		env: { HOME: "/Users/me", SECRET_TOKEN: "x" },
		...options,
	});
	return { s, agent, changes: () => changes, spawned: () => spawned };
}

test("the first question starts the agent with ToolBelt's MCP server only, isolated, and streams the answer", async () => {
	const prompts: unknown[] = [];
	const { s, agent, spawned } = session(async (a, id, prompt) => {
		prompts.push(prompt);
		if (prompts.length === 1) a.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Three tasks." } });
	});
	await s.ask("What's overdue?");
	expect(spawned()!.command).toEqual(["/bin/claude-agent-acp"]);
	// Only what agents need from ToolBelt's environment; no stray secrets.
	expect(spawned()!.env).toEqual({ HOME: "/Users/me", TERM: "dumb", PATH: "/usr/bin:/bin" });
	expect(agent.newSession.mcpServers).toEqual([{ name: "toolbelt", command: "/bun", args: ["/app/cli.js", "--socket", socket, "mcp", "--client", "Agent · Claude Code"], env: [] }]);
	expect(agent.newSession._meta).toEqual(CLAUDE_ISOLATION);
	expect(agent.newSession.cwd).toBe(join(root, "workspace"));
	expect(prompts[0]).toEqual([{ type: "text", text: PREAMBLE }, { type: "text", text: "What's overdue?" }]);
	expect(s.chat.messages.map((m) => m.text)).toEqual(["What's overdue?", "Three tasks."]);
	expect(s.status).toBe("idle");
	// Follow-ups reuse the session and skip the preamble.
	await s.ask("And today?");
	expect(agent.sent.filter((m) => m.method === "session/new")).toHaveLength(1);
	expect(prompts[1]).toEqual([{ type: "text", text: "And today?" }]);
});

test("only ToolBelt's tools are allowed; anything else is refused and said so", async () => {
	const answers: any[] = [];
	const { s } = session(async (a, id) => {
		const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
		answers.push((await a.ask("session/request_permission", { sessionId: id, toolCall: { toolCallId: "1", name: "mcp__toolbelt__show_screen" }, options })).result);
		answers.push((await a.ask("session/request_permission", { sessionId: id, toolCall: { toolCallId: "2", title: "Bash", kind: "execute" }, options })).result);
		answers.push((await a.ask("session/request_permission", { sessionId: id, toolCall: { toolCallId: "3", name: "mcp__gmail__send" }, options })).result);
	});
	await s.ask("Show me");
	expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }, { outcome: { outcome: "selected", optionId: "deny" } }, { outcome: { outcome: "selected", optionId: "deny" } }]);
	expect(s.chat.messages.filter((m) => m.role === "system").map((m) => m.text)).toEqual(["Refused Bash: here the agent may only use ToolBelt.", "Refused gmail__send: here the agent may only use ToolBelt.".replace("gmail__send", "mcp__gmail__send")]);
	expect(isToolbeltTool({ sessionId: "s", options: [], toolCall: { toolCallId: "x", name: "mcp__toolbelt_evil__x" } })).toBe(false);
});

test("problems say what to do: agents off in ToolBelt, an agent that isn't installed, an agent that quits", async () => {
	const off = session(undefined, { agentCommand: ["/bun", "/cli.js", "--socket", join(root, "missing.sock")] });
	await off.s.ask("hi");
	expect(off.s.problem?.text).toContain("Settings → Agents");
	expect(off.s.status).toBe("idle");

	const missing = session(undefined, { resolve: async () => ({ ok: false, id: "codex", name: "Codex", reason: "Codex's ACP mode isn't installed.", install: "npm install -g @agentclientprotocol/codex-acp" }) });
	await missing.s.ask("hi");
	expect(missing.s.problem).toEqual({ text: "Codex's ACP mode isn't installed.", install: "npm install -g @agentclientprotocol/codex-acp", settings: true });

	const quits = session(async (a) => a.exit());
	await quits.s.ask("hi");
	expect(quits.s.problem?.text).toBe("The agent stopped (exit code 1)");
	expect(quits.s.status).toBe("idle");
});

test("stop cancels the turn, and a new chat starts a fresh session", async () => {
	let release: () => void = () => {};
	const { s, agent } = session(async (a, id) => {
		a.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
		await new Promise<void>((r) => (release = r));
		return "cancelled";
	});
	const asking = s.ask("Long question");
	await Bun.sleep(10);
	expect(s.status).toBe("working");
	s.stop();
	expect(agent.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
	release();
	await asking;
	s.reset();
	expect(s.chat.empty).toBe(true);
	expect(agent.closed).toBe(true);
});

test("Test connection starts the agent and its session, and closes them", async () => {
	const { s, agent } = session();
	expect(await s.check()).toBe("Fake Agent 9.9 started and connected to ToolBelt.");
	expect(agent.closed).toBe(true);
	expect(agent.sent.some((m) => m.method === "session/prompt")).toBe(false);
});

const saved = [
	{ role: "user" as const, text: "What's overdue?" },
	{ role: "assistant" as const, text: "Three tasks." },
];

test("a saved chat with the same agent reopens its session, without repeating its history", async () => {
	const prompts: any[] = [];
	const { s, agent } = session(async (_a, _id, prompt) => void prompts.push(prompt), { agentKey: () => "claude" });
	agent.loadable = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Three tasks." } }];
	s.restore(saved, { sessionId: "old-1", agent: "claude" });
	await s.ask("And tomorrow?");
	expect(agent.loadSession).toMatchObject({ sessionId: "old-1", _meta: CLAUDE_ISOLATION });
	expect(agent.newSession).toBeNull();
	expect(prompts[0]).toEqual([{ type: "text", text: "And tomorrow?" }]);
	expect(s.chat.messages.map((m) => m.text)).toEqual(["What's overdue?", "Three tasks.", "And tomorrow?"]);
	expect(s.session).toEqual({ id: "old-1", agent: "claude" });
});

test("another agent (or one that can't reopen sessions) gets a recap in a new session", async () => {
	const prompts: any[] = [];
	const { s, agent } = session(async (_a, _id, prompt) => void prompts.push(prompt), { agentKey: () => "codex" });
	agent.loadable = [];
	s.restore(saved, { sessionId: "old-1", agent: "claude" });
	await s.ask("And tomorrow?");
	expect(agent.loadSession).toBeNull();
	expect(prompts[0].map((p: any) => p.text)).toEqual([PREAMBLE, expect.stringContaining("Person: What's overdue?\n\nYou: Three tasks."), "And tomorrow?"]);
	expect(s.chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
	expect(s.session).toEqual({ id: "s1", agent: "codex" });
});

test("Claude Code with environment lines (a local model) is still isolated and gets them", async () => {
	const { s, agent, spawned } = session(undefined, { resolve: async () => ({ ok: true, id: "claude", name: "Claude Code", command: ["/bin/claude-agent-acp"], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8000" } }) });
	await s.ask("Hi");
	expect(spawned()!.env).toMatchObject({ HOME: "/Users/me", ANTHROPIC_BASE_URL: "http://127.0.0.1:8000" });
	expect(agent.newSession._meta).toEqual(CLAUDE_ISOLATION);
});
