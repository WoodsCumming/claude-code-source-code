## Why

This project lacks a structured, spec-driven workflow for proposing and implementing changes. Adding the OpenSpec tooling provides a formal artifact pipeline (proposal → design → specs → tasks) that brings discipline and traceability to development work done in this codebase.

## What Changes

- **New**: `openspec/config.yaml` — project-level OpenSpec configuration with `spec-driven` schema
- **New**: `.claude/commands/opsx/propose.md` — `/opsx:propose` command for scaffolding change proposals and generating all artifacts in one step
- **New**: `.claude/commands/opsx/apply.md` — `/opsx:apply` command for implementing tasks from a completed change
- **New**: `.claude/commands/opsx/explore.md` — `/opsx:explore` command for freeform ideation and investigation without implementation
- **New**: `.claude/commands/opsx/archive.md` — `/opsx:archive` command for archiving completed changes
- **New**: `.claude/skills/openspec-propose/SKILL.md` — skill backing `/opsx:propose`
- **New**: `.claude/skills/openspec-apply-change/SKILL.md` — skill backing `/opsx:apply`
- **New**: `.claude/skills/openspec-explore/SKILL.md` — skill backing `/opsx:explore`
- **New**: `.claude/skills/openspec-archive-change/SKILL.md` — skill backing `/opsx:archive`

## Capabilities

### New Capabilities

- `opsx-workflow`: Full `/opsx:` command suite enabling spec-driven development — propose, explore, apply, and archive changes through a structured artifact pipeline

### Modified Capabilities

_(none — no existing requirements change)_

## Impact

- No production code changes; affects only the AI workflow tooling layer (`.claude/` and `openspec/`)
- Requires the `openspec` CLI to be available in the environment
- All four commands follow the same skill-backed pattern already used by other Claude Code commands in this project
