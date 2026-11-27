// An in-memory ACP agent for tests: answers initialize and session/new, and runs a scripted turn
// for each prompt. The script can send updates, ask permission and make requests of the client.
import type { Transport } from "../src/acp";

export type Turn = (agent: FakeAgent, sessionId: string, prompt: unknown[]) => Promise<string | void>;

export class FakeAgent {
	sent: any[] = [];
	newSession: any = null;
	loadSession: any = null;
	/** Offer `loadSession`, replaying these updates when a session is reopened. */
	loadable: unknown[] | null = null;
	private onLine: (line: string) => void = () => {};
	private onClose: (reason: string) => void = () => {};
	private next = 1000;
	private waiting = new Map<number, (m: any) => void>();
	closed = false;

	constructor(private readonly turn: Turn = async () => "end_turn") {}

	transport(): Transport {
		return {
			write: (line) => void this.receive(JSON.parse(line)),
			listen: (onLine, onClose) => ((this.onLine = onLine), (this.onClose = onClose)),
			close: () => {
				this.closed = true;
			},
		};
	}

	emit(message: unknown) {
		this.onLine(JSON.stringify(message));
	}

	update(sessionId: string, update: unknown) {
		this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	}

	/** A request to the client; resolves with its reply. */
	ask(method: string, params: unknown): Promise<any> {
		const id = this.next++;
		return new Promise((resolve) => {
			this.waiting.set(id, resolve);
			this.emit({ jsonrpc: "2.0", id, method, params });
		});
	}

	exit(reason = "The agent stopped (exit code 1)") {
		this.onClose(reason);
	}

	private async receive(m: any) {
		this.sent.push(m);
		if (m.method === undefined && this.waiting.has(m.id)) {
			this.waiting.get(m.id)!(m);
			this.waiting.delete(m.id);
			return;
		}
		const reply = (result: unknown) => this.emit({ jsonrpc: "2.0", id: m.id, result });
		if (m.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: this.loadable !== null }, agentInfo: { name: "fake", title: "Fake Agent", version: "9.9" } });
		else if (m.method === "session/load") {
			this.loadSession = m.params;
			for (const u of this.loadable ?? []) this.update(m.params.sessionId, u);
			reply(null);
		}
		else if (m.method === "session/new") {
			this.newSession = m.params;
			reply({ sessionId: "s1" });
		} else if (m.method === "session/prompt") {
			const stopReason = (await this.turn(this, m.params.sessionId, m.params.prompt)) ?? "end_turn";
			reply({ stopReason });
		}
	}
}
