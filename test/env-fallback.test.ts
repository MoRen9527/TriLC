// ── env 兜底候选测试（r19-gate A1）──
// 安装态（C:\Program Files\TriCade）下 r19 三候选全落空 → keys fetch 401。
// A1 扩展：TRILC_ENV_FILE 显式注入 + dataDir 相邻候选。不覆盖已有进程 env
// 的加载器口径不变（r19 回归断言对象）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildEnvFileCandidates } from "../src/config/env.js";

const SAVED = {
  TRILC_ENV_FILE: process.env.TRILC_ENV_FILE,
  TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('TRILC_ENV_FILE 显式注入 = 第一候选（安装态指路，路径不含密钥）', () => {
  process.env.TRILC_ENV_FILE = 'D:/Code/ai/.env';
  const candidates = buildEnvFileCandidates('C:/Program Files/TriCade/trilc/dist/config', 'C:/Windows/System32');
  assert.equal(candidates[0], resolve('D:/Code/ai/.env'), '显式注入优先');
  restoreEnv();
});

test('安装态 dataDir 相邻候选可达（TRILC_DATA_DIR 显式隔离优先）', () => {
  delete process.env.TRILC_ENV_FILE;
  process.env.TRILC_DATA_DIR = 'C:/Users/jedih/AppData/Local/trilc-smoke';
  const candidates = buildEnvFileCandidates('C:/Program Files/TriCade/trilc/dist/config', 'C:/Windows/System32');
  assert.ok(candidates.includes(resolve(process.env.TRILC_DATA_DIR, '.env')), 'TRILC_DATA_DIR/.env 入选');
  restoreEnv();
});

test('未设 TRILC_DATA_DIR 时回退 LOCALAPPDATA/trilc/.env', () => {
  delete process.env.TRILC_ENV_FILE;
  delete process.env.TRILC_DATA_DIR;
  process.env.LOCALAPPDATA = 'C:/Users/jedih/AppData/Local';
  const candidates = buildEnvFileCandidates('C:/Program Files/TriCade/trilc/dist/config', 'C:/Windows/System32');
  assert.ok(candidates.includes(resolve('C:/Users/jedih/AppData/Local', 'trilc', '.env')), 'LOCALAPPDATA/trilc/.env 入选');
  restoreEnv();
});

test('源码态候选保留（r19 口径不退化）', () => {
  delete process.env.TRILC_ENV_FILE;
  const candidates = buildEnvFileCandidates('D:/Code/ai/TriLC/dist/config', 'D:/Code/ai/TriLC');
  assert.ok(candidates.includes(resolve('D:/Code/ai', '.env')), '工作区根候选仍在');
  assert.ok(candidates.includes(resolve('D:/Code/ai/TriLC', '.env')), 'TriLC 根候选仍在');
  restoreEnv();
});
