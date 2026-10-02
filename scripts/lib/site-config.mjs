/* Cabrillo Coast LLC — Jekyll site-configuration rules (Node built-ins only) */
/**
 * The single definition of the site-configuration rules: the settings in the
 * Jekyll configuration file that would keep a tracked post off the site while
 * the public repository still shows it. That is the outcome the
 * tracked-content rules in `./articles.mjs` refuse for committed drafts,
 * `published: false` and future-dated posts, reached here through Jekyll's
 * own settings instead of the articles.
 *
 * `scripts/article.mjs` (`guard --staged`, `guard --pre-push`) and
 * `tests/static/blog-content.test.mjs` (AC-01) import `checkSiteConfig`, so
 * commit time, push time and test time apply identical checks. AC-01 also
 * reads `_config.yml` and `_config.preview.yml` with `readJekyllConfig` for
 * its own publishing-configuration checks.
 *
 * The rules apply only to the file Jekyll 3.10 reads by default
 * (`siteConfigFile`), the one GitHub Pages builds with. An overlay such as
 * `_config.preview.yml` is read only when a command line names it, so it
 * never decides what the live site holds.
 *
 * The configuration is read by `readJekyllConfig`, which fails closed: a
 * construct it cannot read for certain is refused, never guessed, so no
 * setting can hide from the rules behind YAML the reader does not follow.
 *
 * The module performs no I/O and has no side effects at import: callers read
 * the file and the tree and pass their text and paths in.
 */

/* ------------------------------------------------------------------------ */
/* Typed, fail-closed YAML reader for the Jekyll configuration files         */
/* ------------------------------------------------------------------------ */

/**
 * Plain scalars that SafeYAML 1.0.5, which Jekyll 3.10 loads its
 * configuration with, reads as numbers, dates or times instead of text: its
 * integer, float, date and time patterns.
 */
const YAML_TYPED_PLAIN_RES = Object.freeze([
  /^[-+]?(?:0|[1-9][0-9_,]*)$/,
  /^0[0-7_]+$/,
  /^[-+]?0x[0-9a-fA-F_]+$/,
  /^0b[01_]+$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,
  /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]+(?:[eE][-+][0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/,
  /^\d{4}-\d{1,2}-\d{1,2}(?:(?:[Tt]| +)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?: *(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)?$/,
]);

/**
 * The key forms the reader accepts, each with its normalization: plain
 * (`baseurl`), double-quoted (`"baseurl"`, escapes `\"` and `\\` only) and
 * single-quoted (`'baseurl'`, `''` for a quote). Spaces may stand before the
 * `:`, and a space or the end of the line must follow it.
 */
const YAML_KEY_FORMS = Object.freeze([
  [/^([A-Za-z0-9_][A-Za-z0-9_./-]*) *:(?= |$)/, (m) => m[1]],
  [/^"((?:[^"\\]|\\["\\])*)" *:(?= |$)/, (m) => m[1].replace(/\\(["\\])/g, '$1')],
  [/^'((?:[^']|'')*)' *:(?= |$)/, (m) => m[1].replace(/''/g, "'")],
]);

/** What may follow a closing quote or bracket: nothing, or a ` # comment`. */
const YAML_TRAILER_RE = /^(?: *| +#.*)$/;

/** The value of an entry whose value could not be read; the reason is in `unsupported`. */
const YAML_UNREADABLE = Object.freeze({ kind: 'other', value: null, quoted: false });

/**
 * Reads the quoted scalar that starts at `text[start]` and closes on the same
 * line: double-quoted with the escapes `\"` and `\\` only, or single-quoted
 * with `''` for a quote. Returns `{ value, end }` (the index after the
 * closing quote) or `{ error }`.
 */
function readYamlQuoted(text, start) {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        value += "'";
        i += 1;
        continue;
      }
      return { value, end: i + 1 };
    }
    if (quote === '"' && c === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next !== '"' && next !== '\\') return { error: `the escape \\${next} is not supported in a double-quoted string` };
      value += next;
      i += 1;
      continue;
    }
    value += c;
  }
  return { error: `a ${quote === '"' ? 'double' : 'single'}-quoted string must close on the same line` };
}

/**
 * The value SafeYAML 1.0.5 makes of the plain (unquoted) scalar `text`:
 * `''`, `~` and `null` in any letter case are null; `yes`, `on`, `true`,
 * `no`, `off` and `false` in any letter case are booleans; numbers, dates
 * and times are `other`; everything else is a string.
 */
function plainYamlValue(text) {
  if (text === '' || /^(?:~|null)$/i.test(text)) return { kind: 'null', value: null, quoted: false };
  if (/^(?:yes|no|on|off|true|false)$/i.test(text)) return { kind: 'bool', value: /^(?:yes|on|true)$/i.test(text), quoted: false };
  if (YAML_TYPED_PLAIN_RES.some((re) => re.test(text))) return { kind: 'other', value: text, quoted: false };
  return { kind: 'string', value: text, quoted: false };
}

/** Why the plain scalar `text` cannot be read here, or `null`; `inFlow` adds the flow-list rules. */
function plainYamlProblem(text, inFlow) {
  if (/^[&*]/.test(text)) return 'anchors and aliases (& and *) are not supported';
  if (text.startsWith('!')) return 'YAML tags (!) are not supported';
  if (/^[|>]/.test(text)) return 'block scalars (| and >) are not supported';
  if (text.startsWith('{')) return 'flow mappings ({ … }) are not supported';
  if (/^[%@`,\]}]/.test(text)) return `a plain value must not start with ${text[0]}`;
  if (/^[-?:](?: |$)/.test(text)) return `${text[0]} followed by a space cannot start a value here`;
  if (/: |:$/.test(text)) return 'a plain value must not contain ": " or end with ":"';
  if (inFlow && /[[{}]/.test(text)) return 'nested lists and mappings are not supported in a flow list';
  return null;
}

/**
 * Reads the one-line flow list that starts at `text[0]`, such as
 * `[a, "b, c"]`: quoted items keep their commas, plain items are typed by
 * `plainYamlValue`, and empty items, a trailing comma, comments, nesting and
 * an unclosed list are errors. Returns `{ value, end }` or `{ error }`.
 */
function readYamlFlowList(text) {
  const items = [];
  let i = 1;
  const skipSpaces = () => {
    while (text[i] === ' ') i += 1;
  };
  skipSpaces();
  if (text[i] === ']') return { value: { kind: 'list', items }, end: i + 1 };
  for (;;) {
    skipSpaces();
    const c = text[i];
    if (c === undefined) return { error: 'a flow list must close with ] on the same line' };
    if (c === ',' || c === ']') return { error: 'a flow list must not contain empty items' };
    if (c === '"' || c === "'") {
      const quoted = readYamlQuoted(text, i);
      if (quoted.error) return quoted;
      items.push({ kind: 'string', value: quoted.value, quoted: true });
      i = quoted.end;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ',' && text[end] !== ']') end += 1;
      const raw = text.slice(i, end).replace(/ +$/, '');
      if (raw.startsWith('#') || raw.includes(' #')) return { error: 'a comment is not allowed inside a flow list' };
      const problem = plainYamlProblem(raw, true);
      if (problem !== null) return { error: problem };
      items.push(plainYamlValue(raw));
      i = end;
    }
    skipSpaces();
    if (text[i] === ',') {
      i += 1;
      skipSpaces();
      if (text[i] === ']') return { error: 'a flow list must not end with a comma' };
      continue;
    }
    if (text[i] === ']') return { value: { kind: 'list', items }, end: i + 1 };
    if (text[i] === undefined) return { error: 'a flow list must close with ] on the same line' };
    return { error: `unexpected ${JSON.stringify(text[i])} after a flow list item` };
  }
}

/**
 * Reads what follows `key:` or `- ` on one line: `{ empty: true }` when
 * nothing does (the node is null, or continues on the lines below), `{ value }`
 * for a quoted or plain scalar or a one-line flow list, and `{ error }` for
 * every other construct.
 */
function readYamlValue(rest) {
  const text = rest.replace(/^ +/, '');
  if (text === '' || text.startsWith('#')) return { empty: true };
  if (text[0] === '"' || text[0] === "'") {
    const quoted = readYamlQuoted(text, 0);
    if (quoted.error) return quoted;
    if (!YAML_TRAILER_RE.test(text.slice(quoted.end))) return { error: 'only a comment ( # …) may follow the closing quote' };
    return { value: { kind: 'string', value: quoted.value, quoted: true } };
  }
  if (text[0] === '[') {
    const list = readYamlFlowList(text);
    if (list.error) return list;
    if (!YAML_TRAILER_RE.test(text.slice(list.end))) return { error: 'only a comment ( # …) may follow the closing ]' };
    return { value: list.value };
  }
  const plain = text.replace(/ +#.*$/, '').replace(/ +$/, '');
  const problem = plainYamlProblem(plain, false);
  return problem === null ? { value: plainYamlValue(plain) } : { error: problem };
}

/** The key at the start of a line body, normalized (`YAML_KEY_FORMS`), and the text after its `:`; `null` when the line has no key. */
function readYamlKey(body) {
  for (const [form, normalize] of YAML_KEY_FORMS) {
    const m = form.exec(body);
    if (m !== null) return { key: normalize(m), rest: body.slice(m[0].length) };
  }
  return null;
}

/** Whether a line body is a block-list item: `-` followed by a space or the end of the line. */
function isYamlItem(body) {
  return /^-(?: |$)/.test(body);
}

/**
 * Reads a Jekyll configuration file with the types SafeYAML 1.0.5 gives it,
 * without a YAML library, and fails closed: whatever it cannot read for
 * certain is listed in `unsupported` instead of guessed.
 *
 * The whole document is parsed as block YAML, nested levels included, so a
 * line that SafeYAML would reject cannot hide below a key the checks never
 * read. Understood: blank and `#` comment lines; a first-line `---`; block
 * mappings whose keys are plain or quoted (normalized, so `"baseurl"` and
 * `baseurl :` both define `baseurl`) and line up at one indentation; block
 * lists whose `- ` items line up at one indentation, a list directly below a
 * key at the key's own indentation included; compact nodes on an item's line
 * (`- scope:`, `- - x`), which start at their own column; scalar values,
 * quoted (always strings) or plain (typed by `plainYamlValue`), with an
 * optional ` # comment`; and one-line flow lists.
 *
 * Refused, with the line number: any other column-0 construct (`? `, `<<`,
 * `---` or `...` after content, `%` directives); tabs; anchors and aliases;
 * tags; block scalars; flow mappings; plain values containing `: ` or ending
 * in `:`; unclosed quotes or lists; anything but a ` # comment` after a
 * closing quote or bracket; escapes other than `\"` and `\\`; at any depth, a
 * mapping line without a key, a line continuing a value already written on
 * the line above, and a line that lines up with neither its siblings nor the
 * level it closes.
 *
 * @param {string} text File contents.
 * @returns {{
 *   keys: string[],
 *   entries: Array<{ key: string, line: number, value: object }>,
 *   duplicates: string[],
 *   unsupported: string[],
 *   has(key: string): boolean,
 *   get(key: string): { kind: 'null' | 'bool' | 'string' | 'list' | 'mapping' | 'other', value?: unknown, quoted?: boolean, items?: object[], entries?: object[] } | undefined,
 * }} `keys` are the top-level keys in file order, and `entries` every
 *   top-level `{ key, line, value }` in file order, a key written twice
 *   included; a key written twice is in `duplicates`, and `get` returns its
 *   last value, the one Ruby's YAML parser keeps. A list's `items` and a
 *   mapping's `entries` (`{ key, line, value }`) hold values of the same shape.
 */
export function readJekyllConfig(text) {
  const unsupported = [];
  const fail = (n, why) => unsupported.push(`line ${n}: ${why}`);

  // Content lines as { n, indent, body }: blank and comment lines, refused markers and lines with tabs are left out.
  const lines = [];
  let content = false;
  text.replace(/^\uFEFF/, '').split('\n').forEach((raw, index) => {
    const n = index + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (/^[ \t]*(?:#.*)?$/.test(line)) return;
    if (line.includes('\t')) {
      fail(n, 'tabs are not supported');
      return;
    }
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    if (indent === 0 && /^(?:---|\.\.\.)(?: |$)/.test(body)) {
      if (!content && /^---(?: +#.*)?$/.test(body)) {
        content = true;
        return;
      }
      fail(n, `the document marker ${body.slice(0, 3)} is supported only as the first line, alone`);
      return;
    }
    if (indent === 0 && body.startsWith('%')) {
      fail(n, 'YAML directives (%) are not supported');
      return;
    }
    content = true;
    lines.push({ n, indent, body });
  });

  let pos = 0;
  const NULL_VALUE = Object.freeze({ kind: 'null', value: null, quoted: false });

  /** Passes over the lines indented deeper than `indent`, which belong to a node already refused. */
  const skipDeeper = (indent) => {
    while (pos < lines.length && lines[pos].indent > indent) pos += 1;
  };

  /** Refuses `lines[pos]`, indented deeper than the level `indent` it stands in, and passes over it. */
  const misaligned = (indent) => {
    fail(lines[pos].n, `this line is indented ${lines[pos].indent} spaces, deeper than the ${indent} its mapping or list uses`);
    pos += 1;
  };

  const readNode = () => (isYamlItem(lines[pos].body) ? readList(lines[pos].indent) : readMapping(lines[pos].indent));

  /**
   * The value of the key (`keyed`) or item on line `line` at `indent`, whose
   * text after `:` or `- ` is `rest`: that inline value, which no deeper line
   * may continue, or, when the line ends there, the node on the deeper lines
   * below (a list may also sit at a key's own indentation), or null.
   */
  const readValue = (line, rest, indent, keyed) => {
    const value = readYamlValue(rest);
    if (value.error) {
      fail(line.n, value.error);
      skipDeeper(indent);
      return YAML_UNREADABLE;
    }
    const next = lines[pos];
    if (!value.empty) {
      if (next === undefined || next.indent <= indent) return value.value;
      fail(next.n, `the value written on line ${line.n} cannot continue onto another line`);
      skipDeeper(indent);
      return YAML_UNREADABLE;
    }
    if (next !== undefined && next.indent > indent) return readNode();
    if (keyed && next !== undefined && next.indent === indent && isYamlItem(next.body)) return readList(indent);
    return NULL_VALUE;
  };

  /** The block mapping whose keys stand at `indent`, from `lines[pos]` to the first line that ends it. */
  function readMapping(indent) {
    const entries = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const line = lines[pos];
      if (line.indent > indent) {
        misaligned(indent);
        continue;
      }
      if (isYamlItem(line.body)) break;
      const key = readYamlKey(line.body);
      pos += 1;
      if (key === null) {
        fail(line.n, 'a line of a mapping must be key: value');
        skipDeeper(indent);
        continue;
      }
      entries.push({ key: key.key, line: line.n, value: readValue(line, key.rest, indent, true) });
    }
    return { kind: 'mapping', entries };
  }

  /** The block list whose `- ` items stand at `indent`, from `lines[pos]` to the first line that ends it. */
  function readList(indent) {
    const items = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const line = lines[pos];
      if (line.indent > indent) {
        misaligned(indent);
        continue;
      }
      if (!isYamlItem(line.body)) break;
      const rest = line.body.replace(/^-(?: +|$)/, '');
      if (isYamlItem(rest) || readYamlKey(rest) !== null) {
        // A compact node on the item's line starts at its own column, where its later lines must line up.
        lines[pos] = { n: line.n, indent: indent + line.body.length - rest.length, body: rest };
        items.push(readNode());
        continue;
      }
      pos += 1;
      items.push(readValue(line, rest, indent, false));
    }
    return { kind: 'list', items };
  }

  const entries = [];
  while (pos < lines.length) {
    entries.push(...readMapping(0).entries);
    if (pos < lines.length) {
      // readMapping(0) stops only at a column-0 list item, which no top-level key owns.
      fail(lines[pos].n, 'a top-level line must be key: value');
      pos += 1;
      skipDeeper(0);
    }
  }

  const keys = entries.map((entry) => entry.key);
  const duplicates = [...new Set(keys.filter((k, index) => keys.indexOf(k) !== index))];
  const last = (k) => entries.findLast((entry) => entry.key === k);
  return {
    keys,
    entries,
    duplicates,
    unsupported,
    has: (k) => last(k) !== undefined,
    get: (k) => last(k)?.value,
  };
}

/** A typed value from `readJekyllConfig`, described for a failure message. */
export function describeYamlValue(value) {
  if (value === undefined) return 'no such key';
  if (value.kind === 'null') return 'null';
  if (value.kind === 'bool') return `boolean ${value.value}`;
  if (value.kind === 'string') return `${value.quoted ? 'quoted ' : ''}string ${JSON.stringify(value.value)}`;
  if (value.kind === 'list') return `a list of ${value.items.length}`;
  if (value.kind === 'mapping') return 'a mapping';
  return value.value === null ? 'a value this reader cannot read' : `the non-string value ${value.value}`;
}

/* ------------------------------------------------------------------------ */
/* The file Jekyll reads                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The configuration files Jekyll 3.10 looks for in the source folder when no
 * `--config` is given, in its order of preference.
 * @type {readonly string[]}
 */
export const SITE_CONFIG_FILES = Object.freeze(['_config.yml', '_config.yaml']);

/** Throws unless `paths` is an array of strings. */
function assertPaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array of strings');
  for (const p of paths) if (typeof p !== 'string') throw new TypeError('paths must contain strings');
}

/**
 * The configuration file Jekyll 3.10 reads for a tree, as
 * `Configuration#config_files` chooses it without `--config`: `_config.yml`
 * when that name exists in the source folder, otherwise `_config.yaml` when
 * it exists. Jekyll tests the name with `File.exist?`, which a folder also
 * passes, so `_config.yml` is chosen when it is the folder of a tracked path
 * too: Jekyll then reads no configuration at all, never `_config.yaml`, and
 * the caller must refuse a configuration that is not a regular file.
 *
 * @param {string[]} paths The complete tree as repository-relative POSIX paths.
 * @returns {string | null} `_config.yml`, `_config.yaml`, or `null` when the tree has neither.
 */
export function siteConfigFile(paths) {
  assertPaths(paths);
  const present = (name) => paths.some((p) => p === name || p.startsWith(`${name}/`));
  return SITE_CONFIG_FILES.find(present) ?? null;
}

/* ------------------------------------------------------------------------ */
/* Exclude matching (Jekyll 3.10 EntryFilter)                                */
/* ------------------------------------------------------------------------ */

/**
 * Reads the bracket expression whose `[` stands just before `p[start]`, as
 * Ruby's `dir.c` `bracket()` does with escapes on and no case folding. A
 * leading `!` or `^` negates the set; `a-z` is a range by code point, and its
 * two endpoints match even when reversed (`[9-0]` matches `9` and `0` only);
 * a `-` before the closing `]` is literal; `\` makes the next character
 * literal. A `]` right after the opening (or after the negation) closes an
 * empty set, so `[]` matches nothing and `[!]` matches any character.
 *
 * @param {string[]} p The pattern's code points.
 * @param {number} start The index after the `[`.
 * @returns {{ end: number, matches(c: string): boolean } | null} `end` is the index after the
 *   closing `]`; `null` when no `]` closes the bracket, which then matches nothing at its position.
 */
function readBracket(p, start) {
  let i = start;
  if (i >= p.length) return null;
  const negated = p[i] === '!' || p[i] === '^';
  if (negated) i += 1;
  const ranges = [];
  while (p[i] !== ']') {
    let first = i;
    if (p[first] === '\\') first += 1;
    if (first >= p.length) return null;
    i = first + 1;
    if (i >= p.length) return null;
    let last = first;
    if (p[i] === '-' && p[i + 1] !== ']') {
      last = i + 1;
      if (p[last] === '\\') last += 1;
      if (last >= p.length) return null;
      i = last + 1;
    }
    ranges.push([p[first], p[last]]);
  }
  return {
    end: i + 1,
    matches(c) {
      const code = c.codePointAt(0);
      const inSet = ranges.some(([low, high]) => c === low || c === high
        || (low.codePointAt(0) <= code && code <= high.codePointAt(0)));
      return inSet !== negated;
    },
  };
}

/**
 * Ruby's `File.fnmatch?(pattern, string)` with no flags, the call Jekyll's
 * exclude matching makes, ported from `dir.c` `fnmatch_helper()`: `*`
 * matches any run of characters and `?` any one character, `/` included
 * (there is no `FNM_PATHNAME`); `[…]` is read by `readBracket`; `\` makes the
 * next character literal, and a trailing `\` is dropped. Matching is
 * case-sensitive and by Unicode code point. On a mismatch the search resumes
 * one character further along from the last `*`, as `dir.c` does, which
 * finds every match a full backtracking search would.
 *
 * Ruby's leading-period rule is left out: Jekyll matches absolute paths,
 * which never start with a period, and `excludeEntryMatches` passes the
 * equivalent relative forms.
 *
 * @param {string} pattern
 * @param {string} string
 * @returns {boolean}
 */
function rubyFnmatch(pattern, string) {
  const p = Array.from(pattern);
  const s = Array.from(string);
  let pi = 0;
  let si = 0;
  // Where to resume after the last `*`: the pattern after it, and the string position it covered up to.
  let starP = -1;
  let starS = -1;
  for (;;) {
    const c = p[pi];
    if (c === '*') {
      while (p[pi] === '*') pi += 1;
      if ((p[pi] === '\\' ? pi + 1 : pi) >= p.length) return true;
      if (si >= s.length) return false;
      starP = pi;
      starS = si;
      continue;
    }
    if (c === '?') {
      if (si >= s.length) return false;
      pi += 1;
      si += 1;
      continue;
    }
    if (c === '[') {
      if (si >= s.length) return false;
      const set = readBracket(p, pi + 1);
      if (set !== null && set.matches(s[si])) {
        pi = set.end;
        si += 1;
        continue;
      }
    } else {
      const literal = c === '\\' ? pi + 1 : pi;
      if (si >= s.length) return literal >= p.length;
      if (literal < p.length && p[literal] === s[si]) {
        pi = literal + 1;
        si += 1;
        continue;
      }
    }
    if (starP === -1) return false;
    starS += 1;
    pi = starP;
    si = starS;
  }
}

/**
 * Whether the `exclude` entry `entry` makes Jekyll 3.10 leave out the file
 * at `relPath`, as `EntryFilter#glob_include?` decides for a string entry.
 * Jekyll joins both to the source folder, `File.join(source, entry)` dropping
 * one leading `/` of the entry, and excludes the file when the joined entry
 * is a prefix of the file's path or matches it as an `fnmatch` pattern
 * (`rubyFnmatch`). This is the same test on the relative forms. Jekyll does
 * not normalize the entry, so `./_posts` and `//_posts` exclude nothing,
 * while `""` and `/` exclude every file and `_p` every file in `_posts/`.
 *
 * @param {string} entry One `exclude` entry, as written.
 * @param {string} relPath A file path relative to the source folder, such as `_posts/2026-01-01-x.md`.
 * @returns {boolean}
 */
export function excludeEntryMatches(entry, relPath) {
  if (typeof entry !== 'string') throw new TypeError(`entry must be a string, got ${typeof entry}`);
  if (typeof relPath !== 'string') throw new TypeError(`relPath must be a string, got ${typeof relPath}`);
  const pattern = entry.startsWith('/') ? entry.slice(1) : entry;
  return relPath.startsWith(pattern) || rubyFnmatch(pattern, relPath);
}

/* ------------------------------------------------------------------------ */
/* The rules                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The `defaults` values that decide whether and where a post is published,
 * each with what it does to the posts in its scope. Jekyll merges a
 * default's `values` into the front matter of every post its `scope`
 * selects, and the article schema refuses these keys in front matter itself.
 */
const HIDING_DEFAULTS = new Map([
  ['published', 'published: false keeps them off the site'],
  ['date', 'it replaces their filename dates, and one after the build keeps them off the site as future posts'],
  ['permalink', 'one URL for several posts makes them overwrite one another, so all but one vanish from the site'],
  ['slug', 'one slug for several posts gives them one URL, so all but one vanish from the site'],
]);

/**
 * The one `permalink` the site uses: every article at `/blog/<slug>/`. Any
 * other template is refused, because a template that merely holds `:title`
 * can still give every post one URL: Jekyll percent-decodes the URL and
 * normalizes `..` only when it writes the file, so `/blog/:title/%2e%2e/`
 * writes every post to `/blog/index.html`.
 */
const SITE_PERMALINK = '/blog/:title/';

/** The zone guard reads filename dates in when it refuses future-dated posts. */
const GUARD_TIMEZONE = 'Etc/UTC';

/**
 * `defaults` (see `HIDING_DEFAULTS`): every `values` mapping of every list
 * item is checked, in any scope, since a scope can name any post. A
 * `defaults` that is not a list, or an item or `values` that is not a
 * mapping, sets nothing Jekyll applies.
 */
function defaultsProblems({ value }) {
  const problems = [];
  if (value.kind !== 'list') return problems;
  for (const item of value.items) {
    if (item.kind !== 'mapping') continue;
    for (const field of item.entries) {
      if (field.key !== 'values' || field.value.kind !== 'mapping') continue;
      for (const setting of field.value.entries) {
        const effect = HIDING_DEFAULTS.get(setting.key);
        if (effect === undefined) continue;
        problems.push(`line ${setting.line}: defaults set ${setting.key} for the posts in their scope: ${effect} `
          + `while GitHub still shows them; remove ${setting.key} from the defaults values`);
      }
    }
  }
  return problems;
}

/**
 * `exclude`: Jekyll leaves out every file an entry matches
 * (`excludeEntryMatches`), posts included. Each entry is judged against every
 * tracked file in `_posts/`. `include` can bring an excluded file back, but
 * it is not consulted, so an entry that could hide a post is refused even
 * when `include` would restore it (fail closed). Jekyll splits a string at
 * commas and turns every other item into text, a null item into `""`, which
 * excludes every file, so only a list of strings is read.
 */
function excludeProblems({ line, value }, posts) {
  if (value.kind !== 'list') {
    return [`line ${line}: exclude must be a list of strings (got ${describeYamlValue(value)}), or guard cannot `
      + 'tell which posts it keeps off the site; write it as a list of strings'];
  }
  const problems = [];
  value.items.forEach((item, index) => {
    if (item.kind !== 'string') {
      problems.push(`line ${line}: exclude item ${index + 1} must be a string (got ${describeYamlValue(item)}); Jekyll `
        + 'turns it into text (null into "", which excludes every file), so quote the entry');
      return;
    }
    const hidden = posts.find((post) => excludeEntryMatches(item.value, post));
    if (hidden === undefined) return;
    problems.push(`line ${line}: exclude entry ${JSON.stringify(item.value)} keeps ${hidden} off the site while GitHub `
      + 'still shows it; remove the entry or narrow it so it matches no file in _posts/');
  });
  return problems;
}

/** `limit_posts`: Jekyll builds only the newest posts, so the rest stay off the site. Refused at any value. */
function limitPostsProblems({ line }) {
  return [`line ${line}: limit_posts must not be set; Jekyll then builds only the newest posts and leaves the rest off `
    + 'the site while GitHub still shows them; remove it'];
}

/** `collections_dir`: Jekyll reads posts from `<collections_dir>/_posts/` instead, so no post in `_posts/` is built. */
function collectionsDirProblems({ line }) {
  return [`line ${line}: collections_dir must not be set; Jekyll then reads posts from that folder instead of _posts/, `
    + 'and every post in _posts/ stays off the site while GitHub still shows it; remove it'];
}

/**
 * `collections`: a `posts` collection configured here merges into Jekyll's
 * own, so its `permalink` can give every post one URL (all but one vanish)
 * and `output: false` builds none. A list names collections without
 * settings; `posts` is refused there too. Other collections are left alone.
 */
function collectionsProblems({ line, value }) {
  const configured = (value.kind === 'mapping' && value.entries.some((entry) => entry.key === 'posts'))
    || (value.kind === 'list' && value.items.some((item) => item.kind === 'string' && item.value === 'posts'));
  if (!configured) return [];
  return [`line ${line}: collections must not configure posts; its permalink and output settings decide whether and `
    + 'where posts are built, and can keep them off the site while GitHub still shows them; remove posts from it'];
}

/**
 * `future`, `show_drafts` and `unpublished` switch on Jekyll's own ways of
 * building what the site must not hold: posts dated after the build, the
 * `_drafts/` folder and posts marked `published: false`. Each may only stay
 * off, as boolean false or null (which keeps Jekyll's default, off); to Ruby
 * every other value, the string "false" and 0 included, is true.
 */
const OFF_SWITCHES = new Map([
  ['future', 'Jekyll then builds posts dated after the build'],
  ['show_drafts', 'Jekyll then builds the _drafts/ folder'],
  ['unpublished', 'Jekyll then builds posts marked published: false'],
]);

/** The rule for one of `OFF_SWITCHES`. */
function offSwitchProblems({ key, line, value }) {
  if (value.kind === 'null' || (value.kind === 'bool' && value.value === false)) return [];
  return [`line ${line}: ${key} must be boolean false or null (got ${describeYamlValue(value)}); ${OFF_SWITCHES.get(key)}, `
    + `which the site must never publish; set ${key}: false`];
}

/**
 * `timezone`: Jekyll reads filename dates in this zone. guard reads them in
 * `GUARD_TIMEZONE`, so in a zone behind UTC a post it accepts as dated today
 * is still in the future when Pages builds it, and stays off the site.
 */
function timezoneProblems({ line, value }) {
  if (value.kind === 'string' && value.value === GUARD_TIMEZONE) return [];
  return [`line ${line}: timezone must be the string ${JSON.stringify(GUARD_TIMEZONE)} (got ${describeYamlValue(value)}); `
    + 'Jekyll reads filename dates in this zone and guard reads them in UTC, so behind UTC a post guard accepts as '
    + 'dated today is still in the future when Pages builds it and stays off the site while GitHub shows it; '
    + `set timezone: ${GUARD_TIMEZONE}`];
}

/**
 * `permalink`: the URL template of every post. Only `SITE_PERMALINK` is
 * accepted when it is set: another template can give every post the same
 * URL, so all but one vanish, even when it holds `:title`.
 */
function permalinkProblems({ line, value }) {
  if (value.kind === 'string' && value.value === SITE_PERMALINK) return [];
  return [`line ${line}: permalink must be the string ${JSON.stringify(SITE_PERMALINK)} (got `
    + `${describeYamlValue(value)}); another template can give posts one URL, so all but one vanish from the site `
    + `while GitHub still shows them; set permalink: ${SITE_PERMALINK}`];
}

/** The rule for each top-level key that can keep a tracked post off the site. */
const ENTRY_RULES = new Map([
  ['defaults', defaultsProblems],
  ['exclude', excludeProblems],
  ['limit_posts', limitPostsProblems],
  ['collections_dir', collectionsDirProblems],
  ['collections', collectionsProblems],
  ...[...OFF_SWITCHES.keys()].map((key) => [key, offSwitchProblems]),
  ['timezone', timezoneProblems],
  ['permalink', permalinkProblems],
]);

/**
 * Refusals for the Jekyll configuration file `path` (the one
 * `siteConfigFile` names for the tree) whose contents are `text`: every
 * setting that could keep a tracked post off the site while the public
 * repository still shows it.
 *
 * Every top-level entry is checked, a key written twice included: Ruby keeps
 * the last, but the reader's judgement of which one that is must never decide
 * a refusal. What `readJekyllConfig` cannot read is refused too, since guard
 * cannot tell what Jekyll makes of it. Refused:
 *   - `defaults` values `published`, `date`, `permalink` or `slug`, in any scope;
 *   - `exclude` other than a list of strings, or an entry matching a tracked file in `_posts/`;
 *   - `limit_posts` or `collections_dir` set at all;
 *   - `collections` configuring `posts`;
 *   - `future`, `show_drafts` or `unpublished` other than boolean false or null;
 *   - `timezone` other than the string `Etc/UTC`;
 *   - `permalink` other than the string `/blog/:title/`.
 *
 * @param {object} args
 * @param {string} args.path The configuration file's repository-relative path, which starts every message.
 * @param {string} args.text Its contents.
 * @param {string[]} args.paths The complete tree as repository-relative POSIX paths.
 * @returns {string[]} Refusals, each starting with `${path}: ` and saying what to change; unreadable
 *   lines first, then the entries in file order. Identical messages are reported once.
 */
export function checkSiteConfig({ path, text, paths } = {}) {
  if (typeof path !== 'string' || path === '') throw new TypeError('path must be a non-empty string');
  if (typeof text !== 'string') throw new TypeError(`text must be a string, got ${typeof text}`);
  assertPaths(paths);
  const posts = paths.filter((p) => p.startsWith('_posts/'));
  const config = readJekyllConfig(text);
  const problems = config.unsupported.map((where) => `unsupported YAML at ${where}; guard cannot read this as Jekyll `
    + 'does, so it cannot tell whether it keeps a post off the site; rewrite it in plain block YAML');
  for (const entry of config.entries) {
    const rule = ENTRY_RULES.get(entry.key);
    if (rule !== undefined) problems.push(...rule(entry, posts));
  }
  return [...new Set(problems.map((problem) => `${path}: ${problem}`))];
}
