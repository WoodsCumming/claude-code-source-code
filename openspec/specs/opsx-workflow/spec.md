# opsx-workflow Specification

## Requirements

### Requirement: Propose command available
Claude Code SHALL expose a `/opsx:propose` command that, when invoked, creates a new OpenSpec change directory and generates all required artifacts (proposal, design, specs, tasks) in dependency order before stopping.

#### Scenario: Propose with description
- **WHEN** a user runs `/opsx:propose <description>`
- **THEN** Claude Code creates a kebab-case change name from the description, scaffolds it via `openspec new change`, and generates all `applyRequires` artifacts

#### Scenario: Propose with no input
- **WHEN** a user runs `/opsx:propose` with no arguments
- **THEN** Claude Code asks the user what they want to build before proceeding

### Requirement: Apply command available
Claude Code SHALL expose a `/opsx:apply` command that reads a completed change's `tasks.md` and implements the tasks in sequence.

#### Scenario: Apply named change
- **WHEN** a user runs `/opsx:apply <change-name>`
- **THEN** Claude Code locates the change at `openspec/changes/<change-name>/` and begins implementing its tasks

#### Scenario: Apply with ambiguous context
- **WHEN** a user runs `/opsx:apply` with no argument and multiple active changes exist
- **THEN** Claude Code lists available changes and prompts the user to select one

### Requirement: Explore command available
Claude Code SHALL expose a `/opsx:explore` command that enters a thinking-only mode where implementation actions are prohibited.

#### Scenario: Explore blocks implementation
- **WHEN** a user is in explore mode and requests code implementation
- **THEN** Claude Code declines to write code and reminds the user to exit explore mode first

### Requirement: Archive command available
Claude Code SHALL expose a `/opsx:archive` command that marks a completed change as archived.

#### Scenario: Archive named change
- **WHEN** a user runs `/opsx:archive <change-name>`
- **THEN** Claude Code invokes the archive skill, which calls `openspec archive <change-name>` and confirms the result
