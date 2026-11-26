# Changelog

## Unreleased
- First version: ask an AI agent about your tools from a floating ask bar (⌘K) that grows into a chat over whatever Toolbelt screen you're on, and minimizes into its item at the bottom of the sidebar. The agent reads your screens through Toolbelt's MCP server and, once you allow it, shows you what it found.
- Works with Claude Code, Codex and Gemini CLI through their ACP modes, or any other ACP agent, with your own installation and login. The settings live in the window: choose the agent, see whether it's installed (and how to install it), and test the connection.
- The agent gets only Toolbelt: it runs in an empty folder without file or terminal access from the chat, and any other tool it asks for is refused. Claude Code also starts without its own tools, settings and MCP servers.
- Requires Toolbelt 0.7.0 (SDK 0.5.0).
