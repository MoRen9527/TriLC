// ── TC-s1 task_plan 兼容层守卫（扁平数组契约 + systemPrompt 尾部清单注入）──
//
// TC-s1 规格（/tmp/tcs1-brief.md）与 TC-001 harness scaffold 的差异面：
//   1. task_plan 接受扁平结构化数组 [ { id, description, status } ]
//      （TC-001 只接受 { items: [...] } 对象形式）
//   2. task_plan 渲染为 markdown 进度清单注入 systemPrompt 尾部
//   3. 扁平数组契约下 continue_on_incomplete=true 默认使用规格原文英文自查提示
//
// 为什么是静态代码形状守卫而非运行时测试：app.ts 传递依赖 node:sqlite
// （Node ≥22 内置模块），本机 Node 18 无法 import；同 test/server/
// app-json-dedup-shape.test.ts 的取舍。TC-001 机制本身的运行时覆盖在
// harness-scaffold.test.ts（依赖注入桩循环，需 Node ≥22 环境跑 CI）。

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TS_PATH = resolve(__dirname, '../../src/server/app.ts');
const SOURCE = readFileSync(APP_TS_PATH, 'utf8');

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while ((from = haystack.indexOf(needle, from)) !== -1) {
    count++;
    from += needle.length;
  }
  return count;
}

describe('TC-s1: task_plan flat-array contract', () => {
  it('parseHarnessOptions normalizes a flat task_plan array', () => {
    assert.ok(
      SOURCE.includes('const tcs1FlatForm = Array.isArray(b.task_plan)'),
      'flat-array detection branch missing in parseHarnessOptions',
    );
    // 扁平数组直接作为 items 来源（不再要求 raw.items 包装）
    assert.ok(
      SOURCE.includes('? b.task_plan as unknown[]'),
      'flat array must feed rawItems directly',
    );
    // currentFocus 仅对象形式可给
    assert.ok(
      SOURCE.includes('!tcs1FlatForm && typeof raw.currentFocus'),
      'currentFocus must stay object-form only',
    );
  });

  it('flat-array + continue_on_incomplete defaults to the exact English self-check prompt', () => {
    const expected =
      'Your turn ended but the task may not be complete. If not done, continue executing. If truly complete, reply exactly: DONE.';
    assert.ok(
      SOURCE.includes(`'${expected}'`),
      'TCS1_SELF_CHECK_PROMPT must carry the spec-verbatim English text',
    );
    assert.ok(
      SOURCE.includes('out.incomplete_check_prompt = TCS1_SELF_CHECK_PROMPT'),
      'English prompt must be wired as the flat-form default',
    );
    // 显式自定义恒优先：注入点之前必须先解析 incomplete_check_prompt/continue_prompt
    const parseFn = SOURCE.slice(
      SOURCE.indexOf('export function parseHarnessOptions'),
      SOURCE.indexOf('out.incomplete_check_prompt = TCS1_SELF_CHECK_PROMPT'),
    );
    assert.ok(
      parseFn.includes('b.incomplete_check_prompt') && parseFn.includes('b.continue_prompt'),
      'explicit prompt overrides must be parsed before the flat-form default',
    );
  });

  it('TC-001 Chinese default self-check prompt is preserved', () => {
    assert.ok(
      SOURCE.includes('你结束了回合但任务可能尚未完成'),
      'INCOMPLETE_CHECK_PROMPT (Chinese default) must not be regressed',
    );
  });
});

describe('TC-s1: systemPrompt tail checklist injection', () => {
  it('formatTaskPlanChecklist is exported and renders id/status/description', () => {
    assert.ok(SOURCE.includes('export function formatTaskPlanChecklist'), 'helper must be exported');
    assert.ok(SOURCE.includes('- [#${it.id}] [${status}] ${it.description}'), 'checklist line shape');
  });

  it('both /v1/messages and /chat/completions append the checklist tail', () => {
    assert.strictEqual(
      countOccurrences(SOURCE, 'formatTaskPlanChecklist(harness.task_plan)') +
        countOccurrences(SOURCE, 'formatTaskPlanChecklist(oaiHarness.task_plan)'),
      2,
      'checklist injection must appear exactly once per endpoint',
    );
    assert.ok(
      SOURCE.includes('(parsed.system || defaultSystemPrompt()) + systemPromptTail'),
      '/v1/messages systemPrompt tail composition',
    );
    assert.ok(
      SOURCE.includes('(oaiSystem || defaultSystemPrompt()) + oaiSystemPromptTail'),
      '/chat/completions systemPrompt tail composition',
    );
  });

  it('tail is empty-string when no task_plan — zero behavior change preserved', () => {
    assert.ok(
      SOURCE.includes("harness ? formatTaskPlanChecklist(harness.task_plan) : ''"),
      'no-harness requests keep native systemPrompt',
    );
  });
});
