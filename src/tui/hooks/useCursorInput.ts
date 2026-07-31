// ── Cursor input hook (wraps ink useInput + Cursor model) ──
// P0: replaces simple character-by-character input with full cursor navigation

import { useState, useCallback, useRef } from 'react';
// P10: CC terminal input layer replaces npm ink useInput
import { useInput } from './useTerminalInput.js';
import { Cursor, getLastKill, yankPop, recordYank, updateYankLength, resetKillAccumulation } from '../utils/Cursor.js';

interface UseCursorInputOptions {
  onSubmit: (text: string) => void;
  onCommand?: (inputText: string) => boolean;
  onBash?: (cmd: string) => void;
  onPasteOverflow?: (fullLen: number) => void;
  /** P3: set false while an interaction prompt owns the keyboard. */
  isActive?: boolean;
}

export function useCursorInput({ onSubmit, onCommand, onBash, onPasteOverflow, isActive = true }: UseCursorInputOptions) {
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
    // P0-Gap-1: normalize Windows line endings before any processing.
    // \r\n and standalone \r → \n prevents cursor column drift in
    // InputBox multi-line split and avoids carriage-return artifacts.
    const char = inputChar.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Ink's Key type lacks home/end, but runtime may populate them.
    // Cast to access optional extended properties.
    const keyEx = key as typeof key & { home?: boolean; end?: boolean };

    setCursor((prev) => {
      // ── History navigation: ↑ / Ctrl+P ──
      // Ctrl+Up/Ctrl+Down reserved for Vim line navigation (up/down)
      if ((key.upArrow && !key.ctrl) || (char === '\x10')) { // Ctrl+P
        return historyUp(prev);
      }

      // ── History navigation: ↓ / Ctrl+N ──
      if ((key.downArrow && !key.ctrl) || (char === '\x0E')) { // Ctrl+N
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
        // Belt-and-suspenders: normalize prev.text in case any \r slipped through
        const trimmed = prev.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
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
      // Ctrl+Home → start of file, Ctrl+End → end of file
      if (keyEx.home) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.startOfFirstLine() : prev.startOfLine();
      }
      if (keyEx.end) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.endOfFile() : prev.endOfLine();
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
      // Ctrl+Up / Ctrl+Down → Vim line navigation (up/down in wrapped display)
      if (key.upArrow) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.up() : historyUp(prev);
      }
      if (key.downArrow) {
        historyIndexRef.current = -1;
        return key.ctrl ? prev.down() : historyDown(prev);
      }

      // ── Meta+B → prevWord, Meta+F → nextWord, Meta+Y → yank-pop ──
      if (key.meta) {
        historyIndexRef.current = -1;
        if (char === 'b') return prev.prevWord();
        if (char === 'f') return prev.nextWord();
        if (char === 'd') return prev.deleteWordAfter();
        if (char === 'y') {
          // Alt+Y: yank-pop — cycle through kill ring, replacing the last yanked text
          const result = yankPop();
          if (result) {
            // Delete old yank text (at result.start, length result.length)
            // then insert new kill ring item
            const before = prev.text.slice(0, result.start);
            const after = prev.text.slice(result.start + result.length);
            const newText = before + result.text + after;
            const newOffset = result.start + result.text.length;
            recordYank(result.start, result.text.length);
            return Cursor.fromText(newText, columns, newOffset);
          }
          return prev;
        }
      }

      // ── Deletion — exit history mode ──
      // Cross-platform Backspace fix:
      // Ink's parseKeypress maps \x7f to key.name='delete' (parse-keypress.js:163).
      // But on Windows Terminal / macOS, the physical Backspace KEY sends \x7f.
      // So pressing Backspace sets key.delete=true, key.backspace=false, and the
      // old key.delete→del() branch deleted the char AFTER the cursor — a no-op
      // when the cursor is at end of line (the common case), making Backspace
      // appear dead. Treat key.backspace OR key.delete as Backspace semantics.
      if (key.backspace || key.delete) {
        historyIndexRef.current = -1;
        // Meta+Backspace → deleteWordBefore
        if (key.meta) {
          const result = prev.deleteWordBefore();
          return result.cursor;
        }
        return prev.backspace();
      }

      // ── Ctrl+A/E/K/U/W — line operations — exit history mode ──
      if (key.ctrl) {
        historyIndexRef.current = -1;
        if (char === '\x01') return prev.startOfLine();                // Ctrl+A
        if (char === '\x05') return prev.endOfLine();                  // Ctrl+E
        if (char === '\x0B') {                                         // Ctrl+K: delete to line end
          const result = prev.deleteToLineEnd();
          return result.cursor;
        }
        if (char === '\x15') {                                         // Ctrl+U: delete to line start
          const result = prev.deleteToLineStart();
          return result.cursor;
        }
        if (char === '\x17') {                                         // Ctrl+W: delete word before
          const result = prev.deleteWordBefore();
          return result.cursor;
        }
        if (char === '\x19') {                                         // Ctrl+Y: yank (paste) from kill ring
          const killed = getLastKill();
          if (killed) {
            const start = prev.offset;
            // Record yank position before insert so Alt+Y can replace it
            recordYank(start, killed.length);
            resetKillAccumulation();
            return prev.insert(killed);
          }
          return prev;
        }
        // Ctrl+N/P handled above (history navigation)
        return prev;
      }

      // ── Printable characters — exit history mode ──
      if (char && !key.ctrl && !key.meta && char >= ' ') {
        historyIndexRef.current = -1;
        // Paste detection: single input >100 chars with newlines → truncate to 10K
        if (char.length > 100 && char.includes('\n')) {
          const truncated = char.slice(0, 10000);
          onPasteOverflow?.(inputChar.length);
          return prev.insert(truncated.replace(/\n/g, ' '));
        }
        return prev.insert(char.replace(/\n/g, ' '));
      }

      return prev;
    });
  }, { isActive });

  return {
    inputText: cursor.text,
    cursorOffset: cursor.offset,
    clear,
  };
}
