import { canReach, groupOf } from '../engine/raft'
import type { ClusterState, Message, NodeState } from '../engine/types'
import { nodeName } from '../engine/util'
import { C, ROLE_COLOR } from './format'

const W = 600
const H = 500
const CX = W / 2
const CY = H / 2
const R = 180
const NODE_R = 32
const RING_R = 41
const RING_C = 2 * Math.PI * RING_R
const MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace"
const SERIF = "'Fraunces Variable', Georgia, serif"

function pos(i: number, n: number) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) }
}

function MessageDot({ m, now, n }: { m: Message; now: number; n: number }) {
  const p = Math.min(1, Math.max(0, (now - m.sentAt) / (m.deliverAt - m.sentAt)))
  const a = pos(m.from, n)
  const b = pos(m.to, n)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const ox = (-dy / len) * 8
  const oy = (dx / len) * 8
  const x = a.x + dx * p + ox
  const y = a.y + dy * p + oy
  const rpc = m.rpc
  if (m.fate !== 'ok' && p > 0.5) {
    const fade = Math.max(0, 1 - (p - 0.5) * 2)
    return (
      <g opacity={fade} transform={`translate(${a.x + dx * 0.5 + ox},${a.y + dy * 0.5 + oy})`}>
        <path d="M-5 -5L5 5M5 -5L-5 5" stroke={C.red} strokeWidth={2} strokeLinecap="square" />
      </g>
    )
  }
  switch (rpc.type) {
    case 'RequestVote':
      return <path d={`M${x} ${y - 7}L${x + 7} ${y}L${x} ${y + 7}L${x - 7} ${y}Z`} fill={C.ochre} stroke={C.ink} strokeWidth={1} />
    case 'RequestVoteReply':
      return <circle cx={x} cy={y} r={5.5} fill={rpc.voteGranted ? C.green : C.red} stroke={C.ink} strokeWidth={1} />
    case 'AppendEntries':
      return rpc.entries.length ? (
        <g transform={`translate(${x},${y})`}>
          <rect x={-8} y={-8} width={16} height={16} fill={C.blue} stroke={C.ink} strokeWidth={1} />
          <text textAnchor="middle" y={4} fontSize={10} fontWeight={600} fill={C.paper} fontFamily={MONO}>
            {rpc.entries.length}
          </text>
        </g>
      ) : (
        <circle cx={x} cy={y} r={2.5} fill={C.blue} />
      )
    case 'AppendEntriesReply':
      return <circle cx={x} cy={y} r={3} fill={C.paper} stroke={rpc.success ? C.teal : C.red} strokeWidth={1.5} />
  }
}

function NodeView({ node, s, selected, onSelect }: { node: NodeState; s: ClusterState; selected: boolean; onSelect: () => void }) {
  const { x, y } = pos(node.id, s.size)
  const color = ROLE_COLOR[node.alive ? node.role : 'dead']
  const isLeader = node.alive && node.role === 'leader'
  const total = isLeader ? s.config.heartbeat : node.electionDeadline - node.electionResetAt
  const left = isLeader ? node.nextHeartbeat - s.now : node.electionDeadline - s.now
  const frac = node.alive ? Math.max(0, Math.min(1, left / total)) : 0
  const group = groupOf(s, node.id)
  const label = !node.alive ? 'down' : node.role === 'candidate' ? `candidate · ${node.votes.length}/${s.size}` : node.role
  return (
    <g transform={`translate(${x},${y})`} onClick={onSelect} style={{ cursor: 'pointer' }}>
      {selected && <circle r={RING_R + 7} fill="none" stroke={C.ink} strokeWidth={1} strokeDasharray="1 4" />}
      <circle r={RING_R} fill="none" stroke={C.line} strokeWidth={2} />
      <circle r={RING_R} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray={`${frac * RING_C} ${RING_C}`} transform="rotate(-90)" />
      <circle
        r={NODE_R}
        fill={isLeader ? C.green : node.alive ? C.paper : C.paper2}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={node.alive ? undefined : '3 3'}
      />
      <text textAnchor="middle" y={-2} fontSize={16} fontWeight={600} fill={isLeader ? C.paper : C.ink} fontFamily={SERIF}>
        {nodeName(node.id)}
      </text>
      <text textAnchor="middle" y={12} fontSize={9.5} fill={isLeader ? C.paper : C.muted} fontFamily={MONO}>
        {node.alive ? `term ${node.term}` : '—'}
      </text>
      <text textAnchor="middle" y={RING_R + 15} fontSize={10.5} fill={color} fontFamily={MONO} stroke={C.paper} strokeWidth={4} paintOrder="stroke">
        {label}
      </text>
      {group >= 0 && (
        <g transform={`translate(${NODE_R + 4},${-NODE_R})`}>
          <rect x={-8} y={-8} width={16} height={16} fill={C.ink} />
          <text textAnchor="middle" y={4} fontSize={10} fontWeight={600} fill={C.paper} fontFamily={MONO}>
            {'ABC'[group] ?? group}
          </text>
        </g>
      )}
    </g>
  )
}

export function ClusterView({ s, selected, onSelect }: { s: ClusterState; selected: number | null; onSelect: (id: number) => void }) {
  const edges: { a: number; b: number; cut: boolean }[] = []
  for (let a = 0; a < s.size; a++) for (let b = a + 1; b < s.size; b++) edges.push({ a, b, cut: !canReach(s, a, b) })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cluster" role="img" aria-label="Raft cluster">
      {edges.map(({ a, b, cut }) => {
        const p = pos(a, s.size)
        const q = pos(b, s.size)
        return (
          <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={cut ? C.red : C.line} strokeWidth={cut ? 1.5 : 1} strokeDasharray={cut ? '2 6' : undefined} strokeLinecap="round" />
        )
      })}
      {s.nodes.map((n) => (
        <NodeView key={n.id} node={n} s={s} selected={selected === n.id} onSelect={() => onSelect(n.id)} />
      ))}
      {s.messages.map((m) => (
        <MessageDot key={m.id} m={m} now={s.now} n={s.size} />
      ))}
      <text x={CX} y={CY + 6} textAnchor="middle" fontSize={40} fill={C.ink} fontFamily={SERIF} fontWeight={300} stroke={C.paper} strokeWidth={4} paintOrder="stroke">
        {(s.now / 1000).toFixed(1)}s
      </text>
      <text x={CX} y={CY + 26} textAnchor="middle" fontSize={10} fill={C.muted} fontFamily={MONO} stroke={C.paper} strokeWidth={4} paintOrder="stroke">
        seed {s.seed}
      </text>
    </svg>
  )
}
