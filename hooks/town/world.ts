// The crew's town: who is where, doing what, and the cells that show it. The castle sits under the mountains with
// the town square in front of it; round them lies open land with a lake, a river and woods. Every feature the
// crew builds becomes the kind of thing that fits it (a house, a farm and its fields, a dock on the lake, a
// statue...), placed where that kind belongs (near the square, out in the farmland, on the shore, by the woods,
// next to the feature it belongs to), with a path laid from its door to the nearest road. Drawn natively at two
// scales by the art in people.ts, buildings.ts, works.ts, places.ts and scenery.ts. Pure: no `$`, just cells out.

import { drawTown } from './buildings'
import { blend, C, dusk, hash, OVERLAY, Pen, ring, seeded, shade, type Scale } from './kit'
import { helper, helperHeight, person, personHeight, type Pose, type Role } from './people'
import { CROPS, type Crop, guessKind, type Kind, KIND_NAMES, KINDS, TOWN_KINDS } from './kinds'
import { castle, lake, mine, MINE, MIDDLE, mountains, pier, SQUARE, square, tree } from './places'
import { bench, boat, bridge, bush, camp, CAMP, flowers, lamp, river, road, rock } from './scenery'
import { drawWorks } from './works'


export type CrewSession = {
  id: string
  name: string
  color: string
  project: string
  status: 'idle' | 'working'
  tool: string
  detail?: string
  lastPrompt: string
  startedAt: number
  task: { id: string; name: string; role: string; lead?: string } | null
  /** The project's overseer, above every crew's lead: it stands at the castle gate. */
  overseer?: boolean
  agents: { id: string; kind: string; desc: string; at: number }[]
  features?: { id: string; name: string; status: 'building' | 'done'; at: number; kind?: string; parent?: string; crop?: string }[]
  posts: { at: number; to: string; text: string }[]
  talkTo?: string
  talkAt?: number
  attention: boolean
  five: number | null
  week: number | null
}

/** A building in the project's town, kept across tasks: a level up each time it is finished again; `removed` burns it down. */
export type TownBuilding = {
  name: string; level: number; status: 'building' | 'done' | 'removed'; at: number; color: string; by: string
  /** What it is shown as (kinds.ts), the feature it is a part of, what a field grows. */
  kind?: string; parent?: string; crop?: string
  /** Where it stands, from the castle's middle and the map's top: kept so it never moves once built. */
  dx?: number; dy?: number
  /** When it was first started: the older of two claiming the same ground keeps it. */
  since?: number
}

/** `merged`: the names of buildings just merged from two people's changes, to show off. */
/** `project`: whose town it is when no crew is at work (a crew's is its lead's). */
export type Snapshot = { sessions: CrewSession[]; now: number; me?: string; bored?: boolean; seq?: number; town?: TownBuilding[]; merged?: string[]; project?: string }

/** The two zooms: the overview and the close-up. Each is drawn with art of its own. */
export const ZOOMS = [0.5, 1] as const

/** How long a building merged from two people's changes takes to go up again, its sign saying so. */
const MERGE_MS = 8000

/** How long a removed feature's building takes to burn, fall in and be cheered away. */
export const BURN_MS = 26_000

// ---- what they say: mostly what they do, now and then something silly

const FUNNY = [
  '*discussing important business*', '*blah blah yes, blah blah no*', '*synergy intensifies*', '*draws boxes and arrows*',
  'works on my machine', "let's circle back on that", "*whispers* it's a race condition", 'LGTM (did not look)',
  'one more test, I promise', "it's always the cache", '*bikesheds a variable name*', 'okay but hear me out',
  '*estimates: two weeks*', 'blame says... it was me', 'we need more tokens', 'Work work.', 'Something need doing?',
]
const PING = ['Need eyes here!', 'Over here, please!', 'Look at me!']
const BORED = [
  'Are you up there?', 'I need work!', 'Give us a task!', 'I am bored!', 'Hellooo?', '*waves frantically*',
  'We await orders!', 'Did you go for coffee?', 'Pick me! Pick me!', 'Anyone? Anyone?', '*taps on the glass*',
  'We could refactor something...', 'Knock knock!', 'Is this thing on?', 'Work? Please?', 'Orders go under the map!',
]
const ORDERS = ['Get that done!', 'Report back soon!', 'Faster, helpers!', 'That way!', 'Good work, keep going!']
const FISHING = ['*waits for a bite*', 'Caught one!', 'The big one got away...', '*whistles*', 'Fish are biting today']
const BYE = ['Bye bye, {n}...', 'Nooo, {n}!', '*sniff* farewell, {n}', 'We hardly knew ye, {n}.', 'Rest well, {n}.', 'So long, {n}!', 'It had such nice buttons...', 'I had plans for {n}...']
const FRESH = ['Well, time to start fresh, right?', 'More room for new ideas!', 'Onwards!', 'Less code, fewer bugs!', 'Clean slate!', 'Fresh start, here we come!', 'Honestly? We will build better.', 'What do we build next?']
const DONE = ['{n} is done!', 'Another one built!', '{n}: finished!', 'Job done: {n}!']

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T
const gist = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(0, n - 1)) + '…' : one
}
const fill = (line: string, name: string) => line.replace(/\{n\}/g, name)
const rgb = (hex: string) => parseInt(hex.replace('#', ''), 16) & 0xffffff
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ---- the plan, in close-up pixels

const SW = MINE.w // the tokens mine
const SH = MINE.h
const MID = MIDDLE.w // the castle
const MOUNT_H = 58 // how far down the north's mountains reach
const CASTLE_Y = MOUNT_H + 26 // the castle's top: open land and mountains above it
/** The town's area to start with; it grows when the crew runs out of room. */
const AREA = { w: 600, h: 440 }

type Spot = { x: number; y: number }
type Box = { x: number; y: number; w: number; h: number }
type Decor = { kind: 'lamp' | 'bench' | 'bush' | 'rock' | 'flowers'; x: number; y: number; variant?: number }
type Bubble = { text: string; until: number; kind: 'status' | 'say' | 'fun' | 'ping' | 'sleep' | 'sad' | 'happy' | 'think' }
type Building = {
  id: string; name: string; status: 'building' | 'done'; level: number; at: number; color: number; owner: string; order: number
  kind: Kind; crop?: Crop; parent: string
  /** Where it stands (the footprint's top-left), and where the town's file says it stood. */
  pos: Spot | null; stored: Spot | null
  burnAt: number; doneAt: number; by: string
  /** When two people's changes to it were merged: it goes up again where it stands. */
  mergedAt?: number
}
type Doing = 'build' | 'forge' | 'read' | 'write' | 'plan' | 'delegate' | 'think' | 'talk' | 'idle' | 'ping' | 'bored' | 'mourn' | 'cheer'
type Idle = 'gather' | 'nap' | 'fish' | 'stroll'

/** A person or a helper; (x, y) is where its feet are: the middle column, the bottom row. */
type Unit = {
  kind: 'hero' | 'helper'
  id: string
  owner: string
  name: string
  color: number
  role: Role
  hair: number
  x: number
  y: number
  path: Spot[]
  facing: 1 | -1
  moving: boolean
  run: boolean
  bubble: Bubble | null
  status: 'idle' | 'working'
  tool: string
  detail: string
  lastPrompt: string
  attention: boolean
  talkTo: string
  talkAt: number
  doing: Doing
  since: number
  spot: Spot | null
  face: 1 | -1 | 0
  idle: Idle
  idleUntil: number
  nextTalk: number
  lastPost: number
  isLead: boolean
  desc: string
  phase: 'out' | 'work' | 'back' | 'drop'
  until: number
  carrying: '' | 'crate' | 'scroll'
  /** The crew (task) a hero belongs to, and whether it is the project's overseer. */
  crew: string
  overseer: boolean
  /** What it wears: its crew's color (its lead's), shared by every member and their helpers; `color` stays its own. */
  coat: number
}

/** A text on the map: centred on x, its row the one holding pixel row y (both in close-up pixels). */
type Item = { x: number; y: number; text: string; fg: number; bg: number; prio: number; tail?: number; down?: boolean }
type Spark = { x: number; y: number; vx: number; vy: number; c: number; until: number; gravity: number }

const LABEL = 0x1d1b18
const SIGN = 0x3a2a1a
const HUD = 0x15130f
const HUD_TEXT = 0xe8d9a8
const BUBBLE: Record<Bubble['kind'], number> = { status: 0xd8e6f6, say: 0xf6f3ea, fun: 0xf5e6c8, ping: 0xffe14d, sleep: 0xb8c4e6, sad: 0xc5ccdd, happy: 0xc6efb0, think: 0xe6e0f2 }

export class World {
  cols = 0
  rows = 0
  /** The town's size in close-up pixels. */
  W = 0
  H = 0
  /** The scale it is drawn at: one of ZOOMS. */
  zoom: Scale = 1
  /** The smallest zoom the view uses: the land is made big enough to fill it. */
  minZoom: number = ZOOMS[0]
  /** Columns at the right of the status bar left free for the buttons laid over it. */
  hudReserve = 0
  private viewPx = 0
  /** The camera's top-left in close-up pixels, gliding toward where it is wanted. */
  private cam = 0
  private camX = 0
  private wantY = 0
  private wantX = 0
  private placed = false
  /**
   * Freshly opened: the first step with the land laid out and the crew in puts everyone straight where its work is
   * (at its building site, the anvil, the library, the castle gate, fishing or napping), instead of walking there.
   */
  private settling = true
  private movedAt = -1e9
  private pen = new Pen(1, 1)
  private ground = new Pen(1, 1)
  private groundKey = ''
  private items: Item[] = []
  private hudCells: [number, number, number][] = []
  private planKey = ''
  private landKey = ''
  /** The castle's middle: everything is laid out from it. */
  private ox = 0
  private area = { ...AREA }
  private grown = 0
  private castle: Spot = { x: 0, y: 0 }
  private square: Spot = { x: 0, y: 0 }
  private mine: Spot = { x: 0, y: 0 }
  /** The mountains: a few massifs of their own spread over the north, `seed` where along the endless range each is cut from. */
  private mounts: (Box & { seed: number })[] = []
  private lakeC = { x: 0, y: 0, rx: 1, ry: 1 }
  private lakeSpan: (y: number) => { x0: number; x1: number } | null = () => null
  private riverAt: (y: number) => number | null = () => null
  private pierAt = { x: -100, y: -100, len: 0 }
  private napAt: Spot = { x: 0, y: 0 }
  /** The paths a new town has, and those laid since, one per leg. */
  private base: Box[] = []
  private network: Box[] = []
  private decor: Decor[] = []
  /** Spots found since the plugin last asked, to keep in the town's file. */
  private fresh = new Map<string, { dx: number; dy: number }>()
  private trees: { x: number; y: number; pine: boolean }[] = []
  private buildings = new Map<string, Building>()
  private units = new Map<string, Unit>()
  private sparks: Spark[] = []
  private puffs: { x: number; y: number; until: number }[] = []
  private sessions: CrewSession[] = []
  private task: { id: string; name: string; lead: string; project: string } | null = null
  /** Every crew at work in the project, the first started first; with more than one, each has a camp to gather at. */
  private crews: { id: string; name: string; lead: string; color: number; since: number }[] = []
  private camps = new Map<string, Spot>()
  /** The project whose town this is, for the castle's sign when no task is running. */
  private project = ''
  private leadColor = 0xb03a3a
  private clock = 0
  private bored = false
  private dark = 0

  // ---- the view

  /** Sizes the view: `rows` cells, the top one the status bar. */
  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = Math.max(40, cols)
    this.rows = Math.max(10, rows)
    this.viewPx = (this.rows - 1) * 2
    this.planKey = ''
    this.plan()
  }

  /** How much of the town the view shows: close-up pixels across, and down. */
  private get visW() {
    return Math.min(this.W, Math.ceil(this.cols / this.zoom))
  }

  private get visH() {
    return Math.min(this.H, Math.ceil(this.viewPx / this.zoom))
  }

  /** The camera moves a whole drawn pixel across and a whole cell down at a time, so nothing shimmers. */
  private get unitX() {
    return Math.round(1 / this.zoom)
  }

  private get unitY() {
    return Math.round(2 / this.zoom)
  }

  private snapX(x: number) {
    return x - (((x % this.unitX) + this.unitX) % this.unitX)
  }

  private snapY(y: number) {
    return y - (((y % this.unitY) + this.unitY) % this.unitY)
  }

  private get maxY() {
    return this.snapY(Math.max(0, this.H - this.visH))
  }

  private get maxX() {
    return this.snapX(Math.max(0, this.W - this.visW))
  }

  /** Where the camera heads, in rows and columns of the screen; it glides there over the next frames. */
  scroll(byRows: number, byCols = 0) {
    const y = this.snapY(clamp(this.wantY + Math.round((byRows * 2) / this.zoom), 0, this.maxY))
    const x = this.snapX(clamp(this.wantX + Math.round(byCols / this.zoom), 0, this.maxX))
    const moved = y !== this.wantY || x !== this.wantX
    this.wantY = y
    this.wantX = x
    this.movedAt = this.clock
    return moved
  }

  /** Changes the zoom around the middle of the view, at once. */
  setZoom(z: number) {
    const next: Scale = z < 0.75 ? 0.5 : 1
    if (next === this.zoom) return false
    const cx = this.camX + this.visW / 2
    const cy = this.cam + this.visH / 2
    this.zoom = next
    if (!this.H) return true
    this.cam = this.wantY = this.snapY(clamp(Math.round(cy - this.visH / 2), 0, this.maxY))
    this.camX = this.wantX = this.snapX(clamp(Math.round(cx - this.visW / 2), 0, this.maxX))
    return true
  }

  /** The castle and the square in the middle of the view. */
  home() {
    this.lookAt(this.ox, this.square.y)
    this.movedAt = -1e9
  }

  private lookAt(x: number, y: number) {
    this.wantX = this.snapX(clamp(Math.round(x - this.visW / 2), 0, this.maxX))
    this.wantY = this.snapY(clamp(Math.round(y - this.visH / 2), 0, this.maxY))
  }

  get scrollInfo() {
    return { top: this.wantY / 2, rows: this.H / 2, view: this.visH / 2, left: this.wantX, width: this.W, cols: this.visW, zoom: this.zoom }
  }

  /** True while the camera is still gliding. */
  get gliding() {
    return this.cam !== this.wantY || this.camX !== this.wantX
  }

  private glide() {
    const ease = (from: number, to: number, unit: number) => {
      if (from === to) return from
      const step = Math.max(unit, Math.round(Math.abs(to - from) * 0.35))
      const next = from + Math.sign(to - from) * Math.min(Math.abs(to - from), step)
      return next === to ? to : next - (((next % unit) + unit) % unit)
    }
    this.cam = ease(this.cam, this.wantY, this.unitY)
    this.camX = ease(this.camX, this.wantX, this.unitX)
  }

  // ---- the plan: the fixed land round the castle, and every building on the spot that suits its kind

  private plan(): void {
    if (!this.cols) return
    const need = this.buildings.size
    const key = `${this.cols}x${this.viewPx}|${this.minZoom}|${need}|${[...this.buildings.keys()].join(',')}|${this.area.w}x${this.area.h}|${this.crews.length > 1 ? this.crews.map(c => c.id).join(',') : ''}`
    if (key === this.planKey) return
    this.planKey = key
    const viewW = Math.ceil(this.cols / this.minZoom)
    const viewH = Math.ceil(this.viewPx / this.minZoom)
    // the land: the town's area (it grows when the crew runs out of room) and more round it so the view never runs out
    let W = Math.max(this.area.w, Math.ceil(viewW * 1.3))
    let H = Math.max(this.area.h, Math.ceil(viewH * 1.3))
    W += W % 2
    H += H % 4 ? 4 - (H % 4) : 0
    const land = `${W}x${H}|${this.area.w}x${this.area.h}`
    const ox = Math.round(W / 4) * 2
    const grew = this.W && W !== this.W ? ox - this.ox : 0
    if (land !== this.landKey) {
      this.landKey = land
      this.W = W
      this.H = H
      this.ox = ox
      this.nature()
    }
    // every building on its spot, in the order they were first built, paths from their doors; out of room, the
    // town's area grows (a few times at most, so nothing can keep it growing)
    if (!this.placeAll() && this.grown < 6) {
      this.grown += 1
      this.area = { w: this.area.w + 120, h: this.area.h + 80 }
      this.planKey = ''
      return this.plan()
    }
    this.placeCamps()
    this.trees = this.forest()
    this.decor = this.dress()
    this.groundKey = ''
    if (!this.placed) {
      this.placed = true
      this.home()
      this.cam = this.wantY
      this.camX = this.wantX
    } else if (grew) {
      // the land grew: keep looking at the same spot
      this.camX = this.snapX(clamp(this.camX + grew, 0, this.maxX))
      this.wantX = this.snapX(clamp(this.wantX + grew, 0, this.maxX))
      for (const u of this.units.values()) {
        u.x = clamp(u.x + grew, 4, W - 4)
        u.path = []
        u.spot = null
      }
    }
    this.cam = this.snapY(clamp(this.cam, 0, this.maxY))
    this.wantY = this.snapY(clamp(this.wantY, 0, this.maxY))
  }

  /**
   * The fixed land, all from the castle's middle (ox): a few massifs spread over the north with open land and
   * woods between them, the castle under them and the town square in front of it, the tokens mine beside the
   * castle with a path to the square, a lake to the south-west fed by a river from the big north-western massif,
   * a footpath from the square to the fishing pier. It never changes as the crew builds.
   */
  private nature() {
    const ox = this.ox
    this.castle = { x: ox - MID / 2, y: CASTLE_Y }
    this.square = { x: ox - SQUARE.w / 2, y: CASTLE_Y + MIDDLE.castle + 6 }
    this.mounts = [
      { x: ox - 340, y: 0, w: 212, h: 72, seed: 0 },
      { x: ox - 96, y: 2, w: 90, h: 44, seed: 900 },
      { x: ox + 132, y: 0, w: 150, h: 58, seed: 1500 },
      { x: ox + 190, y: 78, w: 104, h: 40, seed: 2300 },
    ]
    this.mine = { x: ox + 66, y: 74 }
    const lk = { x: ox - 140, y: 312, rx: 104, ry: 46 }
    this.lakeC = lk
    this.lakeSpan = (y: number) => {
      const t = (y - lk.y) / lk.ry
      if (t <= -1 || t >= 1) return null
      const half = lk.rx * Math.sqrt(1 - t * t)
      const x0 = Math.round(lk.x - half + Math.sin(y / 11) * 4 + Math.sin(y / 5) * 1.5)
      const x1 = Math.round(lk.x + half + Math.cos(y / 9) * 3)
      return x1 - x0 > 6 ? { x0, x1 } : null
    }
    const lakeTop = lk.y - lk.ry + 2
    const spring = this.mounts[0] ?? { y: 0, h: MOUNT_H }
    const from = { x: ox - 236, y: spring.y + spring.h - 3 }
    const to = { x: lk.x - lk.rx + 18, y: lk.y - Math.round(lk.ry * 0.45) }
    this.riverAt = (y: number) => {
      if (y < from.y || y > to.y) return null
      const f = (y - from.y) / Math.max(1, to.y - from.y)
      return Math.round(from.x + (to.x - from.x) * f * f + Math.sin(y / 21) * 6 + Math.sin(y / 8 + 1) * 2)
    }
    // the pier on the north-east shore, and the one footpath a new town has: from the square to it
    const px = lk.x + 62
    let shore = lakeTop
    while (shore < lk.y && !this.inLake(px + 2, shore)) shore++
    this.pierAt = { x: px, y: shore - 3, len: 24 }
    const sq = this.square
    const py = sq.y + SQUARE.h / 2 - 2
    // and a short one from the mine's rails to the square
    const mx = this.mine.x + SW / 2
    this.base = [
      { x: ox - 4, y: CASTLE_Y + MIDDLE.castle, w: 8, h: 6 },
      { x: px, y: py, w: sq.x - px, h: 4 },
      { x: px, y: py, w: 4, h: shore - 3 - py },
      { x: mx, y: this.mine.y + SH, w: 4, h: py + 4 - (this.mine.y + SH) },
      { x: sq.x + SQUARE.w, y: py, w: mx + 4 - (sq.x + SQUARE.w), h: 4 },
    ]
  }

  /** Where a massif's rock stands: its box less the ends, where it falls away to the open land. */
  private rockOf(m: Box): Box {
    return { x: m.x + Math.round(m.w * 0.12), y: m.y, w: Math.round(m.w * 0.76), h: m.h + 2 }
  }

  inLake(x: number, y: number) {
    const s = this.lakeSpan(Math.round(y))
    return !!s && x >= s.x0 && x <= s.x1
  }

  private nearRiver(x: number, y: number, w: number, h: number, room = 12) {
    for (let yy = y; yy <= y + h; yy += 4) {
      const r = this.riverAt(yy)
      if (r !== null && r > x - room && r < x + w + room) return true
    }
    return false
  }

  /** Is this box clear of the land's fixed things, the paths and the other buildings? */
  private clear(b: Box, self: Building | null, water = false) {
    const a = this.areaBox()
    if (b.x < a.x || b.y < a.y || b.x + b.w > a.x + a.w || b.y + b.h > a.y + a.h) return false
    const fixed: Box[] = [
      grow({ x: this.castle.x, y: this.castle.y, w: MID, h: MIDDLE.castle }, 6), grow({ ...this.square, w: SQUARE.w, h: SQUARE.h }, 4),
      grow({ ...this.mine, w: SW, h: SH }, 4), grow({ x: this.pierAt.x - 6, y: this.pierAt.y, w: 16, h: this.pierAt.len }, 2), ...this.base,
      ...this.mounts.map(m => grow(this.rockOf(m), 4)),
    ]
    if (fixed.some(f => hit(b, f))) return false
    if (this.network.some(r => hit(b, r))) return false
    for (const o of this.buildings.values()) if (o !== self && o.pos && hit(b, this.boxOf(o))) return false
    if (this.nearRiver(b.x, b.y, b.w, b.h)) return false
    if (!water) {
      for (let y = b.y; y <= b.y + b.h; y += 4) for (let x = b.x; x <= b.x + b.w; x += 6) if (this.inLake(x, y)) return false
    }
    return true
  }

  /** The town's area: where things may be built, the castle in its middle. */
  private areaBox(): Box {
    return { x: this.ox - this.area.w / 2 + 20, y: 16, w: this.area.w - 40, h: this.area.h - 52 }
  }

  /** Whether a building fits where `b.pos` puts it: on land all clear; on the shore, its land part clear and its foot in the water. */
  private fits(b: Building) {
    const f = KINDS[b.kind]
    const box = this.boxOf(b)
    if (f.zone !== 'water' || !b.pos) return this.clear(box, b)
    return this.clear({ ...box, h: Math.round(f.h / 3) + 4 }, b, true) && this.inLake(b.pos.x + f.w / 2, b.pos.y + f.h - 2)
  }

  /** The room a building takes: its footprint, its name under it, its builder beside it. */
  private boxOf(b: Building): Box {
    const f = KINDS[b.kind]
    const p = b.pos ?? { x: -1000, y: -1000 }
    return { x: p.x - 4, y: p.y - 3, w: f.w + 18, h: f.h + 12 }
  }

  /** Places every building, oldest first: where it stood before when that still works, else the best free spot for its kind. */
  private placeAll() {
    this.network = []
    const order = [...this.buildings.values()].sort((p, q) => p.order - q.order)
    for (const b of order) b.pos = null
    let ok = true
    for (const b of order) {
      const f = KINDS[b.kind]
      const water = f.zone === 'water'
      let pos: Spot | null = null
      if (b.stored) {
        const at = { x: this.ox + b.stored.x, y: b.stored.y }
        b.pos = at
        // a part stays by its feature: when a merge moved the feature, its parts follow it to new spots
        if (this.fits(b) && this.byParent(b, at)) pos = at
        b.pos = null
      }
      if (!pos) {
        pos = (water ? this.shoreSpot(b) : null) ?? this.landSpot(b)
        if (!pos) {
          ok = false
          continue
        }
        this.fresh.set(b.name, { dx: pos.x - this.ox, dy: pos.y })
      }
      b.pos = pos
      this.connect(b)
    }
    return ok
  }

  /** Whether a part of a feature stands near enough to it (anything that is no part does). */
  private byParent(b: Building, at: Spot) {
    const parent = b.parent ? this.buildings.get(b.parent) : undefined
    if (!parent?.pos) return true
    const f = KINDS[b.kind]
    const a = this.anchorOf(b)
    return Math.hypot(at.x + f.w / 2 - a.x, at.y + f.h / 2 - a.y) < 200
  }

  private anchorOf(b: Building): Spot {
    const parent = b.parent ? this.buildings.get(b.parent) : undefined
    if (parent?.pos) {
      const f = KINDS[parent.kind]
      return { x: parent.pos.x + f.w / 2, y: parent.pos.y + f.h / 2 }
    }
    const sq = { x: this.square.x + SQUARE.w / 2, y: this.square.y + SQUARE.h / 2 }
    const zone = KINDS[b.kind].zone
    return zone === 'farm' ? { x: this.ox + 150, y: 250 }
      : zone === 'forest' ? { x: this.ox + 205, y: 150 }
      : zone === 'hill' ? { x: this.ox - 110, y: 92 }
      : sq
  }

  /** The free spot nearest where the kind belongs (or its parent stands), searched outward in rings. */
  private landSpot(b: Building): Spot | null {
    const f = KINDS[b.kind]
    const a = this.anchorOf(b)
    for (const [dx, dy] of RINGS) {
      const pos = { x: Math.round(a.x + dx - f.w / 2), y: Math.round(a.y + dy - f.h / 2) }
      b.pos = pos
      const ok = this.clear(this.boxOf(b), b)
      b.pos = null
      if (ok) return pos
    }
    return null
  }

  /** On the lake's north shore: the shore a third of the way down the footprint, land above, water below. */
  private shoreSpot(b: Building): Spot | null {
    const f = KINDS[b.kind]
    const a = this.anchorOf(b)
    const lk = this.lakeC
    const spots: Spot[] = []
    for (let x = lk.x - lk.rx + f.w / 2 + 6; x <= lk.x + lk.rx - f.w / 2 - 6; x += 4) {
      let y = lk.y - lk.ry
      while (y < lk.y && !this.inLake(x, y)) y++
      if (y >= lk.y) continue
      spots.push({ x: Math.round(x - f.w / 2), y: Math.round(y - f.h / 3) })
    }
    spots.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))
    for (const pos of spots) {
      b.pos = pos
      const ok = this.fits(b)
      b.pos = null
      if (ok) return pos
    }
    return null
  }

  /** A path from the building's door to the nearest road, two straight legs, the way round other buildings if there is one. */
  private connect(b: Building) {
    const f = KINDS[b.kind]
    const p = b.pos
    if (!p) return
    const water = f.zone === 'water'
    const door = { x: p.x + Math.round(f.w / 2) - 2, y: water ? p.y - 2 : p.y + f.h }
    const roads: Box[] = [...this.base, ...this.network, { ...this.square, w: SQUARE.w, h: SQUARE.h }]
    let best: Spot | null = null
    let d = Infinity
    for (const r of roads) {
      const q = { x: clamp(door.x, r.x, r.x + r.w - 4), y: clamp(door.y, r.y, r.y + r.h - 4) }
      const k = Math.hypot(q.x - door.x, q.y - door.y)
      if (k < d) (d = k), (best = q)
    }
    if (!best) return
    const t = best
    const leg = (x0: number, y0: number, x1: number, y1: number): Box => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 4, h: Math.abs(y1 - y0) + 4 })
    const stub = water ? -6 : 6
    const ways: Box[][] = [
      [leg(door.x, door.y, door.x, t.y), leg(door.x, t.y, t.x, t.y)],
      [leg(door.x, door.y, door.x, door.y + stub), leg(door.x, door.y + stub, t.x, door.y + stub), leg(t.x, door.y + stub, t.x, t.y)],
    ]
    const cost = (way: Box[]) => way.reduce((n, r) => n + [...this.buildings.values()].filter(o => o !== b && o.pos && hit(r, footprint(o))).length * 100 + (this.nearRiver(r.x, r.y, r.w, r.h, 0) ? 1 : 0), 0)
    const way = ways.sort((p1, p2) => cost(p1) - cost(p2))[0] ?? []
    for (const r of way) if (r.w > 0 && r.h > 0) this.network.push(r)
  }

  // ---- camps: with several crews at work, each gathers at a tent of its own near the square

  /** The room a camp takes: the tent, its sign, and its crew standing in front of it. */
  private campBox(at: Spot): Box {
    return { x: at.x - 24, y: at.y - 10, w: CAMP.w + 48, h: CAMP.h + 58 }
  }

  /** A camp for every crew when there are several, each where it was while that still works, else the free spot nearest the square. Buildings come first: a camp never moves one. */
  private placeCamps() {
    const keep = new Map<string, Spot>()
    if (this.crews.length > 1) {
      const free = (at: Spot) => this.clear(this.campBox(at), null) && ![...keep.values()].some(o => hit(this.campBox(at), this.campBox(o)))
      const a = { x: this.square.x + SQUARE.w / 2, y: this.square.y + SQUARE.h / 2 + 20 }
      for (const c of this.crews) {
        const was = this.camps.get(c.id)
        if (was && free(was)) {
          keep.set(c.id, was)
          continue
        }
        for (const [dx, dy] of RINGS) {
          const at = { x: Math.round(a.x + dx - CAMP.w / 2), y: Math.round(a.y + dy - CAMP.h / 2) }
          if (free(at)) {
            keep.set(c.id, at)
            break
          }
        }
      }
    }
    this.camps = keep
  }

  /** The crews as the pane lists them: name, lead, color, and whether it has a camp. */
  crewList() {
    return this.crews.map(c => ({ id: c.id, name: c.name, lead: c.lead, color: c.color, camp: this.camps.has(c.id) }))
  }

  /** The people as they stand: who, dressed how, where, and whether on the way somewhere. */
  heroList() {
    return [...this.units.values()].filter(u => u.kind === 'hero').map(u => ({ id: u.id, role: u.role, coat: u.coat, x: u.x, y: u.y, moving: u.path.length > 0, doing: u.doing }))
  }

  /** Moves the camera to a crew: its camp, else its lead. */
  focusCrew(id: string) {
    const at = this.camps.get(id)
    if (at) return this.lookAt(at.x + CAMP.w / 2, at.y + CAMP.h + 10)
    const lead = [...this.units.values()].find(u => u.kind === 'hero' && u.crew === id && u.isLead)
    if (lead) this.lookAt(lead.x, lead.y)
  }

  /** New spots found since the last call, by building name, from the castle's middle: the plugin keeps them in the town's file. */
  takePlacements() {
    const out = [...this.fresh.entries()].map(([name, p]) => ({ name, dx: p.dx, dy: p.dy }))
    this.fresh.clear()
    return out
  }

  /** Woods along the edges and groves in the open, never on the town's things, the water or the paths. */
  private forest() {
    const { W, H } = this
    const rand = seeded(W * 7919 + H * 31)
    const trees: { x: number; y: number; pine: boolean }[] = []
    const sq = { ...this.square, w: SQUARE.w, h: SQUARE.h }
    const ok = (x: number, y: number) => {
      const b = { x, y, w: 11, h: 10 }
      if (this.mounts.some(m => hit(b, this.rockOf(m)))) return false
      if (hit(b, grow({ x: this.castle.x, y: this.castle.y, w: MID, h: MIDDLE.castle }, 4)) || hit(b, grow(sq, 6)) || hit(b, grow({ ...this.mine, w: SW, h: SH }, 2))) return false
      if ([...this.base, ...this.network].some(r => hit(b, grow(r, 1)))) return false
      if ([...this.buildings.values()].some(o => o.pos && hit(b, this.boxOf(o)))) return false
      if ([...this.camps.values()].some(c => hit(b, this.campBox(c)))) return false
      if (this.nearRiver(x, y, 11, 10, 6)) return false
      for (const [dx, dy] of [[0, 0], [10, 0], [0, 10], [10, 10], [5, 5]] as const) if (this.inLake(x + dx, y + dy)) return false
      if (hit(b, { x: this.pierAt.x - 8, y: this.pierAt.y - 6, w: 20, h: this.pierAt.len + 8 })) return false
      return true
    }
    // thick along the left, right and bottom edges
    for (let y = 2; y < H - 6; y += 7) {
      for (const x0 of [-2, 6, 14, W - 23, W - 15, W - 7]) {
        const x = x0 + Math.round(rand() * 2)
        if (rand() < 0.88 && ok(x, y)) trees.push({ x, y, pine: rand() < 0.45 })
      }
    }
    for (let x = 4; x < W - 12; x += 9) {
      for (const y0 of [H - 9, H - 17, H - 25]) if (rand() < 0.8 && ok(x, y0)) trees.push({ x: x + Math.round(rand() * 2), y: y0, pine: rand() < 0.45 })
    }
    // a wood east of the town (the sawmill's), and groves here and there
    const groves = [
      { x: this.ox + 215, y: 150, n: 26 }, { x: this.ox - 60, y: 380, n: 10 }, { x: this.ox + 60, y: 340, n: 8 }, { x: this.ox - 250, y: 150, n: 10 },
      // between the massifs in the north
      { x: this.ox + 52, y: 30, n: 7 }, { x: this.ox - 104, y: 62, n: 5 }, { x: this.ox + 290, y: 30, n: 6 }, { x: this.ox + 120, y: 76, n: 5 },
    ]
    for (let k = 0; k < 6; k++) groves.push({ x: Math.round(40 + rand() * (W - 80)), y: Math.round(30 + rand() * (H - 90)), n: 5 + Math.round(rand() * 4) })
    for (const g of groves) {
      for (let k = 0; k < g.n * 3 && k < 200; k++) {
        const x = Math.round(g.x + (rand() - 0.5) * g.n * 6)
        const y = Math.round(g.y + (rand() - 0.5) * g.n * 4)
        if (ok(x, y) && !trees.some(t => Math.abs(t.x - x) < 7 && Math.abs(t.y - y) < 6)) trees.push({ x, y, pine: rand() < 0.4 })
      }
    }
    // a tree by the lake to nap under
    const nap = { x: this.lakeC.x + this.lakeC.rx - 8, y: this.lakeC.y - this.lakeC.ry - 22 }
    if (ok(nap.x, nap.y)) trees.push({ ...nap, pine: false })
    this.napAt = { x: nap.x - 16, y: nap.y + 10 }
    return trees.sort((a, b) => a.y - b.y)
  }

  /** The small things: lamps by the gate and the square, a bench by the lake, bushes, rocks and wild flowers in the open. */
  private dress(): Decor[] {
    const rand = seeded(this.W * 131 + this.H * 7)
    const ox = this.ox
    const sq = this.square
    const decor: Decor[] = [
      { kind: 'lamp', x: ox - 9, y: CASTLE_Y + MIDDLE.castle + 5 }, { kind: 'lamp', x: ox + 9, y: CASTLE_Y + MIDDLE.castle + 5 },
      { kind: 'lamp', x: sq.x - 4, y: sq.y + SQUARE.h }, { kind: 'lamp', x: sq.x + SQUARE.w + 3, y: sq.y + SQUARE.h },
      { kind: 'bench', x: this.pierAt.x + 10, y: this.pierAt.y - 2 },
    ]
    const taken = (x: number, y: number, w: number, h: number) => {
      const b = { x, y, w, h }
      if (y < 4 || x < 24 || x + w > this.W - 24 || y + h > this.H - 30) return true
      if (this.mounts.some(m => hit(b, this.rockOf(m)))) return true
      if (hit(b, grow({ x: this.castle.x, y: this.castle.y, w: MID, h: MIDDLE.castle }, 4)) || hit(b, grow({ ...sq, w: SQUARE.w, h: SQUARE.h }, 6)) || hit(b, grow({ ...this.mine, w: SW, h: SH }, 2))) return true
      if ([...this.base, ...this.network].some(r => hit(b, grow(r, 2)))) return true
      if ([...this.buildings.values()].some(o => o.pos && hit(b, this.boxOf(o)))) return true
      if ([...this.camps.values()].some(c => hit(b, this.campBox(c)))) return true
      if (this.nearRiver(x, y, w, h, 6) || this.inLake(x + w / 2, y + h / 2) || this.inLake(x, y) || this.inLake(x + w, y + h)) return true
      if (this.trees.some(t => hit(b, { x: t.x, y: t.y, w: 11, h: 10 }))) return true
      return decor.some(d => hit(b, { x: d.x - 4, y: d.y - 12, w: 16, h: 16 }))
    }
    for (let n = 0; n < (this.W * this.H) / 1100; n++) {
      const x = Math.round(rand() * this.W)
      const y = Math.round(rand() * this.H)
      const r = rand()
      const kind: Decor['kind'] = r < 0.45 ? 'bush' : r < 0.7 ? 'rock' : 'flowers'
      const w = kind === 'flowers' ? 12 : 8
      if (!taken(x, y, w, 6)) decor.push({ kind, x, y, variant: Math.floor(rand() * 3) })
    }
    return decor.sort((a, b) => a.y - b.y)
  }

  /** The ground at a scale: grass, the paths, wild flowers. Made again when the land or the paths change. */
  private groundAt(s: Scale) {
    const key = `${this.landKey}|${s}|${this.network.map(r => `${r.x},${r.y},${r.w},${r.h}`).join(';')}|${this.decor.length}`
    if (key === this.groundKey) return this.ground
    this.groundKey = key
    const w = Math.ceil(this.W * s)
    const h = Math.ceil(this.H * s)
    const g = new Pen(w, h, C.grass)
    const rand = seeded(this.W * 31 + this.H)
    const at = (v: number) => Math.floor(v * s)
    const len = (v: number) => Math.max(1, Math.round(v * s))
    g.as(0, () => {
      // calm grass: sparse tufts, the odd flower
      for (let k = 0; k < (w * h) / 140; k++) {
        const x = Math.floor(rand() * w)
        const y = Math.floor(rand() * h)
        g.dot(x, y, rand() < 0.1 ? (rand() < 0.5 ? C.flowerY : C.flowerW) : C.tuft)
      }
    })
    for (const r of [...this.base, ...this.network]) road(g, s, at(r.x), at(r.y), len(r.w), len(r.h))
    for (const d of this.decor) if (d.kind === 'flowers') flowers(g, s, at(d.x), at(d.y), len(12), len(6), d.variant ?? 0)
    this.ground = g
    return g
  }

  // ---- sync with the crew files

  sync(snap: Snapshot) {
    const now = snap.now
    this.clock = Math.max(this.clock, now)
    this.bored = !!snap.bored
    // every crew in the snapshot (the plugin sends one project's), and its overseer
    const byTask = new Map<string, CrewSession[]>()
    for (const s of snap.sessions) if (s.task) byTask.set(s.task.id, [...(byTask.get(s.task.id) ?? []), s])
    const overseer = snap.sessions.find(s => s.overseer && !s.task)
    const crew = [...[...byTask.values()].flat(), ...(overseer ? [overseer] : [])]
    this.sessions = crew
    this.crews = [...byTask.entries()]
      .map(([id, list]) => {
        const lead = list.find(s => s.task?.role === 'Lead')
        return { id, name: list[0]?.task?.name ?? 'crew', lead: lead?.name ?? list[0]?.task?.lead ?? 'the lead', color: rgb((lead ?? list[0])?.color ?? '#b03a3a'), since: Math.min(...list.map(s => s.startedAt)) }
      })
      .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id))
    const firstCrew = this.crews[0]
    const firstList = firstCrew ? (byTask.get(firstCrew.id) ?? []) : []
    const lead = firstList.find(s => s.task?.role === 'Lead')
    this.project = snap.project ?? ''
    this.task = firstCrew ? { id: firstCrew.id, name: firstCrew.name, lead: firstCrew.lead, project: (lead ?? firstList[0])?.project ?? 'project' } : null
    // the castle flies the overseer's color when there is one, else the first crew's lead's
    this.leadColor = overseer ? rgb(overseer.color) : lead ? rgb(lead.color) : 0xb03a3a
    this.syncBuildings(snap, crew, now)
    this.syncUnits(crew, now)
    this.plan()
  }

  private syncBuildings(snap: Snapshot, crew: CrewSession[], now: number) {
    // the town as built over earlier tasks, then what this crew is on now: a feature named like a building works on it
    type Want = Omit<Building, 'id' | 'pos' | 'burnAt' | 'doneAt'> & { removedAt: number }
    const want = new Map<string, Want>()
    const keyOf = (name: string) => name.trim().toLowerCase()
    const kindOf = (name: string, kind?: string, crop?: string, parent?: string) => {
      const g = guessKind(name, parent)
      const k = (KIND_NAMES as string[]).includes(kind ?? '') ? (kind as Kind) : g.kind
      return { kind: k, crop: (CROPS as string[]).includes(crop ?? '') ? (crop as Crop) : k === 'field' ? (g.crop ?? CROPS[hash(keyOf(name)) % CROPS.length] ?? 'wheat') : undefined }
    }
    ;(snap.town ?? []).forEach((t, i) => {
      const removedAt = t.status === 'removed' ? t.at : 0
      // a rebuild that nobody here is on any more stands as it was
      const status = t.status === 'removed' || t.level > 0 ? 'done' : 'building'
      const { kind, crop } = kindOf(t.name, t.kind, t.crop, t.parent)
      want.set(keyOf(t.name), {
        name: t.name, status, level: t.level, at: t.at, color: rgb(t.color || '#8a8a8a'), owner: '', order: i, by: t.by, removedAt,
        kind, crop, parent: t.parent ? keyOf(t.parent) : '', stored: typeof t.dx === 'number' && typeof t.dy === 'number' ? { x: t.dx, y: t.dy } : null,
      })
    })
    for (const s of crew) {
      for (const f of s.features ?? []) {
        const t = want.get(keyOf(f.name))
        if (t?.removedAt && t.removedAt >= f.at) continue
        const level = Math.max(t?.level ?? 0, f.status === 'done' ? 1 : 0)
        const { kind, crop } = t && !f.kind ? { kind: t.kind, crop: t.crop } : kindOf(f.name, f.kind, f.crop, f.parent)
        want.set(keyOf(f.name), {
          name: t?.name ?? f.name, status: f.status, level, at: f.status === 'building' ? f.at : (t?.at ?? f.at), color: rgb(s.color), owner: s.id,
          order: t?.order ?? 1e6 + f.at, by: s.name, removedAt: 0, kind, crop, parent: f.parent ? keyOf(f.parent) : (t?.parent ?? ''), stored: t?.stored ?? null,
        })
      }
    }
    const merges = new Set((snap.merged ?? []).map(keyOf))
    const seen = new Set<string>()
    for (const [id, w] of want) {
      const old = this.buildings.get(id)
      if (w.removedAt) {
        // removed: it burns if that just happened; long gone, it is not drawn at all
        const burnAt = old?.burnAt || (now - w.removedAt < BURN_MS - 4000 ? Math.max(w.removedAt, now - 2000) : 0)
        if (!burnAt || now - burnAt > BURN_MS) continue
        seen.add(id)
        if (old) {
          if (!old.burnAt) this.ignite(old, now)
          continue
        }
        const { removedAt: _gone, ...rest } = w
        const b: Building = { id, ...rest, level: Math.max(1, w.level), pos: null, burnAt: 0, doneAt: 0 }
        this.buildings.set(id, b)
        this.plan()
        this.ignite(b, burnAt)
        continue
      }
      seen.add(id)
      const { removedAt: _none, ...rest } = w
      if (!old) {
        this.buildings.set(id, { id, ...rest, pos: null, burnAt: 0, doneAt: 0 })
        if (w.owner && w.status === 'building') this.say(w.owner, w.level > 0 ? `Improving ${w.name}!` : `Starting on ${w.name}!`, now, 'say')
        continue
      }
      if (old.burnAt) continue
      if (old.status === 'building' && w.status === 'done') {
        old.doneAt = now
        this.celebrate(old, now)
        if (w.owner) this.say(w.owner, w.level > 1 ? `${w.name} is level ${w.level} now!` : fill(pick(DONE), w.name), now, 'happy')
      }
      if (w.owner && old.status === 'done' && w.status === 'building') this.say(w.owner, `Improving ${w.name}!`, now, 'say')
      // finished again elsewhere, or two people's work on it merged: it goes up where it stands, with confetti
      if (old.status === 'done' && w.status === 'done' && w.level > old.level) {
        old.doneAt = now
        this.celebrate(old, now)
        if (merges.has(id)) old.mergedAt = now
      }
      // where it stands is the engine's own once placed; the rest follows the files
      const { stored: _s, ...fresh } = rest
      Object.assign(old, fresh)
      if (!old.stored && rest.stored) old.stored = rest.stored
    }
    for (const [id, b] of [...this.buildings]) {
      if (seen.has(id) || (b.burnAt && now - b.burnAt < BURN_MS)) continue
      this.buildings.delete(id)
    }
    this.plan()
  }

  /** A building set on fire: the crew runs over, and the camera too unless the person just moved it. */
  private ignite(b: Building, at: number) {
    b.burnAt = at
    const p = b.pos
    const f = KINDS[b.kind]
    if (p && this.clock - this.movedAt > 8000) this.lookAt(p.x + f.w / 2, p.y + f.h / 2 + 6)
  }

  private celebrate(b: Building, now: number) {
    const p = b.pos
    if (!p) return
    const f = KINDS[b.kind]
    const rand = seeded(hash(b.id) + now)
    for (let k = 0; k < 36; k++) {
      this.sparks.push({
        x: p.x + rand() * f.w, y: p.y + 4 + rand() * 6, vx: (rand() - 0.5) * 14, vy: -6 - rand() * 14,
        c: C.confetti[k % C.confetti.length] ?? C.gold, until: now + 2500 + rand() * 2000, gravity: 9,
      })
    }
  }

  private syncUnits(crew: CrewSession[], now: number) {
    const seen = new Set<string>()
    for (const s of crew) {
      seen.add(s.id)
      let u = this.units.get(s.id)
      if (!u) {
        const camp = this.camps.get(s.task?.id ?? '')
        const at = s.overseer ? this.mayorSpot() : camp ? { x: camp.x + CAMP.w / 2, y: camp.y + CAMP.h + 22 } : this.gatherSpot(this.units.size)
        u = blankUnit('hero', s.id, s.id, at)
        u.hair = C.hairs[hash(s.id) % C.hairs.length] ?? C.hairs[0]
        u.nextTalk = now + 3000 + Math.random() * 5000
        u.lastPost = Math.max(0, ...s.posts.map(p => p.at))
        u.bubble = { text: s.overseer ? 'Overseeing the crews!' : `${s.task?.role ?? 'Crew'}, reporting!`, until: now + 3500, kind: 'say' }
        this.units.set(s.id, u)
        this.puffs.push({ x: at.x, y: at.y - 5, until: now + 500 })
      }
      // the overseer is the king; a crew's lead wears the captain's hat
      const role: Role = s.overseer && !s.task ? 'king' : s.task?.role === 'Lead' ? 'lead' : /advis|review|architect|expert|mentor|sage|consult/i.test(s.task?.role ?? '') ? 'sage' : 'worker'
      if (u.status === 'working' && s.status === 'idle') {
        u.bubble = { text: Math.random() < 0.3 ? "Job's done!" : 'Done, ready for more.', until: now + 3000, kind: 'say' }
        u.idleUntil = 0
      }
      // a crew dresses alike, in its lead's color, so who belongs with whom reads at a glance
      const coat = this.crews.find(c => c.id === s.task?.id)?.color ?? rgb(s.color)
      Object.assign(u, {
        name: s.name, color: rgb(s.color), coat, role, status: s.status, tool: s.tool, detail: s.detail ?? '', lastPrompt: s.lastPrompt,
        attention: s.attention, isLead: s.task?.role === 'Lead', talkTo: s.talkTo ?? '', talkAt: s.talkAt ?? 0,
        crew: s.task?.id ?? '', overseer: !!s.overseer && !s.task,
      })
      const newest = s.posts.reduce((m, p) => Math.max(m, p.at), 0)
      if (newest > u.lastPost) {
        u.lastPost = newest
        const post = s.posts.find(p => p.at === newest)
        if (post) u.bubble = { text: `"${gist(post.text, 34)}"`, until: now + 6000, kind: 'say' }
      }
      for (const a of s.agents) {
        seen.add(a.id)
        const known = this.units.get(a.id)
        if (known) {
          known.desc = a.desc || a.kind
          known.color = rgb(s.color)
          known.coat = coat
          continue
        }
        const h = blankUnit('helper', a.id, s.id, { x: u.x + 8, y: u.y })
        h.color = rgb(s.color)
        h.coat = coat
        h.desc = a.desc || a.kind
        h.hair = C.hairs[hash(a.id) % C.hairs.length] ?? C.hairs[0]
        h.bubble = { text: gist(h.desc, 26), until: now + 3500, kind: 'say' }
        this.units.set(a.id, h)
        this.puffs.push({ x: h.x, y: h.y - 4, until: now + 500 })
      }
    }
    for (const [id, u] of this.units) {
      if (seen.has(id)) continue
      this.puffs.push({ x: u.x, y: u.y - 5, until: now + 600 })
      this.units.delete(id)
    }
  }

  private say(id: string, text: string, now: number, kind: Bubble['kind']) {
    const u = this.units.get(id)
    if (u) u.bubble = { text, until: now + 5000, kind }
  }

  // ---- where people stand (feet: the middle column, the bottom row)

  /** Round the spring in the square, each in a place of its own, 18 apart; more stand along the square's front. */
  private gatherSpot(i: number): Spot {
    const q = this.square
    const AROUND = [[24, 26], [60, 26], [33, 38], [51, 38], [17, 15], [67, 15]] as const
    const at = AROUND[i]
    if (at) return { x: q.x + at[0], y: q.y + at[1] }
    return { x: q.x + 6 + (i - AROUND.length) * 18, y: q.y + SQUARE.h + 10 }
  }

  /** Where an idle hero gathers: its crew's camp when there are several crews, the spring otherwise; the overseer at the castle gate. */
  private gatherOf(u: Unit, heroes: Unit[]): Spot {
    if (u.overseer) return this.mayorSpot()
    const camp = this.camps.get(u.crew)
    if (!camp) return this.gatherSpot(Math.max(0, heroes.filter(o => !o.overseer).indexOf(u)))
    const mates = heroes.filter(o => o.crew === u.crew && !o.overseer)
    const i = Math.max(0, mates.indexOf(u))
    // in front of the tent, two by two, clear of it
    const at = [i % 2 ? CAMP.w - 2 : 2, Math.floor(i / 2) * 14]
    return { x: camp.x + (at[0] ?? 0), y: camp.y + CAMP.h + 22 + (at[1] ?? 0) }
  }

  /** The overseer's place: before the castle gate, between the lamps. */
  private mayorSpot(): Spot {
    return { x: this.ox, y: CASTLE_Y + MIDDLE.castle + 5 }
  }

  /** Where the builder of a building stands: just right of it, on its bottom row (on the land, for a water kind). */
  private siteSpot(b: Building, k = 0): Spot | null {
    const p = b.pos
    if (!p) return null
    const f = KINDS[b.kind]
    return { x: p.x + f.w + 5 + k * 12, y: f.zone === 'water' ? p.y + Math.round(f.h / 3) - 2 : p.y + f.h - 1 }
  }

  /** Before the door of the first finished building of a kind, if the town has one. */
  private doorOf(kind: Kind, k = 0): Spot | null {
    const b = [...this.buildings.values()].find(o => o.kind === kind && o.status === 'done' && o.pos && !o.burnAt)
    if (!b?.pos) return null
    const f = KINDS[kind]
    return { x: b.pos.x + Math.round(f.w / 2) - 9 + k * 18, y: b.pos.y + f.h + 5 }
  }

  private spotFor(u: Unit, doing: Doing, heroes: Unit[]): { at: Spot; face: 1 | -1 | 0 } {
    // the overseer works from the castle gate, whatever it does
    if (u.overseer && doing !== 'ping') return { at: this.mayorSpot(), face: 0 }
    const q = this.square
    // two at the same thing stand side by side
    const k = heroes.filter(o => o !== u && o.doing === doing && heroes.indexOf(o) < heroes.indexOf(u)).length
    const site = this.siteOf(u)
    const nearSite = site ? this.siteSpot(site, k) : null
    const aside = (i: number): Spot => ({ x: q.x + (i % 2 ? 72 : 12), y: q.y + 26 + Math.floor(i / 2) * 14 })
    switch (doing) {
      case 'build':
        return { at: nearSite ?? aside(k), face: -1 }
      case 'forge':
        return { at: this.doorOf('blacksmith', k) ?? nearSite ?? aside(k), face: 1 }
      case 'read':
        return { at: this.doorOf('library', k) ?? { x: q.x + 11 + k * 52, y: q.y + 38 }, face: 1 }
      case 'write':
      case 'plan':
        return { at: nearSite ?? aside(k + 1), face: -1 }
      case 'delegate':
      case 'think':
        return { at: { x: this.ox + (k % 2 ? 1 : -1) * (13 + (k >> 1) * 18), y: CASTLE_Y + MIDDLE.castle + 5 }, face: 0 }
      case 'ping':
        return { at: { x: this.ox + (k % 2 ? 1 : -1) * (9 + (k >> 1) * 18), y: q.y + SQUARE.h + 8 }, face: 0 }
      default:
        return { at: this.gatherOf(u, heroes), face: 0 }
    }
  }

  private siteOf(u: Unit) {
    return [...this.buildings.values()].find(b => b.owner === u.id && b.status === 'building' && !b.burnAt)
  }

  private burning() {
    return [...this.buildings.values()].filter(b => b.burnAt && this.clock - b.burnAt < BURN_MS).sort((a, b) => b.burnAt - a.burnAt)[0]
  }

  /** What a working hero is doing, from the tool it is using. */
  private doingOf(u: Unit): Doing {
    const t = u.tool
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t)) return this.siteOf(u) ? 'build' : 'write'
    if (/^(Bash|PowerShell|Monitor|KillShell|BashOutput)$/.test(t)) return 'forge'
    if (/^(Read|Grep|Glob|LSP|WebFetch|WebSearch|ToolSearch|NotebookRead)$/.test(t)) return 'read'
    if (/^(Agent|Task)$/.test(t)) return 'delegate'
    if (t === 'TodoWrite') return 'plan'
    if (!t && this.siteOf(u)) return 'build'
    return 'think'
  }

  /** Straight across the grass, round the lake by its north shore when the way would go through the water. */
  private route(u: Unit, to: Spot) {
    let wet = false
    for (let k = 1; k < 10; k++) if (this.inLake(u.x + ((to.x - u.x) * k) / 10, u.y + ((to.y - u.y) * k) / 10)) wet = true
    if (!wet) {
      u.path = [to]
      return
    }
    const y = this.lakeC.y - this.lakeC.ry - 8
    u.path = [{ x: u.x, y: Math.min(u.y, y) }, { x: to.x, y: Math.min(to.y, y) }, to]
  }

  private go(u: Unit, to: Spot, run = false) {
    const last = u.path[u.path.length - 1] ?? { x: u.x, y: u.y }
    if (Math.abs(last.x - to.x) < 1 && Math.abs(last.y - to.y) < 1) return
    u.run = run
    this.route(u, to)
  }

  // ---- simulation

  step(now: number, dt: number) {
    this.clock = now
    const heroes = [...this.units.values()].filter(u => u.kind === 'hero')
    const fire = this.burning()
    for (const u of this.units.values()) {
      if (u.bubble && u.bubble.until < now) u.bubble = null
      if (u.kind === 'hero') this.stepHero(u, heroes, now, fire)
      else this.stepHelper(u, now)
      walk(u, dt, u.kind === 'hero' ? (u.run ? 26 : 15) : 19)
    }
    if (this.settling && this.placed && heroes.length) this.settle()
    this.puffs = this.puffs.filter(p => p.until > now)
    for (const s of this.sparks) {
      s.vy += (s.gravity * dt) / 1000
      s.x += (s.vx * dt) / 1000
      s.y += (s.vy * dt) / 1000
    }
    this.sparks = this.sparks.filter(s => s.until > now)
    // a finished fire leaves a free plot
    for (const [id, b] of [...this.buildings]) {
      if (b.burnAt && now - b.burnAt > BURN_MS) {
        this.buildings.delete(id)
        this.plan()
      }
    }
  }

  /** Everyone at the end of its way at once: heroes where their work is, helpers beside their owners. */
  private settle() {
    this.settling = false
    for (const u of this.units.values()) {
      const end = u.kind === 'hero' ? u.path[u.path.length - 1] : this.units.get(u.owner)
      if (!end) continue
      u.x = end.x + (u.kind === 'helper' ? 9 : 0)
      u.y = end.y
      u.path = []
      u.moving = false
      if (u.kind === 'hero' && u.face !== 0) u.facing = u.face
    }
  }

  private stepHero(u: Unit, heroes: Unit[], now: number, fire: Building | undefined) {
    const prev = u.doing
    let doing: Doing
    if (fire) doing = now - fire.burnAt < 13_000 ? 'mourn' : 'cheer'
    else if (u.attention) doing = 'ping'
    else if (this.bored && u.status === 'idle') doing = 'bored'
    else if (u.talkTo && now - u.talkAt < 10_000) doing = 'talk'
    else if (u.status === 'working') {
      doing = this.doingOf(u)
      // a moment of thought between two tools does not send it running off
      if (doing === 'think' && ['build', 'forge', 'read', 'write', 'plan', 'delegate'].includes(prev) && now - u.since < 6000) doing = prev
    } else doing = 'idle'
    if (doing !== prev) {
      u.doing = doing
      u.since = now
      u.spot = null
    }
    if (doing === 'mourn' || doing === 'cheer') return this.stepFire(u, heroes, now, fire as Building, doing)
    if (doing === 'bored') return this.stepBored(u, heroes, now)
    if (doing === 'talk') {
      const partner = this.partnerOf(u)
      if (prev !== 'talk') {
        const to = u.talkTo === 'advisor' ? 'the advisor' : partner ? partner.name : u.talkTo === 'all' ? 'the crew' : u.talkTo
        u.bubble = { text: `Talking with ${gist(to, 22)}…`, until: now + 3500, kind: 'say' }
      }
      const spot = u.overseer ? this.mayorSpot() : partner ? { x: partner.x + (partner.x > u.x ? -10 : 10), y: partner.y } : this.gatherOf(u, heroes)
      this.go(u, spot)
      u.face = partner ? (partner.x >= u.x ? 1 : -1) : 0
      return
    }
    if (doing === 'idle') return this.stepIdle(u, heroes, now)
    if (!u.spot) {
      const { at, face } = this.spotFor(u, doing, heroes)
      u.spot = at
      u.face = face
      this.go(u, at)
      if (doing === 'ping') u.bubble = { text: pick(PING), until: now + 4000, kind: 'ping' }
      if (doing === 'delegate') {
        const n = [...this.units.values()].filter(p => p.kind === 'helper' && p.owner === u.id).length
        u.bubble = { text: n ? `Sending ${n} helper${n > 1 ? 's' : ''} out` : 'Calling a helper…', until: now + 3500, kind: 'say' }
      }
    }
    if (doing === 'ping' && !u.bubble) u.bubble = { text: pick(PING), until: now + 4000, kind: 'ping' }
    if (doing === 'delegate' && !u.bubble && now > u.nextTalk) {
      u.bubble = { text: pick(ORDERS), until: now + 2800, kind: 'fun' }
      u.nextTalk = now + 8000 + Math.random() * 6000
    }
  }

  private stepFire(u: Unit, heroes: Unit[], now: number, b: Building, doing: Doing) {
    const p = b.pos
    if (!p) return
    const f = KINDS[b.kind]
    // in rows of four, 18 apart (a person is 14 wide in the overview), below the name so it stays in sight
    const i = Math.max(0, heroes.indexOf(u))
    const row = Math.floor(i / 4)
    const inRow = Math.min(4, heroes.length - row * 4)
    const mid = p.x + f.w / 2
    const below = f.zone === 'water' ? p.y - 6 : p.y + f.h + 22
    const spot = { x: Math.round(mid + ((i % 4) - (inRow - 1) / 2) * 18), y: below + row * 14 }
    if (!u.spot || u.spot.x !== spot.x || u.spot.y !== spot.y) {
      u.spot = spot
      this.go(u, spot, true)
    }
    u.face = spot.x < mid ? 1 : -1
    const t = now - b.burnAt
    // one at a time, the remover first: sad farewells, then a turn for the better
    const order = [...heroes].sort((p, q) => Number(q.name === b.by) - Number(p.name === b.by))
    const turn = order.indexOf(u) % 4
    const say = (start: number, lines: readonly string[], kind: Bubble['kind']) => {
      const at = start + turn * 2400
      if (t >= at && t < at + 300 && u.bubble?.kind !== kind) u.bubble = { text: fill(pick(lines), b.name), until: now + 2600, kind }
    }
    if (doing === 'mourn') say(2500, BYE, 'sad')
    else say(14_000, FRESH, 'happy')
  }

  private stepBored(u: Unit, heroes: Unit[], now: number) {
    // everyone comes into view, lines up and waves for work
    const widths = heroes.map(o => Math.max(18, (Math.min(16, o.name.length) + 2) / this.zoom))
    const total = widths.reduce((a, b) => a + b, 0)
    const i = heroes.indexOf(u)
    const left = widths.slice(0, i).reduce((a, b) => a + b, 0)
    const x = Math.round(this.camX + this.visW / 2 - total / 2 + left + (widths[i] ?? 12) / 2)
    const y = Math.min(this.H - 4, this.cam + this.visH - Math.round(6 / this.zoom))
    if (!u.spot || Math.abs(u.spot.x - x) > 2 || Math.abs(u.spot.y - y) > 2) {
      u.spot = { x, y }
      u.path = [{ x, y }]
    }
    u.face = 0
    if (!u.moving && now > u.nextTalk && !heroes.some(o => o !== u && o.bubble?.kind === 'ping' && o.bubble.until > now)) {
      u.bubble = { text: pick(BORED), until: now + 3200, kind: 'ping' }
      u.nextTalk = now + 4000 + Math.random() * 5000
    }
  }

  private stepIdle(u: Unit, heroes: Unit[], now: number) {
    if (now > u.idleUntil || !u.spot) {
      const fishing = heroes.some(o => o !== u && o.doing === 'idle' && o.idle === 'fish')
      const napping = heroes.some(o => o !== u && o.doing === 'idle' && o.idle === 'nap')
      const r = Math.random()
      u.idle = u.overseer ? 'gather' : r < 0.5 ? 'gather' : r < 0.66 && !napping ? 'nap' : r < 0.84 && !fishing ? 'fish' : 'stroll'
      u.idleUntil = now + 20_000 + Math.random() * 25_000
      const roads = [...this.base, ...this.network]
      const lane = roads[Math.floor(Math.random() * roads.length)]
      const at =
        u.idle === 'fish' ? { x: this.pierAt.x + 2, y: this.pierAt.y + this.pierAt.len - 3 }
        : u.idle === 'nap' ? this.napAt
        : u.idle === 'stroll' && lane ? { x: Math.round(lane.x + Math.random() * lane.w), y: Math.round(lane.y + Math.random() * lane.h) }
        : this.gatherOf(u, heroes)
      u.spot = at
      u.face = u.idle === 'fish' ? 1 : 0
      this.go(u, at)
    }
    if (u.moving) return
    if (u.idle === 'nap') {
      if (!u.bubble) u.bubble = { text: 'Zzz', until: now + 2500, kind: 'sleep' }
    } else if (u.idle === 'fish') {
      if (now > u.nextTalk && !u.bubble) {
        u.bubble = { text: pick(FISHING), until: now + 3500, kind: 'fun' }
        u.nextTalk = now + 9000 + Math.random() * 9000
      }
    } else if (now > u.nextTalk && !heroes.some(o => o.bubble && o.bubble.kind !== 'sleep' && o.bubble.kind !== 'status' && o.bubble.until - now > 2500)) {
      const together = heroes.filter(o => o.doing === 'idle' && o.idle === 'gather' && !o.moving).length
      u.bubble = { text: this.chatter(u, together), until: now + 4500, kind: Math.random() < 0.3 ? 'fun' : 'say' }
      u.nextTalk = now + 8000 + Math.random() * 9000
    }
  }

  private partnerOf(u: Unit): Unit | undefined {
    const want = u.talkTo.toLowerCase()
    const others = [...this.units.values()].filter(o => o.kind === 'hero' && o.id !== u.id)
    if (!want || want === 'advisor') return others.find(o => o.role === 'sage')
    if (want === 'all') return others.find(o => o.isLead) ?? others[0]
    return others.find(o => o.name.toLowerCase() === want || o.name.toLowerCase().includes(want) || o.id === u.talkTo)
  }

  private stepHelper(u: Unit, now: number) {
    const owner = this.units.get(u.owner)
    const gate = { x: this.ox + (hash(u.id) % 2 ? 6 : -6), y: CASTLE_Y + MIDDLE.castle + 4 }
    const home = owner ? { x: owner.x + (owner.facing > 0 ? -9 : 9), y: owner.y } : gate
    const scouting = /explore|research|search|scout|find|look|review|read|investigat|analy|audit/i.test(u.desc)
    const site = owner && this.siteOf(owner)
    const plot = site?.pos ? site : null
    // scouts fetch scrolls (from the library if the town has one); the others carry crates from a store to the site
    const src = scouting ? (this.doorOf('library') ?? gate) : (this.doorOf('warehouse') ?? this.doorOf('sawmill') ?? this.doorOf('blacksmith') ?? gate)
    const f = plot ? KINDS[plot.kind] : null
    const dst = !scouting && plot?.pos && f ? { x: plot.pos.x - 5, y: f.zone === 'water' ? plot.pos.y + Math.round(f.h / 3) - 2 : plot.pos.y + f.h - 1 } : home
    const there = !u.moving && u.path.length === 0
    if (u.phase === 'out') {
      this.go(u, src)
      if (there && Math.hypot(u.x - src.x, u.y - src.y) < 2) (u.phase = 'work'), (u.until = now + 2200)
    } else if (u.phase === 'work') {
      if (now > u.until) (u.phase = 'back'), (u.carrying = scouting ? 'scroll' : 'crate')
    } else if (u.phase === 'back') {
      this.go(u, dst)
      if (there && Math.hypot(u.x - dst.x, u.y - dst.y) < 2) (u.phase = 'drop'), (u.until = now + 900)
    } else if (now > u.until) {
      u.phase = 'out'
      if (u.carrying === 'crate' && plot) this.puffs.push({ x: dst.x, y: dst.y - 3, until: now + 300 })
      u.carrying = ''
    }
  }

  private chatter(u: Unit, together: number) {
    if (Math.random() < 0.28 && together > 1) return pick(FUNNY)
    const mine = [...this.buildings.values()].filter(b => b.owner === u.id)
    const building = mine.find(b => b.status === 'building')
    const done = mine.find(b => b.status === 'done')
    const helpers = [...this.units.values()].filter(p => p.kind === 'helper' && p.owner === u.id).length
    const facts = [
      u.lastPrompt ? `Last on: ${gist(u.lastPrompt, 28)}` : '',
      building ? `Building ${building.name}` : '',
      done ? `I built ${done.name}!` : '',
      helpers ? `${helpers} helper${helpers > 1 ? 's' : ''} out working` : '',
      u.isLead ? `Task: ${gist(this.crews.find(c => c.id === u.crew)?.name ?? '', 26)}` : '',
      u.overseer ? `Overseeing ${this.crews.length} crew${this.crews.length === 1 ? '' : 's'}` : '',
      'Awaiting orders.',
    ].filter(Boolean)
    return pick(facts)
  }

  // ---- drawing

  render(): string {
    this.draw()
    return this.encode()
  }

  /** Everything the window view needs: the canvas (each pixel doubled across), its texts by town cell, the camera. */
  frameData() {
    const p = this.pen
    const FW = p.w * 2
    const px = new Uint32Array(FW * p.h)
    for (let i = 0; i < p.w * p.h; i++) px[i * 2] = px[i * 2 + 1] = p.px[i] ?? 0
    const text = new Map<number, [number, number, number]>()
    for (const it of this.items) {
      const glyphs = [...it.text]
      const row = Math.floor(it.y / 2)
      const x0 = clamp(Math.round(it.x - glyphs.length / 2), 0, Math.max(0, this.W - glyphs.length))
      glyphs.forEach((g, i) => text.set(row * this.W + x0 + i, [g.codePointAt(0) ?? 32, it.fg, it.bg === LABEL ? 0x01000000 : it.bg]))
    }
    return { px, FW, W: p.w, H: p.h, text, cam: this.cam, camX: this.camX, hud: this.hudCells }
  }

  /** The heroes where they stand, as the window view clicks them: the top-left of their body, in town pixels. */
  heroes() {
    return [...this.units.values()].filter(u => u.kind === 'hero').map(u => ({ id: u.id, name: u.name, x: u.x - 3, y: u.y - 11, color: u.color }))
  }

  /** Draws the frame at the zoom: scenery, rings round it, dusk, lights, then people over all; and the texts. */
  draw() {
    const now = this.clock
    const s = this.zoom
    this.glide()
    const anim = Math.floor(now / 250) % 720720
    this.dark = nightness(now)
    const lit = this.dark > 0.15
    const g = this.groundAt(s)
    if (this.pen.w !== g.w || this.pen.h !== g.h) this.pen = new Pen(g.w, g.h)
    const pen = this.pen
    pen.px.set(g.px)
    pen.kind.set(g.kind)
    pen.lights = []
    pen.layer = 1
    this.items = []
    const at = (v: number) => Math.floor(v * s)
    const len = (v: number) => Math.max(1, Math.round(v * s))

    // the land: the mountains, the river and the lake, bridges where paths cross the river, the pier and a boat
    for (const m of this.mounts) mountains(pen, s, at(m.x), at(m.y), len(m.w), len(m.h), m.seed, true)
    const flow: { x: number; w: number }[] = []
    let flowTop = -1
    for (let y = 0; y < pen.h; y++) {
      const c = this.riverAt(y / s)
      if (c === null) continue
      if (flowTop < 0) flowTop = y
      flow.push({ x: at(c - 7), w: len(14) })
    }
    if (flow.length) river(pen, s, flow, flowTop, anim)
    const water: { x: number; w: number }[] = []
    let waterTop = -1
    for (let y = 0; y < pen.h; y++) {
      const sp = this.lakeSpan(y / s)
      if (!sp) continue
      if (waterTop < 0) waterTop = y
      water.push({ x: at(sp.x0), w: Math.max(1, at(sp.x1) - at(sp.x0)) })
    }
    if (water.length) lake(pen, s, water, waterTop, anim)
    for (const r of [...this.base, ...this.network]) {
      if (r.w < r.h) continue
      const c = this.riverAt(r.y + 2)
      if (c !== null && c > r.x && c < r.x + r.w) bridge(pen, s, at(c - 11), at(r.y), len(22), len(r.h))
    }
    pier(pen, s, at(this.pierAt.x), at(this.pierAt.y), len(this.pierAt.len))
    const lk = this.lakeC
    boat(pen, s, at(lk.x - 20 + Math.round(Math.sin(anim / 40) * 30)), at(lk.y + 8 + ((anim >> 3) % 2)), anim)
    for (const d of this.decor) {
      const x = at(d.x)
      const y = at(d.y)
      if (d.kind === 'lamp') lamp(pen, s, x, y, lit, anim)
      else if (d.kind === 'bench') bench(pen, s, x, y)
      else if (d.kind === 'bush') bush(pen, s, x, y, d.variant ?? 0)
      else if (d.kind === 'rock') rock(pen, s, x, y, (d.variant ?? 0) === 2)
    }
    for (const t of this.trees) tree(pen, s, at(t.x), at(t.y), t.pine ? 'pine' : 'round')
    const used = Math.max(-1, ...this.sessions.map(q => q.five ?? -1))
    const left = used >= 0 ? Math.max(0, Math.round(100 - used)) : null
    mine(pen, s, at(this.mine.x), at(this.mine.y), { anim, left, lit })
    this.items.push({
      x: this.mine.x + SW / 2, y: this.mine.y + SH + 1, text: ` Tokens mine${left === null ? '' : `: ${left}% left`} `,
      fg: left === null || left > 40 ? C.gold : left > 15 ? 0xff9b3d : 0xe5484d, bg: SIGN, prio: 5,
    })
    castle(pen, s, at(this.castle.x), at(this.castle.y), { color: this.leadColor, anim, lit: lit || [...this.units.values()].some(u => u.isLead && u.status === 'working') })
    const project = this.task?.project ?? (this.project || 'project')
    this.items.push({ x: this.castle.x + 18, y: this.castle.y - 3, text: ` ${gist(project.charAt(0).toUpperCase() + project.slice(1), 24)} `, fg: 0xffffff, bg: shade(this.leadColor, 0.45), prio: 4 })
    square(pen, s, at(this.square.x), at(this.square.y), anim, lit)
    for (const b of [...this.buildings.values()].sort((p, q) => (p.pos?.y ?? 0) - (q.pos?.y ?? 0))) this.drawBuilding(b, s, anim, now, lit)
    for (const c of this.crews) {
      const at2 = this.camps.get(c.id)
      if (!at2) continue
      camp(pen, s, at(at2.x), at(at2.y), c.color, anim)
      // its name over the tent, in its color, as the castle's is over the castle
      this.items.push({ x: at2.x + CAMP.w / 2 + 2, y: at2.y - 3, text: ` ⚑ ${gist(c.name, s === 1 ? 22 : 14)} `, fg: 0xffffff, bg: shade(c.color, 0.45), prio: 3 })
    }
    ring(pen)
    dusk(pen, this.dark)

    const units = [...this.units.values()].sort((a, b) => a.y - b.y)
    for (const u of units) this.drawUnit(u, s, anim, now)
    pen.as(OVERLAY, () => {
      for (const p of this.puffs) for (const [dx, dy] of [[0, 0], [2, -1], [-1, 1], [3, 2], [1, 3]] as const) pen.dot(at(p.x) + Math.round(dx * s), at(p.y) + Math.round(dy * s), 0xe4e4e4)
      for (const sp of this.sparks) pen.dot(at(sp.x), at(sp.y), sp.c)
    })
    for (const u of units) this.labelUnit(u, s, now)
    this.hud()
  }

  // ---- people

  private drawUnit(u: Unit, s: Scale, anim: number, now: number) {
    const right = u.moving ? u.facing > 0 : u.face === 0 ? u.facing > 0 : u.face > 0
    if (!u.moving && u.face !== 0) u.facing = u.face
    const x = Math.floor(u.x * s)
    const y = Math.floor(u.y * s)
    const pen = this.pen
    if (u.kind === 'helper') {
      for (let i = -2; i <= 2; i++) pen.as(OVERLAY, () => pen.shade(x + Math.round(i * s), y + 1, 0.72))
      helper(pen, s, x, y, { color: u.coat, hair: u.hair, carrying: u.carrying, walking: u.moving, working: u.phase === 'work' && !u.moving, right, anim })
      return
    }
    const pose = this.poseOf(u, anim, now)
    const hop = this.hops(u, anim) ? (s === 1 ? 2 : 1) : 0
    const shadow = pose === 'sleep' ? [0, Math.round(16 * s)] : [-Math.round(3 * s), Math.round(3 * s)]
    pen.as(OVERLAY, () => {
      for (let i = shadow[0] ?? 0; i <= (shadow[1] ?? 0); i++) pen.shade(x + i, y + 1, 0.7)
    })
    person(pen, s, x, y - hop, { role: u.role, color: u.coat, hair: u.hair, pose, right, anim, style: hash(u.id) })
    if (u.attention && anim % 2 === 0) {
      const top = y - hop - personHeight(s, { role: u.role, pose }) - 2
      pen.as(OVERLAY, () => {
        for (const dy of s === 1 ? [-4, -3, -2, 0] : [-2, -1, 0]) pen.dot(x, top + dy, 0xffe14d)
      })
    }
  }

  private hops(u: Unit, anim: number) {
    return (u.doing === 'cheer' || u.doing === 'bored' || u.doing === 'ping') && !u.moving && (anim + (hash(u.id) % 3)) % 4 < 2
  }

  private poseOf(u: Unit, anim: number, now: number): Pose {
    if (u.moving) return anim % 2 ? 'walk1' : 'walk2'
    const beat = anim % 2 === 0
    switch (u.doing) {
      case 'build':
      case 'forge':
        return beat ? 'hammerUp' : 'hammerDown'
      case 'read':
        return anim % 8 === 0 ? 'readTurn' : 'read'
      case 'write':
        return 'write'
      case 'plan':
      case 'delegate':
        return anim % 6 < 4 ? 'point' : 'stand'
      case 'think':
        return 'think'
      case 'talk':
        return beat ? 'talk' : 'stand'
      case 'ping':
      case 'bored':
        return beat ? 'wave1' : 'wave2'
      case 'mourn':
        return 'sad'
      case 'cheer':
        return beat ? 'cheer' : 'stand'
      default:
        if (u.idle === 'nap') return 'sleep'
        if (u.idle === 'fish') return 'sit'
        if (u.bubble && (u.bubble.kind === 'say' || u.bubble.kind === 'fun') && u.bubble.until > now) return beat ? 'talk' : 'stand'
        return 'stand'
    }
  }

  /** The texts that go with a person: its name under its feet, and over its head what it says or does. */
  private labelUnit(u: Unit, s: Scale, now: number) {
    if (u.kind === 'helper') {
      this.items.push({ x: u.x, y: u.y + Math.ceil(2 / s), text: gist(u.desc, 16), fg: blend(u.color, 0xd0d0d0, 0.5), bg: LABEL, prio: 7, down: true })
      return
    }
    const pose = this.poseOf(u, 0, now)
    const lying = pose === 'sleep'
    // a lead's name carries a star; its color is the crew's, like its coat
    const tag = u.role === 'lead' ? `★ ${gist(u.name, 16)}` : gist(u.name, 18)
    this.items.push({ x: lying ? u.x + 8 : u.x, y: u.y + Math.ceil(2 / s), text: tag, fg: blend(u.coat, 0xffffff, 0.35), bg: LABEL, prio: 2, down: true })
    const b = u.bubble ?? this.statusOf(u)
    if (!b) return
    const hop = this.hops(u, 0) ? 2 : 0
    const top = u.y - hop - Math.ceil(personHeight(s, { role: u.role, pose }) / s)
    this.items.push({ x: u.x, y: top - Math.ceil(4 / s), text: ` ${gist(b.text, 32)} `, fg: C.ink, bg: BUBBLE[b.kind], prio: b.kind === 'status' ? 3 : 1, tail: u.x })
  }

  /** The sign over a working head: what it is doing, in a few words. */
  private statusOf(u: Unit): Bubble | null {
    if (u.status !== 'working' || (u.moving && !u.detail)) return null
    const what: Partial<Record<Doing, string>> = {
      build: u.detail || `building ${this.siteOf(u)?.name ?? ''}`,
      forge: u.detail || 'running commands',
      read: u.detail || 'reading',
      write: u.detail || 'writing',
      plan: 'planning the work',
      delegate: u.detail || 'handing out work',
      think: u.detail || 'thinking…',
    }
    const text = what[u.doing]
    if (!text) return null
    const icon = u.doing === 'build' || u.doing === 'write' ? '✎ ' : u.doing === 'forge' ? '▶ ' : u.doing === 'read' ? '≡ ' : u.doing === 'think' ? '… ' : ''
    return { text: icon + text, until: Infinity, kind: u.doing === 'think' ? 'think' : 'status' }
  }

  // ---- buildings

  /** How far a first build has come: quick at first, then slower, never quite done until it is. */
  private progress(b: Building, now: number) {
    return b.status === 'done' ? 1 : Math.min(0.97, 1 - Math.exp(-Math.max(0, now - b.at) / 110_000))
  }

  private drawBuilding(b: Building, s: Scale, anim: number, now: number, lit: boolean) {
    const p = b.pos
    if (!p) return
    const f = KINDS[b.kind]
    const merging = b.mergedAt && now - b.mergedAt < MERGE_MS ? now - b.mergedAt : -1
    const progress = merging >= 0 ? Math.min(1, merging / (MERGE_MS / 2)) : this.progress(b, now)
    const standing = b.level > 0 && merging < 0
    const fire = b.burnAt ? now - b.burnAt : -1
    const look = {
      kind: b.kind, color: b.color, level: b.level, progress: standing ? 1 : progress, building: (b.status === 'building' || (merging >= 0 && progress < 1)) && fire < 0,
      fire, anim, lit, style: hash(b.name.toLowerCase()), crop: b.crop,
    }
    ;(TOWN_KINDS.includes(b.kind) ? drawTown : drawWorks)(this.pen, s, Math.floor(p.x * s), Math.floor(p.y * s), look)
    // its name under it, and how it is going
    const stars = b.level > 1 ? ` ${'★'.repeat(Math.min(5, b.level))}` : ''
    const room = Math.max(10, Math.floor((f.w + 16) * s))
    const field = b.kind === 'field'
    const what = progress < 0.25 ? (field ? 'ploughing' : 'groundwork') : progress < 0.5 ? (field ? 'sowing' : 'framing') : progress < 0.75 ? (field ? 'growing' : 'going up') : field ? 'ripening' : 'finishing'
    const label =
      fire >= 0 ? (fire < 9000 ? `${b.name}: on fire!` : fire < 16_000 ? `${b.name}: gone` : 'Free land')
      : merging >= 0 ? `${b.name}: merged${stars}`
      : b.status === 'done' ? `${b.name}${stars}`
      : s === 1 ? (standing ? `${b.name}: improving` : `${b.name}: ${what}`) : b.name
    const fg = fire >= 0 ? 0xffb35c : b.status === 'done' ? 0xf4f1e8 : 0xf2d27a
    const y = p.y + f.h + 1
    this.items.push({ x: p.x + f.w / 2, y, text: ` ${gist(label, room)} `, fg, bg: fire >= 0 && fire < 9000 ? 0x4a1a10 : SIGN, prio: 2, down: true })
    if (b.status === 'building' && fire < 0) this.items.push({ x: p.x + f.w / 2, y: y + 2 / s, text: bar(progress, s === 1 ? 8 : 5), fg: 0xf2d27a, bg: LABEL, prio: 5, down: true })
  }

  // ---- the status bar

  private hud() {
    const crew = this.sessions
    const helpers = crew.reduce((a, s) => a + s.agents.length, 0)
    const bs = [...this.buildings.values()].filter(b => !b.burnAt)
    const built = bs.filter(b => b.status === 'done').length
    const going = bs.length - built
    const working = crew.filter(s => s.status === 'working').length
    const used = Math.max(-1, ...crew.map(s => s.five ?? -1))
    const heroes = crew.filter(s => !s.overseer)
    const boss = crew.some(s => s.overseer) ? ['◆ overseer at the castle'] : []
    const parts = this.crews.length > 1
      ? [`⚑ ${this.crews.length} crews: ${this.crews.map(c => c.name).join(', ')}`, `${heroes.length} at work, ${working} busy${helpers ? `, ${helpers} helper${helpers === 1 ? '' : 's'}` : ''}`, ...boss, `${built} built${going ? `, ${going} going up` : ''}`, ...(used >= 0 ? [`tokens ${Math.max(0, Math.round(100 - used))}% left`] : [])]
      : this.task
      ? [`⚑ ${this.task.name}`, `★ ${this.task.lead}`, ...boss, `${heroes.length} in crew, ${working} busy${helpers ? `, ${helpers} helper${helpers === 1 ? '' : 's'}` : ''}`, `${built} built${going ? `, ${going} going up` : ''}`, ...(used >= 0 ? [`tokens ${Math.max(0, Math.round(100 - used))}% left`] : [])]
      : boss.length ? [...boss, 'No crew at work: the overseer can start one.'] : ['No crew yet: start or join a task with /crew-task.']
    const tail = ` ${Math.round(this.zoom * 100)}% `
    const room = Math.max(0, this.cols - this.hudReserve - tail.length)
    // as many of the parts as fit, in order
    let line = ''
    for (const part of parts) {
      const next = line ? `${line}  │  ${part}` : ` ${part}`
      if ([...next].length > room) break
      line = next
    }
    line = [...line].slice(0, room).join('').padEnd(room) + tail + ' '.repeat(Math.max(0, this.cols - room - tail.length))
    this.hudCells = [...line].slice(0, this.cols).map((ch, x) => [safe(ch.codePointAt(0) ?? 32), x < 3 ? C.gold : x >= room && x < room + tail.length ? 0xffffff : HUD_TEXT, HUD])
  }

  // ---- cells

  /** The view: the status bar, then the drawn town from the camera, two pixels to a cell, the texts on top. */
  private encode() {
    const { cols, rows, zoom } = this
    const pen = this.pen
    const out = new Uint32Array(cols * rows * 3)
    for (let cx = 0; cx < cols; cx++) {
      const h = this.hudCells[cx] ?? [32, HUD_TEXT, HUD]
      out[cx * 3] = h[0]
      out[cx * 3 + 1] = h[1]
      out[cx * 3 + 2] = h[2]
    }
    const ox = Math.floor(this.camX * zoom)
    const oy = Math.floor(this.cam * zoom)
    const at = (x: number, y: number) => crisp(x >= 0 && y >= 0 && x < pen.w && y < pen.h ? (pen.px[y * pen.w + x] ?? C.grass) : C.grass)
    for (let cy = 1; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const k = (cy * cols + cx) * 3
        const top = at(ox + cx, oy + (cy - 1) * 2)
        const bottom = at(ox + cx, oy + (cy - 1) * 2 + 1)
        if (top === bottom) {
          out[k] = 0x20
          out[k + 1] = top
          out[k + 2] = top
        } else {
          // ▄, the bottom pixel drawn over the top one: where a font draws its blocks inside a box shorter than the
          // cell (as macOS Terminal does), the cell's background fills the gap above it, which is the top pixel's
          // own color; with ▀ the bottom color would show over the top pixel there, in thin stripes.
          out[k] = 0x2584
          out[k + 1] = bottom
          out[k + 2] = top
        }
      }
    }
    for (const t of this.placeTexts((x, y) => at(ox + x, oy + y))) {
      const k = (t.row * cols + t.col) * 3
      out[k] = t.cp
      out[k + 1] = t.fg
      out[k + 2] = t.bg
    }
    return toBase64(new Uint8Array(out.buffer))
  }

  /**
   * The texts as cells: each keeps its size and goes where its middle lands. Bubbles first, then names and
   * signs; one that would cover another moves a row (bubbles up, names down) or is left out. People out of
   * sight get a marker at the edge of the view, pointing their way.
   */
  private placeTexts(pixel: (x: number, y: number) => number) {
    const { cols, rows, zoom } = this
    const taken = new Uint8Array(cols * rows)
    const placed: { cp: number; fg: number; bg: number; row: number; col: number }[] = []
    const toRow = (y: number) => Math.floor(((y - this.cam) * zoom) / 2) + 1
    const toCol = (x: number) => Math.round((x - this.camX) * zoom)
    const fits = (row: number, col: number, n: number) => {
      if (row < 1 || row >= rows || col < 0 || col + n > cols) return false
      for (let i = -1; i <= n; i++) if (col + i >= 0 && col + i < cols && taken[row * cols + col + i]) return false
      return true
    }
    const put = (row: number, col: number, text: string, fg: number, bg: number) => {
      ;[...text].forEach((g, i) => {
        const c = col + i
        if (c < 0 || c >= cols) return
        taken[row * cols + c] = 1
        placed.push({ cp: safe(g.codePointAt(0) ?? 32), fg, bg, row, col: c })
      })
    }
    const edges: { row: number; col: number; text: string; fg: number }[] = []
    for (const u of this.units.values()) {
      if (u.kind !== 'hero') continue
      const r = toRow(u.y - 6)
      const c = toCol(u.x)
      if (r >= 1 && r < rows && c >= 0 && c < cols) continue
      const name = gist(u.name, 14)
      const text = c < 0 ? `◀ ${name}` : c >= cols ? `${name} ▶` : r < 1 ? `▲ ${name}` : `▼ ${name}`
      const n = [...text].length
      // clear of the buttons on the map's edges: the arrows at the sides and in the top and bottom rows
      const col = c < 0 ? 8 : c >= cols ? cols - 8 - n : clamp(c - Math.floor(n / 2), 8, cols - 8 - n)
      edges.push({ row: clamp(r, 4, rows - 4), col, text, fg: blend(u.color, 0xffffff, 0.35) })
    }
    for (const it of [...this.items].sort((a, b) => a.prio - b.prio)) {
      const n = [...it.text].length
      const mid = toCol(it.x)
      // a text whose thing is out of sight stays out of sight; one half in view is nudged in
      if (n > cols || mid < 0 || mid >= cols) continue
      const col = clamp(mid - Math.floor(n / 2), 0, cols - n)
      const row0 = toRow(it.y)
      if (row0 < 1 || row0 >= rows) continue
      const tries = it.tail !== undefined ? [row0, row0 - 1, row0 - 2] : it.down ? [row0, row0 + 1, row0 - 1] : [row0, row0 - 1, row0 + 1]
      const row = tries.find(r => fits(r, col, n))
      if (row === undefined) continue
      put(row, col, it.text, it.fg, it.bg)
      if (it.tail !== undefined && row + 1 < rows) {
        const tc = clamp(toCol(it.tail), col + 1, col + n - 2)
        if (!taken[(row + 1) * cols + tc]) {
          taken[(row + 1) * cols + tc] = 1
          placed.push({ cp: 0x25bc, fg: it.bg, bg: pixel(tc, row * 2 + 1), row: row + 1, col: tc })
        }
      }
    }
    for (const e of edges) {
      const n = [...e.text].length
      const row = [e.row, e.row + 1, e.row - 1, e.row + 2, e.row - 2].find(r => fits(r, e.col, n))
      if (row !== undefined) put(row, e.col, e.text, e.fg, LABEL)
    }
    return placed
  }
}

// ---- helpers

/**
 * A color as terminals show it: 4 bits a channel (steps of 17). Snapping here keeps two shades that would show the
 * same from making a cell of two colors that look alike, and makes every preview exactly what the person sees.
 */
const crispCache = new Map<number, number>()
function crisp(c: number) {
  let v = crispCache.get(c)
  if (v === undefined) {
    const q = (sh: number) => Math.round(((c >> sh) & 255) / 17) * 17
    crispCache.set(c, (v = (q(16) << 16) | (q(8) << 8) | q(0)))
  }
  return v
}

/** Bars for a building going up. */
const bar = (p: number, n: number) => {
  const k = Math.round(p * n)
  return '▰'.repeat(k) + '▱'.repeat(n - k) + ` ${Math.round(p * 100)}%`
}

/** One cell: a code point the terminal draws one column wide, else a question mark. */
function safe(cp: number) {
  if (cp >= 0x20 && cp < 0x7f) return cp
  if (cp >= 0xa0 && cp <= 0x24f) return cp // Latin, accents, æøå
  if (cp >= 0x370 && cp <= 0x4ff) return cp // Greek, Cyrillic
  if (cp >= 0x2010 && cp <= 0x2027) return cp // dashes, quotes, …
  if (cp >= 0x2190 && cp <= 0x21ff) return cp // arrows
  if (cp >= 0x2500 && cp <= 0x25ff && cp !== 0x25fd && cp !== 0x25fe) return cp // boxes, blocks, shapes
  if (cp === 0x2605 || cp === 0x2606 || cp === 0x270e || cp === 0x2691 || cp === 0x2302 || cp === 0x2261 || cp === 0x2713) return cp
  return 0x3f
}

/** 0 by day, up to 0.45 deep in the night, by the person's own clock: dusk, not darkness. */
function nightness(now: number) {
  const d = new Date(now)
  const h = d.getHours() + d.getMinutes() / 60
  if (h >= 7 && h < 18) return 0
  if (h >= 18 && h < 21) return ((h - 18) / 3) * 0.45
  if (h >= 5 && h < 7) return ((7 - h) / 2) * 0.45
  return 0.45
}

function blankUnit(kind: Unit['kind'], id: string, owner: string, at: Spot): Unit {
  return {
    kind, id, owner, name: '', color: 0xffffff, role: 'worker', hair: C.hairs[0], x: at.x, y: at.y, path: [], facing: 1, moving: false, run: false,
    bubble: null, status: 'idle', tool: '', detail: '', lastPrompt: '', attention: false, talkTo: '', talkAt: 0, doing: 'idle', since: 0,
    spot: null, face: 0, idle: 'gather', idleUntil: 0, nextTalk: 0, lastPost: 0, isLead: false, desc: '', phase: 'out', until: 0, carrying: '',
    crew: '', overseer: false, coat: 0xffffff,
  }
}

/** Along the path, a waypoint at a time. */
function walk(u: Unit, dt: number, speed: number) {
  const to = u.path[0]
  if (!to) {
    u.moving = false
    return
  }
  const dx = to.x - u.x
  const dy = to.y - u.y
  const dist = Math.hypot(dx, dy)
  if (dist < 0.5) {
    u.x = to.x
    u.y = to.y
    u.path.shift()
    u.moving = u.path.length > 0
    return
  }
  u.moving = true
  if (Math.abs(dx) > 0.3) u.facing = dx > 0 ? 1 : -1
  const k = Math.min(1, (speed * dt) / 1000 / dist)
  u.x += dx * k
  u.y += dy * k
}

const overlaps = (x: number, y: number, w: number, h: number, X: number, Y: number, Wd: number, Hd: number) =>
  x < X + Wd && x + w > X && y < Y + Hd && y + h > Y

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m })
const hit = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const footprint = (b: Building): Box => (b.pos ? { x: b.pos.x, y: b.pos.y, w: KINDS[b.kind].w, h: KINDS[b.kind].h } : { x: -1000, y: -1000, w: 0, h: 0 })

/** Offsets from an anchor, nearest first, in steps of 6: where a new thing looks for room. */
const RINGS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = []
  for (let y = -420; y <= 420; y += 6) for (let x = -540; x <= 540; x += 6) out.push([x, y])
  return out.sort((a, b) => Math.hypot(a[0], a[1] * 1.3) - Math.hypot(b[0], b[1] * 1.3))
})()
