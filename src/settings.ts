// The person's choices, kept in the plugin's data folder (`settings.json`). Data schema 1.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "./agents";

export type Settings = {
	/** Null until the person picks one (first run opens settings). */
	agent: AgentId | null;
	customName: string;
	customCommand: string;
	/** `NAME=value` lines added to the custom agent's environment. */
	customEnv: string;
};

export const DEFAULTS: Settings = { agent: null, customName: "", customCommand: "", customEnv: "" };
const AGENT_IDS: AgentId[] = ["claude", "codex", "gemini", "custom"];

export function loadSettings(dir: string): Settings {
	const file = join(dir, "settings.json");
	if (!existsSync(file)) return { ...DEFAULTS };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
		return {
			agent: AGENT_IDS.includes(raw.agent as AgentId) ? (raw.agent as AgentId) : null,
			customName: typeof raw.customName === "string" ? raw.customName : "",
			customCommand: typeof raw.customCommand === "string" ? raw.customCommand : "",
			customEnv: typeof raw.customEnv === "string" ? raw.customEnv : "",
		};
	} catch {
		return { ...DEFAULTS };
	}
}

/** Saves atomically: a crash mid-write leaves the previous file. */
export function saveSettings(dir: string, settings: Settings) {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "settings.json");
	writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n");
	renameSync(`${file}.tmp`, file);
}
