/**
 * Builds public/grmconnect-extension.zip from the Chrome extension so the landing
 * page can always serve the latest version.
 *
 * Source of truth is the top-level `extension/` folder (what we load in Chrome).
 * Vercel's build runs with Root Directory = frontend, and files outside that root
 * may not be present. So we keep a committed copy at `frontend/extension/` and:
 *   - when the top-level `extension/` IS available (local builds), we re-sync the
 *     committed copy from it first, guaranteeing they never drift;
 *   - otherwise we fall back to the committed `frontend/extension/`.
 * Either way the zip is generated fresh on every build.
 */
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

const frontendDir = path.join(__dirname, '..')
const bundledExt = path.join(frontendDir, 'extension')          // frontend/extension (inside Vercel root)
const canonicalExt = path.join(frontendDir, '..', 'extension')  // top-level extension/ (source of truth)
const publicDir = path.join(frontendDir, 'public')
const outFile = path.join(publicDir, 'grmconnect-extension.zip')

// Keep the committed copy in sync with the canonical extension when it's available.
if (fs.existsSync(canonicalExt) && path.resolve(canonicalExt) !== path.resolve(bundledExt)) {
  fs.rmSync(bundledExt, { recursive: true, force: true })
  fs.cpSync(canonicalExt, bundledExt, { recursive: true })
  console.log('[zip-extension] synced frontend/extension from top-level extension/')
}

const srcDir = fs.existsSync(bundledExt) ? bundledExt : canonicalExt
if (!fs.existsSync(srcDir)) {
  console.warn('[zip-extension] no extension folder found — skipping zip')
  process.exit(0)
}

fs.mkdirSync(publicDir, { recursive: true })
const zip = new AdmZip()
// Nest everything under grmconnect-extension/ so the unzipped folder is clean to "Load unpacked".
zip.addLocalFolder(srcDir, 'grmconnect-extension')
zip.writeZip(outFile)
console.log('[zip-extension] wrote', path.relative(frontendDir, outFile), 'from', path.relative(frontendDir, srcDir))
