// Runs the built archive the way Toolbelt does: extracted into a temporary folder with no source
// checkout or node_modules and a fresh data directory, its floating surface opened for the person
// (first run: the agents list), a custom agent added and switched to through its events (a tiny
// stdio ACP agent that opens sessions and says hello), a question whose chat is saved, then a
// clean prepare and shutdown.
import { $ } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackageManifest } from "@toolbelt/sdk/package";
import { validateTree } from "@toolbelt/sdk/validation";

const version = JSON.parse(await Bun.file("toolbelt.json").text()).version;
const archive = `artifacts/toolbelt-agent-${version}-portable.tar.gz`;
const root = mkdtempSync(join(tmpdir(), "agent-package-"));
try {
	const pkg = join(root, "package");
	const data = join(root, "data");
	mkdirSync(pkg);
	mkdirSync(data);
	await $`tar -xzf ${archive} -C ${pkg}`;
	// Toolbelt's agent socket only needs to exist: the fake agent never starts the MCP server.
	writeFileSync(join(root, "agent.sock"), "");
	const fake = join(root, "fake-acp.ts");
	writeFileSync(
		fake,
		`for await (const line of console) {
	const m = JSON.parse(line);
	if (m.method === "session/prompt") console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } }));
	const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "1" } } : m.method === "session/new" ? { sessionId: "s1" } : m.method === "session/prompt" ? { stopReason: "end_turn" } : null;
	if (m.id !== undefined) console.log(JSON.stringify(result ? { jsonrpc: "2.0", id: m.id, result } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }));
}`,
	);
	const m = parsePackageManifest(await Bun.file(join(pkg, "toolbelt.json")).json());
	if (!m.floating || m.screens.length || m.agent.access !== "none") throw Error("Expected a floating plugin without screens, hidden from agents");
	const env = { PATH: "/usr/bin:/bin", HOME: root, SHELL: "/bin/sh", TOOLBELT_PLUGIN: m.id, TOOLBELT_PLUGIN_VERSION: m.version, TOOLBELT_DATA_DIR: data, TOOLBELT_PACKAGE_ROOT: pkg, TOOLBELT_AGENT_COMMAND: JSON.stringify([process.execPath, "/nonexistent/cli.js", "--socket", join(root, "agent.sock")]) };
	const proc = Bun.spawn([process.execPath, join(pkg, "index.js")], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 15000 });
	const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + "\n");
	send({ type: "hello", protocol: 2, capabilities: m.capabilities.required, plugin: { id: m.id }, host: { name: "verify", version: "0.7.1" } });
	let buffer = "";
	let step = "ready";
	for await (const bytes of proc.stdout) {
		buffer += new TextDecoder().decode(bytes);
		for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			if (msg.type === "ready" && step === "ready") {
				step = "settings";
				send({ type: "open", surface: "floating", instance: "person" });
			}
			if (msg.type === "render") {
				validateTree(msg.tree);
				if (msg.surface !== "floating" || msg.tree.type !== "floating") throw Error("Expected a floating tree");
				const event = (name: string, payload: unknown = {}) => send({ type: "event", surface: "floating", instance: "person", name, payload });
				if (step === "settings") {
					if (msg.tree.subtitle !== "Agents") throw Error("First run should list the agents");
					step = "add";
					event("open-agent", { list: "agents", item: "add" });
				} else if (step === "add" && msg.tree.subtitle === "Custom agent") {
					step = "use";
					event("field", { form: "agent", field: "name", value: "Fake" });
					event("field", { form: "agent", field: "command", value: `${process.execPath} ${fake}` });
					event("use", { rowId: "connection" });
				} else if (step === "use" && msg.tree.mode === "bar") {
					step = "ask";
					event("ask", { composer: "ask", text: "Say hello" });
				} else if (step === "ask" && msg.tree.mode === "panel" && !msg.tree.busy && JSON.stringify(msg.tree).includes("Hello")) {
					step = "prepare";
					send({ type: "prepare", requestId: "verify", reason: "upgrade" });
				}
			}
			if (msg.type === "prepared") {
				if (!msg.ready) throw Error("Expected readiness");
				step = "done";
				send({ type: "shutdown" });
				proc.stdin.end();
			}
		}
	}
	if ((await proc.exited) !== 0 || step !== "done") throw Error(`Package contract failed at ${step}`);
	const saved = JSON.parse(readFileSync(join(data, "settings.json"), "utf8"));
	if (saved.active !== "custom:1" || saved.custom[0]?.name !== "Fake" || !saved.tested["custom:1"]?.ok) throw Error("The agent switched to was not saved");
	const savedChats = JSON.parse(readFileSync(join(data, "threads", "index.json"), "utf8"));
	if (savedChats.length !== 1 || savedChats[0].title !== "Say hello" || savedChats[0].count !== 2) throw Error("The chat was not saved");
	// The bundled Model API agent starts on its own (no node_modules), answers ACP, and reports a
	// settings problem for the session instead of failing to start.
	const agent = Bun.spawn([process.execPath, join(pkg, "model-api.js")], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TOOLBELT_MODEL_API_PRESET: "omlx" }, stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 15000 });
	agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
	agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root, mcpServers: [{ name: "toolbelt", command: "/nonexistent", args: [], env: [] }] } }) + "\n");
	agent.stdin.end();
	const replies = (await new Response(agent.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
	if (replies[0]?.result?.agentInfo?.name !== "toolbelt-model-api" || replies[0].result.agentInfo.version !== version) throw Error("The Model API agent didn't introduce itself");
	if (!/No model/.test(replies[1]?.error?.message ?? "")) throw Error("The Model API agent didn't report its missing model");
	if ((await agent.exited) !== 0) throw Error("The Model API agent didn't exit cleanly");
	console.log("Clean package: the first-run agents list, adding and switching to an agent, the ask bar, a saved chat, the Model API agent, prepare and shutdown pass.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
