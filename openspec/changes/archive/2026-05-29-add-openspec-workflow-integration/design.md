## Context

Claude Code supports custom commands (`.claude/commands/`) and skills (`.claude/skills/`) that extend its behavior. This project already uses this pattern for other tooling. OpenSpec is an external CLI tool that manages spec-driven development artifacts; its `openspec` CLI is available in the environment.

The integration is purely additive: no existing files are modified, no production TypeScript source is touched.

## Goals / Non-Goals

**Goals:**
- Register four `/opsx:` commands that Claude Code can invoke
- Back each command with a corresponding skill that provides detailed behavior instructions
- Configure OpenSpec with the `spec-driven` schema appropriate for this project

**Non-Goals:**
- Modifying any TypeScript source in `src/`
- Defining OpenSpec schemas (those are managed by the `openspec` CLI itself)
- Automating or CI-gating the workflow

## Decisions

### 1. Commands as thin wrappers, skills as the behavior layer

Each `.claude/commands/opsx/<name>.md` file contains a short frontmatter + description. All actual step-by-step logic lives in the corresponding skill file. This keeps commands readable and skills independently updatable.

**Alternative considered**: Inline all logic in the command file. Rejected — skill files are reusable across different command surfaces and can be versioned independently.

### 2. One skill per command (1-to-1 mapping)

Skills are named `openspec-<verb>` (e.g., `openspec-propose`, `openspec-apply-change`) to match their functional role. The slight naming divergence (`opsx:propose` → `openspec-propose`) is intentional: skill names are implementation-internal identifiers while command names are user-facing.

### 3. `spec-driven` schema selection

OpenSpec's `spec-driven` schema fits this project: changes flow through proposal → design → specs → tasks, which maps well to the exploratory/research-then-implement rhythm of working on decompiled source.

## Risks / Trade-offs

- **`openspec` CLI availability** → Not pinned to a version; if the CLI is absent, commands fail. Mitigation: document dependency in README.
- **Skill content drift** → Skills are static files; if OpenSpec's workflow changes, skills must be manually updated. Mitigation: treat skill files as living docs and update them alongside `openspec` CLI upgrades.

## Open Questions

_(none — scope is fully bounded to file additions)_
