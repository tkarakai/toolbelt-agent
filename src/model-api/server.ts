// The agent side of the Agent Client Protocol (ACP v1) for the Model API agent: JSON-RPC 2.0, one
// message per line. It answers initialize, session/new, session/load, session/prompt and
// session/cancel, and asks the client for nothing: its only tools are ToolBelt's.
// https://agentclientprotocol.com
import { ENV, readConfig, type Config } from "./config";
import { ModelApiAgent, type Update } from "./agent";
import { spawnMcp, type McpTransport } from "./mcp";

export const AGENT_INFO = { name: "toolbelt-model-api", title: "Model API" };

type McpServerSpec = { name?: string; command?: string; args?: string[]; env?: { name: string; value: string }[]; type?: string };

export type ServerOptions = {
	version: string;
	env: Record<string, string | undefined>;
	/** Writes one message line to the client. */
	send: (line: string) => void;
	/** Starts an MCP server from the client's description (tests pass a fake). */
	startMcp?: (spec: McpServerSpec) => McpTransport;
	log?: (line: string) => void;
};

export class ModelApiServer {
	private agent: ModelApiAgent | null = null;
	private config: Config | null = null;

	constructor(private readonly o: ServerOptions) {}

	/** Handles one line from the client. */
	async receive(line: string) {
		let m: any;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (!m || typeof m !== "object" || typeof m.method !== "string") return;
		if (m.id === undefined) {
			if (m.method === "session/cancel" && typeof m.params?.sessionId === "string") await this.agent?.cancel(m.params.sessionId);
			return;
		}
		try {
			this.reply(m.id, await this.handle(m.method, m.params ?? {}));
		} catch (e) {
			const err = e as Error & { code?: number };
			this.send({ jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32603, message: err.message } });
		}
	}

	async close() {
		await this.agent?.close();
	}

	private async handle(method: string, params: any): Promise<unknown> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: 1,
					agentCapabilities: { loadSession: Boolean(this.o.env[ENV.state]), promptCapabilities: {}, mcpCapabilities: { http: false, sse: false } },
					agentInfo: { ...AGENT_INFO, version: this.o.version },
					authMethods: [],
				};
			case "session/new": {
				const start = this.mcpFrom(params.mcpServers);
				return { sessionId: await this.ensure().newSession(start) };
			}
			case "session/load": {
				const start = this.mcpFrom(params.mcpServers);
				const history = await this.ensure().loadSession(String(params.sessionId), start);
				for (const update of history) this.update(params.sessionId, update);
				return {};
			}
			// The settings' Test: one request with a `ping` tool (an ACP extension method).
			case "_toolbelt/probe":
				return this.ensure().probe();
			case "session/prompt": {
				const text = ((params.prompt ?? []) as { type: string; text?: string }[])
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n\n");
				if (!text.trim()) throw Object.assign(new Error("Nothing to answer: the message is empty."), { code: -32602 });
				const sessionId = String(params.sessionId);
				const stopReason = await this.ensure().prompt(sessionId, text, (u) => this.update(sessionId, u));
				return { stopReason };
			}
			default:
				throw Object.assign(new Error(`Not offered: ${method}`), { code: -32601 });
		}
	}

	/** The agent, made on first use so that a settings problem is reported for the session. */
	private ensure(): ModelApiAgent {
		if (!this.agent) {
			this.config = readConfig(this.o.env);
			this.agent = new ModelApiAgent(this.config, { version: this.o.version, log: this.o.log });
		}
		return this.agent;
	}

	/** ToolBelt's MCP server among those the client gives: the agent uses that one only. */
	private mcpFrom(servers: unknown): () => McpTransport {
		const list = (Array.isArray(servers) ? servers : []) as McpServerSpec[];
		const spec = list.find((s) => s.name === "toolbelt" && s.command) ?? list.find((s) => s.command);
		if (!spec?.command) throw Object.assign(new Error("No ToolBelt MCP server was given: the Model API agent needs ToolBelt's tools."), { code: -32602 });
		const start = this.o.startMcp ?? ((s: McpServerSpec) => spawnMcp(s.command!, s.args ?? [], { ...stringEnv(this.o.env), ...Object.fromEntries((s.env ?? []).map((e) => [e.name, e.value])) }, this.o.log));
		return () => start(spec);
	}

	private update(sessionId: string, update: Update) {
		this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	}

	private reply(id: unknown, result: unknown) {
		this.send({ jsonrpc: "2.0", id, result: result ?? null });
	}

	private send(message: unknown) {
		this.o.send(JSON.stringify(message) + "\n");
	}
}

/** The environment without the agent's own settings: the MCP server gets no API key. */
function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("TOOLBELT_MODEL_API_")));
}
