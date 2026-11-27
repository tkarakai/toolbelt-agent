// The Model API agent's process: ToolBelt's own lightweight agent for any model server (local, such
// as oMLX or Ollama, or hosted, such as OpenRouter or OpenAI). The plugin starts it like any ACP
// agent, with its settings in TOOLBELT_MODEL_API_* variables; it speaks ACP on stdin and stdout and
// logs to stderr. It only ever connects to the configured server and ToolBelt's MCP server.
import { readConfig } from "./config";
import { serverFetch } from "./models";
import { ModelApiServer } from "./server";

declare const MODEL_API_VERSION: string | undefined;
const version = typeof MODEL_API_VERSION === "string" ? MODEL_API_VERSION : "dev";
const log = (line: string) => process.stderr.write(`${line}\n`);

// Every request this process makes goes through here: only the configured server is reachable.
try {
	globalThis.fetch = serverFetch(readConfig(process.env), fetch);
} catch {
	// A settings problem: session/new reports it. Until then nothing may be fetched.
	globalThis.fetch = (async () => {
		throw new Error("The Model API agent's settings are incomplete.");
	}) as unknown as typeof fetch;
}

const server = new ModelApiServer({ version, env: process.env, send: (line) => void process.stdout.write(line), log });

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
		const line = buffer.slice(0, at).trim();
		buffer = buffer.slice(at + 1);
		if (line) void server.receive(line).catch((e) => log(`error: ${(e as Error).message}`));
	}
}
await server.close();
process.exit(0);
