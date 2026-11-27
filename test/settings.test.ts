import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, parseSettings, saveSettings } from "../src/settings";

test("the first version's settings carry over", () => {
	expect(parseSettings({ agent: "codex", customName: "", customCommand: "", customEnv: "" })).toEqual({ active: "codex", custom: [], env: {}, tested: {}, keep: "30", recent: true });
	expect(parseSettings({ agent: "custom", customName: "oMLX", customCommand: "codex-acp", customEnv: "A=1" })).toEqual({ active: "custom:1", custom: [{ id: "1", name: "oMLX", command: "codex-acp", env: "A=1" }], env: {}, tested: {}, keep: "30", recent: true });
	expect(parseSettings({ agent: null, keep: "90", recent: false })).toEqual({ active: null, custom: [], env: {}, tested: {}, keep: "90", recent: false });
});

test("unknown agents, bad ids and stray results are dropped", () => {
	const s = parseSettings({ active: "custom:9", custom: [{ id: "1", name: "a", command: "b" }, { id: "../x" }, { id: "1", name: "dup" }], tested: { claude: { ok: true, at: 5, text: "ok" }, "custom:7": { ok: true, at: 1 }, codex: { ok: "yes" } } });
	expect(s).toEqual({ active: null, custom: [{ id: "1", name: "a", command: "b", env: "" }], env: {}, tested: { claude: { ok: true, at: 5, text: "ok" } }, keep: "30", recent: true });
});

test("saving keeps the first version's fields for the agent in use, and round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-settings-"));
	const s = { active: "custom:2" as const, custom: [{ id: "2", name: "Local", command: "x --acp", env: "K=v" }], env: { claude: "ANTHROPIC_BASE_URL=http://localhost:8000" }, tested: {}, keep: "forever" as const, recent: true };
	saveSettings(dir, s);
	const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
	expect(raw).toMatchObject({ agent: "custom", customName: "Local", customCommand: "x --acp", customEnv: "K=v" });
	expect(loadSettings(dir)).toEqual(s);
	writeFileSync(join(dir, "settings.json"), "{not json");
	expect(loadSettings(dir)).toEqual({ active: null, custom: [], env: {}, tested: {}, keep: "30", recent: true });
});

test("only built-in agents that take environment lines keep them", () => {
	expect(parseSettings({ env: { claude: "ANTHROPIC_MODEL=local", codex: "X=1", "custom:1": "Y=2", gemini: 3 } }).env).toEqual({ claude: "ANTHROPIC_MODEL=local" });
	expect(parseSettings({ env: "nope" }).env).toEqual({});
});
