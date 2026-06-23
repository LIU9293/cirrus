import type { ComponentProps } from 'react'
import { MyAgentsPage } from '@/wizard/AgentCanvas'

export function AgentPage(props: ComponentProps<typeof MyAgentsPage>) {
  return <MyAgentsPage {...props} />
}
