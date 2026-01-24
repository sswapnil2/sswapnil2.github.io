# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install        # Install dependencies
npm run dev        # Start development server (localhost:4321)
npm run build      # Build for production (outputs to dist/)
npm run preview    # Preview production build locally
```

## Architecture

This is a personal portfolio and blog built with **Astro** (v4+) using MDX for markdown content.

### Key Directories

- `src/content/blog/` - Blog posts as markdown files with frontmatter (title, description, date, tags, draft)
- `src/pages/` - Astro page components defining routes
- `src/layouts/` - BaseLayout.astro (main wrapper) and BlogPost.astro (post-specific)
- `src/styles/global.css` - CSS custom properties for theming (light/dark mode)

### Content System

Blog posts use Astro's content collections API. Schema defined in `src/content/config.ts`:
- Required: `title`, `description`, `date`
- Optional: `tags` (string array), `draft` (boolean, hides from production)

### Routing

- `/` - Homepage (index.astro)
- `/blog` - Blog listing
- `/blog/[slug]` - Dynamic blog post routes via `[...slug].astro`

### Theming

Dark mode implemented via `data-theme` attribute on `<html>`. Theme toggle persists to localStorage and respects system preference.

### Deployment

GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys to GitHub Pages on push to `master`. Site URL: `https://sswapnil2.github.io`

### TypeScript

Path alias configured: `@/*` maps to `src/*`
