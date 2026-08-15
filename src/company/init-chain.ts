// ── TriCompany Init Chain State Machine ──
// 链路进度状态机（七态）：UNINITIALIZED → SELFCHECK → ONBOARDING →
// PROJECT-LINK → SYNC → CONFIRM → READY（i1-1 拆解 §二）。
//
// 与公司态 CompanyInitState（state.json）分离独立持久（护栏）：
//   链路态 = {dataDir}/company/init-chain.json（显示快照 + 引用）
//   公司态 = {dataDir}/company/state.json（写真源归各域）
// phaseDetail 各阶段只存指针与快照，不复制真源。
//
// 持久化契约：
//   - 真 tmp→rename 原子写（写 tmp → rename 覆盖 → 校验读回）
//   - eventSeq 单调递增；lastUpdatedAt 每次写刷新
//   - 无任何 git 操作（init-state.ts REQ-019 git add -A 隐患不复制）
//   - 断点续跑：daemon 启动 load 恢复帧（I1 交付机制，续跑动作主体归后续树）
//
// 事件流契约（i1-1 §三）：init:chain-changed 由 transitionTo 发布，载荷
// { chainState, from, to, eventSeq, sourceEntry }——与状态文件同帧投影，
// eventSeq 与状态文件一致。事件发布通过注入的 publisher（app.ts publish）。

import { mkdir, readFile, writeFile, rename, access, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { LocalBusEvent } from '../localbus/bus.js';

// ── Types（schema 按 i1-1 拆解 §二）──

export type ChainState =
  | 'uninitialized'
  | 'selfcheck'
  | 'onboarding'
  | 'project-link'
  | 'sync'
  | 'confirm'
  | 'ready';

export type SourceEntry = 'tripilot' | 'trilc-chat' | 'daemon' | null;

export type SelfcheckSummary = 'pass' | 'degraded' | 'blocked';
export type CheckStatus = 'ok' | 'fail' | 'degraded' | 'skipped';

export interface SelfcheckCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  hint: string;
}

export interface SelfcheckPhase {
  runId: string | null;
  summary: SelfcheckSummary | null;
  checks: SelfcheckCheck[];
  finishedAt: string | null;
  retryCount: number;
}

export interface OnboardingPhase {
  step: string | null;
  /** 写真源引用：公司域 = state.json progress（不复制真源）。 */
  ref: string;
}

export interface ProjectLinkPhase {
  status: 'pending' | 'linking' | 'linked' | 'skipped';
  source: string | null;
  projectKey: string | null;
  worktreePath: string | null;
}

export interface SyncPhase {
  status: 'pending' | 'pushed' | 'applied' | 'failed';
  bundleId: string | null;
}

export interface ConfirmPhase {
  status: 'pending' | 'confirmed';
  l1: string | null;
  l2: string | null;
  l3: string | null;
}

export interface ReadyPhase {
  firstCollab: 'pending' | 'triggered' | 'passed';
}

export interface PhaseDetail {
  selfcheck: SelfcheckPhase;
  onboarding: OnboardingPhase;
  'project-link': ProjectLinkPhase;
  sync: SyncPhase;
  confirm: ConfirmPhase;
  ready: ReadyPhase;
}

export interface InitChainFile {
  schemaVersion: 1;
  chainState: ChainState;
  phaseDetail: PhaseDetail;
  lastTransitionAt: string | null;
  lastUpdatedAt: string | null;
  eventSeq: number;
  sourceEntry: SourceEntry;
}

// ── 状态机 ──

export const CHAIN_STATES: readonly ChainState[] = [
  'uninitialized',
  'selfcheck',
  'onboarding',
  'project-link',
  'sync',
  'confirm',
  'ready',
];

/** 合法转移表：线性前进单步；其余（回退/跳级/自环）一律非法。 */
const TRANSITIONS: Record<ChainState, ChainState[]> = {
  uninitialized: ['selfcheck'],
  selfcheck: ['onboarding'],
  onboarding: ['project-link'],
  'project-link': ['sync'],
  sync: ['confirm'],
  confirm: ['ready'],
  ready: [],
};

export function isValidTransition(from: ChainState, to: ChainState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ── 默认帧 ──

export function defaultPhaseDetail(): PhaseDetail {
  return {
    selfcheck: { runId: null, summary: null, checks: [], finishedAt: null, retryCount: 0 },
    onboarding: { step: null, ref: 'company/state.json#progress' },
    'project-link': { status: 'pending', source: null, projectKey: null, worktreePath: null },
    sync: { status: 'pending', bundleId: null },
    confirm: { status: 'pending', l1: null, l2: null, l3: null },
    ready: { firstCollab: 'pending' },
  };
}

export function defaultChainFile(): InitChainFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    chainState: 'uninitialized',
    phaseDetail: defaultPhaseDetail(),
    lastTransitionAt: null,
    lastUpdatedAt: now,
    eventSeq: 0,
    sourceEntry: null,
  };
}

// ── 事件发布 ──

/** 与 app.ts publish 同通道（localbus 事件族，含 init:* 类型）。 */
export type InitChainPublisher = (event: LocalBusEvent) => void;

// ── InitChain ──

export class InitChain {
  private statePath: string;
  private cache: InitChainFile | null = null;
  private publishFn: InitChainPublisher | null = null;

  constructor(dataDir: string, opts?: { onEvent?: InitChainPublisher }) {
    this.statePath = resolve(dataDir, 'company', 'init-chain.json');
    this.publishFn = opts?.onEvent ?? null;
  }

  /**
   * 断点续跑 load（I1 前置强制项③已落地，i2-1 拆解 §六）：
   * - ENOENT（首次启动正常缺失）= 静默默认帧（不产噪音日志）；
   * - JSON 解析错 = 复制损坏现场至 ${statePath}.corrupt + console.error + 默认帧
   *   （daemon 不因损坏文件崩溃启动，零强制原则）。
   */
  async load(): Promise<InitChainFile> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      await access(this.statePath);
      raw = await readFile(this.statePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[trilc:init] init-chain load access failed: ${(err as Error).message}`);
      }
      this.cache = defaultChainFile();
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<InitChainFile>;
      // 帧补齐：旧/缺字段回填默认（前向兼容）
      this.cache = {
        ...defaultChainFile(),
        ...parsed,
        schemaVersion: 1,
        phaseDetail: { ...defaultPhaseDetail(), ...(parsed.phaseDetail ?? {}) },
        chainState: CHAIN_STATES.includes(parsed.chainState as ChainState)
          ? (parsed.chainState as ChainState)
          : 'uninitialized',
      };
    } catch (err) {
      const corruptPath = `${this.statePath}.corrupt`;
      try {
        await access(corruptPath);
        console.error(
          `[trilc:init] init-chain.json parse failed (existing ${corruptPath} kept): ${(err as Error).message}`,
        );
      } catch {
        try {
          await copyFile(this.statePath, corruptPath);
          console.error(
            `[trilc:init] init-chain.json parse failed — copied to ${corruptPath}: ${(err as Error).message}`,
          );
        } catch (backupErr) {
          console.error(
            `[trilc:init] init-chain.json parse failed (corrupt backup failed too): ${(err as Error).message} / ${(backupErr as Error).message}`,
          );
        }
      }
      this.cache = defaultChainFile();
    }
    return this.cache;
  }

  /** 当前链态（需先 load）。 */
  getState(): ChainState {
    if (!this.cache) throw new Error('InitChain not loaded — call load() first');
    return this.cache.chainState;
  }

  /** 状态文件帧快照。 */
  getSnapshot(): InitChainFile {
    if (!this.cache) throw new Error('InitChain not loaded — call load() first');
    return { ...this.cache, phaseDetail: JSON.parse(JSON.stringify(this.cache.phaseDetail)) };
  }

  /** 真 tmp→rename 原子写 + 校验读回；eventSeq 单调递增。 */
  private async persist(next: InitChainFile): Promise<void> {
    const current = this.cache ?? (await this.load());
    if (next.eventSeq <= current.eventSeq) {
      throw new Error(`eventSeq not monotonic: ${next.eventSeq} <= ${current.eventSeq}`);
    }
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    // 真原子写：tmp 直写 → rename 覆盖（与 init-state.ts 的「tmp 直写 + 目标直写
    // + 删 tmp」假原子写区分——那是公司态已知缺陷，链路态不复刻）
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await rename(tmp, this.statePath);
    // 校验读回：rename 生效 + 内容一致，否则抛错（不静默吞写坏）
    const readBack = JSON.parse(await readFile(this.statePath, 'utf-8')) as InitChainFile;
    if (readBack.eventSeq !== next.eventSeq || readBack.chainState !== next.chainState) {
      throw new Error('init-chain persist verification failed: read-back mismatch');
    }
    this.cache = next;
  }

  /**
   * 状态转移：合法性校验 → eventSeq+1 → 原子持久 → 发布 init:chain-changed。
   * 事件载荷 = 状态文件帧投影，eventSeq 与状态文件一致（i1-1 §三）。
   * I1 真实动作仅 uninitialized→selfcheck；其余转移供后续树端点驱动。
   */
  async transitionTo(next: ChainState, entry: SourceEntry): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    if (!isValidTransition(current.chainState, next)) {
      throw new Error(`invalid init-chain transition: ${current.chainState} → ${next}`);
    }
    const now = new Date().toISOString();
    const eventSeq = current.eventSeq + 1;
    const frame: InitChainFile = {
      ...current,
      chainState: next,
      lastTransitionAt: now,
      lastUpdatedAt: now,
      eventSeq,
      sourceEntry: entry,
    };
    await this.persist(frame);
    this.publishFn?.({
      type: 'init:chain-changed',
      chainState: next,
      from: current.chainState,
      to: next,
      eventSeq,
      sourceEntry: entry,
    });
    return frame;
  }

  /**
   * selfcheck 阶段快照回写（探测完成后调用；非状态转移，不发 chain-changed）。
   * phaseDetail 只存显示快照；写真源仍归各域。
   */
  async updateSelfcheck(patch: Partial<SelfcheckPhase>): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...current,
      phaseDetail: {
        ...current.phaseDetail,
        selfcheck: { ...current.phaseDetail.selfcheck, ...patch },
      },
      lastUpdatedAt: now,
      eventSeq: current.eventSeq + 1,
    };
    await this.persist(frame);
    return frame;
  }

  /**
   * project-link 阶段快照回写（I3 link/claim 成功路径调用；非状态转移，不发
   * chain-changed）。phaseDetail 只存显示快照；写真源（注册点 worktrees）归
   * project-registry。护栏例外允许：init-chain.ts 仅此方法为 I3 增量。
   */
  async updateProjectLink(patch: Partial<ProjectLinkPhase>): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...current,
      phaseDetail: {
        ...current.phaseDetail,
        'project-link': { ...current.phaseDetail['project-link'], ...patch },
      },
      lastUpdatedAt: now,
      eventSeq: current.eventSeq + 1,
    };
    await this.persist(frame);
    return frame;
  }

  /**
   * sync 阶段快照回写（I4 sync/run 成功路径调用；非状态转移，不发
   * chain-changed）。phaseDetail 只存指针快照；写真源（bundle 文件）归
   * 项目仓 docs/registry/init-sync/。护栏例外允许：init-chain.ts 仅此方法
   * 与 updateConfirm 为 I4 增量（SyncPhase/ConfirmPhase 字段已预留，零
   * schema 字段新增——门禁 2 同规）。
   */
  async updateSync(patch: Partial<SyncPhase>): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...current,
      phaseDetail: {
        ...current.phaseDetail,
        sync: { ...current.phaseDetail.sync, ...patch },
      },
      lastUpdatedAt: now,
      eventSeq: current.eventSeq + 1,
    };
    await this.persist(frame);
    return frame;
  }

  /**
   * confirm 阶段快照回写（Phase D 确认卡使用；非状态转移，不发
   * chain-changed）。零 schema 字段新增（ConfirmPhase 已预留）。
   */
  async updateConfirm(patch: Partial<ConfirmPhase>): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...current,
      phaseDetail: {
        ...current.phaseDetail,
        confirm: { ...current.phaseDetail.confirm, ...patch },
      },
      lastUpdatedAt: now,
      eventSeq: current.eventSeq + 1,
    };
    await this.persist(frame);
    return frame;
  }

  /**
   * ready 阶段 firstCollab 推进回写（I5 first-collab 端点使用；非状态转移，
   * 不发 chain-changed）。零 schema 字段新增（ReadyPhase 已预留，门禁 7：
   * 仅此方法为 I5 增量，transitionTo 转移表零改动）。
   */
  async updateReady(patch: Partial<ReadyPhase>): Promise<InitChainFile> {
    const current = this.cache ?? (await this.load());
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...current,
      phaseDetail: {
        ...current.phaseDetail,
        ready: { ...current.phaseDetail.ready, ...patch },
      },
      lastUpdatedAt: now,
      eventSeq: current.eventSeq + 1,
    };
    await this.persist(frame);
    return frame;
  }

  /** status 端点载荷（i1-1 §四契约字段：两入口只读投影 + 诊断卡数据源）。 */
  toStatusPayload(debugMode: boolean = false): {
    schemaVersion: 1;
    chainState: ChainState;
    phaseDetail: PhaseDetail;
    lastTransitionAt: string | null;
    eventSeq: number;
    sourceEntry: SourceEntry;
    /** Debug mode flag（TRILC_DEBUG=1），解锁 reset 端点 + UI 控制。 */
    debugMode: boolean;
    /** 是否可 reset（= debugMode）。 */
    canReset: boolean;
  } {
    const snap = this.getSnapshot();
    return {
      schemaVersion: 1,
      chainState: snap.chainState,
      phaseDetail: snap.phaseDetail,
      lastTransitionAt: snap.lastTransitionAt,
      eventSeq: snap.eventSeq,
      sourceEntry: snap.sourceEntry,
      debugMode,
      canReset: debugMode,
    };
  }

  /**
   * Debug reset: 任意链态 → uninitialized（绕过转移表）。
   * 清理面 = 运行态 + 装配产物白名单反查 + 可选项目关联。
   * 护栏: 仅当 TRILC_DEBUG=1 时调用（app.ts 端点层检查）。
   *
   * 复用 dev-reset-init.mjs 验证过的清理白名单 + 占位保护逻辑。
   */
  async reset(opts: { includeProject?: boolean; workspaceRoot?: string }): Promise<{
    chainState: 'selfcheck';
    cleared: string[];
  }> {
    const dataDir = dirname(this.statePath);
    const workspaceRoot = opts.workspaceRoot ?? process.cwd();
    const cleared: string[] = [];

    // ① 读取现有 state.json 提取 employees（如存在）
    let employees: string[] = [];
    const statePath = resolve(dataDir, 'company', 'state.json');
    try {
      await access(statePath);
      const raw = await readFile(statePath, 'utf-8');
      const state = JSON.parse(raw) as { employees?: Array<{ role: string }> };
      if (Array.isArray(state.employees)) {
        employees = state.employees.map((e) => e.role);
      }
    } catch { /* state.json 不存在或损坏 → 跳过 */ }

    // ② 清运行态文件（2026-08-15 竞态修复：init-chain.json 不 unlink——由 ⑤ 原子覆写；
    // unlink 开「文件不存在窗口」→ 并发 load() 命中 catch 写回 default uninitialized 帧，
    // 覆盖 reset 的 selfcheck 终态——CEO 手测「重置后自检卡不出现」根因）
    const chainPath = resolve(dataDir, 'company', 'init-chain.json');
    for (const f of [statePath]) {
      try {
        await access(f);
        await import('node:fs/promises').then(({ unlink }) => unlink(f));
        cleared.push(f);
      } catch { /* 文件不存在 → 跳过 */ }
    }

    // ③ 清装配产物（精确白名单：按 employees 反查）
    const artifacts = [
      ...employees.map((r) => resolve(workspaceRoot, '.claude', 'agents', `${r}.md`)),
      resolve(workspaceRoot, 'docs', 'registry', 'company-state.json'),
    ];
    for (const f of artifacts) {
      try {
        await access(f);
        await import('node:fs/promises').then(({ unlink }) => unlink(f));
        cleared.push(f);
      } catch { /* 文件不存在 → 跳过 */ }
    }

    // 占位文件：仅装配占位特征（小文件 + 标记词）才删
    for (const f of [
      resolve(workspaceRoot, 'AGENTS.md'),
      resolve(workspaceRoot, 'docs', 'registry', 'business-state.md'),
    ]) {
      try {
        await access(f);
        let content = '';
        try {
          content = await readFile(f, 'utf-8');
        } catch { continue; }
        const isPlaceholder = content.length < 1024 && /TriCade|TriMetaverse|占位|placeholder/i.test(content);
        if (isPlaceholder) {
          await import('node:fs/promises').then(({ unlink }) => unlink(f));
          cleared.push(f);
        } else {
          console.log(`[trilc:init] reset: 保留（非占位，真实内容）: ${f}`);
        }
      } catch { /* 文件不存在 → 跳过 */ }
    }

    // ④ 项目关联（可选）
    if (opts.includeProject) {
      const projectRegPath = resolve(dataDir, 'project-registry.json');
      try {
        await access(projectRegPath);
        await import('node:fs/promises').then(({ unlink }) => unlink(projectRegPath));
        cleared.push(projectRegPath);
      } catch { /* 文件不存在 → 跳过 */ }
    }

    // ⑤ 重写 init-chain.json 为 defaultChainFrame()
    this.cache = null; // 清缓存以便重新加载
    const now = new Date().toISOString();
    const frame: InitChainFile = {
      ...defaultChainFile(),
      // 2026-08-15：直接落 selfcheck（等价 daemon 启动转移语义）——落 uninitialized 呈现层隐藏卡片
      chainState: 'selfcheck',
      lastTransitionAt: now,
      lastUpdatedAt: now,
      eventSeq: 1,
    };
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(frame, null, 2), 'utf-8');
    await rename(tmp, this.statePath);
    this.cache = frame;

    // ⑥ 发布 init:chain-changed 事件
    this.publishFn?.({
      type: 'init:chain-changed',
      chainState: 'selfcheck',
      from: 'uninitialized',
      to: 'selfcheck',
      eventSeq: 1,
      sourceEntry: 'daemon',
    });

    // ⑦ 返回清理清单
    return { chainState: 'selfcheck', cleared };
  }
}
