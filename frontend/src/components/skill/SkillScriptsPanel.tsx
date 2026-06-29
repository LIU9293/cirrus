import { useEffect, useRef, useState } from 'react'
import { Code2, FileText, Loader2, Play, Send, Sparkles } from 'lucide-react'
import type { SkillToolCall } from '@shared/protocol'
import { getSkillFile, listSkillFiles, refineSkillFile, testSkillFile } from '@/lib/api'
import { FileTree } from '@/components/magicui/file-tree'
import { CodeBlock } from '@/components/ui/code-block'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { cn } from '@/lib/utils'

// A floating tab — like the agent's "manage Mini App" window, but the canvas is a
// read-only code/README viewer. Left: file tree. Middle: the file (highlighted)
// plus a sandbox Test. Right: a dedicated chat column where the agent rewrites the
// file. All edits go through the agent — no manual editing here.

type ChatMsg = { role: 'user' | 'ai'; text: string }

export function SkillScriptsPanel({
  skillId,
  skillName,
  tools: _tools,
  initialPath,
  onClose,
  onReadmeChange,
}: {
  skillId: string
  skillName: string
  tools: SkillToolCall[]
  initialPath: string | null
  onClose: () => void
  onReadmeChange?: (readme: string) => void
}) {
  const [paths, setPaths] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(initialPath)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string } | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const language = selected?.endsWith('.md') ? 'md' : 'ts'
  const isReadme = selected === 'skill.md'
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const next = await listSkillFiles(skillId).catch(() => [] as string[])
      setPaths(next)
      const open = initialPath && next.includes(initialPath) ? initialPath : next[0] ?? null
      setSelected(open)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId])

  useEffect(() => {
    if (!selected) return
    setTestOut(null)
    setChat([{ role: 'ai', text: `Ask me to change ${selected.split('/').pop()} and I'll rewrite it for you.` }])
    void getSkillFile(skillId, selected)
      .then(setContent)
      .catch(() => setContent(''))
  }, [skillId, selected])

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight })
  }, [chat, busy])

  const runTest = async () => {
    if (!selected) return
    setBusy(true)
    setTestOut(null)
    try {
      const r = await testSkillFile(skillId, selected)
      setTestOut({ ok: r.ok, text: r.ok ? r.stdout || '(no output)' : r.error || r.stderr || 'failed' })
    } catch (e) {
      setTestOut({ ok: false, text: String((e as Error)?.message ?? e) })
    } finally {
      setBusy(false)
    }
  }

  const sendRefine = async () => {
    const text = input.trim()
    if (!text || !selected || busy) return
    setInput('')
    setChat((c) => [...c, { role: 'user', text }])
    setBusy(true)
    try {
      const r = await refineSkillFile(skillId, selected, text)
      if (r.ok) {
        setContent(r.content)
        if (selected === 'skill.md') onReadmeChange?.(r.content)
      }
      setChat((c) => [...c, { role: 'ai', text: r.message }])
    } catch (e) {
      setChat((c) => [...c, { role: 'ai', text: String((e as Error)?.message ?? e) }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <FloatingPanel
      title={`${isReadme ? 'skill.md' : 'Scripts'} · ${skillName}`}
      subtitle={<span className="font-mono">{selected ?? 'no file'}</span>}
      icon={isReadme ? <FileText className="size-[16px]" /> : <Code2 className="size-[16px]" />}
      onClose={onClose}
      width={940}
      height={600}
    >
        <div className="flex min-h-0 flex-1">
          {/* File tree */}
          <div className="w-[200px] shrink-0 overflow-y-auto border-r border-black/5 bg-white/40 p-2">
            <div className="px-2 pb-1 font-mono text-[10px] tracking-[0.14em] text-ink-tertiary">FILES</div>
            <FileTree paths={paths} selected={selected} onSelect={setSelected} />
          </div>

          {/* Code / README viewer (read-only) */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-black/5">
            <div className="flex items-center gap-2 border-b border-black/5 px-3 py-2">
              <span className="font-mono text-[11.5px] text-ink-secondary">{selected ?? '—'}</span>
              {language === 'ts' && (
                <button onClick={runTest} disabled={busy || !selected} className="ml-auto inline-flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-secondary hover:bg-surface-muted disabled:opacity-50">
                  {busy ? <Loader2 className="size-[13px] animate-spin" /> : <Play className="size-[13px]" />} Test
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-white/55 p-3">
              {!selected ? <div className="grid h-full place-items-center text-[13px] text-ink-tertiary">Select a file.</div> : <CodeBlock code={content} language={language} />}
            </div>
            {testOut && (
              <div className={cn('max-h-32 shrink-0 overflow-auto border-t border-black/5 px-3 py-2 font-mono text-[11px] leading-relaxed', testOut.ok ? 'bg-emerald-50/70 text-emerald-800' : 'bg-amber-50/70 text-amber-800')}>
                <div className="mb-1 text-[9.5px] tracking-[0.14em] text-ink-tertiary">{testOut.ok ? 'OUTPUT' : 'ERROR'}</div>
                {testOut.text.slice(0, 1500)}
              </div>
            )}
          </div>

          {/* Dedicated chat column — the agent makes all edits */}
          <div className="flex w-[300px] shrink-0 flex-col bg-white/55">
            <div className="flex items-center gap-2 border-b border-black/5 px-3.5 py-2.5">
              <Sparkles className="size-4 text-primary" />
              <span className="text-[13px] font-semibold text-ink">Edit with agent</span>
            </div>
            <div ref={chatRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
              {chat.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[88%] rounded-[13px] px-3 py-2 text-[12.5px] leading-relaxed', m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border border-border bg-white text-ink')}>{m.text}</div>
                </div>
              ))}
              {busy && (
                <div className="flex items-center gap-2 pl-1 text-xs text-ink-tertiary">
                  <Loader2 className="size-3.5 animate-spin" /> editing {selected?.split('/').pop()}…
                </div>
              )}
            </div>
            <div className="border-t border-black/5 p-2.5">
              <div className="flex items-center gap-2 rounded-[14px] border border-border-strong bg-surface py-1.5 pl-3 pr-1.5">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void sendRefine()
                    }
                  }}
                  rows={2}
                  placeholder={isReadme ? 'e.g. add a section on rate limits…' : `e.g. implement ${selected?.split('/').pop()} against the server…`}
                  disabled={!selected || busy}
                  className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[13px] text-ink outline-none placeholder:text-ink-tertiary disabled:opacity-50"
                />
                <button onClick={sendRefine} disabled={!input.trim() || busy || !selected} className="inline-flex size-8 shrink-0 items-center justify-center self-end rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40" aria-label="Send">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
    </FloatingPanel>
  )
}
