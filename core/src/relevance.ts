// Word overlap between an intent and each section. Never decides what is kept: it
// can't judge meaning (synonyms, other languages). It only orders lines inside a
// group the API already judged relevant, so the matching lines come first rather
// than whichever happen to be at the top. Any language: words are split on Unicode
// letters, and a word that doesn't match simply doesn't count.

const STOPWORDS = new Set("a an and are as at be by do does for from how i if in is it of on or so that the this to was we what when where which who why with you".split(" "));

// A word found in more than this share of sections is too common to signal relevance.
const COMMON_WORD_SHARE = 0.6;
// Below this many sections, word frequencies say nothing reliable.
const MIN_SECTIONS_FOR_FREQUENCY = 5;

/** Rough stem: drop a plural or verb ending, then compare the first 5 letters ("tests"/"test", "failing"/"fail"). */
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w).slice(0, 5);

/** The stemmed content words of a text. */
function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem),
  );
}

/**
 * For each section, the share of the query's words it contains, 0 to 1 (square
 * root: matching a few words of a long query is already a strong signal). Words
 * present in most sections ("src" in a file listing, "INFO" in a log) can't tell
 * sections apart, so they don't count: only the rarer words decide.
 */
export function wordOverlap(query: string, sections: string[]): number[] {
  const sectionWords = sections.map(words);
  let q = [...words(query)];
  if (sections.length >= MIN_SECTIONS_FOR_FREQUENCY) {
    q = q.filter((w) => sectionWords.filter((s) => s.has(w)).length / sections.length <= COMMON_WORD_SHARE);
  }
  if (!q.length) return sections.map(() => 0);
  return sectionWords.map((s) => Math.sqrt(q.filter((w) => s.has(w)).length / q.length));
}
