// ── Agent Contract Resolver ──
// 读取 .contract.yaml（路径索引）→ 加载五件套 → 组装 system prompt
// 
// 用途: TriLC 启动时加载所有 agent 定义，运行时根据 agent_id 注入对应身份

import { readFileSync, existsSync, watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Types ──

export interface AgentContract {
  agentId: string;
  family: 'Role' | 'Registry';
  paths: {
    soul: string;
    agent_body: string;
    agent_frontmatter: string;
    memory: string;
    colleagues_social: string;
  };
  decisionRights: {
    approve: string[];
    freeze: string[];
    escalate: string[];
  };
  systemPrompt: string;   // 拼接后的完整 system prompt
  toolControl: Record<string, unknown>;  // frontmatter 解析后的工具配置
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
  };
  runtime_baseline?: Record<string, unknown>;
}

// ── YAML 解析（minimal，无外部依赖） ──

function parseYamlMinimal(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let currentKey = '';
  let currentIndent = 0;
  let currentList: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      currentList.push(trimmed.substring(2).trim());
      continue;
    }

    // flush list if present
    if (currentList.length > 0 && currentKey) {
      setNestedValue(result, currentKey, [...currentList]);
      currentList = [];
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    const value = trimmed.substring(colonIdx + 1).trim();

    if (indent <= currentIndent || !currentKey) {
      currentKey = key;
      currentIndent = indent;

      if (value === '' || value === '{}') {
        // nested object, handled by sub-keys
      } else if (value.startsWith('"') && value.endsWith('"')) {
        result[key] = value.slice(1, -1);
      } else {
        result[key] = value;
      }
    }
  }

  // flush remaining list
  if (currentList.length > 0 && currentKey) {
    setNestedValue(result, currentKey, [...currentList]);
  }

  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key: string) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

// ── Resolver ──

class AgentContractResolver {
  private contracts = new Map<string, AgentContract>();
  private sourceRoot: string;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
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
    const parsed = parseYamlMinimal(yamlText) as unknown as ContractYaml;

    const contractDir = dirname(contractPath);
    const agentId = parsed.contract?.agent_id;
    const family = (parsed.contract?.family as 'Role' | 'Registry') || 'Role';

    if (!agentId || !parsed.paths) {
      console.warn(`[contract-resolver] invalid contract: ${contractPath}`);
      return null;
    }

    // 读取五件套
    const soul = this.readFileSafe(resolve(contractDir, parsed.paths.soul || ''));
    const agentBody = this.readFileSafe(resolve(contractDir, parsed.paths.agent_body || ''));
    const agentFrontmatter = this.readFileSafe(resolve(contractDir, parsed.paths.agent_frontmatter || ''));
    const memory = this.readFileSafe(resolve(contractDir, parsed.paths.memory || ''));
    const colleaguesSocial = this.readFileSafe(resolve(contractDir, parsed.paths.colleagues_social || ''));

    // 组装 system prompt: soul + agent body
    const systemPrompt = [soul, agentBody]
      .filter(Boolean)
      .join('\n\n');

    // 解析 frontmatter 的工具配置
    const toolControl = this.parseFrontmatter(agentFrontmatter);

    // decision_rights
    const decisionRights = {
      approve: (parsed.decision_rights?.approve) || [],
      freeze: (parsed.decision_rights?.freeze) || [],
      escalate: (parsed.decision_rights?.escalate) || [],
    };

    return {
      agentId,
      family,
      paths: parsed.paths as AgentContract['paths'],
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
    try {
      return parseYamlMinimal(text);
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
