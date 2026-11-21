const STATUSES = ['passed', 'failed', 'skipped_inapplicable', 'unable_to_evaluate']
const ORDER = { failed: 0, unable_to_evaluate: 1, passed: 2, skipped_inapplicable: 3 }
const LABEL = {
  passed: 'PASSED',
  failed: 'FAILED',
  skipped_inapplicable: 'SKIPPED',
  unable_to_evaluate: 'UNABLE',
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function ref(r) {
  if (!r) return null
  return { ref: r.ref, sha: r.sha ?? null }
}

export function buildReport({ tool, run, results }) {
  const summary = { passed: 0, failed: 0, skipped_inapplicable: 0, unable_to_evaluate: 0, coverageGaps: 0, rules: results.length }
  for (const r of results) {
    summary[r.status] += 1
    summary.coverageGaps += r.coverageGaps.length
  }
  return {
    schemaVersion: 1,
    tool: { name: tool.name, version: tool.version },
    run: {
      mode: run.mode,
      head: ref(run.head),
      base: ref(run.base),
      mergeBase: run.mergeBase ?? null,
      worktree: run.worktree,
      dirty: run.dirty,
      rulesDir: run.rulesDir,
      changedFiles: run.changedFiles.map((f) => ({ path: f.path, status: f.status, oldPath: f.oldPath ?? null, binary: f.binary })),
      notices: run.notices.map((n) => ({ code: n.code, detail: n.detail })),
    },
    summary: {
      passed: summary.passed,
      failed: summary.failed,
      skipped_inapplicable: summary.skipped_inapplicable,
      unable_to_evaluate: summary.unable_to_evaluate,
      coverageGaps: summary.coverageGaps,
      rules: summary.rules,
    },
    results: results.map(orderResult),
  }
}

function orderViolation(v) {
  return { file: v.file, line: v.line, column: v.column, match: v.match, excerpt: v.excerpt, message: v.message }
}

function orderResult(r) {
  return {
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    ruleDigest: r.ruleDigest,
    ruleFile: r.ruleFile,
    title: r.title,
    severity: r.severity,
    status: r.status,
    selection: {
      selected: r.selection.selected,
      certainty: r.selection.certainty,
      reasons: r.selection.reasons.map((x) => ({ code: x.code, detail: x.detail, files: [...x.files] })),
    },
    filesEvaluated: [...r.filesEvaluated],
    violations: r.violations.map(orderViolation),
    preexistingViolations: r.preexistingViolations.map(orderViolation),
    coverageGaps: r.coverageGaps.map((g) => ({ code: g.code, file: g.file, detail: g.detail })),
    error: r.error ? { code: r.error.code, detail: r.error.detail } : null,
  }
}

export function exitCodeFor(report, { strict } = {}) {
  for (const r of report.results) {
    if (r.status === 'failed' && r.severity === 'error') return 1
  }
  if (strict) {
    for (const r of report.results) {
      if (r.status === 'unable_to_evaluate' || r.coverageGaps.length > 0) return 1
    }
  }
  return 0
}

function sortedResults(report) {
  return [...report.results].sort((a, b) => ORDER[a.status] - ORDER[b.status] || cmpStr(a.ruleId, b.ruleId))
}

function ident(r) {
  return r.ruleVersion === null ? r.ruleId : `${r.ruleId}@${r.ruleVersion}`
}

function shortDigest(d) {
  if (!d) return 'no digest'
  const m = /^(sha256:)(.*)$/.exec(d)
  return m ? `${m[1]}${m[2].slice(0, 8)}…` : d.slice(0, 16)
}

function changedLine(f) {
  return f.oldPath ? `${f.status} ${f.oldPath} -> ${f.path}` : `${f.status} ${f.path}`
}

function blockingFailures(report) {
  return report.results.filter((r) => r.status === 'failed' && r.severity === 'error')
}

function verdict(report, strict) {
  const b = blockingFailures(report)
  if (b.length > 0) return `Blocking failures: ${b.map((r) => r.ruleId).sort(cmpStr).join(', ')}`
  if (strict) {
    const unable = report.results.filter((r) => r.status === 'unable_to_evaluate')
    const gapRules = report.results.filter((r) => r.coverageGaps.length > 0)
    const gaps = report.results.reduce((n, r) => n + r.coverageGaps.length, 0)
    if (unable.length > 0 || gaps > 0) {
      const parts = []
      if (unable.length > 0) parts.push(`${unable.length} unable to evaluate (${unable.map((r) => r.ruleId).sort(cmpStr).join(', ')})`)
      if (gaps > 0) parts.push(`${gaps} coverage gaps (${gapRules.map((r) => r.ruleId).sort(cmpStr).join(', ')})`)
      return `Blocking under --strict: ${parts.join(', ')}`
    }
  }
  return 'No blocking failures.'
}

function baseText(run) {
  if (run.mode === 'full' && !run.base) return 'not used (full run)'
  return run.base ? `${run.base.ref} (${run.base.sha ? run.base.sha.slice(0, 12) : 'unresolved'})` : 'unresolved'
}

function md(s) {
  return String(s).replace(/[\\*_`\[\]<>]/g, '\\$&')
}

function footer(s) {
  return `Result: ${s.passed} passed, ${s.failed} failed, ${s.skipped_inapplicable} skipped (inapplicable), ${s.unable_to_evaluate} unable to evaluate, ${s.coverageGaps} coverage gaps`
}

function reasonLine(r, reason) {
  const uncertain = r.selection.certainty === 'uncertain' ? ' (uncertain)' : ''
  const files = reason.files.length > 0 ? ` [${reason.files.join(', ')}]` : ''
  return `[${reason.code}]${uncertain} ${reason.detail}${files}`
}

function headLine(rn) {
  return `${rn.head.ref} (${rn.head.sha ? rn.head.sha.slice(0, 12) : 'unresolved'})`
}

export function renderText(report, { strict = false } = {}) {
  const { run, tool } = report
  const out = []
  out.push(`Mottlefin ${tool.version} — ${run.mode} run`)
  out.push(`Head: ${headLine(run)}${run.worktree ? ' + worktree' : ''}`)
  out.push(`Base: ${baseText(run)}`)
  out.push(`Merge base: ${run.mergeBase ? run.mergeBase.slice(0, 12) : 'unresolved'}`)
  out.push(`Rules dir: ${run.rulesDir}`)
  out.push(`Changed files: ${run.changedFiles.length}`)
  for (const f of run.changedFiles) out.push(`  ${changedLine(f)}${f.binary ? ' (binary)' : ''}`)
  for (const n of run.notices) out.push(`Notice [${n.code}]: ${n.detail}`)
  if (strict) out.push('Strict mode is on: unable-to-evaluate results and coverage gaps are blocking.')
  out.push('')

  for (const r of sortedResults(report)) {
    const sev = r.severity === 'warn' ? ', warn' : r.severity === 'error' ? ', error' : ''
    out.push(`${LABEL[r.status]}  ${ident(r)}  (${shortDigest(r.ruleDigest)}${sev})`)
    if (r.title) out.push(`  ${r.title}`)
    const why = r.status === 'skipped_inapplicable' ? 'Why skipped:' : 'Why it ran:'
    for (const reason of r.selection.reasons) out.push(`  ${why} ${reasonLine(r, reason)}`)
    for (const v of r.violations) {
      out.push(`  ✗ ${v.file}:${v.line}:${v.column}  ${v.match}  ${v.message}`)
      out.push(`      ${v.excerpt}`)
    }
    if (r.preexistingViolations.length > 0) {
      out.push(`  Pre-existing violations on unchanged lines: ${r.preexistingViolations.length} (not counted)`)
    }
    for (const g of r.coverageGaps) out.push(`  Coverage gap [${g.code}] ${g.file ?? '(no file)'}: ${g.detail}`)
    if (r.error) out.push(`  Error [${r.error.code}]: ${r.error.detail}`)
    out.push('')
  }

  out.push(footer(report.summary))
  out.push(verdict(report, strict))
  return out.join('\n') + '\n'
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function code(s) {
  const str = String(s).replace(/\r?\n/g, ' ')
  let fence = '`'
  while (str.includes(fence)) fence += '`'
  const pad = str.startsWith('`') || str.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${str}${pad}${fence}`
}

export function renderMarkdown(report, { strict = false } = {}) {
  const { run, tool, summary } = report
  const out = []
  out.push(`# Mottlefin ${tool.version} — ${run.mode} run`)
  out.push('')
  out.push(`- Head: ${code(headLine(run))}${run.worktree ? ' + worktree' : ''}`)
  out.push(`- Base: ${run.base ? code(baseText(run)) : baseText(run)}`)
  out.push(`- Merge base: ${run.mergeBase ? code(run.mergeBase.slice(0, 12)) : 'unresolved'}`)
  out.push(`- Rules dir: ${code(run.rulesDir)}`)
  out.push(`- Changed files: ${run.changedFiles.length}`)
  for (const f of run.changedFiles) out.push(`  - ${code(changedLine(f))}${f.binary ? ' (binary)' : ''}`)
  for (const n of run.notices) out.push(`- Notice ${code(n.code)}: ${md(n.detail)}`)
  if (strict) out.push('- Strict mode is on: unable-to-evaluate results and coverage gaps are blocking.')
  out.push('')
  out.push('## Summary')
  out.push('')
  out.push('| Status | Count |')
  out.push('|---|---|')
  out.push(`| Passed | ${summary.passed} |`)
  out.push(`| Failed | ${summary.failed} |`)
  out.push(`| Skipped (inapplicable) | ${summary.skipped_inapplicable} |`)
  out.push(`| Unable to evaluate | ${summary.unable_to_evaluate} |`)
  out.push(`| Coverage gaps | ${summary.coverageGaps} |`)
  out.push('')
  out.push(`**${md(verdict(report, strict))}**`)
  out.push('')
  out.push('## Rules')
  out.push('')
  out.push('| Status | Rule | Digest | Why |')
  out.push('|---|---|---|---|')
  const sorted = sortedResults(report)
  for (const r of sorted) {
    const reasons = r.selection.reasons.map((x) => md(reasonLine(r, x)))
    const why = r.error && reasons.length === 0 ? md(`[${r.error.code}] ${r.error.detail}`) : reasons.join('; ')
    out.push(`| ${LABEL[r.status]} | ${cell(code(ident(r)))} | ${cell(code(shortDigest(r.ruleDigest)))} | ${cell(why)} |`)
  }
  out.push('')

  const detailed = sorted.filter((r) => r.status === 'failed' || r.status === 'unable_to_evaluate' || r.coverageGaps.length > 0 || r.preexistingViolations.length > 0)
  if (detailed.length > 0) {
    out.push('## Details')
    out.push('')
    for (const r of detailed) {
      out.push(`### ${LABEL[r.status]} ${code(ident(r))}${r.severity === 'warn' ? ' (warn)' : ''}`)
      out.push('')
      if (r.title) { out.push(md(r.title)); out.push('') }
      for (const v of r.violations) {
        out.push(`- ${code(`${v.file}:${v.line}:${v.column}`)} ${code(v.match)} ${md(v.message)}`)
        out.push(`  - ${code(v.excerpt)}`)
      }
      if (r.violations.length > 0) out.push('')
      if (r.preexistingViolations.length > 0) {
        out.push(`Pre-existing violations on unchanged lines: ${r.preexistingViolations.length} (not counted)`)
        out.push('')
      }
      for (const g of r.coverageGaps) out.push(`- Coverage gap ${code(g.code)} ${g.file ? code(g.file) : '(no file)'}: ${md(g.detail)}`)
      if (r.coverageGaps.length > 0) out.push('')
      if (r.error) { out.push(`Error ${code(r.error.code)}: ${md(r.error.detail)}`); out.push('') }
    }
  }
  out.push(footer(summary))
  return out.join('\n') + '\n'
}
