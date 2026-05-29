## 1. OpenSpec Configuration

- [x] 1.1 Create `openspec/config.yaml` with `spec-driven` schema declaration

## 2. Command Files

- [x] 2.1 Create `.claude/commands/opsx/propose.md` — `/opsx:propose` command (scaffold change + generate all artifacts)
- [x] 2.2 Create `.claude/commands/opsx/apply.md` — `/opsx:apply` command (implement tasks from a change)
- [x] 2.3 Create `.claude/commands/opsx/explore.md` — `/opsx:explore` command (thinking-only mode, no implementation)
- [x] 2.4 Create `.claude/commands/opsx/archive.md` — `/opsx:archive` command (archive completed changes)

## 3. Skill Files

- [x] 3.1 Create `.claude/skills/openspec-propose/SKILL.md` — step-by-step logic for the propose workflow
- [x] 3.2 Create `.claude/skills/openspec-apply-change/SKILL.md` — step-by-step logic for the apply workflow
- [x] 3.3 Create `.claude/skills/openspec-explore/SKILL.md` — explore mode stance and constraints
- [x] 3.4 Create `.claude/skills/openspec-archive-change/SKILL.md` — archive workflow steps

## 4. Verification

- [x] 4.1 Confirm all 4 commands appear in Claude Code's command list
- [x] 4.2 Confirm all 4 skills are loadable via the `Skill` tool
- [x] 4.3 Run `/opsx:propose` on a test description and verify artifact generation end-to-end
