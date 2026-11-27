// A small MCP client over stdio (newline-delimited JSON-RPC), for the one server the Model API
// agent uses: ToolBelt's, started from the command the plugin passes in `session/new`. Only what the
// agent needs: initialize (for the server's instructions), tools/list and tools/call.
// https://modelcontextprotocol.io/specification

export const MCP_VERSION = "2025-06-18";

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type McpResult = { text: string; isError: boolean };

/** Lines in and out: the server's process, or a fake one in tests. */
export type McpTransport = {
	write(line: string): void;
	listen(onLine: (line: string) => void, onClose: (reason: string) => void): void;
	close(): void;
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class McpClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private gone: string | null = null;
	instructions = "";

	constructor(private readonly transport: McpTransport) {
		transport.listen(
			(line) => this.receive(line),
			(reason) => {
				this.gone = reason;
				for (const p of this.pending.values()) p.reject(new Error(reason));
				this.pending.clear();
			},
		);
	}

	async initialize(client: { name: string; version: string }) {
		const r = await this.request<{ instructions?: string }>("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: client });
		this.instructions = r?.instructions ?? "";
		this.notify("notifications/initialized", {});
	}

	async tools(): Promise<McpTool[]> {
		const all: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.request<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
			all.push(...(page.tools ?? []));
			cursor = page.nextCursor;
		} while (cursor);
		return all;
	}

	async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
		try {
			const r = await this.request<{ content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }>("tools/call", { name, arguments: args });
			const text = (r.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			return { text: text || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : ""), isError: r.isError === true };
		} catch (e) {
			return { text: (e as Error).message, isError: true };
		}
	}

	close() {
		this.transport.close();
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		if (this.gone) return Promise.reject(new Error(this.gone));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	private notify(method: string, params: unknown) {
		if (!this.gone) this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}

	private receive(line: string) {
		let m: any;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (!m || typeof m !== "object") return;
		if (m.id !== undefined && m.method === undefined) {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.error) p.reject(new Error(m.error.message ?? "MCP error"));
			else p.resolve(m.result);
			return;
		}
		// Requests from the server (sampling, roots, elicitation) aren't offered.
		if (m.id !== undefined && typeof m.method === "string") {
			this.transport.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Not offered: ${m.method}` } }) + "\n");
		}
	}
}

/** Starts an MCP server process and speaks to it over stdin and stdout. */
export function spawnMcp(command: string, args: string[], env: Record<string, string>, log?: (line: string) => void): McpTransport {
	const proc = Bun.spawn([command, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
	if (log) void drain(proc.stderr, log).catch(() => {});
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
				.then((code) => onClose(`ToolBelt's MCP server stopped (exit code ${code})`));
		},
		close() {
			try {
				proc.stdin.end();
			} catch {}
			proc.kill();
		},
	};
}
