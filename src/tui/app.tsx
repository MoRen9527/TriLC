// ── Ink TUI App ──
import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useChat, type Message } from './hooks/useChat.js';
import { useCursorInput } from './hooks/useCursorInput.js';
import { useDoublePress } from './hooks/useDoublePress.js';
import Markdown from './components/Markdown.js';
import ToolCallLine from './components/ToolCallLine.js';
import StatusLine from './components/StatusLine.js';
import ThinkingLine from './components/ThinkingLine.js';
import ErrorMessage from './components/ErrorMessage.js';
import { ThemeProvider, useTheme, type Theme } from './design-system/theme.js';

interface ResumeOptions {
  sessionId?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const MessageLine = React.memo(function MessageLine({ msg, verbose }: { msg: Message; verbose?: boolean }) {
  const theme = useTheme();
  if (msg.role === 'user') {
    return React.createElement(Box, { flexDirection: "column", paddingBottom: 1 },
      React.createElement(Text, { color: theme.warning, bold: true }, "▸ You"),
      React.createElement(Box, { paddingLeft: 2 },
        React.createElement(Text, null, msg.content)
      )
    );
  }
  return React.createElement(Box, { flexDirection: "column", paddingBottom: 1 },
    msg.thinking ? React.createElement(ThinkingLine, { content: msg.thinking, collapsed: !verbose }) : null,
    msg.toolCalls?.map((tc, j) =>
      React.createElement(ToolCallLine, { key: `tc-${j}`, name: tc.name, args: tc.arguments ?? '{}',
        status: (tc.status === 'blocked' ? 'error' : tc.status) as 'pending' | 'done' | 'error' })
    ),
    React.createElement(Box, { paddingLeft: 1 },
      React.createElement(Markdown, { content: msg.content })
    )
  );
});

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!) + 1;
  return dp[m]![n]!;
}

export default function App({ onAbortRef, onCtrlCRef, resume }: { onAbortRef?: React.MutableRefObject<(() => void) | null>; onCtrlCRef?: React.MutableRefObject<(() => void) | null>; resume?: ResumeOptions }) {
  const { messages, send, isLoading, requestState, error, abort, loadSession, clearMessages, addSystemMessage } = useChat();
  const theme = useTheme();
  const [verbose, setVerbose] = useState(false);

  const handleCtrlC = useDoublePress(
    () => {
      clear();
      addSystemMessage('Press Ctrl+C again to exit.');
    },
    () => {
      process.exit(0);
    },
  );

  useEffect(() => {
    if (onCtrlCRef) onCtrlCRef.current = handleCtrlC;
    return () => { if (onCtrlCRef) onCtrlCRef.current = null; };
  }, [handleCtrlC, onCtrlCRef]);

  const COMMANDS: Record<string, { desc: string; handler: (args: string) => string | Promise<string> }> = {
    '/exit':    { desc: 'Exit TriCade', handler: () => { process.exit(0); return ''; } },
    '/help':    { desc: 'Show commands', handler: () => Object.entries(COMMANDS).map(([k,v]) => `  ${k}  — ${v.desc}`).join('\n') },
    '/clear':   { desc: 'Clear message history', handler: () => { clearMessages(); return 'Cleared.'; } },
    '/model':   { desc: 'Show current model', handler: () => 'Current model: deepseek-v4-flash (switching via /model <name> P2)' },
    '/verbose': { desc: 'Toggle verbose mode', handler: () => { setVerbose(v => !v); return `Verbose ${verbose ? 'OFF' : 'ON'}.`; } },
    '/status':  { desc: 'Show session stats', handler: () => `Session: ${messages.length} msgs, model: deepseek-v4-flash` },
    '/compact': { desc: 'Compact context (stub)', handler: () => 'Auto-compact not yet implemented (P2).' },
    '/sessions': { desc: 'List saved sessions', handler: async () => { try { const r = await fetch('http://localhost:8711/internal/v1/sessions?limit=10'); const j = await r.json() as any; return (j.sessions||[]).map((s:any)=>`${s.id?.slice(0,12)}…  ${s.status??'?'}  ${s.created_at??''}`).join('\n') || 'No sessions'; } catch { return 'Cannot reach daemon'; } } },
  };

  const handleSend = useCallback((text: string) => { if (text.trim()) send(text.trim()); }, [send]);

  const handleCommand = useCallback((inputText: string): boolean => {
    const parts = inputText.trim().split(/\s+/);
    const cmdName = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1).join(' ');
    const entry = COMMANDS[cmdName];
    if (entry) { const r = entry.handler(args); if (typeof r === 'string') addSystemMessage(r); else r.then(s => addSystemMessage(s)); return true; }
    const names = Object.keys(COMMANDS);
    const closest = names.reduce((best, n) => { const d = levenshtein(cmdName, n); return d < best.d ? { name: n, d } : best; }, { name: '', d: 99 });
    const hint = closest.d <= 3 ? ` Did you mean ${closest.name}?` : '';
    addSystemMessage(`Unknown command: ${inputText}. Type /help for available commands.${hint}`);
    return true;
  }, [clearMessages, addSystemMessage]);

  const handleBash = useCallback((cmd: string) => {
    (async () => {
      try {
        const { execSync } = await import('child_process');
        const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 });
        addSystemMessage(`! ${cmd}\n${output || '(no output)'}`);
      } catch (e: any) { addSystemMessage(`! ${cmd}\nError: ${e.message || String(e)}`); }
    })();
  }, [addSystemMessage]);

  const { inputText, cursorOffset, clear } = useCursorInput({
    onSubmit: handleSend, onCommand: handleCommand, onBash: handleBash,
    onPasteOverflow: (fullLen: number) => {
      addSystemMessage(`[Paste truncated: ${fullLen} chars → 10K max]`);
    },
  });
  const [resumeLoaded, setResumeLoaded] = useState(false);

  const renderInputBox = () => {
    if (isLoading) return React.createElement(Text, { dimColor: true }, "Waiting...");
    const lines = inputText.split('\n');
    let cumOff = 0, cursorLineIdx = 0, cursorCol = cursorOffset;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i]!.length + 1;
      if (cursorOffset < cumOff + lineLen || i === lines.length - 1) { cursorLineIdx = i; cursorCol = cursorOffset - cumOff; break; }
      cumOff += lineLen;
    }
    return React.createElement(Box, { flexDirection: "column" },
      ...lines.map((line, i) => i === cursorLineIdx
        ? React.createElement(Text, { key: i, dimColor: true }, `> ${line.substring(0, cursorCol)}█${line.substring(cursorCol)}`)
        : React.createElement(Text, { key: i, dimColor: true }, `> ${line}`))
    );
  };

  useEffect(() => { if (onAbortRef) onAbortRef.current = abort; return () => { if (onAbortRef) onAbortRef.current = null; }; }, [abort, onAbortRef]);

  useEffect(() => {
    if (resumeLoaded) return;
    if (!resume) { setResumeLoaded(true); return; }
    if (resume.messages && resume.messages.length > 0) { setResumeLoaded(true); }
    else if (resume.sessionId) { loadSession(resume.sessionId).then(() => setResumeLoaded(true)).catch(() => setResumeLoaded(true)); }
    else { setResumeLoaded(true); }
  }, [resume, resumeLoaded, loadSession]);

  const resumeMsgs: Message[] = resume?.messages?.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, isStreaming: false })) ?? [];
  const allMsgs = resumeMsgs.length > 0 && messages.length === 0 ? resumeMsgs : messages;
  const displayMsgs = allMsgs.length > 0 && allMsgs[allMsgs.length - 1].isStreaming ? allMsgs.slice(0, -1) : allMsgs;

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    React.createElement(Box, { flexGrow: 1, flexDirection: "column" },
      displayMsgs.length === 0 && React.createElement(Box, { paddingY: 1 },
        React.createElement(Text, { color: theme.info, bold: true }, "TriCade v0.4.0"),
        React.createElement(Text, { dimColor: true }, resume ? `Session: ${resume.sessionId ?? '(loaded)'} — Type and Enter. /exit to quit.` : "Type and Enter. /exit to quit. Ctrl+C twice.")
      ),
      resumeMsgs.length > 0 && messages.length === 0 && React.createElement(Box, { paddingY: 0 },
        React.createElement(Text, { dimColor: true }, `── Resumed ${resumeMsgs.length} messages ──`)
      ),
      ...displayMsgs.map((msg, i) => React.createElement(MessageLine, { key: i, msg, verbose })),
      allMsgs.length > 0 && allMsgs[allMsgs.length - 1].isStreaming && React.createElement(MessageLine, { key: 'streaming', msg: allMsgs[allMsgs.length - 1], verbose }),
      requestState === 'waitingForFirstToken' && React.createElement(Text, { dimColor: true }, "Thinking..."),
      error && React.createElement(ErrorMessage, { message: error })
    ),
    React.createElement(Box, { flexDirection: "column", borderStyle: "single" }, renderInputBox()),
    React.createElement(StatusLine, { model: "deepseek-v4-flash", cwd: process.cwd(), inputTokens: 0, outputTokens: 0 })
  );
}
