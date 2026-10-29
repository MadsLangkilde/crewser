// The town's works: the blacksmith, the sawmill, the warehouse, the windmill, farms and their fields, docks, the
// harbor and the lighthouse. Each in its footprint from kinds.ts, at two scales with art of its own (the overview is
// the close-up simplified, never shrunk), built from strict square pixels: no dithering, no lone specks.
//
//  - blacksmith: a stone forge, its brick hearth glowing through an arched front, a smoking chimney, an anvil on a
//    stump, a horseshoe sign. 2 a dormer and a rack with a shield in the builder's color, 3 a great chimney stack.
//  - sawmill: a stone wheelhouse with its water wheel turning in the race, the saw in an open bay, logs piled up.
//    2 a stack of sawn planks, 3 a hoist dormer with a log on its rope and a second pile.
//  - warehouse: a tall store under a steep gable, a hoist over the loft door, great iron-strapped doors, crates and
//    barrels. 2 a crate on the hoist's rope and more crates, 3 a lean-to.
//  - windmill: a white tower in three courses, a cap and sails of canvas dyed in the builder's color, turning.
//    2 a gallery round it, 3 a stone ground floor and sacks of flour.
//  - farm: a red gambrel barn with a hayloft and white-braced doors, the farmhouse, a haystack, a hay cart, a fence.
//    2 a silo, 3 a cupola on the barn.
//  - field: tilled rows of its crop, each crop its own colors and shapes so it is known from afar. 2 a scarecrow,
//    3 a fence with a lantern at the gate, 4 a harvest cart, 5 pennants and a gilded hat.
//  - dock: a jetty out over the water, posts along it, a rowing boat tied up. 2 a sailing boat, 3 a boathouse,
//    4 lanterns, 5 pennants.
//  - harbor: a stone quay, a jib crane lowering a crate onto a ship, crates and barrels, bollards, a lamp. 2 a
//    sailing boat, 3 a second crane, 4 the harbor master's house.
//  - lighthouse: a banded (or, by style, spiralled) tower on the rocks, its lamp glowing and its beam turning at
//    night. 2 a stone foot, 3 the keeper's hut, 4 a gilded lantern.
// Level 4 gilds every eave and ridge, level 5 hangs banners and flies a flag. Roofs, sails, flags and hulls are in
// the builder's color; `style` picks the stone (grey, sandstone, brick, slate) and plaster (cream, whitewash,
// ochre), and turns ships, swaps boats, spirals the lighthouse, moves the scarecrow.
//
// A first build goes up in stages over `progress` like the houses (footing, frame, walls, roof), a field is
// ploughed, sprouts, grows green and ripens, a dock gets its posts then its planks. While `building`, scaffolding
// and a pile of materials. A fire chars it, caves its roof in from 7000 ms, drops its walls from 8400 and leaves
// ruins at 9000 whose embers die by 16000 and smoke thins out by 26000; a field burns as a crop fire sweeping
// across and leaves scorched rows, a dock leaves charred posts in the water, ships burn and sink.
import { C, GROUND, OBJECT, OVERLAY, blend, shade, type Pen, type Scale } from './kit'
import type { BuildLook, Crop } from './kinds'

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Where each stage of a first build begins and ends on `progress`. */
const STAGES = { foundation: [0, 0.18], frame: [0.18, 0.42], walls: [0.42, 0.72], roof: [0.72, 1] } as const
type Stage = keyof typeof STAGES | 'done'

/** A fire's timeline (ms since it caught): the roof caves in, the walls fall, embers die, the smoke clears. */
const BURN = { roofFalls: 7000, wallsFall: 8400, ruins: 9000, embers: 16000, smoke: 26000 } as const

function stageOf(look: BuildLook): { stage: Stage; within: number } {
  if (look.level >= 1) return { stage: 'done', within: 1 }
  const p = look.progress
  const stage: Stage = p < STAGES.foundation[1] ? 'foundation' : p < STAGES.frame[1] ? 'frame' : p < STAGES.walls[1] ? 'walls' : p < 1 ? 'roof' : 'done'
  if (stage === 'done') return { stage, within: 1 }
  const [a, b] = STAGES[stage]
  return { stage, within: clamp((p - a) / (b - a)) }
}

// ---- colors: every shade on the terminal's 12-bit grid (steps of 17), well apart from its neighbours

const S = {
  inside: 0x221111, woodDeep: 0x442211, ironMid: 0x778899, glassHi: 0x556677, lantern: 0xeeeecc,
  barn: 0xaa3322, barnShade: 0x882222, barnLight: 0xcc4433,
  hayWind: 0xffeeaa, hayLight: 0xeedd88, hay: 0xddbb55, hayShade: 0xbb9933, hayDark: 0x997722,
  gH: 0xaacc66, gL: 0x77aa44, gM: 0x559933, gD: 0x447733, gE: 0x335533,
  canvas: 0xeeeedd, canvasShade: 0xccccbb, rope: 0xddccaa,
  soil: 0x775533, soilDark: 0x553322, soilLight: 0x886644, furrow: 0x664433,
  log: 0xaa7744, logEnd: 0xddbb88, logRing: 0xbb8855, bark: 0x664422,
  crate: 0xbb8844, crateLight: 0xddaa66, crateDark: 0x885522,
  steelLight: 0xaabbcc, steel: 0x8899aa, sack: 0xccaa77, sackShade: 0xaa8855,
} as const

/** A palette: letter (by char code) to color, -1 leaving the pixel alone. */
type Pal = Int32Array

/** Letters with a fixed color. */
const FIXED: Readonly<Record<string, number>> = {
  T: C.timber, P: C.plaster, p: C.plasterShade, W: C.white, V: S.canvasShade, G: C.glass, g: S.glassHi,
  D: C.door, d: C.woodDark, B: C.wood, w: C.woodLight, o: S.woodDeep, O: S.inside,
  S: C.stone, s: C.stoneLight, K: C.stoneDark, M: C.mortar,
  i: C.iron, m: S.ironMid, I: C.ironDark, k: C.gold, j: C.goldDark,
  F: C.fire[0], f: C.fire[1], E: C.fire[2],
  H: S.hayLight, Y: S.hay, z: S.hayShade, Z: S.hayDark,
  A: S.barn, a: S.barnShade, '!': S.barnLight,
  l: S.gL, q: S.gM, Q: S.gD, N: S.canvas, v: S.canvasShade, t: S.rope,
  u: C.water, U: C.waterDeep, y: C.waterLight, X: C.char, J: C.ash, '*': S.lantern,
  '1': S.crateLight, '2': S.crate, '3': S.crateDark, '4': S.log, '5': S.logEnd, '6': S.logRing, '7': S.bark,
  '8': C.rockLight, '9': C.rock, '0': C.rockDark,
  '#': S.steelLight, '$': S.steel, '%': S.sack, '&': S.sackShade, '+': S.soil, '-': S.soilDark, '=': S.gH, '~': S.gE,
}

const pals = new Map<number, Pal>()

/**
 * What a building is made of, from its `style`: its stone (grey, sandstone, red brick, slate; letters S s K M) and
 * its plaster (cream, whitewash, ochre; letters P p W V). Every shade on the 12-bit grid.
 */
const STONES = [
  [C.stone, C.stoneLight, C.stoneDark, C.mortar],
  [0xbbaa88, 0xddccaa, 0x998866, 0x776655],
  [0xaa5544, 0xcc7766, 0x884433, 0xccbbaa],
  [0x8899aa, 0xaabbcc, 0x667788, 0x556677],
] as const
const PLASTERS = [
  [C.plaster, C.plasterShade, C.white, S.canvasShade],
  [0xeeeeee, 0xccddee, 0xffffff, 0xbbccdd],
  [0xeeddaa, 0xddbb88, 0xffeecc, 0xccaa77],
] as const

/**
 * The palette for a builder's color. Color letters: R the roof, L its lit slope, h its shaded slope, n and x a
 * course of tiles on each, e the eave and r the ridge (gold when `gilded`), b the color itself (flags, sails,
 * hulls, banners) and c its shade. A color close to the grass is darkened a little so a roof stands apart from
 * it, and a golden one under gold trim so the trim still shows. `style` picks the stone and plaster.
 */
function palOf(color: number, gilded: boolean, style = 0): Pal {
  const st = ((style % 4) + 4) % 4
  const pl = ((Math.floor(style / 4) % 3) + 3) % 3
  const key = (color * 2 + (gilded ? 1 : 0)) * 16 + st * 4 + pl
  let a = pals.get(key)
  if (a) return a
  if (pals.size > 64) pals.clear()
  const red = (color >> 16) & 255
  const g = (color >> 8) & 255
  const b = color & 255
  const greenish = g > red + 30 && g > b + 30
  const golden = red > 150 && g > 110 && b < 110 && red - g < 75
  const base = greenish ? shade(color, 0.86) : gilded && golden ? shade(color, 0.84) : color
  a = new Int32Array(128).fill(-1)
  const set = (ch: string, c: number) => (a![ch.charCodeAt(0)] = c)
  for (const ch of Object.keys(FIXED)) set(ch, FIXED[ch] ?? 0)
  const stone = STONES[st] ?? STONES[0]
  const plaster = PLASTERS[pl] ?? PLASTERS[0]
  ;['S', 's', 'K', 'M'].forEach((ch, i) => set(ch, stone[i] ?? 0))
  ;['P', 'p', 'W', 'V'].forEach((ch, i) => set(ch, plaster[i] ?? 0))
  set('R', base)
  set('L', blend(base, 0xffffff, 0.26))
  set('h', shade(base, 0.72))
  set('n', shade(base, 0.86))
  set('x', shade(base, 0.6))
  set('e', gilded ? C.gold : shade(base, 0.45))
  set('r', gilded ? C.gold : blend(base, 0xffffff, 0.26))
  set('b', color)
  set('c', shade(color, 0.72))
  pals.set(key, a)
  return a
}

/** Charring: a color darkened toward soot by `step` (0..5). */
const chars = new Map<number, number>()
function charOf(c: number, step: number) {
  const key = c * 8 + step
  let v = chars.get(key)
  if (v === undefined) {
    if (chars.size > 4096) chars.clear()
    chars.set(key, (v = blend(c, C.char, step * 0.16)))
  }
  return v
}

/** Darkens every OBJECT pixel in a box toward soot. */
function char(pen: Pen, x0: number, y0: number, w: number, h: number, step: number) {
  if (step <= 0) return
  for (let y = Math.max(0, y0); y < Math.min(pen.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(pen.w, x0 + w); x++) {
      const i = y * pen.w + x
      if (pen.kind[i] === OBJECT) pen.px[i] = charOf(pen.px[i] ?? 0, step)
    }
  }
}

// ---- pictures: rows of letters, '.' (or a letter not in the palette) clear

type Rows = readonly string[]

/** Paints rows `from`..`to`-1 of a picture; the last of them only up to column `cut` (a row being laid). */
function paint(pen: Pen, rows: Rows, X: number, Y: number, pal: Pal, from = 0, to = rows.length, cut = 1 << 20) {
  for (let j = Math.max(0, from); j < Math.min(to, rows.length); j++) {
    const r = rows[j] ?? ''
    const n = j === to - 1 ? Math.min(cut, r.length) : r.length
    for (let i = 0; i < n; i++) {
      const c = pal[r.charCodeAt(i)] ?? -1
      if (c >= 0) pen.dot(X + i, Y + j, c)
    }
  }
}

/** Where a picture's lights are, as x, y and letter, worked out once per picture. */
const spots = new WeakMap<Rows, number[]>()
function spotsOf(rows: Rows) {
  let out = spots.get(rows)
  if (out) return out
  out = []
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      const ch = r[i]
      if (ch === 'G' || ch === 'g' || ch === '*' || ch === 'F' || ch === 'f' || ch === 'E') out.push(i, j, r.charCodeAt(i))
    }
  }
  spots.set(rows, out)
  return out
}

const LIGHT_G = 'G'.charCodeAt(0)
const LIGHT_g = 'g'.charCodeAt(0)
const LIGHT_STAR = '*'.charCodeAt(0)
const LIGHT_F = 'F'.charCodeAt(0)
const LIGHT_f = 'f'.charCodeAt(0)

/** Light from a picture: windows (G, g) and lanterns (*) when `lit`, a hearth (F, f, E) always, flames in the windows when burning. */
function lights(pen: Pen, rows: Rows, X: number, Y: number, lit: boolean, fire: number, anim: number, from = 0) {
  const sp = spotsOf(rows)
  for (let k = 0; k + 2 < sp.length; k += 3) {
    const i = sp[k] ?? 0
    const j = sp[k + 1] ?? 0
    if (j < from) continue
    const ch = sp[k + 2]
    if (ch === LIGHT_G || ch === LIGHT_g) {
      if (fire >= 0) pen.glow(X + i, Y + j, (i + j + anim) % 3 === 0 ? C.fire[0] : (i * 3 + j + anim) % 4 === 0 ? C.fire[2] : C.fire[1])
      else if (lit) pen.glow(X + i, Y + j, C.lit)
    } else if (ch === LIGHT_STAR) {
      if (lit || fire >= 0) pen.glow(X + i, Y + j, C.lit)
    } else {
      const f = (i * 5 + j * 3 + anim) % 7
      pen.glow(X + i, Y + j, ch === LIGHT_F ? (f === 0 ? C.fire[1] : C.fire[0]) : ch === LIGHT_f ? (f === 0 ? C.fire[0] : C.fire[1]) : f < 2 ? C.fire[1] : C.fire[2])
    }
  }
}

// ---- a works building: its parts, and how it goes up, grows, burns and falls

/** What a part is: there before anything, the footing, walls, roof, or a thing set out once it is finished. */
type Cls = 'base' | 'found' | 'wall' | 'roof' | 'prop'

/** A picture placed in the footprint, drawn from level `lv` and below level `max`. */
type Part = { readonly cls: Cls; readonly x: number; readonly y: number; readonly rows: Rows; readonly lv: number; readonly max: number }
const part = (cls: Cls, x: number, y: number, rows: Rows, lv = 1, max = 9): Part => ({ cls, x, y, rows, lv, max })

/** The roof's letters: a picture drawn whole is split into its walls and its roof, built at their own stages. */
const ROOF_LETTERS = new Set(['R', 'L', 'h', 'n', 'x', 'e', 'r'])
function split(x: number, y: number, rows: Rows, lv = 1, max = 9): Part[] {
  const wall = rows.map(r => [...r].map(ch => (ROOF_LETTERS.has(ch) ? '.' : ch)).join(''))
  const roof = rows.map(r => [...r].map(ch => (ROOF_LETTERS.has(ch) ? ch : '.')).join(''))
  // trim rows that are empty at the top of each so their stages start where they have pixels
  const trim = (rs: string[]) => {
    let a = 0
    while (a < rs.length && !/[^.]/.test(rs[a] ?? '')) a++
    let b = rs.length
    while (b > a && !/[^.]/.test(rs[b - 1] ?? '')) b--
    return { from: a, rows: rs.slice(a, b) }
  }
  const w = trim(wall)
  const r = trim(roof)
  const out: Part[] = []
  if (w.rows.length) out.push(part('wall', x, y + w.from, w.rows, lv, max))
  if (r.rows.length) out.push(part('roof', x, y + r.from, r.rows, lv, max))
  return out
}

/** A picture mirrored left to right. */
const flipped = (rows: Rows): Rows => rows.map(r => [...r].reverse().join(''))

/** One kind at one scale. */
type Art = {
  w: number
  h: number
  /** Painted in order; each class shows at its stage of a first build. */
  parts: readonly Part[]
  /** Columns where flames rise when it burns. */
  fire: readonly number[]
  /** Chimneys: smoke rises from (x, y) once it stands, from level `lv`. */
  smoke: readonly (readonly [number, number, number])[]
  /** Scaffolding: the ladder's column, the far pole's column, the row of the top plank. */
  ladder: number
  pole: number
  deck: number
  /** The row the scaffolding stands on (the footprint's bottom row if not given), and the pile's top-left. */
  ground?: number
  pile?: readonly [number, number]
  /** Level 5: where each banner hangs (its top-left). */
  banners: readonly (readonly [number, number])[]
  /** A flag on a pole (its column, the row it stands on) from level `lv`. */
  flags: readonly (readonly [number, number, number])[]
  /** The footing is dug out first (seen from above) before its stones are laid. */
  pit: boolean
  /** The ruins: the heap from column x0 to x1 on row `ground`; charred posts at the columns in `posts`. */
  ruin: { x0: number; x1: number; ground: number; posts: readonly number[]; stump?: readonly [number, number, number] }
}

/** What an art works out to, once: the frame of every wall and roof, the top of what stands per column. */
type Shape = {
  art: Art
  /** Each post as its pixels from the bottom up: the outer ones follow the wall's outline. */
  posts: number[][]
  plates: { x0: number; x1: number; y: number }[]
  /** The roofs' outlines: for each roof, per row from its eave up, the ends of each run. */
  rafters: { eave: number; rows: number[][] }[]
  top: number[]
  wallTop: number
}

const shapes = new Map<Art, Shape>()

function ends(row: string) {
  const out: number[] = []
  let i = 0
  while (i < row.length) {
    while (i < row.length && row[i] === '.') i++
    if (i >= row.length) break
    const a = i
    while (i < row.length && row[i] !== '.') i++
    out.push(a, i - 1)
  }
  return out
}

function shapeOf(a: Art, big: boolean): Shape {
  let sh = shapes.get(a)
  if (sh) return sh
  const posts: Shape['posts'] = []
  const plates: Shape['plates'] = []
  const rafters: Shape['rafters'] = []
  const top: number[] = new Array(a.w).fill(a.h)
  let wallTop = a.h
  for (const p of a.parts) {
    if (p.lv > 1 || (p.cls !== 'wall' && p.cls !== 'roof')) continue
    p.rows.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) if (r[i] !== '.' && p.y + j < (top[p.x + i] ?? 0)) top[p.x + i] = p.y + j
    })
    if (p.cls === 'wall') {
      wallTop = Math.min(wallTop, p.y)
      const last = p.rows.length - 1
      const e = ends(p.rows[last] ?? '')
      for (let k = 0; k + 1 < e.length; k += 2) {
        const l = e[k] ?? 0
        const r = e[k + 1] ?? 0
        // the outer posts climb the wall's outline, so a tower's frame tapers with it
        const left: number[] = []
        const right: number[] = []
        let topRow = last
        for (let j = last; j >= 0; j--) {
          const ej = ends(p.rows[j] ?? '').filter(c => c >= l - 3 && c <= r + 3)
          if (!ej.length) break
          topRow = j
          left.push(p.x + (ej[0] ?? l), p.y + j)
          right.push(p.x + (ej[ej.length - 1] ?? r), p.y + j)
        }
        posts.push(left, right)
        if (big) {
          for (let c = l + 7; c < r - 3; c += 7) {
            const pts: number[] = []
            for (let j = last; j >= 0 && (p.rows[j] ?? '')[c] !== undefined && (p.rows[j] ?? '')[c] !== '.'; j--) pts.push(p.x + c, p.y + j)
            posts.push(pts)
          }
        }
        const te = ends(p.rows[topRow] ?? '')
        plates.push({ x0: p.x + (te[0] ?? l), x1: p.x + (te[te.length - 1] ?? r), y: p.y + topRow })
        const mj = topRow + ((last - topRow) >> 1)
        const me = ends(p.rows[mj] ?? '')
        if (big && last - topRow >= 6) plates.push({ x0: p.x + (me[0] ?? l), x1: p.x + (me[me.length - 1] ?? r), y: p.y + mj })
      }
    } else {
      const rows: number[][] = []
      for (let j = p.rows.length - 1; j >= 0; j--) rows.push(ends(p.rows[j] ?? '').map(c => c + p.x))
      rafters.push({ eave: p.y + p.rows.length - 1, rows })
    }
  }
  sh = { art: a, posts, plates, rafters, top, wallTop }
  shapes.set(a, sh)
  return sh
}

/** Is this part there now: built far enough, at this level? */
function shows(p: Part, lv: number) {
  return p.lv <= lv && lv < p.max
}

/** The timber skeleton, `f` 0..1: posts rise one by one, then the plates, then rafters climb the roofs' outlines. */
function frame(pen: Pen, X: number, Y: number, sh: Shape, f: number) {
  sh.posts.forEach((p, k) => {
    const grown = clamp((f - k * 0.05) / 0.12)
    const n = Math.round(grown * (p.length >> 1))
    for (let i = 0; i < n; i++) pen.dot(X + (p[i * 2] ?? 0), Y + (p[i * 2 + 1] ?? 0), C.wood)
  })
  if (f > 0.4) for (const p of sh.plates) for (let c = p.x0; c <= p.x1; c++) pen.dot(X + c, Y + p.y, C.wood)
  const rf = clamp((f - 0.5) / 0.5)
  if (rf <= 0) return
  for (const rr of sh.rafters) {
    const n = rr.rows.length
    const up = Math.round(rf * (n - 1))
    for (let j = 0; j <= up; j++) {
      const e = rr.rows[j] ?? []
      const full = j === 0 || (j === n - 1 && rf >= 1)
      for (let k = 0; k + 1 < e.length; k += 2) {
        const l = e[k] ?? 0
        const r = e[k + 1] ?? 0
        if (full) for (let c = l; c <= r; c++) pen.dot(X + c, Y + rr.eave - j, C.woodLight)
        else (pen.dot(X + l, Y + rr.eave - j, C.woodLight), pen.dot(X + r, Y + rr.eave - j, C.woodLight))
      }
    }
  }
}

/** The footing: a pit dug out (seen from above), stones laid along its front, up its sides, along its back as `f` goes 0..1; stakes and strings. */
function footing(pen: Pen, X: number, Y: number, a: Art, pal: Pal, f: number, strings: boolean, big: boolean) {
  for (const p of a.parts) {
    if (p.cls !== 'found' || p.lv > 1) continue
    const w = Math.max(0, ...p.rows.map(r => r.length))
    const x0 = p.x
    const x1 = p.x + w - 1
    const depth = big ? 9 : 4
    const back = p.y - depth
    if (a.pit) {
      pen.as(GROUND, () => pen.rect(X + x0 + (big ? 2 : 1), Y + back + (big ? 2 : 1), w - (big ? 4 : 2), depth - (big ? 2 : 1), C.roadEdge))
    }
    const front = a.pit ? clamp(f / 0.4) : f
    const fc = Math.round(front * w)
    for (let j = 0; j < p.rows.length; j++) paint(pen, [(p.rows[j] ?? '').slice(0, fc)], X + x0, Y + p.y + j, pal)
    if (!a.pit) continue
    const sides = clamp((f - 0.4) / 0.3)
    const rear = clamp((f - 0.7) / 0.3)
    const sc = Math.round(sides * (depth - 1))
    const light = pal['s'.charCodeAt(0)] ?? C.stoneLight
    const mid = pal['S'.charCodeAt(0)] ?? C.stone
    const dark = pal['K'.charCodeAt(0)] ?? C.stoneDark
    for (let k = 0; k < sc; k++) {
      const r = p.y - 1 - k
      pen.dot(X + x0, Y + r, light)
      pen.dot(X + x1, Y + r, light)
      if (big) (pen.dot(X + x0 + 1, Y + r, mid), pen.dot(X + x1 - 1, Y + r, mid))
    }
    const bc = Math.round(rear * w)
    for (let i = 0; i < bc; i++) {
      pen.dot(X + x0 + i, Y + back, light)
      if (big) pen.dot(X + x0 + i, Y + back + 1, i < 2 || i > w - 3 ? light : dark)
    }
    // stakes at the corners, a string between them where no stone lies yet
    if (big) for (const c of [x0 - 1, x1 + 1]) for (let j = 0; j < 3; j++) pen.dot(X + c, Y + back - 2 + j, j === 0 ? C.woodLight : C.wood)
    else for (const c of [x0, x1]) pen.dot(X + c, Y + back - 1, C.woodLight)
    if (strings && rear < 1) pen.as(OVERLAY, () => { for (let c = x0; c <= x1; c++) pen.dot(X + c, Y + back - (big ? 2 : 1), C.paper) })
  }
}

/** Scaffolding: a ladder (close-up) or a pole on the left, poles on the right, planks across. */
function scaffold(pen: Pen, X: number, Y: number, a: Art, big: boolean, across: boolean) {
  const bottom = a.ground ?? a.h - 1
  const top = a.deck
  if (big) {
    for (let r = top; r <= bottom; r++) {
      pen.dot(X + a.ladder, Y + r, C.wood)
      pen.dot(X + a.ladder + 2, Y + r, C.wood)
      if ((r - top) % 3 === 1) pen.dot(X + a.ladder + 1, Y + r, C.woodLight)
    }
    for (let r = top - 1; r <= bottom; r++) (pen.dot(X + a.pole, Y + r, C.wood), pen.dot(X + a.pole - 3, Y + r, C.woodDark))
    const mid = top + Math.round((bottom - top) * 0.55)
    for (const r of [top + 1, mid]) for (let c = across ? a.ladder : a.pole - 5; c <= a.pole; c++) (pen.dot(X + c, Y + r, C.woodLight), pen.dot(X + c, Y + r + 1, C.woodDark))
  } else {
    for (let r = top; r <= bottom; r++) (pen.dot(X + a.ladder, Y + r, C.wood), pen.dot(X + a.pole, Y + r, C.wood))
    for (let c = a.ladder; c <= a.pole; c++) if (across || c < a.ladder + 3 || c > a.pole - 3) pen.dot(X + c, Y + top + 1, C.woodLight)
  }
}

/** The builder's pile of planks and stones, in the footprint's bottom-left corner. */
const CU_PILE = ['..sK..', '.sSSK.', 'sSSKSK', 'wwwwww', 'BBBBBB', 'dwwwwd'] as const
const OV_PILE = ['.s.', 'sSK', 'www', 'BBB'] as const

function pile(pen: Pen, X: number, Y: number, a: Art, pal: Pal, big: boolean) {
  const p = big ? CU_PILE : OV_PILE
  if (a.pile) paint(pen, p, X + a.pile[0], Y + a.pile[1], pal)
  else paint(pen, p, X, Y + a.h - p.length, pal)
}

/** The flag in the builder's color on a pole standing on row `on` at column `c`, its tip flapping. */
function flag(pen: Pen, X: number, Y: number, c: number, on: number, pal: Pal, anim: number, big: boolean) {
  const len = big ? 5 : 3
  const top = on - len
  for (let r = top; r < on; r++) pen.dot(X + c, Y + r, C.woodLight)
  const fl = pal['b'.charCodeAt(0)] ?? 0
  const fd = pal['c'.charCodeAt(0)] ?? 0
  const wave = anim % 2
  const n = big ? 4 : 2
  for (let i = 1; i <= n; i++) {
    const dy = i === n ? wave : 0
    pen.dot(X + c + i, Y + top + dy, fl)
    if (big) pen.dot(X + c + i, Y + top + 1 + dy, i > 1 ? fd : fl)
  }
}

/** Level 5's banner: close-up 2 wide (a gold rod, the cloth with a gold boss), overview a pixel wide. */
const CU_BANNER = ['kk', 'bb', 'bb', 'bk', 'bb', 'b.'] as const
const OV_BANNER = ['k', 'b', 'b'] as const

// ---- fire and smoke

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
 * A plume of smoke rising `rise` rows from (cx, y): puffs leave from across the fire, grow as they climb, drift
 * downwind and pale. `thick` 0..1 how dark, `size` the puffs' size (close-up 4, overview 2). OVERLAY.
 */
function smoke(pen: Pen, cx: number, y: number, n: number, rise: number, big: boolean, anim: number, thick: number, size0 = big ? 4 : 2, spread = 1) {
  pen.as(OVERLAY, () => {
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
      const size = size0 + Math.floor(v * (big ? 3 : 1.8))
      const from = (((k * 3) % 5) - 2) * (big ? 3 : 1.5) * spread
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
  })
}

/** A chimney's own smoke: a few small puffs, growing and paling as they drift off. */
function chimneySmoke(pen: Pen, cx: number, y: number, big: boolean, anim: number, dark: boolean) {
  pen.as(OVERLAY, () => {
    const n = big ? 3 : 2
    const rise = big ? 12 : 6
    for (let k = n - 1; k >= 0; k--) {
      const up = ((anim * (big ? 1 : 0.5) + (k * rise) / n) % rise)
      const v = up / rise
      const size = big ? (v < 0.3 ? 2 : v < 0.7 ? 3 : 4) : v < 0.5 ? 1 : 2
      const sx = Math.round(cx + v * v * (big ? 6 : 3) - size / 2 + 0.5)
      const sy = Math.round(y - up - size)
      const col = dark ? (C.smoke[v < 0.4 ? 1 : v < 0.75 ? 2 : 3] ?? 0) : (C.smoke[v < 0.5 ? 2 : 3] ?? 0)
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) if (!(size > 3 && (i === 0 || i === size - 1) && (j === 0 || j === size - 1))) pen.dot(sx + i, sy + j, col)
    }
  })
}

/** Sparks flying up from a fire, as light. */
function embers(pen: Pen, cx: number, y: number, spread: number, n: number, height: number, anim: number) {
  for (let k = 0; k < n; k++) {
    const up = (anim * 2 + k * 7) % height
    const sx = cx + ((k * 11 + (up >> 2) * (k % 2 ? 1 : -1)) % spread) - spread / 2
    pen.glow(sx, y - up, up > height * 0.6 ? C.fire[3] : k % 3 ? C.ember : C.fire[1])
  }
}

/** How fierce a fire is at `t` ms: catching, roaring, dying down as it falls in. */
const fierce = (t: number) => (t < 1500 ? 0.25 + 0.35 * (t / 1500) : t < 3000 ? 0.6 + 0.4 * ((t - 1500) / 1500) : t < 7500 ? 1 : 1 - 0.35 * clamp((t - 7500) / 1500))

/** Flames over whatever stands along the art's fire columns, sparks. */
function fireOn(pen: Pen, X: number, Y: number, sh: Shape, t: number, anim: number, sink: number, big: boolean) {
  const a = sh.art
  const k = fierce(t)
  const mid = Math.floor(a.fire.length / 2)
  let hi = a.h
  for (let i = 0; i < a.fire.length; i++) {
    if (t < 1500 && i !== mid) continue
    const cx = a.fire[i] ?? 0
    const top0 = sh.top[cx] ?? a.h
    if (top0 >= a.h - 1) continue
    const surf = Math.round(top0 + (Math.max(top0, sh.wallTop) - top0 + (big ? 2 : 1)) * sink)
    hi = Math.min(hi, surf)
    const edge = i === 0 || i === a.fire.length - 1
    if (big) flame(pen, X + cx, Y + surf + 3, i === mid ? 7 : 5, Math.round((7 + 8 * flick(anim, i)) * k * (edge ? 0.7 : 1)), Math.round(Math.sin(anim * 0.9 + i) * 2))
    else flame(pen, X + cx, Y + surf + 2, i === mid ? 5 : 3, Math.round((4 + 4 * flick(anim, i)) * k), Math.round(Math.sin(anim * 0.9 + i)))
  }
  const cx = Math.round(a.w / 2)
  if (big) embers(pen, X + cx, Y + hi - 4, a.w - 6, Math.round(4 + 8 * k), 18, anim)
  else embers(pen, X + cx, Y + hi - 2, a.w - 3, Math.round(2 + 4 * k), 9, anim)
  return hi
}

// ---- ruins

const RUIN_MAP: Readonly<Record<string, string>> = { s: '9', S: '0', M: 'M', K: '0', '8': '9', '9': '0', '0': '0' }

/** A heap of rubble and charred beams over columns x0..x1 resting on row `ground`, worked out once per art. */
const ruinPics = new Map<Art, { rows: string[]; y: number }>()

function ruinPic(a: Art, big: boolean) {
  let rp = ruinPics.get(a)
  if (rp) return rp
  const { x0, x1, ground, posts, stump } = a.ruin
  const H = big ? 6 : 3
  const tall = big ? 12 : 6
  const top = Math.min(ground - tall, stump ? stump[2] : ground)
  const rows: string[][] = []
  for (let y = top; y <= ground; y++) rows.push(new Array(a.w).fill('.'))
  const put = (x: number, y: number, ch: string) => {
    const r = rows[y - top]
    if (r && x >= 0 && x < a.w) r[x] = ch
  }
  // a tower's stump: its lower courses, broken off in steps
  if (stump) {
    const [sx0, sx1, sy] = stump
    for (let x = sx0; x <= sx1; x++) {
      const u = (x - sx0) / Math.max(1, sx1 - sx0)
      const broken = sy + Math.round((big ? 4 : 2) * Math.abs(u - 0.3) * 2)
      for (let y = broken; y <= ground; y++) put(x, y, x === sx0 ? '9' : x === sx1 ? '0' : y === broken ? '9' : y % (big ? 4 : 3) === 0 && (x + y) % 3 === 0 ? 'M' : '0')
      put(x, broken, 'X')
    }
  }
  // charred posts, the middle one shorter, the last one leaning
  posts.forEach((c, k) => {
    const h = k === 1 ? Math.round(tall * 0.6) : tall - k
    for (let j = 0; j < h; j++) put(k === posts.length - 1 && k > 0 ? c + (j > h * 0.5 ? 1 : 0) : c, ground - j, 'X')
  })
  // the heap: a smooth mound, lit on top, a charred beam or two across it
  for (let x = x0; x <= x1; x++) {
    const u = (x - x0) / Math.max(1, x1 - x0)
    const hh = Math.max(1, Math.round(H * Math.pow(Math.sin(Math.PI * u), 0.7) * (0.8 + 0.2 * Math.cos(u * 9))))
    for (let j = 0; j < hh; j++) put(x, ground - j, j === hh - 1 ? '9' : '0')
  }
  if (big) {
    const bx = x0 + Math.round((x1 - x0) * 0.3)
    for (let i = 0; i < 7; i++) put(bx + i, ground - 3 - Math.floor(i / 2) + 1, 'X')
    const cx = x0 + Math.round((x1 - x0) * 0.65)
    for (let i = 0; i < 5; i++) put(cx + i, ground - 1 - (i >> 1), 'X')
  }
  for (let x = x0; x <= x1; x++) put(x, ground, 'J')
  rp = { rows: rows.map(r => r.join('')), y: top }
  ruinPics.set(a, rp)
  return rp
}

const RUIN_PAL = (() => {
  const a = new Int32Array(128).fill(-1)
  const m: Record<string, number> = { X: C.char, J: C.ash, '9': C.rock, '0': C.rockDark, M: C.mortar, '8': C.rockLight }
  for (const k of Object.keys(m)) a[k.charCodeAt(0)] = m[k] ?? 0
  return a
})()

/** A footing after the fire: its stones blackened, worked out once. */
const charredRows = new WeakMap<Rows, Rows>()
function charred(rows: Rows) {
  let out = charredRows.get(rows)
  if (!out) charredRows.set(rows, (out = rows.map(r => [...r].map(ch => RUIN_MAP[ch] ?? (ch === '.' ? '.' : 'X')).join(''))))
  return out
}

function ruins(pen: Pen, X: number, Y: number, a: Art, look: BuildLook, pal: Pal, t: number, big: boolean) {
  const anim = look.anim
  // the footing stays, charred
  for (const p of a.parts) if (p.cls === 'found' && shows(p, 1)) paint(pen, charred(p.rows), X + p.x, Y + p.y, RUIN_PAL)
  for (const p of a.parts) if (p.cls === 'base') paint(pen, p.rows, X + p.x, Y + p.y, pal)
  const rp = ruinPic(a, big)
  paint(pen, rp.rows, X, Y + rp.y, RUIN_PAL)
  const { x0, x1, ground } = a.ruin
  const left = 1 - (t - BURN.ruins) / (BURN.embers - BURN.ruins)
  const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
  const span = x1 - x0
  const cx = Math.round((x0 + x1) / 2)
  if (t < BURN.embers) {
    const n = Math.round((big ? 9 : 5) * left)
    for (let k = 0; k < n; k++) if ((anim + k) % 5) pen.glow(X + x0 + 2 + ((k * 7) % Math.max(1, span - 3)), Y + ground - 1 - (k % 2), (k + anim) % 3 ? C.ember : C.fire[3])
    if (t < 12500) {
      const f = 1 - (t - BURN.ruins) / 3500
      if (big) for (let k = 0; k < 3; k++) flame(pen, X + x0 + Math.round(span * (0.25 + k * 0.25)), Y + ground - 2, 3, Math.round(2 + 3 * flick(anim, k) * f), 1)
      else flame(pen, X + cx, Y + ground - 1, 3, Math.round(1 + 2 * flick(anim, 1) * f), 0)
    }
  }
  if (t < BURN.smoke) smoke(pen, X + cx, Y + ground - (big ? 4 : 2), Math.max(1, Math.round((big ? 8 : 5) * thin)), big ? 26 : 13, big, anim, thin * 0.8)
}

// ---- drawing a works building

/** What a kind adds of its own: things that move, drawn after its parts (sails, a wheel, a lamp's beam). */
type Extra = (pen: Pen, X: number, Y: number, look: BuildLook, lv: number, pal: Pal, big: boolean, standing: boolean) => void

function works(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook, a: Art, extra?: Extra, under?: Extra) {
  const big = s === 1
  const t = look.fire
  const gilded = look.level >= 4
  const pal = palOf(look.color, gilded, look.style)
  const sh = shapeOf(a, big)
  const was = pen.layer
  pen.layer = OBJECT
  if (t >= BURN.ruins) {
    if (under) under(pen, X, Y, look, Math.max(1, look.level), pal, big, false)
    ruins(pen, X, Y, a, look, pal, t, big)
    pen.layer = was
    return
  }
  const burning = t >= 0
  const { stage, within } = stageOf(look)
  const lv = Math.max(1, look.level)
  const done = stage === 'done'
  const anim = look.anim
  const caving = burning ? clamp((t - BURN.roofFalls) / (BURN.wallsFall - BURN.roofFalls)) : 0
  const falling = burning ? clamp((t - BURN.wallsFall) / (BURN.ruins - BURN.wallsFall)) : 0
  const step = burning ? Math.min(5, Math.floor(t / 1500)) : 0
  if (under) under(pen, X, Y, look, lv, pal, big, done)
  if (stage === 'foundation') {
    for (const p of a.parts) if (p.cls === 'base') paint(pen, p.rows, X + p.x, Y + p.y, pal)
    footing(pen, X, Y, a, pal, within, !burning, big)
  } else {
    if (stage !== 'done') frame(pen, X, Y, sh, stage === 'frame' ? within : 1)
    for (const p of a.parts) {
      if (!shows(p, done ? lv : 1)) continue
      const n = p.rows.length
      if (p.cls === 'prop' && !done) continue
      if (p.cls === 'base' || p.cls === 'found' || p.cls === 'prop') {
        paint(pen, p.rows, X + p.x, Y + p.y, pal)
        continue
      }
      // walls go up from the bottom row by row, each laid from the left; the roof the same from its eaves
      let from = 0
      let cut = 1 << 20
      if (!done) {
        const f = p.cls === 'wall' ? (stage === 'walls' ? within : stage === 'frame' ? 0 : 1) : stage === 'roof' ? within : 0
        if (f <= 0) continue
        const rows = f * n
        const k = Math.floor(rows)
        from = n - k - (k < n ? 1 : 0)
        if (k < n) {
          let w = 0
          for (const r of p.rows) w = Math.max(w, r.length)
          cut = Math.floor((rows - k) * w)
          paint(pen, p.rows, X + p.x, Y + p.y, pal, from + 1, n)
          const e = ends(p.rows[from] ?? '')
          const l = e[0] ?? 0
          paint(pen, p.rows, X + p.x, Y + p.y, pal, from, from + 1, l + cut)
          continue
        }
      } else if (burning) {
        if (p.cls === 'roof') from = Math.round(caving * n)
        else from = Math.round(falling * Math.min(n, big ? 5 : 3))
      }
      paint(pen, p.rows, X + p.x, Y + p.y, pal, from, n, cut)
    }
  }
  if (extra) extra(pen, X, Y, look, lv, pal, big, done)
  if (done && !burning) {
    for (const [c, on, l] of a.flags) if (lv >= l) flag(pen, X, Y, c, on, pal, anim, big)
    if (lv >= 5) for (const [bx, by] of a.banners) paint(pen, big ? CU_BANNER : OV_BANNER, X + bx, Y + by, pal)
  }
  const work = look.building && !burning
  if (work) {
    if (stage !== 'foundation') scaffold(pen, X, Y, a, big, done)
    pile(pen, X, Y, a, pal, big)
  }
  char(pen, X, Y, a.w, a.h, step)
  if (stage !== 'foundation' && (look.lit || burning)) {
    for (const p of a.parts) {
      if (!shows(p, done ? lv : 1) || (p.cls === 'prop' && !done)) continue
      if (!done && (p.cls === 'roof' || (p.cls === 'wall' && stage === 'walls' && within < 0.6) || stage === 'frame')) continue
      const from = burning && p.cls === 'roof' ? Math.round(caving * p.rows.length) : 0
      lights(pen, p.rows, X + p.x, Y + p.y, look.lit, t, anim, from)
    }
  } else if (stage !== 'foundation') {
    // a hearth glows by day too
    for (const p of a.parts) if (shows(p, done ? lv : 1) && (done || p.cls !== 'prop') && (done || stage === 'roof')) lights(pen, p.rows, X + p.x, Y + p.y, false, -1, anim)
  }
  if (done && !burning) for (const [cx, cy, l] of a.smoke) if (lv >= l) chimneySmoke(pen, X + cx, Y + cy, big, anim + cx, true)
  if (burning) {
    const sink = caving * 0.6 + falling * 0.4
    const hi = fireOn(pen, X, Y, sh, t, anim, sink, big)
    smoke(pen, X + Math.round(a.w / 2), Y + hi, Math.round((big ? 6 : 4) + (big ? 10 : 5) * clamp(t / 2500)), big ? 22 : 11, big, anim, Math.min(1, 0.4 + t / 3000))
  }
  pen.layer = was
}

// ---- the blacksmith: a stone forge, its hearth glowing through the wide front, a big chimney, an anvil

const SMITH_CU: Art = {
  w: 30,
  h: 28,
  parts: [
    part('found', 3, 25, [
      'ssssssssssssssssssssssss',
      'SSMSSSSMSSSKssKSSSSMSSMS',
      'SSSSMSSSSSKSSSSKSMSSSSSS',
    ]),
    part('wall', 4, 14, [
      'KKKKKKKKKKKKKKKKKKKKKK',
      'sSSSSSSSSsssssSSSSSSSK',
      'sSSMSSSssOOOOOOsSSSMSK',
      'sMMMMMsOOOmmmmOOOsMMMK',
      'sSSSSsOOmmmmmmmmOsgGSK',
      'sSSSSsOOEEEEEEEEOsGGSK',
      'sMMMMsOOfFFFFFFfOsMMMK',
      'sSMSSsOOaAAAAAAaOsSSMK',
      'sSMSSsOOAaAAaAAaOsSSMK',
      'sMMMMsOOaAAAAAAaOsMMMK',
      'sSSMSsOOOOOOOOOOOsSMSK',
    ]),
    part('roof', 2, 6, [
      '.......rrrrrrrrrrrr.......',
      '......LRRRRRRRRRRRRh......',
      '.....LLnnnnnnnnnnnnhh.....',
      '....LLRRRRRRRRRRRRRRhh....',
      '...LLLnnnnnnnnnnnnnnhhh...',
      '..LLLRRRRRRRRRRRRRRRRhhh..',
      '.LLLLnnnnnnnnnnnnnnnnhhhh.',
      'eeeeeeeeeeeeeeeeeeeeeeeeee',
    ]),
    // level 2: a dormer
    part('roof', 7, 7, ['..LRh..', '.LRRRh.', 'LgGGGGh', '.GGGGG.', '.ppppp.'], 2),
    // the chimney over the hearth, standing proud of the roof; from level 3 a great stack with two pots
    part('roof', 17, 1, ['IIIII', 'KKKKK', 'sSSSK', 'sSMSK', 'sSSSK', 'sMSSK', 'sSSSK', 'sSSMK', 'sSSSK'], 1, 3),
    part('roof', 16, 0, ['II.II..', 'KKKKKKK', 'sSSSSSK', 'sSMSSSK', 'sSSSSMK', 'sMSSSSK', 'sSSSSSK', 'sSSMSSK', 'sSSSSSK', 'sSSSSSK'], 3),
    // the sign: a board with a horseshoe, hanging off an iron bracket
    part('prop', 0, 14, ['iiiiiiI', '.I...I.', 'wwwwwww', 'wmBBBmw', 'wmBBBmw', 'wBmmmBw', 'ddddddd'], 1, 4),
    part('prop', 0, 14, ['iiiiiiI', '.I...I.', 'wwwwwww', 'wkBBBkw', 'wkBBBkw', 'wBkkkBw', 'ddddddd'], 4),
    // the anvil on its stump, out front
    part('prop', 1, 21, ['...iiiiiI', 'iimmmmmmI', '...mmmI..', '..mmmmmI.', '..wBBBd..', '..BBBBd..', '..dddddd.']),
    // a quench tub by the door
    part('prop', 20, 23, ['.wwww.', 'BuyuuB', 'dBBBBd', 'BddddB', '.dddd.']),
    // level 2: a rack with a shield in the builder's color and two swords
    part('prop', 25, 15, ['.i.i.', '.i.i.', 'bbbbb', 'bLkhc', 'bkkkc', 'bbhcc', '.bcc.', 'wwwww', 'B...d', 'B...d', 'B...d', 'B...d', 'd...d'], 2),
  ],
  fire: [6, 10, 15, 19, 24],
  smoke: [[19, 0, 1]],
  ladder: 1,
  pole: 28,
  deck: 12,
  banners: [[6, 16], [22, 16]],
  flags: [[10, 6, 5]],
  pit: true,
  ruin: { x0: 5, x1: 24, ground: 24, posts: [5, 14, 23] },
}

const SMITH_OV: Art = {
  w: 15,
  h: 14,
  parts: [
    part('found', 1, 12, ['sssssssssssss', 'SSSSSSSSSSSSS']),
    part('wall', 2, 7, ['KKKKKKKKKKK', 'sSSOmmOSSSK', 'sSSOEEOSGSK', 'sSSOAAOSSSK', 'sSSOOOOSSSK']),
    part('roof', 1, 3, ['...rrrrrrr...', '..LRRRRRRRh..', '.LLRRRRRRRhh.', 'eeeeeeeeeeeee']),
    part('roof', 4, 4, ['GG'], 2),
    part('roof', 9, 0, ['III', 'sSK', 'sSK', 'sSK'], 1, 3),
    part('roof', 8, 0, ['I.I', 'sSK', 'sSK', 'sSK'], 3),
    part('roof', 8, 0, ['....', '...K', '...K', '...K'], 3),
    part('prop', 0, 7, ['iI', 'ww', 'mw', 'dd'], 1, 4),
    part('prop', 0, 7, ['iI', 'ww', 'kw', 'dd'], 4),
    part('prop', 0, 11, ['imI', '.B.', '.d.']),
    part('prop', 13, 8, ['bc', 'bc', 'Bd', 'Bd', 'dd'], 2),
  ],
  fire: [3, 7, 11],
  smoke: [[10, -1, 1]],
  ladder: 0,
  pole: 14,
  deck: 5,
  banners: [[3, 8], [10, 8]],
  flags: [[4, 3, 5]],
  pit: true,
  ruin: { x0: 2, x1: 12, ground: 11, posts: [2, 7, 12] },
}

// ---- the windmill: a white tower in three courses, a cap in the builder's color, sails of dyed canvas

const MILL_CU: Art = {
  w: 26,
  h: 44,
  parts: [
    part('found', 5, 42, ['ssssssssssssssss', 'SSMSSSSKKSSSMSSK']),
    part('wall', 7, 16, [
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '..WPPPPPpp..',
      '.VVVVVVVVVV.',
      '.WPPPPPPPpp.',
      '.WPPPPPPPpp.',
      '.WPPPddPPpp.',
      '.WPPPgGPPpp.',
      '.WPPPGGPPpp.',
      '.WPPPPPPPpp.',
      '.WPPPPPPPpp.',
      '.WPPPPPPPpp.',
      'VVVVVVVVVVVV',
      'WPPPPPPPPPpp',
      'WPPPPddPPPpp',
      'WPPPPDDPPPpp',
      'WPPPPDDPPPpp',
      'WPPPPDDPPPpp',
      'WPPPPDDPPPpp',
      'WPPPPDDPPPpp',
    ]),
    // level 3: a stone ground floor
    part('wall', 7, 34, [
      'ssssssssssss',
      'sSSSMSSSSSKK',
      'sSSSSddSSMKK',
      'sMSSSDDSSSKK',
      'sSSSSDDSSSKK',
      'sSSMSDDSMSKK',
      'sSSSSDDSSSKK',
      'MMMMMDDMMMMM',
    ], 3),
    part('roof', 6, 8, [
      '......rr......',
      '....LLRRhh....',
      '...LLLRRhhh...',
      '..LLLLRRhhhh..',
      '..LLLLRRhhhh..',
      '.LLLLLRRhhhhh.',
      '.LLLLLRRhhhhh.',
      'eeeeeeeeeeeeee',
    ]),
    // level 2: a gallery round the tower
    part('prop', 3, 29, [
      'w..w..w..w..w..w..w.',
      'BBBBBBBBBBBBBBBBBBBB',
      'B..B..B..B..B..B..BB',
      'wwwwwwwwwwwwwwwwwwww',
      'dddddddddddddddddddd',
      '.d................d.',
    ], 2),
    // level 3: sacks of flour by the door
    part('prop', 18, 39, ['.t..t.', '%%&%%&', '%%&%%&', '&&&&&&'], 3),
    part('prop', 2, 40, ['.t.', '%%&', '%%&', '&&&'], 3),
  ],
  fire: [9, 13, 16],
  smoke: [],
  ladder: 2,
  pole: 23,
  deck: 14,
  banners: [[8, 35], [16, 35]],
  flags: [[12, 8, 5]],
  pit: false,
  ruin: { x0: 4, x1: 21, ground: 41, posts: [], stump: [7, 18, 32] },
}

const MILL_OV: Art = {
  w: 13,
  h: 22,
  parts: [
    part('found', 2, 20, ['sssssssss', 'SSSSSSSSK']),
    part('wall', 3, 8, [
      '.WPPPp.',
      '.WPPPp.',
      '.WPPPp.',
      '.WPPPp.',
      '.WPPPp.',
      '.WPPPp.',
      '.WPPPp.',
      'VVVVVVV',
      'WPPGPPp',
      'WPPPPPp',
      'WPPDPPp',
      'WPPDPPp',
    ]),
    part('wall', 3, 16, ['sSSGSSK', 'sSSSSSK', 'sSSDSSK', 'MMMDMMM'], 3),
    part('roof', 3, 3, ['...r...', '..LRh..', '.LLRhh.', 'LLLRhhh', 'eeeeeee']),
    part('prop', 0, 14, ['wwwwwwwwwwwww', 'd.d.......d.d'], 2),
    part('prop', 10, 19, ['%&', '%&', '&&'], 3),
  ],
  fire: [4, 6, 8],
  smoke: [],
  ladder: 1,
  pole: 11,
  deck: 7,
  banners: [[4, 16], [8, 16]],
  flags: [[6, 3, 5]],
  pit: false,
  ruin: { x0: 1, x1: 11, ground: 19, posts: [], stump: [3, 9, 15] },
}

/** The sails at four angles, in a picture 8 px larger than the footprint each way (its (0, 0) on (4, 4)). */
function sailFrames(big: boolean): Rows[] {
  const W = big ? 34 : 21
  const H = big ? 52 : 30
  const hx = big ? 16.5 : 10
  const hy = big ? 15.5 : 10
  const R = big ? 15.5 : 8.4
  // only angles whose spars step cleanly: level, two across to one up, diagonal, one across to two up
  return [0, 26.565, 45, 63.435].map(deg => {
    const rows: string[] = []
    for (let y = 0; y < H; y++) {
      let row = ''
      for (let x = 0; x < W; x++) {
        const dx = x - hx
        const dy = y - hy
        let ch = '.'
        for (let a = 0; a < 4; a++) {
          const t = ((deg + a * 90) * Math.PI) / 180
          const along = dx * Math.cos(t) + dy * Math.sin(t)
          const perp = -dx * Math.sin(t) + dy * Math.cos(t)
          if (along < 0.5 || along > R) continue
          if (Math.abs(perp) <= 0.5) ch = 'd'
          else if (big && perp > 0.5 && perp <= 3.5 && along >= 4.5) ch = perp > 2.5 ? 'R' : 'L'
          else if (!big && perp > 0.5 && perp <= 2.5 && along >= 2.5) ch = perp > 1.5 ? 'R' : 'L'
        }
        row += ch
      }
      rows.push(row)
    }
    // the hub over the spars
    const put = (x: number, y: number) => {
      const r = rows[y] ?? ''
      rows[y] = r.slice(0, x) + 'I' + r.slice(x + 1)
    }
    if (big) (put(16, 15), put(17, 15), put(16, 16), put(17, 16))
    else put(10, 10)
    return rows
  })
}

const SAILS_CU = sailFrames(true)
const SAILS_OV = sailFrames(false)

/**
 * The sails, turning 15 degrees every other frame (still while it burns; gone once the cap has fallen). Where a
 * sail crosses the tower, or anything else already drawn, a dark line parts them, as the ring parts things from
 * the grass.
 */
const millSails: Extra = (pen, X, Y, look, lv, pal, big, standing) => {
  if (!standing) return
  const t = look.fire
  if (t >= BURN.roofFalls) return
  const frames = big ? SAILS_CU : SAILS_OV
  const rows = frames[t >= 0 ? 2 : (look.anim >> 1) % frames.length] ?? frames[0]
  if (!rows) return
  const ox = X - 4
  const oy = Y - 4
  const on = (i: number, j: number) => {
    const ch = (rows[j] ?? '')[i]
    return ch !== undefined && ch !== '.'
  }
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j] ?? ''
    for (let i = 0; i < r.length; i++) {
      if (r[i] !== '.') continue
      if (!(on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1))) continue
      const px = ox + i
      const py = oy + j
      if (pen.inside(px, py) && pen.kind[py * pen.w + px] === OBJECT) pen.dot(px, py, C.edge)
    }
  }
  paint(pen, rows, ox, oy, pal)
  void lv
}

// ---- the farm: a red barn with a hayloft and great doors, the farmhouse beside it, a haystack, a cart, a fence

const FENCE_CU = (w: number, gate0: number, gate1: number) =>
  [0, 1, 2].map(j => {
    let r = ''
    for (let c = 0; c < w; c++) {
      if (c >= gate0 && c <= gate1) r += '.'
      else if (c % 4 === 0 || c === gate0 - 1 || c === gate1 + 1 || c === w - 1) r += j === 0 ? 'w' : j === 1 ? 'B' : 'd'
      else r += j === 1 ? 'w' : j === 2 ? '.' : '.'
    }
    return r
  })

const FARM_CU: Art = {
  w: 46,
  h: 32,
  parts: [
    part('found', 1, 27, ['sssssssssss', 'SSMSSSSMSSK']),
    part('found', 13, 27, ['ssssssssssssssssssss', 'SSMSSSKssssKSSSMSSSK']),
    // level 2: the silo behind the haystack's place, a dome in the builder's color
    ...split(36, 2, [
      '...rr...',
      '..LRRh..',
      '.LLRRhh.',
      'LLLRRhhh',
      'eeeeeeee',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'mmmmmmmm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'mmmmmmmm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'mmmmmmmm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'i##$$$mm',
      'mmmmmmmm',
      'i##$$$mm',
      'i##$$$mm',
      'KKKKKKKK',
    ], 2),
    // the farmhouse: plaster and timber under a hip roof, a chimney
    ...split(0, 12, [
      '....rrrrr....',
      '...LRRRRRh...',
      '..LLnnnnnhh..',
      '.LLRRRRRRRhh.',
      'LLLnnnnnnnhhh',
      'eeeeeeeeeeeee',
      '.TTTTTTTTTTT.',
      '.TPPPPPPPPPT.',
      '.TgGPTTTPgGT.',
      '.TGGPTDDPGGT.',
      '.TPPPTDDPPPT.',
      '.TlqlTDkPlqT.',
      '.TPPPTDDPPPT.',
      '.TTTTTDDTTTT.',
      '.TPPPTDDPPPT.',
    ]),
    part('roof', 8, 8, ['KKK', 'sSK', 'sSK', 'sSK', 'sSK']),
    // the barn: a gambrel roof round a red gable, a hayloft, great doors braced in white
    ...split(12, 5, [
      '........rrrrrr........',
      '......LLAAAAAAhh......',
      '....LLAAAAAAAAAAhh....',
      '..LLLAAAAAAAAAAAAhhh..',
      '..LLAAAAWWWWWWAAAAhh..',
      '.LLAAAAAWHHYYWAAAAAhh.',
      '.LLAAAAAWHYYzWAAAAAhh.',
      'LLAAAAAAWWWWWWAAAAAAhh',
      'eeWWWWWWWWWWWWWWWWWWee',
      '..WAAAAAAAAAAAAAAAAV..',
      '..WAWWWWWWWWWWWWWWAV..',
      '..WAWWaaaWWWWaaaWWAV..',
      '..WAWWaaaWWWWaaaWWAV..',
      '..WAWaWaWaWWaWaWaWAV..',
      '..WAWaWaWaWWaWaWaWAV..',
      '..WAWaaWaaWWaaWaaWAV..',
      '..WAWaaWaaWWaaWaaWAV..',
      '..WAWaWaWaWWaWaWaWAV..',
      '..WAWaWaWaWWaWaWaWAV..',
      '..WAWWaaaWWWWaaaWWAV..',
      '..WAWWaaaWWWWaaaWWAV..',
      '..WAWWWWWWWWWWWWWWaV..',
    ]),
    // level 3: a cupola on the barn's ridge, a weathervane on it
    part('roof', 20, 1, ['..rr..', '.LRRh.', 'eeeeee', '.WOWO.'], 3),
    // the haystack, until the silo stands there
    part('prop', 36, 21, ['..HHYY..', '.HHHYYz.', 'HHYHYYzz', 'HYYYzYzz', 'YzYYzzZz', '.ZZZZZZ.'], 1, 2),
    // the hay cart
    part('prop', 35, 23, ['...HHYY...', '.HHHYYYzz.', 'wwwwwwwwwd', 'BBBBBBBBBd', '.dmId..dd.', '..Id......']),
    part('prop', 0, 29, FENCE_CU(46, 19, 26)),
  ],
  fire: [5, 14, 18, 23, 28, 32],
  smoke: [[9, 7, 1]],
  ladder: 13,
  pole: 33,
  deck: 10,
  banners: [[16, 15], [28, 15]],
  flags: [[6, 12, 5], [40, 2, 5]],
  pit: true,
  ruin: { x0: 2, x1: 32, ground: 26, posts: [4, 18, 30] },
}

const FARM_OV: Art = {
  w: 23,
  h: 16,
  parts: [
    part('found', 1, 14, ['ssssss']),
    part('found', 7, 14, ['ssssssssss']),
    ...split(18, 1, ['.LRh.', 'LLRhh', 'eeeee', 'i#$$m', 'i#$$m', 'mmmmm', 'i#$$m', 'i#$$m', 'mmmmm', 'i#$$m', 'i#$$m', 'i#$$m', 'KKKKK'], 2),
    ...split(0, 7, ['..rrr...', '.LRRRh..', 'LLRRRhh.', 'eeeeeee.', '.TGTDGT.', '.TPTDPT.', '.TTTDTT.']),
    part('roof', 4, 5, ['K', 'K']),
    ...split(6, 2, [
      '....rrr....',
      '..LLAAAhh..',
      '.LLAWYWAhh.',
      'LLAAAAAAAhh',
      'eWWWWWWWWWe',
      '.WAAAAAAAV.',
      '.WAWWWWWAV.',
      '.WAWDdDWAV.',
      '.WAWDdDWAV.',
      '.WAWDdDWAV.',
      '.WAWDdDWAV.',
      '.WaWDdDWaV.',
    ]),
    part('roof', 10, 0, ['.r.', 'LRh'], 3),
    part('prop', 18, 10, ['.HY.', 'HYYz', 'ZZZZ'], 1, 2),
    part('prop', 17, 11, ['.HYY', 'wwwd', '.I..']),
    part('prop', 0, 15, ['wBwBwBwBw..', '...'].slice(0, 1).map(r => r + '....' + 'wBwBwBwB')),
  ],
  fire: [3, 9, 11, 14, 20],
  smoke: [[4, 4, 1]],
  ladder: 6,
  pole: 17,
  deck: 4,
  banners: [[8, 7], [14, 7]],
  flags: [[3, 7, 5], [20, 1, 5]],
  pit: true,
  ruin: { x0: 1, x1: 16, ground: 13, posts: [2, 9, 15] },
}

// ---- fields: tilled rows growing the farm's crops

/** The crops' own colors, each set well apart from the others so a field is known by its crop from afar. */
const K = {
  cab: [0xbbddaa, 0x88bb88, 0x558866], pumpkin: [0xffaa44, 0xee8822, 0xbb5511], carrot: 0xee7722,
  sun: [0xffcc33, 0xddaa22, 0x553311], grape: [0x9966cc, 0x664488], tassel: 0xeedd99,
  blooms: [[0xee88bb, 0xbb5588], [0xeecc55, 0xbb9933], [0xdd4444, 0x992233], [0xeeeedd, 0xbbbbaa], [0x9977cc, 0x665599]],
} as const

/** Each crop's rows: how many pixels each row takes, close-up and at overview. */
const PER: Record<Crop, readonly [number, number]> = {
  wheat: [3, 3], corn: [6, 3], cabbage: [5, 3], pumpkin: [6, 3], carrots: [4, 3], sunflowers: [7, 3], grapes: [5, 3], flowers: [4, 2],
}

/**
 * One pixel of a crop: (i, j) inside the field, `r` its place in its row (0 the top) and `per` the row's height,
 * `band` which row. `ripe` false shows it young and green. -1 leaves the soil.
 */
function cropPx(crop: Crop, one: boolean, i: number, r: number, band: number, ripe: boolean, anim: number): number {
  switch (crop) {
    case 'wheat': {
      if (!ripe) return r === 0 ? S.gL : r === 1 ? S.gM : S.gD
      const t = one ? anim >> 1 : anim >> 2
      const cyc = one ? 18 : 12
      const windy = ((((i + band * 3 - t) % cyc) + cyc) % cyc) < (one ? 6 : 4)
      return r === 0 ? (windy ? S.hayWind : S.hayLight) : r === 1 ? (windy ? S.hayLight : S.hay) : S.hayShade
    }
    case 'corn': {
      if (one) {
        const stalk = i % 3 === 2
        const cob = !ripe ? false : (i + band * 3) % 6 === 0
        if (r === 0) return ripe && i % 3 === 1 ? K.tassel : ripe ? -1 : -1
        if (r === 1) return ripe ? (stalk ? S.gD : S.gL) : -1
        if (r === 2) return stalk ? S.gD : cob ? S.hay : ripe ? S.gM : S.gL
        if (r === 3) return stalk ? S.gD : cob ? S.hayShade : S.gL
        if (r === 4) return stalk ? S.gE : S.gM
        return S.soilDark
      }
      if (r === 0) return ripe && i % 3 === 1 ? K.tassel : S.gL
      if (r === 1) return i % 3 === 2 ? S.gE : S.gM
      return S.soilDark
    }
    case 'cabbage': {
      const step = one ? 5 : 3
      const off = (band % 2) * (one ? 2 : 1) + 1
      const hx = (((i - off) % step) + step) % step
      if (one) {
        if (r === 4) return S.soilDark
        if (!ripe) return r >= 1 && r <= 2 && hx >= 1 && hx <= 2 ? (r === 1 ? S.gL : S.gM) : -1
        const head = ['.ab.', 'abbc', '.cc.'][r] ?? ''
        const ch = head[hx]
        return ch === 'a' ? (K.cab[0] ?? 0) : ch === 'b' ? (K.cab[1] ?? 0) : ch === 'c' ? (K.cab[2] ?? 0) : -1
      }
      if (r === 2) return S.soilDark
      if (!ripe) return r === 1 && hx === 0 ? S.gL : -1
      return hx < 2 ? (r === 0 ? (hx === 0 ? (K.cab[0] ?? 0) : (K.cab[1] ?? 0)) : (K.cab[2] ?? 0)) : -1
    }
    case 'pumpkin': {
      if (one) {
        if (r === 5) return S.soilDark
        const px = (i + band * 4) % 8
        const leaf = (i + band * 4 + 4) % 8
        if (r === 4) return S.gD
        if (ripe && px < 4 && r >= 1) {
          const art = ['.q..', 'OooO', 'oooq', 'qooq'][r - 1] ?? ''
          const ch = art[px]
          if (ch === 'O') return K.pumpkin[0] ?? 0
          if (ch === 'o') return K.pumpkin[1] ?? 0
          if (ch === 'q') return r === 1 ? S.gE : (K.pumpkin[2] ?? 0)
        }
        if (!ripe && px < 2 && r === 3) return S.gH
        if (leaf < 3 && r >= 2) return r === 2 ? (leaf === 1 ? S.gM : -1) : leaf === 1 ? S.gD : S.gM
        return -1
      }
      if (r === 2) return S.soilDark
      if (r === 1) return S.gD
      const px = (i + band * 3) % 5
      return ripe && px < 2 ? (px === 0 ? (K.pumpkin[0] ?? 0) : (K.pumpkin[1] ?? 0)) : px === 3 ? S.gM : -1
    }
    case 'carrots': {
      // feathery tops in two rows, the carrots' orange shoulders showing at their feet
      if (one) {
        if (r === 3) return S.soilDark
        if (r === 0) return i % 4 === 1 ? S.gH : ripe || i % 4 !== 3 ? S.gL : -1
        if (r === 1) return i % 4 === 3 ? S.gD : S.gM
        return ripe && i % 4 === 1 ? K.carrot : ripe && i % 4 === 2 ? (K.pumpkin[2] ?? 0) : -1
      }
      if (r === 0) return S.gH
      if (r === 1) return ripe && i % 4 < 2 ? K.carrot : -1
      return S.soilDark
    }
    case 'sunflowers': {
      if (one) {
        if (r === 6) return S.soilDark
        const hx = (i + (band % 2) * 2) % 4
        if (r <= 2) {
          if (!ripe) return r === 2 && hx === 1 ? S.gH : r >= 1 && hx === 1 ? S.gL : -1
          if (hx === 3) return r === 2 ? S.gD : -1
          const art = ['yYy', 'YoY', 'yYy'][r] ?? ''
          const ch = art[hx]
          return ch === 'Y' ? (K.sun[0] ?? 0) : ch === 'y' ? (K.sun[1] ?? 0) : (K.sun[2] ?? 0)
        }
        if (r === 3) return hx === 1 ? S.gD : S.gL
        if (r === 4) return hx === 1 ? S.gD : S.gM
        return hx === 1 ? S.gE : S.gD
      }
      if (r === 2) return S.soilDark
      const hx = (i + (band % 2)) % 3
      if (r === 0) return ripe ? (hx < 2 ? (K.sun[0] ?? 0) : S.gD) : hx === 0 ? S.gL : S.gM
      return hx === 2 ? S.gE : S.gM
    }
    case 'grapes': {
      const step = one ? 9 : 6
      const post = i % step === (one ? 4 : 2)
      if (one) {
        if (post && r <= 3) return r === 0 ? C.woodLight : C.wood
        if (r === 0) return i % 3 === 0 ? S.gL : S.gM
        if (r === 1) return S.gD
        const g = (i + band) % 4
        if (ripe && r === 2 && (g === 1 || g === 2)) return K.grape[0] ?? 0
        if (ripe && r === 3 && g === 1) return K.grape[1] ?? 0
        if (r === 2) return S.gE
        return r === 4 ? S.soilDark : -1
      }
      if (post && r === 0) return C.woodLight
      if (r === 0) return S.gM
      if (r === 1) return ripe && i % 3 === 1 ? (K.grape[0] ?? 0) : S.gD
      return -1
    }
    case 'flowers': {
      const bl = K.blooms[band % K.blooms.length] ?? K.blooms[0]
      if (one) {
        if (r === 0) return ripe ? ((i + band * 2) % 4 === 0 ? S.gM : (bl[0] ?? 0)) : (i + band * 2) % 4 === 1 ? S.gH : S.gM
        if (r === 1) return ripe ? (bl[1] ?? 0) : S.gM
        if (r === 2) return S.gM
        return S.gD
      }
      return r === 0 ? (ripe ? (bl[0] ?? 0) : S.gL) : S.gD
    }
  }
}

const FIELD_PAL = palOf(0, false)

/** Scarecrow: a hat, a sack for a head, a shirt in the builder's color on a cross of poles, straw at the cuffs. */
const SCARE_CU = ['..ooo..', '.ooooo.', '..%%&..', 'HbbLbbH', '..bLc..', '..bbc..', '..YzY..', '...B...', '...B...', '...d...']
const SCARE_GOLD = ['..kkk..', '.kjjjk.']
const SCARE_OV = ['.o.', 'bLb', '.c.', '.B.']
/** A harvest cart: its load in the crop's colors (P lit, Q shaded). */
const CART_CU = ['..PPPQ...', '.PPPPQQ..', 'wwwwwwwwd', 'BBBBBBBBd', '.dIId..dd', '..Id.....']
const CART_OV = ['PQ.', 'wwd', '.I.']
const SACKS_CU = ['.t..t...', '%%&%%&..', '%%&%%&wd', '&&&&&&BB']
const SACKS_OV = ['%&.', '&&w']

const cartPals = new Map<Crop, Pal>()
/** The cart's palette: its load (P lit, Q shaded) in the crop's colors. */
function cartPal(crop: Crop) {
  let p = cartPals.get(crop)
  if (!p) {
    p = new Int32Array(palOf(0, false))
    const [a, b] = produce(crop)
    p['P'.charCodeAt(0)] = a
    p['Q'.charCodeAt(0)] = b
    cartPals.set(crop, p)
  }
  return p
}

function produce(crop: Crop): [number, number] {
  switch (crop) {
    case 'wheat': return [S.hayLight, S.hayShade]
    case 'corn': return [S.hay, S.hayShade]
    case 'cabbage': return [K.cab[0] ?? 0, K.cab[2] ?? 0]
    case 'pumpkin': return [K.pumpkin[0] ?? 0, K.pumpkin[2] ?? 0]
    case 'carrots': return [K.carrot, K.pumpkin[2] ?? 0]
    case 'sunflowers': return [K.sun[0] ?? 0, K.sun[1] ?? 0]
    case 'grapes': return [K.grape[0] ?? 0, K.grape[1] ?? 0]
    case 'flowers': return [K.blooms[0]?.[0] ?? 0, K.blooms[2]?.[0] ?? 0]
  }
}

/**
 * A field: a plot of tilled rows growing `look.crop`, GROUND throughout (a ring round every plant would be noise),
 * with a clear edge. A first build ploughs it row by row, then sprouts come up, the crop grows green and ripens row
 * by row. From level 2 a scarecrow in the builder's colors, 3 a fence round it with a gate (a lantern on its post),
 * 4 a harvest cart loaded with the crop, 5 pennants on the corner posts and a gilded hat. It burns as a crop fire
 * sweeping across from the left and leaves scorched rows.
 */
function drawField(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook) {
  const one = s === 1
  const crop: Crop = look.crop ?? 'wheat'
  const W = one ? 40 : 20
  const H = one ? 28 : 14
  const x0 = one ? 2 : 1
  const y0 = one ? 2 : 1
  const w = W - 2 * x0
  const h = H - 2 * y0
  const per = PER[crop][one ? 0 : 1]
  const n = Math.floor(h / per)
  const top = Math.floor((h - n * per) / 2)
  const t = look.fire
  const anim = look.anim
  const p = look.level >= 1 ? 1 : look.progress
  const lv = Math.max(1, look.level)
  const done = look.level >= 1
  // what has happened to each row: ploughed (0..1 across the plough's run), sprouted, grown, ripe
  const plough = clamp(p / 0.25) * n
  const sprout = p >= 0.25
  const grown = p >= 0.5
  const ripeRows = done ? n : p >= 0.75 ? clamp((p - 0.75) / 0.25) * n : 0
  // a crop fire sweeps across from the left; behind it scorched rows
  const front = t < 0 ? -99 : t >= BURN.ruins ? w + 99 : clamp(t / 7800) * (w + 8) - 4
  const pal = palOf(look.color, false)
  pen.as(GROUND, () => {
    // the edge: a dark border, its corners rounded off
    for (let i = 1; i < W - 1; i++) {
      pen.dot(X + i, Y + y0 - 1, S.soilDark)
      pen.dot(X + i, Y + y0 + h, S.soilDark)
    }
    for (let j = y0; j < y0 + h; j++) {
      pen.dot(X + x0 - 1, Y + j, S.soilDark)
      pen.dot(X + x0 + w, Y + j, S.soilDark)
    }
    for (let j = 0; j < h; j++) {
      const k = j - top
      const band = Math.floor(k / per)
      const r = k - band * per
      const inRows = k >= 0 && band < n
      for (let i = 0; i < w; i++) {
        let c = -1
        if (i < front - 1) {
          // scorched: ash on the ridges, char in the furrows
          c = !inRows ? C.char : r === per - 1 ? C.char : r === 0 ? 0x554433 : C.ash
        } else if (!inRows) {
          c = band < 0 && plough <= 0 ? -1 : S.soil
          if (plough <= 0 && !sprout) c = -1
        } else {
          const tilled = band < Math.floor(plough) || (band === Math.floor(plough) && i < (plough - band) * w)
          if (!tilled && !sprout) c = -1
          else if (!sprout) c = r === per - 1 ? S.soilDark : r === 0 ? S.soilLight : S.soil
          else if (!grown) {
            // sprouts: short green dashes along the rows
            c = r === per - 1 ? S.soilDark : r === per - 2 && i % 4 < 2 ? S.gL : S.soil
          } else {
            const v = cropPx(crop, one, i, r, band, band < ripeRows, anim)
            c = v >= 0 ? v : S.soil
          }
        }
        if (c >= 0) pen.dot(X + x0 + i, Y + y0 + j, c)
      }
    }
  })
  if (t >= 0 && t < BURN.ruins) {
    // the fire's front: flames along it, glowing ash just behind
    const fx = Math.round(front)
    for (let j = 0; j < h; j += one ? 4 : 3) {
      const cx = fx + ((j * 7) % 3) - 1
      if (cx < 0 || cx >= w) continue
      const fl = flick(anim, j)
      flame(pen, X + x0 + cx, Y + y0 + j + (one ? 2 : 1), one ? 5 : 3, Math.round((one ? 4 + 5 * fl : 2 + 3 * fl) * fierce(t)), Math.round(Math.sin(anim * 0.9 + j)))
    }
    for (let k = 0; k < (one ? 10 : 5); k++) {
      const ex = fx - 2 - ((k * 5 + anim) % (one ? 7 : 4))
      const ey = (k * 7 + (anim >> 1)) % h
      if (ex >= 0 && ex < w) pen.glow(X + x0 + ex, Y + y0 + ey, (k + anim) % 3 ? C.ember : C.fire[3])
    }
  } else if (t >= BURN.ruins && t < BURN.embers) {
    const left = 1 - (t - BURN.ruins) / (BURN.embers - BURN.ruins)
    const m = Math.round((one ? 12 : 6) * left)
    for (let k = 0; k < m; k++) if ((anim + k) % 4) pen.glow(X + x0 + ((k * 11 + 3) % w), Y + y0 + ((k * 7 + 2) % h), (k + anim) % 3 ? C.ember : C.fire[3])
  }
  // things on and round the field
  pen.as(OBJECT, () => {
    const ruined = t >= BURN.ruins
    if (done && lv >= 3) {
      // the fence: posts and rails round the edge, a gate in the middle of the bottom side
      const g0 = Math.floor(W / 2) - (one ? 2 : 1)
      const g1 = Math.floor(W / 2) + (one ? 1 : 0)
      const every = one ? 5 : 4
      const rail = (xx: number, yy: number, post: boolean) => {
        if (ruined) {
          if (post) pen.dot(X + xx, Y + yy, C.char)
        } else pen.dot(X + xx, Y + yy, post ? C.wood : C.woodLight)
      }
      for (let i = 0; i < W; i++) {
        const post = i % every === 0 || i === W - 1 || i === g0 - 1 || i === g1 + 1
        rail(i, 0, post)
        if (i < g0 || i > g1) rail(i, H - 1, post)
        if (one && post && !ruined) {
          pen.dot(X + i, Y + 1, C.woodDark)
          if (i < g0 || i > g1) pen.dot(X + i, Y + H - 2, C.woodLight)
        }
      }
      for (let j = 1; j < H - 1; j++) {
        const post = j % every === 0
        rail(0, j, post)
        rail(W - 1, j, post)
      }
      // a lantern on the gate post
      if (one && !ruined) {
        pen.dot(X + g0 - 1, Y + H - 3, C.ironDark)
        pen.dot(X + g0 - 1, Y + H - 4, S.lantern)
        if (look.lit) pen.glow(X + g0 - 1, Y + H - 4, C.lit)
      }
      if (lv >= 5 && !ruined) {
        // pennants on the corner posts
        for (const cx of [0, W - 1]) {
          const fl = pal['b'.charCodeAt(0)] ?? 0
          const top2 = one ? 1 : 0
          for (let k = 0; k < (one ? 4 : 2); k++) pen.dot(X + cx, Y + top2 - k, C.woodLight)
          const dir = cx === 0 ? 1 : -1
          pen.dot(X + cx + dir, Y + top2 - (one ? 3 : 1), fl)
          if (one) (pen.dot(X + cx + dir * 2, Y + top2 - 3 + (anim % 2), fl), pen.dot(X + cx + dir, Y + top2 - 2, pal['c'.charCodeAt(0)] ?? 0))
        }
      }
    }
    if (ruined) return
    if (done && lv >= 2) {
      const sc = one ? SCARE_CU : SCARE_OV
      const left = look.style % 2 === 1
      const sx = X + (one ? (left ? 7 : 27) : left ? 4 : 13)
      const sy = Y + (one ? 7 : 3)
      paint(pen, sc, sx, sy, pal)
      if (one && lv >= 5) paint(pen, SCARE_GOLD, sx, sy, FIELD_PAL)
    }
    if (done && lv >= 4) {
      const cp = cartPal(crop)
      const art = one ? CART_CU : CART_OV
      paint(pen, art, X + (one ? 3 : 1), Y + H - art.length - (one ? 2 : 1), cp)
    }
    if (look.building && t < 0) {
      const art = one ? SACKS_CU : SACKS_OV
      paint(pen, art, X + (lv >= 4 && done ? (one ? 13 : 5) : one ? 2 : 1), Y + H - art.length - (one ? 1 : 0), pal)
    }
    if (!done && p < 0.25 && t < 0) {
      // the plough at the end of the furrow it is cutting
      const band = Math.min(n - 1, Math.floor(plough))
      const px = X + x0 + Math.round((plough - band) * w)
      const py = Y + y0 + top + band * per
      if (one) paint(pen, ['.w..', 'wBBi', '..dI'], px - 1, py - 1, pal)
      else paint(pen, ['wB', '.I'], px - 1, py - 1, pal)
    }
  })
  if (t >= 0) {
    const step = Math.min(5, Math.floor(t / 1500))
    char(pen, X, Y, W, H, step)
    if (t < BURN.ruins) smoke(pen, X + x0 + Math.round(clamp(front / w) * w), Y + y0 + (h >> 1), Math.round((one ? 6 : 4) + (one ? 6 : 3) * clamp(t / 2500)), one ? 22 : 11, one, anim, Math.min(1, 0.4 + t / 3000))
    else if (t < BURN.smoke) {
      const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
      smoke(pen, X + (W >> 1), Y + y0 + (h >> 1), Math.max(1, Math.round((one ? 7 : 4) * thin)), one ? 22 : 11, one, anim, thin * 0.7)
    }
  }
}

// ---- the sawmill: a timber mill, its water wheel turning in the race, the saw in its open bay, logs piled up

/** The water wheel at four angles: a rim lit on its upper left, paddles round it, four spokes, the hub. */
function wheelFrames(big: boolean): Rows[] {
  const R = big ? 6 : 3
  const size = 2 * R + 3
  const c = R + 1
  return [0, 26.565, 45, 63.435].map(deg => {
    const g: string[][] = []
    for (let y = 0; y < size; y++) g.push(new Array(size).fill('.'))
    const set = (x: number, y: number, ch: string) => {
      const r = g[y]
      if (r && x >= 0 && x < size) r[x] = ch
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - c
        const dy = y - c
        const d = Math.sqrt(dx * dx + dy * dy)
        const lit = dx + dy < 0
        if (d <= R + 0.5 && d > R - (big ? 1.3 : 0.5)) set(x, y, d > R - 0.5 ? (lit ? 'w' : 'B') : 'd')
        else if (d <= R - 0.5) {
          // close-up open between the spokes; at overview a solid wheel, its spokes dark on it
          if (!big) set(x, y, 'B')
          for (let a = 0; a < 4; a++) {
            const t = ((deg + a * 90) * Math.PI) / 180
            const along = dx * Math.cos(t) + dy * Math.sin(t)
            const perp = -dx * Math.sin(t) + dy * Math.cos(t)
            if (along > 0 && Math.abs(perp) <= 0.5) set(x, y, big ? 'B' : 'd')
          }
        }
      }
    }
    // paddles standing out of the rim, eight round it (close-up)
    for (let k = 0; k < (big ? 8 : 0); k++) {
      const t = ((deg + k * 45) * Math.PI) / 180
      set(Math.round(c + (R + 1) * Math.cos(t)), Math.round(c + (R + 1) * Math.sin(t)), 'd')
    }
    set(c, c, 'I')
    if (big) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) set(c + dx, c + dy, 'm')
    return g.map(r => r.join(''))
  })
}

const WHEEL_CU = wheelFrames(true)
const WHEEL_OV = wheelFrames(false)

/** The mill race: a stone-lined channel of water under the wheel, there before the mill is. GROUND. */
const millRace: Extra = (pen, X, Y, look, lv, pal, big) => {
  const [x0, x1, y0, y1] = big ? [0, 14, 25, 29] : [0, 8, 12, 14]
  pen.as(GROUND, () => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const edge = y === y0 || (big && y === y1)
        pen.dot(X + x, Y + y, edge ? (y === y0 ? C.stoneLight : C.stoneDark) : (x + y * 2 + (look.anim >> 1)) % 7 === 0 && big ? C.waterLight : y > y0 + 1 ? C.waterDeep : C.water)
      }
    }
  })
  void lv
  void pal
}

/** The wheel, turning when the mill stands, its foot in the race with the water foaming round it. */
const millWheel: Extra = (pen, X, Y, look, lv, pal, big, standing) => {
  if (!standing || look.fire >= BURN.wallsFall) return
  const frames = big ? WHEEL_CU : WHEEL_OV
  const rows = frames[look.fire >= 0 ? 1 : (look.anim >> 1) % frames.length] ?? frames[0]
  if (!rows) return
  const R = big ? 6 : 3
  const cx = big ? 7 : 4
  const cy = big ? 20 : 9
  const ox = X + cx - R - 1
  const oy = Y + cy - R - 1
  paint(pen, rows, ox, oy, pal)
  // the axle into the wall
  pen.dot(X + cx + 1, Y + cy, C.ironDark)
  pen.as(OVERLAY, () => {
    const wy = Y + (big ? 26 : 13)
    for (let x = cx - R - 1; x <= cx + R + 1; x++) {
      const on = pen.get(X + x, wy)
      if (on !== C.water && on !== C.waterDeep && on !== C.waterLight) pen.dot(X + x, wy, (x + (look.anim >> 1)) % 3 ? C.water : C.waterLight)
    }
    if (big && look.fire < 0) {
      const f = look.anim % 4
      pen.dot(X + cx - R - 1 + (f >> 1), wy - 1, C.white)
      pen.dot(X + cx + R + 1 - (f & 1), wy - 1, C.waterLight)
    }
  })
  void lv
}

const SAW_CU: Art = {
  w: 40,
  h: 30,
  parts: [
    part('found', 7, 27, ['ssssssssssssssssssssssssss', 'SSMSSSSMSSSKssssKSSSSMSSMS', 'SSSSMSSSSSKSSSSSSKSMSSSSSS']),
    ...split(6, 7, [
      '......rrrrrrrrrrrrrrrr......',
      '.....LRRRRRRRRRRRRRRRRh.....',
      '....LLnnnnnnnnnnnnnnnnhh....',
      '...LLRRRRRRRRRRRRRRRRRRhh...',
      '..LLLnnnnnnnnnnnnnnnnnnhhh..',
      '.LLLRRRRRRRRRRRRRRRRRRRRhhh.',
      'LLLLnnnnnnnnnnnnnnnnnnnnhhhh',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '..dddddddddddddddddddddddd..',
      '..sSSSSSSSSTTTTTTTTTTTTTTT..',
      '..sSSMSSSSSTDDdDTTOOOOOOOT..',
      '..sMMMMMgGGTDDdDTTOOiiiOOT..',
      '..sSSSSSGGGTDDdDTTOiimmmOT..',
      '..sSMSSSdddTDDdDTTOimImmOT..',
      '..sMMMMMMMMTDDdDTTOimmmmOT..',
      '..sSSSSMSSSTDDdDTT5444447T..',
      '..sSSSSMSSSTDDdDTT7444447T..',
      '..sMMMMMMMMTDkdDTTTTTTTTTT..',
      '..sSSMSSSSSTDDdDTTTOOOOOTT..',
      '..sSSMSSSSSTDDdDTTHHOOOzHT..',
    ]),
    // level 3: a dormer with a hoist, a log hanging from it
    part('roof', 15, 8, ['..LRh...', '.LRRRhoo', 'LgGGGGhd', '.GGGGG.t', '.ppppp.t'], 3),
    part('prop', 22, 13, ['4', '4', '7'], 3),
    // the log pile
    part('prop', 31, 22, ['...55....', '..5567...', '..5667...', '.557755..', '55675567.', '56675667.', '.77..77..']),
    // level 3: a second pile
    part('prop', 35, 25, ['..55.', '.5567', '.5667', '..77.'], 3),
    // level 2: a stack of sawn planks in front of the bay
    part('prop', 23, 24, ['wwwwwwww', 'BBBBBBBd', 'wwwwwwww', 'BBBBBBBd', 'dd.dd.dd'], 2),
  ],
  fire: [9, 14, 20, 25, 30],
  smoke: [],
  ladder: 34,
  pole: 37,
  deck: 13,
  banners: [[15, 17], [22, 17]],
  flags: [[19, 7, 5]],
  pit: true,
  ruin: { x0: 9, x1: 31, ground: 26, posts: [9, 20, 31] },
}

const SAW_OV: Art = {
  w: 20,
  h: 15,
  parts: [
    part('found', 3, 13, ['ssssssssssssss', 'SSSSSSSSSSSSSS']),
    ...split(3, 3, [
      '...rrrrrrrr...',
      '..LRRRRRRRRh..',
      '.LLRRRRRRRRhh.',
      'eeeeeeeeeeeeee',
      '.dddddddddddd.',
      '.sSSSTTTTTTTT.',
      '.sSSSTDDTOiOT.',
      '.sMMMTDDTimiT.',
      '.sSSSTDDT444T.',
      '.sSSSTDDTTTTT.',
    ]),
    part('roof', 8, 4, ['GG'], 3),
    part('prop', 16, 11, ['.57.', '.67.', '5757', '6767']),
    part('prop', 11, 12, ['wwwww', 'BBBBd'], 2),
  ],
  fire: [5, 9, 14],
  smoke: [],
  ladder: 17,
  pole: 19,
  deck: 5,
  banners: [[8, 8], [11, 8]],
  flags: [[9, 3, 5]],
  pit: true,
  ruin: { x0: 4, x1: 15, ground: 12, posts: [4, 10, 15] },
}

// ---- the warehouse: a tall store under a steep gable, a hoist over the loft door, great doors, crates and barrels

const CRATE = ['11111', '22322', '22322', '33333'] as const
const BARREL = ['.BB.', 'wBBd', 'immI', 'wBBd', 'wBBd', 'immI', '.dd.'] as const

const STORE_CU: Art = {
  w: 38,
  h: 28,
  parts: [
    part('found', 4, 25, ['ssssssssssssssssssssssssssssss', 'SSMSSSSMSSSSKssssssKSSSSMSSSMS', 'SSSSMSSSSSSKSSSSSSSSKSSSSSSMSS']),
    // level 3: a lean-to on the left, under its own roof
    ...split(0, 12, ['....LL', '..LLLL', 'LLLLLL', 'eeeeee', 'ddddd.', 'wBBdw.', 'wBBdw.', 'wTTTw.', 'wTDTw.', 'wTDTw.', 'wTDTw.', 'wTDTw.', 'wTDTw.'], 3),
    ...split(5, 1, [
      '.............rr.............',
      '............LLhh............',
      '...........LLLhhh...........',
      '..........LLLoohhh..........',
      '.........LLLBdwBhhh.........',
      '........LLLwTTTTdhhh........',
      '.......LLLdwTDDTdwhhh.......',
      '......LLLBdwTDDTdwBhhh......',
      '.....LLLwBdwTDdTdwBdhhh.....',
      '....LLLdwBdwTTTTdwBdwhhh....',
      '...LLLBdwBdwBdwBdwBdwBhhh...',
      '..LLLwBdwBdwBdwBdwBdwBdhhh..',
      '.LLLdwBdwBdwBdwBdwBdwBdwhhh.',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'KKKKKKKKKKKKKKKKKKKKKKKKKKKK',
      'sSSSSSSSSTTTTTTTTTTSSSSSSSSK',
      'sSSMSSSSSTDDDddDDDTSSSSMSSSK',
      'sSgGGSSSSTIIIddIIITSSSgGGSSK',
      'sSGGGSSSSTDDDddDDDTSSSGGGSSK',
      'sSwwwSMSSTDDDddDDDTSMSwwwSSK',
      'sSSSSSSSSTDDDddDDDTSSSSSSSSK',
      'sMSSSSSMSTIIIddIIITSMSSSSSMK',
      'sSSSSSSSSTDDDddDDDTSSSSSSSSK',
      'sSSSMSSSSTDDkddkDDTSSSSMSSSK',
    ]),
    // level 2: a crate on the hoist's rope
    part('prop', 13, 5, ['.t', '.t', '.t', '.t', '11111'.slice(0, 4), '2232', '3333'], 2),
    // crates and barrels
    part('prop', 0, 20, CRATE),
    part('prop', 0, 24, CRATE),
    part('prop', 33, 21, BARREL),
    part('prop', 33, 16, ['.....', ...CRATE], 2),
    part('prop', 28, 24, CRATE.map(r => r.slice(0, 4)), 2),
  ],
  fire: [9, 14, 19, 24, 29],
  smoke: [],
  ladder: 1,
  pole: 36,
  deck: 13,
  banners: [[7, 17], [29, 17]],
  flags: [[18, 1, 5]],
  pit: true,
  ruin: { x0: 6, x1: 31, ground: 24, posts: [6, 18, 31] },
}

const STORE_OV: Art = {
  w: 19,
  h: 14,
  parts: [
    part('found', 1, 12, ['sssssssssssssssss', 'SSSSSSSSSSSSSSSSS']),
    ...split(0, 5, ['..LL', 'LLLL', 'eeee', 'wBd.', 'wDd.', 'wDd.'], 3),
    ...split(2, 0, [
      '.......r.......',
      '......LRh......',
      '.....LLBhh.....',
      '....LLwBBhh....',
      '...LLBTDTBhh...',
      '..LLwBTDTBBhh..',
      '.LLBwBBBBwBdhh.',
      'eeeeeeeeeeeeeee',
      'KKKKKKKKKKKKKKK',
      'sSGSSTDDDTSSGSK',
      'sSSSSTIIITSSSSK',
      'sSSSSTDDDTSSSSK',
    ]),
    part('prop', 9, 3, ['t', '2'], 2),
    part('prop', 0, 10, ['11', '23', '33']),
    part('prop', 17, 9, ['BB', 'mm', 'BB', 'dd']),
    part('prop', 14, 11, ['11', '33'], 2),
  ],
  fire: [4, 9, 14],
  smoke: [],
  ladder: 0,
  pole: 18,
  deck: 5,
  banners: [[4, 9], [13, 9]],
  flags: [[9, 0, 5]],
  pit: true,
  ruin: { x0: 3, x1: 15, ground: 11, posts: [3, 9, 15] },
}

// ---- boats: a rowing boat, a sailing boat and a ship, their hulls (and sails) in the builder's color

/** A rowing boat side on, its bow to the right: the gunwale, the thwarts inside, the painted hull. */
const ROWBOAT_CU = ['.wwwwwwwww.', 'wdBBdBBBdBw', 'bbbbbbbbbbb', '.cccccccc..']
const ROWBOAT_OV = ['wddw', 'bbbc']
/** A sailing boat: a mast, a sail of dyed canvas, the hull. */
const SAILBOAT_CU = [
  '....d......',
  '....dL.....',
  '....dLL....',
  '....dLLL...',
  '....dLLLL..',
  '....dLLLLR.',
  '....dRRRRR.',
  '.ddddddd...',
  'wwwwwwwwwww',
  'bbbbbbbbbbb',
  '.ccccccccc.',
]
const SAILBOAT_OV = ['.d.', '.dL', '.dR', 'www', 'bbc']
/** The harbor's ship: a square sail on its yard, a raised stern, a pointed bow with a bowsprit. */
const SHIP_CU = [
  '..............d...............',
  '........ddddddddddddd.........',
  '........LLLLLLLLLLLLR.........',
  '........LLLLLLLLLLLLR.........',
  '........LLLLLLLLLLLLR.........',
  '........LLLLLLLLLLLRR.........',
  '........LLLLLLLLLLLRR.........',
  '..d.....RRRRRRRRRRRRR.........',
  '..d...........d...............',
  '..dL..........d...............',
  '..dLL.........d..........d....',
  'wwwwwww.......d.........wd....',
  'BB*BBBw.......d........wBddddd',
  'BBBBBBwwwwwwwwwwwwwwwwwwBB....',
  'BBBBBBBBBBBBBBBBBBBBBBBBBw....',
  'bbbIbbbbIbbbbIbbbbIbbbbIbb....',
  '.bbbbbbbbbbbbbbbbbbbbbbbbb....',
  '..cccccccccccccccccccccccc....',
]
const SHIP_OV = [
  '......d.......',
  '....LLLLL.....',
  '....LLLLR.....',
  '.....RRR......',
  '.d....d.......',
  'w*B...d....wdd',
  'BBBwwwwwwwwwB.',
  'bbbbbbbbbbbbb.',
  '.ccccccccccc..',
]

const SHIP_CU_F = flipped(SHIP_CU)
const SHIP_OV_F = flipped(SHIP_OV)
const SAILBOAT_CU_F = flipped(SAILBOAT_CU)
const SAILBOAT_OV_F = flipped(SAILBOAT_OV)
const ROWBOAT_CU_F = flipped(ROWBOAT_CU)
const ROWBOAT_OV_F = flipped(ROWBOAT_OV)

/** A boat on the water at (x, y), bobbing a pixel with `anim` (`phase` sets it apart from its neighbours). */
function boatOn(pen: Pen, rows: Rows, x: number, y: number, pal: Pal, anim: number, phase: number, big: boolean, sink = 0, lit = false) {
  const bob = big ? ((anim + phase) >> 2) % 2 : 0
  const n = rows.length
  pen.as(OBJECT, () => paint(pen, rows, x, y + bob + sink, pal, 0, n - sink))
  if (lit && sink === 0) lights(pen, rows, x, y + bob, true, -1, anim)
  if (big && sink === 0) {
    // the water lapping at bow and stern
    pen.as(OVERLAY, () => {
      const r = rows[n - 1] ?? ''
      pen.dot(x - 1, y + n - 1 + bob, C.waterLight)
      pen.dot(x + r.length, y + n - 2 + bob, C.waterLight)
    })
  }
}

// ---- the dock: a wooden jetty out into the lake, posts along it, a boat tied up

/**
 * A dock: its jetty starts on the bank at the top (where the path comes in) and runs out over the water. A first
 * build drives its posts one by one from the bank outward, then lays the planks the same way. A rowing boat is tied
 * up once it is finished; from level 2 a sailing boat too, 3 a boathouse on the bank, 4 lanterns on the posts (and
 * gold trim), 5 pennants. It burns with its planks, leaving charred posts standing in the water.
 */
function drawDock(pen: Pen, s: Scale, X: number, Y: number, look: BuildLook) {
  const big = s === 1
  const t = look.fire
  const anim = look.anim
  const lv = Math.max(1, look.level)
  const done = look.level >= 1
  const pal = palOf(look.color, lv >= 4 && done, look.style)
  const p = done ? 1 : look.progress
  // the jetty: deck columns, the bank end, the far end, posts along both sides
  const [d0, d1, top, end] = big ? [12, 17, 1, 19] : [6, 8, 1, 9]
  const postRows = big ? [4, 9, 14] : [3, 6]
  const posts: [number, number][] = []
  for (const r of postRows) posts.push([d0 - 1, r], [d1 + 1, r])
  posts.push([d0, end + 1], [d1, end + 1])
  const ruined = t >= BURN.ruins
  const burning = t >= 0
  const postsUp = clamp(p / 0.5) * posts.length
  const deckTo = top + Math.round(clamp((p - 0.5) / 0.5) * (end - top + 1)) - 1
  // a fire eats the deck from the far end once it has raged a while; then only posts are left
  const burnt = burning ? Math.round(clamp((t - BURN.roofFalls) / (BURN.ruins - BURN.roofFalls)) * (end - top + 1)) : 0
  const deckEnd = ruined ? top + 2 : Math.min(deckTo, end - burnt)
  pen.as(OBJECT, () => {
    // the boathouse on the bank (level 3)
    if (done && lv >= 3) {
      if (big) {
        if (ruined) paint(pen, ['X..X...X', 'XJJXJJJX'], X + 1, Y + 4, pal)
        else
          paint(pen, [
            '..rrrrrr..',
            '.LLRRRRhh.',
            'LLLRRRRhhh',
            'eeeeeeeeee',
            '.wBGGBDDw.',
            '.wBBBBDDw.',
          ], X, Y, pal)
      } else if (!ruined) paint(pen, ['LRRh', 'eeee', 'wGDw'], X, Y, pal)
    }
    // posts: driven one by one from the bank outward
    posts.forEach(([c, r], k) => {
      if (k >= postsUp && !done) return
      if (ruined && k % 2 === 1 && r <= end) return
      if (big) {
        pen.dot(X + c, Y + r, ruined ? C.char : C.woodLight)
        pen.dot(X + c, Y + r + 1, ruined ? C.ash : C.woodDark)
      } else (pen.dot(X + c, Y + r, ruined ? C.char : C.woodLight), pen.dot(X + c, Y + r + 1, ruined ? C.ash : C.woodDark))
    })
    // the deck: planks across, a joint every third, the far end's beam
    for (let r = top; r <= deckEnd; r++) {
      for (let c = d0; c <= d1; c++) {
        let col = (r - top) % 3 === 2 ? C.wood : c === d0 ? S.rope : C.woodLight
        if (c === d1) col = C.wood
        if (ruined) col = (r + c) % 3 ? C.char : C.ash
        pen.dot(X + c, Y + r, col)
      }
    }
    if (deckEnd >= end && !ruined) for (let c = d0; c <= d1; c++) pen.dot(X + c, Y + end + 1, c === d0 || c === d1 ? C.wood : C.woodDark)
    // lanterns on the posts (level 4)
    if (done && lv >= 4 && !ruined && big) {
      for (const [c, r] of [[d0 - 1, postRows[1] ?? 9], [d1 + 1, postRows[1] ?? 9], [d0 - 1, end - 2], [d1 + 1, end - 2]] as const) {
        pen.dot(X + c, Y + r - 1, C.ironDark)
        pen.dot(X + c, Y + r - 2, S.lantern)
        if (look.lit) pen.glow(X + c, Y + r - 2, C.lit)
      }
    }
    // pennants on the far posts (level 5)
    if (done && lv >= 5 && !ruined) {
      for (const c of [d0 - 1, d1 + 1]) {
        const r0 = big ? end - 6 : end - 3
        for (let r = r0; r < end - 2; r++) pen.dot(X + c, Y + r, C.woodLight)
        const dir = c < d0 ? -1 : 1
        pen.dot(X + c + dir, Y + r0, pal['b'.charCodeAt(0)] ?? 0)
        if (big) (pen.dot(X + c + dir * 2, Y + r0 + (anim % 2), pal['b'.charCodeAt(0)] ?? 0), pen.dot(X + c + dir, Y + r0 + 1, pal['c'.charCodeAt(0)] ?? 0))
      }
    }
    // a pile of planks on the bank while it is built
    if (look.building && !burning) paint(pen, big ? CU_PILE.slice(3) : OV_PILE.slice(2), X + (big ? 22 : 11), Y + (big ? 3 : 1), pal)
  })
  // boats: the rowing boat from the first, a sailing boat from level 2, tied up alongside
  if (done && !ruined) {
    const sink = burning ? Math.round(clamp((t - BURN.roofFalls) / 1500) * 4) : 0
    // which side each boat is tied up on, from the dock's style
    const swap = look.style % 2 === 1
    const lit = look.lit && !burning
    if (big) {
      boatOn(pen, swap ? ROWBOAT_CU_F : ROWBOAT_CU, X + (swap ? 19 : 0), Y + 12, pal, anim, 0, big, Math.min(sink, 3), lit)
      if (lv >= 2) boatOn(pen, swap ? SAILBOAT_CU_F : SAILBOAT_CU, X + (swap ? 0 : 19), Y + 8, pal, anim, 3, big, Math.min(sink, 10), lit)
      // the boat's line to the post
      if (!burning) pen.as(OVERLAY, () => pen.dot(X + (swap ? 18 : 11), Y + 12 + ((anim >> 2) % 2), S.rope))
    } else {
      boatOn(pen, swap ? ROWBOAT_OV_F : ROWBOAT_OV, X + (swap ? 10 : 1), Y + 6, pal, anim, 0, big, Math.min(sink, 1), lit)
      if (lv >= 2) boatOn(pen, swap ? SAILBOAT_OV_F : SAILBOAT_OV, X + (swap ? 1 : 10), Y + 4, pal, anim, 3, big, Math.min(sink, 4), lit)
    }
  }
  if (burning) {
    const step = Math.min(5, Math.floor(t / 1500))
    char(pen, X, Y, big ? 30 : 15, big ? 22 : 11, step)
    const cx = X + ((d0 + d1) >> 1)
    if (!ruined) {
      const k = fierce(t)
      const n = big ? 4 : 2
      for (let i = 0; i < n; i++) {
        const r = top + 2 + Math.round(((deckEnd - top - 2) * (i + 0.5)) / n)
        if (r > deckEnd) continue
        flame(pen, cx + (i % 2 ? 1 : -1), Y + r + 1, big ? 5 : 3, Math.round((big ? 5 + 6 * flick(anim, i) : 2 + 3 * flick(anim, i)) * k), Math.round(Math.sin(anim * 0.9 + i)))
      }
      smoke(pen, cx, Y + top + 4, Math.round((big ? 5 : 3) + (big ? 6 : 3) * clamp(t / 2500)), big ? 20 : 10, big, anim, Math.min(1, 0.4 + t / 3000))
    } else if (t < BURN.smoke) {
      const thin = 1 - (t - BURN.ruins) / (BURN.smoke - BURN.ruins)
      if (t < BURN.embers) for (let k = 0; k < 3; k++) if ((anim + k) % 3) pen.glow(cx - 1 + k, Y + top + 1 + (k % 2), C.ember)
      smoke(pen, cx, Y + top + 2, Math.max(1, Math.round((big ? 5 : 3) * thin)), big ? 18 : 9, big, anim, thin * 0.7)
    }
  }
}

// ---- the harbor: a stone quay along the shore, a crane over the water, crates, ships moored alongside

const HARBOR_CU: Art = {
  w: 56,
  h: 32,
  parts: [
    // the quay: paving in courses of slabs on the bank, a coping along its edge, its stone face in the water
    part('found', 0, 5, [
      'sssKsssssssKsssssssKsssssssKsssssssKsssssssKsssssssKssss',
      'SSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSS',
      'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
      'sssssssKsssssssKsssssssKsssssssKsssssssKsssssssKsssssssK',
      'SSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSKSSSSSSSK',
      'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
      'ssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
      'KKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKK',
      'KKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKKKKKMKK',
      '00000000000000000000000000000000000000000000000000000000',
    ]),
    // level 4: the harbor master's house by the path, gold on its eaves
    ...split(14, 0, [
      '...rrrrrr...',
      '..LRRRRRRh..',
      '.LLRRRRRRhh.',
      'LLLRRRRRRhhh',
      'eeeeeeeeeeee',
      '.TTTTTTTTTT.',
      '.TgGTDDTgGT.',
      '.TGGTDDTGGT.',
      '.TPPTDDTPPT.',
      '.TTTTDDTTTT.',
    ], 4),
    // the crane: a post on the quay, a brace, its jib out over the ship with a counterweight, a load on its rope
    part('wall', 48, 2, ['wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'Bd']),
    part('roof', 38, 0, ['wwwwwwwwwwwwww990', 'ddddddddddddddd00', '......wd.....w90.', '.......wd...wB...', '........wd..wB...', '.........wd.wB...'].map(r => r)),
    part('prop', 41, 2, ['t', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'm']),
    part('prop', 39, 22, ['11111', '22322', '33333']),
    // level 3: a second crane at the near end, unloading the sailing boat
    part('wall', 2, 2, ['wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'wB', 'Bd'], 3),
    part('roof', 0, 0, ['099wwwwwwwww', '00dddddddddd', '.09wB..dw...', '...wB.dw....', '...wBdw.....', '...wBw......'], 3),
    part('prop', 10, 2, ['t', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 'm', '%&', '&&'], 3),
    // a lamp post by the path
    part('prop', 25, 1, ['I', '*', 'I', 'm', 'm', 'm', 'm', 'm', 'I']),
    // crates, barrels and sacks on the quay
    part('prop', 30, 6, CRATE),
    part('prop', 35, 5, ['.BB.', 'wBBd', 'immI', 'wBBd', '.dd.']),
    part('prop', 30, 3, ['.%%&.', '%%&&&'].map(r => r)),
    part('prop', 6, 4, [...CRATE.map(r => r)], 2),
    part('prop', 7, 1, ['11111'.slice(0, 4), '2232'].concat(['3333']), 2),
    part('prop', 18, 6, ['.BB.', 'wBBd', 'immI', 'wBBd', '.dd.'], 2),
    // bollards along the edge
    part('prop', 6, 10, ['I', 'm']),
    part('prop', 22, 10, ['I', 'm']),
    part('prop', 34, 10, ['I', 'm']),
    part('prop', 53, 10, ['I', 'm']),
  ],
  fire: [8, 20, 31, 42, 49],
  smoke: [],
  ladder: 44,
  pole: 54,
  deck: 2,
  ground: 10,
  pile: [0, 4],
  banners: [[16, 6], [22, 6]],
  flags: [[19, 0, 5]],
  pit: false,
  ruin: { x0: 30, x1: 52, ground: 10, posts: [48, 41] },
}

const HARBOR_OV: Art = {
  w: 28,
  h: 16,
  parts: [
    part('found', 0, 2, [
      'ssssssssssssssssssssssssssss',
      'SSSKSSSSSSSKSSSSSSSKSSSSSSSK',
      'SSSSSSSKSSSSSSSKSSSSSSSKSSSS',
      'ssssssssssssssssssssssssssss',
      'KKKKKKKKKKKKKKKKKKKKKKKKKKKK',
      '0000000000000000000000000000',
    ]),
    ...split(7, 0, ['.rrrr.', 'LRRRRh', 'eeeeee', 'TGTDGT'], 4),
    part('wall', 24, 0, ['w', 'w', 'w', 'w', 'B']),
    part('roof', 19, 0, ['wwwwwww9']),
    part('prop', 20, 1, ['t', 't', 't', 't', 't', 't', 't', 't', '2']),
    part('wall', 2, 0, ['w', 'w', 'w', 'w', 'B'], 3),
    part('roof', 1, 0, ['9wwww'], 3),
    part('prop', 5, 1, ['t', 't', 't', 't', 't', 't', '&'], 3),
    part('prop', 13, 0, ['*', 'm', 'm']),
    part('prop', 15, 2, ['11', '33']),
    part('prop', 17, 1, ['B', 'm', 'd']),
    part('prop', 9, 3, ['11', '33'], 2),
  ],
  fire: [5, 13, 22],
  smoke: [],
  ladder: 21,
  pole: 26,
  deck: 1,
  ground: 4,
  pile: [0, 1],
  banners: [[8, 3], [11, 3]],
  flags: [[9, 0, 5]],
  pit: false,
  ruin: { x0: 15, x1: 26, ground: 4, posts: [24, 20] },
}

/**
 * The ships alongside the quay: the first once it is finished, a second from level 2. A fire catches their decks;
 * the sails burn away, then the hulls sink.
 */
const harborShips: Extra = (pen, X, Y, look, lv, pal, big, standing) => {
  if (!standing) return
  const t = look.fire
  if (t >= BURN.ruins) return
  const lit = look.lit && t < 0
  const ship = (rows: Rows, x: number, y: number, deckRow: number, phase: number) => {
    if (t < BURN.roofFalls) return boatOn(pen, rows, X + x, Y + y, pal, look.anim, phase, big, 0, lit)
    // the rig gone, only the hull left, going down
    const hull = rows.slice(deckRow)
    const sink = t < BURN.wallsFall ? 0 : Math.round(clamp((t - BURN.wallsFall) / (BURN.ruins - BURN.wallsFall)) * hull.length)
    if (sink < hull.length) boatOn(pen, hull, X + x, Y + y + deckRow, pal, look.anim, phase, big, sink)
  }
  const turn = look.style % 2 === 1
  if (big) {
    if (lv >= 2) ship(turn ? SAILBOAT_CU_F : SAILBOAT_CU, 3, 17, 8, 5)
    ship(turn ? SHIP_CU_F : SHIP_CU, 16, 13, 11, 0)
    if (lv >= 5 && t < 0) flag(pen, X, Y, turn ? 31 : 30, 13 + ((look.anim >> 2) % 2), pal, look.anim, big)
  } else {
    if (lv >= 2) ship(turn ? SAILBOAT_OV_F : SAILBOAT_OV, 3, 9, 3, 5)
    ship(turn ? SHIP_OV_F : SHIP_OV, 11, 6, 5, 0)
  }
  if (t >= 0 && t < BURN.wallsFall) {
    const k = fierce(t)
    const spots = big ? [[21, 25], [29, 26], [37, 26]] : [[13, 12], [17, 12]]
    spots.forEach(([fx, fy], i) => {
      if (t < 1500 && i > 0) return
      flame(pen, X + (fx ?? 0), Y + (fy ?? 0), big ? 5 : 3, Math.round((big ? 4 + 6 * flick(look.anim, i + 3) : 2 + 3 * flick(look.anim, i + 3)) * k), Math.round(Math.sin(look.anim * 0.9 + i)))
    })
  }
}

// ---- the lighthouse: a striped tower on the rocks off the shore, its lamp turning at night

const LIGHT_CU: Art = {
  w: 18,
  h: 44,
  parts: [
    // the rocks it stands on, there before it
    part('base', 0, 31, [
      '.....8899........',
      '...889999900.....',
      '..8999999999990..',
      '.89999999999990..',
      '899999999999900.',
      '8999999999999990.',
      '.8899999999999900',
      '..89999999999900.',
      '...999000999000..',
      '....000..0000....',
      '..........00.....',
    ].map(r => r.padEnd(18, '.'))),
    part('base', 12, 27, ['.889.', '89990', '99900']),
    part('found', 4, 35, ['ssssssssss', 'SSMSSSSMSK']),
    part('wall', 5, 11, [
      '.WRRRRh.',
      '.WRRRRh.',
      '.WRRRRh.',
      '.WRRRRh.',
      '.WPPPPp.',
      '.WPGGPp.',
      '.WPPPPp.',
      '.WPPPPp.',
      '.LRRRRh.',
      '.LRRRRh.',
      '.LRRRRh.',
      '.LRRRRh.',
      'WPPPPPPp',
      'WPPGGPPp',
      'WPPPPPPp',
      'WPPPPPPp',
      'LRRRRRRh',
      'LRRRRRRh',
      'LRRRRRRh',
      'LRRRRRRh',
      'WPPddPPp',
      'WPPDDPPp',
      'WPPDDPPp',
      'WPPDDPPp',
    ].map(r => r.replace(/R/g, 'b').replace(/h/g, 'c'))),
    // level 2: a stone foot
    part('wall', 5, 31, ['sSSddSSK', 'sSSDDSSK', 'sMSDDSMK', 'sSSDDSSK'], 2),
    // the gallery, the lantern, its cap
    part('roof', 3, 9, ['IIIIIIIIIIII', '.iiiiiiiiii.'].map(r => r)),
    part('roof', 5, 4, ['.IIIIII.', '.I****I.', '.I****I.', '.I****I.', '.IIIIII.']),
    part('roof', 4, 0, ['....rr....', '...LRRh...', '..LLRRhh..', '.eeeeeeee.']),
    // level 4: a gilded lantern
    part('roof', 5, 4, ['.kkkkkk.', '.k....k.', '.k....k.', '.k....k.', '.kkkkkk.'], 4),
    // level 3: the keeper's hut on the rocks
    ...split(12, 27, ['.rrr.', 'LRRhh', 'eeeee', 'wGDw.'], 3),
    // level 3: a rowing boat tied at the rocks
  ],
  fire: [7, 9, 11],
  smoke: [],
  ladder: 2,
  pole: 15,
  deck: 8,
  ground: 35,
  pile: [0, 8],
  banners: [[4, 22], [12, 22]],
  flags: [[8, 0, 5]],
  pit: false,
  ruin: { x0: 3, x1: 14, ground: 34, posts: [], stump: [5, 12, 24] },
}

const LIGHT_OV: Art = {
  w: 9,
  h: 22,
  parts: [
    part('base', 0, 16, ['..8999...', '.8999990.', '899999900', '.9990000.', '..00.00..']),
    part('found', 2, 17, ['sssss']),
    part('wall', 2, 6, ['.bbc.', '.bbc.', '.WPp.', '.WPp.', 'bbbbc', 'bbbbc', 'WPPPp', 'WPPPp', 'bbbbc', 'WPDPp', 'WPDPp']),
    part('wall', 2, 14, ['sSDSK', 'sSDSK', 'sSDSK'], 2),
    part('roof', 1, 5, ['IIIIIII']),
    part('roof', 2, 3, ['I**I'.padStart(5, '.').slice(0, 5), '.I**I'].slice(1).concat(['.III.'])),
    part('roof', 2, 0, ['..r..', '.LRh.', 'eeeee']),
    part('roof', 2, 3, ['.k..k', '.kkkk'].map(r => r), 4),
    ...split(6, 14, ['LRh', 'wGw'].map(r => r), 3),
  ],
  fire: [3, 4, 5],
  smoke: [],
  ladder: 0,
  pole: 8,
  deck: 4,
  ground: 17,
  pile: [0, 3],
  banners: [[1, 10], [6, 10]],
  flags: [[4, 0, 5]],
  pit: false,
  ruin: { x0: 1, x1: 7, ground: 16, posts: [], stump: [2, 6, 11] },
}

/**
 * The tower painted in a spiral instead of bands: its color and white run round it diagonally, a pixel across for
 * every row, each keeping its lit left edge and shaded right one. Doors and windows stay.
 */
function spiralled(a: Art, y0: number, band: number): Art {
  const PAINT = new Set(['b', 'c', 'L', 'W', 'P', 'p'])
  const parts = a.parts.map(p => {
    if (p.cls !== 'wall' || p.lv > 1 || p.y !== y0) return p
    const rows = p.rows.map((r, j) => {
      const e = ends(r)
      const l = e[0] ?? 0
      const rr = e[e.length - 1] ?? r.length - 1
      return [...r]
        .map((ch, i) => {
          if (!PAINT.has(ch)) return ch
          const color = Math.floor((j + i + 64) / band) % 2 === 0
          return i === l ? (color ? 'L' : 'W') : i === rr ? (color ? 'c' : 'p') : color ? 'b' : 'P'
        })
        .join('')
    })
    return { ...p, rows }
  })
  return { ...a, parts }
}

const LIGHT_CU_2 = spiralled(LIGHT_CU, 11, 4)
const LIGHT_OV_2 = spiralled(LIGHT_OV, 6, 2)

/**
 * The lamp: by day its glass catches the sun, a glint stepping round it; lit, it glows and its beam turns, swept
 * left, toward you (a flash), right, then away (dim), a step every other frame. The beam stays in the footprint.
 */
const lamp: Extra = (pen, X, Y, look, lv, pal, big, standing) => {
  if (!standing || look.fire >= BURN.roofFalls) return
  const phase = (look.anim >> 1) % 4
  const [gx0, gx1, gy0, gy1] = big ? [7, 10, 5, 7] : [3, 4, 3, 3]
  const cy = big ? 6 : 3
  if (look.fire >= 0) return
  if (!look.lit) {
    const k = gx0 + ((look.anim >> 1) % (gx1 - gx0 + 1))
    pen.dot(X + k, Y + gy0, C.white)
    return
  }
  for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) pen.glow(X + x, Y + y, phase === 3 ? C.fire[1] : phase === 1 ? C.white : C.fire[0])
  const W = big ? 18 : 9
  if (phase === 0 || phase === 2) {
    const left = phase === 0
    const from = left ? gx0 - 1 : gx1 + 1
    const len = left ? from + 1 : W - from
    for (let i = 0; i < len; i++) {
      const x = left ? from - i : from + i
      const spread = big ? Math.floor(i / 4) : Math.floor(i / 3)
      for (let dy = -spread; dy <= spread + (big ? 1 : 0); dy++) {
        const y = cy + dy - (big ? 0 : 0)
        if (y < 0) continue
        const pale = Math.abs(dy - (big ? 0.5 : 0)) >= spread && spread > 0
        pen.glow(X + x, Y + y, pale ? blend(C.lit, 0xffffff, 0.1) : 0xfff4c0)
      }
    }
  } else if (phase === 1 && big) {
    for (const [dx, dy] of [[-1, 0], [0, -1], [0, 1]] as const) pen.glow(X + gx0 + dx, Y + cy + dy, C.fire[0])
    for (const [dx, dy] of [[1, 0], [0, -1], [0, 1]] as const) pen.glow(X + gx1 + dx, Y + cy + dy, C.fire[0])
  }
  void lv
  void pal
}

/**
 * A works kind (kinds.ts WORK_KINDS) in its footprint (KINDS[kind] w by h close-up, halved overview), (x, y) its
 * top-left. The door, where the path starts, is the middle of the footprint's bottom edge; for water kinds the
 * shore crosses the footprint about a third of the way down, and the path starts at the middle of its top edge.
 */
export function drawWorks(pen: Pen, s: Scale, x: number, y: number, look: BuildLook) {
  const big = s === 1
  switch (look.kind) {
    case 'blacksmith':
      return works(pen, s, x, y, look, big ? SMITH_CU : SMITH_OV)
    case 'field':
      return drawField(pen, s, x, y, look)
    case 'sawmill':
      return works(pen, s, x, y, look, big ? SAW_CU : SAW_OV, millWheel, millRace)
    case 'warehouse':
      return works(pen, s, x, y, look, big ? STORE_CU : STORE_OV)
    case 'dock':
      return drawDock(pen, s, x, y, look)
    case 'harbor':
      return works(pen, s, x, y, look, big ? HARBOR_CU : HARBOR_OV, harborShips)
    case 'lighthouse':
      return works(pen, s, x, y, look, look.style % 2 === 1 ? (big ? LIGHT_CU_2 : LIGHT_OV_2) : big ? LIGHT_CU : LIGHT_OV, lamp)
    case 'farm':
      return works(pen, s, x, y, look, big ? FARM_CU : FARM_OV)
    case 'windmill':
      return works(pen, s, x, y, look, big ? MILL_CU : MILL_OV, millSails)
    default:
      // the town's own kinds are drawn by buildings.ts
      return
  }
}
