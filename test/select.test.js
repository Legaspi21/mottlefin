import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRules } from '../src/select.js';

function rule(overrides = {}) {
  const base = {
    id: 'color/no-raw-hex',
    version: '1.0.0',
    title: 'T',
    description: '',
    severity: 'error',
    appliesTo: { paths: ['src/**/*.css'], exclude: ['src/tokens/**'], content: null, triggers: [] },
    check: { type: 'forbid-pattern', pattern: '#fff', scope: 'changed-lines' },
    file: '.mottlefin/rules/color-no-raw-hex.json',
    digest: 'sha256:00',
  };
  return {
    ...base,
    ...overrides,
    appliesTo: { ...base.appliesTo, ...(overrides.appliesTo ?? {}) },
    check: { ...base.check, ...(overrides.check ?? {}) },
  };
}

// In-memory snapshot. files: { path: text | { ok:false, reason } }
function snapshot(files) {
  const reads = [];
  return {
    reads,
    listFiles: () => Object.keys(files).sort(),
    readFile: (p) => {
      reads.push(p);
      const v = files[p];
      if (v === undefined) return { ok: false, reason: 'missing', detail: 'not found' };
      if (typeof v === 'string') return { ok: true, text: v };
      return v;
    },
  };
}

const cf = (path, status = 'M', extra = {}) => ({
  path,
  status,
  oldPath: null,
  binary: false,
  addedLines: status === 'D' ? [] : [1],
  ...extra,
});

const SNAP = snapshot({
  'src/components/Button.css': 'a { color: red; }\n',
  'src/components/Card.css': 'b {}\n',
  'src/tokens/colors.css': ':root { --c: #fff; }\n',
  'docs/guide.md': '# guide\n',
  '.mottlefin/rules/color-no-raw-hex.json': '{}',
});

function one(args) {
  const out = selectRules({ snapshot: SNAP, changedFiles: [], ...args });
  assert.equal(out.length, 1);
  return out[0];
}

// ---------- diff mode ----------

test('changed-file-matches: target with changed-lines evaluation and detail naming file and glob', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('src/components/Button.css', 'M', { addedLines: [3, 4] })] });
  assert.equal(s.ruleId, 'color/no-raw-hex');
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'certain');
  assert.equal(s.reasons.length, 1);
  assert.equal(s.reasons[0].code, 'changed-file-matches');
  assert.equal(s.reasons[0].detail, 'src/components/Button.css changed and matches src/**/*.css.');
  assert.deepEqual(s.reasons[0].files, ['src/components/Button.css']);
  assert.deepEqual(s.targets, [{ path: 'src/components/Button.css', evaluate: 'changed-lines', addedLines: [3, 4] }]);
  assert.deepEqual(s.coverageGaps, []);
});

test('no-changed-file-matches when nothing relevant changed', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('docs/guide.md')] });
  assert.equal(s.selected, false);
  assert.equal(s.certainty, 'certain');
  assert.deepEqual(s.reasons.map((r) => r.code), ['no-changed-file-matches']);
  assert.deepEqual(s.reasons[0].files, []);
  assert.match(s.reasons[0].detail, /None of the 1 changed file matches src\/\*\*\/\*\.css/);
  assert.deepEqual(s.targets, []);
});

test('no-changed-file-matches with an empty diff', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [] });
  assert.equal(s.selected, false);
  assert.deepEqual(s.reasons.map((r) => r.code), ['no-changed-file-matches']);
});

test('exclude removes a file from consideration', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('src/tokens/colors.css')] });
  assert.equal(s.selected, false);
  assert.deepEqual(s.reasons.map((r) => r.code), ['no-changed-file-matches']);
});

test('check.scope "file" evaluates whole file even in diff mode, no gap', () => {
  const s = one({
    rules: [rule({ check: { scope: 'file' } })],
    mode: 'diff',
    changedFiles: [cf('src/components/Button.css', 'M', { addedLines: [2] })],
  });
  assert.equal(s.reasons[0].code, 'changed-file-matches');
  assert.deepEqual(s.targets, [{ path: 'src/components/Button.css', evaluate: 'whole-file', addedLines: [2] }]);
  assert.deepEqual(s.coverageGaps, []);
});

test('check.scope "file" with unknown added lines: whole-file, no changed-lines-unknown gap', () => {
  const s = one({
    rules: [rule({ check: { scope: 'file' } })],
    mode: 'diff',
    changedFiles: [cf('src/components/Button.css', 'M', { addedLines: null })],
  });
  assert.deepEqual(s.targets, [{ path: 'src/components/Button.css', evaluate: 'whole-file', addedLines: null }]);
  assert.deepEqual(s.coverageGaps, []);
});

test('changed-lines-unknown gap when addedLines is null (binary file still a target)', () => {
  const s = one({
    rules: [rule()],
    mode: 'diff',
    changedFiles: [cf('src/components/Button.css', 'M', { addedLines: null, binary: true })],
  });
  assert.equal(s.selected, true);
  assert.equal(s.reasons[0].code, 'changed-file-matches');
  assert.deepEqual(s.targets, [{ path: 'src/components/Button.css', evaluate: 'whole-file', addedLines: null }]);
  assert.equal(s.coverageGaps.length, 1);
  assert.equal(s.coverageGaps[0].code, 'changed-lines-unknown');
  assert.equal(s.coverageGaps[0].file, 'src/components/Button.css');
  assert.match(s.coverageGaps[0].detail, /binary/);
});

test('statuses A, C, T count as live changes', () => {
  for (const status of ['A', 'C', 'T']) {
    const extra = status === 'C' ? { oldPath: 'src/components/Card.css' } : {};
    const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('src/components/Button.css', status, extra)] });
    assert.equal(s.selected, true, status);
    assert.deepEqual(s.targets.map((t) => t.path), ['src/components/Button.css'], status);
  }
});

test('rename uses the new path: into scope selects, out of scope does not', () => {
  const into = one({
    rules: [rule()],
    mode: 'diff',
    changedFiles: [cf('src/components/Button.css', 'R', { oldPath: 'old/Button.css', addedLines: [] })],
  });
  assert.equal(into.selected, true);
  assert.deepEqual(into.targets, [{ path: 'src/components/Button.css', evaluate: 'changed-lines', addedLines: [] }]);
  assert.match(into.reasons[0].detail, /src\/components\/Button\.css \(renamed from old\/Button\.css\) changed and matches/);

  const outOf = one({
    rules: [rule()],
    mode: 'diff',
    changedFiles: [cf('old/Button.css', 'R', { oldPath: 'src/components/Button.css' })],
  });
  assert.equal(outOf.selected, false);
  assert.deepEqual(outOf.reasons.map((r) => r.code), ['no-changed-file-matches']);
});

test('only-deleted-files-match when the only matching file was deleted', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('src/components/Gone.css', 'D')] });
  assert.equal(s.selected, false);
  assert.deepEqual(s.reasons.map((r) => r.code), ['only-deleted-files-match']);
  assert.deepEqual(s.reasons[0].files, ['src/components/Gone.css']);
  assert.deepEqual(s.targets, []);
});

test('deleted file does not prevent selection by another live match', () => {
  const s = one({
    rules: [rule()],
    mode: 'diff',
    changedFiles: [cf('src/components/Gone.css', 'D'), cf('src/components/Button.css')],
  });
  assert.equal(s.selected, true);
  assert.deepEqual(s.targets.map((t) => t.path), ['src/components/Button.css']);
});

test('content gate: match makes a target, no-match gives content-gate-not-matched', () => {
  const snap = snapshot({ 'src/a.tsx': 'import styled from "x";\n', 'src/b.tsx': 'plain\n' });
  const r = rule({ appliesTo: { paths: ['src/**/*.tsx'], exclude: [], content: 'styled' } });
  const matched = selectRules({ rules: [r], mode: 'diff', snapshot: snap, changedFiles: [cf('src/a.tsx'), cf('src/b.tsx')] })[0];
  assert.equal(matched.selected, true);
  assert.deepEqual(matched.targets.map((t) => t.path), ['src/a.tsx']);
  assert.deepEqual(matched.reasons[0].files, ['src/a.tsx']);

  const notMatched = selectRules({ rules: [r], mode: 'diff', snapshot: snap, changedFiles: [cf('src/b.tsx')] })[0];
  assert.equal(notMatched.selected, false);
  assert.deepEqual(notMatched.reasons.map((x) => x.code), ['content-gate-not-matched']);
  assert.deepEqual(notMatched.reasons[0].files, ['src/b.tsx']);
});

test('content gate: deleted plus gate-rejected reports both reasons in order', () => {
  const snap = snapshot({ 'src/b.tsx': 'plain\n' });
  const r = rule({ appliesTo: { paths: ['src/**/*.tsx'], exclude: [], content: 'styled' } });
  const s = selectRules({ rules: [r], mode: 'diff', snapshot: snap, changedFiles: [cf('src/b.tsx'), cf('src/gone.tsx', 'D')] })[0];
  assert.equal(s.selected, false);
  assert.deepEqual(s.reasons.map((x) => x.code), ['only-deleted-files-match', 'content-gate-not-matched']);
});

test('content gate: unreadable file -> applicability-unknown gap and applicability-uncertain selection', () => {
  const snap = snapshot({ 'src/a.tsx': { ok: false, reason: 'too-large', detail: '3 MiB' } });
  const r = rule({ appliesTo: { paths: ['src/**/*.tsx'], exclude: [], content: 'styled' } });
  const s = selectRules({ rules: [r], mode: 'diff', snapshot: snap, changedFiles: [cf('src/a.tsx')] })[0];
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'uncertain');
  assert.deepEqual(s.reasons.map((x) => x.code), ['applicability-uncertain']);
  assert.deepEqual(s.reasons[0].files, ['src/a.tsx']);
  assert.deepEqual(s.targets, []);
  assert.equal(s.coverageGaps.length, 1);
  assert.equal(s.coverageGaps[0].code, 'applicability-unknown');
  assert.equal(s.coverageGaps[0].file, 'src/a.tsx');
  assert.match(s.coverageGaps[0].detail, /too-large/);
});

test('content gate: unreadable alongside a real target -> changed-file-matches with gap', () => {
  const snap = snapshot({ 'src/a.tsx': 'styled', 'src/b.tsx': { ok: false, reason: 'unreadable', detail: 'x' } });
  const r = rule({ appliesTo: { paths: ['src/**/*.tsx'], exclude: [], content: 'styled' } });
  const s = selectRules({ rules: [r], mode: 'diff', snapshot: snap, changedFiles: [cf('src/a.tsx'), cf('src/b.tsx')] })[0];
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'certain');
  assert.equal(s.reasons[0].code, 'changed-file-matches');
  assert.deepEqual(s.coverageGaps.map((g) => [g.code, g.file]), [['applicability-unknown', 'src/b.tsx']]);
});

test('no content gate: files are not read in diff mode', () => {
  const snap = snapshot({});
  const s = selectRules({ rules: [rule()], mode: 'diff', snapshot: snap, changedFiles: [cf('src/x.css')] })[0];
  assert.equal(s.selected, true);
  assert.deepEqual(snap.reads, []);
});

test('rule-changed: rule file in diff -> full scope, whole-file targets', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('.mottlefin/rules/color-no-raw-hex.json')] });
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'certain');
  assert.deepEqual(s.reasons.map((r) => r.code), ['rule-changed']);
  assert.deepEqual(s.reasons[0].files, ['.mottlefin/rules/color-no-raw-hex.json']);
  assert.deepEqual(s.targets, [
    { path: 'src/components/Button.css', evaluate: 'whole-file', addedLines: null },
    { path: 'src/components/Card.css', evaluate: 'whole-file', addedLines: null },
  ]);
});

test('rule-changed takes precedence over changed-file-matches', () => {
  const s = one({
    rules: [rule()],
    mode: 'diff',
    changedFiles: [cf('src/components/Button.css', 'M', { addedLines: [1] }), cf('.mottlefin/rules/color-no-raw-hex.json', 'A')],
  });
  assert.deepEqual(s.reasons.map((r) => r.code), ['rule-changed']);
  assert.ok(s.targets.every((t) => t.evaluate === 'whole-file'));
});

test('deleted rule file is not rule-changed', () => {
  const s = one({ rules: [rule()], mode: 'diff', changedFiles: [cf('.mottlefin/rules/color-no-raw-hex.json', 'D')] });
  assert.equal(s.selected, false);
});

test('trigger-changed: any status incl. D, full scope', () => {
  const r = rule({ appliesTo: { triggers: ['tokens/**'] } });
  for (const status of ['M', 'D']) {
    const s = one({ rules: [r], mode: 'diff', changedFiles: [cf('tokens/colors.json', status)] });
    assert.equal(s.selected, true, status);
    assert.deepEqual(s.reasons.map((x) => x.code), ['trigger-changed']);
    assert.deepEqual(s.reasons[0].files, ['tokens/colors.json']);
    assert.match(s.reasons[0].detail, /tokens\/colors\.json matches trigger tokens\/\*\*/);
    assert.deepEqual(s.targets.map((t) => t.path), ['src/components/Button.css', 'src/components/Card.css']);
  }
});

test('trigger-changed considers the old path of a rename', () => {
  const r = rule({ appliesTo: { triggers: ['tokens/**'] } });
  const s = one({ rules: [r], mode: 'diff', changedFiles: [cf('archive/colors.json', 'R', { oldPath: 'tokens/colors.json' })] });
  assert.deepEqual(s.reasons.map((x) => x.code), ['trigger-changed']);
  assert.deepEqual(s.reasons[0].files, ['tokens/colors.json']);
});

test('full scope with no matching files -> no-files-match (rule-changed)', () => {
  const r = rule({ appliesTo: { paths: ['nothing/**'] } });
  const s = one({ rules: [r], mode: 'diff', changedFiles: [cf(r.file)] });
  assert.equal(s.selected, false);
  assert.deepEqual(s.reasons.map((x) => x.code), ['no-files-match']);
  assert.match(s.reasons[0].detail, /Rule file .* changed/);
});

// ---------- full / full-fallback ----------

test('full mode: full-run, certain, all matching files minus exclude, whole-file', () => {
  const s = one({ rules: [rule()], mode: 'full' });
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'certain');
  assert.deepEqual(s.reasons.map((r) => r.code), ['full-run']);
  assert.deepEqual(s.reasons[0].files, ['src/components/Button.css', 'src/components/Card.css']);
  assert.deepEqual(s.targets.map((t) => [t.path, t.evaluate, t.addedLines]), [
    ['src/components/Button.css', 'whole-file', null],
    ['src/components/Card.css', 'whole-file', null],
  ]);
  assert.deepEqual(s.coverageGaps, []);
});

test('full-fallback mode: diff-unavailable, uncertain', () => {
  const s = one({ rules: [rule()], mode: 'full-fallback' });
  assert.equal(s.selected, true);
  assert.equal(s.certainty, 'uncertain');
  assert.deepEqual(s.reasons.map((r) => r.code), ['diff-unavailable']);
  assert.equal(s.targets.length, 2);
});

test('full mode ignores changedFiles', () => {
  const s = one({ rules: [rule()], mode: 'full', changedFiles: [cf('docs/guide.md')] });
  assert.deepEqual(s.reasons.map((r) => r.code), ['full-run']);
});

test('full mode: no-files-match when nothing matches', () => {
  for (const mode of ['full', 'full-fallback']) {
    const s = one({ rules: [rule({ appliesTo: { paths: ['**/*.scss'] } })], mode });
    assert.equal(s.selected, false, mode);
    assert.deepEqual(s.reasons.map((r) => r.code), ['no-files-match']);
    assert.deepEqual(s.targets, []);
  }
});

test('full mode: content gate applied; unreadable -> gap; gate rejects all -> no-files-match', () => {
  const snap = snapshot({
    'src/a.tsx': 'styled',
    'src/b.tsx': 'plain',
    'src/c.tsx': { ok: false, reason: 'binary', detail: 'NUL byte' },
  });
  const r = rule({ appliesTo: { paths: ['src/*.tsx'], exclude: [], content: 'styled' } });
  const s = selectRules({ rules: [r], mode: 'full', snapshot: snap, changedFiles: [] })[0];
  assert.equal(s.selected, true);
  assert.deepEqual(s.targets.map((t) => t.path), ['src/a.tsx']);
  assert.deepEqual(s.coverageGaps.map((g) => [g.code, g.file]), [['applicability-unknown', 'src/c.tsx']]);
  assert.deepEqual(s.reasons[0].files, ['src/a.tsx', 'src/c.tsx']);

  const onlyPlain = snapshot({ 'src/b.tsx': 'plain' });
  const s2 = selectRules({ rules: [r], mode: 'full', snapshot: onlyPlain, changedFiles: [] })[0];
  assert.equal(s2.selected, false);
  assert.deepEqual(s2.reasons.map((x) => x.code), ['no-files-match']);
  assert.match(s2.reasons[0].detail, /content gate/);
});

test('full mode: only unreadable gated files -> still selected with gaps', () => {
  const snap = snapshot({ 'src/c.tsx': { ok: false, reason: 'unreadable', detail: 'EACCES' } });
  const r = rule({ appliesTo: { paths: ['src/*.tsx'], exclude: [], content: 'x' } });
  const s = selectRules({ rules: [r], mode: 'full', snapshot: snap, changedFiles: [] })[0];
  assert.equal(s.selected, true);
  assert.deepEqual(s.targets, []);
  assert.equal(s.coverageGaps.length, 1);
});

// ---------- general ----------

test('selections are returned in rule order and are deterministic and sorted', () => {
  const rules = [
    rule({ id: 'z/last', appliesTo: { paths: ['**/*.css'], exclude: [] } }),
    rule({ id: 'a/first', check: { scope: 'changed-lines' } }),
  ];
  const changed = [
    cf('src/z.css', 'M', { addedLines: null }),
    cf('src/a.css', 'M', { addedLines: null }),
    cf('src/m.css'),
  ];
  const snap = snapshot({ 'src/a.css': '', 'src/m.css': '', 'src/z.css': '' });
  const out1 = selectRules({ rules, mode: 'diff', changedFiles: changed, snapshot: snap });
  const out2 = selectRules({ rules, mode: 'diff', changedFiles: [...changed].reverse(), snapshot: snap });
  assert.deepEqual(out1.map((s) => s.ruleId), ['z/last', 'a/first']);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  const s = out1[0];
  assert.deepEqual(s.targets.map((t) => t.path), ['src/a.css', 'src/m.css', 'src/z.css']);
  assert.deepEqual(s.reasons[0].files, ['src/a.css', 'src/m.css', 'src/z.css']);
  assert.deepEqual(s.coverageGaps.map((g) => g.file), ['src/a.css', 'src/z.css']);
});

test('gaps sorted by file then code', () => {
  const snap = snapshot({ 'src/b.tsx': 'styled', 'src/a.tsx': { ok: false, reason: 'missing', detail: '' } });
  const r = rule({ appliesTo: { paths: ['src/*.tsx'], exclude: [], content: 'styled' } });
  const s = selectRules({
    rules: [r],
    mode: 'diff',
    snapshot: snap,
    changedFiles: [cf('src/b.tsx', 'M', { addedLines: null }), cf('src/a.tsx')],
  })[0];
  assert.deepEqual(s.coverageGaps.map((g) => [g.file, g.code]), [
    ['src/a.tsx', 'applicability-unknown'],
    ['src/b.tsx', 'changed-lines-unknown'],
  ]);
});

test('every reason has a non-empty detail sentence and files array', () => {
  const r = rule({ appliesTo: { triggers: ['tokens/**'] } });
  const cases = [
    { mode: 'full' },
    { mode: 'full-fallback' },
    { mode: 'diff', changedFiles: [cf('docs/guide.md')] },
    { mode: 'diff', changedFiles: [cf('tokens/x.json')] },
    { mode: 'diff', changedFiles: [cf(r.file)] },
    { mode: 'diff', changedFiles: [cf('src/x.css')] },
    { mode: 'diff', changedFiles: [cf('src/x.css', 'D')] },
  ];
  for (const c of cases) {
    for (const reason of one({ rules: [r], ...c }).reasons) {
      assert.equal(typeof reason.detail, 'string');
      assert.ok(reason.detail.length > 10);
      assert.ok(reason.detail.endsWith('.'));
      assert.ok(Array.isArray(reason.files));
    }
  }
});

test('unknown mode throws', () => {
  assert.throws(() => selectRules({ rules: [], mode: 'nope', changedFiles: [], snapshot: SNAP }));
});
