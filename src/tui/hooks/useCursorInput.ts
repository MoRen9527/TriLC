// ── Cursor input hook (wraps ink useInput + Cursor model) ──
// P0: replaces simple character-by-character input with full cursor navigation

import { useState, useCallback, useRef } from 'react';
import { useInput } from 'ink';
import { Cursor } from '../utils/Cursor.js';

interface UseCursorInputOptions {
  onSubmit: (text: string) => void;
  onCommand?: (inputText: string) => boolean;
}

export function useCursorInput({ onSubmit, onCommand }: UseCursorInputOptions) {
  const columns = Math.max(20, (process.stdout?.columns ?? 80) - 4);
  const [cursor, setCursor] = useState<Cursor>(() =>
    Cursor.fromText('', columns),
  );

  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1); // -1 = live input
  const draftRef = useRef<string>('');

  const clear = useCallback(() => {
    historyIndexRef.current = -1;
    draftRef.current = '';
    setCursor(Cursor.fromText('', columns));
  }, [columns]);

  useInput((inputChar, key) => {
    setCursor((prev) => {
      // ── History navigation: ↑ (up arrow) ──
      if (key.upArrow) {
        const history = historyRef.current;
        if (history.length === 0) return prev;
        if (historyIndexRef.current === -1) {
          // Coming from live input: save current text as draft
          draftRef.current = prev.text;
          historyIndexRef.current = history.length - 1;
          return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
        }
        if (historyIndexRef.current > 0) {
          historyIndexRef.current--;
          return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
        }
        return prev;
      }

      // ── History navigation: ↓ (down arrow) ──
      if (key.downArrow) {
        const history = historyRef.current;
        if (historyIndexRef.current === -1) return prev;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current++;
          return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
        }
        // Back to live: restore draft
        historyIndexRef.current = -1;
        return Cursor.fromText(draftRef.current, columns, draftRef.current.length);
      }

      // ── Submit on Enter ──
      if (key.return) {
        const trimmed = prev.text.trim();
        if (!trimmed) return Cursor.fromText('', columns);

        if (trimmed.startsWith('/') && onCommand) {
          const handled = onCommand(trimmed);
          if (handled) {
            historyRef.current.push(trimmed);
          }
        } else {
          onSubmit(trimmed);
          historyRef.current.push(trimmed);
        }
        historyIndexRef.current = -1;
        draftRef.current = '';
        return Cursor.fromText('', columns);
      }

      // ── Arrow navigation (Ctrl = word-level jump) — exit history mode ──
      if (key.leftArrow) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.prevWord() : prev.left();
      }
      if (key.rightArrow) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.nextWord() : prev.right();
      }

      // ── Deletion — exit history mode ──
      if (key.backspace) {
        historyIndexRef.current = -1;
        return prev.backspace();
      }
      if (key.delete) {
        historyIndexRef.current = -1;
        return prev.del();
      }

      // ── Ctrl+A → start of line, Ctrl+E → end of line — exit history mode ──
      if (inputChar === '\x01') {
        historyIndexRef.current = -1;
        return prev.startOfLine();
      }
      if (inputChar === '\x05') {
        historyIndexRef.current = -1;
        return prev.endOfLine();
      }

      // ── Printable characters — exit history mode ──
      if (inputChar && !key.ctrl && !key.meta && inputChar >= ' ') {
        historyIndexRef.current = -1;
        return prev.insert(inputChar.replace(/\n/g, ' '));
      }

      return prev;
    });
  });

  return {
    inputText: cursor.text,
    cursorOffset: cursor.offset,
    clear,
  };
}
