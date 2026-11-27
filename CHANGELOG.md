# Changelog

## Unreleased
- Requires Toolbelt 0.8.0 (SDK 0.6.0), for secrets kept in your Mac's Keychain and collapsible cards.
- **Model API: ToolBelt's own agent, for a model of your choice.** The first entry in the agents list talks to any model server: on this Mac (oMLX, llama.cpp, Ollama, LM Studio) or hosted (OpenRouter, OpenAI, Anthropic, Gemini). Choose the server and a model from its list, and thinking; its API key is kept in your Mac's Keychain. It says where chats go ("Stays on this Mac" or "Sends chats to …") and only ever connects to that address. On a 27B model on oMLX it answers in about 10 s, twice as fast as Claude Code on the same model.
- **Test checks the model, too.** For Model API, Test asks the model one small question with a tool and says how long it took and whether the model called the tool. If something's wrong, "Before you start" opens at what to check on the server.
- **Secrets in the Keychain.** Claude Code's and custom agents' environment is now a list of variables. Ones whose names look secret (`ANTHROPIC_AUTH_TOKEN`, …) are locked: Toolbelt keeps their values in your Mac's Keychain, not in the plugin's settings. Tokens saved as plain text before are moved into the Keychain once, and the chat says so.

## 0.3.0 — 2026-11-27
- Claude Code no longer runs in your own Claude Code permission mode. If yours was Auto, a Claude Code using another endpoint (such as a local model) had every Toolbelt tool refused; now it asks the plugin, which allows Toolbelt's tools and nothing else, whatever your mode.
- **Claude Code with another model.** Claude Code's setup has an Environment field (`NAME=value` lines), so it can use a local model server such as oMLX, or another Anthropic-compatible endpoint, instead of your Claude login. It still starts without its own tools, settings and MCP servers, which keeps the prompt short for a local model. [Local models](docs/local-models.md) has the lines for a setup that stays on your Mac, server settings and measured results.

## 0.2.0 — 2026-11-27
- Requires Toolbelt 0.7.1 (SDK 0.5.1): its floating windows scroll long settings and lists, and its ask bar shows the Continue and Try asking headings.
- **Chats are saved, and you can pick them up again.** The clock button opens your chats, grouped by when you last used them, with search, Rename, Pin and Delete. Opening one continues it: Claude Code reopens its own session, so it remembers everything. An agent that can't do that (or a different agent than the chat was with) starts a new session that's given a summary of the conversation, and the chat says so.
- **Continue from the ask bar.** ⌘K shows your three most recent chats under Continue, above the questions to try. Turn them off in the agents settings (say, while you share your screen).
- Chats are kept for 30 days since you last used them by default. Choose 90 days, until you delete them, or not at all. Pinned chats stay until you delete them, and Delete all clears everything. Chats stay on this Mac, in the plugin's data folder.
- **Agents keep their own setup.** The settings list Claude Code, Codex, Gemini CLI and your own ACP agents (add as many as you like), each with whether it's installed and when it last worked, so switching back to one is a click. ToolBelt switches only once the new agent has started: if it doesn't start, you keep talking to the one you had.
- Editing a custom agent changes a draft until you save it. Saving the agent in use starts it with the changes first, and keeps the saved setup if that fails. Unsaved changes stay until you save or discard them, and custom agents can be deleted.
- Testing an agent starts a separate copy of it, so a chat in progress isn't interrupted.

## 0.1.0 — 2026-11-26
- First version: ask an AI agent about your tools from a floating ask bar (⌘K) that grows into a chat over whatever Toolbelt screen you're on, and minimizes into its item at the bottom of the sidebar. The agent reads your screens through Toolbelt's MCP server and, once you allow it, shows you what it found.
- Works with Claude Code, Codex and Gemini CLI through their ACP modes, or any other ACP agent, with your own installation and login. The settings live in the window: choose the agent, see whether it's installed (and how to install it), and test the connection.
- The agent gets only Toolbelt: it runs in an empty folder without file or terminal access from the chat, and any other tool it asks for is refused. Claude Code also starts without its own tools, settings and MCP servers.
- Requires Toolbelt 0.7.0 (SDK 0.5.0).
