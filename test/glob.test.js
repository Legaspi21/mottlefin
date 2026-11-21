import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../src/glob.js';

const m = (glob, path) => globToRegExp(glob).test(path);

test('* does not cross /', () => {
  assert.equal(m('src/*.css', 'src/a.css'), true);
  assert.equal(m('src/*.css', 'src/x/a.css'), false);
  assert.equal(m('*.css', 'a/b.css'), false);
});

test('* matches an empty run and dotfiles', () => {
  assert.equal(m('src/*.css', 'src/.css'), true);
  assert.equal(m('src/*', 'src/.hidden'), true);
});

test('**/ matches zero directories', () => {
  assert.equal(m('src/**/*.css', 'src/a.css'), true);
  assert.equal(m('**/*.css', 'a.css'), true);
});

test('**/ matches many directories', () => {
  assert.equal(m('src/**/*.css', 'src/x/y/a.css'), true);
  assert.equal(m('a/**/b', 'a/x/y/z/b'), true);
});

test('**/ does not match outside the prefix or a partial segment', () => {
  assert.equal(m('src/**/*.css', 'lib/a.css'), false);
  assert.equal(m('src/**/*.css', 'src/a.scss'), false);
  assert.equal(m('a/**/b', 'ab'), false);
  assert.equal(m('a/**/b', 'a/xb'), false);
  assert.equal(m('a/**/b', 'a/x/bb'), false);
});

test('**/ at the start of a glob matches any depth', () => {
  assert.equal(m('**/*.css', 'x/y/a.css'), true);
  assert.equal(m('**/*.css', 'x/y/a.scss'), false);
});

test('trailing ** matches anything including /', () => {
  assert.equal(m('src/tokens/**', 'src/tokens/colors.css'), true);
  assert.equal(m('src/tokens/**', 'src/tokens/a/b/c.css'), true);
  assert.equal(m('src/tokens/**', 'src/tokens'), false);
  assert.equal(m('src/tokens/**', 'src/tokensx/a.css'), false);
});

test('? matches exactly one non-/ character', () => {
  assert.equal(m('a?.css', 'ab.css'), true);
  assert.equal(m('a?.css', 'a.css'), false);
  assert.equal(m('a?.css', 'abc.css'), false);
  assert.equal(m('a?b', 'a/b'), false);
});

test('braces alternate, including inside a ** path', () => {
  assert.equal(m('src/**/*.{css,scss}', 'src/a.css'), true);
  assert.equal(m('src/**/*.{css,scss}', 'src/x/a.scss'), true);
  assert.equal(m('src/**/*.{css,scss}', 'src/a.less'), false);
  assert.equal(m('src/**/*.{css,scss}', 'src/a.cssx'), false);
});

test('brace alternatives may contain * and ?', () => {
  assert.equal(m('{*.js,*.ts}', 'index.ts'), true);
  assert.equal(m('{*.js,*.ts}', 'dir/index.ts'), false);
  assert.equal(m('x/{a?,b}.md', 'x/ab.md'), true);
  assert.equal(m('x/{a?,b}.md', 'x/a.md'), false);
  assert.equal(m('x/{a?,b}.md', 'x/b.md'), true);
});

test('brace alternatives may contain ** directory segments', () => {
  assert.equal(m('src/{a/**/b,c}.txt', 'src/a/b.txt'), true);
  assert.equal(m('src/{a/**/b,c}.txt', 'src/a/x/y/b.txt'), true);
  assert.equal(m('src/{a/**/b,c}.txt', 'src/c.txt'), true);
  assert.equal(m('src/{a/**/b,c}.txt', 'src/a/b/c.txt'), false);
  assert.equal(m('src/{a/**/b,c}.txt', 'src/d.txt'), false);
  assert.equal(m('{lib,src/**/x}/y.md', 'src/p/q/x/y.md'), true);
  assert.equal(m('{lib,src/**/x}/y.md', 'lib/y.md'), true);
});

test('dots are literal', () => {
  assert.equal(m('a.css', 'a.css'), true);
  assert.equal(m('a.css', 'abcss'), false);
});

test('parentheses are literal', () => {
  assert.equal(m('file(1).txt', 'file(1).txt'), true);
  assert.equal(m('file(1).txt', 'file1.txt'), false);
});

test('plus is literal', () => {
  assert.equal(m('a+b.txt', 'a+b.txt'), true);
  assert.equal(m('a+b.txt', 'aab.txt'), false);
  assert.equal(m('a+b.txt', 'a+++b.txt'), false);
});

test('other regex metacharacters are literal', () => {
  assert.equal(m('a^b$c|d[e]\\f', 'a^b$c|d[e]\\f'), true);
  assert.equal(m('a^b$c|d[e]\\f', 'abcd'), false);
});

test('paths with spaces match literally', () => {
  assert.equal(m('my dir/*.css', 'my dir/a b.css'), true);
  assert.equal(m('my dir/*.css', 'mydir/a b.css'), false);
  assert.equal(m('src/**/my file.md', 'src/x/my file.md'), true);
});

test('matches are anchored at both ends', () => {
  assert.equal(m('src/a.css', 'src/a.css'), true);
  assert.equal(m('src/a.css', 'x/src/a.css'), false);
  assert.equal(m('src/a.css', 'src/a.css.bak'), false);
  assert.equal(m('a.css', 'a.css\n'), false);
});

test('matching is case-sensitive', () => {
  assert.equal(m('a.css', 'A.css'), false);
  assert.equal(m('SRC/*.css', 'src/a.css'), false);
});

test('a non-segment ** behaves like *', () => {
  assert.equal(m('src/a**', 'src/abc'), true);
  assert.equal(m('src/a**', 'src/a/bc'), false);
});

test('globToRegExp returns a RegExp', () => {
  assert.ok(globToRegExp('src/**/*.css') instanceof RegExp);
});

test('globToRegExp rejects non-string and empty globs', () => {
  assert.throws(() => globToRegExp(undefined), /must be a string/);
  assert.throws(() => globToRegExp(null), /must be a string/);
  assert.throws(() => globToRegExp(42), /must be a string/);
  assert.throws(() => globToRegExp(''), /must not be empty/);
});

test('globToRegExp rejects unbalanced braces', () => {
  assert.throws(() => globToRegExp('src/{a,b'), /unbalanced "\{"/);
  assert.throws(() => globToRegExp('src/a,b}'), /unmatched "\}"/);
  assert.throws(() => globToRegExp('}{'), /unmatched "\}"/);
});

test('globToRegExp rejects nested braces', () => {
  assert.throws(() => globToRegExp('{a,{b,c}}'), /nested/);
  assert.throws(() => globToRegExp('{a{b}}'), /nested/);
});

test('matchesAny is false for empty or missing globs', () => {
  assert.equal(matchesAny('src/a.css', []), false);
  assert.equal(matchesAny('src/a.css', undefined), false);
  assert.equal(matchesAny('src/a.css', null), false);
});

test('matchesAny is true when any glob matches', () => {
  assert.equal(matchesAny('src/a.css', ['docs/**', 'src/**/*.css']), true);
  assert.equal(matchesAny('src/a.js', ['docs/**', 'src/**/*.css']), false);
});

test('matchesAny gives the same answer on repeated calls (cached RegExps)', () => {
  const globs = ['src/tokens/**'];
  assert.equal(matchesAny('src/tokens/a.css', globs), true);
  assert.equal(matchesAny('src/tokens/a.css', globs), true);
  assert.equal(matchesAny('src/components/a.css', globs), false);
});

test('matchesAny propagates glob errors', () => {
  assert.throws(() => matchesAny('a', ['{x']), /unbalanced/);
});
