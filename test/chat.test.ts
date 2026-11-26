import { expect, test } from "bun:test";
import { Chat, VISIBLE_MESSAGES, toolName } from "../src/chat";

test("streams an answer into one message and settles it", () => {
	const chat = new Chat();
	chat.user("What's overdue?");
	expect(chat.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You have " } })).toBe(true);
	chat.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "3 tasks." } });
	expect(chat.messages.map((m) => [m.role, m.text])).toEqual([["user", "What's overdue?"], ["assistant", "You have 3 tasks."]]);
	chat.settle();
	chat.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "More." } });
	expect(chat.messages).toHaveLength(3);
	expect(chat.lastAnswer()).toBe("More.");
	expect(chat.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })).toBe(false);
});

test("tool calls are rows that update in place, named without the server prefix", () => {
	const chat = new Chat();
	chat.apply({ sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__toolbelt__read_screen", status: "pending", rawInput: { plugin: "ontrack" } });
	expect(chat.messages[0]).toMatchObject({ role: "tool", text: "running…", tool: { name: "read_screen" } });
	chat.apply({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "3 rows" } }] });
	expect(chat.messages[0].text).toBe("done");
	expect(chat.messages[0].tool?.detail).toContain('"plugin": "ontrack"');
	expect(chat.messages[0].tool?.detail).toContain("→ 3 rows");
	expect(chat.apply({ sessionUpdate: "tool_call_update", toolCallId: "nope", status: "failed" })).toBe(false);
	expect(toolName({ name: "toolbelt.show_screen" })).toBe("show_screen");
});

test("long conversations show the recent messages and say how many are hidden", () => {
	const chat = new Chat();
	for (let i = 0; i < VISIBLE_MESSAGES + 5; i++) chat.user(`q${i}`);
	const visible = chat.visible();
	expect(visible).toHaveLength(VISIBLE_MESSAGES + 1);
	expect(visible[0]).toEqual({ role: "system", text: "5 earlier messages not shown" });
	expect(visible.at(-1)!.text).toBe(`q${VISIBLE_MESSAGES + 4}`);
});
