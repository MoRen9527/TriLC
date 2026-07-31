// ── AgentPanel component (P2-Batch1-#6) ──
// Displays sub-agent status and messages. Simple read-only view for P2;
// complex interactions deferred to P3.
import React from 'react';
import { Box, Text } from '../fork.js';

export interface AgentStatus {
  id: string;
  name: string;
  state: 'idle' | 'running' | 'done' | 'error';
  currentMessage?: string;
  progress?: { step: number; totalSteps: number; description: string };
}

interface AgentPanelProps {
  agents: AgentStatus[];
  title?: string;
}

export default function AgentPanel({ agents, title = 'Sub-Agents' }: AgentPanelProps) {
  if (agents.length === 0) {
    return React.createElement(Box, { paddingX: 1, paddingY: 1 },
      React.createElement(Text, { dimColor: true, italic: true },
        'No active sub-agents.'
      ),
    );
  }

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1, borderStyle: 'single' },
    // Title row
    React.createElement(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      React.createElement(Text, { bold: true, color: 'cyan' }, `${title} (${agents.length})`),
    ),
    React.createElement(Text, { dimColor: true }, '─'.repeat(40)),

    // Agent list
    ...agents.map((agent, i) => {
      const stateColor = agent.state === 'running' ? 'yellow' : agent.state === 'done' ? 'green' : agent.state === 'error' ? 'red' : 'grey';
      const stateSymbol = agent.state === 'running' ? '⟳' : agent.state === 'done' ? '✓' : agent.state === 'error' ? '✗' : '○';

      return React.createElement(Box, { key: `agent-${i}`, flexDirection: 'column', paddingY: 0, marginBottom: 1 },
        // Agent header
        React.createElement(Box, { flexDirection: 'row' },
          React.createElement(Text, { color: stateColor, bold: agent.state === 'running' }, `${stateSymbol} ${agent.name}`),
          React.createElement(Text, { dimColor: true }, ` — ${agent.id.slice(0, 12)}…`),
        ),

        // Current message (if any)
        agent.currentMessage && React.createElement(Box, { marginLeft: 2 },
          React.createElement(Text, { dimColor: true, italic: true }, agent.currentMessage),
        ),

        // Progress (if any)
        agent.progress && React.createElement(Box, { marginLeft: 2, flexDirection: 'row' },
          React.createElement(Text, { dimColor: true },
            `[${agent.progress.step}/${agent.progress.totalSteps}] ${agent.progress.description}`
          ),
        ),
      );
    }),
  );
}

// ── Compact agent status line ──
// Renders a single-line status summary suitable for embedding in messages
export function renderAgentStatus(agents: AgentStatus[]): string {
  if (agents.length === 0) return 'No active agents.';

  const running = agents.filter(a => a.state === 'running').length;
  const done = agents.filter(a => a.state === 'done').length;
  const errors = agents.filter(a => a.state === 'error').length;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (errors > 0) parts.push(`${errors} errors`);

  return parts.length > 0 ? parts.join(', ') : 'All agents idle.';
}
