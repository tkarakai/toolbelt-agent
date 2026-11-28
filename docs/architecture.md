# Agent architecture

The Agent plugin owns the chat, the ACP client and its settings. Toolbelt owns the floating
window (frame, moving, resizing, minimizing, the sidebar item and ⌘K), the rendering, the agent
interface the agent talks to (MCP over Toolbelt's agent socket), its access levels, grants,
approvals and audit log.

## Runtime and UI

Toolbelt launches the bundled `index.js` with Bun. The plugin uses the public `@toolbelt/sdk`
package over JSON lines on stdin/stdout; stderr is diagnostic output (agent stderr is relayed to it
prefixed `[agent]`). The manifest declares `floating` (shortcut K), no screens, capabilities
`ui.floating`, `ui.collapsible-cards` and `secrets` (Toolbelt 0.8.0, SDK 0.6.0), and
`agent.access: "none"`: agents never read the chat itself.

The only surface is `floating`. `src/ui.ts` renders it as a pure function of the state:

- **Agents** (`mode: "panel"`, subtitle "Agent settings") on first run and from the gear (`settings`): a
  `list` (`agents`) of every agent (`connections.ts`: the built-in ones, then custom ones), each
  with its install state or last start, "In use" on the active one, an inline `use` and, for
  inactive custom agents, `delete` (confirmed); its `open-agent` opens an agent's page, and the
  last row (`add`) a new custom agent. Done (`done`) once an agent is in use.
- **An agent's page** (subtitle "<name> settings", `back`), then a card (`connection`) with `test`,
  `discard`, `save` and `use` ("Use X", or Save for the agent in use):
  - **Model API:** a card (`server`, titled with the preset, its description where chats go:
    "Stays on this Mac" or "Sends chats to <host>") with the form `model-api`: `preset`, `url`,
    `key` (a Keychain secret field, `model-api/key`; absent for presets without keys), `model`
    (a combobox of the server's models, freeform) and `thinking`, and the action
    `refresh-models`. The models are listed afresh whenever the page opens. Then two collapsible cards:
    `advanced` (form `model-api-advanced`: `api`, `maxOutput`, `context`, `maxSteps`,
    `instructions`, `extra`) and `guide` ("Before you start": the checklist for a local or hosted
    server, the preset's own item first). A failed Test that says what went wrong (`guide`)
    puts that item at the top and opens the card (`open: true`; left out otherwise).
  - **Another built-in agent:** its install state and login note, and for Claude Code a form
    `agent` with its `env` field.
  - **A custom agent:** the form `agent`: `name`, `command` and `env`.

  `env` is an `environment` field with `secretPrefix` `agents/<id>/env` (`custom:1` becomes
  `custom-1`): Toolbelt keeps a secret variable's value in the Keychain and the plugin gets the
  entry without it.
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

`src/agents.ts` lists the agents (the bundled Model API agent, Claude Code's adapter
`claude-agent-acp`, Codex's `codex-acp`, `gemini --acp`) and resolves the chosen one to a
command, or to why it can't start (with its install command). The Model API agent
(`AgentKind.bundled`) is always there: ToolBelt's Bun (`process.execPath`) running `model-api.js`
beside `index.js` (`modelApiCommand`). A custom agent is a command line (split like a shell would,
without running one) plus environment variables; Claude Code (`AgentKind.env`) takes variables
too, to use another model or server, and keeps its isolation (below) with them.
`connections.ts` reads an agent's environment when it starts (`resolveConnection`): its selected
variables, secret ones from the Keychain (`ctx.secrets.get`), or for the Model API agent its
`TOOLBELT_MODEL_API_*` variables with the key from `model-api/key` and `STATE` in the plugin's
`model-api/` data folder. A secret variable without a saved value keeps the agent from starting
and says which. Commands are looked up in the person's login-shell PATH
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
own Bun process that speaks ACP like any other agent. It's the agents list's **Model API** entry.

- **Settings** (`config.ts`) arrive as `TOOLBELT_MODEL_API_*` variables:
  - `PRESET` and `URL`: the server;
  - `API`: `auto`, `chat`, `responses` or `messages`;
  - `MODEL` and `KEY`;
  - `THINKING`: `off`, `low`, `medium` or `high`;
  - `MAX_OUTPUT`, `CONTEXT` and `MAX_STEPS`;
  - `INSTRUCTIONS`: appended to the system prompt;
  - `EXTRA`: a JSON object added to request bodies, which can't set the model, messages or tools;
  - `STATE`: where chats are kept.

  `modelApi.keepLoaded` (below) stays in the plugin and isn't passed to the agent.

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
  - The system prompt is ToolBelt's MCP instructions and the person's instructions, the same for
    every chat so the server's prompt cache serves it (and the tools after it) to each new chat.
    Nothing time-dependent goes in it: each message carries when it was sent (`sentAt`). The
    plugin's preamble arrives in the first message, as with every agent.
  - Partial answers and thinking are streamed from pi-durable's live state as
    `agent_message_chunk` and `agent_thought_chunk`. Tool calls are reported by the tools
    themselves (`tool_call` titled `toolbelt.<tool>`, then `tool_call_update`).
  - A cancel aborts the run.
  - A run that fails is answered with an error worded for the person: the server is unreachable,
    the key was refused, the model is unknown, or the conversation is too long.
- **ACP** (`server.ts`) offers `initialize`, `session/new`, `session/load` (which replays the user
  and agent messages), `session/prompt` and `session/cancel`. It never asks the client anything.
- **Probe** (`_toolbelt/probe`, an ACP extension method): one request with a single `ping` tool,
  answering `{ ok, text }` or `{ ok: false, reason, text }` with `reason` `server` (unreachable,
  refused key, unknown model), `tools` (answered without calling it) or `model`. The settings'
  Test calls it after opening a session (`AgentSession.check`) and shows its `text`; a failure's
  `reason` opens "Before you start".
- **Keeping the model loaded** (`src/keeper.ts`, in the plugin's process, active mode only): with
  `modelApi.keepLoaded` `"on"`, while Model API is the agent in use and its address is on this Mac
  (`isLocal`), `ModelKeeper` sends `pingModel` (a one-token request: `max_tokens: 1` over Chat
  Completions or Messages, `max_output_tokens: 16` over Responses, 180 s limit) at once and then
  every 60 s, skipping a round while a chat is answered. A real request, not a server's list of
  loaded models: oMLX kept listing a model whose engine had exited until a request came, and that
  request reloads it. A check slower than 5 s means the server loaded the model, or was busy
  (logged, and said under the switch).

  The person runs the server too (stops, upgrades, quits or uninstalls it, loads other models,
  unloads this one, keeps it busy), so checks back off exponentially (`backoff`: 1, 2, 4, 8, then
  15 minutes) in two cases: while they fail, and while every check has to load the model again
  (`reloads`: something else keeps unloading it, and loading it each minute would fight that). A
  quick successful check returns to every 60 s; so does **Try now** (`keep-retry`), a chat that
  was answered while checks were failing, and any settings change (a new target starts over).
  Every failure is logged and shown under the switch with the next try's time. From the second
  failure in a row (`NOTIFY_AFTER`; a server restarting for an upgrade misses one check) the
  plugin toasts the reason, sets the badge `!` and shows it above the composer; the next success
  toasts that the model is loaded again and clears the badge (start clears a badge left from
  before a restart). The first check in a row that had to reload the model again toasts once.
  Saving settings or switching agents starts, retargets or stops it. Hosted servers aren't
  offered it. ToolBelt never starts, stops or unloads anything on the server.
- **Models**: the settings list the server's models (`listModels`, `GET <url>/models` with the
  key) when the page opens and when the server, address, API or key changes, for the model field.

## ACP client and session

`src/acp.ts` is a minimal ACP v1 client over the agent's stdio: `initialize` (client capabilities:
no file system, no terminal), `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`
notifications and `session/request_permission` requests. Any other request from the agent
(`fs/*`, `terminal/*`, …) is answered with JSON-RPC error -32601. Lines that aren't JSON are
ignored (agents that log to stdout).

`src/session.ts` (`AgentSession`) owns one conversation:

- For the Model API agent (`PREPARED_AGENT`), `prepare()` starts the agent and opens a session
  before the question: on start (active mode), after a new chat, and after the agent in use or its
  setup changed (`unprepare()` first closes a prepared session that wasn't asked anything). The
  question then reuses it, waiting for a prepare still in progress. A prepare fails quietly (the
  question reports the problem) and gives up when a new or saved chat overtakes it. A session
  closed without being asked anything is `discarded`: the plugin removes its
  `model-api/<session id>/` folder (also after Test). Since a reload or crash can skip `stop`,
  start (active mode) also removes `model-api/` chats whose `main.jsonl` has no `pi.user` entry
  (`sweepUnusedSessions`): never asked anything, so nothing could reopen them. Other agents aren't prepared: they'd keep a
  process running and might record an empty session for a gain of a fraction of a second.
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
  it has; follow-ups reuse the session. Every question starts with when it was sent (`sentAt`:
  "(Sent Friday, November 27, 2026 at 2:03 PM, Europe/Budapest.)"), since a chat can be picked up
  again days later.
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
(`Chat.transcript`: questions and answers with when they were written, newest kept within 8,000
characters, no tool output),
with a note in the chat. Deleting a chat removes only ToolBelt's copy; agents may keep their own
session records.

## Settings and switching

`src/settings.ts` keeps every agent's setup: `active` (a built-in id or `custom:<id>`), `custom`
(`id`, `name`, `command`, `vars`), `vars` (environment variables of built-in agents that take
them, by id: `key`, `value`, `selected`, `secret`), `modelApi` (the Model API agent's settings, as
strings, "" for the default) and `tested` (each agent's last start from the settings: `ok`,
`at`, `text`). A secret variable's value is in the Keychain, not here. The agent in use is always one that worked: `use` first starts the agent as it's
set up (a custom agent's draft) in a separate `AgentSession` whose `check()` opens a session
without prompting, then saves the draft, makes it active and closes the conversation's agent so
the next question starts the new one. If the start fails, nothing is saved and the active agent
stays. `test` does the same start without switching. Starting from the settings never touches the
conversation's own agent process.

Edits to a custom agent, a built-in agent's variables or the Model API settings go to an
in-memory draft (`drafts`) until `save`, `use` or `discard`, except a secret value, which Toolbelt
writes to the Keychain as it's typed (discarding the draft doesn't undo that); the
list says "Unsaved changes" meanwhile. A draft's failed start isn't remembered as the saved
setup's result. New custom agents exist only as drafts until saved. The agent in use can't be
deleted.

## Data

The stable plugin id is `agent`. Data schema 1: `settings.json` in the data folder, written
atomically: `active`, `custom`, `vars`, `modelApi`, `tested`, `keep` and `recent`, plus for older
versions `env` (Claude Code's variables as `NAME=value` lines), each custom agent's `env` lines
(both without secret variables) and the first version's `agent`, `customName`, `customCommand` and
`customEnv` mirrored from the agent in use. Saved `vars` win over lines; an older version's lines
load as variables, names that look secret (KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH) marked
secret. On start (active mode) `toKeychain` moves any such variable that still has a value here
into the Keychain, once, and says so in the chat and a toast; a value it couldn't move stays and is
tried again next start. The first version's file loads as one active agent (a custom one becomes
`custom:1`). Unknown agents, malformed ids and results for missing agents are dropped.
`threads/` holds saved chats (above); `workspace/` is the agents' working folder; `model-api/`
holds the Model API agent's chats. `modelApi.keepLoaded` (`"on"` or `""`) was added within schema 1;
older versions ignore it. Keychain items (Toolbelt's, per plugin): `model-api/key` and
`agents/<id>/env/<NAME>`; removing the plugin with its data deletes them.

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
