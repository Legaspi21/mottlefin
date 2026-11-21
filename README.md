# Mottlefin

Mottlefin checks UI changes against your design-system rules.

You write a rule once: what it checks and which files it applies to. On every change, Mottlefin reads the Git diff, runs only the rules that apply, and explains why each rule ran or was skipped. The result is an evidence report tied to the exact rule version and commit.

Mottlefin is deterministic and runs offline. It makes no model calls and has no npm dependencies.

```
FAILED  color/no-raw-hex@1.0.0  (sha256:b7ebd614…, error)
  Use color tokens, not raw hex values
  Why it ran: [changed-file-matches] src/components/Button.css changed and matches src/**/*.css.
  ✗ src/components/Button.css:8:15  #ff0000  Raw hex color. Use a design token, e.g. var(--color-danger).
      background: #ff0000;

Result: 0 passed, 1 failed, 0 skipped (inapplicable), 0 unable to evaluate, 0 coverage gaps
Blocking failures: color/no-raw-hex
```

## Requirements

- Node.js 20 or later
- `git` on your `PATH`

## Install

```sh
git clone https://github.com/legaspi21/mottlefin.git
cd mottlefin
npm link          # optional: puts `mottlefin` on your PATH
```

Without `npm link`, run `node /path/to/mottlefin/bin/mottlefin.js` wherever this README says `mottlefin`.

## Getting started

Run these steps from the root of the repository you want to check.

**1. Add a rule.** Rules are JSON files in `.mottlefin/rules/`. This rule bans raw hex colors in component CSS but allows them in the token definitions:

```sh
mkdir -p .mottlefin/rules
```

`.mottlefin/rules/color-no-raw-hex.json`:

```json
{
  "id": "color/no-raw-hex",
  "version": "1.0.0",
  "title": "Use color tokens, not raw hex values",
  "severity": "error",
  "appliesTo": {
    "paths": ["src/**/*.css"],
    "exclude": ["src/tokens/**"]
  },
  "check": {
    "type": "forbid-pattern",
    "pattern": "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b",
    "message": "Raw hex color. Use a design token, e.g. var(--color-danger)."
  }
}
```

**2. Validate it.**

```sh
mottlefin validate
```

**3. Run it.**

```sh
mottlefin run                            # last commit (HEAD~1..HEAD)
mottlefin run --worktree                 # your uncommitted changes
mottlefin run --base main --head HEAD    # a whole branch
mottlefin run --full                     # every rule over every file (audit)
```

Commit the `.mottlefin/rules/` directory, so that everyone and CI run the same rules.

## Results

Every rule gets exactly one status:

| status | meaning |
|---|---|
| `passed` | The check ran and found nothing. |
| `failed` | The check found a violation. |
| `skipped_inapplicable` | The change doesn't touch anything the rule covers. The report says why. |
| `unable_to_evaluate` | The rule should have run but couldn't, for example an invalid rule file, an unsupported check type, or an unreadable file. |

A result can also list **coverage gaps**: files the rule should have checked but couldn't, such as a binary file matching `*.css`. A gap is never reported as a pass.

**Only new problems fail a change.** In a normal diff run, a violation counts only if it is on a line the change added or modified. Existing violations elsewhere in a touched file are reported as pre-existing and do not fail the rule. Use `--full` to audit everything, or set `"scope": "file"` on a rule to always check whole files.

## Writing rules

| field | required | description |
|---|---|---|
| `id` | yes | Lowercase, `/`-separated, unique (`color/no-raw-hex`). |
| `version` | yes | `MAJOR.MINOR.PATCH`. Bump it when the rule's behavior changes. |
| `title` | yes | Shown in reports. |
| `description` | no | Longer explanation. |
| `severity` | no | `error` (default) blocks. `warn` is reported but never blocks. |
| `appliesTo.paths` | yes | Globs for the files the rule is about. |
| `appliesTo.exclude` | no | Globs to leave out. |
| `appliesTo.content` | no | A regex. A matching file is checked only if its contents match, e.g. only files that import your UI library. |
| `appliesTo.triggers` | no | Globs for files that, when changed, re-check *every* file the rule covers, e.g. your token definitions. |
| `check.type` | yes | `forbid-pattern` (the only type so far). |
| `check.pattern` | yes | A regex. Each match on a line is a violation. |
| `check.flags` | no | Regex flags from `imsu`. |
| `check.allow` | no | Regexes. Lines matching any of them are ignored, e.g. an inline `mottlefin-allow color/no-raw-hex` comment. |
| `check.scope` | no | `changed-lines` (default) or `file`. |
| `check.message` | no | Shown with each violation. |

Unknown fields are rejected, so typos don't silently disable a rule.

**Globs:**
- `*` matches within one directory.
- `**/` matches any number of directories.
- `?` matches one character.
- `{css,scss}` matches either alternative.

Paths are relative to the repo root.

**Versions and digests.** Each result records the rule's `version` and a `sha256` digest of the rule file. The version is the label people read. The digest proves exactly which rule content ran, even if someone edited the file without bumping the version.

## How Mottlefin decides what runs

For each rule, Mottlefin applies the first of these that is true:

1. **The rule file changed.** It re-checks every file the rule covers.
2. **A trigger file changed.** It re-checks every file the rule covers.
3. **A changed file matches the rule's paths.** It checks the changed files.
4. **Otherwise** the rule is skipped, with the reason. Possible reasons:
   - no changed file matches
   - only deleted files match
   - the content filter didn't match

When applicability can't be determined, Mottlefin runs anyway and says so. For example, a file can match the paths, but the content filter can't be applied because the file can't be read. If the base commit can't be found at all (a shallow clone, say), every rule runs, results are marked `uncertain`, and the report carries a `diff-unavailable` notice.

The report states every decision as a reason code. The JSON gives the exact codes.

## Command reference

```
mottlefin run [--base <ref>] [--head <ref>] [--worktree] [--full] [--strict]
              [--rules <dir>] [--repo <dir>]
              [--format text|json|markdown] [--report-json <file>] [--report-md <file>]
mottlefin validate [--rules <dir>] [--repo <dir>]
mottlefin --help | --version
```

| flag | default | description |
|---|---|---|
| `--base` | `HEAD~1` (`HEAD` with `--worktree`) | Compare from here. Mottlefin uses the merge base of `--base` and `--head`. |
| `--head` | `HEAD` | The commit to check. |
| `--worktree` | off | Check uncommitted changes, including untracked files, instead of a commit. |
| `--full` | off | Ignore the diff and run every rule over every file it covers. |
| `--strict` | off | Also fail on `unable_to_evaluate` results and coverage gaps. |
| `--rules` | `.mottlefin/rules` | Rules directory. |
| `--repo` | current directory | Repository to check. |
| `--format` | `text` | Output format on stdout. |
| `--report-json`, `--report-md` | none | Also write the report to a file. |

**Exit codes:**

| code | meaning |
|---|---|
| `0` | Nothing blocking. |
| `1` | A rule with `error` severity failed. With `--strict`, also any result that is unable to evaluate or any coverage gap. For `validate`, any invalid rule. |
| `2` | Usage or environment error: not a git repository, missing rules directory, unknown ref or flag. |

## Evidence reports

`--format json` or `--report-json <file>` writes a machine-readable report. It contains:

- **run**: mode, head and base `{ ref, sha }`, merge base, changed files, and notices.
- **summary**: count per status, plus coverage gaps.
- **results**: per rule, the id, version, digest and status. Each result also has the reasons it ran or was skipped, the files checked, violations (`file:line:column`, match, message), pre-existing violations, coverage gaps, and any error.

The same commit and the same rules always produce byte-identical JSON. The report contains no timestamps or machine-specific paths.

**Notices** flag anything that weakens the evidence:

| notice | meaning |
|---|---|
| `diff-unavailable` | The base couldn't be resolved, so every rule ran. |
| `merge-base-unavailable` | There is no common ancestor, so Mottlefin diffed against the base directly. |
| `worktree-dirty` | Results include uncommitted changes (`--worktree`). |
| `worktree-dirty-ignored` | There are uncommitted changes that were *not* checked. |
| `rules-differ-from-head` | The rule files on disk differ from the commit being checked. |

## CI

A complete GitHub Actions workflow is in [`examples/github-actions.yml`](examples/github-actions.yml). Copy it to `.github/workflows/mottlefin.yml` in the repo you want to check. It fetches Mottlefin from `legaspi21/mottlefin`; change that line to use a fork.

What it does, and what any CI setup needs:

1. **Full history.** Use `fetch-depth: 0`. The diff needs the base commit, and a shallow clone falls back to running every rule.
2. **Explicit commits.** Pass `--base ${{ github.event.pull_request.base.sha }}` and `--head ${{ github.event.pull_request.head.sha }}`. Also check out the head SHA, so the rules on disk are the PR's version.
3. **Reports that always post.** Write `--report-md` to `$GITHUB_STEP_SUMMARY`, and upload `--report-json` as an artifact. Run both steps with `if: always()`, and only then exit with Mottlefin's exit code.
4. **Strict mode, optionally.** `--strict` also blocks the PR on rules that couldn't be evaluated and on coverage gaps. Leave it off if only real violations should block.

On other CI systems the pattern is the same:
- **GitLab:** pass `--base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --head "$CI_COMMIT_SHA"` with `GIT_DEPTH: 0`.
- **Anywhere else:** run `git fetch origin main`, then `--base origin/main`.

## Limitations

- There is one check type, `forbid-pattern`: a line-by-line regex. A pattern can't span lines or understand code structure.
- Rules are read from the working tree, not from the commit being checked. In CI, check out the head commit. Locally, the `rules-differ-from-head` notice warns you when the two differ.
- There is no dashboard and no auto-fix.

## Development

```sh
npm test         # unit tests plus end-to-end CLI tests
npm run smoke    # end-to-end scenarios; writes reports to smoke-results/
```

The tests build a small Git repository with known commits (`fixture/setup.mjs`). They check three cases: a relevant change selects the rule, an unrelated change skips it, and a deliberate regression fails at the right line. `PLAN.md` holds the design, the internal interfaces and the acceptance criteria.
