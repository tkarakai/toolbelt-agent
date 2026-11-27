// The floating window, as a pure function of the plugin's state: an ask bar until there's a
// conversation (or when the person folds it back), a chat panel, and the settings that take over
// the window from its gear button (and open by themselves on first run).
import type { Action, Message, Node, Suggestion } from "@toolbelt/sdk";
import type { AgentKind } from "./agents";
import { connection, connections, type Connection, type Draft } from "./connections";
import { API_NAMES, autoApi, destination, isLocal, preset, PRESETS, type Preset } from "./model-api/config";
import type { Problem, Status } from "./session";
import { findCustom, isCustom, MODEL_API_KEY, secretPrefix, type ConnectionId, type ModelApiSettings, type Settings, type Var } from "./settings";
import type { ThreadMeta } from "./threads";

export const DOCS = "https://github.com/tkarakai/toolbelt-agent/blob/main/docs/other-agents.md";
export const LOCAL_DOCS = "https://github.com/tkarakai/toolbelt-agent/blob/main/docs/local-models.md";

export const SUGGESTIONS: Suggestion[] = [
	{ id: "suggest:attention", label: "What needs my attention?", icon: "bell", group: "Try asking" },
	{ id: "suggest:updates", label: "Anything I should update?", icon: "package", group: "Try asking" },
	{ id: "suggest:tools", label: "What can you see in ToolBelt?", icon: "eye", group: "Try asking" },
];
/** How many recent chats the ask bar offers under Continue. */
export const RECENT = 3;

/** `guide`: what a failed Model API test was about (`server`, `tools`, `model`), which opens "Before you start". */
export type TestResult = { state: "running"; use?: boolean } | { state: "ok"; text: string } | { state: "failed"; text: string; guide?: string };

/** The Model API server's models, for the model field: listed for one address and key. */
export type ModelList = { state: "loading" } | { state: "ok"; list: { id: string; context?: number }[] } | { state: "failed"; text: string };

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
	/** Agents being edited (and new custom ones not saved yet). */
	drafts: Map<ConnectionId, Draft>;
	/** The Model API server's models, once asked. */
	models?: ModelList | null;
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
	settings: { id: "settings", label: "Settings", icon: "settings" },
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

const sameVars = (a: Var[], b: Var[]) => JSON.stringify(a.map(({ key, value, selected, secret }) => [key, secret ? "" : value, selected, secret])) === JSON.stringify(b.map(({ key, value, selected, secret }) => [key, secret ? "" : value, selected, secret]));

/** Whether an agent has edits that aren't saved (or, for a custom one, was never saved). */
export function dirty(s: Pick<ViewState, "settings" | "drafts">, id: ConnectionId): boolean {
	const d = s.drafts.get(id);
	if (!d) return false;
	if (d.modelApi) return JSON.stringify(d.modelApi) !== JSON.stringify(s.settings.modelApi);
	if (!isCustom(id)) return !sameVars(d.vars, s.settings.vars[id] ?? []);
	const saved = findCustom(s.settings, id);
	return !saved || saved.name !== d.name || saved.command !== d.command || !sameVars(saved.vars, d.vars);
}

/** Whether an agent can be started as it's set up (installed, a Model API with a model, or a custom agent with a command). */
const startable = (s: ViewState, c: Connection) => (c.modelApi ? !!c.modelApi.model.trim() : c.kind ? !!s.found[c.kind.id] : !!c.custom?.command.trim());

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
	if (c.kind && !c.kind.bundled && !s.found[c.kind.id]) return s.found[c.kind.id] === undefined ? "Looking for it…" : "Not installed";
	const ok = s.settings.tested[c.id];
	if (c.modelApi) {
		const p = preset(c.modelApi.preset);
		const where = `${p.name} · ${c.modelApi.model.trim() || "no model yet"}`;
		return ok?.ok ? `${where} · worked ${relative(ok.at, s.now)}` : where;
	}
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
	items.push({ id: "add", title: "Add an ACP agent…", icon: "plus", subtitle: "Any agent that speaks ACP" });
	return {
		type: "floating",
		mode: "panel",
		subtitle: "Agent settings",
		actions: first ? [] : [ACTIONS.done],
		children: [
			{ type: "text", tone: "muted", text: first ? "Choose the agent you talk to: Model API for a model of your choice (on this Mac or hosted), or an agent you use already, with your own login." : "Each agent keeps its own setup, so you can switch back any time. ToolBelt switches once the new one starts." },
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
			{ type: "markdown", text: `**What agents can see.** The screens of the plugins ToolBelt's Settings → Agents lets them read. They ask before showing you a screen, and here they have no files, shell or web. [Local models](${LOCAL_DOCS}) · [Other agents](${DOCS})` },
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
	if (c.modelApi) children.push(...modelApiView(s, c.modelApi));
	else if (c.kind) {
		children.push({ type: "markdown", text: kindStatus(c.kind, s.found[c.kind.id]) });
		if (c.kind.env) children.push({ type: "form", id: "agent", fields: [envField(c, c.kind.env.description)] });
	} else
		children.push({
			type: "form",
			id: "agent",
			fields: [
				{ type: "text", id: "name", label: "Name", value: c.custom!.name, placeholder: "My agent" },
				{ type: "text", id: "command", label: "Command", value: c.custom!.command, placeholder: "my-agent --acp", description: "Starts it in ACP mode (stdin and stdout). No shell runs it, so use full paths outside your PATH." },
				envField(c, "Variables for the agent's environment. Values with the lock are kept in your Mac's Keychain."),
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
	return { type: "floating", mode: "panel", subtitle: `${c.name} settings`, actions: [ACTIONS.back], children };
}

/** An agent's environment variables, secret ones kept in the Keychain by ToolBelt. */
function envField(c: Connection, description: string): Extract<Node, { type: "form" }>["fields"][number] {
	return { type: "environment", id: "env", label: "Environment", value: (c.vars ?? []).map((v) => ({ key: v.key, value: v.secret ? "" : v.value, selected: v.selected, secret: v.secret })), secretPrefix: secretPrefix(c.id), description };
}

const THINKING = [
	{ value: "off", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

/** The Model API agent's setup: the server and model, advanced settings, and what to check first. */
function modelApiView(s: ViewState, m: ModelApiSettings): Node[] {
	const p = preset(m.preset);
	const url = (m.url.trim() || p.url).replace(/\/+$/, "");
	const api = m.api === "auto" || !m.api ? autoApi(p, url) : (m.api as keyof typeof API_NAMES);
	const models = s.models;
	const listed = models?.state === "ok" ? models.list : [];
	const modelNote =
		models?.state === "loading" ? "Asking the server for its models…" : models?.state === "failed" ? `Couldn't list the server's models: ${models.text}` : models?.state === "ok" ? `${listed.length} model${listed.length === 1 ? "" : "s"} on the server. Choose one that handles tool calls.` : "Choose one that handles tool calls.";
	const test = s.tests["model-api"];
	const guide = test?.state === "failed" && test.guide ? test.guide : null;
	const fields: Extract<Node, { type: "form" }>["fields"] = [
		{ type: "select", id: "preset", label: "Server", value: p.id, options: PRESETS.map((x) => ({ value: x.id, label: x.name })) },
		{ type: "text", id: "url", label: "Address", value: m.url, placeholder: p.url || "https://…/v1", description: p.url ? `Leave empty for ${p.name}'s usual address.` : "The server's address, ending in its API version, such as /v1." },
	];
	if (p.key !== "none")
		fields.push({ type: "text", id: "key", label: "API key", value: "", secret: MODEL_API_KEY, placeholder: p.key === "required" ? "Required" : "If the server has one", description: "Kept in your Mac's Keychain by ToolBelt." });
	fields.push(
		{ type: "combobox", id: "model", label: "Model", value: m.model, options: listed.map((x) => ({ value: x.id, label: x.id, ...(x.context ? { sub: `${Math.round(x.context / 1000)}k context` } : {}) })), freeform: true, placeholder: "Choose or type a model", description: modelNote },
		{ type: "select", id: "thinking", label: "Thinking", value: m.thinking || "off", options: THINKING, description: "Off answers about twice as fast on a model on this Mac." },
	);
	return [
		{
			type: "card",
			id: "server",
			title: p.name,
			description: destination(url),
			// The server's models change (a model added or deleted): list them again.
			actions: [{ id: "refresh-models", label: models?.state === "loading" ? "Listing models…" : "Refresh models", icon: "refresh-cw", disabled: models?.state === "loading" }],
			children: [{ type: "form", id: "model-api", fields }],
		},
		{
			type: "card",
			id: "advanced",
			title: "Advanced",
			description: `${API_NAMES[api]}${m.api === "auto" || !m.api ? " (automatic)" : ""} · up to ${m.maxSteps.trim() || "12"} tool steps per answer`,
			collapsible: true,
			children: [
				{
					type: "form",
					id: "model-api-advanced",
					fields: [
						{ type: "select", id: "api", label: "API", value: m.api || "auto", options: [{ value: "auto", label: `Automatic: ${API_NAMES[autoApi(p, url)]}` }, ...Object.entries(API_NAMES).map(([value, label]) => ({ value, label }))] },
						{ type: "text", id: "maxOutput", label: "Max answer length", value: m.maxOutput, placeholder: "4096", description: "Tokens per answer. Limits cost on a paid server." },
						{ type: "text", id: "context", label: "Context size", value: m.context, placeholder: String(p.context), description: "The model's context window in tokens, so long chats are shortened in time." },
						{ type: "text", id: "maxSteps", label: "Tool steps per answer", value: m.maxSteps, placeholder: "12", description: "Stops a confused model from looping." },
						{ type: "textarea", id: "instructions", label: "Extra instructions", value: m.instructions, placeholder: "Answer in Hungarian.", rows: 2, description: "Added after ToolBelt's own." },
						{ type: "textarea", id: "extra", label: "Extra request fields", value: m.extra, placeholder: '{"top_k": 20}', rows: 2, description: "A JSON object added to every request, for server-specific options. It can't set the model, messages or tools." },
					],
				},
			],
		},
		{
			type: "card",
			id: "guide",
			title: "Before you start",
			description: isLocal(url) ? "Running a model on this Mac" : "Using a hosted model",
			collapsible: true,
			// Opened by a failed Test; left to the person otherwise.
			...(guide ? { open: true } : {}),
			children: [{ type: "markdown", text: guideText(p, url, guide) }],
		},
	];
}

/** What to set up on the server's side: for a model on this Mac, or a hosted one; a failed Test's item first. */
export function guideText(p: Preset, url: string, failed: string | null): string {
	const first =
		failed === "tools"
			? "**The model answered without calling a tool.** It would answer without reading ToolBelt. Choose a model that handles tool calls (larger ones usually do), or turn thinking on.\n\n"
			: failed === "server" || failed === "model"
				? "**ToolBelt couldn't use the server.** Check that it's running, its address, the API key and the model's name.\n\n"
				: "";
	if (isLocal(url)) {
		const specific: Record<string, string> = {
			omlx: "- **oMLX:** turn thinking off for the model (or add a profile with thinking off), keep its context at 32k or more and leave the cache on.",
			llamacpp: "- **llama.cpp:** start `llama-server` with `--jinja` (tool calls) and `-c 32768` or more.",
			ollama: "- **Ollama:** raise the context with `OLLAMA_CONTEXT_LENGTH=32768`, and keep the model loaded with `OLLAMA_KEEP_ALIVE`. Use a model tagged *tools*.",
			lmstudio: "- **LM Studio:** load the model with a context of 32k or more and start its server.",
		};
		return `${first}${[
			specific[p.id] ?? "",
			"- **The model calls tools.** Small models often answer without calling any.",
			"- **A context of 32k tokens or more.** Reading a busy screen can bring a chat past 15k.",
			"- **Thinking off by default** on the server, or answers take about twice as long.",
			"- **The prompt cache on**, and the model kept loaded between questions.",
			"- **Chats stay on this Mac**: ToolBelt only talks to this address.",
		]
			.filter(Boolean)
			.join("\n")}\n\n[More about local models](${LOCAL_DOCS})`;
	}
	const hosted: Record<string, string> = {
		openrouter: "- **OpenRouter:** choose a model that lists tool support. Its privacy settings decide which providers may keep your chats.",
		openai: "- **OpenAI:** a key from platform.openai.com. Its data controls decide what's kept.",
		anthropic: "- **Anthropic:** a key from console.anthropic.com.",
		gemini: "- **Gemini:** a key from Google AI Studio.",
	};
	return `${first}${[
		hosted[p.id] ?? "",
		"- **An API key**, ideally with a spending limit.",
		"- **A model that supports tool calls.**",
		`- **Chats are sent to ${destination(url).replace(/^Sends chats to /, "")}.** What the provider keeps is up to its settings, not ToolBelt.`,
	]
		.filter(Boolean)
		.join("\n")}\n\n[More about models and servers](${LOCAL_DOCS})`;
}

function kindStatus(kind: AgentKind, found: string | null | undefined): string {
	if (kind.bundled) return kind.note;
	if (found) return `Found \`${found}\`. ${kind.note}`;
	if (found === undefined) return `Looking for ${kind.name}… ${kind.note}`;
	return `${kind.name}'s ACP mode isn't installed. Install it in a terminal:\n\n\`\`\`sh\n${kind.install}\n\`\`\`\n\n${kind.note}`;
}

function startText(s: ViewState, id: ConnectionId): Node {
	const t = lastStart(s, id);
	const at = s.settings.tested[id]?.at;
	if (!t) return { type: "text", text: id === "model-api" ? "Test starts the agent, connects it to ToolBelt and asks the model one small question with a tool." : "Test starts the agent and connects it to ToolBelt, without asking anything.", tone: "muted" };
	if (t.state === "running") return { type: "progress", label: "Starting the agent…" };
	const when = !s.tests[id] && at ? ` (${relative(at, s.now)})` : "";
	if (t.state === "ok") return { type: "text", text: t.text + when, tone: "success" };
	if (t.state === "failed" && t.guide) return { type: "text", text: `${t.text}${when} See “Before you start”.`, tone: "danger" };
	return { type: "text", text: t.text + when, tone: "danger" };
}
