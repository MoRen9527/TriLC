// Intl wrapper — the ink engine needs a grapheme segmenter for text
// measurement (CJK grapheme boundaries). Node 16+ has Intl.Segmenter.
export const getGraphemeSegmenter = () => new Intl.Segmenter(undefined, { granularity: 'grapheme' });
