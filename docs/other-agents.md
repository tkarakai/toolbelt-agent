# Other agents and local models

The Agent plugin talks to any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) on stdin and stdout and accepts
the MCP servers its client gives it. In the agents list, choose **Add an ACP agent…** and enter:

- **Command**: the command that starts the agent in ACP mode, for example `my-agent --acp`. It's
  split into words the way a shell would (quotes group, backslash escapes) but no shell runs it, so
  `$VARIABLES`, `~` and pipes aren't expanded. Use full paths when the program isn't on your login
  shell's PATH.
- **Environment**: variables added to the agent's environment, such as a local server's address.
  A variable whose name looks secret (KEY, TOKEN, SECRET, PASSWORD, AUTH) is locked: Toolbelt
  keeps its value in your Mac's Keychain. The lock button switches it before a value is saved.

**Test** checks that it starts and opens a session; **Use** does the same and then switches to
it. Unsaved edits stay a draft until you save or discard them, and you can add several custom
agents (say, one per local model) and switch between them.

The agent must use the MCP servers it's given: that's how it reaches Toolbelt. An adapter that
accepts them but doesn't pass them to its model answers without any Toolbelt tools.

## A local model (for example oMLX)

The simplest and fastest way is the built-in **Model API** agent: choose the server and a model,
and it does the rest ([Local models](local-models.md#model-api)). The agents below work too, for
those who prefer an agent they already use.

Local inference servers such as oMLX, LM Studio, Ollama or llama.cpp expose an OpenAI-compatible
API (`http://localhost:<port>/v1`), and some (oMLX among them) also Anthropic's Messages API. Use
a model that handles tool calls well; small models often don't call tools at all and answer from
nothing.

**Claude Code** suits a server that speaks the Messages API: open **Claude Code** in the agents
list and fill in its **Environment**. [Local models](local-models.md) has the variables, including
the ones that keep everything on your Mac, and how to set up the server and what to expect.

Use the built-in Claude Code rather than adding `claude-agent-acp` as a custom agent: a custom
agent isn't isolated. Claude Code then sends its whole toolset (several times the prompt, so slower
answers on a local model), reads your Claude settings and MCP servers, and runs in your own
permission mode; if that's Auto, a local model has every tool refused.

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
