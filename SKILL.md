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
- **Categorize correctly by checking file extensions using regexes** (e.g. `/\.(js|mjs)(\?|$)/i` for JS, `/\.css(\?|$)/i` for CSS, `/\.(png|jpg|jpeg|webp|gif|svg|ico)(\?|$)/i` for images). This ensures files with query parameters (e.g., `?v=2`) are not misclassified as media files.
- **Detect all page routes**: Every `.html` file found represents a unique route (homepage `/`, `/blogs`, `/pricing`, `/terms-conditions`, `/blogs/slug-title`, etc.)
- Each HTML file contains `data-framer-hydrate-v2="{routeId:...}"` — this JSON determines which page renders on the client and is baked in at download time, so each route needs its own HTML file
- Log all discovered routes

### Step 2: Create local asset directories
Create `js/`, `css/`, `images/`, `media/` directories alongside `index.html`.

### Step 3: Download all external resources
Download all JS, CSS, images, and media files (video, PDF, audio, documents) to local directories. Skip fonts by default unless user requests them.
- **Media Validation**: Validate downloaded files. For videos (MP4, WebM, Ogg) and audio, read the first 12 bytes to verify magic bytes. MP4 contains `ftyp` at offset 4, WebM/MKV starts with `\x1a\x45\xdf\xa3`. Reject empty files.

**Important: Extract dynamic import URLs from script_main.mjs**. Framer's SPA router dynamically imports page modules. Construct full CDN URLs from the script_main base path, and download those dynamic modules too.

### Step 4: Fix ES module imports in JS files
Many Framer exports have `import` statements referencing CDN filenames like `7zd_4hdYd8O.mjs`. Rename these to short local names and update all import paths:
- `from "./7zd_4hdYd8O-dG7PZxJrnFUX2tGHHFGd1cKXxhsQWgA.B72Ql4Dm.mjs"` → `from "./site-home.mjs"`
- Also fix dynamic imports: `` import(`./filename.mjs`) ``
- Also fix `modulepreload` links.

### Step 5: Update HTML references
Replace all CDN URLs in HTML files with **absolute root-relative paths** (starting with `/`) to ensure sub-pages and nested routes resolve correctly:
- `https://framer.com/bootstrap.js` → `/js/bootstrap.js`
- Images: `https://framerusercontent.com/images/xxx.png` → `/images/xxx.png` (strip query params)
- Media (video/PDF/audio): `https://framerusercontent.com/files/xxx.pdf` → `/media/xxx.pdf`
- **Modulepreload links**: Rewrite relative/CDN modulepreload href values to `/js/filename.mjs` but **ignore** any links that are already absolute (starting with `/`) or external (starting with `http`/`https`) to avoid double-prefixing.

### Step 6: Remove Framer noise
Surgically remove Framer badge, editor bar, iframe, and related CSS/scripts. Update all HTML files, not just the homepage.

### Step 7: Fix SPA routing
1. Delete empty static HTML directories (blog/, support/, etc.) that override SPA routes — but ONLY if they contain no actual HTML files
2. Update nav links from `.html` paths to SPA routes: `href="blog/index.html"` → `href="/blog"`. Skip relative asset directory prefixes (`js/`, `css/`, `images/`, `media/`) and file extensions to avoid breaking asset loading.
3. Generate a custom `server.js` that maps each discovered URL slug to its HTML file.
4. The `server.js` template must double-escape regexes (e.g. `url.replace(/^\\//, '')` in template string) to strip leading slashes correctly.

### Step 8: Verify
- Run: `node server.js`
- Test all routes and test page refresh on sub-pages and nested pages to check for any blank screens or 404s.
- Check browser console for "Failed to fetch dynamically imported module" errors.

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
