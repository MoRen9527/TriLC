# TriLC Code State

## Repository Map

- `src/server/`：HTTP API server（TriMC 兼容）— **CTO-008-M 新增**。`app.ts` 提供 ConnectionManager（3 次失败降级/2 次成功恢复状态机）+ 增强心跳（POST `/internal/v1/heartbeat`）+ 恢复回放（degraded→connected 自动触发 `_performReplay()`）+ `/healthz` `/internal/v1/agent` 端点。
- `src/event-queue/`：**NEW CTO-008-M M.1/M.3**。离网事件队列：`store.ts`（SQLite WAL 持久化，prepared statements, batch transactions）、`queue.ts`（`createEventQueue` 工厂：enqueue / getPendingForReplay / applyReplayResponse / expireOldEvents / getQueueSize）、`types.ts`（QueuedEvent / ReplayRequest / ReplayResponse 类型契约）。11 unit tests + 6 integration tests PASS。
- `src/localbus/`：**NEW CTO-008-M M.3**。`bus.ts` 提供 typed EventEmitter singleton（`localBus`）+ `publish()` helper。Phase 1 内存总线 → Phase 2 UDS/Named Pipe。事件类型：task:queued/running/succeeded/failed、node:connected/degraded/local、agent:event。
- `src/runtime/`：本地 detached runtime
- `src/local-node/`：节点生命周期和心跳
- `src/planner/`：规划与重规划
- `src/toolbus/`：工具总线
- `src/task-runtime/`：任务运行时
- `src/context-adapter/`：本地上下文与能力适配
- `src/contracts/`：类型契约
- `src/session-store/`：**2026-07-22 arch-trilc-daemon D4-D5 新增**。`store.ts`（SQLite WAL，schema v2 migration：`sync_status`/`last_synced_at`/`cloud_session_id`/`title` + `updateSyncStatus`/`markPendingSync`/`getPendingSyncSessions`/`getSessionByCloudId`）+ `types.ts`（SyncStatus 状态机：`local→pending→syncing→synced|error`）。37/37 单元测试 PASS。
- `src/cli.ts`：CLI 入口 + daemon 生命周期管理 — **2026-07-22 arch-trilc-daemon D1 新增**：`install-service`/`uninstall-service`（Windows Service via `sc.exe`）+ `install-regrun`/`uninstall-regrun`（Registry Run）+ 权限检测 + 平台检测 + 互斥检测 + 卸载清理逻辑。
- `vendor/`：外部基线快照

## Current Code Health

- 已有较清晰的本地域控制器骨架。
- **2026-07-17 CTO-008-M**：通信协议全线代码落地 + 测试通过（M.1-M.6 完成，M.7 收口中）：
  - M.1: `src/event-queue/` SQLite 事件队列 — 11 tests PASS
  - M.2: TriMC replay 端点（TriMC app.ts）— 6 集成测试覆盖
  - M.3: `src/localbus/` 内存 EventEmitter 总线
  - M.4: 增强心跳（TriMC + TriLC ConnectionManager）
  - M.5: 冲突仲裁（TriMC `src/comm/arbitration.ts`）— 11 tests PASS
  - M.6: 端到端集成测试（enqueue→replay→arbitrate→apply）— 6 tests PASS
  - 全量：27 tests / 0 fail（TriLC）；11 tests / 0 fail（TriMC 仲裁模块）
- 2026-07-16：CTO-008-P 冒烟测试通过 — healthz、代理到 TriMC（失败→fallback→本地 agentLoop）、clean shutdown 均验证 OK
- **2026-07-22：arch-trilc-daemon 交付（CTO 门禁 APPROVE）** — CLI daemon 注册（`install-service`/`uninstall-service`/`install-regrun`/`uninstall-regrun`，8/8 代码审查验证项通过）+ session-store schema v2 migration（`sync_status`/`last_synced_at`/`cloud_session_id`/`title`，37/37 新增单元测试 PASS）+ 已有回归 28/28 PASS。SyncStatus 默认值统一为 `'local'`。待后续树：arch-trilc-tray（Tray 实现）、arch-trilc-sync（sync-engine+端点）、arch-trilc-msi-e2e（MSI+集成验证）。
- 依赖 `@trimetaverse/agent-core` (file:../TriMC/packages/agent-core) + `trimodel`
- 2026-05-26 已补齐独立 git 仓、根级 `.gitignore` 与本地 CodeGraph 标配。
- 尚未建立 registry 级代码健康评分和 git 健康摘要。

## Change Tracking Baseline

- 关键关注 runtime、planner、本地节点和 capability adapter 的结构变化。

- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。

## Local CodeGraph Index

- 2026-05-24 已由 CTO 小狄技术线完成本地 CodeGraph 试点初始化，并由本模块 CodeRegistry 接管索引摘要。
- 索引范围为仓根干净索引，当前 `.gitignore` 排除 `.codegraph/`、`.cursor/`、`node_modules/`、`vendor/`、构建产物和环境文件；`vendor/openclaw/` 只作为外部参考快照，不进入本模块 CodeGraph 事实。
- 当前摘要：10 files，39 nodes，48 edges，language `typescript`。
- 当前 pending changes 为 `0/0/0`；`.codegraph/` 只作为本地缓存，不作为仓库真源提交。

## Git Health

- 2026-05-26 已补齐独立 git 仓基线；后续由本模块 CodeRegistry 继续维护分支、热区和 dirty worktree 摘要。

## Quality Risks

- 本地域控制器与移动端、入口层的边界容易被过度乐观表述。
- 若不持续区分 `TriLC` 的本地 runtime / planner / tool bus 职责与 PC 端软件层的工作台职责，后续很容易混淆本地执行面和桌面入口面。
- 若不持续更新 planner 和 node lifecycle 的成熟度，后续人格型 agent 会高估执行能力。

## Known Issues / Follow-ups

- **2026-07-25 工程纪律登记（AgentEvent 消费约束）**：`@trimetaverse/agent-core` 的 `agentLoop` 每轮模型回复会 emit 两类事件——`content_delta`（每个 stream chunk 一次，增量文本）与 `assistant_message`（整轮结束一次性，完整聚合 content + tool_calls）。**二者在 content 维度上语义重叠且互斥**：`assistant_message.content` 即同一轮 `content_delta.delta` 的聚合，下游消费者二选一，禁止同时累加/转发，否则会产生重复文本（如 "ABC"+"ABC"）。`tool_calls` 维度有**两个同源事件**：`assistant_message`（聚合 `tool_calls[]`）与独立的 `tool_call`（单调用事件，携带同 id/name/arguments）。下游必须按 **tool_use id 去重**（先到先处理、后到跳过），禁止双源同时开 tool_use block / 转发 tool_calls delta，否则客户端会看到重复的 `content_block_start`（同 id）或重复的 tool_calls chunk。两个 converter（`anthropic-stream.ts` / `openai-stream.ts`）均已用 `processedToolUseIds: Set<string>` 落地该去重（每轮 `request_start` 清空）。正确兜底范式参考 `src/server/app.ts` `/internal/v1/sessions/{id}/stream` 中的 `if (am.content && !deltaContent)` 写法——仅在未收到任何 delta 时用 `assistant_message.content` 兜底。本次 `/v1/messages`、`/chat/completions` 流式与 JSON 四处消费点违反该约束的 Bug 已在修复中；本条纪律作为防复发基线长期生效。
- **2026-07-25 review 偏差登记（ink 依赖）**：TriLC 实际依赖 `ink@^5.2.0`（npm 公开包），CTO 历史技术 review 中"自研 Ink vendor 吸收"未落地。当前以 npm 公开包依赖运行，不阻塞本次 AgentEvent 重复文本修复；后续若进入正式宿主切换或供应链收敛阶段，需另行评估是否进入 vendor 吸收或锁定包指纹，作为 follow-up 待办。

## Phase 1 配置平面改造（W30，cpo-trimodel-deployment）

### Key 缓存模块（`src/config/key-cache.ts`）

- **★ Phase 1 新增**：从 TriModel 配置平面 API 拉取 Provider Key
- 持久化到磁盘（S3 安全：600 权限），Phase 2 预留 KeyStorage 抽象用于 S2 加密
- 刷新策略：15 分钟定时刷新 + 启动时 0-60s 随机 stagger（防惊群）
- TTL：24 小时，过期后若无缓存则 chat 降级不可用
- 离线容错：fetch 失败时使用磁盘缓存；无缓存时 chat disabled
- API：`initKeyCache()`, `getKeyCache()`, `stopKeyCache()`
- 密钥日志脱敏：`sanitizeKey()` → 仅显示前 5 字符 + `****`

### HTTP 优先模型发现（`src/server/app.ts` `getAvailableModels()`）

- **★ Phase 1 改造**：从同步 import library 改为 `async` HTTP 优先
- 优先级：TriModel API (`GET /v1/models`) → library fallback (`createModelClient().listModels()`) → 硬编码兜底
- TriModel API 不可用时自动降级，不阻断 TriPilot 启动
- 1 分钟内存缓存（`MODEL_CACHE_TTL_MS = 60_000`）

### Mirror 模块（`src/mirror/`）

- **★ Phase 1 新增**：`pusher.ts`（推送引擎）+ `types.ts`（类型契约）
- 用于 TriLC → TriMC 云端会话数据镜像推送

### Agent Contract Resolver（`src/config/contract-resolver.ts`）

- Agent Contract V2 YAML 加载与五件套拼接，运行时根据 agent_id 注入对应身份
- `loadAll()`：遍历 source-agents 子目录，加载所有 `*.contract.yaml`
- `loadOne()`：解析单个 contract → 读取 soul / agent_body / agent_frontmatter / memory / colleagues / social → 组装 system prompt
- `watchAndReload()`：监听文件变更并热重载
- **2026-08-01 P0-1 修复**（colleagues_social schema 兼容）：Resolved 原本只识别 YAML paths 中独立 `colleagues` + `social` 字段；TriCompany V2 contract 部分使用合并字段 `colleagues_social`。`loadOne()` 新增归一化逻辑：若 paths 包含 `colleagues_social`，自动填充缺失的独立字段（`colleagues` / `social`），保持向后兼容两种格式。

### env var 变更

| 变量 | 说明 |
|------|------|
| `TRIMODEL_API_URL` | TriModel 配置平面 API 地址（默认 `http://127.0.0.1:3333`） |
| `TRIMODEL_API_TOKEN` | TriModel API 认证 token |

## 初始化状态机（W33，init-collab I1 — commit 186296a）

### 链路进度状态机（`src/company/init-chain.ts`）

- **I1 新增（init-collab-i1-statemachine）**：七态链路状态机 `UNINITIALIZED → SELFCHECK → ONBOARDING → PROJECT-LINK → SYNC → CONFIRM → READY`，与公司态 `CompanyInitState` 分离独立持久（`{dataDir}/company/init-chain.json`）。
- 真 tmp→rename 原子写 + 校验读回；`eventSeq` 单调递增；无任何 git 操作（与 init-state.ts REQ-019 隐患区分，不复刻）。
- 断点续跑：daemon 启动 `load()` 恢复帧；`transitionTo()` 发布 `init:chain-changed`（事件帧 = 状态文件投影，eventSeq 同帧）。
- I1 真实动作仅 `uninitialized→selfcheck`（启动转移，不自动探测）；其余转移由后续树端点驱动。
- 护栏延续：`src/company/session-initializer.ts` 与 TriMC 同源文件 diff 零行；`init-state.ts` diff 零行。

### 自检（`src/company/init-selfcheck.ts`）

- 五探测：healthz / tripilot（被动观察计数）/ trimodel / tristaciss / plane-hint-probe（第五探测构造 TriPilot 形态会话）。
- summary 规则：任一 fail（blocked 级）→ blocked；仅 degraded → degraded；全 ok → pass。401/403/unauthorized = 认证失败族唯一 blocked 类（网络不可达 = degraded）。
- 防重入：运行中再触发 → `{ conflict: true, runId }`（端点 409 同 runId）。
- 事件族：`init:selfcheck-started/progress/finished`（均经 localbus publish 同通道）。
- **I2 A' 裁决（CTO 2026-08-14）**：executeSelfcheck 完成路径加自动推进——summary ∈ {pass, degraded} 且链态 selfcheck → `transitionTo('onboarding', 'daemon')`；发布顺序 = selfcheck-finished 先、chain-changed 后（入口先看自检结果再切选择界面）；blocked 不推进（诊断卡保留，重跑幂等）；`getState()==='selfcheck'` 条件即幂等守卫（onboarding 态重跑无转移无事件）。

### I1 端点（`src/server/app.ts`）

- `GET /internal/v1/init/chain/status`（只读投影 + 诊断卡数据源）
- `POST /internal/v1/init/selfcheck/run`（202 + 防重入 409）
- 启动 load + `uninitialized` 自动转 selfcheck（不自动探测）
- I1 同批修复：A1（TRILC_ENV_FILE + dataDir 相邻 .env 候选）、A2（tool_result SSE 载荷映射）、A3（C13 门卫收紧）、tasks/submit 提交计数钩子、key-cache fetch 状态跟踪。

## 公司面装配升级（W33，init-collab I2 — 本树，commit 见 tree-op i2-2 checkpoint）

### 装配执行体（`src/company/init-assemble.ts`）

- **I2 新增**：`POST /internal/v1/init/assemble` 端点执行体（daemon 单执行体；两入口只发指令，零本地执行）。
- 校验先行（400 族）：ceoName 必填（trim 1..64）、selections ≥1（A4 0 人拦截）、roleId 形状 + 岗位目录成员双校验（白名单逃逸直接拒绝）、去重、name 必填；阶段门禁 422 `{ chainState }`；防重入 409 `{ busy: true }`；<5 岗 warning 不拦截（CEO 裁决口径）。
- 阶段门禁口径（i2-1 §一.2 字面 + CTO A' 裁决 2026-08-14）：仅 `chainState === 'onboarding'` 放行，其余（uninitialized / selfcheck / project-link+）422 `{ chainState }`。selfcheck→onboarding 推进点在 init-selfcheck.ts executeSelfcheck 完成路径（见下节），不在本端点。
- 预写段：白名单落点（`.claude/agents/<roleId>.md` / `docs/registry/company-state.json` / `docs/registry/business-state.md` / `AGENTS.md`）逐文件 tmp→rename + `.bak` 备份目录（`{dataDir}/company/assemble-bak/<runId>/`）；任一失败 → .bak 恢复 + 删新增文件 + 500 `{ rollback }`。
- 提交段：`CompanyInitState.save({ state:'initialized', ... })` → `InitChain.transitionTo('project-link', entry)`（公司态先、链路态后；save 成功但 transition 失败不回滚文件，幂等重试路径承接）。
- 幂等重试：公司态已 initialized 且链路态仍 onboarding/selfcheck → 跳过文件段与 state save，校验员工一致（不一致 409 `employees_mismatch`）后补 transition。
- 事件：`init:step-event` assembling / assembled / assemble-failed；chain-changed 由 transitionTo 自动发布。
- 既有真实内容不覆盖：`business-state.md` / `AGENTS.md` 缺失才写占位，存在即 preserved（响应报告）。
- 同包断点续跑端点逻辑：`getOnboardingStateProjection()`（只读投影，progress.ceoName 优先）+ `validateProgressUpsert()` / `upsertOnboardingProgress()`（经 `CompanyInitState.save({ progress })` 机制沿用，init-state.ts 零改动）。
- init 模式路由：`buildInitModeSystemPrompt(chainState)`（链态 ∈ {selfcheck, onboarding, project-link, sync, confirm} 且无 client systemPrompt 时替代 defaultSystemPrompt；含 init 端点指令面 + 零本地执行措辞）。

### I2 端点增量（`src/server/app.ts`）

- `GET /internal/v1/init/role-catalog`（contract-resolver `getRoleCatalog()`；resolver 未初始化/roster 缺失 → 503 不开天窗）
- `POST /internal/v1/init/assemble`（校验 → 执行 → 200/400/409/422/500）
- `GET /internal/v1/init/events`（daemon 级 init:* SSE 通道；无重放缓冲 = 断连重拉 status；25s keep-alive）
- `GET /internal/v1/init/onboarding/state` + `POST /internal/v1/init/onboarding/progress`（REQ-016 断点续跑真源）
- tasks/submit init 模式路由（无显式 systemPrompt + 链态 ∈ init 集 → init bootstrap + 周平面提示恒一次）

### role-catalog 数据源（`src/config/contract-resolver.ts`）

- `DEFAULT_SELECTED_ROLES` 常量（D1 决策 2026-08-14 CPO 确认）：ceo-chief-of-staff / full-stack-developer / chief-administrative-officer / chief-human-resources-officer / chief-technology-officer。
- `getRoleCatalog()`：roster 主键 + 合同 identity 面（roleName=identity.role、oneLinePositioning=identity.description、isGovernance=tier==='C-suite'、defaultSelected=常量）。
- `loadEmployeeRoster()` 路径候选扩展：`<sourceRoot>/docs/registry/` 与 `<TriCompany 根>/docs/registry/`（真源路径）。

### 叙事态下线（i2-2 §五，同 release 一次性）

- 删除 `src/company/onboarding.ts`（Step1-5 叙事 prompt 整体下线）
- 删除 app.ts heartbeat 叙事 onboarding agent 注册块 + cli.ts `hb_company-onboarding` auto-resume 分支
- ONBOARDING 阶段驱动 = 装配端点 + 事件流，无叙事 agent 并存路径

### 前置项与契约修正（i2-2 落地）

- I1 前置强制项③：`init-chain.ts load()` 区分 ENOENT（静默默认帧）vs 解析错（`.corrupt` 备份 + console.error + 默认帧），单测三件套覆盖。
- 契约修正⑧：`init-selfcheck.ts` trimodel 认证失败 detail 用 `ks.lastFetchError` 实际错误串（截断 120）。

### CLI 文本化流程（`src/company/init-cli-flow.ts`）

- trilc chat 启动时 chain/status 呈初始化阶段 → 文本化流程（selfcheck 诊断卡 blocked 置顶 + 组合规则注记 → 编号多选（默认 D1 五岗）→ CEO 名/员工名问答（REQ-016 已答不重复问）→ 汇总确认 → assemble 提交，entry=trilc-chat）。
- 员工 `--agent` 会话路径不动；流程只渲染 + 发 daemon 端点指令。

### 测试与冒烟

- 单测：init-chain（load 三件套 + 既有 8）/ init-selfcheck（detail 实际错误串断言更新 + A' 自动推进四用例：pass 转移 / degraded 转移 / blocked 不转移 / onboarding 重跑无转移）/ init-assemble 14 用例（校验矩阵、逃逸拒绝、422/409 门禁、回滚注入、幂等重试、事件帧一致、preserved、progress roundtrip、init 模式矩阵）/ contract-resolver（getRoleCatalog 2 用例）/ tasks-submit-weekly-hint（init 模式路由 1 用例）。
- 全量基线：340/341（1 fail = test/tui/components.test.ts ink-testing-library 环境缺口，r19 基线既有非本树引入）。
- 活体冒烟：TRILC_DATA_DIR 显式隔离实例 8726（候选 A 轮）+ 8727（A' 轮）全链 PASS。A' 轮实证：selfcheck 完成（degraded）→ 链态自动 onboarding（chain-changed from=selfcheck to=onboarding sourceEntry=daemon，SSE 序 selfcheck-finished 先于 chain-changed）→ assemble 200（响应与 §一.5 契约字面一致，无 advancedFromSelfcheck）→ 工作区白名单 8 产物 → 重入 422 → 8711 全程未扰动。

## Sources

- `../../src/runtime/`
- `../../src/local-node/`
- `../../src/planner/`
- `../../src/toolbus/`
- `../../src/context-adapter/`
- `../../src/config/contract-resolver.ts`
- `../../src/config/key-cache.ts`
- `../../src/mirror/`
- `../../src/server/app.ts`
