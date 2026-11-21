// Rule loader: reads every *.json file under the rules dir (recursively), validates
// the v1 envelope strictly, and returns valid rules and invalid rule files, both sorted.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './glob.js';

const ID_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TOP_LEVEL_KEYS = ['schema', 'id', 'version', 'title', 'description', 'severity', 'appliesTo', 'check'];
const APPLIES_TO_KEYS = ['paths', 'exclude', 'content', 'triggers'];
const SEVERITIES = ['error', 'warn'];
const CHECK_SCOPES = ['changed-lines', 'file'];

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Recursively collect *.json files (absolute paths). Directory symlinks are not followed
// (avoids cycles); file symlinks are followed.
function collectJsonFiles(dirAbs, out) {
  const entries = readdirSync(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(abs, out);
    } else if (entry.name.endsWith('.json')) {
      if (entry.isFile()) {
        out.push(abs);
      } else if (entry.isSymbolicLink()) {
        let st = null;
        try {
          st = statSync(abs);
        } catch {
          st = null;
        }
        // A dangling symlink is still reported (as unreadable) rather than silently dropped.
        if (st === null || st.isFile()) out.push(abs);
      }
    }
  }
  return out;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function validateGlobArray(value, field, errors, { required }) {
  if (value === undefined) {
    if (required) errors.push(`appliesTo.${field} is required (a non-empty array of globs)`);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`appliesTo.${field} must be an array of globs, got ${describe(value)}`);
    return;
  }
  if (required && value.length === 0) {
    errors.push(`appliesTo.${field} must be a non-empty array of globs`);
    return;
  }
  value.forEach((glob, i) => {
    if (typeof glob !== 'string') {
      errors.push(`appliesTo.${field}[${i}] must be a string, got ${describe(glob)}`);
      return;
    }
    try {
      globToRegExp(glob);
    } catch (err) {
      errors.push(`appliesTo.${field}[${i}] is not a valid glob: ${err.message}`);
    }
  });
}

// Returns { errors, rule } where rule is the normalized partial rule (only meaningful when errors is empty).
function validateEnvelope(data) {
  const errors = [];
  if (!isPlainObject(data)) {
    errors.push(`rule must be a JSON object, got ${describe(data)}`);
    return { errors, rule: null };
  }

  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`unknown top-level key "${key}"`);
  }

  if (data.schema !== undefined && data.schema !== 1) {
    errors.push(`schema must be 1 if present, got ${JSON.stringify(data.schema)}`);
  }

  if (data.id === undefined) {
    errors.push('id is required');
  } else if (typeof data.id !== 'string') {
    errors.push(`id must be a string, got ${describe(data.id)}`);
  } else if (!ID_RE.test(data.id)) {
    errors.push(`id ${JSON.stringify(data.id)} must match ${ID_RE.source}`);
  }

  if (data.version === undefined) {
    errors.push('version is required');
  } else if (typeof data.version !== 'string' || !VERSION_RE.test(data.version)) {
    errors.push(`version must be a string like "1.0.0" (MAJOR.MINOR.PATCH), got ${JSON.stringify(data.version)}`);
  }

  if (data.title === undefined) {
    errors.push('title is required');
  } else if (typeof data.title !== 'string' || data.title.trim() === '') {
    errors.push('title must be a non-empty string');
  }

  if (data.description !== undefined && typeof data.description !== 'string') {
    errors.push(`description must be a string, got ${describe(data.description)}`);
  }

  if (data.severity !== undefined && !SEVERITIES.includes(data.severity)) {
    errors.push(`severity must be "error" or "warn", got ${JSON.stringify(data.severity)}`);
  }

  const appliesTo = data.appliesTo;
  if (appliesTo === undefined) {
    errors.push('appliesTo is required');
  } else if (!isPlainObject(appliesTo)) {
    errors.push(`appliesTo must be an object, got ${describe(appliesTo)}`);
  } else {
    for (const key of Object.keys(appliesTo)) {
      if (!APPLIES_TO_KEYS.includes(key)) errors.push(`unknown appliesTo key "${key}"`);
    }
    validateGlobArray(appliesTo.paths, 'paths', errors, { required: true });
    validateGlobArray(appliesTo.exclude, 'exclude', errors, { required: false });
    validateGlobArray(appliesTo.triggers, 'triggers', errors, { required: false });
    const content = appliesTo.content;
    if (content !== undefined && content !== null) {
      if (typeof content !== 'string') {
        errors.push(`appliesTo.content must be a regex source string or null, got ${describe(content)}`);
      } else {
        try {
          new RegExp(content);
        } catch (err) {
          errors.push(`appliesTo.content is not a valid regex: ${err.message}`);
        }
      }
    }
  }

  const check = data.check;
  if (check === undefined) {
    errors.push('check is required');
  } else if (!isPlainObject(check)) {
    errors.push(`check must be an object, got ${describe(check)}`);
  } else {
    if (typeof check.type !== 'string' || check.type === '') {
      errors.push('check.type must be a non-empty string');
    }
    if (check.scope !== undefined && !CHECK_SCOPES.includes(check.scope)) {
      errors.push(`check.scope must be "changed-lines" or "file", got ${JSON.stringify(check.scope)}`);
    }
  }

  if (errors.length > 0) return { errors, rule: null };

  return {
    errors,
    rule: {
      id: data.id,
      version: data.version,
      title: data.title,
      description: data.description ?? '',
      severity: data.severity ?? 'error',
      appliesTo: {
        paths: [...appliesTo.paths],
        exclude: [...(appliesTo.exclude ?? [])],
        content: appliesTo.content ?? null,
        triggers: [...(appliesTo.triggers ?? [])],
      },
      check: { ...check, scope: check.scope ?? 'changed-lines' },
    },
  };
}

function byIdThenFile(a, b) {
  return compare(a.id, b.id) || compare(a.file, b.file);
}

/**
 * Load and validate every rule file under rulesDirAbs.
 * Throws only if the rules dir does not exist or is not a directory.
 * @returns {{ rules: object[], invalid: object[] }} both sorted by id (tie-break: file)
 */
export function loadRules(rulesDirAbs, { repoRoot }) {
  let st;
  try {
    st = statSync(rulesDirAbs);
  } catch (err) {
    throw new Error(`rules dir does not exist: ${rulesDirAbs} (${err.code ?? err.message})`);
  }
  if (!st.isDirectory()) {
    throw new Error(`rules dir is not a directory: ${rulesDirAbs}`);
  }

  const files = collectJsonFiles(rulesDirAbs, [])
    .map((abs) => ({ abs, file: toPosix(path.relative(repoRoot, abs)) }))
    .sort((a, b) => compare(a.file, b.file));

  const rules = [];
  const invalid = [];
  const firstFileForId = new Map();

  for (const { abs, file } of files) {
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch (err) {
      invalid.push({ id: file, file, digest: null, errors: [`cannot read rule file: ${err.code ?? err.message}`] });
      continue;
    }
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');

    let data;
    try {
      let text = bytes.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      data = JSON.parse(text);
    } catch (err) {
      invalid.push({ id: file, file, digest, errors: [`invalid JSON: ${err.message}`] });
      continue;
    }

    const { errors, rule } = validateEnvelope(data);
    const declaredId = isPlainObject(data) && typeof data.id === 'string' ? data.id : null;

    // Duplicate detection: any earlier file declaring a well-formed id claims it, even if
    // that earlier file is invalid for other reasons.
    if (declaredId !== null && ID_RE.test(declaredId)) {
      const first = firstFileForId.get(declaredId);
      if (first !== undefined) {
        errors.push(`duplicate id "${declaredId}": already defined in ${first}`);
      } else {
        firstFileForId.set(declaredId, file);
      }
    }

    if (errors.length > 0) {
      invalid.push({ id: declaredId ?? file, file, digest, errors });
    } else {
      rules.push({ ...rule, file, digest });
    }
  }

  rules.sort(byIdThenFile);
  invalid.sort(byIdThenFile);
  return { rules, invalid };
}
