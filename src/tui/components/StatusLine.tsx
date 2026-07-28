// ── StatusLine v1 (CC-aligned) ──
// Displays model | cwd | input/output tokens at the bottom of the TUI.
import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  model: string;
  cwd: string;
  inputTokens: number;
  outputTokens: number;
}

export default function StatusLine({ model, cwd, inputTokens, outputTokens }: Props) {
  const cwdShort = cwd.length > 35 ? '…' + cwd.slice(-34) : cwd;

  return React.createElement(Box, { flexDirection: "row" },
    React.createElement(Text, { dimColor: true, wrap: "truncate" },
      `${model}  │  ${cwdShort}  │  in:${inputTokens}  out:${outputTokens}  ctx:0%`
    )
  );
}
