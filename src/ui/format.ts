import type { Role } from '../engine/types'

/** Palette for the SVG parts; mirrors the CSS variables in styles.css. */
export const C = {
  paper: '#F2EDE1',
  paper2: '#E9E2D1',
  ink: '#22201C',
  muted: '#7B7466',
  line: '#CFC6B2',
  green: '#2F6B4F',
  ochre: '#B9791A',
  red: '#B03A2A',
  blue: '#2D4F86',
  teal: '#2E7D78',
}

export const ROLE_COLOR: Record<Role | 'dead', string> = {
  follower: '#6F695B',
  candidate: C.ochre,
  leader: C.green,
  dead: C.red,
}

/** A fixed, hand-picked set so adjacent terms are easy to tell apart. */
const TERM_COLORS = ['#8FB8A8', '#E2B76B', '#C98B7C', '#8AA0C4', '#B7A1C9', '#A9C27F', '#D4A0B0', '#7FB5C4']
export const termColor = (term: number) => TERM_COLORS[term % TERM_COLORS.length]
