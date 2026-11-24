// Lookup keys. The builder and the lookup both go through normalizeKey, so a
// key in the pack and a key made from a selection always agree.

const APOSTROPHES = /[‘’ʼ＇]/g
const DOUBLE_QUOTES = /[“”]/g
const HYPHENS = /[‐‑]/g
const SOFT_HYPHEN = /­/g

/**
 * The key for a word or phrase: Unicode NFC, lower case, curly or modifier
 * apostrophes as `'`, curly double quotes as `"`, the Unicode hyphens U+2010
 * and U+2011 as `-`, soft hyphens removed, runs of white space as one space.
 * Dashes (en, em) and compatibility characters are left alone.
 */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(APOSTROPHES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(HYPHENS, '-')
    .replace(SOFT_HYPHEN, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFC')
}
