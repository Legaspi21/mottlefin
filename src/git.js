import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF = 8000;
const BASE_ARGS = ['--literal-pathspecs', '-c', 'core.quotepath=false'];

function git(cwd, args) {
  return execFileSync('git', [...BASE_ARGS, ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function gitText(cwd, args) {
  return git(cwd, args).toString('utf8');
}

function splitZ(buf) {
  const parts = buf.toString('utf8').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function hasNul(buf) {
  const end = Math.min(buf.length, BINARY_SNIFF);
  return buf.subarray(0, end).includes(0);
}

export function findRepoRoot(dir) {
  try {
    const out = gitText(dir, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
    if (!out) return null;
    return realpathSync(out);
  } catch {
    return null;
  }
}

function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

function parseHunks(diffText) {
  // Returns { binary, lines } from a -U0 diff for one file.
  if (/^Binary files .* differ$/m.test(diffText) || /^GIT binary patch$/m.test(diffText)) {
    return { binary: true, lines: null };
  }
  const set = new Set();
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  let seen = false;
  while ((m = re.exec(diffText)) !== null) {
    seen = true;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return { binary: false, lines: [...set].sort((a, b) => a - b), seen };
}

function insideRoot(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createRepo(rootInput) {
  let root;
  try {
    root = realpathSync(rootInput);
  } catch {
    root = path.resolve(rootInput);
  }

  function resolveRef(ref) {
    try {
      const out = gitText(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  function mergeBase(a, b) {
    try {
      const out = gitText(root, ['merge-base', a, b]).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  function isDirty() {
    try {
      return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0;
    } catch {
      return false;
    }
  }

  function untrackedFiles() {
    return splitZ(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  }

  function diffRange({ baseSha, headSha, worktree }) {
    return worktree ? [baseSha] : [baseSha, headSha];
  }

  function addedLinesFor(opts, paths) {
    try {
      const out = gitText(root, [
        'diff', '-U0', '--no-color', '--no-ext-diff', '-M',
        '--src-prefix=a/', '--dst-prefix=b/',
        ...diffRange(opts), '--', ...paths,
      ]);
      const parsed = parseHunks(out);
      if (parsed.binary) return { binary: true, addedLines: null };
      return { binary: false, addedLines: parsed.lines };
    } catch {
      return { binary: false, addedLines: null };
    }
  }

  function changedFiles({ baseSha, headSha, worktree }) {
    const opts = { baseSha, headSha, worktree: !!worktree };
    const tokens = splitZ(
      git(root, ['diff', '--name-status', '-z', '-M', ...diffRange(opts)]),
    );
    const files = [];
    for (let i = 0; i < tokens.length;) {
      const st = tokens[i++];
      const letter = st[0];
      if (letter === 'R' || letter === 'C') {
        const oldPath = tokens[i++];
        const newPath = tokens[i++];
        files.push({ path: newPath, status: letter, oldPath });
      } else {
        const p = tokens[i++];
        const status = letter === 'U' ? 'M' : letter;
        if (!['A', 'M', 'D', 'T'].includes(status)) continue; // X etc.
        files.push({ path: p, status, oldPath: null });
      }
    }

    const result = [];
    for (const f of files) {
      if (f.status === 'D') {
        result.push({ ...f, binary: false, addedLines: [] });
        continue;
      }
      const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
      const { binary, addedLines } = addedLinesFor(opts, paths);
      result.push({ ...f, binary, addedLines });
    }

    if (opts.worktree) {
      const seen = new Set(result.map((f) => f.path));
      for (const p of untrackedFiles()) {
        if (seen.has(p)) continue;
        let buf;
        try {
          const abs = path.join(root, p);
          if (lstatSync(abs).isDirectory()) continue;
          buf = readFileSync(abs);
        } catch {
          result.push({ path: p, status: 'A', oldPath: null, binary: false, addedLines: null });
          continue;
        }
        if (hasNul(buf)) {
          result.push({ path: p, status: 'A', oldPath: null, binary: true, addedLines: null });
          continue;
        }
        const n = countLines(buf);
        const addedLines = Array.from({ length: n }, (_, k) => k + 1);
        result.push({ path: p, status: 'A', oldPath: null, binary: false, addedLines });
      }
    }

    result.sort((a, b) => cmp(a.path, b.path));
    return result;
  }

  function snapshot({ headSha, worktree }) {
    const cache = new Map();
    let listing = null;
    let realRoot = null;

    function listFiles() {
      if (listing) return listing.slice();
      let names;
      if (!worktree) {
        names = splitZ(git(root, ['ls-tree', '-r', '-z', '--name-only', headSha]));
      } else {
        names = [
          ...splitZ(git(root, ['ls-files', '-z'])),
          ...untrackedFiles(),
        ].filter((p) => {
          try {
            return !lstatSync(path.join(root, p)).isDirectory();
          } catch {
            return false;
          }
        });
      }
      listing = [...new Set(names)].sort(cmp);
      return listing.slice();
    }

    function badPath(p) {
      if (typeof p !== 'string' || p === '' || p.includes('\0') || path.isAbsolute(p)) return true;
      return p.split(/[\\/]/).some((seg) => seg === '..');
    }

    function decode(buf) {
      if (hasNul(buf)) return { ok: false, reason: 'binary', detail: 'file contains NUL bytes' };
      return { ok: true, text: buf.toString('utf8') };
    }

    function readUncached(p) {
      if (badPath(p)) return { ok: false, reason: 'unreadable', detail: 'path escapes the repository root' };
      if (worktree) {
        const abs = path.resolve(root, p);
        if (!insideRoot(root, abs)) {
          return { ok: false, reason: 'unreadable', detail: 'path escapes the repository root' };
        }
        let st;
        try {
          st = statSync(abs);
        } catch (e) {
          if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
            return { ok: false, reason: 'missing', detail: 'file does not exist in the working tree' };
          }
          return { ok: false, reason: 'unreadable', detail: String(e && e.message) };
        }
        try {
          if (!realRoot) realRoot = realpathSync(root);
          if (!insideRoot(realRoot, realpathSync(abs))) {
            return { ok: false, reason: 'unreadable', detail: 'path resolves outside the repository root' };
          }
          if (!st.isFile()) return { ok: false, reason: 'unreadable', detail: 'not a regular file' };
          if (st.size > MAX_TEXT_BYTES) {
            return { ok: false, reason: 'too-large', detail: `file is ${st.size} bytes (limit ${MAX_TEXT_BYTES})` };
          }
          return decode(readFileSync(abs));
        } catch (e) {
          return { ok: false, reason: 'unreadable', detail: String(e && e.message) };
        }
      }
      const spec = `${headSha}:${p}`;
      let size;
      try {
        size = Number(gitText(root, ['cat-file', '-s', spec]).trim());
      } catch {
        return { ok: false, reason: 'missing', detail: `no such file at ${String(headSha).slice(0, 12)}` };
      }
      if (size > MAX_TEXT_BYTES) {
        return { ok: false, reason: 'too-large', detail: `file is ${size} bytes (limit ${MAX_TEXT_BYTES})` };
      }
      try {
        // cat-file blob fails (not a blob) for directories/submodules.
        return decode(git(root, ['cat-file', 'blob', spec]));
      } catch (e) {
        return { ok: false, reason: 'unreadable', detail: String(e && e.message).split('\n')[0] };
      }
    }

    function readFile(p) {
      if (cache.has(p)) return cache.get(p);
      let r;
      try {
        r = readUncached(p);
      } catch (e) {
        r = { ok: false, reason: 'unreadable', detail: String(e && e.message) };
      }
      cache.set(p, r);
      return r;
    }

    return { listFiles, readFile };
  }

  return { root, resolveRef, mergeBase, isDirty, changedFiles, snapshot };
}
