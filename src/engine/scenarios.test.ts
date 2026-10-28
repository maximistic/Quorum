import { describe, expect, it } from 'vitest'
import { Cluster } from './raft'
import { SCENARIOS, ScenarioRunner } from './scenarios'

function play(make: () => ReturnType<(typeof SCENARIOS)[number]>, seconds = 90) {
  const sc = make()
  const c = new Cluster({ seed: sc.seed, size: sc.size, config: sc.config })
  const r = new ScenarioRunner(sc)
  for (let i = 0; i < seconds * 100 && !r.done; i++) {
    c.step()
    r.tick(c)
  }
  c.advance(8000)
  return { c, r, id: sc.id }
}

describe('guided scenarios', () => {
  for (const make of SCENARIOS) {
    const id = make().id
    it(`${id} runs to completion with the promised outcome`, () => {
      const { c, r } = play(make)
      expect(r.done).toBe(true)
      const rules = c.state.violations.map((v) => v.rule)
      if (id === 'break-quorum') expect(rules).toContain('state-machine-safety')
      else expect(rules).toEqual([])
      if (id === 'split-brain') {
        for (const n of c.state.nodes) {
          expect(n.kv.y).toBe('2')
          expect(n.kv.stale).toBeUndefined()
        }
      }
      if (id === 'split-vote') expect(Math.max(...c.state.nodes.map((n) => n.term))).toBeGreaterThan(2)
    })
  }
})
