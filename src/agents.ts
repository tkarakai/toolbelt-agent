// Which agents the chat can start and how to find them. Each is an ACP agent the person installed
// (the plugin never downloads code): Claude Code's and Codex's ACP adapters, Gemini CLI's ACP mode,
// or any command that speaks ACP. ToolBelt starts plugins with a minimal PATH (an app launched
// from the Dock doesn't see the shell's), so commands are looked up in the person's login-shell
// PATH and the usual install folders.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type AgentId = "claude" | "codex" | "gemini" | "custom";

export type AgentKind = {
	id: Exclude<AgentId, "custom">;
	name: string;
	/** The executable and its arguments for ACP mode. */
	command: string;
	args: string[];
	/** How to install it, as a command to paste in a terminal. */
	install: string;
	/** What else it needs (a login). */
	note: string;
	/** A lucide icon for its row in the settings. */
	icon: string;
};

export const AGENTS: AgentKind[] = [
	{
		id: "claude",
		name: "Claude Code",
		command: "claude-agent-acp",
		args: [],
		install: "npm install -g @agentclientprotocol/claude-agent-acp",
		note: "Uses your Claude Code login: run `claude` once and log in.",
		icon: "asterisk",
	},
	{
		id: "codex",
		name: "Codex",
		command: "codex-acp",
		args: [],
		install: "npm install -g @agentclientprotocol/codex-acp",
		note: "Uses your Codex login: run `codex login` once.",
		icon: "code-xml",
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		command: "gemini",
		args: ["--acp"],
		install: "npm install -g @google/gemini-cli",
		note: "Uses your Gemini CLI login: run `gemini` once and sign in.",
		icon: "gem",
	},
];

export const agentName = (id: AgentId, customName?: string) => (id === "custom" ? customName?.trim() || "Custom agent" : (AGENTS.find((a) => a.id === id)?.name ?? id));

/** Folders agents are commonly installed in, besides the login shell's PATH. */
export function knownDirs(home = homedir()): string[] {
	return [
		join(home, ".local/bin"),
		join(home, ".bun/bin"),
		join(home, ".npm-global/bin"),
		join(home, ".volta/bin"),
		join(home, "Library/pnpm"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	];
}

let shellPath: Promise<string> | null = null;

/**
 * The person's login-shell PATH, read once (with a 5 s limit) by asking their shell to print it.
 * Falls back to ToolBelt's PATH.
 */
export function loginPath(env: Record<string, string | undefined> = process.env): Promise<string> {
	shellPath ??= (async () => {
		const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : "/bin/zsh";
		try {
			const proc = Bun.spawn([shell, "-ilc", 'printf "__TB_PATH__%s__TB_END__" "$PATH"'], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { HOME: env.HOME ?? homedir(), USER: env.USER ?? "", SHELL: shell, TERM: "dumb" }, timeout: 5000 });
			const out = await new Response(proc.stdout).text();
			const found = out.match(/__TB_PATH__(.*?)__TB_END__/s)?.[1];
			if (found) return found;
		} catch {}
		return env.PATH ?? "";
	})();
	return shellPath;
}

/** The PATH agents run with: the login shell's, then the usual install folders. */
export async function searchPath(env: Record<string, string | undefined> = process.env): Promise<string> {
	const dirs = [...(await loginPath(env)).split(delimiter), ...knownDirs(env.HOME)].filter(Boolean);
	return [...new Set(dirs)].join(delimiter);
}

/** The full path of an executable on `path`, or null. */
export function which(command: string, path: string): string | null {
	const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

/** Splits a command line into words: spaces separate, quotes group, backslash escapes. */
export function splitCommand(line: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: '"' | "'" | null = null;
	let started = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
			else word += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			started = true;
		} else if (c === "\\" && i + 1 < line.length) {
			word += line[++i];
			started = true;
		} else if (/\s/.test(c)) {
			if (started || word) words.push(word);
			word = "";
			started = false;
		} else {
			word += c;
			started = true;
		}
	}
	if (quote) throw new Error("The command has an unclosed quote");
	if (started || word) words.push(word);
	return words;
}

/** `KEY=value` lines (blank lines and `#` comments skipped). */
export function parseEnv(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const at = line.indexOf("=");
		if (at <= 0) throw new Error(`Environment lines look like NAME=value (got "${line}")`);
		const name = line.slice(0, at).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" isn't a valid environment variable name`);
		env[name] = line.slice(at + 1).trim();
	}
	return env;
}

export type Resolved =
	| { ok: true; id: AgentId; name: string; command: string[]; env: Record<string, string> }
	| { ok: false; id: AgentId; name: string; reason: string; install?: string };

/** The command to start the chosen agent with, or why it can't start. */
export function resolveAgent(settings: { agent: AgentId; customName?: string; customCommand?: string; customEnv?: string }, path: string): Resolved {
	const name = agentName(settings.agent, settings.customName);
	if (settings.agent === "custom") {
		let words: string[];
		let env: Record<string, string>;
		try {
			words = splitCommand(settings.customCommand ?? "");
			env = parseEnv(settings.customEnv ?? "");
		} catch (e) {
			return { ok: false, id: "custom", name, reason: (e as Error).message };
		}
		if (!words.length) return { ok: false, id: "custom", name, reason: "Enter the command that starts your agent in ACP mode." };
		const found = which(words[0], path);
		if (!found) return { ok: false, id: "custom", name, reason: `ToolBelt can't find \`${words[0]}\` on your PATH.` };
		return { ok: true, id: "custom", name, command: [found, ...words.slice(1)], env };
	}
	const kind = AGENTS.find((a) => a.id === settings.agent)!;
	const found = which(kind.command, path);
	if (!found) return { ok: false, id: kind.id, name, reason: `${kind.name}'s ACP mode isn't installed.`, install: kind.install };
	return { ok: true, id: kind.id, name, command: [found, ...kind.args], env: {} };
}
