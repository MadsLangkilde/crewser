// The town's drawing kit: a canvas of square pixels, the small palette every picture is painted in, and the
// helpers the pictures share. A terminal cell shows two of these pixels, one above the other, so a pixel is
// square on screen and each cell has exactly two colors: no blending, no dithering, nothing scrambled.
//
// The town is drawn at two scales, each with art of its own (never one shrunk into the other):
//   s = 1    close-up: a person is 9 px wide and 14 tall, a building plot 40 by 36
//   s = 0.5  overview: a person is 7 px wide and 10 tall, a building plot 20 by 18
// The town's layout is in units of the close-up; a position (u, v) is drawn at (floor(u * s), floor(v * s)).

export type Scale = 1 | 0.5

/** What a pixel belongs to. Every OBJECT gets a dark ring on the ground round it (the engine draws it after). */
export const GROUND = 0
export const OBJECT = 1
/** People and helpers: drawn last, with their own outline, never covered. */
export const PERSON = 2
/** Smoke, sparks, ripples, shadows: drawn without a ring. */
export const OVERLAY = 3

/**
 * The palette. Keep to it: a terminal shows at most 1024 different pairs of colors at once, and a small palette
 * keeps the picture calm. Colors of the crew's sessions (the coat of a person, the roof of what it built) come in
 * from outside as numbers; `shade(c, f)` darkens or lightens one.
 */
export const C = {
  // ground
  grass: 0x4f8a3c, grass2: 0x4a8338, tuft: 0x427a33, flowerY: 0xe6cf5c, flowerW: 0xeee8da, flowerP: 0xd98ab0,
  road: 0xb39360, roadEdge: 0x977a4e, cobble: 0xaaa497, cobble2: 0x9a9488, cobbleEdge: 0x7f796e,
  water: 0x3b7cc0, waterDeep: 0x30689f, waterLight: 0x86bde9, sand: 0xd4bf88,
  // the ring round every object, and people's outline
  edge: 0x23301c, outline: 0x1a1612,
  // nature
  leafDark: 0x24502a, leaf: 0x2f6a33, leafLight: 0x4c9443, trunk: 0x6b4423, trunkDark: 0x4a2e17,
  rock: 0x8a857d, rockLight: 0xb0aaa1, rockDark: 0x5f5b55, snow: 0xf2f5f8,
  // building
  stone: 0xaaa497, stoneLight: 0xcbc5b8, stoneDark: 0x7b766c, mortar: 0x67625a,
  plaster: 0xe8dec5, plasterShade: 0xd2c6a8, timber: 0x6a4a2c, wood: 0x9a6b3c, woodLight: 0xc08d56, woodDark: 0x5e3f20,
  glass: 0x2b3442, lit: 0xf6d36b, door: 0x5a3820, gold: 0xf2c33a, goldDark: 0xb8891f, iron: 0xc9ced8, ironDark: 0x3c3f46,
  // people
  skin: 0xf0c49a, skinShade: 0xd6a57c, eye: 0x1f1a16, mouth: 0x9a3a2a, tear: 0x8fd0ff, belt: 0x5a3b1e, pants: 0x3e4658,
  boot: 0x3a2716, hardHat: 0xf2c33a, sageHat: 0x3d3f8f, beard: 0xe9e6df, apron: 0xc8a676,
  hairs: [0x6b4423, 0x2a1f18, 0xd9a441, 0x9a4a22, 0x8a8a8a] as const,
  // things
  white: 0xf4f1e8, ink: 0x161616, page: 0xf4f1e8, bookCover: 0x8a2f2f, books: [0x8a2f2f, 0x2f5a8a, 0x3f7a3a, 0xb8891f, 0x6a3f7a] as const,
  paper: 0xe6dab4, paperShade: 0xc9b98a,
  // fire and smoke
  fire: [0xfff1a8, 0xffcc33, 0xff8a1f, 0xe2461c] as const, ember: 0xff7a1a, smoke: [0x4a4744, 0x6a6764, 0x8d8a86, 0xb3b0ac] as const,
  ash: 0x3c3834, char: 0x2a2420,
  confetti: [0xe5484d, 0x4f7cff, 0xf2c33a, 0x3fb950, 0xc061cb, 0xff8700] as const,
}

export const shade = (c: number, f: number) => {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * f)))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export const blend = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** A canvas of square pixels at one scale. */
export class Pen {
  readonly px: Uint32Array
  readonly kind: Uint8Array
  /** Lights, as x, y, color: painted after the night tint, so windows, fires and lamps glow. Never ringed. */
  lights: number[] = []
  /** What `dot` marks the pixels it paints as: OBJECT unless a picture says otherwise. */
  layer = OBJECT

  readonly w: number
  readonly h: number

  constructor(w: number, h: number, ground: number = C.grass) {
    this.w = w
    this.h = h
    this.px = new Uint32Array(w * h).fill(ground)
    this.kind = new Uint8Array(w * h)
  }

  inside(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h
  }

  get(x: number, y: number) {
    return this.inside(x, y) ? (this.px[y * this.w + x] ?? 0) : 0
  }

  /** One pixel. */
  dot(x: number, y: number, c: number) {
    x = Math.round(x)
    y = Math.round(y)
    if (!this.inside(x, y)) return
    const i = y * this.w + x
    this.px[i] = c
    this.kind[i] = this.layer
  }

  /** One pixel of light: a lit window, a flame, a lamp. */
  glow(x: number, y: number, c: number) {
    this.lights.push(Math.round(x), Math.round(y), c)
  }

  rect(x: number, y: number, w: number, h: number, c: number) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, c)
  }

  /** Darkens (f < 1) or lightens what is drawn at a pixel, keeping what it belongs to: shadows. */
  shade(x: number, y: number, f: number) {
    x = Math.round(x)
    y = Math.round(y)
    if (!this.inside(x, y)) return
    const i = y * this.w + x
    this.px[i] = shade(this.px[i] ?? 0, f)
  }

  /** Runs `draw` with `dot` marking what it paints as `layer`. */
  as(layer: number, draw: () => void) {
    const was = this.layer
    this.layer = layer
    try {
      draw()
    } finally {
      this.layer = was
    }
  }

  /** A picture from rows of letters, '.' (or a letter not in `pal`) left clear; `flip` mirrors it left to right. */
  sprite(rows: readonly string[], x: number, y: number, pal: Readonly<Record<string, number>>, flip = false) {
    const w = Math.max(0, ...rows.map(r => r.length))
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j] ?? ''
      for (let i = 0; i < w; i++) {
        const c = pal[r[flip ? w - 1 - i : i] ?? '.']
        if (c !== undefined) this.dot(x + i, y + j, c)
      }
    }
  }

  /**
   * A picture with a 1-pixel dark outline all round it (the 4 neighbours of every clear pixel next to it), for
   * people and the small things that must stand out. Rows are padded to the widest; `flip` mirrors the whole.
   */
  figure(rows: readonly string[], x: number, y: number, pal: Readonly<Record<string, number>>, flip = false, outline: number = C.outline) {
    const w = Math.max(0, ...rows.map(r => r.length))
    const h = rows.length
    const at = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= w || j >= h) return undefined
      return pal[(rows[j] ?? '')[flip ? w - 1 - i : i] ?? '.']
    }
    for (let j = -1; j <= h; j++) {
      for (let i = -1; i <= w; i++) {
        const c = at(i, j)
        if (c !== undefined) this.dot(x + i, y + j, c)
        else if (at(i + 1, j) !== undefined || at(i - 1, j) !== undefined || at(i, j + 1) !== undefined || at(i, j - 1) !== undefined) this.dot(x + i, y + j, outline)
      }
    }
  }
}

/** A seeded random number generator, so the same town is drawn the same way every time. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** The dark ring round every OBJECT: each GROUND pixel touching one (left, right, above or below) turns `C.edge`. */
export function ring(pen: Pen) {
  const { w, h, kind, px } = pen
  const near = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (kind[i] !== GROUND) continue
      if ((x > 0 && kind[i - 1] === OBJECT) || (x < w - 1 && kind[i + 1] === OBJECT) || (y > 0 && kind[i - w] === OBJECT) || (y < h - 1 && kind[i + w] === OBJECT)) near[i] = 1
    }
  }
  for (let i = 0; i < w * h; i++) if (near[i]) px[i] = C.edge
}

/**
 * Evening: everything drawn so far dims toward night blue by `k` (0 by day, 0.45 at most), then the lights are
 * painted over it at full strength. People are drawn after this, so they never dim.
 */
export function dusk(pen: Pen, k: number) {
  if (k > 0) {
    const cache = new Map<number, number>()
    for (let i = 0; i < pen.px.length; i++) {
      const c = pen.px[i] ?? 0
      let n = cache.get(c)
      if (n === undefined) cache.set(c, (n = blend(shade(c, 1 - k * 0.5), 0x1a2550, k * 0.3)))
      pen.px[i] = n
    }
  }
  const l = pen.lights
  pen.as(OVERLAY, () => {
    for (let i = 0; i + 2 < l.length; i += 3) pen.dot(l[i] ?? 0, l[i + 1] ?? 0, l[i + 2] ?? 0)
  })
  pen.lights = []
}
