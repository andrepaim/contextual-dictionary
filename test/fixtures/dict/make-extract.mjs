// Writes kaikki-extract.ndjson: a hand-made extract in the shape of Kaikki's
// wiktextract English JSONL. Run with `node make-extract.mjs` after editing.
import fs from 'node:fs'

const usage = (text) => ({ text, type: 'example' })
const quote = (text, ref = '2001, Some Author, Some Book') => ({ text, ref, type: 'quotation' })
const formOf = (word, gloss, extra = {}) => ({ glosses: [gloss], form_of: [{ word }], tags: ['form-of'], ...extra })

const entries = [
  // Same spelling in several parts of speech, examples over the cap and over 240 characters.
  { word: 'mouse', pos: 'noun', senses: [
    { glosses: ['Any small rodent of the genus Mus.'], raw_glosses: ['Any small rodent of the genus Mus.'], examples: [
      quote('The cat caught a mouse in the barn, and the farmer was glad of it.'),
      usage('a field mouse'),
      usage('There is a mouse under the stove.'),
      usage('This example is far too long to be kept. '.repeat(8)),
    ] },
    { glosses: ['A computer input device that is moved over a pad or other flat surface to produce a corresponding movement of a pointer on a graphical display.'],
      raw_glosses: ['(computing) A computer input device that is moved over a pad or other flat surface to produce a corresponding movement of a pointer on a graphical display.'],
      examples: [usage('Drag the mouse to move the cursor.'), { text: 'He clicked the   mouse\nand waited.', ref: '1990, A Writer' }] },
    { glosses: [], tags: ['no-gloss'] },
  ] },
  { word: 'mouse', pos: 'verb', senses: [
    { glosses: ['To hunt or catch mice, usually of cats.'], raw_glosses: ['(intransitive) To hunt or catch mice, usually of cats. [from 12th c.]'] },
    { glosses: ['To move cautiously or furtively.'] },
  ] },
  // Proper names are out of scope.
  { word: 'Mouse', pos: 'name', senses: [{ glosses: ['A surname.'] }] },
  { word: 'MOUSE', pos: 'noun', senses: [{ glosses: ['Acronym of minimal orbital unmanned satellite of the Earth.'], alt_of: [{ word: 'minimal orbital unmanned satellite of the Earth' }], tags: ['acronym', 'alt-of'] }] },
  // Inflections become pointers; the page lists the plural first.
  { word: 'mice', pos: 'noun', senses: [formOf('mouse', 'plural of mouse')] },
  { word: 'mice', pos: 'verb', senses: [{ glosses: ['To be distracted or inattentive.'], raw_glosses: ['(Bermuda) To be distracted or inattentive.'] }] },
  // Two etymologies with the same part of speech.
  { word: 'bank', pos: 'noun', etymology_number: 1, senses: [
    { glosses: ['An institution where one can place and borrow money.'], examples: [usage('She works at a bank.')] },
    { glosses: ['The sloping side of a river.'] },
  ] },
  { word: 'bank', pos: 'verb', senses: [{ glosses: ['To deposit in a bank.'] }] },
  { word: 'bank', pos: 'noun', etymology_number: 2, senses: [{ glosses: ['A row or panel of items, such as keys or switches.'] }] },
  // Multi-level glosses.
  { word: 'run', pos: 'verb', senses: [
    { glosses: ['To move swiftly.'] },
    { glosses: ['To move swiftly.', 'To move forward quickly upon two feet by alternately making a short jump off either foot.'] },
    { glosses: ['To move swiftly.', 'To move swiftly. Specifically, of a vehicle: to travel.'] },
    { glosses: ['To compete in a race.'], raw_glosses: ['(intransitive) To compete in a race.'] },
  ] },
  { word: 'run', pos: 'noun', senses: [{ glosses: ['Act or instance of running.'] }] },
  { word: 'ran', pos: 'verb', senses: [formOf('run', 'simple past of run'), formOf('rin', 'simple past of rin')] },
  { word: 'rin', pos: 'verb', senses: [{ glosses: ['To run.'], raw_glosses: ['(Scotland) To run.'] }] },
  { word: 'running', pos: 'verb', senses: [formOf('run', 'present participle and gerund of run')] },
  { word: 'running', pos: 'adj', senses: [
    { glosses: ['Moving or advancing at a run.'] },
    { glosses: ['Moving or advancing at a run.', 'Of a horse, having a running gait; not a trotter or pacer.'] },
  ] },
  // Two pointers to the same base and part of speech; labels on a pointer.
  { word: 'went', pos: 'verb', senses: [
    formOf('go', 'simple past of go'),
    formOf('go', 'past participle of go', { raw_glosses: ['(nonstandard) past participle of go'] }),
  ] },
  { word: 'go', pos: 'verb', senses: [{ glosses: ['To move from one place to another.'] }] },
  { word: 'go', pos: 'noun', senses: [{ glosses: ['A board game for two players.'] }] },
  // An entry with both an inflection sense and senses of its own.
  { word: 'better', pos: 'adv', senses: [
    formOf('well', 'comparative form of well: more well'),
    { glosses: ['Used to suggest that something should be done.'] },
  ] },
  { word: 'well', pos: 'adv', senses: [{ glosses: ['Accurately; competently.'] }] },
  { word: 'well', pos: 'noun', senses: [{ glosses: ['A hole sunk into the ground to reach water.'] }] },
  // Multiword entries and their inflections.
  { word: 'neural network', pos: 'noun', senses: [{ glosses: ['A computer system loosely modelled on the brain.'], raw_glosses: ['(machine learning) A computer system loosely modelled on the brain.'] }] },
  { word: 'neural networks', pos: 'noun', senses: [formOf('neural network', 'plural of neural network')] },
  { word: 'network', pos: 'noun', senses: [{ glosses: ['A fabric or structure of cords or wires that cross at regular intervals.'] }] },
  { word: 'neural', pos: 'adj', senses: [{ glosses: ['Of or relating to the nerves.'] }] },
  { word: 'rock \'n\' roll', pos: 'noun', senses: [{ glosses: ['A style of music.'] }] },
  // Apostrophes and hyphens.
  { word: "don't", pos: 'verb', senses: [{ glosses: ['Do not.'], examples: [usage("Don't be such a nuisance!")] }] },
  { word: "don't", pos: 'contraction', senses: [{ glosses: ['Contraction of done + it.'], raw_glosses: ['(archaic) Contraction of done + it.'], alt_of: [{ word: 'done', extra: '+ it' }], tags: ['alt-of'] }] },
  { word: "o'clock", pos: 'adv', senses: [{ glosses: ['Of the clock; used to indicate the hour.'] }] },
  { word: "'tis", pos: 'contraction', senses: [{ glosses: ['It is.'] }] },
  { word: 'dog', pos: 'noun', senses: [{ glosses: ['A domesticated mammal.'] }] },
  { word: 'e-mail', pos: 'noun', senses: [{ glosses: ['Electronic mail.'] }] },
  { word: 'well-known', pos: 'adj', senses: [{ glosses: ['Widely known.'] }] },
  { word: 'known', pos: 'adj', senses: [{ glosses: ['Having been discovered.'] }] },
  { word: 'self', pos: 'noun', senses: [{ glosses: ['The individual person.'] }] },
  { word: 'attention', pos: 'noun', senses: [{ glosses: ['Mental focus.'] }] },
  // Words with no entry of their own reach these by suffix stripping.
  { word: 'unfriend', pos: 'verb', senses: [{ glosses: ['To remove from a list of friends.'] }] },
  { word: 'google', pos: 'verb', senses: [{ glosses: ['To search for on the Internet.'] }] },
  { word: 'stop', pos: 'verb', senses: [{ glosses: ['To cease moving.'] }] },
  { word: 'fly', pos: 'verb', senses: [{ glosses: ['To travel through the air.'] }] },
  // Capitalised and lower-case variants.
  { word: 'Polish', pos: 'adj', senses: [{ glosses: ['Of Poland.'] }] },
  { word: 'polish', pos: 'verb', senses: [{ glosses: ['To make smooth and shiny.'] }] },
  { word: 'polish', pos: 'noun', senses: [{ glosses: ['A substance used to polish.'] }] },
  // Single characters, symbols and punctuation are out of scope; single-letter words are not.
  { word: 'A', pos: 'character', senses: [{ glosses: ['The first letter of the English alphabet.'] }] },
  { word: 'A', pos: 'symbol', senses: [{ glosses: ['The highest grade.'] }] },
  { word: '&', pos: 'conj', senses: [{ glosses: ['Abbreviation of and.'] }] },
  { word: '!', pos: 'punct', senses: [{ glosses: ['Marks an exclamation.'] }] },
  { word: '42', pos: 'num', senses: [{ glosses: ['The number forty-two.'] }] },
  { word: 'a', pos: 'article', senses: [{ glosses: ['One; any indefinite example of.'] }] },
  // Markup left in glosses, empty glosses, ellipsis continuations.
  { word: 'markup', pos: 'noun', senses: [
    { glosses: ['God; {{n-g|the name used for God in scripture'] },
    { glosses: ['A [[link|linked]] word and a [[plain]] one, a [[passive#Adjective|]] form.'] },
    { glosses: ['Area in m<sup>2</sup>&nbsp;or ft<sub>2</sub>, a {{lb|en|rare}} value.'] },
    { glosses: ["The '''bold''' and ''italic'' parts; the prime in NR''₂ stays."] },
    { glosses: ['The operator <=> compares; Procter & Gamble; &trade; stays.'] },
    { glosses: ['   '] },
    { glosses: [''] },
    { glosses: ['{{rfdef|en}}'] },
  ] },
  { word: 'the', pos: 'article', senses: [
    { glosses: ['The definite article, used before a noun phrase that is definitely identifiable...', '...because it is known in context.'] },
  ] },
  { word: 'emptyword', pos: 'noun', senses: [{ glosses: [] }, { tags: ['no-gloss'] }] },
  // A chain of inflections and a loop of them.
  { word: 'chaina', pos: 'noun', senses: [formOf('chainb', 'plural of chainb')] },
  { word: 'chainb', pos: 'noun', senses: [formOf('chainc', 'alternative plural of chainc')] },
  { word: 'chainc', pos: 'noun', senses: [{ glosses: ['The end of the chain.'] }] },
  { word: 'loopa', pos: 'noun', senses: [formOf('loopb', 'plural of loopb')] },
  { word: 'loopb', pos: 'noun', senses: [formOf('loopa', 'plural of loopa')] },
  // An inflection of a word that is only a proper name.
  { word: 'Smiths', pos: 'noun', senses: [formOf('Smith', 'plural of Smith')] },
  { word: 'Smith', pos: 'name', senses: [{ glosses: ['A surname.'] }] },
  // Another language, a record without a word, and one with odd fields.
  { word: 'Haus', pos: 'noun', lang: 'German', lang_code: 'de', senses: [{ glosses: ['house'] }] },
  { pos: 'noun', senses: [{ glosses: ['No word.'] }] },
  { word: 'oddity', pos: 'noun', senses: [{ glosses: ['A strange thing.', 42], examples: [{ text: 7 }, null, usage('an oddity')] }, 'not a sense'] },
]

const lines = entries.map(entry => JSON.stringify({ lang: 'English', lang_code: 'en', ...entry }))
// A blank line in the middle, as a defensive case.
lines.splice(10, 0, '')
fs.writeFileSync(new URL('./kaikki-extract.ndjson', import.meta.url), `${lines.join('\n')}\n`)
