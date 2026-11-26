// Pure helpers of the training round's data (docs/validation.md, "Training round 1"): the held-out headwords, the seeded
// split of the other headwords into training and development, and the check that keeps any passage close to a test
// passage out of training. Tested in test/unit/validation/training-items.test.ts.
import { createHash } from 'node:crypto'

const dataLines = (text: string) => text.split('\n').filter(line => line && !line.startsWith('#'))

/**
 * Headwords that no training passage may be built for: the first column of validation/data/wiktionary-items.tsv
 * (after its header line) and the lemma column of validation/data/written-labels.tsv.
 */
export function heldOutHeadwords(wiktionaryItemsTsv: string, writtenLabelsTsv: string): Set<string> {
  return new Set([
    ...dataLines(wiktionaryItemsTsv).slice(1).map(line => line.split('\t')[0]!),
    ...dataLines(writtenLabelsTsv).map(line => line.split('\t')[1]!),
  ].filter(Boolean))
}

/** Whether `word` is on the development side: the first 32 bits of sha256(`${seed}\n${word}`), as a share of 2^32, below `share`. */
export function isDevelopmentHeadword(word: string, seed: string, share: number): boolean {
  const value = parseInt(createHash('sha256').update(`${seed}\n${word}`).digest('hex').slice(0, 8), 16) / 2 ** 32
  return value < share
}

/** Lower case, every run of characters other than ASCII letters and digits made one space, trimmed. */
export function normalizePassage(text: string): string {
  return text.toLowerCase().replace(/[^0-9a-z]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The runs of `n` consecutive words of a normalised passage. */
export function shingles(normalized: string, n = 10): Set<string> {
  const words = normalized.split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '))
  return out
}

export interface TestPassageIndex { passages: Set<string>; shingles: Set<string> }

/** The test passages (any of the three evaluation sets), normalised, and all their 10-word runs. */
export function testPassageIndex(passages: Iterable<string>): TestPassageIndex {
  const index: TestPassageIndex = { passages: new Set(), shingles: new Set() }
  for (const passage of passages) {
    const normalized = normalizePassage(passage)
    index.passages.add(normalized)
    for (const run of shingles(normalized)) index.shingles.add(run)
  }
  return index
}

/** True when `passage` equals a test passage after normalisation or shares a run of ten words with one. */
export function overlapsTestPassage(passage: string, index: TestPassageIndex): boolean {
  const normalized = normalizePassage(passage)
  if (index.passages.has(normalized)) return true
  for (const run of shingles(normalized)) if (index.shingles.has(run)) return true
  return false
}

/** An unlabelled item is dropped when its word, or any lemma its lookup returns, is held out or on the development side. */
export function blockedLookup(word: string, lemmas: readonly string[], heldOut: ReadonlySet<string>, isDevelopment: (word: string) => boolean): boolean {
  return [word, ...lemmas].some(candidate => heldOut.has(candidate) || isDevelopment(candidate))
}
