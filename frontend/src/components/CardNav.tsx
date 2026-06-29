import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { gsap } from 'gsap'
import { ArrowUpRight } from 'lucide-react'

type CardNavLink = {
  label: string
  ariaLabel: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
}

export type CardNavItem = {
  label: string
  bgColor: string
  textColor: string
  links: CardNavLink[]
  /** Decorative illustration shown in the card's top-right corner. */
  icon?: ReactNode
}

export interface CardNavProps {
  logo?: ReactNode
  centerSlot?: ReactNode
  items: CardNavItem[]
  rightSlot?: ReactNode
  className?: string
  ease?: string
  baseColor?: string
  menuColor?: string
}

const CLOSED_HEIGHT = 60
const DESKTOP_OPEN_HEIGHT = 260

export function CardNav({
  logo,
  centerSlot,
  items,
  rightSlot,
  className = '',
  ease = 'power3.out',
  baseColor = '#fff',
  menuColor,
}: CardNavProps) {
  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const navRef = useRef<HTMLDivElement | null>(null)
  const cardsRef = useRef<HTMLDivElement[]>([])
  const tlRef = useRef<gsap.core.Timeline | null>(null)
  const animationRef = useRef<gsap.core.Timeline | null>(null)

  const calculateHeight = () => {
    const navEl = navRef.current
    if (!navEl) return DESKTOP_OPEN_HEIGHT

    const isMobile = window.matchMedia('(max-width: 768px)').matches
    if (!isMobile) return DESKTOP_OPEN_HEIGHT

    const contentEl = navEl.querySelector('.card-nav-content') as HTMLElement | null
    if (!contentEl) return DESKTOP_OPEN_HEIGHT

    const previous = {
      visibility: contentEl.style.visibility,
      pointerEvents: contentEl.style.pointerEvents,
      position: contentEl.style.position,
      height: contentEl.style.height,
    }

    contentEl.style.visibility = 'visible'
    contentEl.style.pointerEvents = 'auto'
    contentEl.style.position = 'static'
    contentEl.style.height = 'auto'

    contentEl.offsetHeight
    const contentHeight = contentEl.scrollHeight

    contentEl.style.visibility = previous.visibility
    contentEl.style.pointerEvents = previous.pointerEvents
    contentEl.style.position = previous.position
    contentEl.style.height = previous.height

    return CLOSED_HEIGHT + contentHeight + 16
  }

  const createTimeline = () => {
    const navEl = navRef.current
    if (!navEl) return null

    gsap.set(navEl, { height: CLOSED_HEIGHT, overflow: 'hidden' })
    gsap.set(cardsRef.current, { y: 34, opacity: 0 })

    const tl = gsap.timeline({ paused: true })
    tl.to(navEl, { height: calculateHeight, duration: 0.34, ease })
    tl.to(cardsRef.current, { y: 0, opacity: 1, duration: 0.34, ease, stagger: 0.06 }, '-=0.08')
    return tl
  }

  useLayoutEffect(() => {
    const tl = createTimeline()
    tlRef.current = tl
    return () => {
      tl?.kill()
      animationRef.current?.kill()
      tlRef.current = null
      animationRef.current = null
    }
  }, [ease, items])

  useLayoutEffect(() => {
    const handleResize = () => {
      if (!tlRef.current) return
      tlRef.current.kill()
      const nextTl = createTimeline()
      if (isExpanded) {
        gsap.set(navRef.current, { height: calculateHeight() })
        nextTl?.progress(1)
      }
      tlRef.current = nextTl
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isExpanded])

  const resetMenu = () => {
    animationRef.current?.kill()
    animationRef.current = null
    gsap.killTweensOf([navRef.current, ...cardsRef.current])
    tlRef.current?.pause(0)
    tlRef.current?.eventCallback('onReverseComplete', null)
    setIsHamburgerOpen(false)
    setIsExpanded(false)
    gsap.set(navRef.current, { height: CLOSED_HEIGHT, overflow: 'hidden' })
    gsap.set(cardsRef.current, { y: 34, opacity: 0 })
  }

  const closeMenu = () => {
    const navEl = navRef.current
    if (!navEl) return
    animationRef.current?.kill()
    gsap.killTweensOf([navEl, ...cardsRef.current])
    setIsHamburgerOpen(false)
    const tl = gsap.timeline({
      onComplete: () => {
        setIsExpanded(false)
        gsap.set(navEl, { height: CLOSED_HEIGHT, overflow: 'hidden' })
        gsap.set(cardsRef.current, { y: 34, opacity: 0 })
        animationRef.current = null
      },
    })
    tl.to(cardsRef.current, { y: 20, opacity: 0, duration: 0.2, ease }, 0)
    tl.to(navEl, { height: CLOSED_HEIGHT, duration: 0.28, ease, overflow: 'hidden' }, 0.02)
    animationRef.current = tl
  }

  const toggleMenu = () => {
    const navEl = navRef.current
    if (!navEl) return
    const currentHeight = parseFloat(getComputedStyle(navEl).height)
    const isOpen = isExpanded || currentHeight > CLOSED_HEIGHT + 1
    if (isOpen) {
      closeMenu()
      return
    }
    animationRef.current?.kill()
    gsap.killTweensOf([navEl, ...cardsRef.current])
    setIsHamburgerOpen(true)
    setIsExpanded(true)
    gsap.set(navEl, { height: CLOSED_HEIGHT, overflow: 'hidden' })
    gsap.set(cardsRef.current, { y: 34, opacity: 0 })
    requestAnimationFrame(() => {
      const tl = gsap.timeline({
        onComplete: () => {
          animationRef.current = null
        },
      })
      tl.to(navEl, { height: calculateHeight(), duration: 0.34, ease, overflow: 'hidden' }, 0)
      tl.to(cardsRef.current, { y: 0, opacity: 1, duration: 0.34, ease, stagger: 0.06 }, 0.08)
      animationRef.current = tl
    })
  }

  const setCardRef = (i: number) => (el: HTMLDivElement | null) => {
    if (el) cardsRef.current[i] = el
  }

  return (
    <div
      className={`card-nav-container fixed left-1/2 top-3 z-[260] w-full max-w-[1080px] -translate-x-1/2 px-4 sm:top-4 sm:px-6 lg:px-10 ${className}`}
      data-no-pan
    >
      <nav
        ref={navRef}
        className={`card-nav relative block h-[60px] overflow-hidden rounded-[16px] border border-border bg-surface/95 p-0 shadow-[0_12px_36px_-26px_rgba(25,25,23,0.22)] backdrop-blur-xl will-change-[height] ${isExpanded ? 'open' : ''}`}
        style={{ backgroundColor: baseColor }}
      >
        <div className="card-nav-top absolute inset-x-0 top-0 z-[2] flex h-[60px] items-center justify-between px-2.5 py-2 sm:pl-4">
          <button
            type="button"
            className="group flex h-full w-11 flex-col items-center justify-center gap-[6px] rounded-[12px] text-ink transition-colors hover:bg-surface-muted"
            onClick={toggleMenu}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleMenu()
              }
            }}
            aria-label={isExpanded ? 'Close menu' : 'Open menu'}
            aria-expanded={isExpanded}
            style={{ color: menuColor || undefined }}
          >
            <span
              className={`h-[2px] w-6 bg-current transition-[transform,opacity] duration-300 [transform-origin:50%_50%] group-hover:opacity-75 ${
                isHamburgerOpen ? 'translate-y-[4px] rotate-45' : ''
              }`}
            />
            <span
              className={`h-[2px] w-6 bg-current transition-[transform,opacity] duration-300 [transform-origin:50%_50%] group-hover:opacity-75 ${
                isHamburgerOpen ? '-translate-y-[4px] -rotate-45' : ''
              }`}
            />
          </button>

          <div className="order-1 flex min-w-0 items-center">
            {logo}
          </div>

          <div className="pointer-events-auto absolute left-1/2 top-1/2 flex max-w-[calc(100%-112px)] min-w-0 -translate-x-1/2 -translate-y-1/2 overflow-hidden">
            {centerSlot}
          </div>

          <div className="order-3 flex h-full min-w-0 items-center justify-end">{rightSlot}</div>
        </div>

        <div
          className={`card-nav-content absolute bottom-0 left-0 right-0 top-[60px] z-[1] flex flex-col items-stretch justify-start gap-2 p-2 ${
            isExpanded ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
          } md:flex-row md:items-end md:gap-2.5`}
          aria-hidden={!isExpanded}
        >
          {items.map((item, idx) => (
            <div
              key={`${item.label}-${idx}`}
              ref={setCardRef(idx)}
              className="nav-card relative flex h-auto min-h-[64px] min-w-0 flex-[1_1_auto] select-none flex-col gap-2 overflow-hidden rounded-[10px] p-3 md:h-full md:min-h-0 md:flex-[1_1_0%] md:p-4"
              style={{ backgroundColor: item.bgColor, color: item.textColor }}
            >
              {item.icon && (
                <div className="pointer-events-none absolute right-3 top-3 md:right-4 md:top-4" aria-hidden="true">
                  {item.icon}
                </div>
              )}
              <div className="text-[18px] font-semibold tracking-normal md:text-[20px]">{item.label}</div>
              <div className="mt-auto flex flex-col gap-1">
                {item.links.map((link) => (
                  <button
                    key={link.label}
                    type="button"
                    disabled={link.disabled}
                    onClick={() => {
                      if (link.disabled) return
                      resetMenu()
                      link.onClick?.()
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-left text-[14px] font-medium transition-opacity hover:opacity-75 disabled:cursor-default disabled:opacity-45 md:text-[15px] ${
                      link.active ? 'bg-white/45' : ''
                    }`}
                    aria-label={link.ariaLabel}
                  >
                    <ArrowUpRight className="size-[14px] shrink-0" aria-hidden="true" />
                    {link.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}

export default CardNav
