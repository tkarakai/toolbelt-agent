// The agents the settings list: the built-in ones, then the person's custom ACP agents, each with
// what's needed to start it. An agent being edited is started from its draft: a custom agent's
// whole setup, a built-in agent's environment variables, or the Model API agent's settings.
import { join } from "node:path";
import { AGENTS, resolveAgent, type AgentKind, type Resolved } from "./agents";
import { ENV } from "./model-api/config";
import { customId, findCustom, isCustom, MODEL_API_KEY, secretPrefix, type ConnectionId, type ModelApiSettings, type Settings, type Var } from "./settings";

/** An agent being edited. A built-in agent's draft uses `vars` (or `modelApi`) only. */
export type Draft = { id: string; name: string; command: string; vars: Var[]; modelApi?: ModelApiSettings };

/** `vars`: an agent's environment variables, when it takes them; `modelApi`: the Model API agent's settings. */
export type Connection = { id: ConnectionId; name: string; icon: string; kind?: AgentKind; custom?: Draft; vars?: Var[]; modelApi?: ModelApiSettings };

export const customName = (c: Pick<Draft, "name">) => c.name.trim() || "Custom agent";

export function connections(s: Settings, drafts: Map<ConnectionId, Draft> = new Map()): Connection[] {
	const custom: Draft[] = [...s.custom];
	// A new custom agent exists only as a draft until it's saved.
	for (const [id, d] of drafts) if (isCustom(id) && !findCustom(s, id)) custom.push(d);
	return [
		...AGENTS.map((kind) => ({
			id: kind.id,
			name: kind.name,
			icon: kind.icon,
			kind,
			...(kind.env ? { vars: drafts.get(kind.id)?.vars ?? s.vars[kind.id] ?? [] } : {}),
			...(kind.bundled ? { modelApi: drafts.get(kind.id)?.modelApi ?? s.modelApi } : {}),
		})),
		...custom.map((c) => {
			const draft = drafts.get(customId(c.id)) ?? c;
			return { id: customId(c.id), name: customName(draft), icon: "terminal", custom: draft, vars: draft.vars };
		}),
	];
}

export const connection = (s: Settings, id: ConnectionId, drafts?: Map<ConnectionId, Draft>) => connections(s, drafts).find((c) => c.id === id);

/** Reads a secret from the Keychain (ToolBelt's, through the SDK). */
export type SecretReader = (name: string) => Promise<string | null>;

/**
 * An agent's environment: its selected variables, secret ones read from the Keychain. Throws when
 * a secret variable has no saved value.
 */
export async function environment(id: ConnectionId, vars: Var[], secret: SecretReader): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const v of vars) {
		if (!v.selected || !v.key) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) throw new Error(`"${v.key}" isn't a valid environment variable name`);
		if (!v.secret) env[v.key] = v.value;
		else {
			const value = v.value || (await secret(`${secretPrefix(id)}/${v.key}`));
			if (!value) throw new Error(`${v.key} has no saved value: enter it again in the agent's setup.`);
			env[v.key] = value;
		}
	}
	return env;
}

/** The Model API agent's TOOLBELT_MODEL_API_* variables, its key read from the Keychain. */
export async function modelApiEnvironment(m: ModelApiSettings, secret: SecretReader, state: string): Promise<Record<string, string>> {
	const key = await secret(MODEL_API_KEY);
	const env: Record<string, string> = {
		[ENV.preset]: m.preset,
		[ENV.api]: m.api || "auto",
		[ENV.model]: m.model,
		[ENV.thinking]: m.thinking || "off",
		[ENV.state]: state,
	};
	const optional: [string, string][] = [
		[ENV.url, m.url],
		[ENV.maxOutput, m.maxOutput],
		[ENV.context, m.context],
		[ENV.maxSteps, m.maxSteps],
		[ENV.instructions, m.instructions],
		[ENV.extra, m.extra],
	];
	for (const [name, value] of optional) if (value.trim()) env[name] = value.trim();
	if (key) env[ENV.key] = key;
	return env;
}

/** The command that starts an agent (from its draft if it's being edited), or why it can't start. */
export async function resolveConnection(c: Connection, path: string, secret: SecretReader, data: string): Promise<Resolved> {
	const name = c.custom ? customName(c.custom) : c.name;
	let env: Record<string, string>;
	try {
		env = c.modelApi ? await modelApiEnvironment(c.modelApi, secret, join(data, "model-api")) : await environment(c.id, c.vars ?? [], secret);
	} catch (e) {
		return { ok: false, id: c.custom ? "custom" : c.kind!.id, name, reason: (e as Error).message };
	}
	if (c.custom) return resolveAgent({ agent: "custom", customName: name, customCommand: c.custom.command, env }, path);
	return resolveAgent({ agent: c.kind!.id, env }, path);
}
