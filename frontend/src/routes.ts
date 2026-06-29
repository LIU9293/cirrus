import type { NavView } from '@/wizard/AgentCanvas'

// Two surfaces: Community (public discovery) at /skills + /agents, and the user's
// Dashboard workspace at /dashboard/*. Creation flows keep their own routes.
export const ROUTES: Record<NavView, string> = {
  flow: '/new-agent',
  newSkill: '/new-skill',
  communitySkills: '/skills',
  communityAgents: '/agents',
  dashSkills: '/dashboard/skills',
  dashAgents: '/dashboard/agents',
  dashBots: '/dashboard/bots',
  dashRuntimes: '/dashboard/runtimes',
  dashModel: '/dashboard/model',
  dashSandbox: '/dashboard/sandbox',
  dashSettings: '/dashboard/settings',
}

export const DASHBOARD_VIEWS: NavView[] = ['dashSkills', 'dashAgents', 'dashBots', 'dashRuntimes', 'dashModel', 'dashSandbox', 'dashSettings']

export function isDashboardView(view: NavView): boolean {
  return DASHBOARD_VIEWS.includes(view)
}

export function viewFromPath(pathname: string): NavView {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (p === '/new' || p === '/new-agent') return 'flow'
  if (p === '/new-skill') return 'newSkill'
  if (p === '/skills') return 'communitySkills'
  if (p === '/agents' || p === '/community') return 'communityAgents'
  if (p === '/dashboard/skills') return 'dashSkills'
  if (p === '/dashboard/bots') return 'dashBots'
  if (p === '/dashboard/runtimes' || p === '/runtime') return 'dashRuntimes'
  if (p === '/dashboard/model') return 'dashModel'
  if (p === '/dashboard/sandbox') return 'dashSandbox'
  if (p === '/dashboard/settings') return 'dashSettings'
  if (p === '/dashboard/agents' || p === '/dashboard' || p === '/agent') return 'dashAgents'
  return 'dashAgents'
}
