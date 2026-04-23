# Folder-based markdown agents (`<id>/agent.md`)

## Locked decisions

| Topic | Choice |
|--------|--------|
| Top-level `*.md` | **Removed** — folder layout only (**breaking**). Startup lists orphan files and tells you to use `<stem>/agent.md`. |
| Entry file | **`agent.md` only** — no `index.md` alias in v1. |
| Subdir without entry | **Throw** — every directory under `config/agents` (except reserved names) must contain `agent.md`. |
| `skills/` at repo root under `agents/` | **Ignored** — reserved for future per-agent skills; not loaded as an agent package in v1. |
| `agents:` frontmatter | Unchanged — array of **agent ids** (folder names). |

## Goal

Support one **directory per agent** with a fixed entry file (`agent.md`), so each agent can later grow **skills** and other assets without flattening everything into one markdown file.

## Loader behavior (`loadAgentsFromDir`)

1. `readdirSync(dir, { withFileTypes: true })`.
2. **Reject** any top-level `*.md` with an error that suggests `mv X.md X/agent.md`-style migration.
3. For each subdirectory whose name is not reserved (`skills`), require `<id>/agent.md`; register agent **`id`** from that file.
4. Two-pass resolution for `agents:` references (unchanged semantics).
5. **`default: true`** — deterministic: sort agent ids, first `default: true` wins.

Single-file **`loadAgentFromFile`** keeps rejecting non-empty `agents:`. Paths ending in `/agent.md` derive the logical agent id from the **parent directory name** (see `agentIdFromMarkdownPath`).

## Acceptance criteria

- Loading `config/agents` with only `assistant/agent.md` yields `defs.assistant`.
- Flat `assistant.md` alone does **not** register — covered by loader tests and docs.
- Reference apps use `<id>/agent.md` under `config/agents`.

## Git stack

Loader + unit tests belong on **`agent/v2/4-agents-plugin`**. Docs and app migrations typically land on **`agent/v2/6-apps-docs`** after rebasing onto the updated stack; **`git push --force-with-lease`** stacked branches **4 → 5 → 6** when coordinating PRs.
