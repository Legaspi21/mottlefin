import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findRepoRoot, createRepo } from '../src/git.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' }).trim();
}

function mkRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mottlefin-git-')));
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function put(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f]));

test('findRepoRoot and resolveRef/mergeBase/isDirty', () => {
  const dir = mkRepo();
  try {
    put(dir, 'a.txt', 'one\n');
    const c1 = commit(dir, 'c1');
    put(dir, 'a.txt', 'one\ntwo\n');
    const c2 = commit(dir, 'c2');

    assert.equal(findRepoRoot(dir), dir);
    mkdirSync(path.join(dir, 'sub'));
    assert.equal(findRepoRoot(path.join(dir, 'sub')), dir);

    const repo = createRepo(dir);
    assert.equal(repo.root, dir);
    assert.equal(repo.resolveRef('HEAD'), c2);
    assert.equal(repo.resolveRef('HEAD~1'), c1);
    assert.equal(repo.resolveRef('no-such-ref'), null);
    assert.equal(repo.resolveRef('HEAD~5'), null);
    assert.equal(repo.mergeBase(c1, c2), c1);
    assert.equal(repo.mergeBase('nope', c2), null);

    assert.equal(repo.isDirty(), false);
    put(dir, 'untracked.txt', 'x\n');
    assert.equal(repo.isDirty(), true);
    rmSync(path.join(dir, 'untracked.txt'));
    assert.equal(repo.isDirty(), false);
    put(dir, 'a.txt', 'changed\n');
    assert.equal(repo.isDirty(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRepoRoot returns null outside a repo', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mottlefin-norepo-')));
  try {
    assert.equal(findRepoRoot(dir), null);
    assert.equal(findRepoRoot(path.join(dir, 'does-not-exist')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commit mode: add, modify, delete, rename, spaces, binary, addedLines', () => {
  const dir = mkRepo();
  try {
    put(dir, 'mod.txt', lines(10));
    put(dir, 'del.txt', 'gone\n');
    put(dir, 'old name.txt', lines(20, (i) => `renamed content ${i}`));
    put(dir, 'dir with space/f é.txt', 'a\nb\nc\n');
    put(dir, 'pure.txt', lines(8));
    put(dir, 'bin.dat', Buffer.from([1, 2, 0, 3, 4]));
    const base = commit(dir, 'base');

    // modify: line 2 changed, line 5 deleted, lines 11-12 appended
    const modLines = lines(10).split('\n');
    modLines[1] = 'CHANGED';
    modLines.splice(4, 1);
    put(dir, 'mod.txt', modLines.join('\n') + 'new a\nnew b\n');
    // pure deletion hunk
    const pure = lines(8).split('\n');
    pure.splice(2, 2);
    put(dir, 'pure.txt', pure.join('\n'));
    rmSync(path.join(dir, 'del.txt'));
    git(dir, 'mv', 'old name.txt', 'new name.txt');
    put(dir, 'dir with space/f é.txt', 'a\nB\nc\nd\n');
    put(dir, 'added.txt', 'x\ny\nz');
    put(dir, 'bin.dat', Buffer.from([9, 0, 9, 9]));
    put(dir, 'newbin.dat', Buffer.from([0, 0, 0]));
    put(dir, 'empty.txt', '');
    const head = commit(dir, 'head');

    const repo = createRepo(dir);
    const files = repo.changedFiles({ baseSha: base, headSha: head, worktree: false });
    assert.deepEqual(files.map((f) => f.path), [...files.map((f) => f.path)].sort());
    const m = byPath(files);

    assert.equal(m['mod.txt'].status, 'M');
    assert.equal(m['mod.txt'].oldPath, null);
    assert.equal(m['mod.txt'].binary, false);
    assert.deepEqual(m['mod.txt'].addedLines, [2, 10, 11]);

    assert.equal(m['pure.txt'].status, 'M');
    assert.deepEqual(m['pure.txt'].addedLines, []);

    assert.equal(m['del.txt'].status, 'D');
    assert.deepEqual(m['del.txt'].addedLines, []);
    assert.equal(m['del.txt'].binary, false);

    assert.equal(m['new name.txt'].status, 'R');
    assert.equal(m['new name.txt'].oldPath, 'old name.txt');
    assert.deepEqual(m['new name.txt'].addedLines, []);
    assert.equal(m['old name.txt'], undefined);

    assert.equal(m['dir with space/f é.txt'].status, 'M');
    assert.deepEqual(m['dir with space/f é.txt'].addedLines, [2, 4]);

    assert.equal(m['added.txt'].status, 'A');
    assert.deepEqual(m['added.txt'].addedLines, [1, 2, 3]);

    assert.equal(m['empty.txt'].status, 'A');
    assert.deepEqual(m['empty.txt'].addedLines, []);

    assert.equal(m['bin.dat'].binary, true);
    assert.equal(m['bin.dat'].addedLines, null);
    assert.equal(m['newbin.dat'].binary, true);
    assert.equal(m['newbin.dat'].addedLines, null);
    assert.equal(m['newbin.dat'].status, 'A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree mode: staged, unstaged, untracked, ignored', () => {
  const dir = mkRepo();
  try {
    put(dir, '.gitignore', 'ignored.txt\n');
    put(dir, 'staged.txt', lines(5));
    put(dir, 'unstaged.txt', lines(5));
    put(dir, 'tracked-del.txt', 'x\n');
    const base = commit(dir, 'base');

    put(dir, 'staged.txt', lines(5).replace('line 3', 'STAGED'));
    git(dir, 'add', 'staged.txt');
    put(dir, 'unstaged.txt', lines(5).replace('line 5', 'UNSTAGED'));
    put(dir, 'staged-new.txt', 'n1\nn2\n');
    git(dir, 'add', 'staged-new.txt');
    put(dir, 'untracked file.txt', 'u1\nu2\nu3');
    put(dir, 'untracked-empty.txt', '');
    put(dir, 'untracked.bin', Buffer.from([0, 1, 2]));
    put(dir, 'ignored.txt', 'nope\n');
    rmSync(path.join(dir, 'tracked-del.txt'));

    const repo = createRepo(dir);
    const files = repo.changedFiles({ baseSha: base, headSha: base, worktree: true });
    const m = byPath(files);
    assert.equal(m['ignored.txt'], undefined);
    assert.deepEqual(m['staged.txt'].addedLines, [3]);
    assert.deepEqual(m['unstaged.txt'].addedLines, [5]);
    assert.equal(m['staged-new.txt'].status, 'A');
    assert.deepEqual(m['staged-new.txt'].addedLines, [1, 2]);
    assert.equal(m['untracked file.txt'].status, 'A');
    assert.deepEqual(m['untracked file.txt'].addedLines, [1, 2, 3]);
    assert.deepEqual(m['untracked-empty.txt'].addedLines, []);
    assert.equal(m['untracked.bin'].binary, true);
    assert.equal(m['untracked.bin'].addedLines, null);
    assert.equal(m['tracked-del.txt'].status, 'D');
    assert.deepEqual(files.map((f) => f.path), [...files.map((f) => f.path)].sort());

    const snap = repo.snapshot({ headSha: base, worktree: true });
    const listed = snap.listFiles();
    assert.ok(listed.includes('untracked file.txt'));
    assert.ok(listed.includes('staged-new.txt'));
    assert.ok(!listed.includes('ignored.txt'));
    assert.ok(!listed.includes('tracked-del.txt'));
    assert.deepEqual(listed, [...listed].sort());
    assert.deepEqual(snap.readFile('unstaged.txt').text, lines(5).replace('line 5', 'UNSTAGED'));
    assert.equal(snap.readFile('tracked-del.txt').reason, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot in commit mode: list, read, missing, binary, too-large, escape', () => {
  const dir = mkRepo();
  try {
    put(dir, 'src/a.css', 'a { color: red; }\n');
    put(dir, 'sp ace/é.txt', 'héllo\n');
    put(dir, 'bin.dat', Buffer.from([65, 0, 66]));
    put(dir, 'big.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    const head = commit(dir, 'c');
    put(dir, 'src/a.css', 'changed on disk\n');
    put(dir, 'later.txt', 'untracked\n');

    const repo = createRepo(dir);
    const snap = repo.snapshot({ headSha: head, worktree: false });
    assert.deepEqual(snap.listFiles(), ['big.txt', 'bin.dat', 'sp ace/é.txt', 'src/a.css']);

    const r = snap.readFile('src/a.css');
    assert.deepEqual(r, { ok: true, text: 'a { color: red; }\n' });
    assert.equal(snap.readFile('src/a.css'), r); // memoized
    assert.equal(snap.readFile('sp ace/é.txt').text, 'héllo\n');

    const missing = snap.readFile('nope.txt');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');
    assert.equal(typeof missing.detail, 'string');
    assert.equal(snap.readFile('later.txt').reason, 'missing');

    assert.equal(snap.readFile('bin.dat').reason, 'binary');
    assert.equal(snap.readFile('big.txt').reason, 'too-large');
    assert.equal(snap.readFile('../outside.txt').reason, 'unreadable');
    assert.equal(snap.readFile('/etc/passwd').reason, 'unreadable');
    assert.equal(snap.readFile('src').reason !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot in worktree mode: binary, too-large, escape', () => {
  const dir = mkRepo();
  try {
    put(dir, 'a.txt', 'a\n');
    const head = commit(dir, 'c');
    put(dir, 'bin.dat', Buffer.from([0, 1]));
    put(dir, 'big.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
    const repo = createRepo(dir);
    const snap = repo.snapshot({ headSha: head, worktree: true });
    assert.equal(snap.readFile('bin.dat').reason, 'binary');
    assert.equal(snap.readFile('big.txt').reason, 'too-large');
    assert.equal(snap.readFile('../x').reason, 'unreadable');
    assert.equal(snap.readFile('nope').reason, 'missing');
    assert.deepEqual(snap.readFile('a.txt'), { ok: true, text: 'a\n' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
