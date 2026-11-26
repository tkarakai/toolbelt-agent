// ToolBelt Agent: a floating plugin that talks to an ACP agent (Claude Code, Codex, Gemini CLI or
// another) about the person's tools, through ToolBelt's own MCP server.
import { join } from "node:path";
import { agentCommand, dataDir, definePlugin, type Context } from "@toolbelt/sdk";
import { AGENTS, resolveAgent, searchPath, which, type AgentId } from "./agents";
import { AgentSession } from "./session";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { floating, SUGGESTIONS, type TestResult } from "./ui";

const data = dataDir();
let settings: Settings = loadSettings(data);
let editing = false;
let collapsed = false;
let test: TestResult | null = null;
let found: Partial<Record<AgentId, string | null>> = {};
let ctx: Context | undefined;

// While an answer streams, render about ten times a second at most.
let pending: ReturnType<typeof setTimeout> | null = null;
const changed = () => {
	if (pending) return;
	pending = setTimeout(() => {
		pending = null;
		ctx?.invalidate("floating");
	}, 100);
};

const session = new AgentSession({
	resolve: async () => resolveAgent({ ...settings, agent: settings.agent ?? "claude" }, await searchPath()),
	workdir: join(data, "workspace"),
	agentCommand: agentCommand(),
	path: () => searchPath(),
	changed,
	log: (line) => console.error(`[agent] ${line}`),
});

/** Where each agent's command is, for the settings. */
async function detect() {
	const path = await searchPath();
	found = Object.fromEntries(AGENTS.map((a) => [a.id, which(a.command, path)]));
	ctx?.invalidate("floating");
}

function update(next: Partial<Settings>) {
	const agentChanged = next.agent !== undefined && next.agent !== settings.agent;
	settings = { ...settings, ...next };
	saveSettings(data, settings);
	test = null;
	// Another agent (or command) starts fresh on the next question.
	if (agentChanged || next.customCommand !== undefined || next.customEnv !== undefined) session.close();
}

definePlugin({
	async start(c) {
		ctx = c;
		if (c.mode === "active") void detect();
	},
	stop() {
		session.close();
	},
	render: {
		floating: () =>
			floating({
				settings,
				editing,
				collapsed,
				status: session.status,
				problem: session.problem,
				messages: session.chat.visible(),
				lastAnswer: session.chat.lastAnswer(),
				found,
				test,
			}),
	},
	async onEvent(_surface, name, payload, c) {
		const suggestion = SUGGESTIONS.find((s) => s.id === name);
		if (name === "ask" || suggestion) {
			collapsed = false;
			void session.ask(suggestion ? suggestion.label : String((payload as { text?: string })?.text ?? ""));
		} else if (name === "stop") session.stop();
		else if (name === "new-chat") {
			collapsed = false;
			session.reset();
		} else if (name === "collapse") collapsed = true;
		else if (name === "expand") collapsed = false;
		else if (name === "settings") {
			editing = true;
			void detect();
		} else if (name === "done") editing = false;
		else if (name === "field") {
			const { field, value } = payload as { field: string; value: unknown };
			if (field === "agent" && ["claude", "codex", "gemini", "custom"].includes(String(value))) update({ agent: value as AgentId });
			else if (field === "customName" || field === "customCommand" || field === "customEnv") update({ [field]: String(value ?? "") });
		} else if (name === "test") {
			test = { state: "running" };
			c.invalidate("floating");
			try {
				test = { state: "ok", text: await session.check() };
			} catch (e) {
				test = { state: "failed", text: session.problem?.text ?? (e as Error).message };
				session.problem = null;
			}
		}
		c.invalidate("floating");
	},
});
