---
name: frontend-developer-skill
description: Use when designing or building any Cirrus miniapp UI. Covers the runtime boundary, shadcn-informed component composition, the responsive/agent-native craft rules, and the three selectable visual styles (Default / Modern / Custom).
---

# Frontend Developer Skill

The single design discipline for every Cirrus miniapp build and redesign. You are
building a compact, product-quality surface inside a sandboxed iframe — not a
marketing site. Always obey the miniapp spec: **React + Tailwind + CirrusUI
(`@/terrui`) only**.

## Runtime Boundary (always)

- Miniapps may only import `react`, `@/terrui`, and local files.
- Do NOT import `@/components/ui/*`, Radix, shadcn packages, or any npm package
  inside generated miniapp code — including component libraries like reactbits or
  Aceternity. The sandbox cannot resolve them.
- We use **shadcn/ui as the conceptual base**: recreate shadcn-like primitives
  directly with React + Tailwind utilities (buttons, cards, fields, badges, tabs,
  toggles, segmented controls, separators, lists, tables, dialogs, empty states).
  Prefer semantic tokens and roles over decorative styling.
- When a style below references an external library, treat it as an **aesthetic
  reference to reproduce by hand** with Tailwind — never as an import.

## Choosing the style

The creator picks a style for the build; the system prompt tells you which one is
active. Follow that section. If none is specified, use **Default**.

### Default — the Terr look

Use shadcn-like primitives styled to match Terr's "Fantastic Planet" design
system: warm, editorial, minimal-yet-crafted. Recreate the feel with Tailwind:

- **Color**: warm neutrals, never cool grey. Warm off-white background, warm
  "sand" surfaces, deep warm-brown ink for text, warm-grey hairline borders.
  Signature accent is a **coral/orange**, used sparingly for primary actions,
  active indicators, and hover. Approx tokens (adapt as CSS vars in source):
  bg `oklch(0.975 0.012 76)`, surface `oklch(0.948 0.018 62)`, border
  `oklch(0.815 0.018 58)`, ink `oklch(0.24 0.015 58)`, coral `oklch(0.64 0.16 48)`,
  coral-deep `oklch(0.54 0.14 48)`, danger `oklch(0.50 0.152 24)`.
- **Type**: clean sans for body/UI (Inter / IBM Plex Sans / system); large
  headings in a **light weight (300)** with slight negative tracking; **uppercase
  labels** with wide letter-spacing (~0.12em); monospace (Fira Code / ui-monospace)
  for technical labels. If a web font isn't available, fall back to the system
  sans but keep the light-weight large-heading treatment.
- **Shape**: radius ~6px on components, ~10px on inputs, full-round (999px) on
  pills/chips. Quiet 1px borders over heavy shadows; soft inset highlight +
  gentle drop shadow for depth. Cards lift slightly on hover (`translateY(-2px)`).
- **Buttons**: min-height ~2.75rem, uppercase label, letter-spacing ~0.04em.
  Primary = dark ink background, chalk text, subtle inset+drop shadow; secondary
  = light surface, ink text; ghost = transparent with hover tint; danger = red.
  Active state scales to ~0.96.
- **Motion**: `cubic-bezier(0.22, 1, 0.36, 1)`, 150ms quick / 200–250ms standard.
- **Feel**: generous spacing, open layouts, breathing room. Coral is the only
  loud color; everything else stays warm and quiet.

### Modern — expressive component-library look

Go beyond the base shadcn primitives with the kind of motion and polish seen in
**reactbits.dev** and **ui.aceternity.com/components** — reproduced by hand in
React + Tailwind (no imports). Also apply the structural/craft discipline below.

- Reach for tasteful gradients, animated borders/glows, spotlight and hover
  effects, subtle parallax, gradient/animated text, marquees, bento grids,
  glassmorphism, and entrance animations (fade/slide/scale on mount or scroll).
- Use CSS transitions/animations and `requestAnimationFrame`; keep it performant
  and respect `prefers-reduced-motion`.
- Pick a strong, coherent palette and a clear structural fingerprint (bento,
  split, dashboard, timeline) — modern does NOT mean random flourish.
- Still forbidden even in Modern: fake browser/phone/IDE chrome, fabricated
  metrics/testimonials, generic emoji icon walls, and decoration that hurts
  usability. The app must stay legible and obviously usable on first view.

### Custom — follow the creator

Defer to the creator's prompt for look and feel. Give them only the most basic
shadcn-like primitives (unstyled-but-accessible buttons, inputs, cards) and let
their instructions drive color, type, density, and motion. Do not impose the
Terr palette or modern effects unless they ask. When the prompt is silent on a
visual detail, choose the simplest neutral option.

## Composition Rules (all styles)

- Group form controls predictably: label, control, helper/error text, action.
- Use toggle groups / segmented controls for mutually exclusive options; tabs for
  switching views (not one-off filters); tables or dense lists for comparable
  records; cards only for repeated user data or a genuinely framed tool (never
  card-in-card).
- Use badges for state/category/metadata; keep them short. Destructive styling
  only for destructive actions.
- Every interactive control needs hover, focus-visible, active, disabled, and
  loading states where relevant. Hover-only affordances need a touch/focus path.

## Structure & Anti-Slop (Default and Custom; relaxed for Modern)

- Pick a structural fingerprint before styling — workbench, document pad, dense
  table, split editor, timeline, catalogue, board, dashboard, checklist, or
  form-led flow. Don't reuse the same header-card-list shell for every app.
- Don't center everything: bias with a sidebar, rail, split, pinned controls,
  asymmetric grid, or strong reading column.
- For Default/Custom, avoid purple/blue/pink gradient heroes, floating orbs,
  bokeh blobs, purposeless glass, and oversized landing-page hero treatment for
  operational tools. The first viewport should be the usable app. (Modern may use
  these tastefully — see above.)

## Responsive Gates (all styles)

- Design mobile-first for 320, 375, 414, and 768 px widths. No horizontal scroll.
- Use `minmax(0, 1fr)`, `min-w-0`, and `overflow-wrap: anywhere` for long content.
- Prefer content-driven breakpoints and `clamp()` for large type; do not scale
  fonts by viewport width.

## Agent-Native Miniapp Craft (all styles)

- Preserve app-state clarity above decoration: the user should immediately see
  what is saved, what can be edited, and what each agent button will do.
- Place agent-powered controls near the data they affect; label the action
  plainly and expose pending/result states.
- For forms, validate simple local input before calling an agent action.
- When redesigning, keep the manifest/state/action contract unless the creator
  explicitly asks for behavior changes.
- Stamp the main source with a short comment:
  `Cirrus miniapp - style: <default|modern|custom> - structure: <shape>`.

## Source

Adapted from the shadcn/ui Skills docs (https://ui.shadcn.com/docs/skills), Terr's
"Fantastic Planet" design system, and the expressive patterns of reactbits.dev and
ui.aceternity.com — all reproduced within the React + Tailwind + CirrusUI boundary.
