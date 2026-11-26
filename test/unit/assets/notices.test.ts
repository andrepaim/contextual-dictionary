// The notices published next to the assets (notices/): who made each work,
// under which licence, what was changed, and the licence texts verbatim.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const read = (name: string) => fs.readFileSync(new URL(`../../../notices/${name}`, import.meta.url), 'utf8')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** The text between `----- BEGIN <title> -----` and `----- END <title> -----` lines, without those lines. */
function embedded(notice: string, title: string): string {
  const begin = notice.indexOf(`\n----- BEGIN ${title} -----\n`)
  const end = notice.indexOf(`\n----- END ${title} -----\n`)
  if (begin < 0 || end < begin) throw new Error(`no embedded ${title}`)
  return notice.slice(notice.indexOf('\n', begin + 1) + 1, end + 1)
}

describe('NOTICES-model.txt', () => {
  const notice = read('NOTICES-model.txt')

  test('names the checkpoint, its revision and licence, the base model and its licence, and the changes', () => {
    for (const part of [
      'sign/Ettin-150m-WSD', '8751b577199d1bb95b74fa2457da7065d57100ae', 'https://huggingface.co/sign/Ettin-150m-WSD/tree/8751b577199d1bb95b74fa2457da7065d57100ae',
      'Apache License, Version 2.0', 'jhu-clsp/ettin-encoder-150m', 'https://huggingface.co/jhu-clsp/ettin-encoder-150m', 'MIT',
      'compact-v1', 'INT8 ONNX', 'ettin-150m-wsd-int8.onnx.gz', 'model_metadata.json', 'calibration.json', 'tokenizer.json', 'tokenizer_config.json',
    ]) expect(notice, part).toContain(part)
  })

  test('says the model was fine-tuned from that checkpoint, with which teacher and on which data, under which licences (assets-v2)', () => {
    for (const part of [
      'assets-v2', 'sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3',
      'sign/Ettin-1B-WSD', 'e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc', 'https://huggingface.co/sign/Ettin-1B-WSD/tree/e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc',
      'English Wiktionary', 'Kaikki.org', '2026-10-30', 'CC BY-SA 4.0', 'GFDL',
      'English Wikipedia', 'https://huggingface.co/datasets/wikimedia/wikipedia', 'b04c8d1ceb2f5cd4588862100d08de323dccfbaa', 'CC BY-SA 3.0',
      'docs/validation.md',
    ]) expect(notice, part).toContain(part)
  })

  test('holds the Apache-2.0 text as published by the ASF and the base model MIT licence', () => {
    // SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt
    expect(digest(embedded(notice, 'Apache License, Version 2.0'))).toBe('cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30')
    const mit = embedded(notice, 'MIT License of jhu-clsp/ettin-encoder-150m')
    expect(mit).toContain('Copyright (c) 2025 Johns Hopkins University Center for Language and Speech Processing')
    expect(mit).toContain('Permission is hereby granted, free of charge')
    expect(mit).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })
})

describe('NOTICES-dictionary.txt', () => {
  const notice = read('NOTICES-dictionary.txt')

  test('attributes Wiktionary and Kaikki.org, states the snapshot, the licence and the changes', () => {
    for (const part of [
      'wiktionary-en-v1.pack', 'https://en.wiktionary.org/', 'Wiktionary contributors', 'https://kaikki.org/', 'wiktextract', '2026-10-30',
      'CC BY-SA 4.0', 'GFDL', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://creativecommons.org/licenses/by-sa/4.0/legalcode',
      'docs/dictionary-build.md', 'docs/pack-format.md', 'two', 'Tatu Ylonen: Wiktextract: Wiktionary as Machine-Readable Structured Data',
    ]) expect(notice, part).toContain(part)
  })

  test('holds the CC BY-SA 4.0 legal code as published by Creative Commons', () => {
    // SHA-256 of https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt, fetched on 2026-11-23.
    expect(digest(embedded(notice, 'CC BY-SA 4.0 legal code'))).toBe('28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5')
  })
})

test('the embedded() helper refuses a notice without the section', () => {
  expect(() => embedded('nothing here\n', 'X')).toThrow()
})
