// One conversation with an agent: starts it on the first question, gives it ToolBelt's MCP server
// and nothing else, streams its answer into the chat, and refuses its permission requests for
// anything but ToolBelt's tools. Closing it (a new chat, other settings) stops the agent.
import { existsSync, mkdirSync } from "node:fs";
import { AcpClient, AgentError, spawnTransport, type McpServer, type PermissionOutcome, type PermissionRequest, type Transport } from "./acp";
import type { Resolved } from "./agents";
import { Chat, toolName } from "./chat";

export type Status = "idle" | "starting" | "working";
export type Problem = { text: string; install?: string; settings?: boolean };

export const CLIENT = { name: "toolbelt-agent", title: "ToolBelt Agent", version: "0.0.0" };

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
			const prompt = this.told ? [{ type: "text", text: text.trim() }] : [{ type: "text", text: PREAMBLE }, { type: "text", text: text.trim() }];
			this.told = true;
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

	/** Starts the agent and its session without asking anything: what "Test connection" does. */
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
		this.o.changed();
	}

	close() {
		this.client?.close();
		this.client = null;
		this.sessionId = null;
		this.told = false;
	}

	private async connect() {
		if (this.client && !this.client.closed && this.sessionId) return { client: this.client, sessionId: this.sessionId };
		const { client, sessionId } = await this.connectWithInfo();
		return { client, sessionId };
	}

	private async connectWithInfo() {
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
				if (sessionId === this.sessionId && this.chat.apply(update)) this.o.changed();
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
		const { sessionId } = await client.newSession(this.o.workdir, [toolbelt], agent.id === "claude" ? CLAUDE_ISOLATION : undefined);
		this.sessionId = sessionId;
		return { client, sessionId, info: hello.agentInfo };
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
