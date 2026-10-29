// What a feature is shown as. Every feature the crew builds becomes one kind of thing in the town: a small
// house for a small feature, a farm for a big area of work whose parts are its fields, a dock for an
// integration, a statue for a milestone... The session's model picks the kind when it records the feature
// (mcp__crewser__feature); `guessKind` reads one from the name when it did not.
//
// Every size here is close-up (s = 1) in town pixels; the overview (s = 0.5) halves it. A thing is drawn in its
// footprint, (x, y) its top-left: nothing but smoke, flames and sails leaves it. Under the footprint the engine
// keeps two rows for the name, and a path starts from the middle of its bottom edge (its door). The builder stands
// just right of the footprint, feet on its bottom row; helpers drop their loads just left of it.
import type { Pen, Scale } from './kit'

export type Kind =
  | 'house' | 'townhouse' | 'shop' | 'tavern' | 'hall' | 'school' | 'library' | 'workshop' | 'tower' | 'statue' | 'garden' | 'observatory'
  | 'blacksmith' | 'sawmill' | 'warehouse' | 'windmill' | 'farm' | 'field' | 'dock' | 'harbor' | 'lighthouse'

export type Crop = 'wheat' | 'corn' | 'cabbage' | 'pumpkin' | 'carrots' | 'sunflowers' | 'grapes' | 'flowers'

/** Where a kind likes to stand: near the town square, out in the meadows (farm land), on the lake shore, by the woods, up on the hills. */
export type Zone = 'town' | 'square' | 'farm' | 'water' | 'forest' | 'hill'

export type KindInfo = { w: number; h: number; zone: Zone; about: string }

/**
 * Every kind: its footprint close-up, where it stands, and what it is for (the model reads `about` to choose).
 * Water kinds stand on the lake shore: the shore runs across their footprint at about a third of its height,
 * land above, water below (the engine places them so).
 */
export const KINDS: Record<Kind, KindInfo> = {
  house: { w: 26, h: 28, zone: 'town', about: 'a small feature or a fix' },
  townhouse: { w: 30, h: 34, zone: 'town', about: 'a larger feature' },
  shop: { w: 28, h: 28, zone: 'town', about: 'something users see or buy: a page, a screen, checkout, a store' },
  tavern: { w: 32, h: 30, zone: 'town', about: 'chat, messaging, comments, social features' },
  hall: { w: 40, h: 36, zone: 'town', about: 'admin, settings, accounts, governance: the town hall' },
  school: { w: 34, h: 30, zone: 'town', about: 'onboarding, tutorials, help' },
  library: { w: 32, h: 30, zone: 'town', about: 'docs, search, knowledge' },
  workshop: { w: 30, h: 28, zone: 'town', about: 'tooling, build scripts, developer experience, tests' },
  tower: { w: 16, h: 38, zone: 'town', about: 'security, auth, permissions, monitoring: a watchtower' },
  statue: { w: 14, h: 22, zone: 'square', about: 'a milestone, a release, something to celebrate' },
  garden: { w: 32, h: 24, zone: 'town', about: 'polish, design, UX niceties, cleanup' },
  observatory: { w: 26, h: 34, zone: 'hill', about: 'analytics, metrics, dashboards, insight' },
  blacksmith: { w: 30, h: 28, zone: 'town', about: 'core logic, refactoring, performance: things forged' },
  sawmill: { w: 40, h: 30, zone: 'forest', about: 'data processing: pipelines, imports, exports, transforms' },
  warehouse: { w: 38, h: 28, zone: 'town', about: 'storage, databases, caching, files' },
  windmill: { w: 26, h: 44, zone: 'farm', about: 'background jobs, workers, queues, schedulers' },
  farm: { w: 46, h: 32, zone: 'farm', about: 'a big area of work made of several parts: give its parts the kind "field"' },
  field: { w: 40, h: 28, zone: 'farm', about: 'a part of a farm (set parent to the farm): one crop per part' },
  dock: { w: 30, h: 22, zone: 'water', about: 'an integration with one outside service, an API client, a webhook' },
  harbor: { w: 56, h: 32, zone: 'water', about: 'a big integration hub, an API gateway, import/export with many services' },
  lighthouse: { w: 18, h: 44, zone: 'water', about: 'notifications, alerts, status and uptime' },
}

export const KIND_NAMES = Object.keys(KINDS) as Kind[]
export const CROPS: readonly Crop[] = ['wheat', 'corn', 'cabbage', 'pumpkin', 'carrots', 'sunflowers', 'grapes', 'flowers']

/** How a built thing looks right now. */
export type BuildLook = {
  kind: Kind
  /** The builder's session color: roofs, flags, awnings, banners, sails. */
  color: number
  /** 0 while first being built; 1 finished; 2..5 improved, each level adding something you can see from afar. */
  level: number
  /** 0..1 across the first build: each kind shows its own stages (footings, frame, walls, roof; or plough, sprouts, crop). */
  progress: number
  /** Work going on (a first build, or a finished thing being improved): scaffolding, materials. */
  building: boolean
  /** Milliseconds since it caught fire, or -1: burning to 9000, then ruins whose smoke thins out by 26000. */
  fire: number
  /** Frame counter, four a second. */
  anim: number
  /** Evening: windows and lamps glow (`pen.glow`). */
  lit: boolean
  /** Variation within the kind, from the name (any non-negative integer; take it modulo your own count). */
  style: number
  /** Fields: what grows. */
  crop?: Crop
}

/** A kind read from a feature's name, for features recorded without one. */
export function guessKind(name: string, parent?: string): { kind: Kind; crop?: Crop } {
  const n = name.toLowerCase()
  const crop = CROPS.find(c => n.includes(c.replace(/s$/, '')))
  if (parent && /farm/i.test(parent)) return { kind: 'field', crop: crop ?? CROPS[hashOf(n) % CROPS.length] }
  const rules: [RegExp, Kind][] = [
    [/farm/, 'farm'], [/field|crop|wheat|corn|harvest/, 'field'], [/windmill|mill\b|queue|job|worker|cron|schedul|background/, 'windmill'],
    [/harbou?r|gateway|hub/, 'harbor'], [/dock|integrat|webhook|api client|sdk|connector|sync/, 'dock'], [/lighthouse|notif|alert|status|uptime|email|push/, 'lighthouse'],
    [/statue|release|launch|milestone|v\d/, 'statue'], [/garden|polish|cleanup|theme|style|design/, 'garden'], [/observ|analytic|metric|dashboard|insight|report|chart/, 'observatory'],
    [/sawmill|pipeline|import|export|etl|transform|parse|migrat/, 'sawmill'], [/warehouse|database|\bdb\b|storage|cache|store|upload|file/, 'warehouse'],
    [/smith|forge|refactor|perf|core|engine|optimi/, 'blacksmith'], [/tower|auth|login|security|permission|role|guard|monitor/, 'tower'],
    [/hall|admin|setting|account|billing|config/, 'hall'], [/school|onboard|tutorial|help|guide/, 'school'], [/library|doc|search|wiki|knowledge/, 'library'],
    [/tavern|chat|message|comment|social|forum/, 'tavern'], [/workshop|tool|build|ci\b|test|lint|dev/, 'workshop'],
    [/shop|store|checkout|cart|page|screen|view|ui\b|landing|payment/, 'shop'],
  ]
  for (const [re, kind] of rules) if (re.test(n)) return kind === 'field' ? { kind, crop: crop ?? 'wheat' } : { kind }
  return { kind: hashOf(n) % 3 === 0 ? 'townhouse' : 'house' }
}

function hashOf(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Kinds drawn by buildings.ts; the rest by works.ts. */
export const TOWN_KINDS: readonly Kind[] = ['house', 'townhouse', 'shop', 'tavern', 'hall', 'school', 'library', 'workshop', 'tower', 'statue', 'garden', 'observatory']
export const WORK_KINDS: readonly Kind[] = ['blacksmith', 'sawmill', 'warehouse', 'windmill', 'farm', 'field', 'dock', 'harbor', 'lighthouse']

export type Draw = (pen: Pen, s: Scale, x: number, y: number, look: BuildLook) => void
