// The person's agents, kept in the plugin's data folder (`settings.json`). Data schema 1.
//
// Every agent keeps its own setup: the built-in ones (Claude Code, Codex, Gemini CLI, the Model
// API agent) and any number of custom ACP agents. One of them is in use. Switching only happens
// once the new one has started (see index.ts), so the one in use is always the last one that worked.
//
// Environment variables (Claude Code's and custom agents') are entries; a secret one's value is
// in the Keychain (ToolBelt keeps it, under `secretPrefix(id)/<NAME>`), never in this file. So is
// the Model API agent's key (`MODEL_API_KEY`).
//
// The file is additive over earlier versions: it still has `env` (Claude Code's lines) and each
// custom agent's `env`, as lines without secret values, and the first version's `agent`,
// `customName`, `customCommand` and `customEnv` mirrored from the agent in use, so an older plugin
// version reading it keeps working.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentId } from "./agents";
import type { Keep } from "./threads";

/** An environment variable: a secret one's value is in the Keychain and empty here. */
export type Var = { key: string; value: string; selected: boolean; secret: boolean };
export type CustomAgent = { id: string; name: string; command: string; vars: Var[] };
/** A built-in agent's id, or `custom:<id>`. */
export type ConnectionId = BuiltInId | `custom:${string}`;
export type BuiltInId = Exclude<AgentId, "custom">;
/** The last time an agent was started from the settings, and how it went. */
export type Tested = { ok: boolean; at: number; text: string };

/** The Model API agent's setup, as its TOOLBELT_MODEL_API_* variables take it ("" for the default). */
export type ModelApiSettings = {
	preset: string;
	url: string;
	api: string;
	model: string;
	thinking: string;
	maxOutput: string;
	context: string;
	maxSteps: string;
	instructions: string;
	extra: string;
};
export const MODEL_API_DEFAULTS: ModelApiSettings = { preset: "omlx", url: "", api: "auto", model: "", thinking: "off", maxOutput: "", context: "", maxSteps: "", instructions: "", extra: "" };
/** The Model API agent's key, in the Keychain. */
export const MODEL_API_KEY = "model-api/key";

export type Settings = {
	/** Null until the person picks one (first run opens the settings). */
	active: ConnectionId | null;
	custom: CustomAgent[];
	/** Environment variables of the built-in agents that take them (see `AgentKind.env`). */
	vars: Partial<Record<BuiltInId, Var[]>>;
	modelApi: ModelApiSettings;
	tested: Partial<Record<ConnectionId, Tested>>;
	/** How long chats are kept: not at all, 30 or 90 days since they were last used, or until deleted. */
	keep: Keep;
	/** Recent chats show in the ask bar under Continue. */
	recent: boolean;
};

export const DEFAULTS: Settings = { active: null, custom: [], vars: {}, modelApi: MODEL_API_DEFAULTS, tested: {}, keep: "30", recent: true };
const KEEP: Keep[] = ["off", "30", "90", "forever"];
const BUILT_IN = AGENTS.map((a) => a.id) as string[];
const TAKES_ENV = AGENTS.filter((a) => a.env).map((a) => a.id) as string[];

/** Names that look like they hold a secret: such variables are kept in the Keychain. */
export const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i;

export const customId = (id: string): ConnectionId => `custom:${id}`;
export const isCustom = (id: string): id is `custom:${string}` => id.startsWith("custom:");
export const findCustom = (s: Settings, id: string) => s.custom.find((c) => customId(c.id) === id);
/** Whether an id names an agent that exists in these settings. */
export const exists = (s: Settings, id: string): id is ConnectionId => BUILT_IN.includes(id) || !!findCustom(s, id);
/** Where an agent's secret variables are kept: `agents/<id>/env/<NAME>`. */
export const secretPrefix = (id: ConnectionId) => `agents/${id.replace(":", "-")}/env`;
/** An agent's variables: a built-in one's, or a custom one's. */
export const varsOf = (s: Settings, id: ConnectionId): Var[] => (isCustom(id) ? (findCustom(s, id)?.vars ?? []) : (s.vars[id] ?? []));

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Environment lines (`NAME=value`, blank lines and `#` comments skipped) as variables; lines that
 * aren't one are dropped. A name that looks secret is marked secret, its value still here until
 * it's moved to the Keychain (`toKeychain` in index.ts).
 */
export function varsFromLines(text: string): Var[] {
	const vars: Var[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const at = line.indexOf("=");
		if (!line || line.startsWith("#") || at <= 0) continue;
		const key = line.slice(0, at).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		vars.push({ key, value: line.slice(at + 1).trim(), selected: true, secret: SECRET_KEY.test(key) });
	}
	return vars;
}

/** Variables as lines, for older plugin versions: secrets (whose values aren't here) left out. */
export const linesFromVars = (vars: Var[]) =>
	vars
		.filter((v) => v.key && v.selected && !v.secret)
		.map((v) => `${v.key}=${v.value}`)
		.join("\n");

function parseVars(raw: unknown): Var[] | null {
	if (!Array.isArray(raw)) return null;
	return raw
		.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && typeof (v as Var).key === "string")
		.map((v) => ({ key: str(v.key), value: str(v.value), selected: v.selected !== false, secret: v.secret === true }));
}

function parseModelApi(raw: unknown): ModelApiSettings {
	const out = { ...MODEL_API_DEFAULTS };
	if (raw && typeof raw === "object") for (const k of Object.keys(out) as (keyof ModelApiSettings)[]) if (typeof (raw as Record<string, unknown>)[k] === "string") out[k] = (raw as Record<string, string>)[k];
	return out;
}

export function loadSettings(dir: string): Settings {
	const file = join(dir, "settings.json");
	if (!existsSync(file)) return structuredClone(DEFAULTS);
	try {
		return parseSettings(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return structuredClone(DEFAULTS);
	}
}

export function parseSettings(raw: Record<string, unknown>): Settings {
	const custom: CustomAgent[] = [];
	if (Array.isArray(raw.custom))
		for (const c of raw.custom as Record<string, unknown>[]) {
			const id = str(c?.id);
			if (/^[a-z0-9]{1,16}$/.test(id) && !custom.some((x) => x.id === id)) custom.push({ id, name: str(c.name), command: str(c.command), vars: parseVars(c.vars) ?? varsFromLines(str(c.env)) });
		}
	let active: ConnectionId | null = null;
	if (typeof raw.active === "string") active = raw.active as ConnectionId;
	else if (raw.agent === "custom") {
		// The first version kept one custom agent in flat fields.
		if (!custom.length) custom.push({ id: "1", name: str(raw.customName), command: str(raw.customCommand), vars: varsFromLines(str(raw.customEnv)) });
		active = customId(custom[0].id);
	} else if (BUILT_IN.includes(raw.agent as string)) active = raw.agent as ConnectionId;
	const vars: Settings["vars"] = {};
	const savedVars = raw.vars && typeof raw.vars === "object" ? (raw.vars as Record<string, unknown>) : {};
	const lines = raw.env && typeof raw.env === "object" ? (raw.env as Record<string, unknown>) : {};
	for (const id of TAKES_ENV) {
		const v = parseVars(savedVars[id]) ?? (typeof lines[id] === "string" ? varsFromLines(lines[id] as string) : null);
		if (v?.length) vars[id as BuiltInId] = v;
	}
	const settings: Settings = {
		active: null,
		custom,
		vars,
		modelApi: parseModelApi(raw.modelApi),
		tested: {},
		keep: KEEP.includes(raw.keep as Keep) ? (raw.keep as Keep) : DEFAULTS.keep,
		recent: typeof raw.recent === "boolean" ? raw.recent : DEFAULTS.recent,
	};
	if (active && exists(settings, active)) settings.active = active;
	if (raw.tested && typeof raw.tested === "object")
		for (const [id, t] of Object.entries(raw.tested as Record<string, Partial<Tested>>))
			if (exists(settings, id) && typeof t?.ok === "boolean" && typeof t.at === "number") settings.tested[id] = { ok: t.ok, at: t.at, text: str(t.text) };
	return settings;
}

/**
 * Saves atomically: a crash mid-write leaves the previous file. A secret variable's value is only
 * here until it's moved to the Keychain (a value from an older version's lines; see `toKeychain`).
 */
export function saveSettings(dir: string, settings: Settings) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "settings.json");
	const clean = (vars: Var[]) => vars.map((v) => ({ key: v.key, value: v.value, selected: v.selected, secret: v.secret }));
	const custom = settings.custom.map((c) => ({ ...c, vars: clean(c.vars), env: linesFromVars(c.vars) }));
	const vars = Object.fromEntries(Object.entries(settings.vars).map(([id, v]) => [id, clean(v ?? [])]));
	const env = Object.fromEntries(Object.entries(settings.vars).map(([id, v]) => [id, linesFromVars(v ?? [])]));
	const active = settings.active ? custom.find((c) => customId(c.id) === settings.active) : undefined;
	const legacy = {
		agent: !settings.active ? null : active ? "custom" : settings.active,
		customName: active?.name ?? "",
		customCommand: active?.command ?? "",
		customEnv: active?.env ?? "",
	};
	writeFileSync(`${file}.tmp`, JSON.stringify({ ...legacy, ...settings, custom, vars, env }, null, 2) + "\n");
	renameSync(`${file}.tmp`, file);
}
