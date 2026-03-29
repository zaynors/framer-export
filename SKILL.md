---
name: framer-export
description: Export a Framer website to fully local HTML/JS/CSS with no CDN dependencies. Use when the user wants to self-host a Framer site, remove Framer branding, or create an offline-capable version. Works on any Framer-exported site.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Write, Edit, Glob, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Framer Exporter Skill

Export any Framer website to fully self-hosted local files with no Framer CDN dependencies.

## What This Does

1. **Downloads all assets** — JS, CSS, images, video, PDF, audio, and other files from Framer CDN to local `js/`, `css/`, `images/`, `media/` folders
2. **Fixes ES module imports** — Updates all `import` and `import()` paths to use local filenames, including `modulepreload` links
3. **Handles multi-page exports** — Detects and processes all HTML pages (blog posts, policy pages, sub-routes) with their unique `data-framer-hydrate-v2` routeIds
4. **Removes Framer noise** — Strips "Made in Framer" badges, editor bars, and Framer branding precisely
5. **Fixes SPA routing** — Updates nav links, deletes conflicting directories, generates a custom `server.js` with URL-to-HTML mapping

## Usage

### Export a live Framer site
```
/framer-export https://example.framer.app
```

### Export from local HTML files
```
/framer-export ./my-exported-site
```

## Workflow

### Step 1: Analyze the site
- If URL: download the HTML and scan for all external CDN URLs
- If local: scan all HTML files for CDN references
- Categorize: JS files, CSS files, images, media (video/PDF/audio/documents), fonts
- **Detect all page routes**: Every `.html` file found represents a unique route (homepage `/`, `/blogs`, `/pricing`, `/terms-conditions`, `/blogs/slug-title`, etc.)
- Each HTML file contains `data-framer-hydrate-v2="{routeId:...}"` — this JSON determines which page renders on the client and is baked in at download time, so each route needs its own HTML file
- Log all discovered routes

### Step 2: Create local asset directories
Create `js/`, `css/`, `images/`, `media/` directories alongside `index.html`.

### Step 3: Download all external resources
Download all JS, CSS, images, and media files (video, PDF, audio, documents) to local directories. Skip fonts by default unless user requests them (fonts from `framerusercontent.com/assets/*.woff2` are OK to keep external — they carry no visible branding).

### Step 4: Fix ES module imports in JS files
Many Framer exports have `import` statements referencing CDN filenames like `7zd_4hdYd8O.mjs`. Rename these to short local names and update all import paths:
- `from "./7zd_4hdYd8O-dG7PZxJrnFUX2tGHHFGd1cKXxhsQWgA.B72Ql4Dm.mjs"` → `from "./site-home.mjs"`
- Also fix dynamic imports: `` import(`./filename.mjs`) ``
- **Also fix `modulepreload` links**: `<link rel="modulepreload" href="./PX9hIOIVM.BKfS3pIK.mjs">` → `<link rel="modulepreload" href="/js/site-route.mjs">`

### Step 5: Update HTML references
Replace all CDN URLs in HTML files with local paths:
- `https://framer.com/bootstrap.js` → `js/bootstrap.js`
- `https://app.framerstatic.com/chunk-XXX.mjs` → `js/chunk-XXX.mjs`
- Images in `src=`: `https://framerusercontent.com/images/xxx.png?width=101` → `images/xxx.png` (strip query params)
- Images in `srcset=`: same treatment, strip query params
- Images in `href=` (favicons): same treatment
- Images in `content=` (og:image meta tags): same treatment
- Media (video/PDF/audio): `https://framerusercontent.com/files/xxx.pdf` → `media/xxx.pdf`
- `modulepreload` links: add `/js/` prefix to hash-based filenames

### Step 6: Remove Framer noise
Target these elements precisely (do NOT remove surrounding HTML):
- `<!-- Made in Framer -->` comment
- `<div id="__framer-badge-container">...</div>` — the entire div with all its nested content (contains `</a><!--/$--><!--/$--><!--/$--></div>`)
- `<div id="__framer-editorbar-container">` (Edit button wrapper)
- `<div id="__framer-editorbar">` (editor iframe)
- `#__framer-badge-container` CSS rules
- `#__framer-editorbar*` CSS rules (container, label, button, loading-spinner)
- `<link rel="stylesheet" href="...editorbar.css">` link tags
- `cssBundleURL`, `deferredJsFiles` `<script>` blocks
- Editorbar `<script>` tags (src attributes containing "editorbar")
- `modulepreload` links to editorbar modules
- `class="notranslate editorbar "` → `class="notranslate "` on body
- `<div id="drag-overlay">` and `<div id="canvas_sandbox">` elements
- `<!-- Published -->` comments

### Step 7: Fix SPA routing
1. Delete empty static HTML directories (blog/, support/, etc.) that override SPA routes — but ONLY if they contain no actual HTML files (only empty subdirectories)
2. Update nav links from `.html` paths to SPA routes: `href="blog/index.html"` → `href="/blog"`, `href="pricing.html"` → `href="/pricing"`
3. Generate a custom `server.js` that maps each discovered URL slug to its HTML file — this handles refresh on sub-pages correctly
4. The `server.js` should:
   - Kill any existing process on the target port before starting
   - Serve static files normally
   - For any unknown route, serve the correct HTML file based on slug mapping (e.g. `/blogs/some-post` → `blogs/some-post.html`)

### Step 8: Verify
- Run: `node server.js` (generated custom server)
- Test all routes: homepage, /blog, /support, /pricing, /terms-conditions, /blogs/slug-title, etc.
- Test page refresh on each sub-page
- Check Network tab for 404s
- Check for "Made in Framer" text anywhere on the page

## Important Framer Patterns

### data-framer-hydrate-v2
Framer bakes `data-framer-hydrate-v2="{routeId:...,...}"` JSON into each HTML page. This routeId is set at download time — each unique URL needs its own HTML file because the routeId cannot be dynamically changed after download.

### CDN import paths to fix
Framer uses hash-based filenames. Common patterns:
```
https://framer.com/bootstrap.[hash].js
https://app.framerstatic.com/chunk-[hash].mjs
https://framerusercontent.com/sites/[siteId]/[hash].mjs
```

### Route modules
Framer SPAs define routes in `site-script_main.mjs`:
```javascript
W = {
  routeId: { page: () => import('./route-page.mjs'), path: '/path' },
  ...
}
```
The route `.mjs` files often import each other — must update ALL import paths recursively.

### Dynamic imports in route files
Route files often import other modules dynamically:
```javascript
page: E(() => import(`./some-file.mjs`))
```
These also need fixing.

### Image URL variants
Framer URLs appear in multiple attributes:
```html
src="https://framerusercontent.com/images/xxx.png?width=101&height=101"
srcset="https://framerusercontent.com/images/xxx.png?w=800 800w, ..."
href="https://framerusercontent.com/images/xxx.png?..." (favicon)
content="https://framerusercontent.com/images/xxx.png?..." (og:image)
```
Strip query parameters from all of these and map to `images/`.

### Framer font files
`framerusercontent.com/assets/*.woff2` custom fonts — these are design fonts with no Framer branding. It's acceptable to keep them as external references. Skip by default, offer `--with-fonts` to download.

## Output Structure
```
project/
├── index.html              (cleaned, local refs)
├── server.js               (custom SPA server with URL→HTML mapping)
├── js/
│   ├── bootstrap.js
│   ├── site-script_main.mjs
│   ├── site-[name].mjs
│   ├── route-[page].mjs
│   └── ...
├── css/
│   └── editorbar.css
├── images/
│   └── [all images]
└── media/
    └── [videos, PDFs, audio, documents, etc.]
```

## Edge Cases
- **Port conflicts**: Kill existing processes on the port before starting server (`taskkill //F //IM node.exe` on Windows)
- **Static `.html` files**: If nav links point to `.html` files that exist, update those files' CDN refs too
- **Empty dirs vs real dirs**: blog/ with only empty subdirs → delete; blog/ with `index.html` → keep and clean
- **Blog post slugs**: URLs like `/blogs/top-ai-tools` need their own `blogs/top-ai-tools.html` file — extract from `data-framer-hydrate-v2` or from the SPA router config
- **Font files**: Skip by default; no visible branding but adds significant export time
- **Canvas sandbox iframe**: Editor-only, safe to remove (already caught by noise removal)
