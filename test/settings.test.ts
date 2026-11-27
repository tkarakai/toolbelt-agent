import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, linesFromVars, loadSettings, MODEL_API_DEFAULTS, parseSettings, saveSettings, secretPrefix, varsFromLines, type Settings } from "../src/settings";

const base = { vars: {}, modelApi: MODEL_API_DEFAULTS, tested: {}, keep: "30", recent: true };

test("the first version's settings carry over", () => {
	expect(parseSettings({ agent: "codex", customName: "", customCommand: "", customEnv: "" })).toEqual({ ...base, active: "codex", custom: [] } as Settings);
	expect(parseSettings({ agent: "custom", customName: "oMLX", customCommand: "codex-acp", customEnv: "A=1" })).toEqual({ ...base, active: "custom:1", custom: [{ id: "1", name: "oMLX", command: "codex-acp", vars: [{ key: "A", value: "1", selected: true, secret: false }] }] } as Settings);
	expect(parseSettings({ agent: null, keep: "90", recent: false })).toEqual({ ...base, active: null, custom: [], keep: "90", recent: false } as Settings);
});

test("unknown agents, bad ids and stray results are dropped", () => {
	const s = parseSettings({ active: "custom:9", custom: [{ id: "1", name: "a", command: "b" }, { id: "../x" }, { id: "1", name: "dup" }], tested: { claude: { ok: true, at: 5, text: "ok" }, "custom:7": { ok: true, at: 1 }, codex: { ok: "yes" } } });
	expect(s).toEqual({ ...base, active: null, custom: [{ id: "1", name: "a", command: "b", vars: [] }], tested: { claude: { ok: true, at: 5, text: "ok" } } } as Settings);
});

test("environment lines become variables; secret-looking names are marked secret", () => {
	expect(varsFromLines("# local\nANTHROPIC_BASE_URL=http://127.0.0.1:8000\n\nANTHROPIC_AUTH_TOKEN = abc=1\nbad line\n1X=y")).toEqual([
		{ key: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8000", selected: true, secret: false },
		{ key: "ANTHROPIC_AUTH_TOKEN", value: "abc=1", selected: true, secret: true },
	]);
	expect(linesFromVars([{ key: "A", value: "1", selected: true, secret: false }, { key: "B_TOKEN", value: "", selected: true, secret: true }, { key: "C", value: "3", selected: false, secret: false }])).toBe("A=1");
	expect(secretPrefix("claude")).toBe("agents/claude/env");
	expect(secretPrefix("custom:2")).toBe("agents/custom-2/env");
});

test("an older version's Claude Code lines load as variables; only agents that take them keep them", () => {
	const s = parseSettings({ env: { claude: "ANTHROPIC_MODEL=local\nANTHROPIC_AUTH_TOKEN=t", codex: "X=1", gemini: 3 } });
	expect(s.vars).toEqual({
		claude: [
			{ key: "ANTHROPIC_MODEL", value: "local", selected: true, secret: false },
			{ key: "ANTHROPIC_AUTH_TOKEN", value: "t", selected: true, secret: true },
		],
	});
	expect(parseSettings({ env: "nope" }).vars).toEqual({});
	// Saved variables win over the mirrored lines.
	expect(parseSettings({ vars: { claude: [{ key: "A", value: "", selected: false, secret: true }] }, env: { claude: "B=2" } }).vars).toEqual({ claude: [{ key: "A", value: "", selected: false, secret: true }] });
});

test("the Model API settings load field by field, with defaults", () => {
	expect(parseSettings({ modelApi: { preset: "openrouter", model: "qwen/qwen3.8-27b", thinking: 3, bogus: "x" } }).modelApi).toEqual({ ...MODEL_API_DEFAULTS, preset: "openrouter", model: "qwen/qwen3.8-27b" });
	expect(parseSettings({}).modelApi).toEqual(MODEL_API_DEFAULTS);
});

test("saving keeps older versions' fields, without secret values, and round-trips", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-settings-"));
	const s: Settings = {
		...DEFAULTS,
		active: "custom:2",
		custom: [{ id: "2", name: "Local", command: "x --acp", vars: [{ key: "K", value: "v", selected: true, secret: false }, { key: "API_KEY", value: "", selected: true, secret: true }] }],
		vars: { claude: [{ key: "ANTHROPIC_BASE_URL", value: "http://localhost:8000", selected: true, secret: false }] },
		modelApi: { ...MODEL_API_DEFAULTS, preset: "ollama", model: "qwen3" },
		keep: "forever",
	};
	saveSettings(dir, s);
	const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
	expect(raw).toMatchObject({ agent: "custom", customName: "Local", customCommand: "x --acp", customEnv: "K=v", env: { claude: "ANTHROPIC_BASE_URL=http://localhost:8000" } });
	expect(raw.custom[0].env).toBe("K=v");
	expect(loadSettings(dir)).toEqual(s);
	writeFileSync(join(dir, "settings.json"), "{not json");
	expect(loadSettings(dir)).toEqual(DEFAULTS);
});
