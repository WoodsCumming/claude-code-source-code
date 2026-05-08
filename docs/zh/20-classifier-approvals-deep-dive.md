# classifierApprovals.ts 深度解析：分类器审批结果的跨层传递总线

> 基于 Claude Code v2.1.88 源码，含函数级代码注释与完整数据流

---

## 1. 模块定位

`src/utils/classifierApprovals.ts` 是一个**模块级全局状态存储**，负责在权限决策层（`permissions.ts`、`useCanUseTool.tsx`）和 UI 渲染层（`UserToolSuccessMessage.tsx`）之间传递分类器审批结果。

它解决的核心问题：**分类器在权限检查阶段做出决定，但 UI 在工具执行完成后才渲染——两者在时间和调用栈上完全分离，需要一个中间存储来桥接。**

```
权限检查层（异步）                        UI 渲染层（React）
─────────────────────────                ─────────────────────────
classifyYoloAction()                      UserToolSuccessMessage
  └── shouldBlock=false                     └── useState(() => getYoloClassifierApproval(toolUseID))
      └── setYoloClassifierApproval()            └── 首次渲染时读取审批结果
                                                 └── useEffect → deleteClassifierApproval()
                                                     （读取后立即删除，防 Map 无限增长）

中间存储（本模块）：
  CLASSIFIER_APPROVALS: Map<toolUseID, { classifier, matchedRule/reason }>
  CLASSIFIER_CHECKING:  Set<toolUseID>
```

---

## 2. 数据结构

**文件**：`src/utils/classifierApprovals.ts:9`

```typescript
// 审批结果记录：区分两种分类器
type ClassifierApproval = {
  classifier: 'bash' | 'auto-mode'  // bash = Bash 提示词分类器；auto-mode = YOLO 分类器
  matchedRule?: string               // bash 分类器：匹配到的规则描述文本
  reason?: string                    // auto-mode 分类器：审批原因
}

// 全局 Map：toolUseID → 审批结果
// 键是工具调用的唯一 ID，值在 UI 渲染时读取后立即删除
const CLASSIFIER_APPROVALS = new Map<string, ClassifierApproval>()

// 正在检查中的工具调用 ID 集合
// 用于驱动 UI 上的"正在分类..."指示器
const CLASSIFIER_CHECKING = new Set<string>()

// 信号对象：CLASSIFIER_CHECKING 变化时广播给 React 订阅者
const classifierChecking = createSignal()
```

---

## 3. 函数详解

### 3.1 Bash 分类器审批结果（BASH_CLASSIFIER feature）

```typescript
/**
 * 记录 Bash 提示词分类器的 allow 审批结果。
 * 由 useCanUseTool.tsx:141 和 PermissionContext.ts:199 在分类器
 * 高置信度匹配 allow 规则时调用。
 *
 * feature guard: BASH_CLASSIFIER（ANT-ONLY，外部构建直接返回）
 *
 * @param toolUseID   - 工具调用的唯一 ID
 * @param matchedRule - 匹配到的规则描述文本，如 "run npm commands"
 *                      后续用于在 UI 显示：✓ Auto-approved · matched "run npm commands"
 */
export function setClassifierApproval(toolUseID: string, matchedRule: string): void {
  if (!feature('BASH_CLASSIFIER')) return
  CLASSIFIER_APPROVALS.set(toolUseID, { classifier: 'bash', matchedRule })
}

/**
 * 读取 Bash 分类器的审批结果（matchedRule）。
 * 由 UserToolSuccessMessage.tsx 的 useState 懒初始化器调用——
 * 组件首次渲染时读取一次，结果存入 React state 持久化，
 * 防止后续重渲染时 Map 已清空导致数据丢失。
 *
 * @returns matchedRule 字符串，或 undefined（无审批记录 / 分类器不匹配 'bash'）
 */
export function getClassifierApproval(toolUseID: string): string | undefined {
  if (!feature('BASH_CLASSIFIER')) return undefined
  const approval = CLASSIFIER_APPROVALS.get(toolUseID)
  if (!approval || approval.classifier !== 'bash') return undefined
  return approval.matchedRule
}
```

### 3.2 YOLO 分类器审批结果（TRANSCRIPT_CLASSIFIER feature）

```typescript
/**
 * 记录 YOLO 分类器（Auto Mode）的 allow 审批结果。
 * 由 useCanUseTool.tsx:44 在 Auto Mode 下分类器返回 shouldBlock=false 时调用。
 *
 * feature guard: TRANSCRIPT_CLASSIFIER（ANT-ONLY，外部构建直接返回）
 *
 * @param toolUseID - 工具调用的唯一 ID
 * @param reason    - 审批原因，来自 decisionReason.reason
 *                    后续用于在 UI 显示："Allowed by auto mode classifier"
 */
export function setYoloClassifierApproval(toolUseID: string, reason: string): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  CLASSIFIER_APPROVALS.set(toolUseID, { classifier: 'auto-mode', reason })
}

/**
 * 读取 YOLO 分类器的审批原因。
 * 由 UserToolSuccessMessage.tsx 的 useState 懒初始化器调用。
 *
 * @returns reason 字符串，或 undefined（无审批记录 / 分类器不匹配 'auto-mode'）
 */
export function getYoloClassifierApproval(toolUseID: string): string | undefined {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return undefined
  const approval = CLASSIFIER_APPROVALS.get(toolUseID)
  if (!approval || approval.classifier !== 'auto-mode') return undefined
  return approval.reason
}
```

### 3.3 "正在检查"状态（UI 指示器）

```typescript
/**
 * 标记某个工具调用正在等待分类器结果。
 * 由 permissions.ts:690 在调用 classifyYoloAction() 之前设置，
 * 驱动 UI 显示"正在分类..."旋转指示器。
 *
 * 同时触发 classifierChecking 信号，通知所有 React 订阅者重新渲染。
 *
 * feature guard: 至少一个分类器 feature 启用时才生效
 */
export function setClassifierChecking(toolUseID: string): void {
  if (!feature('BASH_CLASSIFIER') && !feature('TRANSCRIPT_CLASSIFIER')) return
  CLASSIFIER_CHECKING.add(toolUseID)
  classifierChecking.emit()  // 广播状态变化，触发 React 重渲染
}

/**
 * 清除"正在检查"状态。
 * 由 permissions.ts:701（finally 块）在分类器调用完成后清除，
 * 无论成功还是失败都会执行（即使分类器决定拦截）。
 *
 * 同时触发 classifierChecking 信号，通知订阅者重新渲染（隐藏指示器）。
 */
export function clearClassifierChecking(toolUseID: string): void {
  if (!feature('BASH_CLASSIFIER') && !feature('TRANSCRIPT_CLASSIFIER')) return
  CLASSIFIER_CHECKING.delete(toolUseID)
  classifierChecking.emit()
}

/**
 * 订阅"正在检查"状态变化（信号对象的 subscribe 方法）。
 * 由 classifierApprovalsHook.ts 的 useIsClassifierChecking Hook 传给
 * useSyncExternalStore，实现 React 与模块级状态的同步。
 */
export const subscribeClassifierChecking = classifierChecking.subscribe

/**
 * 查询某个工具调用是否正在等待分类器结果。
 * 由 classifierApprovalsHook.ts 的 useIsClassifierChecking Hook 在
 * useSyncExternalStore 的快照函数中调用，驱动 UI 指示器的显示/隐藏。
 */
export function isClassifierChecking(toolUseID: string): boolean {
  return CLASSIFIER_CHECKING.has(toolUseID)
}
```

### 3.4 清理函数

```typescript
/**
 * 删除单个工具调用的审批记录。
 * 由 UserToolSuccessMessage.tsx 的 useEffect 在组件挂载后调用，
 * 确保已渲染到 React state 的记录不会留在 Map 中无限积累。
 *
 * 设计：使用 useState 懒初始化器在渲染时读取，useEffect 在渲染后删除，
 * 保证读取和删除的顺序正确（读取先于删除）。
 */
export function deleteClassifierApproval(toolUseID: string): void {
  CLASSIFIER_APPROVALS.delete(toolUseID)
}

/**
 * 清空所有审批记录和"正在检查"状态。
 * 由 postCompactCleanup.ts:63 在对话压缩完成后调用——
 * 压缩后消息列表被重建，旧的 toolUseID 不再有效，
 * 对应的审批记录也应清除，防止内存泄漏。
 *
 * 同时触发 classifierChecking 信号，确保 UI 状态同步（清除所有指示器）。
 */
export function clearClassifierApprovals(): void {
  CLASSIFIER_APPROVALS.clear()
  CLASSIFIER_CHECKING.clear()
  classifierChecking.emit()
}
```

---

## 4. React Hook 封装

**文件**：`src/utils/classifierApprovalsHook.ts`

```typescript
/**
 * React hook，将模块级 CLASSIFIER_CHECKING 状态接入 React 渲染循环。
 *
 * 使用 useSyncExternalStore 而非 useState/useEffect，
 * 保证在 React Concurrent Mode 下状态读取的一致性（无撕裂）。
 *
 * 拆分到独立文件的原因（文件头注释）：
 *   permissions.ts、toolExecution.ts、postCompactCleanup.ts 只需要
 *   纯状态操作（不依赖 React），若直接导入 React Hook 会把 React
 *   拖入 print.ts（非交互模式）的依赖链，增加打包体积。
 *
 * @param toolUseID - 工具调用 ID
 * @returns 是否正在等待分类器结果（true = 显示"正在检查"指示器）
 */
export function useIsClassifierChecking(toolUseID: string): boolean {
  return useSyncExternalStore(
    subscribeClassifierChecking,           // 订阅：状态变化时触发重渲染
    () => isClassifierChecking(toolUseID)  // 快照：读取当前状态
  )
}
```

---

## 5. 完整数据流

### 5.1 YOLO 分类器（Auto Mode）审批流

```
permissions.ts:690
  setClassifierChecking(toolUseID)            ← 标记"正在检查"，UI 显示指示器
      │
      ▼
  classifyYoloAction(...)                     ← 调用 LLM 分类器（异步）
      │
      └── finally: clearClassifierChecking()  ← 无论结果如何，清除指示器
              │
              ▼
useCanUseTool.tsx:44（分类器 allow 结果处理）
  if (result.decisionReason.classifier === 'auto-mode')
    setYoloClassifierApproval(toolUseID, reason)  ← 写入审批结果
              │
              ▼
UserToolSuccessMessage.tsx（工具执行完成后渲染）
  // 渲染时同步读取
  const [yoloReason] = useState(() => getYoloClassifierApproval(toolUseID))
  // 渲染后异步删除
  useEffect(() => { deleteClassifierApproval(toolUseID) }, [toolUseID])
  // JSX
  {yoloReason && <Text dimColor>Allowed by auto mode classifier</Text>}
```

### 5.2 Bash 分类器审批流

```
useCanUseTool.tsx:141（交互模式，await 权限检查结果）
  if (result.decisionReason.classifier === 'bash_allow')
    setClassifierApproval(toolUseID, matchedRule)  ← 写入审批结果
              │
              ▼
UserToolSuccessMessage.tsx
  const [classifierRule] = useState(() => getClassifierApproval(toolUseID))
  // JSX：✓ Auto-approved · matched "run npm commands"
  {classifierRule && <Text>✓ Auto-approved · matched "{classifierRule}"</Text>}
```

### 5.3 压缩清理流

```
compactConversation() 完成
    │
    ▼
postCompactCleanup.ts:63
  clearClassifierApprovals()  ← 清空所有记录，防止压缩后旧 toolUseID 残留
```

---

## 6. 设计要点

### 6.1 Map 不会无限增长

每个 toolUseID 的记录在 `UserToolSuccessMessage` 组件首次渲染时（`useEffect`）被删除。即使工具从未成功执行（被拦截），`clearClassifierApprovals()` 也会在压缩时兜底清理。

### 6.2 读写顺序保证（useState 懒初始化 + useEffect 删除）

```typescript
// UserToolSuccessMessage.tsx:47-51
// useState 懒初始化器在渲染时同步执行（早于 useEffect）
const [classifierRule] = React.useState(() => getClassifierApproval(toolUseID))  // ① 渲染时读取
React.useEffect(() => {
  deleteClassifierApproval(toolUseID)  // ② 渲染后删除
}, [toolUseID])
```

`useState` 懒初始化器在组件首次渲染时同步执行，早于 `useEffect`（异步），保证"先读取，后删除"的顺序。读取结果存入 React state，后续重渲染不再从 Map 读取，即使 Map 已清空也不影响显示。

### 6.3 feature guard 的死代码消除

每个函数都检查对应的 feature flag（`BASH_CLASSIFIER` / `TRANSCRIPT_CLASSIFIER`）。在 Bun 构建时，这些分支被静态分析为 `false` 并通过死代码消除（DCE）完全删除，外部构建不产生任何运行时开销。

### 6.4 Hook 与纯状态分离（防止 React 污染非 UI 模块）

React Hook（`useIsClassifierChecking`）与纯状态操作分在两个文件：
- `classifierApprovals.ts`：纯状态，可被 `permissions.ts`、`toolExecution.ts`、`postCompactCleanup.ts` 安全导入
- `classifierApprovalsHook.ts`：React Hook，仅被 React 组件导入

---

## 7. 源文件索引

| 文件 | 角色 |
|-----|-----|
| `src/utils/classifierApprovals.ts` | 核心存储：Map + Set + 信号 |
| `src/utils/classifierApprovalsHook.ts` | React Hook 封装（`useIsClassifierChecking`） |
| `src/utils/permissions/permissions.ts:690` | 写入 `setClassifierChecking` / `clearClassifierChecking` |
| `src/hooks/useCanUseTool.tsx:44,141` | 写入 `setYoloClassifierApproval` / `setClassifierApproval` |
| `src/hooks/toolPermission/PermissionContext.ts:199` | 写入 `setClassifierApproval`（交互权限上下文） |
| `src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx:47-51` | 读取并删除审批结果，渲染 UI 标注 |
| `src/services/compact/postCompactCleanup.ts:63` | 压缩后调用 `clearClassifierApprovals` 兜底清理 |
