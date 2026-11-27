# Other agents and local models

The Agent plugin talks to any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdin and stdout and accepts
the MCP servers its client gives it. In the agents list, choose **Add an ACP agent…** and enter:

- **Command**: the command that starts the agent in ACP mode, for example `my-agent --acp`. It's
  split into words the way a shell would (quotes group, backslash escapes) but no shell runs it, so
  `$VARIABLES`, `~` and pipes aren't expanded. Use full paths when the program isn't on your login
  shell's PATH.
- **Environment**: `NAME=value` lines added to the agent's environment, such as a local server's
  address. Lines starting with `#` are ignored.

**Test** checks that it starts and opens a session; **Use** does the same and then switches to
it. Unsaved edits stay a draft until you save or discard them, and you can add several custom
agents (say, one per local model) and switch between them.

The agent must use the MCP servers it's given: that's how it reaches Toolbelt. An adapter that
accepts them but doesn't pass them to its model answers without any Toolbelt tools.

## A local model (for example oMLX)

Local inference servers such as oMLX, LM Studio, Ollama or llama.cpp expose an OpenAI-compatible
API (`http://localhost:<port>/v1`), and some (oMLX among them) also Anthropic's Messages API. Use
a model that handles tool calls well; small models often don't call tools at all and answer from
nothing.

**Claude Code** suits a server that speaks the Messages API (or a proxy that translates it). Open
**Claude Code** in the agents list and fill in its **Environment**, for example for oMLX:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8000
ANTHROPIC_AUTH_TOKEN=<the server's API key, if it has one>
ANTHROPIC_MODEL=Qwen3.8-27B-4bit
ANTHROPIC_DEFAULT_HAIKU_MODEL=Qwen3.8-27B-4bit
MAX_THINKING_TOKENS=0
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

`ANTHROPIC_MODEL` is the model as the server names it; the Haiku line keeps Claude Code's small
background requests on the same server, and `MAX_THINKING_TOKENS=0` turns thinking off (often
faster on a local model). The built-in Claude Code starts without its own tools, settings and MCP
servers, so a local model gets a short prompt: ToolBelt's tools and little else. Clear the
Environment to go back to your Claude login. The lines are kept in the plugin's settings on this
Mac, in plain text.

Adding `claude-agent-acp` as a custom agent with the same lines works too, but a custom agent isn't
isolated: Claude Code then sends its whole toolset (several times the prompt, so slower answers on
a local model) and reads your Claude settings and MCP servers.

**Codex** works with a server that speaks the OpenAI Responses API: its ACP adapter passes
Toolbelt's MCP server through, and Codex supports custom model providers. Keep it apart from your
everyday Codex with its own configuration folder: add a custom agent with the command `codex-acp`
and the environment line `CODEX_HOME=/Users/<you>/.codex-local`, and put the provider in that
folder's `config.toml` (see Codex's configuration docs for the current keys):

```toml
model_provider = "local"
model = "your-model-name"               # as your server names it
model_reasoning_effort = "none"

[model_providers.local]
name = "Local (oMLX)"
base_url = "http://localhost:8000/v1"   # your server's address
env_key = "LOCAL_API_KEY"               # set it in the agent's environment, if the server has a key
wire_api = "responses"
```

Codex's own instructions and tools come along, so its prompt is long for a local model.

## pi

pi's community ACP adapters (such as `pi-acp`) currently accept MCP servers without passing them
to pi, so pi wouldn't see Toolbelt's tools through them. Check the adapter's documentation for MCP
support before using it here.
