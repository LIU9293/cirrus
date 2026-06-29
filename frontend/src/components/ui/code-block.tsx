import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// A self-contained code renderer: line numbers + lightweight TS/JS/Markdown
// syntax highlighting (regex tokenizer, no dependency). Read-only display used
// by the skill script viewer.

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'await', 'async',
  'new', 'class', 'extends', 'import', 'from', 'export', 'default', 'of', 'in', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false', 'this', 'globalThis', 'void', 'yield',
])

type Tok = { text: string; cls?: string }

// Tokenize one line of code, carrying block-comment state across lines.
function tokenizeCode(line: string, inBlock: boolean): { toks: Tok[]; inBlock: boolean } {
  const toks: Tok[] = []
  let i = 0
  let block = inBlock
  const push = (text: string, cls?: string) => text && toks.push({ text, cls })

  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) { push(line.slice(i), 'text-ink-tertiary italic'); i = line.length; break }
      push(line.slice(i, end + 2), 'text-ink-tertiary italic'); i = end + 2; block = false
      continue
    }
    const rest = line.slice(i)
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) { push(line.slice(i), 'text-ink-tertiary italic'); i = line.length; block = true; break }
      push(line.slice(i, end + 2), 'text-ink-tertiary italic'); i = end + 2; continue
    }
    if (rest.startsWith('//')) { push(line.slice(i), 'text-ink-tertiary italic'); break }
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) { if (line[j] === '\\') j++; j++ }
      push(line.slice(i, Math.min(j + 1, line.length)), 'text-emerald-600'); i = j + 1; continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++
      const word = line.slice(i, j)
      push(word, KEYWORDS.has(word) ? 'font-medium text-violet-600' : undefined)
      i = j; continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < line.length && /[0-9.]/.test(line[j])) j++
      push(line.slice(i, j), 'text-amber-600'); i = j; continue
    }
    push(ch)
    i++
  }
  return { toks, inBlock: block }
}

function markdownLine(line: string): Tok[] {
  if (/^#{1,6}\s/.test(line)) return [{ text: line, cls: 'font-bold text-ink' }]
  if (/^\s*[-*]\s/.test(line)) return [{ text: line, cls: 'text-ink-secondary' }]
  if (/^```/.test(line)) return [{ text: line, cls: 'text-ink-tertiary' }]
  return [{ text: line }]
}

export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  const isMarkdown = language === 'md' || language === 'markdown'
  const lines = code.replace(/\n$/, '').split('\n')
  let inBlock = false
  const rendered: ReactNode[] = lines.map((line, idx) => {
    let toks: Tok[]
    if (isMarkdown) {
      toks = markdownLine(line)
    } else {
      const out = tokenizeCode(line, inBlock)
      toks = out.toks
      inBlock = out.inBlock
    }
    return (
      <div key={idx} className="flex">
        <span className="select-none pr-3 text-right text-ink-tertiary/60" style={{ minWidth: 38 }}>{idx + 1}</span>
        <span className="whitespace-pre-wrap break-words text-ink">
          {toks.length ? toks.map((t, k) => <span key={k} className={t.cls}>{t.text}</span>) : ' '}
        </span>
      </div>
    )
  })
  return (
    <pre className={cn('overflow-auto font-mono text-[12.5px] leading-[1.6]', className)}>
      <code>
        {rendered.map((node, i) => (
          <Fragment key={i}>{node}</Fragment>
        ))}
      </code>
    </pre>
  )
}
