// ── ToolCall line component (CC-aligned, ● + useBlink) ──
// Displays tool name + key args with CC-style ● prefix:
//   pending: ● blinking dimColor
//   done:    ● solid green
//   error:   ● solid red
import React from 'react';
import { Box, Text } from 'ink';
import { useBlink } from '../hooks/useBlink.js';

const BLACK_CIRCLE = '●'; // ● (CC figures.BLACK_CIRCLE equivalent)
const MAX_LINE_LEN = 70;
const BLINK_INTERVAL = 800; // CC-compatible blink cadence

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractArgs(name: string, argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return '';
    switch (name) {
      case 'Read':
      case 'Write':
        return obj.file_path ? `${obj.file_path}` : '';
      case 'Edit':
        if (!obj.file_path) return '';
        if (obj.old_string) {
          return `${obj.file_path} ("${trunc(String(obj.old_string), 20)}"→"${trunc(String(obj.new_string ?? ''), 20)}")`;
        }
        return `${obj.file_path}`;
      case 'Bash':
        return obj.command ? trunc(String(obj.command), 50) : '';
      case 'Grep':
      case 'Glob':
        return obj.pattern ? trunc(String(obj.pattern), 40) : '';
      default: {
        const entries = Object.entries(obj);
        if (entries.length === 0) return '';
        return entries.slice(0, 2).map(([k, v]) =>
          `${k}: ${trunc(String(v), 30)}`
        ).join(', ');
      }
    }
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
    React.createElement(Text, { color, dimColor: dim }, `${circle} ${formatLine(name, extractArgs(name, args))}`),
  );
}
