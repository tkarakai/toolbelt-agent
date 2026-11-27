// The floating window, as a pure function of the plugin's state: an ask bar until there's a
// conversation (or when the person folds it back), a chat panel, and the settings that take over
// the window from its gear button (and open by themselves on first run).
import type { Action, Message, Node, Suggestion } from "@toolbelt/sdk";
import type { AgentKind } from "./agents";
import { connection, connections, type Connection } from "./connections";
import type { Problem, Status } from "./session";
import { findCustom, isCustom, type ConnectionId, type CustomAgent, type Settings } from "./settings";
import type { ThreadMeta } from "./threads";

export const DOCS = "https://github.com/tkarakai/toolbelt-agent/blob/main/docs/other-agents.md";

export const SUGGESTIONS: Suggestion[] = [
	{ id: "suggest:attention", label: "What needs my attention?", icon: "bell", group: "Try asking" },
	{ id: "suggest:updates", label: "Anything I should update?", icon: "package", group: "Try asking" },
	{ id: "suggest:tools", label: "What can you see in ToolBelt?", icon: "eye", group: "Try asking" },
];
/** How many recent chats the ask bar offers under Continue. */
export const RECENT = 3;

export type TestResult = { state: "running"; use?: boolean } | { state: "ok"; text: string } | { state: "failed"; text: string };

/** What the window shows: the chat (or ask bar), saved chats, the list of agents, or one agent's setup. */
export type Page = { view: "chat" } | { view: "history" } | { view: "agents" } | { view: "agent"; id: ConnectionId };

export type ViewState = {
	settings: Settings;
	page: Page;
	/** The person folded the chat back into the ask bar. */
	collapsed: boolean;
	status: Status;
	problem: Problem | null;
	messages: Message[];
	lastAnswer: string | null;
	/** Built-in agent id → where its command was found, or null. */
	found: Partial<Record<string, string | null>>;
	/** Custom agents being edited (and new ones not saved yet). */
	drafts: Map<ConnectionId, CustomAgent>;
	/** Starts from the settings in progress or just finished, this run. */
	tests: Partial<Record<ConnectionId, TestResult>>;
	/** Saved chats, newest first. */
	threads: ThreadMeta[];
	/** The saved chat on screen, if it's saved. */
	thread: string | null;
	/** What the history is filtered by (titles; the person presses return to search). */
	search: string;
	now: number;
};

const ACTIONS = {
	settings: { id: "settings", label: "Agents", icon: "settings" },
	done: { id: "done", label: "Done", icon: "check" },
	back: { id: "back", label: "All agents", icon: "arrow-left" },
	newChat: { id: "new-chat", label: "New chat", icon: "square-pen" },
	collapse: { id: "collapse", label: "Back to the ask bar", icon: "chevrons-down-up" },
	expand: { id: "expand", label: "Show the chat", icon: "chevrons-up-down" },
	stop: { id: "stop", label: "Stop", icon: "square" },
	history: { id: "history", label: "Chats", icon: "rotate-ccw-clock" },
	chat: { id: "chat", label: "Back to the chat", icon: "arrow-left" },
} satisfies Record<string, Action>;

export function floating(s: ViewState): Node {
	if (s.page.view === "agent") {
		const c = connection(s.settings, s.page.id, s.drafts);
		if (c) return agentView(s, c);
	}
	const active = s.settings.active ? connection(s.settings, s.settings.active) : undefined;
	if (active && s.page.view === "history") return historyView(s);
	if (!active || s.page.view !== "chat") return agentsView(s);
	const name = active.name;
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
			suggestions: s.messages.length ? [] : askSuggestions(s),
			actions: [...(s.messages.length ? [ACTIONS.expand] : []), ...(s.threads.length ? [ACTIONS.history] : []), ACTIONS.settings],
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
		actions: busy ? [ACTIONS.stop, ACTIONS.settings] : [ACTIONS.newChat, ...(s.threads.length ? [ACTIONS.history] : []), ACTIONS.collapse, ACTIONS.settings],
		children,
	};
}

/** The ask bar's suggestions: recent chats to continue (when the person wants them), then questions to try. */
export function askSuggestions(s: Pick<ViewState, "settings" | "threads">): Suggestion[] {
	if (!s.settings.recent || !s.threads.length) return SUGGESTIONS;
	const recent: Suggestion[] = s.threads.slice(0, RECENT).map((t) => ({ id: `thread:${t.id}`, label: t.title, icon: t.pinned ? "pin" : "message-square", group: "Continue", metaAt: t.updated }));
	if (s.threads.length > RECENT) recent.push({ id: "history", label: `All ${s.threads.length} chats…`, icon: "rotate-ccw-clock", group: "Continue" });
	return [...recent, ...SUGGESTIONS];
}

const DAY = 86_400_000;

/** Which heading a chat goes under in the history. */
function period(t: ThreadMeta, now: number): string {
	if (t.pinned) return "Pinned";
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const today = start.getTime();
	if (t.updated >= today) return "Today";
	if (t.updated >= today - DAY) return "Yesterday";
	if (t.updated >= today - 6 * DAY) return "Earlier this week";
	if (t.updated >= today - 29 * DAY) return "This month";
	return "Older";
}

export const keepLabel = (keep: Settings["keep"]) => (keep === "off" ? "Chats aren't saved" : keep === "forever" ? "Kept until you delete them" : `Kept for ${keep} days`);

function historyView(s: ViewState): Node {
	const query = s.search.trim().toLowerCase();
	const shown = query ? s.threads.filter((t) => t.title.toLowerCase().includes(query)) : s.threads;
	const children: Node[] = [{ type: "form", id: "history", fields: [{ type: "text", id: "search", label: "Search", value: s.search, placeholder: "Search chat titles, then press return" }] }];
	const groups = new Map<string, ThreadMeta[]>();
	for (const t of shown) groups.set(period(t, s.now), [...(groups.get(period(t, s.now)) ?? []), t]);
	for (const [heading, threads] of groups)
		children.push({
			type: "stack",
			gap: 1,
			children: [
				{ type: "text", tone: "muted", text: heading },
				{
					type: "list",
					id: `threads-${heading}`,
					open: { id: "open-thread", label: "Continue" },
					items: threads.map((t) => ({
						id: t.id,
						title: t.title,
						icon: t.pinned ? "pin" : "message-square",
						subtitle: `${t.agentName || "Agent"} · ${t.count} message${t.count === 1 ? "" : "s"}`,
						metaAt: t.updated,
						...(t.id === s.thread ? { dot: { color: "info" as const, label: "On screen" } } : {}),
						actions: [
							{ id: "rename", label: "Rename", icon: "pencil", input: { placeholder: t.title } },
							{ id: t.pinned ? "unpin" : "pin", label: t.pinned ? "Unpin" : "Pin", icon: t.pinned ? "pin-off" : "pin" },
							{ id: "delete-thread", label: "Delete", icon: "trash", tone: "destructive", confirm: `Delete “${t.title}”? It's removed from this Mac.` },
						],
					})),
				},
			],
		});
	if (!shown.length) children.push({ type: "empty", icon: query ? "search-x" : "rotate-ccw-clock", title: query ? "No chats match" : "No saved chats", description: query ? "Search looks at chat titles." : keepLabel(s.settings.keep) });
	children.push({ type: "text", tone: "muted", text: `${keepLabel(s.settings.keep)}${s.settings.keep === "off" ? "" : ", pinned ones until you delete them"}. Change it in Agents settings.` });
	return {
		type: "floating",
		mode: "panel",
		subtitle: `Chats · ${s.threads.length}`,
		actions: [ACTIONS.chat, ACTIONS.newChat],
		children,
	};
}

function problemCard(p: Problem): Node {
	const children: Node[] = [{ type: "text", text: p.text }];
	if (p.install) children.push({ type: "markdown", text: `Install it in a terminal, then ask again:\n\n\`\`\`sh\n${p.install}\n\`\`\`` });
	return { type: "card", id: "problem", tone: "warning", children, actions: p.settings ? [{ id: "settings", label: "Open settings", icon: "settings" }] : [] };
}

const relative = (at: number, now: number) => {
	const m = Math.round((now - at) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
};

const firstSentence = (t: string) => t.replace(/\s+/g, " ").match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? t;

/** Whether an agent has edits that aren't saved (or, for a custom one, was never saved). */
export function dirty(s: Pick<ViewState, "settings" | "drafts">, id: ConnectionId): boolean {
	const d = s.drafts.get(id);
	if (!d) return false;
	if (!isCustom(id)) return d.env !== (s.settings.env[id] ?? "");
	const saved = findCustom(s.settings, id);
	return !saved || saved.name !== d.name || saved.command !== d.command || saved.env !== d.env;
}

/** Whether an agent can be started as it's set up (installed, or a custom agent with a command). */
const startable = (s: ViewState, c: Connection) => (c.kind ? !!s.found[c.kind.id] : !!c.custom?.command.trim());

/** The last start from the settings: this run's, or the remembered one. */
function lastStart(s: ViewState, id: ConnectionId): TestResult | null {
	const t = s.tests[id];
	if (t) return t;
	const remembered = s.settings.tested[id];
	return remembered ? { state: remembered.ok ? "ok" : "failed", text: remembered.text } : null;
}

function statusLine(s: ViewState, c: Connection): string {
	const t = s.tests[c.id];
	if (t?.state === "running") return "Starting…";
	if (dirty(s, c.id)) return c.kind || findCustom(s.settings, c.id) ? "Unsaved changes" : "New, not saved";
	const last = lastStart(s, c.id);
	if (last?.state === "failed") return `Didn't start: ${firstSentence(last.text)}`;
	if (c.kind && !s.found[c.kind.id]) return s.found[c.kind.id] === undefined ? "Looking for it…" : "Not installed";
	const ok = s.settings.tested[c.id];
	if (ok?.ok) return `Worked ${relative(ok.at, s.now)}`;
	if (c.kind) return "Installed";
	return c.custom?.command.trim() || "No command yet";
}

function agentsView(s: ViewState): Node {
	const first = !s.settings.active;
	const items: Extract<Node, { type: "list" }>["items"] = connections(s.settings, s.drafts).map((c) => {
		const t = s.tests[c.id];
		const inUse = c.id === s.settings.active;
		const last = lastStart(s, c.id);
		const actions: Action[] = [];
		if (!inUse && startable(s, c)) actions.push({ id: "use", label: t?.state === "running" ? "Starting…" : "Use", inline: true, disabled: t?.state === "running" });
		if (c.custom && !inUse) actions.push({ id: "delete", label: "Delete", icon: "trash", tone: "destructive", confirm: `Delete ${c.name}? Its setup is removed; your chats stay.` });
		return {
			id: c.id,
			title: c.name,
			icon: c.icon,
			subtitle: statusLine(s, c),
			...(inUse ? { meta: "In use" } : {}),
			...(t?.state === "running" ? { dot: { color: "info" as const, pulse: true, label: "Starting" } } : inUse ? { dot: { color: "success" as const, label: "In use" } } : last?.state === "failed" ? { dot: { color: "danger" as const, label: "Didn't start" } } : {}),
			actions,
		};
	});
	items.push({ id: "add", title: "Add an ACP agent…", icon: "plus", subtitle: "A local model, or any agent that speaks ACP" });
	return {
		type: "floating",
		mode: "panel",
		subtitle: "Agents",
		actions: first ? [] : [ACTIONS.done],
		children: [
			{ type: "text", tone: "muted", text: first ? "Choose the agent you talk to. It runs on this Mac with your own login." : "Each agent keeps its own setup, so you can switch back any time. ToolBelt switches once the new one starts." },
			{ type: "list", id: "agents", items, open: { id: "open-agent", label: "Set up" } },
			{
				type: "form",
				id: "conversations",
				title: "Chats",
				fields: [
					{ type: "select", id: "keep", label: "Keep chats", value: s.settings.keep, options: [{ value: "off", label: "Don't save chats" }, { value: "30", label: "For 30 days" }, { value: "90", label: "For 90 days" }, { value: "forever", label: "Until I delete them" }], description: "Since a chat was last used. Pinned chats stay until you delete them. Chats can include what the agent read from your screens, and stay on this Mac." },
					{ type: "switch", id: "recent", label: "Recent chats in the ask bar", value: s.settings.recent, description: "Under Continue, when you press ⌘K. Turn off while you share your screen." },
				],
			},
			{
				type: "card",
				id: "saved",
				title: `${s.threads.length} saved chat${s.threads.length === 1 ? "" : "s"}`,
				description: "Deleting removes them from this Mac. An agent may keep its own record of a session (Claude Code does, in ~/.claude).",
				actions: s.threads.length ? [{ id: "clear-threads", label: "Delete all", icon: "trash", tone: "destructive", confirm: `Delete all ${s.threads.length} saved chats, pinned ones too?` }] : [],
				children: [],
			},
			{ type: "markdown", text: `**What agents can see.** The screens of the plugins ToolBelt's Settings → Agents lets them read. They ask before showing you a screen, and here they have no files, shell or web. [Other agents and local models](${DOCS})` },
		],
	};
}

function agentView(s: ViewState, c: Connection): Node {
	const inUse = c.id === s.settings.active;
	const t = s.tests[c.id];
	const running = t?.state === "running";
	const isDirty = dirty(s, c.id);
	const saved = !!c.kind || !!findCustom(s.settings, c.id);
	const children: Node[] = [];
	if (c.kind) {
		children.push({ type: "markdown", text: kindStatus(c.kind, s.found[c.kind.id]) });
		if (c.kind.env) children.push({ type: "form", id: "agent", fields: [{ type: "textarea", id: "env", label: "Environment", value: c.env ?? "", placeholder: c.kind.env.placeholder, rows: 2, description: c.kind.env.description }] });
	} else
		children.push({
			type: "form",
			id: "agent",
			fields: [
				{ type: "text", id: "name", label: "Name", value: c.custom!.name, placeholder: "My agent" },
				{ type: "text", id: "command", label: "Command", value: c.custom!.command, placeholder: "my-agent --acp", description: "Starts it in ACP mode (stdin and stdout). No shell runs it, so use full paths outside your PATH." },
				{ type: "textarea", id: "env", label: "Environment", value: c.custom!.env, placeholder: "OPENAI_BASE_URL=http://localhost:8000/v1", rows: 2, description: "NAME=value lines for the agent's environment." },
			],
		});
	const actions: Action[] = [{ id: "test", label: running && !t.use ? "Testing…" : "Test", icon: "plug", disabled: running }];
	if (isDirty && saved) actions.push({ id: "discard", label: "Discard changes", disabled: running });
	if (isDirty && !saved) actions.push({ id: "discard", label: "Discard", disabled: running });
	if (inUse && isDirty) actions.push({ id: "use", label: running && t.use ? "Starting…" : "Save", icon: "check", primary: true, disabled: running });
	else if (!inUse) {
		if (isDirty && saved) actions.push({ id: "save", label: "Save", disabled: running });
		actions.push({ id: "use", label: running && t.use ? "Starting…" : `Use ${c.name}`, primary: true, disabled: running || !startable(s, c) });
	}
	children.push({
		type: "card",
		id: "connection",
		title: inUse ? "In use" : "Connection",
		description: inUse && isDirty ? "Saving starts it with the changes first. If it doesn't start, the saved setup stays." : inUse ? "This is the agent you're talking to." : `It starts once before ToolBelt switches to it. ${s.settings.active ? `If it doesn't, you keep ${connection(s.settings, s.settings.active)?.name}.` : ""}`.trim(),
		actions,
		children: [startText(s, c.id)],
	});
	return { type: "floating", mode: "panel", subtitle: c.name, actions: [ACTIONS.back], children };
}

function kindStatus(kind: AgentKind, found: string | null | undefined): string {
	if (found) return `Found \`${found}\`. ${kind.note}`;
	if (found === undefined) return `Looking for ${kind.name}… ${kind.note}`;
	return `${kind.name}'s ACP mode isn't installed. Install it in a terminal:\n\n\`\`\`sh\n${kind.install}\n\`\`\`\n\n${kind.note}`;
}

function startText(s: ViewState, id: ConnectionId): Node {
	const t = lastStart(s, id);
	const at = s.settings.tested[id]?.at;
	if (!t) return { type: "text", text: "Test starts the agent and connects it to ToolBelt, without asking anything.", tone: "muted" };
	if (t.state === "running") return { type: "progress", label: "Starting the agent…" };
	const when = !s.tests[id] && at ? ` (${relative(at, s.now)})` : "";
	if (t.state === "ok") return { type: "text", text: t.text + when, tone: "success" };
	return { type: "text", text: t.text + when, tone: "danger" };
}
