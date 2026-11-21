// Applicability selector. Pure: uses only its arguments and snapshot.listFiles/readFile.
// See PLAN.md section 2 ("Applicability rules") for the decision order implemented here.

import { globToRegExp } from './glob.js';

const RULE_CHANGE_STATUSES = new Set(['A', 'M', 'R', 'C']);
const LIVE_STATUSES = new Set(['A', 'M', 'R', 'C', 'T']);

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(items) {
  return [...new Set(items)].sort(compare);
}

function compareGaps(a, b) {
  if (a.file !== b.file) {
    if (a.file === null) return -1;
    if (b.file === null) return 1;
    return compare(a.file, b.file);
  }
  return compare(a.code, b.code);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function fileList(files, max = 5) {
  if (files.length <= max) return files.join(', ');
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`;
}

// Compiled matchers for one rule: { firstMatch(globs, path) -> glob | null, ... }.
function compileRule(rule) {
  const compileAll = (globs) => (globs ?? []).map((glob) => ({ glob, re: globToRegExp(glob) }));
  const paths = compileAll(rule.appliesTo.paths);
  const exclude = compileAll(rule.appliesTo.exclude);
  const triggers = compileAll(rule.appliesTo.triggers);
  const first = (list, p) => {
    for (const { glob, re } of list) if (re.test(p)) return glob;
    return null;
  };
  const content = rule.appliesTo.content;
  return {
    // Glob from appliesTo.paths that selects p, or null if none matches or p is excluded.
    pathGlob: (p) => {
      const glob = first(paths, p);
      if (glob === null || first(exclude, p) !== null) return null;
      return glob;
    },
    triggerGlob: (p) => first(triggers, p),
    contentRe: content === null || content === undefined ? null : new RegExp(content),
    content,
  };
}

// Apply the content gate to one path. Returns 'match' | 'no-match' | { gap }.
function contentGate(matcher, snapshot, p) {
  if (matcher.contentRe === null) return 'match';
  const result = snapshot.readFile(p);
  if (!result || !result.ok) {
    const why = result ? result.reason + (result.detail ? `: ${result.detail}` : '') : 'unknown';
    return {
      gap: {
        code: 'applicability-unknown',
        file: p,
        detail: `${p} matches the rule's paths but could not be read to apply the content gate /${matcher.content}/ (${why}).`,
      },
    };
  }
  matcher.contentRe.lastIndex = 0;
  return matcher.contentRe.test(result.text) ? 'match' : 'no-match';
}

// Full scope: every snapshot file matching paths minus exclude, content gate applied.
function fullScope(rule, matcher, snapshot) {
  const targets = [];
  const gaps = [];
  let gateRejected = 0;
  let pathMatched = 0;
  for (const p of [...snapshot.listFiles()].sort(compare)) {
    if (matcher.pathGlob(p) === null) continue;
    pathMatched++;
    const gate = contentGate(matcher, snapshot, p);
    if (gate === 'match') targets.push({ path: p, evaluate: 'whole-file', addedLines: null });
    else if (gate === 'no-match') gateRejected++;
    else gaps.push(gate.gap);
  }
  return { targets, gaps, gateRejected, pathMatched };
}

function describePaths(rule) {
  const base = rule.appliesTo.paths.join(', ');
  return rule.appliesTo.exclude.length > 0 ? `${base} (excluding ${rule.appliesTo.exclude.join(', ')})` : base;
}

function scopeSummary(scope) {
  const n = scope.targets.length;
  let s = `${n} matching ${plural(n, 'file', 'files')} evaluated as whole files`;
  if (scope.gaps.length > 0) {
    s += `, ${scope.gaps.length} ${plural(scope.gaps.length, 'file', 'files')} with unknown applicability`;
  }
  return s;
}

function noFilesMatchReason(rule, scope, cause) {
  let detail = `${cause}, but no file in the snapshot matches ${describePaths(rule)}`;
  if (scope.gateRejected > 0) {
    detail = `${cause}, but none of the ${scope.pathMatched} ${plural(scope.pathMatched, 'file', 'files')} matching ${describePaths(rule)} matches the content gate /${rule.appliesTo.content}/`;
  }
  return { code: 'no-files-match', detail: `${detail}.`, files: [] };
}

function fullScopeSelection(rule, matcher, snapshot, { code, certainty, cause, files }) {
  const scope = fullScope(rule, matcher, snapshot);
  const gaps = [...scope.gaps].sort(compareGaps);
  if (scope.targets.length === 0 && gaps.length === 0) {
    return {
      ruleId: rule.id,
      selected: false,
      certainty: 'certain',
      reasons: [noFilesMatchReason(rule, scope, cause)],
      targets: [],
      coverageGaps: [],
    };
  }
  const reasonFiles = files ?? sortedUnique([...scope.targets.map((t) => t.path), ...gaps.map((g) => g.file)]);
  return {
    ruleId: rule.id,
    selected: true,
    certainty,
    reasons: [{ code, detail: `${cause}; ${scopeSummary(scope)}.`, files: reasonFiles }],
    targets: scope.targets,
    coverageGaps: gaps,
  };
}

function selectDiff(rule, matcher, changedFiles, snapshot) {
  // 1. Rule file itself changed.
  const ruleChange = changedFiles.find((cf) => cf.path === rule.file && RULE_CHANGE_STATUSES.has(cf.status));
  if (ruleChange) {
    return fullScopeSelection(rule, matcher, snapshot, {
      code: 'rule-changed',
      certainty: 'certain',
      cause: `Rule file ${rule.file} changed, so the rule runs over every file it targets`,
      files: [rule.file],
    });
  }

  // 2. A changed file (any status) matches a trigger. Both new and old paths are considered.
  const triggerHits = [];
  for (const cf of changedFiles) {
    for (const p of cf.oldPath ? [cf.path, cf.oldPath] : [cf.path]) {
      const glob = matcher.triggerGlob(p);
      if (glob !== null) triggerHits.push({ path: p, glob });
    }
  }
  if (triggerHits.length > 0) {
    triggerHits.sort((a, b) => compare(a.path, b.path));
    const files = sortedUnique(triggerHits.map((h) => h.path));
    const parts = triggerHits.map((h) => `${h.path} matches trigger ${h.glob}`);
    return fullScopeSelection(rule, matcher, snapshot, {
      code: 'trigger-changed',
      certainty: 'certain',
      cause: `${plural(files.length, 'Changed file', 'Changed files')} ${parts.join('; ')}, so the rule runs over every file it targets`,
      files,
    });
  }

  // 3. Changed files matching paths minus exclude.
  const scope = rule.check.scope ?? 'changed-lines';
  const targets = [];
  const gaps = [];
  const matched = []; // { path, glob } for targets
  const deleted = [];
  const gateRejected = [];
  for (const cf of changedFiles) {
    const glob = matcher.pathGlob(cf.path);
    if (glob === null) continue;
    if (cf.status === 'D') {
      deleted.push(cf.path);
      continue;
    }
    if (!LIVE_STATUSES.has(cf.status)) continue;
    const gate = contentGate(matcher, snapshot, cf.path);
    if (gate === 'no-match') {
      gateRejected.push(cf.path);
      continue;
    }
    if (gate !== 'match') {
      gaps.push(gate.gap);
      continue;
    }
    const addedLines = cf.addedLines ?? null;
    let evaluate = 'whole-file';
    if (scope === 'changed-lines') {
      if (addedLines !== null) {
        evaluate = 'changed-lines';
      } else {
        gaps.push({
          code: 'changed-lines-unknown',
          file: cf.path,
          detail: `Added lines for ${cf.path} are unknown${cf.binary ? ' (binary file)' : ''}, so the whole file is evaluated and every finding counts.`,
        });
      }
    }
    targets.push({ path: cf.path, evaluate, addedLines: addedLines === null ? null : [...addedLines] });
    matched.push({ path: cf.path, glob, status: cf.status, oldPath: cf.oldPath });
  }

  targets.sort((a, b) => compare(a.path, b.path));
  matched.sort((a, b) => compare(a.path, b.path));
  gaps.sort(compareGaps);

  if (targets.length > 0) {
    const parts = matched.map((m) => {
      const how = m.oldPath && (m.status === 'R' || m.status === 'C')
        ? `${m.path} (${m.status === 'R' ? 'renamed' : 'copied'} from ${m.oldPath})`
        : m.path;
      return `${how} changed and matches ${m.glob}`;
    });
    return {
      ruleId: rule.id,
      selected: true,
      certainty: 'certain',
      reasons: [{ code: 'changed-file-matches', detail: `${parts.join('; ')}.`, files: matched.map((m) => m.path) }],
      targets,
      coverageGaps: gaps,
    };
  }

  if (gaps.length > 0) {
    const files = sortedUnique(gaps.map((g) => g.file));
    return {
      ruleId: rule.id,
      selected: true,
      certainty: 'uncertain',
      reasons: [{
        code: 'applicability-uncertain',
        detail: `${fileList(files)} ${plural(files.length, 'matches', 'match')} ${describePaths(rule)} but could not be read to apply the content gate, so applicability is unknown.`,
        files,
      }],
      targets: [],
      coverageGaps: gaps,
    };
  }

  const reasons = [];
  if (deleted.length > 0) {
    const files = sortedUnique(deleted);
    reasons.push({
      code: 'only-deleted-files-match',
      detail: `${fileList(files)} ${plural(files.length, 'matches', 'match')} ${describePaths(rule)} but ${plural(files.length, 'was', 'were')} deleted, so there is nothing to check.`,
      files,
    });
  }
  if (gateRejected.length > 0) {
    const files = sortedUnique(gateRejected);
    reasons.push({
      code: 'content-gate-not-matched',
      detail: `${fileList(files)} ${plural(files.length, 'matches', 'match')} ${describePaths(rule)} but ${plural(files.length, 'does', 'do')} not match the content gate /${rule.appliesTo.content}/.`,
      files,
    });
  }
  if (reasons.length === 0) {
    const n = changedFiles.length;
    reasons.push({
      code: 'no-changed-file-matches',
      detail: n === 0
        ? `No files changed, so nothing matches ${describePaths(rule)}.`
        : `None of the ${n} changed ${plural(n, 'file', 'files')} ${plural(n, 'matches', 'match')} ${describePaths(rule)}.`,
      files: [],
    });
  }
  return { ruleId: rule.id, selected: false, certainty: 'certain', reasons, targets: [], coverageGaps: [] };
}

/**
 * Decide, per rule, whether it applies to this change, why, and on which files.
 * @param {{ rules: object[], mode: 'diff'|'full'|'full-fallback', changedFiles: object[], snapshot: object }} args
 * @returns {object[]} Selection[] in rule order
 */
export function selectRules({ rules, mode, changedFiles = [], snapshot }) {
  if (mode !== 'diff' && mode !== 'full' && mode !== 'full-fallback') {
    throw new Error(`unknown selection mode: ${JSON.stringify(mode)}`);
  }
  const sortedChanged = [...changedFiles].sort((a, b) => compare(a.path, b.path));
  return rules.map((rule) => {
    const matcher = compileRule(rule);
    if (mode === 'full') {
      return fullScopeSelection(rule, matcher, snapshot, {
        code: 'full-run',
        certainty: 'certain',
        cause: 'Full run requested, so the rule runs over every file it targets',
      });
    }
    if (mode === 'full-fallback') {
      return fullScopeSelection(rule, matcher, snapshot, {
        code: 'diff-unavailable',
        certainty: 'uncertain',
        cause: 'The base could not be resolved, so the diff is unavailable and the rule runs over every file it targets',
      });
    }
    return selectDiff(rule, matcher, sortedChanged, snapshot);
  });
}
