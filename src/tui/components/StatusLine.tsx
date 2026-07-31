// ── StatusLine v2 (P2-Batch1-#4) ──
// Displays model | git-branch | cwd | ctx% | input/output tokens
// P2-Batch1-#4: Added git branch detection and context percentage calculation
import React from 'react';
import { Box, Text } from '../fork.js';

interface Props {
  model: string;
  cwd: string;
  inputTokens: number;
  outputTokens: number;
  // P2-Batch1-#4: New props for git branch and context calculation
  totalMessages?: number;
  maxContextMessages?: number;
}

// P2-Batch1-#4: Simple git branch detection (no external dependency)
function getGitBranch(): string {
  try {
    const { execSync } = require('node:child_process');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch || '-';
  } catch {
    return '-';
  }
}

// Memoized branch value (update on component mount only)
let cachedBranch: string | null = null;

export default function StatusLine({
  model,
  cwd,
  inputTokens,
  outputTokens,
  totalMessages = 0,
  maxContextMessages = 100, // Arbitrary baseline for 100% context
}: Props) {
  const cwdShort = cwd.length > 30 ? '…' + cwd.slice(-29) : cwd;

  // P2-Batch1-#4: Get git branch (cached)
  if (cachedBranch === null) {
    cachedBranch = getGitBranch();
  }

  // P2-Batch1-#4: Calculate context percentage
  const ctxPercent = Math.min(100, Math.round((totalMessages / maxContextMessages) * 100));

  // Estimate total tokens (rough approximation: 1 message ≈ 500 tokens avg)
  const estimatedTotalTokens = (inputTokens + outputTokens) || 0;
  const tokenDisplay = estimatedTotalTokens > 0
    ? `${Math.round(estimatedTotalTokens / 1000)}k`
    : '0';

  return React.createElement(Box, { flexDirection: "row" },
    React.createElement(Text, { dimColor: true, wrap: "truncate" },
      `${model}  │  ${cachedBranch}  │  ${cwdShort}  │  ctx:${ctxPercent}%  │  ${tokenDisplay} tokens`
    )
  );
}
