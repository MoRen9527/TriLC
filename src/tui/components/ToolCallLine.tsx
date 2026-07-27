// ── ToolCall line component (Ink) ──
// Displays tool name + key args with a tri-state prefix (pending spinner / done check / error cross).
// Self-maintains a braille spinner via setInterval; cleans up when status leaves 'pending'.
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

// ── Constants ──
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const MAX_VALUE_LEN = 40;
const MAX_LINE_LEN = 70; // leaves room for prefix + space within 72

// ── Args extraction ──
// Parses the JSON args string, extracts the first 2 key-value pairs,
// truncates each value to MAX_VALUE_LEN chars.
function extractArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson);
    if (typeof obj !== 'object' || obj === null) return '';
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '';

    const parts = entries.slice(0, 2).map(([k, v]) => {
      const valStr = typeof v === 'string' ? v : JSON.stringify(v);
      const truncated = valStr.length > MAX_VALUE_LEN
        ? valStr.slice(0, MAX_VALUE_LEN) + '…'
        : valStr;
      return `${k}: ${truncated}`;
    });

    return parts.join(', ');
  } catch {
    return '';
  }
}

// ── Line formatting ──
// Ensures the total display line (tool name + args) fits within MAX_LINE_LEN.
function formatLine(name: string, argsDisplay: string): string {
  const full = argsDisplay ? `${name} ${argsDisplay}` : name;
  if (full.length <= MAX_LINE_LEN) return full;
  return full.slice(0, MAX_LINE_LEN) + '…';
}

// ── Props ──
interface ToolCallLineProps {
  name: string;
  args: string;
  status: 'pending' | 'done' | 'error';
}

// ── Component ──
export default function ToolCallLine({ name, args, status }: ToolCallLineProps) {
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Self-maintained braille spinner
  useEffect(() => {
    if (status !== 'pending') {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [status]);

  // Determine prefix and color by status
  const prefix = status === 'pending'
    ? SPINNER_FRAMES[spinnerIdx]
    : status === 'done' ? '✓' : '✗'; // ✓ : ✗

  const textProps: Record<string, unknown> = status === 'pending'
    ? { dimColor: true }
    : { color: status === 'done' ? 'green' : 'red' };

  const argsDisplay = extractArgs(args);
  const line = formatLine(name, argsDisplay);

  return React.createElement(Box, { marginLeft: 2 },
    React.createElement(Text, textProps, `${prefix} ${line}`),
  );
}
