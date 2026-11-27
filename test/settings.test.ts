import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, parseSettings, saveSettings } from "../src/settings";

test("the first version's settings carry over", () => {
	expect(parseSettings({ agent: "codex", customName: "", customCommand: "", customEnv: "" })).toEqual({ active: "codex", custom: [], tested: {} });
	expect(parseSettings({ agent: "custom", customName: "oMLX", customCommand: "codex-acp", customEnv: "A=1" })).toEqual({ active: "custom:1", custom: [{ id: "1", name: "oMLX", command: "codex-acp", env: "A=1" }], tested: {} });
	expect(parseSettings({ agent: null })).toEqual({ active: null, custom: [], tested: {} });
});

test("unknown agents, bad ids and stray results are dropped", () => {
	const s = parseSettings({ active: "custom:9", custom: [{ id: "1", name: "a", command: "b" }, { id: "../x" }, { id: "1", name: "dup" }], tested: { claude: { ok: true, at: 5, text: "ok" }, "custom:7": { ok: true, at: 1 }, codex: { ok: "yes" } } });
	expect(s).toEqual({ active: null, custom: [{ id: "1", name: "a", command: "b", env: "" }], tested: { claude: { ok: true, at: 5, text: "ok" } } });
});

test("saving keeps the first version's fields for the agent in use, and round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-settings-"));
	const s = { active: "custom:2" as const, custom: [{ id: "2", name: "Local", command: "x --acp", env: "K=v" }], tested: {} };
	saveSettings(dir, s);
	const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
	expect(raw).toMatchObject({ agent: "custom", customName: "Local", customCommand: "x --acp", customEnv: "K=v" });
	expect(loadSettings(dir)).toEqual(s);
	writeFileSync(join(dir, "settings.json"), "{not json");
	expect(loadSettings(dir)).toEqual({ active: null, custom: [], tested: {} });
});
