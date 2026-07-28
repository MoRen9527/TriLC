// ── Ink TUI bootstrap (npm ink) ──
import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { ThemeProvider } from './design-system/theme.js';

const SIGINT_RESET_MS = 1000;

export interface TUIResumeOptions {
  sessionId?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function startTUI(resume?: TUIResumeOptions): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> {
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>(r => { exitResolve = r; });

  const abortRef: React.MutableRefObject<(() => void) | null> = { current: null };
  const ctrlCRef: React.MutableRefObject<(() => void) | null> = { current: null };

  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;

  const handleSigint = () => {
    // If app has a Ctrl+C handler (useDoublePress), use it
    if (ctrlCRef.current) {
      ctrlCRef.current();
      return;
    }
    // Fallback: legacy behavior for abort / exit
    if (abortRef.current) {
      sigintCount++;
      if (sigintCount === 1) {
        abortRef.current();
        if (sigintTimer) clearTimeout(sigintTimer);
        sigintTimer = setTimeout(() => { sigintCount = 0; }, SIGINT_RESET_MS);
        return;
      }
    }
    exitResolve?.();
    process.exit(0);
  };

  process.on('SIGINT', handleSigint);

  const { unmount, waitUntilExit: inkWait } = render(
    React.createElement(ThemeProvider, null, React.createElement(App, { onAbortRef: abortRef, onCtrlCRef: ctrlCRef, resume })),
    { exitOnCtrlC: false, patchConsole: true }
  );

  return {
    unmount: () => { process.off('SIGINT', handleSigint); unmount(); },
    waitUntilExit: () => Promise.race([inkWait(), exitPromise]),
  };
}
