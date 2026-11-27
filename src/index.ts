// ToolBelt Agent: a floating plugin that talks to an ACP agent (Claude Code, Codex, Gemini CLI or
// another) about the person's tools, through ToolBelt's own MCP server.
import { join } from "node:path";
import { agentCommand, dataDir, definePlugin, type Context } from "@toolbelt/sdk";
import { AGENTS, searchPath, which } from "./agents";
import { connection, resolveConnection } from "./connections";
import { AgentSession, type SessionOptions } from "./session";
import { customId, exists, findCustom, isCustom, loadSettings, saveSettings, type ConnectionId, type CustomAgent, type Settings } from "./settings";
import { dirty, floating, SUGGESTIONS, type Page, type TestResult } from "./ui";

const data = dataDir();
let settings: Settings = loadSettings(data);
let page: Page = { view: settings.active ? "chat" : "agents" };
let collapsed = false;
let found: Partial<Record<string, string | null>> = {};
const drafts = new Map<ConnectionId, CustomAgent>();
const tests: Partial<Record<ConnectionId, TestResult>> = {};
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

const options: Omit<SessionOptions, "resolve"> = {
	workdir: join(data, "workspace"),
	agentCommand: agentCommand(),
	path: () => searchPath(),
	changed,
	log: (line) => console.error(`[agent] ${line}`),
};

/** The conversation, always with the agent in use (its saved setup, never a draft). */
const session = new AgentSession({
	...options,
	resolve: async () => resolveConnection(connection(settings, settings.active ?? "claude")!, await searchPath()),
});

/** Where each built-in agent's command is, for the settings. */
async function detect() {
	const path = await searchPath();
	found = Object.fromEntries(AGENTS.map((a) => [a.id, which(a.command, path)]));
	ctx?.invalidate("floating");
}

function save(next: Settings) {
	settings = next;
	saveSettings(data, settings);
}

/**
 * Starts an agent as it's set up (its draft, for a custom one being edited) without asking it
 * anything, in its own process: the conversation in progress isn't touched. Remembers how it went.
 */
async function start(id: ConnectionId, use: boolean): Promise<boolean> {
	const c = connection(settings, id, drafts);
	if (!c || tests[id]?.state === "running") return false;
	tests[id] = { state: "running", use };
	ctx?.invalidate("floating");
	const probe = new AgentSession({ ...options, changed: () => {}, resolve: async () => resolveConnection(c, await searchPath()) });
	let ok = false;
	try {
		tests[id] = { state: "ok", text: await probe.check() };
		ok = true;
	} catch (e) {
		tests[id] = { state: "failed", text: probe.problem?.text ?? (e as Error).message };
	}
	// What's remembered is about the saved setup, so a failed draft doesn't mark the saved one.
	if (!dirty({ settings, drafts }, id) || ok) save({ ...settings, tested: { ...settings.tested, [id]: { ok, at: Date.now(), text: (tests[id] as { text: string }).text } } });
	return ok;
}

/** Saves a custom agent's draft. */
function commit(id: ConnectionId) {
	const d = drafts.get(id);
	if (!d) return;
	drafts.delete(id);
	const custom = findCustom(settings, id) ? settings.custom.map((c) => (customId(c.id) === id ? d : c)) : [...settings.custom, d];
	save({ ...settings, custom });
}

/**
 * Switches to an agent (saving its draft) once it started. If it doesn't start, the agent in use
 * stays, and so does its saved setup.
 */
async function use(id: ConnectionId) {
	const first = !settings.active;
	if (!(await start(id, true))) {
		if (page.view === "agents") page = { view: "agent", id };
		return;
	}
	commit(id);
	if (settings.active !== id || isCustom(id)) session.close();
	save({ ...settings, active: id });
	ctx?.toast(`Now using ${connection(settings, id)?.name}`, "success");
	if (first) page = { view: "chat" };
}

function newCustom(): ConnectionId {
	let n = 1;
	while (findCustom(settings, customId(String(n))) || drafts.has(customId(String(n)))) n++;
	const id = customId(String(n));
	drafts.set(id, { id: String(n), name: "", command: "", env: "" });
	return id;
}

/** The connection a settings event is about: the agent page's, or a list row's. */
const target = (payload: unknown): ConnectionId | null => {
	const row = (payload as { rowId?: string } | undefined)?.rowId;
	if (row && row !== "connection") return exists(settings, row) || drafts.has(row as ConnectionId) ? (row as ConnectionId) : null;
	return page.view === "agent" ? page.id : null;
};

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
				page,
				collapsed,
				status: session.status,
				problem: session.problem,
				messages: session.chat.visible(),
				lastAnswer: session.chat.lastAnswer(),
				found,
				drafts,
				tests,
				now: Date.now(),
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
			// From a problem in the chat, straight to the agent in use.
			page = (payload as { rowId?: string })?.rowId === "problem" && settings.active ? { view: "agent", id: settings.active } : { view: "agents" };
			void detect();
		} else if (name === "done") {
			if (settings.active) page = { view: "chat" };
		} else if (name === "back") page = { view: "agents" };
		else if (name === "open-agent") {
			const item = String((payload as { item?: string })?.item ?? "");
			if (item === "add") page = { view: "agent", id: newCustom() };
			else if (exists(settings, item) || drafts.has(item as ConnectionId)) page = { view: "agent", id: item as ConnectionId };
		} else if (name === "field" && page.view === "agent" && isCustom(page.id)) {
			const { field, value } = payload as { field: string; value: unknown };
			const id = page.id;
			const base = drafts.get(id) ?? findCustom(settings, id);
			if (base && (field === "name" || field === "command" || field === "env")) {
				drafts.set(id, { ...base, [field]: String(value ?? "") });
				delete tests[id];
			}
		} else if (name === "discard") {
			const id = target(payload);
			if (id) {
				drafts.delete(id);
				delete tests[id];
				if (!exists(settings, id)) page = { view: "agents" };
			}
		} else if (name === "save") {
			const id = target(payload);
			if (id) commit(id);
		} else if (name === "delete") {
			const id = target(payload);
			if (id && isCustom(id) && id !== settings.active) {
				drafts.delete(id);
				delete tests[id];
				const tested = { ...settings.tested };
				delete tested[id];
				save({ ...settings, custom: settings.custom.filter((x) => customId(x.id) !== id), tested });
				if (page.view === "agent" && page.id === id) page = { view: "agents" };
			}
		} else if (name === "test") {
			const id = target(payload);
			if (id) await start(id, false);
		} else if (name === "use") {
			const id = target(payload);
			if (id) await use(id);
		}
		c.invalidate("floating");
	},
});
