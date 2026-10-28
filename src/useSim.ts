import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Cluster, STEP } from './engine/raft'
import { SCENARIOS, ScenarioRunner } from './engine/scenarios'
import type { Config } from './engine/types'

export type Actions = ReturnType<typeof useSim>['actions']

export function useSim() {
  const cluster = useRef<Cluster>(null as unknown as Cluster)
  if (!cluster.current) cluster.current = new Cluster({ seed: 11, size: 5 })
  const runner = useRef<ScenarioRunner | null>(null)
  const [, force] = useReducer((x: number) => x + 1, 0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const live = useRef({ playing, speed })
  live.current = { playing, speed }

  useEffect(() => {
    let last = performance.now()
    let acc = 0
    let raf = 0
    const loop = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      if (live.current.playing) {
        const c = cluster.current
        const before = c.state.violations.length
        acc += dt * live.current.speed
        let n = 0
        while (acc >= STEP && n < 60) {
          c.step()
          runner.current?.tick(c)
          acc -= STEP
          n++
        }
        if (acc >= STEP) acc = 0
        if (c.state.violations.length > before) setPlaying(false)
        force()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const actions = useMemo(() => {
    const c = () => cluster.current
    const wrap =
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        const r = fn(...a)
        force()
        return r
      }
    return {
      setPlaying,
      setSpeed,
      stepOnce: wrap(() => {
        setPlaying(false)
        for (let i = 0; i < 10; i++) {
          c().step()
          runner.current?.tick(c())
        }
      }),
      reset: wrap((seed: number, size: number) => {
        runner.current = null
        c().reset({ seed, size })
        setPlaying(true)
      }),
      loadScenario: wrap((index: number) => {
        const sc = SCENARIOS[index]()
        runner.current = new ScenarioRunner(sc)
        c().reset({ seed: sc.seed, size: sc.size, config: sc.config })
        setPlaying(true)
      }),
      stopScenario: wrap(() => {
        runner.current = null
      }),
      submit: wrap((cmd: string, target?: number) => c().submit(cmd, target)),
      crash: wrap((id: number) => c().crash(id)),
      restart: wrap((id: number) => c().restart(id)),
      partition: wrap((g: number[][]) => c().partition(g)),
      isolate: wrap((id: number) => c().isolate(id)),
      heal: wrap(() => c().heal()),
      setConfig: wrap((p: Partial<Omit<Config, 'sabotage'>> & { sabotage?: Partial<Config['sabotage']> }) => c().setConfig(p)),
      seek: wrap((i: number) => {
        setPlaying(false)
        runner.current = null
        c().seek(i)
      }),
      goLive: wrap(() => {
        runner.current = null
        c().seek(c().history.length - 1)
      }),
    }
  }, [])

  return { cluster: cluster.current, runner: runner.current, playing, speed, actions }
}
