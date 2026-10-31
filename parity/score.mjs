// Parity scorecard: how close Spectral Tally is to TallyPrime, and whether it's improving.
//
//   node parity/score.mjs                      print the scorecard (and the change since the last record)
//   node parity/score.mjs --record "cycle 3"   also append this run to parity/history.jsonl
//
// Coverage counts done = 1, partial = 0.5, missing = 0. "Weighted" uses the tier
// (3 daily bookkeeping, 2 common, 1 specialist), so it tracks what most users touch; it is the
// headline "Tally parity" number. The projection to 1:1 uses the pace of the recorded cycles.
// Speed comes from the latest bench/results/*.json files, when present.
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { features } = JSON.parse(readFileSync(path.join(here, 'features.json'), 'utf8'))
const historyFile = path.join(here, 'history.jsonl')
const label = process.argv.includes('--record') ? process.argv[process.argv.indexOf('--record') + 1] : null

const credit = { done: 1, partial: 0.5, missing: 0 }
const pct = (x) => `${(x * 100).toFixed(1)}%`

function score(list) {
  const n = list.length
  const got = list.reduce((t, f) => t + credit[f.status], 0)
  const w = list.reduce((t, f) => t + f.tier, 0)
  const wgot = list.reduce((t, f) => t + f.tier * credit[f.status], 0)
  const count = (s) => list.filter((f) => f.status === s).length
  return { total: n, done: count('done'), partial: count('partial'), missing: count('missing'), coverage: got / n, weighted: wgot / w }
}

const overall = score(features)
const byTier = Object.fromEntries([3, 2, 1].map((t) => [t, score(features.filter((f) => f.tier === t))]))
const areas = [...new Set(features.map((f) => f.area))].map((a) => [a, score(features.filter((f) => f.area === a))])

// latest benchmark result per target (written by bench/bench.mjs)
const benchDir = path.join(here, '..', 'bench', 'results')
const bench = {}
if (existsSync(benchDir))
  for (const f of readdirSync(benchDir).filter((f) => f.endsWith('.json')).sort()) {
    const r = JSON.parse(readFileSync(path.join(benchDir, f), 'utf8'))
    bench[r.target] = r
  }

const history = existsSync(historyFile)
  ? readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
const prev = history[history.length - 1]

const delta = (now, before) => {
  if (before === undefined) return ''
  const d = (now - before) * 100
  return d === 0 ? '  (=)' : `  (${d > 0 ? '+' : ''}${d.toFixed(1)} pts)`
}

console.log(`\nSPECTRAL TALLY vs TALLYPRIME — ${features.length} features from the installed TallyPrime`)
console.log('='.repeat(78))
console.log(`TALLY PARITY: ${Math.round(overall.weighted * 100)}%   (all TallyPrime features, weighted by how often they are used)`)
console.log('-'.repeat(78))
console.log(`Coverage (all features):        ${pct(overall.coverage).padStart(6)}${delta(overall.coverage, prev?.coverage)}`)
console.log(`Weighted by everyday use:       ${pct(overall.weighted).padStart(6)}${delta(overall.weighted, prev?.weighted)}`)
console.log(`Done ${overall.done} · partial ${overall.partial} · missing ${overall.missing}   (features left: ${overall.missing + overall.partial})`)
console.log('')
console.log('By tier                         done  part  miss   coverage')
for (const [t, name] of [[3, 'Daily bookkeeping (tier 3)'], [2, 'Common (tier 2)'], [1, 'Specialist (tier 1)']]) {
  const s = byTier[t]
  console.log(`  ${name.padEnd(29)} ${String(s.done).padStart(4)}  ${String(s.partial).padStart(4)}  ${String(s.missing).padStart(4)}   ${pct(s.coverage).padStart(6)}`)
}
console.log('')
console.log('By area                         done  part  miss   coverage')
for (const [a, s] of areas)
  console.log(`  ${a.padEnd(29)} ${String(s.done).padStart(4)}  ${String(s.partial).padStart(4)}  ${String(s.missing).padStart(4)}   ${pct(s.coverage).padStart(6)}`)

const targets = Object.values(bench)
if (targets.length) {
  console.log('\nSpeed (same Tally XML requests to each server; lower is faster)')
  const metrics = targets[0].metrics.map((m) => m.name)
  console.log(`  ${'metric'.padEnd(34)}${targets.map((t) => t.target.padStart(20)).join('')}`)
  for (const m of metrics)
    console.log(
      `  ${m.padEnd(34)}${targets.map((t) => {
        const x = t.metrics.find((y) => y.name === m)
        return (x ? `${x.value} ${x.unit}` : "—").padStart(20)
      }).join('')}`,
    )
  console.log(`  dataset: ${targets[0].dataset}`)
} else console.log('\nSpeed: no benchmark results yet (run bench/bench.mjs)')

// pace: features gained per recorded cycle (the first record is the baseline, not a cycle)
const gained = (h) => h.done + h.partial / 2
const cycles = history.length - 1 + (label ? 1 : 0)
if (history.length) {
  const perCycle = (gained(overall) - gained(history[0])) / Math.max(cycles, 1)
  const left = overall.total - gained(overall)
  if (perCycle > 0)
    console.log(`\nTo 1:1: ${left} features left; at the recent pace of ${perCycle.toFixed(1)} a cycle, about ${Math.ceil(left / perCycle)} more cycles.`)
}

if (prev) console.log(`\nCompared with "${prev.label}" (${prev.date.slice(0, 10)}).`)
const top = features.filter((f) => f.tier === 3 && f.status !== 'done').map((f) => f.name)
console.log(`\nDaily-bookkeeping gaps (${top.length}): ${top.join(', ')}`)

if (label) {
  const entry = { label, date: new Date().toISOString(), ...overall, tiers: byTier, bench: Object.fromEntries(targets.map((t) => [t.target, t.metrics])) }
  appendFileSync(historyFile, JSON.stringify(entry) + '\n')
  console.log(`\nRecorded as "${label}".`)
}
