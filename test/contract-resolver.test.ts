import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContractResolver } from '../src/config/contract-resolver.js';

/** v3.0 形状合同（strict 必填最小集；decision_rights 顶层必填，四键有默认）。 */
function v3Contract(agentId: string, extra?: Record<string, string[]>): string {
  const dr = extra?.decision_rights
    ? ['decision_rights:', ...extra.decision_rights]
    : ['decision_rights: {}'];
  return [
    'contract:',
    '  version: "3.0"',
    '  type: agent-contract',
    `  agent_id: ${agentId}`,
    '  family: Role',
    'identity:',
    '  display_name: Sample',
    `  role: ${agentId}`,
    '  description: test agent',
    'paths:',
    `  soul: ${agentId}/soul.agent.md`,
    `  agent_body: ${agentId}/agent-body.agent.md`,
    `  agent_frontmatter: ${agentId}/agent-frontmatter.agent.md`,
    `  memory: ${agentId}/memory.agent.md`,
    `  colleagues: ${agentId}/colleagues.agent.md`,
    `  social: ${agentId}/social.agent.md`,
    'responsibilities:',
    '  - test duty',
    ...dr,
    'collaborators:',
    '  reports_to: ceo',
    'io_contract:',
    '  inputs:',
    '    - type: msg',
    '      description: test input',
    '  outputs:',
    '    - type: res',
    '      description: test output',
  ].join('\n');
}

describe('AgentContractResolver', () => {
  let sourceRoot: string | undefined;

  afterEach(async () => {
    if (sourceRoot) {
      await rm(sourceRoot, { recursive: true, force: true });
      sourceRoot = undefined;
    }
  });

  it('resolves contract paths from the source-agents root', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-resolver-'));
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
        v3Contract('sample-agent', { decision_rights: ['  approve:', '    - release'] }),
        'utf-8',
      ),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    assert.equal(await resolver.loadAll(), 1);
    assert.deepEqual(resolver.listAgents(), ['sample-agent']);
    assert.equal(resolver.getSystemPrompt('sample-agent'), 'Sample soul\n\nSample body');
    assert.deepEqual(resolver.getDecisionRights('sample-agent'), {
      approve: ['release'],
      freeze: [],
      escalate: [],
      forbidden: [],
    });
    assert.deepEqual(resolver.getToolControl('sample-agent'), { tools: ['read'] });
  });

  it('uses agent body frontmatter when the dedicated frontmatter file is empty', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-body-frontmatter-'));
    const agentDir = join(sourceRoot, 'body-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Body soul', 'utf-8'),
      writeFile(
        join(agentDir, 'agent-body.agent.md'),
        '---\nname: BodyAgent\ndescription: Contract metadata\ntools: [read, search]\n---\nBody instructions',
        'utf-8',
      ),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), '---\n\n---\n', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'body-agent.contract.yaml'), v3Contract('body-agent'), 'utf-8'),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    assert.equal(await resolver.loadAll(), 1);
    assert.deepEqual(resolver.getToolControl('body-agent'), {
      name: 'BodyAgent',
      description: 'Contract metadata',
      tools: ['read', 'search'],
    });
  });

  it('rejects v2-shaped contracts (negative path: no compat branch)', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-v2-reject-'));
    const agentDir = join(sourceRoot, 'legacy-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), '', 'utf-8'),
      writeFile(
        join(agentDir, 'legacy-agent.contract.yaml'),
        [
          'contract:',
          '  version: "2.0"',
          '  agent_id: legacy-agent',
          '  family: Role',
          'paths:',
          '  soul: legacy-agent/soul.agent.md',
          '  agent_body: legacy-agent/agent-body.agent.md',
          '  agent_frontmatter: legacy-agent/agent-frontmatter.agent.md',
          '  memory: legacy-agent/memory.agent.md',
          '  colleagues: legacy-agent/colleagues.agent.md',
          '  social: legacy-agent/social.agent.md',
        ].join('\n'),
        'utf-8',
      ),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    // v2 形状被 v3 schema 拒绝：loadAll 返回 0，无兼容分支
    assert.equal(await resolver.loadAll(), 0);
    assert.deepEqual(resolver.listAgents(), []);
  });
});
