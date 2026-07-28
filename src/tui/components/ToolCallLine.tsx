// ── ToolCall line component (CC-aligned, ● + useBlink) ──
// Displays tool name + key args with CC-style ● prefix:
//   pending: ● blinking dimColor
//   done:    ● solid green
//   error:   ● solid red
import React from 'react';
import { Box, Text } from 'ink';
import { useBlink } from '../hooks/useBlink.js';

const BLACK_CIRCLE = '●'; // ● (CC figures.BLACK_CIRCLE equivalent)
const MAX_VALUE_LEN = 40;
const MAX_LINE_LEN = 70;
const BLINK_INTERVAL = 800; // CC-compatible blink cadence

function extractArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson);
    if (typeof obj !== 'object' || obj === null) return '';
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '';
    const parts = entries.slice(0, 2).map(([k, v]) => {
      const valStr = typeof v === 'string' ? v : JSON.stringify(v);
      const truncated = valStr.length > MAX_VALUE_LEN ? valStr.slice(0, MAX_VALUE_LEN) + '…' : valStr;
      return `${k}: ${truncated}`;
    });
    return parts.join(', ');
  } catch { return ''; }
}

function formatLine(name: string, argsDisplay: string): string {
  const full = argsDisplay ? `${name} ${argsDisplay}` : name;
  return full.length <= MAX_LINE_LEN ? full : full.slice(0, MAX_LINE_LEN) + '…';
}

interface Props { name: string; args: string; status: 'pending' | 'done' | 'error'; }

export default function ToolCallLine({ name, args, status }: Props) {
  const isBlinking = useBlink(status === 'pending', BLINK_INTERVAL);

  // Pending: show ● only on visible half-cycle (blinking effect)
  const showCircle = status !== 'pending' || isBlinking;
  const circle = showCircle ? BLACK_CIRCLE : ' ';

  const color = status === 'done' ? 'green'
              : status === 'error' ? 'red'
              : 'yellow';

  const dim = status === 'pending';

  return React.createElement(Box, { marginLeft: 2 },
    React.createElement(Text, { color, dimColor: dim }, `${circle} ${formatLine(name, extractArgs(args))}`),
  );
}
