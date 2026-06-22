---
name: shadcn-ui
description: Use when designing miniapp interfaces with shadcn/ui-informed component composition, semantic styling, accessible states, and common product patterns.
---

# shadcn/ui Miniapp Skill

Use shadcn/ui knowledge to shape component composition and interaction patterns.
The official shadcn skill gives assistants project-aware context about
components, patterns, CLI commands, theming, registries, and MCP workflows. In
this Terr miniapp runtime, adapt those ideas to the available stack.

## Runtime Boundary

- Miniapps may only import `react`, `@/terrui`, and local files.
- Do not import `@/components/ui/*`, Radix, shadcn packages, or any npm package
  inside generated miniapp code unless the Terr miniapp spec explicitly changes.
- Build shadcn-like primitives directly with React and Tailwind utilities:
  buttons, cards, fields, badges, tabs, toggles, separators, lists, tables,
  dialogs, and empty states.
- Prefer semantic tokens and roles over decorative styling.

## Composition Rules

- Use `FieldGroup`-style grouping for forms: label, control, helper/error text,
  and action grouped predictably.
- Use toggle groups or segmented controls for mutually exclusive options.
- Use tabs for switching views, not for one-off filters.
- Use tables or dense lists for comparable records.
- Use cards only for real repeated items or framed tools; avoid nested cards.
- Use badges for state, category, or metadata. Keep badges short.
- Use destructive styling only for destructive actions.

## Styling Rules

- Use semantic surfaces: background, foreground, muted, border, accent,
  destructive, success, warning.
- Prefer quiet borders, clear focus-visible rings, and consistent radii.
- Every interactive control needs hover, focus-visible, active, disabled, and
  loading states where relevant.
- Keep spacing systematic: compact operational tools should feel dense but not
  cramped.
- Use icons only when they clarify a command or state.

## Agent-Native Miniapp Rules

- Place agent-powered actions near the data they affect.
- Show pending states on agent buttons.
- Make state persistence obvious: counters, lists, forms, and selections should
  clearly communicate what has been saved.
- For forms, validate simple local input before calling an agent action.

## Source

Adapted from the shadcn/ui Skills documentation:
https://ui.shadcn.com/docs/skills
