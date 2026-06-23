import { ArrowRight } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

export function InteractiveHoverButton({
  children,
  className,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const ariaLabel = props['aria-label'] ?? (typeof children === 'string' ? children : undefined)

  return (
    <a
      aria-label={ariaLabel}
      className={cn(
        'group relative inline-flex w-fit cursor-pointer overflow-hidden rounded-full border bg-background p-2 px-6 text-center font-semibold whitespace-nowrap',
        className,
      )}
      {...props}
    >
      <span className="flex items-center justify-center gap-2">
        <span className="h-2 w-2 rounded-full bg-primary transition-all duration-300 group-hover:scale-[100.8]" />
        <span className="inline-block transition-all duration-300 group-hover:translate-x-12 group-hover:opacity-0">
          {children}
        </span>
      </span>
      <span className="absolute inset-0 z-10 flex translate-x-8 items-center justify-center gap-2 text-primary-foreground opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100">
        <span>{children}</span>
        <ArrowRight className="size-4" />
      </span>
    </a>
  )
}
