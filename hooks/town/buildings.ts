// A feature as a building on its plot: it goes up in stages you can tell apart (foundation, frame, walls, roof),
// gets more as it is improved (levels), and when the crew drops the feature it burns and falls to ruins.
//
// A street is not one house repeated: a feature's name picks one of a few kinds of building (`STYLES`), a
// half-timbered cottage under a hip roof, a tall townhouse with a steep gable, a planked workshop under a barn
// roof with a wide door and a sign, a shop with a striped awning, a round tower house under a witch's hat. The
// roof is always in its builder's color.
//
// Each scale has art of its own, drawn as letters a pixel (see `Art`), but the overview is the close-up
// simplified, never another building: the same roof seen the same way, the same walls, door and windows in a
// few clear shapes, with nothing sticking out of the roof and no fine patterns, so it never turns to noise.
// Slopes step evenly, a pixel a row or a pixel every two rows (a terminal cell), since the terminal draws the
// rows of a cell 8 and 6 screen pixels tall and a ragged step shows.
//
// Every kind is built and improved the same way, from its own pictures: the footing, the frame (its rafters
// follow the roof's outline), the walls row by row, the roof from the eaves up; then a dormer or a roof window
// (level 2, a fence close-up), a stone ground floor and a tower (level 3, the flag moves up to it), gold trim
// (level 4), banners (level 5).
import { KINDS as FOOTPRINTS, type BuildLook, type Kind } from './kinds'
import { C, GROUND, OBJECT, OVERLAY, blend, shade, type Pen, type Scale } from './kit'

export type Stage = 'foundation' | 'frame' | 'walls' | 'roof' | 'done'

export type HouseLook = {
  /** The builder's session color: the roof and the flag. */
  color: number
  /** 0 while first going up; 1 a cottage; 2 adds a dormer and a fence; 3 a stone ground floor and a tower; 4+ gold trim. */
  level: number
  stage: Stage
  /** 0..1 across the whole first build; within a stage it says how far that stage is (walls rising row by row). */
  progress: number
  /** Work going on: a first build, or a standing building being improved. Scaffolding, a pile of materials. */
  building: boolean
  /** Milliseconds since it caught fire, or -1. Burning 0 to 9000, then ruins whose smoke thins out by 26000. */
  fire: number
  /** Frame counter, four a second. */
  anim: number
  /** Evening: lit windows glow (`pen.glow`). */
  lit: boolean
  /**
   * Which kind of building, as a number from the feature's name (any non-negative integer; the art takes it
   * modulo its own count): a cottage, a townhouse, a workshop, a shop... so a street is not one house repeated.
   * Absent: style 0.
   */
  style?: number
}

/** A plot's size at each scale. */
export const PLOT = { 1: { w: 40, h: 36 }, 0.5: { w: 20, h: 18 } } as const

/** Where each stage of a first build begins and ends on `progress`. */
export const STAGES = { foundation: [0, 0.18], frame: [0.18, 0.42], walls: [0.42, 0.72], roof: [0.72, 1] } as const

/** A fire's timeline (ms since it caught): the roof caves in, the walls fall, embers die, the smoke clears. */
export const BURN = { roofFalls: 7000, wallsFall: 8400, ruins: 9000, embers: 16000, smoke: 26000 } as const

/** The kinds of building, in the order `HouseLook.style` (modulo their count) picks them. */
export const STYLES = ['cottage', 'townhouse', 'workshop', 'shop', 'tower'] as const

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// ---- colors: the palette, and a few shades of the builder's color

type Pal = Readonly<Record<string, number>>

/** Letters of the walls. */
const WALL: Pal = {
  T: C.timber, P: C.plaster, p: C.plasterShade, q: 0xb9ab92, W: C.white, G: C.glass, g: C.iron, l: C.leaf, F: C.flowerP,
  Y: C.flowerY, B: C.wood, D: C.door, d: C.woodDark, k: C.gold, S: C.stone, s: C.stoneLight, K: C.stoneDark, M: C.mortar,
  w: C.woodLight,
}

/**
 * A roof's shades. Light comes from the upper left: the slopes turned toward it are `light`, those facing you the
 * plain `base`, those turned away `shadow`. Every two shades sit well apart, since the terminal shows colors in
 * 12 bits and merges two closer than about 17 a channel.
 */
type Roof = {
  base: number; light: number; line: number; shadow: number; eave: number; flag: number; flagDark: number
  /**
   * Pictures with roof letters (and the walls'): R base, L light, n a course of tiles, h shadow, x a course in the
   * shadow, e eave and r ridge (gold when gilded), b the builder's color (banners, an awning), k gold.
   */
  pal: Pal
}
const roofs = new Map<number, Roof>()

/**
 * The roof's shades for a builder's color. A color close to the grass is darkened a little so it stands apart,
 * and a golden one under gold trim (`gilded`) is darkened so the trim still shows.
 */
function roofOf(c: number, gilded = false): Roof {
  const key = c * 2 + (gilded ? 1 : 0)
  let r = roofs.get(key)
  if (!r) {
    const red = (c >> 16) & 255
    const g = (c >> 8) & 255
    const b = c & 255
    const greenish = g > red + 30 && g > b + 30
    const golden = red > 150 && g > 110 && b < 110 && red - g < 75
    const base = greenish ? shade(c, 0.86) : gilded && golden ? shade(c, 0.84) : c
    const light = blend(base, 0xffffff, 0.26)
    const line = shade(base, 0.86)
    const shadow = shade(base, 0.72)
    const eave = shade(base, 0.45)
    r = {
      base, light, line, shadow, eave, flag: c, flagDark: shade(c, 0.72),
      pal: {
        ...WALL, R: base, L: light, n: line, h: shadow, x: shade(base, 0.6), e: gilded ? C.gold : eave, r: gilded ? C.gold : light,
        b: c, k: C.gold,
      },
    }
    roofs.set(key, r)
  }
  return r
}

/** Charring: a color darkened toward soot by `step` (0..5). */
const chars = new Map<number, number>()
function charOf(c: number, step: number) {
  const key = c * 8 + step
  let v = chars.get(key)
  if (v === undefined) chars.set(key, (v = blend(c, C.char, step * 0.16)))
  return v
}

// ---- pictures

type Rows = readonly string[]
/** A picture on the plot: rows of letters ('.' or a letter not in the palette stays clear), top-left at (x, y). */
type Pic = { readonly rows: Rows; readonly x: number; readonly y: number }
const pic = (x: number, y: number, rows: Rows): Pic => ({ rows, x, y })
const NONE = pic(0, 0, [])

/** Paints rows of letters with `pal`, only rows from..to-1. */
function paint(pen: Pen, rows: Rows, x: number, y: number, pal: Pal, from = 0, to = rows.length) {
  for (let j = Math.max(0, from); j < to; j++) {
    const r = rows[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      const c = pal[r[i] ?? '.']
      if (c !== undefined) pen.dot(x + i, y + j, c)
    }
  }
}
const draw = (pen: Pen, p: Pic, X: number, Y: number, pal: Pal, from = 0, to = p.rows.length) => paint(pen, p.rows, X + p.x, Y + p.y, pal, from, to)

/** Lights the glass ('G', 'g') of a picture: lamplight, or (fire >= 0) flames flickering in it. */
function lightGlass(pen: Pen, p: Pic, X: number, Y: number, fire: number, anim: number, from = 0, to = p.rows.length) {
  for (let j = Math.max(0, from); j < to; j++) {
    const r = p.rows[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      const ch = r[i]
      if (ch !== 'G' && ch !== 'g') continue
      const x = X + p.x + i
      const y = Y + p.y + j
      if (fire < 0) pen.glow(x, y, C.lit)
      else pen.glow(x, y, (i + j + anim) % 3 === 0 ? C.fire[0] : (i * 3 + j + anim) % 4 === 0 ? C.fire[2] : C.fire[1])
    }
  }
}

/**
 * One kind of building at one scale, every position in plot coordinates of that scale. The pictures are painted
 * in this order: foundation, walls (the stone floor over them from level 3), the front, the roof, the attic, the
 * tower.
 */
type Art = {
  found: Pic
  wall: Pic
  /** Level 3's stone ground floor, over the walls' lower rows ('.' leaves the wall). */
  stone: Pic
  /** With the walls once they stand, in roof letters: an awning, a sign. */
  front: Pic
  roof: Pic
  /** Level 2: a dormer or a window in the roof, in roof letters. */
  attic: Pic
  /** Level 3: a tower, in roof letters. */
  tower: Pic
  /** Level 5: where each banner hangs (its top-left). */
  banners: readonly (readonly [number, number])[]
  /** Close-up: a chimney 3 wide at column x from row `top` down to `bottom`, or null. */
  chimney: readonly [number, number, number] | null
  /** Close-up: the flag's pole (column, the row it stands on) on the roof, and on the tower from level 3. */
  flag: readonly [number, number] | null
  towerFlag: readonly [number, number] | null
  /** The frame: posts (columns) and plates (rows). */
  posts: readonly number[]
  plates: readonly number[]
  /** Close-up: pickets from level 2, [from, to] columns. */
  fence: readonly (readonly [number, number])[]
  /** Scaffolding: the ladder's (or the left pole's) column and the right pole's. */
  ladder: number
  pole: number
  /** Where flames rise (columns), and flames out of windows (x, y). */
  fire: readonly number[]
  panes: readonly (readonly [number, number])[]
}

/** What an art's pictures work out to, once: each roof row's ends, and the top of the building per column. */
type Shape = Art & { edges: readonly (readonly [number, number])[]; top: readonly number[] }

function shapeOf(a: Art): Shape {
  const edges: [number, number][] = a.roof.rows.map(r => {
    const m = /[^.]/.exec(r)
    const l = m ? m.index : 0
    let e = r.length - 1
    while (e > 0 && r[e] === '.') e--
    return [a.roof.x + l, a.roof.x + e]
  })
  const top: number[] = []
  for (let c = 0; c < 40; c++) {
    let t = 99
    for (const p of [a.roof, a.wall]) {
      p.rows.forEach((r, j) => {
        const ch = r[c - p.x]
        if (ch !== undefined && ch !== '.' && p.y + j < t) t = p.y + j
      })
    }
    top.push(t)
  }
  return { ...a, edges, top }
}

// ---- the kinds of building, close-up (s = 1): within plot columns 6..31, rows 0..27, the door on columns 18..21

/** The tower from level 3, columns 6..11 from row 3: a pyramid roof, a stone body with slit windows. */
const CU_TOWER = pic(6, 3, [
  '..RR..',
  '.LRRh.',
  'LLRRhh',
  'eeeeee',
  'sSSSSK',
  'sSMSSK',
  'sSGGSK',
  'sSGGSK',
  'sSSSMK',
  'sMSSSK',
  'sSSSSK',
  'sSSMSK',
  'sSSSSK',
  'sSGGSK',
  'sSGGSK',
  'sMSSSK',
  'sSSSSK',
  'sSSSMK',
  'sSSSSK',
  'sSMSSK',
  'sSSSSK',
  'sSSSSK',
  'sMSSSK',
  'sSSSSK',
  'KKKKKK',
])
/** The foundation most kinds stand on, columns 9..30, rows 25..27, the doorstep under the door. */
const CU_FOUND = pic(9, 25, [
  'ssssssssssssssssssssss',
  'SSMSSSSMSssssSMSSSSMSS',
  'SSSSMSSSSssssSSSSMSSSS',
])
/** A dormer, columns 16..23: a little gable over a window. */
const CU_DORMER = [
  '...LR...',
  '..LRRh..',
  '.LRRRRh.',
  '.PgGGGP.',
  '.PGGGGP.',
  '.pppppp.',
] as const

const COTTAGE: Art = {
  found: CU_FOUND,
  wall: pic(10, 14, [
    'TTTTTTTTTTTTTTTTTTTT',
    'TppppppppppppppppppT',
    'TPgGGGPTTTTTTPgGGGPT',
    'TPGGGGPTDDDDTPGGGGPT',
    'TPGGGGPTDDDDTPGGGGPT',
    'TlFYFYlTDDDDTlFYFYlT',
    'TBBBBBBTDDDDTBBBBBBT',
    'TPPPPPPTDDkDTPPPPPPT',
    'TPPPPPPTDDDDTPPPPPPT',
    'TPPPPPPTDDDDTPPPPPPT',
    'TTTTTTTTDDDDTTTTTTTT',
  ]),
  stone: pic(10, 21, [
    'sssssssKDDkDKsssssss',
    'SSMSSSSKDDDDKSSSSMSS',
    'SSSSSMSKDDDDKSMSSSSS',
    'MMMMMMMKDDDDKMMMMMMM',
  ]),
  front: NONE,
  roof: pic(8, 5, [
    '........rrrrrrrr........',
    '.......LRRRRRRRRh.......',
    '......LLnnnnnnnnhh......',
    '.....LLRRRRRRRRRRhh.....',
    '....LLLnnnnnnnnnnhhh....',
    '...LLLRRRRRRRRRRRRhhh...',
    '..LLLLnnnnnnnnnnnnhhhh..',
    '.LLLLRRRRRRRRRRRRRRhhhh.',
    'eeeeeeeeeeeeeeeeeeeeeeee',
  ]),
  attic: pic(16, 6, CU_DORMER),
  tower: CU_TOWER,
  banners: [[16, 15], [22, 15]],
  chimney: [25, 3, 10],
  flag: [16, 5],
  towerFlag: [8, 3],
  posts: [10, 29, 17, 22],
  plates: [14, 21],
  fence: [[6, 12], [27, 31]],
  ladder: 7,
  pole: 31,
  fire: [10, 14, 19, 25, 29],
  panes: [[13, 17], [26, 17]],
}

/**
 * A stone ground floor from rows of wall: plaster and timber turn to stone (mortar joints here and there, the
 * last row a mortar course), a round wall keeps its light and shade; glass, doors and the rest stay ('.').
 */
function stoned(rows: Rows): Rows {
  return rows.map((r, j) =>
    [...r]
      .map((ch, i) => {
        if (ch === 'W') return 's'
        if (ch === 'q') return 'K'
        if (ch !== 'P' && ch !== 'p' && ch !== 'T') return '.'
        if (j === rows.length - 1) return 'M'
        return (i + j * 3) % 7 === 0 ? 'M' : 'S'
      })
      .join(''),
  )
}

/** Two storeys of plaster between stone quoins, tall windows in white frames, the door under a fanlight. */
const TH_WALL = [
  'sppppppppppppppppppK',
  'sPWWWWPPWWWWPPWWWWPK',
  'ssWgGWPPWgGWPPWgGWSK',
  'ssWGGWPPWGGWPPWGGWSK',
  'sPWGGWPPWGGWPPWGGWPK',
  'sPssssPPssssPPssssPK',
  'SSSSSSSSSSSSSSSSSSSK',
  'ssWWWWPWGGGGWPWWWWSK',
  'sPWgGWPWDDDDWPWgGWPK',
  'sPWGGWPWDDDDWPWGGWPK',
  'ssWGGWPWDDkDWPWGGWSK',
  'ssssssPWDDDDWPssssSK',
  'sPPPPPPWDDDDWPPPPPPK',
] as const

const TOWNHOUSE: Art = {
  found: CU_FOUND,
  wall: pic(10, 12, TH_WALL),
  stone: pic(10, 19, stoned(TH_WALL.slice(7))),
  front: NONE,
  roof: pic(8, 0, [
    '...........rr...........',
    '..........Lnxx..........',
    '.........LRRhhh.........',
    '........Lnnnxxxx........',
    '.......LRRRRhhhhh.......',
    '......Lnnnnnxxxxxx......',
    '.....LRRRRRRhhhhhhh.....',
    '....Lnnnnnnnxxxxxxxx....',
    '...LRRRRRRRRhhhhhhhhh...',
    '..Lnnnnnnnnnxxxxxxxxxx..',
    '.LRRRRRRRRRRhhhhhhhhhhh.',
    'eeeeeeeeeeeeeeeeeeeeeeee',
  ]),
  attic: pic(18, 4, ['.gG.', 'GGGG', 'GGGG', 'ssss']),
  tower: CU_TOWER,
  banners: [[16, 13], [22, 13]],
  chimney: [24, 2, 7],
  flag: null,
  towerFlag: [8, 3],
  posts: [10, 29, 17, 22],
  plates: [12, 18],
  fence: [[6, 12], [27, 31]],
  ladder: 7,
  pole: 31,
  fire: [10, 14, 19, 25, 29],
  panes: [[14, 14], [26, 14]],
}

/** Logs, a window, a wide double door braced in a chevron. */
const WS_WALL = [
  'dddddddddddddddddddddd',
  'wwwwwwwTTTTTTTTwwwwwww',
  'BBBBBBBTDDDDDDTBBBBBBB',
  'wwwgGGwTBBBBBBTwwwwwww',
  'BBBGGGBTDDBBDDTBBBBBBB',
  'wwwGGGwTDBDDBDTwwwwwww',
  'BBBdddBTBDDDDBTBBBBBBB',
  'wwwwwwwTDDDDDDTwwwwwww',
  'BBBBBBBTBBBBBBTBBBBBBB',
  'BBBBBBBTDDDDDDTBBBBBBB',
] as const

const WORKSHOP: Art = {
  found: pic(8, 25, [
    'ssssssssssssssssssssssss',
    'SSMSSSSSSssssssSSSSSMSSS',
    'SSSSMSSSSssssssSSSMSSSSS',
  ]),
  wall: pic(9, 15, WS_WALL),
  stone: pic(9, 22, [
    'sssssss........sssssss',
    'SSMSSSS........SSSMSSS',
    'MMMMMMM........MMMMMMM',
  ]),
  front: pic(25, 17, ['TTTTT', 'TPbPT', 'TbbbT', 'TTTTT']),
  roof: pic(8, 9, [
    '..........rrrr..........',
    '........LLRRhhhh........',
    '......LLnnnnxxxxxx......',
    '....LLRRRRRRhhhhhhhh....',
    '..LLnnnnnnnnxxxxxxxxxx..',
    'eeeeeeeeeeeeeeeeeeeeeeee',
  ]),
  attic: pic(18, 11, ['wGGw', 'wGGw']),
  tower: CU_TOWER,
  banners: [[15, 16], [23, 16]],
  chimney: [27, 5, 13],
  flag: [19, 9],
  towerFlag: [8, 3],
  posts: [9, 30, 16, 23],
  plates: [15, 21],
  fence: [[6, 12], [27, 31]],
  ladder: 6,
  pole: 31,
  fire: [10, 14, 19, 25, 29],
  panes: [[13, 18]],
}

/** A shop front in light wood: two display windows with wares on the sill, a glazed door. */
const SH_WALL = [
  'PPPPPPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPPPPPP',
  'wwgGGGGwDDDDwgGGGGww',
  'wwGGGGGwDGGDwGGGGGww',
  'wwGGGGGwDGGDwGGGGGww',
  'wwGkkFFwDDkDwFFkkGww',
  'wwwwwwwwDDDDwwwwwwww',
  'wwTTTTTwDDDDwTTTTTww',
  'wwwwwwwwDDDDwwwwwwww',
] as const

const SHOP: Art = {
  found: CU_FOUND,
  wall: pic(10, 15, SH_WALL),
  stone: pic(10, 23, ['wwSMSSSw....wSSSMSww', 'MMMMMMMM....MMMMMMMM']),
  front: pic(9, 15, [
    'bbWWbbWWbbWWbbWWbbWWbb',
    'bbWWbbWWbbWWbbWWbbWWbb',
    'bbppbbppbbppbbppbbppbb',
  ]),
  roof: pic(8, 8, [
    '....rrrrrrrrrrrrrrrr....',
    '..LLnnnnnnnnnnnnnnnnxx..',
    '.LRRRRRRRRRRRRRRRRRRRhh.',
    '.Lnnnnnnnnnnnnnnnnnnnxx.',
    '.LRRRRRRRRRRRRRRRRRRRhh.',
    '.Lnnnnnnnnnnnnnnnnnnnxx.',
    'eeeeeeeeeeeeeeeeeeeeeeee',
  ]),
  attic: pic(16, 5, CU_DORMER),
  tower: CU_TOWER,
  banners: [[10, 18], [28, 18]],
  chimney: [26, 4, 9],
  flag: [12, 8],
  towerFlag: [8, 3],
  posts: [10, 29, 17, 22],
  plates: [15, 18],
  fence: [[6, 12], [27, 31]],
  ladder: 7,
  pole: 31,
  fire: [10, 14, 19, 25, 29],
  panes: [[14, 18], [25, 18]],
}

/** A whitewashed round wall (lit on the left), a shuttered window over a little balcony, an arched door. */
const TW_WALL = [
  'pppppppppppqqq',
  'pPWWPPGGPPppqq',
  'pPWWBGGGGBppqq',
  'pPGWBGGGGBpGqq',
  'pPGWBGGGGBpGqq',
  'pPWWwwwwwwppqq',
  'sssddddddddKKK',
  'pPWWPSDDSPppqq',
  'pPGWSDDDDSpGqq',
  'pPGWSDDDDSpGqq',
  'pPWWSDDkDSppqq',
  'pPWWSDDDDSppqq',
  'pPWWSDDDDSppqq',
] as const

/** The round tower house's own turret from level 3, columns 6..11 from row 6: a little witch's hat. */
const CU_TURRET = pic(6, 6, [
  '..Lh..',
  '..Lh..',
  '.LRhh.',
  '.LRhh.',
  'LLRhhh',
  'eeeeee',
  'pppppq',
  'pWPPpq',
  'pWGGpq',
  'pWGGpq',
  'pWPPpq',
  'pWPPpq',
  'pWPPpq',
  'pWGGpq',
  'pWGGpq',
  'pWPPpq',
  'sSSSKK',
  'sSMSKK',
  'sSSSKK',
  'sMSSKK',
  'sSSSKK',
  'KKKKKK',
])

const TOWER: Art = {
  found: pic(12, 25, [
    'ssssssssssssssss',
    'SSMSSSssssSSSMSS',
    '.SSSMSssssSSMSS.',
  ]),
  wall: pic(13, 12, TW_WALL),
  stone: pic(13, 19, stoned(TW_WALL.slice(7))),
  front: NONE,
  roof: pic(10, 0, [
    '.........rr.........',
    '.........Lh.........',
    '........LRhh........',
    '........LRhh........',
    '.......LLRRhh.......',
    '.......LLRRhh.......',
    '......LLRRRhhh......',
    '.....LLLRRRhhhh.....',
    '....LLLLRRRhhhhh....',
    '...LLLLRRRRRhhhhh...',
    'eeLLLLRRRRRRhhhhhhee',
    '..eeeeeeeeeeeeeeee..',
  ]),
  attic: pic(17, 4, ['..Lh..', '.LRRh.', 'LPGGPh', '.PGGP.']),
  tower: CU_TURRET,
  banners: [[16, 19], [22, 19]],
  chimney: [23, 3, 8],
  flag: null,
  towerFlag: [8, 6],
  posts: [13, 26, 17, 22],
  plates: [12, 18],
  fence: [[10, 14], [25, 29]],
  ladder: 10,
  pole: 29,
  fire: [12, 15, 19, 24, 27],
  panes: [[19, 13]],
}

// ---- the same at overview (s = 0.5): within plot columns 3..15, rows 0..13, the door on columns 9..10

const OV_TOWER = pic(3, 1, ['.R.', 'LRh', 'eee', 'sSK', 'sGK', 'sGK', 'sSK', 'sSK', 'sGK', 'sSK', 'sSK', 'sSK', 'KKK'])
const OV_FOUND = pic(4, 12, ['ssssssssssss', 'SSSSSSSSSSSS'])

const OV_COTTAGE: Art = {
  found: OV_FOUND,
  wall: pic(5, 8, ['TppppppppT', 'TGGPDDPGGT', 'TGGPDDPGGT', 'TFFPDDPFFT']),
  stone: pic(5, 10, ['SGGSDDSGGS', 'SFFSDDSFFS']),
  front: NONE,
  roof: pic(4, 3, ['....rrrr....', '...LRRRRh...', '..LLRRRRhh..', '.LLRRRRRRhh.', 'eeeeeeeeeeee']),
  attic: pic(9, 4, ['GG', 'GG']),
  tower: OV_TOWER,
  banners: [[8, 8], [11, 8]],
  chimney: null,
  flag: null,
  towerFlag: null,
  posts: [5, 14, 8, 11],
  plates: [8],
  fence: [],
  ladder: 3,
  pole: 15,
  fire: [6, 9, 13],
  panes: [],
}

const OV_TOWNHOUSE: Art = {
  found: pic(4, 13, ['ssssssssssss']),
  wall: pic(5, 6, ['sppppppppK', 'sPGPGGPGPK', 'sPGPGGPGPK', 'SSSSSSSSSK', 'sPGPDDPGPK', 'sPGPDDPGPK', 'sPPPDDPPPK']),
  stone: pic(5, 10, ['sSGSDDSGSK', 'sSGSDDSGSK', 'MMMMDDMMMM']),
  front: NONE,
  roof: pic(4, 0, ['.....rr.....', '....LRhh....', '...LRRhhh...', '..LRRRhhhh..', '.LRRRRhhhhh.', 'eeeeeeeeeeee']),
  attic: pic(9, 2, ['GG']),
  tower: OV_TOWER,
  banners: [[8, 6], [11, 6]],
  chimney: null,
  flag: null,
  towerFlag: null,
  posts: [5, 14, 8, 11],
  plates: [6, 9],
  fence: [],
  ladder: 3,
  pole: 15,
  fire: [6, 9, 13],
  panes: [],
}

const OV_WORKSHOP: Art = {
  found: pic(4, 12, ['ssssssssssss', 'SSSSssssSSSS']),
  wall: pic(5, 8, ['dddddddddd', 'wGwDDDDwww', 'wGwDDDDwww', 'BBBDDDDBBB']),
  stone: pic(5, 11, ['SSS....SSS']),
  front: pic(12, 9, ['TT', 'bb']),
  roof: pic(4, 4, ['.....rr.....', '...LRRhhh...', '.LLRRRhhhhh.', 'eeeeeeeeeeee']),
  attic: pic(9, 5, ['GG']),
  tower: OV_TOWER,
  banners: [[7, 8], [12, 8]],
  chimney: null,
  flag: null,
  towerFlag: null,
  posts: [5, 14, 7, 12],
  plates: [8],
  fence: [],
  ladder: 3,
  pole: 15,
  fire: [6, 9, 13],
  panes: [],
}

const OV_SHOP: Art = {
  found: OV_FOUND,
  wall: pic(5, 8, ['PPPPPPPPPP', 'PPPPPPPPPP', 'wGGwDDwGGw', 'wwwwDDwwww']),
  stone: pic(5, 11, ['SSSSDDSSSS']),
  front: pic(5, 8, ['bbWWbbWWbb', 'bbppbbppbb']),
  roof: pic(4, 4, ['..rrrrrrrr..', '.LRRRRRRRRh.', '.LRRRRRRRRh.', 'eeeeeeeeeeee']),
  attic: pic(9, 5, ['GG']),
  tower: OV_TOWER,
  banners: [[8, 9], [11, 9]],
  chimney: null,
  flag: null,
  towerFlag: null,
  posts: [5, 14, 8, 11],
  plates: [8],
  fence: [],
  ladder: 3,
  pole: 15,
  fire: [6, 9, 13],
  panes: [],
}

const OV_TOWERHOUSE: Art = {
  found: pic(6, 13, ['ssssssss']),
  wall: pic(7, 6, ['pppppq', 'PWGGpq', 'PWGGpq', 'sSSSSK', 'PWDDpq', 'PWDDpq', 'PWDDpq']),
  stone: pic(7, 10, ['sSDDSK', 'sSDDSK', 'MSDDSM']),
  front: NONE,
  roof: pic(5, 0, ['....rr....', '....Lh....', '...LRhh...', '..LLRhhh..', '.LLRRhhhh.', 'eeeeeeeeee']),
  attic: pic(9, 2, ['GG']),
  tower: pic(3, 3, ['.L.', 'LRh', 'eee', 'pPq', 'pGq', 'pPq', 'pPq', 'sSK', 'sSK', 'sSK', 'KKK']),
  banners: [[8, 9], [11, 9]],
  chimney: null,
  flag: null,
  towerFlag: null,
  posts: [7, 12, 8, 11],
  plates: [6, 9],
  fence: [],
  ladder: 4,
  pole: 14,
  fire: [7, 9, 12],
  panes: [],
}

/** Every kind at both scales, in the order of `STYLES`. */
const KINDS: readonly { cu: Shape; ov: Shape }[] = [
  { cu: shapeOf(COTTAGE), ov: shapeOf(OV_COTTAGE) },
  { cu: shapeOf(TOWNHOUSE), ov: shapeOf(OV_TOWNHOUSE) },
  { cu: shapeOf(WORKSHOP), ov: shapeOf(OV_WORKSHOP) },
  { cu: shapeOf(SHOP), ov: shapeOf(OV_SHOP) },
  { cu: shapeOf(TOWER), ov: shapeOf(OV_TOWERHOUSE) },
]

// ---- drawing a kind of building

/** Level 5's banner: close-up 2 wide (a gold rod, the cloth with a gold boss), overview a pixel wide. */
const CU_BANNER = ['kk', 'bb', 'bb', 'bk', 'bb', 'bb', 'b.'] as const
const OV_BANNER = ['k', 'b', 'b'] as const
const CU_PILE = ['..sK..', '.sSSK.', 'sSSKSK', 'wwwwww', 'BBBBBB', 'dwwwwd'] as const
const OV_PILE = ['.s.', 'sSK', 'www', 'BBB'] as const

/** The building as it stands, at level `lv`; `roofGone` rows of roof burnt away, `wallGone` rows of wall fallen. */
function standing(pen: Pen, X: number, Y: number, a: Shape, look: HouseLook, lv: number, roofGone: number, wallGone: number, big: boolean) {
  const rf = roofOf(look.color, lv >= 4)
  draw(pen, a.found, X, Y, WALL)
  const stoneAt = lv >= 3 && a.stone.rows.length ? a.stone.y - a.wall.y : a.wall.rows.length
  draw(pen, a.wall, X, Y, WALL, wallGone, a.wall.rows.length)
  if (lv >= 3) draw(pen, a.stone, X, Y, WALL, Math.max(0, wallGone - stoneAt))
  if (wallGone === 0) {
    draw(pen, a.front, X, Y, rf.pal)
    draw(pen, a.roof, X, Y, rf.pal, roofGone)
  }
  if (roofGone > 0 && wallGone < 2) {
    // charred rafters where the roof has burnt away
    for (let j = 0; j < roofGone && j < a.edges.length; j++) {
      const [l, r] = a.edges[j] ?? [0, 0]
      pen.dot(X + l, Y + a.roof.y + j, C.char)
      pen.dot(X + r, Y + a.roof.y + j, C.char)
    }
  }
  if (roofGone === 0) {
    if (big && a.chimney) chimney(pen, X, Y, a.chimney)
    const f = lv >= 3 ? a.towerFlag : a.flag
    if (big && f && look.fire < 4000) flag(pen, X, Y, f, rf, look.anim)
    if (lv >= 2) draw(pen, a.attic, X, Y, rf.pal)
  }
  if (lv >= 3) draw(pen, a.tower, X, Y, rf.pal, roofGone >= (big ? 5 : 3) ? (big ? 7 : 3) : 0)
  if (lv >= 2 && big) for (const [from, to] of a.fence) fence(pen, X, Y, from, to)
  if (lv >= 5 && wallGone === 0) for (const [bx, by] of a.banners) paint(pen, big ? CU_BANNER : OV_BANNER, X + bx, Y + by, rf.pal)
}

/** The chimney: light on the left, a mortar course, a dark cap. */
function chimney(pen: Pen, X: number, Y: number, [x, top, bottom]: readonly [number, number, number]) {
  for (let r = top + 1; r <= bottom; r++) {
    pen.dot(X + x, Y + r, C.stoneLight)
    pen.dot(X + x + 1, Y + r, r === top + 3 ? C.mortar : C.stone)
    pen.dot(X + x + 2, Y + r, C.stoneDark)
  }
  for (let c = 0; c < 3; c++) pen.dot(X + x + c, Y + top, C.stoneDark)
}

/** The flag in the builder's color on a pole standing on row `on` at column `c`, its tip flapping. */
function flag(pen: Pen, X: number, Y: number, [c, on]: readonly [number, number], rf: Roof, anim: number) {
  const top = Math.max(0, on - 5)
  for (let r = top; r < on; r++) pen.dot(X + c, Y + r, C.woodLight)
  const wave = anim % 2
  for (let i = 1; i <= 4; i++) {
    const dy = i === 4 ? wave : 0
    pen.dot(X + c + i, Y + top + dy, rf.flag)
    pen.dot(X + c + i, Y + top + 1 + dy, i > 1 ? rf.flagDark : rf.flag)
  }
}

/** A low picket fence, columns from..to, in front of the foundation. */
function fence(pen: Pen, X: number, Y: number, from: number, to: number) {
  for (let c = from; c <= to; c++) {
    if ((c - from) % 2 === 0) for (let r = 24; r <= 27; r++) pen.dot(X + c, Y + r, r === 24 ? C.flowerW : C.white)
    else {
      pen.dot(X + c, Y + 25, C.white)
      // the fence's shadow on the stones behind it
      if (pen.kind[(Y + 26) * pen.w + X + c] === OBJECT) (pen.shade(X + c, Y + 26, 0.62), pen.shade(X + c, Y + 27, 0.62))
    }
  }
}

/**
 * The timber skeleton, `f` 0..1 how far it has got: posts rise one by one, then the plates, then the rafters
 * climb the roof's outline from the eaves to the ridge.
 */
function frame(pen: Pen, X: number, Y: number, a: Shape, f: number, big: boolean) {
  const bottom = a.found.y - 1
  const height = bottom - a.wall.y
  for (let k = 0; k < a.posts.length; k++) {
    const grown = clamp((f - k * 0.08) / 0.1)
    if (grown <= 0) continue
    for (let r = bottom - Math.round(grown * height); r <= bottom; r++) pen.dot(X + (a.posts[k] ?? 0), Y + r, C.wood)
  }
  const x0 = a.posts[0] ?? 0
  const x1 = a.posts[1] ?? 0
  const d0 = a.posts[2] ?? 0
  const d1 = a.posts[3] ?? 0
  if (f > 0.4) a.plates.forEach((r, i) => { for (let c = x0; c <= x1; c++) if (i === 0 || c < d0 || c > d1) pen.dot(X + c, Y + r, C.wood) })
  const roofF = clamp((f - 0.5) / 0.5)
  if (roofF <= 0) return
  const n = a.edges.length
  const eave = a.roof.y + n - 1
  const [l0, r0] = a.edges[n - 1] ?? [0, 0]
  for (let c = l0; c <= r0; c++) pen.dot(X + c, Y + eave, C.woodLight)
  const up = Math.round(roofF * (n - 1))
  for (let j = 1; j <= up; j++) {
    const [l, r] = a.edges[n - 1 - j] ?? [0, 0]
    pen.dot(X + l, Y + eave - j, C.woodLight)
    pen.dot(X + r, Y + eave - j, C.woodLight)
  }
  if (roofF < 1) return
  const [lt, rt] = a.edges[0] ?? [0, 0]
  for (let c = lt; c <= rt; c++) pen.dot(X + c, Y + a.roof.y, C.woodLight)
  // a king post and a collar tie
  const mid = big ? 19 : 9
  for (let r = a.roof.y + 1; r < eave; r++) pen.dot(X + mid, Y + r, C.woodLight)
  const tie = a.roof.y + Math.round((n - 1) * 0.6)
  const [lc, rc] = a.edges[tie - a.roof.y] ?? [0, 0]
  if (big) for (let c = lc; c <= rc; c++) pen.dot(X + c, Y + tie, C.woodLight)
}

/** The footing seen from above: a pit dug out, stones laid round it as `f` goes 0..1, stakes and strings. */
function footing(pen: Pen, X: number, Y: number, a: Shape, f: number, strings: boolean, big: boolean) {
  const fp = a.found
  const w = (fp.rows[0] ?? '').length
  const x0 = fp.x
  const x1 = fp.x + w - 1
  const fy = fp.y
  const back = big ? 17 : 9
  const was = pen.layer
  pen.layer = GROUND
  if (big) pen.rect(X + x0 + 2, Y + back + 2, w - 4, fy - back - 2, C.roadEdge)
  else pen.rect(X + x0 + 1, Y + back + 1, w - 2, fy - back - 1, C.roadEdge)
  pen.layer = was
  const front = clamp(f / 0.4)
  const sides = clamp((f - 0.4) / 0.3)
  const rear = clamp((f - 0.7) / 0.3)
  // the front first, left to right
  const fc = Math.round(front * w)
  for (let i = 0; i < fc; i++) {
    for (let j = 0; j < fp.rows.length; j++) {
      const ch = (fp.rows[j] ?? '')[i] ?? 'S'
      if (ch !== '.') pen.dot(X + x0 + i, Y + fy + j, j > 0 && ch === 's' ? C.stone : (WALL[ch] ?? C.stone))
    }
  }
  const depth = fy - back - 1
  const sc = Math.round(sides * depth)
  for (let k = 0; k < sc; k++) {
    const r = fy - 1 - k
    pen.dot(X + x0, Y + r, C.stoneLight)
    pen.dot(X + x1, Y + r, C.stoneLight)
    if (big) (pen.dot(X + x0 + 1, Y + r, C.stone), pen.dot(X + x1 - 1, Y + r, C.stone))
  }
  const bc = Math.round(rear * w)
  for (let i = 0; i < bc; i++) {
    pen.dot(X + x0 + i, Y + back, C.stoneLight)
    if (big) pen.dot(X + x0 + i, Y + back + 1, i < 2 || i > w - 3 ? C.stoneLight : C.stoneDark)
  }
  // stakes at the corners, and strings between them where no stone lies yet
  const sl = x0 - 1
  const sr = x1 + 1
  if (big) for (const c of [sl, sr]) for (let j = 0; j < 4; j++) (pen.dot(X + c, Y + back - 3 + j, j === 0 ? C.woodLight : C.wood), pen.dot(X + c, Y + fy - 3 + j, j === 0 ? C.woodLight : C.wood))
  else for (const c of [x0, x1]) for (let r = back - 2; r < back; r++) pen.dot(X + c, Y + r, r === back - 2 ? C.woodLight : C.wood)
  if (!strings) return
  pen.layer = OVERLAY
  if (big) {
    if (rear < 1) for (let c = x0; c <= x1; c++) pen.dot(X + c, Y + back - 3, C.paper)
    if (sides < 1) for (let r = back - 2; r <= fy - 4; r++) (pen.dot(X + sl, Y + r, C.paper), pen.dot(X + sr, Y + r, C.paper))
  } else if (rear < 1) for (let c = x0 + 1; c < x1; c++) pen.dot(X + c, Y + back - 2, C.paper)
  pen.layer = was
}

/** Scaffolding: a ladder (close-up) or a pole on the left, poles and planks on the right; `across` over the front too. */
function scaffold(pen: Pen, X: number, Y: number, a: Shape, top: number, across: boolean, big: boolean) {
  const bottom = big ? 27 : 13
  if (big) {
    for (let r = top; r <= bottom; r++) {
      pen.dot(X + a.ladder, Y + r, C.wood)
      pen.dot(X + a.ladder + 2, Y + r, C.wood)
      if ((r - top) % 3 === 1) pen.dot(X + a.ladder + 1, Y + r, C.woodLight)
    }
    for (let r = top - 1; r <= bottom; r++) (pen.dot(X + a.pole, Y + r, C.wood), pen.dot(X + a.pole - 3, Y + r, C.woodDark))
    for (const r of [top + 1, 21]) for (let c = across ? a.ladder : a.pole - 5; c <= a.pole; c++) (pen.dot(X + c, Y + r, C.woodLight), pen.dot(X + c, Y + r + 1, C.woodDark))
  } else {
    for (let r = top; r <= bottom; r++) (pen.dot(X + a.ladder, Y + r, C.wood), pen.dot(X + a.pole, Y + r, C.wood))
    for (let c = a.ladder; c <= a.pole; c++) if (across || c < a.ladder + 3 || c > a.pole - 3) pen.dot(X + c, Y + 8, C.woodLight)
  }
}

// ---- fire

/** A tongue of flame as light: `w` wide at its base on row `base`, `h` tall, its tip swaying by `sway`. */
function flame(pen: Pen, cx: number, base: number, w: number, h: number, sway: number) {
  for (let j = 0; j < h; j++) {
    const v = j / h
    const hw = Math.floor(((w - 1) / 2) * Math.pow(1 - v, 0.8) + 0.5)
    const off = Math.round(sway * v * v)
    for (let i = -hw; i <= hw; i++) {
      const edge = hw > 0 && (i === hw || i === -hw)
      const k = v > 0.72 ? 3 : edge ? (v > 0.35 ? 3 : 2) : v > 0.45 ? 2 : v > 0.2 || Math.abs(i) > hw / 2 ? 1 : 0
      pen.glow(cx + i + off, base - j, C.fire[k] ?? C.ember)
    }
  }
}

/** Flicker, 0..1, from the frame and a seed: deterministic, different for every tongue. */
const flick = (anim: number, seed: number) => 0.5 + 0.5 * Math.sin(anim * 1.9 + seed * 2.7) * Math.cos(anim * 0.7 + seed * 1.3)

/**
 * A plume of smoke rising `rise` rows from (cx, y): puffs leave from across the fire, merge as they climb, drift
 * downwind and pale. `thick` 0..1 how dark. OVERLAY, so it is not ringed. The highest puffs are painted first.
 */
function smoke(pen: Pen, cx: number, y: number, n: number, rise: number, big: boolean, anim: number, thick: number) {
  const was = pen.layer
  pen.layer = OVERLAY
  const speed = big ? 1.5 : 0.75
  let k0 = 0
  let most = -1
  for (let k = 0; k < n; k++) {
    const up = (anim * speed + (k * rise) / n) % rise
    if (up > most) (most = up), (k0 = k)
  }
  for (let m = 0; m < n; m++) {
    const k = (k0 - m + n) % n
    const up = (anim * speed + (k * rise) / n) % rise
    const v = up / rise
    const size = big ? 4 + Math.floor(v * 3) : 2 + Math.floor(v * 1.8)
    const from = (((k * 3) % 5) - 2) * (big ? 3 : 1.5)
    const sx = Math.round(cx + from * (1 - v * 0.6) + v * v * (big ? 9 : 4) - size / 2)
    const sy = Math.round(y - up - size / 2)
    const col = C.smoke[Math.min(3, Math.floor(v * 2.4 + (1 - thick) * 1.8))] ?? C.smoke[3]
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        if (size > 3 && (i === 0 || i === size - 1) && (j === 0 || j === size - 1)) continue
        pen.dot(sx + i, sy + j, col)
      }
    }
  }
  pen.layer = was
}

/** Sparks flying up from a fire, as light. */
function embers(pen: Pen, cx: number, y: number, spread: number, n: number, height: number, anim: number) {
  for (let k = 0; k < n; k++) {
    const up = (anim * 2 + k * 7) % height
    const sx = cx + ((k * 11 + (up >> 2) * (k % 2 ? 1 : -1)) % spread) - spread / 2
    pen.glow(sx, y - up, up > height * 0.6 ? C.fire[3] : k % 3 ? C.ember : C.fire[1])
  }
}

/** Darkens everything drawn in the building's box toward soot. */
function char(pen: Pen, x0: number, y0: number, w: number, h: number, step: number) {
  if (step <= 0) return
  for (let y = Math.max(0, y0); y < Math.min(pen.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(pen.w, x0 + w); x++) {
      const i = y * pen.w + x
      if (pen.kind[i] === OBJECT) pen.px[i] = charOf(pen.px[i] ?? 0, step)
    }
  }
}

/** How fierce a fire is at `t` ms: catching, roaring, dying down as the house falls in. */
const fierce = (t: number) => (t < 1500 ? 0.25 + 0.35 * (t / 1500) : t < 3000 ? 0.6 + 0.4 * ((t - 1500) / 1500) : t < 7500 ? 1 : 1 - 0.35 * clamp((t - 7500) / 1500))

/** Flames over whatever stands (its top on row `top`), out of the windows when it has them, sparks. */
function fireOn(pen: Pen, X: number, Y: number, a: Shape, t: number, anim: number, top: number, windows: boolean, big: boolean) {
  const k = fierce(t)
  const mid = Math.floor(a.fire.length / 2)
  for (let i = 0; i < a.fire.length; i++) {
    if (t < 1500 && i !== mid) continue
    const cx = a.fire[i] ?? 19
    const surf = Math.max(top, a.top[Math.round(cx)] ?? top)
    const edge = i === 0 || i === a.fire.length - 1
    if (big) {
      const h = Math.round((7 + 8 * flick(anim, i)) * k * (edge ? 0.7 : 1))
      flame(pen, X + cx, Y + surf + 3, i === mid ? 7 : 5, h, Math.round(Math.sin(anim * 0.9 + i) * 2))
    } else {
      const h = Math.round((4 + 4 * flick(anim, i)) * k)
      flame(pen, X + cx + (i === mid ? 0.5 : 0), Y + surf + 2, i === mid ? 5 : 3, h, Math.round(Math.sin(anim * 0.9 + i)))
    }
  }
  if (windows && big) a.panes.forEach(([wx, wy], w) => flame(pen, X + wx, Y + wy, 3, Math.round(3 + 3 * flick(anim, w + 5) * Math.min(1, t / 2000)), 1))
  if (big) embers(pen, X + 19, Y + top - 4, 26, Math.round(4 + 8 * k), 18, anim)
  else embers(pen, X + 9, Y + top - 2, 12, Math.round(2 + 4 * k), 9, anim)
}

// ---- ruins

/** Ruins close-up, plot columns 6..31 from row 12: charred posts, a fallen beam, a heap of rubble. */
const CU_RUINS = [
  '...K......................',
  '...K......................',
  '...K..............a.......',
  '...K..............K.......',
  '...K..............KK......',
  '...K.......a......K.K.....',
  '...K.......K......K..K....',
  '...K.......K......K...K..a',
  '...K.......K..rr..K....K.K',
  '...K.....rrKrrRRr.K...rRKK',
  '...Kr..rrRRKRRRRRrKrrrRRRK',
  '...KRrrRRkRRRRkRRRRRRkRRRK',
  '..aaaaaaaaaaaaaaaaaaaaaaa.',
  '..MSSMSSSSMSSSSMSSSSMSSMS.',
  '..SSSSMSSSSSMSSSSSMSSSSSS.',
] as const
/** What is left of the tower: a roofless stone stump, plot columns 6..11 from row 14. */
const CU_STUMP = ['K.K.KK', 'SKSSSK', 'SSSSKK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'sSSSSK', 'KKKKKK'] as const
/** The same at overview, plot columns 3..15 from row 5. */
const OV_RUINS = [
  '..K..........',
  '..K.......a..',
  '..K.......K..',
  '..K..rr...K..',
  '..KrRRRr..K..',
  '..KRRRRRRrK..',
  '.rRRRRRRRRRr.',
  '.aaaaaaaaaaaa',
  '.SSSSSSSSSSSS',
] as const
const OV_STUMP = ['K.K', 'SSK', 'sSK', 'sSK', 'sSK', 'sSK', 'sSK', 'sSK', 'KKK'] as const
const RUIN: Pal = { K: C.char, k: C.char, a: C.ash, r: C.rock, R: C.rockDark, S: C.stoneDark, M: C.mortar, s: C.stone }
const STUMP: Pal = { ...RUIN, S: C.rockDark, s: C.rock }

function ruins(pen: Pen, X: number, Y: number, a: Shape, look: HouseLook, t: number, big: boolean) {
  const anim = look.anim
  const bare = look.stage === 'foundation' && look.level < 1
  if (bare) {
    footing(pen, X, Y, a, 1, false, big)
    if (big) char(pen, X + 6, Y, 26, 28, 4)
    else char(pen, X + 3, Y, 13, 14, 4)
  } else if (big) {
    paint(pen, CU_RUINS, X + 6, Y + 12, RUIN)
    if (look.level >= 3) paint(pen, CU_STUMP, X + 6, Y + 14, STUMP)
  } else {
    paint(pen, OV_RUINS, X + 3, Y + 5, RUIN)
    if (look.level >= 3) paint(pen, OV_STUMP, X + 3, Y + 5, STUMP)
  }
  const left = 1 - (t - BURN.ruins) / (BURN.embers - BURN.ruins)
  const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
  if (big) {
    if (t < BURN.embers) {
      // embers glowing in the heap, a few last flames
      const n = Math.round(9 * left)
      for (let k = 0; k < n; k++) if ((anim + k) % 5) pen.glow(X + 10 + ((k * 7) % 19), Y + 22 + ((k * 3) % 2), (k + anim) % 3 ? C.ember : C.fire[3])
      if (!bare && t < 12500) for (let k = 0; k < 3; k++) flame(pen, X + 13 + k * 6, Y + 22, 3, Math.round(2 + 3 * flick(anim, k) * (1 - (t - BURN.ruins) / 3500)), 1)
    }
    if (t < BURN.smoke) smoke(pen, X + 19, Y + 19, Math.max(1, Math.round(8 * thin)), 26, true, anim, thin * 0.8)
  } else {
    if (t < BURN.embers) {
      const n = Math.round(5 * left)
      for (let k = 0; k < n; k++) if ((anim + k) % 4) pen.glow(X + 6 + ((k * 3) % 7), Y + 10 + (k % 2), (k + anim) % 3 ? C.ember : C.fire[3])
      if (!bare && t < 12500) flame(pen, X + 9, Y + 10, 3, Math.round(1 + 2 * flick(anim, 1)), 0)
    }
    if (t < BURN.smoke) smoke(pen, X + 9, Y + 9, Math.max(1, Math.round(5 * thin)), 13, false, anim, thin * 0.8)
  }
}

// ---- the building

/**
 * Draws a building on its plot, (x, y) the plot's top-left. Close-up (s=1), in plot coordinates:
 *  - the building stands within columns 6..31 and rows 0..27; row 27 is its bottom (the foundation's last row).
 *    Chimney smoke and flames may rise above row 0 (as OVERLAY or `pen.glow`), nothing else leaves the plot.
 *  - rows 28..31 stay ground: the engine writes the building's name there. A 2-px path leaves the door
 *    (centred on column 19) down through them, which the engine paints.
 *  - its builder stands right of it with feet on (36, 27), facing left, hammering at the wall's right side.
 *  - while `building`, the pile of planks and stones sits in columns 0..5, rows 21..27; helpers drop crates there.
 * Overview (s=0.5): every number halves (columns 3..15, rows 0..13, labels 14..15, builder on (18, 13), pile 0..2).
 * Everything drawn is OBJECT (the engine rings it) except smoke (OVERLAY) and light (`pen.glow`).
 *
 * A standing building (level 1 or more) is drawn finished whatever its `stage`; a first build (level 0) shows its
 * stage, `progress` saying how far within it. A fire chars it, caves its roof in from 7000 ms, drops its walls
 * from 8400 and leaves ruins at 9000.
 */
export function house(pen: Pen, s: Scale, x: number, y: number, look: HouseLook) {
  const big = s === 1
  const kind = KINDS[Math.abs(Math.floor(look.style ?? 0)) % KINDS.length] ?? KINDS[0]
  if (!kind) return
  const a = big ? kind.cu : kind.ov
  const t = look.fire
  const was = pen.layer
  pen.layer = OBJECT
  if (t >= BURN.ruins) {
    ruins(pen, x, y, a, look, t, big)
    pen.layer = was
    return
  }
  const burning = t >= 0
  const standingUp = look.level >= 1 || look.stage === 'done'
  const lv = Math.max(1, look.level)
  const stage: Stage = standingUp ? 'done' : look.stage
  const within = stage === 'done' ? 1 : clamp((look.progress - STAGES[stage][0]) / (STAGES[stage][1] - STAGES[stage][0]))
  const work = look.building && !burning
  const anim = look.anim
  // a fire: how much of the roof has burnt away, how many rows of wall have fallen
  const caving = burning ? clamp((t - BURN.roofFalls) / (BURN.wallsFall - BURN.roofFalls)) : 0
  const falling = burning ? clamp((t - BURN.wallsFall) / (BURN.ruins - BURN.wallsFall)) : 0
  const step = burning ? Math.min(5, Math.floor(t / 1500)) : 0
  const roofRows = a.roof.rows.length
  const wallRows = a.wall.rows.length
  const roofGone = Math.round(caving * roofRows)
  const wallGone = Math.round(falling * (big ? 4 : 2))
  const roofTop = a.roof.y
  let top = roofTop // the top of what stands, where the flames take hold
  let windows = false
  if (stage === 'done') {
    standing(pen, x, y, a, look, lv, roofGone, wallGone, big)
    top = wallGone > 0 ? a.wall.y + wallGone : roofTop + roofGone
    windows = wallGone < 3
  } else {
    footing(pen, x, y, a, stage === 'foundation' ? within : 1, stage === 'foundation' && !burning, big)
    if (stage === 'foundation') top = a.found.y - 3
    else if (stage === 'frame') {
      frame(pen, x, y, a, within, big)
      top = within > 0.5 ? roofTop + roofRows - 1 - Math.round(clamp((within - 0.5) / 0.5) * (roofRows - 1)) : a.wall.y
    } else if (stage === 'walls') {
      frame(pen, x, y, a, 1, big)
      const rows = within * wallRows
      const n = Math.floor(rows)
      draw(pen, a.wall, x, y, WALL, wallRows - n)
      if (n < wallRows) {
        // the row going up now, laid from the left
        const j = wallRows - 1 - n
        const row = a.wall.rows[j] ?? ''
        const part = Math.floor((rows - n) * row.length)
        paint(pen, [row.slice(0, part)], x + a.wall.x, y + a.wall.y + j, WALL)
      }
      windows = within > 0.6
    } else {
      draw(pen, a.found, x, y, WALL)
      draw(pen, a.wall, x, y, WALL)
      const rf = roofOf(look.color)
      draw(pen, a.front, x, y, rf.pal)
      frame(pen, x, y, a, 1, big)
      const rows = within * roofRows
      const n = Math.floor(rows)
      draw(pen, a.roof, x, y, rf.pal, roofRows - n)
      if (n < roofRows) {
        const j = roofRows - 1 - n
        const row = a.roof.rows[j] ?? ''
        const [l, r] = a.edges[j] ?? [0, 0]
        const part = Math.floor((rows - n) * (r - l + 1))
        paint(pen, [row.slice(0, l - a.roof.x + part)], x + a.roof.x, y + roofTop + j, rf.pal)
      }
      windows = true
    }
  }
  if (work) {
    if (stage !== 'foundation') scaffold(pen, x, y, a, big ? a.wall.y - 2 : 5, stage === 'done', big)
    if (big) paint(pen, CU_PILE, x, y + 22, WALL)
    else paint(pen, OV_PILE, x, y + 10, WALL)
  }
  if (big) char(pen, x + 6, y, 26, 28, step)
  else char(pen, x + 3, y, 13, 14, step)
  if (stage === 'done' && !burning && big && a.chimney && roofGone === 0) {
    // a wisp from the chimney
    pen.layer = OVERLAY
    const k = anim % 8
    const cx = a.chimney[0] + 1
    const cy = a.chimney[1]
    pen.dot(x + cx + (k > 4 ? 1 : 0), y + cy - 2 - (k >> 1), C.smoke[3])
    if (k > 1) pen.dot(x + cx + 1, y + cy - 4 - (k >> 1), C.smoke[2])
    pen.layer = OBJECT
  }
  if (look.lit || burning) {
    if (stage === 'done') {
      // the stone floor keeps the walls' windows where they were
      lightGlass(pen, a.wall, x, y, t, anim, wallGone)
      if (wallGone === 0) lightGlass(pen, a.front, x, y, t, anim)
      if (lv >= 2 && roofGone === 0) lightGlass(pen, a.attic, x, y, t, anim)
      if (lv >= 3) lightGlass(pen, a.tower, x, y, t, anim)
    } else if (stage === 'roof') lightGlass(pen, a.wall, x, y, t, anim)
  }
  if (burning) {
    if (big) smoke(pen, x + 19, y + top, Math.round(6 + 10 * clamp(t / 2500)), 22, true, anim, Math.min(1, 0.4 + t / 3000))
    else smoke(pen, x + 9, y + top, Math.round(4 + 5 * clamp(t / 2500)), 11, false, anim, Math.min(1, 0.4 + t / 3000))
    fireOn(pen, x, y, a, t, anim, top, windows, big)
  }
  pen.layer = was
}

/** Mown grass on an empty lot, a step lighter than the meadow round it, and the string pegged round it. */
const MOWN = 0x5a9a44
const STRING = blend(C.paperShade, MOWN, 0.45)

/** The lot's little sign close-up, its board at columns 10..14 from row 19 on a post (wall letters). */
const CU_SIGN = ['wwwww', 'wPPPw', 'wwwww', '..B..', '..B..', '..B..', '..B..'] as const

/**
 * An empty plot, waiting for a feature: drawn on the whole plot (40 by 36 close-up, 20 by 18 overview) with the
 * same rules as a building (within rows 0..27, rows 28..31 left for the engine, the path from column 19 down).
 * Something you can tell is a lot for building on from afar (marked corners, mown grass, a small sign), quiet
 * enough that a street of them does not shout.
 */
export function lot(pen: Pen, s: Scale, x: number, y: number, anim: number) {
  void anim
  const was = pen.layer
  const big = s === 1
  // the house's footprint mown, a string round it from peg to peg
  const [x0, y0, x1, y1] = big ? [8, 14, 31, 27] : [4, 7, 15, 13]
  pen.layer = GROUND
  pen.rect(x + x0, y + y0, x1 - x0 + 1, y1 - y0 + 1, MOWN)
  pen.layer = OVERLAY
  for (let c = x0; c <= x1; c++) (pen.dot(x + c, y + y0, STRING), pen.dot(x + c, y + y1, STRING))
  for (let r = y0 + 1; r < y1; r++) (pen.dot(x + x0, y + r, STRING), pen.dot(x + x1, y + r, STRING))
  if (big) {
    // stakes at the corners, and a little sign: the plot is for sale
    pen.layer = OBJECT
    for (const [c, r] of [[x0, y0 - 1], [x1, y0 - 1], [x0, y1 - 1], [x1, y1 - 1]] as const) (pen.dot(x + c, y + r, C.woodLight), pen.dot(x + c, y + r + 1, C.wood))
    paint(pen, CU_SIGN, x + 10, y + 19, WALL)
  } else for (const [c, r] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) pen.dot(x + c, y + r, C.woodLight)
  pen.layer = was
}

// ==== the town's kinds (kinds.ts TOWN_KINDS): every feature as the kind of thing that fits it
//
// Each kind is drawn in its own footprint (kinds.ts KINDS close-up, halved at overview), (0, 0) its top-left and
// the door on the middle of its bottom edge. The buildings among them go up as a house does (footing, frame, walls
// rising, the roof from the eaves up) from pictures of their own (`Spec`), and are improved the same way: a dormer
// or the like (level 2), a stone ground floor and a tower or a grander part (3), gold trim (4), banners (5). The
// statue is carved in its scaffolding and the garden dug, planted and furnished, each by a hand of its own.

/** Letters the kinds use beyond the walls' and the roofs'. */
const EXTRA: Pal = {
  i: 0x2a2320, I: C.iron, j: C.ironDark, '1': C.books[0], '2': C.books[1], '3': C.books[2], '4': C.books[3], '5': C.books[4],
  v: C.leafDark, V: C.leafLight, y: C.flowerW, a: 0xd24a32, c: 0xe8902c, f: C.paper, o: C.lit, Q: C.white, t: C.trunk,
  O: C.trunkDark, m: C.sand, A: C.water, E: C.waterLight, U: C.goldDark,
}

const pals = new Map<number, Pal>()
/** Every letter a kind's pictures use at level `lv`: the roof in `color`, gold trim from level 4 ('z' and 'Z' turn gold). */
function palOf(color: number, lv: number): Pal {
  const gilded = lv >= 4
  const key = color * 2 + (gilded ? 1 : 0)
  let p = pals.get(key)
  if (!p) pals.set(key, (p = { ...roofOf(color, gilded).pal, ...EXTRA, z: gilded ? C.gold : C.stoneLight, Z: gilded ? C.goldDark : C.stone }))
  return p
}

const rep = (ch: string, n: number) => (n > 0 ? ch.repeat(n) : '')

/** Rows `w` wide and `h` tall laid out of parts on '.': each part's rows at (x, y), its '.' leaving what is under it. */
function compose(w: number, h: number, parts: readonly (readonly [number, number, Rows])[]): string[] {
  const g = Array.from({ length: h }, () => new Array<string>(w).fill('.'))
  for (const [x, y, rows] of parts) {
    rows.forEach((r, j) => {
      const row = g[y + j]
      if (!row) return
      for (let i = 0; i < r.length; i++) {
        const ch = r[i]
        if (ch !== undefined && ch !== '.' && x + i >= 0 && x + i < w) row[x + i] = ch
      }
    })
  }
  return g.map(r => r.join(''))
}

/**
 * A steep roof seen from its corner: a 2-px ridge, each of the `n` - 1 rows under it a pixel wider a side, the lit
 * half left (its edge L), the shaded half right, a course every other row; then the eave: 2n + 2 wide.
 */
function steep(n: number): string[] {
  const rows = [rep('.', n) + 'rr' + rep('.', n)]
  for (let k = 1; k < n; k++) rows.push(rep('.', n - k) + 'L' + rep(k % 2 ? 'n' : 'R', k) + rep(k % 2 ? 'x' : 'h', k + 1) + rep('.', n - k))
  rows.push(rep('e', 2 * n + 2))
  return rows
}

/** A hip roof: a ridge `r` wide, `n` rows under it each a pixel wider a side, the lit end widening; then the eave, r + 2n + 2 wide. */
function hip(r: number, n: number): string[] {
  const rows = [rep('.', n + 1) + rep('r', r) + rep('.', n + 1)]
  for (let k = 1; k <= n; k++) {
    const e = Math.floor(k / 2) + 1
    rows.push(rep('.', n + 1 - k) + rep('L', e) + rep(k % 2 ? 'R' : 'n', r + 2 * k - 2 * e) + rep('h', e) + rep('.', n + 1 - k))
  }
  rows.push(rep('e', r + 2 * n + 2))
  return rows
}

/** A dome `w` wide (even) and `h` tall, a half disc: lit on the left, shaded on the right. */
function dome(w: number, h: number): string[] {
  const rows: string[] = []
  for (let j = 0; j < h; j++) {
    const v = (h - j - 0.5) / h
    const half = Math.max(1, Math.round((w / 2) * Math.sqrt(1 - v * v)))
    let r = ''
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5 - w / 2) / half
      r += Math.abs(u) > 1 ? '.' : u < -0.4 ? 'L' : u > 0.45 ? 'h' : 'R'
    }
    rows.push(r)
  }
  return rows
}

/** A course of stones `w` wide: mortar every 6, shifted by `k`. */
const course = (w: number, k: number) => Array.from({ length: w }, (_, i) => ((i + k * 3) % 6 === 4 ? 'M' : 'S')).join('')

/** A foundation `w` wide: a light top row and two courses, the doorstep (columns d0..d1) light. */
function plinth(w: number, d0: number, d1: number, rows = 3): string[] {
  const out = [rep('s', w)]
  for (let k = 1; k < rows; k++) out.push([...course(w, k)].map((ch, i) => (i >= d0 && i <= d1 ? 's' : ch)).join(''))
  return out
}

/** A slim stone tower `w` (4, 5 or 6) wide and `h` tall: a little pyramid roof, the eave, a stone body with slit windows. */
function keep(w: 4 | 5 | 6, h: number): string[] {
  const top = w === 6 ? ['..RR..', '.LRRh.', 'LLRRhh', 'eeeeee'] : w === 5 ? ['..R..', '.LRh.', 'LLRhh', 'eeeee'] : ['.Lh.', 'LRhh', 'eeee']
  const body: string[] = []
  const n = h - top.length - 1
  for (let j = 0; j < n; j++) {
    const win = j % 7 === 2 || j % 7 === 3
    const m = j % 3 === 1 ? 1 + ((j >> 1) % (w - 2)) : -1
    let mid = ''
    for (let i = 1; i < w - 1; i++) mid += win && (i === Math.floor((w - 1) / 2) || (w === 6 && i === 3)) ? 'G' : i === m ? 'M' : 'S'
    body.push('s' + mid + 'K')
  }
  return [...top, ...body, rep('K', w)]
}

/** A ground floor in stone from rows of wall: plaster, timber and planks turn to stone, the rest stays ('.'). */
function stony(rows: Rows): string[] {
  return rows.map((r, j) =>
    [...r]
      .map((ch, i) => {
        if (!'PTwB'.includes(ch)) return '.'
        if (j === rows.length - 1) return 'M'
        return (i + j * 3) % 7 === 0 ? 'M' : 'S'
      })
      .join(''),
  )
}

/** Level 5's banner (close-up 2 wide, overview 1), and the pile of materials while building. */
const PILE: Rows = ['.sK..', 'sSSK.', 'wwwww', 'BBBBB']

/**
 * A kind of building at one scale, in footprint coordinates of that scale. Painted in this order: the foundation,
 * the walls (level 3's stone over their lower rows), the front, the roof, the attic, the tower, the props, the banners.
 */
type Spec = {
  w: number
  h: number
  found: Pic
  wall: Pic
  /** Level 3's stone ground floor over the walls' lower rows ('.' leaves the wall). */
  stone: Pic
  /** With the walls once they stand, in roof letters: an awning, a sign, a porch. */
  front: Pic
  roof: Pic
  /** Level 2: a dormer or the like. */
  attic: Pic
  /** Level 3: a tower or a grander part. */
  tower: Pic
  /** Things about it once it stands: a bench, barrels, goods, a lamp. */
  props: Pic
  /** Level 5: where each banner hangs (its top-left). */
  banners: readonly (readonly [number, number])[]
  /** Close-up: a chimney 3 wide at column x from row `top` down to `bottom`, or null. */
  chimney: readonly [number, number, number] | null
  /** Close-up: the flag's pole (column, the row it stands on), and where it moves from level 3. */
  flag: readonly [number, number] | null
  towerFlag: readonly [number, number] | null
  /** The frame: posts (column, top row) rising from the foundation, plates (row, from, to), king posts (columns). */
  posts: readonly (readonly [number, number])[]
  plates: readonly (readonly [number, number, number])[]
  kings: readonly number[]
  /** The footing's back row. */
  back: number
  /** Scaffolding: the ladder's (or the left pole's) column, the right pole's, its top row, the rows of planks. */
  ladder: number
  pole: number
  rig: number
  planks: readonly number[]
  /** Close-up: pickets from level 2, [from, to] columns, on the bottom rows. */
  fence: readonly (readonly [number, number])[]
  /** Where flames rise (columns), and flames out of windows (x, y). */
  fire: readonly number[]
  panes: readonly (readonly [number, number])[]
  /** Ruins: how many rows of the walls are left standing (stone), 0 when it all falls. */
  stump: number
}

/** What a spec works out to, once: the roof's outline per row (for the rafters) and the top of the building per column. */
type Built = Spec & { outline: readonly (readonly number[])[]; top: readonly number[] }

function prep(s: Spec): Built {
  const rows = s.roof.rows
  const at = (i: number, j: number) => {
    const ch = rows[j]?.[i]
    return ch !== undefined && ch !== '.'
  }
  const outline = rows.map((r, j) => {
    const o: number[] = []
    for (let i = 0; i < r.length; i++) if (at(i, j) && (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1))) o.push(i)
    return o
  })
  const top: number[] = []
  for (let c = 0; c < s.w; c++) {
    let t = s.h
    for (const p of [s.roof, s.wall]) {
      p.rows.forEach((r, j) => {
        const ch = r[c - p.x]
        if (ch !== undefined && ch !== '.' && p.y + j < t) t = p.y + j
      })
    }
    top.push(t)
  }
  return { ...s, outline, top }
}

/** The stage of a first build. */
function stageOf(look: BuildLook): Stage {
  if (look.level >= 1 || look.progress >= 1) return 'done'
  const p = look.progress
  return p < STAGES.foundation[1] ? 'foundation' : p < STAGES.frame[1] ? 'frame' : p < STAGES.walls[1] ? 'walls' : 'roof'
}

/** Lights a picture: its glass ('G', 'g') as windows, 'o' as lamps, 'Q' (a clock face) softly; flames in them when burning. */
function shine(pen: Pen, p: Pic, X: number, Y: number, fire: number, anim: number, from = 0, to = p.rows.length) {
  for (let j = Math.max(0, from); j < to; j++) {
    const r = p.rows[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      const ch = r[i]
      if (ch !== 'G' && ch !== 'g' && ch !== 'o' && ch !== 'Q') continue
      const x = X + p.x + i
      const y = Y + p.y + j
      if (fire >= 0 && ch !== 'Q') pen.glow(x, y, (i + j + anim) % 3 === 0 ? C.fire[0] : (i * 3 + j + anim) % 4 === 0 ? C.fire[2] : C.fire[1])
      else if (fire < 0) pen.glow(x, y, ch === 'o' ? C.fire[0] : ch === 'Q' ? 0xf4e7c0 : C.lit)
    }
  }
}

/** The footing seen from above: a pit, stones laid round it as `f` goes 0..1, stakes and strings. */
function dig(pen: Pen, X: number, Y: number, a: Built, f: number, strings: boolean, big: boolean) {
  const fp = a.found
  const w = (fp.rows[0] ?? '').length
  const x0 = fp.x
  const x1 = fp.x + w - 1
  const fy = fp.y
  const back = a.back
  const was = pen.layer
  pen.layer = GROUND
  if (big) pen.rect(X + x0 + 2, Y + back + 2, w - 4, fy - back - 2, C.roadEdge)
  else pen.rect(X + x0 + 1, Y + back + 1, w - 2, fy - back - 1, C.roadEdge)
  pen.layer = was
  const front = clamp(f / 0.4)
  const sides = clamp((f - 0.4) / 0.3)
  const rear = clamp((f - 0.7) / 0.3)
  const fc = Math.round(front * w)
  for (let i = 0; i < fc; i++) {
    for (let j = 0; j < fp.rows.length; j++) {
      const ch = (fp.rows[j] ?? '')[i] ?? 'S'
      if (ch !== '.') pen.dot(X + x0 + i, Y + fy + j, j > 0 && ch === 's' ? C.stone : (WALL[ch] ?? C.stone))
    }
  }
  const depth = fy - back - 1
  const sc = Math.round(sides * depth)
  for (let k = 0; k < sc; k++) {
    const r = fy - 1 - k
    pen.dot(X + x0, Y + r, C.stoneLight)
    pen.dot(X + x1, Y + r, C.stoneLight)
    if (big) (pen.dot(X + x0 + 1, Y + r, C.stone), pen.dot(X + x1 - 1, Y + r, C.stone))
  }
  const bc = Math.round(rear * w)
  for (let i = 0; i < bc; i++) {
    pen.dot(X + x0 + i, Y + back, C.stoneLight)
    if (big) pen.dot(X + x0 + i, Y + back + 1, i < 2 || i > w - 3 ? C.stoneLight : C.stoneDark)
  }
  const sl = Math.max(0, x0 - 1)
  const sr = Math.min(a.w - 1, x1 + 1)
  if (big) for (const c of [sl, sr]) for (let j = 0; j < 4; j++) (pen.dot(X + c, Y + back - 3 + j, j === 0 ? C.woodLight : C.wood), pen.dot(X + c, Y + fy - 3 + j, j === 0 ? C.woodLight : C.wood))
  else for (const c of [x0, x1]) for (let r = back - 2; r < back; r++) pen.dot(X + c, Y + r, r === back - 2 ? C.woodLight : C.wood)
  if (!strings) return
  pen.layer = OVERLAY
  if (big) {
    if (rear < 1) for (let c = sl; c <= sr; c++) pen.dot(X + c, Y + back - 3, C.paper)
    if (sides < 1) for (let r = back - 2; r <= fy - 4; r++) (pen.dot(X + sl, Y + r, C.paper), pen.dot(X + sr, Y + r, C.paper))
  } else if (rear < 1) for (let c = x0 + 1; c < x1; c++) pen.dot(X + c, Y + back - 2, C.paper)
  pen.layer = was
}

/** The timber skeleton, `f` 0..1: posts rise one by one, then the plates, then rafters climb the roof's outline. */
function skeleton(pen: Pen, X: number, Y: number, a: Built, f: number) {
  const bottom = a.found.y - 1
  a.posts.forEach(([c, top], k) => {
    const grown = clamp((f - k * 0.06) / 0.1)
    if (grown <= 0) return
    for (let r = bottom - Math.round(grown * (bottom - top)); r <= bottom; r++) pen.dot(X + c, Y + r, C.wood)
  })
  if (f > 0.4) for (const [r, c0, c1] of a.plates) for (let c = c0; c <= c1; c++) pen.dot(X + c, Y + r, C.wood)
  const roofF = clamp((f - 0.5) / 0.5)
  if (roofF <= 0) return
  const n = a.roof.rows.length
  const up = Math.round(roofF * (n - 1))
  for (let j = n - 1; j >= n - 1 - up; j--) for (const i of a.outline[j] ?? []) pen.dot(X + a.roof.x + i, Y + a.roof.y + j, C.woodLight)
  if (roofF < 1) return
  for (const c of a.kings) {
    let r0 = -1
    let r1 = -1
    a.roof.rows.forEach((r, j) => {
      const ch = r[c - a.roof.x]
      if (ch !== undefined && ch !== '.') ((r0 = r0 < 0 ? j : r0), (r1 = j))
    })
    for (let j = r0 + 1; j < r1; j++) pen.dot(X + c, Y + a.roof.y + j, C.woodLight)
  }
}

/** Scaffolding: a ladder (close-up) or a pole on the left, poles and planks on the right; `across` over the front too. */
function rig(pen: Pen, X: number, Y: number, a: Built, across: boolean, big: boolean) {
  const bottom = a.h - 1
  const top = a.rig
  if (big) {
    for (let r = top; r <= bottom; r++) {
      pen.dot(X + a.ladder, Y + r, C.wood)
      pen.dot(X + a.ladder + 2, Y + r, C.wood)
      if ((r - top) % 3 === 1) pen.dot(X + a.ladder + 1, Y + r, C.woodLight)
    }
    for (let r = top - 1; r <= bottom; r++) (pen.dot(X + a.pole, Y + r, C.wood), pen.dot(X + a.pole - 3, Y + r, C.woodDark))
    for (const r of a.planks) for (let c = across ? a.ladder : a.pole - 5; c <= a.pole; c++) (pen.dot(X + c, Y + r, C.woodLight), pen.dot(X + c, Y + r + 1, C.woodDark))
  } else {
    for (let r = top; r <= bottom; r++) (pen.dot(X + a.ladder, Y + r, C.wood), pen.dot(X + a.pole, Y + r, C.wood))
    for (const r of a.planks) for (let c = a.ladder; c <= a.pole; c++) if (across || c < a.ladder + 3 || c > a.pole - 3) pen.dot(X + c, Y + r, C.woodLight)
  }
}

/** A low picket fence, columns from..to, on the footprint's bottom rows. */
function pickets(pen: Pen, X: number, Y: number, a: Built, from: number, to: number) {
  const b = a.h - 1
  for (let c = from; c <= to; c++) {
    if ((c - from) % 2 === 0) for (let r = b - 3; r <= b; r++) pen.dot(X + c, Y + r, r === b - 3 ? C.flowerW : C.white)
    else {
      pen.dot(X + c, Y + b - 2, C.white)
      if (pen.kind[(Y + b - 1) * pen.w + X + c] === OBJECT) (pen.shade(X + c, Y + b - 1, 0.62), pen.shade(X + c, Y + b, 0.62))
    }
  }
}

/** Flames over whatever stands (its top on row `top`), out of the windows when it has them, sparks. */
function blaze(pen: Pen, X: number, Y: number, a: Built, t: number, anim: number, top: number, windows: boolean, big: boolean) {
  const k = fierce(t)
  const mid = Math.floor(a.fire.length / 2)
  for (let i = 0; i < a.fire.length; i++) {
    if (t < 1500 && i !== mid) continue
    const cx = a.fire[i] ?? a.w / 2
    const surf = Math.max(top, a.top[Math.round(cx)] ?? top)
    const edge = i === 0 || i === a.fire.length - 1
    if (big) flame(pen, X + cx, Y + surf + 3, i === mid ? 7 : 5, Math.round((7 + 8 * flick(anim, i)) * k * (edge ? 0.7 : 1)), Math.round(Math.sin(anim * 0.9 + i) * 2))
    else flame(pen, X + cx + (i === mid ? 0.5 : 0), Y + surf + 2, i === mid ? 5 : 3, Math.round((4 + 4 * flick(anim, i)) * k), Math.round(Math.sin(anim * 0.9 + i)))
  }
  if (windows && big) a.panes.forEach(([wx, wy], w) => flame(pen, X + wx, Y + wy, 3, Math.round(3 + 3 * flick(anim, w + 5) * Math.min(1, t / 2000)), 1))
  const cx = X + Math.floor(a.w / 2)
  if (big) embers(pen, cx, Y + top - 4, a.w, Math.round(4 + 8 * k), 18, anim)
  else embers(pen, cx, Y + top - 2, a.w, Math.round(2 + 4 * k), 9, anim)
}

/** A picture's rows made `w` wide: cut in the middle, or widened by repeating its middle columns. */
function stretch(rows: Rows, w: number): string[] {
  const n = (rows[0] ?? '').length
  if (w === n) return [...rows]
  const a = Math.ceil(Math.min(w, n) / 2)
  const b = Math.min(w, n) - a
  if (w < n) return rows.map(r => r.slice(0, a) + r.slice(n - b))
  const mid = Math.floor(n / 2)
  return rows.map(r => {
    let fill = ''
    for (let i = 0; i < w - n; i++) fill += r[mid - 3 + (i % 6)] ?? '.'
    return r.slice(0, mid) + fill + r.slice(mid)
  })
}

/** What is left of a stone wall: per pair of columns how many rows still stand below the stump's top. */
const JAG = [0, 2, 1, 3, 0, 4, 2, 1, 3, 0, 2, 4] as const
const WRECK: Pal = {
  s: C.rock, W: C.rock, P: C.rock, L: C.rock, z: C.rock, w: C.rock, Q: C.rock,
  S: C.rockDark, p: C.rockDark, B: C.rockDark, T: C.rockDark, R: C.rockDark, Z: C.rockDark, h: C.rockDark, r: C.rockDark, n: C.rockDark, e: C.rockDark,
  K: C.char, M: C.char, q: C.char, d: C.char, G: C.char, g: C.char, D: C.char, i: C.char, k: C.char, x: C.char, j: C.char, I: C.rockDark, o: C.char,
}

/** Ruins: sooty foundation stones, what stone walls are left, a heap of rubble with charred posts, embers, thinning smoke. */
function wreck(pen: Pen, X: number, Y: number, a: Built, look: BuildLook, t: number, big: boolean) {
  const anim = look.anim
  const bare = look.level < 1 && look.progress < STAGES.foundation[1]
  if (bare) {
    dig(pen, X, Y, a, 1, false, big)
    char(pen, X, Y, a.w, a.h, 4)
  } else {
    const stump = big ? a.stump : Math.round(a.stump / 2)
    if (stump > 0) {
      const wl = a.wall
      const n = wl.rows.length
      const width = (wl.rows[n - 1] ?? '').length
      for (let i = 0; i < width; i++) {
        const keepRows = stump - (JAG[Math.floor(i / 2) % JAG.length] ?? 0) * (big ? 1 : 0.5)
        for (let j = Math.max(0, n - Math.round(keepRows)); j < n; j++) {
          const c = WRECK[(wl.rows[j] ?? '')[i] ?? '.']
          if (c !== undefined) pen.dot(X + wl.x + i, Y + wl.y + j, c)
        }
      }
    }
    const heap = stretch(big ? CU_RUINS : OV_RUINS, a.w)
    paint(pen, heap, X, Y + a.h - heap.length, RUIN)
  }
  const left = 1 - (t - BURN.ruins) / (BURN.embers - BURN.ruins)
  const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
  const cx = Math.floor(a.w / 2)
  if (big) {
    if (t < BURN.embers) {
      const n = Math.round(9 * left)
      for (let k = 0; k < n; k++) if ((anim + k) % 5) pen.glow(X + 4 + ((k * 7) % Math.max(1, a.w - 8)), Y + a.h - 6 + ((k * 3) % 2), (k + anim) % 3 ? C.ember : C.fire[3])
      if (!bare && t < 12500) for (let k = 0; k < 3; k++) flame(pen, X + cx - 6 + k * 6, Y + a.h - 6, 3, Math.round(2 + 3 * flick(anim, k) * (1 - (t - BURN.ruins) / 3500)), 1)
    }
    if (t < BURN.smoke) smoke(pen, X + cx, Y + a.h - 9, Math.max(1, Math.round(8 * thin)), 26, true, anim, thin * 0.8)
  } else {
    if (t < BURN.embers) {
      const n = Math.round(5 * left)
      for (let k = 0; k < n; k++) if ((anim + k) % 4) pen.glow(X + 3 + ((k * 3) % Math.max(1, a.w - 6)), Y + a.h - 4 + (k % 2), (k + anim) % 3 ? C.ember : C.fire[3])
      if (!bare && t < 12500) flame(pen, X + cx, Y + a.h - 4, 3, Math.round(1 + 2 * flick(anim, 1)), 0)
    }
    if (t < BURN.smoke) smoke(pen, X + cx, Y + a.h - 5, Math.max(1, Math.round(5 * thin)), 13, false, anim, thin * 0.8)
  }
}

/** The building as it stands at level `lv`; `roofGone` rows of roof burnt away, `wallGone` rows of wall fallen. */
function upright(pen: Pen, X: number, Y: number, a: Built, look: BuildLook, lv: number, roofGone: number, wallGone: number, big: boolean, props: boolean) {
  const pal = palOf(look.color, lv)
  draw(pen, a.found, X, Y, pal)
  draw(pen, a.wall, X, Y, pal, wallGone)
  if (lv >= 3) draw(pen, a.stone, X, Y, pal, Math.max(0, wallGone - (a.stone.y - a.wall.y)))
  if (wallGone === 0) {
    draw(pen, a.front, X, Y, pal)
    draw(pen, a.roof, X, Y, pal, roofGone)
  }
  if (roofGone > 0 && wallGone < 2) {
    // charred rafters where the roof has burnt away
    for (let j = 0; j < roofGone; j++) {
      const o = a.outline[j] ?? []
      const l = o[0]
      const r = o[o.length - 1]
      if (l !== undefined) pen.dot(X + a.roof.x + l, Y + a.roof.y + j, C.char)
      if (r !== undefined) pen.dot(X + a.roof.x + r, Y + a.roof.y + j, C.char)
    }
  }
  const rf = roofOf(look.color, lv >= 4)
  if (roofGone === 0) {
    if (big && a.chimney) chimney(pen, X, Y, a.chimney)
    const f = lv >= 3 ? a.towerFlag : a.flag
    if (big && f && look.fire < 4000) flag(pen, X, Y, f, rf, look.anim)
    if (lv >= 2) draw(pen, a.attic, X, Y, pal)
  }
  if (lv >= 3) draw(pen, a.tower, X, Y, pal, roofGone >= (big ? 5 : 3) ? (big ? 7 : 3) : 0)
  if (lv >= 2 && big) for (const [from, to] of a.fence) pickets(pen, X, Y, a, from, to)
  if (props && wallGone === 0) draw(pen, a.props, X, Y, pal)
  if (lv >= 5 && wallGone === 0) for (const [bx, by] of a.banners) paint(pen, big ? CU_BANNER : OV_BANNER, X + bx, Y + by, pal)
}

/** One of the building kinds in its footprint, through its first build, its levels, a fire and its ruins. */
function edifice(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook, a: Built) {
  const big = s === 1
  const t = look.fire
  const was = pen.layer
  pen.layer = OBJECT
  if (t >= BURN.ruins) {
    wreck(pen, X, Y, a, look, t, big)
    pen.layer = was
    return
  }
  const burning = t >= 0
  const lv = Math.max(1, look.level)
  const stage = stageOf(look)
  const within = stage === 'done' ? 1 : clamp((look.progress - STAGES[stage][0]) / (STAGES[stage][1] - STAGES[stage][0]))
  const work = look.building && !burning
  const anim = look.anim
  const caving = burning ? clamp((t - BURN.roofFalls) / (BURN.wallsFall - BURN.roofFalls)) : 0
  const falling = burning ? clamp((t - BURN.wallsFall) / (BURN.ruins - BURN.wallsFall)) : 0
  const step = burning ? Math.min(5, Math.floor(t / 1500)) : 0
  const roofRows = a.roof.rows.length
  const wallRows = a.wall.rows.length
  const roofGone = Math.round(caving * roofRows)
  const wallGone = Math.round(falling * Math.min(wallRows, big ? 6 : 3))
  const roofTop = a.roof.y
  let top = roofTop
  let windows = false
  const pal = palOf(look.color, 1)
  if (stage === 'done') {
    upright(pen, X, Y, a, look, lv, roofGone, wallGone, big, look.level >= 1)
    top = wallGone > 0 ? a.wall.y + wallGone : roofTop + roofGone
    windows = wallGone < 3
  } else {
    dig(pen, X, Y, a, stage === 'foundation' ? within : 1, stage === 'foundation' && !burning, big)
    if (stage === 'foundation') top = a.found.y - 3
    else if (stage === 'frame') {
      skeleton(pen, X, Y, a, within)
      top = within > 0.5 ? roofTop + roofRows - 1 - Math.round(clamp((within - 0.5) / 0.5) * (roofRows - 1)) : a.wall.y
    } else if (stage === 'walls') {
      skeleton(pen, X, Y, a, 1)
      const rows = within * wallRows
      const n = Math.floor(rows)
      draw(pen, a.wall, X, Y, pal, wallRows - n)
      if (n < wallRows) {
        // the row going up now, laid from the left
        const j = wallRows - 1 - n
        const row = a.wall.rows[j] ?? ''
        paint(pen, [row.slice(0, Math.floor((rows - n) * row.length))], X + a.wall.x, Y + a.wall.y + j, pal)
      }
      windows = within > 0.6
    } else {
      draw(pen, a.found, X, Y, pal)
      draw(pen, a.wall, X, Y, pal)
      draw(pen, a.front, X, Y, pal)
      skeleton(pen, X, Y, a, 1)
      const rows = within * roofRows
      const n = Math.floor(rows)
      draw(pen, a.roof, X, Y, pal, roofRows - n)
      if (n < roofRows) {
        const j = roofRows - 1 - n
        const row = a.roof.rows[j] ?? ''
        const o = a.outline[j] ?? []
        const l = o[0] ?? 0
        const r = o[o.length - 1] ?? 0
        paint(pen, [row.slice(0, l + Math.floor((rows - n) * (r - l + 1)))], X + a.roof.x, Y + roofTop + j, pal)
      }
      windows = true
    }
  }
  if (work) {
    if (stage !== 'foundation') rig(pen, X, Y, a, stage === 'done', big)
    if (big) paint(pen, PILE, X, Y + a.h - PILE.length, WALL)
    else paint(pen, OV_PILE, X, Y + a.h - OV_PILE.length, WALL)
  }
  char(pen, X, Y, a.w, a.h, step)
  if (stage === 'done' && !burning && big && a.chimney && roofGone === 0) {
    // a wisp from the chimney
    pen.layer = OVERLAY
    const k = anim % 8
    const cx = a.chimney[0] + 1
    const cy = a.chimney[1]
    pen.dot(X + cx + (k > 4 ? 1 : 0), Y + cy - 2 - (k >> 1), C.smoke[3])
    if (k > 1) pen.dot(X + cx + 1, Y + cy - 4 - (k >> 1), C.smoke[2])
    pen.layer = OBJECT
  }
  if (look.lit || burning) {
    if (stage === 'done') {
      shine(pen, a.wall, X, Y, t, anim, wallGone)
      if (wallGone === 0) (shine(pen, a.front, X, Y, t, anim), shine(pen, a.roof, X, Y, t, anim, roofGone))
      if (lv >= 2 && roofGone === 0) shine(pen, a.attic, X, Y, t, anim)
      if (lv >= 3) shine(pen, a.tower, X, Y, t, anim)
      if (look.level >= 1 && wallGone === 0 && !burning) shine(pen, a.props, X, Y, t, anim)
    } else if (stage === 'roof') shine(pen, a.wall, X, Y, t, anim)
  }
  if (burning) {
    const cx = X + Math.floor(a.w / 2)
    if (big) smoke(pen, cx, Y + top, Math.round(6 + 10 * clamp(t / 2500)), 22, true, anim, Math.min(1, 0.4 + t / 3000))
    else smoke(pen, cx, Y + top, Math.round(4 + 5 * clamp(t / 2500)), 11, false, anim, Math.min(1, 0.4 + t / 3000))
    blaze(pen, X, Y, a, t, anim, top, windows, big)
  }
  pen.layer = was
}

// ---- the building kinds, close-up (footprint coordinates; the door on the middle of the bottom edge)

const slim = (rows: Rows) => rows.map(r => r.slice(0, 3) + r.slice(4))

/** The cottage of the old plots, its door on the footprint's middle, its tower slimmed to fit. */
const CU_HOUSE: Spec = {
  w: 26, h: 28,
  found: pic(2, 25, CU_FOUND.rows), wall: pic(3, 14, COTTAGE.wall.rows), stone: pic(3, 21, COTTAGE.stone.rows), front: NONE,
  roof: pic(1, 5, COTTAGE.roof.rows), attic: pic(9, 6, CU_DORMER), tower: pic(0, 3, slim(CU_TOWER.rows)), props: NONE,
  banners: [[9, 15], [15, 15]], chimney: [18, 3, 10], flag: [9, 5], towerFlag: [2, 3],
  posts: [[3, 14], [22, 14], [10, 21], [15, 21]], plates: [[14, 3, 22], [21, 3, 10], [21, 15, 22]], kings: [12], back: 17,
  ladder: 0, pole: 24, rig: 12, planks: [13, 21], fence: [[0, 5], [20, 25]], fire: [3, 7, 12, 18, 22], panes: [[6, 17], [19, 17]], stump: 0,
}

/** The round tower house, a variant of the house. */
const CU_TOWERHOUSE: Spec = {
  w: 26, h: 28,
  found: pic(5, 25, TOWER.found.rows), wall: pic(6, 12, TW_WALL), stone: pic(6, 19, TOWER.stone.rows), front: NONE,
  roof: pic(3, 0, TOWER.roof.rows), attic: pic(10, 4, TOWER.attic.rows), tower: pic(0, 6, CU_TURRET.rows), props: NONE,
  banners: [[9, 19], [15, 19]], chimney: [16, 3, 8], flag: null, towerFlag: [2, 6],
  posts: [[6, 12], [19, 12], [10, 19], [15, 19]], plates: [[12, 6, 19], [18, 6, 19]], kings: [12], back: 17,
  ladder: 3, pole: 22, rig: 10, planks: [11, 21], fence: [[3, 7], [18, 22]], fire: [5, 8, 12, 17, 20], panes: [[12, 13]], stump: 0,
}

/** Two storeys of plaster between stone quoins, four tall windows upstairs, the door under a fanlight. */
const TH2_WALL = [
  'sppppppppppppppppppppppK',
  'sPWWWWPWWWWPPWWWWPWWWWPK',
  'ssWgGWPWgGWPPWgGWPWgGWSK',
  'ssWGGWPWGGWPPWGGWPWGGWSK',
  'sPWGGWPWGGWPPWGGWPWGGWPK',
  'sPWGGWPWGGWPPWGGWPWGGWPK',
  'sPssssPssssPPssssPssssPK',
  'ssPPPPPPPPPPPPPPPPPPPPSK',
  'SSSSSSSSSSSSSSSSSSSSSSSK',
  'sPWWWWPPPWWWWWWPPPWWWWPK',
  'ssWgGWPPPWgGGGWPPPWgGWSK',
  'ssWGGWPPPWDDDDWPPPWGGWSK',
  'sPWGGWPPPWDDDDWPPPWGGWPK',
  'sPWGGWPPPWDDkDWPPPWGGWPK',
  'sPssssPPPWDDDDWPPPssssPK',
  'ssPPPPPPPWDDDDWPPPPPPPSK',
] as const

const CU_TOWNHOUSE: Spec = {
  w: 30, h: 34,
  found: pic(2, 31, plinth(26, 11, 14)), wall: pic(3, 15, TH2_WALL), stone: pic(3, 23, stoned(TH2_WALL.slice(8))), front: NONE,
  roof: pic(1, 1, steep(13)), attic: pic(11, 6, CU_DORMER), tower: pic(25, 3, keep(5, 31)), props: NONE,
  banners: [[10, 24], [18, 24]], chimney: [21, 2, 9], flag: null, towerFlag: [27, 3],
  posts: [[3, 15], [26, 15], [12, 23], [17, 23]], plates: [[15, 3, 26], [23, 3, 26]], kings: [14], back: 22,
  ladder: 0, pole: 28, rig: 13, planks: [14, 23], fence: [[0, 5], [24, 29]], fire: [4, 9, 15, 21, 26], panes: [[7, 19], [22, 19]], stump: 0,
}

/** Goods out front: a crate of apples and a crate of oranges. */
const CRATE = (fruit: string) => ['.' + rep(fruit, 3) + '.', rep(fruit, 5), 'wwwww', 'BBBBB']

const CU_SHOP: Spec = {
  w: 28, h: 28,
  found: pic(3, 25, CU_FOUND.rows), wall: pic(4, 15, SH_WALL), stone: pic(4, 23, SHOP.stone.rows), front: pic(3, 15, SHOP.front.rows),
  roof: pic(2, 8, SHOP.roof.rows), attic: pic(10, 5, CU_DORMER), tower: pic(0, 3, CU_TOWER.rows),
  props: pic(5, 24, compose(18, 4, [[0, 0, CRATE('a')], [13, 0, CRATE('c')]])),
  banners: [[4, 18], [22, 18]], chimney: [20, 4, 9], flag: [6, 8], towerFlag: [2, 3],
  posts: [[4, 15], [23, 15], [11, 18], [16, 18]], plates: [[15, 4, 23], [18, 4, 11], [18, 16, 23]], kings: [13], back: 17,
  ladder: 1, pole: 25, rig: 13, planks: [14, 21], fence: [], fire: [4, 8, 13, 19, 23], panes: [[8, 18], [19, 18]], stump: 0,
}

/** The workshop's sign (a hammer in the builder's color) and a saw hung on the wall; a workbench out front. */
const WS_FRONT = compose(7, 9, [
  [1, 0, ['TTTTT', 'TbbbT', 'TbbbT', 'TPbPT', 'TPbPT', 'TTTTT']],
  [0, 7, ['wwIIIII', 'wwIIII.']],
])

const CU_WORKSHOP: Spec = {
  w: 30, h: 28,
  found: pic(3, 25, WORKSHOP.found.rows), wall: pic(4, 15, WS_WALL), stone: pic(4, 22, WORKSHOP.stone.rows), front: pic(19, 15, WS_FRONT),
  roof: pic(3, 9, WORKSHOP.roof.rows), attic: pic(13, 11, WORKSHOP.attic.rows), tower: pic(1, 3, CU_TOWER.rows),
  props: pic(26, 22, ['wwww', 'jIjd', 'BBBB', 'd..d', 'd..d', 'd..d']),
  banners: [[10, 16], [18, 16]], chimney: [22, 5, 13], flag: [14, 9], towerFlag: [3, 3],
  posts: [[4, 15], [25, 15], [11, 17], [18, 17]], plates: [[15, 4, 25], [21, 4, 11], [21, 18, 25]], kings: [14], back: 17,
  ladder: 1, pole: 26, rig: 13, planks: [14, 21], fence: [], fire: [5, 9, 14, 20, 24], panes: [[8, 18]], stump: 0,
}

// The tavern: a half-timbered upper floor over a bay window, a bench, a barrel and a lantern out front, its sign (a
// foaming mug) hanging from an iron bracket on the right.
/** A row of the tavern's upper floor: timber posts, three small windows, two braces. */
const tvUp = (win: string, l: string, r: string) => 'T' + win + 'T' + l + 'T' + win + 'T' + r + 'T' + win + 'T'
const TV_WALL = [
  rep('T', 24),
  tvUp('PPPP', 'PPP', 'PPP'),
  tvUp('PgGP', 'PPT', 'TPP'),
  tvUp('PGGP', 'PTP', 'PTP'),
  tvUp('PGGP', 'TPP', 'PPT'),
  tvUp('pppp', 'PPP', 'PPP'),
  tvUp('PPPP', 'PPP', 'PPP'),
  rep('d', 24),
  'TwwwwwwwwwwTTTTTTPwwwwPT',
  'TwgGwGGwGGwTDDDDTPwgGwPT',
  'TwGGwGGwGGwTDDDDTPwGGwPT',
  'TwGGwGGwGGwTDDkDTPwGGwPT',
  'TwwwwwwwwwwTDDDDTPwwwwPT',
  'TPPPPPPPPPPTDDDDTPPPPPPT',
  'TPPPPPPPPPPTDDDDTPPPPPPT',
] as const

/** The sign: an iron bracket, a chain, and hanging from it a mug of beer with its foam and handle. */
const TV_SIGN = ['IIIIII', '...j..', '..WWW.', '.WWWW.', '.kkUjj', '.kkU.j', '.kkUjj', '.kkU..', '.UUU..']
const TV_ORIEL = ['..R..', '..Rh.', '.LRh.', '.LRh.', 'LLRhh', 'eeeee', 'WPPpq', 'WGGpq', 'WGGpq', 'WPPpq', 'WPPpq', 'WGGpq', 'WGGpq', 'WPPpq', '.qpq.', '..q..']
const BARREL = ['.BB.', 'wBBd', 'jjjj', 'wBBd', 'wBBd', 'jjjj']

const CU_TAVERN: Spec = {
  w: 32, h: 30,
  found: pic(1, 27, plinth(26, 13, 16)), wall: pic(2, 12, TV_WALL), stone: pic(2, 20, stony(TV_WALL.slice(8))), front: pic(26, 13, TV_SIGN),
  roof: pic(0, 3, hip(12, 7)), attic: pic(10, 5, CU_DORMER), tower: pic(0, 4, TV_ORIEL),
  props: pic(3, 20, compose(21, 10, [[15, 0, ['j', 'o', 'j']], [1, 5, ['wwwwwww', 'BBBBBBB', 'd.....d', 'd.....d']], [17, 3, BARREL]])),
  banners: [[7, 13], [19, 13]], chimney: [5, 0, 7], flag: [16, 3], towerFlag: [2, 4],
  posts: [[2, 12], [25, 12], [13, 20], [18, 20]], plates: [[12, 2, 25], [19, 2, 25]], kings: [13], back: 20,
  ladder: 0, pole: 28, rig: 10, planks: [11, 20], fence: [], fire: [3, 8, 13, 19, 24], panes: [[7, 22], [21, 22], [13, 15]], stump: 0,
}

/** A lamp post: a lantern on a dark iron post. */
const LAMP_POST = ['.j.', 'joj', '.j.', '.j.', '.j.', '.j.', '.j.', '.j.', 'jjj']

// The town hall: a long hall under a hip roof, a clock tower rising from it, a portico of four columns under a
// pediment, broad steps.
const HL_FACE = [
  'sSSzzzzSSK',
  'sSzQQQQzSK',
  'szQQQiQQzK',
  'szQQQiQQzK',
  'szQQQiiQzK',
  'szQQQQQQzK',
  'sSzQQQQzSK',
  'sSSzzzzSSK',
]
const HL_WING_L = ['spppppppp', 'sPPWWWWPP', 'ssPWgGWPP', 'sPPWGGWPP', 'sPPWGGWPP', 'ssPWGGWPP', 'sPPWGGWPP', 'sPPssssPP', 'ssPPPPPPP', 'sPPPPPPPP']
const HL_WING_R = ['ppppppppK', 'PPWWWWPPK', 'PPWgGWPSK', 'PPWGGWPPK', 'PPWGGWPPK', 'PPWGGWPSK', 'PPWGGWPPK', 'PPssssPPK', 'PPPPPPPSK', 'PPPPPPPPK']
const HL_PORTICO = [
  'zzzzzzzzzzzzzzzzzz',
  'zzMMzzMMMMMMzzMMzz',
  'WpKKWpKKKKKKWpKKWp',
  'WpKKWpKWWWWKWpKKWp',
  'WpGGWpWgGGGWWpGGWp',
  'WpGGWpWDDDDWWpGGWp',
  'WpGGWpWDDDDWWpGGWp',
  'WpKKWpWDDkDWWpKKWp',
  'WpKKWpWDDDDWWpKKWp',
  'ssKKssWDDDDWssKKss',
]
const HL_WALL = compose(36, 25, [
  [13, 0, HL_FACE],
  [13, 8, ['sSSSSSSSSK', 'sSMSSSSMSK', 'sSSSSSSSSK', 'sSSSSMSSSK', 'sSSSSSSSSK', 'sSSSSSSSSK', 'sSSSSSSSSK']],
  [0, 15, HL_WING_L],
  [27, 15, HL_WING_R],
  [9, 15, HL_PORTICO],
])
const HL_PEDIMENT = ['........zzzz........', '......zzWWWWzz......', '....zzWWWWWWWWzz....', '..zzWWWWWZZWWWWWzz..', 'zzWWWWWWWWWWWWWWWWzz', 'SSSSSSSSSSSSSSSSSSSS']
const HL_ROOF = compose(38, 21, [
  [14, 0, steep(4)],
  [0, 13, hip(26, 5)],
  [9, 15, HL_PEDIMENT],
])

const CU_HALL: Spec = {
  w: 40, h: 36,
  found: pic(0, 32, [...plinth(38, 11, 26, 2).map(r => '.' + r + '.'), ...plinth(40, 12, 27, 2)]),
  wall: pic(2, 7, HL_WALL), stone: pic(2, 27, stony(HL_WALL.slice(20))), front: NONE,
  roof: pic(1, 2, HL_ROOF), attic: compose2(40, 36, [[8, 26, LAMP_POST], [29, 26, LAMP_POST]]),
  tower: compose2(40, 36, [[0, 9, keep(5, 23)], [35, 9, keep(5, 23)]]), props: NONE,
  banners: [[13, 23], [25, 23]], chimney: null, flag: [19, 2], towerFlag: [19, 2],
  posts: [[2, 22], [37, 22], [11, 22], [28, 22], [17, 26], [22, 26], [15, 7], [24, 7]], plates: [[22, 2, 37], [13, 15, 24]], kings: [19], back: 23,
  ladder: 0, pole: 39, rig: 19, planks: [20, 27], fence: [], fire: [4, 10, 16, 19, 23, 29, 35], panes: [[6, 25], [32, 25], [19, 27]], stump: 6,
}

/** A picture laid out on a whole footprint (for parts in several places). */
function compose2(w: number, h: number, parts: readonly (readonly [number, number, Rows])[]): Pic {
  const rows = compose(w, h, parts)
  let y0 = rows.findIndex(r => /[^.]/.test(r))
  if (y0 < 0) return NONE
  let y1 = rows.length - 1
  while (y1 > y0 && !/[^.]/.test(rows[y1] ?? '')) y1--
  return pic(0, y0, rows.slice(y0, y1 + 1))
}

// The school: a long schoolhouse in planks, white trim and tall windows, a canopy over the door, and on the ridge an
// open bell tower with its bell.
const SC_BELFRY = ['WWWWWWWW', 'WiiIIiiW', 'WiikkiiW', 'WikkkkiW', 'WikkkkiW', 'WkkkkkkW', 'WWWWWWWW', 'PPPPPPPP', 'PPPPPPPP']
/** A row of the school's side: corner boards, two windows a side and the middle `mid` (6). */
const scRow = (win: string, mid: string) => 'Www' + win + 'ww' + win + mid + win + 'ww' + win + 'wwW'
const SC_SIDE = [
  'W' + rep('B', 30) + 'W',
  scRow('WWWW', 'wwwwww'),
  scRow('WgGW', 'WWWWWW'),
  scRow('WGGW', 'WDDDDW'),
  scRow('WGGW', 'WDDDDW'),
  scRow('WGGW', 'WDDkDW'),
  scRow('WWWW', 'WDDDDW'),
  scRow('wwww', 'WDDDDW'),
]
const SC_WALL = compose(32, 20, [[12, 0, SC_BELFRY], [0, 12, SC_SIDE]])
const SC_PORCH = ['LRRRRRRRRh', 'eeeeeeeeee', '.W......W.', '.W......W.', '.W......W.', '.W......W.', '.W......W.']

const CU_SCHOOL: Spec = {
  w: 34, h: 30,
  found: pic(0, 27, plinth(34, 14, 19)), wall: pic(1, 7, SC_WALL), stone: pic(1, 24, stony(SC_SIDE.slice(5))), front: pic(12, 20, SC_PORCH),
  roof: pic(0, 2, compose(34, 17, [[12, 0, steep(4)], [0, 11, hip(24, 4)]])),
  attic: compose2(34, 30, [[3, 25, ['FFYYFF', 'dddddd']], [9, 25, ['YYFFYY', 'dddddd']], [19, 25, ['YYFFYY', 'dddddd']], [25, 25, ['FFYYFF', 'dddddd']]]),
  tower: compose2(34, 30, [[0, 9, keep(4, 21)], [30, 9, keep(4, 21)]]), props: NONE,
  banners: [[1, 15], [31, 15]], chimney: [25, 10, 15], flag: [16, 2], towerFlag: [16, 2],
  posts: [[1, 19], [32, 19], [14, 21], [19, 21], [13, 7], [20, 7]], plates: [[19, 1, 32], [14, 13, 20]], kings: [16], back: 19,
  ladder: 0, pole: 33, rig: 17, planks: [18, 23], fence: [], fire: [3, 9, 16, 24, 30], panes: [[5, 22], [11, 22], [21, 22], [27, 22]], stump: 0,
}

// The library: plaster between stone pilasters under a dome with a lantern, tall arched windows full of books,
// columns either side of an arched door with a lamp by it.
const LB_WINDOW = ['PPWWPP', 'PWGGWP', 'WgGGGW', 'W1325W', 'W1325W', 'WddddW', 'W4251W', 'W4251W', 'WddddW', 'W5314W', 'W5314W', 'WWWWWW']
const LB_DOOR = ['PPWWPP', 'PWGGWP', 'WgGGGW', 'WDDDDW', 'WDDDDW', 'WDDDDW', 'WDDkDW', 'WDDDDW', 'WDDDDW', 'WDDDDW']
const LB_WALL = compose(32, 15, [
  [0, 0, [rep('z', 32), '.' + rep('K', 30) + '.']],
  [1, 2, Array.from({ length: 13 }, (_, j) => 's' + rep('P', 28) + 'K')],
  [4, 2, LB_WINDOW],
  [22, 2, LB_WINDOW],
  [10, 1, ['zz', ...Array.from({ length: 12 }, () => 'Wp'), 'ss']],
  [20, 1, ['zz', ...Array.from({ length: 12 }, () => 'Wp'), 'ss']],
  [13, 5, LB_DOOR],
])

/** Books for sale outside: a little shelf of them on legs. */
const BOOK_CART = ['wwwww', 'w1325', 'wdddd', 'w4152', 'wwwww', 'd...d']

const CU_LIBRARY: Spec = {
  w: 32, h: 30,
  found: pic(0, 27, ['.' + rep('s', 30) + '.', ...plinth(32, 14, 17).slice(1)]), wall: pic(0, 12, LB_WALL), stone: pic(1, 22, stony(LB_WALL.slice(10).map(r => r.slice(1, 31)))), front: NONE,
  roof: pic(7, 0, compose(18, 12, [[7, 0, ['.Lh.', 'sGGK', 'ssKK']], [1, 3, dome(16, 8)], [0, 11, [rep('e', 18)]]])),
  attic: compose2(32, 30, [[1, 23, BOOK_CART], [26, 23, BOOK_CART]]),
  tower: compose2(32, 30, [[0, 8, keep(4, 19)], [28, 8, keep(4, 19)]]),
  props: pic(12, 17, compose(8, 3, [[0, 0, ['j', 'o', 'o']], [7, 0, ['j', 'o', 'o']]])),
  banners: [[1, 15], [29, 15]], chimney: null, flag: null, towerFlag: null,
  posts: [[1, 13], [30, 13], [10, 13], [21, 13], [13, 17], [18, 17]], plates: [[13, 1, 30]], kings: [15], back: 19,
  ladder: 0, pole: 31, rig: 11, planks: [12, 20], fence: [], fire: [3, 9, 15, 22, 28], panes: [[6, 16], [24, 16]], stump: 5,
}

// The watchtower: a stone shaft with slit windows and an arched door, corbelled out to a wooden lookout under a
// pyramid roof, a watch fire in it.
const TW2_BODY = Array.from({ length: 17 }, (_, j) => {
  if (j === 3 || j === 4 || j === 8 || j === 9) return 'sSSSGGSSSK'
  if (j % 3 === 1) return 'sSS' + (j % 2 ? 'MSS' : 'SSM') + 'SSSK'
  return 'sSSSSSSSSK'
})
const TW2_WALL = compose(16, 25, [
  [0, 0, ['.wiiiwiiiiwiiiw.', '.wiiiwiiiiwiiiw.', '.wiiiwiooiwiiiw.', 'wwwwwwwwwwwwwwww', 'BBBBBBBBBBBBBBBB', 'dddddddddddddddd']],
  [1, 6, ['zSSSSSSSSSSSSK', '.sSSSSSSSSSSK.']],
  [3, 8, TW2_BODY],
  [3, 19, ['sSSSzzSSSK', 'sSSzDDzSSK', 'sSzDDDDzSK', 'sSzDDDDzSK', 'sSzDDkDzSK', 'sSzDDDDzSK']],
])

const CU_TOWER2: Spec = {
  w: 16, h: 38,
  found: pic(2, 35, plinth(12, 4, 7)), wall: pic(0, 10, TW2_WALL), stone: NONE, front: NONE,
  roof: pic(0, 2, steep(7)), attic: pic(2, 13, ['bb...bb...bb', 'bb...bb...bb']),
  tower: pic(1, 22, Array.from({ length: 13 }, (_, j) => (j < 3 ? '.s..........K.' : 'sS..........SK'))), props: NONE,
  banners: [[4, 19], [10, 19]], chimney: null, flag: [7, 2], towerFlag: [7, 2],
  posts: [[3, 10], [12, 10], [6, 29], [9, 29]], plates: [[15, 1, 14], [10, 1, 14]], kings: [7], back: 29,
  ladder: 0, pole: 15, rig: 8, planks: [9, 16, 23, 30], fence: [], fire: [2, 5, 8, 11, 13], panes: [[7, 20], [4, 11], [11, 11]], stump: 18,
}

// The observatory: a whitewashed round drum under a great dome with a slot, its telescope looking out.
const OB_DRUM = Array.from({ length: 15 }, (_, j) => {
  if (j === 0) return rep('p', 15) + 'qqq'
  if (j >= 2 && j <= 4) return 'WPP' + (j === 2 ? 'gG' : 'GG') + 'PPPPPPPPPGpqq'
  if (j === 5) return 'WPPssPPPPPPPPPspqq'
  if (j === 8) return 'WPPPPPPzzzzPPPppqq'
  if (j >= 9) return 'WPPPPPz' + (j === 11 ? 'DDkD' : 'DDDD') + 'zPPppqq'
  return 'WPPPPPPPPPPPPPppqq'
})
const OB_DOME = dome(20, 10).map((r, j) => (j >= 1 ? r.slice(0, 10) + 'ii' + r.slice(12) : r))

const CU_OBSERVATORY: Spec = {
  w: 26, h: 34,
  found: pic(3, 31, plinth(20, 8, 11)), wall: pic(4, 15, [rep('z', 18), ...OB_DRUM.slice(0, 15)]), stone: pic(4, 25, stony(OB_DRUM.slice(9).map(r => r.replace(/W/g, 'P')))),
  front: NONE,
  roof: pic(2, 4, [...OB_DOME.map(r => '.' + r + '.'), rep('e', 22)]),
  attic: pic(20, 20, ['LLL...', 'LRRRh.', 'nnnnxx', 'eeeeee', 'PPPPq.', 'PgGPq.', 'PGGPq.', 'PPPPq.', 'PPPPq.', 'PPPPq.', 'SSSSK.']),
  tower: pic(0, 6, ['..k..', '.LRh.', 'LLRhh', 'LRRhh', 'eeeee', ...Array.from({ length: 19 }, (_, j) => (j % 6 === 2 || j % 6 === 3 ? 'WGGpq' : 'WPPpq')), 'KKKKK']),
  props: pic(13, 0, ['......kk', '.....IIk', '....IIj.', '...IIj..', '..IIj...', '.IIj....', 'IIj.....']),
  banners: [[6, 22], [18, 22]], chimney: null, flag: null, towerFlag: null,
  posts: [[4, 16], [21, 16], [10, 24], [15, 24]], plates: [[16, 4, 21]], kings: [12], back: 23,
  ladder: 0, pole: 24, rig: 14, planks: [15, 23], fence: [], fire: [5, 9, 13, 17, 21], panes: [[7, 19], [18, 19]], stump: 10,
}

// ---- the building kinds at overview (s = 0.5): the close-up simplified, the door on the middle of the bottom edge

/** A little stone tower `h` tall, 3 wide, for overview: a pyramid cap, slit windows. */
const ovKeep = (h: number) => ['.R.', 'LRh', 'eee', ...Array.from({ length: h - 4 }, (_, j) => (j % 4 === 1 ? 'sGK' : 'sSK')), 'KKK']
/** A tower 2 wide for overview. */
const ovPost = (h: number) => ['Lh', 'ee', ...Array.from({ length: h - 3 }, (_, j) => (j % 4 === 1 ? 'GK' : 'sK')), 'KK']

const OV_HOUSE: Spec = {
  w: 13, h: 14,
  found: pic(1, 12, OV_FOUND.rows), wall: pic(2, 8, OV_COTTAGE.wall.rows), stone: pic(2, 10, OV_COTTAGE.stone.rows), front: NONE,
  roof: pic(1, 3, OV_COTTAGE.roof.rows), attic: pic(6, 4, OV_COTTAGE.attic.rows), tower: pic(0, 1, OV_TOWER.rows), props: NONE,
  banners: [[5, 8], [8, 8]], chimney: null, flag: null, towerFlag: null,
  posts: [[2, 8], [11, 8], [5, 10], [8, 10]], plates: [[8, 2, 11]], kings: [6], back: 9,
  ladder: 0, pole: 12, rig: 5, planks: [8], fence: [], fire: [3, 6, 10], panes: [], stump: 0,
}

const OV_TOWERHOUSE2: Spec = {
  w: 13, h: 14,
  found: pic(3, 13, OV_TOWERHOUSE.found.rows), wall: pic(4, 6, OV_TOWERHOUSE.wall.rows), stone: pic(4, 10, OV_TOWERHOUSE.stone.rows), front: NONE,
  roof: pic(2, 0, OV_TOWERHOUSE.roof.rows), attic: pic(6, 2, OV_TOWERHOUSE.attic.rows), tower: pic(0, 3, OV_TOWERHOUSE.tower.rows), props: NONE,
  banners: [[5, 9], [8, 9]], chimney: null, flag: null, towerFlag: null,
  posts: [[4, 6], [9, 6], [5, 10], [8, 10]], plates: [[6, 4, 9], [9, 4, 9]], kings: [6], back: 9,
  ladder: 1, pole: 11, rig: 5, planks: [8], fence: [], fire: [4, 6, 9], panes: [], stump: 0,
}

const OV_TOWNHOUSE2: Spec = {
  w: 15, h: 17,
  found: pic(1, 15, ['ssssssssssssss', 'SSMSSSssSSSMSS']),
  wall: pic(2, 7, ['sppppppppppK', 'sPGPGPPGPGPK', 'sPGPGPPGPGPK', 'sPPPPPPPPPPK', 'SSSSSSSSSSSK', 'sPGPPDDPPGPK', 'sPGPPDDPPGPK', 'sPPPPDDPPPPK']),
  stone: pic(2, 12, ['SGSSDDSSGK', 'SGSSDDSSGK', 'MMMMDDMMMM'].map(r => 's' + r + 'K').map(r => r.slice(0, 12))),
  front: NONE, roof: pic(1, 0, steep(6)), attic: pic(7, 3, ['GG']), tower: pic(12, 1, ovKeep(16)), props: NONE,
  banners: [[5, 12], [10, 12]], chimney: null, flag: null, towerFlag: null,
  posts: [[2, 7], [13, 7], [6, 11], [9, 11]], plates: [[7, 2, 13], [11, 2, 13]], kings: [7], back: 11,
  ladder: 0, pole: 14, rig: 6, planks: [9], fence: [], fire: [3, 7, 12], panes: [], stump: 0,
}

const OV_SHOP2: Spec = {
  w: 14, h: 14,
  found: pic(1, 12, OV_FOUND.rows), wall: pic(2, 8, OV_SHOP.wall.rows), stone: pic(2, 11, OV_SHOP.stone.rows), front: pic(2, 8, OV_SHOP.front.rows),
  roof: pic(1, 4, OV_SHOP.roof.rows), attic: pic(6, 5, OV_SHOP.attic.rows), tower: pic(0, 1, OV_TOWER.rows), props: pic(2, 11, ['aa......cc']),
  banners: [[5, 9], [8, 9]], chimney: null, flag: null, towerFlag: null,
  posts: [[2, 8], [11, 8], [5, 10], [8, 10]], plates: [[8, 2, 11]], kings: [6], back: 9,
  ladder: 0, pole: 13, rig: 5, planks: [8], fence: [], fire: [3, 6, 10], panes: [], stump: 0,
}

const OV_WORKSHOP2: Spec = {
  w: 15, h: 14,
  found: pic(2, 12, OV_WORKSHOP.found.rows), wall: pic(3, 8, OV_WORKSHOP.wall.rows), stone: pic(3, 11, OV_WORKSHOP.stone.rows), front: pic(10, 8, ['TT', 'bb']),
  roof: pic(2, 4, OV_WORKSHOP.roof.rows), attic: pic(7, 5, OV_WORKSHOP.attic.rows), tower: pic(0, 1, OV_TOWER.rows), props: pic(13, 10, ['ww', 'dd']),
  banners: [[5, 8], [10, 8]], chimney: null, flag: null, towerFlag: null,
  posts: [[3, 8], [12, 8], [5, 9], [10, 9]], plates: [[8, 3, 12]], kings: [7], back: 9,
  ladder: 0, pole: 14, rig: 5, planks: [8], fence: [], fire: [4, 7, 11], panes: [], stump: 0,
}

const OV_TAVERN: Spec = {
  w: 16, h: 15,
  found: pic(0, 13, plinth(13, 7, 8, 2)),
  wall: pic(1, 6, ['TTTTTTTTTTT', 'TGPTPGPTPGT', 'TPPTPPPTPPT', 'ddddddddddd', 'TGGGGTDDTGT', 'TGGGGTDDTGT', 'TPPPPTDDTPT']),
  stone: pic(1, 10, stony(['TGGGGTDDTGT', 'TGGGGTDDTGT', 'TPPPPTDDTPT'])), front: pic(13, 7, ['III', '.j.', 'WW.', 'kUj', 'kU.']),
  roof: pic(0, 1, hip(5, 3)), attic: pic(5, 2, ['LRh', 'GGG']), tower: pic(0, 1, ['.R.', 'LRh', 'eee', 'WPq', 'WGq', 'WGq', 'WPq', '.q.']),
  props: pic(2, 12, ['wwww', 'd..d']),
  banners: [[3, 6], [8, 6]], chimney: null, flag: null, towerFlag: null,
  posts: [[1, 6], [11, 6], [6, 10], [9, 10]], plates: [[6, 1, 11], [9, 1, 11]], kings: [6], back: 10,
  ladder: 0, pole: 12, rig: 4, planks: [6], fence: [], fire: [2, 6, 10], panes: [], stump: 0,
}

const OV_HALL: Spec = {
  w: 20, h: 18,
  found: pic(0, 16, ['.' + rep('s', 18) + '.', 'SSSMSSSSssssSSSSMSSS']),
  wall: pic(1, 3, compose(18, 13, [
    [7, 0, ['sQiK', 'sQQK', 'sSSK', 'sSSK', 'sSSK']],
    [0, 8, ['sppp', 'sPGP', 'sPGP', 'sPPP', 'sPPP']],
    [14, 8, ['pppK', 'PGPK', 'PGPK', 'PPPK', 'PPPK']],
    [4, 9, ['WKKWDDWKKW', 'WKKWDDWKKW', 'WKKWDDWKKW', 'zKKzDDzKKz']],
  ])),
  stone: pic(1, 12, compose(18, 2, [[0, 0, ['SSSS', 'MMMM']], [14, 0, ['SSSS', 'MMMM']]])), front: NONE,
  roof: pic(1, 0, compose(18, 12, [[7, 0, ['.Lh.', 'LRhh', 'eeee']], [0, 7, hip(12, 2)], [4, 7, ['....zz....', '..zzWWzz..', 'zzWWWWWWzz', 'SSSSSSSSSS']]])),
  attic: compose2(20, 18, [[4, 12, ['o', 'j', 'j', 'j']], [15, 12, ['o', 'j', 'j', 'j']]]),
  tower: compose2(20, 18, [[0, 5, ovKeep(11)], [17, 5, ovKeep(11)]]), props: NONE,
  banners: [[6, 12], [13, 12]], chimney: null, flag: null, towerFlag: null,
  posts: [[1, 11], [18, 11], [5, 11], [14, 11], [8, 3], [11, 3]], plates: [[11, 1, 18]], kings: [9], back: 12,
  ladder: 0, pole: 19, rig: 9, planks: [11], fence: [], fire: [3, 7, 10, 13, 16], panes: [], stump: 3,
}

const OV_SCHOOL: Spec = {
  w: 17, h: 15,
  found: pic(1, 14, ['ssssssssssssssss']),
  wall: pic(2, 3, compose(14, 11, [[5, 0, ['WiiW', 'WkkW', 'WWWW', 'PPPP']], [0, 7, ['WBBBBBBBBBBBBW', 'WGwGwWDDWwGwGW', 'WGwGwWDDWwGwGW', 'WwwwwWDDWwwwwW']]])),
  stone: pic(2, 12, stony(['WGwGwWDDWwGwGW', 'WwwwwWDDWwwwwW'])), front: pic(7, 10, ['LRRh']),
  roof: pic(1, 0, compose(16, 10, [[5, 0, steep(2)], [0, 6, hip(10, 2)]])),
  attic: pic(3, 13, ['F.Y......Y.F']), tower: compose2(17, 15, [[1, 4, ovPost(10)], [15, 4, ovPost(10)]]), props: NONE,
  banners: [[1, 8], [16, 8]], chimney: null, flag: null, towerFlag: null,
  posts: [[2, 10], [15, 10], [7, 11], [10, 11], [7, 3], [10, 3]], plates: [[10, 2, 15]], kings: [8], back: 11,
  ladder: 0, pole: 16, rig: 8, planks: [10], fence: [], fire: [3, 8, 13], panes: [], stump: 0,
}

const OV_LIBRARY: Spec = {
  w: 16, h: 15,
  found: pic(0, 13, ['.' + rep('s', 14) + '.', 'SSSMSSSssSSSMSSS']),
  wall: pic(0, 6, [rep('z', 16), '.sWGGWsGGsWGGWK.', '.sW13WWDDWW24WK.', '.sW42WWDDWW15WK.', '.sWWWWWDDWWWWWK.', '.sPPPPWDDWPPPPK.', '.sPPPPWDDWPPPPK.']),
  stone: pic(1, 11, ['SSSSSWDDWSSSSS', 'MMMMMWDDWMMMMM'].map(r => r.slice(0, 14))), front: NONE,
  roof: pic(2, 0, compose(12, 6, [[1, 0, dome(10, 5)], [0, 5, [rep('e', 12)]]])),
  attic: compose2(16, 15, [[0, 10, ['13', '42', 'dd']], [14, 10, ['24', '51', 'dd']]]),
  tower: compose2(16, 15, [[0, 4, ovPost(9)], [14, 4, ovPost(9)]]), props: NONE,
  banners: [[1, 7], [14, 7]], chimney: null, flag: null, towerFlag: null,
  posts: [[1, 6], [14, 6], [6, 8], [9, 8]], plates: [[6, 1, 14]], kings: [7], back: 9,
  ladder: 0, pole: 15, rig: 5, planks: [7], fence: [], fire: [3, 7, 12], panes: [], stump: 3,
}

const OV_TOWER2: Spec = {
  w: 8, h: 19,
  found: pic(1, 17, ['ssssss', 'SSssSK']),
  wall: pic(0, 5, ['wiiooiiw', 'wwwwwwww', 'dddddddd', '.sSSSSK.', '..sSSK..', '..sSSK..', '..sGSK..', '..sSSK..', '..sSSK..', '..sGSK..', '..sDDK..', '..sDDK..']),
  stone: NONE, front: NONE, roof: pic(0, 1, steep(3)), attic: pic(1, 6, ['b....b']),
  tower: pic(1, 12, ['s....K', 's....K', 's....K', 's....K', 's....K']), props: NONE,
  banners: [[2, 9], [5, 9]], chimney: null, flag: null, towerFlag: null,
  posts: [[2, 5], [5, 5], [3, 15], [4, 15]], plates: [[7, 0, 7], [5, 0, 7]], kings: [3], back: 14,
  ladder: 0, pole: 7, rig: 3, planks: [5, 9, 13], fence: [], fire: [1, 4, 6], panes: [], stump: 7,
}

const OV_OBSERVATORY: Spec = {
  w: 13, h: 17,
  found: pic(2, 15, ['ssssssssss', 'SSMSssSMSS']),
  wall: pic(3, 8, ['zzzzzzzz', 'WPPPPPpq', 'WGPPPPpq', 'WPPPPPpq', 'WPPzzPpq', 'WPPDDPpq', 'WPPDDPpq']),
  stone: pic(3, 12, ['SSSzzSSK', 'SSSDDSSK', 'MMMDDMMM'].map((r, j) => (j === 0 ? '........' : r))),
  front: NONE, roof: pic(1, 2, [...dome(10, 5).map((r, j) => '.' + (j >= 1 ? r.slice(0, 6) + 'i' + r.slice(7) : r) + '.'), rep('e', 12)]),
  attic: pic(10, 10, ['LRh', 'eee', 'PGq', 'PPq', 'SSK']),
  tower: pic(0, 3, ['.R.', 'LRh', 'eee', 'WPq', 'WGq', 'WPq', 'WPq', 'WGq', 'WPq', 'WPq', 'WPq', 'KKK']),
  props: pic(7, 0, ['..Ik', '.Ij.', 'Ij..']),
  banners: [[4, 10], [9, 10]], chimney: null, flag: null, towerFlag: null,
  posts: [[3, 8], [10, 8], [5, 12], [8, 12]], plates: [[8, 3, 10]], kings: [6], back: 12,
  ladder: 0, pole: 12, rig: 6, planks: [8], fence: [], fire: [3, 6, 9], panes: [], stump: 5,
}

// ---- the statue: a figure on a plinth, carved inside its scaffolding

/** A monument at one scale: the plinth, its figures (one a style), and what each level adds. */
type Monument = {
  w: number
  h: number
  /** The plinth, stone letters, its top row the one the figure stands on. */
  plinth: Pic
  /** The figures by style: marble W p q (gold from level 4), the cape b, the torch's flame c k, iron j I. */
  figures: readonly Pic[]
  /** Level 2: a laurel on each figure's head (by style), flowers at the foot of the plinth. */
  wreaths: readonly Pic[]
  flowers: Pic
  /** Level 3: a grander plinth (over the plain one) and lamps either side. */
  grand: Pic
  lamps: Pic
  /** Level 5: where the banners hang (top-left). */
  banners: readonly (readonly [number, number])[]
  /** The rough block the figure is carved from: x, y, w, h. */
  block: readonly [number, number, number, number]
  /** Scaffolding: the poles' columns, the planks' rows. */
  poles: readonly [number, number]
  planks: readonly number[]
}

const MARBLE: Pal = { W: C.white, p: C.plasterShade, q: 0xb9ab92 }
const GILT: Pal = { W: C.gold, p: 0xd6a228, q: C.goldDark }

const CU_STATUE: Monument = {
  w: 14, h: 22,
  plinth: pic(0, 16, ['...zzzzzzzz...', '....sSSSSK....', '....sUUUSK....', '...zzzzzzzz...', '..ssssssssss..', '..SSSMSSSMSK..']),
  figures: [
    pic(2, 2, [
      '.ck.......',
      '.kk.......',
      '.jj.......',
      '.WW..WWp..',
      '.Wp..WWp..',
      '.Wp..Wpp..',
      '.WWWWWWWp.',
      '...WWWWpbh',
      '...WWWWpbh',
      '...WpWWpbh',
      '...WpWWpbh',
      '..WWpWWpbh',
      '..WWpWWppb',
      '.WWWpWWppq',
    ]),
    pic(2, 2, [
      '.......I..',
      '.......I..',
      '.......I..',
      '..WWp.jjj.',
      '..WWp..Wp.',
      '..Wpp..Wp.',
      '.WWWWWWWp.',
      'hbWWWWpq..',
      'hbWWWWpq..',
      'hbWpWWpq..',
      'hbWpWWpq..',
      'hbWpWWpqq.',
      'bWWpWWppq.',
      'WWWpWWppq.',
    ]),
  ],
  wreaths: [pic(7, 4, ['VlV']), pic(4, 4, ['VlV'])],
  flowers: pic(0, 19, ['FY..........YF', 'll..........ll']),
  grand: pic(0, 14, ['..zzzzzzzzzz..', '...sSSSSSSK...', '...sSUUUUSK...', '...sSSSSSSK...', '..zzzzzzzzzz..', '..SSSSSSSSSK..', '.ssssssssssss.', 'SSSSMSSSSMSSSK']),
  lamps: pic(0, 14, ['j............j', 'o............o', ...Array.from({ length: 5 }, () => 'j............j')]),
  banners: [[0, 4], [12, 4]],
  block: [2, 2, 10, 14],
  poles: [1, 12],
  planks: [6, 11],
}

const OV_STATUE: Monument = {
  w: 7, h: 11,
  plinth: pic(0, 8, ['.zzzzz.', '..sUK..', '.sssss.']),
  figures: [
    pic(1, 1, ['k....', 'W.Wp.', 'WWWWp', '.WWpb', '.WWpb', '.WWpb', 'WWWpp']),
    pic(1, 1, ['....I', '.Wp.W', 'WWWWp', 'bWWp.', 'bWWp.', 'bWWp.', 'WWWpp']),
  ],
  wreaths: [pic(3, 2, ['V']), pic(2, 2, ['V'])],
  flowers: pic(0, 10, ['F.....F']),
  grand: pic(0, 7, ['.zzzzz.', '..sUK..', '.zzzzz.', 'SSSSSSK']),
  lamps: pic(0, 7, ['o.....o', 'j.....j', 'j.....j', 'j.....j']),
  banners: [[0, 3], [6, 3]],
  block: [1, 1, 5, 7],
  poles: [0, 6],
  planks: [3],
}

/** The statue through its first build (footing, plinth, block, carving), its levels, a fire and its ruins. */
function monument(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook) {
  const big = s === 1
  const m = big ? CU_STATUE : OV_STATUE
  const n = Math.abs(Math.floor(look.style)) % m.figures.length
  const raise = look.level >= 3 ? m.plinth.y - m.grand.y : 0
  const fig0 = m.figures[n] ?? NONE
  const fig = pic(fig0.x, fig0.y - raise, fig0.rows)
  const t = look.fire
  const was = pen.layer
  pen.layer = OBJECT
  const lv = Math.max(1, look.level)
  const pal = palOf(look.color, lv)
  const stone = { ...pal, ...(lv >= 4 ? GILT : MARBLE) }
  const anim = look.anim
  const [bx, by0, bw, bh] = m.block
  const by = by0 - raise
  const pTop = m.plinth.y
  const burning = t >= 0
  if (t >= BURN.ruins) {
    // the plinth stands broken and sooty, the figure lies in pieces at its foot
    const base = look.level >= 3 ? m.grand : m.plinth
    draw(pen, base, X, Y, WRECK, big ? 2 : 1)
    if (big) paint(pen, ['.WWq...Wq..', 'qWpWq.WWpWq'], X + 1, Y + m.h - 4, { ...WRECK, W: C.rock, p: C.rockDark, q: C.char })
    else paint(pen, ['WqWW'], X + 1, Y + m.h - 2, { ...WRECK, W: C.rock, q: C.char })
    const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
    if (t < BURN.embers && (anim % 4)) pen.glow(X + Math.floor(m.w / 2), Y + m.h - 2, C.ember)
    if (t < BURN.smoke) smoke(pen, X + Math.floor(m.w / 2), Y + pTop, Math.max(1, Math.round((big ? 5 : 3) * thin)), big ? 18 : 9, big, anim, thin * 0.7)
    pen.layer = was
    return
  }
  const stage = stageOf(look)
  const within = stage === 'done' ? 1 : clamp((look.progress - STAGES[stage][0]) / (STAGES[stage][1] - STAGES[stage][0]))
  const prow = m.plinth.rows.length
  if (stage === 'foundation') {
    // the bottom step laid stone by stone, pegged out with a string
    const r = m.plinth.rows[prow - 1] ?? ''
    paint(pen, [r.slice(0, Math.round(within * r.length))], X + m.plinth.x, Y + m.h - 1, pal)
    if (!burning) {
      pen.layer = OVERLAY
      for (let c = 0; c < m.w; c++) if (c >= Math.round(within * m.w)) pen.dot(X + c, Y + m.h - 2, C.paper)
      pen.layer = OBJECT
    }
    for (const c of [0, m.w - 1]) pen.dot(X + c, Y + m.h - 2, C.woodLight)
  } else if (stage === 'frame') {
    // the plinth rising course by course
    const k = Math.max(1, Math.round(within * prow))
    draw(pen, m.plinth, X, Y, pal, prow - k)
  } else {
    if (look.level >= 3) draw(pen, m.grand, X, Y, pal)
    else draw(pen, m.plinth, X, Y, pal)
    if (look.level >= 2) draw(pen, m.flowers, X, Y, pal)
    // the figure: the block hoisted course by course, then carved from the top down
    const carved = stage === 'walls' ? 0 : stage === 'roof' ? Math.round(within * bh) : bh
    const stacked = stage === 'walls' ? Math.max(1, Math.round(within * bh)) : bh
    const caving = burning ? clamp((t - BURN.roofFalls) / (BURN.ruins - BURN.roofFalls)) : 0
    const fallen = Math.round(caving * bh)
    for (let j = Math.max(bh - stacked, fallen); j < bh; j++) {
      if (j < carved) paint(pen, [fig.rows[j] ?? ''], X + fig.x, Y + fig.y + j, stone)
      else for (let i = 0; i < bw; i++) pen.dot(X + bx + i, Y + by + j, i === 0 ? C.white : i === bw - 1 ? 0xb9ab92 : C.plasterShade)
    }
    if (stage === 'roof' && !burning && carved < bh) {
      // chips flying off where the chisel is
      pen.layer = OVERLAY
      const cy = Y + by + carved
      for (let k = 0; k < 3; k++) pen.dot(X + bx + ((anim * 3 + k * 5) % (bw + 2)) - 1, cy - 1 - ((anim + k) % 2), C.white)
      pen.layer = OBJECT
    }
    const wr = m.wreaths[n] ?? NONE
    if (look.level >= 2 && fallen === 0) draw(pen, pic(wr.x, wr.y - raise, wr.rows), X, Y, pal)
    if (look.level >= 3) draw(pen, m.lamps, X, Y, pal)
    if (look.level >= 5) {
      for (const [x, y] of m.banners) {
        for (let r = y - 1; r < m.lamps.y; r++) pen.dot(X + x + (big && x ? 1 : 0), Y + r, C.ironDark)
        paint(pen, big ? CU_BANNER : OV_BANNER, X + x, Y + y, pal)
      }
    }
    if ((look.lit || burning) && look.level >= 3) shine(pen, m.lamps, X, Y, t, anim)
    if (look.lit && !burning && fallen === 0 && carved > 0) {
      // the torch's flame burns on at night
      fig.rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === 'c' || (r[i] === 'k' && j < 2)) pen.glow(X + fig.x + i, Y + fig.y + j, (i + j + anim) % 3 ? C.fire[1] : C.fire[0]) })
    }
  }
  if (look.building && !burning && stage !== 'foundation') {
    // poles either side, planks across the front
    const top = stage === 'frame' ? pTop + prow - Math.round(within * prow) - 2 : by
    for (const c of m.poles) for (let r = Math.max(0, top - 1); r < m.h; r++) pen.dot(X + c, Y + r, C.wood)
    for (const r of m.planks) if (r >= top) for (let c = m.poles[0]; c <= m.poles[1]; c++) (pen.dot(X + c, Y + r, C.woodLight), big && pen.dot(X + c, Y + r + 1, C.woodDark))
  }
  if (burning) {
    const step = Math.min(5, Math.floor(t / 1500))
    char(pen, X, Y, m.w, m.h, step)
    const k = fierce(t)
    const cx = X + Math.floor(m.w / 2)
    smoke(pen, cx, Y + by, Math.round((big ? 5 : 3) + 5 * clamp(t / 2500)), big ? 20 : 10, big, anim, Math.min(1, 0.4 + t / 3000))
    if (big) for (let i = 0; i < 3; i++) flame(pen, X + 3 + i * 4, Y + pTop + 1, i === 1 ? 5 : 3, Math.round((5 + 6 * flick(anim, i)) * k), Math.round(Math.sin(anim * 0.9 + i)))
    else flame(pen, cx, Y + pTop + 1, 3, Math.round((3 + 3 * flick(anim, 1)) * k), 0)
    embers(pen, cx, Y + by, m.w, big ? 6 : 3, big ? 14 : 7, anim)
  }
  pen.layer = was
}

// ---- the garden: hedges round a lawn, flower beds either side of a gravel path to a little gazebo

/** A garden at one scale. */
type Grounds = {
  w: number
  h: number
  /** The mown lawn inside the hedges, and the gravel path from the gate to the gazebo: x, y, w, h. */
  lawn: readonly [number, number, number, number]
  path: readonly [number, number, number, number]
  /** The hedges (leaf letters), the gate posts. */
  hedges: Pic
  posts: Pic
  /** The beds in bloom, and where each bed lies (x, y, w, h) for digging and planting. */
  beds: Pic
  plots: readonly (readonly [number, number, number, number])[]
  /** The gazebo, and another with a domed roof (odd styles); their first `roof` rows are the roof. */
  gazebo: Pic
  domed: Pic
  roof: number
  /** Level 2: a fountain on the path; 3: stone edging and topiary; 5: banners on poles (pole column, banner top-left). */
  fountain: Pic
  edging: Pic
  topiary: Pic
  banners: readonly (readonly [number, number, number])[]
  /** Where flames rise. */
  fire: readonly number[]
}

/** A bed of flowers `w` wide and `h` tall: clumps of two by two in rows, leaves between, one flower in the builder's color. */
function bed(w: number, h: number, flip: boolean, big: boolean): string[] {
  const kinds = flip ? ['b', 'Y', 'F', 'y'] : ['F', 'y', 'b', 'Y']
  const rows: string[] = []
  for (let j = 0; j < h; j++) {
    let r = ''
    for (let i = 0; i < w; i++) {
      if (!big) r += kinds[(j + Math.floor(i / 2)) % 4] ?? 'l'
      else if (j % 3 === 0 || i % 3 === 0) r += 'l'
      else r += kinds[(Math.floor(i / 3) + Math.floor(j / 3)) % 4] ?? 'l'
    }
    rows.push(r)
  }
  return rows
}

const GD_HEDGE_CU = compose(32, 24, [
  [0, 8, ['VVVVVVVVVV', 'llllllllll', 'vvvvvvvvvv']],
  [22, 8, ['VVVVVVVVVV', 'llllllllll', 'vvvvvvvvvv']],
  [0, 11, Array.from({ length: 9 }, () => 'Vl')],
  [30, 11, Array.from({ length: 9 }, () => 'lv')],
  [0, 20, ['VVVVVVVVVVVVV', 'lllllllllllll', 'lllllllllllll', 'vvvvvvvvvvvvv']],
  [19, 20, ['VVVVVVVVVVVVV', 'lllllllllllll', 'lllllllllllll', 'vvvvvvvvvvvvv']],
])

const CU_GARDEN: Grounds = {
  w: 32, h: 24,
  lawn: [2, 11, 28, 9], path: [14, 11, 4, 13],
  hedges: pic(0, 0, GD_HEDGE_CU),
  posts: pic(13, 18, ['z....z', 's....s', 's....s', 's....s', 's....s', 'K....K']),
  beds: compose2(32, 24, [[3, 12, bed(10, 6, false, true)], [19, 12, bed(10, 6, true, true)]]),
  plots: [[3, 12, 10, 6], [19, 12, 10, 6]],
  gazebo: pic(10, 0, [
    '.....zz.....',
    '....LRhh....',
    '...LLRRhh...',
    '..LLLRRhhh..',
    '.LLLRRRRhhh.',
    'eeeeeeeeeeee',
    '.WvvvWWvvvW.',
    '.WvvvWWvvvW.',
    '.WvvvWWvvvW.',
    '.WlllWWlllW.',
    'ssssssssssss',
    'SSSSsssSSSSS',
  ]),
  domed: pic(10, 0, ['.....zz.....', '...LLRRhh...', '..LLRRRRhh..', '.LLLRRRRhhh.', '.LLLRRRRhhh.', 'eeeeeeeeeeee', '.WvvvWWvvvW.', '.WvvvWWvvvW.', '.WvvvWWvvvW.', '.WlllWWlllW.', 'ssssssssssss', 'SSSSsssSSSSS']),
  roof: 6,
  fountain: pic(13, 14, ['ssssss', 'sAEEAs', 'sAAAAs', 'SSSSSS']),
  edging: compose2(32, 24, [[2, 11, ['s' + rep('s', 10) + 's', ...Array.from({ length: 6 }, () => 's..........s'), 'S' + rep('S', 10) + 'S']], [18, 11, ['s' + rep('s', 10) + 's', ...Array.from({ length: 6 }, () => 's..........s'), 'S' + rep('S', 10) + 'S']]]),
  topiary: compose2(32, 24, [[5, 2, ['.VV.', 'VVll', 'Vllv', '.lv.', '.t..', '.t..', 'ssss']], [23, 2, ['.VV.', 'VVll', 'Vllv', '.lv.', '..t.', '..t.', 'ssss']]]),
  banners: [[0, 1, 0], [31, 29, 0]],
  fire: [3, 9, 15, 22, 28],
}

const OV_GARDEN: Grounds = {
  w: 16, h: 12,
  lawn: [1, 6, 14, 3], path: [7, 6, 2, 6],
  hedges: pic(0, 0, compose(16, 12, [[0, 4, ['VVVVV', 'vvvvv']], [11, 4, ['VVVVV', 'vvvvv']], [0, 6, ['V', 'V', 'V']], [15, 6, ['v', 'v', 'v']], [0, 9, ['VVVVVV', 'llllll', 'vvvvvv']], [10, 9, ['VVVVVV', 'llllll', 'vvvvvv']]])),
  posts: pic(6, 9, ['z..z', 's..s', 'K..K']),
  beds: compose2(16, 12, [[2, 6, ['FFyy', 'bbYY']], [10, 6, ['YYbb', 'yyFF']]]),
  plots: [[2, 6, 4, 2], [10, 6, 4, 2]],
  gazebo: pic(4, 0, ['...zz...', '..LRhh..', '.LLRhhh.', 'eeeeeeee', '.WvvvvW.', 'ssssssss']),
  domed: pic(4, 0, ['...zz...', '.LLRRhh.', '.LLRRhh.', 'eeeeeeee', '.WvvvvW.', 'ssssssss']),
  roof: 4,
  fountain: pic(6, 7, ['sAAs', 'SSSS']),
  edging: compose2(16, 12, [[1, 5, ['ssssss', 's....s', 's....s', 'SSSSSS']], [9, 5, ['ssssss', 's....s', 's....s', 'SSSSSS']]]),
  topiary: compose2(16, 12, [[1, 1, ['VV', 'lv', '.t']], [13, 1, ['VV', 'lv', 't.']]]),
  banners: [[0, 0, 0], [15, 15, 0]],
  fire: [2, 8, 13],
}

/** The garden through its first build (marked out, dug, planted, furnished), its levels, a fire and its ruins. */
function grounds(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook) {
  const big = s === 1
  const g = big ? CU_GARDEN : OV_GARDEN
  const t = look.fire
  const was = pen.layer
  const lv = Math.max(1, look.level)
  const pal = palOf(look.color, lv)
  const anim = look.anim
  const stage = stageOf(look)
  const within = stage === 'done' ? 1 : clamp((look.progress - STAGES[stage][0]) / (STAGES[stage][1] - STAGES[stage][0]))
  const burning = t >= 0
  const ruined = t >= BURN.ruins
  const at = (k: Stage) => ['foundation', 'frame', 'walls', 'roof', 'done'].indexOf(stage) > ['foundation', 'frame', 'walls', 'roof', 'done'].indexOf(k)
  const [lx, ly, lw, lh] = g.lawn
  const [px, py, pw, ph] = g.path
  // the ground: mown lawn once the beds are dug, the path dug and then gravelled from the gate up
  pen.layer = GROUND
  if (at('foundation') || ruined) pen.rect(X + lx, Y + ly, lw, lh, ruined ? 0x4a6a34 : MOWN)
  const dug = stage === 'foundation' ? Math.round(within * ph) : ph
  pen.rect(X + px, Y + py + ph - dug, pw, dug, C.roadEdge)
  const gravel = stage === 'foundation' ? 0 : stage === 'frame' ? Math.round(within * ph) : ph
  pen.rect(X + px, Y + py + ph - gravel, pw, gravel, ruined ? C.roadEdge : C.sand)
  pen.layer = OBJECT
  if (ruined) {
    // charred stubs of the hedges, ash in the beds, the gazebo's floor and two black posts
    // a hedge burns down to its lowest row, left in black stubs
    const hr = g.hedges.rows
    hr.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) {
        const below = (hr[j + 1] ?? '')[i]
        if (r[i] !== '.' && (below === undefined || below === '.') && (i + j) % 5 !== 2) pen.dot(X + g.hedges.x + i, Y + g.hedges.y + j, i % 4 === 1 ? C.ash : C.char)
      }
    })
    for (const [bx, by, bw, bh] of g.plots) (pen.rect(X + bx, Y + by, bw, bh, C.trunk), pen.rect(X + bx, Y + by, bw, 1, C.ash))
    const gr = g.gazebo.rows.length
    paint(pen, g.gazebo.rows.slice(gr - 2), X + g.gazebo.x, Y + g.gazebo.y + gr - 2, WRECK)
    paint(pen, g.posts.rows, X + g.posts.x, Y + g.posts.y, WRECK)
    const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
    const left = 1 - (t - BURN.ruins) / (BURN.embers - BURN.ruins)
    if (t < BURN.embers) for (let k = 0; k < Math.round((big ? 8 : 4) * left); k++) if ((anim + k) % 4) pen.glow(X + 2 + ((k * 7) % (g.w - 4)), Y + g.h - (big ? 4 : 2) - (k % 2) * (big ? 9 : 4), (k + anim) % 3 ? C.ember : C.fire[3])
    if (t < BURN.smoke) smoke(pen, X + Math.floor(g.w / 2), Y + Math.floor(g.h / 2), Math.max(1, Math.round((big ? 7 : 4) * thin)), big ? 22 : 11, big, anim, thin * 0.8)
    pen.layer = was
    return
  }
  // the beds: dug, sown in rows, in bloom
  const bloom = stage === 'done' ? 1 : stage === 'roof' ? within : 0
  for (const [bx, by, bw, bh] of g.plots) {
    if (stage === 'foundation') continue
    const open = stage === 'frame' ? Math.round(within * bh) : bh
    for (let j = 0; j < open; j++) {
      const flowering = (j + 1) / bh <= bloom
      for (let i = 0; i < bw; i++) {
        if (flowering) {
          const ch = (g.beds.rows[by + j - g.beds.y] ?? '')[bx + i - g.beds.x] ?? 'l'
          pen.dot(X + bx + i, Y + by + j, pal[ch] ?? C.leaf)
        } else pen.dot(X + bx + i, Y + by + j, at('frame') && j % 2 === 1 ? C.leaf : C.trunkDark)
      }
    }
  }
  // the hedges: planted low, then grown
  if (at('frame')) {
    const grown = stage === 'walls' ? within : 1
    const hp = g.hedges
    const rows = hp.rows.length
    for (let j = 0; j < rows; j++) {
      const r = hp.rows[j] ?? ''
      for (let i = 0; i < r.length; i++) {
        const ch = r[i]
        if (ch === undefined || ch === '.') continue
        // a hedge pixel shows once the hedge has grown past it (measured from the hedge's own bottom)
        let base = j
        while (base + 1 < rows && ((hp.rows[base + 1] ?? '')[i] ?? '.') !== '.' && base - j < 4) base++
        const tall = base - j + 1
        const top = (hp.rows[j - 1] ?? '')[i]
        const first = top === undefined || top === '.'
        if (grown < 1 && tall > Math.max(1, Math.round(grown * 4))) continue
        pen.dot(X + hp.x + i, Y + hp.y + j, grown < 1 && first ? C.leafLight : pal[ch] ?? C.leaf)
      }
    }
    draw(pen, g.posts, X, Y, pal)
  }
  if (look.level >= 2) draw(pen, g.fountain, X, Y, pal)
  if (look.level >= 3) (draw(pen, g.edging, X, Y, pal), draw(pen, g.topiary, X, Y, pal))
  // the gazebo: its posts rise, then its roof goes on from the eave up
  const gz = look.style % 2 ? g.domed : g.gazebo
  const gr = gz.rows.length
  const caving = burning ? clamp((t - BURN.roofFalls) / (BURN.wallsFall - BURN.roofFalls)) : 0
  const falling = burning ? clamp((t - BURN.wallsFall) / (BURN.ruins - BURN.wallsFall)) : 0
  if (stage === 'roof' || stage === 'done') {
    const postsUp = stage === 'roof' ? clamp(within / 0.4) : 1
    const roofOn = stage === 'roof' ? clamp((within - 0.4) / 0.6) : 1
    const body = gr - g.roof
    const up = Math.round(postsUp * body)
    const fell = Math.round(falling * body)
    draw(pen, gz, X, Y, pal, Math.max(gr - up, g.roof + fell))
    const rr = Math.round(roofOn * g.roof)
    const gone = Math.round(caving * g.roof)
    draw(pen, gz, X, Y, pal, Math.max(g.roof - rr, gone), g.roof)
  }
  if (look.level >= 5) {
    for (const [pc, bx2, by2] of g.banners) {
      for (let r = 0; r < (big ? 9 : 4); r++) pen.dot(X + pc, Y + r, C.woodLight)
      paint(pen, big ? CU_BANNER : OV_BANNER, X + bx2, Y + by2 + 1, pal)
    }
  }
  if (look.building && !burning && stage !== 'done') {
    // a barrow of soil and a sack of seed by the gate
    paint(pen, big ? ['.OO.', 'OOOO', 'wwww', 'd..d'] : ['OO', 'ww'], X, Y + g.h - (big ? 4 : 2), { ...WALL, ...EXTRA })
  }
  if (stage === 'foundation') {
    // pegs at the corners, a string round the plot
    for (const [c, r] of [[0, ly - 3], [g.w - 1, ly - 3], [0, g.h - 1], [g.w - 1, g.h - 1]] as const) pen.dot(X + c, Y + r, C.woodLight)
    if (!burning) {
      pen.layer = OVERLAY
      for (let c = 1; c < g.w - 1; c++) pen.dot(X + c, Y + ly - 3, C.paper)
      for (let r = ly - 2; r < g.h - 1; r++) (pen.dot(X, Y + r, C.paper), pen.dot(X + g.w - 1, Y + r, C.paper))
      pen.layer = OBJECT
    }
  }
  if (stage === 'done' && look.level >= 2 && !burning) {
    // the fountain's spray rising and falling
    pen.layer = OVERLAY
    const fx = X + g.fountain.x + Math.floor((g.fountain.rows[0] ?? '').length / 2) - 1
    const h = 1 + (anim % 3)
    if (big) for (let k = 0; k < h; k++) (pen.dot(fx, Y + g.fountain.y - k, C.waterLight), pen.dot(fx + 1, Y + g.fountain.y - k, C.waterLight))
    else if (anim % 2) pen.dot(fx + 1, Y + g.fountain.y - 1, C.waterLight)
    pen.layer = OBJECT
  }
  if ((look.lit || burning) && (stage === 'done')) {
    // a lantern in the gazebo
    const lx2 = X + gz.x + Math.floor((gz.rows[0] ?? '').length / 2)
    if (!burning) (pen.glow(lx2 - 1, Y + gz.y + g.roof, C.lit), pen.glow(lx2, Y + gz.y + g.roof, C.lit))
  }
  if (burning) {
    char(pen, X, Y, g.w, g.h, Math.min(5, Math.floor(t / 1500)))
    const k = fierce(t)
    g.fire.forEach((cx, i) => {
      const onGazebo = cx > gz.x && cx < gz.x + (gz.rows[0] ?? '').length
      const base = onGazebo ? gz.y + Math.round(caving * g.roof) + (big ? 3 : 2) : big ? (i % 2 ? 22 : 10) : i % 2 ? 11 : 5
      if (t < 1500 && i !== Math.floor(g.fire.length / 2)) return
      flame(pen, X + cx, Y + base, big ? 5 : 3, Math.round((big ? 5 + 6 * flick(anim, i) : 2 + 3 * flick(anim, i)) * k), Math.round(Math.sin(anim * 0.9 + i)))
    })
    smoke(pen, X + Math.floor(g.w / 2), Y + gz.y + (big ? 2 : 1), Math.round((big ? 6 : 4) + 6 * clamp(t / 2500)), big ? 22 : 11, big, anim, Math.min(1, 0.4 + t / 3000))
    embers(pen, X + Math.floor(g.w / 2), Y + gz.y, g.w, big ? 8 : 4, big ? 16 : 8, anim)
  }
  pen.layer = was
}

/** A picture with some letters swapped. */
const swap = (p: Pic, map: Readonly<Record<string, string>>) => pic(p.x, p.y, p.rows.map(r => [...r].map(ch => map[ch] ?? ch).join('')))
/** A cheap variant: the walls (and what else is named) of another material. */
const tint = (s: Spec, map: Readonly<Record<string, string>>, more: Partial<Spec> = {}): Spec => ({ ...s, wall: swap(s.wall, map), ...more })

const TAN = { P: 'w', p: 'B' } as const
const CREAM = { w: 'P', B: 'p' } as const

/** Every building kind's art, close-up and overview, by `look.style` modulo the count. */
const TOWN_ART: Partial<Record<Kind, readonly { cu: Built; ov: Built }[]>> = {
  house: [{ cu: prep(CU_HOUSE), ov: prep(OV_HOUSE) }, { cu: prep(CU_TOWERHOUSE), ov: prep(OV_TOWERHOUSE2) }],
  townhouse: [
    { cu: prep(CU_TOWNHOUSE), ov: prep(OV_TOWNHOUSE2) },
    { cu: prep(tint(CU_TOWNHOUSE, TAN)), ov: prep(tint(OV_TOWNHOUSE2, TAN)) },
  ],
  shop: [
    { cu: prep(CU_SHOP), ov: prep(OV_SHOP2) },
    { cu: prep(tint(CU_SHOP, CREAM, { roof: pic(2, 8, hip(12, 5)) })), ov: prep(tint(OV_SHOP2, CREAM, { roof: pic(1, 4, hip(6, 2)) })) },
  ],
  workshop: [{ cu: prep(CU_WORKSHOP), ov: prep(OV_WORKSHOP2) }, { cu: prep(tint(CU_WORKSHOP, CREAM)), ov: prep(tint(OV_WORKSHOP2, CREAM)) }],
  tavern: [{ cu: prep(CU_TAVERN), ov: prep(OV_TAVERN) }, { cu: prep(tint(CU_TAVERN, TAN)), ov: prep(tint(OV_TAVERN, TAN)) }],
  hall: [
    { cu: prep(CU_HALL), ov: prep(OV_HALL) },
    { cu: prep({ ...CU_HALL, roof: pic(1, 2, compose(38, 21, [[14, 0, [...dome(10, 4), rep('e', 10)]], [0, 13, hip(26, 5)], [9, 15, HL_PEDIMENT]])) }), ov: prep(OV_HALL) },
  ],
  school: [{ cu: prep(CU_SCHOOL), ov: prep(OV_SCHOOL) }, { cu: prep(tint(CU_SCHOOL, CREAM)), ov: prep(tint(OV_SCHOOL, CREAM)) }],
  library: [{ cu: prep(CU_LIBRARY), ov: prep(OV_LIBRARY) }, { cu: prep(tint(CU_LIBRARY, { P: 's' })), ov: prep(tint(OV_LIBRARY, { P: 's' })) }],
  tower: [
    { cu: prep(CU_TOWER2), ov: prep(OV_TOWER2) },
    { cu: prep({ ...CU_TOWER2, roof: pic(0, 3, hip(4, 5)), flag: [7, 3], towerFlag: [7, 3] }), ov: prep({ ...OV_TOWER2, roof: pic(0, 1, hip(2, 2)) }) },
  ],
  observatory: [
    { cu: prep(CU_OBSERVATORY), ov: prep(OV_OBSERVATORY) },
    { cu: prep(tint(CU_OBSERVATORY, { P: 'S', W: 's', p: 'S', q: 'K' })), ov: prep(tint(OV_OBSERVATORY, { P: 'S', W: 's', p: 'S', q: 'K' })) },
  ],
}

/**
 * A town kind (kinds.ts TOWN_KINDS: house, townhouse, shop, tavern, hall, school, library, workshop, tower, statue,
 * garden, observatory) in its footprint (KINDS[kind] w by h close-up, halved overview), (x, y) its top-left.
 * The door, where the path starts, is the middle of the footprint's bottom edge.
 */
export function drawTown(pen: Pen, s: Scale, x: number, y: number, look: BuildLook) {
  if (look.kind === 'statue') return monument(pen, s, x, y, look)
  if (look.kind === 'garden') return grounds(pen, s, x, y, look)
  const arts = TOWN_ART[look.kind]
  const art = arts?.[Math.abs(Math.floor(look.style)) % arts.length]
  const a = art ? (s === 1 ? art.cu : art.ov) : null
  if (a) return edifice(pen, s, x, y, look, a)
  // not drawn yet: the cottage, centred in the footprint
  const f = FOOTPRINTS[look.kind]
  const k = s === 1 ? 1 : 0.5
  house(pen, s, x + Math.round(((f.w - 26) / 2 - 6) * k), y + Math.round((f.h - 28) * k), { ...look, stage: stageOf(look), style: look.style })
}
