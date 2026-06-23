import * as React from 'react'
import { motion } from 'motion/react'
import { Minus, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface MotionAccordionItem {
  question: React.ReactNode
  answer: React.ReactNode
}

export interface MotionAccordionProps {
  items: MotionAccordionItem[]
  gap?: number
  className?: string
}

function AccordionItem({
  item,
  isOpen,
  onToggle,
  itemId,
  panelId,
}: {
  item: MotionAccordionItem
  isOpen: boolean
  onToggle: () => void
  itemId: string
  panelId: string
}) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = React.useState(0)

  React.useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const observer = new ResizeObserver(() => setContentHeight(el.scrollHeight))
    observer.observe(el)
    setContentHeight(el.scrollHeight)

    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      layout
      className="overflow-hidden rounded-[24px] border-none bg-surface-muted text-foreground shadow-xs"
      transition={{ type: 'spring', stiffness: 280, damping: 28, mass: 0.9 }}
      animate={{ scale: isOpen ? 1 : 0.985 }}
      initial={false}
      style={{ originX: 0.5, originY: 0 }}
    >
      <button
        id={itemId}
        type="button"
        aria-controls={panelId}
        aria-expanded={isOpen}
        onClick={onToggle}
        className="flex w-full cursor-pointer select-none items-center justify-between gap-4 px-5 py-3.5 text-left sm:px-6 sm:py-4"
      >
        <span className="text-[16px] font-medium leading-snug text-ink sm:text-[18px]">{item.question}</span>
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ rotate: isOpen ? 180 : 0, scale: isOpen ? 1.05 : 1 }}
          transition={{ type: 'spring', stiffness: 480, damping: 28 }}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink sm:size-10"
        >
          {isOpen ? <Minus className="size-4" /> : <Plus className="size-4" />}
        </motion.span>
      </button>
      <motion.div
        id={panelId}
        role="region"
        aria-labelledby={itemId}
        animate={{ height: isOpen ? contentHeight : 0, opacity: isOpen ? 1 : 0 }}
        initial={false}
        transition={{
          height: { type: 'spring', stiffness: 340, damping: 34, mass: 0.9 },
          opacity: { duration: 0.2, ease: 'easeOut' },
        }}
        style={{ overflow: 'hidden' }}
      >
        <motion.div
          ref={contentRef}
          animate={{ y: isOpen ? 0 : -8 }}
          transition={{ type: 'spring', stiffness: 360, damping: 30, mass: 0.8 }}
          className="px-5 pb-4 sm:px-6 sm:pb-5"
        >
          <p className="text-[15px] leading-7 text-ink-secondary sm:text-[17px] sm:leading-8">{item.answer}</p>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}

export function MotionAccordion({ items, gap = 8, className }: MotionAccordionProps) {
  const rawId = React.useId()
  const baseId = `accordion-${rawId.replace(/:/g, '')}`
  const [openIndex, setOpenIndex] = React.useState<number | null>(null)

  const toggle = (index: number) => setOpenIndex((prev) => (prev === index ? null : index))

  return (
    <div className={cn('w-full', className)}>
      <div className="flex flex-col rounded-[24px] p-2" style={{ gap }}>
        {items.map((item, index) => (
          <AccordionItem
            key={index}
            item={item}
            isOpen={openIndex === index}
            onToggle={() => toggle(index)}
            itemId={`${baseId}-trigger-${index}`}
            panelId={`${baseId}-panel-${index}`}
          />
        ))}
      </div>
    </div>
  )
}
