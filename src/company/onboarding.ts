// ── TriCompany Onboarding Agent ──
// REQ-20260805-001: when company is uninitialized, the heartbeat runner
// registers an onboarding agent that auto-pushes the onboarding flow:
//   Step 1: greet CEO
//   Step 2: ask CEO name
//   Step 3: offer role list (standard roles from TriCompany source-agents)
//   Step 4: CEO selects roles + names employees
//   Step 5: assemble skeleton → state INITIALIZED
//
// Roles are standard assets; names are user assets (CEO-defined).

import type { HeartbeatAgentConfig } from "../heartbeat/heartbeat-runner.js";

/** Standard role catalog (positions, not people). */
export const ROLE_CATALOG: Array<{ role: string; label: string }> = [
  { role: "ceo-chief-of-staff", label: "CEOChiefOfStaff 总助" },
  { role: "full-stack-developer", label: "FullStackDeveloper 开发" },
  { role: "chief-administrative-officer", label: "ChiefAdministrativeOfficer 行政官" },
  { role: "chief-human-resources-officer", label: "ChiefHumanResourcesOfficer 人力官" },
  { role: "chief-technology-officer", label: "ChiefTechnologyOfficer 技术官" },
  { role: "chief-product-officer", label: "ChiefProductOfficer 产品官" },
  { role: "chief-financial-officer", label: "ChiefFinancialOfficer 财务官" },
  { role: "chief-operating-officer", label: "ChiefOperatingOfficer 运营官" },
  { role: "chief-marketing-officer", label: "ChiefMarketingOfficer 营销官" },
  { role: "test-engineer", label: "TestEngineer 测试" },
  { role: "rd-trainer", label: "RAndDTrainer 培训" },
  { role: "deployment-engineer", label: "DeploymentEngineer 部署" },
  { role: "customer-success-officer", label: "CustomerSuccessOfficer 客户成功" },
];

/** Build the onboarding agent's system prompt (per playbook §1.2). */
export function buildOnboardingSystemPrompt(workspaceRoot: string, statePath?: string): string {
  const roleList = ROLE_CATALOG.map((r, i) => `  [${i + 1}] ${r.label} (${r.role})`).join("\n");

  return `你是 TriCade 的安装初始化引导 Agent。公司尚未开张，你的任务是按实施手册引导 CEO 完成公司开张。

工作区: ${workspaceRoot}

按以下步骤引导（一次一步，等 CEO 回复后再继续）:

Step 1: 跟 CEO 打招呼
  "欢迎使用 TriCade。检测到公司尚未开张，我来引导您开张赛博公司。"

Step 2: 问 CEO 名字
  "请问您的名字？（您将是公司的 CEO）"

Step 3: 提供岗位列表（标准岗位目录）
  "请选择要启用的岗位（最小配置建议 5 个，含治理角色）：
${roleList}
  （回复岗位编号，可多选，如：1,2,3,4,5）"

Step 4: 为每个员工起名
  对每个选中的岗位，请 CEO 给员工起名（名字由 CEO 定义，不预设）。

Step 5: 装配公司骨架
  使用 Write/Edit 工具在工作区创建:
  - .claude/agents/<role>.md（员工 agent 定义，名字写入）
  - docs/registry/company-state.json（公司状态: CEO 名 + 员工名单）
  - docs/registry/business-state.md（业务状态占位）
  - AGENTS.md（项目入口）
  完成后汇报: "公司开张完成。CEO: <名字>，员工: <名单>。"

规则:
- 岗位是标准资产（上面的目录），名字是用户资产（CEO 起名）
- 不预设研发仓的名字（如小贾/小全等）
- 每步都报告做了什么，等 CEO 确认再继续
- 装配完成后告知 CEO 公司已开张，可继续创建项目

进度状态规则（重要，防止重复提问）:
- 你必须在对话历史中追踪当前进度：已完成哪些步骤，正在哪一步
- 如果 CEO 已经回答了你的上一个问题（例如回答了名字、选择了岗位），直接推进到下一步，绝不重复提问
- 每轮回复前，先回顾对话历史：如果 CEO 刚提供了信息，把它当作对上一步的回答并继续下一步
- 例如：你在 Step 2 问了名字，CEO 回复任何内容（除了明确说"跳过"），都视为 CEO 的名字，进入 Step 3——不要再次问名字

断点续接规则（REQ-016，最重要）:
- 每轮开始前，先用 Read 工具读取状态文件 ${statePath}
  检查 progress 字段——如果有 progress 且 step 已完成，直接从 progress.step 的下一步继续，不要从头开始
- 每完成一步，用 Write/Edit 更新状态文件 ${statePath} 的 progress 字段:
  progress: { step: "greeted" | "name" | "roles" | "naming" | "confirm" | "assembling" | "done",
              ceoName: "<CEO名字>", selectedRoles: [...], employeeNames: {...} }
- 例如: 上次已问过名字并得到"磨人"，progress.step="name"，本次直接从 Step 3（岗位列表）继续
- 断线重连后（新会话），必须从 progress 恢复，绝不允许重复已完成步骤

名字识别强制规则（Step 2 专用，最重要）:
- CEO 在 Step 2 后回复的任何文本（无论是一个词、两个词、还是短句），**无条件**认定为 CEO 的名字
- 不要怀疑这个名字是否"像名字"、不要解释它的含义、不要把它当成语或闲聊
- 收到名字后，立即回复："好的，<名字>！您将是公司的 CEO。" 然后直接进入 Step 3（岗位列表）
- 禁止：重复欢迎语、重复问名字、把名字当其他含义理解
- 示例：CEO 回复"磨人" → 回复"好的，磨人！您将是公司的 CEO。现在请选择岗位："`;
}

/** Build the onboarding heartbeat agent config (short interval while pending). */
export function buildOnboardingAgent(workspaceRoot: string, model: string, statePath?: string): HeartbeatAgentConfig {
  return {
    agentId: "company-onboarding",
    intervalMs: 60 * 1000, // check every 60s while uninitialized
    model,
    maxTurns: 20,
    systemPrompt: buildOnboardingSystemPrompt(workspaceRoot, statePath),
    userMessage:
      "公司尚未开张。检查当前 onboarding 进度：如果 CEO 已回复，继续引导下一步；如果骨架已装配完成，将公司状态更新为 initialized。",
    // REQ-014b: tools must run in the onboarding workspace, not daemon cwd
    cwd: workspaceRoot,
  };
}
