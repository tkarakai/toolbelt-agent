// The Model API agent's chats: each is a pi-durable conversation whose only tools are ToolBelt's MCP
// tools, kept in its own folder so it can be reopened. Answers, thinking and tool calls are reported
// as they happen, in ACP's `session/update` shapes.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, MemoryStorage, section, type Conversation } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { substitution, type Config } from "./config";
import { McpClient, type McpTool, type McpTransport } from "./mcp";
import { piProvider, PROVIDER } from "./models";

const context = BACKGROUND_CONTEXT;

export type Update = Record<string, unknown> & { sessionUpdate: string };
export type StopReason = "end_turn" | "max_turn_requests" | "cancelled";
/**
 * How a probe went: `server` (unreachable, refused, unknown model…), `tools` (no tool call), `model`
 * (not configured), `substituted` (a server on this Mac answered with another model).
 */
export type Probe = { ok: true; text: string; ms: number } | { ok: false; reason: "server" | "tools" | "model" | "substituted"; text: string; ms?: number };

/** Starts ToolBelt's MCP server for a chat. */
export type McpStarter = () => McpTransport;

type Entry = { id: number; kind: string; model?: { role: string; content: unknown }[] };
type Content = { type: string; text?: string; thinking?: string };

type Chat = {
	id: string;
	harness: Harness;
	root: Conversation;
	mcp: McpClient;
	/** Reports updates of the prompt being answered; null between prompts. */
	report: ((u: Update) => void) | null;
	/** Text and thinking of the answer being streamed, already reported. */
	sentText: string;
	sentThought: string;
	seen: Set<number>;
	stopWatch: () => Promise<unknown>;
	calls: number;
	/** Why the answer being written was stopped: another model answered. Nothing more of it is shown. */
	substituted: string | null;
};

export class ModelApiAgent {
	private chats = new Map<string, Chat>();

	constructor(private readonly config: Config, private readonly o: { version: string; log?: (line: string) => void }) {}

	async newSession(mcp: McpStarter): Promise<string> {
		const id = crypto.randomUUID();
		await this.open(id, mcp, true);
		return id;
	}

	/** Reopens a chat and returns its history as updates, oldest first. */
	async loadSession(id: string, mcp: McpStarter): Promise<Update[]> {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Unknown chat.");
		if (!this.chats.has(id)) {
			if (!this.config.state || !existsSync(join(this.config.state, id))) throw new Error("This chat isn't kept any more.");
			await this.open(id, mcp, false);
		}
		const chat = this.chats.get(id)!;
		const page = await chat.root.entries({ order: "ascending" } as never, 1000, undefined, context);
		const history: Update[] = [];
		for (const e of page.items as unknown as Entry[]) {
			chat.seen.add(e.id);
			for (const m of e.model ?? []) {
				const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content ?? []) as Content[]);
				const text = textOf(content);
				if (!text) continue;
				if (e.kind === "pi.user") history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
				if (e.kind === "pi.assistant") history.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
			}
		}
		return history;
	}

	async prompt(id: string, text: string, report: (u: Update) => void): Promise<StopReason> {
		const chat = this.chats.get(id);
		if (!chat) throw new Error("Unknown chat.");
		if (chat.report) throw new Error("Still answering the last message.");
		chat.report = report;
		chat.sentText = chat.sentThought = "";
		chat.substituted = null;
		try {
			const submission = await chat.root.submit({ type: "input", content: text }, context);
			const settled = await submission.wait(context);
			// What the watch hasn't delivered yet: the end of the answer.
			const page = await chat.root.entries({ order: "descending" } as never, 50, undefined, context);
			for (const e of (page.items as unknown as Entry[]).reverse()) this.entry(chat, e);
			if (chat.substituted) throw new Error(chat.substituted);
			if (settled.status === "done") return "end_turn";
			const reason = (settled as { reason?: { reason?: string; detail?: string } | string }).reason;
			const why = typeof reason === "string" ? reason : reason?.reason;
			if (why === "aborted") return "cancelled";
			if (why === "turn_limit") return "max_turn_requests";
			const live = await chat.harness.snapshot(LiveDoc, chat.root.id, context).catch(() => undefined);
			const detail = live?.runFailure?.detail ?? (typeof reason === "object" ? reason?.detail : undefined);
			throw new Error(this.explain(detail ?? why));
		} finally {
			chat.report = null;
		}
	}

	/**
	 * One small request with a single `ping` tool: whether the server answers and the model calls
	 * tools at all (small models often answer without calling any). For the settings' Test.
	 */
	async probe(): Promise<Probe> {
		const c = this.config;
		const models = createModels();
		models.setProvider(piProvider(c));
		const model = models.getModel(PROVIDER, c.model);
		if (!model) return { ok: false, reason: "model", text: `No model "${c.model}".` };
		const started = Date.now();
		const answer = await models.completeSimple(
			model,
			{
				systemPrompt: "You are checking that tool calls work. Call the ping tool now, without writing anything else.",
				messages: [{ role: "user", content: "Call the ping tool.", timestamp: started }],
				tools: [{ name: "ping", description: "Answers pong. Call it when you're asked to.", parameters: { type: "object", properties: {}, additionalProperties: false } }],
			},
			{ ...(c.thinking === "off" ? {} : { reasoning: c.thinking }), maxTokens: Math.min(c.maxOutput, 1024) } as never,
		);
		const ms = Date.now() - started;
		const content = (answer.content ?? []) as { type: string }[];
		const other = substitution(c, (answer as { responseModel?: string }).responseModel);
		if (other) return { ok: false, reason: "substituted", text: other, ms };
		if (answer.stopReason === "error" || answer.stopReason === "aborted") return { ok: false, reason: "server", text: this.explain((answer as { errorMessage?: string }).errorMessage), ms };
		if (content.some((x) => x.type === "toolCall")) return { ok: true, text: `${c.model} answered in ${(ms / 1000).toFixed(1)} s and called a tool.`, ms };
		return { ok: false, reason: "tools", text: `${c.model} answered without calling a tool, so it would answer without reading ToolBelt.`, ms };
	}

	async cancel(id: string) {
		const chat = this.chats.get(id);
		if (chat?.report) await chat.root.abort(context).catch(() => {});
	}

	async close() {
		for (const chat of this.chats.values()) {
			await chat.stopWatch().catch(() => {});
			await chat.harness.close(context).catch(() => {});
			chat.mcp.close();
		}
		this.chats.clear();
	}

	private async open(id: string, start: McpStarter, fresh: boolean) {
		const c = this.config;
		const mcp = new McpClient(start());
		try {
			await mcp.initialize({ name: "toolbelt-model-api", version: this.o.version });
		} catch (e) {
			mcp.close();
			throw new Error(`Couldn't reach ToolBelt: ${(e as Error).message}`);
		}
		const tools = await mcp.tools();
		const chat = { id, mcp, report: null, sentText: "", sentThought: "", seen: new Set<number>(), calls: 0, substituted: null } as unknown as Chat;
		// The same for every chat, so the server's prompt cache serves it to each new chat too. The
		// time isn't here: every message says when it was sent (the plugin's `sentAt`).
		const sections = [
			section("toolbelt", () => mcp.instructions || "ToolBelt's tools read what the person's ToolBelt plugins show."),
			...(c.instructions ? [section("instructions", () => c.instructions)] : []),
		];
		const registry = createRegistry();
		registry.install(defineExtension({ name: "toolbelt", tools: tools.map((t) => this.tool(chat, t)), sections }));
		const models = createModels();
		models.setProvider(piProvider(c));
		let storage;
		if (c.state) {
			const dir = join(c.state, id);
			mkdirSync(dir, { recursive: true });
			storage = await openNodeJsonlStorage(dir, context);
		} else storage = new MemoryStorage();
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: null },
				onReport: (r) => this.o.log?.(`${r.kind}: ${(r as { error?: Error }).error?.message ?? ""}`),
				settings: {
					retry: { maxRetries: 2 },
					compaction: { enabled: true, reserveTokens: Math.min(16_384, Math.floor(c.context / 4)), keepRecentTokens: Math.floor(c.context / 4) },
				},
			},
			context,
		);
		const agent = { model: { provider: PROVIDER, modelId: c.model }, thinkingLevel: c.thinking, maxTurns: c.maxSteps };
		const root = await harness.root(context, { agent });
		// A reopened chat runs with today's settings: the model or thinking may have changed.
		if (!fresh) await root.configure(agent as never, context);
		harness.resume();
		chat.harness = harness;
		chat.root = root;
		const watch = await root.watch(context);
		for (const e of (watch.value as unknown as { entries?: Entry[] }).entries ?? []) chat.seen.add(e.id);
		watch.start(async (call) => {
			if (call.kind === "value") this.live(chat, call.value as never);
		});
		chat.stopWatch = () => watch.stop();
		this.chats.set(id, chat);
	}

	/** One of ToolBelt's tools, reporting its call and result. */
	private tool(chat: Chat, t: McpTool) {
		return defineTool({
			name: t.name,
			description: t.description ?? t.name,
			parameters: t.inputSchema as never,
			execute: async (args: unknown) => {
				// Another model asked for this: don't run it (the answer is being stopped).
				if (chat.substituted) throw new Error(chat.substituted);
				const input = (args ?? {}) as Record<string, unknown>;
				const toolCallId = `call-${++chat.calls}`;
				const name = `toolbelt.${t.name}`;
				chat.report?.({ sessionUpdate: "tool_call", toolCallId, title: name, name, kind: t.name.startsWith("read") ? "read" : "other", status: "in_progress", rawInput: input });
				const r = await chat.mcp.call(t.name, input);
				chat.report?.({
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: r.isError ? "failed" : "completed",
					content: [{ type: "content", content: { type: "text", text: r.text } }],
					rawOutput: r.text,
				});
				if (r.isError) throw new Error(r.text);
				return { output: [{ type: "text" as const, text: r.text }] };
			},
		});
	}

	/** Stops the answer when a server on this Mac answers with another model than the chosen one. */
	private check(chat: Chat, answered: string | undefined) {
		if (chat.substituted) return;
		const other = substitution(this.config, answered);
		if (!other) return;
		chat.substituted = other;
		this.o.log?.(other);
		void chat.root.abort(context).catch(() => {});
	}

	/** A change to the conversation: stream the partial answer, settle finished ones. */
	private live(chat: Chat, value: { entries?: Entry[]; docs?: Record<string, any> }) {
		if (!chat.report) return;
		for (const e of value.entries ?? []) this.entry(chat, e);
		const message = value.docs?.["pi.live"]?.generation?.message as { content?: Content[]; responseModel?: string } | undefined;
		this.check(chat, message?.responseModel);
		const partial = message?.content;
		if (!partial || chat.substituted) return;
		this.stream(chat, textOf(partial), thoughtOf(partial));
	}

	private entry(chat: Chat, e: Entry) {
		if (chat.seen.has(e.id)) return;
		chat.seen.add(e.id);
		if (e.kind !== "pi.assistant" || !chat.report) return;
		for (const m of e.model ?? []) this.check(chat, (m as { responseModel?: string }).responseModel);
		if (chat.substituted) return;
		const content = (e.model ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as Content[]) : []));
		this.stream(chat, textOf(content), thoughtOf(content));
		chat.sentText = chat.sentThought = "";
	}

	/** Reports what's new in the answer so far; a restarted attempt that differs isn't repeated. */
	private stream(chat: Chat, text: string, thought: string) {
		if (thought.startsWith(chat.sentThought) && thought.length > chat.sentThought.length) {
			chat.report?.({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thought.slice(chat.sentThought.length) } });
			chat.sentThought = thought;
		}
		if (text.startsWith(chat.sentText) && text.length > chat.sentText.length) {
			chat.report?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(chat.sentText.length) } });
			chat.sentText = text;
		}
	}

	/** A model error, in words the person can act on. */
	private explain(detail: string | undefined): string {
		const d = detail ?? "no answer";
		const where = this.config.url;
		if (/ECONNREFUSED|Unable to connect|fetch failed|ConnectionRefused/i.test(d)) return `Couldn't reach ${where}: is the server running?`;
		if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*key/i.test(d)) return `${this.config.preset.name} refused the API key.`;
		if (/\b404\b|not found|no such model|model.*not.*exist/i.test(d)) return `${this.config.preset.name} doesn't know the model "${this.config.model}": ${d}`;
		if (/context|too long|maximum.*tokens/i.test(d)) return `The conversation is too long for the model's context: ${d}`;
		return `The model didn't answer: ${d}`;
	}
}

function textOf(content: Content[]) {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function thoughtOf(content: Content[]) {
	return content
		.filter((c) => c.type === "thinking")
		.map((c) => c.thinking ?? "")
		.join("");
}

