import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoApi, destination, ENV, extraFields, isLocal, listModels, preset, readConfig } from "../src/model-api/config";
import { piModel, serverFetch } from "../src/model-api/models";
import { ModelApiServer } from "../src/model-api/server";
import { fakeMcp, fakeModelServer } from "./model-api-fakes";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});

/** A server and a client talking to it, collecting what it sends. */
function client(env: Record<string, string>, calls: { name: string; args: unknown }[] = []) {
	const out: any[] = [];
	const server = new ModelApiServer({ version: "test", env, send: (line) => out.push(JSON.parse(line)), startMcp: () => fakeMcp(calls)(), now: () => new Date("2026-11-26T09:00:00") });
	cleanup.push(() => server.close());
	let id = 0;
	const request = async (method: string, params: unknown) => {
		const n = ++id;
		await server.receive(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
		const reply = out.find((m) => m.id === n);
		if (reply?.error) throw new Error(reply.error.message);
		return reply?.result;
	};
	const updates = () => out.filter((m) => m.method === "session/update").map((m) => m.params.update);
	return { request, updates, out, server };
}

const MCP = [{ name: "toolbelt", command: "bun", args: ["toolbelt", "mcp"], env: [] }];

function env(url: string, extra: Record<string, string> = {}) {
	return { [ENV.preset]: "omlx", [ENV.url]: url, [ENV.model]: "small", [ENV.key]: "secret-key", ...extra };
}

describe("settings", () => {
	test("presets pick their API; another address is guessed from its host", () => {
		expect(readConfig({ [ENV.preset]: "anthropic", [ENV.model]: "claude" }).api).toBe("messages");
		expect(readConfig({ [ENV.preset]: "openai", [ENV.model]: "gpt" }).api).toBe("responses");
		expect(readConfig({ [ENV.preset]: "ollama", [ENV.model]: "qwen" }).api).toBe("chat");
		expect(autoApi(preset("other"), "https://api.anthropic.com/v1")).toBe("messages");
		expect(autoApi(preset("other"), "https://example.com/v1")).toBe("chat");
		expect(readConfig({ [ENV.preset]: "anthropic", [ENV.model]: "claude", [ENV.api]: "chat" }).api).toBe("chat");
	});

	test("explains what's missing or wrong", () => {
		expect(() => readConfig({ [ENV.preset]: "omlx" })).toThrow(/No model/);
		expect(() => readConfig({ [ENV.preset]: "other", [ENV.model]: "m" })).toThrow(/No server address/);
		expect(() => readConfig({ [ENV.preset]: "omlx", [ENV.model]: "m", [ENV.url]: "localhost:8000" })).toThrow(/http/);
		expect(() => readConfig({ [ENV.preset]: "omlx", [ENV.model]: "m", [ENV.thinking]: "max" })).toThrow(/Thinking/);
		expect(() => readConfig({ [ENV.preset]: "omlx", [ENV.model]: "m", [ENV.maxSteps]: "0" })).toThrow(/Tool steps/);
		expect(() => extraFields("[1]")).toThrow(/JSON object/);
		expect(() => extraFields('{"messages": []}')).toThrow(/can't set messages/);
		expect(extraFields('{"top_k": 20}')).toEqual({ top_k: 20 });
	});

	test("says where chats go", () => {
		expect(isLocal("http://127.0.0.1:8000/v1")).toBe(true);
		expect(isLocal("http://localhost:11434/v1")).toBe(true);
		expect(isLocal("http://[::1]:8080/v1")).toBe(true);
		expect(isLocal("http://10.0.0.5:8000/v1")).toBe(false);
		expect(destination("http://127.0.0.1:8000/v1")).toBe("Stays on this Mac");
		expect(destination("https://openrouter.ai/api/v1")).toBe("Sends chats to openrouter.ai");
		expect(destination("https://api.openai.com/v1")).toBe("Sends chats to openai.com");
	});

	test("switches thinking the way each server expects", () => {
		const omlx = piModel(readConfig({ [ENV.preset]: "omlx", [ENV.model]: "m" })) as any;
		expect(omlx.compat.thinkingFormat).toBe("chat-template");
		const openai = piModel(readConfig({ [ENV.preset]: "openai", [ENV.model]: "m", [ENV.api]: "chat" })) as any;
		expect(openai.compat).toMatchObject({ thinkingFormat: "openai", maxTokensField: "max_completion_tokens", supportsDeveloperRole: true });
		const anthropic = piModel(readConfig({ [ENV.preset]: "anthropic", [ENV.model]: "m" })) as any;
		expect(anthropic.baseUrl).toBe("https://api.anthropic.com");
	});

	test("lists the server's models", async () => {
		const fake = fakeModelServer();
		cleanup.push(fake.stop);
		expect(await listModels({ url: fake.url, api: "chat", key: "k" })).toEqual([{ id: "small", context: 65536 }, { id: "big" }]);
		expect(fake.seen[0]!.headers.authorization).toBe("Bearer k");
		await listModels({ url: fake.url, api: "messages", key: "k" });
		expect(fake.seen[1]!.headers["x-api-key"]).toBe("k");
	});
});

describe("only the configured server", () => {
	test("adds the extra fields and refuses other addresses", async () => {
		const seen: { url: string; body: string }[] = [];
		const inner = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), body: String(init?.body) });
			return new Response("{}");
		}) as typeof fetch;
		const f = serverFetch(readConfig({ [ENV.preset]: "omlx", [ENV.model]: "m", [ENV.extra]: '{"top_k": 20, "max_tokens": 1}' }), inner);
		await f("http://127.0.0.1:8000/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 500 }) });
		expect(JSON.parse(seen[0]!.body)).toEqual({ top_k: 20, max_tokens: 500, model: "m" });
		await expect(f("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })).rejects.toThrow(/only talks to http:\/\/127.0.0.1:8000/);
		expect(seen).toHaveLength(1);
	});
});

describe.each([
	["chat", "/v1/chat/completions"],
	["responses", "/v1/responses"],
	["messages", "/v1/messages"],
] as const)("a conversation over %s", (api, path) => {
	test("calls ToolBelt's tool, streams the answer and ends the turn", async () => {
		const fake = fakeModelServer();
		cleanup.push(fake.stop);
		const calls: { name: string; args: unknown }[] = [];
		const c = client(env(fake.url, { [ENV.api]: api }), calls);
		const hello = await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		expect(hello).toMatchObject({ protocolVersion: 1, agentInfo: { name: "toolbelt-model-api", title: "Model API" }, agentCapabilities: { loadSession: false } });
		const { sessionId } = await c.request("session/new", { cwd: "/tmp", mcpServers: MCP });
		const result = await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "What's due today?" }] });
		expect(result).toEqual({ stopReason: "end_turn" });
		expect(calls).toEqual([{ name: "read_screen", args: { plugin: "ontrack" } }]);

		const updates = c.updates();
		const tool = updates.find((u) => u.sessionUpdate === "tool_call");
		expect(tool).toMatchObject({ title: "toolbelt.read_screen", status: "in_progress", rawInput: { plugin: "ontrack" } });
		expect(updates.find((u) => u.sessionUpdate === "tool_call_update")).toMatchObject({ toolCallId: tool.toolCallId, status: "completed" });
		const answer = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
		expect(answer).toBe("You have 2 tasks due today.");

		const requests = fake.seen.filter((s) => s.path === path);
		expect(requests).toHaveLength(2);
		const first = JSON.stringify(requests[0]!.body);
		expect(first).toContain("Read a screen before answering"); // ToolBelt's instructions
		expect(first).toContain("Thursday, November 26, 2026");
		expect(first).toContain("read_screen");
		if (api === "messages") expect(requests[0]!.headers["x-api-key"]).toBe("secret-key");
		else expect(requests[0]!.headers.authorization).toBe("Bearer secret-key");
		if (api === "chat") expect(requests[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});

describe("conversations", () => {
	test("a model error reads as something to act on", async () => {
		const fake = fakeModelServer({ fail: 401 });
		cleanup.push(fake.stop);
		const c = client(env(fake.url));
		await c.request("initialize", { protocolVersion: 1 });
		const { sessionId } = await c.request("session/new", { cwd: "/tmp", mcpServers: MCP });
		await expect(c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hi" }] })).rejects.toThrow(/refused the API key/);
	});

	test("settings problems are reported for the session, and without ToolBelt there's no session", async () => {
		const c = client({ [ENV.preset]: "omlx" });
		await c.request("initialize", { protocolVersion: 1 });
		await expect(c.request("session/new", { cwd: "/tmp", mcpServers: MCP })).rejects.toThrow(/No model/);
		const d = client(env("http://127.0.0.1:9/v1"));
		await expect(d.request("session/new", { cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/No ToolBelt MCP server/);
		await expect(d.request("session/fork", {})).rejects.toThrow(/Not offered/);
	});

	test("a kept chat reopens with its history, in a new process", async () => {
		const fake = fakeModelServer();
		cleanup.push(fake.stop);
		const state = mkdtempSync(join(tmpdir(), "model-api-"));
		cleanup.push(() => rmSync(state, { recursive: true, force: true }));
		const first = client(env(fake.url, { [ENV.state]: state }));
		expect(await first.request("initialize", { protocolVersion: 1 })).toMatchObject({ agentCapabilities: { loadSession: true } });
		const { sessionId } = await first.request("session/new", { cwd: "/tmp", mcpServers: MCP });
		await first.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "What's due today?" }] });
		await first.server.close();

		const second = client(env(fake.url, { [ENV.state]: state }));
		await second.request("initialize", { protocolVersion: 1 });
		expect(await second.request("session/load", { sessionId, cwd: "/tmp", mcpServers: MCP })).toEqual({});
		const history = second.updates();
		expect(history[0]).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "What's due today?" } });
		expect(history.at(-1)).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You have 2 tasks due today." } });
		await expect(second.request("session/load", { sessionId: "00000000-0000-0000-0000-000000000000", cwd: "/tmp", mcpServers: MCP })).rejects.toThrow(/isn't kept/);
	});
});

describe("cancelling", () => {
	test("a cancelled answer ends the turn as cancelled", async () => {
		const fake = fakeModelServer({ delayMs: 400 });
		cleanup.push(fake.stop);
		const c = client(env(fake.url));
		await c.request("initialize", { protocolVersion: 1 });
		const { sessionId } = await c.request("session/new", { cwd: "/tmp", mcpServers: MCP });
		const answering = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "What's due today?" }] });
		await Bun.sleep(100);
		await c.server.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }));
		expect(await answering).toEqual({ stopReason: "cancelled" });
	});
});

// The bundle too: bundling once left a lazily imported module uninitialized.
describe.each(["source", "bundle"])("the agent process (%s)", (kind) => {
	test("starts ToolBelt's MCP server, answers over ACP, and gives the MCP server no API key", async () => {
		const fake = fakeModelServer();
		cleanup.push(fake.stop);
		let entry = join(import.meta.dir, "../src/model-api/main.ts");
		if (kind === "bundle") {
			const dir = mkdtempSync(join(tmpdir(), "model-api-bundle-"));
			cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
			const built = await Bun.build({ entrypoints: [entry], target: "bun", minify: true });
			if (!built.success || built.outputs.length !== 1) throw new AggregateError(built.logs, "bundle failed");
			entry = join(dir, "model-api.js");
			await Bun.write(entry, built.outputs[0]!);
		}
		const proc = Bun.spawn(["bun", entry], {
			env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env(fake.url), FAKE_SCREEN: "OnTrack" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanup.push(() => void proc.kill());
		const lines: any[] = [];
		const reader = (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) lines.push(JSON.parse(buffer.slice(0, at)));
			}
		})();
		const send = (m: unknown) => {
			proc.stdin.write(JSON.stringify(m) + "\n");
			proc.stdin.flush();
		};
		const reply = async (id: number) => {
			for (let i = 0; i < 200 && !lines.some((l) => l.id === id); i++) await Bun.sleep(25);
			return lines.find((l) => l.id === id);
		};
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		expect((await reply(1)).result.protocolVersion).toBe(1);
		const mcp = [{ name: "toolbelt", command: "bun", args: [join(import.meta.dir, "fake-mcp-server.ts")], env: [] }];
		send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: mcp } });
		const sessionId = (await reply(2)).result.sessionId;
		send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "What's due today?" }] } });
		expect((await reply(3)).result).toEqual({ stopReason: "end_turn" });
		const toolResult = lines.find((l) => l.params?.update?.sessionUpdate === "tool_call_update");
		expect(toolResult.params.update.rawOutput).toBe("OnTrack: 2 tasks today (key: none)");
		proc.stdin.end();
		expect(await proc.exited).toBe(0);
		await reader;
	});
});
