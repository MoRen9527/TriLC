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

### env var 变更

| 变量 | 说明 |
|------|------|
| `TRIMODEL_API_URL` | TriModel 配置平面 API 地址（默认 `http://127.0.0.1:3333`） |
| `TRIMODEL_API_TOKEN` | TriModel API 认证 token |

## Sources

- `../../src/runtime/`
- `../../src/local-node/`
- `../../src/planner/`
- `../../src/toolbus/`
- `../../src/context-adapter/`
- `../../src/config/key-cache.ts`
- `../../src/mirror/`
- `../../src/server/app.ts`
