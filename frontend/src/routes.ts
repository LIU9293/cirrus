import type { NavView } from '@/wizard/AgentCanvas'

export const ROUTES: Record<NavView, string> = {
  flow: '/new-agent',
  newSkill: '/new-skill',
  skills: '/skills',
  agents: '/agent',
  community: '/community',
  runtime: '/runtime',
}

export function viewFromPath(pathname: string): NavView {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (normalized === '/new') return 'flow'
  if (normalized === ROUTES.flow) return 'flow'
  if (normalized === ROUTES.newSkill) return 'newSkill'
  if (normalized === ROUTES.skills) return 'skills'
  if (normalized === ROUTES.agents) return 'agents'
  if (normalized === ROUTES.community) return 'community'
  if (normalized === ROUTES.runtime) return 'runtime'
  return 'agents'
}
