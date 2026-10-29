export type CrewMe = {
  id: string
  codename: string
  name: string
  colorName: string
  color: string
  tty: string | null
  term: string
  profile: string | null
  ackedAt: number
}

export type CrewUsage = {
  ctx?: number
  ctxTokens?: number
  ctxWindow?: number
  five?: number
  fiveResetsAt?: string
  week?: number
  weekResetsAt?: string
  cost?: number
}

export type CrewAttention = {
  pingId: string
  fromName: string
  fromColor: string
  reason: string
  at: number
}

export type CrewPeerRow = {
  id: string
  name: string
  color: string
  status: string
  project: string
  activity: string
  task: string
  ctx: number | null
  isMe: boolean
}

export type TownSelection = { id: string; name: string; typing: boolean }

export type CrewBoard = {
  /** pick: setting up a task to start; manage: the strategies; crew: adding to the running task's crew. */
  mode: 'pick' | 'manage' | 'crew'
  /** The strategy the list shows. */
  index: number
  v: number
  view?: 'menu' | 'resume' | 'resumeone' | 'tabs' | 'stop' | 'name' | 'goal' | 'list' | 'create' | 'busy' | 'chosen' | 'change' | 'changed' | 'confirm' | 'launch' | 'crew' | 'edit' | 'delete'
  /** In the list: the row in focus that is no strategy (create one, or none), shown beside it instead of a drawing. */
  hover?: 'new' | 'none' | null
  /** In the editor: the role being changed, and what is being typed. */
  role?: string | null
  typing?: 'duty' | 'role' | 'name' | 'task' | null
  note?: string
}

export type CrewTaskRef = { id: string; name: string; role: string; isLead: boolean }

declare module 'claude-code' {
  interface PluginState {
    crewser: {
      me: CrewMe | null
      usage: CrewUsage
      attention: CrewAttention | null
      pulse: number
      peers: CrewPeerRow[]
      task: CrewTaskRef | null
      board: CrewBoard
      selected: TownSelection | null
      /** Bumped by the overseer's heartbeat: the Overview pane redraws. */
      overview: number
    }
  }
}
