import { describe, expect, it } from 'vitest'
import { Cluster } from './raft'
import { fuzz } from './fuzz'

const leaders = (c: Cluster) => c.state.nodes.filter((n) => n.alive && n.role === 'leader')

describe('raft engine', () => {
  it('elects exactly one leader and replicates writes to every node', () => {
    const c = new Cluster({ seed: 1, size: 5 })
    c.advance(8000)
    expect(leaders(c)).toHaveLength(1)
    c.submit('SET x=1')
    c.advance(5000)
    for (const n of c.state.nodes) {
      expect(n.kv.x).toBe('1')
      expect(n.log).toHaveLength(c.leader()!.log.length)
    }
    expect(c.state.violations).toEqual([])
  })

  it('is deterministic for a given seed', () => {
    const run = () => {
      const c = new Cluster({ seed: 42, size: 5 })
      c.advance(6000)
      c.submit('SET a=1')
      c.advance(4000)
      return JSON.stringify(c.state)
    }
    expect(run()).toBe(run())
  })

  it('re-elects after the leader crashes and the old leader catches up on restart', () => {
    const c = new Cluster({ seed: 3, size: 5 })
    c.advance(8000)
    const old = c.leader()!
    c.submit('SET x=1')
    c.advance(4000)
    c.crash(old.id)
    c.advance(10000)
    const next = c.leader()!
    expect(next.id).not.toBe(old.id)
    c.submit('SET y=2')
    c.advance(4000)
    c.restart(old.id)
    c.advance(8000)
    expect(c.state.nodes[old.id].kv).toEqual({ x: '1', y: '2' })
    expect(c.state.violations).toEqual([])
  })

  it('a minority partition cannot commit, and its stale entries are overwritten after healing', () => {
    const c = new Cluster({ seed: 5, size: 5 })
    c.advance(8000)
    const old = c.leader()!
    const buddy = c.state.nodes.find((n) => n.id !== old.id)!.id
    const rest = c.state.nodes.map((n) => n.id).filter((id) => id !== old.id && id !== buddy)
    c.partition([[old.id, buddy], rest])
    c.submit('SET stale=1', old.id)
    c.advance(12000)
    expect(c.state.nodes[old.id].commitIndex).toBeLessThan(c.state.nodes[old.id].log.length)
    const fresh = c.leader()!
    expect(rest).toContain(fresh.id)
    c.submit('SET good=1', fresh.id)
    c.advance(4000)
    c.heal()
    c.advance(10000)
    for (const n of c.state.nodes) {
      expect(n.kv.good).toBe('1')
      expect(n.kv.stale).toBeUndefined()
    }
    expect(c.state.violations).toEqual([])
  })

  it('time travel restores earlier state and replays identically', () => {
    const c = new Cluster({ seed: 9, size: 5 })
    c.advance(5000)
    const i = c.history.findIndex((h) => h.now === 3000)
    c.seek(i)
    expect(c.state.now).toBe(3000)
    c.advance(2000)
    const a = JSON.stringify(c.state)
    c.seek(c.history.findIndex((h) => h.now === 3000))
    c.advance(2000)
    expect(JSON.stringify(c.state)).toBe(a)
  })
})

describe('safety under chaos', () => {
  it('never violates an invariant across 150 fuzzed seeds', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 150; seed++) {
      const c = fuzz(seed, { size: seed % 3 === 0 ? 3 : seed % 3 === 1 ? 5 : 7 })
      if (c.state.violations.length) bad.push(`seed ${seed}: ${c.state.violations[0].detail}`)
    }
    expect(bad).toEqual([])
  })

  it('the checker catches broken commit quorums', () => {
    let caught = 0
    for (let seed = 1; seed <= 40; seed++) {
      const c = fuzz(seed, { config: { sabotage: { minorityCommit: true, skipLogCheck: false, doubleVote: false } } })
      if (c.state.violations.length) caught++
    }
    expect(caught).toBeGreaterThan(0)
  })

  it('the checker catches double voting and ignored log checks', () => {
    let a = 0
    let b = 0
    for (let seed = 1; seed <= 60; seed++) {
      const dv = fuzz(seed, { config: { electionMin: 1500, electionMax: 1600, sabotage: { doubleVote: true, skipLogCheck: false, minorityCommit: false } } })
      if (dv.state.violations.length) a++
      const sk = fuzz(seed, { config: { sabotage: { skipLogCheck: true, doubleVote: false, minorityCommit: false } } })
      if (sk.state.violations.length) b++
    }
    console.log(`double-vote caught in ${a}/60 seeds, skip-log-check caught in ${b}/60 seeds`)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
  })
})
