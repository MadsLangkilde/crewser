// The country round the town and the small things along its streets: roads, a river with bridges, farm fields
// with a windmill, street lamps, benches, signposts, market stalls, a well, bushes, rocks and flower beds. They
// make the map feel like a place from the start, before the crew has built anything. Drawn at two scales with
// art of their own; every size and position below is close-up (s = 1), the overview halves it (rounded).
//
// As in places.ts, the small things are pictures worked out once, a letter per pixel, painted through a palette.
// Light comes from the upper left: left faces lighter, right faces and undersides darker. Long stretches (roads,
// the river, fields) are kept calm: few marks, long dashes, never a checker or a scatter of lone pixels.
import { C, GROUND, OBJECT, OVERLAY, blend, shade, type Pen, type Scale } from './kit'

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

function at(p: Pic, x: number, y: number) {
  return x < 0 || y < 0 || x >= p.w || y >= p.h ? 0 : (p.px[y * p.w + x] ?? 0)
}

/** Where a letter is, as x, y pairs: windows and lanterns to light. */
function where(p: Pic, ch: string) {
  const out: number[] = []
  const code = ch.charCodeAt(0)
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.px[y * p.w + x] === code) out.push(x, y)
  return out
}

function pal(m: Readonly<Record<string, number>>): Pal {
  const a = new Int32Array(128).fill(-1)
  for (const key of Object.keys(m)) a[key.charCodeAt(0)] = m[key] ?? -1
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

function glowAt(pen: Pen, spots: readonly number[], x: number, y: number, c: number) {
  for (let i = 0; i + 1 < spots.length; i += 2) pen.glow(x + (spots[i] ?? 0), y + (spots[i + 1] ?? 0), c)
}

/** A well-mixed number from two integers: the same pixel always gets the same answer. */
function mix(a: number, b: number) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// ---- shades of our own, each on the terminal's 12-bit grid (steps of 17) so no two merge

const S = {
  // earth
  rut: 0xaa8855, lip: 0xccaa77, pebble: 0xddccaa, pebbleShade: 0x998866,
  // soil, fields
  soil: 0x775533, soilDark: 0x553322, soilLight: 0x886644,
  // banks
  sandLight: 0xddcc99, sandDark: 0xaa9966, mud: 0x886644, mudDark: 0x664433,
  // greens as the trees have them: highlight, light, mid, dark, underside
  gH: 0xaacc66, gL: 0x77aa44, gM: 0x559933, gD: 0x447733, gE: 0x335533,
  // hay and wheat
  hayWind: 0xffeeaa, hayLight: 0xeedd88, hay: 0xddbb55, hayShade: 0xbb9933, hayDark: 0x997722,
  // wood, a step below C.woodDark, and a warm roof
  woodDeep: 0x442211, plankShade: 0x775533, roofLight: 0xaa6644, roof: 0x884433, roofDark: 0x663322,
  // things on display
  apple: 0xcc3333, appleShade: 0x992222, orange: 0xee8833, orangeShade: 0xcc6622, bread: 0xcc9955,
  pumpkin: 0xee8822, pumpkinLight: 0xffaa44, pumpkinShade: 0xbb5511,
  canvas: 0xeeeedd, canvasShade: 0xccccbb, glassDay: 0xccddcc,
} as const

// ---- roads

/** Every color a road is painted in: how a road knows another one is there. */
const ROADS = new Set<number>([C.road, C.roadEdge, S.rut, S.lip, S.pebble, S.pebbleShade])

/**
 * The packed earth inside a road at a canvas pixel. `along` is the road's direction (true: left to right), `a` the
 * pixel's place across it and `n` the road's width across. Close-up a worn track runs a pixel in from the edge, in
 * long dashes: a dark groove with a lit lip on its far side (light from the upper left). Now and then a pebble,
 * lit on the left. All from the canvas position and the road's own place, so drawing it again gives the same.
 */
function earth(X: number, Y: number, along: boolean, one: boolean, a: number, n: number) {
  const u = along ? X : Y
  const v = along ? Y : X
  if (one && n >= 4) {
    const g = a === 1 || a === 2 ? 1 : n >= 7 && (a === n - 3 || a === n - 2) ? n - 3 : -1
    if (g > 0) {
      // the groove's two rows share their dashes: keyed on the groove's own first row
      const key = v - a + g
      const shift = mix(key, 7) % 13
      const slot = Math.floor((u + shift) / 13)
      const h = mix(slot, key)
      if (h % 5 < 3 && (u + shift) % 13 < 5 + ((h >>> 5) % 4)) return a === g ? S.rut : S.lip
    }
  }
  const m = (q: number) => mix(q, v * 31 + 5) % (one ? 89 : 131) === 0
  if (a > 0 && a < n - 1) {
    if (m(u)) return S.pebble
    if (one && m(u - 1)) return S.pebbleShade
  }
  return C.road
}

/**
 * A stretch of road, (x, y, w, h) in canvas pixels at this scale: packed earth, a slightly darker edge where it
 * meets the grass, worn wheel ruts along its length, a few pebbles. GROUND. Painted once into the town's ground,
 * so it must be deterministic from the canvas position (the same pixel always gets the same color).
 *
 * Where roads meet they join without a seam whichever is drawn first: an edge is only drawn where the road meets
 * something that is not road, and the edge of a road already there opens where this one runs into it. Close-up
 * the edge runs all round; at overview (2 px wide) only the shaded side, below and to the right.
 */
export function road(pen: Pen, s: Scale, x: number, y: number, w: number, h: number) {
  const one = s === 1
  const along = w >= h
  const isRoad = (X: number, Y: number) => pen.inside(X, Y) && ROADS.has(pen.get(X, Y))
  pen.as(GROUND, () => {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const X = x + i
        const Y = y + j
        let edge = false
        if (one) {
          edge =
            (h >= 3 && j === 0 && !isRoad(X, Y - 1)) ||
            (h >= 3 && j === h - 1 && !isRoad(X, Y + 1)) ||
            (w >= 3 && i === 0 && !isRoad(X - 1, Y)) ||
            (w >= 3 && i === w - 1 && !isRoad(X + 1, Y))
        } else {
          edge = (h >= 2 && j === h - 1 && !isRoad(X, Y + 1)) || (w >= 2 && i === w - 1 && !isRoad(X + 1, Y))
        }
        pen.dot(X, Y, edge ? C.roadEdge : earth(X, Y, along, one, along ? j : i, along ? h : w))
      }
    }
    // an edge of another road that this one now closes in on every side opens up
    const open = (X: number, Y: number) => {
      if (pen.get(X, Y) !== C.roadEdge || !pen.inside(X, Y)) return
      if (isRoad(X - 1, Y) && isRoad(X + 1, Y) && isRoad(X, Y - 1) && isRoad(X, Y + 1)) pen.dot(X, Y, C.road)
    }
    for (let i = 0; i < w; i++) (open(x + i, y - 1), open(x + i, y + h))
    for (let j = 0; j < h; j++) (open(x - 1, y + j), open(x + w, y + j))
  })
}

// ---- the river

/**
 * Reeds by the water, top row first, from the bank's outer column toward the water: h a cattail's brown head, s a
 * stem or leaf (the one standing in the water a shade darker).
 */
const REEDS1 = [
  ['.h..', '.h.h', '.s.h', 'ss.s', '.s.s'],
  ['...h', '.h.h', '.h.s', '.s.s', 'ss.s'],
  ['.h..', '.h..', 'ss.h', '.s.h', '.s.s'],
] as const
const REEDS2 = [['.h', 'sh', 'ss'], ['h.', 'hh', 'ss']] as const

/**
 * A river running down the map: for each canvas row `y0 + i`, water from column `rows[i].x` for `rows[i].w`
 * pixels, with its banks (sand or mud and reeds) drawn just outside that span. GROUND, so nothing rings it; the
 * engine calls it every frame for the rows in view, so ripples and sparkles can move with `anim`.
 *
 * Close-up a bank is 2 px each side (the left one shading toward the water, the right one catching the light),
 * 1 px at overview; long stretches of it are mud instead of sand, where reeds grow in clumps. The water is darker
 * under the left bank and in a channel down the middle; short light ripples drift downstream, now and then one
 * sparkles.
 */
export function river(pen: Pen, s: Scale, rows: readonly { x: number; w: number }[], y0: number, anim: number) {
  const one = s === 1
  const { px, kind } = pen
  const W = pen.w
  const H = pen.h
  const set = (X: number, Y: number, c: number) => {
    if (X < 0 || Y < 0 || X >= W || Y >= H) return
    const i = Y * W + X
    px[i] = c
    kind[i] = GROUND
  }
  const bank = one ? 2 : 1
  const block = one ? 18 : 9
  const flow = one ? anim >> 1 : anim >> 2
  const period = one ? 11 : 7
  const lanes = [0.22, 0.52, 0.8]
  const len = one ? 3 : 2
  const tall = one ? 5 : 3
  const reedRun = one ? 15 : 11
  const mudAt = (Y: number, side: number) => mix(Math.floor((Y + side * (block >> 1)) / block), 11 + side * 12) % 3 === 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const Y = y0 + i
    const { x, w } = r
    const up = rows[i - 1] ?? r
    const down = rows[i + 1] ?? r
    // the banks, widened where the river steps sideways so they never break
    const mudL = mudAt(Y, 0)
    const mudR = mudAt(Y, 1)
    const l0 = Math.min(x, up.x, down.x) - bank
    for (let X = l0; X < x; X++) set(X, Y, X === x - 1 && one ? (mudL ? S.mudDark : S.sandDark) : mudL ? S.mud : C.sand)
    const r1 = Math.max(x + w, up.x + up.w, down.x + down.w) + bank
    for (let X = x + w; X < r1; X++) set(X, Y, X === x + w && one ? (mudR ? S.mud : S.sandLight) : mudR ? S.mud : C.sand)
    // the water: the left bank's shadow, a deeper channel down the middle
    const lo = x + Math.round(w * 0.36)
    const hi = x + w - Math.round(w * 0.3)
    for (let X = x; X < x + w; X++) set(X, Y, X === x || (X >= lo && X < hi) ? C.waterDeep : C.water)
    // ripples drifting downstream, now and then a sparkle on one
    for (let L = 0; L < lanes.length; L++) {
      const v = Y - flow + L * 4
      if (((v % period) + period) % period !== 0) continue
      const id = Math.floor(v / period)
      const c = x + Math.round((lanes[L] ?? 0.5) * w) + (mix(id, L) % 3) - 1
      const a = Math.max(x + 2, c - (len >> 1))
      const b = Math.min(x + w - 2, a + len)
      for (let X = a; X < b; X++) set(X, Y, C.waterLight)
      if (one && b - a === len && mix(id * 3 + L, anim >> 1) % 5 === 0) set(a + 1, Y, C.white)
    }
    // reeds: now and then a clump at the water's edge (most where it is muddy), its stems in the water, kept
    // apart: at most one a side in each stretch of rows; keyed by the row it stands on, drawn on the rows it reaches
    for (let d = 0; d < tall; d++) {
      const base = Y + d
      for (let side = 0; side < 2; side++) {
        const blk = Math.floor(base / reedRun)
        const m = mix(blk, side * 101 + 3)
        if (base !== blk * reedRun + (m % (reedRun - tall)) || (m >>> 8) % (mudAt(base, side) ? 4 : 9) > 2) continue
        const kinds = one ? REEDS1 : REEDS2
        const art = kinds[(m >>> 16) % kinds.length] ?? kinds[0]
        const row = art[tall - 1 - d] ?? ''
        for (let c = 0; c < row.length; c++) {
          const ch = row[c]
          if (ch === '.' || ch === undefined) continue
          const X = side === 0 ? x - 1 + c : x + w - c
          set(X, Y, ch === 'h' ? C.trunk : c > 0 ? S.gM : S.gL)
        }
      }
    }
  }
}

// ---- the bridge

/**
 * A bridge carrying a street across the river: its deck covers canvas pixels (x, y, w, h), the street's own rows,
 * from one bank to the other; railings run along its top and bottom edge just outside them (OBJECT). The deck is
 * GROUND, people walk on it. Close-up h is 4 (the street), overview 2.
 *
 * The deck's planks are marked OVERLAY rather than GROUND: flat, never ringed, and this way the ring the engine
 * draws round the railings stays off them too (at overview it would cover both of the deck's rows). Planks run
 * across the street, a faint joint every third pixel, the row under the far railing in its shade. Close-up the
 * posts' caps stand a pixel above the far railing, the end posts two, and the bridge's side beam shows under the
 * near railing.
 */
export function bridge(pen: Pen, s: Scale, x: number, y: number, w: number, h: number) {
  const one = s === 1
  pen.as(OVERLAY, () => {
    for (let i = 0; i < w; i++) {
      const X = x + i
      const joint = X % 3 === 0
      for (let j = 0; j < h; j++) pen.dot(X, y + j, j === 0 ? (joint ? C.woodDark : S.plankShade) : joint ? S.plankShade : C.wood)
    }
  })
  pen.as(OBJECT, () => {
    const posts = one ? 5 : 4
    for (let i = 0; i < w; i++) {
      const X = x + i
      const end = i === 0 || i === w - 1
      const post = end || (i % posts === 0 && i < w - 2)
      pen.dot(X, y - 1, post && one ? C.wood : C.woodLight)
      pen.dot(X, y + h, post && one ? C.wood : C.woodLight)
      if (one) {
        if (post) pen.dot(X, y - 2, C.woodLight)
        if (end) pen.dot(X, y - 3, C.woodLight)
        pen.dot(X, y + h + 1, post ? S.woodDeep : C.woodDark)
      }
    }
  })
}

// ---- fields

export type Crop = 'wheat' | 'cabbage' | 'pumpkin' | 'flowers'

const FIELD_PAL = pal({
  k: S.soilDark, s: S.soil, S: S.soilLight,
  x: 0xffeeaa, y: S.hayLight, Y: S.hay, z: S.hayShade, Z: S.hayDark,
  a: S.gH, b: S.gL, c: S.gD, g: S.gM, G: S.gE,
  o: S.pumpkin, O: S.pumpkinLight, q: S.pumpkinShade,
  '1': 0xdd88aa, '2': 0xaa5577, '3': 0xeecc55, '4': 0xbb9933, '5': 0xdd4444, '6': 0x992233, '7': 0xeeeedd, '8': 0xbbbbaa,
  '9': 0x9977cc, '0': 0x665599,
})

/** Bands of flowers, as the letters of a lit and a shaded row. */
const BLOOMS = [['1', '2'], ['3', '4'], ['5', '6'], ['7', '8'], ['9', '0']] as const

/** Rows of `per` pixels across a field's inside (`ih` tall): as many as fit, the spare split above and below. */
function rowsOf(ih: number, per: number) {
  const n = Math.max(1, Math.floor(ih / per))
  return { n, top: 1 + Math.max(0, Math.floor((ih - n * per) / 2)) }
}

/** The still part of a field: soil and crop, worked out once per size and crop (wheat is drawn per frame). */
function buildField(one: boolean, w: number, h: number, crop: Crop) {
  const p = blank(w, h)
  fill(p, 0, 0, w, h, 's')
  const ih = h - 2
  const across = (y: number, ch: string) => {
    for (let i = 1; i < w - 1; i++) put(p, i, y, ch)
  }
  if (crop === 'cabbage') {
    // heads on tilled soil, rows staggered, a furrow between rows
    const per = one ? 5 : 3
    const { n, top } = rowsOf(ih, per)
    const head = one ? ['.ab.', 'abbc', '.cc.'] : ['ab']
    const hw = one ? 4 : 2
    for (let r = 0; r < n; r++) {
      const y0 = top + r * per
      if (r < n - 1) across(y0 + per - 1, 'k')
      const off = (r % 2) * (one ? 2 : 1) + 2
      for (let c = off; c + hw <= w - 2; c += one ? 5 : 3) stamp(p, c, y0 + (one ? 0 : 1), head)
    }
  } else if (crop === 'pumpkin') {
    // vines along the rows with big leaves on them, pumpkins sitting here and there
    const per = one ? 6 : 3
    const { n, top } = rowsOf(ih, per)
    for (let r = 0; r < n; r++) {
      const y0 = top + r * per
      if (r < n - 1) across(y0 + per - 1, 'k')
      const vy = y0 + (one ? 3 : 1)
      across(vy, one ? 'c' : 'g')
      if (one) {
        for (let i = 1 + (r % 2) * 4; i + 2 < w - 1; i += 8) stamp(p, i, vy - 1, ['bg.', 'gcg'])
        let i = 2 + (mix(r, 5) % 4)
        while (i + 4 < w - 1) {
          stamp(p, i, vy - 2, ['.c..', 'oOoo', 'qooq'])
          i += 7 + (mix(r, i) % 5)
        }
      } else {
        let i = 2 + (mix(r, 5) % 3)
        while (i + 2 < w - 1) {
          stamp(p, i, vy - 1, ['oo'])
          i += 4 + (mix(r, i) % 3)
        }
      }
    }
  } else if (crop === 'flowers') {
    // bands of flowers, each its own color, on green: close-up a lit row parted into single blooms, a shaded row,
    // then two rows of leaves; at overview a row of blooms and a row of leaves
    const per = one ? 4 : 2
    const { n, top } = rowsOf(ih, per)
    for (let j = 1; j < h - 1; j++) across(j, 'g')
    for (let r = 0; r < n; r++) {
      const y0 = top + r * per
      const bl = BLOOMS[r % BLOOMS.length] ?? BLOOMS[0]
      for (let i = 1; i < w - 1; i++) {
        if (one) {
          put(p, i, y0, (i + r * 2) % 4 === 0 ? 'g' : bl[0])
          put(p, i, y0 + 1, bl[1])
          put(p, i, y0 + 3, 'c')
        } else put(p, i, y0, bl[0])
      }
    }
  }
  return p
}

/** The field's edge: a dark border, its corners rounded off. */
function edgeField(pen: Pen, x: number, y: number, w: number, h: number) {
  for (let i = 1; i < w - 1; i++) (pen.dot(x + i, y, S.soilDark), pen.dot(x + i, y + h - 1, S.soilDark))
  for (let j = 1; j < h - 1; j++) (pen.dot(x, y + j, S.soilDark), pen.dot(x + w - 1, y + j, S.soilDark))
}

/**
 * Wheat: rows of it, ears lit on top and a shaded line below, no soil showing. The wind runs over it in long soft
 * streaks of lighter gold, each row's a little ahead of the one above, moving along a pixel every other frame.
 */
function wheat(pen: Pen, one: boolean, x: number, y: number, w: number, h: number, anim: number) {
  const per = 3
  const ih = h - 2
  const { n, top } = rowsOf(ih, per)
  const t = one ? anim >> 1 : anim >> 2
  const cycle = one ? 18 : 12
  const gust = one ? 6 : 4
  for (let j = 1; j < h - 1; j++) {
    const kk = j - top
    const r = kk < 0 ? 1 : kk >= n * per ? 2 : kk % per
    const band = Math.floor(kk / per)
    for (let i = 1; i < w - 1; i++) {
      const windy = ((((i + band * 3 - t) % cycle) + cycle) % cycle) < gust
      const c = r === 0 ? (windy ? S.hayWind : S.hayLight) : r === 1 ? (windy ? S.hayLight : S.hay) : S.hayShade
      pen.dot(x + i, y + j, c)
    }
  }
}

const fields = new Map<string, Pic>()

/**
 * A farm field filling (x, y, w, h) in canvas pixels: tilled rows of soil with the crop growing in them, swaying
 * or bobbing a little with `anim` if you like. GROUND throughout (a ring round every plant would be noise); give
 * it a clear edge so it reads as a field. Fields are between 40 and 90 close-up pixels each way.
 *
 * Wheat sways: the wind runs over it in streaks of lighter gold. The other crops stand still.
 */
export function field(pen: Pen, s: Scale, x: number, y: number, w: number, h: number, crop: Crop, anim: number) {
  const one = s === 1
  pen.as(GROUND, () => {
    if (crop === 'wheat') wheat(pen, one, x, y, w, h, anim)
    else {
      const key = `${s}|${w}|${h}|${crop}`
      let p = fields.get(key)
      if (!p) {
        if (fields.size > 24) fields.clear()
        p = buildField(one, w, h, crop)
        fields.set(key, p)
      }
      paint(pen, p, x, y, FIELD_PAL)
    }
    edgeField(pen, x, y, w, h)
  })
}

// ---- the windmill

const MILL_PAL = pal({
  L: 0xffeedd, P: C.plaster, p: C.plasterShade, j: 0xbbbb99,
  r: S.roofLight, R: S.roof, q: S.roofDark, e: S.woodDeep,
  S: C.stone, s: C.stoneLight, D: C.stoneDark,
  d: C.door, f: C.woodDark, T: C.woodLight, W: C.wood, g: C.glass, i: C.ironDark,
  w: C.woodDark, c: S.canvas, C: S.canvasShade,
})

/**
 * The tower close-up, in the 26 by 44 box: a white tower in three courses, each a pixel narrower, a wooden gallery
 * round it, a domed cap, the hub on (13, 12). The window sits below where the sails reach.
 */
const MILL1 = (() => {
  const p = blank(26, 44)
  const courses: [number, number, number][] = [[16, 24, 8], [25, 33, 7], [34, 43, 6]]
  for (const [a, b, l] of courses) {
    const r = 25 - l
    for (let y = a; y <= b; y++) for (let x = l; x <= r; x++) put(p, x, y, x === l ? 'L' : x >= r - 1 ? 'p' : 'P')
  }
  // a stone footing
  for (let x = 6; x <= 19; x++) for (let y = 40; y <= 43; y++) put(p, x, y, x === 6 ? 's' : x >= 18 ? 'D' : y === 42 && x % 4 === 1 ? 'D' : 'S')
  fill(p, 6, 40, 13, 1, 's')
  // the gallery: boards round the tower, lit on top, dark beneath
  fill(p, 4, 32, 18, 1, 'T')
  fill(p, 4, 33, 18, 1, 'f')
  put(p, 21, 32, 'W')
  // the cap: a dome of boards, lit on the left, an eave
  const cap: [number, number][] = [[10, 15], [8, 17], [7, 18], [7, 18], [7, 18], [6, 19]]
  cap.forEach(([a, b], r) => {
    for (let x = a; x <= b; x++) {
      const t = (x - a) / Math.max(1, b - a)
      put(p, x, 10 + r, r === cap.length - 1 ? 'e' : t < 0.3 ? 'r' : t > 0.72 ? 'q' : 'R')
    }
  })
  // door and window
  stamp(p, 11, 35, ['.ff.', 'fddf', 'fddf', 'fddf', 'fddf', 'fddf', 'fddf', 'fddf', 'fddf'])
  stamp(p, 12, 28, ['ff', 'gg', 'gg'])
  return p
})()

/** Overview, 13 by 22: two courses, the cap, the hub on (6, 6); the window below the sails' reach. */
const MILL2 = (() => {
  const p = blank(13, 22)
  const courses: [number, number, number][] = [[8, 14, 4], [15, 21, 3]]
  for (const [a, b, l] of courses) {
    const r = 12 - l
    for (let y = a; y <= b; y++) for (let x = l; x <= r; x++) put(p, x, y, x === l ? 'L' : x === r ? 'p' : 'P')
  }
  fill(p, 3, 20, 7, 2, 'S')
  fill(p, 3, 20, 1, 2, 's')
  fill(p, 9, 20, 1, 2, 'D')
  fill(p, 2, 15, 9, 1, 'T')
  const cap: [number, number][] = [[5, 7], [4, 8], [3, 9]]
  cap.forEach(([a, b], r) => {
    for (let x = a; x <= b; x++) put(p, x, 5 + r, r === cap.length - 1 ? 'e' : x === a ? 'r' : x === b ? 'q' : 'R')
  })
  stamp(p, 6, 19, ['d', 'd', 'd'])
  stamp(p, 6, 17, ['g'])
  return p
})()

/**
 * The sails at one angle, in a picture 8 px larger than the box each way (the box's (0, 0) on (4, 4)): four arms,
 * each a spar with a blade of canvas trailing it, the canvas's outer edge in shade; the hub over them.
 */
function sailFrame(one: boolean, deg: number) {
  const W = one ? 34 : 21
  const H = one ? 52 : 30
  const hx = (one ? 13 : 6) + 4
  const hy = (one ? 12 : 6) + 4
  const R = one ? 15.5 : 8.2
  const p = blank(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - hx
      const dy = y - hy
      for (let a = 0; a < 4; a++) {
        const t = ((deg + a * 90) * Math.PI) / 180
        const along = dx * Math.cos(t) + dy * Math.sin(t)
        const perp = -dx * Math.sin(t) + dy * Math.cos(t)
        if (along < 0.5 || along > R) continue
        if (Math.abs(perp) <= 0.5) put(p, x, y, 'w')
        else if (one && perp > 0.5 && perp <= 3.5 && along >= 4.5) put(p, x, y, perp > 2.5 ? 'C' : 'c')
        else if (!one && perp > 0.5 && perp <= 2.5 && along >= 2.5) put(p, x, y, perp > 1.5 ? 'C' : 'c')
      }
    }
  }
  stamp(p, hx - (one ? 1 : 0), hy - (one ? 1 : 0), one ? ['ii', 'ii'] : ['i'])
  return p
}

const ANGLES = [0, 15, 30, 45, 60, 75]
const SAILS1 = ANGLES.map(d => sailFrame(true, d))
const SAILS2 = ANGLES.map(d => sailFrame(false, d))
const MILL1_WINDOW = where(MILL1, 'g')
const MILL2_WINDOW = where(MILL2, 'g')

/**
 * A windmill, (x, y) the top-left of its box: 26 wide and 44 tall close-up (13 by 22 overview), the tower standing
 * on the box's bottom row, centred; four sails turning with `anim` (a step every frame or two, they may sweep
 * outside the box by up to 4 px). A door and a window; the window glows when `lit`.
 *
 * The sails turn 15 degrees every other frame. Where one crosses the tower a dark line parts them, as the ring
 * parts things from the grass.
 */
export function windmill(pen: Pen, s: Scale, x: number, y: number, anim: number, lit: boolean) {
  const one = s === 1
  const body = one ? MILL1 : MILL2
  const frames = one ? SAILS1 : SAILS2
  const sails = frames[(anim >> 1) % frames.length] ?? frames[0]
  pen.as(OBJECT, () => {
    paint(pen, body, x, y, MILL_PAL)
    if (!sails) return
    for (let j = 0; j < sails.h; j++) {
      for (let i = 0; i < sails.w; i++) {
        if (at(sails, i, j)) continue
        const near = at(sails, i - 1, j) || at(sails, i + 1, j) || at(sails, i, j - 1) || at(sails, i, j + 1)
        if (near && at(body, i - 4, j - 4)) pen.dot(x + i - 4, y + j - 4, C.edge)
      }
    }
    paint(pen, sails, x - 4, y - 4, MILL_PAL)
  })
  if (lit) glowAt(pen, one ? MILL1_WINDOW : MILL2_WINDOW, x, y, C.lit)
}

// ---- lamps

const LAMP_PAL = pal({ i: 0x334455, I: 0x667788, g: 0xeeeecc })
const LAMP1 = pic(['.i.', 'iii', 'ggg', 'ggg', 'iii', '.I.', '.I.', '.I.', '.I.', '.I.', '.I.', 'iIi'])
const LAMP2 = pic(['ii', 'gg', '.I', '.I', '.I', 'iI'])
const LAMP1_GLASS = where(LAMP1, 'g')
const LAMP2_GLASS = where(LAMP2, 'g')

/** The pool of lamplight on the ground, as offsets from the foot and a strength (1 near, 0 far). */
function pool(rx: number, ry: number, dy: number) {
  const out: number[] = []
  for (let j = -Math.ceil(ry); j <= Math.ceil(ry); j++) {
    for (let i = -Math.ceil(rx); i <= Math.ceil(rx); i++) {
      const d = (i / rx) ** 2 + (j / ry) ** 2
      if (d <= 1) out.push(i, j + dy, d < 0.45 ? 1 : 0)
    }
  }
  return out
}
const POOL1 = pool(5.5, 2.2, 1)
const POOL2 = pool(2.6, 1, 1)
const warmed = new Map<number, number>()

/**
 * A street lamp standing with its foot on (x, feet), x its middle: close-up 3 wide and 12 tall, overview 2 by 6. Its lantern glows when `lit`.
 *
 * Lit, it also warms a small pool of the ground round its foot (light, painted over the dusk), never over a thing
 * already drawn or the ring round it: draw lamps after what stands next to them.
 */
export function lamp(pen: Pen, s: Scale, x: number, feet: number, lit: boolean, anim: number) {
  const one = s === 1
  const p = one ? LAMP1 : LAMP2
  const lx = x - 1
  const ly = feet - p.h + 1
  pen.as(OBJECT, () => paint(pen, p, lx, ly, LAMP_PAL))
  if (!lit) return
  const pl = one ? POOL1 : POOL2
  const { w, kind } = pen
  const solid = (X: number, Y: number) => pen.inside(X, Y) && kind[Y * w + X] === OBJECT
  for (let i = 0; i + 2 < pl.length; i += 3) {
    const X = x + (pl[i] ?? 0)
    const Y = feet + (pl[i + 1] ?? 0)
    if (!pen.inside(X, Y) || kind[Y * w + X] !== GROUND) continue
    if (solid(X - 1, Y) || solid(X + 1, Y) || solid(X, Y - 1) || solid(X, Y + 1)) continue
    const c = pen.get(X, Y)
    const strong = pl[i + 2] === 1
    const key = c * 2 + (strong ? 1 : 0)
    let wc = warmed.get(key)
    if (wc === undefined) {
      if (warmed.size > 256) warmed.clear()
      wc = strong ? blend(shade(c, 0.86), C.lit, 0.2) : blend(shade(c, 0.8), C.lit, 0.1)
      warmed.set(key, wc)
    }
    pen.glow(X, Y, wc)
  }
  // the flame flickers now and then
  const dim = (anim * 7 + x * 13) % 23 === 0
  glowAt(pen, one ? LAMP1_GLASS : LAMP2_GLASS, lx, ly, dim ? C.fire[1] : C.lit)
}

// ---- benches, signposts

const WOOD_PAL = pal({ T: C.woodLight, W: C.wood, d: C.woodDark, e: S.woodDeep, t: C.timber, k: S.woodDeep, i: 0x334455 })

const BENCH1 = pic(['.WWWWWWW.', '.ddddddd.', 'TTTTTTTTT', 'id.....di'])
const BENCH2 = pic(['TTTTT', 'd...d'])

/** A bench, its left end at x and its feet on row `feet`: close-up 9 wide and 4 tall, overview 5 by 2. */
export function bench(pen: Pen, s: Scale, x: number, feet: number) {
  const p = s === 1 ? BENCH1 : BENCH2
  pen.as(OBJECT, () => paint(pen, p, x, feet - p.h + 1, WOOD_PAL))
}

const SIGN1 = pic([
  '...t.....',
  'TTTTTTTT.',
  'TkkTkkkTT',
  'WWWWWWWW.',
  '...t.....',
  '...t.....',
  '...t.....',
  '...t.....',
  '...t.....',
  '..ttt....',
])
const SIGN2 = pic(['TTTT.', 'TkkTT', 'WWWW.', '.t...', '.t...'])

/** A signpost with its foot on (x, feet), x its middle: close-up 9 wide and 10 tall (a board with an arrow), overview 5 by 5. */
export function signpost(pen: Pen, s: Scale, x: number, feet: number) {
  const p = s === 1 ? SIGN1 : SIGN2
  pen.as(OBJECT, () => paint(pen, p, x - (p.w >> 1), feet - p.h + 1, WOOD_PAL))
}

// ---- market stalls

/** The stall close-up: awning letters a (lit stripe), A (shaded), b/B the white stripes; the rest wood and goods. */
const STALL1 = (() => {
  const p = blank(16, 14)
  for (let x = 0; x < 16; x++) {
    const white = (x >> 1) % 2 === 1
    for (let y = 0; y < 4; y++) {
      if (y === 0 && (x === 0 || x === 15)) continue
      put(p, x, y, y < 2 ? (white ? 'b' : 'a') : white ? 'B' : 'A')
    }
    if (!white) put(p, x, 4, 'A')
  }
  fill(p, 1, 5, 14, 3, 'K')
  fill(p, 1, 4, 1, 1, 'K')
  for (const px of [1, 14]) fill(p, px, 4, 1, 4, 't')
  stamp(p, 2, 6, ['.rr..oo..gg..n.', 'rrRRoooOgggGnnN'])
  fill(p, 0, 8, 16, 1, 'T')
  for (let y = 9; y < 13; y++) for (let x = 0; x < 16; x++) put(p, x, y, x === 0 ? 'T' : x === 15 || x % 5 === 4 ? 'd' : 'W')
  fill(p, 0, 13, 16, 1, 'd')
  return p
})()

const STALL2 = (() => {
  const p = blank(8, 7)
  for (let x = 0; x < 8; x++) {
    const white = (x >> 1) % 2 === 1
    put(p, x, 0, white ? 'b' : 'a')
    put(p, x, 1, white ? 'B' : 'A')
    if (!white) put(p, x, 2, 'A')
  }
  stamp(p, 0, 3, ['tro.ggnt'])
  fill(p, 0, 4, 8, 1, 'T')
  fill(p, 0, 5, 8, 1, 'W')
  fill(p, 0, 6, 8, 1, 'd')
  put(p, 0, 5, 'T')
  return p
})()

const stallPals = new Map<number, Pal>()
function stallPal(color: number) {
  let a = stallPals.get(color)
  if (!a) {
    if (stallPals.size > 16) stallPals.clear()
    a = pal({
      a: color, A: shade(color, 0.72), b: C.white, B: 0xccccbb,
      K: 0x332211, t: C.woodDark, T: C.woodLight, W: C.wood, d: C.woodDark,
      r: S.apple, R: S.appleShade, o: S.orange, O: S.orangeShade, g: S.gL, G: S.gD, n: S.bread, N: 0x996633,
    })
    stallPals.set(color, a)
  }
  return a
}

/** A market stall, (x, y) the top-left of its 16 by 14 box close-up (8 by 7 overview): a striped awning in `color`, goods on the counter. */
export function stall(pen: Pen, s: Scale, x: number, y: number, color: number, anim: number) {
  pen.as(OBJECT, () => paint(pen, s === 1 ? STALL1 : STALL2, x, y, stallPal(color)))
  void anim
}

// ---- the well

const WELL_PAL = pal({
  r: S.roofLight, R: S.roof, q: S.roofDark, e: S.woodDeep, t: C.woodLight, T: C.woodLight, W: C.wood, w: C.woodDark,
  L: C.stoneLight, S: C.stone, D: C.stoneDark, j: C.mortar, K: 0x223344, b: C.waterDeep, i: 0x334455,
})
const WELL1 = pic([
  '...rrRq...',
  '.rrrrRqqq.',
  'eeeeeeeeee',
  '.t.iiii.w.',
  '.t...i..w.',
  '.t..WWW.w.',
  'LLLLLLLLLD',
  'LKKKbbKKKD',
  'LSSjSSSjSD',
  'LSjSSSjSSD',
  '.DDDDDDDD.',
])
const WELL2 = pic(['.rRq.', 'eeeee', 't.W.w', 'LLLLD', 'LKbKD', '.DDD.'])

/** A well, (x, y) the top-left of its 10 by 11 box close-up (5 by 6 overview): a stone ring, a little roof, a bucket. */
export function well(pen: Pen, s: Scale, x: number, y: number) {
  pen.as(OBJECT, () => paint(pen, s === 1 ? WELL1 : WELL2, x, y, WELL_PAL))
}

// ---- bushes, rocks, haystacks

const BUSH_PAL = pal({ H: S.gH, L: S.gL, M: S.gM, D: S.gD, E: S.gE, f: C.flowerP, w: C.flowerW, r: S.apple, R: S.appleShade })
const BUSH1 = [
  pic(['..LLM..', '.LHLLMM', 'LHLLMMD', 'LLMMMDD', '.MDDDE.']),
  pic(['..LfM..', '.LHLLwM', 'LfLLMMD', 'LLMwMDD', '.MDDDE.']),
  pic(['..LLM..', '.LHrLMM', 'LLLMMrD', 'LrMMMDD', '.MDDDE.']),
]
const BUSH2 = [pic(['.LM.', 'LHMD', '.DD.']), pic(['.fM.', 'LHMD', '.DD.']), pic(['.LM.', 'LHrD', '.DD.'])]

/** A bush, (x, y) the top-left of its 7 by 5 box close-up (4 by 3 overview); `kind` 0 plain, 1 with flowers, 2 with berries. */
export function bush(pen: Pen, s: Scale, x: number, y: number, kind: number) {
  const set = s === 1 ? BUSH1 : BUSH2
  const p = set[((kind % 3) + 3) % 3] ?? set[0]
  if (p) pen.as(OBJECT, () => paint(pen, p, x, y, BUSH_PAL))
}

const ROCK_PAL = pal({ r: C.rockLight, R: C.rock, a: C.rockDark })
const ROCKS = {
  1: { small: pic(['.rR.', 'rRRa', '.aa.']), big: pic(['..rrR..', '.rrRRRa', 'rrRRRaa', 'rRRRaaa', '.aaaaa.']) },
  0.5: { small: pic(['rR', 'Ra']), big: pic(['.rR.', 'rRRa', '.aa.']) },
} as const

/** A rock, (x, y) the top-left of its box: small 4 by 3, big 7 by 5 close-up (2 by 2 and 4 by 3 overview). */
export function rock(pen: Pen, s: Scale, x: number, y: number, big: boolean) {
  const r = ROCKS[s]
  pen.as(OBJECT, () => paint(pen, big ? r.big : r.small, x, y, ROCK_PAL))
}

const HAY_PAL = pal({ y: S.hayLight, Y: S.hay, z: S.hayShade, Z: S.hayDark })
const HAY1 = pic(['..yyYY..', '.yyyYYz.', 'yyYyYYzz', 'yYYYzYzz', 'YzYYzzZz', '.ZZZZZZ.'])
const HAY2 = pic(['.yY.', 'yYzz', 'ZZZZ'])

/** A haystack, (x, y) the top-left of its 8 by 6 box close-up (4 by 3 overview). */
export function haystack(pen: Pen, s: Scale, x: number, y: number) {
  pen.as(OBJECT, () => paint(pen, s === 1 ? HAY1 : HAY2, x, y, HAY_PAL))
}

// ---- flower beds

/** Each bed's blooms: petals and the eye in their middle. */
const BEDS = [
  [0xdd88aa, 0xeeeedd, 0xeecc55],
  [0xdd4444, 0xeecc55],
  [0x9977cc, 0xeeeedd],
  [0xeecc55, 0xee8833],
] as const

/**
 * A flower bed or a patch of wild flowers over (x, y, w, h) canvas pixels; GROUND; `seed` varies it.
 *
 * An even seed makes a bed: dark soil, a shaded lower edge, flowers in staggered rows; an odd one a patch of wild
 * flowers on the grass. The colors come from seed / 2. Close-up a flower is a cross of petals round a yellow eye
 * over two leaves; at overview a single bloom.
 */
export function flowers(pen: Pen, s: Scale, x: number, y: number, w: number, h: number, seed: number) {
  const one = s === 1
  const bed = seed % 2 === 0
  const n = BEDS.length
  const cols = BEDS[(((seed >> 1) % n) + n) % n] ?? BEDS[0]
  pen.as(GROUND, () => {
    if (bed) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if ((i === 0 || i === w - 1) && (j === 0 || j === h - 1)) continue
          pen.dot(x + i, y + j, j === h - 1 ? S.soilDark : S.soil)
        }
      }
    }
    // flowers in staggered rows; in a bed their leaves may hang over its front edge
    const fw = one ? 3 : 2
    const fh = one ? 3 : 2
    const step = one ? 4 : 3
    const rowStep = one ? 3 : 2
    const pad = bed ? 1 : 0
    let k = 0
    for (let j = 0, row = 0; j + fh <= h; j += rowStep, row++) {
      for (let i = pad + (row % 2) * (step >> 1); i + fw <= w - pad; i += step) {
        k++
        const m = mix(k + seed * 97, row)
        if (!bed && m % 4 === 0) continue
        const petal = cols[(m >>> 4) % cols.length] ?? C.flowerY
        const X = x + i + (bed ? 0 : ((m >>> 12) % 3) - 1)
        const Y = y + j
        if (one) {
          const eye = petal === 0xeecc55 ? 0xee8833 : 0xeecc55
          pen.dot(X + 1, Y, petal)
          pen.dot(X, Y + 1, petal)
          pen.dot(X + 2, Y + 1, petal)
          pen.dot(X + 1, Y + 1, eye)
          pen.dot(X, Y + 2, S.gM)
          pen.dot(X + 2, Y + 2, S.gM)
          pen.dot(X + 1, Y + 2, S.gD)
        } else if (bed) {
          pen.dot(X, Y, petal)
          pen.dot(X + 1, Y, petal)
          pen.dot(X, Y + 1, S.gM)
          pen.dot(X + 1, Y + 1, S.gD)
        } else pen.dot(X + ((m >>> 9) & 1), Y, petal)
      }
    }
  })
}

// ---- fences

/** A wooden fence round (x, y, w, h) in canvas pixels: posts and rails on its edges, a gap of `gate` pixels in the middle of the bottom side. */
export function fence(pen: Pen, s: Scale, x: number, y: number, w: number, h: number, gate: number) {
  const one = s === 1
  const every = one ? 5 : 4
  const g0 = x + Math.floor((w - gate) / 2)
  const g1 = g0 + gate
  pen.as(OBJECT, () => {
    const across = (Y: number, from: number, to: number) => {
      for (let X = from; X < to; X++) {
        const post = (X - x) % every === 0 || X === to - 1 || X === from
        pen.dot(X, Y, post ? C.wood : C.woodLight)
        if (post && one) pen.dot(X, Y - 1, C.woodLight)
      }
    }
    const down = (X: number) => {
      for (let Y = y; Y < y + h; Y++) pen.dot(X, Y, (Y - y) % every === 0 ? C.woodLight : C.wood)
    }
    down(x)
    down(x + w - 1)
    across(y, x, x + w)
    if (gate > 0) {
      across(y + h - 1, x, g0)
      across(y + h - 1, g1, x + w)
    } else across(y + h - 1, x, x + w)
  })
}

// ---- the boat

const BOAT_PAL = { T: C.woodLight, W: C.wood, d: C.woodDark, R: 0xaa4433, r: 0x883322 } as const
/** Close-up: the stern square on the left, the bow pointed on the right, a thwart across, the painted hull below. */
const BOAT1 = ['.TTTTTTT..', 'TddWddWdTT', 'TTTTTTTTT.', '.RRRRRRr..']
const BOAT2 = ['TdddT', '.RRr.']

/** A rowing boat on the water, (x, y) the top-left of its 10 by 4 box close-up (5 by 2 overview), bobbing with `anim`. */
export function boat(pen: Pen, s: Scale, x: number, y: number, anim: number) {
  const one = s === 1
  const bob = (anim >> 2) % 2
  pen.as(OVERLAY, () => {
    pen.figure(one ? BOAT1 : BOAT2, x, y + (one ? bob : 0), BOAT_PAL, false, C.edge)
    // the water lapping at the bow and stern
    if (one) {
      pen.dot(x - 2, y + 2 + bob, C.waterLight)
      pen.dot(x + 11, y + 2 - bob, C.waterLight)
    }
  })
}

// ---- a crew's camp: a tent in its color and a pennant on a pole, where the crew gathers when several are at work

const CAMP1 = pic([
  '..t.....................',
  '..pFFFFf................',
  '..pFFFFFFf..............',
  '..pFFFFf......LA........',
  '..p..........LLAD.......',
  '..p.........LLLADD......',
  '..p........LLLAADDD.....',
  '..p.......LLLAAKADDD....',
  '..p......LLLAAKKKADDD...',
  '..p.....LLLAAKKKKKADDD..',
  '..p....LLLAAKKKKKKKADDD.',
  '..p...LLLAAAKKKKKKKAADDD',
  '.ppp..wwwwwwwwwwwwwwwwww',
])
const CAMP2 = pic([
  't.....LA....',
  'pFf..LLAD...',
  'pF..LLAKAD..',
  'p..LLAKKKAD.',
  'p.LLAAKKKAAD',
  'ppwwwwwwwwww',
])

/** The size of a camp close-up (the overview halves it). */
export const CAMP = { w: 24, h: 13 }

const campPals = new Map<number, Pal>()
function campPal(color: number) {
  let a = campPals.get(color)
  if (!a) {
    if (campPals.size > 16) campPals.clear()
    a = pal({
      t: C.gold, p: C.woodDark, F: color, f: shade(color, 0.7),
      L: blend(color, 0xffffff, 0.3), A: color, D: shade(color, 0.68), K: 0x2a1f18, w: shade(color, 0.5),
    })
    campPals.set(color, a)
  }
  return a
}

/** A crew's camp, (x, y) the top-left of its 24 by 13 box close-up (12 by 6 overview): its tent and pennant in `color`; the pennant flutters. */
export function camp(pen: Pen, s: Scale, x: number, y: number, color: number, anim: number) {
  pen.as(OBJECT, () => {
    paint(pen, s === 1 ? CAMP1 : CAMP2, x, y, campPal(color))
    // the pennant's tip flutters
    if (anim % 4 < 2) pen.dot(x + (s === 1 ? 10 : 3), y + (s === 1 ? 2 : 1), shade(color, 0.7))
  })
}
