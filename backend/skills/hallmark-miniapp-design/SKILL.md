---
name: hallmark-miniapp-design
description: Use when designing or redesigning Terr miniapps so the generated UI has a deliberate structure, polished visual system, and responsive product-quality craft.
---

# Hallmark Miniapp Design

Use Hallmark design discipline for every new miniapp and every visual redesign.
Adapt it to this runtime: you are building a compact product surface inside a
sandboxed iframe, not a marketing site. The output must still obey the miniapp
spec: React + Tailwind + TerrUI only.

## Design Flow

1. Read the user's brief and infer the app's audience, primary use case, and
   tone. If the request is brand/style-sensitive and one of those is genuinely
   unknowable, ask one short clarifying question. Otherwise proceed.
2. Pick a structural fingerprint before styling. Choose a layout shape that fits
   the app's job: workbench, document pad, dense table, split editor, timeline,
   catalogue, board, dashboard, checklist, or form-led flow. Do not reuse the
   same default header-card-list structure for every miniapp.
3. Pick a genre: utilitarian for operational tools, modern-minimal for SaaS/API
   surfaces, playful for casual consumer tools, editorial for reading/writing,
   atmospheric only when the brief asks for immersive or media-heavy mood.
4. Establish a small token system in the component source when useful: surface,
   ink, muted ink, border, accent, danger, success, radius, shadow, and spacing.
   Use Tailwind utilities for layout and component states; avoid dynamic Tailwind
   class names that the build cannot see.
5. Stamp the main source with a short comment:
   `Hallmark miniapp - genre: <genre> - structure: <shape> - critique: P/H/E/S/R/V`.

## Anti-Slop Gates

- No purple/blue/pink gradient hero, gradient text, floating orbs, bokeh blobs,
  glass panels without purpose, fake browser/phone/IDE chrome, generic emoji
  icons, or fabricated metrics/testimonials.
- Do not center everything. Bias the layout with a useful sidebar, rail, split,
  pinned control area, asymmetric grid, or strong reading column.
- Avoid card-in-card nesting and identical three-card feature rows. Cards are
  allowed only when they represent repeated user data or a genuinely framed tool.
- Do not use oversized landing-page hero treatment for operational miniapps.
  The first viewport should be the usable app, not a marketing prelude.
- Buttons, tabs, chips, and menu items must have default, hover, focus-visible,
  active, disabled/loading states where relevant.
- Hover-only affordances need a touch/click/focus path.

## Responsive Gates

- Design mobile-first for 320, 375, 414, and 768 px widths.
- No horizontal scroll. Use `minmax(0, 1fr)`, `min-w-0`, and
  `overflow-wrap:anywhere` for long user content.
- Prefer content-driven breakpoints and `clamp()` for large type. Do not use
  viewport-width font scaling.

## Miniapp-Specific Craft

- Preserve app state clarity above decoration. The user should immediately see
  what is saved, what can be edited, and what the agent button will do.
- Agent-powered controls should look purposeful: label the action plainly,
  expose pending/result states, and place the control near the data it affects.
- If redesigning an existing miniapp, keep its manifest/state/action contract
  unless the user explicitly asks for behavior changes.
