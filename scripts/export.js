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

function curl(url, outputPath) {
  exec(`curl -sL "${url}" -o "${outputPath}"`);
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
  const imgUrls = allUrls.filter(u => /\.(png|jpg|jpeg|webp|gif|svg)(\?|$)/.test(u) || u.includes('framerusercontent.com/images/') || u.includes('framerusercontent.com/assets/'));
  const fontUrls = allUrls.filter(u => u.includes('fonts.gstatic') || u.includes('framerusercontent.com/assets/') && u.endsWith('.woff2'));
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
  const { htmlPath, baseDir, skipFonts } = opts;
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
      curl(url, path.join(jsDir, shortName));
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
      curl(url, path.join(cssDir, name));
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
      curl(url, path.join(imgDir, imgName));
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
      curl(url, path.join(mediaDir, name));
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
  // Use exact URL→local map for reliable replacement
  Object.entries(downloadedImages).forEach(([url, filename]) => {
    const localPath = `images/${filename}`;
    // Handle URL as-is (no query params)
    html = html.split(url).join(localPath);
    // Handle URL with query params (strip query string)
    const urlBase = url.split('?')[0];
    if (urlBase !== url) {
      html = html.split(urlBase).join(localPath);
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

  // Remove "Made in Framer" comment
  c = c.replace(/<!--\s*Made in Framer[^>]*-->\s*/g, '');

  // Remove badge container (long single-line div)
  c = c.replace(/<div id="__framer-badge-container">[\s\S]*?<\/div>\s*<\/div>\s*(?=<script>var animator=)/, '\n');

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

function fixSpaRouting(htmlPath, baseDir) {
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

  findHtmlFiles(baseDir);

  const knownDirs = routes.filter(r => r.path !== '/').map(r => r.path.replace(/^\//, ''));

  // Delete empty directories that would override SPA routes
  knownDirs.forEach(slug => {
    const dirPath = path.join(baseDir, slug);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const entries = fs.readdirSync(dirPath);
      const isEmptyDir = entries.every(e => {
        const full = path.join(dirPath, e);
        return fs.statSync(full).isDirectory() && fs.readdirSync(full).length === 0;
      });
      if (isEmptyDir) {
        fs.rmdirSync(dirPath);
        log(`  Removed empty SPA override dir: ${slug}/`);
      }
    }
  });

  // Update nav links from .html paths to SPA routes in all HTML files
  const allHtmlFiles = [htmlPath];
  routes.forEach(r => {
    if (r.file !== 'index.html') {
      const f = path.join(baseDir, r.file);
      if (fs.existsSync(f)) allHtmlFiles.push(f);
    }
  });

  allHtmlFiles.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    knownDirs.forEach(slug => {
      content = content.replace(new RegExp(`href="${slug}/index\\.html"`, 'g'), `href="/${slug}"`);
      content = content.replace(new RegExp(`href="${slug}\\.html"`, 'g'), `href="/${slug}"`);
      content = content.replace(new RegExp(`href="${slug}/"`, 'g'), `href="/${slug}"`);
    });
    fs.writeFileSync(f, content);
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

  const analysis = analyzeSite(htmlPath, baseDir);
  const downloadedAssets = downloadAssets(analysis, { htmlPath, baseDir, skipFonts: !opts.withFonts });
  const renameMap = fixJsImports(path.join(baseDir, 'js'));
  fixHtmlRefs(htmlPath, renameMap, downloadedAssets, baseDir);
  if (opts.clean) cleanFramerNoise(htmlPath);
  const routes = opts.spa ? fixSpaRouting(htmlPath, baseDir) : [];
  if (opts.spa) generateServer(baseDir, routes);

  log('\n✅ Export complete!');
  log('Next steps:');
  log('  1. Review the generated js/, css/, images/, media/ directories');
  log('  2. Start: node server.js [port]');
  log('  3. Test all routes including sub-pages and refresh on each');
}

main();
