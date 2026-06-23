import type { ComponentProps } from 'react'
import { CommunityPage } from '@/wizard/AgentCanvas'

export function CommunityAgentsPage(props: ComponentProps<typeof CommunityPage>) {
  return <CommunityPage {...props} />
}
