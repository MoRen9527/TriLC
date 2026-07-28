// ── ThinkingLine (P1-5): renders model thinking content ──
// verbose mode: shows expanded thinking with content preview (up to 200 chars)
// collapsed mode: shows minimal "∴ Thinking" indicator
import React from 'react';
import { Box, Text } from 'ink';

export default function ThinkingLine({ content, collapsed }: { content: string; collapsed: boolean }) {
  if (collapsed) {
    return React.createElement(Text, { dimColor: true, italic: true }, '∴ Thinking');
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { dimColor: true, italic: true }, '∴ Thinking…'),
    React.createElement(Box, { paddingLeft: 2 },
      React.createElement(Text, { dimColor: true },
        content.slice(0, 200) + (content.length > 200 ? '…' : ''))));
}
