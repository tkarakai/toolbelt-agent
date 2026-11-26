// The floating window, as a pure function of the plugin's state: an ask bar until there's a
// conversation (or when the person folds it back), a chat panel, and the settings that take over
// the window from its gear button (and open by themselves on first run).
import type { Action, Message, Node, Suggestion } from "@toolbelt/sdk";
import { AGENTS, agentName, type AgentId } from "./agents";
import type { Problem, Status } from "./session";
import type { Settings } from "./settings";

export const DOCS = "https://github.com/tkarakai/toolbelt-agent/blob/main/docs/other-agents.md";

export const SUGGESTIONS: Suggestion[] = [
	{ id: "suggest:attention", label: "What needs my attention?", icon: "bell" },
	{ id: "suggest:updates", label: "Anything I should update?", icon: "package" },
	{ id: "suggest:tools", label: "What can you see in ToolBelt?", icon: "eye" },
];

export type TestResult = { state: "running" } | { state: "ok"; text: string } | { state: "failed"; text: string; install?: string };

export type ViewState = {
	settings: Settings;
	/** The settings take over the window. */
	editing: boolean;
	/** The person folded the chat back into the ask bar. */
	collapsed: boolean;
	status: Status;
	problem: Problem | null;
	messages: Message[];
	lastAnswer: string | null;
	/** Agent id → where its command was found, or null. */
	found: Partial<Record<AgentId, string | null>>;
	test: TestResult | null;
};

const ACTIONS = {
	settings: { id: "settings", label: "Settings", icon: "settings" },
	done: { id: "done", label: "Done", icon: "check" },
	newChat: { id: "new-chat", label: "New chat", icon: "square-pen" },
	collapse: { id: "collapse", label: "Back to the ask bar", icon: "chevrons-down-up" },
	expand: { id: "expand", label: "Show the chat", icon: "chevrons-up-down" },
	stop: { id: "stop", label: "Stop", icon: "square" },
} satisfies Record<string, Action>;

export function floating(s: ViewState): Node {
	if (s.editing || !s.settings.agent) return settingsView(s);
	const name = agentName(s.settings.agent, s.settings.customName);
	const busy = s.status !== "idle";
	const composer: Node = {
		type: "composer",
		id: "ask",
		single: true,
		placeholder: busy ? `${name} is working…` : s.messages.length ? "Ask a follow-up…" : "Ask ToolBelt about your tools…",
		action: { id: "ask", label: "Ask", icon: "sparkles", disabled: busy },
	};
	if (!s.messages.length || (s.collapsed && !busy)) {
		const last = s.lastAnswer?.replace(/[*_`#>]/g, "").split("\n").find((l) => l.trim());
		return {
			type: "floating",
			mode: "bar",
			subtitle: name,
			busy,
			suggestions: s.messages.length ? [] : SUGGESTIONS,
			actions: s.messages.length ? [ACTIONS.expand, ACTIONS.settings] : [ACTIONS.settings],
			children: [...(last ? [{ type: "text", text: last, tone: "muted" } as Node] : []), composer],
		};
	}
	const children: Node[] = [{ type: "conversation", id: "chat", messages: s.messages, empty: "Ask about your tools." }];
	if (s.problem) children.push(problemCard(s.problem));
	children.push(composer);
	return {
		type: "floating",
		mode: "panel",
		subtitle: busy ? `${name} · ${s.status === "starting" ? "starting…" : "working…"}` : name,
		busy,
		actions: busy ? [ACTIONS.stop, ACTIONS.settings] : [ACTIONS.newChat, ACTIONS.collapse, ACTIONS.settings],
		children,
	};
}

function problemCard(p: Problem): Node {
	const children: Node[] = [{ type: "text", text: p.text }];
	if (p.install) children.push({ type: "markdown", text: `Install it in a terminal, then ask again:\n\n\`\`\`sh\n${p.install}\n\`\`\`` });
	return { type: "card", id: "problem", tone: "warning", children, actions: p.settings ? [{ id: "settings", label: "Open settings", icon: "settings" }] : [] };
}

function settingsView(s: ViewState): Node {
	const agent = s.settings.agent;
	const fields: Extract<Node, { type: "form" }>["fields"] = [
		{
			type: "select",
			id: "agent",
			label: "Agent",
			value: agent ?? "none",
			options: [...(agent ? [] : [{ value: "none", label: "Choose an agent…" }]), ...AGENTS.map((a) => ({ value: a.id, label: a.name })), { value: "custom", label: "Another ACP agent…" }],
			description: "The agent you talk to. It runs on this Mac with your own login.",
		},
	];
	if (agent === "custom")
		fields.push(
			{ type: "text", id: "customName", label: "Name", value: s.settings.customName, placeholder: "My agent" },
			{ type: "text", id: "customCommand", label: "Command", value: s.settings.customCommand, placeholder: "my-agent --acp", description: "Starts the agent in ACP mode, speaking on stdin and stdout." },
			{ type: "textarea", id: "customEnv", label: "Environment", value: s.settings.customEnv, placeholder: "OPENAI_BASE_URL=http://localhost:8000/v1", rows: 3, description: "NAME=value lines, added to the agent's environment." },
		);
	const children: Node[] = [{ type: "form", id: "settings", fields }];
	if (agent) children.push({ type: "markdown", text: agentStatus(agent, s) });
	if (agent)
		children.push({
			type: "card",
			id: "connection",
			title: "Connection",
			actions: [{ id: "test", label: s.test?.state === "running" ? "Testing…" : "Test connection", icon: "plug", disabled: s.test?.state === "running" }],
			children: [testText(s.test)],
		});
	children.push({
		type: "markdown",
		text: `**What the agent can see.** The screens of plugins that ToolBelt's Settings → Agents lets agents read. It asks before showing you a screen. Here it has no files, shell or web.\n\n[Other agents and local models](${DOCS})`,
	});
	return {
		type: "floating",
		mode: "panel",
		subtitle: "Settings",
		actions: agent ? [ACTIONS.done] : [],
		children,
	};
}

function agentStatus(agent: AgentId, s: ViewState): string {
	if (agent === "custom") return "Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) on stdin and stdout works.";
	const kind = AGENTS.find((a) => a.id === agent)!;
	const found = s.found[agent];
	if (found) return `Found \`${found}\`. ${kind.note}`;
	return `${kind.name}'s ACP mode isn't installed. Install it in a terminal:\n\n\`\`\`sh\n${kind.install}\n\`\`\`\n\n${kind.note}`;
}

function testText(t: TestResult | null): Node {
	if (!t) return { type: "text", text: "Starts the agent and connects it to ToolBelt, without asking anything.", tone: "muted" };
	if (t.state === "running") return { type: "progress", label: "Starting the agent…" };
	if (t.state === "ok") return { type: "text", text: t.text, tone: "success" };
	return { type: "text", text: t.text, tone: "danger" };
}
