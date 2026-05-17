---
version: alpha
name: 大明帝国 · 文件管理
description: "A warm parchment-toned file management system inspired by traditional Chinese classical text readers. The canvas is a rice-paper cream (#f7f3eb), with a light parchment surface hierarchy using warm earth tones. The primary accent is a classical vermillion red (#c0392b) used sparingly for active states and primary actions. Display type uses Noto Serif SC for headings — evoking woodblock-printed books — and Noto Sans SC for body text. The sidebar uses a slightly darker parchment (#ede8dd) to suggest the 'table of contents' panel of a classical book viewer. Decorative elements reference imperial court aesthetics: thin horizontal rules, serifed chapter headings, and warm golden-brown folder icons reminiscent of bound volumes."

colors:
  primary: "#c0392b"
  on-primary: "#ffffff"
  primary-hover: "#a93226"
  primary-muted: "#f5d6d0"
  ink: "#2c1810"
  ink-muted: "#5c4033"
  ink-subtle: "#8b7355"
  ink-tertiary: "#b0a08a"
  canvas: "#f7f3eb"
  surface-1: "#ede8dd"
  surface-2: "#e3dccf"
  surface-3: "#d6cebf"
  hairline: "#d4c9b5"
  hairline-strong: "#bfb49e"
  danger: "#c0392b"
  danger-hover: "#a93226"
  warning: "#d4a017"
  warning-hover: "#b8860b"
  success: "#27713a"
  success-hover: "#1e5c2e"
  word-badge: "#7b4a2e"
  excel-badge: "#3a6b35"
  image-badge: "#6b4c8a"
  text-badge: "#8b7355"
  folder-icon: "#c49a3c"
  folder-open: "#a67c2e"
  overlay: "rgba(44,24,16,0.5)"

typography:
  display-lg:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: -0.5px
  display-md:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.3px
  headline:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.30
    letterSpacing: -0.2px
  body:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.50
    letterSpacing: 0
  body-sm:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  caption:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.30
    letterSpacing: 0.2px
  mono:
    fontFamily: JetBrains Mono, Consolas, monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.50
    letterSpacing: 0
  button:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.20
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  section: 48px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  button-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.canvas}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
  button-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
  sidebar:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    width: 360px
  sidebar-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    padding: 12px 16px
  tree-item:
    textColor: "{colors.ink-muted}"
    typography: "{typography.body-sm}"
    padding: 6px 12px
  tree-item-hover:
    backgroundColor: "{colors.surface-2}"
  tree-item-active:
    backgroundColor: "{colors.primary-muted}"
    textColor: "{colors.on-primary}"
  toolbar:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    padding: 12px 20px
  preview-area:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 24px
  modal:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 24px
  toast:
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 12px 20px
  file-badge:
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: 2px 6px
  header:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.display-md}"
    height: 56px
    padding: 0 24px
  path-input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 8px 14px
  excel-table:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
  word-preview:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 32px
  text-preview:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: 20px
---

## Overview

The File Manager uses a deep navy canvas (`{colors.canvas}` #0a0e1a) with a three-step surface ladder for hierarchy. The system is built for **information density** — file trees, data tables, and document previews need to communicate maximum data with minimal visual noise.

The single chromatic accent is **electric blue** `{colors.primary}` (#3b82f6) — used on primary CTAs, active tree items, and interactive focus states. Three semantic colors (danger red, warning amber, success green) are reserved for the three action buttons.

Typography runs Inter at tight tracking. The sidebar tree uses `{typography.body-sm}` 13px for density; the preview area runs `{typography.body}` 14px for readability. Monospace is reserved for text file previews.

**Key Characteristics:**
- **Dark-canvas tool interface** — `{colors.canvas}` (#0a0e1a) deep navy.
- **Electric blue accent** (`{colors.primary}` #3b82f6) — CTAs, active states, focus rings.
- Three-step surface ladder (canvas → surface-1 → surface-2 → surface-3) carries hierarchy without shadow.
- **File type color coding** — Word blue, Excel green, Image purple, Text gray.
- **Sidebar + content split** — classic developer tool layout with resizable sidebar.
- Semantic action buttons: danger red (move), warning amber (search), success green (delete content).

## Colors

### Brand & Accent
- **Electric Blue** ({colors.primary}): Primary CTA, active tree items, focus rings, links.
- **Blue Hover** ({colors.primary-hover}): Lighter blue for hover states.
- **Blue Muted** ({colors.primary-muted}): Deep blue for active tree item background.

### Surface
- **Canvas** ({colors.canvas}): Default page background — #0a0e1a, deep navy.
- **Surface 1** ({colors.surface-1}): Sidebar, header, toolbar, cards — #111827.
- **Surface 2** ({colors.surface-2}): Sidebar header, hover states, inputs — #1e293b.
- **Surface 3** ({colors.surface-3}): Active/pressed states — #334155.
- **Hairline** ({colors.hairline}): 1px borders between sections.
- **Hairline Strong** ({colors.hairline-strong}): Stronger borders for focus states.

### Text
- **Ink** ({colors.ink}): Headlines, file names, primary content — #f1f5f9.
- **Ink Muted** ({colors.ink-muted}): Secondary info, tree items — #94a3b8.
- **Ink Subtle** ({colors.ink-subtle}): Tertiary info, placeholders — #64748b.
- **Ink Tertiary** ({colors.ink-tertiary}): Disabled states — #475569.

### Semantic
- **Danger** ({colors.danger}): Move/delete operations — #ef4444.
- **Warning** ({colors.warning}): Search operations — #f59e0b.
- **Success** ({colors.success}): Content modification — #10b981.

### File Type Badges
- **Word** ({colors.word-badge}): #2563eb — .doc/.docx files.
- **Excel** ({colors.excel-badge}): #059669 — .xls/.xlsx files.
- **Image** ({colors.image-badge}): #7c3aed — image files.
- **Text** ({colors.text-badge}): #6b7280 — text/code files.

## Typography

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-lg}` | 24px | 700 | 1.15 | -0.5px | App title in header |
| `{typography.display-md}` | 18px | 600 | 1.25 | -0.3px | Modal titles, preview file name |
| `{typography.headline}` | 16px | 600 | 1.30 | -0.2px | Section headers, sidebar title |
| `{typography.body}` | 14px | 400 | 1.50 | 0 | Default body, preview content |
| `{typography.body-sm}` | 13px | 400 | 1.45 | 0 | Tree items, table cells, toolbar |
| `{typography.caption}` | 12px | 500 | 1.30 | 0.2px | File badges, counts, metadata |
| `{typography.button}` | 13px | 500 | 1.20 | 0 | All button labels |
| `{typography.mono}` | 13px | 400 | 1.50 | 0 | Text file preview, code |

## Layout

### Spacing System
- **Base unit**: 4px.
- Sidebar width: 360px (resizable 200–600px).
- Header height: 56px.
- Toolbar height: 48px.
- Tree item height: 32px.
- Button padding: 8px 16px.

### Structure
- **Header**: Full-width top bar with title left, path input + refresh right.
- **Sidebar**: Fixed left panel with tree view, file count badge.
- **Content**: Flex right panel with toolbar (3 action buttons) + preview area.

## Do's and Don'ts

### Do
- Reserve `{colors.canvas}` as the anchor surface.
- Use `{colors.primary}` blue ONLY for: active states, primary CTA, focus rings.
- Use semantic colors consistently: red=move, amber=search, green=modify.
- Apply file type color badges consistently.
- Keep tree items compact (32px height) for density.

### Don't
- Don't ship a light-mode version.
- Don't use accent blue as a surface fill.
- Don't mix semantic action colors (e.g., don't use red for search).
- Don't add gradients or decorative elements.
- Don't use more than one accent on the same component.
