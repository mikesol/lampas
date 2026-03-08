# Site Design

## Overview

Single-page whitepaper-style site for lampas.dev. Built with Astro, compiles to static HTML. No JS runtime. Lives in `packages/site`.

## Content Structure

Six sections, read top to bottom like a paper:

1. **What Lampas is** — one paragraph, the core idea
2. **Why** — ephemeral compute motivation (serverless, agents, disposable VMs)
3. **How it works** — protocol walkthrough (target, method, callbacks, retry, envelope)
4. **Try it** — live curl example against lampas.dev
5. **Design principles** — request is the spec, no stored credentials, verbatim response, bounded retry, fan-out
6. **The name** — Lampadedromia torch race metaphor

## Visual Design

- Centered content column, ~700px max-width
- System serif font stack (Georgia, Times) for body
- System monospace for code blocks
- Dark text on white/off-white background
- Code blocks with light gray background, no syntax highlighting
- No custom fonts, no loading latency

## What Is Not Included

No navigation, hamburger menu, footer, logo, favicon, analytics, dark mode, animations, or responsive breakpoints beyond basic mobile readability.

## Writing Style

- Complete sentences throughout, no dramatic fragments
- Whitepaper tone — accessible but substantive, not marketing copy
- Draws from ARTICLE.md content but toned down on comedy and self-deprecation
- Readable by anyone who writes code, no PhD required

## Tech

- Astro with static output
- Single `index.astro` page
- Inline `<style>` for CSS, no external stylesheets
- `packages/site/` in the monorepo
