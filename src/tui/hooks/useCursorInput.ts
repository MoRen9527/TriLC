// ── Cursor input hook (wraps ink useInput + Cursor model) ──
// P0: replaces simple character-by-character input with full cursor navigation

import { useState, useCallback } from 'react';
import { useInput } from 'ink';
import { Cursor } from '../utils/Cursor.js';

interface UseCursorInputOptions {
  onSubmit: (text: string) => void;
}

export function useCursorInput({ onSubmit }: UseCursorInputOptions) {
  const columns = Math.max(20, (process.stdout?.columns ?? 80) - 4);
  const [cursor, setCursor] = useState<Cursor>(() =>
    Cursor.fromText('', columns),
  );

  const clear = useCallback(() => {
    setCursor(Cursor.fromText('', columns));
  }, [columns]);

  useInput((inputChar, key) => {
    setCursor((prev) => {
      // Submit on Enter
      if (key.return) {
        if (prev.text.trim()) {
          onSubmit(prev.text.trim());
        }
        return Cursor.fromText('', columns);
      }

      // Arrow navigation (Ctrl = word-level jump)
      if (key.leftArrow) {
        return key.ctrl ? prev.prevWord() : prev.left();
      }
      if (key.rightArrow) {
        return key.ctrl ? prev.nextWord() : prev.right();
      }

      // Deletion
      if (key.backspace) return prev.backspace();
      if (key.delete) return prev.del();

      // Ctrl+A → start of line, Ctrl+E → end of line
      // (terminals send \x01 / \x05 for these control characters)
      if (inputChar === '\x01') return prev.startOfLine();
      if (inputChar === '\x05') return prev.endOfLine();

      // Printable characters (exclude control/meta sequences)
      if (inputChar && !key.ctrl && !key.meta && inputChar >= ' ') {
        // Normalize multi-line paste to single line
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
