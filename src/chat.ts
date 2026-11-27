// The conversation as the floating window shows it: the person's questions, the agent's answers
// as they stream in, and its tool calls as compact rows. Pure: it only turns ACP session updates
// into `Message`s.
import type { Message } from "@toolbelt/sdk";
import type { SessionUpdate, ToolCall } from "./acp";

/** Messages sent in full; older ones are summarized, so long chats stay small to render. */
export const VISIBLE_MESSAGES = 80;
const DETAIL_LIMIT = 4000;

export class Chat {
	readonly messages: Message[];
	/** A chat to continue, with its saved messages. */
	constructor(messages: Message[] = []) {
		this.messages = messages.map((m) => ({ ...m, ...(m.tool ? { tool: { ...m.tool } } : {}) }));
	}
	/** Tool call id → its message and what's known about the call so far. */
	private tools = new Map<string, { message: Message; call: ToolCall }>();
	/** The answer being streamed, if any. */
	private answer: Message | null = null;

	user(text: string) {
		this.answer = null;
		this.messages.push({ role: "user", author: "You", text, at: Date.now() });
	}

	system(text: string) {
		this.answer = null;
		this.messages.push({ role: "system", text });
	}

	/** Applies one `session/update`. Returns whether anything visible changed. */
	apply(update: SessionUpdate): boolean {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = textOf((update as { content?: unknown }).content);
				if (!text) return false;
				if (!this.answer) {
					this.answer = { role: "assistant", text: "", at: Date.now() };
					this.messages.push(this.answer);
				}
				this.answer.text += text;
				return true;
			}
			case "tool_call": {
				const call = update as unknown as ToolCall;
				this.answer = null;
				const message: Message = { role: "tool", text: summary(call), tool: { name: toolName(call), ...detail(call) } };
				this.tools.set(call.toolCallId, { message, call: { ...call } });
				this.messages.push(message);
				return true;
			}
			case "tool_call_update": {
				const call = update as unknown as ToolCall;
				const known = this.tools.get(call.toolCallId);
				if (!known) return false;
				known.call = { ...known.call, ...strip(call) };
				known.message.text = summary(known.call);
				known.message.tool = { name: toolName(known.call), ...detail(known.call) };
				return true;
			}
			default:
				return false; // thoughts, plans, usage: not shown
		}
	}

	/** The answer is complete: the next chunk starts a new message. */
	settle() {
		this.answer = null;
	}

	/** What to render: the most recent messages, with a note for the rest. */
	visible(): Message[] {
		const copy = (m: Message): Message => ({ ...m, ...(m.tool ? { tool: { ...m.tool } } : {}) });
		if (this.messages.length <= VISIBLE_MESSAGES) return this.messages.map(copy);
		const hidden = this.messages.length - VISIBLE_MESSAGES;
		return [{ role: "system", text: `${hidden} earlier message${hidden === 1 ? "" : "s"} not shown` }, ...this.messages.slice(-VISIBLE_MESSAGES).map(copy)];
	}

	/** The last thing the agent said, for the ask bar's one-line summary. */
	lastAnswer(): string | null {
		for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].role === "assistant" && this.messages[i].text.trim()) return this.messages[i].text;
		return null;
	}

	/**
	 * The conversation so far as plain text, for an agent that can't reopen its own session: the
	 * person's questions and the answers, newest kept when it's longer than `limit` characters.
	 */
	transcript(limit = 8000): string {
		const lines: string[] = [];
		let size = 0;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role !== "user" && m.role !== "assistant") continue;
			const line = `${m.role === "user" ? "Person" : "You"}: ${m.text.trim()}`;
			if (size + line.length > limit) {
				if (!lines.length) lines.unshift(`${line.slice(0, limit)}…`);
				break;
			}
			lines.unshift(line);
			size += line.length + 2;
		}
		return lines.join("\n\n");
	}

	get empty() {
		return this.messages.length === 0;
	}
}

function strip(call: ToolCall): Partial<ToolCall> {
	return Object.fromEntries(Object.entries(call).filter(([k, v]) => v !== undefined && v !== null && k !== "sessionUpdate")) as Partial<ToolCall>;
}

function textOf(content: unknown): string {
	const c = content as { type?: string; text?: string } | undefined;
	return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** `mcp__toolbelt__read_screen` → `read_screen`: the agent's tool, without its server prefix. */
export function toolName(call: Partial<ToolCall>): string {
	const raw = call.name || call.title || call.kind || "tool";
	return raw.replace(/^mcp__toolbelt__/, "").replace(/^toolbelt[.:/]/, "");
}

function summary(call: Partial<ToolCall>): string {
	const parts: string[] = [];
	const title = call.title && call.title !== call.name ? call.title.replace(/^mcp__toolbelt__/, "") : "";
	if (title && title !== toolName(call)) parts.push(title);
	if (call.status === "failed") parts.push("failed");
	else if (call.status === "completed") parts.push("done");
	else parts.push("running…");
	return parts.join(" · ");
}

function detail(call: Partial<ToolCall>): { detail?: string } {
	const sections: string[] = [];
	if (call.rawInput !== undefined && call.rawInput !== null) sections.push(stringify(call.rawInput));
	const output = call.rawOutput ?? contentText(call.content);
	if (output) sections.push(`→ ${typeof output === "string" ? output : stringify(output)}`);
	const text = sections.join("\n");
	return text ? { detail: text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text } : {};
}

function contentText(content: unknown[] | null | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			const inner = (c as { content?: unknown }).content ?? c;
			return textOf(inner);
		})
		.filter(Boolean)
		.join("\n");
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
