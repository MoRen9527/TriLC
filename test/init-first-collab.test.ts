// ── Init FirstCollab 执行体单测（i5-2 任务 C）──
// i5-1 §五 契约四例：链态门 409 / 合法转移 pending→triggered→passed /
// 非法转移拒绝（跳级 + 回退）/ 重放幂等（no-op 200 不写状态）。
// 附加：载荷校验（invalid_status / note 超长）。零 schema 新增 +
// transitionTo 转移表零改动（门禁 7）。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InitChain } from '../src/company/init-chain.js';
import { runFirstCollabUpdate } from '../src/company/init-first-collab.js';

let tmpRoot: string;
let chain: InitChain;

/** 线性推进到目标链态（ready = 七态末端）。 */
async function chainTo(state: 'confirm' | 'ready'): Promise<void> {
  const order = ['uninitialized', 'selfcheck', 'onboarding', 'project-link', 'sync', 'confirm', 'ready'] as const;
  await chain.load();
  for (const s of order) {
    if (chain.getState() === state) return;
    if (s === 'uninitialized') continue;
    await chain.transitionTo(s, 'daemon');
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trilc-init-firstcollab-'));
  chain = new InitChain(path.join(tmpRoot, 'data'));
});

describe('runFirstCollabUpdate — 链态门', () => {
  it('非 ready 链态 → 409 { chainState }', async () => {
    await chainTo('confirm');
    const result = await runFirstCollabUpdate({ chain }, 'triggered');
    assert.deepEqual(result, { status: 409, chainState: 'confirm' });
    // 未写任何状态：firstCollab 仍 pending
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'pending');
  });
});

describe('runFirstCollabUpdate — 合法转移', () => {
  it('pending→triggered→passed 逐级推进（200 changed:true + 快照落盘）', async () => {
    await chainTo('ready');
    const t1 = await runFirstCollabUpdate({ chain }, 'triggered');
    assert.deepEqual(t1, { status: 200, firstCollab: 'triggered', changed: true });
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'triggered');
    const t2 = await runFirstCollabUpdate({ chain }, 'passed');
    assert.deepEqual(t2, { status: 200, firstCollab: 'passed', changed: true });
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'passed');
    // 链态保持 ready（非状态转移，transitionTo 零改动）
    assert.equal(chain.getState(), 'ready');
  });
});

describe('runFirstCollabUpdate — 非法转移拒绝', () => {
  it('跳级 pending→passed → 409 illegalTransition', async () => {
    await chainTo('ready');
    const result = await runFirstCollabUpdate({ chain }, 'passed');
    assert.deepEqual(result, {
      status: 409,
      illegalTransition: true,
      current: 'pending',
      requested: 'passed',
    });
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'pending');
  });

  it('回退 passed→triggered → 409 illegalTransition', async () => {
    await chainTo('ready');
    await runFirstCollabUpdate({ chain }, 'triggered');
    await runFirstCollabUpdate({ chain }, 'passed');
    const result = await runFirstCollabUpdate({ chain }, 'triggered');
    assert.deepEqual(result, {
      status: 409,
      illegalTransition: true,
      current: 'passed',
      requested: 'triggered',
    });
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'passed');
  });
});

describe('runFirstCollabUpdate — 重放幂等', () => {
  it('同 status 重复提交 → 200 changed:false（不写状态、eventSeq 不增长）', async () => {
    await chainTo('ready');
    await runFirstCollabUpdate({ chain }, 'triggered');
    const seqBefore = chain.getSnapshot().eventSeq;
    const result = await runFirstCollabUpdate({ chain }, 'triggered');
    assert.deepEqual(result, { status: 200, firstCollab: 'triggered', changed: false });
    const snap = chain.getSnapshot();
    assert.equal(snap.phaseDetail.ready.firstCollab, 'triggered');
    assert.equal(snap.eventSeq, seqBefore); // no-op 不写状态
  });
});

describe('runFirstCollabUpdate — 载荷校验', () => {
  it('非法 status → 400 invalid_status；note 超长 → 400 invalid_note', async () => {
    await chainTo('ready');
    const bad = await runFirstCollabUpdate({ chain }, 'confirmed');
    assert.equal(bad.status, 400);
    if (bad.status === 400) assert.equal(bad.error, 'invalid_status');
    const longNote = await runFirstCollabUpdate({ chain }, 'triggered', 'x'.repeat(501));
    assert.equal(longNote.status, 400);
    if (longNote.status === 400) assert.equal(longNote.error, 'invalid_note');
    assert.equal(chain.getSnapshot().phaseDetail.ready.firstCollab, 'pending');
  });
});
