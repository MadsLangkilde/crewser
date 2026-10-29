// The town's fixed places and its nature: the lead's castle, the town square in front of it with its spring, the
// tokens mine beside it, the park with its pond, trees, the lake with its fishing pier, and the mountains, a few
// massifs spread over the north of the map. Drawn at two scales with art of their own.
//
// Every picture is worked out once, when the module loads (or once for its shape: the lake, the mountains), as a
// letter per pixel (see `Pic`), and painted each frame through a palette; only what moves (flags, torches, water,
// the cart, ducks, ripples) is drawn per frame.
// Light comes from the upper left: left faces are lighter, right faces darker. Textures are kept faint so the
// people, who wear bright coats, stand out against the places.
import { C, GROUND, OBJECT, OVERLAY, blend, seeded, shade, type Pen, type Scale } from './kit'
import { bench } from './scenery'

/** The castle's size close-up; overview halves it. The town square below it is SQUARE. */
export const MIDDLE = { w: 84, castle: 36 } as const

// ---- pictures: a letter per pixel ('.' clear), colored through a palette when painted

type Pic = { w: number; h: number; px: Uint8Array }
/** Letter (by char code) to color; -1 leaves the pixel alone. */
type Pal = Int32Array

function blank(w: number, h: number): Pic {
  return { w, h, px: new Uint8Array(w * h) }
}

function put(p: Pic, x: number, y: number, ch: string) {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return
  p.px[y * p.w + x] = ch === '.' ? 0 : ch.charCodeAt(0)
}

function fill(p: Pic, x: number, y: number, w: number, h: number, ch: string) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(p, x + i, y + j, ch)
}

/** Rows of letters onto a picture at (x, y); '.' leaves what is there. */
function stamp(p: Pic, x: number, y: number, art: readonly string[]) {
  for (let j = 0; j < art.length; j++) {
    const r = art[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      const ch = r[i] ?? '.'
      if (ch !== '.') put(p, x + i, y + j, ch)
    }
  }
}

function pic(art: readonly string[]): Pic {
  const p = blank(Math.max(0, ...art.map(r => r.length)), art.length)
  stamp(p, 0, 0, art)
  return p
}

/** Where a letter is, as x, y pairs: windows to light, a furnace's mouth. */
function where(p: Pic, ch: string) {
  const out: number[] = []
  const code = ch.charCodeAt(0)
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.px[y * p.w + x] === code) out.push(x, y)
  return out
}

/** The pixels just outside a picture (left, right, above or below one of its own), as x, y pairs. */
function around(p: Pic) {
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < p.w && y < p.h && (p.px[y * p.w + x] ?? 0) !== 0
  const out: number[] = []
  for (let y = -1; y <= p.h; y++) {
    for (let x = -1; x <= p.w; x++) if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) out.push(x, y)
  }
  return out
}

/**
 * Where a picture stands in front of something drawn before it (not the ground), the dark line the engine draws
 * on the ground round every object: so a tree in a wood, or the mine before the mountains, stays apart.
 */
function edgeOver(pen: Pen, spots: readonly number[], x: number, y: number) {
  const { w, px, kind } = pen
  for (let i = 0; i + 1 < spots.length; i += 2) {
    const ax = x + (spots[i] ?? 0)
    const ay = y + (spots[i + 1] ?? 0)
    if (!pen.inside(ax, ay)) continue
    const k = kind[ay * w + ax]
    if (k === OBJECT || k === OVERLAY) px[ay * w + ax] = C.edge
  }
}

function pal(m: Readonly<Record<string, number>>): Pal {
  const a = new Int32Array(128).fill(-1)
  for (const k of Object.keys(m)) a[k.charCodeAt(0)] = m[k] ?? -1
  return a
}

function paint(pen: Pen, p: Pic, x: number, y: number, colors: Pal, flip = false) {
  const { w, h, px } = p
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ch = px[j * w + (flip ? w - 1 - i : i)] ?? 0
      if (!ch) continue
      const c = colors[ch] ?? -1
      if (c >= 0) pen.dot(x + i, y + j, c)
    }
  }
}

/**
 * `anim` a step every `n` frames. The frame count runs from 1970 (four a second), long past where `>>` keeps a
 * number whole, so slow it by dividing.
 */
const slow = (anim: number, n: number) => Math.floor(anim / n)

/** A flicker that looks random but is the same for the same frame and place: 0..7. */
const flick = (anim: number, n: number) => (anim * 5 + n * 3 + ((anim * (n + 3)) >> 2)) & 7

// ---- the castle

export type CastleLook = { color: number; anim: number; lit: boolean }

/**
 * The castle's stone and iron. The lead's color fills r/R/q (roof light, mid, dark), b/B (banner, its shade),
 * f/F (flag, its shade) and e (the banner's emblem): see `castlePal`.
 */
const CASTLE_BASE: Readonly<Record<string, number>> = {
  L: C.stoneLight, S: C.stone, j: C.cobble2, D: C.stoneDark, w: C.cobble2, x: C.cobbleEdge,
  K: C.ink, i: C.ironDark, g: C.glass, t: C.timber, p: C.ironDark,
}

/** Close-up: 84 by 36, the castle within columns 12..72, the gate centred on column 42. */
const CASTLE1 = (() => {
  const p = blank(84, 36)
  // masonry in courses four rows tall, the joints faint and staggered
  const masonry = (x0: number, y0: number, w: number, h: number, base: string, joint: string, light: string, dark: string) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const course = y >> 2
        const row = (y & 3) === 3
        const col = (x + (course & 1) * 3) % 6 === 0
        put(p, x, y, x === x0 ? light : x === x0 + w - 1 ? dark : row || col ? joint : base)
      }
    }
  }
  const merlons = (x0: number, y0: number, pattern: string, top: string, body: string) => {
    for (let i = 0; i < pattern.length; i++) if (pattern[i] !== '.') (put(p, x0 + i, y0, top), put(p, x0 + i, y0 + 1, body))
  }
  // the curtain wall, set back: a shade darker than what stands in front of it
  masonry(22, 21, 11, 15, 'w', 'x', 'w', 'w')
  masonry(52, 21, 11, 15, 'w', 'x', 'w', 'w')
  merlons(22, 19, 'SS.SS.SS.SS', 'L', 'w')
  merlons(52, 19, 'SS.SS.SS.SS', 'L', 'w')
  // the shadows the keep and the left tower cast on the wall
  fill(p, 52, 21, 2, 15, 'x')
  fill(p, 22, 21, 1, 15, 'x')
  fill(p, 27, 25, 1, 3, 'K')
  fill(p, 57, 25, 1, 3, 'K')
  // the keep
  masonry(33, 8, 19, 28, 'S', 'j', 'L', 'D')
  merlons(33, 5, 'SSS.SSS.SSS.SSS.SSS', 'L', 'S')
  fill(p, 33, 7, 19, 1, 'L')
  fill(p, 33, 8, 19, 1, 'D')
  for (const wx of [35, 47]) stamp(p, wx, 11, ['.g.', 'ggg', 'ggg', 'ggg', 'LLL'])
  // the banner on its rod, swallowtailed, a diamond on it
  fill(p, 39, 11, 7, 1, 't')
  fill(p, 40, 12, 5, 8, 'b')
  fill(p, 44, 12, 1, 8, 'B')
  stamp(p, 40, 20, ['bb.bB'])
  stamp(p, 41, 14, ['.e.', 'eee', '.e.'])
  // the gate: an arch framed in light stone, the portcullis half raised
  stamp(p, 37, 24, [
    '...LLLLL...',
    '..LKKKKKL..',
    '.LKKKKKKKL.',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
    'LKKKKKKKKKL',
  ])
  stamp(p, 38, 25, [
    '..i.i.i..',
    '.i.i.i.i.',
    'iiiiiiiii',
    '.i.i.i.i.',
    '.i.i.i.i.',
    'iiiiiiiii',
    '.i.i.i.i.',
  ])
  for (const tx of [35, 49]) fill(p, tx, 28, 1, 2, 't')
  // the towers: round, lit from the left, cone roofs in the lead's color
  for (const cx of [17, 67]) {
    for (let y = 13; y < 36; y++) {
      for (let dx = -4; dx <= 4; dx++) put(p, cx + dx, y, dx <= -3 ? 'L' : dx === 4 ? 'D' : dx === 3 ? 'j' : (y & 3) === 3 ? 'j' : 'S')
    }
    fill(p, cx - 4, 13, 9, 1, 'D')
    // a plinth, one wider each side, its ledge catching the light
    fill(p, cx - 5, 32, 11, 1, 'L')
    for (let y = 33; y < 36; y++) for (let dx = -5; dx <= 5; dx++) put(p, cx + dx, y, dx === -5 ? 'L' : dx >= 4 ? 'D' : y === 34 ? 'j' : 'S')
    fill(p, cx, 17, 1, 3, 'g')
    fill(p, cx, 25, 1, 3, 'g')
    const widths = [1, 3, 3, 5, 5, 7, 7, 9, 9, 11]
    widths.forEach((wd, r) => {
      const half = (wd - 1) / 2
      for (let dx = -half; dx <= half; dx++) {
        const t = dx / (half + 0.5)
        put(p, cx + dx, 3 + r, r === widths.length - 1 ? 'q' : t < -0.3 ? 'r' : t > 0.35 ? 'q' : 'R')
      }
    })
    fill(p, cx, 0, 1, 3, 'p')
  }
  return { p, windows: where(p, 'g') }
})()

/** Overview: 42 by 18, the castle within columns 6..36, the gate centred on column 21. */
const CASTLE2 = (() => {
  const p = blank(42, 18)
  fill(p, 12, 11, 4, 7, 'w')
  fill(p, 27, 11, 4, 7, 'w')
  stamp(p, 12, 10, ['L.L.'])
  stamp(p, 27, 10, ['.L.L'])
  fill(p, 27, 11, 1, 7, 'x')
  // keep
  fill(p, 16, 5, 11, 13, 'S')
  fill(p, 16, 5, 1, 13, 'L')
  fill(p, 26, 5, 1, 13, 'D')
  stamp(p, 16, 4, ['L.L.L.L.L.L'])
  fill(p, 16, 5, 11, 1, 'L')
  stamp(p, 18, 7, ['g.....g', 'g.....g'])
  stamp(p, 20, 7, ['bbB', 'bbB', 'bbB', 'b.B'])
  stamp(p, 19, 12, ['.LLL.', 'LKKKL', 'LiiiL', 'LKKKL', 'LKKKL', 'LKKKL'])
  // towers
  for (const cx of [9, 33]) {
    for (let y = 8; y < 18; y++) for (let dx = -2; dx <= 2; dx++) put(p, cx + dx, y, dx === -2 ? 'L' : dx === 2 ? 'D' : dx === 1 ? 'j' : 'S')
    put(p, cx, 11, 'g')
    put(p, cx, 14, 'g')
    const widths = [1, 3, 3, 5, 5, 7]
    widths.forEach((wd, r) => {
      const half = (wd - 1) / 2
      for (let dx = -half; dx <= half; dx++) put(p, cx + dx, 2 + r, r === widths.length - 1 ? 'q' : dx < 0 ? 'r' : dx > 0 ? 'q' : 'R')
    })
    fill(p, cx, 0, 1, 2, 'p')
  }
  return { p, windows: where(p, 'g') }
})()

const castlePals = new Map<number, Pal>()
function castlePal(color: number) {
  let a = castlePals.get(color)
  if (!a) {
    if (castlePals.size > 16) castlePals.clear()
    // the banner's emblem: gold on a dark color, a deep shade of the color on a light one
    const luma = 0.299 * ((color >> 16) & 255) + 0.587 * ((color >> 8) & 255) + 0.114 * (color & 255)
    const e = luma > 145 ? shade(color, 0.45) : C.gold
    a = pal({ ...CASTLE_BASE, r: blend(color, 0xffffff, 0.25), R: color, q: shade(color, 0.68), b: color, B: shade(color, 0.72), f: color, F: shade(color, 0.72), e })
    castlePals.set(color, a)
  }
  return a
}

/** The towers' middle columns, and the torches either side of the gate. */
const TOWERS1 = [17, 67] as const
const TOWERS2 = [9, 33] as const
const TORCHES1 = [35, 49] as const
const TORCHES2 = [18, 24] as const

/** Flags flying right from a pole's top, two frames of flapping. */
const FLAG1 = [pic(['ffff', 'FFF.']), pic(['fff.', 'FFFF'])]
const FLAG2 = [pic(['ff']), pic(['f.', '.f'])]

/**
 * The lead's castle: towers with roofs and flags in the lead's color, a keep, a curtain wall, a gate. (x, y) is
 * the top-left of its 84 by 36 box close-up (42 by 18 overview); it stands within columns 12..72 (6..36); the
 * gate is centred on column 42 (21) and opens on the box's bottom row onto the street below. The engine
 * writes the project's name above the box.
 */
export function castle(pen: Pen, s: Scale, x: number, y: number, look: CastleLook) {
  const one = s === 1
  const art = one ? CASTLE1 : CASTLE2
  const colors = castlePal(look.color)
  pen.as(OBJECT, () => {
    paint(pen, art.p, x, y, colors)
    for (const cx of one ? TOWERS1 : TOWERS2) {
      const frames = one ? FLAG1 : FLAG2
      const f = frames[(slow(look.anim, 2) + cx) % 2] ?? frames[0]
      if (f) paint(pen, f, x + cx + 1, y, colors)
    }
  })
  if (look.lit) for (let i = 0; i + 1 < art.windows.length; i += 2) pen.glow(x + (art.windows[i] ?? 0), y + (art.windows[i + 1] ?? 0), C.lit)
  // torches by the gate; at overview only in the evening
  if (one) {
    for (const tx of TORCHES1) {
      pen.glow(x + tx, y + 27, flick(look.anim, tx) < 4 ? C.fire[1] : C.fire[2])
      if (flick(look.anim, tx + 1) < 5) pen.glow(x + tx, y + 26, flick(look.anim, tx + 2) < 4 ? C.fire[2] : C.fire[3])
    }
  } else if (look.lit) {
    for (const tx of TORCHES2) pen.glow(x + tx, y + 14, flick(look.anim, tx) < 4 ? C.fire[1] : C.fire[2])
  }
}

// ---- the tokens mine: a building of its own beside the castle

/**
 * How the mine looks: `left` is how much of the five-hour limit is left (0..100, null when not known yet), shown as
 * the pile of gold tokens in its bin: heaped high when there is plenty, down to an empty bin.
 */
export type MineLook = { anim: number; left: number | null; lit: boolean }

/** The mine's footprint close-up (the overview halves it); the engine keeps the rows under it for its name. */
export const MINE = { w: 52, h: 34 } as const

const MINE_PAL = pal({
  r: C.rockLight, R: C.rock, a: C.rockDark, t: C.timber, T: C.woodDark, w: C.wood, W: C.woodLight, K: C.ink, I: C.iron, i: C.ironDark,
  o: C.gold, O: C.goldDark, y: C.lit, s: C.road, e: C.roadEdge,
})

/**
 * A hill from its outline: `top[x]` the first row of rock in column x (-1 for none), `ridges` the lines that split
 * a lit face from a shaded one, as [x at the peak, peak row, columns per row]; left of the first ridge is lit.
 */
function hill(p: Pic, top: readonly number[], base: number, ridges: readonly (readonly [number, number, number])[], dx = 0) {
  for (let x = 0; x < top.length; x++) {
    const t = top[x] ?? -1
    if (t < 0) continue
    for (let y = t; y <= base; y++) {
      const past = ridges.filter(([rx, ry, k]) => y >= ry && x > rx + Math.round((y - ry) * k)).length
      put(p, x + dx, y, past === 0 ? 'r' : past === 1 ? 'R' : 'a')
    }
  }
}

/** A leg of the winding tower, from (x0, y0) down to (x1, y1), two pixels wide (lit, then shaded) close-up. */
function leg(p: Pic, x0: number, y0: number, x1: number, y1: number, wide: boolean) {
  for (let y = y0; y <= y1; y++) {
    const x = Math.round(x0 + ((x1 - x0) * (y - y0)) / Math.max(1, y1 - y0))
    put(p, x, y, 't')
    if (wide) put(p, x + 1, y, 'T')
  }
}

// close-up: the hill with the tunnel on the left, the winding tower in the middle, the bin of tokens on the right
const BIN1 = { x: 35, rim: 13, w: 17 } as const
const MINE1 = (() => {
  const p = blank(MINE.w, 31)
  hill(p, [22, 19, 16, 14, 12, 11, 10, 9, 8, 8, 7, 7, 7, 8, 8, 9, 10, 11, 13, 15, 17, 20, 23], 30, [[11, 7, 0.32], [16, 9, 0.6]])
  stamp(p, 2, 14, ['a', 'a'])
  stamp(p, 18, 13, ['a', 'a'])
  stamp(p, 7, 10, ['RR'])
  // the tunnel: a timber frame round the dark, a lantern on its left post
  stamp(p, 4, 18, [
    'TttttttttttT',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
    '.tKKKKKKKKt.',
  ])
  stamp(p, 3, 19, ['i', 'o'])
  // the winding tower: two legs, braces, a platform; its wheel turns (drawn each frame)
  leg(p, 25, 10, 22, 30, true)
  leg(p, 30, 10, 33, 30, true)
  fill(p, 24, 9, 8, 1, 'T')
  fill(p, 24, 17, 8, 1, 't')
  fill(p, 23, 24, 10, 1, 't')
  for (let k = 0; k < 6; k++) put(p, 25 + k, 18 + k, 'T')
  // the bin: its back rim, the dark inside, the front rim and planks, iron bands, legs
  const { x, rim, w } = BIN1
  fill(p, x, rim, w, 1, 'T')
  fill(p, x, rim + 1, w, 2, 'K')
  put(p, x, rim + 1, 'T')
  put(p, x, rim + 2, 'T')
  put(p, x + w - 1, rim + 1, 'T')
  put(p, x + w - 1, rim + 2, 'T')
  fill(p, x, rim + 3, w, 1, 'W')
  for (let y = rim + 4; y <= rim + 14; y++) for (let i = 0; i < w; i++) put(p, x + i, y, i === 0 ? 'W' : i === w - 1 ? 'T' : i % 4 === 0 ? 't' : 'w')
  fill(p, x + 1, rim + 5, w - 2, 1, 'i')
  fill(p, x + 1, rim + 13, w - 2, 1, 'i')
  // a token on the front: a gold coin with a T
  stamp(p, x + 5, rim + 6, [
    '.yooooO.',
    'yoOOOOoO',
    'oooOOooO',
    'oooOOooO',
    'oooOOooO',
    '.oOOOOO.',
  ])
  for (const lx of [x + 1, x + w - 3]) fill(p, lx, rim + 15, 2, 3, 'T')
  return p
})()

/** The ground in front: the rails from the tunnel to the bin, as ground (no ring): close-up rows 31..33. */
const APRON1 = (() => {
  const p = blank(MINE.w, 3)
  fill(p, 2, 0, MINE.w - 2, 2, 's')
  fill(p, 2, 2, MINE.w - 2, 1, 'e')
  for (let x = 5; x < MINE.w - 1; x++) put(p, x, 1, x % 3 === 1 ? 'w' : 'I')
  return p
})()

/** The wheel close-up: rim, a dark inside and a hub; its spokes turn. */
const WHEEL1 = pic([
  '..IIIII..',
  '.IiiiiiI.',
  'IiiiiiiiI',
  'IiiiiiiiI',
  'IiiiIiiiI',
  'IiiiiiiiI',
  'IiiiiiiiI',
  '.IiiiiiI.',
  '..IIIII..',
])
const SPOKES1 = [
  [[4, 1], [4, 2], [4, 3], [4, 5], [4, 6], [4, 7], [1, 4], [2, 4], [3, 4], [5, 4], [6, 4], [7, 4]],
  [[2, 2], [3, 3], [5, 5], [6, 6], [6, 2], [5, 3], [3, 5], [2, 6]],
] as const

// overview: the same three things, half the size
const BIN2 = { x: 17, rim: 7, w: 9 } as const
const MINE2 = (() => {
  const p = blank(26, 15)
  hill(p, [11, 9, 7, 5, 4, 4, 3, 3, 4, 5, 7, 9], 14, [[6, 3, 0.3]])
  stamp(p, 2, 8, ['TtttT', '.KKK.', '.KKK.', '.KKK.', '.KKK.', '.KKK.', '.KKK.'])
  put(p, 2, 9, 't')
  put(p, 6, 9, 't')
  // the tower as a lattice, solid at this size
  stamp(p, 11, 5, ['.TTTT.', '.wTTw.', '.TwwT.', '.wTTw.', '.TwwT.', 'TwTTwT', 'TTwwTT', 'TwTTwT', 'TTwwTT', 'T....T'])
  const { x, rim, w } = BIN2
  fill(p, x, rim, w, 1, 'T')
  fill(p, x, rim + 1, w, 1, 'K')
  put(p, x, rim + 1, 'T')
  put(p, x + w - 1, rim + 1, 'T')
  fill(p, x, rim + 2, w, 1, 'W')
  stamp(p, x, rim + 3, ['WwwwwwwwT', 'WwwyoOwwT', 'WwwoOOwwT', 'WwwwwwwwT'])
  put(p, x + 1, rim + 7, 'T')
  put(p, x + w - 2, rim + 7, 'T')
  return p
})()
const APRON2 = (() => {
  const p = blank(26, 2)
  fill(p, 1, 0, 25, 1, 's')
  for (let x = 2; x < 26; x++) put(p, x, 0, x % 2 ? 'I' : 'w')
  fill(p, 1, 1, 25, 1, 'e')
  return p
})()
const WHEEL2: readonly [Pic, Pic] = [pic(['.III.', 'IiIiI', 'IIiII', 'IiIiI', '.III.']), pic(['.III.', 'IIiII', 'IiIiI', 'IIiII', '.III.'])]

/** The pile of tokens in the bin for a level 0..5: none, a few, a layer, level with the rim, heaped, heaped high. */
function heap(one: boolean, level: number) {
  const b = one ? BIN1 : BIN2
  const inner = b.w - 2
  const depth = one ? 2 : 1 // rows of inside below the rim
  const over = one ? [0, 0, 0, 1, 5, 9][level] ?? 0 : [0, 0, 0, 1, 2, 4][level] ?? 0
  const p = blank(b.w, over + depth + 1)
  const rimRow = over // the rim's row in this picture
  if (level === 0) return { p, top: b.rim - over }
  for (let i = 0; i < inner; i++) {
    const d = (i - (inner - 1) / 2) / ((inner + 1) / 2)
    const rise = level >= 3 ? Math.round(over * (1 - d * d)) : 0
    // a few tokens, or a layer on the bottom, or full to the rim and heaped over it
    const from = level === 1 ? (i % 3 === 1 ? rimRow + depth : 99) : level === 2 ? rimRow + depth : rimRow + 1 - rise
    for (let y = Math.max(0, from); y <= rimRow + depth; y++) {
      const shaded = i > inner * 0.62 && y > rimRow + 1 - rise + 1
      const coin = one && (i * 2 + y * 3) % 7 === 0
      put(p, i + 1, y, coin ? 'O' : shaded ? 'O' : 'o')
    }
    if (one && level >= 3 && i % 5 === 2) put(p, i + 1, Math.max(0, rimRow + 1 - rise), 'y')
  }
  return { p, top: b.rim - over }
}
const HEAPS = new Map<string, { p: Pic; top: number }>()
function heapOf(one: boolean, level: number) {
  const key = `${one}|${level}`
  let h = HEAPS.get(key)
  if (!h) HEAPS.set(key, (h = heap(one, level)))
  return h
}

/** The cart, loaded and empty. */
const CART1: readonly [Pic, Pic] = [pic(['..oyo..', '.ooOoo.', 'IIIIIII', '.iiiii.', '.K...K.']), pic(['IIIIIII', '.iiiii.', '.K...K.'])]
const CART2: readonly [Pic, Pic] = [pic(['.oy.', 'IiiI', '.KK.']), pic(['IiiI', '.KK.'])]

/** Where the cart is along its run, and whether it is loaded: out of the tunnel full, a wait at the bin, back empty. */
function cartAt(anim: number, run: number, wait: number) {
  const t = anim % (2 * (run + wait))
  if (t < wait) return { at: 0, full: true }
  if (t < wait + run) return { at: t - wait, full: true }
  if (t < 2 * wait + run) return { at: run, full: false }
  return { at: run - (t - 2 * wait - run), full: false }
}

/** How full the bin is, 0..5, from what is left of the five-hour limit. */
const levelOf = (left: number | null) => (left === null ? 3 : left >= 80 ? 5 : left >= 60 ? 4 : left >= 40 ? 3 : left >= 15 ? 2 : left > 0 ? 1 : 0)

/**
 * The tokens mine on its plot (MINE close-up, half that at overview; the label rows under it left to the engine):
 * a rocky hill with a tunnel, a winding tower whose wheel turns, rails with a cart bringing tokens out, and the bin
 * the tokens go into, as full as the five-hour limit has tokens left.
 */
export function mine(pen: Pen, s: Scale, x: number, y: number, look: MineLook) {
  const one = s === 1
  const anim = look.anim
  pen.as(GROUND, () => paint(pen, one ? APRON1 : APRON2, x, y + (one ? 31 : 15), MINE_PAL))
  const level = levelOf(look.left)
  pen.as(OBJECT, () => {
    paint(pen, one ? MINE1 : MINE2, x, y, MINE_PAL)
    const h = heapOf(one, level)
    paint(pen, h.p, x + (one ? BIN1.x : BIN2.x), y + h.top, MINE_PAL)
    // the wheel turns while there are tokens to bring up
    const turn = level > 0 ? slow(anim, 2) & 1 : 0
    if (one) {
      paint(pen, WHEEL1, x + 23, y, MINE_PAL)
      for (const [sx, sy] of SPOKES1[turn] ?? []) pen.dot(x + 23 + sx, y + sy, C.iron)
    } else paint(pen, WHEEL2[turn ? 1 : 0], x + 12, y, MINE_PAL)
    if (level > 0) {
      const c = cartAt(anim, one ? 22 : 10, one ? 6 : 4)
      const cart = (one ? CART1 : CART2)[c.full ? 0 : 1]
      paint(pen, cart, x + (one ? 6 : 3) + c.at, y + (one ? 33 : 16) - cart.h, MINE_PAL)
    }
  })
  // the lantern by the tunnel, and a glint on the pile now and then
  if (one) pen.glow(x + 3, y + 20, flick(anim, 4) < 6 ? C.fire[1] : C.fire[2])
  else if (look.lit) pen.glow(x + 1, y + 9, C.fire[1])
  if (level >= 3 && (anim & 7) < 2) {
    const h = heapOf(one, level)
    const gx = (one ? BIN1.x : BIN2.x) + 2 + (slow(anim, 8) % ((one ? BIN1.w : BIN2.w) - 4))
    pen.glow(x + gx, y + h.top + (one ? 2 : 1), C.fire[0])
  }
}

// ---- the park

const PARK_PAL = pal({ b: C.water, B: C.waterDeep, l: C.waterLight, s: C.sand, W: C.wood, T: C.woodLight, d: C.woodDark, g: C.leafDark, G: C.leaf, h: C.trunk })

/** The pond: water within an ellipse, a sandy rim round it. */
function buildPond(k: number) {
  const cx = 16 * k
  const cy = Math.floor(17 * k)
  const pad = k === 1 ? 0.5 : 0.3
  const rx = 13 * k + pad
  const ry = 7 * k + pad
  const p = blank(40 * k, 36 * k)
  const water = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (water(x, y)) put(p, x, y, 'b')
      else if (water(x - 1, y) || water(x + 1, y) || water(x, y - 1) || water(x, y + 1) || (k === 1 && (water(x - 2, y) || water(x + 2, y)))) put(p, x, y, 's')
    }
  }
  return p
}
const POND1 = (() => {
  const p = buildPond(1)
  // two reeds by the left bank, brown heads on green stems, and a lily pad
  stamp(p, 4, 17, ['..h', 'h.h', 'h.G', 'G.G'])
  stamp(p, 9, 22, ['GG'])
  return p
})()
const POND2 = buildPond(0.5)

/** Half-width of the pond's water on a row, for ripples. */
function pondHalf(k: number, dy: number) {
  const pad = k === 1 ? 0.5 : 0.3
  const rx = 13 * k + pad
  const ry = 7 * k + pad
  return Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)))
}

/** Rows of the close-up pond, from its centre, where ripples drift. */
const RIPPLES = [-4, 3, 0] as const

const PIER1 = pic(['TWTWTWTWT', 'TWTWTWTWT', 'ddddddddd'])
const PIER2 = pic(['TWTWT', 'ddddd'])

const DUCK1 = pic(['...Wo', 'WWWW.', '.WWW.'])
const DUCK2 = pic(['.Wo', 'WW.'])
const DUCK_PAL = pal({ W: C.white, o: C.ember, l: C.waterLight })

/**
 * The park on its plot: a pond, a pier, a tree. Close-up, from the plot's top-left: the pond centred on (16, 17),
 * 13 wide and 7 high each way from there, a sandy rim; the pier on rows 16..18 from column 23 to 31; a tree in
 * columns 27..37, rows 0..10. A fisher sits on the pier with feet on (28, 16) facing left; a napper lies under
 * the tree from (12, 7) to the right. Overview halves every number. Ducks swim on the pond (drawn here).
 */
export function park(pen: Pen, s: Scale, x: number, y: number, anim: number) {
  const one = s === 1
  const k = one ? 1 : 0.5
  pen.as(GROUND, () => paint(pen, one ? POND1 : POND2, x, y, PARK_PAL))
  pen.as(OBJECT, () => paint(pen, one ? PIER1 : PIER2, x + (one ? 23 : 11), y + (one ? 16 : 8), PARK_PAL))
  tree(pen, s, x + (one ? 27 : 13), y, 'round')
  const cx = x + 16 * k
  const cy = y + Math.floor(17 * k)
  pen.as(OVERLAY, () => {
    // ripples drifting across, short and faint
    const rows = one ? RIPPLES : []
    rows.forEach((dy, i) => {
      const half = pondHalf(k, dy) - (one ? 3 : 1)
      const len = one ? 3 : 2
      const span = 2 * half - len
      if (span <= 0) return
      const t = (slow(anim, one ? 2 : 4) + i * 11) % span
      const rx = cx - half + t
      if (one && dy === 0 && rx + len > cx + 6) return
      for (let j = 0; j < len; j++) pen.dot(rx + j, cy + dy, C.waterLight)
    })
    // two ducks paddling to and fro
    const duck = one ? DUCK1 : DUCK2
    const swim = (x0: number, dy: number, span: number, phase: number) => {
      const t = (anim + phase) % (span * 2)
      const left = t >= span
      const dx = left ? span * 2 - t : t
      paint(pen, duck, x0 + dx, cy + dy, DUCK_PAL, left)
    }
    if (one) {
      swim(cx - 11, -5, 10, 0)
      swim(cx - 8, 2, 9, 7)
    } else {
      swim(cx - 5, -3, 5, 0)
      swim(cx - 4, 1, 3, 3)
    }
  })
}

// ---- trees

/**
 * Trees have greens of their own, lighter than the grass so a crown stands out inside the dark ring the engine
 * draws round it: broadleaf crowns warm (H highlight, L light, M, D, E the underside), pines cool (l, m, d, e).
 * Each step is at least 17 apart in a channel so the terminal's 12-bit colors keep them apart. S marks a shadow
 * on the ground by the trunk: the grass darkened, drawn as OVERLAY so the ring leaves it soft.
 */
const TREE_PAL = pal({
  H: 0xaacc66, L: 0x77aa44, M: 0x559933, D: 0x447733, E: 0x335533,
  l: 0x55aa66, m: 0x338855, d: 0x226644, e: 0x114433,
  T: 0x996633, t: 0x664422,
})

/**
 * A tree's picture, the shadow pixels taken out of it, and the pixels round it: where it stands in front of a tree
 * drawn earlier, those get the ring's dark color, so trees in a wood stay apart as the engine's ring keeps them
 * apart from the grass.
 */
type TreeArt = { p: Pic; around: number[]; shadow: number[] }

function treeArt(art: readonly string[]): TreeArt {
  const p = pic(art)
  const shadow = where(p, 'S')
  for (let i = 0; i + 1 < shadow.length; i += 2) put(p, shadow[i] ?? 0, shadow[i + 1] ?? 0, '.')
  return { p, around: around(p), shadow }
}

// Light from the upper left: a soft highlight there, the crown darkening toward its lower right and underside.
const ROUND1 = treeArt([
  '...LLLLL...',
  '.LLHHLLLMM.',
  'LLHHHLLLMMM',
  'LHHLLLLMMMD',
  'LLLLLLMMMDD',
  'LLLLMMMMDDD',
  '.MMMMMMDDE.',
  '..DDDDDEE..',
  '....TTt....',
  '...STTtSS..',
])
// Three tiers, each with a lit tip on the left and a darker underside.
const PINE1 = treeArt([
  '.....l.....',
  '....llm....',
  '...lmmdd...',
  '....llm....',
  '...llmmd...',
  '..lmmmddd..',
  '...lllmd...',
  '..lllmmdd..',
  '.lmmmmmdde.',
  '...STTtSS..',
])
const ROUND2 = treeArt([
  '.LLMM.',
  'LHLLMM',
  'LLLMMD',
  'MMMMDD',
  '.DDDD.',
  '..TtS.',
])
const PINE2 = treeArt([
  '..l..',
  '.lmd.',
  'llmdd',
  '.lmd.',
  'llmdd',
  '..TS.',
])

/** Ground colors and their shadows, worked out once each; `shaded` holds the shadows, never darkened twice. */
const shadowOf = new Map<number, number>()
const shaded = new Set<number>()

/**
 * A tree, (x, y) the top-left of its 11 by 10 box close-up (6 by 6 overview; a pine is 5 wide). Woods are drawn
 * top to bottom, so a tree lower down stands in front of the ones above it.
 */
export function tree(pen: Pen, s: Scale, x: number, y: number, kind: 'round' | 'pine') {
  const art = s === 1 ? (kind === 'pine' ? PINE1 : ROUND1) : kind === 'pine' ? PINE2 : ROUND2
  const { w, px } = pen
  const kinds = pen.kind
  // first the edge onto trees behind (their shadows too), then this tree's shadow, then the tree
  edgeOver(pen, art.around, x, y)
  pen.as(OVERLAY, () => {
    const sh = art.shadow
    for (let i = 0; i + 1 < sh.length; i += 2) {
      const sx = x + (sh[i] ?? 0)
      const sy = y + (sh[i + 1] ?? 0)
      if (!pen.inside(sx, sy) || kinds[sy * w + sx] !== GROUND) continue
      const c = px[sy * w + sx] ?? 0
      if (shaded.has(c)) continue
      let d = shadowOf.get(c)
      if (d === undefined) {
        if (shadowOf.size > 64) (shadowOf.clear(), shaded.clear())
        d = shade(c, 0.72)
        shadowOf.set(c, d)
        shaded.add(d)
      }
      pen.dot(sx, sy, d)
    }
  })
  pen.as(OBJECT, () => paint(pen, art.p, x, y, TREE_PAL))
}

// ---- the town square

/** The town square in front of the castle, close-up; overview halves it. */
export const SQUARE = { w: 84, h: 40 } as const

/** The spring's box and the trees' and benches' places in the square, close-up (see `square`). */
const SPRING = { x: 32, y: 11, w: 21, h: 19 } as const
const SQ_TREES = [[1, 1], [72, 1], [1, 29], [72, 29]] as const
/** Overview: the trees a pixel in from the halved places, so they stay inside the kerb. */
const SQ_TREES2 = [[1, 1], [35, 1], [1, 13], [35, 13]] as const
const SQ_BENCHES = [[14, 34], [61, 34]] as const

/**
 * The square's colors. The floor: cobbles (c), their joints (j), the kerb (k), the round paving the spring stands
 * in (its edge P; paler at overview, p). The spring's stone is paler than the cobbles so it stands out: rim lit,
 * mid and shaded (L, M, S), the basin's wall lit, mid and dark (W, w, D), K the inside of the far wall in shadow.
 * Water b, its deep and light (B, l), foam f. At the trees' feet flowers (1..4) on grass (g, its shade G).
 */
const SQ_PAL = pal({
  c: C.cobble, j: C.cobble2, k: C.cobbleEdge, p: 0xbbbbaa, P: C.cobble2,
  L: 0xeeeedd, M: 0xddddcc, S: 0xbbbbaa, W: 0xccccbb, w: 0xaaaa99, D: 0x888877, K: 0x666655,
  b: C.water, B: C.waterDeep, l: C.waterLight, f: 0xeeffff,
  g: C.grass, G: C.tuft, '1': 0xdd88aa, '2': 0xeecc55, '3': 0xeeeedd, '4': 0xeecc55,
})

/** Is (x, y) inside the ellipse round (cx, cy)? */
const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

/**
 * The floor close-up: flagstones in courses four rows tall, the joints staggered as in the castle's walls, a kerb
 * round the edge opening where the streets come in (the gate's path at the top and the road at the bottom, columns
 * 38..45; the roads at the middle of the sides, rows 18..21); round the spring a round of paving, two rings of
 * joints, where people stand to talk.
 */
const SQ_FLOOR1 = (() => {
  const { w, h } = SQUARE
  const p = blank(w, h)
  const disc = (x: number, y: number) => inEllipse(x, y, 42, 20, 17.5, 10.5)
  const inner = (x: number, y: number) => inEllipse(x, y, 42, 20, 14.5, 8.5)
  const ring = (x: number, y: number) => inner(x, y) && !(inner(x - 1, y) && inner(x + 1, y) && inner(x, y - 1) && inner(x, y + 1))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const open = ((y === 0 || y === h - 1) && x >= 38 && x <= 45) || ((x === 0 || x === w - 1) && y >= 18 && y <= 21)
      const kerb = !open && (x === 0 || y === 0 || x === w - 1 || y === h - 1)
      const course = Math.floor((y - 1) / 4)
      const joint = (y - 1) % 4 === 3 || (x + (course % 2) * 4) % 8 === 0
      let ch = kerb ? 'k' : joint ? 'j' : 'c'
      if (disc(x, y)) ch = disc(x - 1, y) && disc(x + 1, y) && disc(x, y - 1) && disc(x, y + 1) ? (ring(x, y) ? 'j' : 'c') : 'P'
      put(p, x, y, ch)
    }
  }
  return p
})()

const SQ_FLOOR2 = (() => {
  const w = SQUARE.w / 2
  const h = SQUARE.h / 2
  const p = blank(w, h)
  // the round of flags, as half-widths by row round column 21
  const halves = [[5, 4], [6, 7], [7, 8], [8, 9], [9, 9], [10, 9], [11, 9], [12, 8], [13, 7], [14, 4]] as const
  const disc = (x: number, y: number) => {
    const r = halves.find(([hy]) => hy === y)
    return r !== undefined && Math.abs(x - 21) <= r[1]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const open = ((y === 0 || y === h - 1) && x >= 19 && x <= 22) || ((x === 0 || x === w - 1) && y >= 9 && y <= 10)
      const kerb = !open && (x === 0 || y === 0 || x === w - 1 || y === h - 1)
      const dash = y % 4 === 2 && (x + ((y >> 2) % 2) * 5) % 10 < 2
      let ch = kerb ? 'k' : dash ? 'j' : 'c'
      if (disc(x, y)) ch = 'p'
      put(p, x, y, ch)
    }
  }
  return p
})()

/**
 * The spring close-up, 21 by 19 (its box in the square): a round stone basin, its rim seen from above, its wall in
 * front; a column in the middle carrying a small bowl, the water welling up from a knob in the bowl and spilling
 * over its sides into the basin (the moving water is drawn per frame, see `springWater`).
 */
const SPRING1 = (() => {
  const p = blank(SPRING.w, SPRING.h)
  // half-widths of the rim and of the opening inside it, by row
  const outer = [[6, 6], [7, 8], [8, 9], [9, 10], [10, 10], [11, 10], [12, 10], [13, 9], [14, 8], [15, 6]] as const
  const inner = [[7, 5], [8, 7], [9, 8], [10, 8], [11, 8], [12, 8], [13, 7], [14, 5]] as const
  const half = (rows: readonly (readonly [number, number])[], y: number) => rows.find(r => r[0] === y)?.[1] ?? -1
  const rimOf = (x: number) => (x <= 5 ? 'L' : x >= 15 ? 'S' : 'M')
  // the rim, and inside it the far wall in shadow, then the water, deeper at the back
  for (const [y, hw] of outer) {
    for (let x = 10 - hw; x <= 10 + hw; x++) {
      const ih = half(inner, y)
      if (Math.abs(x - 10) > ih) put(p, x, y, rimOf(x))
      else put(p, x, y, Math.abs(x - 10) > half(inner, y - 1) ? 'K' : y <= 8 ? 'B' : 'b')
    }
  }
  // the wall below the rim, three rows, lit on the left, in shadow under the rim's lip
  for (let x = 0; x < SPRING.w; x++) {
    let last = -1
    for (const [y, hw] of outer) if (Math.abs(x - 10) <= hw) last = y
    for (let y = last + 1; y <= last + 3; y++) put(p, x, y, x <= 3 ? 'W' : x >= 17 ? 'D' : y === last + 1 ? 'D' : 'w')
  }
  // the column with its bowl, standing in the water in front of the far rim
  stamp(p, 0, 1, [
    '.........LMS.........',
    '......LLLWwDMSS......',
    '.....LbbbbbbbbbS.....',
    '.....LLMMMMMMMSS.....',
    '......WwwwwwwwD......',
    '........WwwwD........',
    '.........WwD.........',
    '.........WwD.........',
    '.........WwD.........',
    '.........WwD.........',
  ])
  return p
})()

/** Overview, 11 by 10 (the box halved): the basin, the column and the bowl. */
const SPRING2 = pic([
  '...........',
  '...........',
  '...LbbbS...',
  '....wwD....',
  '..LLLwSSS..',
  '.LBBBwBBBS.',
  'LbbbbbbbbbS',
  '.LMMMMMMMS.',
  '.WwwwwwwwD.',
  '...WwwwD...',
])

/**
 * The moving water: welling from the knob, light running over the bowl, two streams falling, rings spreading (at
 * overview the welling and the light). In the evening the welling water catches the lamplight and glints.
 */
function springWater(pen: Pen, one: boolean, x: number, y: number, anim: number, lit: boolean) {
  const dot = (i: number, j: number, ch: 'b' | 'l' | 'f') => pen.dot(x + i, y + j, ch === 'f' ? 0xeeffff : ch === 'l' ? C.waterLight : C.water)
  const well = (i: number, j: number, ch: 'l' | 'f') => (lit ? pen.glow(x + i, y + j, ch === 'f' ? 0xeeffff : C.waterLight) : dot(i, j, ch))
  if (!one) {
    // water welling up over the bowl, light spreading over the basin
    const t = slow(anim, 2) % 3
    if (t === 0) well(5, 1, 'f')
    else if (t === 1) (well(4, 1, 'l'), well(5, 1, 'f'), well(6, 1, 'l'))
    else well(5, 1, 'l')
    dot(4 - t, 6, 'l')
    dot(6 + t, 6, 'l')
    return
  }
  // welling up over the knob: a bead of water, then a little dome spilling down
  const w = slow(anim, 2) % 3
  if (w === 0) well(10, 0, 'f')
  else if (w === 1) (well(9, 0, 'l'), well(10, 0, 'f'), well(11, 0, 'l'))
  else well(10, 0, 'l')
  // light running outward over the bowl's water from the knob
  const r = slow(anim, 2) % 3
  dot(8 - r, 3, 'l')
  dot(12 + r, 3, 'l')
  // two streams falling from the bowl's sides, dashes of light running down them
  for (const sx of [5, 15]) {
    for (let j = 5; j <= 8; j++) dot(sx, j, ((j - anim) % 3 + 3) % 3 === 0 ? 'f' : 'l')
    // a splash where each lands
    if (anim % 2 === 0) (dot(sx - 1, 9, 'l'), dot(sx + 1, 9, 'l'))
    else dot(sx, 9, 'f')
  }
  // rings spreading over the basin from the column's foot, a short arc each side
  const ring = slow(anim, 2) % 3
  const rx = 2 + ring * 2
  const ry = 11 + (ring === 2 ? 1 : 0)
  dot(10 - rx - 1, ry, 'l')
  dot(10 - rx, ry, 'l')
  dot(10 + rx, ry, 'l')
  dot(10 + rx + 1, ry, 'l')
}

/** Flowers either side of a tree's foot close-up (rows 7..9 of its box, under the crown's edge); grass at overview. */
const BED1 = pic(['.1.......3.', '121.....343', 'gGg.....gGg'])
const BED2 = pic(['.gggg.', 'GGGGGG'])

/**
 * The town square, (x, y) its top-left, SQUARE in size: cobbles (GROUND), a little spring in the middle (a stone
 * basin with water welling up and spilling, moving with `anim`; `lit`, in the evening, it glints), a few trees with
 * flowers at their feet and benches round it. It never changes as the crew builds. People gather round the spring, so keep everything but these clear for them:
 *  - the spring within columns 32..52, rows 11..29 (its centre at 42, 20)
 *  - trees within 11 by 10 boxes at (1, 1), (72, 1), (1, 29) and (72, 29)
 *  - benches 9 by 4 at (14, 34) and (61, 34)
 * The engine writes the square's name over its top edge and the path from the castle gate comes in at the middle
 * of the top edge (columns 38..45); the roads leave from the middle of each side.
 */
export function square(pen: Pen, s: Scale, x: number, y: number, anim: number, lit: boolean) {
  const one = s === 1
  const at = (v: number) => Math.floor(v * s)
  const trees = one ? SQ_TREES : SQ_TREES2
  pen.as(GROUND, () => {
    paint(pen, one ? SQ_FLOOR1 : SQ_FLOOR2, x, y, SQ_PAL)
    for (const [tx, ty] of trees) paint(pen, one ? BED1 : BED2, x + tx, y + ty + (one ? 7 : 4), SQ_PAL)
  })
  for (const [tx, ty] of trees) tree(pen, s, x + tx, y + ty, 'round')
  for (const [bx, by] of SQ_BENCHES) bench(pen, s, x + at(bx), y + at(by) + (one ? 3 : 1))
  const sx = x + at(SPRING.x)
  const sy = y + at(SPRING.y)
  pen.as(OBJECT, () => {
    paint(pen, one ? SPRING1 : SPRING2, sx, sy, SQ_PAL)
    springWater(pen, one, sx, sy, anim, lit)
  })
}

// ---- the lake

/**
 * The lake's colors, each on the terminal's 12-bit grid. Water deep in the middle (B), open (b), shallow by the
 * shore (h), the far bank's shadow on it (K); ripples and glints (l, f). The shore: the far bank's face (e), wet
 * sand at the water (W), sand (s), pebbles lit and shaded (o, O). Reeds lit, mid and dark (r, R, q), cattails (c);
 * lily pads lit and shaded (p, P), a lily (k) with its heart (y); tufts of grass (t).
 */
const LAKE_PAL = pal({
  B: 0x336699, b: C.water, h: 0x4488cc, K: 0x335588, l: C.waterLight, f: 0xeeffff,
  e: 0x998855, W: 0xbbaa77, s: C.sand, o: 0xddccaa, O: 0x998866,
  r: 0x88bb55, R: 0x559933, q: 0x447733, c: 0x774422,
  p: 0x77bb55, P: 0x448844, k: 0xeeaacc, y: 0xeecc55,
  t: C.tuft,
})

/** Reed clumps close-up, their bottom row on the waterline: cattails (c) on stems, blades leaning out. */
const REED_CLUMPS1 = [
  pic([
    '...c.....',
    '..cc...c.',
    '..cc..cc.',
    '..rR..cc.',
    '.rrR..rR.',
    '.r.rR.rR.',
    'rr.rRrR.q',
    '.rrrRRRqq',
    '..rRRRqq.',
  ]),
  pic([
    '......c.',
    '.c...cc.',
    'cc...cc.',
    'cc.r.rR.',
    'rR.rRrR.',
    'rR.rR.Rq',
    '.rRrRRqq',
    '..rRRqq.',
  ]),
  pic([
    '..c...',
    '.cc...',
    '.cc.R.',
    '.rRrR.',
    'r.rRRq',
    '.rRRq.',
  ]),
] as const
const REED_CLUMPS2 = [pic(['.c..', 'rcR.', 'rRq.']), pic(['c..', 'cR.', 'Rq.'])] as const

/** Lily pads close-up: flattened rounds, a notch cut in each, one in flower. */
const PADS1 = [
  pic(['.pppp..', 'pppppPP', '.pPPPP.']),
  pic(['..k..', '.kyk.', 'ppppP', '.pPP.']),
  pic(['.pp..', 'pppPP', '.PPP.']),
] as const
const PADS2 = [pic(['ppP', '.PP']), pic(['kP', 'PP'])] as const

/** A duck close-up, facing right: white, a grey belly at the waterline, an orange bill; overview 3 by 2. */
const LAKE_DUCK1 = pic(['...ww.', '...wkY', 'w.www.', 'wwwww.', '.gggg.'])
const LAKE_DUCK2 = pic(['.wY', 'wg.'])
const LAKE_DUCK_PAL = pal({ w: C.white, g: 0xbbbbbb, k: C.ink, Y: 0xee8833 })

/** The colors a river's water is drawn in: where the lake meets one, its mouth is left open. */
const RIVER_WATER = new Set<number>([C.water, C.waterDeep, C.waterLight, C.white])
const EDGE_K = 'K'.charCodeAt(0)
const EDGE_H = 'h'.charCodeAt(0)
const OPEN_B = 'b'.charCodeAt(0)

type LakeArt = { x0: number; y0: number; p: Pic; water: Uint8Array; lanes: { y: number; a: number; b: number }[]; spots: number[] }
const lakes = new Map<string, LakeArt>()

/**
 * Works out the still part of a lake once for its shape: the shore round the water, the water's depth, reeds and
 * lily pads, and where ducks may swim and ripples may show.
 */
function buildLake(one: boolean, rows: readonly { x: number; w: number }[], y0: number): LakeArt {
  const n = rows.length
  const reach = one ? 4 : 2
  const deepAt = one ? 9 : 5
  let lo = Infinity
  let hi = -Infinity
  let top = -1
  let bottom = -1
  rows.forEach((r, i) => {
    if (r.w <= 0) return
    lo = Math.min(lo, r.x)
    hi = Math.max(hi, r.x + r.w)
    if (top < 0) top = i
    bottom = i
  })
  if (top < 0) return { x0: 0, y0, p: blank(0, 0), water: new Uint8Array(0), lanes: [], spots: [] }
  const x0 = lo - reach - 2
  const W = hi - lo + 2 * reach + 4
  const H = n + 2 * reach + 2
  const top0 = y0 - reach - 1
  const p = blank(W, H)
  const water = new Uint8Array(W * H)
  const wet = (i: number, X: number) => {
    const r = rows[i]
    return r !== undefined && r.w > 0 && X >= r.x && X < r.x + r.w
  }
  /** Horizontal distance from X to row i's water (0 inside it), or Infinity for a dry row. */
  const gap = (i: number, X: number) => {
    const r = rows[i]
    if (!r || r.w <= 0) return Infinity
    return X < r.x ? r.x - X : X >= r.x + r.w ? X - (r.x + r.w - 1) : 0
  }
  const cx = (lo + hi) / 2
  const cy = (top + bottom) / 2
  for (let j = 0; j < H; j++) {
    const i = j + top0 - y0
    for (let u = 0; u < W; u++) {
      const X = x0 + u
      if (wet(i, X)) {
        water[j * W + u] = 1
        // how far in from the shore, round
        let d = Infinity
        for (let dy = -deepAt; dy <= deepAt; dy++) {
          const r = rows[i + dy]
          if (!wet(i + dy, X)) d = Math.min(d, Math.abs(dy))
          else if (r) d = Math.min(d, Math.hypot(dy, Math.min(X - r.x + 1, r.x + r.w - X)))
        }
        // the water's edge: in the far bank's shadow on the upper half, catching the light on the lower
        const edge = !wet(i - 1, X) || !wet(i + 1, X) || !wet(i, X - 1) || !wet(i, X + 1)
        const ch = edge ? (!wet(i - 1, X) || (wet(i + 1, X) && i < cy) ? 'K' : 'h') : d >= deepAt ? 'B' : 'b'
        put(p, u, j, ch)
        continue
      }
      let d = Infinity
      for (let dy = -reach; dy <= reach; dy++) d = Math.min(d, Math.hypot(dy, gap(i + dy, X)))
      if (d > reach) continue
      // the shore is wider here and narrower there, slowly, round the lake
      const a = Math.atan2(i - cy, (X - cx) * 0.5)
      const wide = (one ? 2.6 : 1.2) + (one ? 1.3 : 0.9) * (0.5 + 0.5 * Math.sin(a * 3 + 0.7))
      if (wet(i + 1, X)) put(p, u, j, 'e')
      else if (one && d <= 1.5) put(p, u, j, 'W')
      else if (d <= wide) put(p, u, j, 's')
    }
  }
  const letter = (u: number, j: number) => (u < 0 || j < 0 || u >= W || j >= H ? 0 : (p.px[j * W + u] ?? 0))
  const S = 's'.charCodeAt(0)
  const isWater = (u: number, j: number) => u >= 0 && j >= 0 && u < W && j < H && water[j * W + u] === 1
  // pebbles on the sand, lit on the left, few and apart; tufts of grass along the shore's outer edge
  if (one) {
    for (let j = 0; j < H; j++) {
      for (let u = 1; u < W - 2; u++) {
        const m = mixInt(x0 + u, top0 + j)
        if (m % 37 === 0 && letter(u, j) === S && letter(u + 1, j) === S && letter(u - 1, j) === S && letter(u + 2, j) === S) {
          put(p, u, j, 'o')
          put(p, u + 1, j, 'O')
        } else if (m % 23 === 0 && letter(u, j) === 0 && letter(u, j - 1) === 0 && letter(u + 1, j) === 0 && letter(u + 2, j) === 0) {
          // a tuft on the grass beside the sand: two blades, a V
          const near = letter(u + 1, j + 1) === S || letter(u + 1, j - 2) === S || letter(u - 1, j) === S || letter(u + 3, j) === S
          if (near) (put(p, u, j - 1, 't'), put(p, u + 2, j - 1, 't'), put(p, u + 1, j, 't'))
        }
      }
    }
  }
  // reeds where the shore turns: at the far left and right of the lake, and low on the left and high on the right
  const span = (i: number) => rows[i] ?? { x: 0, w: 0 }
  const rowAt = (f: number) => Math.round(top + (bottom - top) * f)
  const clumps = one ? REED_CLUMPS1 : REED_CLUMPS2
  const reed = (i: number, left: boolean, k: number) => {
    const r = span(i)
    if (r.w <= 0) return
    const c = clumps[k % clumps.length] ?? clumps[0]
    const u = (left ? r.x - (one ? 2 : 1) : r.x + r.w - c.w + (one ? 2 : 1)) - x0
    stamp(p, u, i + (y0 - top0) - c.h + 1, art(c))
  }
  let leftmost = top
  let rightmost = top
  for (let i = top; i <= bottom; i++) {
    if (span(i).x < span(leftmost).x) leftmost = i
    if (span(i).x + span(i).w > span(rightmost).x + span(rightmost).w) rightmost = i
  }
  reed(leftmost + (one ? 3 : 1), true, 0)
  reed(rowAt(0.82), true, 2)
  reed(rightmost + (one ? 2 : 1), false, 1)
  reed(rowAt(0.22), false, 2)
  // lily pads in a loose group in the shallows on the lower right, and two on the upper left
  const pads = one ? PADS1 : PADS2
  const padAt = (fx: number, fy: number, list: readonly number[]) => {
    const i = rowAt(fy)
    const r = span(i)
    if (r.w <= 0) return
    const X = Math.round(r.x + r.w * fx)
    for (let k = 0; k + 2 < list.length; k += 3) {
      const pd = pads[list[k + 2] ?? 0] ?? pads[0]
      const u = X - x0 + (list[k] ?? 0)
      const j = i + (y0 - top0) + (list[k + 1] ?? 0)
      let ok = true
      for (let b = -1; b <= pd.h && ok; b++) for (let a = -1; a <= pd.w && ok; a++) if (!isWater(u + a, j + b)) ok = false
      if (ok) stamp(p, u, j, art(pd))
    }
  }
  if (one) {
    padAt(0.66, 0.7, [0, 0, 0, 7, 1, 1, -2, 4, 2])
    padAt(0.2, 0.3, [0, 0, 1, 7, 2, 2])
  } else {
    padAt(0.66, 0.7, [0, 0, 0, 4, 1, 1])
    padAt(0.24, 0.3, [0, 0, 0])
  }
  // two lanes for the ducks, a third and three quarters of the way down (a boat may row across the middle), clear
  // of the shore
  const lanes: LakeArt['lanes'] = []
  const margin = one ? 8 : 4
  const duckW = one ? LAKE_DUCK1.w : LAKE_DUCK2.w
  for (const f of [0.34, 0.76]) {
    const i = rowAt(f)
    const r = span(i)
    if (r.w > 2 * margin + duckW + 4) lanes.push({ y: i + y0, a: r.x + margin, b: r.x + r.w - margin - duckW })
  }
  // where ripples may show: open water, three pixels clear of anything else on the row
  const spots: number[] = []
  const B = 'B'.charCodeAt(0)
  const b = 'b'.charCodeAt(0)
  const plain = (u: number, j: number) => letter(u, j) === B || letter(u, j) === b
  for (let j = 0; j < H; j++) {
    for (let u = 0; u < W; u++) {
      let ok = true
      for (let a = -3; a <= 6 && ok; a++) if (!plain(u + a, j) || !plain(u + a, j - 1) || !plain(u + a, j + 1)) ok = false
      if (ok) spots.push(x0 + u, top0 + j)
    }
  }
  return { x0, y0: top0, p, water, lanes, spots }
}

/** A picture back to rows of letters, to stamp it into another. */
function art(p: Pic) {
  const out: string[] = []
  for (let j = 0; j < p.h; j++) {
    let r = ''
    for (let i = 0; i < p.w; i++) {
      const ch = p.px[j * p.w + i] ?? 0
      r += ch ? String.fromCharCode(ch) : '.'
    }
    out.push(r)
  }
  return out
}

/** A well-mixed number from two integers: the same pixel always gets the same answer. */
function mixInt(a: number, b: number) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * A lake: for each canvas row `y0 + i`, water from column `rows[i].x` for `rows[i].w` pixels (a row with w 0 is
 * dry), its shore (sand, pebbles, tufts of grass, reeds and cattails) drawn just outside that span and closing
 * the lake above its first wet row and below its last; lily pads, ripples and two ducks moving with `anim`.
 * GROUND, so nothing rings it; drawn every frame for the rows in view. A lake is about 150 by 80 close-up.
 *
 * The still part is worked out once for each shape. The far (top) bank shows its face and throws a shadow along
 * the water's edge on the upper half; on the lower half the edge catches the light; the middle is deep. Where a
 * river runs in (its water already drawn), the shore leaves its mouth open.
 */
export function lake(pen: Pen, s: Scale, rows: readonly { x: number; w: number }[], y0: number, anim: number) {
  const one = s === 1
  let key = `${s}|${y0}|`
  for (const r of rows) key += `${r.x},${r.w};`
  let L = lakes.get(key)
  if (!L) {
    if (lakes.size > 6) lakes.clear()
    L = buildLake(one, rows, y0)
    lakes.set(key, L)
  }
  const art0 = L
  pen.as(GROUND, () => {
    // where a river runs in, its water stays open: no shore across its mouth, no edge line on the lake's side of it
    const { p, x0, y0: top, water } = art0
    const W = pen.w
    const river = (X: number, Y: number) => pen.inside(X, Y) && RIVER_WATER.has(pen.px[Y * W + X] ?? 0)
    const dry = (u: number, j: number) => u < 0 || j < 0 || u >= p.w || j >= p.h || water[j * p.w + u] !== 1
    for (let j = 0; j < p.h; j++) {
      for (let u = 0; u < p.w; u++) {
        let ch = p.px[j * p.w + u] ?? 0
        if (!ch) continue
        const X = x0 + u
        const Y = top + j
        if (!pen.inside(X, Y)) continue
        if (water[j * p.w + u] !== 1) {
          if (river(X, Y)) continue
        } else if (ch === EDGE_K || ch === EDGE_H) {
          if ((dry(u, j - 1) && river(X, Y - 1)) || (dry(u - 1, j) && river(X - 1, Y)) || (dry(u + 1, j) && river(X + 1, Y)) || (dry(u, j + 1) && river(X, Y + 1))) ch = OPEN_B
        }
        const c = LAKE_PAL[ch] ?? -1
        if (c >= 0) pen.dot(X, Y, c)
      }
    }
  })
  pen.as(OVERLAY, () => {
    // ripples: a few at a time, each a short light line that grows and goes, now and then a glint on one
    const spots = art0.spots
    const count = spots.length >> 1
    if (count > 0) {
      const slots = one ? 6 : 3
      const life = 16
      for (let k = 0; k < slots; k++) {
        const t = anim + k * Math.floor(life * 1.7 / slots) * 3
        const cycle = Math.floor(t / (life * 2))
        const age = t % (life * 2)
        if (age >= life) continue
        const m = mixInt(cycle * 7 + k, 91)
        const at = (m % count) * 2
        const X = spots[at] ?? 0
        const Y = spots[at + 1] ?? 0
        const len = one ? (age < 4 ? 2 : age < 11 ? 4 : 2) : age < 8 ? 1 : 2
        const from = X - (len >> 1)
        for (let i = 0; i < len; i++) pen.dot(from + i, Y, C.waterLight)
        if (one && m % 3 === 0 && age >= 5 && age < 7) pen.dot(X, Y, 0xeeffff)
      }
    }
    // two ducks paddling up and down their lanes, a little wake behind
    const duck = one ? LAKE_DUCK1 : LAKE_DUCK2
    art0.lanes.forEach((ln, k) => {
      const span = ln.b - ln.a
      if (span <= 0) return
      const step = slow(anim, one ? 2 : 4)
      const t = (step + k * Math.floor(span * 0.8)) % (span * 2)
      const back = t >= span
      const X = ln.a + (back ? span * 2 - t : t)
      const Y = ln.y - duck.h + 1
      paint(pen, duck, X, Y, LAKE_DUCK_PAL, back)
      const tail = back ? X + duck.w : X - 1
      const d = back ? 1 : -1
      if (one) {
        pen.dot(tail, ln.y, C.waterLight)
        pen.dot(tail + d, ln.y, C.waterLight)
        if (slow(anim, 2) % 2 === 0) pen.dot(tail + d * 2, ln.y, C.waterLight)
      } else if (slow(anim, 4) % 2 === 0) pen.dot(tail, ln.y, C.waterLight)
    })
  })
}

// ---- the pier

/**
 * A wooden fishing pier from the shore at (x, y) out over the water, `len` canvas pixels long, downward; 5 wide
 * close-up, 3 overview. Planks run across it, lit on the left, a joint every third row; two posts stand up at its
 * end; under the end the posts show, standing in the water (3 rows close-up, 2 overview, below `len`).
 * A person sits at its end, fishing.
 */
export function pier(pen: Pen, s: Scale, x: number, y: number, len: number) {
  const one = s === 1
  const w = one ? 5 : 3
  const post = 0x553311
  const cap = 0xddbb88
  pen.as(OBJECT, () => {
    for (let j = 0; j < len; j++) {
      const k = len - 1 - j
      const joint = k % 3 === 2
      for (let i = 0; i < w; i++) {
        const right = i === w - 1
        let c = joint ? (right ? C.woodDark : C.wood) : right ? C.wood : C.woodLight
        // the posts standing up at the end's corners, a lit cap on each
        if (one && (i === 0 || right) && k <= 1) c = k === 1 ? cap : post
        pen.dot(x + i, y + j, c)
      }
    }
    // the end's edge, in shade
    for (let i = 0; i < w; i++) pen.dot(x + i, y + len, C.woodDark)
  })
  // the posts under the end, standing in the water, the water lapping light round their feet
  pen.as(OVERLAY, () => {
    const deep = one ? 3 : 2
    for (const i of [0, w - 1]) for (let j = 1; j <= deep; j++) pen.dot(x + i, y + len + j, post)
    if (one) {
      pen.dot(x - 1, y + len + deep, C.waterLight)
      pen.dot(x + w, y + len + deep, C.waterLight)
    }
  })
}

// ---- the mountains

/**
 * The mountains' colors, cool and pale for the far range (a lit, c shaded), darker and greener for the near one
 * (A lit, C shaded, D deep); snow lit and shaded (n, N); E the line where the near range stands in front of the
 * far one.
 */
const MOUNT_PAL = pal({
  a: 0xaabbcc, c: 0x8899aa,
  A: 0x889988, C: 0x667766, D: 0x556655,
  n: 0xeeeeff, N: 0xccddee, E: C.edge,
})

/**
 * A peak: its apex (x, top), its top edge for each column out to the left and right, the slant of its ridge, and
 * how deep its snow is.
 */
type Peak = { x: number; top: number; left: number[]; right: number[]; ridge: number; near: boolean; snow: number }

/**
 * One side of a peak, as the row of its top edge for each column out from the apex: slopes in stretches of a few
 * columns, steep near the top and gentler lower down, a shoulder or a crag (the edge stepping back up a row or two)
 * now and then, until it reaches the foot.
 */
function slope(rand: () => number, top: number, foot: number, steep: number, crags: number) {
  const out: number[] = []
  let y = top
  let acc = top
  let s = steep
  while (y < foot && out.length < 400) {
    const run = 3 + Math.floor(rand() * 6)
    if (out.length > 4 && y - 2 > top + 3 && rand() < crags) {
      const up = 1 + Math.floor(rand() * 2)
      out.push(y - 1)
      if (up > 1) out.push(y - 2)
      out.push(y - up)
      acc = y - up
      y = y - up
    }
    const shoulder = out.length > 6 && rand() < 0.18
    const k = shoulder ? 0.15 : s * (0.7 + rand() * 0.6)
    for (let i = 0; i < run && y < foot; i++) {
      acc += k
      y = Math.floor(acc)
      out.push(Math.min(foot, y))
    }
    s = Math.max(0.45, s * 0.82)
  }
  return out
}

/**
 * The peaks of the one endless range that reach into close-up columns from..to: the far range's apexes one to a
 * stretch of 62 columns, the near range's one to a stretch of 76, each somewhere in its stretch. All from the
 * column, so boxes side by side show one unbroken range.
 */
function peaks(from: number, to: number, h: number): Peak[] {
  const out: Peak[] = []
  const reach = 150
  for (let n = Math.floor((from - reach) / 62); n * 62 < to + reach; n++) {
    const rand = seeded(mixInt(n, 3))
    const x = n * 62 + Math.floor(rand() * 26)
    const top = Math.floor(rand() * h * 0.25)
    out.push({ x, top, left: slope(rand, top, h, 1.6, 0.22), right: slope(rand, top, h, 1.4, 0.22), ridge: 0.22 + rand() * 0.2, near: false, snow: Math.round(h * (0.2 + rand() * 0.12)) })
  }
  for (let n = Math.floor((from - reach) / 76); n * 76 < to + reach; n++) {
    const rand = seeded(mixInt(n, 7))
    const x = n * 76 + 30 + Math.floor(rand() * 32)
    const top = Math.floor(h * (0.45 + rand() * 0.2))
    out.push({ x, top, left: slope(rand, top, h, 1.1, 0.08), right: slope(rand, top, h, 1.0, 0.08), ridge: 0.3 + rand() * 0.2, near: true, snow: 0 })
  }
  return out
}

/** The top edge of a peak at column x (close-up units), or Infinity outside it. */
function peakTop(p: Peak, x: number) {
  const dx = Math.floor(x) - p.x
  if (dx === 0) return p.top
  const side = dx < 0 ? p.left : p.right
  const v = side[Math.abs(dx) - 1]
  return v === undefined ? Infinity : v
}

/** The straight line from a peak's apex to where each side reaches the foot: its slopes without crags and shoulders. */
function peakCone(p: Peak, x: number, foot: number) {
  const dx = Math.floor(x) - p.x
  const side = dx < 0 ? p.left : p.right
  return p.top + (Math.abs(dx) * (foot - p.top)) / Math.max(1, side.length)
}

/** Snow's lower edge below a peak's top at column x: deeper down the gullies, in bands three columns wide. */
function snowLine(p: Peak, x: number) {
  const dx = x - p.x
  const band = Math.floor(dx / 3)
  const gully = mixInt(band, p.x) % 4 === 0 ? 3 + (mixInt(band, p.top) % 4) : 0
  return p.top + p.snow - Math.abs(dx) * 0.35 + gully
}

/**
 * The range as a picture W by H at one scale, from the peaks' shapes worked out close-up; `from` is the close-up
 * column of its left edge along the range.
 */
function buildMountains(one: boolean, W: number, H: number, from: number, alone: boolean) {
  const k = one ? 1 : 0.5
  const h = Math.round(H / k)
  const wide = W / k
  /**
   * A massif standing alone falls away to its foot at both ends: no rock above this row in close-up column X.
   * Full height across its middle, down to nothing at the ends, the slope a little uneven.
   */
  const floor = (X: number) => {
    if (!alone) return 0
    const t = (X - from) / wide
    const e = Math.max(0, Math.min(1, Math.min(t, 1 - t) / 0.3))
    if (e >= 1) return 0
    return h * (1 - e * e * (3 - 2 * e)) + Math.sin(X / 5.3 + from) * 2 + Math.sin(X / 2.1) * 0.8
  }
  const list = peaks(from, from + W / k, h)
  const p = blank(W, H)
  const near = list.filter(q => q.near)
  const far = list.filter(q => !q.near)
  /**
   * The peak of a layer that owns (X, Y) close-up, or undefined: where two overlap the lower one stands in front,
   * so the fold between them is its own slope.
   */
  const owner = (layer: Peak[], X: number, Y: number) => {
    let best: Peak | undefined
    // the crags and shoulders only shape the skyline: inside, each peak's slopes are taken as straight
    for (const q of layer) if (peakTop(q, X) <= Y && peakCone(q, X, h) <= Y && (!best || q.top > best.top)) best = q
    if (!best) for (const q of layer) if (peakTop(q, X) <= Y && (!best || q.top > best.top)) best = q
    return best
  }
  const shadeOf = (q: Peak, X: number, Y: number, lit: string, dark: string, deep: string) => {
    const dy = Y - q.top
    if (X <= q.x + dy * q.ridge) return lit
    const second = q.x + (h - q.top) * 0.6 + dy * 0.1
    return X > second && dy > (h - q.top) * 0.4 ? deep : dark
  }
  const nearAt = (u: number, v: number) => {
    const X = from + (u + 0.5) / k
    const Y = (v + 0.5) / k
    return Y >= floor(X) && near.some(q => peakTop(q, X) <= Y)
  }
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const X = from + (u + 0.5) / k
      const Y = (v + 0.5) / k
      if (Y < floor(X) || (alone && Y > h - 1 - Math.max(0, Math.round(1.5 + Math.sin(X / 9 + from) * 1.5 + Math.sin(X / 3.7))))) continue
      const qn = owner(near, X, Y)
      if (qn) {
        put(p, u, v, shadeOf(qn, X, Y, 'A', 'C', 'D'))
        continue
      }
      const qf = owner(far, X, Y)
      if (!qf) continue
      // the far range: snow down to its line, a dark line where the near range rises in front
      if (nearAt(u, v + 1) || nearAt(u - 1, v + 1) || nearAt(u + 1, v + 1)) {
        put(p, u, v, 'E')
        continue
      }
      const ch = shadeOf(qf, X, Y, 'a', 'c', 'c')
      put(p, u, v, Y < snowLine(qf, X) ? (ch === 'a' ? 'n' : 'N') : ch)
    }
  }
  return p
}

/**
 * Where pines stand at the range's foot, as close-up columns along it, from..to: clusters of two or three now and
 * then, each pine a row or two up or down.
 */
function footPines(from: number, to: number) {
  const out: { x: number; dy: number }[] = []
  for (let n = Math.floor((from - 40) / 104); n * 104 < to; n++) {
    const rand = seeded(mixInt(n, 41))
    if (rand() < 0.25) continue
    const x = n * 104 + Math.floor(rand() * 64)
    const count = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < count; i++) {
      const px = x + i * 7 + Math.floor(rand() * 2)
      const dy = Math.floor(rand() * 3)
      if (px + 11 > from && px < to) out.push({ x: px, dy })
    }
  }
  return out.sort((a, b) => a.dy - b.dy)
}

const mountainArt = new Map<string, Pic>()

/**
 * Rocky mountains with snowy peaks filling (x, y, w, h), w and h in canvas pixels at this scale (up to 400 by 70
 * close-up, half that at overview): a far range of tall pale peaks with snow, a lower, darker and greener range in
 * front, and a few pines at the foot. OBJECT, so the engine rings it; its foot is the box's bottom row.
 *
 * The range is one endless skyline and `seed` is where along it (in close-up columns) the box starts: boxes side
 * by side, each given its own close-up x as seed, join without a seam. `alone` makes the box a massif of its own
 * instead, falling away to its foot at both ends, with open land round it.
 */
export function mountains(pen: Pen, s: Scale, x: number, y: number, w: number, h: number, seed: number, alone = false) {
  const one = s === 1
  const key = `${s}|${w}|${h}|${seed}|${alone}`
  let p = mountainArt.get(key)
  if (!p) {
    if (mountainArt.size > 40) mountainArt.clear()
    p = buildMountains(one, w, h, seed, alone)
    mountainArt.set(key, p)
  }
  const pic0 = p
  pen.as(OBJECT, () => paint(pen, pic0, x, y, MOUNT_PAL))
  const k = one ? 1 : 0.5
  const foot = y + pic0.h
  for (const t of footPines(seed, seed + w / k)) {
    tree(pen, s, x + Math.floor((t.x - seed) * k), foot - (one ? 12 : 7) + (one ? t.dy : t.dy >> 1), 'pine')
  }
}
