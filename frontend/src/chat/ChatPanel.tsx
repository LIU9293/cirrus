import { Wrench, Hammer, AlertTriangle, Sparkles, AppWindow, Bot, Database, X, MousePointer2 } from 'lucide-react'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputHeader,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { cn } from '@/lib/utils'
import type { DeveloperChatActivity, DeveloperChatMessage, MiniappRecord } from '@shared/protocol'
import type { CanvasSelectionAttachment, StudioMode } from '@/App'

export type Activity = DeveloperChatActivity
export type UiMessage = DeveloperChatMessage

interface Props {
  mode: StudioMode
  miniapp: MiniappRecord | null
  messages: UiMessage[]
  liveMessages: UiMessage[]
  streaming: boolean
  liveStreaming: boolean
  selectionAttachment: CanvasSelectionAttachment | null
  onClearSelectionAttachment: () => void
  onSend: (text: string) => void
  onLiveSend: (text: string) => void
}

const SUGGESTIONS = [
  'Build a todo list with a button that asks the agent to suggest starter tasks',
  'Make a meeting-notes app where a button asks the agent to summarize the notes',
  'Create a habit tracker with a weekly grid I can toggle',
]

export function ChatPanel({
  mode,
  miniapp,
  messages,
  liveMessages,
  streaming,
  liveStreaming,
  selectionAttachment,
  onClearSelectionAttachment,
  onSend,
  onLiveSend,
}: Props) {
  const handleSubmit = (msg: PromptInputMessage) => {
    const text = msg.text?.trim()
    if (mode === 'dev' && text && !streaming) onSend(text)
    if (mode === 'live' && text && !liveStreaming) onLiveSend(text)
  }

  if (mode === 'live') {
    return (
      <LivePanel
        miniapp={miniapp}
        messages={liveMessages}
        streaming={liveStreaming}
        onSend={onLiveSend}
        onSubmit={handleSubmit}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Miniapp Developer</div>
          <div className="truncate text-xs text-muted-foreground">Describe a miniapp — I build it into the canvas.</div>
        </div>
      </header>

      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center px-4">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => !streaming && onSend(s)}
                className="rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-2xl">
            {messages.map((m) => (
              <DeveloperMessage key={m.id} message={m} streaming={streaming} />
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <div className="border-t border-border p-3">
        <PromptInput onSubmit={handleSubmit} className="mx-auto max-w-2xl">
          <PromptInputBody>
            {selectionAttachment && (
              <PromptInputHeader>
                <SelectionAttachmentPreview attachment={selectionAttachment} onClear={onClearSelectionAttachment} />
              </PromptInputHeader>
            )}
            <PromptInputTextarea placeholder="Describe the miniapp you want…" disabled={streaming} />
          </PromptInputBody>
          <PromptInputFooter>
            <span className="px-1 text-xs text-muted-foreground">{streaming ? 'working...' : 'Enter to send'}</span>
            <PromptInputSubmit status={streaming ? 'streaming' : undefined} disabled={streaming} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

function DeveloperMessage({ message, streaming }: { message: UiMessage; streaming: boolean }) {
  const display = getDisplayMessage(message)

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.activities && message.activities.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {message.activities.map((a, i) => (
              <ActivityRow key={i} activity={a} />
            ))}
          </div>
        )}
        {display.attachment && (
          <div className="mb-2">
            <SelectionMessageAttachment attachment={display.attachment} />
          </div>
        )}
        {display.content ? (
          <MessageResponse>{display.content}</MessageResponse>
        ) : message.role === 'assistant' && streaming ? (
          <span className="text-sm text-muted-foreground">working...</span>
        ) : null}
      </MessageContent>
    </Message>
  )
}

function SelectionAttachmentPreview({
  attachment,
  onClear,
}: {
  attachment: CanvasSelectionAttachment
  onClear: () => void
}) {
  return (
    <div className="group relative w-fit">
      <img
        src={attachment.imageUrl}
        alt="Selected canvas element"
        title={attachment.selection.label}
        className="h-16 w-28 rounded-md border border-border bg-muted object-cover shadow-sm"
      />
      <button
        type="button"
        aria-label="Remove selected element"
        onClick={onClear}
        className="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-90 shadow-sm transition hover:bg-secondary hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function SelectionMessageAttachment({
  attachment,
}: {
  attachment: {
    imageUrl?: string
    label: string
  }
}) {
  return (
    <div className="w-fit">
      {attachment.imageUrl ? (
        <img
          src={attachment.imageUrl}
          alt="Selected canvas element"
          title={attachment.label}
          className="h-14 w-24 rounded-md border border-border bg-muted object-cover shadow-sm"
        />
      ) : (
        <div
          title={attachment.label}
          className="flex h-14 w-24 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground shadow-sm"
        >
          <MousePointer2 className="size-4" />
        </div>
      )}
    </div>
  )
}

function LivePanel({
  miniapp,
  messages,
  streaming,
  onSend,
  onSubmit,
}: {
  miniapp: MiniappRecord | null
  messages: UiMessage[]
  streaming: boolean
  onSend: (text: string) => void
  onSubmit: (msg: PromptInputMessage) => void
}) {
  const suggestions = getLiveSuggestions(miniapp)
  const fields = miniapp?.manifest?.stateModel.fields ?? []
  const actions = miniapp?.manifest?.actions ?? []

  return (
    <div className="flex h-full flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-2xl px-4 py-5">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <AppWindow className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{miniapp?.manifest?.name ?? 'Live app'}</div>
                  <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {miniapp?.manifest?.description ?? 'Chat with this app agent as an end user.'}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {suggestions.map((item) => (
                  <button
                    key={item}
                    onClick={() => !streaming && onSend(item)}
                    className="rounded-lg border border-border px-3 py-2 text-left text-xs leading-5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                  >
                    {item}
                  </button>
                ))}
              </div>

              {(actions.length > 0 || fields.length > 0) && (
                <div className="grid gap-2">
                  {actions.length > 0 && (
                    <LiveInfoRow
                      icon={<Bot className="size-3.5" />}
                      label={`${actions.filter((a) => a.kind === 'agent').length} agent action${actions.filter((a) => a.kind === 'agent').length === 1 ? '' : 's'}`}
                    />
                  )}
                  {fields.length > 0 && (
                    <LiveInfoRow
                      icon={<Database className="size-3.5" />}
                      label={`${fields.length} saved state field${fields.length === 1 ? '' : 's'}`}
                    />
                  )}
                </div>
              )}
            </div>
          ) : (
            messages.map((m) => (
              <Message key={m.id} from={m.role}>
                <MessageContent>
                  {m.content ? (
                    <MessageResponse>{m.content}</MessageResponse>
                  ) : m.role === 'assistant' && streaming ? (
                    <span className="text-sm text-muted-foreground">working...</span>
                  ) : null}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border p-3">
        <PromptInput onSubmit={onSubmit} className="mx-auto max-w-2xl">
          <PromptInputBody>
            <PromptInputTextarea placeholder={`Ask ${miniapp?.manifest?.name ?? 'this app'}…`} disabled={streaming} />
          </PromptInputBody>
          <PromptInputFooter>
            <span className="px-1 text-xs text-muted-foreground">{streaming ? 'working...' : 'Chat with app agent'}</span>
            <PromptInputSubmit status={streaming ? 'streaming' : undefined} disabled={streaming} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

function LiveInfoRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-2 text-xs text-muted-foreground">
      {icon}
      <span>{label}</span>
    </div>
  )
}

function getLiveSuggestions(miniapp: MiniappRecord | null): string[] {
  if (!miniapp?.manifest) {
    return [
      'Create a miniapp in Dev Mode, then switch back here to try it as a user.',
      'Live Mode keeps the developer chat out of the way while you use the canvas.',
      'User-entered app data will stay saved through the TerrUI state bridge.',
    ]
  }

  const actionSuggestions = miniapp.manifest.actions.slice(0, 2).map((action) => {
    const prefix = action.kind === 'agent' ? 'Try the smart action' : 'Try the app action'
    return `${prefix}: ${action.description}`
  })

  const fieldSuggestions = miniapp.manifest.stateModel.fields.slice(0, 2).map((field) => {
    const name = field.name.replace(/[-_]/g, ' ')
    return field.description ? `Update ${name}: ${field.description}` : `Update ${name} and refresh to confirm it stays saved.`
  })

  return [
    ...actionSuggestions,
    ...fieldSuggestions,
    'What can I do with this app?',
  ].slice(0, 4)
}

function getDisplayMessage(message: UiMessage): {
  content: string
  attachment?: {
    imageUrl?: string
    label: string
  }
} {
  if (message.role !== 'user') return { content: message.content }
  const legacy = parseLegacySelectionContext(message.content)
  return {
    content: legacy?.content ?? message.content,
    attachment:
      message.selectionAttachment ??
      (legacy
        ? {
            label: legacy.label,
          }
        : undefined),
  }
}

function parseLegacySelectionContext(content: string): { content: string; label: string } | null {
  const start = content.indexOf('<selected_canvas_element>')
  if (start < 0) return null
  const end = content.indexOf('</selected_canvas_element>', start)
  const visible = content.slice(0, start).trim()
  const metadata = content.slice(start, end >= 0 ? end : undefined)
  const label = metadata.match(/Label:\s*([^\n]+)/)?.[1]?.trim() || 'Selected canvas element'
  return {
    content: visible,
    label,
  }
}

function ActivityRow({ activity }: { activity: Activity }) {
  const icon =
    activity.kind === 'build' ? (
      <Hammer className="size-3.5" />
    ) : activity.kind === 'error' ? (
      <AlertTriangle className="size-3.5" />
    ) : activity.kind === 'status' ? (
      <Sparkles className="size-3.5" />
    ) : (
      <Wrench className="size-3.5" />
    )
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1 text-xs',
        activity.kind === 'error' || activity.ok === false
          ? 'bg-destructive/10 text-destructive'
          : activity.kind === 'build' && activity.ok
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-secondary/60 text-muted-foreground',
      )}
    >
      {icon}
      <span className="truncate">{activity.text}</span>
    </div>
  )
}
