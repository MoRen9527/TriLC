// ── ErrorMessage (P1-7): error rendering with optional details ──
import React from 'react';
import { Box, Text } from 'ink';

export default function ErrorMessage({ message, details }: { message: string; details?: string }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "red" }, `Error: ${message.slice(0, 500)}`),
    details ? React.createElement(Text, { dimColor: true }, details) : null);
}
