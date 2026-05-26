# TriLC Product State

## Module Overview

- `TriLC` 是本地域控制器，也是配合 `TriMC` 控制和调配龙虾 / Hermes / 其他 agents 的本地适配层。
- 它承接 detached local runtime、本地节点升级、planner、tool bus、本地执行生命周期，以及服务域到本地域的 agent 执行适配。

## Current Product Scope

- 作为本地域侧的执行与节点升级入口。
- 为本地域任务链路、节点升级和本地工具能力提供底座。
- 与 `TriMC` 协同完成 agent 集群调度在本地节点上的适配、控制与执行反馈。
- 与 `TriPilot`、`Tride`、`vscodium` 和 CLI 组成的 PC 端软件层协同承接本地化任务；其中 PC 端软件层更偏入口、工作台和用户自用自动化，`TriLC` 负责本地 runtime、planner、tool bus 和执行生命周期。

- 涉及具体项目代码仓库时，产品侧文档基线应按 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md` 和产品版 `STATE.md` 维护；若缺失，应视为待补齐的产品真源缺口。

## Current Progress

- 已具备根级 `AGENTS.md`、`README.md` 和首版 registry 工作层。
- 当前产品资料仍偏向架构和职责层，成熟度需后续继续细化。

## Bug And Gap State

- 本地域节点成熟度仍需明确，不能把规划中能力写成现役。
- 与 `TriMobile`、`TriAvatar` 的入口协作仍需后续进一步定义。

## Cross-Module Dependencies

- 与 `TriMC` 共同形成服务域到本地域的任务链路。
- 与 `TriPilot`、`Tride`、`vscodium` 共同形成“桌面工作台 + 本地域控制器”的协同链路。
- 与 `TriMobile`、`TriAvatar` 在入口和体验侧存在未来耦合。
- 与 `TriMetaverse` 的总体战略保持一致。

## Architecture State

- 当前以 local runtime、planner、node lifecycle 和 tool bus 为核心。

## Sources

- `../../AGENTS.md`
- `../../README.md`
