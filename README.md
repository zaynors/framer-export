# framer-export

Export any Framer website to fully self-hosted local files — no Framer CDN, no Framer branding, no dependencies.

## What it does

1. **Downloads all assets** from Framer's CDN: JS modules, CSS, images, videos, PDFs, audio, documents
2. **Fixes ES module imports** — hash-based CDN filenames renamed to clean local names, all `import` and `import()` paths updated
3. **Discovers all routes** — detects every page (home, blog posts, policy pages, etc.) by scanning for HTML files
4. **Cleans Framer noise** — removes "Made in Framer" badges, editor bars, edit buttons, canvas sandbox iframes
5. **Generates a custom SPA server** — `server.js` with URL→HTML routing, handles page refresh on sub-pages, auto-kills port conflicts

## Setup

```bash
# Install from GitHub (one line)
npm install -g git+https://github.com/zaynors/framer-export.git

# To update to the latest version
npm install -g git+https://github.com/zaynors/framer-export.git --force

# Or clone and run directly
git clone https://github.com/zaynors/framer-export.git
node framer-export/scripts/export.js <url-or-html-file>
```

## Usage

```bash
# Export from a live Framer site
npx framer-export https://your-site.framer.app

# Or from local HTML files
npx framer-export ./my-exported-site/index.html

# Options
--no-clean    Skip Framer noise removal
--no-spa      Skip SPA routing fixes (no server.js generation)
--with-fonts  Also download font files (skipped by default)
```

## After export

```bash
# Start the local server
node server.js

# Or with a custom port
node server.js 3000
```

Then open `http://localhost:8080` (or your chosen port).

## What gets exported

```
project/
├── index.html              # Cleaned homepage
├── server.js               # Custom SPA server (route mapping, port kill)
├── js/
│   ├── bootstrap.js
│   ├── site-script_main.mjs   # SPA router
│   ├── route-*.mjs             # Page modules
│   └── dep-*.mjs               # Shared dependencies
├── css/
├── images/
│   └── [all images, locally hosted]
└── media/
    └── [videos, PDFs, audio, documents]
```

## How it works

The export process runs in 7 steps:

1. **Analyze** — scan the HTML for all external CDN URLs, categorize by type
2. **Download** — fetch all JS, CSS, images, and media to local directories
3. **Fix imports** — rename hash-based module files, update all `import` and `import()` references recursively
4. **Update HTML** — replace CDN URLs with local paths, fix `modulepreload` links, handle `srcset`/favicon/og:image URLs
5. **Clean noise** — surgically remove Framer badge, editor bar, iframe, and related CSS/scripts
6. **Fix SPA routing** — discover all routes from HTML files, update nav links, delete conflicting empty directories
7. **Generate server** — produce a `server.js` that maps URL slugs to HTML files and handles SPA fallback

## Framer-specific notes

- **Route hydration**: Framer bakes `data-framer-hydrate-v2="{routeId:...}"` into each HTML page. Each unique URL needs its own HTML file — this is handled automatically.
- **Font files**: `framerusercontent.com/assets/*.woff2` files carry no Framer branding and are skipped by default to save time.
- **Editor artifacts**: The canvas sandbox iframe and editor bar are editor-only and safely removed.
- **Port conflicts**: The generated `server.js` automatically kills any process occupying its port before starting.

## Skill (Claude Code)

This tool also exists as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills). Install it to use it from within Claude Code:

```
/framer-export https://your-site.framer.app
```

## License

MIT
