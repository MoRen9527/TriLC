# TriLC Product State

## Module Overview

- `TriLC` 是**本地人机协作主入口**（分布式员工工位），负责编码/办公/视频制作等本地人机协作场景的 detached local runtime、planner、tool bus 和本地执行生命周期。
- `TriPilot` 默认直连 `TriLC`；`TriLC` 崩溃时配合 TWF-001 任务树恢复机制自动切换至 `TriMC` 云端 fallback。
- `TriMC` 作为公司云端实体，承载公司运行面（知识体系、业务运营、奖励发放、审计），并保持多热备保障托管任务与公司运营稳定性。

## Current Product Scope

- 作为本地人机协作主入口，承接编码/办公/视频制作等场景的本地 agent 执行闭环。
- 为本地任务链路、节点生命周期和本地工具能力提供 runtime + planner + tool bus 底座。
- 本地 detached runtime 基于从 OpenClaw 吸收的守候进程模式（daemon placeholder），确保 IDE 关闭后任务不中断。
- `TriPilot` 默认直连本模块；崩溃时通过 TWF-001 恢复机制切换至 `TriMC` 云端 fallback。
- 与 `TriCode`（多代码工具 glue 层）、`TriPilot`（chat webview + CLI 双入口）、`vscodium`（IDE 宿主）组成本地工作台链路。
- 稳定产出可平滑迁移至 `TriMC` 云端托管；`TriMC`→`TriLC` 通知通道保留，用于公司运营通知回传。

- 涉及具体项目代码仓库时，产品侧文档基线应按 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md` 和产品版 `STATE.md` 维护；若缺失，应视为待补齐的产品真源缺口。

## Current Progress

- 已具备根级 `AGENTS.md`、`README.md` 和首版 registry 工作层。
- 当前产品资料仍偏向架构和职责层，成熟度需后续继续细化。

## Bug And Gap State

- 本地域节点成熟度仍需明确，不能把规划中能力写成现役。
- 与 `TriMobile`、`TriAvatar` 的入口协作仍需后续进一步定义。

## Cross-Module Dependencies

- 与 `TriMC`：本地→云端成果迁移通道 + 云端通知回传 + TriLC 崩溃时 TriMC fallback（TWF-001）。
- 与 `TriPilot` + `TriCode` + `vscodium`：共同形成"本地工作台"协同链路——TriPilot 用户入口 → TriLC 本地主控 → TriCode 工具 glue → opencode/Claude Code。
- 与 `TriMobile`、`TriAvatar`：未来入口和体验侧耦合（非首轮阻塞）。
- 与 `TriMetaverse` 中央 BusinessStrategy 保持一致。

## Architecture State

- 当前以 local runtime、planner、node lifecycle 和 tool bus 为核心。

## Sources

- `../../AGENTS.md`
- `../../README.md`
