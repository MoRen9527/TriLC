import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContractResolver } from '../src/config/contract-resolver.js';

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
        [
          'contract:',
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
        ].join('\n'),
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
    });
    assert.deepEqual(resolver.getToolControl('sample-agent'), { tools: ['read'] });
  });
});