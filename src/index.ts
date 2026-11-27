// ToolBelt Agent: a floating plugin that talks to an ACP agent (Claude Code, Codex, Gemini CLI or
// another) about the person's tools, through ToolBelt's own MCP server.
import { join } from "node:path";
import { agentCommand, dataDir, definePlugin, type Context } from "@toolbelt/sdk";
import { AGENTS, modelApiCommand, searchPath, which } from "./agents";
import { connection, resolveConnection, type Draft } from "./connections";
import { listModels, preset, readConfig, type Api } from "./model-api/config";
import { AgentSession, type SessionOptions } from "./session";
import { customId, exists, findCustom, isCustom, loadSettings, MODEL_API_DEFAULTS, MODEL_API_KEY, SECRET_KEY, saveSettings, secretPrefix, type BuiltInId, type ConnectionId, type ModelApiSettings, type Settings, type Var } from "./settings";
import { newId, Threads, titleOf, type Keep } from "./threads";
import { dirty, floating, SUGGESTIONS, type ModelList, type Page, type TestResult } from "./ui";

const data = dataDir();
let settings: Settings = loadSettings(data);
let page: Page = { view: settings.active ? "chat" : "agents" };
let collapsed = false;
let found: Partial<Record<string, string | null>> = {};
/** Agents being edited: a custom agent's setup, a built-in agent's `vars`, or the Model API's settings. */
const drafts = new Map<ConnectionId, Draft>();
/** The Model API server's models, and for which server and key they were listed. */
let models: { for: string; list: ModelList } | null = null;
const tests: Partial<Record<ConnectionId, TestResult>> = {};
let ctx: Context | undefined;
const threads = new Threads(data);
threads.prune(settings.keep);
/** The saved chat on screen (null until a new chat's first question, or when chats aren't saved). */
let thread: string | null = null;
let search = "";

// While an answer streams, render about ten times a second at most.
let pending: ReturnType<typeof setTimeout> | null = null;
const changed = () => {
	if (pending) return;
	pending = setTimeout(() => {
		pending = null;
		ctx?.invalidate("floating");
	}, 100);
};

/** Secrets ToolBelt keeps in the Keychain for the plugin. */
const secret = async (name: string) => (ctx ? ctx.secrets.get(name) : null);

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
	resolve: async () => resolveConnection(connection(settings, settings.active ?? "claude")!, await searchPath(), secret, data),
	agentKey: () => settings.active,
});

/** Saves the chat on screen (creating it on its first question), unless chats aren't kept. */
function persist() {
	const messages = session.chat.messages;
	const first = messages.find((m) => m.role === "user");
	if (!first || (settings.keep === "off" && !thread)) return;
	const now = Date.now();
	const meta = thread ? threads.get(thread) : undefined;
	if (thread && !meta) return; // deleted while on screen
	const id = thread ?? newId();
	threads.save({
		id,
		title: meta?.title ?? titleOf(first.text),
		created: meta?.created ?? now,
		updated: now,
		pinned: meta?.pinned ?? false,
		agent: session.session?.agent ?? settings.active,
		agentName: settings.active ? (connection(settings, settings.active)?.name ?? "") : "",
		count: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
		messages,
		sessionId: session.session?.id ?? null,
	});
	if (!thread) threads.prune(settings.keep, now);
	thread = id;
}

async function ask(text: string) {
	const answered = session.ask(text);
	persist();
	await answered;
	persist();
	ctx?.invalidate("floating");
}

function newChat() {
	persist();
	session.reset();
	thread = null;
	collapsed = false;
}

function openThread(id: string) {
	if (session.busy) return;
	const saved = threads.load(id);
	if (!saved) return;
	persist();
	session.restore(saved.messages, { sessionId: saved.sessionId, agent: saved.agent });
	thread = id;
	collapsed = false;
	page = { view: "chat" };
}

function deleteThread(id: string) {
	threads.remove(id);
	if (thread === id) {
		if (session.busy) session.stop();
		session.reset();
		thread = null;
	}
}

const rowId = (payload: unknown) => String((payload as { rowId?: string; item?: string } | undefined)?.rowId ?? (payload as { item?: string } | undefined)?.item ?? "");

/** Where each built-in agent's command is, for the settings. */
async function detect() {
	const path = await searchPath();
	found = Object.fromEntries(AGENTS.map((a) => [a.id, a.bundled ? modelApiCommand()[1]! : which(a.command, path)]));
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
	const probe = new AgentSession({ ...options, changed: () => {}, resolve: async () => resolveConnection(c, await searchPath(), secret, data) });
	let ok = false;
	try {
		tests[id] = { state: "ok", text: await probe.check() };
		ok = true;
	} catch (e) {
		const guide = (e as { guide?: string }).guide;
		tests[id] = { state: "failed", text: probe.problem?.text ?? (e as Error).message, ...(guide ? { guide } : {}) };
	}
	// What's remembered is about the saved setup, so a failed draft doesn't mark the saved one.
	if (!dirty({ settings, drafts }, id) || ok) save({ ...settings, tested: { ...settings.tested, [id]: { ok, at: Date.now(), text: (tests[id] as { text: string }).text } } });
	return ok;
}

/** Saves an agent's draft. */
function commit(id: ConnectionId) {
	const d = drafts.get(id);
	if (!d) return;
	drafts.delete(id);
	if (d.modelApi) return save({ ...settings, modelApi: d.modelApi });
	if (!isCustom(id)) return save({ ...settings, vars: { ...settings.vars, [id]: d.vars } });
	const agent = { id: d.id, name: d.name, command: d.command, vars: d.vars };
	const custom = findCustom(settings, id) ? settings.custom.map((c) => (customId(c.id) === id ? agent : c)) : [...settings.custom, agent];
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
	const edited = drafts.has(id);
	commit(id);
	if (settings.active !== id || isCustom(id) || edited) session.close();
	save({ ...settings, active: id });
	ctx?.toast(`Now using ${connection(settings, id)?.name}`, "success");
	if (first) page = { view: "chat" };
}

function newCustom(): ConnectionId {
	let n = 1;
	while (findCustom(settings, customId(String(n))) || drafts.has(customId(String(n)))) n++;
	const id = customId(String(n));
	drafts.set(id, { id: String(n), name: "", command: "", vars: [] });
	return id;
}

/** The connection a settings event is about: the agent page's, or a list row's. */
const target = (payload: unknown): ConnectionId | null => {
	const row = (payload as { rowId?: string } | undefined)?.rowId;
	if (row && row !== "connection") return exists(settings, row) || drafts.has(row as ConnectionId) ? (row as ConnectionId) : null;
	return page.view === "agent" ? page.id : null;
};

/** Variables from an `environment` field's event: ToolBelt already kept secret values in the Keychain. */
const varsFrom = (value: unknown): Var[] =>
	(Array.isArray(value) ? value : []).map((v: Partial<Var>) => ({ key: String(v.key ?? ""), value: v.secret ? "" : String(v.value ?? ""), selected: v.selected !== false, secret: v.secret === true }));

/** The Model API settings being edited (or saved). */
const modelApiDraft = (): ModelApiSettings => drafts.get("model-api")?.modelApi ?? settings.modelApi;

/** Lists the Model API server's models for the model field (again when the server or key changed). */
async function refreshModels(force = false) {
	const m = modelApiDraft();
	const p = preset(m.preset);
	const url = (m.url.trim() || p.url).replace(/\/+$/, "");
	const key = (await secret(MODEL_API_KEY).catch(() => null)) ?? "";
	const api = (m.api === "auto" || !m.api ? undefined : m.api) as Api | undefined;
	const id = `${p.id}|${url}|${api ?? "auto"}|${key.length}`;
	if (!url || (!force && models?.for === id && models.list.state !== "failed")) return;
	models = { for: id, list: { state: "loading" } };
	ctx?.invalidate("floating");
	let list: ModelList;
	try {
		const config = readConfig({ TOOLBELT_MODEL_API_PRESET: p.id, TOOLBELT_MODEL_API_URL: url, TOOLBELT_MODEL_API_MODEL: "x", ...(api ? { TOOLBELT_MODEL_API_API: api } : {}) });
		list = { state: "ok", list: await listModels({ url: config.url, api: config.api, key }) };
	} catch (e) {
		list = { state: "failed", text: (e as Error).message };
	}
	if (models?.for === id) models = { for: id, list };
	ctx?.invalidate("floating");
}

/**
 * Moves secret-looking variables that still have a value here (from an older version's lines)
 * into the Keychain, once, and says so.
 */
async function toKeychain(c: Context) {
	const moved: string[] = [];
	const move = async (id: ConnectionId, vars: Var[]): Promise<Var[]> => {
		const out: Var[] = [];
		for (const v of vars) {
			if (v.value && (v.secret || SECRET_KEY.test(v.key)) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
				try {
					await c.secrets.set(`${secretPrefix(id)}/${v.key}`, v.value);
					out.push({ ...v, value: "", secret: true });
					moved.push(v.key);
					continue;
				} catch (e) {
					console.error(`[agent] couldn't move ${v.key} into the Keychain: ${(e as Error).message}`);
				}
			}
			out.push(v);
		}
		return out;
	};
	const vars: Settings["vars"] = {};
	for (const [id, v] of Object.entries(settings.vars)) vars[id as BuiltInId] = await move(id as ConnectionId, v ?? []);
	const custom = [];
	for (const a of settings.custom) custom.push({ ...a, vars: await move(customId(a.id), a.vars) });
	if (!moved.length) return;
	save({ ...settings, vars, custom });
	const names = [...new Set(moved)].join(", ");
	session.chat.system(`Moved ${names} into your Mac's Keychain. ToolBelt keeps ${moved.length === 1 ? "it" : "them"} there now, not in the plugin's settings.`);
	c.toast(`Moved ${names} into your Mac's Keychain`, "success");
}

definePlugin({
	async start(c) {
		ctx = c;
		if (c.mode === "active") {
			void detect();
			await toKeychain(c).catch((e) => console.error(`[agent] ${(e as Error).message}`));
		}
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
				models: models?.list ?? null,
				tests,
				threads: threads.list(),
				thread,
				search,
				now: Date.now(),
			}),
	},
	async onEvent(_surface, name, payload, c) {
		const suggestion = SUGGESTIONS.find((s) => s.id === name);
		if (name === "ask" || suggestion) {
			collapsed = false;
			page = { view: "chat" };
			void ask(suggestion ? suggestion.label : String((payload as { text?: string })?.text ?? ""));
		} else if (name === "stop") session.stop();
		else if (name === "new-chat") {
			newChat();
			page = { view: "chat" };
		} else if (name.startsWith("thread:")) openThread(name.slice("thread:".length));
		else if (name === "history") {
			search = "";
			page = { view: "history" };
		} else if (name === "chat") page = { view: "chat" };
		else if (name === "open-thread") openThread(rowId(payload));
		else if (name === "rename") {
			const title = String((payload as { text?: string })?.text ?? "").replace(/\s+/g, " ").trim();
			if (title) threads.update(rowId(payload), { title: title.slice(0, 120) });
		} else if (name === "pin" || name === "unpin") threads.update(rowId(payload), { pinned: name === "pin" });
		else if (name === "delete-thread") deleteThread(rowId(payload));
		else if (name === "clear-threads") {
			threads.clear();
			thread = null;
		} else if (name === "field" && (payload as { form?: string })?.form === "history") search = String((payload as { value?: unknown }).value ?? "");
		else if (name === "field" && (payload as { form?: string })?.form === "conversations") {
			const { field, value } = payload as { field: string; value: unknown };
			if (field === "keep" && ["off", "30", "90", "forever"].includes(String(value))) {
				save({ ...settings, keep: value as Keep });
				threads.prune(settings.keep);
				if (thread && !threads.get(thread)) thread = null;
			} else if (field === "recent") save({ ...settings, recent: value === true });
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
			// Listed afresh each time: the server's models may have changed since.
			if (item === "model-api") void refreshModels(true);
		} else if (name === "field" && page.view === "agent" && isCustom(page.id)) {
			const { field, value } = payload as { field: string; value: unknown };
			const id = page.id;
			const base = drafts.get(id) ?? findCustom(settings, id);
			if (base && (field === "name" || field === "command")) drafts.set(id, { ...base, [field]: String(value ?? "") });
			else if (base && field === "env") drafts.set(id, { ...base, vars: varsFrom(value) });
			delete tests[id];
		} else if (name === "field" && page.view === "agent" && page.id === "model-api") {
			const { form, field, value } = payload as { form: string; field: string; value: unknown };
			if (field === "key" && form === "model-api") {
				// ToolBelt saved or removed the key in the Keychain: the server may list other models.
				delete tests["model-api"];
				void refreshModels(true);
			} else if ((form === "model-api" || form === "model-api-advanced") && field in MODEL_API_DEFAULTS) {
				const next = { ...modelApiDraft(), [field]: String(value ?? "") };
				// Another server: its own usual address.
				if (field === "preset") next.url = "";
				drafts.set("model-api", { id: "model-api", name: "", command: "", vars: [], modelApi: next });
				delete tests["model-api"];
				if (field === "preset" || field === "url" || field === "api") void refreshModels();
			}
		} else if (name === "field" && page.view === "agent") {
			const { field, value } = payload as { field: string; value: unknown };
			const id = page.id as BuiltInId;
			if (field === "env" && AGENTS.some((a) => a.id === id && a.env)) {
				drafts.set(id, { id, name: "", command: "", vars: varsFrom(value) });
				delete tests[id];
			}
		} else if (name === "refresh-models") void refreshModels(true);
		else if (name === "discard") {
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
