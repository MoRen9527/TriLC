// ── InputBox — uses fork's native useDeclaredCursor for IME support ──
// No more manual CUP/imeCursorCallback. The fork engine parks the terminal
// cursor at the declared position automatically (displayCursor preamble).
import React from 'react';
import { Box, Text } from '../fork.js';
import { useDeclaredCursor } from '../ink/ink/hooks/use-declared-cursor.js';
import stringWidth from 'string-width';
import { levenshtein } from '../utils/levenshtein.js';

const CURSOR_CHAR = '█';

interface CommandHintProps {
  inputText: string;
  commands: Record<string, { desc: string }>;
}

function CommandHint({ inputText, commands }: CommandHintProps) {
  if (!inputText.startsWith('/')) return null;
  const query = inputText.slice(1).toLowerCase();
  const entries = Object.entries(commands);
  if (!query) {
    const all = entries.sort(([a], [b]) => a.localeCompare(b)).slice(0, 6);
    return React.createElement(Box, { flexDirection: "column", marginLeft: 2, marginTop: 0 },
      ...all.map(([name, info], i) =>
        React.createElement(Text, { key: `hint-${i}`, dimColor: true }, `  ${name}  —  ${info.desc}`)),
    );
  }
  const scored = entries.map(([name, info]) => {
    const cmdName = name.slice(1).toLowerCase();
    const prefixMatch = cmdName.startsWith(query);
    const distance = levenshtein(query, cmdName);
    const score = prefixMatch ? -100 + distance : distance;
    return { name, desc: info.desc, distance, score };
  }).filter(e => {
    if (e.distance === 0) return true;
    return e.distance <= Math.min(3, Math.floor(e.name.length * 0.5));
  }).sort((a, b) => a.score - b.score).slice(0, 5);
  if (scored.length === 0) return null;
  return React.createElement(Box, { flexDirection: "column", marginLeft: 2, marginTop: 0 },
    ...scored.map((e, i) =>
      React.createElement(Text, { key: `hint-${i}`, dimColor: true }, `  ${e.name}  —  ${e.desc}`)),
  );
}

interface InputBoxProps {
  inputText: string;
  cursorOffset: number;
  isLoading: boolean;
  commands: Record<string, { desc: string }>;
}

function InputBox({ inputText, cursorOffset, isLoading, commands }: InputBoxProps) {
  if (isLoading) {
    return React.createElement(Text, { dimColor: true }, "Waiting...");
  }

  const lines = inputText.split('\n');
  let cumOff = 0, cursorLineIdx = 0, cursorCol = cursorOffset;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i]?.length ?? 0) + 1;
    if (cursorOffset < cumOff + lineLen || i === lines.length - 1) {
      cursorLineIdx = i;
      cursorCol = Math.max(0, cursorOffset - cumOff);
      break;
    }
    cumOff += lineLen;
  }

  // Column = display width of text before caret (CJK = 2 cols each) + "> " prefix (2)
  const lineText = lines[cursorLineIdx] ?? '';
  const column = 2 + stringWidth(lineText.substring(0, cursorCol));

  // Fork native: declares cursor position relative to the ref'd Box.
  // The fork engine handles displayCursor preamble automatically — no manual CUP.
  const setRef = useDeclaredCursor({
    line: cursorLineIdx,
    column,
    active: true,
  });

  const forceKey = `${inputText}|${cursorOffset}`;

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(CommandHint, { inputText, commands }),
    React.createElement(Box, { key: forceKey, flexDirection: "column", ref: setRef },
      ...lines.map((line, i) =>
        i === cursorLineIdx
          ? React.createElement(Text, { key: i, dimColor: true },
              `> ${line.substring(0, cursorCol)}${CURSOR_CHAR}${line.substring(cursorCol)}`)
          : React.createElement(Text, { key: i, dimColor: true }, `> ${line}`),
      ),
    ),
  );
}

export default InputBox;
