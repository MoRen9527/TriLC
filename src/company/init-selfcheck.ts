// ── Init Selfcheck（五探测 + summary + 防重入）──
// SELFCHECK 端点契约（i1-1 拆解 §四）：四要素 + 第五探测 plane-hint-probe。
//
// 检查面：
//   healthz          GET 本机 /healthz（ok:true）                      fail = blocked（daemon 面）
//   tripilot         被动观察：近 N 分钟 TriPilot 形态任务提交计数      degraded = 面板连通待交互确认
//   trimodel         GET 127.0.0.1:3333/health + key-cache 现状        401 = blocked（唯一认证阻塞类）；网络不可达 = degraded
//   tristaciss       GET 127.0.0.1:8008/v1/models                      fail = degraded（直连 fallback 过渡可用态）
//   plane-hint-probe daemon 内部构造 TriPilot 形态会话（第五探测）     fail = 诊断卡显式红行「问周面路径」（r19 前置缺陷不静默吞）
//
// summary 规则：任一项 fail（blocked 级）→ blocked；仅 degraded → degraded；全 ok → pass。
// 防重入：运行中再触发 → beginSelfcheck 返回 { conflict: true, runId }（端点映射 409）。
//
// 事件流（i1-1 §三）：init:selfcheck-started / init:selfcheck-progress /
// init:selfcheck-finished——全部经注入 publisher（app.ts publish 同通道）。

import { getKeyCacheStatus } from '../config/key-cache.js';
import { localBus, type LocalBusEvent } from '../localbus/bus.js';
import type { InitChain, SelfcheckCheck, SelfcheckSummary } from './init-chain.js';

/** 与 app.ts publish 同通道（localbus 事件族，含 init:* 类型）。 */
export type SelfcheckPublisher = (event: LocalBusEvent) => void;

export interface SelfcheckDeps {
  port: number;
  projectRoot: string;
  chain: InitChain;
  publish: SelfcheckPublisher;
  /** 第五探测构造 TriPilot 形态会话的客户端 systemPrompt（tasks/submit 会追加周平面提示）。 */
  probeSystemPrompt: string;
}

export const SELFCHECK_PROBE_IDS = ['healthz', 'tripilot', 'trimodel', 'tristaciss', 'plane-hint-probe'] as const;

const HTTP_TIMEOUT_MS = 5_000;
const PLANE_HINT_TIMEOUT_MS = 150_000;
const TRIPILOT_WINDOW_MS = 10 * 60 * 1000;

// ── tripilot 被动观察计数（daemon 内存态，tasks/submit 钩子喂入）──

const _submissionLog: number[] = [];

/** tasks/submit 钩子：记录一次 TriPilot 形态任务提交（携带 workspaceRoot 的存活计数）。 */
export function recordTaskSubmission(): void {
  _submissionLog.push(Date.now());
}

export function getRecentSubmissionCount(now: number = Date.now(), windowMs: number = TRIPILOT_WINDOW_MS): number {
  const cutoff = now - windowMs;
  while (_submissionLog.length > 0 && _submissionLog[0] < cutoff) _submissionLog.shift();
  return _submissionLog.length;
}

// ── 防重入 ──

let _activeRunId: string | null = null;

export function isSelfcheckRunning(): boolean {
  return _activeRunId !== null;
}

export function getActiveRunId(): string | null {
  return _activeRunId;
}

/** 测试复位（清运行态 + 提交计数）。 */
export function resetSelfcheckForTest(): void {
  _activeRunId = null;
  _submissionLog.length = 0;
}

// ── summary ──

export function summarize(checks: SelfcheckCheck[]): SelfcheckSummary {
  if (checks.some((c) => c.status === 'fail')) return 'blocked';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'pass';
}

// ── 探测实现 ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Probe = (deps: SelfcheckDeps) => Promise<SelfcheckCheck>;

const probeHealthz: Probe = async (deps) => {
  try {
    const res = await fetch(`http://127.0.0.1:${deps.port}/healthz`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = (await res.json()) as { ok?: boolean; service?: string; uptime?: number };
    if (res.ok && body.ok === true) {
      return { id: 'healthz', status: 'ok', detail: `healthz ok（service=${body.service ?? '?'}，uptime=${body.uptime ?? 0}s）`, hint: '' };
    }
    return { id: 'healthz', status: 'fail', detail: `healthz http ${res.status}`, hint: 'daemon 面异常 — blocked 级' };
  } catch (err) {
    return { id: 'healthz', status: 'fail', detail: `healthz unreachable: ${errMsg(err)}`, hint: 'daemon 面异常 — blocked 级' };
  }
};

const probeTripilot: Probe = async () => {
  const count = getRecentSubmissionCount();
  if (count > 0) {
    return { id: 'tripilot', status: 'ok', detail: `近 10 分钟 ${count} 次 TriPilot 形态任务提交（workspaceRoot 存活计数）`, hint: '' };
  }
  return { id: 'tripilot', status: 'degraded', detail: '近 10 分钟无 TriPilot 形态任务提交', hint: '面板连通待交互确认' };
};

const probeTrimodel: Probe = async () => {
  let reachable = false;
  try {
    const res = await fetch('http://127.0.0.1:3333/health', {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  const ks = getKeyCacheStatus();

  if (!reachable) {
    return { id: 'trimodel', status: 'degraded', detail: '127.0.0.1:3333 网络不可达', hint: '重试降级（模型主路径不可用）' };
  }
  // 401 = 唯一认证阻塞类（§5.2）：key-cache 最近一次 fetch 认证失败
  if (ks.lastFetchError && /401|403|unauthorized/i.test(ks.lastFetchError)) {
    const at = ks.lastFetchAt ? new Date(ks.lastFetchAt).toISOString() : '?';
    // 契约修正⑧（i2-1 §七）：detail 用实际错误串（截断 120），不硬编码「fetch 401」
    const errText = ks.lastFetchError.slice(0, 120);
    return {
      id: 'trimodel',
      status: 'fail',
      detail: `3333 可达；key-cache fetch 认证失败（${errText}，lastFetchAt=${at}）`,
      hint: '认证失败 — blocked 级（TRIMODEL_API_TOKEN 注入面）',
    };
  }
  if (!ks.hasCache) {
    return { id: 'trimodel', status: 'degraded', detail: '3333 可达但 key-cache 为空', hint: '等待首次 key fetch 或检查 token 注入' };
  }
  if (ks.lastFetchError) {
    return {
      id: 'trimodel',
      status: 'degraded',
      detail: `3333 可达；key fetch 非认证失败（${ks.lastFetchError}），缓存 ${ks.providerCount} providers 兜底`,
      hint: '非认证类失败 — 降级继续',
    };
  }
  const expired = ks.expiresAt != null && Date.now() > ks.expiresAt;
  return {
    id: 'trimodel',
    status: 'ok',
    detail: `3333 ok；key-cache ${ks.providerCount} providers${expired ? '（已过期，stale 兜底中）' : ''}`,
    hint: '',
  };
};

const probeTriStaciss: Probe = async () => {
  try {
    const res = await fetch('http://127.0.0.1:8008/v1/models', {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
      return { id: 'tristaciss', status: 'ok', detail: `8008 ok（${ids.length} models）`, hint: '' };
    }
    return { id: 'tristaciss', status: 'degraded', detail: `8008 http ${res.status}`, hint: '直连 fallback 过渡可用态（§5.1 现状）' };
  } catch (err) {
    return { id: 'tristaciss', status: 'degraded', detail: `8008 unreachable: ${errMsg(err)}`, hint: '直连 fallback 过渡可用态（§5.1 现状）' };
  }
};

const PLANE_HINT_QUESTION =
  '请读取公司周面根目录（系统提示中 Company Weekly Plane 的路径），确认当前活动周（status: active 的 OP 索引所在周目录名，如 2026-W33），并回复活动周编号。如果目录不可读或不存在，直接说明原因。';

const probePlaneHint: Probe = async (deps) => {
  const busEvents: Array<{ type: string; taskId?: string; error?: string }> = [];
  const onBusEvent = (e: LocalBusEvent) => {
    if (e.type.startsWith('task:') && 'taskId' in e) {
      busEvents.push({ type: e.type, taskId: (e as { taskId: string }).taskId, error: (e as { error?: string }).error });
    }
  };
  localBus.on('event', onBusEvent);

  let sessionId: string | null = null;
  let streamTerminal: string | null = null;
  let streamError: string | null = null;
  const deltas: string[] = [];

  try {
    // TriPilot 形态：POST tasks/submit 带客户端 systemPrompt + workspaceRoot
    // （daemon 会追加周平面提示 — r4-1 B 族注入路径）
    const submitRes = await fetch(`http://127.0.0.1:${deps.port}/internal/v1/tasks/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: PLANE_HINT_QUESTION,
        systemPrompt: deps.probeSystemPrompt,
        conversationId: `selfcheck-plane-hint-${Date.now().toString(36)}`,
        context: { workspaceRoot: deps.projectRoot },
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!submitRes.ok) {
      return {
        id: 'plane-hint-probe',
        status: 'fail',
        detail: `tasks/submit http ${submitRes.status}`,
        hint: '问周面路径 — 提交面失败（模型链族）',
      };
    }
    const submitBody = (await submitRes.json()) as { sessionId?: string };
    sessionId = submitBody.sessionId ?? null;
    if (!sessionId) {
      return { id: 'plane-hint-probe', status: 'fail', detail: 'tasks/submit 无 sessionId', hint: '问周面路径 — 提交面异常（模型链族）' };
    }

    const streamRes = await fetch(`http://127.0.0.1:${deps.port}/internal/v1/sessions/${sessionId}/stream`, {
      signal: AbortSignal.timeout(PLANE_HINT_TIMEOUT_MS),
    });
    if (!streamRes.ok || !streamRes.body) {
      return {
        id: 'plane-hint-probe',
        status: 'fail',
        detail: `stream http ${streamRes.status}`,
        hint: '问周面路径 — 事件流不可达（模型链族）',
      };
    }
    const text = await streamRes.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      let event = '';
      let data = '';
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!event || !data) continue;
      if (event === 'delta') {
        try { deltas.push((JSON.parse(data) as { content?: string }).content ?? ''); } catch { /* skip */ }
      } else if (event === 'task_done') {
        streamTerminal = 'task_done';
      } else if (event === 'task_error') {
        streamTerminal = 'task_error';
        try { streamError = (JSON.parse(data) as { error?: string }).error ?? null; } catch { /* skip */ }
      }
    }
  } finally {
    localBus.off('event', onBusEvent);
  }

  const ev = (t: string) => busEvents.filter((e) => e.type === t && (!sessionId || e.taskId === sessionId));
  const failedCount = ev('task:failed').length;
  const succeededCount = ev('task:succeeded').length;

  if (failedCount > 0 || streamTerminal === 'task_error') {
    const errText = ev('task:failed')[0]?.error ?? streamError ?? 'unknown';
    const family = /401|403|auth|key|token/i.test(errText)
      ? '模型链族（认证/key 面）'
      : '模型链族';
    return {
      id: 'plane-hint-probe',
      status: 'fail',
      detail: `问周面路径：任务失败（${errText.slice(0, 120)}）`,
      hint: `分类=${family} — r19 前置缺陷显式红行`,
    };
  }
  if (succeededCount === 0 || streamTerminal !== 'task_done') {
    return {
      id: 'plane-hint-probe',
      status: 'fail',
      detail: `问周面路径：未达 succeeded（bus task:succeeded=${succeededCount}，sse=${streamTerminal ?? 'none'}）`,
      hint: '分类=模型链族/渲染族待判 — r19 前置缺陷显式红行',
    };
  }
  const answer = deltas.join('');
  if (!answer.trim()) {
    return {
      id: 'plane-hint-probe',
      status: 'fail',
      detail: '问周面路径：任务成功但零答复内容（空答复伪成功）',
      hint: '分类=模型链族（A3 伪成功面） — r19 前置缺陷显式红行',
    };
  }
  return {
    id: 'plane-hint-probe',
    status: 'ok',
    detail: `问周面冒烟 PASS（答复 ${answer.length} 字符，bus queued→running→succeeded，无 task:failed）`,
    hint: '',
  };
};

const PROBES: Probe[] = [probeHealthz, probeTripilot, probeTrimodel, probeTriStaciss, probePlaneHint];

// ── 执行 ──

async function executeSelfcheck(runId: string, deps: SelfcheckDeps): Promise<void> {
  try {
    deps.publish({ type: 'init:selfcheck-started', runId, checks: [...SELFCHECK_PROBE_IDS] });
    const checks: SelfcheckCheck[] = [];
    for (const probe of PROBES) {
      const result = await probe(deps);
      checks.push(result);
      deps.publish({ type: 'init:selfcheck-progress', runId, checkId: result.id, status: result.status, detail: result.detail });
    }
    const summary = summarize(checks);
    const finishedAt = new Date().toISOString();
    const prev = (await deps.chain.load()).phaseDetail.selfcheck;
    await deps.chain.updateSelfcheck({ runId, summary, checks, finishedAt, retryCount: prev.retryCount + 1 });
    deps.publish({ type: 'init:selfcheck-finished', runId, summary, report: checks });
    // I2 A' 裁决（CTO 2026-08-14）：自检完结（pass/degraded）→ 自动推进 onboarding。
    // 发布顺序 = selfcheck-finished（绿/红卡汇总）先、chain-changed（阶段切换）后——
    // 入口先看自检结果，再切选择界面；chain-changed 仍是两入口渲染阶段切换的唯一依据。
    // blocked → 不推进（诊断卡保留，重跑自检幂等）；getState()==='selfcheck' 条件
    // 本身即幂等守卫（onboarding 态重跑自检无转移无事件）。
    if ((summary === 'pass' || summary === 'degraded') && deps.chain.getState() === 'selfcheck') {
      await deps.chain.transitionTo('onboarding', 'daemon');
    }
  } finally {
    _activeRunId = null;
  }
}

/**
 * 触发一次自检（防重入）：运行中 → { conflict: true, runId }（端点映射 409）；
 * 空闲 → 202 { runId }，探测异步执行、经 init:selfcheck-* 事件流发布。
 */
export function beginSelfcheck(deps: SelfcheckDeps): { conflict: boolean; runId: string } {
  if (_activeRunId !== null) {
    return { conflict: true, runId: _activeRunId };
  }
  const runId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  _activeRunId = runId;
  void executeSelfcheck(runId, deps).catch((err) => {
    console.error('[trilc:init] selfcheck run failed:', errMsg(err));
  });
  return { conflict: false, runId };
}
