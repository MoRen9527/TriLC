# TriLC Code State

## Repository Map

- `src/runtime/`：本地 detached runtime
- `src/local-node/`：节点生命周期和心跳
- `src/planner/`：规划与重规划
- `src/toolbus/`：工具总线
- `src/context-adapter/`：本地上下文与能力适配
- `vendor/`：外部基线快照

## Current Code Health

- 已有较清晰的本地域控制器骨架。
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

## Sources

- `../../src/runtime/`
- `../../src/local-node/`
- `../../src/planner/`
- `../../src/toolbus/`
- `../../src/context-adapter/`
