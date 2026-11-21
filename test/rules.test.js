import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRules } from '../src/rules.js';

function validRule(overrides = {}) {
  return {
    schema: 1,
    id: 'color/no-raw-hex',
    version: '1.0.0',
    title: 'Use color tokens, not raw hex values',
    description: 'Component styles must reference var(--color-*) tokens.',
    severity: 'error',
    appliesTo: { paths: ['src/**/*.css'], exclude: ['src/tokens/**'], content: null, triggers: [] },
    check: { type: 'forbid-pattern', pattern: '#[0-9a-f]{3}', flags: '', allow: [], scope: 'changed-lines', message: 'm' },
    ...overrides,
  };
}

function makeRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'mottlefin-rules-'));
  const rulesDir = path.join(root, '.mottlefin', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rulesDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return { root, rulesDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function load(files) {
  const repo = makeRepo(files);
  try {
    return loadRules(repo.rulesDir, { repoRoot: repo.root });
  } finally {
    repo.cleanup();
  }
}

function errorsFor(rule) {
  const { rules, invalid } = load({ 'r.json': rule });
  assert.equal(rules.length, 0, 'expected rule to be invalid');
  assert.equal(invalid.length, 1);
  return invalid[0].errors;
}

test('loads a valid rule with normalized fields, repo-relative file and digest', () => {
  const raw = JSON.stringify(validRule(), null, 2);
  const { rules, invalid } = load({ 'color-no-raw-hex.json': raw });
  assert.deepEqual(invalid, []);
  assert.equal(rules.length, 1);
  const r = rules[0];
  assert.equal(r.id, 'color/no-raw-hex');
  assert.equal(r.file, '.mottlefin/rules/color-no-raw-hex.json');
  assert.equal(r.digest, 'sha256:' + createHash('sha256').update(raw).digest('hex'));
  assert.equal(r.schema, undefined);
  assert.deepEqual(Object.keys(r), ['id', 'version', 'title', 'description', 'severity', 'appliesTo', 'check', 'file', 'digest']);
});

test('fills defaults for optional fields', () => {
  const rule = { id: 'a', version: '0.1.0', title: 'A', appliesTo: { paths: ['**/*.css'] }, check: { type: 'forbid-pattern' } };
  const { rules, invalid } = load({ 'a.json': rule });
  assert.deepEqual(invalid, []);
  assert.deepEqual(rules[0].appliesTo, { paths: ['**/*.css'], exclude: [], content: null, triggers: [] });
  assert.equal(rules[0].description, '');
  assert.equal(rules[0].severity, 'error');
  assert.deepEqual(rules[0].check, { type: 'forbid-pattern', scope: 'changed-lines' });
});

test('keeps check opaque and preserves scope "file"', () => {
  const { rules } = load({ 'a.json': validRule({ check: { type: 'x', whatever: [1, 2], scope: 'file' } }) });
  assert.deepEqual(rules[0].check, { type: 'x', whatever: [1, 2], scope: 'file' });
});

test('unknown check type is NOT a load error', () => {
  const { rules, invalid } = load({ 'a.json': validRule({ check: { type: 'some-future-check' } }) });
  assert.deepEqual(invalid, []);
  assert.equal(rules[0].check.type, 'some-future-check');
});

test('walks recursively, *.json only, sorted by id then file', () => {
  const { rules, invalid } = load({
    'z/b.json': validRule({ id: 'b' }),
    'a.json': validRule({ id: 'c' }),
    'nested/deep/x.json': validRule({ id: 'a/x' }),
    'README.md': '# not a rule',
    'notes.txt': 'nope',
  });
  assert.deepEqual(invalid, []);
  assert.deepEqual(rules.map((r) => r.id), ['a/x', 'b', 'c']);
  assert.deepEqual(rules.map((r) => r.file), [
    '.mottlefin/rules/nested/deep/x.json',
    '.mottlefin/rules/z/b.json',
    '.mottlefin/rules/a.json',
  ]);
});

test('file path may start with ../ when rules dir is outside repoRoot', () => {
  const repo = makeRepo({ 'a.json': validRule({ id: 'a' }) });
  try {
    const fakeRoot = path.join(repo.root, 'sub');
    mkdirSync(fakeRoot);
    const { rules } = loadRules(repo.rulesDir, { repoRoot: fakeRoot });
    assert.equal(rules[0].file, '../.mottlefin/rules/a.json');
  } finally {
    repo.cleanup();
  }
});

test('digest is stable and depends on raw bytes, not parsed content', () => {
  const compact = JSON.stringify(validRule());
  const pretty = JSON.stringify(validRule(), null, 2);
  const a1 = load({ 'a.json': compact }).rules[0].digest;
  const a2 = load({ 'a.json': compact }).rules[0].digest;
  const b = load({ 'a.json': pretty }).rules[0].digest;
  assert.match(a1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('invalid JSON becomes an InvalidRule keyed by file path with digest', () => {
  const raw = '{ "id": "a", ';
  const { rules, invalid } = load({ 'broken.json': raw });
  assert.equal(rules.length, 0);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].id, '.mottlefin/rules/broken.json');
  assert.equal(invalid[0].file, '.mottlefin/rules/broken.json');
  assert.equal(invalid[0].digest, 'sha256:' + createHash('sha256').update(raw).digest('hex'));
  assert.equal(invalid[0].errors.length, 1);
  assert.match(invalid[0].errors[0], /invalid JSON/);
});

test('non-object JSON is invalid', () => {
  assert.match(errorsFor([1, 2])[0], /must be a JSON object/);
  assert.match(load({ 'n.json': 'null' }).invalid[0].errors[0], /must be a JSON object/);
});

test('collects all errors, not just the first', () => {
  const errors = errorsFor({ id: 'Bad Id', version: '1', title: '', appliesTo: { paths: [] }, check: {}, extra: true });
  assert.ok(errors.length >= 6, errors.join('\n'));
  assert.ok(errors.some((e) => /unknown top-level key "extra"/.test(e)));
  assert.ok(errors.some((e) => /^id /.test(e)));
  assert.ok(errors.some((e) => /^version /.test(e)));
  assert.ok(errors.some((e) => /^title /.test(e)));
  assert.ok(errors.some((e) => /appliesTo\.paths/.test(e)));
  assert.ok(errors.some((e) => /check\.type/.test(e)));
});

test('InvalidRule id is the declared id when it is a string, else the file path', () => {
  const a = load({ 'a.json': validRule({ id: 'Not Valid', version: 'x' }) }).invalid[0];
  assert.equal(a.id, 'Not Valid');
  const b = load({ 'b.json': validRule({ id: 42 }) }).invalid[0];
  assert.equal(b.id, '.mottlefin/rules/b.json');
});

test('schema must be 1 if present', () => {
  assert.match(errorsFor(validRule({ schema: 2 })).join(), /schema must be 1/);
  const noSchema = validRule();
  delete noSchema.schema;
  assert.equal(load({ 'a.json': noSchema }).rules.length, 1);
});

test('id is required and must match the pattern', () => {
  const r = validRule();
  delete r.id;
  assert.match(errorsFor(r).join(), /id is required/);
  for (const bad of ['Upper', '-lead', 'a//b', 'a/', '/a', 'a_b', '']) {
    assert.match(errorsFor(validRule({ id: bad })).join(), /^id /, bad);
  }
  for (const good of ['a', 'color/no-raw-hex', 'a1/b2-c/d']) {
    assert.equal(load({ 'a.json': validRule({ id: good }) }).rules.length, 1, good);
  }
});

test('version is required and must be MAJOR.MINOR.PATCH', () => {
  const r = validRule();
  delete r.version;
  assert.match(errorsFor(r).join(), /version is required/);
  for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', 1]) {
    assert.match(errorsFor(validRule({ version: bad })).join(), /^version /, String(bad));
  }
});

test('title is required non-empty string; description optional string', () => {
  const r = validRule();
  delete r.title;
  assert.match(errorsFor(r).join(), /title is required/);
  assert.match(errorsFor(validRule({ title: '  ' })).join(), /title must be a non-empty string/);
  assert.match(errorsFor(validRule({ title: 5 })).join(), /title must be a non-empty string/);
  assert.match(errorsFor(validRule({ description: 5 })).join(), /description must be a string/);
});

test('severity must be error or warn', () => {
  assert.match(errorsFor(validRule({ severity: 'info' })).join(), /severity/);
  assert.equal(load({ 'a.json': validRule({ severity: 'warn' }) }).rules[0].severity, 'warn');
});

test('appliesTo: required object, unknown keys, globs validated', () => {
  const r = validRule();
  delete r.appliesTo;
  assert.match(errorsFor(r).join(), /appliesTo is required/);
  assert.match(errorsFor(validRule({ appliesTo: [] })).join(), /appliesTo must be an object/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], include: ['b'] } })).join(), /unknown appliesTo key "include"/);
  assert.match(errorsFor(validRule({ appliesTo: {} })).join(), /appliesTo\.paths is required/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: 'src/**' } })).join(), /appliesTo\.paths must be an array/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: [] } })).join(), /non-empty/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['src/{a,b'] } })).join(), /appliesTo\.paths\[0\] is not a valid glob/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: [''] } })).join(), /appliesTo\.paths\[0\] is not a valid glob/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: [3] } })).join(), /appliesTo\.paths\[0\] must be a string/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], exclude: ['ok', 'b}'] } })).join(), /appliesTo\.exclude\[1\]/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], triggers: 'x' } })).join(), /appliesTo\.triggers must be an array/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], triggers: ['{'] } })).join(), /appliesTo\.triggers\[0\]/);
});

test('appliesTo.content must be a valid regex source or null', () => {
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], content: '(' } })).join(), /appliesTo\.content is not a valid regex/);
  assert.match(errorsFor(validRule({ appliesTo: { paths: ['a'], content: 5 } })).join(), /appliesTo\.content must be/);
  assert.equal(load({ 'a.json': validRule({ appliesTo: { paths: ['a'], content: 'styled\\.' } }) }).rules[0].appliesTo.content, 'styled\\.');
});

test('check: required object with non-empty type; scope restricted', () => {
  const r = validRule();
  delete r.check;
  assert.match(errorsFor(r).join(), /check is required/);
  assert.match(errorsFor(validRule({ check: 'forbid-pattern' })).join(), /check must be an object/);
  assert.match(errorsFor(validRule({ check: [] })).join(), /check must be an object/);
  assert.match(errorsFor(validRule({ check: { type: '' } })).join(), /check\.type/);
  assert.match(errorsFor(validRule({ check: { type: 3 } })).join(), /check\.type/);
  assert.match(errorsFor(validRule({ check: { type: 'x', scope: 'line' } })).join(), /check\.scope/);
});

test('duplicate id: later file in sorted path order is invalid and names the first', () => {
  const { rules, invalid } = load({
    'b.json': validRule({ id: 'dup', title: 'second' }),
    'a.json': validRule({ id: 'dup', title: 'first' }),
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].title, 'first');
  assert.equal(rules[0].file, '.mottlefin/rules/a.json');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].id, 'dup');
  assert.equal(invalid[0].file, '.mottlefin/rules/b.json');
  assert.deepEqual(invalid[0].errors, ['duplicate id "dup": already defined in .mottlefin/rules/a.json']);
});

test('invalid output sorted by id then file', () => {
  const { invalid } = load({
    'c.json': '{',
    'a.json': validRule({ id: 'zz', version: 'bad' }),
    'b.json': validRule({ id: 'aa', version: 'bad' }),
  });
  assert.deepEqual(invalid.map((i) => i.id), ['.mottlefin/rules/c.json', 'aa', 'zz']);
});

test('throws if rules dir is missing or not a directory', () => {
  const repo = makeRepo({ 'a.json': validRule() });
  try {
    assert.throws(() => loadRules(path.join(repo.root, 'nope'), { repoRoot: repo.root }), /does not exist/);
    assert.throws(() => loadRules(path.join(repo.rulesDir, 'a.json'), { repoRoot: repo.root }), /not a directory/);
  } finally {
    repo.cleanup();
  }
});

test('empty rules dir yields empty arrays', () => {
  assert.deepEqual(load({}), { rules: [], invalid: [] });
});
