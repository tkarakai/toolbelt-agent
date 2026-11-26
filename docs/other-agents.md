# Other agents and local models

The Agent plugin talks to any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdin and stdout and accepts
the MCP servers its client gives it. Pick **Another ACP agent…** in the settings and enter:

- **Command**: the command that starts the agent in ACP mode, for example `my-agent --acp`. It's
  split into words the way a shell would (quotes group, backslash escapes) but no shell runs it, so
  `$VARIABLES`, `~` and pipes aren't expanded. Use full paths when the program isn't on your login
  shell's PATH.
- **Environment**: `NAME=value` lines added to the agent's environment, such as a local server's
  address. Lines starting with `#` are ignored.

**Test connection** checks that it starts and opens a session.

The agent must use the MCP servers it's given: that's how it reaches Toolbelt. An adapter that
accepts them but doesn't pass them to its model answers without any Toolbelt tools.

## A local model (for example oMLX)

Local inference servers such as oMLX, LM Studio, Ollama or llama.cpp expose an OpenAI-compatible
API (`http://localhost:<port>/v1`). Point an ACP agent that supports MCP and custom model providers
at it.

**Codex** suits this: its ACP adapter passes Toolbelt's MCP server through, and Codex supports
custom model providers in `~/.codex/config.toml`, which `codex-acp` reads. Add a provider for your
server and make it the model Codex uses (see Codex's configuration docs for the current keys):

```toml
model_provider = "local"
model = "your-model-name"                 # as your server names it

[model_providers.local]
name = "Local (oMLX)"
base_url = "http://localhost:8000/v1"   # your server's address
```

Then pick **Codex**. That changes Codex's default everywhere; to keep it separate, use a Codex
profile and start the adapter with it as a custom command, as `codex-acp`'s README describes. Use a
model that handles tool calls well; small models often don't call tools at all and answer from
nothing.

**Claude Code** works too when the local server speaks Anthropic's Messages API (or through a
proxy that translates it): choose **Another ACP agent…** with the command `claude-agent-acp` and
the environment line `ANTHROPIC_BASE_URL=http://localhost:<port>`.

## pi

pi's community ACP adapters (such as `pi-acp`) currently accept MCP servers without passing them
to pi, so pi wouldn't see Toolbelt's tools through them. Check the adapter's documentation for MCP
support before using it here.
