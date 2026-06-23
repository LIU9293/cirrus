import type { ComponentProps } from 'react'
import { AgentCanvas } from '@/wizard/AgentCanvas'

export function AgentFlowPage(props: ComponentProps<typeof AgentCanvas>) {
  return <AgentCanvas {...props} />
}
