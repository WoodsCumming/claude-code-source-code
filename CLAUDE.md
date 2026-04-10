# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Decompiled TypeScript source of **Claude Code v2.1.88**, extracted from the `@anthropic-ai/claude-code` npm package for research and educational purposes. The original package ships a single bundled `cli.js` (~12MB); this repo contains the unbundled source.

**Commercial use is strictly prohibited.** See README.md disclaimer.

## Commands

```bash
# Type-check only (recommended verification)
npm run check           # prepare-src + tsc --noEmit

# Best-effort build (~95% complete, see caveats below)
npm run build           # prepare-src + esbuild bundle → dist/cli.js

# Run pre-built CLI
node dist/cli.js --version
node dist/cli.js -p "Hello Claude"
```

There are no tests. `npm run check` is the primary way to verify correctness.

### Build Caveats

A full rebuild requires Bun (not Node.js) for compile-time intrinsics. The esbuild build:
- Transforms `feature('X')` → `false` (dead code elimination)
- Substitutes `MACRO.VERSION` → `'2.1.88'`
- Stubs `bun:bundle` / `bun:ffi` imports
- Cannot resolve **108 feature-gated internal modules** (daemon, KAIROS, bridge, contextCollapse, etc.) — these were eliminated by Bun at Anthropic's build time and do not exist in the published source

To diagnose missing modules after a failed build:
```bash
npx esbuild build-src/entry.ts --bundle --platform=node \
  --packages=external --external:'bun:*' \
  --log-level=error --log-limit=0 --outfile=/dev/null 2>&1 | \
  grep "Could not resolve" | sort -u
```

## Architecture

### Entry & Bootstrap

```
entrypoints/cli.tsx          ← process.argv parsing, fast-paths (--version, --daemon-worker)
  └─ main.tsx (4715 lines)   ← app orchestrator: auth, config, analytics, permission context
       └─ screens/REPL.tsx   ← interactive terminal loop (React Ink TUI)
```

Bootstrap sequence: MDM settings + keychain (parallel) → auth → analytics → plugins/MCP/skills → permission context → tool registry → REPL.

### Query Loop

Every user turn flows through `services/api/claude.ts`:
1. `getSystemContext()` — composes system prompt (git status, CLAUDE.md, memory, instructions)
2. `getTools()` — filters 40+ tools by permissions and feature flags
3. Streaming API call to Claude with tools
4. Tool results returned as next user message
5. Loop until `stop_reason: "end_turn"`

### State Management

- `state/AppState.tsx` — central React state (Redux-like), owns conversation thread and settings
- `state/AppStateStore.ts` — persistent storage (sessions, settings)
- `state/store.ts` — message history and request tracking

### Tool System

40+ built-in tools in `src/tools/`. Always-available core tools:

| Tool | Purpose |
|------|---------|
| `BashTool` | Shell command execution |
| `FileReadTool`, `FileEditTool`, `FileWriteTool` | File operations |
| `GlobTool`, `GrepTool` | File search |
| `AgentTool` | Delegate to sub-agents |
| `WebFetchTool`, `WebSearchTool` | Web access |
| `SkillTool` | Execute skills (slash commands) |
| `TaskCreateTool` / `TaskGetTool` / `TaskUpdateTool` / `TaskListTool` | Task management |

Feature-gated tools (not in published source): `REPLTool`, `SleepTool`, `MonitorTool`, `WorkflowTool`, `WebBrowserTool`, `CronCreateTool`, `CronDeleteTool`, `CronListTool`, `RemoteTriggerTool`, and ~10 more.

### Key Directories

| Path | Contents |
|------|----------|
| `src/entrypoints/` | CLI entry points and SDK exports |
| `src/tools/` | All built-in tool implementations |
| `src/services/api/` | Claude API client, query orchestration, streaming |
| `src/state/` | Global app state and persistent storage |
| `src/context/` | System prompt assembly |
| `src/commands/` | 80+ CLI command implementations |
| `src/components/` | React TUI components (Ink-based, 146 files) |
| `src/screens/` | Full-screen UI modes (REPL, Doctor, ResumeConversation) |
| `src/hooks/` | 87 custom React hooks |
| `src/services/` | Analytics, MCP client, remote settings, plugin manager |
| `src/constants/` | System prompts, feature flags, OAuth config |
| `src/memdir/` | Context compaction and memory persistence |
| `src/skills/` | Built-in skills (slash commands) |
| `stubs/` | Build-time stubs for Bun intrinsics |
| `scripts/` | `build.mjs` (esbuild pipeline), `prepare-src.mjs` (source transformation) |

### Feature Flags

`feature('FLAG_NAME')` calls are Bun compile-time intrinsics. In the published source, `prepare-src.mjs` replaces all calls with `false`, dead-code-eliminating all gated branches. The 108 missing internal modules correspond to these gates (e.g., `DAEMON`, `KAIROS`, `COORDINATOR_MODE`, `BRIDGE_MODE`, `CONTEXT_COLLAPSE`).

### Permission System

- `src/utils/permissions/` — tool whitelisting/blacklisting, auto mode verification
- Permission modes: `auto` (all tools allowed), `bypass` (skip checks), custom (whitelist/blacklist)
- `src/utils/permissions/PermissionMode.ts` — mode definitions

### Production Harness Features

The codebase layers 12 mechanisms on top of the core agent loop: telemetry (two sinks: Anthropic + Datadog), background task execution, hourly remote settings polling (`/api/claude_code/settings`), prompt caching (1-hour scope), context compaction, permission system, undercover mode (strips AI attribution in public repos for Anthropic employees), GrowthBook feature flags/killswitches, model routing (Opus/Sonnet/fast), effort/token budgets, fast mode, and plan mode.

## Analysis Reports

`docs/` contains quadrilingual (EN/JA/KO/ZH) deep-dive reports on telemetry, hidden features/codenames (Capybara, Tengu, Numbat), undercover mode, remote control/killswitches, and future roadmap (KAIROS autonomous mode, voice mode, unreleased tools).
