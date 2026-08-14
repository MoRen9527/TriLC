// ── TriCompany Init FirstCollab 执行体（I5：firstCollab 推进写入面）──
// init-collab-i5-first-collab i5-1 拆解 §五（本树唯一代码增量）：
//
//   POST /internal/v1/init/ready/first-collab（internal localhost-only 面）：
//   - 链态门：chainState == 'ready' 否则 409 { chainState }。
//   - 载荷：{ status: 'triggered' | 'passed', note?: string }。
//   - 合法转移：pending → triggered → passed（passed 需先 triggered，非法
//     转移 409）；重放幂等（同 status 重复提交 no-op 200）。
//   - 推进纪律（i5-1 门禁 7）：仅 updateReady 增量，transitionTo 转移表零
//     改动；两入口（TriPilot/trilc chat）零执行增量，只读呈现 firstCollab。
//
// note 不持久（ReadyPhase 零 schema 字段新增；证据面归 OP 登记与验收执行
// 本 verify/ 留档），仅作载荷契约透传。

import type { InitChain } from './init-chain.js';

export type FirstCollabStatus = 'triggered' | 'passed';

export type FirstCollabUpdateResult =
  | { status: 200; firstCollab: FirstCollabStatus; changed: boolean }
  | { status: 400; error: 'invalid_status' | 'invalid_note'; message: string }
  | { status: 409; chainState: string }
  | { status: 409; illegalTransition: true; current: string; requested: string };

const ORDER: Record<ReadyPhaseFirstCollab, number> = { pending: 0, triggered: 1, passed: 2 };

type ReadyPhaseFirstCollab = 'pending' | FirstCollabStatus;

const NOTE_MAX_LEN = 500;

export async function runFirstCollabUpdate(
  deps: { chain: InitChain },
  requestedStatus: unknown,
  note?: unknown,
): Promise<FirstCollabUpdateResult> {
  // 链态门：仅 ready 生效（409 附当前链态）
  const chainFrame = await deps.chain.load();
  if (chainFrame.chainState !== 'ready') {
    return { status: 409, chainState: chainFrame.chainState };
  }
  // 载荷校验
  if (requestedStatus !== 'triggered' && requestedStatus !== 'passed') {
    return {
      status: 400,
      error: 'invalid_status',
      message: "status must be 'triggered' | 'passed'",
    };
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MAX_LEN)) {
    return {
      status: 400,
      error: 'invalid_note',
      message: `note must be a string of at most ${NOTE_MAX_LEN} chars`,
    };
  }
  const current = chainFrame.phaseDetail.ready.firstCollab;
  const reqIdx = ORDER[requestedStatus];
  const curIdx = ORDER[current];
  // 重放幂等：同 status 重复提交 no-op 200（不写状态、eventSeq 不增长）
  if (reqIdx === curIdx) {
    return { status: 200, firstCollab: requestedStatus, changed: false };
  }
  // 非法转移：回退（triggered→pending、passed→*）与跳级（pending→passed）
  // 一律 409——合法推进只允许恰好 +1 步（pending→triggered / triggered→passed）
  if (reqIdx !== curIdx + 1) {
    return { status: 409, illegalTransition: true, current, requested: requestedStatus };
  }
  // 合法推进：pending→triggered / triggered→passed（仅 updateReady 增量）
  await deps.chain.updateReady({ firstCollab: requestedStatus });
  return { status: 200, firstCollab: requestedStatus, changed: true };
}
