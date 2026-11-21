import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRules } from '../src/runner.js'

const mkRule = (over = {}) => ({
  id: 'r/one', version: '1.0.0', title: 'T', description: '', severity: 'error',
  appliesTo: { paths: ['**'], exclude: [], content: null, triggers: [] },
  check: { type: 'forbid-pattern', pattern: 'BAD', scope: 'changed-lines' },
  file: '.mottlefin/rules/one.json', digest: 'sha256:abc', ...over,
})
const mkSel = (over = {}) => ({
  ruleId: 'r/one', selected: true, certainty: 'certain',
  reasons: [{ code: 'changed-file-matches', detail: 'd', files: ['a.css'] }],
  targets: [{ path: 'a.css', evaluate: 'changed-lines', addedLines: [2] }],
  coverageGaps: [], ...over,
})
const snap = (files) => ({
  listFiles: () => Object.keys(files).sort(),
  readFile: (p) => (p in files ? files[p] : { ok: false, reason: 'missing', detail: 'nope' }),
})
const ok = (text) => ({ ok: true, text })
const go = (rule, sel, files) => runRules({ rules: [rule], invalid: [], selections: [sel], snapshot: snap(files) })[0]

test('changed-lines: only added lines count, others preexisting', () => {
  const r = go(mkRule(), mkSel(), { 'a.css': ok('BAD\nBAD\nok') })
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.violations.map((v) => v.line), [2])
  assert.deepEqual(r.preexistingViolations.map((v) => v.line), [1])
  assert.equal(r.violations[0].file, 'a.css')
  assert.deepEqual(r.filesEvaluated, ['a.css'])
  assert.equal(r.error, null)
})

test('changed-lines with only preexisting findings passes', () => {
  const r = go(mkRule(), mkSel(), { 'a.css': ok('BAD\nfine') })
  assert.equal(r.status, 'passed')
  assert.equal(r.preexistingViolations.length, 1)
})

test('whole-file: every finding counts', () => {
  const sel = mkSel({ targets: [{ path: 'a.css', evaluate: 'whole-file', addedLines: null }] })
  const r = go(mkRule(), sel, { 'a.css': ok('BAD\nBAD') })
  assert.equal(r.status, 'failed')
  assert.equal(r.violations.length, 2)
  assert.equal(r.preexistingViolations.length, 0)
})

test('passed with no findings', () => {
  const r = go(mkRule(), mkSel(), { 'a.css': ok('fine') })
  assert.equal(r.status, 'passed')
})

test('not selected -> skipped_inapplicable, check not run', () => {
  const sel = mkSel({ selected: false, reasons: [{ code: 'no-changed-file-matches', detail: 'x', files: [] }], targets: [] })
  const r = go(mkRule(), sel, {})
  assert.equal(r.status, 'skipped_inapplicable')
  assert.equal(r.selection.selected, false)
  assert.equal(r.error, null)
  assert.deepEqual(r.filesEvaluated, [])
})

test('unsupported check type', () => {
  const r = go(mkRule({ check: { type: 'mystery', scope: 'file' } }), mkSel(), { 'a.css': ok('BAD') })
  assert.equal(r.status, 'unable_to_evaluate')
  assert.equal(r.error.code, 'unsupported-check-type')
})

test('check-config-invalid', () => {
  const r = go(mkRule({ check: { type: 'forbid-pattern', pattern: '(' } }), mkSel(), { 'a.css': ok('BAD') })
  assert.equal(r.status, 'unable_to_evaluate')
  assert.equal(r.error.code, 'check-config-invalid')
})

test('invalid rule', () => {
  const out = runRules({
    rules: [], selections: [], snapshot: snap({}),
    invalid: [{ id: 'bad.json', file: 'rules/bad.json', digest: 'sha256:dd', errors: ['e1', 'e2'] }],
  })
  assert.deepEqual(out[0], {
    ruleId: 'bad.json', ruleVersion: null, ruleDigest: 'sha256:dd', ruleFile: 'rules/bad.json', title: null, severity: null,
    status: 'unable_to_evaluate',
    selection: { selected: false, certainty: 'certain', reasons: [] },
    filesEvaluated: [], violations: [], preexistingViolations: [], coverageGaps: [],
    error: { code: 'rule-invalid', detail: 'e1; e2' },
  })
})

test('unreadable target -> gap, other targets still evaluated', () => {
  const sel = mkSel({ targets: [
    { path: 'a.css', evaluate: 'whole-file', addedLines: null },
    { path: 'gone.css', evaluate: 'whole-file', addedLines: null },
  ] })
  const r = go(mkRule(), sel, { 'a.css': ok('fine') })
  assert.equal(r.status, 'passed')
  assert.equal(r.coverageGaps.length, 1)
  assert.equal(r.coverageGaps[0].code, 'file-unreadable')
  assert.equal(r.coverageGaps[0].file, 'gone.css')
  assert.match(r.coverageGaps[0].detail, /missing/)
})

test('only unreadable targets -> no-evaluable-targets', () => {
  const r = go(mkRule(), mkSel(), {})
  assert.equal(r.status, 'unable_to_evaluate')
  assert.equal(r.error.code, 'no-evaluable-targets')
  assert.equal(r.coverageGaps[0].code, 'file-unreadable')
})

test('selected with zero targets (uncertain) -> no-evaluable-targets, selector gaps kept', () => {
  const sel = mkSel({
    certainty: 'uncertain', targets: [],
    reasons: [{ code: 'applicability-uncertain', detail: 'u', files: ['a.css'] }],
    coverageGaps: [{ code: 'applicability-unknown', file: 'a.css', detail: 'cannot read' }],
  })
  const r = go(mkRule(), sel, {})
  assert.equal(r.status, 'unable_to_evaluate')
  assert.equal(r.error.code, 'no-evaluable-targets')
  assert.equal(r.selection.certainty, 'uncertain')
  assert.equal(r.coverageGaps[0].code, 'applicability-unknown')
})

test('check that throws -> check-error gap', () => {
  // a text getter that throws inside run via non-string coercion
  const bad = { ok: true, get text() { throw new Error('boom') } }
  const sel = mkSel({ targets: [
    { path: 'x.css', evaluate: 'whole-file', addedLines: null },
    { path: 'a.css', evaluate: 'whole-file', addedLines: null },
  ] })
  const r = go(mkRule(), sel, { 'x.css': bad, 'a.css': ok('fine') })
  assert.equal(r.status, 'passed')
  assert.deepEqual(r.filesEvaluated, ['a.css'])
  assert.equal(r.coverageGaps[0].code, 'check-error')
  assert.match(r.coverageGaps[0].detail, /boom/)
})

test('failed result keeps gaps; warn severity carried', () => {
  const sel = mkSel({ targets: [
    { path: 'a.css', evaluate: 'whole-file', addedLines: null },
    { path: 'gone.css', evaluate: 'whole-file', addedLines: null },
  ], coverageGaps: [{ code: 'changed-lines-unknown', file: 'a.css', detail: 'unknown' }] })
  const r = go(mkRule({ severity: 'warn' }), sel, { 'a.css': ok('BAD') })
  assert.equal(r.status, 'failed')
  assert.equal(r.severity, 'warn')
  assert.deepEqual(r.coverageGaps.map((g) => g.code), ['changed-lines-unknown', 'file-unreadable'])
})

test('results sorted by ruleId; gaps sorted file (null first) then code; violations sorted', () => {
  const rules = [mkRule({ id: 'z/z' }), mkRule({ id: 'a/a' })]
  const selections = [
    mkSel({ ruleId: 'z/z' }),
    mkSel({
      ruleId: 'a/a',
      targets: [{ path: 'b.css', evaluate: 'whole-file', addedLines: null }, { path: 'a.css', evaluate: 'whole-file', addedLines: null }],
      coverageGaps: [{ code: 'x', file: 'q', detail: '' }, { code: 'y', file: null, detail: '' }],
    }),
  ]
  const out = runRules({ rules, invalid: [{ id: 'm', file: 'm.json', digest: 'sha256:1', errors: ['e'] }], selections, snapshot: snap({ 'a.css': ok('BAD'), 'b.css': ok('BAD\nBAD'), }) })
  assert.deepEqual(out.map((r) => r.ruleId), ['a/a', 'm', 'z/z'])
  assert.deepEqual(out[0].violations.map((v) => `${v.file}:${v.line}`), ['a.css:1', 'b.css:1', 'b.css:2'])
  assert.deepEqual(out[0].coverageGaps.map((g) => g.file), [null, 'q'])
})
