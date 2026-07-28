// ── Grapheme/Word segmenter utilities ──
// Extracted from CC 2.1.88 vendor/cc-tui/utils/intl.js (A级复制)

let graphemeSegmenter: Intl.Segmenter | null = null;
let wordSegmenter: Intl.Segmenter | null = null;

/** Lazy singleton: grapheme-level segmenter (locale: en) */
export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  }
  return graphemeSegmenter;
}

/** Lazy singleton: word-level segmenter (locale: en) */
export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
  }
  return wordSegmenter;
}

/** Return the first grapheme cluster from `text`, or empty string if empty. */
export function firstGrapheme(text: string): string {
  if (!text) return '';
  const segments = getGraphemeSegmenter().segment(text);
  const first = segments[Symbol.iterator]().next();
  return first.done ? '' : first.value.segment;
}
