export interface DictionarySense { definition: string; examples: string[] }

export interface DictionaryEntry {
  /** The headword as the dictionary spells it. */
  lemma: string
  /** The dictionary's own label, such as noun, verb, adj, adv or intj. */
  partOfSpeech: string
  senses: DictionarySense[]
  /** Shown above the meanings, for example "plural of mouse". */
  note?: string
}

export interface DictionarySource { name: string; license: string; url: string }

export interface DictionaryResult { query: string; entries: DictionaryEntry[]; source: DictionarySource }

/** Selected text and any adjacent text available to the caller. Whitespace marks word boundaries. */
export interface Selection { text: string; before?: string; after?: string }

export interface Dictionary { define(selection: Selection): Promise<DictionaryResult> }

export const SELECTION_LIMITS = { contextChars: 120, definableChars: 80, definableWords: 4 } as const

/** Random access to a stored file. `end` is exclusive, and the read must return `end - start` bytes. */
export interface ByteSource {
  readonly size: number
  read(start: number, end: number): Promise<Uint8Array>
}

/** The checkpoint's compact-v1 prompt format, using the model metadata's field names. */
export interface SenseFormat {
  letters: string[]
  nota_index: number
  none_text: string
  separator: string
  mask_token: string
  max_length: number
  temperature: number
}

/** An error with a stable code the interface can translate. */
export class CodedError extends Error {
  constructor(readonly code: string, message = code, readonly details?: Record<string, unknown>) { super(message) }
}
