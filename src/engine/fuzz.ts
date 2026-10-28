import { Cluster, STEP } from './raft'
import type { Config } from './types'
import { nextRandom } from './util'

export interface FuzzOptions {
  size?: number
  seconds?: number
  config?: Partial<Config>
  /** Highest rate at which random faults are injected (ms between actions). */
  maxGap?: number
}

/** Runs a cluster under random crashes, partitions, message loss and client writes. */
export function fuzz(seed: number, opts: FuzzOptions = {}): Cluster {
  const size = opts.size ?? 5
  const c = new Cluster({ seed, size, config: opts.config, history: false })
  const chaos = { rng: seed * 7919 + 13 }
  const r = () => nextRandom(chaos)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  let nextAction = 1000
  let writes = 0
  const total = (opts.seconds ?? 120) * 1000
  for (let t = 0; t < total; t += STEP) {
    c.step()
    if (c.state.now < nextAction) continue
    nextAction = c.state.now + 300 + r() * (opts.maxGap ?? 2500)
    const ids = c.state.nodes.map((n) => n.id)
    const roll = r()
    if (roll < 0.3) c.submit(`SET k${writes % 4}=${writes++}`)
    else if (roll < 0.45) {
      const alive = c.state.nodes.filter((n) => n.alive)
      if (alive.length > 1) c.crash(pick(alive).id)
    } else if (roll < 0.6) {
      const dead = c.state.nodes.filter((n) => !n.alive)
      if (dead.length) c.restart(pick(dead).id)
    } else if (roll < 0.75) {
      const shuffled = [...ids].sort(() => r() - 0.5)
      const cut = 1 + Math.floor(r() * (size - 1))
      c.partition([shuffled.slice(0, cut), shuffled.slice(cut)])
    } else if (roll < 0.88) c.heal()
    else if (roll < 0.95) c.setConfig({ dropRate: r() * 0.3 })
    else c.setConfig({ dropRate: 0 })
  }
  return c
}
