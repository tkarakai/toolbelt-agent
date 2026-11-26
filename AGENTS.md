# toolbelt-agent — notes for coding agents

Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md). Read
[docs/releases.md](docs/releases.md) before any version, tag or publication work. Keep these
documents accurate when behavior or contracts change; write maintenance references, not diaries.

## Workflow

- Never use the no-mistakes tool, plugin, skill or pipeline. Work directly.
- One agent per checkout. Stop and ask if unexpected edits appear.
- Never commit directly to `main`; use a branch and a PR and let CI pass. The user owns merges;
  merging a validated release PR authorizes its CI publication. Do not enable auto-merge unasked.
- Add user-visible changes to `## Unreleased` in `CHANGELOG.md`. Feature PRs do not bump
  versions; use a release PR.
- Pin workflow actions to full SHAs and keep permissions minimal. Allowed actions are
  GitHub-owned actions, `oven-sh/setup-bun` and `zizmorcore/zizmor-action`.

## Implementation and validation

- Use Bun commands, not node/npm/yarn/pnpm or other test runners. CI uses Bun 1.4.4.
- Depend on the pinned public SDK package. Do not copy SDK source or import a host checkout.
  New UI needs are host/SDK contracts: add them in the Toolbelt repo, wait for the SDK release,
  then pin it here with a matching `requires.host`.
- Keep `src/acp.ts` (the ACP client) and `src/chat.ts` (the conversation model) free of UI, and
  `src/ui.ts` pure. Agents are started only through `src/agents.ts`.
- The agent never gets file-system or terminal access through ACP, runs in an empty folder in the
  plugin's data, and only ToolBelt's MCP server is offered to it. Keep it that way: permission
  requests for anything else are refused.
- Never download code at runtime. Bundled adapters are pinned dependencies built into the archive.
- Keep the plugin id, the data schema and settings keys stable. Schema changes need a migration.
- Run `bun run typecheck`, `bun test`, `bun run package` and `bun scripts/verify-package.ts`.
  Check the UI in ToolBelt's plugin development mode with a disposable profile. Live agent tests
  use the person's own login: keep them short and ask first.

Follow the [release procedure](docs/releases.md). Local builds create files only. Published bytes
are immutable; corrections require a new version.
