// A small Agent Client Protocol (ACP v1) client: JSON-RPC 2.0, one message per line, over the
// agent's stdin and stdout. It offers the agent no file-system or terminal methods (those requests
// are refused), forwards `session/update` notifications and asks its owner about
// `session/request_permission`. https://agentclientprotocol.com
//
// Only what the chat needs is here: initialize, session/new, session/load, session/set_mode,
// session/prompt and session/cancel.

export const PROTOCOL_VERSION = 1;

/** A tool call as the agent describes it (`ToolCall` / `ToolCallUpdate`). */
export type ToolCall = {
	toolCallId: string;
	title?: string | null;
	name?: string | null;
	kind?: string | null;
	status?: "pending" | "in_progress" | "completed" | "failed" | null;
	content?: unknown[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
};

/** What `session/update` carries; the variants the chat shows. Others pass through untyped. */
export type SessionUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
	| ({ sessionUpdate: "tool_call" } & ToolCall)
	| ({ sessionUpdate: "tool_call_update" } & ToolCall)
	| { sessionUpdate: string; [key: string]: unknown };

export type ContentBlock = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export type PermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };
export type PermissionRequest = { sessionId: string; toolCall: ToolCall; options: PermissionOption[] };
export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

/** The permission modes an agent offers (`SessionModeState`), when it has any. */
export type Modes = { currentModeId: string; availableModes: { id: string; name?: string }[] };

export type McpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** Lines in and out: the agent's process, or a fake one in tests. */
export type Transport = {
	write(line: string): void;
	/** Calls back with each line the agent writes, and once when it's gone. */
	listen(onLine: (line: string) => void, onClose: (reason: string) => void): void;
	close(): void;
};

export type ClientHandlers = {
	update(sessionId: string, update: SessionUpdate): void;
	permission(request: PermissionRequest): Promise<PermissionOutcome>;
	/** The agent went away (exited, or its output closed). */
	closed?(reason: string): void;
};

/** An error the agent answered with. */
export class AgentError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class AcpClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private gone: string | null = null;

	constructor(private readonly transport: Transport, private readonly handlers: ClientHandlers) {
		transport.listen(
			(line) => this.receive(line),
			(reason) => {
				this.gone = reason;
				for (const p of this.pending.values()) p.reject(new Error(reason));
				this.pending.clear();
				handlers.closed?.(reason);
			},
		);
	}

	get closed() {
		return this.gone !== null;
	}

	/** Says hello. The client offers nothing beyond the basics: no files, no terminals. */
	initialize(client: { name: string; title?: string; version: string }) {
		return this.request<{ protocolVersion: number; agentCapabilities?: Record<string, unknown>; authMethods?: { id: string; name: string; description?: string }[]; agentInfo?: { name: string; title?: string; version?: string } }>("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: client,
		});
	}

	newSession(cwd: string, mcpServers: McpServer[], meta?: Record<string, unknown>) {
		return this.request<{ sessionId: string; modes?: Modes | null }>("session/new", { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
	}

	/** Reopens an earlier session (only when the agent offers `loadSession`). The agent replays its
	 *  history as `session/update`s before answering. */
	loadSession(sessionId: string, cwd: string, mcpServers: McpServer[], meta?: Record<string, unknown>) {
		return this.request<{ modes?: Modes | null } | null>("session/load", { sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
	}

	setMode(sessionId: string, modeId: string) {
		return this.request<unknown>("session/set_mode", { sessionId, modeId });
	}

	prompt(sessionId: string, prompt: ContentBlock[]) {
		return this.request<{ stopReason: StopReason }>("session/prompt", { sessionId, prompt });
	}

	cancel(sessionId: string) {
		this.notify("session/cancel", { sessionId });
	}

	close() {
		this.transport.close();
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		if (this.gone) return Promise.reject(new Error(this.gone));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown) {
		if (!this.gone) this.send({ jsonrpc: "2.0", method, params });
	}

	private send(message: unknown) {
		this.transport.write(JSON.stringify(message) + "\n");
	}

	private receive(line: string) {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // not JSON-RPC: agents sometimes log to stdout
		}
		if (!message || typeof message !== "object") return;
		// A reply to one of ours.
		if (message.id !== undefined && message.method === undefined) {
			const p = this.pending.get(message.id);
			if (!p) return;
			this.pending.delete(message.id);
			if (message.error) p.reject(new AgentError(message.error.code ?? -32603, message.error.message ?? "Agent error", message.error.data));
			else p.resolve(message.result);
			return;
		}
		if (typeof message.method !== "string") return;
		// A request from the agent: only permission questions are answered.
		if (message.id !== undefined) {
			if (message.method === "session/request_permission") {
				this.handlers
					.permission(message.params as PermissionRequest)
					.then((outcome) => this.send({ jsonrpc: "2.0", id: message.id, result: { outcome } }))
					.catch(() => this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }));
			} else {
				this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `ToolBelt Agent doesn't offer ${message.method}` } });
			}
			return;
		}
		if (message.method === "session/update" && message.params?.update) this.handlers.update(message.params.sessionId, message.params.update);
	}
}

/** Runs an agent command and speaks to it over its stdin and stdout. Its stderr goes to `log`. */
export function spawnTransport(command: string[], options: { cwd: string; env: Record<string, string>; log?: (line: string) => void }): Transport {
	const proc = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const drain = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
				const line = buffer.slice(0, at).trim();
				buffer = buffer.slice(at + 1);
				if (line) onLine(line);
			}
		}
	};
	if (options.log) void drain(proc.stderr, options.log).catch(() => {});
	return {
		write(line) {
			try {
				proc.stdin.write(line);
				proc.stdin.flush();
			} catch {}
		},
		listen(onLine, onClose) {
			void drain(proc.stdout, onLine)
				.catch(() => {})
				.then(() => proc.exited)
				.then((code) => onClose(`The agent stopped (exit code ${code})`));
		},
		close() {
			try {
				proc.stdin.end();
			} catch {}
			proc.kill();
		},
	};
}
