// The Model API agent's settings: which server, which of its APIs, which model, and how it's run.
// The plugin passes them to the agent process as TOOLBELT_MODEL_API_* environment variables; the
// presets fill in what each kind of server needs, so a person usually picks a preset and a model.

/** The request formats the agent speaks. */
export type Api = "chat" | "responses" | "messages";
export const API_NAMES: Record<Api, string> = { chat: "Chat Completions", responses: "Responses", messages: "Anthropic Messages" };

export type Thinking = "off" | "low" | "medium" | "high";

/** How a server is told to think or not, over Chat Completions. */
export type ThinkingStyle =
	/** `chat_template_kwargs.enable_thinking` (oMLX, llama.cpp, vLLM: Qwen, Gemma and similar templates). */
	| "chat-template"
	/** `reasoning_effort` (OpenAI, Gemini, Ollama). */
	| "openai"
	/** OpenRouter's `reasoning` object. */
	| "openrouter"
	/** Nothing is sent: the server's own setting decides. */
	| "none";

export type Preset = {
	id: string;
	name: string;
	/** The address, ending in the API's version path (`/v1`). */
	url: string;
	/** The API that works best with it. */
	api: Api;
	/** Runs on this Mac: nothing leaves it. */
	local: boolean;
	thinking: ThinkingStyle;
	/** Whether it needs an API key, and where to get one. */
	key: "required" | "optional" | "none";
	/** The context to assume when the server doesn't report one. */
	context: number;
};

export const PRESETS: Preset[] = [
	{ id: "omlx", name: "oMLX", url: "http://127.0.0.1:8000/v1", api: "chat", local: true, thinking: "chat-template", key: "optional", context: 32_768 },
	{ id: "llamacpp", name: "llama.cpp", url: "http://127.0.0.1:8080/v1", api: "chat", local: true, thinking: "chat-template", key: "optional", context: 32_768 },
	{ id: "ollama", name: "Ollama", url: "http://127.0.0.1:11434/v1", api: "chat", local: true, thinking: "openai", key: "none", context: 32_768 },
	{ id: "lmstudio", name: "LM Studio", url: "http://127.0.0.1:1234/v1", api: "chat", local: true, thinking: "none", key: "none", context: 32_768 },
	{ id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", api: "chat", local: false, thinking: "openrouter", key: "required", context: 128_000 },
	{ id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", api: "responses", local: false, thinking: "openai", key: "required", context: 128_000 },
	{ id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com/v1", api: "messages", local: false, thinking: "none", key: "required", context: 200_000 },
	{ id: "gemini", name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", api: "chat", local: false, thinking: "openai", key: "required", context: 128_000 },
	{ id: "other", name: "Other", url: "", api: "chat", local: false, thinking: "none", key: "optional", context: 32_768 },
];

export const preset = (id: string | undefined) => PRESETS.find((p) => p.id === id) ?? PRESETS.find((p) => p.id === "other")!;

export type Config = {
	preset: Preset;
	/** The server's address, ending in its version path, without a trailing slash. */
	url: string;
	api: Api;
	model: string;
	key: string;
	thinking: Thinking;
	/** Output tokens per answer. */
	maxOutput: number;
	/** The model's context window, in tokens. */
	context: number;
	/** Tool rounds per answer. */
	maxSteps: number;
	/** Appended after ToolBelt's own instructions. */
	instructions: string;
	/** Added to every request body; can't replace the model, messages or tools. */
	extra: Record<string, unknown>;
	/** Where chats are kept so they can be reopened; none keeps them in memory only. */
	state: string | null;
};

export const ENV = {
	preset: "TOOLBELT_MODEL_API_PRESET",
	url: "TOOLBELT_MODEL_API_URL",
	api: "TOOLBELT_MODEL_API_API",
	model: "TOOLBELT_MODEL_API_MODEL",
	key: "TOOLBELT_MODEL_API_KEY",
	thinking: "TOOLBELT_MODEL_API_THINKING",
	maxOutput: "TOOLBELT_MODEL_API_MAX_OUTPUT",
	context: "TOOLBELT_MODEL_API_CONTEXT",
	maxSteps: "TOOLBELT_MODEL_API_MAX_STEPS",
	instructions: "TOOLBELT_MODEL_API_INSTRUCTIONS",
	extra: "TOOLBELT_MODEL_API_EXTRA",
	state: "TOOLBELT_MODEL_API_STATE",
} as const;

/** Body fields the extra fields can't set: they'd replace what the agent sends. */
const RESERVED = new Set(["model", "messages", "input", "tools", "tool_choice", "stream", "system", "instructions"]);

const THINKING: Thinking[] = ["off", "low", "medium", "high"];

/** Reads the settings from the environment; throws with a message for the person when one is wrong. */
export function readConfig(env: Record<string, string | undefined>): Config {
	const p = preset(env[ENV.preset]);
	const url = (env[ENV.url]?.trim() || p.url).replace(/\/+$/, "");
	if (!url) throw new Error("No server address: choose a server or enter its address.");
	if (!/^https?:\/\//.test(url)) throw new Error(`The server address should start with http:// or https:// (got "${url}").`);
	const apiSetting = env[ENV.api]?.trim() || "auto";
	if (apiSetting !== "auto" && !(apiSetting in API_NAMES)) throw new Error(`Unknown API "${apiSetting}".`);
	const model = env[ENV.model]?.trim() ?? "";
	if (!model) throw new Error("No model: choose one of the server's models.");
	const thinking = (env[ENV.thinking]?.trim() || "off") as Thinking;
	if (!THINKING.includes(thinking)) throw new Error(`Thinking is one of ${THINKING.join(", ")} (got "${thinking}").`);
	return {
		preset: p,
		url,
		api: apiSetting === "auto" ? autoApi(p, url) : (apiSetting as Api),
		model,
		key: env[ENV.key] ?? "",
		thinking,
		maxOutput: count(env[ENV.maxOutput], 4096, "Max answer length"),
		context: count(env[ENV.context], p.context, "Context size"),
		maxSteps: count(env[ENV.maxSteps], 12, "Tool steps per answer"),
		instructions: env[ENV.instructions]?.trim() ?? "",
		extra: extraFields(env[ENV.extra]),
		state: env[ENV.state]?.trim() || null,
	};
}

/** The best API for a server: the preset's, or for another address, what its host suggests. */
export function autoApi(p: Preset, url: string): Api {
	if (p.id !== "other") return p.api;
	const host = hostOf(url);
	if (host === "api.anthropic.com") return "messages";
	if (host === "api.openai.com") return "responses";
	return "chat";
}

export function extraFields(text: string | undefined): Record<string, unknown> {
	if (!text?.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Extra request fields should be a JSON object, such as {\"top_k\": 20}.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extra request fields should be a JSON object, such as {\"top_k\": 20}.");
	const reserved = Object.keys(value).filter((k) => RESERVED.has(k));
	if (reserved.length) throw new Error(`Extra request fields can't set ${reserved.join(", ")}: the agent sends those itself.`);
	return value as Record<string, unknown>;
}

function count(text: string | undefined, fallback: number, label: string): number {
	if (!text?.trim()) return fallback;
	const n = Number(text);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} should be a whole number above zero (got "${text}").`);
	return n;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** The address is on this Mac, so chats don't leave it. */
export function isLocal(url: string): boolean {
	const host = hostOf(url).replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** For the settings: "Stays on this Mac" or "Sends chats to openrouter.ai". */
export function destination(url: string): string {
	if (isLocal(url)) return "Stays on this Mac";
	const host = hostOf(url);
	return host ? `Sends chats to ${host.replace(/^api\./, "")}` : "No server address yet";
}

/** The base URL each API's client expects: Anthropic's client adds `/v1/messages` itself. */
export function baseUrlFor(api: Api, url: string): string {
	return api === "messages" ? url.replace(/\/v1$/, "") : url;
}

/** Headers that authenticate a plain request (listing models) the way the API expects. */
export function authHeaders(api: Api, key: string): Record<string, string> {
	if (!key) return {};
	return api === "messages" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
}

/** How long a keep-alive request may take: loading a large model from disk takes a minute or more. */
export const PING_TIMEOUT_MS = 180_000;

/**
 * One tiny request for a one-token answer: a server that dropped the model loads it again, and one
 * that unloads idle models counts it as use. A server's own "loaded" list can't stand in for this:
 * oMLX listed a model whose engine had exited until a request came. For keeping a local model loaded.
 */
export async function pingModel(c: Pick<Config, "url" | "api" | "key" | "model">, fetcher: typeof fetch = fetch, timeoutMs = PING_TIMEOUT_MS): Promise<{ ms: number }> {
	const messages = [{ role: "user", content: "Hi" }];
	const [path, body] =
		c.api === "messages"
			? [`${baseUrlFor(c.api, c.url)}/v1/messages`, { model: c.model, max_tokens: 1, messages }]
			: c.api === "responses"
				? [`${c.url}/responses`, { model: c.model, input: "Hi", max_output_tokens: 16 }]
				: [`${c.url}/chat/completions`, { model: c.model, max_tokens: 1, stream: false, messages }];
	const started = Date.now();
	let r: Response;
	try {
		r = await fetcher(path, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(c.api, c.key) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	} catch (e) {
		const err = e as Error;
		if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error(`The server didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
		throw new Error(`Couldn't reach ${c.url}: is the server running?`);
	}
	const text = await r.text().catch(() => "");
	if (r.status === 401 || r.status === 403) throw new Error("The server refused the API key.");
	// LM Studio also answers 404 for a model it has but won't load on request: its message says which.
	if (r.status === 404) throw new Error(`The server doesn't know the model "${c.model}"${detailOf(text) ? ` (${detailOf(text)})` : ""}.`);
	if (!r.ok) throw new Error(`The server answered ${r.status}${detailOf(text) ? `: ${detailOf(text)}` : ""}.`);
	// LM Studio answers a model it doesn't have with whichever model is loaded: that one isn't kept.
	const answered = modelOf(text);
	if (answered && !sameModel(answered, c.model)) throw new Error(`The server answered with "${answered}" instead of "${c.model}": it doesn't have that model, or couldn't load it.`);
	return { ms: Date.now() - started };
}

/** The model a JSON answer says it came from, if it says. */
function modelOf(text: string): string | null {
	try {
		const m = (JSON.parse(text) as { model?: unknown }).model;
		return typeof m === "string" && m ? m : null;
	} catch {
		return null; // a stream or no JSON: nothing to compare
	}
}

/**
 * Whether a server's name for the model that answered is the one asked for. Servers add a variant
 * (`lfm3-1.7b-mlx` answers as `lfm3-1.7b-mlx@8bit` in LM Studio, `qwen3` as `qwen3:latest` in Ollama).
 */
export function sameModel(answered: string, asked: string): boolean {
	const norm = (m: string) => m.trim().toLowerCase().replace(/:latest$/, "");
	const [a, b] = [norm(answered), norm(asked)];
	if (a === b) return true;
	const variant = (long: string, short: string) => ["@", ":"].some((sep) => long.startsWith(short + sep));
	return variant(a, b) || variant(b, a) || a.split("/").pop() === b.split("/").pop();
}

/** A server's error message from its JSON body, shortened. */
function detailOf(text: string): string {
	try {
		const body = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string };
		const m = typeof body.error === "string" ? body.error : (body.error?.message ?? body.detail ?? body.message);
		return typeof m === "string" ? m.replace(/\s+/g, " ").trim().slice(0, 200) : "";
	} catch {
		return "";
	}
}

/** The server's models (`GET <url>/models`), for the settings' model list. */
export async function listModels(c: Pick<Config, "url" | "api" | "key">, fetcher: typeof fetch = fetch): Promise<{ id: string; context?: number }[]> {
	const r = await fetcher(`${c.url}/models`, { headers: authHeaders(c.api, c.key), signal: AbortSignal.timeout(10_000) });
	if (r.status === 401 || r.status === 403) throw new Error("The server refused the API key.");
	if (!r.ok) throw new Error(`The server answered ${r.status} for its model list.`);
	const body = (await r.json()) as { data?: { id?: string; context_length?: number; max_context_window?: number }[] };
	return (body.data ?? [])
		.filter((m): m is { id: string; context_length?: number; max_context_window?: number } => typeof m.id === "string")
		.map((m) => ({ id: m.id, ...(m.context_length || m.max_context_window ? { context: m.context_length ?? m.max_context_window } : {}) }));
}
