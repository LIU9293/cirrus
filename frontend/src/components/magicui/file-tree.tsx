import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, File as FileIcon, Folder as FolderIcon, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

// A small file-tree (magicui-inspired): builds a collapsible tree from a flat
// list of "a/b/c.ts" paths. Folders toggle; files select. Used by the skill
// script viewer to navigate skill.md + tools/*.ts.

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  isFile: boolean
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false }
  for (const full of paths) {
    const segments = full.split('/').filter(Boolean)
    let node = root
    segments.forEach((seg, i) => {
      const isLast = i === segments.length - 1
      let child = node.children.get(seg)
      if (!child) {
        child = { name: seg, path: segments.slice(0, i + 1).join('/'), children: new Map(), isFile: isLast }
        node.children.set(seg, child)
      }
      if (isLast) child.isFile = true
      node = child
    })
  }
  return root
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1 // folders first
    return a.name.localeCompare(b.name)
  })
}

export function FileTree({
  paths,
  selected,
  onSelect,
  className,
}: {
  paths: string[]
  selected: string | null
  onSelect: (path: string) => void
  className?: string
}) {
  const root = useMemo(() => buildTree(paths), [paths])
  return (
    <div className={cn('select-none text-[12.5px]', className)}>
      {sortedChildren(root).map((node) => (
        <TreeRow key={node.path} node={node} depth={0} selected={selected} onSelect={onSelect} />
      ))}
      {paths.length === 0 && <div className="px-2 py-3 text-[12px] text-ink-tertiary">No files yet.</div>}
    </div>
  )
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}): ReactNode {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: 8 + depth * 14 }

  if (node.isFile) {
    const active = selected === node.path
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-[7px] py-1.5 pr-2 text-left transition',
          active ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-ink-secondary hover:bg-surface-muted',
        )}
      >
        <FileIcon className="size-[14px] shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pad}
        className="flex w-full items-center gap-1.5 rounded-[7px] py-1.5 pr-2 text-left font-medium text-ink hover:bg-surface-muted"
      >
        <ChevronRight className={cn('size-[13px] shrink-0 text-ink-tertiary transition-transform', open && 'rotate-90')} />
        {open ? <FolderOpen className="size-[14px] shrink-0 text-accent-ink" /> : <FolderIcon className="size-[14px] shrink-0 text-accent-ink" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && sortedChildren(node).map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </div>
  )
}
