// The crew as people: a session is a person in its own color, a subagent a smaller helper in its owner's.
// Their pose says what they are doing; their hat says their role (the overseer is the king, with a crown and an
// ermine cape; a crew's lead wears a captain's hat with a white plume and a cape); their hair, skin and small marks
// say who they are. Drawn at two scales with art of their own.
import { C, PERSON, shade, type Pen, type Scale } from './kit'

export type Role = 'king' | 'lead' | 'sage' | 'worker'

export type Pose =
  | 'stand' | 'walk1' | 'walk2'
  | 'hammerUp' | 'hammerDown' // building, or at the anvil
  | 'read' | 'readTurn' // a book open in front
  | 'point' | 'write' | 'think' | 'talk'
  | 'cheer' | 'wave1' | 'wave2' | 'sad'
  | 'sit' // on the pier, fishing (rod and line are part of it)
  | 'sleep' // lying on the ground

export type Look = {
  role: Role
  /** The coat: its crew's color, the same for every member of a crew. */
  color: number
  hair: number
  pose: Pose
  /** Facing right; mirrored when false. */
  right: boolean
  /** Frame counter, four a second, for small motions inside a pose (a flicker, a bob). */
  anim: number
  /**
   * Who it is, as a number from its id (any non-negative integer; the art takes it modulo its own count): picks
   * the hairstyle, skin tone and small marks (a beard, glasses, a ponytail) so people tell apart at a glance.
   * Absent: style 0.
   */
  style?: number
}

export type HelperLook = {
  /** The owning session's color: the cap. */
  color: number
  hair: number
  carrying: '' | 'crate' | 'scroll'
  walking: boolean
  /** Working at a source: a tool moving. */
  working: boolean
  right: boolean
  anim: number
}

export const ROLES: readonly Role[] = ['king', 'lead', 'sage', 'worker']
export const POSES: readonly Pose[] = [
  'stand', 'walk1', 'walk2', 'hammerUp', 'hammerDown', 'read', 'readTurn', 'point', 'write', 'think', 'talk',
  'cheer', 'wave1', 'wave2', 'sad', 'sit', 'sleep',
]

// ---- who they are: a hairdo, a skin tone and a mark, picked together by `look.style`

type Hairdo = 'short' | 'long' | 'curly' | 'tail' | 'bald' | 'bob'
type Mark = '' | 'beard' | 'glasses' | 'blush'

/**
 * Skin tones, light to deep: the skin, a closed mouth, rosy cheeks. Each tone is at least two 12-bit steps from
 * the next in two channels, so they stay apart in the terminal, and the deepest is still light enough for dark
 * eyes and hair to read on it, on grass and on cobbles.
 */
const TONES: readonly (readonly [skin: number, mouth: number, blush: number])[] = [
  [0xf3cba5, 0xc77a62, 0xf2a08e],
  [0xdca472, 0x9a5038, 0xe8846c],
  [0xae7448, 0x5e2e1e, 0xd0705a],
  [0x8a5a3c, 0x40241a, 0xb06048],
]

/**
 * Everyone's look, by `style % STYLES.length`: a hairdo, a skin tone, a mark. Neighbours in the list differ in
 * all three, and the count (17) shares no factor with the five hair colors, so hair color varies across them too.
 */
const STYLES: readonly (readonly [Hairdo, number, Mark])[] = [
  ['short', 0, ''], ['long', 2, ''], ['curly', 3, ''], ['tail', 1, 'blush'], ['bald', 2, 'beard'],
  ['bob', 0, 'glasses'], ['short', 3, ''], ['curly', 1, 'blush'], ['long', 0, ''], ['tail', 2, ''],
  ['bald', 0, 'glasses'], ['bob', 3, ''], ['short', 1, 'glasses'], ['long', 3, 'blush'], ['curly', 0, 'beard'],
  ['tail', 3, ''], ['bob', 1, 'beard'],
]
/** How many looks there are: `look.style` is taken modulo this. */
export const STYLE_COUNT = STYLES.length

/** The distinct drawings among the styles (hairdo and mark; the skin tone is only a color). */
const LAYOUTS: (readonly [Hairdo, Mark])[] = []
const LAYOUT_OF = STYLES.map(([hairdo, , mark]) => {
  let i = LAYOUTS.findIndex(l => l[0] === hairdo && l[1] === mark)
  if (i < 0) i = LAYOUTS.push([hairdo, mark]) - 1
  return i
})
const styleOf = (style: number | undefined) => {
  const n = STYLES.length
  return ((Math.floor(Math.abs(style ?? 0)) % n) + n) % n
}

// ---- the art: every picture faces right (mirrored for left) and is drawn with `pen.figure`, which puts the
// dark outline round all of it. Letters:
//   h hair · s skin · a hand · e eye · d shut eye
//   n closed mouth · m open mouth · T tear · l rosy cheek · O glasses
//   C coat (the crew's color) · c sleeve, a darker shade · K the lead's cape, darker still · R a sage's robe
//   M the king's ermine cape · V its black spots
//   o collar · b belt · g gold (buckle, crown, star) · p trousers · D the far leg · f boots
//   H hard hat · J its shine · G its brim · r a ruby · N wizard hat · W beard · E a lead's captain's hat · F its plume
//   i hammer head · I its underside · w handle, clipboard · P page · L the crease · k book cover · q quill
//   Z parchment
//   helpers: Q cap · A apron · B shirt, a shade of the cap · X crate · Y its slats
//
// A picture is laid in layers: the face, the hair (and a beard) over it, then the body, its arms and its tools
// (hair falling over the shoulders stays on top of the coat), then the role: cape, robe, white beard, hat.
// The outline goes round the outside only: raised arms and hands lie against the head, never a pixel apart,
// so no dark bars run between them.

/** Which way the head looks: at the viewer (idle poses) or to the side (walking and working). */
type View = 'front' | 'side'

type PoseArt = {
  /** Body, arms and tools; '.' is clear. The head is laid first, under these. */
  rows: readonly string[]
  /** Where (cx, feet) is in `rows`. */
  ax: number
  ay: number
  /** Top-left of the head box (7 by 5 close-up, 5 by 3 overview); hats and hair are laid from it. */
  head: readonly [number, number]
  view: View
  /** Which face, from FACES. */
  face: string
  /** The lead's cape, as [column, first row, last row] runs (only where nothing else is drawn). */
  cape: readonly (readonly [number, number, number])[]
  /** Overview arms up on both sides: the head is 3 wide between them, and so is the hat. */
  narrow?: boolean
}

/** Faces, by scale: close-up 7 by 5 with eyes two pixels tall; overview 5 by 3. */
const FACES: Record<Scale, Record<string, readonly string[]>> = {
  1: {
    front: ['.sssss.', 'sssssss', 'ssesess', 'ssesess', '.ssnss.'],
    open: ['.sssss.', 'sssssss', 'ssesess', 'ssesess', '.ssmss.'],
    // eyes up and aside, the mouth pulled to one side
    think: ['.sssss.', 'sssssss', 'ssseses', 'sssssss', '.sssns.'],
    // eyes cast down, a tear
    sad: ['.sssss.', 'sssssss', 'sssssss', 'ssesess', '.sssTs.'],
    shut: ['.sssss.', 'sssssss', 'sssssss', 'ssdsdss', '.sssss.'],
    side: ['.sssss.', 'sssssss', 'ssseses', 'ssseses', '.sssns.'],
    // on the work in the hands
    down: ['.sssss.', 'sssssss', 'sssssss', 'ssseses', '.sssss.'],
  },
  0.5: {
    front: ['sssss', 'seses', 'sssss'],
    open: ['sssss', 'seses', 'ssmss'],
    think: ['sssss', 'seses', 'sssss'],
    sad: ['sssss', 'seses', 'sssTs'],
    shut: ['sssss', 'sssss', 'sdsds'],
    side: ['sssss', 'seses', 'sssss'],
    down: ['sssss', 'sssss', 'seses'],
    narrow: ['sss', 'ese', 'sms'],
  },
}

/**
 * Hair, laid from one column left of the head box: 'h' over skin and clear pixels, 'j' hair that falls over the
 * shoulders and stays on top of the coat, 's' bare skin (a bald pate), 'C' a hair tie in the coat's color.
 */
const HAIR: Record<Scale, Record<Hairdo, Record<View, readonly string[]>>> = {
  1: {
    short: {
      front: ['..hhhhh..', '.hhhhhhh.', '.h.....h.'],
      side: ['..hhhhh..', '.hhhhh...', '.hh......', '.h.......'],
    },
    long: {
      front: ['..hhhhh..', '.hhhhhhh.', '.h.....h.', '.h.....h.', '.h.....h.', '.j.....j.', '.j.....j.'],
      side: ['..hhhhh..', '.hhhhh...', 'hhh......', 'hhh......', 'hh.......', '.j.......', '.j.......'],
    },
    curly: {
      front: ['..hhhhh..', 'hhhhhhhhh', 'hh.....hh', 'hh.....hh', '.h.....h.'],
      side: ['.hhhhhh..', 'hhhhhhh..', 'hhh......', 'hhh......', '.h.......'],
    },
    tail: {
      front: ['..hhhhh..', '.hhhhhhh.', 'Ch.....h.', 'hh.......', 'h........', 'h........'],
      side: ['..hhhhh..', 'Chhhhh...', 'hhh......', 'hh.......', 'h........', 'h........'],
    },
    bald: {
      front: ['..sssss..', '.sssssss.', '.h.....h.', '.h.....h.'],
      side: ['..sssss..', '.sssss...', '.hh......', '.h.......'],
    },
    bob: {
      front: ['..hhhhh..', '.hhhhhhh.', '.hh...hh.', '.h.....h.', '.h.....h.'],
      side: ['..hhhhh..', '.hhhhhhh.', '.hhh.....', '.hh......', '.hh......'],
    },
  },
  0.5: {
    short: { front: ['.hhhhh.'], side: ['.hhhhh.', '.h.....'] },
    long: { front: ['.hhhhh.', '.......', '.h...h.', '.j...j.'], side: ['.hhhhh.', 'hh.....', 'hh.....', '.j.....'] },
    curly: { front: ['hhhhhhh', 'h.....h'], side: ['hhhhhh.', 'hh.....', 'h......'] },
    tail: { front: ['.hhhhh.', 'C......', 'h......'], side: ['.hhhhh.', 'Ch.....', 'h......', 'h......'] },
    bald: { front: ['.sssss.'], side: ['.sssss.'] },
    bob: { front: ['.hhhhh.', '.h...h.', '.h...h.'], side: ['.hhhhh.', '.hh....', '.hh....'] },
  },
}
/** Overview, a head 3 wide between raised arms: only the top shows. */
const NARROW_HAIR = (hairdo: Hairdo) => [hairdo === 'bald' ? '.sss.' : '.hhh.']

/** A beard in the hair's color, laid like hair: jaw and chin, and a little over the collar close-up. */
const BEARD_MARK: Record<Scale, Record<View, readonly string[]>> = {
  1: {
    front: ['', '', '', '.h.....h.', '.hhhhhhh.', '...jjj...'],
    side: ['', '', '', '.hh......', '.hhhhhh..', '....jj...'],
  },
  0.5: { front: ['', '', '..hhh..'], side: ['', '', '..hhh..'] },
}

/** Close-up only: glasses on the eyes (the skin beside each eye becomes frame); rosy cheeks beside the lowest eye row. */
function marked(face: readonly string[], mark: Mark, s: Scale): string[] {
  const g = face.map(r => r.split(''))
  if (mark === 'glasses' && s === 1) {
    g.forEach(r => {
      const eye = r.map((ch, i) => (ch === 'e' ? i : -1)).filter(i => i >= 0)
      for (const i of eye) for (const j of [i - 1, i + 1]) if (r[j] === 's') r[j] = 'O'
    })
  }
  if (mark === 'blush' && s === 1) {
    let y = -1
    g.forEach((r, j) => { if (r.includes('e')) y = j })
    const r = g[y]
    if (r) {
      const a = r.indexOf('e')
      const b = r.lastIndexOf('e')
      if (r[a - 1] === 's') r[a - 1] = 'l'
      if (r[b + 1] === 's') r[b + 1] = 'l'
    }
  }
  return g.map(r => r.join(''))
}

// Close-up: a frame 15 wide and 16 tall, the body in columns 4..10 (cx = 7) and rows 4..15 (feet = 15);
// rows 0..3 and columns 0..3 and 11..14 are for hats, raised arms and tools. The head is 7 wide and 5 tall
// (hair, brow, eyes two rows, chin and mouth), the coat 4 rows (collar, chest, belt and buckle, hem), the legs 3.
const blank = (n: number) => Array<string>(n).fill('')
const FT = ['....cCoooCc', '....cCCCCCc', '....cbbgbbc', '....aCCCCCa'] as const // front
const FL = ['.....pp.pp', '.....pp.pp', '.....ff.ff'] as const
const ST = ['....cCCooCc', '....cCCCCCc', '....cbbbgbc', '....aCCCCCa'] as const // side: collar and buckle forward
const SL = ['.....DD.pp', '.....DD.pp', '.....ff.fff'] as const // the far leg darker, the near boot's toe forward
const CAPE_F = [[3, 9, 14], [11, 9, 14]] as const
const CAPE_S = [[3, 9, 14], [4, 13, 14]] as const

const big = (view: View, face: string, rows: readonly string[], o: Partial<PoseArt> = {}): PoseArt =>
  ({ rows, ax: 7, ay: 15, head: [4, 4], view, face, cape: view === 'front' ? CAPE_F : CAPE_S, ...o })

const BIG: Record<Exclude<Pose, 'sleep'>, PoseArt> = {
  stand: big('front', 'front', [...blank(9), ...FT, ...FL]),
  // a stride: arms swing out, the legs apart, the far one behind
  walk1: big('side', 'side', [...blank(10), ...ST.slice(0, 3), '...acCCCCCca', '....DD..pp', '...ff....fff'], { head: [4, 5], cape: [[3, 10, 14], [2, 13, 14]] }),
  // passing: arms at the sides, the far foot lifted behind the near one
  walk2: big('side', 'side', [...blank(9), ...ST, '.....DDpp', '....ff.pp', '.......fff']),
  // the hammer up over the front shoulder, the arm against the head
  hammerUp: big('side', 'down', [
    '..........iiii',
    '..........IIII',
    '...........w',
    '...........w',
    '...........a',
    '...........c',
    '...........c',
    '...........c',
    '..........cc',
    '....cCCooCC',
    '....cCCCCCC',
    '....cbbbgbC',
    '....aCCCCCC',
    ...SL,
  ]),
  hammerDown: big('side', 'down', [...blank(9), '....cCCooCcca', '....cCCCCCC.w', '....cbbbgbC.w', '....aCCCCCC.w', '.....DD.pp.iii', '.....DD.pp.III', '.....ff.fff']),
  read: big('side', 'down', [...blank(9), '....cCCooCc', '....cCCCCCkPLPk', '....cbbbgbakkk', '....aCCCCCC', ...SL]),
  readTurn: big('side', 'down', [...blank(9), '....cCCooCc.PP', '....cCCCCCkPLkk', '....cbbbgbakkk', '....aCCCCCC', ...SL]),
  point: big('side', 'side', [...blank(9), '....cCCooCccaa', '....cCCCCCC', '....cbbbgbC', '....aCCCCCC', ...SL]),
  // a sheet held out in one hand, the quill in the other
  write: big('side', 'down', [...blank(8), '.............q', '....cCCooCc.q', '....cCCCCCca', '....cbbbgbZZZZ', '....aCCCCCwwww', ...SL]),
  // a hand at the chin, its elbow propped on the other arm folded across the waist
  think: big('front', 'think', [...blank(8), '....a', '...ccCoooCc', '...ccCCCCCc', '....acccccc', '....CCCCCCC', ...FL]),
  // a hand up, palm out
  talk: big('front', 'open', [...blank(9), '....cCoooCc.a', '....cCCCCCcc', '....cbbgbbC', '....aCCCCCC', ...FL]),
  cheer: big('front', 'open', [
    '',
    '..a.........a',
    '..a.........a',
    '...c.......c',
    '...c.......c',
    '...c.......c',
    '...c.......c',
    '...c.......c',
    '...cc.....cc',
    '....CCoooCC',
    '....CCCCCCC',
    '....CbbgbbC',
    '....CCCCCCC',
    ...FL,
  ]),
  wave1: big('front', 'open', [
    '', '', '',
    '.............a',
    '............c',
    '...........c',
    '...........c',
    '...........c',
    '..........cc',
    '....cCoooCC',
    '....cCCCCCC',
    '....cbbgbbC',
    '....aCCCCCC',
    ...FL,
  ]),
  wave2: big('front', 'open', [
    '', '',
    '...........a',
    '...........a',
    '...........c',
    '...........c',
    '...........c',
    '...........c',
    '..........cc',
    '....cCoooCC',
    '....cCCCCCC',
    '....cbbgbbC',
    '....aCCCCCC',
    ...FL,
  ]),
  // the head sunk between raised shoulders, eyes down, a tear
  sad: big('front', 'sad', [...blank(9), '....c.....c', '....cCoooCc', '....cbbgbbc', '....aCCCCCa', ...FL], { head: [4, 5], cape: [[3, 9, 14], [11, 9, 14]] }),
  sit: big('side', 'side', [...blank(11), '....cCCooCc', '....cCCCCCcca', '....cbbbgbC...f', '....aCCCCCppppf', '.....CCCCCppppf'], { head: [4, 6], cape: [[3, 11, 15]] }),
}

// Overview: a frame 9 wide and 10 tall, the body in columns 2..6 (cx = 4) and rows 2..9 (feet = 9). The head
// is 5 wide (hair under the hat, eyes, cheeks), the coat 3 rows, the legs 2.
const OT = ['..cCoCc', '..cCCCc', '..aCCCa'] as const
const OB = ['..cCoCC', '..cCCCC', '..aCCCC'] as const // the front arm busy
const OL = ['..pp.pp', '..ff.ff'] as const
const OSL = ['..Dp.pp', '..ff.fff'] as const
const OCAPE_F = [[1, 5, 8], [7, 5, 8]] as const
const OCAPE_S = [[1, 5, 8]] as const

const small = (view: View, face: string, rows: readonly string[], o: Partial<PoseArt> = {}): PoseArt =>
  ({ rows, ax: 4, ay: 9, head: [2, 2], view, face, cape: view === 'front' ? OCAPE_F : OCAPE_S, ...o })

const SMALL: Record<Exclude<Pose, 'sleep'>, PoseArt> = {
  stand: small('front', 'front', [...blank(5), ...OT, ...OL]),
  walk1: small('side', 'side', [...blank(5), '..cCoCc', '..cCCCc', '.acCCCca', '..Dp.pp', '.ff...ff']),
  walk2: small('side', 'side', [...blank(5), ...OT, '...Dpp', '...fff']),
  hammerUp: small('side', 'down', ['.......ii', '.......w', '.......a', '.......c', '.......c', ...OB, ...OSL]),
  hammerDown: small('side', 'down', [...blank(5), '..cCoCca', '..cCCCCw', '..aCCCCii', ...OSL]),
  read: small('side', 'down', [...blank(5), '..cCoCc', '..cCCPLP', '..aCakkk', ...OSL]),
  readTurn: small('side', 'down', [...blank(5), '..cCoCcP', '..cCCPL', '..aCakkk', ...OSL]),
  point: small('side', 'side', [...blank(5), '..cCoCcca', ...OB.slice(1), ...OSL]),
  write: small('side', 'down', [...blank(4), '........q', '..cCoCcq', '..cCCCaP', '..aCCCPP', ...OSL]),
  think: small('front', 'think', [...blank(4), '.a', '.ccCoCc', '..cCCCc', '..CCCCa', ...OL]),
  talk: small('front', 'open', [...blank(5), '..cCoCca', '..cCCCc', '..aCCCC', ...OL]),
  // both hands up beside a narrower head: no gap between arm and head, so no dark bars
  cheer: small('front', 'narrow', ['..a...a', '..c...c', '..c...c', '..c...c', '..c...c', '..cCoCc', '..CCCCC', '..CCCCC', ...OL], { head: [3, 2], narrow: true }),
  wave1: small('front', 'open', ['', '.......a', '.......c', '.......c', '.......c', ...OB, ...OL]),
  wave2: small('front', 'open', ['........a', '.......c', '.......c', '.......c', '.......c', ...OB, ...OL]),
  sad: small('front', 'sad', [...blank(5), '..c...c', '..cCoCc', '..aCCCa', ...OL], { head: [2, 3], cape: [[1, 6, 8], [7, 6, 8]] }),
  sit: small('side', 'side', [...blank(7), '..cCoCca', '..cCCCC', '..aCCpppf'], { head: [2, 4], cape: [[1, 7, 9]] }),
}

/** Hats, laid over the head from its top-left: rows, how many of them are above the head, a column shift. */
type Hat = readonly [rows: readonly string[], up: number, dx: number]
const CROWN: Hat = [['g..g..g', 'gg.g.gg', 'ggrgrgg'], 3, 0]
// a lead's captain's hat: dark, with a gold badge and a white plume, so a crew's lead reads at a glance
const CAPTAIN_F: Hat = [['.....FF..', '..EEEEF..', '.EEEgEEE.', 'EEEEEEEEE'], 3, -1]
const CAPTAIN_S: Hat = [['....FF...', '.EEEEF...', 'EEEgEEEE.', 'EEEEEEEE'], 3, 0]
const HATS: Record<Scale, Record<View, Record<Role, Hat>>> = {
  1: {
    front: {
      worker: [['...HHH...', '..HJHHH..', '.HHHHHHH.', 'GGGGGGGGG'], 3, -1],
      king: CROWN,
      lead: CAPTAIN_F,
      sage: [['....N....', '...NNN...', '...NgN...', '..NNNNN..', 'NNNNNNNNN'], 4, -1],
    },
    side: {
      worker: [['..HHH...', '.HHHJH..', 'HHHHHHH.', 'GGGGGGGG'], 3, 0],
      king: CROWN,
      lead: CAPTAIN_S,
      // the tip flops back
      sage: [['.NN......', '..NNN....', '..NgN....', '.NNNNN...', 'NNNNNNNNN'], 4, -1],
    },
  },
  0.5: {
    front: {
      worker: [['.HHH.', 'HJHHH', 'GGGGG'], 2, 0],
      // the gaps between the points filled in, so the outline goes round the crown, not between its points
      king: [['gGgGg', 'ggrgg'], 2, 0],
      lead: [['..FF.', 'EEgEE'], 2, 0],
      // one tall dark triangle with a star, down over the brow: the eyes move down a row to show under it
      sage: [['..N..', '.NNN.', ',NgN,', 'NNNNN'], 2, 0],
    },
    side: {
      worker: [['.HHH.', 'HHHJH', 'GGGGGG'], 2, 0],
      king: [['gGgGg', 'ggrgg'], 2, 0],
      lead: [['.FF..', 'EEgEE'], 2, 0],
      sage: [['..N..', '.NNN.', ',NgN,', 'NNNNN'], 2, 0],
    },
  },
}
const NARROW: Record<Role, Hat> = {
  worker: [['HHJ', 'GGG'], 1, 0],
  king: [['gGg', 'grg'], 1, 0],
  lead: [['.F.', 'EgE'], 1, 0],
  sage: [['.N.', 'NgN', 'NNN'], 1, 0],
}

/** The sage's white beard, from the head's top-left: rows and how far down; it lies only on chin and coat. */
const BEARD: Record<Scale, Record<View, readonly [readonly string[], number]>> = {
  1: { front: [['.WWWWW.', '..WWW..', '...W...'], 4], side: [['.WWWWW.', '...WWW.', '....W..'], 4] },
  0.5: { front: [['.WWW.'], 3], side: [['.WWW.'], 3] },
}

type Sprite = { rows: readonly string[]; ax: number; ay: number; top: number; w: number }

/** A scratch grid with its origin `pad` cells in, so overlays may stick out of the frame. */
class Grid {
  readonly g: string[][]
  readonly pad: number
  constructor(w: number, h: number, pad: number) {
    this.pad = pad
    this.g = Array.from({ length: h + pad * 2 }, () => Array<string>(w + pad * 2).fill('.'))
  }
  at(x: number, y: number) {
    return this.g[y + this.pad]?.[x + this.pad] ?? '.'
  }
  put(x: number, y: number, ch: string) {
    const r = this.g[y + this.pad]
    if (r && x + this.pad >= 0 && x + this.pad < r.length) r[x + this.pad] = ch
  }
  lay(rows: readonly string[], x: number, y: number, only?: string) {
    rows.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) {
        const ch = r[i] ?? '.'
        // ',' clears hair, so a hat narrower than the head shows no hair beside it
        if (ch === ',') {
          if (this.at(x + i, y + j) === 'h') this.put(x + i, y + j, '.')
        } else if (ch !== '.' && (only === undefined || only.includes(this.at(x + i, y + j)))) this.put(x + i, y + j, ch)
      }
    })
  }
  /** The drawn part, and where a frame point (ax, ay) lands in it. */
  sprite(ax: number, ay: number): Sprite {
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1
    this.g.forEach((r, y) => r.forEach((ch, x) => {
      if (ch === '.') return
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }))
    const rows = this.g.slice(y0, y1 + 1).map(r => r.slice(x0, x1 + 1).join(''))
    const sy = ay + this.pad - y0
    return { rows, ax: ax + this.pad - x0, ay: sy, top: sy + 1, w: x1 - x0 + 1 }
  }
}

/** Lays hair rows from (x, y): over skin and clear pixels only; 'j' marks hair the coat must not cover. */
function layHair(g: Grid, rows: readonly string[], x: number, y: number, over: Set<string>) {
  rows.forEach((r, j) => {
    for (let i = 0; i < r.length; i++) {
      const ch = r[i] ?? '.'
      if (ch === '.' || !'.s'.includes(g.at(x + i, y + j))) continue
      if (ch === 'j') over.add(`${x + i},${y + j}`)
      g.put(x + i, y + j, ch === 'j' ? 'h' : ch)
    }
  })
}

function dress(art: PoseArt, s: Scale, role: Role, hairdo: Hairdo, mark: Mark, hat?: Hat, face = art.face) {
  const g = new Grid(Math.max(...art.rows.map(r => r.length)), art.rows.length, 6)
  const [hx, hy] = art.head
  const view = art.view
  let rows = FACES[s][face] ?? FACES[s].front ?? []
  // overview, the sage's hat comes down over the brow: the eyes move down onto the cheeks
  if (s === 0.5 && role === 'sage' && rows[1]?.includes('e')) rows = [rows[0] ?? '', rows[0] ?? '', rows[1] ?? '']
  g.lay(marked(rows, role === 'sage' && mark === 'beard' ? '' : mark, s), hx, hy)
  const over = new Set<string>()
  layHair(g, art.narrow ? NARROW_HAIR(hairdo) : HAIR[s][hairdo][view], hx - 1, hy, over)
  if (mark === 'beard' && role !== 'sage' && !art.narrow) layHair(g, BEARD_MARK[s][view], hx - 1, hy, over)
  // the body over the head, but hair falling on the shoulders stays on top
  art.rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const ch = r[x] ?? '.'
      if (ch === '.' || (over.has(`${x},${y}`) && 'cCo'.includes(ch))) continue
      g.put(x, y, ch)
    }
  })
  // a lead's cape is a darker shade of its crew's color; the king's is ermine, white with black spots
  if (role === 'lead' || role === 'king') {
    for (const [x, y0, y1] of art.cape) for (let y = y0; y <= y1; y++) if (g.at(x, y) === '.') g.put(x, y, role === 'lead' ? 'K' : (x + y * 2) % 3 === 0 ? 'V' : 'M')
  }
  if (role === 'sage') {
    // trousers become a robe, and so does the gap between the legs
    art.rows.forEach((r, y) => {
      const a = Math.min(...['p', 'D'].map(c => r.indexOf(c)).filter(i => i >= 0))
      const b = Math.max(r.lastIndexOf('p'), r.lastIndexOf('D'))
      for (let x = a; Number.isFinite(a) && x <= b; x++) g.put(x, y, 'R')
    })
    const [beard, dy] = BEARD[s][view]
    g.lay(art.narrow ? beard.map(r => r.slice(1)) : beard, hx, hy + dy, 'slOoCcb')
  }
  const [hr, up, dx] = hat ?? (art.narrow ? NARROW : HATS[s][view])[role]
  // a hat covers hair and brow, never a hand or a sleeve
  g.lay(hr, hx + dx, hy - up, '.hseOC')
  return g
}

const SLEEP_HATS: Record<Role, Hat> = {
  worker: [['.HHJHH.', 'HHHHHHH', 'GGGGGGG'], 2, 0],
  king: CROWN,
  lead: [['..FF...', '.EEEEE.', 'EEEgEEE'], 2, 0],
  sage: [['..NgN..', '.NNNNN.', 'NNNNNNN'], 2, 0],
}

/** Close-up, lying on its back seen from above: the standing picture turned so the head points right, eyes shut. */
function lying(role: Role, hairdo: Hairdo, mark: Mark): Sprite {
  const stand = dress(BIG.stand, 1, role, hairdo, mark, SLEEP_HATS[role], 'shut')
  // only the body's columns (and the lead's cape): curls and tails stay within, so every style lies as wide
  const [lo, hi] = role === 'lead' || role === 'king' ? [3, 11] : [4, 10]
  stand.g.forEach(r => r.forEach((_, x) => { if (x - stand.pad < lo || x - stand.pad > hi) r[x] = '.' }))
  const up = stand.sprite(BIG.stand.ax, BIG.stand.ay)
  const h = up.rows.length
  const g = new Grid(h, up.w, 0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < up.w; x++) {
      // mirrored, then turned a quarter clockwise: the head goes right and the face up
      g.put(h - 1 - y, x, up.rows[y]?.[up.w - 1 - x] ?? '.')
    }
  }
  const sp = g.sprite(0, up.w - 1)
  return { ...sp, ax: 0 }
}

/** Overview sleepers are drawn by hand, 9 long: boots, coat, face (eyes shut), the hat turned with the head. */
const SMALL_SLEEP: Record<Role, readonly string[]> = {
  worker: ['fpacssGH.', 'fpCodsGHH', '..CossGHH', 'fpCodsGJH', 'fpacssGH.'],
  king: ['fpacsshgg', 'fpCodshgG', '..Cosshrg', 'fpCodshgG', 'fpacsshgg'],
  lead: ['fpacsshEE', 'fpCodshEE', '..CosshgF', 'fpCodshEE', 'fpacsshEE'],
  sage: ['fRccsN...', 'fRCWdNNN.', '.RCWsNgNN', 'fRCWdNNN.', 'fRccsN...'],
}

function build(s: Scale, role: Role, pose: Pose, hairdo: Hairdo, mark: Mark): Sprite {
  if (pose === 'sleep') {
    if (s === 1) return lying(role, hairdo, mark)
    const rows = SMALL_SLEEP[role]
    return { rows, ax: 0, ay: rows.length - 1, top: rows.length, w: Math.max(...rows.map(r => r.length)) }
  }
  const art = (s === 1 ? BIG : SMALL)[pose]
  return dress(art, s, role, hairdo, mark).sprite(art.ax, art.ay)
}

/** Every picture, by scale, role, pose and layout. */
const SPRITES = {} as Record<Scale, Record<Role, Record<Pose, Sprite[]>>>
for (const s of [1, 0.5] as const) {
  SPRITES[s] = {} as Record<Role, Record<Pose, Sprite[]>>
  for (const role of ROLES) {
    const all = {} as Record<Pose, Sprite[]>
    for (const pose of POSES) all[pose] = LAYOUTS.map(([hairdo, mark]) => build(s, role, pose, hairdo, mark))
    SPRITES[s][role] = all
  }
}

// One palette, its few look-dependent entries set per call; the shades of a color are worked out once.
const PAL: Record<string, number> = {
  h: 0, s: 0, a: 0, n: 0, l: 0, e: C.eye, d: C.trunk, m: 0x7a2a22, T: C.tear, O: 0x8f95a3,
  C: 0, c: 0, K: 0, R: 0, o: C.white, b: C.belt, g: C.gold, p: shade(C.pants, 1.35), D: C.pants, f: C.char,
  H: C.hardHat, J: C.fire[0], G: C.goldDark, r: C.confetti[0], N: C.sageHat, W: C.beard,
  E: 0x262833, F: C.white, M: 0xf4f0e6, V: 0x1e1e24,
  i: C.iron, I: shade(C.iron, 0.72), w: C.woodDark, Z: C.paper, P: C.page, L: C.paperShade, k: C.bookCover, q: C.white,
  Q: 0, B: 0, A: C.apron, X: C.woodLight, Y: C.wood,
}
const SHADES = new Map<number, readonly [number, number]>()
function shades(color: number) {
  let v = SHADES.get(color)
  if (!v) SHADES.set(color, (v = [shade(color, 0.72), shade(color, 0.5)]))
  return v
}
function skin(tone: number) {
  const t = TONES[tone] ?? TONES[0]!
  PAL.s = PAL.a = t[0]
  PAL.n = t[1]
  PAL.l = t[2]
}

/**
 * The outline round people and helpers: a soft dark brown, lighter than their eyes and shoes, so it holds the
 * silhouette on grass and cobbles without weighing on such small figures.
 */
const OUTLINE = 0x3f3226

const ROD = C.trunk
const LINE = C.iron
const FLOAT = C.confetti[0]

/**
 * Draws a crew member standing on (cx, feet): its boots' bottom pixels on row `feet`, its body centred on
 * column `cx`, with a dark outline all round (`pen.figure`) and marked PERSON. Close-up (s=1) a body is 7 px
 * wide and 12 tall inside the outline, tools and raised arms may reach 4 px further out, hats 4 px higher;
 * overview (s=0.5) 5 by 8, tools 2 further, hats 2 higher. `sleep` lies along the ground to the right of cx
 * (at most 16 px long close-up, 9 overview); `sit` sits on the ground at `feet`.
 */
export function person(pen: Pen, s: Scale, cx: number, feet: number, look: Look) {
  const sp = sprite(s, look)
  const [c, k] = shades(look.color)
  PAL.C = PAL.R = look.color
  PAL.c = c
  PAL.K = k
  PAL.h = look.hair
  skin(STYLES[styleOf(look.style)]?.[1] ?? 0)
  const flip = !look.right
  // asleep, the picture starts at cx and lies to the right whichever way it faces
  const x = look.pose === 'sleep' ? cx : flip ? cx - (sp.w - 1 - sp.ax) : cx - sp.ax
  pen.as(PERSON, () => {
    pen.figure(sp.rows, x, feet - sp.ay, PAL, flip, OUTLINE)
    if (look.pose === 'sit') fishing(pen, s, cx, feet, flip ? -1 : 1, look.anim)
  })
}

/** The rod up and out from the fisher's hand, the line down to the water, a red float bobbing on it. */
function fishing(pen: Pen, s: Scale, cx: number, feet: number, d: number, anim: number) {
  const big = s === 1
  const hx = cx + d * (big ? 5 : 3)
  let y = feet - (big ? 3 : 2)
  const steps = big ? [1, 1, 0, 1, 1, 0, 1] : [1, 0, 1, 1]
  let x = hx
  for (const up of steps) {
    x += d
    y -= up
    pen.dot(x, y, ROD)
  }
  const bob = anim % 4 === 3 ? 1 : 0
  const end = feet + (big ? 3 : 2)
  for (let j = y + 1; j < end + bob; j++) pen.dot(x, j, LINE)
  pen.dot(x, end + bob, FLOAT)
}

/** How many pixels above `feet` the top of the figure is, its outline included: the bubble goes above that. */
export function personHeight(s: Scale, look: Pick<Look, 'role' | 'pose'>) {
  return sprite(s, look).top
}

/** The picture for a look; an unknown role or pose (from old state) falls back to a standing worker. */
function sprite(s: Scale, look: Pick<Look, 'role' | 'pose'> & { style?: number }): Sprite {
  const all = SPRITES[s] ?? SPRITES[1]
  const set = (all[look.role] ?? all.worker)[look.pose] ?? all.worker.stand
  return set[LAYOUT_OF[styleOf(look.style)] ?? 0] ?? set[0]!
}

// ---- helpers: a cap in the owner's color, a shirt in its shade, an apron.
// Close-up 5 wide and 9 tall (cx = column 2), overview 3 by 6 (cx = column 1); feet on the last row.
type HelperArt = {
  body: readonly string[]
  /** A ponytail behind the head, laid from one column left of it, on the face's row. */
  tail: readonly string[]
  /** The legs mid-stride (the last two rows). */
  step: readonly string[]
  /** The crate over the head, from the rows above it, and the hands that come off the hips. */
  crate: readonly string[]
  hips: readonly (readonly [number, number])[]
  /** The scroll under the arm, laid from row `at`. */
  scroll: readonly string[]
  at: number
  /** A small hammer up, then down, laid from row 0. */
  tool: readonly (readonly string[])[]
}
const HELPER: Record<Scale, HelperArt> = {
  // a face with both eyes inside it, hair at the nape under the cap, shoulders in the shirt's shade between chin
  // and apron so the two never run together, and a crate with upright slats
  1: {
    body: ['.QQQ.', 'QQQQQB', 'seses', 'hsss.', 'BBBBB', 'BAAAB', 'aAAAa', '.p.p.', '.f.f.'],
    tail: ['h', 'h'],
    step: ['.p.p.', 'f...f'],
    crate: ['XYXYX', 'XYXYX', 'a...a'],
    hips: [[0, 6], [4, 6]],
    scroll: ['....PPL', '...PPL'],
    at: 4,
    tool: [['', '', '', '.....ii', '.....w', '.....a', '....A'], ['', '', '', '', '', '.....aw', '....A.ii']],
  },
  // overview: cap, face, shirt, legs; the apron is too small to show
  0.5: {
    body: ['.QQ.', 'QQQB', 'ses', 'BBB', 'p.p', 'f.f'],
    tail: ['h'],
    step: ['.p.', 'f.f'],
    crate: ['XYX', 'XYX'],
    hips: [],
    scroll: ['BPPL'],
    at: 3,
    tool: [['', '', '...i', '...a'], ['', '', '', '', '...ai']],
  },
}

function makeHelper(s: Scale, tail: boolean, carrying: HelperLook['carrying'], step: boolean, tool: number): Sprite {
  const art = HELPER[s]
  const n = art.body.length
  const g = new Grid(8, n, 6)
  g.lay(art.body, 0, 0)
  if (tail) g.lay(art.tail, -1, 2)
  if (step) {
    for (let x = 0; x < 6; x++) for (const y of [n - 2, n - 1]) g.put(x, y, '.')
    g.lay(art.step, 0, n - 2)
  }
  if (carrying === 'crate') {
    g.lay(art.crate, 0, -art.crate.length)
    for (const [x, y] of art.hips) g.put(x, y, '.')
  } else if (carrying === 'scroll') g.lay(art.scroll, 0, art.at)
  else if (tool) g.lay(art.tool[tool - 1] ?? [], 0, 0)
  return g.sprite(s === 1 ? 2 : 1, n - 1)
}

/** Every helper picture, by scale, then [ponytail][carrying][step][tool]. */
const CARRY = ['', 'crate', 'scroll'] as const
const HELPERS = {} as Record<Scale, Sprite[][][][]>
for (const s of [1, 0.5] as const) {
  HELPERS[s] = [false, true].map(tail => CARRY.map(c => [false, true].map(step => [0, 1, 2].map(tool => makeHelper(s, tail, c, step, tool)))))
}
const helperSprite = (s: Scale, tail: boolean, carrying: HelperLook['carrying'], step: boolean, tool: number) =>
  HELPERS[s][tail ? 1 : 0]?.[CARRY.indexOf(carrying)]?.[step ? 1 : 0]?.[tool] ?? makeHelper(s, tail, carrying, step, tool)

/** Helpers vary with their hair color: a skin tone, and a ponytail or not. */
const HELPER_LOOKS: readonly (readonly [tone: number, tail: boolean])[] = [[1, false], [3, true], [0, false], [0, true], [2, false]]
function helperLook(hair: number) {
  let i = (C.hairs as readonly number[]).indexOf(hair)
  if (i < 0) i = (hair >>> 0) % HELPER_LOOKS.length
  return HELPER_LOOKS[i] ?? [0, false]
}

/**
 * Draws a helper (a subagent) on (cx, feet), smaller than a person: close-up 5 px wide and 9 tall inside its
 * outline (a crate carried over the head adds 3), overview 3 by 6 (a crate adds 2). A cap in its owner's color.
 */
export function helper(pen: Pen, s: Scale, cx: number, feet: number, look: HelperLook) {
  const tool = look.working && !look.walking && look.carrying !== 'crate' ? 1 + (look.anim % 2) : 0
  const step = look.walking && look.anim % 2 === 1
  const [tone, tail] = helperLook(look.hair)
  const sp = helperSprite(s, tail, look.carrying, step, tool)
  const [b] = shades(look.color)
  PAL.Q = look.color
  PAL.B = b
  PAL.h = look.hair
  skin(tone)
  const flip = !look.right
  pen.as(PERSON, () => pen.figure(sp.rows, flip ? cx - (sp.w - 1 - sp.ax) : cx - sp.ax, feet - sp.ay, PAL, flip, OUTLINE))
}

/** How many pixels above `feet` a helper's top is, its outline included (a crate over the head adds to it). */
export function helperHeight(s: Scale, carrying: boolean | HelperLook['carrying'] = false) {
  return helperSprite(s, false, carrying === true || carrying === 'crate' ? 'crate' : '', false, 0).top
}
