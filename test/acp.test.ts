import { expect, test } from "bun:test";
import { AcpClient, AgentError, type PermissionRequest } from "../src/acp";
import { FakeAgent } from "./fake-agent";

test("initializes without offering files or terminals, opens a session and streams a turn", async () => {
	const updates: unknown[] = [];
	const agent = new FakeAgent(async (a, sessionId) => {
		a.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
		return "end_turn";
	});
	const client = new AcpClient(agent.transport(), { update: (_s, u) => updates.push(u), permission: async () => ({ outcome: "cancelled" }) });
	const hello = await client.initialize({ name: "t", version: "1" });
	expect(hello.agentInfo?.title).toBe("Fake Agent");
	expect(agent.sent[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
	const { sessionId } = await client.newSession("/tmp/x", [{ name: "toolbelt", command: "/bun", args: ["cli", "mcp"], env: [] }]);
	expect(agent.newSession.mcpServers[0].name).toBe("toolbelt");
	expect(await client.prompt(sessionId, [{ type: "text", text: "hello" }])).toEqual({ stopReason: "end_turn" });
	expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }]);
});

test("refuses file-system and terminal requests, and answers permission questions through its owner", async () => {
	let asked: PermissionRequest | null = null;
	const agent = new FakeAgent();
	new AcpClient(agent.transport(), {
		update: () => {},
		permission: async (r) => ((asked = r), { outcome: "selected", optionId: "yes" }),
	});
	const read = await agent.ask("fs/read_text_file", { sessionId: "s1", path: "/etc/passwd" });
	expect(read.error.code).toBe(-32601);
	const terminal = await agent.ask("terminal/create", { sessionId: "s1", command: "rm" });
	expect(terminal.error.code).toBe(-32601);
	const permission = await agent.ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "t1", name: "mcp__toolbelt__read_screen" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] });
	expect(permission.result).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
	expect(asked!.toolCall.name).toBe("mcp__toolbelt__read_screen");
});

test("agent errors reject the request, and a vanished agent fails what's pending", async () => {
	// A silent agent: it answers only what the test writes for it.
	let reply: (line: string) => void = () => {};
	let gone: (reason: string) => void = () => {};
	const closed: string[] = [];
	const client = new AcpClient(
		{ write: () => {}, listen: (onLine, onClose) => ((reply = onLine), (gone = onClose)), close: () => {} },
		{ update: () => {}, permission: async () => ({ outcome: "cancelled" }), closed: (r) => closed.push(r) },
	);
	const prompt = client.prompt("s1", []);
	reply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Authentication required" } }));
	await expect(prompt).rejects.toBeInstanceOf(AgentError);
	const hanging = client.newSession("/tmp", []);
	gone("gone");
	await expect(hanging).rejects.toThrow("gone");
	expect(closed).toEqual(["gone"]);
	expect(client.closed).toBe(true);
	await expect(client.prompt("s1", [])).rejects.toThrow("gone");
});

test("ignores lines that aren't JSON-RPC (agents that log to stdout)", async () => {
	const agent = new FakeAgent();
	const client = new AcpClient(agent.transport(), { update: () => {}, permission: async () => ({ outcome: "cancelled" }) });
	(agent as any).onLine("Starting up…");
	expect((await client.initialize({ name: "t", version: "1" })).protocolVersion).toBe(1);
});
