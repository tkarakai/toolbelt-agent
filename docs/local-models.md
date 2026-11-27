# Local models

How to run the Agent plugin on a model served from your own Mac, what each setup is good for,
and what to expect. This is a living document: setups and inference servers are added as they
are tried. Each section says whether it was measured or not yet tested.

## Choosing a setup

| Setup | For | Leaves your Mac? | Limits |
|---|---|---|---|
| **Model API** ([below](#model-api)), built in | The fastest answers from a model of your choice, on this Mac or hosted | Not with a local server: it only ever connects to the address you give it | About 10 s per answer on a 27B model (measured) |
| Claude Code, your Claude login | Best answers, least setup | Yes: conversations go to Anthropic | Needs a Claude subscription or API key |
| Claude Code, local server ([below](#claude-code-on-a-local-server)) | Everything local through an agent you already have | No, with the lines below (measured) | About 20 s per answer on a 27B model, against 11–13 s for a lightweight harness: Claude Code adds its own prompt, longer answers and a chat-title request |
| Codex, local server ([Other agents](other-agents.md)) | People who already use Codex | Not checked | Codex's own instructions and tools come along, so the prompt is long. Not measured |
| A custom ACP agent ([Other agents](other-agents.md)) | Any other agent or adapter | Depends on the agent | Isn't isolated: it may read your settings and offer its own tools |

Don't add `claude-agent-acp` as a custom agent for a local model. Use the built-in Claude Code
entry: only that entry starts Claude Code isolated and asks the plugin before each tool.

## What a local setup needs from the model and server

- **Tool calls.** The model must call tools reliably. Small models often answer without
  calling any tool. Qwen3.8-27B (4-bit) did well; see [Results](#results).
- **Context.** Allow at least 32k tokens. Claude Code's first request is about 4k tokens, and
  reading a busy screen can bring a conversation to 15k or more.
- **API.** Model API speaks Chat Completions, Responses and Anthropic Messages, and picks the
  best one for the server. Claude Code needs Anthropic's Messages API (`/v1/messages`). Codex
  needs OpenAI's Responses API.
- **Thinking off.** Thinking roughly doubles answer time without improving these answers (see
  [Thinking](#thinking)). Make sure the server doesn't think by default for the model you use.

## Model API

ToolBelt's own lightweight agent, built into the plugin. Open **Model API** in the agents list:

- **Server:** oMLX, llama.cpp, Ollama, LM Studio, OpenRouter, OpenAI, Anthropic, Gemini or Other.
  The preset fills in the usual address, the API to use and how to turn thinking off. Under
  the card's title it says where chats go: **Stays on this Mac**, or **Sends chats to …**.
- **API key**, when the server has one. Toolbelt keeps it in your Mac's Keychain, never in the
  plugin's settings.
- **Model:** chosen from the server's list of models, or typed.
- **Thinking:** off by default, about twice as fast on a model on this Mac.
- **Advanced:** the API (automatic by default), max answer length, context size, tool steps per
  answer, extra instructions, and extra request fields as JSON.
- **Before you start:** what to set up on the server's side, for a model on this Mac or a hosted
  one.

**Test** starts the agent, connects it to ToolBelt and asks the model one small question with a
tool. It reports how long the answer took and whether the model called the tool. If it fails, it
opens **Before you start** at the item that explains why. A model that answers without calling
tools would answer without reading ToolBelt.

It only ever connects to the address you give it, and ToolBelt's own MCP server. It doesn't name
chats with an extra request or send a long system prompt of its own, which is why it answers about
twice as fast as Claude Code on the same model.

## Claude Code on a local server

Open **Claude Code** in the agents list and fill in its **Environment**:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8000
ANTHROPIC_AUTH_TOKEN=<the server's API key, or any text if it has none>
ANTHROPIC_MODEL=<the model, as the server names it>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<the same model, or a smaller one on the same server>
MAX_THINKING_TOKENS=0
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CONFIG_DIR=/Users/<you>/.claude-toolbelt-local
HTTPS_PROXY=http://127.0.0.1:9
HTTP_PROXY=http://127.0.0.1:9
NO_PROXY=127.0.0.1,localhost
```

Values aren't run through a shell, so write full paths: `~` and `$HOME` aren't expanded. A
variable whose name looks like a secret (`ANTHROPIC_AUTH_TOKEN`, anything with KEY, TOKEN,
SECRET, PASSWORD or AUTH) is locked: Toolbelt keeps its value in your Mac's Keychain, and the rest
stay in the plugin's settings. Tokens saved as plain text by an older version are moved into the
Keychain the first time the plugin starts. Remove the variables to go back to your Claude login.

What each group of lines does:

- **`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL`** send Claude Code's
  requests to your server.
- **`ANTHROPIC_DEFAULT_HAIKU_MODEL`** covers Claude Code's background requests, such as naming
  each new chat. Without it they'd ask the server for a Claude model it doesn't have.
- **`MAX_THINKING_TOKENS=0`** stops Claude Code from asking for thinking. When thinking isn't
  requested, the server's own setting for the model decides. See [Thinking](#thinking).
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`** turns off telemetry, error reports and update
  checks.
- **`CLAUDE_CONFIG_DIR`** gives this Claude Code a folder of its own instead of `~/.claude`:
  - your Claude login isn't in it;
  - your settings don't apply;
  - its chats don't appear in your everyday Claude Code history.
- **The proxy lines** make leaving the Mac fail. Every connection that isn't to `127.0.0.1` or
  `localhost` goes to a port where nothing listens, so it's refused. If the server address is
  ever wrong or missing, Claude Code reports an error instead of reaching Anthropic. If your
  server isn't on this Mac, add its host to `NO_PROXY`.

### What was checked

Claude Code 2.1.331 through `claude-agent-acp` 0.112.0, with oMLX, running the evaluation cases the
way the plugin starts it:

- **The lines above.** Nothing tried to leave the Mac. A logging proxy received no requests, and
  sampling the process tree's connections found none to other hosts.
- **The server address removed on purpose.** All 14 attempts went to the proxy as
  `CONNECT api.anthropic.com:443` and were refused, and there were no direct connections.

### Does it change your everyday Claude Code?

No. The plugin starts Claude Code without your settings files, `CLAUDE.md`, hooks, plugins or MCP
servers, and without its built-in tools. Its only tools are ToolBelt's. It doesn't write your
settings. On your login, without a separate `CLAUDE_CONFIG_DIR`, it does two things in
`~/.claude`:

- it saves its chats as Claude Code sessions for the plugin's empty workspace folder;
- it updates Claude Code's usual bookkeeping in `~/.claude.json`.

Claude Code's adapter does read your default permission mode. The plugin then switches each
session to asking first, so that mode doesn't apply.

## Thinking

Measured with Qwen3.8-27B (4-bit) on oMLX, through Claude Code:

| | Typical / slow answer | Output tokens per answer |
|---|---|---|
| Thinking on (oMLX's setting for this model) | 38 s / 96 s | ~1,600 |
| Thinking off | 20 s / 44 s | ~520 |

Both passed nearly all cases, so thinking made answers slower without making them better.
`MAX_THINKING_TOKENS=0` alone doesn't turn it off on oMLX: Claude Code then leaves thinking out of
its requests, and oMLX applies the model's own setting.

## Side requests and parallel requests

Claude Code names every new chat with a separate request (on oMLX about 900 tokens in, 100–175
out, 4–17 s). There's no setting to turn it off. It runs at the same time as the first answer, so
it doesn't wait in a queue, but it shares the GPU and slows that answer.

- **oMLX** already serves requests in parallel (`scheduler.max_concurrent_requests`, 8 here).
  Raising it doesn't help: there are only two requests at once.
- **A smaller title model.** Pointing `ANTHROPIC_DEFAULT_HAIKU_MODEL` at a small model on the same
  server should make the title request lighter. It needs memory for a second model. Not measured.

## Inference servers

### oMLX (measured)

oMLX serves Anthropic's Messages API at `http://127.0.0.1:8000` (use the API key from its
settings).

1. **Thinking.** Thinking is set per model (`enable_thinking` in the model's settings). To keep
   your other uses of the model unchanged, add a profile for the model with thinking off, expose
   it as a model, and use its API name as `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
   Check that the name appears in `GET /v1/models`.
2. **Context.** Keep the model's context window at 32k tokens or more (`max_context_window`).
3. **Parallel requests.** `scheduler.max_concurrent_requests` should be at least 2. The default
   setup here had 8.
4. **Prompt cache.** Leave the cache on. Each request repeats the earlier conversation, and most
   of it was served from the cache.

### llama.cpp (not yet tested)

`llama-server` has an Anthropic Messages endpoint in recent versions. To fill in once measured:

- turning thinking off (the chat template's `enable_thinking`, or the reasoning options);
- the context size (`-c`);
- parallel slots (`-np`), so the title request doesn't wait;
- the exact Environment lines.

### Ollama (not yet tested)

Recent Ollama versions serve an Anthropic-compatible API. To fill in once measured:

- turning thinking off;
- the context size: Ollama's default is far below 32k, so raise it;
- parallel requests (`OLLAMA_NUM_PARALLEL`);
- the exact Environment lines.

## Results

Qwen3.8-27B (4-bit) on oMLX, on one Apple Silicon Mac, with the same ToolBelt workspace and
questions. Measured with the evaluation harness in the ToolBelt repository
(`evals/agent-models`).

| Setup | Passed | Typical / slow answer | Output tokens per answer | First prompt |
|---|---|---|---|---|
| **Model API** | 22/23 (96%) | 10.2 s / 25 s | ~240 | 2.5k tokens |
| Evaluation harness (pi-durable) | 65/69 (94%) | 11–13 s / 32 s | ~270 | 2.4k tokens |
| Claude Code, thinking on (run stopped early) | 29/30 | 38 s / 96 s | ~1,600 | 4.2k tokens |
| Claude Code, thinking off | 21/23 (91%) | 20 s / 44 s | ~520 | 4.2k tokens |

- **The 10-turn planning conversation** passed 10/10 through Claude Code with thinking off, in
  84 s in total.
- **The misses** were the same kinds in both setups:
  - an archived task treated as current;
  - a work task listed among personal ones.
- **The remaining gap** with the harness comes from three things:
  - Claude Code's longer prompt;
  - its longer answers;
  - the chat-title request.
