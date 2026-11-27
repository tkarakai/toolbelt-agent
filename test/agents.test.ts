import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelApiCommand, parseEnv, resolveAgent, splitCommand, which } from "../src/agents";

const dir = mkdtempSync(join(tmpdir(), "agent-bin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tool = (name: string) => {
	writeFileSync(join(dir, name), "#!/bin/sh\n");
	chmodSync(join(dir, name), 0o755);
};

test("splits command lines like a shell, without running one", () => {
	expect(splitCommand(`codex-acp -c 'model="local"' --flag "a b" c\\ d`)).toEqual(["codex-acp", "-c", 'model="local"', "--flag", "a b", "c d"]);
	expect(splitCommand("  ")).toEqual([]);
	expect(splitCommand(`x ""`)).toEqual(["x", ""]);
	expect(() => splitCommand(`x "open`)).toThrow("unclosed quote");
});

test("reads NAME=value environment lines", () => {
	expect(parseEnv("# local model\nOPENAI_BASE_URL=http://localhost:8000/v1\n\nKEY = a=b ")).toEqual({ OPENAI_BASE_URL: "http://localhost:8000/v1", KEY: "a=b" });
	expect(() => parseEnv("nope")).toThrow("NAME=value");
	expect(() => parseEnv("1X=y")).toThrow("valid environment variable name");
});

test("finds an agent's ACP command on the path, or says how to install it", () => {
	tool("claude-agent-acp");
	tool("gemini");
	expect(which("claude-agent-acp", `/nonexistent:${dir}`)).toBe(join(dir, "claude-agent-acp"));
	expect(resolveAgent({ agent: "claude" }, dir)).toEqual({ ok: true, id: "claude", name: "Claude Code", command: [join(dir, "claude-agent-acp")], env: {} });
	expect(resolveAgent({ agent: "gemini" }, dir)).toMatchObject({ ok: true, command: [join(dir, "gemini"), "--acp"] });
	expect(resolveAgent({ agent: "codex" }, dir)).toMatchObject({ ok: false, name: "Codex", install: "npm install -g @agentclientprotocol/codex-acp" });
});

test("a custom agent runs its own command with its environment", () => {
	tool("my-agent");
	expect(resolveAgent({ agent: "custom", customName: "Local", customCommand: "my-agent --acp", env: { OPENAI_BASE_URL: "http://localhost:8000/v1" } }, dir)).toEqual({
		ok: true,
		id: "custom",
		name: "Local",
		command: [join(dir, "my-agent"), "--acp"],
		env: { OPENAI_BASE_URL: "http://localhost:8000/v1" },
	});
	expect(resolveAgent({ agent: "custom", customCommand: "" }, dir)).toMatchObject({ ok: false, reason: expect.stringContaining("Enter the command") });
	expect(resolveAgent({ agent: "custom", customCommand: "missing-agent" }, dir)).toMatchObject({ ok: false, reason: expect.stringContaining("can't find `missing-agent`") });
	expect(resolveAgent({ agent: "custom", customCommand: "'my-agent" }, dir)).toMatchObject({ ok: false, reason: expect.stringContaining("unclosed quote") });
});

test("the Model API agent is always there: ToolBelt's Bun running the bundled agent", () => {
	const r = resolveAgent({ agent: "model-api", env: { TOOLBELT_MODEL_API_MODEL: "qwen" } }, "/nonexistent");
	expect(r).toMatchObject({ ok: true, id: "model-api", name: "Model API", env: { TOOLBELT_MODEL_API_MODEL: "qwen" } });
	expect((r as { command: string[] }).command[0]).toBe(process.execPath);
	expect(modelApiCommand("/pkg")).toEqual([process.execPath, "/pkg/model-api/main.ts"]);
});

