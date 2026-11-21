import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureRepo } from '../fixture/setup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'mottlefin.js')

let tmp, dir, refs

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mottlefin-smoke-'))
  dir = path.join(tmp, 'repo')
  refs = createFixtureRepo(dir).refs
})
after(() => rmSync(tmp, { recursive: true, force: true }))

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: opts.cwd ?? tmp })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
function runJson(extra, { repo = dir } = {}) {
  const r = cli(['run', '--repo', repo, ...extra, '--format', 'json'])
  let report = null
  try { report = JSON.parse(r.stdout) } catch { /* leave null */ }
  return { ...r, report }
}
const ruleResult = (report, id = 'color/no-raw-hex') => report.results.find((x) => x.ruleId === id)

test('relevant-clean: passed, changed-file-matches names Button.css, exit 0', () => {
  const { code, report } = runJson(['--base', 'base', '--head', 'relevant-clean'])
  assert.equal(code, 0)
  assert.equal(report.run.mode, 'diff')
  const r = ruleResult(report)
  assert.equal(r.status, 'passed')
  const reason = r.selection.reasons.find((x) => x.code === 'changed-file-matches')
  assert.ok(reason)
  assert.ok(reason.files.includes('src/components/Button.css'))
  assert.equal(r.ruleVersion, '1.0.0')
  assert.match(r.ruleDigest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(r.violations, [])
})

test('unrelated: skipped_inapplicable, no files evaluated, exit 0', () => {
  const { code, report } = runJson(['--base', 'base', '--head', 'unrelated'])
  assert.equal(code, 0)
  const r = ruleResult(report)
  assert.equal(r.status, 'skipped_inapplicable')
  assert.equal(r.selection.selected, false)
  assert.ok(r.selection.reasons.some((x) => x.code === 'no-changed-file-matches'))
  assert.deepEqual(r.filesEvaluated, [])
})

test('regression: failed with exactly one violation at the exact line and column, exit 1', () => {
  const { code, report } = runJson(['--base', 'base', '--head', 'regression'])
  assert.equal(code, 1)
  const r = ruleResult(report)
  assert.equal(r.status, 'failed')
  assert.equal(r.violations.length, 1)
  const show = spawnSync('git', ['show', 'regression:src/components/Button.css'], { cwd: dir, encoding: 'utf8' }).stdout
  const lines = show.split('\n')
  const idx = lines.findIndex((l) => l.includes('#ff0000'))
  const v = r.violations[0]
  assert.equal(v.file, 'src/components/Button.css')
  assert.equal(v.line, idx + 1)
  assert.equal(v.column, lines[idx].indexOf('#ff0000') + 1)
  assert.equal(v.match, '#ff0000')
  assert.equal(report.run.head.sha, refs.regression)
  assert.equal(report.run.base.sha, refs.base)
  assert.equal(report.run.mergeBase, refs.base)
})

test('--full on base: full-run, full mode, pre-existing Legacy.css debt fails', () => {
  const { code, report } = runJson(['--full', '--head', 'base'])
  assert.equal(code, 1)
  assert.equal(report.run.mode, 'full')
  const r = ruleResult(report)
  assert.ok(r.selection.reasons.some((x) => x.code === 'full-run'))
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.violations.map((v) => v.file), ['src/components/Legacy.css'])
  assert.ok(!r.filesEvaluated.includes('src/tokens/colors.css'))
  assert.ok(r.filesEvaluated.includes('src/components/Button.css'))
})

test('unresolvable base: full-fallback, notice, rule selected as uncertain', () => {
  const { report } = runJson(['--base', 'no-such-ref', '--head', 'regression'])
  assert.equal(report.run.mode, 'full-fallback')
  assert.ok(report.run.notices.some((n) => n.code === 'diff-unavailable'))
  assert.equal(report.run.base.sha, null)
  const r = ruleResult(report)
  assert.equal(r.selection.selected, true)
  assert.equal(r.selection.certainty, 'uncertain')
  assert.ok(r.selection.reasons.some((x) => x.code === 'diff-unavailable'))
})

test('two runs on the same commit produce byte-identical JSON', () => {
  const a = cli(['run', '--repo', dir, '--base', 'base', '--head', 'regression', '--format', 'json'])
  const b = cli(['run', '--repo', dir, '--base', 'base', '--head', 'regression', '--format', 'json'])
  assert.equal(a.stdout, b.stdout)
  assert.ok(a.stdout.length > 0)
})

test('text format shows FAILED and file:line:col', () => {
  const json = runJson(['--base', 'base', '--head', 'regression']).report
  const v = ruleResult(json).violations[0]
  const t = cli(['run', '--repo', dir, '--base', 'base', '--head', 'regression', '--format', 'text'])
  assert.equal(t.code, 1)
  assert.ok(t.stdout.includes('FAILED'))
  assert.ok(t.stdout.includes(`Button.css:${v.line}:${v.column}`))
})

test('unsupported check type: unable_to_evaluate; exit 1 only with --strict', () => {
  const rulesDir = path.join(tmp, 'extra-rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(path.join(rulesDir, 'future.json'), JSON.stringify({
    id: 'future/thing', version: '2.0.0', title: 'Future check',
    appliesTo: { paths: ['src/**/*.css'] },
    check: { type: 'no-such-check' },
  }))
  const args = ['--rules', rulesDir, '--base', 'base', '--head', 'relevant-clean']
  const lax = runJson(args)
  const r = ruleResult(lax.report, 'future/thing')
  assert.equal(r.status, 'unable_to_evaluate')
  assert.equal(r.error.code, 'unsupported-check-type')
  assert.equal(lax.code, 0)
  const strict = runJson([...args, '--strict'])
  assert.equal(strict.code, 1)
})

test('validate exits 0 on fixture rules', () => {
  const r = cli(['validate', '--repo', dir])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('color/no-raw-hex@1.0.0'))
})

test('exit 2 outside a git repository, no stack trace', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'mottlefin-nogit-'))
  try {
    const r = cli(['run'], { cwd: outside })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /not inside a git repository/)
    assert.ok(!/\n\s+at /.test(r.stderr))
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('unknown flag exits 2 with usage', () => {
  const r = cli(['run', '--bogus'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Usage:/)
})

test('rules differ from head: uncommitted rule edit on main with --head regression adds notice', () => {
  const repo2 = path.join(tmp, 'repo-dirty-rules')
  createFixtureRepo(repo2)
  const f = path.join(repo2, '.mottlefin/rules/color-no-raw-hex.json')
  writeFileSync(f, readFileSync(f, 'utf8').replace('"1.0.0"', '"1.1.0"'))
  const { report } = runJson(['--base', 'base', '--head', 'regression'], { repo: repo2 })
  const n = report.run.notices.find((x) => x.code === 'rules-differ-from-head')
  assert.ok(n)
  assert.ok(n.detail.includes('.mottlefin/rules/color-no-raw-hex.json'))
  assert.ok(n.detail.includes('regression'))
  assert.ok(n.detail.includes(refs.regression.slice(0, 7)))
})

test('clean tree: no rules-differ-from-head notice', () => {
  const { report } = runJson(['--base', 'base', '--head', 'regression'])
  assert.ok(!report.run.notices.some((x) => x.code === 'rules-differ-from-head'))
})

test('strict text verdict for unsupported check type says Blocking under --strict', () => {
  const rulesDir = path.join(tmp, 'strict-rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(path.join(rulesDir, 'future.json'), JSON.stringify({
    id: 'future/thing', version: '2.0.0', title: 'Future check',
    appliesTo: { paths: ['src/**/*.css'] },
    check: { type: 'no-such-check' },
  }))
  const r = cli(['run', '--repo', dir, '--rules', rulesDir, '--base', 'base', '--head', 'relevant-clean', '--strict', '--format', 'text'])
  assert.equal(r.code, 1)
  assert.ok(r.stdout.includes('Blocking under --strict'), r.stdout)
})
