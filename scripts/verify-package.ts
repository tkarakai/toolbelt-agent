// Runs the built archive the way Toolbelt does: extracted into a temporary folder with no source
// checkout or node_modules and a fresh data directory, its floating surface opened for the person
// (first run: the settings), an agent chosen through its events, then a clean prepare and
// shutdown. No agent is started.
import { $ } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	const m = parsePackageManifest(await Bun.file(join(pkg, "toolbelt.json")).json());
	if (!m.floating || m.screens.length || m.agent.access !== "none") throw Error("Expected a floating plugin without screens, hidden from agents");
	const env = { PATH: "/usr/bin:/bin", HOME: root, SHELL: "/bin/sh", TOOLBELT_PLUGIN: m.id, TOOLBELT_PLUGIN_VERSION: m.version, TOOLBELT_DATA_DIR: data, TOOLBELT_PACKAGE_ROOT: pkg, TOOLBELT_AGENT_COMMAND: JSON.stringify([process.execPath, "/nonexistent/cli.js", "--socket", join(root, "agent.sock")]) };
	const proc = Bun.spawn([process.execPath, join(pkg, "index.js")], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 15000 });
	const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + "\n");
	send({ type: "hello", protocol: 2, capabilities: m.capabilities.required, plugin: { id: m.id }, host: { name: "verify", version: "0.7.0" } });
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
				if (step === "settings") {
					if (msg.tree.subtitle !== "Settings") throw Error("First run should open the settings");
					step = "choose";
					send({ type: "event", surface: "floating", instance: "person", name: "field", payload: { form: "settings", field: "agent", value: "claude" } });
					send({ type: "event", surface: "floating", instance: "person", name: "done" });
				} else if (step === "choose" && msg.tree.mode === "bar") {
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
	if (saved.agent !== "claude") throw Error("The chosen agent was not saved");
	console.log("Clean package: first-run settings, choosing an agent, the ask bar, prepare and shutdown pass.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
