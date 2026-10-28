import type { Cluster } from './raft'
import type { Config } from './types'

export interface Step {
  when: (c: Cluster, sinceLast: number) => boolean
  run: (c: Cluster) => void
  caption: string
}

export interface Scenario {
  id: string
  title: string
  blurb: string
  seed: number
  size: number
  config?: Partial<Config>
  intro: string
  steps: Step[]
}

export class ScenarioRunner {
  private idx = 0
  private lastT = 0
  caption: string
  constructor(readonly scenario: Scenario) {
    this.caption = scenario.intro
  }
  get done() {
    return this.idx >= this.scenario.steps.length
  }
  get progress() {
    return `${Math.min(this.idx, this.scenario.steps.length)}/${this.scenario.steps.length}`
  }
  tick(c: Cluster) {
    const st = this.scenario.steps[this.idx]
    if (!st || !st.when(c, c.state.now - this.lastT)) return
    st.run(c)
    this.caption = st.caption
    this.lastT = c.state.now
    this.idx++
  }
}

const stable = (c: Cluster) => {
  const l = c.leader()
  if (!l || l.commitIndex < 1) return false
  return c.state.nodes.every((n) => !n.alive || n.term === l.term)
}
const after = (ms: number) => (_: Cluster, since: number) => since >= ms

/** Splits the cluster so the current leader sits in a two-node minority. */
function isolateLeaderWithOneFollower(c: Cluster): { old: number; buddy: number } {
  const old = c.leader()!.id
  const buddy = c.state.nodes.find((n) => n.id !== old)!.id
  const rest = c.state.nodes.map((n) => n.id).filter((id) => id !== old && id !== buddy)
  c.partition([[old, buddy], rest])
  return { old, buddy }
}

const majorityLeaderExists = (c: Cluster, old: number, buddy: number) => {
  const l = c.leader()
  return !!l && l.id !== old && l.id !== buddy && l.term > c.state.nodes[old].term
}

export const SCENARIOS: (() => Scenario)[] = [
  () => ({
    id: 'happy',
    title: 'Happy path',
    blurb: 'Election, then a replicated write.',
    seed: 11,
    size: 5,
    intro: 'Five followers boot with random election timers. Watch the rings drain: whichever hits zero first calls an election.',
    steps: [
      { when: stable, run: (c) => c.submit('SET x=1'), caption: 'A leader exists. A client writes x=1. The leader appends it locally and sends it to every follower. It commits as soon as a majority (3 of 5) has stored it.' },
      { when: after(3500), run: (c) => c.submit('SET y=2'), caption: 'A second write. In the log rows below each cell is coloured by the term it was created in, and solid cells are committed.' },
      { when: after(3500), run: () => {}, caption: 'Every log is identical and every state machine agrees. Now open the Chaos tab: crash a node, cut the network, or drop messages.' },
    ],
  }),
  () => {
    let victim = -1
    return {
      id: 'leader-crash',
      title: 'Leader crash',
      blurb: 'Kill the leader, watch failover and catch-up.',
      seed: 21,
      size: 5,
      intro: 'Waiting for a stable leader…',
      steps: [
        { when: stable, run: (c) => c.submit('SET x=1'), caption: 'x=1 is written and committed on a majority.' },
        { when: after(3500), run: (c) => { victim = c.leader()!.id; c.crash(victim) }, caption: 'The leader crashes. Followers stop receiving heartbeats, so nothing resets their election rings.' },
        { when: (c) => stable(c) && c.leader()!.id !== victim, run: (c) => c.submit('SET y=2'), caption: 'A new leader won a higher term. The cluster keeps working with 4 of 5 nodes, and writes still commit.' },
        { when: after(3500), run: (c) => c.restart(victim), caption: 'The old leader restarts as a follower with a stale log. The new leader probes backwards (nextIndex) until it finds where the logs agree, then streams the missing entries.' },
        { when: after(6000), run: () => {}, caption: 'Caught up. The restarted node rebuilt its key-value state purely from the replicated log.' },
      ],
    }
  },
  () => {
    let old = -1
    let buddy = -1
    return {
      id: 'split-brain',
      title: 'Split brain attempt',
      blurb: 'Partition the leader. Does safety hold?',
      seed: 5,
      size: 5,
      intro: 'Waiting for a stable leader…',
      steps: [
        { when: stable, run: (c) => c.submit('SET x=1'), caption: 'x=1 is committed everywhere.' },
        { when: after(3500), run: (c) => ({ old, buddy } = isolateLeaderWithOneFollower(c)), caption: 'The network splits 2 | 3. The old leader and one follower are in the minority, and the old leader still believes it is in charge.' },
        { when: after(600), run: (c) => c.submit('SET stale=1', old), caption: 'A client talking to the old leader writes "stale=1". It replicates to its one neighbour, but 2 of 5 is not a majority, so it can never commit.' },
        { when: (c) => majorityLeaderExists(c, old, buddy), run: (c) => c.submit('SET y=2', c.leader()!.id), caption: 'The majority side elected its own leader in a higher term. It accepts "y=2" and commits it with 3 of 5. Two leaders exist, but only one can commit.' },
        { when: after(3500), run: (c) => c.heal(), caption: 'Network heals. The old leader sees the higher term, steps down, and its uncommitted "stale=1" is overwritten.' },
        { when: after(7000), run: () => {}, caption: 'Converged. The client that wrote stale=1 never got an acknowledgement, so no promise was broken. Safety held; availability was sacrificed on the minority side.' },
      ],
    }
  },
  () => {
    let old = -1
    let buddy = -1
    return {
      id: 'break-quorum',
      title: 'Break it: tiny quorum',
      blurb: 'Same split, but with a rigged commit rule.',
      seed: 5,
      size: 5,
      config: { sabotage: { minorityCommit: true, skipLogCheck: false, doubleVote: false } },
      intro: 'Same experiment as “Split brain attempt”, except the leader is sabotaged: it commits once just 2 of 5 nodes have an entry.',
      steps: [
        { when: stable, run: (c) => c.submit('SET x=1'), caption: 'Sabotage is on: the commit quorum is 2 of 5 instead of 3.' },
        { when: after(3500), run: (c) => ({ old, buddy } = isolateLeaderWithOneFollower(c)), caption: 'Partition 2 | 3 again.' },
        { when: after(600), run: (c) => c.submit('SET stale=1', old), caption: 'The old leader writes "stale=1". Two nodes hold it, which the rigged rule accepts as committed.' },
        { when: (c) => majorityLeaderExists(c, old, buddy), run: (c) => c.submit('SET y=2', c.leader()!.id), caption: 'The honest majority elects a new leader and commits "y=2" at the very same log index.' },
        { when: after(3500), run: (c) => c.heal(), caption: 'Healing the network…' },
        { when: after(6000), run: () => {}, caption: 'Two different commands were committed at the same index, so the safety alarms above turn red: a leader was elected without a committed entry, and committed data is lost. This is why quorums must overlap.' },
      ],
    }
  },
  () => ({
    id: 'split-vote',
    title: 'Split votes',
    blurb: 'Why election timeouts are randomized.',
    seed: 8,
    size: 5,
    config: { electionMin: 1500, electionMax: 1560 },
    intro: 'The election timeout range is squeezed to 60ms. Several nodes will time out almost together and split the vote.',
    steps: [
      { when: after(9000), run: (c) => c.setConfig({ electionMin: 1500, electionMax: 3000 }), caption: 'Timeouts widened back to 1.5–3s. Now one node usually fires well ahead of the others and wins before anyone competes. Randomness breaks the tie.' },
      { when: after(8000), run: () => {}, caption: 'Notice how high the term number climbed: every failed election burns a term.' },
    ],
  }),
]
