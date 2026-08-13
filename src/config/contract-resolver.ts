// ── Agent Contract Resolver ──
// 读取 .contract.yaml（路径索引）→ 加载五件套 → 组装 system prompt
// 
// 用途: TriLC 启动时加载所有 agent 定义，运行时根据 agent_id 注入对应身份

import { readFileSync, existsSync, watch } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

// ── Types ──

export interface AgentContract {
  agentId: string;
  family: 'Role' | 'Registry';
  paths: {
    soul: string;
    agent_body: string;
    agent_frontmatter: string;
    memory: string;
    colleagues: string;
    social: string;
  };
  decisionRights: {
    approve: string[];
    freeze: string[];
    escalate: string[];
    forbidden: string[];
  };
  systemPrompt: string;   // 拼接后的完整 system prompt
  toolControl: Record<string, unknown>;  // frontmatter 解析后的工具配置
}

/** Employee roster entry from TriCompany/docs/registry/employee-roster.json. */
export interface EmployeeRosterEntry {
  id: string;
  displayName: string;
  family: 'Role' | 'Registry';
  role: string;
  tier: string;
  reportsTo: string;
  supervises: string[];
  onboardedAt: string;
  status: string;
}

/** Full employee roster document shape. */
export interface EmployeeRoster {
  version: string;
  company: string;
  rosterDate: string;
  totalEmployees: number;
  employees: EmployeeRosterEntry[];
  tiers: Record<string, number>;
  families: Record<string, number>;
}

interface ContractYaml {
  contract: {
    agent_id: string;
    family?: string;
  };
  paths: Record<string, string>;
  decision_rights?: {
    approve?: string[];
    freeze?: string[];
    escalate?: string[];
    forbidden?: string[];
  };
  runtime_baseline?: Record<string, unknown>;
}

// ── Resolver ──

class AgentContractResolver {
  private contracts = new Map<string, AgentContract>();
  private sourceRoot: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private employeeRoster: EmployeeRoster | null = null;

  constructor(sourceRoot: string) {
    this.sourceRoot = resolve(sourceRoot);
  }

  /** 从 source-agents 目录加载所有 .contract.yaml */
  async loadAll(): Promise<number> {
    const contractsDir = resolve(this.sourceRoot);
    if (!existsSync(contractsDir)) {
      console.warn(`[contract-resolver] source root not found: ${contractsDir}`);
      return 0;
    }

    // 遍历子目录查找 .contract.yaml
    const fs = await import('fs/promises');
    const entries = await fs.readdir(contractsDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const contractPath = resolve(contractsDir, entry.name, `${entry.name}.contract.yaml`);
      if (!existsSync(contractPath)) continue;

      try {
        const contract = this.loadOne(contractPath);
        if (contract) {
          this.contracts.set(contract.agentId, contract);
          count++;
        }
      } catch (err) {
        console.warn(`[contract-resolver] failed to load ${contractPath}:`, (err as Error).message);
      }
    }

    console.log(`[contract-resolver] loaded ${count} agent contracts`);
    return count;
  }

  /** 加载单个 contract */
  private loadOne(contractPath: string): AgentContract | null {
    const yamlText = readFileSync(contractPath, 'utf-8');
    const parsed = parseYaml(yamlText) as unknown as ContractYaml;

    const agentId = parsed.contract?.agent_id;
    const family = (parsed.contract?.family as 'Role' | 'Registry') || 'Role';

    if (!agentId || !parsed.paths) {
      console.warn(`[contract-resolver] invalid contract: ${contractPath}`);
      return null;
    }

    // paths 兼容性归一化：colleagues_social（合并字段）→ colleagues + social
    const rawPaths = parsed.paths;
    if (rawPaths.colleagues_social) {
      if (!rawPaths.colleagues) rawPaths.colleagues = rawPaths.colleagues_social;
      if (!rawPaths.social) rawPaths.social = rawPaths.colleagues_social;
    }
    // 确保所有必填字段有默认值，避免 undefined 传入 resolve()
    const paths: Required<AgentContract['paths']> = {
      soul: rawPaths.soul || '',
      agent_body: rawPaths.agent_body || '',
      agent_frontmatter: rawPaths.agent_frontmatter || '',
      memory: rawPaths.memory || '',
      colleagues: rawPaths.colleagues || '',
      social: rawPaths.social || '',
    };

    // 读取五件套（兼容 colleagues_social 合并字段）
    const soul = this.readFileSafe(resolve(this.sourceRoot, paths.soul));
    const agentBody = this.readFileSafe(resolve(this.sourceRoot, paths.agent_body));
    const agentFrontmatter = this.readFileSafe(resolve(this.sourceRoot, paths.agent_frontmatter));
    const memory = this.readFileSafe(resolve(this.sourceRoot, paths.memory));
    const colleagues = this.readFileSafe(resolve(this.sourceRoot, paths.colleagues));
    const social = this.readFileSafe(resolve(this.sourceRoot, paths.social));

    // 组装 system prompt: soul + agent body
    const systemPrompt = [soul, agentBody]
      .filter(Boolean)
      .join('\n\n');

    // 解析 frontmatter 的工具配置
    const explicitToolControl = this.parseFrontmatter(agentFrontmatter);
    const bodyToolControl = this.parseFrontmatter(agentBody);
    const toolControl = Object.keys(explicitToolControl).length > 0
      ? explicitToolControl
      : bodyToolControl;

    // decision_rights
    const decisionRights = {
      approve: (parsed.decision_rights?.approve) || [],
      freeze: (parsed.decision_rights?.freeze) || [],
      escalate: (parsed.decision_rights?.escalate) || [],
      forbidden: (parsed.decision_rights?.forbidden) || [],
    };

    return {
      agentId,
      family,
      paths,
      decisionRights,
      systemPrompt,
      toolControl,
    };
  }

  private readFileSafe(filePath: string): string {
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, 'utf-8');
      }
    } catch { /* ignore */ }
    return '';
  }

  private parseFrontmatter(text: string): Record<string, unknown> {
    if (!text) return {};
    const trimmed = text.trim();
    if (!trimmed) return {};
    let yamlText = trimmed;
    if (trimmed.startsWith('---')) {
      const lines = trimmed.split(/\r?\n/);
      const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
      if (closingIndex < 0) return {};
      yamlText = lines.slice(1, closingIndex).join('\n').trim();
      if (!yamlText) return {};
    }
    try {
      const parsed = parseYaml(yamlText) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  /** 获取 agent 的 system prompt */
  getSystemPrompt(agentId?: string): string | undefined {
    if (!agentId) return undefined;
    return this.contracts.get(agentId)?.systemPrompt;
  }

  /** 获取 agent 的决策权限 */
  getDecisionRights(agentId: string): AgentContract['decisionRights'] | undefined {
    return this.contracts.get(agentId)?.decisionRights;
  }

  /** 获取 agent 的工具控制 */
  getToolControl(agentId: string): Record<string, unknown> | undefined {
    return this.contracts.get(agentId)?.toolControl;
  }

  /** 列出所有已加载的 agent */
  listAgents(): string[] {
    return [...this.contracts.keys()];
  }

  /** 从 TriCompany 路径加载 employee-roster.json。
   *
   * 路径：``<sourceRoot>/docs/registry/employee-roster.json``
   * 如果 roster 文件不存在或解析失败，roster 保持为 null。
   * 返回已解析的 roster 条目数量，或 0（失败时）。
   */
  loadEmployeeRoster(): number {
    const rosterPath = resolve(this.sourceRoot, 'docs', 'registry', 'employee-roster.json');
    if (!existsSync(rosterPath)) {
      console.warn(`[contract-resolver] employee roster not found: ${rosterPath}`);
      return 0;
    }
    try {
      const raw = readFileSync(rosterPath, 'utf-8');
      const parsed = JSON.parse(raw) as EmployeeRoster;
      if (!parsed.employees || !Array.isArray(parsed.employees)) {
        console.warn('[contract-resolver] employee roster has no employees array');
        return 0;
      }
      this.employeeRoster = parsed;
      console.log(`[contract-resolver] loaded ${parsed.employees.length} employee roster entries`);
      return parsed.employees.length;
    } catch (err) {
      console.warn(`[contract-resolver] failed to load employee roster:`, (err as Error).message);
      return 0;
    }
  }

  /** 获取员工在 roster 中的信息。
   *
   * 以 agentId 为键查找 employee roster。
   * 返回 EmployeeRosterEntry，或 undefined（若 roster 未加载或该 agentId 不在 roster 中）。
   */
  getEmployeeInfo(agentId: string): EmployeeRosterEntry | undefined {
    if (!this.employeeRoster) return undefined;
    return this.employeeRoster.employees.find((e) => e.id === agentId);
  }

  /** 返回已加载的 employee roster 的所有条目。
   *
   * 若 roster 尚未加载，返回空数组。
   */
  listEmployees(): EmployeeRosterEntry[] {
    return this.employeeRoster?.employees ?? [];
  }

  /** 监听文件变更并热重载 */
  watchAndReload(): void {
    this.watcher = watch(this.sourceRoot, { recursive: true }, (_event, filename) => {
      if (filename?.endsWith('.contract.yaml') || filename?.endsWith('.agent.md')) {
        console.log(`[contract-resolver] change detected: ${filename}, reloading...`);
        this.loadAll().then(count => {
          console.log(`[contract-resolver] reloaded ${count} contracts`);
        });
      }
    });
  }

  /** 停止监听 */
  dispose(): void {
    this.watcher?.close();
    this.contracts.clear();
  }
}

// ── Singleton ──

let _instance: AgentContractResolver | null = null;

export function getContractResolver(sourceRoot?: string): AgentContractResolver {
  if (!_instance && sourceRoot) {
    _instance = new AgentContractResolver(sourceRoot);
  }
  if (!_instance) {
    throw new Error('Contract resolver not initialized. Call getContractResolver(sourceRoot) first.');
  }
  return _instance;
}

export { AgentContractResolver };
