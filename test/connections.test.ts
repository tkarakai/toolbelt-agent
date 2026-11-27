import { expect, test } from "bun:test";
import { connection, environment, modelApiEnvironment, resolveConnection } from "../src/connections";
import { DEFAULTS, MODEL_API_DEFAULTS, type Settings } from "../src/settings";

const v = (key: string, value: string, secret = false, selected = true) => ({ key, value, selected, secret });
const keychain = (items: Record<string, string>) => async (name: string) => items[name] ?? null;

test("an agent's environment: selected variables, secret ones from the Keychain", async () => {
	const env = await environment("claude", [v("ANTHROPIC_BASE_URL", "http://127.0.0.1:8000"), v("ANTHROPIC_AUTH_TOKEN", "", true), v("OFF", "x", false, false)], keychain({ "agents/claude/env/ANTHROPIC_AUTH_TOKEN": "t0k" }));
	expect(env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8000", ANTHROPIC_AUTH_TOKEN: "t0k" });
	await expect(environment("custom:1", [v("API_KEY", "", true)], keychain({}))).rejects.toThrow("API_KEY has no saved value");
	await expect(environment("custom:1", [v("1X", "y")], keychain({}))).rejects.toThrow("isn't a valid environment variable name");
});

test("the Model API agent's variables, its key from the Keychain", async () => {
	const env = await modelApiEnvironment({ ...MODEL_API_DEFAULTS, preset: "openrouter", model: "qwen/qwen3.8-27b", maxSteps: " 8 " }, keychain({ "model-api/key": "sk-or" }), "/data/model-api");
	expect(env).toEqual({
		TOOLBELT_MODEL_API_PRESET: "openrouter",
		TOOLBELT_MODEL_API_API: "auto",
		TOOLBELT_MODEL_API_MODEL: "qwen/qwen3.8-27b",
		TOOLBELT_MODEL_API_THINKING: "off",
		TOOLBELT_MODEL_API_STATE: "/data/model-api",
		TOOLBELT_MODEL_API_MAX_STEPS: "8",
		TOOLBELT_MODEL_API_KEY: "sk-or",
	});
	expect(await modelApiEnvironment(MODEL_API_DEFAULTS, keychain({}), "/d")).not.toHaveProperty("TOOLBELT_MODEL_API_KEY");
});

test("a missing secret keeps the agent from starting, and says why", async () => {
	const s: Settings = { ...DEFAULTS, vars: { claude: [v("ANTHROPIC_AUTH_TOKEN", "", true)] } };
	const r = await resolveConnection(connection(s, "claude")!, "/nonexistent", keychain({}), "/data");
	expect(r).toMatchObject({ ok: false, id: "claude", reason: expect.stringContaining("ANTHROPIC_AUTH_TOKEN has no saved value") });
	const m = await resolveConnection(connection({ ...DEFAULTS, modelApi: { ...MODEL_API_DEFAULTS, model: "qwen" } }, "model-api")!, "/nonexistent", keychain({}), "/data");
	expect(m).toMatchObject({ ok: true, id: "model-api", env: { TOOLBELT_MODEL_API_MODEL: "qwen", TOOLBELT_MODEL_API_STATE: "/data/model-api" } });
});
