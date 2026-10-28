import { useState } from 'react'
import { majority } from '../engine/raft'
import type { Cluster } from '../engine/raft'
import { nodeName } from '../engine/util'
import type { Actions } from '../useSim'
import { ROLE_COLOR } from './format'

type Tab = 'events' | 'node' | 'chaos'

export function SidePanel({ cluster, selected, actions }: { cluster: Cluster; selected: number | null; actions: Actions }) {
  const [tab, setTab] = useState<Tab>('events')
  return (
    <div className="panel side">
      <div className="tabs">
        {(['events', 'node', 'chaos'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'events' ? 'Narration' : t === 'node' ? 'Inspector' : 'Chaos'}
          </button>
        ))}
      </div>
      {tab === 'events' && <Events cluster={cluster} />}
      {tab === 'node' && <Inspector cluster={cluster} selected={selected} actions={actions} />}
      {tab === 'chaos' && <Chaos cluster={cluster} actions={actions} />}
    </div>
  )
}

function Events({ cluster }: { cluster: Cluster }) {
  const evs = [...cluster.state.events].reverse()
  return (
    <div className="events">
      {evs.map((e) => (
        <div key={e.id} className={`ev ${e.level}`}>
          <span className="t">{(e.t / 1000).toFixed(1)}s</span>
          <div>
            <div className="txt">{e.text}</div>
            {e.note && <div className="note">{e.note}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function Inspector({ cluster, selected, actions }: { cluster: Cluster; selected: number | null; actions: Actions }) {
  const s = cluster.state
  const [cmd, setCmd] = useState('SET x=1')
  if (selected === null || !s.nodes[selected]) return <div className="empty-note">Click a node in the diagram or the log table to inspect it.</div>
  const n = s.nodes[selected]
  const timer = n.role === 'leader' ? n.nextHeartbeat - s.now : n.electionDeadline - s.now
  return (
    <div className="inspector">
      <h3 style={{ color: ROLE_COLOR[n.alive ? n.role : 'dead'] }}>
        {nodeName(n.id)} <small>{n.alive ? n.role : 'down'}</small>
      </h3>
      <dl>
        <dt>current term</dt>
        <dd>{n.term}</dd>
        <dt>voted for</dt>
        <dd>{n.votedFor === null ? '—' : nodeName(n.votedFor)}</dd>
        <dt>known leader</dt>
        <dd>{n.leaderId === null ? '—' : nodeName(n.leaderId)}</dd>
        <dt>log length</dt>
        <dd>{n.log.length}</dd>
        <dt>commit / applied</dt>
        <dd>
          {n.commitIndex} / {n.lastApplied}
        </dd>
        <dt>{n.role === 'leader' ? 'next heartbeat' : 'election timeout'}</dt>
        <dd>{n.alive ? `${Math.max(0, timer / 1000).toFixed(1)}s` : '—'}</dd>
      </dl>
      <h4>State machine (key-value)</h4>
      <div className="kv">
        {Object.keys(n.kv).length === 0 ? <em>empty</em> : Object.entries(n.kv).map(([k, v]) => <code key={k}>{k}={v}</code>)}
      </div>
      {n.alive && n.role === 'leader' && (
        <>
          <h4>Replication progress</h4>
          <table>
            <thead>
              <tr>
                <th>follower</th>
                <th>nextIndex</th>
                <th>matchIndex</th>
              </tr>
            </thead>
            <tbody>
              {s.nodes
                .filter((p) => p.id !== n.id)
                .map((p) => (
                  <tr key={p.id}>
                    <td>{nodeName(p.id)}</td>
                    <td>{n.nextIndex[p.id]}</td>
                    <td>{n.matchIndex[p.id]}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row">
        {n.alive ? (
          <>
            <button className="btn danger" onClick={() => actions.crash(n.id)}>
              Crash
            </button>
            <button className="btn" onClick={() => actions.isolate(n.id)}>
              Isolate
            </button>
          </>
        ) : (
          <button className="btn good" onClick={() => actions.restart(n.id)}>
            Restart
          </button>
        )}
      </div>
      <div className="row">
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} spellCheck={false} />
        <button className="btn" onClick={() => actions.submit(cmd, n.id)}>
          Write here
        </button>
      </div>
      <p className="hint">Writing to a non-leader is rejected. Writing to a stale, partitioned leader is accepted but can never commit.</p>
    </div>
  )
}

function Chaos({ cluster, actions }: { cluster: Cluster; actions: Actions }) {
  const s = cluster.state
  const [cmd, setCmd] = useState('SET x=1')
  const ids = s.nodes.map((n) => n.id)
  const leader = cluster.leader()
  const sab = s.config.sabotage
  const splitMinorityWithLeader = () => {
    const l = leader?.id ?? 0
    const others = ids.filter((i) => i !== l)
    const k = Math.floor(s.size / 2) - 1 // minority holds the leader plus (k) others
    actions.partition([[l, ...others.slice(0, Math.max(0, k))], others.slice(Math.max(0, k))])
  }
  const halves = () => actions.partition([ids.slice(0, Math.ceil(s.size / 2)), ids.slice(Math.ceil(s.size / 2))])
  return (
    <div className="chaos">
      <h4>Client</h4>
      <div className="row">
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} spellCheck={false} />
        <button className="btn" onClick={() => actions.submit(cmd)}>
          Write to leader
        </button>
      </div>

      <h4>Network</h4>
      <div className="row wrap">
        <button className="btn" onClick={() => leader && actions.isolate(leader.id)} disabled={!leader}>
          Isolate leader
        </button>
        <button className="btn" onClick={splitMinorityWithLeader}>
          Split: leader in minority
        </button>
        <button className="btn" onClick={halves}>
          Split in halves
        </button>
        <button className="btn good" onClick={actions.heal} disabled={!s.partition}>
          Heal
        </button>
      </div>
      <label className="slider">
        Message loss <b>{Math.round(s.config.dropRate * 100)}%</b>
        <input type="range" min={0} max={50} value={Math.round(s.config.dropRate * 100)} onChange={(e) => actions.setConfig({ dropRate: +e.target.value / 100 })} />
      </label>
      <label className="slider">
        Latency <b>{s.config.latencyMin}–{s.config.latencyMax}ms</b>
        <input type="range" min={50} max={800} step={50} value={s.config.latencyMax} onChange={(e) => actions.setConfig({ latencyMin: Math.max(20, +e.target.value - 200), latencyMax: +e.target.value })} />
      </label>
      <label className="slider">
        Election timeout <b>{(s.config.electionMin / 1000).toFixed(1)}–{(s.config.electionMax / 1000).toFixed(1)}s</b>
        <input type="range" min={0} max={1500} step={50} value={s.config.electionMax - s.config.electionMin} onChange={(e) => actions.setConfig({ electionMax: s.config.electionMin + +e.target.value })} />
      </label>

      <h4 className="warn-h">Break Raft</h4>
      <p className="hint">
        Each rule in Raft exists for a reason. Disable one and let the checker catch the damage. Majority is {majority(s.size)} of {s.size}.
      </p>
      <Toggle on={sab.minorityCommit} onChange={(v) => actions.setConfig({ sabotage: { minorityCommit: v } })} title="Commit on a minority" desc="Leaders commit with fewer than a majority. Combine with a partition to lose “committed” data." />
      <Toggle on={sab.skipLogCheck} onChange={(v) => actions.setConfig({ sabotage: { skipLogCheck: v } })} title="Ignore log freshness when voting" desc="Voters elect candidates with stale logs, so a new leader can lack committed entries." />
      <Toggle on={sab.doubleVote} onChange={(v) => actions.setConfig({ sabotage: { doubleVote: v } })} title="Vote more than once per term" desc="Two candidates can both win the same term. Try with Split votes and a crash." />
    </div>
  )
}

function Toggle({ on, onChange, title, desc }: { on: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <label className={`toggle ${on ? 'on' : ''}`}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{title}</b>
        <small>{desc}</small>
      </span>
    </label>
  )
}
