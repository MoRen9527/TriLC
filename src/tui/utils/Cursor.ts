// ── Cursor model ──
// Extracted from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts (A级复制)
// Stripped: kill ring, render, imageRef, Vim methods, logical-line methods,
//           delete series, findCharacter, goToLine, viewport methods
// Adapted: left() / right() — no imageRef chip-hopping

import stringWidth from 'string-width';
import { MeasuredText } from './MeasuredText.js';

type Position = {
  line: number;
  column: number;
};

export class Cursor {
  readonly offset: number;
  constructor(
    readonly measuredText: MeasuredText,
    offset: number = 0,
    readonly selection: number = 0,
  ) {
    // it's ok for the cursor to be 1 char beyond the end of the string
    this.offset = Math.max(0, Math.min(this.text.length, offset));
  }

  static fromText(
    text: string,
    columns: number,
    offset: number = 0,
    selection: number = 0,
  ): Cursor {
    // make MeasuredText on less than columns width, to account for cursor
    return new Cursor(new MeasuredText(text, columns - 1), offset, selection);
  }

  public get text(): string {
    return this.measuredText.text;
  }

  private get columns(): number {
    return this.measuredText.columns + 1;
  }

  getPosition(): Position {
    return this.measuredText.getPositionFromOffset(this.offset);
  }

  private getOffset(position: Position): number {
    return this.measuredText.getOffsetFromPosition(position);
  }

  // ── adapted: no imageRef chip-hopping ──
  left(): Cursor {
    if (this.offset === 0) return this;
    const prevOffset = this.measuredText.prevOffset(this.offset);
    return new Cursor(this.measuredText, prevOffset);
  }

  // ── adapted: no imageRef chip-hopping ──
  right(): Cursor {
    if (this.offset >= this.text.length) return this;
    const nextOffset = this.measuredText.nextOffset(this.offset);
    return new Cursor(this.measuredText, Math.min(nextOffset, this.text.length));
  }

  /**
   * Move to the start of the current line (column 0).
   * This is the raw version used internally by startOfLine.
   */
  private startOfCurrentLine(): Cursor {
    const { line } = this.getPosition();
    return new Cursor(
      this.measuredText,
      this.getOffset({ line, column: 0 }),
      0,
    );
  }

  startOfLine(): Cursor {
    const { line, column } = this.getPosition();

    // If already at start of line and not at first line, move to previous line
    if (column === 0 && line > 0) {
      return new Cursor(
        this.measuredText,
        this.getOffset({ line: line - 1, column: 0 }),
        0,
      );
    }

    return this.startOfCurrentLine();
  }

  firstNonBlankInLine(): Cursor {
    const { line } = this.getPosition();
    const lineText = this.measuredText.getWrappedText()[line] || '';

    const match = lineText.match(/^\s*\S/);
    const column = match?.index ? match.index + match[0].length - 1 : 0;
    const offset = this.getOffset({ line, column });

    return new Cursor(this.measuredText, offset, 0);
  }

  endOfLine(): Cursor {
    const { line } = this.getPosition();
    const column = this.measuredText.getLineLength(line);
    const offset = this.getOffset({ line, column });
    return new Cursor(this.measuredText, offset, 0);
  }

  // ── Word movement (Intl.Segmenter based) ──

  nextWord(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the next word start boundary after current position
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.start);
      }
    }

    // If no next word found, go to end
    return new Cursor(this.measuredText, this.text.length);
  }

  endOfWord(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the current word boundary we're in
    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) continue;

      // If we're inside this word but NOT at the last character
      if (this.offset >= boundary.start && this.offset < boundary.end - 1) {
        // Move to end of this word (last character position)
        return new Cursor(this.measuredText, boundary.end - 1);
      }

      // If we're at the last character of a word (end - 1), find the next word's end
      if (this.offset === boundary.end - 1) {
        // Find next word
        for (const nextBoundary of wordBoundaries) {
          if (nextBoundary.isWordLike && nextBoundary.start > this.offset) {
            return new Cursor(this.measuredText, nextBoundary.end - 1);
          }
        }
        return this;
      }
    }

    // If not in a word, find the next word and go to its end
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.end - 1);
      }
    }

    return this;
  }

  prevWord(): Cursor {
    if (this.isAtStart()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the previous word start boundary before current position
    // We need to iterate in reverse to find the previous word
    let prevWordStart: number | null = null;

    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) continue;

      // If we're at or after the start of this word, but this word starts before us
      if (boundary.start < this.offset) {
        // If we're inside this word (not at the start), go to its start
        if (this.offset > boundary.start && this.offset <= boundary.end) {
          return new Cursor(this.measuredText, boundary.start);
        }
        // Otherwise, remember this as a candidate for previous word
        prevWordStart = boundary.start;
      }
    }

    if (prevWordStart !== null) {
      return new Cursor(this.measuredText, prevWordStart);
    }

    return new Cursor(this.measuredText, 0);
  }

  // ── Text mutation ──

  modifyText(end: Cursor, insertString: string = ''): Cursor {
    const startOffset = this.offset;
    const endOffset = end.offset;

    const newText =
      this.text.slice(0, startOffset) +
      insertString +
      this.text.slice(endOffset);

    return Cursor.fromText(
      newText,
      this.columns,
      startOffset + insertString.normalize('NFC').length,
    );
  }

  insert(insertString: string): Cursor {
    const newCursor = this.modifyText(this, insertString);
    return newCursor;
  }

  del(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }
    return this.modifyText(this.right());
  }

  backspace(): Cursor {
    if (this.isAtStart()) {
      return this;
    }
    return this.left().modifyText(this);
  }

  // ── Equality / boundary checks ──

  equals(other: Cursor): boolean {
    return (
      this.offset === other.offset && this.measuredText === other.measuredText
    );
  }

  isAtStart(): boolean {
    return this.offset === 0;
  }

  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }
}
