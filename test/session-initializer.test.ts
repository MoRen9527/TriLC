import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContractResolver } from '../src/config/contract-resolver.js';
import {
  initializeSession,
  ensureWorkspaceDir,
  SessionInitError,
} from '../src/company/session-initializer.js';

describe('session-initializer', () => {
  let sourceRoot: string | undefined;
  let workspaceRoot: string | undefined;

  before(async () => {
    // 装配一份 v2 合同 + roster，供单例 resolver 加载
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-session-init-'));
    const agentDir = join(sourceRoot, 'sample-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'Sample body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), 'tools:\n  - read', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), 'Sample memory', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), 'Sample colleagues', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), 'Sample social', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        [
          'contract:',
          '  version: "2.0"',
          '  agent_id: sample-agent',
          '  family: Role',
          'paths:',
          '  soul: sample-agent/soul.agent.md',
          '  agent_body: sample-agent/agent-body.agent.md',
          '  agent_frontmatter: sample-agent/agent-frontmatter.agent.md',
          '  memory: sample-agent/memory.agent.md',
          '  colleagues: sample-agent/colleagues.agent.md',
          '  social: sample-agent/social.agent.md',
          'decision_rights:',
          '  approve:',
          '    - release',
          '  forbidden:',
          '    - skip tests',
        ].join('\n'),
        'utf-8',
      ),
    ]);

    const registryDir = join(sourceRoot, 'docs', 'registry');
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, 'employee-roster.json'),
      JSON.stringify({
        version: '1.0',
        company: 'Test',
        rosterDate: '2026-08-13',
        totalEmployees: 1,
        employees: [
          {
            id: 'sample-agent',
            displayName: 'sample',
            family: 'Role',
            role: 'SampleAgent',
            tier: 'main',
            reportsTo: 'ceo',
            supervises: [],
            onboardedAt: '2026-08-13',
            status: 'active',
          },
        ],
        tiers: { main: 1 },
        families: { Role: 1 },
      }),
      'utf-8',
    );

    getContractResolver(sourceRoot);
    await getContractResolver().loadAll();
    getContractResolver().loadEmployeeRoster();
  });

  after(async () => {
    for (const dir of [sourceRoot, workspaceRoot]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('initializes a session with contract assembly + workspace ready', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'trilc-session-ws-'));
    const config = await initializeSession('sample-agent', join(workspaceRoot, 'nested', 'ws'));

    assert.equal(config.agentId, 'sample-agent');
    assert.equal(config.systemPrompt, 'Sample soul\n\nSample body');
    assert.deepEqual(config.decisionRights, {
      approve: ['release'],
      freeze: [],
      escalate: [],
      forbidden: ['skip tests'],
    });
    assert.deepEqual(config.toolControl, { tools: ['read'] });
    assert.equal(config.employeeInfo?.id, 'sample-agent');
    assert.match(config.readyAt, /^\d{4}-\d{2}-\d{2}T/);

    // 工作目录就绪：嵌套路径已创建且可写
    await access(config.workspaceRoot, constants.W_OK);
  });

  it('ensureWorkspaceDir is idempotent', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'trilc-session-ws2-'));
    const first = await ensureWorkspaceDir(workspaceRoot);
    const second = await ensureWorkspaceDir(workspaceRoot);
    assert.equal(first, second);
  });

  it('throws SessionInitError for an unloaded agent', async () => {
    await assert.rejects(
      initializeSession('no-such-agent', join(tmpdir(), 'trilc-session-ws3-')),
      (err: unknown) => err instanceof SessionInitError && err.agentId === 'no-such-agent',
    );
  });
});
