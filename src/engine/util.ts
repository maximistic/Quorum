import type { Entry } from './types'

export const nodeName = (id: number) => `S${id + 1}`

export function cmdLabel(e: Pick<Entry, 'command'>): string {
  if (e.command === 'no-op') return '∅'
  return e.command.replace(/^SET /, '')
}

export function fmtTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** mulberry32 over a state field, so the whole simulation is replayable from a seed. */
export function nextRandom(holder: { rng: number }): number {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
