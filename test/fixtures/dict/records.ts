// Hand-written pack records for the reader and lookup tests, in the shape the
// builder writes (docs/pack-format.md). Not in key order on purpose: the
// helpers sort them.
import type { PackRecord } from '../../../src/dict/pack-format'

export const RECORDS: PackRecord[] = [
  { k: 'mouse', e: [
    { w: 'MOUSE', p: 'noun', s: ['Acronym of minimal orbital unmanned satellite of the Earth.'] },
    { w: 'mouse', p: 'noun', s: [
      ['Any small rodent of the genus Mus.', 'a field mouse', 'There is a mouse under the stove.'],
      ['(computing) A computer input device that moves a pointer.', 'Drag the mouse to move the cursor.'],
    ] },
    { w: 'mouse', p: 'verb', s: ['(intransitive) To hunt or catch mice.', 'To move cautiously or furtively.'] },
  ] },
  { k: 'mice', e: [
    { w: 'mice', p: 'noun', f: [{ l: 'mouse', n: 'plural of mouse' }] },
    { w: 'mice', p: 'verb', s: ['(Bermuda) To be distracted or inattentive.'] },
  ] },
  { k: 'bank', e: [
    { w: 'bank', p: 'noun', s: [['An institution where one can place and borrow money.', 'She works at a bank.'], 'The sloping side of a river.'] },
    { w: 'bank', p: 'noun', s: ['A row or panel of items, such as keys or switches.'] },
    { w: 'bank', p: 'verb', s: ['To deposit in a bank.'] },
  ] },
  { k: 'run', e: [
    { w: 'run', p: 'noun', s: ['Act or instance of running.'] },
    { w: 'run', p: 'verb', s: ['To move swiftly.', '(intransitive) To compete in a race.'] },
  ] },
  { k: 'ran', e: [{ w: 'ran', p: 'verb', f: [{ l: 'run', n: 'simple past of run' }, { l: 'rin', n: 'simple past of rin' }] }] },
  { k: 'rin', e: [{ w: 'rin', p: 'verb', s: ['(Scotland) To run.'] }] },
  { k: 'running', e: [
    { w: 'running', p: 'adj', s: ['Moving or advancing at a run.'] },
    { w: 'running', p: 'verb', f: [{ l: 'run', n: 'present participle and gerund of run' }] },
  ] },
  { k: 'went', e: [{ w: 'went', p: 'verb', f: [{ l: 'go', n: 'simple past of go' }, { l: 'go', n: '(nonstandard) past participle of go' }] }] },
  { k: 'go', e: [
    { w: 'go', p: 'noun', s: ['A board game for two players.'] },
    { w: 'go', p: 'verb', s: ['To move from one place to another.'] },
  ] },
  { k: 'better', e: [{ w: 'better', p: 'adv', s: ['Used to suggest that something should be done.'], f: [{ l: 'well', n: 'comparative form of well: more well' }] }] },
  { k: 'well', e: [
    { w: 'well', p: 'adv', s: ['Accurately; competently.'] },
    { w: 'well', p: 'noun', s: ['A hole sunk into the ground to reach water.'] },
  ] },
  { k: 'neural network', e: [{ w: 'neural network', p: 'noun', s: ['(machine learning) A computer system loosely modelled on the brain.'] }] },
  { k: 'neural networks', e: [{ w: 'neural networks', p: 'noun', f: [{ l: 'neural network', n: 'plural of neural network' }] }] },
  { k: 'network', e: [{ w: 'network', p: 'noun', s: ['A fabric or structure of cords or wires.'] }] },
  { k: 'neural', e: [{ w: 'neural', p: 'adj', s: ['Of or relating to the nerves.'] }] },
  { k: 'artificial neural network', e: [{ w: 'artificial neural network', p: 'noun', s: ['A neural network made by people.'] }] },
  { k: "rock 'n' roll", e: [{ w: "rock 'n' roll", p: 'noun', s: ['A style of music.'] }] },
  { k: 'roll', e: [{ w: 'roll', p: 'verb', s: ['To turn over and over.'] }] },
  { k: "don't", e: [{ w: "don't", p: 'verb', s: [['Do not.', "Don't be such a nuisance!"]] }] },
  { k: "o'clock", e: [{ w: "o'clock", p: 'adv', s: ['Of the clock.'] }] },
  { k: "'tis", e: [{ w: "'tis", p: 'contraction', s: ['It is.'] }] },
  { k: 'dog', e: [{ w: 'dog', p: 'noun', s: ['A domesticated mammal.'] }] },
  { k: 'e-mail', e: [{ w: 'e-mail', p: 'noun', s: ['Electronic mail.'] }] },
  { k: 'well-known', e: [{ w: 'well-known', p: 'adj', s: ['Widely known.'] }] },
  { k: 'known', e: [{ w: 'known', p: 'adj', s: ['Having been discovered.'] }] },
  { k: 'self', e: [{ w: 'self', p: 'noun', s: ['The individual person.'] }] },
  { k: 'attention', e: [{ w: 'attention', p: 'noun', s: ['Mental focus.'] }] },
  { k: 'unfriend', e: [{ w: 'unfriend', p: 'verb', s: ['To remove from a list of friends.'] }] },
  { k: 'google', e: [{ w: 'google', p: 'verb', s: ['To search for on the Internet.'] }] },
  { k: 'stop', e: [{ w: 'stop', p: 'verb', s: ['To cease moving.'] }] },
  { k: 'fly', e: [{ w: 'fly', p: 'verb', s: ['To travel through the air.'] }] },
  { k: 'happy', e: [{ w: 'happy', p: 'adj', s: ['Feeling joy.'] }] },
  { k: 'polish', e: [
    { w: 'Polish', p: 'adj', s: ['Of Poland.'] },
    { w: 'polish', p: 'noun', s: ['A substance used to polish.'] },
    { w: 'polish', p: 'verb', s: ['To make smooth and shiny.'] },
  ] },
  { k: 'chaina', e: [{ w: 'chaina', p: 'noun', f: [{ l: 'chainb', n: 'plural of chainb' }] }] },
  { k: 'chainb', e: [{ w: 'chainb', p: 'noun', f: [{ l: 'chainc', n: 'alternative plural of chainc' }] }] },
  { k: 'chainc', e: [{ w: 'chainc', p: 'noun', s: ['The end of the chain.'] }] },
  { k: 'loopa', e: [{ w: 'loopa', p: 'noun', f: [{ l: 'loopb', n: 'plural of loopb' }] }] },
  { k: 'loopb', e: [{ w: 'loopb', p: 'noun', f: [{ l: 'loopa', n: 'plural of loopa' }] }] },
  { k: 'smiths', e: [{ w: 'Smiths', p: 'noun', f: [{ l: 'Smith', n: 'plural of Smith' }] }] },
  { k: 'colour', e: [
    { w: 'colour', p: 'noun', s: ['The spectral composition of visible light.'] },
    { w: 'colour', p: 'verb', s: ['To give something colour.'] },
  ] },
  { k: 'colours', e: [
    { w: 'colours', p: 'noun', f: [{ l: 'colour', n: 'plural of colour' }] },
    { w: 'colours', p: 'noun', s: ['(nautical) A flag denoting the nationality of a vessel.'] },
    { w: 'colours', p: 'verb', f: [{ l: 'colour', n: 'third-person singular simple present indicative of colour' }] },
  ] },
  { k: 'café', e: [{ w: 'café', p: 'noun', s: ['A coffee shop.'] }] },
  { k: 'a', e: [{ w: 'a', p: 'article', s: ['One; any indefinite example of.'] }] },
  { k: 'the', e: [{ w: 'the', p: 'article', s: ['The definite article.'] }] },
  { k: 'at the bank', e: [{ w: 'at the bank', p: 'prep_phrase', s: ['In the bank of a river (in angling).'] }] },
  { k: 'in the running', e: [{ w: 'in the running', p: 'prep_phrase', s: ['Having a chance of winning.'] }] },
  { k: 'go home', e: [{ w: 'go home', p: 'verb', s: ['To return to one\'s home.'] }] },
  { k: 'went home', e: [{ w: 'went home', p: 'verb', f: [{ l: 'go home', n: 'simple past of go home' }] }] },
  { k: 'drag', e: [{ w: 'drag', p: 'verb', s: ['To pull along.'] }] },
]
