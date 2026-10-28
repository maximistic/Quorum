import type {
  AppendEntries,
  AppendEntriesReply,
  ClusterState,
  Config,
  Level,
  Message,
  NodeState,
  RequestVote,
  RequestVoteReply,
  Role,
  Rpc,
  RuleId,
} from './types'
import { cmdLabel, nextRandom, nodeName as S } from './util'

/** Simulation tick, in simulated milliseconds. */
export const STEP = 10
const SNAP_EVERY = 500
const MAX_HISTORY = 700
const MAX_EVENTS = 250

export const DEFAULT_CONFIG: Config = {
  electionMin: 1500,
  electionMax: 3000,
  heartbeat: 500,
  latencyMin: 200,
  latencyMax: 400,
  dropRate: 0,
  maxBatch: 2,
  sabotage: { skipLogCheck: false, minorityCommit: false, doubleVote: false },
}

export const RULES: Record<RuleId, { title: string; desc: string }> = {
  'election-safety': {
    title: 'Election Safety',
    desc: 'At most one leader can be elected in any given term.',
  },
  'log-matching': {
    title: 'Log Matching',
    desc: 'If two logs hold an entry with the same index and term, the logs are identical up to that index.',
  },
  'leader-completeness': {
    title: 'Leader Completeness',
    desc: 'A newly elected leader’s log contains every entry that was ever committed.',
  },
  'state-machine-safety': {
    title: 'State Machine Safety',
    desc: 'No two nodes ever apply different commands at the same log index.',
  },
}

export const majority = (n: number) => Math.floor(n / 2) + 1

export function canReach(s: { partition: number[][] | null }, a: number, b: number): boolean {
  if (a === b || !s.partition) return true
  const g = s.partition.find((grp) => grp.includes(a))
  return !!g && g.includes(b)
}

export function groupOf(s: { partition: number[][] | null }, id: number): number {
  return s.partition ? s.partition.findIndex((g) => g.includes(id)) : -1
}

const roleCode = (n: NodeState) => (!n.alive ? 'X' : n.role === 'leader' ? 'L' : n.role === 'candidate' ? 'C' : 'F')
const termAt = (n: NodeState, idx: number) => (idx === 0 ? 0 : n.log[idx - 1]?.term ?? 0)

export interface ClusterOptions {
  seed: number
  size: number
  config?: Partial<Config>
  /** Keep snapshots for time travel. Off for fuzzing. */
  history?: boolean
}

export class Cluster {
  state!: ClusterState
  history: ClusterState[] = []
  cursor = -1
  private recordHistory: boolean

  constructor(opts: ClusterOptions) {
    this.recordHistory = opts.history ?? true
    this.reset(opts)
  }

  reset(opts: Omit<ClusterOptions, 'history'>) {
    const config: Config = {
      ...DEFAULT_CONFIG,
      ...opts.config,
      sabotage: { ...DEFAULT_CONFIG.sabotage, ...opts.config?.sabotage },
    }
    const s: ClusterState = {
      now: 0,
      rng: opts.seed | 0,
      seed: opts.seed,
      size: opts.size,
      config,
      nodes: [],
      messages: [],
      nextMsgId: 1,
      nextEntryId: 1,
      nextEventId: 1,
      partition: null,
      events: [],
      committed: [],
      leadersByTerm: {},
      violations: [],
      trace: [],
      partitionTrace: [],
      stats: { sent: 0, dropped: 0, elections: 0, leaders: 0, commits: 0 },
    }
    this.state = s
    for (let i = 0; i < opts.size; i++) {
      const n: NodeState = {
        id: i,
        alive: true,
        role: 'follower',
        term: 0,
        votedFor: null,
        log: [],
        commitIndex: 0,
        lastApplied: 0,
        kv: {},
        leaderId: null,
        votes: [],
        nextIndex: [],
        matchIndex: [],
        electionDeadline: 0,
        electionResetAt: 0,
        nextHeartbeat: 0,
      }
      s.nodes.push(n)
      s.trace.push([{ t: 0, code: 'F' }])
      this.resetElection(n)
    }
    this.history = []
    this.cursor = -1
    this.pushSnapshot()
    this.emit('info', null, `Cluster of ${opts.size} nodes started (seed ${opts.seed}).`, 'Every node boots as a follower with its own randomized election timer.')
  }

  // ───────────────────────────── time travel ─────────────────────────────

  private pushSnapshot() {
    if (!this.recordHistory) return
    this.history.push(structuredClone(this.state))
    if (this.history.length > MAX_HISTORY) this.history.shift()
    this.cursor = this.history.length - 1
  }

  get isLive() {
    return this.cursor === this.history.length - 1
  }

  seek(i: number) {
    const idx = Math.max(0, Math.min(this.history.length - 1, i))
    this.state = structuredClone(this.history[idx])
    this.cursor = idx
  }

  /** Mutating from the past discards the future: this is the branch point. */
  private branch() {
    if (this.cursor < this.history.length - 1) this.history.length = this.cursor + 1
  }

  // ───────────────────────────── simulation loop ─────────────────────────────

  step() {
    this.branch()
    const s = this.state
    s.now += STEP
    this.deliverDue()
    for (const n of s.nodes) {
      if (!n.alive) continue
      if (n.role === 'leader') {
        if (s.now >= n.nextHeartbeat) {
          n.nextHeartbeat = s.now + s.config.heartbeat
          for (const p of s.nodes) if (p.id !== n.id) this.sendAppend(n, p.id)
        }
      } else if (s.now >= n.electionDeadline) {
        this.startElection(n)
      }
    }
    for (const n of s.nodes) this.applyCommitted(n)
    this.checkInvariants()
    if (s.now % SNAP_EVERY === 0) this.pushSnapshot()
  }

  advance(ms: number) {
    for (let t = 0; t < ms; t += STEP) this.step()
  }

  private rand() {
    return nextRandom(this.state)
  }

  private emit(level: Level, node: number | null, text: string, note?: string) {
    const s = this.state
    s.events.push({ id: s.nextEventId++, t: s.now, node, level, text, note })
    if (s.events.length > MAX_EVENTS) s.events.shift()
  }

  private setRole(n: NodeState, role: Role) {
    n.role = role
    this.updateTrace(n)
  }

  private updateTrace(n: NodeState) {
    const tr = this.state.trace[n.id]
    const code = roleCode(n)
    if (tr[tr.length - 1].code !== code) tr.push({ t: this.state.now, code })
  }

  private resetElection(n: NodeState) {
    const { electionMin, electionMax } = this.state.config
    n.electionResetAt = this.state.now
    n.electionDeadline = this.state.now + electionMin + this.rand() * (electionMax - electionMin)
  }

  // ───────────────────────────── network ─────────────────────────────

  private send(from: number, to: number, rpc: Rpc) {
    const s = this.state
    const { latencyMin, latencyMax, dropRate } = s.config
    const lat = latencyMin + this.rand() * (latencyMax - latencyMin)
    const roll = this.rand()
    const fate: Message['fate'] = !canReach(s, from, to) ? 'blocked' : roll < dropRate ? 'lost' : 'ok'
    s.stats.sent++
    s.messages.push({ id: s.nextMsgId++, from, to, sentAt: s.now, deliverAt: s.now + lat, rpc, fate })
  }

  private deliverDue() {
    const s = this.state
    const due = s.messages.filter((m) => m.deliverAt <= s.now).sort((a, b) => a.deliverAt - b.deliverAt || a.id - b.id)
    if (!due.length) return
    s.messages = s.messages.filter((m) => m.deliverAt > s.now)
    for (const m of due) {
      const target = s.nodes[m.to]
      if (m.fate !== 'ok' || !canReach(s, m.from, m.to) || !target.alive) {
        s.stats.dropped++
        continue
      }
      this.handle(target, m)
    }
  }

  private handle(n: NodeState, m: Message) {
    const rpc = m.rpc
    if (rpc.term > n.term) this.stepDown(n, rpc.term)
    switch (rpc.type) {
      case 'RequestVote':
        return this.onRequestVote(n, m.from, rpc)
      case 'RequestVoteReply':
        return this.onVoteReply(n, m.from, rpc)
      case 'AppendEntries':
        return this.onAppendEntries(n, m.from, rpc)
      case 'AppendEntriesReply':
        return this.onAppendReply(n, m.from, rpc)
    }
  }

  private stepDown(n: NodeState, term: number) {
    const was = n.role
    n.term = term
    n.votedFor = null
    if (was !== 'follower') {
      this.setRole(n, 'follower')
      this.resetElection(n)
      this.emit('warn', n.id, `${S(n.id)} steps down to follower (saw term ${term}).`, 'Any message carrying a higher term makes a node immediately defer: a newer term means a newer leader exists.')
    }
  }

  // ───────────────────────────── elections ─────────────────────────────

  private startElection(n: NodeState) {
    const s = this.state
    n.term++
    n.votedFor = n.id
    n.votes = [n.id]
    this.setRole(n, 'candidate')
    this.resetElection(n)
    s.stats.elections++
    this.emit('key', n.id, `${S(n.id)} hears no leader and starts an election for term ${n.term}.`, 'Its randomized election timeout expired without a heartbeat. It votes for itself and asks everyone else.')
    const last = n.log.length
    for (const p of s.nodes) {
      if (p.id === n.id) continue
      this.send(n.id, p.id, { type: 'RequestVote', term: n.term, candidateId: n.id, lastLogIndex: last, lastLogTerm: termAt(n, last) })
    }
  }

  private onRequestVote(n: NodeState, from: number, rpc: RequestVote) {
    const sab = this.state.config.sabotage
    let grant = false
    let why = ''
    if (rpc.term >= n.term) {
      const canVote = sab.doubleVote || n.votedFor === null || n.votedFor === rpc.candidateId
      const myLast = n.log.length
      const myLastTerm = termAt(n, myLast)
      const upToDate = sab.skipLogCheck || rpc.lastLogTerm > myLastTerm || (rpc.lastLogTerm === myLastTerm && rpc.lastLogIndex >= myLast)
      grant = canVote && upToDate
      if (!canVote) why = `it already voted for ${S(n.votedFor!)} in term ${n.term}`
      else if (!upToDate) why = 'its own log is more up to date than the candidate’s'
    } else why = `the candidate’s term ${rpc.term} is stale`
    if (grant) {
      n.votedFor = rpc.candidateId
      this.resetElection(n)
      this.emit('info', n.id, `${S(n.id)} votes for ${S(from)} in term ${rpc.term}.`)
    } else {
      this.emit('info', n.id, `${S(n.id)} refuses to vote for ${S(from)} in term ${rpc.term}.`, `Because ${why}.`)
    }
    this.send(n.id, from, { type: 'RequestVoteReply', term: n.term, voteGranted: grant })
  }

  private onVoteReply(n: NodeState, from: number, rpc: RequestVoteReply) {
    if (n.role !== 'candidate' || rpc.term !== n.term || !rpc.voteGranted || n.votes.includes(from)) return
    n.votes.push(from)
    if (n.votes.length >= majority(this.state.size)) this.becomeLeader(n)
  }

  private becomeLeader(n: NodeState) {
    const s = this.state
    const prior = s.leadersByTerm[n.term]
    if (prior !== undefined && prior !== n.id) {
      this.violate('election-safety', `Term ${n.term} elected both ${S(prior)} and ${S(n.id)}.`)
    }
    s.leadersByTerm[n.term] = n.id
    for (let i = 0; i < s.committed.length; i++) {
      const e = n.log[i]
      if (!e || e.id !== s.committed[i].id) {
        this.violate(
          'leader-completeness',
          `${S(n.id)} became leader of term ${n.term} but its log ${e ? `disagrees at` : `is missing`} committed index ${i + 1}.`,
        )
        break
      }
    }
    this.setRole(n, 'leader')
    n.leaderId = n.id
    n.nextIndex = s.nodes.map(() => n.log.length + 1)
    n.matchIndex = s.nodes.map(() => 0)
    s.stats.leaders++
    this.emit('good', n.id, `${S(n.id)} wins term ${n.term} with ${n.votes.length}/${s.size} votes and becomes leader.`, `A majority (${majority(s.size)} of ${s.size}) agreed. Two majorities always overlap, so no other leader can win this term.`)
    // A fresh leader commits a no-op so entries from earlier terms can be committed safely (Raft §5.4.2).
    n.log.push({ term: n.term, command: 'no-op', id: s.nextEntryId++ })
    n.nextHeartbeat = s.now + s.config.heartbeat
    for (const p of s.nodes) if (p.id !== n.id) this.sendAppend(n, p.id)
  }

  // ───────────────────────────── replication ─────────────────────────────

  private sendAppend(n: NodeState, to: number) {
    const next = Math.max(1, n.nextIndex[to] ?? n.log.length + 1)
    const prev = next - 1
    this.send(n.id, to, {
      type: 'AppendEntries',
      term: n.term,
      leaderId: n.id,
      prevLogIndex: prev,
      prevLogTerm: termAt(n, prev),
      entries: n.log.slice(prev, prev + this.state.config.maxBatch),
      leaderCommit: n.commitIndex,
    })
  }

  private onAppendEntries(n: NodeState, from: number, rpc: AppendEntries) {
    const reply = (success: boolean, matchIndex: number) =>
      this.send(n.id, from, { type: 'AppendEntriesReply', term: n.term, success, matchIndex })
    if (rpc.term < n.term) return reply(false, 0)
    if (n.role !== 'follower') {
      this.setRole(n, 'follower')
      this.emit('warn', n.id, `${S(n.id)} recognizes ${S(from)} as leader of term ${rpc.term} and reverts to follower.`)
    }
    n.leaderId = rpc.leaderId
    this.resetElection(n)
    const prev = rpc.prevLogIndex
    if (prev > n.log.length || termAt(n, prev) !== rpc.prevLogTerm) return reply(false, 0)
    let idx = prev
    for (const e of rpc.entries) {
      idx++
      const existing = n.log[idx - 1]
      if (existing && existing.term !== e.term) {
        const dropped = n.log.length - (idx - 1)
        n.log.length = idx - 1
        this.emit('warn', n.id, `${S(n.id)} discards ${dropped} conflicting entr${dropped === 1 ? 'y' : 'ies'} from index ${idx}.`, 'The leader’s log is the truth. Entries that were never committed on a majority can be safely overwritten.')
      }
      if (!n.log[idx - 1]) n.log.push({ ...e })
    }
    if (rpc.leaderCommit > n.commitIndex) n.commitIndex = Math.min(rpc.leaderCommit, prev + rpc.entries.length)
    reply(true, prev + rpc.entries.length)
  }

  private onAppendReply(n: NodeState, from: number, rpc: AppendEntriesReply) {
    if (n.role !== 'leader' || rpc.term !== n.term) return
    if (rpc.success) {
      n.matchIndex[from] = Math.max(n.matchIndex[from], rpc.matchIndex)
      n.nextIndex[from] = n.matchIndex[from] + 1
      this.advanceCommit(n)
      if (n.nextIndex[from] <= n.log.length) this.sendAppend(n, from)
    } else {
      n.nextIndex[from] = Math.max(1, n.nextIndex[from] - 1)
      this.sendAppend(n, from)
    }
  }

  private advanceCommit(n: NodeState) {
    const s = this.state
    const need = s.config.sabotage.minorityCommit ? Math.floor(s.size / 2) : majority(s.size)
    for (let N = n.log.length; N > n.commitIndex; N--) {
      if (n.log[N - 1].term !== n.term) continue
      let count = 1
      for (const p of s.nodes) if (p.id !== n.id && n.matchIndex[p.id] >= N) count++
      if (count >= need) {
        const e = n.log[N - 1]
        s.stats.commits += N - n.commitIndex
        n.commitIndex = N
        if (e.command !== 'no-op') {
          this.emit('good', n.id, `Entry ${N} (${cmdLabel(e)}) is committed.`, `Stored on ${count} of ${s.size} nodes — a majority — so it can never be lost. The leader now tells followers to apply it.`)
        }
        break
      }
    }
  }

  private applyCommitted(n: NodeState) {
    while (n.lastApplied < n.commitIndex && n.lastApplied < n.log.length) {
      const e = n.log[n.lastApplied++]
      const m = /^SET (\S+)=(.*)$/.exec(e.command)
      if (m) n.kv[m[1]] = m[2]
    }
  }

  // ───────────────────────────── client & chaos API ─────────────────────────────

  leader(): NodeState | null {
    let best: NodeState | null = null
    for (const n of this.state.nodes) if (n.alive && n.role === 'leader' && (!best || n.term > best.term)) best = n
    return best
  }

  submit(command: string, target?: number): { ok: boolean; reason?: string } {
    this.branch()
    const s = this.state
    const n = target !== undefined ? s.nodes[target] : this.leader()
    let result: { ok: boolean; reason?: string }
    if (!n) {
      this.emit('warn', null, `Client write "${command}" failed: no leader is known.`, 'Clients can only write through a leader. Until an election finishes the cluster is unavailable for writes.')
      result = { ok: false, reason: 'no leader' }
    } else if (!n.alive) {
      result = { ok: false, reason: `${S(n.id)} is down` }
    } else if (n.role !== 'leader') {
      this.emit('warn', n.id, `${S(n.id)} rejects write "${command}": not the leader.`, n.leaderId !== null ? `A real client would be redirected to ${S(n.leaderId)}.` : 'It does not know who the leader is.')
      result = { ok: false, reason: 'not leader' }
    } else {
      n.log.push({ term: n.term, command, id: s.nextEntryId++ })
      this.emit('info', n.id, `${S(n.id)} appends "${command}" at index ${n.log.length} (uncommitted).`, 'Not durable yet: it only counts once a majority of nodes have stored it.')
      for (const p of s.nodes) if (p.id !== n.id) this.sendAppend(n, p.id)
      result = { ok: true }
    }
    this.pushSnapshot()
    return result
  }

  crash(id: number) {
    this.branch()
    const n = this.state.nodes[id]
    if (!n.alive) return
    n.alive = false
    this.updateTrace(n)
    this.emit('danger', id, `${S(id)} crashes.`, 'It keeps its term, vote and log on disk but loses all in-memory state.')
    this.pushSnapshot()
  }

  restart(id: number) {
    this.branch()
    const n = this.state.nodes[id]
    if (n.alive) return
    n.alive = true
    n.role = 'follower'
    n.commitIndex = 0
    n.lastApplied = 0
    n.kv = {}
    n.votes = []
    n.leaderId = null
    n.nextIndex = []
    n.matchIndex = []
    this.resetElection(n)
    this.updateTrace(n)
    this.emit('good', id, `${S(id)} restarts as a follower.`, 'It replays its committed log to rebuild its state machine once a leader tells it the commit index.')
    this.pushSnapshot()
  }

  partition(groups: number[][]) {
    this.branch()
    const s = this.state
    this.closePartition()
    s.partition = groups
    s.partitionTrace.push({ start: s.now, end: null })
    this.emit('danger', null, `Network partition: ${groups.map((g) => `{${g.map(S).join(', ')}}`).join(' | ')}`, 'Nodes in different groups can no longer exchange messages. Each side thinks the other crashed.')
    this.pushSnapshot()
  }

  isolate(id: number) {
    this.partition([[id], this.state.nodes.filter((n) => n.id !== id).map((n) => n.id)])
  }

  heal() {
    this.branch()
    if (!this.state.partition) return
    this.closePartition()
    this.state.partition = null
    this.emit('good', null, 'Network healed: all nodes can talk again.')
    this.pushSnapshot()
  }

  private closePartition() {
    const last = this.state.partitionTrace[this.state.partitionTrace.length - 1]
    if (last && last.end === null) last.end = this.state.now
  }

  setConfig(patch: Partial<Omit<Config, 'sabotage'>> & { sabotage?: Partial<Config['sabotage']> }) {
    this.branch()
    const c = this.state.config
    const { sabotage, ...rest } = patch
    Object.assign(c, rest)
    if (sabotage) {
      Object.assign(c.sabotage, sabotage)
      const on = Object.entries(c.sabotage).filter(([, v]) => v).map(([k]) => k)
      this.emit('danger', null, on.length ? `Raft is sabotaged: ${on.join(', ')}.` : 'Sabotage removed: Raft is correct again.')
    }
    this.pushSnapshot()
  }

  // ───────────────────────────── invariant checker ─────────────────────────────

  private violate(rule: RuleId, detail: string) {
    const s = this.state
    if (s.violations.length >= 20 || s.violations.some((v) => v.rule === rule && v.detail === detail)) return
    s.violations.push({ t: s.now, rule, detail })
    this.emit('danger', null, `SAFETY VIOLATION: ${RULES[rule].title}`, detail)
  }

  private checkInvariants() {
    const s = this.state

    // State machine safety: everything any node has committed must agree with the canonical record.
    for (const n of s.nodes) {
      const upto = Math.min(n.commitIndex, n.log.length)
      for (let i = 1; i <= upto; i++) {
        const e = n.log[i - 1]
        const c = s.committed[i - 1]
        if (!c) {
          if (i === s.committed.length + 1) s.committed.push({ ...e })
        } else if (c.id !== e.id) {
          this.violate(
            'state-machine-safety',
            `Index ${i}: ${S(n.id)} holds committed "${cmdLabel(e)}" (term ${e.term}) but "${cmdLabel(c)}" (term ${c.term}) was already committed there.`,
          )
        }
      }
    }

    // Log matching: same (index, term) at one point means identical prefixes.
    for (let a = 0; a < s.nodes.length; a++) {
      for (let b = a + 1; b < s.nodes.length; b++) {
        const la = s.nodes[a].log
        const lb = s.nodes[b].log
        let top = Math.min(la.length, lb.length)
        while (top > 0 && la[top - 1].term !== lb[top - 1].term) top--
        for (let i = 0; i < top; i++) {
          if (la[i].id !== lb[i].id) {
            this.violate('log-matching', `${S(a)} and ${S(b)} share term ${la[top - 1].term} at index ${top} but differ at index ${i + 1}.`)
            break
          }
        }
      }
    }
  }
}
