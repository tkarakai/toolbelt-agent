// ToolBelt's MCP server as a process, for the Model API agent's process test: one tool, `read_screen`.
export {};
const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
		const line = buffer.slice(0, at).trim();
		buffer = buffer.slice(at + 1);
		if (!line) continue;
		const m = JSON.parse(line);
		if (m.method === "initialize") write({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "toolbelt" }, instructions: "Read a screen before answering." } });
		else if (m.method === "tools/list") write({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "read_screen", description: "Reads a plugin's screen.", inputSchema: { type: "object", properties: { plugin: { type: "string" } } } }] } });
		else if (m.method === "tools/call") write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${process.env.FAKE_SCREEN ?? "OnTrack"}: 2 tasks today (key: ${process.env.TOOLBELT_MODEL_API_KEY ?? "none"})` }] } });
	}
}
