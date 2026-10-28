import { useState } from 'react'
import { RULES } from './engine/raft'
import { SCENARIOS } from './engine/scenarios'
import type { RuleId } from './engine/types'
import { ClusterView } from './ui/ClusterView'
import { LogsView } from './ui/LogsView'
import { SidePanel } from './ui/SidePanel'
import { Timeline } from './ui/Timeline'
import { useSim } from './useSim'

const SCENARIO_LIST = SCENARIOS.map((f) => f())

export function App() {
  const { cluster, runner, playing, speed, actions } = useSim()
  const s = cluster.state
  const [selected, setSelected] = useState<number | null>(null)
  const [seed, setSeed] = useState(11)
  const [size, setSize] = useState(5)
  const broken = new Set(s.violations.map((v) => v.rule))
  const leader = cluster.leader()
  const maxTerm = Math.max(...s.nodes.map((n) => n.term))

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>quorum</h1>
          <p>
            A working Raft cluster you can poke. Every node, vote and message below is the real algorithm running in your browser, so you can
            kill things and see what the protocol does about it.
          </p>
        </div>
        <dl className="ledger" title="Re-checked on every tick of the simulation">
          <dt className="ledger-title">Safety checks</dt>
          <dd />
          {(Object.keys(RULES) as RuleId[]).map((r) => (
            <div key={r} className={broken.has(r) ? 'bad' : 'ok'} title={RULES[r].desc}>
              <dt>{RULES[r].title}</dt>
              <dd>{broken.has(r) ? 'VIOLATED' : 'holds'}</dd>
            </div>
          ))}
        </dl>
      </header>

      {s.violations.length > 0 && (
        <div className="alarm">
          <b>Safety violated.</b> {s.violations[0].detail} Raft only promises anything while its rules are intact. Drag the time slider back to find the moment it went wrong.
        </div>
      )}

      <main>
        <section className="left">
          <div className="block">
            <div className="facts">
              <span>
                leader <b>{leader ? `S${leader.id + 1}` : 'none'}</b>
              </span>
              <span>
                term <b>{maxTerm}</b>
              </span>
              <span>
                elections <b>{s.stats.elections}</b>
              </span>
              <span>
                messages <b>{s.stats.sent}</b> ({s.stats.dropped} lost)
              </span>
              <span>
                committed <b>{s.committed.length}</b>
              </span>
            </div>
            <ClusterView s={s} selected={selected} onSelect={setSelected} />
            <p className="legend key">
              <svg width="12" height="12" viewBox="-7 -7 14 14">
                <path d="M0 -6L6 0L0 6L-6 0Z" fill="#B9791A" stroke="#22201C" />
              </svg>{' '}
              vote request <i className="r" style={{ background: '#2F6B4F' }} /> granted <i className="r" style={{ background: '#B03A2A' }} /> denied{' '}
              <i className="sq" /> log entries (count inside) <i className="r tiny" style={{ background: '#2D4F86' }} /> heartbeat. The ring around a node empties as its timeout approaches.
            </p>
          </div>

          <div className="block">
            <h2>
              <span>2</span> Who was what, and when
            </h2>
            <Timeline cluster={cluster} onSeek={actions.seek} onLive={actions.goLive} />
          </div>

          <div className="block">
            <h2>
              <span>3</span> The replicated logs
            </h2>
            <LogsView s={s} selected={selected} onSelect={setSelected} />
          </div>
        </section>

        <aside className="right">
          <div className="block controls">
            <div className="row">
              <button className="btn primary" onClick={() => actions.setPlaying(!playing)}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <button className="btn" onClick={actions.stepOnce} title="Advance 100ms of simulated time">
                Step
              </button>
              <select value={speed} onChange={(e) => actions.setSpeed(+e.target.value)} aria-label="Speed">
                {[0.25, 0.5, 1, 2, 4, 8].map((v) => (
                  <option key={v} value={v}>
                    {v}x speed
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <label>
                seed <input className="num" type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} />
              </label>
              <label>
                nodes{' '}
                <select value={size} onChange={(e) => setSize(+e.target.value)}>
                  {[3, 5, 7].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <button className="btn" onClick={() => actions.reset(seed, size)}>
                Restart
              </button>
              <button
                className="btn"
                onClick={() => {
                  const r = Math.floor(Math.random() * 9999)
                  setSeed(r)
                  actions.reset(r, size)
                }}
              >
                Random seed
              </button>
            </div>
            <p className="hint">Same seed and same actions give exactly the same run. Delays, timeouts and votes are all seeded.</p>
          </div>

          <div className="block">
            <h2>
              <span>1</span> Walk through it
            </h2>
            <ol className="sc-list">
              {SCENARIO_LIST.map((sc, i) => (
                <li key={sc.id}>
                  <button className={`sc ${runner?.scenario.id === sc.id ? 'on' : ''} ${sc.id.startsWith('break') ? 'break' : ''}`} onClick={() => actions.loadScenario(i)}>
                    <b>{sc.title}</b> <span>{sc.blurb}</span>
                  </button>
                </li>
              ))}
            </ol>
            {runner && (
              <p className="caption">
                <span>
                  step {runner.progress}
                  {runner.done ? ', finished' : ''}
                </span>
                {runner.caption}
              </p>
            )}
          </div>

          <SidePanel cluster={cluster} selected={selected} actions={actions} />
        </aside>
      </main>
      <footer>
        Written to understand Raft properly, from Ongaro &amp; Ousterhout’s 2014 paper. The engine is plain TypeScript; the page just draws it. Notes and tests are in the README.
      </footer>
    </div>
  )
}
