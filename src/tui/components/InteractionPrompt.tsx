// ── InteractionPrompt (P3) ──
// Live keyboard-driven prompt rendered while the daemon waits on an
// interaction: AskUserQuestion options or permission allow/deny/always.
// Keyboard handling lives in app.tsx (single useInput owner); this component
// is pure rendering driven by props.
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
  { label: 'Always allow', hint: 'remember for this session' },
] as const;

export default function InteractionPrompt({
  interaction,
  questionIndex,
  cursorIndex,
  collectedAnswers,
}: InteractionPromptProps) {
  if (interaction.kind === 'permission') {
    const { toolName, argsSummary, reason } = interaction.payload;
    return React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'yellow',
      paddingX: 1,
      marginY: 0,
    },
      React.createElement(Text, { bold: true, color: 'yellow' },
        `⚠ Permission required — ${toolName ?? 'unknown tool'}`),
      argsSummary
        ? React.createElement(Box, { marginTop: 0 },
            React.createElement(Text, { color: 'white' }, `  ${argsSummary}`))
        : null,
      reason
        ? React.createElement(Text, { dimColor: true }, `  ${reason}`)
        : null,
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
