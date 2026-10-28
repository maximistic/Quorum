import type { ClusterState } from '../engine/types'
import { cmdLabel, nodeName } from '../engine/util'
import { ROLE_COLOR, termColor } from './format'

const WINDOW = 16

export function LogsView({ s, selected, onSelect }: { s: ClusterState; selected: number | null; onSelect: (id: number) => void }) {
  const maxLen = Math.max(0, ...s.nodes.map((n) => n.log.length))
  const start = Math.max(0, maxLen - WINDOW)
  const cols = Array.from({ length: Math.min(WINDOW, Math.max(maxLen, 1)) }, (_, i) => start + i + 1)
  return (
    <div className="logs">
      <div className="logs-head">
        <span />
        {cols.map((i) => (
          <span key={i} className="idx">
            {i}
          </span>
        ))}
      </div>
      {s.nodes.map((n) => (
        <div key={n.id} className={`log-row ${selected === n.id ? 'sel' : ''} ${n.alive ? '' : 'dead'}`} onClick={() => onSelect(n.id)}>
          <span className="who" style={{ color: ROLE_COLOR[n.alive ? n.role : 'dead'] }}>
            {nodeName(n.id)}
          </span>
          {cols.map((i) => {
            const e = n.log[i - 1]
            if (!e) return <span key={i} className="cell empty" />
            const committed = i <= n.commitIndex
            const c = termColor(e.term)
            return (
              <span
                key={i}
                className={`cell ${committed ? 'committed' : 'pending'}`}
                style={committed ? { background: c, borderColor: '#22201C' } : { background: `color-mix(in srgb, ${c} 22%, transparent)`, borderColor: c }}
                title={`index ${i} · term ${e.term} · ${e.command}${committed ? ' · committed' : ' · not committed'}`}
              >
                <small>{e.term}</small>
                {cmdLabel(e)}
              </span>
            )
          })}
        </div>
      ))}
      <p className="legend">
        Filled = committed, dashed = not yet. Small number is the term the entry was created in; the colour follows it. ∅ is the no-op a new leader writes.
      </p>
    </div>
  )
}
