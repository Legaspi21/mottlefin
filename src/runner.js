import { checks } from './checks/index.js'

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function cmpViolation(a, b) {
  return cmpStr(a.file, b.file) || a.line - b.line || a.column - b.column
}

function cmpGap(a, b) {
  if (a.file !== b.file) {
    if (a.file === null) return -1
    if (b.file === null) return 1
    return cmpStr(a.file, b.file)
  }
  return cmpStr(a.code, b.code)
}

function sortGaps(gaps) {
  return gaps.map((g) => ({ code: g.code, file: g.file ?? null, detail: g.detail })).sort(cmpGap)
}

function copySelection(sel) {
  return {
    selected: sel.selected,
    certainty: sel.certainty,
    reasons: sel.reasons.map((r) => ({ code: r.code, detail: r.detail, files: [...r.files] })),
  }
}

export function runRules({ rules, invalid, selections, snapshot }) {
  const selById = new Map(selections.map((s) => [s.ruleId, s]))
  const results = []

  for (const inv of invalid ?? []) {
    results.push({
      ruleId: inv.id,
      ruleVersion: null,
      ruleDigest: inv.digest,
      ruleFile: inv.file,
      title: null,
      severity: null,
      status: 'unable_to_evaluate',
      selection: { selected: false, certainty: 'certain', reasons: [] },
      filesEvaluated: [],
      violations: [],
      preexistingViolations: [],
      coverageGaps: [],
      error: { code: 'rule-invalid', detail: inv.errors.join('; ') },
    })
  }

  for (const rule of rules) {
    const sel = selById.get(rule.id) ?? { ruleId: rule.id, selected: false, certainty: 'certain', reasons: [], targets: [], coverageGaps: [] }
    const result = {
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleDigest: rule.digest,
      ruleFile: rule.file,
      title: rule.title,
      severity: rule.severity,
      status: 'passed',
      selection: copySelection(sel),
      filesEvaluated: [],
      violations: [],
      preexistingViolations: [],
      coverageGaps: sortGaps(sel.coverageGaps ?? []),
      error: null,
    }
    results.push(result)

    if (!sel.selected) {
      result.status = 'skipped_inapplicable'
      continue
    }
    const check = Object.prototype.hasOwnProperty.call(checks, rule.check.type) ? checks[rule.check.type] : null
    if (!check) {
      result.status = 'unable_to_evaluate'
      result.error = { code: 'unsupported-check-type', detail: `Unsupported check type "${rule.check.type}".` }
      continue
    }
    const errs = check.validate(rule.check)
    if (errs.length > 0) {
      result.status = 'unable_to_evaluate'
      result.error = { code: 'check-config-invalid', detail: errs.join('; ') }
      continue
    }

    const gaps = [...result.coverageGaps]
    const targets = [...sel.targets].sort((a, b) => cmpStr(a.path, b.path))
    for (const target of targets) {
      const read = snapshot.readFile(target.path)
      if (!read.ok) {
        gaps.push({ code: 'file-unreadable', file: target.path, detail: `Could not read file (${read.reason}): ${read.detail}` })
        continue
      }
      let findings
      try {
        findings = check.run({ path: target.path, text: read.text, config: rule.check })
      } catch (e) {
        gaps.push({ code: 'check-error', file: target.path, detail: `Check threw: ${e && e.message ? e.message : String(e)}` })
        continue
      }
      result.filesEvaluated.push(target.path)
      const added = target.evaluate === 'changed-lines' ? new Set(target.addedLines ?? []) : null
      for (const f of findings) {
        const v = { file: target.path, line: f.line, column: f.column, match: f.match, excerpt: f.excerpt, message: f.message }
        if (added === null || added.has(f.line)) result.violations.push(v)
        else result.preexistingViolations.push(v)
      }
    }
    result.filesEvaluated.sort(cmpStr)
    result.violations.sort(cmpViolation)
    result.preexistingViolations.sort(cmpViolation)
    result.coverageGaps = sortGaps(gaps)

    if (result.violations.length > 0) {
      result.status = 'failed'
    } else if (result.filesEvaluated.length === 0) {
      result.status = 'unable_to_evaluate'
      result.error = {
        code: 'no-evaluable-targets',
        detail: result.coverageGaps.length > 0
          ? 'No target file could be evaluated; see coverage gaps.'
          : 'The rule was selected but has no target files to evaluate.',
      }
    } else {
      result.status = 'passed'
    }
  }

  results.sort((a, b) => cmpStr(a.ruleId, b.ruleId))
  return results
}
