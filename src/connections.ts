// The agents the settings list: the built-in ones, then the person's custom ACP agents, each with
// what's needed to start it. A custom agent being edited is started from its draft.
import { AGENTS, resolveAgent, type AgentKind, type Resolved } from "./agents";
import { customId, findCustom, type ConnectionId, type CustomAgent, type Settings } from "./settings";

export type Connection = { id: ConnectionId; name: string; icon: string; kind?: AgentKind; custom?: CustomAgent };

export const customName = (c: Pick<CustomAgent, "name">) => c.name.trim() || "Custom agent";

export function connections(s: Settings, drafts: Map<ConnectionId, CustomAgent> = new Map()): Connection[] {
	const custom = [...s.custom];
	// A new custom agent exists only as a draft until it's saved.
	for (const [id, d] of drafts) if (!findCustom(s, id)) custom.push(d);
	return [
		...AGENTS.map((kind) => ({ id: kind.id, name: kind.name, icon: kind.icon, kind })),
		...custom.map((c) => {
			const draft = drafts.get(customId(c.id)) ?? c;
			return { id: customId(c.id), name: customName(draft), icon: "terminal", custom: draft };
		}),
	];
}

export const connection = (s: Settings, id: ConnectionId, drafts?: Map<ConnectionId, CustomAgent>) => connections(s, drafts).find((c) => c.id === id);

/** The command that starts an agent (from its draft if it's being edited), or why it can't start. */
export function resolveConnection(c: Connection, path: string): Resolved {
	if (c.custom) return resolveAgent({ agent: "custom", customName: customName(c.custom), customCommand: c.custom.command, customEnv: c.custom.env }, path);
	return resolveAgent({ agent: c.kind!.id }, path);
}
