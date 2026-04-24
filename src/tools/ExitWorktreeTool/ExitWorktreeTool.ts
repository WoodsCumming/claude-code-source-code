import { z } from 'zod/v4'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { count } from '../../utils/array.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  killTmuxSession,
} from '../../utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['keep', 'remove'])
      .describe(
        '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
      ),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['keep', 'remove']),
    originalCwd: z.string(),
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    tmuxSessionName: z.string().optional(),
    discardedFiles: z.number().optional(),
    discardedCommits: z.number().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ChangeSummary = {
  changedFiles: number
  commits: number
}

/**
 * Returns null when state cannot be reliably determined — callers that use
 * this as a safety gate must treat null as "unknown, assume unsafe"
 * (fail-closed). A silent 0/0 would let cleanupWorktree destroy real work.
 *
 * Null is returned when:
 * - git status or rev-list exit non-zero (lock file, corrupt index, bad ref)
 * - originalHeadCommit is undefined but git status succeeded — this is the
 *   hook-based-worktree-wrapping-git case (worktree.ts:525-532 doesn't set
 *   originalHeadCommit). We can see the working tree is git, but cannot count
 *   commits without a baseline, so we cannot prove the branch is clean.
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) {
    return null
  }
  const changedFiles = count(status.stdout.split('\n'), l => l.trim() !== '')

  if (!originalHeadCommit) {
    // git status succeeded → this is a git repo, but without a baseline
    // commit we cannot count commits. Fail-closed rather than claim 0.
    return null
  }

  const revList = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `${originalHeadCommit}..HEAD`,
  ])
  if (revList.code !== 0) {
    return null
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0

  return { changedFiles, commits }
}

/**
 * Restore session state to reflect the original directory.
 * This is the inverse of the session-level mutations in EnterWorktreeTool.call().
 *
 * keepWorktree()/cleanupWorktree() handle process.chdir and currentWorktreeSession;
 * this handles everything above the worktree utility layer.
 */
function restoreSessionToOriginalCwd(
  originalCwd: string,
  projectRootIsWorktree: boolean,
): void {
  setCwd(originalCwd)
  // EnterWorktree sets originalCwd to the *worktree* path (intentional — see
  // state.ts getProjectRoot comment). Reset to the real original.
  setOriginalCwd(originalCwd)
  // --worktree startup sets projectRoot to the worktree; mid-session
  // EnterWorktreeTool does not. Only restore when it was actually changed —
  // otherwise we'd move projectRoot to wherever the user had cd'd before
  // entering the worktree (session.originalCwd), breaking the "stable project
  // identity" contract.
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    // setup.ts's --worktree block called updateHooksConfigSnapshot() to re-read
    // hooks from the worktree. Restore symmetrically. (Mid-session
    // EnterWorktreeTool never touched the snapshot, so no-op there.)
    updateHooksConfigSnapshot()
  }
  saveWorktreeState(null)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
}

export const ExitWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: 'exit a worktree session and return to the original directory',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Exits a worktree session created by EnterWorktree and restores the original working directory'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Exiting worktree'
  },
  shouldDefer: true,
  isDestructive(input) {
    return input.action === 'remove'
  },
  toAutoClassifierInput(input) {
    return input.action
  },
  async validateInput(input) {
    // Scope guard: getCurrentWorktreeSession() is null unless EnterWorktree
    // (specifically createWorktreeForSession) ran in THIS session. Worktrees
    // created by `git worktree add`, or by EnterWorktree in a previous
    // session, do not populate it. This is the sole entry gate — everything
    // past this point operates on a path EnterWorktree created.
    // ! 1. 检查是否在 EnterWorktree 创建的会话中（手动创建的 worktree 不会被删除）
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        result: false,
        message:
          'No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.',
        errorCode: 1,
      }
    }


    if (input.action === 'remove' && !input.discard_changes) {
      /**
       * ! 2. countWorktreeChanges(worktreePath, originalHeadCommit)
            ├── git status --porcelain → 统计未提交文件数
            ├── git rev-list --count <originalHead>..HEAD → 统计新提交数
            └── 返回 null（git 失败时）→ fail-closed（拒绝删除）
       */
      const summary = await countWorktreeChanges(
        session.worktreePath,
        session.originalHeadCommit,
      )
      /**
        fail-closed 设计
        countWorktreeChanges() 在以下情况返回 null（“未知，假设不安全”）：
        git status 或 git rev-list 退出非零（锁文件、损坏的索引）
        originalHeadCommit 未定义（hook-based worktree 没有设置基线 commit）
        返回 null 时，validateInput 拒绝删除——宁可让用户手动处理，也不冒险丢失工作。
       */
      if (summary === null) {
        return {
          result: false,
          message: `Could not verify worktree state at ${session.worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
          errorCode: 3,
        }
      }

      // ! 3. 有未提交文件或新提交？→ 拒绝，要求 discard_changes: true 确认
      const { changedFiles, commits } = summary
      if (changedFiles > 0 || commits > 0) {
        const parts: string[] = []
        if (changedFiles > 0) {
          parts.push(
            `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
          )
        }
        if (commits > 0) {
          parts.push(
            `${commits} ${commits === 1 ? 'commit' : 'commits'} on ${session.worktreeBranch ?? 'the worktree branch'}`,
          )
        }
        return {
          result: false,
          message: `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      // validateInput guards this, but the session is module-level mutable
      // state — defend against a race between validation and execution.
      throw new Error('Not in a worktree session')
    }

    // Capture before keepWorktree/cleanupWorktree null out currentWorktreeSession.
    const {
      originalCwd,
      worktreePath,
      worktreeBranch,
      tmuxSessionName,
      originalHeadCommit,
    } = session

    // --worktree startup calls setOriginalCwd(getCwd()) and
    // setProjectRoot(getCwd()) back-to-back right after setCwd(worktreePath)
    // (setup.ts:235/239), so both hold the same realpath'd value and BashTool
    // cd never touches either. Mid-session EnterWorktreeTool sets originalCwd
    // but NOT projectRoot. (Can't use getCwd() — BashTool mutates it on every
    // cd. Can't use session.worktreePath — it's join()'d, not realpath'd.)
    const projectRootIsWorktree = getProjectRoot() === getOriginalCwd()

    // Re-count at execution time for accurate analytics and output — the
    // worktree state at validateInput time may not match now. Null (git
    // failure) falls back to 0/0; safety gating already happened in
    // validateInput, so this only affects analytics + messaging.
    // ! 1. 重新计数变更（validateInput 和 call 之间可能有新修改）
    const { changedFiles, commits } = (await countWorktreeChanges(
      worktreePath,
      originalHeadCommit,
    )) ?? { changedFiles: 0, commits: 0 }

    if (input.action === 'keep') {
      /**
       * 1. chdir 回 originalCwd
         2. 清空 currentWorktreeSession
         3. 更新项目配置（activeWorktreeSession = undefined）
         4. worktree 目录和分支保留在磁盘上
       */
      await keepWorktree()
      restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

      logEvent('tengu_worktree_kept', {
        mid_session: true,
        commits,
        changed_files: changedFiles,
      })

      const tmuxNote = tmuxSessionName
        ? ` Tmux session ${tmuxSessionName} is still running; reattach with: tmux attach -t ${tmuxSessionName}`
        : ''
      return {
        data: {
          action: 'keep' as const,
          originalCwd,
          worktreePath,
          worktreeBranch,
          tmuxSessionName,
          message: `Exited worktree. Your work is preserved at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ''}. Session is now back in ${originalCwd}.${tmuxNote}`,
        },
      }
    }

    // action === 'remove'
    // ! 2. 如果有 tmux session → killTmuxSession()
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName)
    }
    /**
     * 3. cleanupWorktree()
          ├── hook-based → 执行 WorktreeRemove hook
          └── git-based → git worktree remove --force + git branch -D
     */
    await cleanupWorktree()
    /**
     * 4. restoreSessionToOriginalCwd()
          - setCwd(originalCwd)
          - setOriginalCwd(originalCwd)
          - 如果 projectRoot 是 worktree 时才恢复（防误触）
          - 更新 hooks config snapshot
          - 清空系统提示和 memory 缓存
     */
    restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

    logEvent('tengu_worktree_removed', {
      mid_session: true,
      commits,
      changed_files: changedFiles,
    })

    const discardParts: string[] = []
    if (commits > 0) {
      discardParts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
      )
    }
    const discardNote =
      discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : ''
    return {
      data: {
        action: 'remove' as const,
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changedFiles,
        discardedCommits: commits,
        message: `Exited and removed worktree at ${worktreePath}.${discardNote} Session is now back in ${originalCwd}.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
