import type { Cluster } from '../engine/raft'
import { nodeName } from '../engine/util'
import { C, ROLE_COLOR } from './format'

const VIEW_W = 800
const LABEL_W = 30
const ROW_H = 14
const GAP = 5
const WINDOW = 60000
const MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace"

const CODE_COLOR = { F: C.line, C: ROLE_COLOR.candidate, L: ROLE_COLOR.leader, X: ROLE_COLOR.dead } as const

export function Timeline({ cluster, onSeek, onLive }: { cluster: Cluster; onSeek: (i: number) => void; onLive: () => void }) {
  const s = cluster.state
  const start = Math.max(0, s.now - WINDOW)
  const end = Math.max(s.now, start + 15000)
  const x = (t: number) => LABEL_W + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * (VIEW_W - LABEL_W)
  const h = s.size * (ROW_H + GAP) + 16
  const ticks: number[] = []
  for (let t = Math.ceil(start / 10000) * 10000; t <= end; t += 10000) ticks.push(t)
  const last = cluster.history.length - 1
  return (
    <div className="timeline">
      <svg viewBox={`0 0 ${VIEW_W} ${h}`} preserveAspectRatio="none">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={C.red} strokeWidth="1.5" opacity="0.35" />
          </pattern>
        </defs>
        {s.partitionTrace.map((p, i) => (
          <rect key={i} x={x(p.start)} y={0} width={Math.max(1, x(p.end ?? s.now) - x(p.start))} height={h - 14} fill="url(#hatch)" />
        ))}
        {ticks.map((t) => (
          <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={h - 14} stroke={C.line} strokeWidth={1} />
        ))}
        {s.trace.map((segs, id) =>
          segs.map((seg, i) => {
            const t1 = segs[i + 1]?.t ?? s.now
            if (t1 < start) return null
            return <rect key={`${id}-${i}`} x={x(seg.t)} y={id * (ROW_H + GAP) + 2} width={Math.max(1, x(t1) - x(seg.t))} height={ROW_H} fill={CODE_COLOR[seg.code]} />
          }),
        )}
        {s.nodes.map((n) => (
          <text key={n.id} x={0} y={n.id * (ROW_H + GAP) + 13} fontSize={11} fill={C.muted} fontFamily={MONO}>
            {nodeName(n.id)}
          </text>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={h - 2} fontSize={10} fill={C.muted} textAnchor="middle" fontFamily={MONO}>
            {t / 1000}s
          </text>
        ))}
      </svg>
      <div className="scrub">
        <input type="range" min={0} max={Math.max(last, 0)} value={Math.max(cluster.cursor, 0)} onChange={(e) => onSeek(+e.target.value)} aria-label="Time travel" />
        {cluster.isLive ? (
          <span className="live">live</span>
        ) : (
          <button className="btn small" onClick={onLive}>
            back to live
          </button>
        )}
      </div>
      <p className="legend">
        <i style={{ background: CODE_COLOR.F }} /> follower <i style={{ background: CODE_COLOR.C }} /> candidate <i style={{ background: CODE_COLOR.L }} /> leader{' '}
        <i style={{ background: CODE_COLOR.X }} /> down <i className="hatch" /> partitioned. Drag the slider to rewind, then press play to branch from that moment.
      </p>
    </div>
  )
}
