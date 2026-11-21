# Mottlefin

Mottlefin runs design-system checks on UI changes. Given a Git diff and a set of versioned rules, it selects the rules that apply, explains why each one ran or was skipped, runs them, and writes an evidence report tied to the rule version and the commit. Selection and execution are deterministic: no model calls, no network, no runtime dependencies.

## Install

Requires Node.js 20 or later and `git` on the PATH. There are no npm dependencies.

```sh
git clone <this repo> mottlefin
cd mottlefin

# Option 1: run in place
node bin/mottlefin.js --help

# Option 2: put `mottlefin` on your PATH
npm link
mottlefin --help
```

## Quick start

Build a throwaway repo with a few known commits, then check the `regression` commit against `base`:

```sh
node fixture/setup.mjs /tmp/mf-demo
node bin/mottlefin.js run --repo /tmp/mf-demo --base base --head regression
```

The `regression` commit adds a raw hex color to `src/components/Button.css`. The rule `color/no-raw-hex` is selected, reports `failed` at the exact line, and the command exits with `1`.

## Writing a rule

Rules are JSON files, one per rule, in `<repo>/.mottlefin/rules` (searched recursively for `*.json`). Use `--rules <dir>` to point elsewhere.

The fixture rule, `fixture/rules/color-no-raw-hex.json`:

```json
{
  "schema": 1,
  "id": "color/no-raw-hex",
  "version": "1.0.0",
  "title": "Use color tokens, not raw hex values",
  "description": "Component styles must reference design tokens (var(--color-*)). Raw hex values bypass theming and dark mode. Token definitions under src/tokens/ are exempt.",
  "severity": "error",
  "appliesTo": {
    "paths": ["src/**/*.css"],
    "exclude": ["src/tokens/**"]
  },
  "check": {
    "type": "forbid-pattern",
    "pattern": "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b",
    "allow": ["mottlefin-allow color/no-raw-hex"],
    "scope": "changed-lines",
    "message": "Raw hex color. Use a design token, e.g. var(--color-danger)."
  }
}
```

What each part does:

- `id`: stable identifier, lowercase segments separated by `/` (`color/no-raw-hex`). Must be unique across the rules dir.
- `version`: semver `x.y.z`. Recorded in every result. See versioning below.
- `title`, `description`: human text shown in reports.
- `severity`: `error` (default) or `warn`. A failed `warn` rule does not affect the exit code.
- `appliesTo.paths`: required glob list. Which files the rule is about.
- `appliesTo.exclude`: glob list of files to skip (here, the token definitions).
- `appliesTo.content`: optional regex source. A matching file is a target only if its contents match. Set to `null` or omit.
- `appliesTo.triggers`: optional glob list. A change to any matching file (including a deletion) selects the rule for all of its files.
- `check.type`: the check to run. `forbid-pattern` is the only one in this version.
- `check.pattern`: the regex for `forbid-pattern`. Every match on a line is a finding.
- `check.flags`: regex flags. The `g` flag is always added. The fixture omits it.
- `check.allow`: regexes. A line matching any of them produces no finding. The fixture uses this as a per-line escape hatch.
- `check.scope`: `changed-lines` (default) or `file`. See "Which violations count" below.
- `check.message`: text shown with each finding.

Unknown keys at the top level or inside `appliesTo` are load errors. Use `mottlefin validate` to check rule files without running anything.

**Glob syntax:** `*` matches any run of characters except `/`; `?` matches one character except `/`; `**/` matches zero or more directories; a trailing `**` matches anything; `{a,b}` is alternation (no nesting). Everything else is literal. Globs are anchored at both ends, case-sensitive, and do not special-case dotfiles. Paths are repo-relative with no leading `./`.

**Versioning:**

- Bump `version` when the rule's check behavior changes: what it flags (`pattern`, `flags`, `allow`, `scope`) or which files it selects (`appliesTo`). Evidence reports record the version, so a bump shows when behavior changed.
- Any byte change to the file changes its `digest` (`sha256:` plus the hash of the raw file), even without a version bump. The report records the digest, so the exact content that ran is always known. Treat the digest as the authoritative identity and `version` as the human-readable label.

## How selection works

Mottlefin resolves `--head` (default `HEAD`) and `--base` (default `HEAD~1`; `HEAD` with `--worktree`). The diff is taken from `merge-base(base, head)` to `head`.

Three modes:

| mode | when | what runs |
|---|---|---|
| `diff` | normal case | Rules are selected by the applicability rules below. |
| `full` | `--full` | Every rule runs over every file it targets. |
| `full-fallback` | the base cannot be resolved (shallow clone, first commit) | Every rule runs as in `full`. The report has a `diff-unavailable` notice. |

**Applicability in diff mode**, evaluated in this order for each rule:

1. The rule file itself is in the diff (added, modified, renamed, or copied). The rule is selected with reason `rule-changed` and runs over its full scope: all files matching its paths, and every violation counts.
2. Any changed file matches `appliesTo.triggers`, including deleted files. The rule is selected with reason `trigger-changed`, full scope, and every violation counts.
3. Otherwise, look at changed files with status added, modified, renamed, copied, or type-changed whose new path matches `appliesTo.paths` and not `appliesTo.exclude`:
   - With no content gate, each such file is a target.
   - With a content gate, the file is read. If it matches, it is a target. If it does not, it is not. If it cannot be read, the file gets an `applicability-unknown` coverage gap.
   - One or more targets: selected, reason `changed-file-matches`, certainty `certain`.
   - No targets but at least one `applicability-unknown` gap: selected, reason `applicability-uncertain`, certainty `uncertain`. The runner then reports `unable_to_evaluate`.
   - Otherwise not selected, with the first applicable reason: `only-deleted-files-match`, `content-gate-not-matched`, or `no-changed-file-matches`.

Full scope (`full`, `full-fallback`, `rule-changed`, `trigger-changed`): targets are all files in the snapshot matching paths minus exclude, with the content gate applied the same way. If nothing matches and there are no gaps, the rule is not selected with reason `no-files-match`.

**Reason codes**

| code | selected? | meaning |
|---|---|---|
| `full-run` | yes (certain) | `--full` mode; every matching file. |
| `diff-unavailable` | yes (uncertain) | Base unresolved; full-fallback mode. |
| `rule-changed` | yes | The rule file changed in this diff. |
| `trigger-changed` | yes | A trigger file changed in this diff. |
| `changed-file-matches` | yes (certain) | One or more changed files are targets. |
| `applicability-uncertain` | yes (uncertain) | No targets could be confirmed; an unreadable file could be one. |
| `no-changed-file-matches` | no | No changed file matches the rule's paths. |
| `only-deleted-files-match` | no | Only deleted files match. |
| `content-gate-not-matched` | no | Matching files do not satisfy `appliesTo.content`. |
| `no-files-match` | no | Full scope, and no file in the snapshot matches. |

**Coverage gaps.** A gap is a file the rule should have covered but could not. Gaps are never a silent pass. They are listed per rule and counted in the summary.

| code | source | meaning |
|---|---|---|
| `applicability-unknown` | selector | A content-gated file could not be read, so it may or may not be a target. |
| `changed-lines-unknown` | selector | Added lines for a file are unknown (binary or unparseable), so every finding in it counts. |
| `file-unreadable` | runner | A target could not be read. |
| `check-error` | runner | The check threw on a target. |

**Which violations count.** With `scope: "changed-lines"` in diff mode, a finding counts only if it is on a line the change added or modified. Other findings are listed as pre-existing violations. They are informational and never fail the rule. With `scope: "file"`, in full mode, or when added lines are unknown, every finding counts.

## Statuses

| status | meaning |
|---|---|
| `passed` | The check ran on at least one file and found no counting violation. |
| `failed` | The check found at least one counting violation. |
| `skipped_inapplicable` | The selector determined the rule does not apply to this change. The check did not run. |
| `unable_to_evaluate` | The rule should have run but could not: invalid rule, unsupported check type, bad check config, or no readable target. |

`passed` and `failed` results may also carry coverage gaps.

## Commands and flags

```
mottlefin run [--base <ref>] [--head <ref>] [--worktree] [--full] [--strict]
              [--rules <dir>] [--repo <dir>]
              [--format text|json|markdown] [--report-json <file>] [--report-md <file>]
mottlefin validate [--rules <dir>] [--repo <dir>]
mottlefin --help | --version
```

- `--base <ref>`: base to diff from. Default `HEAD~1` (`HEAD` with `--worktree`).
- `--head <ref>`: head to evaluate. Default `HEAD`.
- `--worktree`: compare the base against the working tree (staged, unstaged, and untracked non-ignored files) instead of `--head`.
- `--full`: run every rule over every file it targets, ignoring the diff.
- `--strict`: also exit `1` on `unable_to_evaluate` results and coverage gaps.
- `--rules <dir>`: rules directory. Default `<repo>/.mottlefin/rules`.
- `--repo <dir>`: repository to check.
- `--format text|json|markdown`: format written to stdout.
- `--report-json <file>`, `--report-md <file>`: also write the report to these files.
- `validate`: load and check the rule files only.

`run` always reads rules from the working tree (see limitations).

## Exit codes

| code | meaning |
|---|---|
| `0` | No blocking result. |
| `1` | A blocking result: a `failed` rule with `error` severity. With `--strict`, also any `unable_to_evaluate` result or coverage gap. `validate` exits `1` if any rule is invalid. |
| `2` | Usage or environment error: not a git repo, rules dir missing, head unresolvable, unknown flag. |

## Evidence report

`--format json` (or `--report-json`) produces a report with this shape:

- `schemaVersion`: `1`.
- `tool`: `{ name, version }` of mottlefin.
- `run`: `mode` (`diff`, `full`, `full-fallback`), `head` and `base` as `{ ref, sha }` (base `sha` is null if unresolved), `mergeBase`, `worktree`, `dirty`, `rulesDir`, `changedFiles` (path, status, oldPath, binary), and `notices` (for example `diff-unavailable`, `merge-base-unavailable`, `worktree-dirty`).
- `summary`: counts for each status, `coverageGaps`, and `rules`.
- `results`: one entry per rule, sorted by rule id. Each has `ruleId`, `ruleVersion`, `ruleDigest`, `ruleFile`, `title`, `severity`, `status`, `selection` (selected, certainty, reasons), `filesEvaluated`, `violations`, `preexistingViolations`, `coverageGaps`, and `error`.
- Each violation has `file`, `line`, `column`, `match`, `excerpt`, and `message`.

**Determinism.** The report has no timestamps, absolute paths, or hostnames. The same commit and the same rule files produce a byte-identical JSON report. Run `run` twice and diff the output to confirm.

**Traceability.** Every result carries the rule `id`, `version`, and `digest`, so you know exactly which rule content was applied. The report carries the head and base SHAs, so you know which commit was evaluated. With `--worktree` and uncommitted changes, `dirty` is true and a `worktree-dirty` notice is added: the evidence then refers to the head SHA plus uncommitted content, which is not a commit-only result.

Notices that qualify the evidence:

| notice | meaning |
|---|---|
| `diff-unavailable` | base could not be resolved; every rule ran (`full-fallback`), selections are `uncertain` |
| `merge-base-unavailable` | no common ancestor; the diff was taken from the base directly |
| `worktree-dirty` | `--worktree` run; results include uncommitted changes |
| `worktree-dirty-ignored` | the tree has uncommitted changes that were *not* evaluated (pass `--worktree` to include them) |
| `rules-differ-from-head` | rules are read from the working tree, and some rule files there differ from the `--head` commit. The digests show what actually ran; check out the head commit for evidence that matches it. CI checks out the head, so this should not appear there. |

## Local usage

```sh
# Check the last commit (HEAD against HEAD~1)
node bin/mottlefin.js run --repo /path/to/app

# Check a specific range
node bin/mottlefin.js run --repo /path/to/app --base main --head feature/x

# Check uncommitted changes against HEAD
node bin/mottlefin.js run --repo /path/to/app --worktree

# Run every rule over every file, ignoring the diff
node bin/mottlefin.js run --repo /path/to/app --full

# Check the rule files
node bin/mottlefin.js validate --repo /path/to/app
```

## CI setup

The example workflow is in `examples/github-actions.yml`. The key points:

**Fetch depth.** The diff needs the base commit. Use `fetch-depth: 0` in `actions/checkout`. With a shallow clone, the base cannot be resolved, the run falls back to `full-fallback`, and the report says so in its notices.

**Pass the PR base and head explicitly.**

- `--base ${{ github.event.pull_request.base.sha }}`
- `--head ${{ github.event.pull_request.head.sha }}`

`actions/checkout` checks out a merge commit by default for `pull_request` events. Passing `--head` explicitly keeps the evaluated commit the PR head, not the merge commit. The example also checks out the head SHA so that rules are read from the PR's version.

**Reports.** Write `--report-json` (evidence, uploaded as an artifact) and `--report-md` (for humans). Append the Markdown to `$GITHUB_STEP_SUMMARY` so it appears on the run page.

**Keep the report step running when the check fails.** Run mottlefin in a step that captures its exit code instead of failing immediately. Run the report and upload steps with `if: always()`. Finish with a step that exits with the captured code, so the job's final status is mottlefin's.

**Blocking.** Add `--strict` to also block on `unable_to_evaluate` results and coverage gaps. Without it, only failed `error`-severity rules block.

Minimal GitHub Actions sketch (see the example file for the full workflow):

```yaml
on: pull_request
jobs:
  mottlefin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/checkout@v4
        with:
          repository: your-org/mottlefin
          path: .mottlefin-tool
      - id: check
        shell: bash
        run: |
          set +e
          node .mottlefin-tool/bin/mottlefin.js run --repo "$GITHUB_WORKSPACE" \
            --base "${{ github.event.pull_request.base.sha }}" \
            --head "${{ github.event.pull_request.head.sha }}" --strict \
            --report-json "$RUNNER_TEMP/mottlefin/report.json" \
            --report-md "$RUNNER_TEMP/mottlefin/report.md"
          echo "code=$?" >> "$GITHUB_OUTPUT"
      - if: always()
        run: cat "$RUNNER_TEMP/mottlefin/report.md" >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: mottlefin-evidence
          path: ${{ runner.temp }}/mottlefin/
      - if: always()
        run: exit ${{ steps.check.outputs.code }}
```

**Other CI systems.** The same pattern applies anywhere:

- GitLab merge requests: `--base "$CI_MERGE_REQUEST_DIFF_BASE_SHA"` and `--head "$CI_COMMIT_SHA"`. Fetch full history (`GIT_DEPTH: 0`).
- Any CI: fetch the base branch explicitly, then diff against it: `git fetch origin main`, then `--base origin/main`.

Whatever the system, keep the report step unconditional and exit with mottlefin's code last.

## Limitations of this version

- One check type: `forbid-pattern`. Rules that use another type report `unable_to_evaluate`.
- Checks are line-based regexes. A pattern cannot match across lines.
- No inline suppressions beyond `check.allow` patterns.
- Rules are read from the working tree, not from the commit being checked. In CI, check out the head so the rules match the PR. Each result's digest records what ran.
- No dashboard, no auto-fix, no AST-based checks.
