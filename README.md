# Toolbelt Agent

Ask an AI agent about your tools from inside [Toolbelt](https://github.com/tkarakai/toolbelt): a
floating ask bar that grows into a chat over whatever screen you're on. The agent reads your
Toolbelt screens through Toolbelt's own MCP server and, when you allow it, shows you what it found.

It's a *floating plugin*: it has no screen of its own, only a window you move, resize and
minimize into its item at the bottom of Toolbelt's sidebar. The window doesn't block the screen
behind it, so you keep working while you talk to the agent.

## Use

1. In Toolbelt's plugin manager, enter `tkarakai/toolbelt-agent`, review the release and publisher,
   and approve execution. Plugin code runs with your user privileges; process isolation is not a
   security sandbox. Requires Toolbelt 0.7.1 or later.
2. Turn on **Settings → Agents → Let agents use ToolBelt**, and choose there which plugins agents
   may read.
3. Press **⌘K** (or click **Agent** at the bottom of the sidebar). The first time, the window opens
   on its list of agents: pick one and **Use** it. It runs on your Mac with your own login:

   | Agent | Install its ACP mode | Log in |
   | --- | --- | --- |
   | Claude Code | `npm install -g @agentclientprotocol/claude-agent-acp` | run `claude` once and log in |
   | Codex | `npm install -g @agentclientprotocol/codex-acp` | `codex login` |
   | Gemini CLI | `npm install -g @google/gemini-cli` (ACP mode is `gemini --acp`) | run `gemini` once |
   | Another ACP agent | its own instructions | — |

   Each agent keeps its own setup, so you can switch between them from the gear button. Toolbelt
   switches only once the new agent has started; if it doesn't, you keep the one you had. **Test**
   starts an agent and connects it to Toolbelt without asking anything. Claude Code's setup takes
   environment lines, to use a local model (such as oMLX) instead of your login. Other agents and local
   models (add as many custom ACP agents as you like):
   [docs/other-agents.md](docs/other-agents.md); [docs/local-models.md](docs/local-models.md) covers
   local models: setups, server settings and what to expect.
4. Ask. The bar grows into a chat. The agent reads screens on its own; the first time it wants to
   change what you see (say, filter OnTrack to overdue tasks), Toolbelt asks you, and its "Shown by"
   note offers Restore.

In the window: **↵** asks, **esc** minimizes it into the sidebar, the title bar's buttons start a
new chat, open your saved chats, fold it back into the ask bar, stop an answer and open the
settings. Chats are saved on this Mac (for 30 days since last used, unless you choose otherwise or
pin them); open one to continue it, or pick a recent one under **Continue** in the ask bar. Click its sidebar
item or press ⌘K to bring it back where it was; when it's in front, the same minimizes it. The
item spins while the agent works and shows a dot when it answers while minimized.

## What the agent can do

Only what Toolbelt's agent interface allows: read the screens of the plugins you let agents read,
search them, and show you a screen once you approve. It runs in an empty folder, gets no file or
terminal access from the chat, and any request to use another tool is refused (the chat says so).
For Claude Code, the session also starts without Claude Code's own tools, settings and MCP servers.

## Develop

See [AGENTS.md](AGENTS.md), [docs/architecture.md](docs/architecture.md) and
[docs/releases.md](docs/releases.md). Run `bun install --frozen-lockfile`, `bun run typecheck`,
`bun test`, `bun run package` and `bun scripts/verify-package.ts`, and try archives in Toolbelt's
plugin development mode.
