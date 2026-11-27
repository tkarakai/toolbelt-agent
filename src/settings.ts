// The person's agents, kept in the plugin's data folder (`settings.json`). Data schema 1.
//
// Every agent keeps its own setup: the built-in ones (Claude Code, Codex, Gemini CLI) and any
// number of custom ACP agents. One of them is in use. Switching only happens once the new one has
// started (see index.ts), so the one in use is always the last one that worked.
//
// The file is additive over the first version: it still has `agent`, `customName`,
// `customCommand` and `customEnv`, mirrored from the agent in use, so an older plugin version
// reading it keeps working.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentId } from "./agents";

export type CustomAgent = { id: string; name: string; command: string; env: string };
/** A built-in agent's id, or `custom:<id>`. */
export type ConnectionId = Exclude<AgentId, "custom"> | `custom:${string}`;
/** The last time an agent was started from the settings, and how it went. */
export type Tested = { ok: boolean; at: number; text: string };

export type Settings = {
	/** Null until the person picks one (first run opens the settings). */
	active: ConnectionId | null;
	custom: CustomAgent[];
	tested: Partial<Record<ConnectionId, Tested>>;
};

export const DEFAULTS: Settings = { active: null, custom: [], tested: {} };
const BUILT_IN = AGENTS.map((a) => a.id) as string[];

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
	const settings: Settings = { active: null, custom, tested: {} };
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
