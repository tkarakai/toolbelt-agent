// Fakes for the Model API agent's tests: a model server that speaks each API (it asks for one tool
// call, then answers from the tool's result) and ToolBelt's MCP server in memory.
import type { McpTransport } from "../src/model-api/mcp";

export type Seen = { path: string; body: any; headers: Record<string, string> };

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const named = (events: [string, unknown][]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** Whether the request already carries the tool's result. */
function hasToolResult(body: any): boolean {
	const text = JSON.stringify(body.messages ?? body.input ?? []);
	return /"role":"tool"|function_call_output|"tool_result"/.test(text);
}

export function fakeModelServer(o: { answer?: string; fail?: number; delayMs?: number; noTools?: boolean; respondAs?: string } = {}) {
	const seen: Seen[] = [];
	const answer = o.answer ?? "You have 2 tasks due today.";
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? await req.json() : null;
			seen.push({ path: url.pathname, body, headers: Object.fromEntries(req.headers) });
			if (o.delayMs && req.method === "POST") await Bun.sleep(o.delayMs);
			if (o.fail) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: o.fail, headers: { "content-type": "application/json" } });
			if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "small", context_length: 65536 }, { id: "big" }] });
			const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
			const done = o.noTools || hasToolResult(body);
			if (url.pathname.endsWith("/chat/completions")) {
				const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: o.respondAs ?? body.model };
				return stream(
					sse(
						done
							? [
									{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer.slice(0, 9) } }] },
									{ ...base, choices: [{ index: 0, delta: { content: answer.slice(9) } }] },
									{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 } },
								]
							: [
									{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read_screen", arguments: "" } }] } }] },
									{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"plugin":"ontrack"}' } }] } }] },
									{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } },
								],
					) + "data: [DONE]\n\n",
				);
			}
			if (url.pathname.endsWith("/responses")) {
				const resp = { id: "r1", object: "response", model: body.model, status: "in_progress", output: [] as unknown[] };
				const usage = { input_tokens: 40, output_tokens: 5, total_tokens: 45, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
				if (!done) {
					const item = { type: "function_call", id: "fc1", call_id: "t1", name: "read_screen", arguments: '{"plugin":"ontrack"}', status: "completed" };
					return stream(
						named([
							["response.created", { type: "response.created", sequence_number: 0, response: resp }],
							["response.output_item.added", { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }],
							["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", sequence_number: 2, item_id: "fc1", output_index: 0, delta: item.arguments }],
							["response.function_call_arguments.done", { type: "response.function_call_arguments.done", sequence_number: 3, item_id: "fc1", output_index: 0, arguments: item.arguments }],
							["response.output_item.done", { type: "response.output_item.done", sequence_number: 4, output_index: 0, item }],
							["response.completed", { type: "response.completed", sequence_number: 5, response: { ...resp, status: "completed", output: [item], usage } }],
						]),
					);
				}
				const msg = { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
				return stream(
					named([
						["response.created", { type: "response.created", sequence_number: 0, response: resp }],
						["response.output_item.added", { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...msg, content: [], status: "in_progress" } }],
						["response.content_part.added", { type: "response.content_part.added", sequence_number: 2, item_id: "m1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
						["response.output_text.delta", { type: "response.output_text.delta", sequence_number: 3, item_id: "m1", output_index: 0, content_index: 0, delta: answer }],
						["response.output_text.done", { type: "response.output_text.done", sequence_number: 4, item_id: "m1", output_index: 0, content_index: 0, text: answer }],
						["response.content_part.done", { type: "response.content_part.done", sequence_number: 5, item_id: "m1", output_index: 0, content_index: 0, part: msg.content[0] }],
						["response.output_item.done", { type: "response.output_item.done", sequence_number: 6, output_index: 0, item: msg }],
						["response.completed", { type: "response.completed", sequence_number: 7, response: { ...resp, status: "completed", output: [msg], usage } }],
					]),
				);
			}
			if (url.pathname.endsWith("/messages")) {
				const start = { type: "message_start", message: { id: "msg1", type: "message", role: "assistant", model: o.respondAs ?? body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } };
				return stream(
					named(
						done
							? [
									["message_start", start],
									["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
									["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }],
									["content_block_stop", { type: "content_block_stop", index: 0 }],
									["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }],
									["message_stop", { type: "message_stop" }],
								]
							: [
									["message_start", start],
									["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_screen", input: {} } }],
									["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"plugin":"ontrack"}' } }],
									["content_block_stop", { type: "content_block_stop", index: 0 }],
									["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
									["message_stop", { type: "message_stop" }],
								],
					),
				);
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

/** ToolBelt's MCP server, in memory: one tool, `read_screen`. */
export function fakeMcp(calls: { name: string; args: unknown }[] = []): () => McpTransport {
	return () => {
		let onLine: (line: string) => void = () => {};
		const reply = (id: unknown, result: unknown) => queueMicrotask(() => onLine(JSON.stringify({ jsonrpc: "2.0", id, result })));
		return {
			write(line) {
				const m = JSON.parse(line);
				if (m.method === "initialize") reply(m.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "toolbelt" }, instructions: "ToolBelt shows the person's plugins. Read a screen before answering." });
				else if (m.method === "tools/list") reply(m.id, { tools: [{ name: "read_screen", description: "Reads a plugin's screen.", inputSchema: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"] } }] });
				else if (m.method === "tools/call") {
					calls.push({ name: m.params.name, args: m.params.arguments });
					reply(m.id, { content: [{ type: "text", text: "OnTrack · Today: Budget review (due 3 PM), Sign contract (due 5 PM)" }] });
				}
			},
			listen(l) {
				onLine = l;
			},
			close() {},
		};
	};
}
