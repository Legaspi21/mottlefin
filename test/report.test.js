import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, renderText, renderMarkdown, exitCodeFor } from '../src/report.js'

const sel = (certainty = 'certain', code = 'changed-file-matches') => ({
  selected: true, certainty, reasons: [{ code, detail: 'Changed file matches', files: ['src/a.css'] }],
})
const res = (over) => ({
  ruleId: 'color/no-raw-hex', ruleVersion: '1.0.0', ruleDigest: 'sha256:abcd1234ef567890', ruleFile: '.mottlefin/rules/x.json',
  title: 'Use color tokens, not raw hex values', severity: 'error', status: 'passed', selection: sel(),
  filesEvaluated: ['src/a.css'], violations: [], preexistingViolations: [], coverageGaps: [], error: null, ...over,
})
const violation = { file: 'src/components/Button.css', line: 7, column: 15, match: '#ff0000', excerpt: 'background: #ff0000;', message: 'Raw hex color | bad' }
const run = () => ({
  mode: 'diff', head: { ref: 'HEAD', sha: 'a'.repeat(40) }, base: { ref: 'HEAD~1', sha: 'b'.repeat(40) }, mergeBase: 'c'.repeat(40),
  worktree: false, dirty: false, rulesDir: '.mottlefin/rules',
  changedFiles: [
    { path: 'src/components/Button.css', status: 'M', oldPath: null, binary: false },
    { path: 'src/new.css', status: 'R', oldPath: 'src/old.css', binary: false },
  ],
  notices: [{ code: 'worktree-dirty', detail: 'uncommitted changes' }],
})
const tool = { name: 'mottlefin', version: '0.1.0' }
const mk = (results) => buildReport({ tool, run: run(), results })

const failed = res({ status: 'failed', violations: [violation], preexistingViolations: [violation, violation] })
const skipped = res({ ruleId: 'a/skip', status: 'skipped_inapplicable', selection: { selected: false, certainty: 'certain', reasons: [{ code: 'no-changed-file-matches', detail: 'Nothing matched', files: [] }] }, filesEvaluated: [] })
const unable = res({ ruleId: 'b/unable', status: 'unable_to_evaluate', filesEvaluated: [], error: { code: 'unsupported-check-type', detail: 'Unsupported check type "x".' }, coverageGaps: [{ code: 'file-unreadable', file: 'f.css', detail: 'gone' }] })
const passed = res({ ruleId: 'c/pass' })

test('summary counts', () => {
  const r = mk([failed, skipped, unable, passed])
  assert.deepEqual(r.summary, { passed: 1, failed: 1, skipped_inapplicable: 1, unable_to_evaluate: 1, coverageGaps: 1, rules: 4 })
  assert.equal(r.schemaVersion, 1)
  assert.deepEqual(Object.keys(r), ['schemaVersion', 'tool', 'run', 'summary', 'results'])
})

test('exitCodeFor', () => {
  assert.equal(exitCodeFor(mk([failed]), {}), 1)
  assert.equal(exitCodeFor(mk([res({ ...failed, severity: 'warn' })]), { strict: true }), 0)
  assert.equal(exitCodeFor(mk([passed, skipped]), { strict: true }), 0)
  assert.equal(exitCodeFor(mk([unable]), {}), 0)
  assert.equal(exitCodeFor(mk([unable]), { strict: true }), 1)
  const gap = res({ coverageGaps: [{ code: 'file-unreadable', file: 'x', detail: '' }] })
  assert.equal(exitCodeFor(mk([gap]), {}), 0)
  assert.equal(exitCodeFor(mk([gap]), { strict: true }), 1)
})

test('JSON is stable across builds regardless of input key order', () => {
  const a = JSON.stringify(mk([failed, skipped, unable, passed]))
  const reordered = { ...failed }
  const b = JSON.stringify(mk([Object.fromEntries(Object.entries(reordered).reverse()), skipped, unable, passed]))
  assert.equal(a, b)
  assert.equal(a, JSON.stringify(mk([failed, skipped, unable, passed])))
})

test('text rendering has key evidence', () => {
  const t = renderText(mk([passed, skipped, unable, failed]))
  assert.match(t, /^Mottlefin 0\.1\.0 — diff run/)
  assert.ok(t.includes('a'.repeat(12)) && !t.includes('a'.repeat(13)))
  assert.ok(t.includes('b'.repeat(12)))
  assert.ok(t.includes('c'.repeat(12)))
  assert.ok(t.includes('Changed files: 2'))
  assert.ok(t.includes('R src/old.css -> src/new.css'))
  assert.ok(t.includes('Notice [worktree-dirty]'))
  assert.ok(t.includes('FAILED  color/no-raw-hex@1.0.0  (sha256:abcd1234…'))
  assert.ok(t.includes('Why it ran: [changed-file-matches]'))
  assert.ok(t.includes('Why skipped: [no-changed-file-matches]'))
  assert.ok(t.includes('src/components/Button.css:7:15  #ff0000'))
  assert.ok(t.includes('      background: #ff0000;'))
  assert.ok(t.includes('Pre-existing violations on unchanged lines: 2 (not counted)'))
  assert.ok(t.includes('Coverage gap [file-unreadable] f.css: gone'))
  assert.ok(t.includes('Error [unsupported-check-type]: Unsupported check type "x".'))
  assert.ok(t.includes('Result: 1 passed, 1 failed, 1 skipped (inapplicable), 1 unable to evaluate, 1 coverage gaps'))
  assert.ok(t.trimEnd().endsWith('Blocking failures: color/no-raw-hex'))
  assert.ok(!/\x1b\[/.test(t))
  const order = ['FAILED', 'UNABLE', 'PASSED', 'SKIPPED'].map((l) => t.indexOf(`\n${l}  `))
  assert.deepEqual([...order].sort((x, y) => x - y), order)
})

test('text: no blocking failures, unresolved base, uncertain marker', () => {
  const r = buildReport({ tool, run: { ...run(), base: { ref: 'nope', sha: null }, mergeBase: null, mode: 'full-fallback' }, results: [res({ selection: sel('uncertain', 'diff-unavailable') })] })
  const t = renderText(r)
  assert.ok(t.includes('No blocking failures.'))
  assert.ok(t.includes('Base: nope (unresolved)'))
  assert.ok(t.includes('Merge base: unresolved'))
  assert.ok(t.includes('(uncertain)'))
})

test('warn failure is not listed as blocking', () => {
  const t = renderText(mk([res({ ...failed, severity: 'warn' })]))
  assert.ok(t.includes('No blocking failures.'))
})

test('markdown rendering and escaping', () => {
  const weird = res({ ruleId: 'x/y', selection: { selected: true, certainty: 'certain', reasons: [{ code: 'c', detail: 'a | b', files: [] }] } })
  const m = renderMarkdown(mk([failed, weird, skipped, unable]))
  assert.ok(m.includes('| Status | Count |'))
  assert.ok(m.includes('| Failed | 1 |'))
  assert.ok(m.includes('a \\| b'))
  assert.ok(m.includes('`src/components/Button.css:7:15`'))
  assert.ok(m.includes('Raw hex color | bad'))
  assert.ok(m.includes('`background: #ff0000;`'))
  assert.ok(m.includes('color/no-raw-hex@1.0.0'))
  assert.ok(m.includes('Pre-existing violations on unchanged lines: 2 (not counted)'))
  assert.ok(m.includes('Blocking failures: color/no-raw-hex'))
  assert.ok(m.includes('Result: 1 passed'.replace('1 passed', '1 passed')))
  for (const line of m.split('\n').filter((l) => l.startsWith('| ') && l.includes('x/y'))) {
    assert.equal(line.replace(/\\\|/g, '').split('|').length, 6)
  }
})

test('strict verdict agrees with exitCodeFor', () => {
  const r = mk([unable, passed])
  assert.equal(exitCodeFor(r, { strict: true }), 1)
  const t = renderText(r, { strict: true })
  assert.ok(t.includes('Blocking under --strict: 1 unable to evaluate (b/unable), 1 coverage gaps (b/unable)'))
  assert.ok(t.includes('Strict mode is on'))
  assert.ok(renderText(r).includes('No blocking failures.'))
  assert.ok(!renderText(r).includes('Strict mode is on'))
  assert.ok(renderMarkdown(r, { strict: true }).includes('Blocking under --strict'))
  assert.ok(renderText(mk([failed]), { strict: true }).includes('Blocking failures: color/no-raw-hex'))
  assert.ok(renderText(mk([passed]), { strict: true }).includes('No blocking failures.'))
})

test('full run with no base prints not used; fallback keeps unresolved', () => {
  const full = buildReport({ tool, run: { ...run(), mode: 'full', base: null, mergeBase: null }, results: [passed] })
  assert.ok(renderText(full).includes('Base: not used (full run)'))
  assert.ok(renderMarkdown(full).includes('Base: not used (full run)'))
  const fb = buildReport({ tool, run: { ...run(), mode: 'full-fallback', base: null, mergeBase: null }, results: [passed] })
  assert.ok(renderText(fb).includes('Base: unresolved'))
})

test('markdown escapes specials in free text but not in code spans', () => {
  const r = res({
    title: 'Use *tokens* <b>',
    selection: { selected: true, certainty: 'certain', reasons: [{ code: 'c', detail: 'matches src/**/*.css and a_b', files: [] }] },
    status: 'failed', violations: [{ ...violation, message: 'bad **hex** [x]' }],
    coverageGaps: [{ code: 'g', file: 'f.css', detail: 'x*y' }], error: { code: 'e', detail: 'a_b <c>' },
  })
  const m = renderMarkdown(mk([r]))
  assert.ok(m.includes('src/\\*\\*/\\*.css'))
  assert.ok(m.includes('a\\_b'))
  assert.ok(m.includes('Use \\*tokens\\* \\<b\\>'))
  assert.ok(m.includes('bad \\*\\*hex\\*\\* \\[x\\]'))
  assert.ok(m.includes('x\\*y'))
  assert.ok(m.includes('a\\_b \\<c\\>'))
  assert.ok(m.includes('`background: #ff0000;`'))
})

test('every notice appears in text and markdown headers', () => {
  const rn = { ...run(), notices: [{ code: 'n-one', detail: 'first' }, { code: 'n-two', detail: 'second' }] }
  const r = buildReport({ tool, run: rn, results: [passed] })
  for (const out of [renderText(r), renderMarkdown(r)]) {
    for (const s of ['n-one', 'first', 'n-two', 'second']) assert.ok(out.includes(s))
  }
})
