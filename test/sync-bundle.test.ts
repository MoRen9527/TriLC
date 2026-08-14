// ── Sync Bundle 契约纯函数单测（i4-2 Phase C #12 前半）──
// schema 校验矩阵（密钥字段递归拒绝 + keys 白名单 + 降级段）、指纹、
// 单调性、序列化泄漏扫描断言（测试门禁②）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoSecretMaterial,
  buildGeneratedBy,
  computeContentHash,
  computeDimsContentHash,
  computeKeyFingerprint,
  findSecretField,
  nextGeneratedAt,
  scanSecretMaterial,
  validateSyncBundle,
  type SyncBundle,
} from '../src/company/sync-bundle.js';

function validBundle(): SyncBundle {
  return {
    schemaVersion: 1,
    bundleId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    generatedAt: '2026-08-14T10:00:00.000Z',
    generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
    company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
    model: {
      defaultModel: 'tmv-deepseek-v4-pro',
      catalog: [{ id: 'tmv-deepseek-v4-pro', provider: 'deepseek', capabilities: ['chat'] }],
      providers: [{ provider: 'deepseek', baseUrl: 'http://127.0.0.1:3333/v1', port: 3333 }],
    },
    keys: {
      providers: [{ provider: 'deepseek', ready: true, fingerprint: 'a1b2c3d4' }],
      refreshIntervalS: 900,
      fetchedAt: '2026-08-14T09:59:00.000Z',
    },
    employees: {
      roster: [{ roleId: 'chief-technology-officer', name: '小狄' }],
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    project: {
      projectKey: 'trimetaverse',
      repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
      defaultBranch: 'dev',
      worktrees: [{ path: 'D:/Code/ai/TriMetaverse', branch: 'dev' }],
      devHead: 'fedcba9876543210fedcba9876543210fedcba98',
    },
  };
}

describe('sync-bundle schema 校验（生成端拒绝密钥材料）', () => {
  it('accepts valid bundle + 单维降级段', () => {
    assert.equal(validateSyncBundle(validBundle()).ok, true);
    const degraded = validBundle();
    degraded.model = { status: 'unavailable', reason: 'TriModel unreachable' };
    assert.equal(validateSyncBundle(degraded).ok, true);
  });

  it('拒绝 api_key / apiKey / secret / token 任意深度非空字符串值', () => {
    assert.equal(validateSyncBundle({ ...validBundle(), api_key: 'sk-top' }).ok, false);
    const b = validBundle();
    (b.model as unknown as { nested: unknown }).nested = { apiKey: 'sk-camel' };
    assert.equal(validateSyncBundle(b).ok, false);
    const b2 = validBundle();
    b2.employees.roster.push({ roleId: 'x', name: 'y', token: 'tk-1' } as never);
    assert.equal(validateSyncBundle(b2).ok, false);
    const b3 = validBundle();
    (b3.keys as unknown as { providers: Array<{ secret: string }> }).providers[0].secret = 's3';
    assert.equal(validateSyncBundle(b3).ok, false);
  });

  it('keys 维白名单：额外字段拒绝（防滑变）', () => {
    const b = validBundle();
    b.keys.providers[0] = { ...b.keys.providers[0], apiKeyPlain: 'x' } as never;
    const v = validateSyncBundle(b);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.message, /not whitelisted/);
  });

  it('findSecretField 只拒绝非空字符串值（契约口径）', () => {
    assert.equal(findSecretField({ a: { api_key: '' } }, '$'), null);
    assert.equal(findSecretField({ a: { token: 42 } }, '$'), null);
    assert.equal(findSecretField({ a: { api_key: 'sk-x' } }, '$'), '$.a.api_key');
  });
});

describe('sync-bundle 指纹 / 哈希 / 单调性', () => {
  it('fingerprint = sha256(material).slice(0,8)，确定性且不含材料', () => {
    const material = 'sk-very-secret-material-abc123';
    const fp = computeKeyFingerprint(material);
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.ok(!fp.includes('sk-'));
    assert.equal(computeKeyFingerprint(material), fp);
    assert.notEqual(computeKeyFingerprint('sk-different'), fp);
  });

  it('contentHash 只覆盖五维语义（元字段变化不影响；内容变化影响；devHead 自引用排除 R1）', () => {
    const a = validBundle();
    const b = validBundle();
    b.bundleId = '99999999-9999-4999-9999-999999999999';
    b.generatedAt = '2026-08-15T00:00:00.000Z';
    b.generatedBy = 'other-instance';
    assert.equal(computeContentHash(a), computeContentHash(b)); // 元字段不纳入
    // R1（i4-4 修正记录 ②）：project.devHead 自引用字段同口径排除——devHead 每次
    // 成功 run 必推进，纳入会使幂等重跑判定恒失效
    b.project.devHead = '0000000000000000000000000000000000000000';
    assert.equal(computeContentHash(a), computeContentHash(b)); // devHead 变化不纳入
    // 其他维内容变化 → 纳入
    b.project.repoUrl = 'https://github.com/other/repo.git';
    assert.notEqual(computeContentHash(a), computeContentHash(b));
    assert.equal(
      computeContentHash(a),
      computeDimsContentHash({ company: a.company, model: a.model, keys: a.keys, employees: a.employees, project: a.project }),
    );
  });

  it('generatedAt 严格递增：max(now, 现存 + 1ms)', () => {
    const existing = '2026-08-14T10:00:00.000Z';
    const nowMs = Date.parse('2026-08-13T00:00:00.000Z'); // 时钟回拨场景
    const next = nextGeneratedAt(existing, nowMs);
    assert.equal(next, '2026-08-14T10:00:00.001Z'); // 严格 > 现存
    const next2 = nextGeneratedAt(null, Date.parse('2026-08-13T00:00:00.000Z'));
    assert.equal(next2, '2026-08-13T00:00:00.000Z');
    assert.equal(nextGeneratedAt('not-a-date', 0), new Date(0).toISOString());
  });

  it('buildGeneratedBy = trilc-init-<version>@<host-hash-8>', () => {
    const g = buildGeneratedBy('0.9.0', 'myhost');
    assert.match(g, /^trilc-init-0\.9\.0@[0-9a-f]{8}$/);
    assert.equal(buildGeneratedBy('0.9.0', 'myhost'), g);
    assert.notEqual(buildGeneratedBy('0.9.0', 'otherhost'), g);
  });
});

describe('sync-bundle 序列化泄漏扫描（测试门禁②）', () => {
  it('干净序列化 → 断言通过', () => {
    const serialized = JSON.stringify(validBundle(), null, 2);
    assertNoSecretMaterial(serialized);
    assert.deepEqual(scanSecretMaterial(serialized), { hasSecretFieldName: false, hasSkPlaintext: false });
  });

  it('含 sk- 明文 → 断言抛错', () => {
    assert.throws(() => assertNoSecretMaterial(JSON.stringify({ a: 'sk-abc12345' })), /SEC-20260813-001/);
  });

  it('含 api_key 字段名 → 断言抛错', () => {
    assert.throws(() => assertNoSecretMaterial(JSON.stringify({ x: { api_key: 'anything' } })), /SEC-20260813-001/);
  });
});
