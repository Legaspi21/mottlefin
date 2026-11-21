import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checks } from '../src/checks/index.js'

const fp = checks['forbid-pattern']
const run = (config, text) => fp.run({ path: 'a.css', text, config: { type: 'forbid-pattern', ...config } })

test('registry exposes forbid-pattern', () => {
  assert.equal(typeof fp.validate, 'function')
  assert.equal(typeof fp.run, 'function')
})

test('validate accepts a good config', () => {
  assert.deepEqual(fp.validate({ type: 'forbid-pattern', pattern: 'x', flags: 'i', allow: ['y'], scope: 'file', message: 'm' }), [])
  assert.deepEqual(fp.validate({ type: 'forbid-pattern', pattern: 'x', flags: 'gi' }), [])
})

test('validate rejects bad configs', () => {
  assert.ok(fp.validate({ type: 'forbid-pattern' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: '' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 5 }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: '(' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', flags: 'x' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', flags: 'y' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', allow: 'b' }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', allow: ['('] }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', message: 3 }).length > 0)
  assert.ok(fp.validate({ type: 'forbid-pattern', pattern: 'a', bogus: 1 }).some((e) => e.includes('bogus')))
})

test('finds multiple matches per line with columns', () => {
  const f = run({ pattern: '#[0-9a-f]{3}\\b' }, 'a: #fff; b: #000;\nnone\n')
  assert.deepEqual(f.map((x) => [x.line, x.column, x.match]), [[1, 4, '#fff'], [1, 13, '#000']])
  assert.equal(f[0].excerpt, 'a: #fff; b: #000;')
})

test('default and custom message', () => {
  assert.equal(run({ pattern: 'x' }, 'x')[0].message, 'Forbidden pattern x')
  assert.equal(run({ pattern: 'x', message: 'no x' }, 'x')[0].message, 'no x')
})

test('allow list skips whole line', () => {
  const f = run({ pattern: 'foo', allow: ['ok-foo', 'LEGACY'] }, 'foo\nok-foo foo\nfoo LEGACY\nfoo')
  assert.deepEqual(f.map((x) => x.line), [1, 4])
})

test('flags: case-insensitive, g normalized, CRLF handled', () => {
  const f = run({ pattern: 'foo', flags: 'ig' }, 'FOO\r\nfoo\r\n')
  assert.equal(f.length, 2)
  assert.equal(f[1].line, 2)
  assert.equal(f[0].excerpt, 'FOO')
})

test('zero-length matches are ignored and do not loop', () => {
  assert.deepEqual(run({ pattern: 'x*' }, 'abc\nxx'), [{ line: 2, column: 1, match: 'xx', excerpt: 'xx', message: 'Forbidden pattern x*' }])
})

test('excerpt trimmed and truncated to 200', () => {
  const long = '   ' + 'a'.repeat(300)
  const f = run({ pattern: 'a' }, long)
  assert.equal(f[0].excerpt.length, 200)
  assert.equal(f[0].column, 4)
})

test('findings sorted by line then column', () => {
  const f = run({ pattern: 'a|b' }, 'ba\nb')
  assert.deepEqual(f.map((x) => [x.line, x.column]), [[1, 1], [1, 2], [2, 1]])
})
