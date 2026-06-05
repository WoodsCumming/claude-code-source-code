# AI Agent 小模意图型路由服务设计方案

**日期：** 2026-06-04  
**状态：** 已确认  
**适用场景：** 多 Agent 调度 + 大小模型分流 + 工具/API 路由（三合一）

---

## 目录

1. [整体架构](#1-整体架构)
2. [数据模型与意图体系](#2-数据模型与意图体系)
3. [请求生命周期与各层实现](#3-请求生命周期与各层实现)
4. [API 接口设计与可观测性](#4-api-接口设计与可观测性)
5. [部署方案与生产注意事项](#5-部署方案与生产注意事项)

---

## 1. 整体架构

### 1.1 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                     Intent Router Service                        │
│                                                                 │
│  HTTP/gRPC Request                                              │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────────┐     ┌─────────────────┐                      │
│  │ Session Mgr  │────▶│  Context Fusion │                      │
│  │ (Redis)      │     │  (上下文融合器)  │                      │
│  └──────────────┘     └────────┬────────┘                      │
│                                │                                │
│                                ▼                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  L1 · 粗筛层                             │   │
│  │  ┌──────────────┐   ┌──────────────────────────────┐   │   │
│  │  │  规则引擎     │   │  Embedding 向量召回           │   │   │
│  │  │ (精确匹配/    │   │  (FAISS/Milvus)              │   │   │
│  │  │  正则/关键词) │   │                              │   │   │
│  │  └──────┬───────┘   └──────────────┬───────────────┘   │   │
│  │         └──────────────────────────┘                    │   │
│  │                    置信度评估                            │   │
│  │            ≥ threshold ──→ 直接路由 (bypass L2)         │   │
│  │            < threshold ──→ 进入 L2                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                │                                │
│                                ▼ (低置信)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  L2 · 精分层                             │   │
│  │         小模型 LLM (Qwen-1.5B / local inference)        │   │
│  │         + 多轮上下文 (最近 N 轮 slot)                   │   │
│  │                                                         │   │
│  │            ≥ threshold ──→ 路由决策                     │   │
│  │            < threshold ──→ 进入 L3                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                │                                │
│                                ▼ (低置信)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  L3 · 兜底层                             │   │
│  │  ┌─────────────────────┐   ┌─────────────────────────┐ │   │
│  │  │  大模型重判          │──▶│  超时/失败 → 反问用户   │ │   │
│  │  │  (GPT-4/Claude/等)  │   │  (Clarification Agent)  │ │   │
│  │  └─────────────────────┘   └─────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                │                                │
│                                ▼                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Router Dispatcher                       │   │
│  │  意图 → Agent / 工具 / 模型 的映射注册表                 │   │
│  │  支持：多Agent调度 / 大小模型分流 / 工具API路由          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                │                                │
│          ┌─────────────────────┼──────────────────────┐        │
│          ▼                     ▼                      ▼        │
│   [专家 Agent Pool]     [工具/API 网关]        [大/小模型池]    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **分层短路** | L1 命中即返回，不触发 LLM，高频意图 P95 延迟 < 5ms |
| **上下文前置融合** | Session 在进入任何分类层之前统一注入，避免重复读取 |
| **置信度驱动降级** | 每层输出 `(intent, confidence, entities)`，统一接口 |
| **Dispatcher 解耦** | 意图分类与路由规则完全分离，新增 Agent 不改分类器 |

---

## 2. 数据模型与意图体系

### 2.1 意图分类体系（Intent Taxonomy）

采用**两级树形结构**，一级意图由 L1 粗筛，二级意图由 L2 精分：

```
intent_tree:
│
├── query                          # 信息查询类
│   ├── query.knowledge            # 知识问答
│   ├── query.data                 # 数据查询（SQL/报表）
│   └── query.status               # 状态查询（订单/任务进度）
│
├── task                           # 任务执行类
│   ├── task.code                  # 代码生成/调试
│   ├── task.data_analysis         # 数据分析/可视化
│   ├── task.file                  # 文件处理
│   └── task.automation            # 工作流自动化
│
├── conversation                   # 对话管理类
│   ├── conversation.chit_chat     # 闲聊
│   ├── conversation.clarify       # 用户主动澄清
│   └── conversation.feedback      # 反馈/评价
│
├── tool_call                      # 工具调用类
│   ├── tool_call.search           # 搜索引擎
│   ├── tool_call.calendar         # 日历/调度
│   └── tool_call.external_api     # 第三方 API
│
└── __fallback__                   # 兜底意图
```

### 2.2 核心数据结构

```python
# 统一的分类结果结构（每层输出相同接口）
@dataclass
class IntentResult:
    intent: str              # "task.code"
    confidence: float        # 0.0 ~ 1.0
    entities: dict           # {"language": "python", "task": "sort algorithm"}
    source: str              # "rule" | "embedding" | "llm_small" | "llm_large"
    latency_ms: float        # 本层耗时

# 路由决策结果
@dataclass
class RouteDecision:
    intent_result: IntentResult
    target_type: str         # "agent" | "tool" | "model"
    target_id: str           # "code_agent_v2" | "search_tool" | "gpt-4o"
    model_tier: str          # "small" | "large"（仅 target_type=model 时有效）
    fallback_chain: list     # 路由失败时的备选链

# Session 上下文（存 Redis，TTL=30min）
@dataclass
class SessionContext:
    session_id: str
    history: list[dict]      # 最近 N 轮 {role, content, intent, entities}
    current_topic: str       # 当前话题域，辅助 L2 消歧
    user_profile: dict       # 用户偏好/权限级别
    pending_clarification: bool  # 是否等待用户澄清中
```

### 2.3 置信度阈值配置

```yaml
# config/router_thresholds.yaml
thresholds:
  l1_pass:    0.90   # L1 ≥ 0.90 → 直接路由，bypass L2
  l2_pass:    0.75   # L2 ≥ 0.75 → 路由决策
  l3_timeout: 8000   # ms，大模型兜底超时 → 触发反问

  # 特殊意图可覆盖全局阈值
  overrides:
    "tool_call.external_api": 0.95   # 工具调用要求更高置信
    "conversation.chit_chat": 0.60   # 闲聊容忍较低置信
```

### 2.4 路由注册表（Dispatcher Registry）

```python
# 意图 → 路由目标的映射，运行时热加载
ROUTING_TABLE = {
    "task.code":              RouteTarget(type="agent",  id="code_agent"),
    "task.data_analysis":     RouteTarget(type="agent",  id="data_agent"),
    "query.data":             RouteTarget(type="tool",   id="sql_executor"),
    "tool_call.search":       RouteTarget(type="tool",   id="search_api"),
    "query.knowledge":        RouteTarget(type="model",  tier="small"),
    "conversation.chit_chat": RouteTarget(type="model",  tier="small"),
    "__fallback__":           RouteTarget(type="model",  tier="large"),
}
```

> 路由表支持通过管理 API 热更新，不需要重启服务。

---

## 3. 请求生命周期与各层实现

### 3.1 请求完整生命周期

```
Client Request
     │
     ▼
┌────────────────────────────────────────────┐
│ 1. 预处理（PreProcessor）                   │
│    • 文本归一化（去噪/截断/语言检测）        │
│    • 提取 session_id，读取 SessionContext    │
│    • 上下文融合：拼接 current_topic + 历史  │
│      关键 slot 注入当前请求                  │
└────────────────┬───────────────────────────┘
                 │ enriched_request
                 ▼
┌────────────────────────────────────────────┐
│ 2. L1 粗筛层（< 5ms 目标）                  │
│                                            │
│  ┌─────────────┐   ┌────────────────────┐  │
│  │ 规则引擎    │   │ Embedding 召回      │  │
│  │             │   │                    │  │
│  │ • 精确词典  │   │ • 请求向量化        │  │
│  │ • 正则模板  │   │ • Top-K 意图召回    │  │
│  │ • 前缀树    │   │ • 余弦相似度打分    │  │
│  └──────┬──────┘   └─────────┬──────────┘  │
│         └──────────┬─────────┘             │
│                    ▼                        │
│           分数融合（加权平均）              │
│           rule_score * 0.6 +               │
│           embed_score * 0.4               │
│                    │                        │
│         ≥ 0.90 ────┼──→ [RouteDecision]    │
│         < 0.90 ────┴──→ 进入 L2            │
└────────────────────────────────────────────┘
                 │ (低置信)
                 ▼
┌────────────────────────────────────────────┐
│ 3. L2 精分层（目标 < 200ms）                │
│                                            │
│  输入构造：                                 │
│  ┌──────────────────────────────────────┐  │
│  │ System: 你是意图分类器，输出JSON...   │  │
│  │ History: [上2轮 intent + entities]   │  │
│  │ Topic: {current_topic}               │  │
│  │ User: {当前请求}                     │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  小模型推理（本地部署 / vLLM / Ollama）    │
│  强制 JSON 输出（JSON Mode / Grammar）     │
│                                            │
│  输出解析 → IntentResult                   │
│         ≥ 0.75 ──→ [RouteDecision]        │
│         < 0.75 ──→ 进入 L3                │
└────────────────────────────────────────────┘
                 │ (低置信)
                 ▼
┌────────────────────────────────────────────┐
│ 4. L3 兜底层                                │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  大模型重判（async，timeout=8s）      │  │
│  │  • 携带完整 session history           │  │
│  │  • 返回 intent + entities + reason    │  │
│  └───────────────┬──────────────────────┘  │
│                  │                          │
│         成功 ────┴──→ [RouteDecision]      │
│         超时/失败 ───→ Clarification Agent │
│                        生成反问话术         │
│                        返回给用户          │
└────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────┐
│ 5. Router Dispatcher                        │
│    • 查询 ROUTING_TABLE                    │
│    • 执行路由目标（Agent/Tool/Model）       │
│    • 失败时走 fallback_chain               │
└────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────┐
│ 6. 后处理（PostProcessor）                  │
│    • 更新 SessionContext（写回 Redis）      │
│    • 记录路由日志（用于离线分析/再训练）    │
│    • 返回响应给 Client                     │
└────────────────────────────────────────────┘
```

### 3.2 L1 规则引擎实现

```python
class RuleEngine:
    def __init__(self, rules_path: str):
        self.exact_map: dict[str, str] = {}     # 词典精确匹配
        self.regex_rules: list[tuple] = []       # (pattern, intent, weight)
        self.trie = Trie()                        # 前缀树加速

    def score(self, text: str) -> IntentResult | None:
        # 优先级：精确匹配 > 前缀树 > 正则
        if intent := self.exact_map.get(text.strip().lower()):
            return IntentResult(intent=intent, confidence=1.0, source="rule")

        for pattern, intent, weight in self.regex_rules:
            if m := pattern.search(text):
                entities = m.groupdict()
                return IntentResult(
                    intent=intent,
                    confidence=weight,
                    entities=entities,
                    source="rule"
                )
        return None  # 规则未命中，交给 Embedding
```

### 3.3 L2 小模型 Prompt 模板

```python
CLASSIFY_PROMPT = """你是一个意图分类器，只输出 JSON，不输出其他内容。

## 可选意图列表
{intent_list}

## 对话历史（最近2轮）
{history}

## 当前话题域
{current_topic}

## 用户输入
{user_input}

## 输出格式
{{"intent": "<一级.二级>", "confidence": 0.0~1.0, "entities": {{}}}}"""
```

**关键工程细节：**

| 细节 | 方案 |
|------|------|
| 防止 LLM 乱输出 | 使用 JSON Mode 或 Outlines/Guidance 约束语法 |
| 推理加速 | vLLM + continuous batching，多请求合并推理 |
| 模型热备 | 主模型 + shadow 模型，主模型超时自动切换 |
| 输入长度控制 | history 最多保留 2 轮，超出截断最早轮 |

### 3.4 多轮上下文融合策略

```python
class ContextFusion:
    def enrich(self, request: str, ctx: SessionContext) -> tuple[str, dict]:
        """
        融合策略：
        1. 代词消解  "再画一个" → 结合 current_topic="数据分析" → "再画一个数据图"
        2. 话题继承  上轮 intent=task.data_analysis → 本轮 bias 权重 +0.2
        3. 实体继承  上轮 entities={dataset:"销售数据"} → 注入本轮 prompt
        """
        if ctx.current_topic and self._is_follow_up(request, ctx):
            request = f"[承接话题:{ctx.current_topic}] {request}"

        inherited_entities = self._extract_sticky_entities(ctx.history)
        return request, inherited_entities

    def _is_follow_up(self, text: str, ctx: SessionContext) -> bool:
        FOLLOW_UP_SIGNALS = ["再", "继续", "那", "然后", "还有", "它", "这个"]
        return any(sig in text for sig in FOLLOW_UP_SIGNALS)
```

---

## 4. API 接口设计与可观测性

### 4.1 对外 API 接口

#### 主路由接口

```python
# POST /v1/route
class RouteRequest(BaseModel):
    session_id: str                       # 会话ID，用于多轮上下文
    message: str                          # 用户输入
    user_id: str | None = None            # 用户标识（用于权限/画像）
    context_override: dict | None = None  # 临时覆盖上下文（调试用）
    dry_run: bool = False                 # 只返回意图，不实际路由执行

class RouteResponse(BaseModel):
    request_id: str                    # 链路追踪ID
    intent: str                        # "task.code"
    confidence: float
    entities: dict
    route_target: RouteTarget
    classify_source: str               # "l1_rule"|"l1_embed"|"l2_llm"|"l3_llm"
    latency_breakdown: dict            # {"preprocess":2,"l1":4,"l2":180}
    clarification_needed: bool         # True时返回反问内容
    clarification_text: str | None
```

#### 管理接口

```
PUT  /admin/routing-table    # 路由表热更新（无需重启）
GET  /admin/routing-table
GET  /admin/intent-tree      # 意图树查看
PUT  /admin/thresholds       # 置信度阈值调整
GET  /admin/thresholds
GET  /health                 # {"status":"ok","l1":"ok","l2":"ok","l3":"ok"}
GET  /health/detail          # 各组件延迟、命中率统计
```

### 4.2 Metrics（Prometheus 格式）

```
# 每层命中率
router_l1_hit_total{source="rule|embedding"}       Counter
router_l2_hit_total                                Counter
router_l3_hit_total{reason="low_conf|timeout"}     Counter
router_clarification_total                         Counter

# 置信度分布
router_confidence_histogram{layer="l1|l2|l3"}      Histogram

# 延迟分位数
router_latency_ms{layer="l1|l2|l3|total"}          Histogram

# 路由目标分布
router_dispatch_total{target_type, target_id}       Counter

# 错误率
router_error_total{layer, error_type}               Counter
```

### 4.3 结构化日志格式

```json
{
  "timestamp": "2026-06-04T10:23:45.123Z",
  "request_id": "req_abc123",
  "session_id": "sess_xyz",
  "input_text": "帮我分析上个月的销售数据",
  "classification": {
    "l1_result": {"intent": "query.data", "confidence": 0.72, "source": "embedding"},
    "l2_result": {"intent": "task.data_analysis", "confidence": 0.91, "source": "llm_small"},
    "final_intent": "task.data_analysis",
    "winning_layer": "l2"
  },
  "route": {
    "target_type": "agent",
    "target_id": "data_agent"
  },
  "latency": {
    "l1_ms": 4,
    "l2_ms": 178,
    "total_ms": 190
  }
}
```

### 4.4 告警规则

```yaml
alerts:
  - name: L3FallbackRateTooHigh
    expr: rate(router_l3_hit_total[5m]) / rate(router_dispatch_total[5m]) > 0.10
    message: "L3兜底率超过10%，可能意图体系有盲区或L2模型退化"

  - name: L2LatencySpike
    expr: histogram_quantile(0.95, router_latency_ms{layer="l2"}) > 500
    message: "L2小模型P95延迟超500ms，检查vLLM服务负载"

  - name: ClarificationRateTooHigh
    expr: rate(router_clarification_total[10m]) / rate(router_dispatch_total[10m]) > 0.03
    message: "反问率超3%，用户体验受损，需扩充意图覆盖"

  - name: ConfidenceDistributionDrift
    expr: avg(router_confidence_histogram{layer="l1"}) < 0.6
    message: "L1平均置信度下降，规则库可能过期或输入分布漂移"
```

### 4.5 离线反馈闭环

```
线上路由日志
      │
      ▼
┌─────────────────────────────────┐
│  自动样本挖掘                    │
│  • confidence < 0.75 的请求     │
│  • 用户纠正行为（重试/反问后）   │
│  • 路由后 Agent 报错的请求       │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  标注队列（Label Studio 等）     │
│  人工标注 or 大模型辅助标注      │
└────────────┬────────────────────┘
             ▼
┌─────────────────────────────────┐
│  增量微调 / 规则库更新           │
│  → 灰度上线 → 效果评估           │
└─────────────────────────────────┘
```

---

## 5. 部署方案与生产注意事项

### 5.1 整体部署架构

```
                        ┌─────────────────┐
                        │   API Gateway   │
                        │  (限流/鉴权/LB) │
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
    │ Router Pod 1 │   │ Router Pod 2 │   │ Router Pod N │
    │ • L1 引擎    │   │ • L1 引擎    │   │ • L1 引擎    │
    │ • L2 Client  │   │ • L2 Client  │   │ • L2 Client  │
    │ • Dispatcher │   │ • Dispatcher │   │ • Dispatcher │
    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
           └──────────────────┴──────────────────┘
                               │
     ┌─────────────────────────┼──────────────────────┐
     │         Redis           │  vLLM (GPU)           │
     │         Cluster         │  FAISS / Milvus       │
     │         (Session)       │  (Embedding)          │
     └─────────────────────────┴──────────────────────┘
                   大模型 API (L3) — 外部/自建
```

### 5.2 Docker Compose 本地开发配置

```yaml
services:
  intent-router:
    build: .
    ports: ["8000:8000"]
    environment:
      - REDIS_URL=redis://redis:6379
      - L2_INFERENCE_URL=http://vllm:8080
      - L3_API_KEY=${OPENAI_API_KEY}
      - L1_THRESHOLD=0.90
      - L2_THRESHOLD=0.75
    depends_on: [redis, vllm]
    volumes:
      - ./config:/app/config      # 规则库/路由表热加载

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru

  vllm:
    image: vllm/vllm-openai:latest
    runtime: nvidia
    command: ["--model", "Qwen/Qwen1.5-1.8B-Chat", "--max-model-len", "2048"]
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]

  # 无 GPU 环境用 Ollama 替代
  ollama:
    image: ollama/ollama:latest
    profiles: ["no-gpu"]
```

### 5.3 灰度上线策略

```
Step 1  Shadow Mode（影子流量）
        新模型并行接收 10% 流量，只记录结果不实际路由
        观察 3 天：意图分布、置信度、与旧模型的差异率

Step 2  Canary（金丝雀）
        切换 5% → 20% → 50% 真实流量到新模型
        每阶段观察 24h，监控 L3兜底率 / 反问率 / 用户投诉

Step 3  Full Rollout
        确认指标无退化后全量切换，保留旧版本 72h 支持快速回滚

Rollback 触发条件：
  • L3兜底率上升 > 5个百分点
  • P95 延迟上升 > 100ms
  • 反问率上升 > 1个百分点
```

### 5.4 生产注意事项清单

#### 稳定性

| 风险 | 缓解措施 |
|------|----------|
| vLLM 服务宕机 | Circuit Breaker，L2 故障时直接升 L3（大模型 API） |
| Redis 超时 | Session 读取失败时降级为无上下文单轮分类，不阻断主链路 |
| L3 大模型限流 | 指数退避重试 + 本地 fallback 队列，超时后直接反问用户 |
| 意图体系版本不一致 | 路由表和意图树版本号强绑定，不同版本拒绝路由 |

#### 安全性

```python
# Prompt 注入防护
INJECTION_PATTERNS = [
    r"ignore previous instructions",
    r"你现在是",
    r"system:",
]

def sanitize_input(text: str) -> str:
    for pattern in INJECTION_PATTERNS:
        text = re.sub(pattern, "[FILTERED]", text, flags=re.IGNORECASE)
    return text[:512]   # 强制截断，防止超长输入攻击
```

#### 成本控制（参考：每日 100 万次请求）

```
L1 命中（~78%）：780,000 次 × ~0 LLM 成本 = ¥0
L2 命中（~17%）：170,000 次 × 本地推理     = 电费 ~¥5
L3 命中（~5%）：  50,000 次 × ¥0.002/次    = ¥100
────────────────────────────────────────────────────
合计约 ¥105/天，vs 全走大模型约 ¥2,000/天（节省 95%）
```

### 5.5 演进路线

```
阶段一（MVP，2周）
  ├── L1 规则引擎 + 静态路由表
  ├── FastAPI 服务框架
  └── 基础 Redis Session

阶段二（+2周）
  ├── L2 小模型接入（Ollama 本地）
  ├── Embedding 向量召回
  └── Prometheus + Grafana 看板

阶段三（+1月）
  ├── L3 大模型兜底 + 反问 Agent
  ├── 多轮上下文融合
  └── 灰度发布流水线

阶段四（持续）
  ├── 离线标注闭环
  ├── 模型增量微调
  └── A/B 路由策略实验
```

---

## 附录：技术选型速查

| 组件 | 推荐选项 | 备选 |
|------|----------|------|
| L2 小模型 | Qwen1.5-1.8B-Chat | Llama-3.2-1B, Phi-3-mini |
| 推理框架 | vLLM | Ollama（无GPU）, TGI |
| Embedding | BGE-small-zh | text2vec-base-chinese |
| 向量索引 | FAISS（单机）| Milvus（分布式）|
| Session 存储 | Redis Cluster | Valkey |
| 输出约束 | Outlines / lm-format-enforcer | 原生 JSON Mode |
| 监控 | Prometheus + Grafana | Datadog |
| 日志 | Kafka + ELK | Loki + Grafana |
