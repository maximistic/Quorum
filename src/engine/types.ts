export type Role = 'follower' | 'candidate' | 'leader'

export interface Entry {
  term: number
  command: string
  /** Unique per client command, so safety checks can tell two entries apart even if term matches. */
  id: number
}

export interface RequestVote {
  type: 'RequestVote'
  term: number
  candidateId: number
  lastLogIndex: number
  lastLogTerm: number
}
export interface RequestVoteReply {
  type: 'RequestVoteReply'
  term: number
  voteGranted: boolean
}
export interface AppendEntries {
  type: 'AppendEntries'
  term: number
  leaderId: number
  prevLogIndex: number
  prevLogTerm: number
  entries: Entry[]
  leaderCommit: number
}
export interface AppendEntriesReply {
  type: 'AppendEntriesReply'
  term: number
  success: boolean
  matchIndex: number
}
export type Rpc = RequestVote | RequestVoteReply | AppendEntries | AppendEntriesReply

export interface Message {
  id: number
  from: number
  to: number
  sentAt: number
  deliverAt: number
  rpc: Rpc
  /** Decided at send time so the animation can show where a message dies. */
  fate: 'ok' | 'lost' | 'blocked'
}

export interface NodeState {
  id: number
  alive: boolean
  role: Role
  // persistent state (survives crashes)
  term: number
  votedFor: number | null
  log: Entry[] // log[0] is index 1
  // volatile state
  commitIndex: number
  lastApplied: number
  kv: Record<string, string>
  leaderId: number | null
  votes: number[]
  nextIndex: number[]
  matchIndex: number[]
  electionDeadline: number
  electionResetAt: number
  nextHeartbeat: number
}

export type Level = 'info' | 'good' | 'warn' | 'danger' | 'key'

export interface SimEvent {
  id: number
  t: number
  node: number | null
  level: Level
  text: string
  note?: string
}

export type RuleId = 'election-safety' | 'log-matching' | 'leader-completeness' | 'state-machine-safety'

export interface Violation {
  t: number
  rule: RuleId
  detail: string
}

export interface TraceSeg {
  t: number
  code: 'F' | 'C' | 'L' | 'X'
}

export interface Sabotage {
  /** Voters ignore the "candidate's log must be up to date" rule. */
  skipLogCheck: boolean
  /** Leaders commit once only a minority has the entry. */
  minorityCommit: boolean
  /** Voters may vote for several candidates in one term. */
  doubleVote: boolean
}

export interface Config {
  electionMin: number
  electionMax: number
  heartbeat: number
  latencyMin: number
  latencyMax: number
  dropRate: number
  maxBatch: number
  sabotage: Sabotage
}

export interface Stats {
  sent: number
  dropped: number
  elections: number
  leaders: number
  commits: number
}

export interface ClusterState {
  now: number
  rng: number
  seed: number
  size: number
  config: Config
  nodes: NodeState[]
  messages: Message[]
  nextMsgId: number
  nextEntryId: number
  nextEventId: number
  partition: number[][] | null
  events: SimEvent[]
  /** Canonical record of every entry any node has ever committed, by index. */
  committed: Entry[]
  leadersByTerm: Record<number, number>
  violations: Violation[]
  trace: TraceSeg[][]
  partitionTrace: { start: number; end: number | null }[]
  stats: Stats
}
