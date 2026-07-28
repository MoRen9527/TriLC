// ── Cursor input hook (wraps ink useInput + Cursor model) ──
// P0: replaces simple character-by-character input with full cursor navigation

import { useState, useCallback, useRef } from 'react';
import { useInput } from 'ink';
import { Cursor } from '../utils/Cursor.js';

interface UseCursorInputOptions {
  onSubmit: (text: string) => void;
  onCommand?: (inputText: string) => boolean;
  onBash?: (cmd: string) => void;
  onPasteOverflow?: (fullLen: number) => void;
}

export function useCursorInput({ onSubmit, onCommand, onBash, onPasteOverflow }: UseCursorInputOptions) {
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

  // ── Shared history navigation helpers ──
  const historyUp = useCallback((prev: Cursor): Cursor => {
    const history = historyRef.current;
    if (history.length === 0) return prev;
    if (historyIndexRef.current === -1) {
      draftRef.current = prev.text;
      historyIndexRef.current = history.length - 1;
      return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
    }
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
    }
    return prev;
  }, [columns]);

  const historyDown = useCallback((prev: Cursor): Cursor => {
    const history = historyRef.current;
    if (historyIndexRef.current === -1) return prev;
    if (historyIndexRef.current < history.length - 1) {
      historyIndexRef.current++;
      return Cursor.fromText(history[historyIndexRef.current], columns, history[historyIndexRef.current].length);
    }
    // Back to live: restore draft
    historyIndexRef.current = -1;
    return Cursor.fromText(draftRef.current, columns, draftRef.current.length);
  }, [columns]);

  useInput((inputChar, key) => {
    // Ink's Key type lacks home/end, but runtime may populate them.
    // Cast to access optional extended properties.
    const keyEx = key as typeof key & { home?: boolean; end?: boolean };

    setCursor((prev) => {
      // ── History navigation: ↑ / Ctrl+P ──
      if (key.upArrow || (inputChar === '\x10')) { // Ctrl+P
        return historyUp(prev);
      }

      // ── History navigation: ↓ / Ctrl+N ──
      if (key.downArrow || (inputChar === '\x0E')) { // Ctrl+N
        return historyDown(prev);
      }

      // ── Enter: submit vs multi-line insert ──
      if (key.return) {
        // Shift+Enter or Meta+Enter → insert newline (multi-line input)
        if (key.shift || key.meta) {
          historyIndexRef.current = -1;
          // Backslash continuation: if cursor preceded by '\', remove it first
          if (prev.text[prev.offset - 1] === '\\') {
            return prev.backspace().insert('\n');
          }
          return prev.insert('\n');
        }

        // Plain Enter → submit
        const trimmed = prev.text.trim();
        if (!trimmed) return Cursor.fromText('', columns);

        // !bash mode: execute shell command
        if (trimmed.startsWith('!') && onBash) {
          onBash(trimmed.slice(1).trim() || trimmed);
          historyRef.current.push(trimmed);
        } else if (trimmed.startsWith('/') && onCommand) {
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

      // ── Home / End keys (extended runtime props) ──
      if (keyEx.home) {
        historyIndexRef.current = -1;
        return prev.startOfLine();
      }
      if (keyEx.end) {
        historyIndexRef.current = -1;
        return prev.endOfLine();
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

      // ── Meta+B → prevWord, Meta+F → nextWord (Alt-based word nav) ──
      if (key.meta) {
        historyIndexRef.current = -1;
        if (inputChar === 'b') return prev.prevWord();
        if (inputChar === 'f') return prev.nextWord();
        if (inputChar === 'd') return prev.deleteWordAfter();
      }

      // ── Deletion — exit history mode ──
      if (key.backspace) {
        historyIndexRef.current = -1;
        // Meta+Backspace → deleteWordBefore
        if (key.meta) {
          const result = prev.deleteWordBefore();
          return result.cursor;
        }
        return prev.backspace();
      }
      if (key.delete) {
        historyIndexRef.current = -1;
        // Meta+Delete → deleteToLineEnd
        if (key.meta) {
          const result = prev.deleteToLineEnd();
          return result.cursor;
        }
        return prev.del();
      }

      // ── Ctrl+A/E/K/U/W — line operations — exit history mode ──
      if (key.ctrl) {
        historyIndexRef.current = -1;
        if (inputChar === '\x01') return prev.startOfLine();                // Ctrl+A
        if (inputChar === '\x05') return prev.endOfLine();                  // Ctrl+E
        if (inputChar === '\x0B') {                                         // Ctrl+K: delete to line end
          const result = prev.deleteToLineEnd();
          return result.cursor;
        }
        if (inputChar === '\x15') {                                         // Ctrl+U: delete to line start
          const result = prev.deleteToLineStart();
          return result.cursor;
        }
        if (inputChar === '\x17') {                                         // Ctrl+W: delete word before
          const result = prev.deleteWordBefore();
          return result.cursor;
        }
        // Ctrl+N/P handled above (history navigation)
        return prev;
      }

      // ── Printable characters — exit history mode ──
      if (inputChar && !key.ctrl && !key.meta && inputChar >= ' ') {
        historyIndexRef.current = -1;
        // Paste detection: single input >100 chars with newlines → truncate to 10K
        if (inputChar.length > 100 && inputChar.includes('\n')) {
          const truncated = inputChar.slice(0, 10000);
          onPasteOverflow?.(inputChar.length);
          return prev.insert(truncated.replace(/\n/g, ' '));
        }
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
