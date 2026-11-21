# Mottlefin — plan, acceptance criteria, shared interfaces

Mottlefin runs design-system evals on UI changes. Given a Git diff and a set of
versioned rules it selects the applicable checks, explains why each ran or was
skipped, runs them, and writes an evidence report tied to rule version and commit.
Selection and execution are deterministic. No model calls, no network, no
runtime dependencies.

## 1. Scope of this pass

In: rule format, selector, runner, evidence report, CLI, one tiny fixture, CI instructions.
Out (later pass): demo apps, external repo clones, cross-framework validation, dashboard,
AST-based checks, inline suppressions, auto-fix.

Stack: Node >= 20, ES modules, zero npm dependencies, `node --test` for tests.
Rules are JSON (no YAML parser needed). All file I/O and git calls are synchronous.

## 2. The workflow

```
rules dir ──► loadRules ─┐
                         ├─► selectRules ─► runRules ─► buildReport ─► text / JSON / Markdown + exit code
git base..head ─► changedFiles ─┘
```

1. Resolve `head` (default `HEAD`) and `base` (default `HEAD~1`; `HEAD` with `--worktree`).
   The diff is taken from `merge-base(base, head)` to `head`.
2. Pick the mode:
   - `diff` — normal case.
   - `full` — `--full` was passed. Every rule runs over every file it targets.
   - `full-fallback` — the base could not be resolved (shallow clone, first commit).
     Applicability is unknowable, so every rule runs as in `full` and the report says so.
3. Select: for each rule decide selected / not selected, with reason codes and target files.
4. Run: execute each selected rule's check on its targets.
5. Report: one result per rule with one of four statuses.

### Statuses

| status | meaning |
|---|---|
| `passed` | check ran on at least one file and found no counting violation |
| `failed` | check found at least one counting violation |
| `skipped_inapplicable` | selector determined the rule does not apply to this change |
| `unable_to_evaluate` | rule should have run but could not (invalid rule, unsupported check type, bad check config, no readable target) |

A `passed` or `failed` result may also carry `coverageGaps`: files the rule
should have covered but could not. Gaps never turn into a silent pass; they are
listed per rule and counted in the summary.

### Applicability rules (diff mode), evaluated in this order

1. Rule file itself is in the diff (A/M/R/C) → selected, reason `rule-changed`, full scope
   (all files matching the rule's paths), every violation counts.
2. Any changed file (any status, including D) matches `appliesTo.triggers` → selected,
   reason `trigger-changed`, full scope, every violation counts.
3. Otherwise look at changed files with status A/M/R/C/T whose (new) path matches
   `appliesTo.paths` and not `appliesTo.exclude`:
   - No content gate: each is a target.
   - Content gate (`appliesTo.content`, a regex): read the file. Matches → target.
     Does not match → not a target. Unreadable → applicability is unknown: record
     coverage gap `applicability-unknown` for that file.
   - ≥ 1 target → selected, reason `changed-file-matches`, certainty `certain`.
   - 0 targets but ≥ 1 `applicability-unknown` gap → selected, reason
     `applicability-uncertain`, certainty `uncertain` (runner will report `unable_to_evaluate`).
   - Otherwise not selected, with whichever of these reasons apply:
     `only-deleted-files-match`, `content-gate-not-matched`, else `no-changed-file-matches`.

Full scope (modes `full`, `full-fallback`, and reasons `rule-changed`, `trigger-changed`):
targets are all files in the snapshot matching paths minus exclude, content gate applied
the same way. Zero matching files and zero gaps → not selected, reason `no-files-match`.
Selected reasons: `full-run` (certain) or `diff-unavailable` (uncertain).

### Which violations count

- Target evaluated as `changed-lines` (diff mode, reason `changed-file-matches`, and the
  rule's `check.scope` is `"changed-lines"`, the default): a finding counts only if its
  line is one of the file's added lines. Other findings go to `preexistingViolations`
  (informational, never fail the rule).
- Target evaluated as `whole-file` (full scope, or `check.scope: "file"`, or the added
  lines are unknown): every finding counts. If added lines were unknown, also record gap
  `changed-lines-unknown`.

## 3. Rule format (v1)

One JSON file per rule under the rules dir (default `<repo>/.mottlefin/rules`, searched
recursively, `*.json`, processed in sorted path order).

```json
{
  "schema": 1,
  "id": "color/no-raw-hex",
  "version": "1.0.0",
  "title": "Use color tokens, not raw hex values",
  "description": "Component styles must reference var(--color-*) tokens.",
  "severity": "error",
  "appliesTo": {
    "paths": ["src/**/*.css"],
    "exclude": ["src/tokens/**"],
    "content": null,
    "triggers": []
  },
  "check": {
    "type": "forbid-pattern",
    "pattern": "#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b",
    "flags": "",
    "allow": [],
    "scope": "changed-lines",
    "message": "Raw hex color. Use a design token: var(--color-*)."
  }
}
```

Envelope validation (rules.js), strict — unknown keys at top level or in `appliesTo` are errors:

- `schema`: optional, must be `1` if present.
- `id`: required, `^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*$`, unique across the rules dir
  (the later file in sort order is the invalid one).
- `version`: required, `^\d+\.\d+\.\d+$`.
- `title`: required non-empty string. `description`: optional string (default `""`).
- `severity`: `"error"` (default) or `"warn"`. A failed `warn` rule does not affect the exit code.
- `appliesTo.paths`: required non-empty array of valid globs. `exclude`, `triggers`:
  optional glob arrays (default `[]`). `content`: optional regex source or null.
- `check`: required object with non-empty string `type`. `check.scope` if present must be
  `"changed-lines"` or `"file"`. The rest of `check` is opaque to rules.js; the check
  implementation validates it. An unknown `check.type` is NOT a load error — the runner
  reports `unable_to_evaluate` so newer rule packs degrade visibly on an older CLI.

Rule identity in evidence = `id` + `version` + `digest` (`sha256:` + hex of the raw file bytes).

Glob syntax (glob.js): `*` any run of non-`/` chars; `?` one non-`/` char; `**/` zero or
more directories; trailing `**` anything; `{a,b}` alternation (no nesting); everything else
literal. Anchored at both ends, case-sensitive, no dotfile special-casing. Paths are
repo-relative POSIX with no leading `./`.

Check type `forbid-pattern`: for each line, each regex match of `pattern` (flags from
`flags`, `g` always added) is a finding, unless the line matches any regex in `allow`.

## 4. Shared interfaces

All modules are ESM under `src/`. All paths passed between modules are repo-relative POSIX.
All returned arrays are sorted (rules by id, files by path, findings by file/line/column)
so output is byte-stable.

### src/glob.js

```js
export function globToRegExp(glob)        // -> RegExp; throws Error on invalid glob (e.g. unbalanced brace, empty string)
export function matchesAny(path, globs)   // -> boolean; false for empty globs
```

### src/git.js

```js
export function findRepoRoot(dir)   // -> absolute path | null  (git rev-parse --show-toplevel)
export function createRepo(root)    // -> Repo
Repo = {
  root,
  resolveRef(ref),                  // -> full sha | null   (rev-parse --verify <ref>^{commit})
  mergeBase(a, b),                  // -> sha | null
  isDirty(),                        // -> boolean (tracked changes or untracked non-ignored files)
  changedFiles({ baseSha, headSha, worktree }),   // -> ChangedFile[] sorted by path
  snapshot({ headSha, worktree }),  // -> Snapshot
}
ChangedFile = {
  path,                             // new path (old path for D)
  status,                           // 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  oldPath,                          // string for R/C, else null
  binary,                           // boolean
  addedLines,                       // sorted number[] of 1-based line numbers added/modified in the new file;
                                    // [] for D; null when unknown (binary, unparseable)
}
Snapshot = {
  listFiles(),                      // -> string[] sorted; all files at head (or in the worktree: tracked + untracked non-ignored, existing on disk)
  readFile(path),                   // -> ReadResult, memoized
}
ReadResult = { ok: true, text } | { ok: false, reason: 'missing' | 'binary' | 'too-large' | 'unreadable', detail }
```

- `worktree: false`: diff `baseSha..headSha`, content from `git show <headSha>:<path>`.
- `worktree: true`: diff `baseSha` vs working tree (staged + unstaged), plus untracked
  non-ignored files as status `A` with every line added; content from disk.
- Rename detection on (`-M`). Binary = NUL byte in the first 8000 bytes. Too large = > 2 MiB.
- Must be correct for paths containing spaces and non-ASCII (use `-z` output).
- Uses `execFileSync('git', [...])` only. No shell.

### src/rules.js

```js
export function loadRules(rulesDirAbs, { repoRoot })   // -> { rules: Rule[], invalid: InvalidRule[] }, both sorted by id
Rule = {
  id, version, title, description, severity,
  appliesTo: { paths, exclude, content, triggers },   // normalized, defaults filled
  check,                                               // as written, with scope defaulted to 'changed-lines'
  file,                                                // rule file path relative to repoRoot, POSIX (may start with ../)
  digest,                                              // 'sha256:<hex>'
}
InvalidRule = { id, file, digest, errors: string[] }   // id = declared id if it is a string, else the file path
```

Throws only if the rules dir does not exist or is not a directory.

### src/select.js

```js
export function selectRules({ rules, mode, changedFiles, snapshot })   // -> Selection[] in rule order
// mode: 'diff' | 'full' | 'full-fallback'; changedFiles is [] unless mode === 'diff'
Selection = {
  ruleId,
  selected,                         // boolean
  certainty,                        // 'certain' | 'uncertain'
  reasons: [{ code, detail, files }],   // files: string[] (may be empty); detail: one human sentence
  targets: [{ path, evaluate, addedLines }],   // evaluate: 'changed-lines' | 'whole-file'; addedLines: number[] | null
  coverageGaps: [{ code, file, detail }],      // file: string | null
}
```

Reason codes — selected: `full-run`, `diff-unavailable`, `rule-changed`, `trigger-changed`,
`changed-file-matches`, `applicability-uncertain`. Not selected: `no-changed-file-matches`,
`only-deleted-files-match`, `content-gate-not-matched`, `no-files-match`.
Gap codes from the selector: `applicability-unknown`, `changed-lines-unknown`.
Pure function: no git, no fs — only `snapshot` and its arguments.

### src/checks/index.js, src/checks/forbid-pattern.js

```js
export const checks = { 'forbid-pattern': forbidPattern }
Check = {
  validate(config),                 // -> string[] of errors ([] = ok); config is rule.check
  run({ path, text, config }),      // -> Finding[] sorted by line, column
}
Finding = { line, column, match, excerpt, message }   // 1-based; excerpt = the trimmed line, max 200 chars
```

### src/runner.js

```js
export function runRules({ rules, invalid, selections, snapshot })   // -> RuleResult[] sorted by ruleId
RuleResult = {
  ruleId, ruleVersion, ruleDigest, ruleFile, title, severity,   // version/title/severity null for invalid rules
  status,                           // 'passed' | 'failed' | 'skipped_inapplicable' | 'unable_to_evaluate'
  selection: { selected, certainty, reasons },
  filesEvaluated,                   // string[]
  violations,                       // Violation[] — counting
  preexistingViolations,            // Violation[] — informational
  coverageGaps,                     // selector gaps + runner gaps
  error,                            // { code, detail } | null
}
Violation = { file, line, column, match, excerpt, message }
```

Status logic, in order: invalid rule → `unable_to_evaluate` (`rule-invalid`); not selected →
`skipped_inapplicable`; unknown check type → `unable_to_evaluate` (`unsupported-check-type`);
`validate` errors → `unable_to_evaluate` (`check-config-invalid`); then run each target —
unreadable target → gap `file-unreadable`, check throws → gap `check-error`; any counting
violation → `failed`; else zero files evaluated → `unable_to_evaluate` (`no-evaluable-targets`);
else `passed`.

### src/report.js

```js
export function buildReport({ tool, run, results })   // -> Report
export function renderText(report)                    // -> string (plain, no ANSI)
export function renderMarkdown(report)                // -> string (GitHub-flavored, for step summaries / PR comments)
export function exitCodeFor(report, { strict })       // -> 0 | 1
Report = {
  schemaVersion: 1,
  tool: { name: 'mottlefin', version },
  run: {
    mode,                           // 'diff' | 'full' | 'full-fallback'
    head: { ref, sha },
    base: { ref, sha } | null,      // sha null when unresolved
    mergeBase,                      // sha | null
    worktree, dirty,                // booleans
    rulesDir,                       // repo-relative
    changedFiles: [{ path, status, oldPath, binary }],
    notices: [{ code, detail }],    // e.g. diff-unavailable, merge-base-unavailable, worktree-dirty
  },
  summary: { passed, failed, skipped_inapplicable, unable_to_evaluate, coverageGaps, rules },
  results,                          // RuleResult[]
}
```

No timestamps, no absolute paths, no hostnames: the same commit + rules produce a
byte-identical JSON report. `exitCodeFor`: 1 if any `failed` result with severity `error`;
with `strict`, also 1 if any `unable_to_evaluate` result or any coverage gap; else 0.

Text and Markdown must show, per rule: status, `id@version`, short digest, why it ran or was
skipped (reason details), each violation as `file:line:column` with match, message and
excerpt, pre-existing violation count, coverage gaps, and error detail. Header shows mode,
head sha, base sha, changed-file count, notices. Footer shows the four counts plus gaps.

### src/cli.js, bin/mottlefin.js

```
mottlefin run [--base <ref>] [--head <ref>] [--worktree] [--full] [--strict]
              [--rules <dir>] [--repo <dir>]
              [--format text|json|markdown] [--report-json <file>] [--report-md <file>]
mottlefin validate [--rules <dir>] [--repo <dir>]
mottlefin --help | --version
```

Exit codes: `0` no blocking result; `1` a blocking result (see `exitCodeFor`), or
`validate` found an invalid rule; `2` usage or environment error (not a git repo, rules dir
missing, head unresolvable, unknown flag).

`run` flow: find repo root → load rules → resolve head (fail → 2) → choose mode (`--full` →
`full`; base unresolved → `full-fallback` + notice `diff-unavailable`; merge-base missing →
diff from base directly + notice `merge-base-unavailable`) → changedFiles → selectRules →
runRules → buildReport → print `--format` to stdout, write `--report-json` / `--report-md` →
exit. With `--worktree` and a dirty tree, add notice `worktree-dirty` (evidence then refers
to head sha plus uncommitted changes). Rules are always read from the working tree; the
digest records exactly which rule content ran.

## 5. Fixture and smoke test

`fixture/` holds one rule (`color/no-raw-hex`, section 3) and `fixture/setup.mjs`, which
builds a throwaway git repo (fixed author, committer and dates, so SHAs are stable) with:

| ref | change relative to `base` | expected |
|---|---|---|
| `base` | `src/components/Button.css` (tokens only), `src/components/Legacy.css` (one pre-existing raw hex = existing debt), `src/tokens/colors.css` (hex, excluded), `docs/guide.md`, `.mottlefin/rules/color-no-raw-hex.json` | — |
| `relevant-clean` | Button.css gains a `var(--color-border)` declaration | rule selected, `passed`, exit 0 |
| `unrelated` | `docs/guide.md` edited | rule `skipped_inapplicable`, exit 0 |
| `regression` | Button.css gains `background: #ff0000;` | rule selected, `failed` at the exact line, exit 1 |

Extra scenarios on the same fixture: `--full` on `base` (selected `full-run`; whole-file
scope finds the Legacy.css debt, so `failed`, exit 1 — the audit view);
`--base no-such-ref` (mode `full-fallback`, notice, rule still runs, uncertain).
`test/smoke.test.js` asserts all of these through the real CLI. `scripts/smoke.mjs` prints
the actual reports for humans.

## 6. Acceptance criteria

1. `npm test` passes with zero dependencies installed.
2. Relevant change → rule selected with reason `changed-file-matches` naming the file; `passed`.
3. Unrelated change → `skipped_inapplicable` with reason `no-changed-file-matches`; check not executed.
4. Regression → `failed`, violation reported at correct `file:line:column`, exit code 1.
5. `--full` runs every rule regardless of the diff, reason `full-run`.
6. Unresolvable base → every rule runs, mode `full-fallback`, notice in report.
7. Unsupported check type, invalid rule file, and unreadable-only targets each yield
   `unable_to_evaluate` with an error code; `--strict` makes them exit 1.
8. A file that matches a rule but cannot be read yields a coverage gap, never a silent pass.
9. Every result carries rule id, version, digest; the report carries head and base SHAs.
10. Two runs on the same commit + rules produce byte-identical JSON.
11. Pre-existing violations on unchanged lines do not fail a `changed-lines` rule but are counted.
12. No network or model calls anywhere in the codebase; only `node:` builtins and `git`.

## 7. Delegation

| phase | owner | model | deliverable |
|---|---|---|---|
| 0 | lead | — | this plan |
| 1 | agent A | Haiku | `src/glob.js`, `test/glob.test.js` |
| 1 | agent B | Sonnet | `src/git.js`, `test/git.test.js` |
| 1 | agent C | Opus | `src/rules.js`, `src/select.js`, tests |
| 1 | agent D | Sonnet | `src/checks/*`, `src/runner.js`, `src/report.js`, tests |
| 2 | agent E | Sonnet | `package.json`, `bin/`, `src/cli.js`, `fixture/`, smoke test + script |
| 2 | agent F | Haiku | `README.md` (usage + CI setup), `examples/github-actions.yml` |
| 3 | lead | — | review, integrated run, delegate fixes, record smoke results |

Rules for agents: touch only your own files; code against the interfaces above exactly; if
an interface seems wrong, report it instead of changing it; no npm dependencies.

## 8. Verification record (lead, integrated run)

- `npm test`: 137 tests, 137 pass, 0 fail (Node v24.15.0, zero dependencies).
- `npm run smoke`: 5/5 scenarios match expectation; outputs in `smoke-results/`.
- Manual runs on a fresh fixture: relevant → passed (`Button.css` named in reason); unrelated →
  skipped (`no-changed-file-matches`); regression → failed at `Button.css:8:15`, exit 1;
  `--full` → `full-run`, finds `Legacy.css:2:10` debt; bad base → `full-fallback` + notice,
  uncertain; `--worktree` with new file → only new-line violation counts, Legacy debt reported
  as pre-existing; binary `.css` → `unable_to_evaluate` + gaps, exit 0 / 1 with `--strict`;
  invalid + unreadable rule files → `rule-invalid`; rule file edited → `rule-changed` re-audit;
  run from a subdirectory → same result; JSON byte-identical across runs; no network/model calls.
- Defects found in review and fixed by owners: verdict ignored `--strict`; `--full` header said
  base "unresolved"; Markdown did not escape `*`/`_` (globs rendered as bold); report could
  claim a head SHA whose rules did not run (now `rules-differ-from-head` notice); CI example
  exited 0 if the run step died early.
