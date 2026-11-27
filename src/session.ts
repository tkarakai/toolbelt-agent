// One conversation with an agent: starts it on the first question, gives it ToolBelt's MCP server
// and nothing else, streams its answer into the chat, and refuses its permission requests for
// anything but ToolBelt's tools. Closing it (a new chat, other settings) stops the agent.
import { existsSync, mkdirSync } from "node:fs";
import { AcpClient, AgentError, spawnTransport, type McpServer, type PermissionOutcome, type PermissionRequest, type Transport } from "./acp";
import type { Resolved } from "./agents";
import type { Message } from "@toolbelt/sdk";
import { Chat, toolName } from "./chat";

export type Status = "idle" | "starting" | "working";
export type Problem = { text: string; install?: string; settings?: boolean };

export const CLIENT = { name: "toolbelt-agent", title: "ToolBelt Agent", version: "0.2.0" };

/** What the agent is told before the person's first question. */
export const PREAMBLE = `You are the assistant inside ToolBelt, a macOS app whose plugins show screens (tasks, software updates, processes and more). The person is looking at ToolBelt while they talk to you.

Answer from ToolBelt's screens with the \`toolbelt\` MCP tools: \`toolbelt_status\` lists the plugins, \`list_screens\` their screens and view controls, \`read_screen\` reads one with your own search, filters and sort, \`search_screens\` searches across them, and \`show_screen\` puts a screen on the person's display (they approve it the first time). Show them what you found when it helps.

You have no other tools here: no files, no shell, no web. Keep answers short and concrete.`;

export type SessionOptions = {
	/** The agent to start, resolved when the conversation starts. */
	resolve: () => Promise<Resolved>;
	/** The empty folder the agent runs in. */
	workdir: string;
	/** `[bun, cli, --socket, path]` from ToolBelt, or undefined. */
	agentCommand?: string[];
	/** The PATH agents run with. */
	path: () => Promise<string>;
	/** Something visible changed. */
	changed: () => void;
	log?: (line: string) => void;
	/** Starts the agent's process; tests pass a fake. */
	transport?: (command: string[], options: { cwd: string; env: Record<string, string> }) => Transport;
	env?: Record<string, string | undefined>;
	/** Which of the person's agents this is (its settings id), kept with saved chats. */
	agentKey?: () => string | null;
};

export class AgentSession {
	chat = new Chat();
	status: Status = "idle";
	problem: Problem | null = null;
	/** The agent's name once it started ("Claude Code"). */
	agentName: string | null = null;
	private client: AcpClient | null = null;
	private sessionId: string | null = null;
	private told = false;
	/** The session the conversation's agent has open, and whose agent it is: what a saved chat keeps. */
	session: { id: string; agent: string | null } | null = null;
	/** A saved chat being continued: reopen its session if the same agent offers that, otherwise
	 *  start a new one that's told the conversation so far. */
	private resume: { sessionId: string | null; agent: string | null } | null = null;
	/** The agent is replaying a reopened session: its updates are already in the chat. */
	private loading = false;
	/** Sent before the next question when the agent couldn't reopen its session. */
	private recap: string | null = null;

	constructor(private readonly o: SessionOptions) {}

	get busy() {
		return this.status !== "idle";
	}

	/** Asks a question; the answer streams into the chat. */
	async ask(text: string) {
		if (this.busy || !text.trim()) return;
		this.problem = null;
		this.chat.user(text.trim());
		this.status = "starting";
		this.o.changed();
		try {
			const { client, sessionId } = await this.connect();
			this.status = "working";
			this.o.changed();
			const intro = this.told ? [] : [{ type: "text", text: PREAMBLE }];
			if (this.recap) intro.push({ type: "text", text: this.recap });
			const prompt = [...intro, { type: "text", text: text.trim() }];
			this.told = true;
			this.recap = null;
			const { stopReason } = await client.prompt(sessionId, prompt);
			this.chat.settle();
			if (stopReason === "refusal") this.chat.system("The agent declined to answer.");
			else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") this.chat.system("The agent stopped before finishing: it reached its limit.");
		} catch (e) {
			this.chat.settle();
			this.problem ??= describe(e);
		} finally {
			this.status = "idle";
			this.o.changed();
		}
	}

	/** Starts the agent and its session without asking anything: what Test does, and Use before it switches. */
	async check(): Promise<string> {
		this.close();
		this.problem = null;
		try {
			const { info } = await this.connectWithInfo();
			return `${info?.title ?? info?.name ?? this.agentName} ${info?.version ?? ""} started and connected to ToolBelt.`.replace(/\s+/g, " ").trim();
		} finally {
			this.close();
		}
	}

	/** Stops the answer being written. */
	stop() {
		if (this.client && this.sessionId && this.status === "working") this.client.cancel(this.sessionId);
	}

	/** Starts over: a new chat, and a new agent session on the next question. */
	reset() {
		this.close();
		this.chat = new Chat();
		this.problem = null;
		this.resume = null;
		this.session = null;
		this.o.changed();
	}

	/** Shows a saved chat; the next question continues it (see `resume`). */
	restore(messages: Message[], saved: { sessionId: string | null; agent: string | null }) {
		this.close();
		this.chat = new Chat(messages);
		this.problem = null;
		this.resume = saved;
		this.session = saved.sessionId ? { id: saved.sessionId, agent: saved.agent } : null;
		this.o.changed();
	}

	close() {
		this.client?.close();
		this.client = null;
		this.sessionId = null;
		this.told = false;
		this.recap = null;
		this.loading = false;
	}

	private async connect() {
		if (this.client && !this.client.closed && this.sessionId) return { client: this.client, sessionId: this.sessionId };
		const resume = this.resume;
		const { client, sessionId, resumed } = await this.connectWithInfo(resume ?? undefined);
		if (resume) {
			this.resume = null;
			if (resumed) this.told = true;
			else if (this.chat.messages.some((m) => m.role === "user")) {
				// Everything but the question just asked, which follows the recap.
				const earlier = new Chat(this.chat.messages.slice(0, -1)).transcript();
				if (earlier) {
					this.recap = `This continues an earlier conversation with the person. You can't see it, so here it is (oldest first):\n\n${earlier}`;
					this.chat.messages.splice(this.chat.messages.length - 1, 0, { role: "system", text: `Continued in a new session: ${this.agentName ?? "the agent"} sees a summary of the earlier conversation.` });
					this.o.changed();
				}
			}
		}
		return { client, sessionId };
	}

	private async connectWithInfo(resume?: { sessionId: string | null; agent: string | null }) {
		this.close();
		const agent = await this.o.resolve();
		this.agentName = agent.name;
		if (!agent.ok) {
			this.problem = { text: agent.reason, install: agent.install, settings: true };
			throw new Error(agent.reason);
		}
		const toolbelt = this.toolbeltServer(agent.name);
		mkdirSync(this.o.workdir, { recursive: true });
		const env = { ...pick(this.o.env ?? process.env, ["HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL"]), TERM: "dumb", PATH: await this.o.path(), ...agent.env };
		const start = this.o.transport ?? ((command, options) => spawnTransport(command, { ...options, log: this.o.log }));
		const client = new AcpClient(start(agent.command, { cwd: this.o.workdir, env }), {
			update: (sessionId, update) => {
				if (this.loading || sessionId !== this.sessionId) return;
				if (this.chat.apply(update)) this.o.changed();
			},
			permission: (request) => this.permission(request),
			closed: (reason) => {
				if (this.client !== client) return;
				this.client = null;
				this.sessionId = null;
				if (this.busy) this.problem ??= { text: reason };
				this.o.changed();
			},
		});
		this.client = client;
		const hello = await client.initialize(CLIENT);
		if (hello.protocolVersion !== 1) throw new Error(`${agent.name} speaks ACP ${hello.protocolVersion}; ToolBelt Agent speaks ACP 1.`);
		const meta = agent.id === "claude" ? CLAUDE_ISOLATION : undefined;
		const key = this.o.agentKey?.() ?? null;
		// The same agent can reopen its own session when it offers that; others get a recap.
		if (resume?.sessionId && resume.agent === key && hello.agentCapabilities?.loadSession === true) {
			this.sessionId = resume.sessionId;
			this.loading = true;
			try {
				await client.loadSession(resume.sessionId, this.o.workdir, [toolbelt], meta);
				this.session = { id: resume.sessionId, agent: key };
				return { client, sessionId: resume.sessionId, info: hello.agentInfo, resumed: true };
			} catch (e) {
				this.o.log?.(`couldn't reopen session ${resume.sessionId}: ${(e as Error).message}`);
				this.sessionId = null;
			} finally {
				this.loading = false;
			}
			if (client.closed) throw new Error(`${agent.name} stopped while reopening the chat.`);
		}
		const { sessionId } = await client.newSession(this.o.workdir, [toolbelt], meta);
		this.sessionId = sessionId;
		this.session = { id: sessionId, agent: key };
		return { client, sessionId, info: hello.agentInfo, resumed: false };
	}

	/** ToolBelt's MCP server, as the agent should start it. */
	private toolbeltServer(agentName: string): McpServer {
		const command = this.o.agentCommand;
		if (!command?.length) {
			this.problem = { text: "This ToolBelt didn't say how agents reach it. Update ToolBelt to 0.7.0 or later." };
			throw new Error(this.problem.text);
		}
		const socket = command[command.indexOf("--socket") + 1];
		if (command.includes("--socket") && socket && !existsSync(socket)) {
			this.problem = { text: "Agents can't reach ToolBelt yet: turn on Settings → Agents → “Let agents use ToolBelt”." };
			throw new Error(this.problem.text);
		}
		return { name: "toolbelt", command: command[0], args: [...command.slice(1), "mcp", "--client", `Agent · ${agentName}`], env: [] };
	}

	/** Only ToolBelt's own tools may run; ToolBelt then applies its own access levels and grants. */
	private async permission(request: PermissionRequest): Promise<PermissionOutcome> {
		const allow = request.options.find((o) => o.kind === "allow_once") ?? request.options.find((o) => o.kind === "allow_always");
		const reject = request.options.find((o) => o.kind === "reject_once") ?? request.options.find((o) => o.kind === "reject_always");
		if (isToolbeltTool(request) && allow) return { outcome: "selected", optionId: allow.optionId };
		this.chat.system(`Refused ${toolName(request.toolCall)}: here the agent may only use ToolBelt.`);
		this.o.changed();
		return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
	}
}

/** Claude Code: no built-in tools, none of the person's Claude settings or MCP servers. */
export const CLAUDE_ISOLATION = {
	claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false } },
};

/** A call to one of ToolBelt's MCP tools, by the names agents give them. */
export function isToolbeltTool(request: PermissionRequest): boolean {
	const names = [request.toolCall.name, request.toolCall.title].filter((n): n is string => typeof n === "string");
	return names.some((n) => /^mcp__toolbelt__[a-z_]+$/.test(n) || /^toolbelt[.:/][a-z_]+$/.test(n));
}

function pick(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
	return Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]!]));
}

function describe(e: unknown): Problem {
	if (e instanceof AgentError) {
		if (e.code === -32000 || /auth/i.test(e.message)) return { text: `The agent needs you to log in: ${e.message}` };
		return { text: `The agent answered with an error: ${e.message}` };
	}
	const message = e instanceof Error ? e.message : String(e);
	if (/ENOENT|not found/i.test(message)) return { text: `The agent couldn't start: ${message}`, settings: true };
	return { text: message };
}
