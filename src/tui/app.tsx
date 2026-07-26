// ©¤©¤ Ink TUI App ©¤©¤
import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useChat } from './hooks/useChat.js';

// Memoized message row ¡ª prevents re-printing
const MessageLine = React.memo(function MessageLine({ msg }: { msg: any }) {
  if (msg.role === 'user') {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { color: "yellow", bold: true }, "You:"),
      React.createElement(Text, null, msg.content)
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "green" }, msg.content),
    msg.toolCalls?.map((tc: any, j: number) =>
      React.createElement(Box, { key: j, marginLeft: 2 },
        React.createElement(Text, { dimColor: true },
          `[tool] ${tc.name} ${tc.status === 'done' ? 'OK' : '...'}`)))
  );
});

export default function App({ onAbortRef }: { onAbortRef?: React.MutableRefObject<(() => void) | null> }) {
  const { messages, send, isLoading, requestState, error, abort } = useChat();
  const [input, setInput] = React.useState('');

  useEffect(() => {
    if (onAbortRef) onAbortRef.current = abort;
    return () => { if (onAbortRef) onAbortRef.current = null; };
  }, [abort, onAbortRef]);

  useInput((inputChar, key) => {
    if (key.return) {
      if (input.trim()) { send(input.trim()); setInput(''); }
    } else if (key.backspace || key.delete) {
      setInput(v => v.slice(0, -1));
    } else if (inputChar && inputChar >= ' ') {
      setInput(v => v + inputChar);
    }
  });

  // Only render last message when streaming, all messages otherwise
  const displayMsgs = messages.length > 0 && messages[messages.length - 1].isStreaming
    ? messages.slice(0, -1) // complete messages
    : messages;

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    React.createElement(Box, { flexGrow: 1, flexDirection: "column" },
      displayMsgs.length === 0 && React.createElement(Box, { paddingY: 1 },
        React.createElement(Text, { color: "cyan", bold: true }, "TriLC TUI Chat"),
        React.createElement(Text, { dimColor: true }, "Type and Enter. /exit to quit. Ctrl+C twice.")
      ),
      ...displayMsgs.map((msg, i) =>
        React.createElement(MessageLine, { key: i, msg })
      ),
      // Show streaming message separately (uses absolute key to prevent re-render)
      messages.length > 0 && messages[messages.length - 1].isStreaming &&
        React.createElement(MessageLine, { key: 'streaming', msg: messages[messages.length - 1] }),
      requestState === 'waitingForFirstToken' && React.createElement(Text, { dimColor: true }, "Thinking..."),
      error && React.createElement(Text, { color: "red" }, `Error: ${error}`)
    ),
    React.createElement(Box, { flexDirection: "column", borderStyle: "single" },
      React.createElement(Text, { dimColor: true }, isLoading ? "Waiting..." : `> ${input}`)
    )
  );
}