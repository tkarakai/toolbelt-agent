// Turns the settings into a pi-ai provider with one model, over the chosen API, with the server's
// way of switching thinking. Requests go only to the configured address.
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import { lazyApi } from "@earendil-works/pi-ai/api/lazy";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses";
import { baseUrlFor, hostOf, type Config } from "./config";

export const PROVIDER = "model-api";

const PI_API = { chat: "openai-completions", responses: "openai-responses", messages: "anthropic-messages" } as const;

export function piModel(c: Config): Model<any> {
	const baseUrl = baseUrlFor(c.api, c.url);
	const base = {
		id: c.model,
		name: c.model,
		api: PI_API[c.api],
		provider: PROVIDER,
		baseUrl,
		// Thinking can be switched (on or off) unless the server is left to decide.
		reasoning: c.api !== "chat" || c.preset.thinking !== "none" || c.thinking !== "off",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: c.context,
		maxTokens: Math.min(c.maxOutput, Math.floor(c.context / 2)),
	};
	if (c.api !== "chat") return base as Model<any>;
	const openai = hostOf(c.url) === "api.openai.com";
	return {
		...base,
		compat: {
			supportsDeveloperRole: openai,
			supportsStore: openai,
			maxTokensField: openai ? "max_completion_tokens" : "max_tokens",
			...thinkingCompat(c),
		},
	} as Model<any>;
}

function thinkingCompat(c: Config) {
	switch (c.preset.thinking) {
		case "chat-template":
			return { supportsReasoningEffort: false, thinkingFormat: "chat-template" as const, chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" as const } } };
		case "openai":
			return { supportsReasoningEffort: true, thinkingFormat: "openai" as const };
		case "openrouter":
			return { supportsReasoningEffort: true, thinkingFormat: "openrouter" as const };
		case "none":
			return { supportsReasoningEffort: false };
	}
}

export function piProvider(c: Config): Provider<any> {
	const model = piModel(c);
	// Imported up front, not lazily: a bundled lazy import leaves pi-ai's telemetry uninitialized.
	const api = lazyApi(async () => (c.api === "chat" ? openAICompletions : c.api === "responses" ? openAIResponses : anthropicMessages) as never);
	return createProvider({
		id: PROVIDER,
		name: c.preset.name,
		baseUrl: model.baseUrl,
		auth: { apiKey: { name: c.preset.name, resolve: async () => ({ auth: { apiKey: c.key || "none" } }) } },
		models: [model],
		api: api as never,
	}) as Provider<any>;
}

/**
 * A fetch that adds the extra request fields to JSON bodies sent to the server, and refuses any
 * other address: this process only ever talks to the configured server.
 */
export function serverFetch(c: Config, inner: typeof fetch = fetch): typeof fetch {
	const origin = new URL(c.url).origin;
	const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== origin) throw new Error(`The Model API agent only talks to ${origin}, not ${url.origin}.`);
		if (Object.keys(c.extra).length && typeof init?.body === "string") {
			try {
				const body = JSON.parse(init.body);
				if (body && typeof body === "object" && !Array.isArray(body)) init = { ...init, body: JSON.stringify({ ...c.extra, ...body }) };
			} catch {}
		}
		return inner(input, init);
	};
	return wrapped as typeof fetch;
}
