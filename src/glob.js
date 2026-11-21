// Glob matching for repo-relative POSIX paths.
//
// Syntax:
//   *        any run of non-"/" characters
//   ?        one non-"/" character
//   **/      zero or more whole directories
//   **       as the last segment (trailing): anything, including "/"
//   {a,b}    alternation, no nesting; alternatives may contain * and ?
//   other    literal
// Anchored at both ends, case-sensitive, no dotfile special-casing.
// A "**" that is not a whole segment behaves like a single "*".

const regexCache = new Map();

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(text) {
  return text.replace(REGEX_META, '\\$&');
}

// Translate a brace-free fragment to a regex body.
// leftBoundary: the fragment starts at a segment boundary (start of glob, after "/", or at an alternative start).
// rightBoundary: the fragment ends at the end of the glob or alternative.
function translateFragment(src, leftBoundary, rightBoundary) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') {
      let j = i;
      while (j < src.length && src[j] === '*') j++;
      const run = j - i;
      const atStart = i === 0 ? leftBoundary : src[i - 1] === '/';
      const atEnd = j === src.length && rightBoundary;
      if (run === 2 && atStart && src[j] === '/') {
        // "**/": zero or more whole directories
        out += '(?:[^/]+/)*';
        i = j + 1;
      } else if (run === 2 && atStart && atEnd) {
        // trailing "**": anything, including "/"
        out += '.*';
        i = j;
      } else {
        out += '[^/]*';
        i = j;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(c);
    }
    i++;
  }
  return out;
}

/**
 * Compile a glob to an anchored, case-sensitive RegExp.
 * Throws Error on an empty or non-string glob, unbalanced braces, or nested braces.
 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string') {
    throw new Error(`glob must be a string, got ${glob === null ? 'null' : typeof glob}`);
  }
  if (glob.length === 0) {
    throw new Error('glob must not be empty');
  }

  let body = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '}') {
      throw new Error(`glob has an unmatched "}" in ${JSON.stringify(glob)}`);
    }
    if (c === '{') {
      let end = -1;
      for (let k = i + 1; k < glob.length; k++) {
        if (glob[k] === '{') {
          throw new Error(`glob has nested "{" (nested braces are not supported) in ${JSON.stringify(glob)}`);
        }
        if (glob[k] === '}') {
          end = k;
          break;
        }
      }
      if (end < 0) {
        throw new Error(`glob has an unbalanced "{" (no closing "}") in ${JSON.stringify(glob)}`);
      }
      const alternatives = glob.slice(i + 1, end).split(',');
      body += '(?:' + alternatives.map((alt) => translateFragment(alt, true, true)).join('|') + ')';
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < glob.length && glob[j] !== '{' && glob[j] !== '}') j++;
    const leftBoundary = i === 0 || glob[i - 1] === '/';
    const rightBoundary = j === glob.length;
    body += translateFragment(glob.slice(i, j), leftBoundary, rightBoundary);
    i = j;
  }

  return new RegExp('^' + body + '$');
}

/**
 * True if path matches at least one glob. False for empty or missing globs.
 * Compiled RegExps are cached by glob string.
 */
export function matchesAny(path, globs) {
  if (!Array.isArray(globs) || globs.length === 0 || typeof path !== 'string') {
    return false;
  }
  for (const glob of globs) {
    let re = regexCache.get(glob);
    if (re === undefined) {
      re = globToRegExp(glob);
      regexCache.set(glob, re);
    }
    if (re.test(path)) return true;
  }
  return false;
}
