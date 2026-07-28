// ── MeasuredText + WrappedLine ──
// Extracted from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts (A级复制)
// Imports adapted: '../ink/stringWidth.js' → 'string-width'
//                  '../ink/wrapAnsi.js'    → 'wrap-ansi'
//                  './intl.js'             → './grapheme.js'

import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {
  getGraphemeSegmenter,
  getWordSegmenter,
} from './grapheme.js';

export class WrappedLine {
  constructor(
    public readonly text: string,
    public readonly startOffset: number,
    public readonly isPrecededByNewline: boolean,
    public readonly endsWithNewline: boolean = false,
  ) {}

  equals(other: WrappedLine): boolean {
    return this.text === other.text && this.startOffset === other.startOffset;
  }

  get length(): number {
    return this.text.length + (this.endsWithNewline ? 1 : 0);
  }
}

type WrappedText = string[];

export class MeasuredText {
  private _wrappedLines?: WrappedLine[];
  public readonly text: string;
  private navigationCache: Map<string, number>;
  private graphemeBoundaries?: number[];

  constructor(
    text: string,
    readonly columns: number,
  ) {
    this.text = text.normalize('NFC');
    this.navigationCache = new Map();
  }

  /**
   * Lazily computes and caches wrapped lines.
   * This expensive operation is deferred until actually needed.
   */
  private get wrappedLines(): WrappedLine[] {
    if (!this._wrappedLines) {
      this._wrappedLines = this.measureWrappedText();
    }
    return this._wrappedLines;
  }

  private getGraphemeBoundaries(): number[] {
    if (!this.graphemeBoundaries) {
      this.graphemeBoundaries = [];
      for (const { index } of getGraphemeSegmenter().segment(this.text)) {
        this.graphemeBoundaries.push(index);
      }
      // Add the end of text as a boundary
      this.graphemeBoundaries.push(this.text.length);
    }
    return this.graphemeBoundaries;
  }

  private wordBoundariesCache?: Array<{
    start: number;
    end: number;
    isWordLike: boolean;
  }>;

  /**
   * Get word boundaries using Intl.Segmenter for proper Unicode word segmentation.
   * This correctly handles CJK (Chinese, Japanese, Korean) text where each character
   * is typically its own word, as well as scripts that use spaces between words.
   */
  public getWordBoundaries(): Array<{
    start: number;
    end: number;
    isWordLike: boolean;
  }> {
    if (!this.wordBoundariesCache) {
      this.wordBoundariesCache = [];
      for (const segment of getWordSegmenter().segment(this.text)) {
        this.wordBoundariesCache.push({
          start: segment.index,
          end: segment.index + segment.segment.length,
          isWordLike: segment.isWordLike ?? false,
        });
      }
    }
    return this.wordBoundariesCache;
  }

  /**
   * Binary search for boundaries.
   * @param boundaries: Sorted array of boundaries
   * @param target: Target offset
   * @param findNext: If true, finds first boundary > target. If false, finds last boundary < target.
   * @returns The found boundary index, or appropriate default
   */
  private binarySearchBoundary(
    boundaries: number[],
    target: number,
    findNext: boolean,
  ): number {
    let left = 0;
    let right = boundaries.length - 1;
    let result = findNext ? this.text.length : 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const boundary = boundaries[mid];
      if (boundary === undefined) break;

      if (findNext) {
        if (boundary > target) {
          result = boundary;
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      } else {
        if (boundary < target) {
          result = boundary;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }

    return result;
  }

  // Convert string index to display width
  public stringIndexToDisplayWidth(text: string, index: number): number {
    if (index <= 0) return 0;
    if (index >= text.length) return stringWidth(text);
    return stringWidth(text.substring(0, index));
  }

  // Convert display width to string index
  public displayWidthToStringIndex(text: string, targetWidth: number): number {
    if (targetWidth <= 0) return 0;
    if (!text) return 0;

    // If the text matches our text, use the precomputed graphemes
    if (text === this.text) {
      return this.offsetAtDisplayWidth(targetWidth);
    }

    // Otherwise compute on the fly
    let currentWidth = 0;
    let currentOffset = 0;

    for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
      const segmentWidth = stringWidth(segment);

      if (currentWidth + segmentWidth > targetWidth) {
        break;
      }

      currentWidth += segmentWidth;
      currentOffset = index + segment.length;
    }

    return currentOffset;
  }

  /**
   * Find the string offset that corresponds to a target display width.
   */
  private offsetAtDisplayWidth(targetWidth: number): number {
    if (targetWidth <= 0) return 0;

    let currentWidth = 0;
    const boundaries = this.getGraphemeBoundaries();

    // Iterate through grapheme boundaries
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      if (start === undefined || end === undefined) continue;
      const segment = this.text.substring(start, end);
      const segmentWidth = stringWidth(segment);

      if (currentWidth + segmentWidth > targetWidth) {
        return start;
      }
      currentWidth += segmentWidth;
    }

    return this.text.length;
  }

  private measureWrappedText(): WrappedLine[] {
    const wrappedText = wrapAnsi(this.text, this.columns, {
      hard: true,
      trim: false,
    });

    const wrappedLines: WrappedLine[] = [];
    let searchOffset = 0;
    let lastNewLinePos = -1;

    const lines = wrappedText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const isPrecededByNewline = (startOffset: number) =>
        i === 0 || (startOffset > 0 && this.text[startOffset - 1] === '\n');

      if (text.length === 0) {
        // For blank lines, find the next newline character after the last one
        lastNewLinePos = this.text.indexOf('\n', lastNewLinePos + 1);

        if (lastNewLinePos !== -1) {
          const startOffset = lastNewLinePos;
          const endsWithNewline = true;

          wrappedLines.push(
            new WrappedLine(
              text,
              startOffset,
              isPrecededByNewline(startOffset),
              endsWithNewline,
            ),
          );
        } else {
          // If we can't find another newline, this must be the end of text
          const startOffset = this.text.length;
          wrappedLines.push(
            new WrappedLine(
              text,
              startOffset,
              isPrecededByNewline(startOffset),
              false,
            ),
          );
        }
      } else {
        // For non-blank lines, find the text in this.text
        const startOffset = this.text.indexOf(text, searchOffset);

        if (startOffset === -1) {
          throw new Error('Failed to find wrapped line in text');
        }

        searchOffset = startOffset + text.length;

        // Check if this line ends with a newline in this.text
        const potentialNewlinePos = startOffset + text.length;
        const endsWithNewline =
          potentialNewlinePos < this.text.length &&
          this.text[potentialNewlinePos] === '\n';

        if (endsWithNewline) {
          lastNewLinePos = potentialNewlinePos;
        }

        wrappedLines.push(
          new WrappedLine(
            text,
            startOffset,
            isPrecededByNewline(startOffset),
            endsWithNewline,
          ),
        );
      }
    }

    return wrappedLines;
  }

  public getWrappedText(): WrappedText {
    return this.wrappedLines.map(line =>
      line.isPrecededByNewline ? line.text : line.text.trimStart(),
    );
  }

  public getWrappedLines(): WrappedLine[] {
    return this.wrappedLines;
  }

  private getLine(line: number): WrappedLine {
    const lines = this.wrappedLines;
    return lines[Math.max(0, Math.min(line, lines.length - 1))]!;
  }

  public getOffsetFromPosition(position: { line: number; column: number }): number {
    const wrappedLine = this.getLine(position.line);

    // Handle blank lines specially
    if (wrappedLine.text.length === 0 && wrappedLine.endsWithNewline) {
      return wrappedLine.startOffset;
    }

    // Account for leading whitespace
    const leadingWhitespace = wrappedLine.isPrecededByNewline
      ? 0
      : wrappedLine.text.length - wrappedLine.text.trimStart().length;

    // Convert display column to string index
    const displayColumnWithLeading = position.column + leadingWhitespace;
    const stringIndex = this.displayWidthToStringIndex(
      wrappedLine.text,
      displayColumnWithLeading,
    );

    // Calculate the actual offset
    const offset = wrappedLine.startOffset + stringIndex;

    // For normal lines
    const lineEnd = wrappedLine.startOffset + wrappedLine.text.length;

    // Don't allow going past the end of the current line into the next line
    // unless we're at the very end of the text
    let maxOffset = lineEnd;
    const lineDisplayWidth = stringWidth(wrappedLine.text);
    if (wrappedLine.endsWithNewline && position.column > lineDisplayWidth) {
      // Allow positioning after the newline
      maxOffset = lineEnd + 1;
    }

    return Math.min(offset, maxOffset);
  }

  public getLineLength(line: number): number {
    const wrappedLine = this.getLine(line);
    return stringWidth(wrappedLine.text);
  }

  public getPositionFromOffset(offset: number): { line: number; column: number } {
    const lines = this.wrappedLines;
    for (let line = 0; line < lines.length; line++) {
      const currentLine = lines[line]!;
      const nextLine = lines[line + 1];
      if (
        offset >= currentLine.startOffset &&
        (!nextLine || offset < nextLine.startOffset)
      ) {
        // Calculate string position within the line
        const stringPosInLine = offset - currentLine.startOffset;

        // Handle leading whitespace for wrapped lines
        let displayColumn: number;
        if (currentLine.isPrecededByNewline) {
          // For lines preceded by newline, calculate display width directly
          displayColumn = this.stringIndexToDisplayWidth(
            currentLine.text,
            stringPosInLine,
          );
        } else {
          // For wrapped lines, we need to account for trimmed whitespace
          const leadingWhitespace =
            currentLine.text.length - currentLine.text.trimStart().length;
          if (stringPosInLine < leadingWhitespace) {
            // Cursor is in the trimmed whitespace area, position at start
            displayColumn = 0;
          } else {
            // Calculate display width from the trimmed text
            const trimmedText = currentLine.text.trimStart();
            const posInTrimmed = stringPosInLine - leadingWhitespace;
            displayColumn = this.stringIndexToDisplayWidth(
              trimmedText,
              posInTrimmed,
            );
          }
        }

        return {
          line,
          column: Math.max(0, displayColumn),
        };
      }
    }

    // If we're past the last character, return the end of the last line
    const line = lines.length - 1;
    const lastLine = this.wrappedLines[line]!;
    return {
      line,
      column: stringWidth(lastLine.text),
    };
  }

  public get lineCount(): number {
    return this.wrappedLines.length;
  }

  private withCache<T>(key: string, compute: () => T): T {
    const cached = this.navigationCache.get(key);
    if (cached !== undefined) return cached as T;

    const result = compute();
    this.navigationCache.set(key, result as number);
    return result;
  }

  nextOffset(offset: number): number {
    return this.withCache(`next:${offset}`, () => {
      const boundaries = this.getGraphemeBoundaries();
      return this.binarySearchBoundary(boundaries, offset, true);
    });
  }

  prevOffset(offset: number): number {
    if (offset <= 0) return 0;

    return this.withCache(`prev:${offset}`, () => {
      const boundaries = this.getGraphemeBoundaries();
      return this.binarySearchBoundary(boundaries, offset, false);
    });
  }

  /**
   * Snap an arbitrary code-unit offset to the start of the containing grapheme.
   * If offset is already on a boundary, returns it unchanged.
   */
  snapToGraphemeBoundary(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.text.length) return this.text.length;
    const boundaries = this.getGraphemeBoundaries();
    // Binary search for largest boundary <= offset
    let lo = 0;
    let hi = boundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (boundaries[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return boundaries[lo]!;
  }
}
