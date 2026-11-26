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

- **Settings** (`mode: "panel"`, subtitle Settings) when no agent is chosen yet or the gear was
  pressed: a form (`settings`: `agent`, and for a custom agent `customName`, `customCommand`,
  `customEnv`), where the chosen agent was found or how to install it, a Connection card whose
  `test` action runs `AgentSession.check()`, and what the agent can see. Done is `done`.
- **Ask bar** (`mode: "bar"`) while the chat is empty or folded back (`collapsed`): suggestions
  (`suggest:*`, sent as questions), the composer (`ask`), and when folded back the last answer's
  first line and `expand`.
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
plus `NAME=value` environment lines. Commands are looked up in the person's login-shell PATH
(read once, by asking `$SHELL -ilc` to print it, 5 s limit) followed by the usual install folders
(`~/.local/bin`, `~/.bun/bin`, Homebrew, `/usr/local/bin`, …), because Toolbelt starts plugins with
the app's minimal PATH. Agents run with that PATH and only `HOME`, `USER`, `LANG`, `LC_ALL`,
`TMPDIR`, `SHELL` from the plugin's environment, plus a custom agent's own variables.

Nothing is bundled or downloaded: each agent is the person's own installation and login. (Claude
Code's adapter depends on the Claude Agent SDK, whose license doesn't allow redistributing it in
this archive, and on Claude Code's native binary, larger than Toolbelt's archive limits.)

## ACP client and session

`src/acp.ts` is a minimal ACP v1 client over the agent's stdio: `initialize` (client capabilities:
no file system, no terminal), `session/new`, `session/prompt`, `session/cancel`, `session/update`
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
  `allowDangerouslySkipPermissions: false`.
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

## Data

The stable plugin id is `agent`. Data schema 1: `settings.json` in the data folder (`agent`,
`customName`, `customCommand`, `customEnv`), written atomically; unknown or missing values fall back
to the defaults. `workspace/` is the agents' working folder.

## Tests

`test/fake-agent.ts` is an in-memory ACP agent with scripted turns. Tests cover the client
(capabilities offered, refused methods, permission answers, errors, a vanishing agent), the chat
model, agent lookup and command parsing, the session (MCP server and isolation, the preamble,
refused tools, problems, stop, Test connection) and every view, validated against the SDK's tree
schema. `scripts/verify-package.ts` runs the built archive like Toolbelt does: first-run settings,
choosing an agent, the ask bar, prepare and shutdown, without starting an agent.
