import { parseArgs } from 'node:util'
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { findRepoRoot, createRepo } from './git.js'
import { loadRules } from './rules.js'
import { selectRules } from './select.js'
import { runRules } from './runner.js'
import { buildReport, renderText, renderMarkdown, exitCodeFor } from './report.js'
import { checks } from './checks/index.js'

const USAGE = `Usage:
  mottlefin run [--base <ref>] [--head <ref>] [--worktree] [--full] [--strict]
                [--rules <dir>] [--repo <dir>]
                [--format text|json|markdown] [--report-json <file>] [--report-md <file>]
  mottlefin validate [--rules <dir>] [--repo <dir>]
  mottlefin --help | --version

Exit codes: 0 ok, 1 blocking result or invalid rule, 2 usage/environment error.
`

const OPTIONS = {
  base: { type: 'string' },
  head: { type: 'string' },
  worktree: { type: 'boolean' },
  full: { type: 'boolean' },
  strict: { type: 'boolean' },
  rules: { type: 'string' },
  repo: { type: 'string' },
  format: { type: 'string' },
  'report-json': { type: 'string' },
  'report-md': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

class UsageError extends Error {}

function toolVersion() {
  const pkgUrl = new URL('../package.json', import.meta.url)
  return JSON.parse(readFileSync(pkgUrl, 'utf8')).version
}

function writeOut(file, cwd, content) {
  const abs = path.resolve(cwd, file)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function setup(values, cwd) {
  const startDir = values.repo ? path.resolve(cwd, values.repo) : cwd
  const root = findRepoRoot(startDir)
  if (!root) throw new UsageError('not inside a git repository')
  const rulesAbs = values.rules ? path.resolve(cwd, values.rules) : path.join(root, '.mottlefin', 'rules')
  let isDir = false
  try { isDir = statSync(rulesAbs).isDirectory() } catch { /* handled below */ }
  if (!isDir) throw new UsageError(`rules directory not found: ${rulesAbs}`)
  return { root, rulesAbs }
}

function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function blobBytes(root, sha, file) {
  try {
    return execFileSync('git', ['cat-file', 'blob', `${sha}:${file}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

// Rules are read from the working tree; compare them with the head commit's content.
function rulesDifferFromHead({ root, rulesAbs, rules, invalid, snapshot, headSha }) {
  const rulesRel = relPosix(root, rulesAbs)
  if (rulesRel === '..' || rulesRel.startsWith('../')) return []
  const differing = new Set()
  const loaded = new Set()
  for (const r of [...rules, ...invalid]) {
    if (!r.file || r.file.startsWith('../')) continue
    loaded.add(r.file)
    const bytes = blobBytes(root, headSha, r.file)
    const digest = bytes ? 'sha256:' + createHash('sha256').update(bytes).digest('hex') : null
    if (digest !== r.digest) differing.add(r.file)
  }
  const prefix = rulesRel === '' ? '' : rulesRel + '/'
  for (const f of snapshot.listFiles()) {
    if (f.startsWith(prefix) && f.endsWith('.json') && !loaded.has(f)) differing.add(f)
  }
  return [...differing].sort()
}

function cmdValidate(values, cwd, stdout) {
  const { root, rulesAbs } = setup(values, cwd)
  const { rules, invalid } = loadRules(rulesAbs, { repoRoot: root })
  let bad = 0
  for (const r of rules) {
    stdout.write(`${r.id}@${r.version} ${r.file}\n`)
    const check = checks[r.check.type]
    if (!check) {
      stdout.write(`  warning: unsupported check type "${r.check.type}"\n`)
      continue
    }
    const errs = check.validate(r.check)
    if (errs.length) {
      bad++
      for (const e of errs) stdout.write(`  error: check config: ${e}\n`)
    }
  }
  for (const r of invalid) {
    bad++
    stdout.write(`INVALID ${r.id} ${r.file}\n`)
    for (const e of r.errors) stdout.write(`  error: ${e}\n`)
  }
  stdout.write(`${rules.length} valid, ${invalid.length} invalid rule(s)\n`)
  return bad > 0 ? 1 : 0
}

function cmdRun(values, cwd, stdout) {
  const format = values.format ?? 'text'
  if (!['text', 'json', 'markdown'].includes(format)) throw new UsageError(`unknown --format: ${format}`)
  const { root, rulesAbs } = setup(values, cwd)
  const repo = createRepo(root)
  const { rules, invalid } = loadRules(rulesAbs, { repoRoot: root })

  const worktree = Boolean(values.worktree)
  const headRef = values.head ?? 'HEAD'
  const headSha = repo.resolveRef(headRef)
  if (!headSha) throw new UsageError(`cannot resolve head ref: ${headRef}`)

  const baseRef = values.base ?? (worktree ? 'HEAD' : 'HEAD~1')
  const baseSha = repo.resolveRef(baseRef)
  const notices = []
  let mode
  let mergeBase = null
  if (values.full) {
    mode = 'full'
  } else if (!baseSha) {
    mode = 'full-fallback'
    notices.push({
      code: 'diff-unavailable',
      detail: `base ref "${baseRef}" could not be resolved (shallow clone, first commit, or unknown ref); all rules run over all files.`,
    })
  } else {
    mode = 'diff'
  }

  let changedFiles = []
  if (mode === 'diff') {
    mergeBase = repo.mergeBase(baseSha, headSha)
    if (!mergeBase) {
      notices.push({
        code: 'merge-base-unavailable',
        detail: `no merge base between ${baseRef} and ${headRef}; diffing from ${baseRef} directly.`,
      })
    }
    changedFiles = repo.changedFiles({ baseSha: mergeBase ?? baseSha, headSha, worktree })
  } else if (baseSha) {
    mergeBase = repo.mergeBase(baseSha, headSha)
  }

  const dirty = repo.isDirty()
  if (dirty && worktree) {
    notices.push({
      code: 'worktree-dirty',
      detail: 'evidence refers to the head sha plus uncommitted changes in the working tree.',
    })
  } else if (dirty) {
    notices.push({
      code: 'worktree-dirty-ignored',
      detail: 'uncommitted changes are not evaluated; pass --worktree to include them.',
    })
  }

  const snapshot = repo.snapshot({ headSha, worktree })
  if (!worktree) {
    const differ = rulesDifferFromHead({ root, rulesAbs, rules, invalid, snapshot, headSha })
    if (differ.length) {
      notices.push({
        code: 'rules-differ-from-head',
        detail: `${differ.length} rule file(s) in the working tree differ from ${headRef} (${headSha.slice(0, 7)}): ${differ.join(', ')}. Results reflect the working-tree rules; check out the head commit for evidence that matches it.`,
      })
    }
  }
  const selections = selectRules({ rules, mode, changedFiles, snapshot })
  const results = runRules({ rules, invalid, selections, snapshot })

  const baseGiven = values.base !== undefined
  const report = buildReport({
    tool: { name: 'mottlefin', version: toolVersion() },
    run: {
      mode,
      head: { ref: headRef, sha: headSha },
      base: mode === 'diff' || baseGiven || mode === 'full-fallback' ? { ref: baseRef, sha: baseSha } : null,
      mergeBase,
      worktree,
      dirty,
      rulesDir: relPosix(root, rulesAbs),
      changedFiles: changedFiles.map(({ path: p, status, oldPath, binary }) => ({ path: p, status, oldPath, binary })),
      notices,
    },
    results,
  })

  const strict = Boolean(values.strict)
  const json = JSON.stringify(report, null, 2) + '\n'
  if (values['report-json']) writeOut(values['report-json'], cwd, json)
  if (values['report-md']) writeOut(values['report-md'], cwd, renderMarkdown(report, { strict }))
  const out = format === 'json' ? json : format === 'markdown' ? renderMarkdown(report, { strict }) : renderText(report, { strict })
  stdout.write(out.endsWith('\n') ? out : out + '\n')
  return exitCodeFor(report, { strict })
}

export async function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    let parsed
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    } catch (e) {
      throw new UsageError(e.message)
    }
    const { values, positionals } = parsed
    if (values.help) { stdout.write(USAGE); return 0 }
    if (values.version) { stdout.write(toolVersion() + '\n'); return 0 }
    if (positionals.length !== 1) throw new UsageError(positionals.length ? `unexpected arguments: ${positionals.slice(1).join(' ')}` : 'missing command')
    const cmd = positionals[0]
    if (cmd === 'run') return cmdRun(values, cwd, stdout)
    if (cmd === 'validate') return cmdValidate(values, cwd, stdout)
    throw new UsageError(`unknown command: ${cmd}`)
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`mottlefin: ${e.message}\n\n${USAGE}`)
    } else {
      stderr.write(`mottlefin: ${e && e.message ? e.message : String(e)}\n`)
    }
    return 2
  }
}
