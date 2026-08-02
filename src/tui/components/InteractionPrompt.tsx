// ── InteractionPrompt v2 (w34-2) ──
// Live keyboard-driven prompt rendered while the daemon waits on an
// interaction: AskUserQuestion options or permission allow/deny/always.
// Keyboard handling lives in app.tsx (single useInput owner); this component
// is pure rendering driven by props.
//
// w34-2: Enhanced permission dialog — tool category/risk level indicator,
//        better args display with truncation, corrected "Always allow" hint.
import React from 'react';
import { Box, Text } from '../fork.js';
import type { PendingInteraction } from '../hooks/usePendingInteraction.js';

export interface InteractionPromptProps {
  interaction: PendingInteraction;
  /** Index of the question currently being answered (multi-question flow). */
  questionIndex: number;
  /** Currently highlighted option (arrow-key cursor). */
  cursorIndex: number;
  /** Answers collected so far (question kind). */
  collectedAnswers: Record<string, string>;
}

const PERMISSION_OPTIONS = [
  { label: 'Allow', hint: 'run this once' },
  { label: 'Deny', hint: 'block this call' },
  { label: 'Always allow', hint: 'remember (persists across sessions)' },
] as const;

// w34-2: Derive tool category and risk level from tool name for better UX.
function deriveToolMeta(toolName: string | undefined): { category: string; risk: 'low' | 'medium' | 'high'; color: string } {
  const name = (toolName ?? '').toLowerCase();
  // High-risk: shell execution, process management, file deletion
  if (
    name.includes('bash') || name.includes('shell') || name.includes('exec') ||
    name.includes('spawn') || name.includes('command') || name.includes('process') ||
    name.includes('rm ') || name.includes('delete') || name.includes('unlink')
  ) {
    return { category: 'Shell / Command Execution', risk: 'high', color: 'red' };
  }
  // Medium-risk: file write, network, git operations
  if (
    name.includes('write') || name.includes('edit') || name.includes('replace') ||
    name.includes('save') || name.includes('git') || name.includes('commit') ||
    name.includes('push') || name.includes('fetch') || name.includes('curl')
  ) {
    return { category: 'File Write / Network', risk: 'medium', color: 'yellow' };
  }
  // Low-risk: read-only operations
  if (
    name.includes('read') || name.includes('grep') || name.includes('glob') ||
    name.includes('ls') || name.includes('list') || name.includes('cat') ||
    name.includes('view') || name.includes('search')
  ) {
    return { category: 'Read-Only File Access', risk: 'low', color: 'green' };
  }
  // Default: unknown tool — medium risk as precaution
  return { category: 'Tool Execution', risk: 'medium', color: 'yellow' };
}

export default function InteractionPrompt({
  interaction,
  questionIndex,
  cursorIndex,
  collectedAnswers,
}: InteractionPromptProps) {
  if (interaction.kind === 'permission') {
    const { toolName, argsSummary, reason } = interaction.payload;
    const toolMeta = deriveToolMeta(toolName);
    // Truncate argsSummary if too long (keep first 200 chars)
    const argsDisplay = (argsSummary && argsSummary.length > 200)
      ? argsSummary.slice(0, 200) + '…'
      : argsSummary;

    return React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: toolMeta.risk === 'high' ? 'red' : 'yellow',
      paddingX: 1,
      marginY: 0,
    },
      // Header: tool name + risk badge
      React.createElement(Box, { flexDirection: 'row' },
        React.createElement(Text, { bold: true, color: 'yellow' },
          `⚠ Permission required`
        ),
      ),
      // Tool name line
      React.createElement(Box, { marginTop: 0, flexDirection: 'row' },
        React.createElement(Text, { bold: true, color: 'white' },
          `  Tool: ${toolName ?? 'unknown tool'}`
        ),
        React.createElement(Text, { color: toolMeta.color, dimColor: false },
          ` [${toolMeta.risk.toUpperCase()} RISK — ${toolMeta.category}]`
        ),
      ),
      // Args summary (truncated)
      argsDisplay
        ? React.createElement(Box, { marginTop: 0 },
            React.createElement(Text, { color: 'white' }, `  Args: ${argsDisplay}`))
        : null,
      // Reason / risk explanation
      reason
        ? React.createElement(Text, { dimColor: true }, `  Reason: ${reason}`)
        : React.createElement(Text, { dimColor: true, italic: true },
            `  ${toolMeta.risk === 'high' ? 'This tool can execute commands or modify your system.' : toolMeta.risk === 'low' ? 'This is a read-only operation.' : 'This tool may modify files or access the network.'}`),
      // Options
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        ...PERMISSION_OPTIONS.map((opt, i) => {
          const highlighted = i === cursorIndex;
          return React.createElement(Text, {
            key: `perm-${i}`,
            color: highlighted ? 'green' : 'gray',
            bold: highlighted,
          }, ` ${highlighted ? '❯' : ' '} [${i + 1}] ${opt.label} — ${opt.hint}`);
        }),
      ),
      React.createElement(Text, { dimColor: true, italic: true },
        '  Press 1-3, or ↑/↓ + Enter. Esc = deny.'),
    );
  }

  // ── question kind ──
  const questions = interaction.payload.questions ?? [];
  const q = questions[Math.min(questionIndex, questions.length - 1)];
  if (!q) return null;

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'blue',
    paddingX: 1,
  },
    React.createElement(Text, { bold: true, color: 'blue' },
      `【${q.header}】${questions.length > 1 ? ` (${questionIndex + 1}/${questions.length})` : ''}`),
    React.createElement(Text, null, q.question),
    React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
      ...q.options.map((opt, i) => {
        const highlighted = i === cursorIndex;
        const alreadyAnswered = collectedAnswers[q.question];
        return React.createElement(Box, { key: `qopt-${i}`, flexDirection: 'column' },
          React.createElement(Text, {
            color: highlighted ? 'green' : 'gray',
            bold: highlighted,
          }, ` ${highlighted ? '❯' : ' '} [${i + 1}] ${opt.label} — ${opt.description}`),
          highlighted && opt.preview
            ? React.createElement(Box, { paddingLeft: 6 },
                React.createElement(Text, { dimColor: true },
                  opt.preview.length > 100 ? opt.preview.slice(0, 100) + '...' : opt.preview))
            : null,
          alreadyAnswered
            ? React.createElement(Text, { color: 'green' }, `     ✓ ${alreadyAnswered}`)
            : null,
        );
      }),
    ),
    React.createElement(Text, { dimColor: true, italic: true },
      '  Press number to select, or ↑/↓ + Enter. Esc = cancel.'),
  );
}

export { PERMISSION_OPTIONS };
