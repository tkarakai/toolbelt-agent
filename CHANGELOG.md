# Changelog

## Unreleased
- **Agents keep their own setup.** The settings list Claude Code, Codex, Gemini CLI and your own ACP agents (add as many as you like), each with whether it's installed and when it last worked, so switching back to one is a click. ToolBelt switches only once the new agent has started: if it doesn't start, you keep talking to the one you had.
- Editing a custom agent changes a draft until you save it. Saving the agent in use starts it with the changes first, and keeps the saved setup if that fails. Unsaved changes stay until you save or discard them, and custom agents can be deleted.
- Testing an agent starts a separate copy of it, so a chat in progress isn't interrupted.

## 0.1.0 — 2026-11-26
- First version: ask an AI agent about your tools from a floating ask bar (⌘K) that grows into a chat over whatever Toolbelt screen you're on, and minimizes into its item at the bottom of the sidebar. The agent reads your screens through Toolbelt's MCP server and, once you allow it, shows you what it found.
- Works with Claude Code, Codex and Gemini CLI through their ACP modes, or any other ACP agent, with your own installation and login. The settings live in the window: choose the agent, see whether it's installed (and how to install it), and test the connection.
- The agent gets only Toolbelt: it runs in an empty folder without file or terminal access from the chat, and any other tool it asks for is refused. Claude Code also starts without its own tools, settings and MCP servers.
- Requires Toolbelt 0.7.0 (SDK 0.5.0).
