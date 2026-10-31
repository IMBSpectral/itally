// Assemble everything the desktop app ships into desktop/bundle/:
//   web/      the built front end (served by the server at /)
//   server/   the API + XML gateway bundled into one file, its SQL migrations, and PGlite
//   node/     the Node runtime that runs the server
// Tauri then packs bundle/ into the installer as resources (see src-tauri/tauri.conf.json).
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..')
const server = path.join(app, 'server')
const out = path.join(here, 'bundle')

const step = (msg) => console.log(`\n> ${msg}`)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

step('front end (vite build)')
execSync('npx vite build --outDir desktop/bundle/web --emptyOutDir', { cwd: app, stdio: 'inherit' })

step('server bundle (esbuild)')
await build({
  entryPoints: [path.join(server, 'src/index.ts')],
  outfile: path.join(out, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // PGlite loads its .wasm/.data next to its own files, so it ships as a package (below);
  // pg-native is an optional add-on of `pg` that we don't use
  external: ['@electric-sql/pglite', 'pg-native'],
  // CommonJS dependencies (express, pg) call require() for Node built-ins
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
})
cpSync(path.join(server, 'src/migrations'), path.join(out, 'server/migrations'), { recursive: true })

step('PGlite package (without source maps and unused extensions)')
cpSync(path.join(server, 'node_modules/@electric-sql/pglite'), path.join(out, 'server/node_modules/@electric-sql/pglite'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map') && !src.endsWith('.tar.gz'),
})

step(`Node runtime (${process.version})`)
mkdirSync(path.join(out, 'node'), { recursive: true })
cpSync(process.execPath, path.join(out, 'node', path.basename(process.execPath)))

const size = (p) => {
  const s = statSync(p)
  return s.isDirectory() ? readdirSync(p).reduce((t, f) => t + size(path.join(p, f)), 0) : s.size
}
console.log('\nbundle/')
for (const d of readdirSync(out)) console.log(`  ${d.padEnd(8)} ${(size(path.join(out, d)) / 1e6).toFixed(1)} MB`)
