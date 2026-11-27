// The person's agents, kept in the plugin's data folder (`settings.json`). Data schema 1.
//
// Every agent keeps its own setup: the built-in ones (Claude Code, Codex, Gemini CLI; Claude Code
// can take environment lines, to use another model or server) and any number of custom ACP agents. One of them is in use. Switching only happens once the new one has
// started (see index.ts), so the one in use is always the last one that worked.
//
// The file is additive over the first version: it still has `agent`, `customName`,
// `customCommand` and `customEnv`, mirrored from the agent in use, so an older plugin version
// reading it keeps working.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentId } from "./agents";
import type { Keep } from "./threads";

export type CustomAgent = { id: string; name: string; command: string; env: string };
/** A built-in agent's id, or `custom:<id>`. */
export type ConnectionId = BuiltInId | `custom:${string}`;
export type BuiltInId = Exclude<AgentId, "custom">;
/** The last time an agent was started from the settings, and how it went. */
export type Tested = { ok: boolean; at: number; text: string };

export type Settings = {
	/** Null until the person picks one (first run opens the settings). */
	active: ConnectionId | null;
	custom: CustomAgent[];
	/** Environment lines of the built-in agents that take them (see `AgentKind.env`). */
	env: Partial<Record<BuiltInId, string>>;
	tested: Partial<Record<ConnectionId, Tested>>;
	/** How long chats are kept: not at all, 30 or 90 days since they were last used, or until deleted. */
	keep: Keep;
	/** Recent chats show in the ask bar under Continue. */
	recent: boolean;
};

export const DEFAULTS: Settings = { active: null, custom: [], env: {}, tested: {}, keep: "30", recent: true };
const KEEP: Keep[] = ["off", "30", "90", "forever"];
const BUILT_IN = AGENTS.map((a) => a.id) as string[];
const TAKES_ENV = AGENTS.filter((a) => a.env).map((a) => a.id) as string[];

export const customId = (id: string): ConnectionId => `custom:${id}`;
export const isCustom = (id: string): id is `custom:${string}` => id.startsWith("custom:");
export const findCustom = (s: Settings, id: string) => s.custom.find((c) => customId(c.id) === id);
/** Whether an id names an agent that exists in these settings. */
export const exists = (s: Settings, id: string): id is ConnectionId => BUILT_IN.includes(id) || !!findCustom(s, id);

const str = (v: unknown) => (typeof v === "string" ? v : "");

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
			if (/^[a-z0-9]{1,16}$/.test(id) && !custom.some((x) => x.id === id)) custom.push({ id, name: str(c.name), command: str(c.command), env: str(c.env) });
		}
	let active: ConnectionId | null = null;
	if (typeof raw.active === "string") active = raw.active as ConnectionId;
	else if (raw.agent === "custom") {
		// The first version kept one custom agent in flat fields.
		if (!custom.length) custom.push({ id: "1", name: str(raw.customName), command: str(raw.customCommand), env: str(raw.customEnv) });
		active = customId(custom[0].id);
	} else if (BUILT_IN.includes(raw.agent as string)) active = raw.agent as ConnectionId;
	const env: Settings["env"] = {};
	if (raw.env && typeof raw.env === "object")
		for (const [id, lines] of Object.entries(raw.env as Record<string, unknown>)) if (TAKES_ENV.includes(id) && typeof lines === "string" && lines) env[id as BuiltInId] = lines;
	const settings: Settings = { active: null, custom, env, tested: {}, keep: KEEP.includes(raw.keep as Keep) ? (raw.keep as Keep) : DEFAULTS.keep, recent: typeof raw.recent === "boolean" ? raw.recent : DEFAULTS.recent };
	if (active && exists(settings, active)) settings.active = active;
	if (raw.tested && typeof raw.tested === "object")
		for (const [id, t] of Object.entries(raw.tested as Record<string, Partial<Tested>>))
			if (exists(settings, id) && typeof t?.ok === "boolean" && typeof t.at === "number") settings.tested[id] = { ok: t.ok, at: t.at, text: str(t.text) };
	return settings;
}

/** Saves atomically: a crash mid-write leaves the previous file. */
export function saveSettings(dir: string, settings: Settings) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "settings.json");
	const active = settings.active ? findCustom(settings, settings.active) : undefined;
	const legacy = {
		agent: !settings.active ? null : active ? "custom" : settings.active,
		customName: active?.name ?? "",
		customCommand: active?.command ?? "",
		customEnv: active?.env ?? "",
	};
	writeFileSync(`${file}.tmp`, JSON.stringify({ ...legacy, ...settings }, null, 2) + "\n");
	renameSync(`${file}.tmp`, file);
}
