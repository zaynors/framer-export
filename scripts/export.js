#!/usr/bin/env node
/**
 * Framer Exporter CLI
 * Usage: node export.js <html-file-or-url> [output-dir]
 *
 * Exports a Framer site to fully local files with no CDN dependencies.
 * Steps:
 *   1. Analyze - find all CDN URLs
 *   2. Download assets
 *   3. Fix ES module imports
 *   4. Clean HTML of Framer noise
 *   5. Fix SPA routing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { URL } = require('url');
const TMP = os.tmpdir();

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[framer-export] ${msg}`); }
function logStep(n, msg) { console.log(`\n[Step ${n}] ${msg}`); }
function err(msg) { console.error(`[ERROR] ${msg}`); process.exit(1); }

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout || '';
  }
}

function curl(url, outputPath, referer) {
  // Decode HTML entities (e.g. &amp; → &) so Framer CDN URLs work correctly
  url = url.replace(/&amp;/g, '&');
  const headers = [
    referer ? `-H "Referer: ${referer}"` : '',
    `-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`,
  ].filter(Boolean).join(' ');
  // Convert /tmp to Windows temp dir for Git Bash/msys compatibility
  const resolvedPath = outputPath.replace(/^\/tmp\//, `${TMP}\\`);
  exec(`curl -sL -o "${resolvedPath}" "${url}" ${headers}`);

  // For images and media, verify content is valid (not a Framer JSON error)
  const isImage = /\.(png|jpg|jpeg|webp|gif|svg|ico)(\?|$)/i.test(url);
  const isMedia = /\.(mp4|webm|mp3|pdf|zip)(\?|$)/i.test(url);
  if (isImage || isMedia) {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(resolvedPath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString('latin1');
    // PNG=\x89PNG, JPEG=\xff\xd8\xff, GIF=GIF8, WebP=RIFL, PDF=%PDF, SVG=<svg
    const validMagic = ['\x89PN', '\xff\xd8\xff', 'GIF8', 'RIFL', '%PDF', '<sv'];
    if (!validMagic.some(m => magic.startsWith(m))) {
      fs.unlinkSync(resolvedPath);
      throw new Error(`Invalid content for ${url}`);
    }
  }
}

function download(url, outputDir, filename) {
  const ext = path.extname(new URL(url).pathname).split('?')[0] || '.bin';
  const name = filename || path.basename(new URL(url).pathname.split('?')[0]);
  const filePath = path.join(outputDir, name);
  log(`Downloading: ${url} → ${name}`);
  curl(url, filePath);
  return name;
}

// ─── Step 1: Analyze ─────────────────────────────────────────────────────

function analyzeSite(htmlPath, baseDir) {
  logStep(1, 'Analyzing site...');
  let html;

  if (htmlPath.startsWith('http://') || htmlPath.startsWith('https://')) {
    log('Fetching HTML from URL...');
    const tmp = path.join(TMP, 'framer-export-index.html');
    curl(htmlPath, tmp);
    html = fs.readFileSync(tmp, 'utf8');
  } else {
    if (!fs.existsSync(htmlPath)) err(`File not found: ${htmlPath}`);
    html = fs.readFileSync(htmlPath, 'utf8');
  }

  // Find all unique external URLs
  const urlRegex = /https?:\/\/[^"'>` )]+/g;
  const allUrls = [...new Set(html.match(urlRegex) || [])];

  const jsUrls = allUrls.filter(u => u.endsWith('.js') || u.endsWith('.mjs'));
  const cssUrls = allUrls.filter(u => u.endsWith('.css'));
  const imgExtensions = /\.(png|jpg|jpeg|webp|gif|svg)(\?|$)/i;
  const imgUrls = allUrls.filter(u => imgExtensions.test(u) || u.includes('framerusercontent.com/images/'));
  const fontUrls = allUrls.filter(u => u.includes('fonts.gstatic') || u.includes('framerusercontent.com/assets/'));
  const knownTypeSet = new Set([...jsUrls, ...cssUrls, ...imgUrls, ...fontUrls]);
  // Only URLs from known CDN domains that point to downloadable files with extensions
  const mediaExtensions = /\.(mp4|webm|ogg|mov|avi|mkv|wmv|pdf|mp3|wav|flac|aac|opus|zip|tar|gz|rar|7z|doc|docx|xls|xlsx|ppt|pptx)(\?|$)/i;
  const mediaUrls = allUrls.filter(u =>
    !knownTypeSet.has(u) && (
      mediaExtensions.test(u) ||
      u.includes('framerusercontent.com/files/') ||
      u.includes('framerusercontent.com/sites/')
    )
  );

  // Find HTML files that need processing
  const htmlFiles = [];
  findHtmlFiles(baseDir, baseDir, htmlFiles);
  htmlFiles.sort();

  // Find all JS files and their import references
  const jsDir = path.join(baseDir, 'js');
  const allJsFiles = jsDir && fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js')) : [];

  log(`  JS files: ${jsUrls.length} from CDN, ${allJsFiles.length} local`);
  log(`  CSS files: ${cssUrls.length}`);
  log(`  Images: ${imgUrls.length}`);
  log(`  Media (video/pdf/audio/etc): ${mediaUrls.length}`);
  log(`  Font files: ${fontUrls.length} (skipped by default)`);
  log(`  HTML files to process: ${htmlFiles.length}`);

  return { html, allUrls, jsUrls, cssUrls, imgUrls, mediaUrls, fontUrls, htmlFiles, allJsFiles, baseDir };
}

function findHtmlFiles(baseDir, currentDir, results) {
  if (!fs.existsSync(currentDir)) return;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      findHtmlFiles(baseDir, full, results);
    } else if (entry.name === 'index.html' && currentDir !== baseDir) {
      results.push(currentDir);
    }
  }
}

// ─── Step 2: Download assets ─────────────────────────────────────────────

function downloadAssets(analysis, opts = {}) {
  logStep(2, 'Downloading assets...');
  const { htmlPath, baseDir, skipFonts, sourceUrl } = opts;
  const jsDir = path.join(baseDir, 'js');
  const cssDir = path.join(baseDir, 'css');
  const imgDir = path.join(baseDir, 'images');
  const mediaDir = path.join(baseDir, 'media');

  [jsDir, cssDir, imgDir, mediaDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Download JS
  const downloadedJs = {};
  analysis.jsUrls.forEach(url => {
    const name = path.basename(url.split('?')[0]);
    // Generate a short unique name
    const shortName = name.replace(/^[a-f0-9]{20,}\./, 'chunk-').replace(/\.mjs$/, '.mjs');
    try {
      curl(url, path.join(jsDir, shortName), sourceUrl);
      downloadedJs[url] = shortName;
      log(`  JS: ${name} → ${shortName}`);
    } catch(e) {
      err(`Failed to download JS: ${url}`);
    }
  });

  // Download CSS
  analysis.cssUrls.forEach(url => {
    const name = path.basename(url.split('?')[0]);
    try {
      curl(url, path.join(cssDir, name), sourceUrl);
      log(`  CSS: ${name}`);
    } catch(e) {
      err(`Failed to download CSS: ${url}`);
    }
  });

  // Download images
  const downloadedImages = {};
  analysis.imgUrls.forEach(url => {
    try {
      const name = path.basename(url.split('?')[0]);
      const imgName = `img-${name}`;
      curl(url, path.join(imgDir, imgName), sourceUrl);
      downloadedImages[url] = imgName;
      log(`  IMG: ${name}`);
    } catch(e) {
      log(`  Warning: failed to download image: ${url}`);
    }
  });

  // Download media (video, PDF, audio, documents, etc.)
  const downloadedMedia = {};
  analysis.mediaUrls.forEach(url => {
    try {
      const name = path.basename(url.split('?')[0]);
      curl(url, path.join(mediaDir, name), sourceUrl);
      downloadedMedia[url] = name;
      log(`  MEDIA: ${name}`);
    } catch(e) {
      log(`  Warning: failed to download media: ${url}`);
    }
  });

  log('Assets downloaded.');

  // Download search index if present
  return { downloadedJs, downloadedImages, downloadedMedia };
}

// ─── Step 3: Fix imports in JS files ────────────────────────────────────

function fixJsImports(jsDir) {
  logStep(3, 'Fixing ES module imports...');
  if (!fs.existsSync(jsDir)) { log('  No js/ directory, skipping'); return; }

  const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
  if (files.length === 0) { log('  No JS files, skipping'); return; }

  // Build a map of old CDN filenames to new short names
  const nameMap = {};
  files.forEach(f => {
    // Extract hash-based CDN names and create mapping
    // e.g. "7zd_4hdYd8O-dG7PZxJrnFUX2tGHHFGd1cKXxhsQWgA.B72Ql4Dm.mjs" → "site-home.mjs"
    // Pattern: long hex/hash strings in filenames
    const hashMatch = f.match(/^([a-f0-9]{20,})/);
    if (hashMatch) {
      nameMap[f] = f; // Will be renamed
    }
  });

  // Rename files with hash names to short descriptive names
  const renameMap = {};
  let counter = 1;
  Object.keys(nameMap).forEach(old => {
    const ext = old.endsWith('.mjs') ? '.mjs' : '.js';
    const isRoute = old.includes('route') || old.includes('Route');
    const isHome = old.includes('site-7zd') || old.includes('augiA20Il');
    let newName;
    if (isHome) newName = 'site-home.mjs';
    else if (isRoute) newName = `route-${counter}${ext}`;
    else newName = `chunk-${counter}${ext}`;
    renameMap[old] = newName;
    counter++;
  });

  // Apply renames
  Object.entries(renameMap).forEach(([old, neu]) => {
    const oldPath = path.join(jsDir, old);
    const newPath = path.join(jsDir, neu);
    fs.renameSync(oldPath, newPath);
    log(`  Renamed: ${old} → ${neu}`);
  });

  // Now fix all import paths in all JS files
  const allFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
  allFiles.forEach(f => {
    const fp = path.join(jsDir, f);
    let c = fs.readFileSync(fp, 'utf8');
    let modified = false;

    // Fix static imports: from"./old-name.mjs" → from"./new-name.mjs"
    Object.entries(renameMap).forEach(([old, neu]) => {
      if (c.includes(`from"./${old}"`)) {
        c = c.split(`from"./${old}"`).join(`from"./${neu}"`);
        modified = true;
      }
      if (c.includes(`from'./${old}'`)) {
        c = c.split(`from'./${old}'`).join(`from'./${neu}'`);
        modified = true;
      }
    });

    // Fix dynamic imports: import(`./old-name.mjs`) → import(`./new-name.mjs`)
    Object.entries(renameMap).forEach(([old, neu]) => {
      if (c.includes(`import(\`./${old}\`)`)) {
        c = c.split(`import(\`./${old}\`)`).join(`import(\`./${neu}\`)`);
        modified = true;
      }
      if (c.includes(`import("./${old}")`)) {
        c = c.split(`import("./${old}")`).join(`import("./${neu}")`);
        modified = true;
      }
    });

    if (modified) {
      fs.writeFileSync(fp, c);
      log(`  Fixed imports in: ${f}`);
    }
  });

  // Recursive pass: keep fixing until no more CDN-named imports remain
  let iterations = 0;
  let changed = true;
  while (changed && iterations < 10) {
    changed = false;
    iterations++;
    const allFiles2 = fs.readdirSync(jsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
    allFiles2.forEach(f => {
      const fp = path.join(jsDir, f);
      let c = fs.readFileSync(fp, 'utf8');
      let localChanged = false;

      // Find CDN filenames referenced in this file's imports
      const importMatches = [...c.matchAll(/from["'`]\.\/([^"']+)["'`]/g)].map(m => m[1]);
      importMatches.forEach(importedName => {
        // Check if this imported file exists locally
        const importedPath = path.join(jsDir, importedName);
        if (!fs.existsSync(importedPath)) {
          // Try to find it under a different name (might have been renamed)
          const allFiles3 = fs.readdirSync(jsDir);
          const found = allFiles3.find(name => {
            // Match by hash prefix (first 20+ hex chars)
            const hMatch = importedName.match(/^([a-f0-9]{20,})/);
            const nMatch = name.match(/^([a-f0-9]{20,})/);
            if (hMatch && nMatch && hMatch[1] === nMatch[1]) return true;
            // Also match by site ID pattern
            if (importedName.includes(name.substring(0, Math.min(15, name.length)))) return true;
            return false;
          });
          if (found) {
            c = c.split(`from"./${importedName}"`).join(`from"./${found}"`);
            c = c.split(`from'./${importedName}'`).join(`from'./${found}'`);
            localChanged = true;
          }
        }
      });

      if (localChanged) {
        fs.writeFileSync(fp, c);
        changed = true;
        log(`  Pass ${iterations} fixed: ${f}`);
      }
    });
  }

  log('Import fixing complete.');
  return renameMap;
}

// ─── Step 4: Update HTML references ─────────────────────────────────────

function fixHtmlRefs(htmlPath, renameMap, { downloadedJs, downloadedImages, downloadedMedia }, baseDir) {
  logStep(4, 'Updating HTML references...');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Build full URL → local path map
  const urlToLocal = {};

  // JS URLs → local js files
  Object.entries(downloadedJs).forEach(([url, filename]) => {
    urlToLocal[url] = filename;
  });

  // Also add renamed files
  Object.entries(renameMap).forEach(([old, neu]) => {
    // The old name was a CDN filename, need to find its URL
    // This is already handled in downloadedAssets
  });

  // Fix JS script src attributes
  const jsDir = path.join(baseDir, 'js');
  const jsFiles = fs.existsSync(jsDir) ? fs.readdirSync(jsDir) : [];

  // Simple approach: replace CDN URLs with local paths in HTML
  // Replace framer.com bootstrap
  html = html.replace(/https:\/\/framer\.com\/[a-zA-Z0-9_\-\.]+\.js/g, 'js/bootstrap.js');

  // Replace framerstatic URLs for JS
  html = html.replace(/https:\/\/app\.framerstatic\.com\/chunk-([a-zA-Z0-9]+)\.mjs/g, (m, hash) => {
    const match = jsFiles.find(f => f.includes(hash));
    return match ? `js/${match}` : m;
  });
  html = html.replace(/https:\/\/app\.framerstatic\.com\/editorbar\.[^.]+\.css/g, 'css/editorbar.css');
  html = html.replace(/https:\/\/app\.framerstatic\.com\/editorbar\.[^.]+\.mjs/g, 'js/editorbar.mjs');
  html = html.replace(/https:\/\/app\.framerstatic\.com\/framer-motion[^.]+\.mjs/g, 'js/framer-motion-shim.mjs');

  // Replace framercanvas React URLs
  html = html.replace(/https:\/\/site-[a-z0-9]+\.framercanvas\.com\/s\/[^/]+\/scripts\/react\/react\.production\.min\.js/g, 'js/react.production.min.js');
  html = html.replace(/https:\/\/site-[a-z0-9]+\.framercanvas\.com\/s\/[^/]+\/scripts\/react-dom\/react-dom\.production\.min\.js/g, 'js/react-dom.production.min.js');
  html = html.replace(/https:\/\/site-[a-z0-9]+\.framercanvas\.com\/s\/[^/]+\/scripts\/react-dom\/react-dom-server[^.]+\.min\.js/g, 'js/react-dom-server.browser.min.js');

  // Replace framerusercontent module URLs
  html = html.replace(/https:\/\/framerusercontent\.com\/sites\/[^\/]+\/([^\/]+)\.mjs/g, (m, filename) => {
    const match = jsFiles.find(f => f.includes(filename.split('.')[0]));
    return match ? `js/${match}` : m;
  });

  // Replace image URLs (framerusercontent.com/images/ and assets/)
  // Replace by base URL (without query params) so ?width=... doesn't break the path
  Object.entries(downloadedImages).forEach(([url, filename]) => {
    const localPath = `images/${filename}`;
    const urlBase = url.split('?')[0];
    // Replace all occurrences of the base URL in the HTML
    html = html.split(urlBase).join(localPath);
    // If original URL had query params, also replace the full URL (params will be discarded)
    if (urlBase !== url) {
      html = html.split(url).join(localPath);
    }
  });

  // Fix modulepreload links — add /js/ prefix to hash-based filenames
  html = html.replace(/<link rel="modulepreload"[^>]*href="\.\/([^"]+\.mjs)"[^>]*>/g, (m, filename) => {
    return `<link rel="modulepreload" href="/js/${filename}">`;
  });

  // Replace media URLs (video, PDF, audio, documents, etc.)
  const mediaDir = path.join(baseDir, 'media');
  const mediaFiles = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
  // Generic replacement for any CDN URL that matches a downloaded media file
  Object.entries(downloadedMedia).forEach(([url, filename]) => {
    html = html.split(url).join(`media/${filename}`);
  });

  // Replace framer.com edit/init URLs
  html = html.replace(/https:\/\/framer\.com\/edit\/init\.mjs/g, 'js/init.mjs');
  html = html.replace(/https:\/\/framer\.com\/m\/[^\/]+\/[^\/]+@[^/]+\.js/g, 'js/empty.js');

  // Replace canvas-sandbox iframe src
  html = html.replace(/src="https:\/\/site-[^"]+framercanvas[^"]+"/g, '');

  // Replace cssBundleURL and deferredJsFiles
  html = html.replace(/Object\.defineProperty\(window,\s*['"`](?:cssBundleURL|deferredJsFiles)['"`]/g, '// $&');

  fs.writeFileSync(htmlPath, html);
  log('HTML references updated.');
}

// ─── Step 5: Clean Framer noise ───────────────────────────────────────────

function cleanFramerNoise(htmlPath) {
  logStep(5, 'Removing Framer noise...');
  let c = fs.readFileSync(htmlPath, 'utf8');
  const original = c;

  // Remove data-framer-hydrate-v2 from #main - this forces SPA to use URL-based routing
  // instead of always rendering the routeId baked into the HTML (which is always the home page)
  c = c.replace(/\s*data-framer-hydrate-v2="[^"]*"/g, '');

  // Remove "Made in Framer" comment
  c = c.replace(/<!--\s*Made in Framer[^>]*-->\s*/g, '');

  // Remove badge container (has SSR markers like <!--$--> inside)
  c = c.replace(/<div id="__framer-badge-container">[\s\S]*?<\/div>\s*<\/div>\s*/g, '');

  // Remove editorbar container button
  c = c.replace(/<div id="__framer-editorbar-container"[\s\S]*?<\/div>\s*/g, '');

  // Remove editorbar iframe
  c = c.replace(/<div id="__framer-editorbar"[\s\S]*?<\/div>\s*/g, '');

  // Remove badge CSS rules
  c = c.replace(/\s*#__framer-badge-container\s*\{[\s\S]*?\}\s*/g, '\n');

  // Remove editorbar CSS rules
  c = c.replace(/\s*#__framer-editorbar-container\s*\{[\s\S]*?\}\s*/g, '\n');
  c = c.replace(/\s*#__framer-editorbar-label\s*\{[\s\S]*?\}\s*/g, '\n');
  c = c.replace(/\s*#__framer-editorbar-button\s*\{[\s\S]*?\}\s*/g, '\n');
  c = c.replace(/\s*#__framer-editorbar\s*\{[\s\S]*?\}\s*/g, '\n');
  c = c.replace(/\s*#__framer-editorbar-loading-spinner\s*\{[\s\S]*?\}\s*/g, '\n');

  // Remove editorbar stylesheet link
  c = c.replace(/<link[^>]*href="[^"]*editorbar[^"]*"[^>]*>\s*/g, '');

  // Remove cssBundleURL/deferredJsFiles script
  c = c.replace(/\s*<script>\s*Object\.defineProperty\(window,\s*['"`](?:cssBundleURL|deferredJsFiles)['"`][\s\S]*?<\/script>\s*/g, '\n');

  // Remove editorbar init script
  c = c.replace(/\s*<script>try\{if\(localStorage\.get\("__framer_force_showing_editorbar_since"\)\)[\s\S]*?catch\(e\)\{\}<\/script>\s*/g, '\n');

  // Remove editorbar modulepreload and script tags
  c = c.replace(/<link[^>]*href="[^"]*editorbar[^"]*"[^>]*>\s*/g, '');
  c = c.replace(/<script[^>]*src="[^"]*editorbar[^"]*"[^>]*><\/script>\s*/g, '');

  // Remove body class editorbar
  c = c.replace(/class="notranslate editorbar /g, 'class="notranslate ');

  // Remove drag-overlay
  c = c.replace(/<div id="drag-overlay"[^>]*><\/div>\s*/g, '');

  // Remove canvas_sandbox iframe
  c = c.replace(/<div[^>]*id="canvas_sandbox"[^>]*>[\s\S]*?<\/div>\s*/g, '');

  // Remove "Published" comment
  c = c.replace(/<!--\s*Published[^>]*-->/g, '');

  fs.writeFileSync(htmlPath, c);
  const removed = original.length - c.length;
  log(`  Removed ${removed} characters of Framer noise.`);
}

// ─── Step 6: Fix SPA routing ─────────────────────────────────────────────

function fixSpaRouting(htmlPath, baseDir, sourceUrl) {
  logStep(6, 'Fixing SPA routing...');

  // Discover all HTML files to build route list
  const routes = [{ path: '/', file: 'index.html' }];

  // Find all .html files in subdirectories (blog/, pricing/, blogs/slug.html, etc.)
  function findHtmlFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Check if directory has an index.html
        const indexPath = path.join(full, 'index.html');
        if (fs.existsSync(indexPath)) {
          const slug = entry.name;
          routes.push({ path: `/${slug}`, file: `${slug}/index.html` });
          // Also check for slug.html directly
        } else {
          // Nested: blogs/some-post.html
          findHtmlFiles(full);
        }
      } else if (entry.name.endsWith('.html') && entry.name !== 'index.html') {
        const slug = entry.name.replace(/\.html$/, '');
        routes.push({ path: `/${slug}`, file: `${slug}.html` });
      }
    }
  }

  // Also extract routes from script_main.*.mjs (Framer SPA router)
  const jsDir = path.join(baseDir, 'js');
  if (fs.existsSync(jsDir)) {
    const scriptMain = fs.readdirSync(jsDir).find(f => f.startsWith('script_main.'));
    if (scriptMain) {
      const content = fs.readFileSync(path.join(jsDir, scriptMain), 'utf8');
      // Match path:`/route` patterns
      const routeMatches = content.match(/path:`([^`]+)`/g) || [];
      routeMatches.forEach(m => {
        const routePath = m.match(/path:`([^`]+)`/)[1];
        if (!routes.find(r => r.path === routePath)) {
          routes.push({ path: routePath, file: 'index.html' });
        }
      });
    }
  }

  // Also fetch sitemap.xml to discover all routes (Framer sites have this)
  if (sourceUrl) {
    try {
      const sitemapUrl = sourceUrl.replace(/\/$/, '') + '/sitemap.xml';
      const sitemapTmp = path.join(TMP, 'framer-export-sitemap.xml');
      curl(sitemapUrl, sitemapTmp);
      const sitemap = fs.readFileSync(sitemapTmp, 'utf8');
      const sitemapRoutes = sitemap.match(/<loc>[^<]+<\/loc>/g) || [];
      sitemapRoutes.forEach(loc => {
        const url = loc.replace(/<\/?loc>/g, '');
        try {
          const u = new URL(url);
          const routePath = u.pathname;
          if (!routes.find(r => r.path === routePath)) {
            routes.push({ path: routePath, file: 'index.html' });
          }
        } catch(e) {}
      });
      log(`  Found ${sitemapRoutes.length} routes from sitemap.xml`);
    } catch(e) {}
  }

  findHtmlFiles(baseDir);

  // Get list of all HTML files (including the downloaded per-route pages)
  const allHtmlFiles = [htmlPath];
  routes.forEach(r => {
    if (r.file !== 'index.html') {
      const f = path.join(baseDir, r.file);
      if (fs.existsSync(f)) allHtmlFiles.push(f);
    }
  });

  // Get list of known route slugs for link fixing
  const knownDirs = routes.filter(r => r.path !== '/').map(r => r.path.replace(/^\//, '').replace(/\/$/, ''));

  // Fix nav links in ALL HTML files
  // The downloaded pages have href="/blogs/index.html" but should be href="/blogs"
  // The server maps /blogs → blogs/index.html, so links should use /blogs format
  allHtmlFiles.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let modified = false;

    // Fix /slug/index.html → /slug for all known route slugs
    knownDirs.forEach(slug => {
      // href="/blogs/index.html" → href="/blogs"
      const pattern1 = new RegExp(`href="/${slug}/index\\.html"`, 'g');
      if (content.match(pattern1)) { content = content.replace(pattern1, `href="/${slug}"`); modified = true; }

      // href="/blogs/" → href="/blogs"
      const pattern2 = new RegExp(`href="/${slug}/"`, 'g');
      if (content.match(pattern2)) { content = content.replace(pattern2, `href="/${slug}"`); modified = true; }

      // href="./blogs" or href="./blogs/" → href="/blogs"
      const pattern3 = new RegExp(`href="./${slug}/index\\.html"`, 'g');
      if (content.match(pattern3)) { content = content.replace(pattern3, `href="/${slug}"`); modified = true; }
      const pattern4 = new RegExp(`href="./${slug}"`, 'g');
      if (content.match(pattern4)) { content = content.replace(pattern4, `href="/${slug}"`); modified = true; }
      const pattern5 = new RegExp(`href="./${slug}/"`, 'g');
      if (content.match(pattern5)) { content = content.replace(pattern5, `href="/${slug}"`); modified = true; }
    });

    // Fix href="./" (root link)
    content = content.replace(/href="\.\/"/g, 'href="/"');

    // Also fix any remaining ./slug patterns that might not be in knownDirs
    content = content.replace(/href="\.\/([^"]+)"/g, (m, p) => {
      if (p.startsWith('http') || p.startsWith('//') || p.startsWith('#') || p.startsWith('?')) return m;
      return `href="/${p.replace(/^\/+/, '')}"`;
    });

    if (modified) {
      fs.writeFileSync(f, content);
    }
  });

  log(`  Discovered ${routes.length} routes: ${routes.map(r => r.path).join(', ')}`);
  log('SPA routing fixed.');
  return routes;
}

// ─── Generate custom SPA server ─────────────────────────────────────────

function generateServer(baseDir, routes) {
  logStep(7, 'Generating custom SPA server...');

  const routeMap = routes.map(r => `  '${r.path}': '${r.file}'`).join(',\n');

  const serverCode = `#!/usr/bin/env node
/**
 * Custom Framer SPA server
 * Generated by framer-export
 *
 * Usage: node server.js [port]
 * Default port: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;

// Kill any existing process on this port
const { execSync } = require('child_process');
try {
  if (process.platform === 'win32') {
    execSync(\`for /f "tokens=5" %a in ('netstat -ano ^| findstr :\${PORT}') do taskkill /F /PID %a\`, { stdio: 'ignore' });
  } else {
    execSync(\`lsof -ti:\${PORT} | xargs kill -9 2>/dev/null || true\`, { stdio: 'ignore' });
  }
} catch(e) {}

// Route slug → HTML file mapping (auto-generated)
const ROUTES = {
${routeMap}
};

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url.endsWith('/')) url = url.slice(0, -1);

  // Static file lookup
  const staticFile = path.join(__dirname, url);
  if (fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
    const ext = path.extname(staticFile);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    fs.createReadStream(staticFile).pipe(res);
    return;
  }

  // Directory index.html
  const indexFile = path.join(__dirname, url, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(indexFile).pipe(res);
    return;
  }

  // Known route → serve its HTML
  if (ROUTES[url]) {
    const htmlPath = path.join(__dirname, ROUTES[url]);
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // Slug fallback — try stripping path segments to find .html file
  // e.g. /blogs/some-post → blogs/some-post.html
  let search = url.replace(/^\\//, '').replace(/\\//g, '/');
  while (search.includes('/')) {
    const candidate = path.join(__dirname, search + '.html');
    if (fs.existsSync(candidate)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(candidate).pipe(res);
      return;
    }
    search = search.substring(search.indexOf('/') + 1);
  }

  // Fallback to index.html
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

server.listen(PORT, () => {
  console.log(\`Framer SPA server running at http://localhost:\${PORT}\`);
  console.log('Press Ctrl+C to stop');
});
`;

  fs.writeFileSync(path.join(baseDir, 'server.js'), serverCode);
  log('  Generated server.js with SPA routing');
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Framer Exporter - Export Framer sites to fully local HTML/JS/CSS

Usage:
  node export.js <index.html-or-url> [output-dir]

Examples:
  node export.js ./my-site/index.html
  node export.js https://example.framer.app

Options:
  --no-clean     Skip Framer noise removal
  --no-spa      Skip SPA routing fixes
  --with-fonts  Also download font files
`);
    process.exit(0);
  }

  let htmlPath = args[0];
  const opts = {
    clean: !args.includes('--no-clean'),
    spa: !args.includes('--no-spa'),
    withFonts: args.includes('--with-fonts'),
  };

  log('Framer Exporter starting...');
  log(`Source: ${htmlPath}`);

  // Determine base output directory
  const isUrl = htmlPath.startsWith('http://') || htmlPath.startsWith('https://');
  const sourceUrl = isUrl ? htmlPath : null;
  const baseDir = isUrl
    ? path.join(process.cwd(), new URL(htmlPath).hostname)
    : path.dirname(path.resolve(htmlPath));

  log(`Output dir: ${baseDir}`);

  // When source is URL, download HTML to baseDir/index.html and use that from now on
  if (isUrl) {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const tmpHtml = path.join(baseDir, 'index.html');
    exec(`curl -sL "${htmlPath}" -o "${tmpHtml}"`);
    htmlPath = tmpHtml;
  }

  // Step 1: Analyze homepage to get initial asset lists (JS, CSS, images)
  const analysis = analyzeSite(htmlPath, baseDir);

  // Step 2: NEW APPROACH - Download each page's pre-rendered HTML from Framer using sitemap
  // This gives us fully pre-rendered page content instead of relying on JS dynamic loading
  if (sourceUrl) {
    try {
      const sitemapUrl = sourceUrl.replace(/\/$/, '') + '/sitemap.xml';
      const sitemapPath = path.join(TMP, 'framer-export-sitemap.xml');
      curl(sitemapUrl, sitemapPath);
      const sitemap = fs.readFileSync(sitemapPath, 'utf8');
      const pageUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
      log(`Found ${pageUrls.length} pages from sitemap.xml`);

      for (const pageUrl of pageUrls) {
        const u = new URL(pageUrl);
        const routePath = u.pathname;

        // Skip homepage (already downloaded)
        if (routePath === '/') continue;

        // Determine local file path: /blogs → blogs/index.html
        const slug = routePath.replace(/^\//, '').replace(/\/$/, '');
        const dirPath = path.join(baseDir, slug);
        const pageHtmlPath = path.join(dirPath, 'index.html');

        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        // Download the full pre-rendered HTML page
        curl(pageUrl, pageHtmlPath, sourceUrl);
        log(`  Downloaded page: ${routePath} → ${slug}/index.html`);

        // Remove data-framer-hydrate-v2 from this page - it contains the HOME page's routeId
        // which would cause Framer JS to render home content instead of this page's content
        const pageContent = fs.readFileSync(pageHtmlPath, 'utf8');
        const fixedContent = pageContent.replace(/\s*data-framer-hydrate-v2="[^"]*"/g, '');
        fs.writeFileSync(pageHtmlPath, fixedContent);
      }
    } catch(e) {
      log(`  Warning: Could not download sitemap pages: ${e.message}`);
    }
  }

  // Step 3: Re-extract URLs from ALL downloaded HTML pages (homepage + per-route pages)
  // This ensures we catch media URLs (video, audio) that appear in sub-pages
  log('Scanning all HTML pages for additional assets...');
  const allHtmlFiles = [htmlPath];
  const pagesDir = baseDir;
  if (fs.existsSync(pagesDir)) {
    const entries = fs.readdirSync(pagesDir, { withFileTypes: true });
    entries.forEach(entry => {
      if (entry.isDirectory()) {
        const indexPath = path.join(pagesDir, entry.name, 'index.html');
        if (fs.existsSync(indexPath)) {
          allHtmlFiles.push(indexPath);
        }
      }
    });
  }

  const allHtmlContent = allHtmlFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const allUrlsInPages = [...new Set([...allHtmlContent.matchAll(/https?:\/\/[^"'>` )]+/g)].map(m => m[0]))];

  // Find media URLs (video, audio) from all pages - Framer uses video.framer.com CDN
  const mediaExtensions = /\.(mp4|webm|ogg|mov|avi|mkv|wmv|mp3|wav|flac|aac|opus)(\?|$)/i;
  const mediaUrlsFromPages = allUrlsInPages.filter(u =>
    mediaExtensions.test(u) ||
    u.includes('video.framer.com/') ||
    u.includes('framerusercontent.com/files/') ||
    u.includes('framerusercontent.com/sites/')
  );

  // Dedupe with already-found media
  const existingMedia = new Set(analysis.mediaUrls);
  const newMediaUrls = mediaUrlsFromPages.filter(u => !existingMedia.has(u));
  if (newMediaUrls.length > 0) {
    log(`Found ${newMediaUrls.length} additional media URLs from downloaded pages`);
    analysis.mediaUrls.push(...newMediaUrls);
  }

  // Step 4: Download all assets
  const downloadedAssets = downloadAssets(analysis, { htmlPath, baseDir, skipFonts: !opts.withFonts, sourceUrl });

  // Extract dynamic import URLs from downloaded JS files and download any missing modules
  // This handles Framer's dynamic import() calls which aren't in HTML
  const jsDir = path.join(baseDir, 'js');
  if (fs.existsSync(jsDir)) {
    const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
    // Match dynamic imports: import(`./name.mjs`), import('./name.mjs'), import("./name.mjs")
    const dynamicImportRegex = /import\(\x60\.\/([^\x60]+\.mjs)\x60\)|import\(['"]\.\/([^'")]*\.mjs)['"]\)/g;
    const foundDynamicUrls = [];
    jsFiles.forEach(f => {
      const content = fs.readFileSync(path.join(jsDir, f), 'utf8');
      let match;
      while ((match = dynamicImportRegex.exec(content)) !== null) {
        // match[1] = backtick style (./name.mjs), match[2] = quote style
        const moduleName = match[1] || match[2];
        if (moduleName) foundDynamicUrls.push(moduleName);
      }
    });
    if (foundDynamicUrls.length > 0) {
      log(`Found ${foundDynamicUrls.length} dynamic import references to resolve`);
      // Find script_main URL from HTML to construct full CDN URLs
      const scriptMainPattern = /https:\/\/framerusercontent\.com\/sites\/([^\/]+)\/script_main\.[^\/]+\.mjs/;
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      const scriptMainMatch = htmlContent.match(scriptMainPattern);
      if (scriptMainMatch) {
        const scriptMainUrl = scriptMainMatch[0];
        const baseCdn = scriptMainUrl.replace(/\/script_main\.[^/]+\.mjs$/, '');
        const extraUrls = [];
        foundDynamicUrls.forEach(moduleName => {
          // Skip if already exists locally
          const localName = path.basename(moduleName.split('?')[0]);
          if (!jsFiles.includes(localName)) {
            // Strip leading ./ from moduleName (for backtick-style imports)
            const cleanName = moduleName.replace(/^\.\//, '');
            extraUrls.push(`${baseCdn}/${cleanName}`);
          }
        });
        if (extraUrls.length > 0) {
          log(`Downloading ${extraUrls.length} dynamically-imported modules...`);
          extraUrls.forEach(url => {
            const name = path.basename(url.split('?')[0]);
            const dest = path.join(jsDir, name);
            try {
              curl(url, dest, sourceUrl);
              log(`  Dynamic: ${name}`);
            } catch(e) {
              log(`  Warning: failed to download dynamic module: ${name}`);
            }
          });
        }
      }
    }
  }
  const renameMap = fixJsImports(path.join(baseDir, 'js'));

  // Update downloadedJs to map CDN URLs → final renamed filenames
  // downloadAssets returns shortNames (pre-rename), but files got renamed to renameMap values
  const { downloadedJs, downloadedImages, downloadedMedia } = downloadedAssets;
  Object.keys(downloadedJs).forEach(cdnUrl => {
    const oldLocalName = downloadedJs[cdnUrl];
    if (renameMap[oldLocalName]) {
      downloadedJs[cdnUrl] = renameMap[oldLocalName];
    }
  });

  fixHtmlRefs(htmlPath, renameMap, downloadedAssets, baseDir);
  if (opts.clean) cleanFramerNoise(htmlPath);
  const routes = opts.spa ? fixSpaRouting(htmlPath, baseDir, sourceUrl) : [];
  if (opts.spa) generateServer(baseDir, routes);

  log('\n✅ Export complete!');
  log('Next steps:');
  log('  1. Review the generated js/, css/, images/, media/ directories');
  log('  2. Start: node server.js [port]');
  log('  3. Test all routes including sub-pages and refresh on each');
}

main();
