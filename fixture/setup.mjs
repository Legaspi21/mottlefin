import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const BUTTON_CSS = `.button {
  display: inline-flex;
  align-items: center;
  padding: var(--space-2) var(--space-4);
  color: var(--color-text);
  background: var(--color-surface);
  border-radius: var(--radius-md);
}

.button:hover {
  color: var(--color-text-hover);
}
`

const LEGACY_CSS = `.legacy-banner {
  color: #333333;
  background: var(--color-surface);
}
`

const TOKENS_CSS = `:root {
  --color-text: #1f2937;
  --color-text-hover: #111827;
  --color-surface: #ffffff;
  --color-border: #d1d5db;
}
`

const GUIDE_MD = `# Guide

Use design tokens for every color.
`

const ENV = {
  GIT_AUTHOR_NAME: 'Mottlefin Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Mottlefin Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

export function createFixtureRepo(dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`fixture dir is not empty: ${dir}`)
  mkdirSync(dir, { recursive: true })
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      env: { ...process.env, ...ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const put = (rel, content) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const commit = (msg) => {
    git('add', '-A')
    git('commit', '-q', '-m', msg)
    return git('rev-parse', 'HEAD')
  }

  git('init', '-q')
  put('src/components/Button.css', BUTTON_CSS)
  put('src/components/Legacy.css', LEGACY_CSS)
  put('src/tokens/colors.css', TOKENS_CSS)
  put('docs/guide.md', GUIDE_MD)
  put('.mottlefin/rules/color-no-raw-hex.json', readFileSync(path.join(here, 'rules', 'color-no-raw-hex.json'), 'utf8'))
  const base = commit('base')
  git('tag', 'base')

  const branch = (name, files, msg) => {
    git('checkout', '-q', '-b', name, 'base')
    for (const [rel, content] of Object.entries(files)) put(rel, content)
    const sha = commit(msg)
    return sha
  }
  const withLine = (line) => BUTTON_CSS.replace('  border-radius: var(--radius-md);\n', `  border-radius: var(--radius-md);\n${line}\n`)
  const relevantClean = branch('relevant-clean', { 'src/components/Button.css': withLine('  border: 1px solid var(--color-border);') }, 'relevant-clean')
  const unrelated = branch('unrelated', { 'docs/guide.md': GUIDE_MD + '\nTokens live in src/tokens.\n' }, 'unrelated')
  const regression = branch('regression', { 'src/components/Button.css': withLine('  background: #ff0000;') }, 'regression')

  git('checkout', '-q', 'main')
  return { dir, refs: { base, relevantClean, unrelated, regression } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node fixture/setup.mjs <dir>')
    process.exit(2)
  }
  try {
    const r = createFixtureRepo(path.resolve(dir))
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
}
