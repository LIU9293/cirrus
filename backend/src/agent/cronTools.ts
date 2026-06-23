import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Type as TypeNS } from '@earendil-works/pi-ai'
import type { CronJob } from '../../../shared/protocol.ts'
import { createCronJob, deleteCronJob, listCronJobs, updateCronJob } from '../cronStore.ts'
import { loadRuntime } from '../runtimeStore.ts'
import { isValidCron } from '../cron.ts'

// Cron CRUD as pi-agent tools, scoped to one runtime. Shared by the dedicated
// scheduling assistant (cronAssistant) and the main runtime chat agent, so both
// can create/edit/delete scheduled tasks. Each tool loads the runtime fresh so
// ownerId + agent keys are always current.

type Type = typeof TypeNS

function toolResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], details: payload }
}

function jobSummary(job: CronJob) {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    message: job.message,
    targetAgentKey: job.targetAgentKey ?? null,
    enabled: job.enabled,
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
  }
}

/** Build the cron tools for `runtimeId`. The model may not know it's calling
 *  these inside a runtime, so descriptions are self-contained. */
export function makeCronTools(Type: Type, runtimeId: string): AgentTool[] {
  const requireRuntime = async () => {
    const runtime = await loadRuntime(runtimeId)
    if (!runtime) throw new Error('runtime not found')
    return runtime
  }
  const coerceTarget = (runtimeAgents: { key: string }[], v: unknown): string | null => {
    const key = typeof v === 'string' && v.trim() ? v.trim() : null
    if (key && !runtimeAgents.some((a) => a.key === key)) {
      throw new Error(`Unknown agent key "${key}". Valid keys: ${runtimeAgents.map((a) => a.key).join(', ') || '(none)'}`)
    }
    return key
  }

  return [
    {
      name: 'list_cron_jobs',
      label: 'List cron jobs',
      description: 'List the scheduled tasks (cron jobs) in this runtime, with ids, schedules, targets, and enabled state.',
      parameters: Type.Object({}),
      execute: async () => toolResult({ ok: true, jobs: (await listCronJobs(runtimeId)).map(jobSummary) }),
      executionMode: 'sequential',
    },
    {
      name: 'create_cron_job',
      label: 'Create cron job',
      description:
        'Schedule a recurring task: on the cron schedule, `message` is sent to an agent in this runtime as if the user typed it. ' +
        'schedule is a standard 5-field cron expression ("min hour day-of-month month day-of-week"), e.g. "0 9 * * 1-5" = weekdays 09:00. ' +
        'Times use the server timezone. Set targetAgentKey to a runtime agent key, or omit to auto-route.',
      parameters: Type.Object({
        name: Type.String(),
        schedule: Type.String(),
        message: Type.String(),
        targetAgentKey: Type.Optional(Type.String()),
      }),
      execute: async (_id, rawArgs) => {
        const args = rawArgs as any
        try {
          if (!isValidCron(String(args?.schedule ?? ''))) throw new Error(`Invalid cron schedule "${args?.schedule}"`)
          const runtime = await requireRuntime()
          const job = await createCronJob({
            runtimeId,
            ownerId: runtime.ownerId,
            name: String(args?.name ?? ''),
            schedule: String(args?.schedule ?? ''),
            message: String(args?.message ?? ''),
            targetAgentKey: coerceTarget(runtime.agents, args?.targetAgentKey),
          })
          return toolResult({ ok: true, job: jobSummary(job) })
        } catch (err) {
          return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'update_cron_job',
      label: 'Update cron job',
      description: 'Update a scheduled task by id. Include only the fields to change. Use enabled=false to pause it.',
      parameters: Type.Object({
        id: Type.String(),
        name: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String()),
        message: Type.Optional(Type.String()),
        targetAgentKey: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, rawArgs) => {
        const args = rawArgs as any
        try {
          if (args?.schedule !== undefined && !isValidCron(String(args.schedule))) throw new Error(`Invalid cron schedule "${args.schedule}"`)
          const runtime = await requireRuntime()
          const job = await updateCronJob(String(args?.id ?? ''), {
            name: args?.name !== undefined ? String(args.name) : undefined,
            schedule: args?.schedule !== undefined ? String(args.schedule) : undefined,
            message: args?.message !== undefined ? String(args.message) : undefined,
            targetAgentKey: args?.targetAgentKey !== undefined ? coerceTarget(runtime.agents, args.targetAgentKey) : undefined,
            enabled: args?.enabled !== undefined ? Boolean(args.enabled) : undefined,
          })
          if (!job) throw new Error(`No cron job with id "${args?.id}"`)
          return toolResult({ ok: true, job: jobSummary(job) })
        } catch (err) {
          return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'delete_cron_job',
      label: 'Delete cron job',
      description: 'Delete a scheduled task permanently by id.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, rawArgs) => {
        const id = String((rawArgs as any)?.id ?? '')
        const ok = await deleteCronJob(id)
        return toolResult(ok ? { ok: true } : { ok: false, error: `No cron job with id "${id}"` })
      },
      executionMode: 'sequential',
    },
  ]
}
