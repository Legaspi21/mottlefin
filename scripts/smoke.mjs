import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureRepo } from '../fixture/setup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'mottlefin.js')
const outDir = path.join(process.cwd(), 'smoke-results')
mkdirSync(outDir, { recursive: true })

const tmp = mkdtempSync(path.join(tmpdir(), 'mottlefin-smoke-'))
const repo = path.join(tmp, 'repo')
createFixtureRepo(repo)

const scenarios = [
  { name: 'relevant-clean', args: ['--base', 'base', '--head', 'relevant-clean'], status: 'passed', code: 0 },
  { name: 'unrelated', args: ['--base', 'base', '--head', 'unrelated'], status: 'skipped_inapplicable', code: 0 },
  { name: 'regression', args: ['--base', 'base', '--head', 'regression'], status: 'failed', code: 1 },
  { name: 'full-on-base', args: ['--full', '--head', 'base'], status: 'failed', code: 1 },
  { name: 'unresolvable-base', args: ['--base', 'no-such-ref', '--head', 'regression'], status: 'failed', code: 1 },
]

const run = (args) => spawnSync(process.execPath, [bin, 'run', '--repo', repo, ...args], { encoding: 'utf8', cwd: tmp })
const rows = []
let mismatch = false

for (const s of scenarios) {
  const cmd = `mottlefin run --repo <fixture> ${s.args.join(' ')} --format text`
  const text = run([...s.args, '--format', 'text'])
  const json = run([...s.args, '--format', 'json'])
  const md = run([...s.args, '--format', 'markdown'])
  let status = 'n/a'
  try { status = JSON.parse(json.stdout).results.map((r) => r.status).join(',') } catch { /* keep n/a */ }
  const ok = text.status === s.code && status === s.status
  if (!ok) mismatch = true
  rows.push({ name: s.name, cmd, expected: `${s.status} / exit ${s.code}`, status, code: text.status, ok })

  console.log(`\n===== ${s.name} =====\n$ ${cmd}\nexit code: ${text.status}\n`)
  console.log(text.stdout + (text.stderr ? `\n[stderr]\n${text.stderr}` : ''))
  writeFileSync(path.join(outDir, `${s.name}.txt`), text.stdout)
  writeFileSync(path.join(outDir, `${s.name}.json`), json.stdout)
  writeFileSync(path.join(outDir, `${s.name}.md`), md.stdout)
}

const summary = [
  '# Smoke results',
  '',
  '| scenario | command | expected | actual status | exit code | result |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | \`${r.cmd}\` | ${r.expected} | ${r.status} | ${r.code} | ${r.ok ? 'PASS' : 'MISMATCH'} |`),
  '',
].join('\n')
writeFileSync(path.join(outDir, 'SUMMARY.md'), summary)
console.log('\n' + summary)
rmSync(tmp, { recursive: true, force: true })
process.exit(mismatch ? 1 : 0)
