// ── Ink TUI App ──
import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { useChat, type Message } from './hooks/useChat.js';
import { useCursorInput } from './hooks/useCursorInput.js';
import Markdown from './components/Markdown.js';
import ToolCallLine from './components/ToolCallLine.js';
import { ThemeProvider, useTheme, type Theme } from './design-system/theme.js';

interface ResumeOptions {
  sessionId?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Memoized message row — prevents re-printing
const MessageLine = React.memo(function MessageLine({ msg }: { msg: Message }) {
  const theme = useTheme();
  if (msg.role === 'user') {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { color: theme.warning, bold: true }, "You:"),
      React.createElement(Text, null, msg.content)
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Markdown, { content: msg.content }),
    msg.toolCalls?.map((tc, j) =>
      React.createElement(ToolCallLine, {
        key: j,
        name: tc.name,
        args: tc.arguments ?? '{}',
        status: (tc.status === 'blocked' ? 'error' : tc.status) as 'pending' | 'done' | 'error',
      }))
  );
});

export default function App({ onAbortRef, resume }: { onAbortRef?: React.MutableRefObject<(() => void) | null>; resume?: ResumeOptions }) {
  const { messages, send, isLoading, requestState, error, abort, loadSession, clearMessages, addSystemMessage } = useChat();
  const theme = useTheme();
  // ── Send logic with resume-aware ──
  const handleSend = useCallback((text: string) => {
    if (!text.trim()) return;
    send(text.trim());
  }, [send]);

  // ── Slash-command handler ──
  const handleCommand = useCallback((inputText: string): boolean => {
    const cmd = inputText.trim().toLowerCase();
    switch (cmd) {
      case '/exit':
        process.exit(0);
        return true; // unreachable, satisfies TS
      case '/help':
        addSystemMessage(
          'Available commands:\n' +
          '  /exit  - Exit TriCade\n' +
          '  /help  - Show this help\n' +
          '  /clear - Clear conversation history'
        );
        return true;
      case '/clear':
        clearMessages();
        return true;
      default:
        addSystemMessage(`Unknown command: ${inputText}. Type /help for available commands.`);
        return true;
    }
  }, [clearMessages, addSystemMessage]);

  const { inputText, cursorOffset, clear } = useCursorInput({ onSubmit: handleSend, onCommand: handleCommand });
  const [resumeLoaded, setResumeLoaded] = useState(false);

  useEffect(() => {
    if (onAbortRef) onAbortRef.current = abort;
    return () => { if (onAbortRef) onAbortRef.current = null; };
  }, [abort, onAbortRef]);

  // Handle resume on mount
  useEffect(() => {
    if (resumeLoaded) return;
    if (!resume) { setResumeLoaded(true); return; }

    // If messages were pre-fetched, display them and set session
    if (resume.messages && resume.messages.length > 0) {
      // Display the messages as history, then prompt for next input
      // We don't send automatically — user types next message
      setResumeLoaded(true);
    } else if (resume.sessionId) {
      // Try loading from API
      loadSession(resume.sessionId).then((data) => {
        if (data) {
          // Messages will be loaded via the hook's state
        }
        setResumeLoaded(true);
      }).catch(() => setResumeLoaded(true));
    } else {
      setResumeLoaded(true);
    }
  }, [resume, resumeLoaded, loadSession]);

  // Show resume messages if any
  const resumeMsgs: Message[] = resume?.messages?.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
    isStreaming: false,
  })) ?? [];

  // Only render last message when streaming, all messages otherwise
  const allMsgs = resumeMsgs.length > 0 && messages.length === 0 ? resumeMsgs : messages;
  const displayMsgs = allMsgs.length > 0 && allMsgs[allMsgs.length - 1].isStreaming
    ? allMsgs.slice(0, -1)
    : allMsgs;

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    React.createElement(Box, { flexGrow: 1, flexDirection: "column" },
      displayMsgs.length === 0 && React.createElement(Box, { paddingY: 1 },
        React.createElement(Text, { color: theme.info, bold: true }, "TriCade"),
        React.createElement(Text, { dimColor: true }, resume ? `Session: ${resume.sessionId ?? '(loaded)'} — Type and Enter. /exit to quit.` : "Type and Enter. /exit to quit. Ctrl+C twice.")
      ),
      resumeMsgs.length > 0 && messages.length === 0 && React.createElement(Box, { paddingY: 0 },
        React.createElement(Text, { dimColor: true }, `── Resumed ${resumeMsgs.length} messages ──`)
      ),
      ...displayMsgs.map((msg, i) =>
        React.createElement(MessageLine, { key: i, msg })
      ),
      // Show streaming message separately
      allMsgs.length > 0 && allMsgs[allMsgs.length - 1].isStreaming &&
        React.createElement(MessageLine, { key: 'streaming', msg: allMsgs[allMsgs.length - 1] }),
      requestState === 'waitingForFirstToken' && React.createElement(Text, { dimColor: true }, "Thinking..."),
      error && React.createElement(Text, { color: theme.error }, `Error: ${error}`)
    ),
    React.createElement(Box, { flexDirection: "column", borderStyle: "single" },
      React.createElement(Text, { dimColor: true }, isLoading ? "Waiting..." : `> ${inputText.substring(0, cursorOffset)}█${inputText.substring(cursorOffset)}`)
    )
  );
}
