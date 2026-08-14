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

  /** status 端点载荷（i1-1 §四契约字段：两入口只读投影 + 诊断卡数据源）。 */
  toStatusPayload(): {
    schemaVersion: 1;
    chainState: ChainState;
    phaseDetail: PhaseDetail;
    lastTransitionAt: string | null;
    eventSeq: number;
    sourceEntry: SourceEntry;
  } {
    const snap = this.getSnapshot();
    return {
      schemaVersion: 1,
      chainState: snap.chainState,
      phaseDetail: snap.phaseDetail,
      lastTransitionAt: snap.lastTransitionAt,
      eventSeq: snap.eventSeq,
      sourceEntry: snap.sourceEntry,
    };
  }
}
