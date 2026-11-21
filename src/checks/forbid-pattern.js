const ALLOWED_KEYS = new Set(['type', 'pattern', 'flags', 'allow', 'scope', 'message'])
const MAX_EXCERPT = 200

function normalizeFlags(flags) {
  const set = new Set(String(flags ?? '').split(''))
  set.add('g')
  return [...set].sort().join('')
}

function compile(source, flags) {
  return new RegExp(source, normalizeFlags(flags))
}

function defaultMessage(config) {
  return typeof config.message === 'string' && config.message !== ''
    ? config.message
    : `Forbidden pattern ${config.pattern}`
}

export function validate(config) {
  const errors = []
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['check must be an object']
  }
  for (const key of Object.keys(config).sort()) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown check key "${key}"`)
  }
  let flagsOk = true
  if (config.flags !== undefined && config.flags !== null) {
    if (typeof config.flags !== 'string' || !/^[gimsu]*$/.test(config.flags)) {
      errors.push('check.flags must be a string containing only the characters i, m, s, u (g is added automatically)')
      flagsOk = false
    }
  }
  if (typeof config.pattern !== 'string' || config.pattern === '') {
    errors.push('check.pattern is required and must be a non-empty string')
  } else if (flagsOk) {
    try {
      compile(config.pattern, config.flags)
    } catch (e) {
      errors.push(`check.pattern is not a valid regular expression: ${e.message}`)
    }
  }
  if (config.allow !== undefined && config.allow !== null) {
    if (!Array.isArray(config.allow)) {
      errors.push('check.allow must be an array of regular expression strings')
    } else {
      config.allow.forEach((a, i) => {
        if (typeof a !== 'string' || a === '') {
          errors.push(`check.allow[${i}] must be a non-empty string`)
          return
        }
        try {
          new RegExp(a)
        } catch (e) {
          errors.push(`check.allow[${i}] is not a valid regular expression: ${e.message}`)
        }
      })
    }
  }
  if (config.message !== undefined && config.message !== null && typeof config.message !== 'string') {
    errors.push('check.message must be a string')
  }
  return errors
}

export function run({ path, text, config }) {
  const re = compile(config.pattern, config.flags)
  const allow = (config.allow ?? []).map((a) => new RegExp(a))
  const message = defaultMessage(config)
  const findings = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (allow.some((a) => a.test(line))) continue
    let excerpt = null
    for (const m of line.matchAll(re)) {
      if (m[0] === '') continue
      if (excerpt === null) {
        excerpt = line.trim()
        if (excerpt.length > MAX_EXCERPT) excerpt = excerpt.slice(0, MAX_EXCERPT)
      }
      findings.push({ line: i + 1, column: m.index + 1, match: m[0], excerpt, message })
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column)
  return findings
}

export default { validate, run }
