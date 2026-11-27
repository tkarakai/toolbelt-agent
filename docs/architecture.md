# Agent architecture

The Agent plugin owns the chat, the ACP client and its settings. Toolbelt owns the floating
window (frame, moving, resizing, minimizing, the sidebar item and ⌘K), the rendering, the agent
interface the agent talks to (MCP over Toolbelt's agent socket), its access levels, grants,
approvals and audit log.

## Runtime and UI

Toolbelt launches the bundled `index.js` with Bun. The plugin uses the public `@toolbelt/sdk`
package over JSON lines on stdin/stdout; stderr is diagnostic output (agent stderr is relayed to it
prefixed `[agent]`). The manifest declares `floating` (shortcut K), no screens, capability
`ui.floating`, and `agent.access: "none"`: agents never read the chat itself.

The only surface is `floating`. `src/ui.ts` renders it as a pure function of the state:

- **Agents** (`mode: "panel"`, subtitle Agents) on first run and from the gear (`settings`): a
  `list` (`agents`) of every agent (`connections.ts`: the built-in ones, then custom ones), each
  with its install state or last start, "In use" on the active one, an inline `use` and, for
  inactive custom agents, `delete` (confirmed); its `open-agent` opens an agent's page, and the
  last row (`add`) a new custom agent. Done (`done`) once an agent is in use.
- **An agent's page** (subtitle its name, `back`): a built-in agent's install state and login
  note (and, for Claude Code, a form `agent` with its `env` lines), or a custom agent's form (`agent`: `name`, `command`, `env`), and a card (`connection`)
  with `test`, `discard`, `save` and `use` ("Use X", or Save for the agent in use).
- **Chats** (`mode: "panel"`, subtitle `Chats · N`, from `history`): a search form (`history`,
  field `search`, matched against titles when committed), then one `list` per period (Pinned,
  Today, Yesterday, Earlier this week, This month, Older) under a muted heading. A row's
  `open-thread` continues it; its actions are `rename` (with text input), `pin`/`unpin` and
  `delete-thread` (confirmed). Title bar: `chat` (back) and `new-chat`.
- **Ask bar** (`mode: "bar"`) while the chat is empty or folded back (`collapsed`): suggestions
  (`suggest:*` under "Try asking", sent as questions; above them, unless `Settings.recent` is off,
  the three most recent chats as `thread:<id>` under "Continue" with their time, and `history`
  when there are more), the composer (`ask`), and when folded back the last answer's first line
  and `expand`. Suggestion groups and times need ToolBelt 0.7.1; older hosts show a flat list.
- **Chat** (`mode: "panel"`): the `conversation` (`chat`), a problem card when something needs the
  person (with the install command and an Open settings action), and the composer. Title bar:
  `new-chat`, `collapse`, `settings`; while working `stop` and `settings`, `busy` set and the
  composer disabled.

Renders are coalesced to at most one per 100 ms while an answer streams, and the conversation
sends the most recent 80 messages (`VISIBLE_MESSAGES`) with a note for the rest, so long chats stay
far inside Toolbelt's 30 renders/s and 4 MiB limits. The conversation lives in plugin memory and
resets on restart.

## Agents

`src/agents.ts` lists the agents (Claude Code's adapter `claude-agent-acp`, Codex's `codex-acp`,
`gemini --acp`) and resolves the chosen one to a command, or to why it can't start (with its
install command). A custom agent is a command line (split like a shell would, without running one)
plus `NAME=value` environment lines; Claude Code (`AgentKind.env`) takes such lines too, to use
another model or server, and keeps its isolation (below) with them. Commands are looked up in the person's login-shell PATH
(read once, by asking `$SHELL -ilc` to print it, 5 s limit) followed by the usual install folders
(`~/.local/bin`, `~/.bun/bin`, Homebrew, `/usr/local/bin`, …), because Toolbelt starts plugins with
the app's minimal PATH. Agents run with that PATH and only `HOME`, `USER`, `LANG`, `LC_ALL`,
`TMPDIR`, `SHELL` from the plugin's environment, plus the agent's own variables from its setup.

Nothing is downloaded. The other agents are the person's own installation and login. (Claude
Code's adapter depends on the Claude Agent SDK, whose license doesn't allow redistributing it in
this archive, and on Claude Code's native binary, larger than Toolbelt's archive limits.) The one
bundled agent is the plugin's own Model API agent (below).

## Model API agent

`src/model-api/` is ToolBelt's own lightweight agent for any model server, local (oMLX,
llama.cpp, Ollama, LM Studio) or hosted (OpenRouter, OpenAI, Anthropic, Gemini). It's built to
`model-api.js` in the archive (minified, about 1.2 MB; about 300 KB of the archive) and runs as its
own Bun process that speaks ACP like any other agent. It isn't in the agents list yet.

- **Settings** (`config.ts`) arrive as `TOOLBELT_MODEL_API_*` variables:
  - `PRESET` and `URL`: the server;
  - `API`: `auto`, `chat`, `responses` or `messages`;
  - `MODEL` and `KEY`;
  - `THINKING`: `off`, `low`, `medium` or `high`;
  - `MAX_OUTPUT`, `CONTEXT` and `MAX_STEPS`;
  - `INSTRUCTIONS`: appended to the system prompt;
  - `EXTRA`: a JSON object added to request bodies, which can't set the model, messages or tools;
  - `STATE`: where chats are kept.

  A preset supplies the address, the best API (`auto`), how thinking is switched over Chat
  Completions (`chat_template_kwargs.enable_thinking`, `reasoning_effort` or OpenRouter's
  `reasoning`) and a default context size. A settings problem is reported as the error of
  `session/new`, so **Test** shows it.
- **Requests** go through pi-ai (`models.ts`): one provider with one model, over Chat
  Completions, Responses or Anthropic Messages. The three API modules are imported up front: a
  bundled lazy import left pi-ai's telemetry uninitialized. The process replaces `fetch` with one
  that refuses every address but the configured server's origin and adds the extra fields
  (`serverFetch`).
- **Chats** (`agent.ts`) are pi-durable conversations:
  - Each is stored as JSONL in `STATE/<session id>/`, or in memory without `STATE`, which also
    turns off `loadSession`.
  - The only tools are ToolBelt's MCP tools, through a small stdio MCP client (`mcp.ts`) started
    from the command in `session/new`. The MCP server gets the plugin's environment without the
    `TOOLBELT_MODEL_API_*` variables.
  - The system prompt is ToolBelt's MCP instructions, the date and time when the chat was opened
    (fixed, so the server's prompt cache holds), and the person's instructions. The plugin's
    preamble arrives in the first message, as with every agent.
  - Partial answers and thinking are streamed from pi-durable's live state as
    `agent_message_chunk` and `agent_thought_chunk`. Tool calls are reported by the tools
    themselves (`tool_call` titled `toolbelt.<tool>`, then `tool_call_update`).
  - A cancel aborts the run.
  - A run that fails is answered with an error worded for the person: the server is unreachable,
    the key was refused, the model is unknown, or the conversation is too long.
- **ACP** (`server.ts`) offers `initialize`, `session/new`, `session/load` (which replays the user
  and agent messages), `session/prompt` and `session/cancel`. It never asks the client anything.

## ACP client and session

`src/acp.ts` is a minimal ACP v1 client over the agent's stdio: `initialize` (client capabilities:
no file system, no terminal), `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`
notifications and `session/request_permission` requests. Any other request from the agent
(`fs/*`, `terminal/*`, …) is answered with JSON-RPC error -32601. Lines that aren't JSON are
ignored (agents that log to stdout).

`src/session.ts` (`AgentSession`) owns one conversation:

- The first question starts the agent in `<data>/workspace` (an empty folder) and opens a session
  whose only MCP server is Toolbelt's: `TOOLBELT_AGENT_COMMAND` (the SDK's `agentCommand()`) plus
  `mcp --client "Agent · <agent name>"`, so Toolbelt's grants and audit log name it. When the
  socket in that command doesn't exist, the chat says to turn on Settings → Agents instead.
- For Claude Code the session's `_meta.claudeCode.options` (`CLAUDE_ISOLATION`) sets `tools: []`
  (no built-in tools), `settingSources: []` (none of the person's Claude settings, hooks or
  permission rules), `strictMcpConfig: true` (none of their MCP servers) and
  `allowDangerouslySkipPermissions: false`. Its adapter still starts the session in the person's
  `permissions.defaultMode` (it reads their settings itself), often Auto, which decides without
  asking and, through another endpoint such as a local model, refuses every tool. So after
  `session/new` or `session/load`, when the reported modes aren't already `default`, the session
  asks for `session/set_mode` `default` (`CLAUDE_MODE`), where every tool call becomes a
  permission request (below).
- The first prompt carries `PREAMBLE`, which tells the agent where it is and which Toolbelt tools
  it has; follow-ups reuse the session.
- Permission requests are allowed (`allow_once`) only for Toolbelt's MCP tools
  (`mcp__toolbelt__<tool>` or `toolbelt.<tool>`) and refused otherwise, with a line in the chat.
  Toolbelt's own access levels and view grants still apply to the allowed ones.
- A new chat, another agent or another custom command closes the agent; the next question starts
  it again. An agent that exits mid-answer leaves the reason in the chat.

`src/chat.ts` turns session updates into messages: answer chunks into one assistant message per
turn, tool calls into tool rows that update in place (named without the `mcp__toolbelt__` prefix,
with their input and output as details, capped at 4,000 characters). Thoughts, plans and usage
aren't shown.

## Saved chats

`src/threads.ts` keeps chats in `<data>/threads/`: `index.json` (id, title, created, updated,
pinned, agent, agentName, count) and `<id>.json` (messages as shown, the agent's session id),
written atomically. A chat is saved when its first question is asked and again when the answer
ends (`persist()` in index.ts); its title is the first question, shortened to 60 characters.
`Settings.keep` (`off`, `30`, `90`, `forever`; default 30) prunes unpinned chats by last use at
start, when a new chat is saved and when it changes; at most 200 unpinned chats are kept. With
`off`, new chats aren't saved. `Delete all` removes the folder. Ids are checked against
`/^[a-z0-9]{6,24}$/` before touching files; a damaged index loads as no chats.

Opening a chat (`thread:<id>` or `open-thread`) shows its messages and remembers its session.
The next question continues it (`AgentSession.restore`): when the agent in use is the chat's agent
and offers `loadSession`, the session reopens with `session/load` (its replayed updates are
ignored, since the messages are already shown) and the question goes as a follow-up. Otherwise a
new session starts, and the first prompt carries the preamble and a recap of the conversation
(`Chat.transcript`: questions and answers, newest kept within 8,000 characters, no tool output),
with a note in the chat. Deleting a chat removes only ToolBelt's copy; agents may keep their own
session records.

## Settings and switching

`src/settings.ts` keeps every agent's setup: `active` (a built-in id or `custom:<id>`), `custom`
(`id`, `name`, `command`, `env`), `env` (environment lines of built-in agents that take them,
by id) and `tested` (each agent's last start from the settings: `ok`,
`at`, `text`). The agent in use is always one that worked: `use` first starts the agent as it's
set up (a custom agent's draft) in a separate `AgentSession` whose `check()` opens a session
without prompting, then saves the draft, makes it active and closes the conversation's agent so
the next question starts the new one. If the start fails, nothing is saved and the active agent
stays. `test` does the same start without switching. Starting from the settings never touches the
conversation's own agent process.

Edits to a custom agent, or to a built-in agent's environment lines, go to an in-memory draft
(`drafts`) until `save`, `use` or `discard`; the
list says "Unsaved changes" meanwhile. A draft's failed start isn't remembered as the saved
setup's result. New custom agents exist only as drafts until saved. The agent in use can't be
deleted.

## Data

The stable plugin id is `agent`. Data schema 1: `settings.json` in the data folder, written
atomically: `active`, `custom`, `env`, `tested`, `keep` and `recent`, plus the first version's `agent`, `customName`,
`customCommand` and `customEnv` mirrored from the agent in use, so older versions still read it.
The first version's file (only those fields) loads as one active agent (a custom one becomes
`custom:1`). Unknown agents, malformed ids and results for missing agents are dropped.
`threads/` holds saved chats (above); `workspace/` is the agents' working folder.

## Tests

`test/fake-agent.ts` is an in-memory ACP agent with scripted turns. Tests cover the client
(capabilities offered, refused methods, permission answers, errors, a vanishing agent), the chat
model, agent lookup and command parsing, the session (MCP server and isolation, the preamble,
refused tools, problems, stop, test starts) and every view, validated against the SDK's tree
schema, and settings loading (the first version's file, bad values, the mirrored fields).
`scripts/verify-package.ts` runs the built archive like Toolbelt does: the first-run agents list,
adding a custom agent and switching to it (a tiny stdio ACP agent that only opens sessions), the
ask bar, a question whose chat is saved, the bundled Model API agent answering `initialize` and
reporting a missing model, then prepare and shutdown. `test/model-api.test.ts` covers the Model API
agent's settings, the server-only `fetch`, a conversation over each API against a fake server
(`test/model-api-fakes.ts`), errors, cancelling, reopening a kept chat in a new process, and the
agent process, from source and from a fresh bundle, with a real MCP server process.
