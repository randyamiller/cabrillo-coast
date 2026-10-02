/* Cabrillo Coast LLC — shared article rules (Node built-ins only) */
/**
 * The single definition of the blog's article rules.
 *
 * `scripts/article.mjs` (`check`, `publish`, `unpublish`, `guard --staged`,
 * `guard --pre-push`), the git hooks that call it and the test suites all
 * import these functions, so commit time, push time and test time apply
 * identical checks. The module performs no I/O: callers read files and git
 * objects and pass their text in.
 *
 * Importing it has no side effects. No file system, process or console access
 * happens at module level, and the current date is read only when a caller
 * omits `todayUtc`.
 *
 * Article model (repository-relative POSIX paths):
 *   - drafts:    `_drafts/<slug>.md`, images in `assets/drafts/<slug>/` (git-ignored)
 *   - posts:     `_posts/YYYY-MM-DD-<slug>.md`, images in `assets/blog/<slug>/`
 *   - fixtures:  `tests/fixtures/posts/YYYY-MM-DD-<slug>.md` (validated as posts)
 *
 * The root `_posts/` and `tests/fixtures/posts/` are the only article folders.
 * No tracked path may sit in a `_drafts/` folder at any depth, in a `_posts/`
 * folder below the root, or in a folder inside `_posts/` whose name starts
 * with `_`, `.`, `#` or `~`. Jekyll reads `<dir>/_drafts/` as drafts and
 * `<dir>/_posts/` as posts in every folder it builds, which the article
 * checks would not cover, and skips the last kind of folder, so its files
 * stay off the site while GitHub shows them (see `folderRefusal`).
 *
 * Front matter accepts `title`, `summary`, `tags`, `updated` and `author` only,
 * written in a restricted YAML subset that `parseArticle` reads without a
 * library.
 *
 * How the Markdown scanners decide what is code: the live site is rendered by
 * kramdown 2.4.0 with GFM input, so a scanner that treats text as code when
 * kramdown does not would hide real markup. Code is therefore located by
 * kramdown's own rules, including those plain CommonMark lacks: a fence run
 * may mix backticks and tildes, and inline code may close on part of a longer
 * backtick run. Any construct whose reading is uncertain is scanned as prose.
 * A misjudgement can only produce a false finding, which the author fixes by
 * rewording, never a missed one. Each place where these rules differ from
 * plain CommonMark is commented below with the kramdown behaviour that
 * decided it.
 */

import { posix } from 'node:path';

/* ------------------------------------------------------------------------ */
/* Public constants                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Slug format: lowercase letters and digits in groups joined by single
 * hyphens. No `g` flag, so `SLUG_RE.test()` is stateless. Callers must also
 * enforce `SLUG_MAX`.
 * @type {RegExp}
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Maximum slug length in characters.
 * @type {number}
 */
export const SLUG_MAX = 60;

/**
 * Tracked article paths: `_posts/**\/*.md` and `tests/fixtures/posts/**\/*.md`.
 * @type {RegExp}
 */
export const ARTICLE_PATH_RE = /^(?:_posts|tests\/fixtures\/posts)\/(?:[^/]+\/)*[^/]+\.md$/;

/* ------------------------------------------------------------------------ */
/* Internal constants                                                        */
/* ------------------------------------------------------------------------ */

const ALLOWED_KEYS = ['title', 'summary', 'tags', 'updated', 'author'];
const QUOTED_KEYS = new Set(['title', 'summary', 'author']);
const TITLE_MAX = 100;
const SUMMARY_MAX = 200;
const TAGS_MIN = 1;
const TAGS_MAX = 5;

/**
 * Front-matter keys Jekyll understands that the schema rejects, each with its
 * reason: `layout`, `permalink` and `date` are supplied elsewhere (the
 * `_config.yml` defaults, its `permalink` and the filename), `published` is
 * prohibited, and `categories` is replaced by `tags`.
 */
const REJECTED_KEY_REASONS = {
  published: 'published: is not allowed; keep unpublished drafts in the git-ignored _drafts/ folder',
  layout: 'layout: is not allowed; the layout is set by _config.yml defaults',
  permalink: 'permalink: is not allowed; the URL is set by _config.yml',
  date: 'date: is not allowed; the date comes from the filename',
  categories: 'categories: is not allowed; use tags instead',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const POST_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
const DRAFT_FILENAME_RE = /^(.+)\.md$/;
const POST_PATH_RE = /^_posts\/(?:[^/]+\/)*(\d{4}-\d{2}-\d{2})-([^/]+)\.md$/;
const DATED_BASENAME_RE = /^(\d{4}-\d{2}-\d{2})-/;
/** A path inside a `_drafts` folder at any depth (whole folder names only). */
const DRAFTS_FOLDER_RE = /(?:^|\/)_drafts\//;
/** A path inside a `_posts` folder below the repository root (whole folder names only). */
const NESTED_POSTS_FOLDER_RE = /\/_posts\//;
/** A folder name Jekyll's entry filter skips: one starting with `_`, `.`, `#` or `~`. */
const SKIPPED_FOLDER_RE = /^[_.#~]/;

/** kramdown 2.4.0 `HTML_SPAN_ELEMENTS`: a line starting with one of these is paragraph text. */
const HTML_SPAN_ELEMENTS = new Set([
  'a', 'abbr', 'acronym', 'b', 'big', 'bdo', 'br', 'button', 'cite', 'code', 'del', 'dfn', 'em',
  'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'option', 'q', 'rb', 'rbc', 'rp', 'rt',
  'rtc', 'ruby', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'tt', 'u', 'var',
]);

/** kramdown 2.4.0 `HTML_ELEMENTS_WITHOUT_BODY`: void elements never open a raw block. */
const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input', 'keygen', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** kramdown 2.4.0 `HTML_BLOCK_ELEMENTS`: in running text these tags are written out as text. */
const HTML_BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'applet', 'body', 'blockquote', 'caption', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'head', 'iframe', 'legend', 'menu', 'li', 'main',
  'map', 'nav', 'ol', 'optgroup', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'th',
  'thead', 'tfoot', 'tr', 'ul',
]);

/**
 * kramdown 2.4.0 `HTML_CONTENT_MODEL_BLOCK`, `HTML_CONTENT_MODEL_SPAN` and
 * `HTML_CONTENT_MODEL_RAW` (which wins). Every other element, unknown and
 * custom elements included, has raw content too: kramdown copies it through
 * without reading Markdown in it.
 */
const HTML_CONTENT_MODEL_BLOCK = new Set([
  'address', 'applet', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl',
  'fieldset', 'figure', 'figcaption', 'footer', 'form', 'header', 'hgroup', 'iframe', 'li',
  'main', 'map', 'menu', 'nav', 'noscript', 'object', 'section', 'summary', 'td',
]);
const HTML_CONTENT_MODEL_SPAN = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdo', 'big', 'button', 'cite', 'caption', 'del', 'dfn', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'ins', 'label', 'legend', 'optgroup', 'p', 'q',
  'rb', 'rbc', 'rp', 'rt', 'rtc', 'ruby', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'th',
  'tt',
]);
const HTML_CONTENT_MODEL_RAW = new Set([
  'script', 'style', 'math', 'option', 'textarea', 'pre', 'code', 'kbd', 'samp', 'var',
]);

/** kramdown 2.4.0 `HTML_ELEMENT`: names it lowercases and matches case-insensitively. */
const KNOWN_HTML_ELEMENTS = new Set([
  ...HTML_SPAN_ELEMENTS, ...HTML_BLOCK_ELEMENTS, ...HTML_VOID_ELEMENTS,
  ...HTML_CONTENT_MODEL_BLOCK, ...HTML_CONTENT_MODEL_SPAN, ...HTML_CONTENT_MODEL_RAW,
]);

/** Opening tags of elements that may run script, load content or change the page. */
const UNSAFE_TAG_RE = /<(?:script|iframe|object|embed|form|base|meta|link|style)\b/gi;

/** Start of a kramdown attribute list (`{: …}`, `{:#id}`, ALDs). */
const IAL_START_RE = /\{:/g;

/**
 * Event-handler attribute inside a tag, and inside an attribute list. The `g`
 * flag lets the scanner visit every match; findings are still reported one
 * per line (`lineFindings`).
 */
const TAG_EVENT_ATTR_RE = /[\s"'/]on[a-z]+\s*=/gi;
const IAL_EVENT_ATTR_RE = /[\s"'/:]on[a-z]+\s*=/gi;

/**
 * The `javascript` scheme. Browsers remove tabs and line breaks anywhere in a
 * URL and ignore leading spaces and control characters, so those are allowed
 * between the letters and before the scheme; whitespace before the colon is
 * tolerated as well.
 */
const JS_SCHEME = 'j[\\t\\n\\r]*a[\\t\\n\\r]*v[\\t\\n\\r]*a[\\t\\n\\r]*s[\\t\\n\\r]*c[\\t\\n\\r]*'
  + 'r[\\t\\n\\r]*i[\\t\\n\\r]*p[\\t\\n\\r]*t\\s*:';

/**
 * Where a Markdown URL can start: after an inline link or image destination
 * `](`, a link definition `]:` (each optionally followed by whitespace and
 * `<`), or an angle-bracket URL `<`. Matched in the source, so a delimiter is
 * always a literal character: `&lt;javascript:x&gt;` is prose, not a URL.
 */
const MD_URL_START_RE = /\]\(\s*<?|\]:\s*<?|</g;

/**
 * `javascript:` at the start of a Markdown URL (sticky), tested where
 * `MD_URL_START_RE` ends, in the body with its character references decoded:
 * kramdown copies `&#106;avascript:`, `java&#x09;script:` or
 * `javascript&colon;` into the `href` or `src` as written, and the browser
 * decodes them there.
 *
 * The scheme is matched only where a URL can stand, never as a bare word, so
 * prose such as a heading "JavaScript: closures explained" does not block
 * publishing a technical article. Only these literal Markdown URL positions
 * are covered: a destination that Liquid generates is not evaluated here and
 * is left to the scan of the rendered pages.
 */
const JS_URL_DEST_RE = new RegExp(`[\\s\\u0000-\\u001f]*${JS_SCHEME}`, 'iy');

/** Link text as kramdown counts brackets in it, one level of nesting deep. */
const BRACKETED_TEXT = '(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*';

/**
 * `javascript:` after `=` (optionally quoted), applied inside tags and
 * attribute lists only. The `g` flag lets the scanner visit every match;
 * findings are still reported one per line (`lineFindings`).
 */
const JS_URL_ATTR_RE = new RegExp(`=\\s*["']?[\\s\\u0000-\\u001f]*${JS_SCHEME}`, 'gi');

/**
 * Start of a Markdown inline image `![alt](dest "title")` as kramdown's link
 * parser reads it, through the end of `dest`; `inlineImageEnd` then reads the
 * optional title and the closing `)`. The alt text may hold bracketed text.
 * `dest` takes one of two forms:
 *   - an `<…>` URL, recognised only when `<` directly follows `(`. `>` must
 *     then be followed directly by `)`, or by a title and `)`; otherwise the
 *     whole image is literal text;
 *   - otherwise a Liquid expression, or a URL holding spaces (except before a
 *     quote, which starts the title) and balanced parentheses, and surrounding
 *     whitespace, which kramdown strips. A quote directly after `(` belongs to
 *     the URL. `dest` may be empty or whitespace, which kramdown renders as
 *     an image with an empty source, so `()`, `( )` and `( "title")` are
 *     images too, as is `(<>)` in the first form.
 * kramdown has no parenthesised titles (verified). Groups: 1 alt, 2 `<…>`
 * destination, 3 any other destination (exactly one of 2 and 3 is set). The
 * captures are possessive, as no shorter match could succeed.
 */
const IMG_INLINE_HEAD_RE = new RegExp(
  `!\\[(?=(${BRACKETED_TEXT}))\\1\\]\\(`
  + `(?:(?=(<[^>\\n]*>))\\2`
  + `|(?!<[^>\\n]*>)(?=(\\s*(?:\\{\\{[\\s\\S]*?\\}\\}[^\\s)]*`
  + `|(?!(?<=\\s)["'])(?:[^\\s()]|[ \\t]+(?=[^\\s"')])|\\([^()\\n]*\\))*)))\\3)`,
  'gd',
);

/**
 * A quote that can close an inline image title: kramdown's title pattern
 * `\s*?(["'])(.+?)\1\s*?\)` ends the title at the first matching quote that
 * only (Ruby) whitespace separates from `)`.
 */
const TITLE_CLOSE_RE = /["'](?=[ \t\n\v\f\r]*\))/g;

/** A line kramdown reads as blank: Ruby whitespace only. */
const RUBY_BLANK_LINE_RE = /^[ \t\v\f\r]*$/;

/**
 * Markdown reference image `![alt][id]`, `![alt][]` or shortcut `![alt]`;
 * kramdown allows any whitespace, a line break included, before `[id]`.
 * Matched within one paragraph (`paragraphSpans`).
 */
const IMG_REFERENCE_RE = new RegExp(`!\\[(${BRACKETED_TEXT})\\](?:\\s*?\\[([^\\]]*)\\])?`, 'g');

/** Raw HTML `<img …>` start. */
const IMG_TAG_START_RE = /<img(?=[\s/>])/gi;

/**
 * Tag text `collectImages` may read from `<img>` tags, per character of the
 * body and in all. Tags that do not overlap total at most the body's length;
 * unclosed starts (`'<img '.repeat(n)`) all end at the same `>`, and reading
 * each of them would take quadratic time.
 */
const IMAGE_TAG_WORK_PER_CHAR = 4;
const IMAGE_TAG_WORK_BASE = 65536;

/** One attribute inside a tag: name, then a double-quoted, single-quoted or bare value. */
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const LIQUID_RELATIVE_URL_RE = /^\{\{-?\s*(['"])(\/[^'"]*)\1\s*\|\s*relative_url\s*-?\}\}$/;
const LIQUID_BASEURL_RE = /^\{\{-?\s*site\.baseurl\s*-?\}\}(\/.*)$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const RAW_OPEN_RE = /\{%-?\s*raw\s*-?%\}/g;
const RAW_CLOSE_RE = /\{%-?\s*endraw\s*-?%\}/g;
const RAW_TAG_AT_RE = /\{%-?\s*(?:end)?raw\s*-?%\}/y;
const LIQUID_IN_CODE_RE = /\{\{|\{%/g;

/**
 * `post_url` and `link` tags. Liquid 4.0.4 (`BlockBody::FullToken`) reads a
 * tag's markup lazily before the optional closing `-`, so the argument is
 * captured lazily too: in `{% post_url 2026-01-15-foo-%}` it is
 * `2026-01-15-foo`, not `2026-01-15-foo-`.
 */
const POST_URL_TAG_RE = /\{%-?\s*post_url\s+([^\s%]+?)\s*-?%\}/g;
const LINK_TAG_RE = /\{%-?\s*link\s+([^\s%]+?)\s*-?%\}/g;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n',
  sol: '/', lpar: '(', rpar: ')', period: '.', nbsp: '\u00a0',
};

/* ------------------------------------------------------------------------ */
/* Input, date and line helpers                                              */
/* ------------------------------------------------------------------------ */

/** Returns `value` as text: `undefined` and `null` become `''`, other non-strings throw. */
function asText(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string, got ${typeof value}`);
  }
  return value;
}

/** Today's date in UTC as `YYYY-MM-DD`; read only when a caller omits `todayUtc`. */
function todayUtcDefault() {
  return new Date().toISOString().slice(0, 10);
}

/** Resolves a `todayUtc` argument, rejecting anything that is not a real `YYYY-MM-DD` date. */
function resolveToday(todayUtc) {
  const today = todayUtc === undefined || todayUtc === null ? todayUtcDefault() : todayUtc;
  if (!isCalendarDate(today)) {
    throw new TypeError(`todayUtc must be a YYYY-MM-DD date, got ${JSON.stringify(today)}`);
  }
  return today;
}

/**
 * True for a real calendar date written `YYYY-MM-DD` (rejects `2026-02-30`,
 * `2026-13-01`). Dates in this form compare correctly as strings, so callers
 * order them with `<` and `>`.
 */
function isCalendarDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

/** Counts Unicode code points. */
function charCount(s) {
  return [...s].length;
}

function isFilled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Returns `lineAt(offset)` for `text`: the 1-based line number of `offset`,
 * that is 1 plus the newlines before it. Line starts are indexed once, in
 * O(n) for a text of n characters, and each lookup is a binary search in
 * O(log L) for its L lines.
 */
function lineLocator(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return function lineAt(offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The whole line containing `offset`, without its line terminator, trimmed. */
function lineText(text, offset) {
  const start = offset <= 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
  const nl = text.indexOf('\n', start);
  const end = nl === -1 ? text.length : nl;
  return text.slice(start, end).replace(/\r$/, '').trim();
}

/**
 * Splits `text` on `\r?\n`, keeping offsets so callers can slice exactly.
 * Each entry is `{ start, end, next, text }`: `text` is the line without its
 * terminator, `end` is where the terminator begins and `next` where the
 * following line starts. A text ending in a newline yields a final empty line.
 */
function splitLines(text) {
  const lines = [];
  const re = /\r?\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    lines.push({ start, end: m.index, next: m.index + m[0].length, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  lines.push({ start, end: text.length, next: text.length, text: text.slice(start) });
  return lines;
}

/** Index of the line in `lines` (from `splitLines`) that contains `offset`. */
function lineIndexAt(lines, offset) {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Collects line-level findings for `text`: the first offset noted on a line
 * wins, and `list()` returns `{ line, text }` entries ordered by line. Every
 * scanner reports one finding per line through this, so results are stable
 * enough to compare with `assert.deepStrictEqual`.
 */
function lineFindings(text) {
  const lineAt = lineLocator(text);
  const byLine = new Map();
  return {
    note(offset) {
      const line = lineAt(offset);
      if (!byLine.has(line)) byLine.set(line, offset);
    },
    list() {
      return [...byLine.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, offset]) => ({ line, text: lineText(text, offset) }));
    },
  };
}

/** Escapes `s` for literal use inside a regular expression. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The passes of `decodeEntities`, applied in order, each to the output of
 * the one before: hexadecimal and decimal references (the semicolon is
 * optional, as browsers allow), then the named references in
 * `NAMED_ENTITIES`. Each decoder returns the reference unchanged when it
 * names nothing. `decodeEntitiesMapped` applies the same passes.
 */
const ENTITY_PASSES = [
  [/&#[xX]([0-9a-fA-F]+);?/g, (all, hex) => codePointText(Number.parseInt(hex, 16), all)],
  [/&#(\d+);?/g, (all, dec) => codePointText(Number.parseInt(dec, 10), all)],
  [/&([a-zA-Z]+);/g, (all, name) => {
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : all;
  }],
];

/**
 * Decodes the HTML character references a browser would decode in an
 * attribute value: numeric references (the semicolon is optional, as browsers
 * allow) and the named references that can spell a URL scheme. Used only to
 * look through obfuscation such as `&#106;avascript:`; reported text always
 * comes from the original source.
 */
function decodeEntities(s) {
  return ENTITY_PASSES.reduce((text, [re, decode]) => text.replace(re, decode), s);
}

/**
 * `decodeEntities(s)` as `{ text, from }`, where `from[k]` is the offset in
 * `s` that character `k` of `text` comes from: a decoded reference maps to
 * the first character of the reference it was decoded from (through every
 * pass), any other character to itself. It runs the same passes, so `text`
 * always equals `decodeEntities(s)`.
 */
function decodeEntitiesMapped(s) {
  let text = s;
  let from = Array.from({ length: s.length }, (_, k) => k);
  for (const [re, decode] of ENTITY_PASSES) {
    let out = '';
    const map = [];
    let pos = 0;
    const keep = (end) => {
      out += text.slice(pos, end);
      for (let k = pos; k < end; k += 1) map.push(from[k]);
    };
    for (const m of text.matchAll(re)) {
      const value = decode(m[0], m[1]);
      if (value === m[0]) continue;
      keep(m.index);
      out += value;
      for (let k = 0; k < value.length; k += 1) map.push(from[m.index]);
      pos = m.index + m[0].length;
    }
    keep(text.length);
    text = out;
    from = map;
  }
  return { text, from };
}

function codePointText(cp, fallback) {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

/* ------------------------------------------------------------------------ */
/* Code regions                                                              */
/* ------------------------------------------------------------------------ */
/*
 * The scanners skip code, so they must know exactly what kramdown 2.4.0
 * (GFM input, as on GitHub Pages) renders as code. A fence is paired with
 * the first closing line after it, so one misjudged fence shifts every later
 * pairing and could hide real markup between two code blocks. The model
 * below ports kramdown's rules for fences, list items, raw HTML blocks
 * (where they end, and the block that may follow on the same line) and
 * extensions, and where a rule depends on context it does not model
 * (blockquote and definition continuation, indented code, Markdown inside
 * HTML, math blocks, whether a line continues the paragraph before it) it
 * keeps every plausible reading as a separate hypothesis. A line counts as
 * code only when every hypothesis agrees, so uncertainty can only leave code
 * unmasked (a possible false finding), never mask prose. Inline code follows
 * kramdown's span parser on the lines every hypothesis reads as running text
 * (see "inline code" below).
 */

/*
 * kramdown builds its HTML regexps from REXML's `UNAME_STR` and runs them in
 * Ruby's Onigmo engine, where `[:alpha:]` is \p{Alphabetic}, `[:alnum:]` adds
 * \p{Nd}, `\p{Word}` is \p{Alphabetic}, \p{M}, \p{Nd} and \p{Pc}, and `\s` is
 * ASCII only (each verified in Ruby 3.3.4). Ruby's atomic groups `(?>…)` are
 * written `(?=(…))\N`, which fixes the first match exactly as they do.
 */
const RUBY_SPACE = '[ \\t\\n\\v\\f\\r]';
const RUBY_SPACE_CHAR_RE = /^[ \t\n\v\f\r]$/;
const NCNAME = '[\\p{Alpha}_][-\\p{Alpha}\\p{Nd}._]*';
const UNAME = `(?:${NCNAME}:)?${NCNAME}`;
const RUBY_WORD = '[\\p{Alpha}\\p{M}\\p{Nd}\\p{Pc}]';
/**
 * kramdown `HTML_TAG_RE` (sticky). Groups: 1 name, 2 attributes, 5 the
 * self-closing slash. Of the ways kramdown's `\s*` after the name can split
 * the whitespace there, only two can lead to a match: taking all of it, when
 * `/>` or `>` follows, or all but its last character, which then begins the
 * first attribute; every shorter split repeats that second attempt. Only
 * those two are tried, which gives the same match and keeps whitespace runs
 * from costing quadratic time.
 */
const KD_TAG_RE = new RegExp(
  `<(?=(${UNAME}))\\1`
  + `(?:${RUBY_SPACE}*(?=\\/?>)|(?:${RUBY_SPACE}(?=${RUBY_SPACE}))*(?=${RUBY_SPACE}(?!${RUBY_SPACE})))`
  + `((?:(?=(${RUBY_SPACE}+${UNAME}(?:${RUBY_SPACE}*=${RUBY_SPACE}*(?:${RUBY_WORD}+|(["'])[\\s\\S]*?\\4))?))\\3)*)`
  + `${RUBY_SPACE}*(\\/)?>`,
  'uy',
);
/** kramdown `HTML_TAG_CLOSE_RE` (sticky). Group 1: the name. */
const KD_TAG_CLOSE_RE = new RegExp(`</(${UNAME})${RUBY_SPACE}*>`, 'uy');
/** kramdown `HTML_ATTRIBUTE_RE`. Groups: 1 name, 2 bare value, 4 quoted value. */
const KD_ATTRIBUTE_RE = new RegExp(
  `${RUBY_SPACE}*(${UNAME})(?:${RUBY_SPACE}*=${RUBY_SPACE}*(?:(${RUBY_WORD}+)|(["'])([\\s\\S]*?)\\3))?`,
  'gu',
);
/** kramdown `AUTOLINK_START` (sticky); Ruby's `.` is anything but a line feed. */
const KD_AUTOLINK_RE = /<(?:(?:mailto|https?|ftps?):[^\n]+?|[\p{Alpha}\p{Nd}\-_.]+?@[\p{Alpha}\p{Nd}\-_.]+?)>/uy;
/** The schemes `KD_AUTOLINK_RE` accepts after the `<`, each with its colon. */
const KD_AUTOLINK_SCHEMES = ['mailto:', 'https:', 'http:', 'ftps:', 'ftp:'];
/** kramdown `HTML_RAW_START`: where raw HTML parsing looks for the next tag. */
const KD_RAW_START_RE = /<(?=[\p{Alpha}_/?]|!--)/gu;
/** kramdown `HTML_MARKDOWN_ATTR_MAP` values. */
const MARKDOWN_ATTR_MODES = new Set(['0', '1', 'span', 'block']);

const BLANK_LINE_RE = /^[ \t]*$/;
/** kramdown-parser-gfm `FENCED_CODEBLOCK_START`. */
const FENCE_START_RE = /^ {0,3}([~`]{3,})/;
/** kramdown `LIST_START_UL` / `LIST_START_OL`: indentation, marker, rest of the line. */
const LIST_START_RE = /^( {0,3})(?:([+*-])|\d+\.)([\t| ].*)$/;
/** The IAL of kramdown `LIST_ITEM_IAL_CHECK`, matched against the whole line without its surrounding spaces and tabs (see `isEmptyItemLine`). */
const LIST_ITEM_IAL_RE = /^\{:(?![\w-]*:|\/)(?:\\\}|[^}])+\}$/;
/** kramdown `HR_START`. */
const HR_LINE_RE = /^ {0,3}([-*_])[ \t]*\1[ \t]*\1(?:\1|[ \t])*$/;
/** kramdown `EOB_MARKER`. */
const EOB_LINE_RE = /^\^[ \t]*$/;
/** kramdown lazy-continuation stops: `IAL_BLOCK`, `LAZY_END_HTML_STOP`, `LAZY_END_HTML_START`. */
const LAZY_STOP_RE = new RegExp(
  '^(?:\\{:(?!:|/)(?:\\\\\\}|[^}])+\\}[ \\t]*$'
  + `|</(?!(?:${[...HTML_SPAN_ELEMENTS, 'script'].join('|')})\\b)${UNAME}${RUBY_SPACE}*>`
  + `|<(?!(?:${[...HTML_SPAN_ELEMENTS, 'script'].join('|')})\\b)[\\p{Alpha}_])`,
  'u',
);
/** Blockquote, definition and footnote lines, whose blocks continue lazily (not modelled). */
const LAZY_CONTAINER_RE = /^ {0,3}(?:>|:[ \t]|\[\^[^\]\n]+\]:)/;
/** kramdown `HTML_BLOCK_START` for a start tag: up to three spaces, `<` and a name. */
const HTML_BLOCK_TAG_RE = /^ {0,3}<[\p{Alpha}_]/u;
/** kramdown `LAZY_END_HTML_START`: a start tag that ends a running paragraph. */
const LAZY_END_HTML_START_RE = new RegExp(
  `^<(?!(?:${[...HTML_SPAN_ELEMENTS, 'script'].join('|')})\\b)${UNAME}`,
  'u',
);
/** kramdown `BLOCK_EXTENSIONS_START`. */
const BLOCK_EXTENSION_RE = /^ {0,3}\{::([a-zA-Z]\w*)(?:\s[^}\n]*?)?(\/)?\}/;
/** A line ending block extensions: `{:/}` ends any, `{:/name}` (group 1) those named `name`. */
const EXTENSION_STOP_RE = /^ {0,3}\{:\/([a-zA-Z]\w*)?\}[ \t\r\f\v]*$/;
const OPTIONS_EXTENSION_RE = /\{::options\b/;
const RAW_EXTENSIONS = new Set(['comment', 'nomarkdown']);
const MATH_BLOCK_RE = /^ {0,3}\\?\$\$/;
/** Above this many open readings the model stops masking for the rest of the body. */
const MAX_HYPOTHESES = 64;
/**
 * Work that searches for the end of a fence or block extension may do, per
 * line of the body, per character of it and in all. A search inside list
 * items reads lines through the item's extraction, which top-level indexes
 * cannot answer, and pays one unit per line read, and a fence search there
 * one more per character it examines of a line that starts like a fence. A
 * top-level fence search pays one unit per closing-fence-shaped line it
 * visits. A fence search at either depth also pays one unit per character it
 * compares with the opening run, so the per-character allowance lets a body
 * with very long fence lines be read whole. A body of unclosed openers would
 * otherwise take quadratic time; once the budget is spent the model stops
 * masking for the rest of the body.
 */
const LOOKAHEAD_PER_LINE = 64;
const LOOKAHEAD_PER_CHAR = 4;
const LOOKAHEAD_BASE = 65536;
/** Scanning allowed to the inline-code walk, per character of text and in all. */
const SPAN_WORK_PER_CHAR = 32;
const SPAN_WORK_BASE = 65536;
/** Same-line block restarts after raw HTML tried per line before the model gives up on it. */
const RESUME_BUDGET = 256;

/** Characters at which kramdown's span parsers that matter here can start. */
const SPAN_SPECIAL_RE = /[`\\<\]$\{~]/g;
/** kramdown-parser-gfm `ESCAPED_CHARS_GFM`: characters a backslash escapes in running text. */
const ESCAPABLE_GFM = new Set([...'\\.*_+`<>()[]{}#!:|"\'$=-~']);
/** kramdown `HTML_SPAN_START`: what may follow `<` for span-level HTML. */
const SPAN_HTML_NEXT_RE = /^[\p{Alpha}_?/]/u;
/** kramdown link destinations (link.rb): `(<…>`, the parenthesis scan, the title. */
const LINK_ANGLE_RE = /^\(<[^\n]*?>/;
const LINK_PAREN_RE = /(\()|(\))|[ \t\n\v\f\r](?=['"])/g;
const LINK_TITLE_RE = /^[ \t\n\v\f\r]*?(["'])[\s\S]+?\1[ \t\n\v\f\r]*?\)/;
/** kramdown `LINK_INLINE_ID_RE`: a reference `[id]` after a link's text. */
const LINK_ID_RE = /[ \t\n\v\f\r]*?\[([^\]]*)\]/y;
/** Characters that could start or end markup inside a link destination, reference or attribute list. */
const SPAN_DANGER_RE = /[`<{$~[\]\\]/;
/** A Liquid tag on one line whose text holds no backtick or `<`. */
const LIQUID_TAG_RE = /\{\{[^`<\n]*?\}\}|\{%[^`<\n]*?%\}/g;
/** The end of kramdown-parser-gfm `STRIKETHROUGH_MATCH`. */
const STRIKE_END_RE = /[^ \t\n\v\f\r~]~~/g;
/** kramdown `TABLE_LINE`: a line kramdown may read as a table row. */
const TABLE_LINE_RE = /^\||[^\\]\|/;
/** Text after raw HTML on a line that could carry span markup on to the next line. */
const RESUME_DANGER_RE = /[`<\]]|\$\$|\{:|~~/;

function stripCr(s) {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function leadingSpaces(s) {
  return /^ */.exec(s)[0].length;
}

/** `s` without its trailing spaces and tabs, read once from the end. */
function trimSpaceTabEnd(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/** True for the characters Ruby's `String#strip` removes: NUL, tab, line feed, vertical tab, form feed, carriage return and space. */
function isRubyStripChar(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r' || c === '\0';
}

/** `s` as Ruby's `String#strip` leaves it: without its leading and trailing `isRubyStripChar` characters, each read once. */
function rubyStrip(s) {
  let from = 0;
  while (from < s.length && isRubyStripChar(s[from])) from += 1;
  let to = s.length;
  while (to > from && isRubyStripChar(s[to - 1])) to -= 1;
  return s.slice(from, to);
}

/* ---- kramdown list extraction ------------------------------------------ */

/**
 * kramdown `LIST_ITEM_IAL_CHECK`: true when an item's first line, `content`,
 * is empty or only an IAL between spaces and tabs. The spaces and tabs are
 * stripped first, so time is linear in the line's length.
 */
function isEmptyItemLine(content) {
  let from = 0;
  while (from < content.length && (content[from] === ' ' || content[from] === '\t')) from += 1;
  const core = trimSpaceTabEnd(content.slice(from));
  return core === '' || LIST_ITEM_IAL_RE.test(core);
}

/**
 * The list item a line opens, following kramdown's `parse_first_list_line`:
 * `{ indent, kind, content }`, where `indent` is the content indentation
 * relative to the enclosing block and `content` the item's first line as its
 * content sees it. `m` is a `LIST_START_RE` match. kramdown expands the tabs
 * in the leading whitespace of `content` one run at a time: the run's first
 * tab reaches the next multiple of four columns, counting the marker and the
 * indentation before it, and each further tab adds four. One pass over that
 * whitespace gives the same width, so time is linear in the line's length.
 */
function openItem(m) {
  const kind = m[2] ? 'bullet' : 'ordered';
  let indent = m[0].length - m[3].length;
  let content = m[3];
  if (isEmptyItemLine(content)) {
    indent = 4;
  } else {
    let width = 0;
    let i = 0;
    for (; i < content.length; i += 1) {
      if (content[i] === ' ') width += 1;
      else if (content[i] === '\t') width += 4 - ((width + indent) % 4);
      else break;
    }
    indent += width;
    content = content.slice(i);
  }
  content = content.replace(/^\s*/, '');
  return { indent, kind, nested: LIST_START_RE.test(content), content };
}

/** kramdown `fetch_pattern`: a sibling item of a list whose current item has `indent`. */
function isSibling(view, item) {
  const m = LIST_START_RE.exec(view);
  return m !== null && (m[2] ? 'bullet' : 'ordered') === item.kind && m[1].length <= Math.min(item.indent - 1, 3);
}

/** kramdown's `content_re` for `indent`: tabs count as four columns in whole groups. */
function isItemContent(view, indent) {
  const q = indent >> 2;
  return new RegExp(`^(?:(?:\\t| {4}){${q}} {${indent & 3}}|(?:\\t| {4}){${q + 1}})`).test(view);
}

/** kramdown's de-indentation of an item content line. */
function dedent(view, indent) {
  const expanded = view.replace(/^\t+/, (tabs) => ' '.repeat(4 * tabs.length));
  return expanded.startsWith(' '.repeat(indent)) ? expanded.slice(indent) : expanded;
}

/** True when kramdown's `lazy_re` lets `view` continue an item lazily. */
function isLazyLine(view, indent) {
  const spaces = leadingSpaces(view);
  return !(spaces <= Math.min(indent, 3) && LAZY_STOP_RE.test(view.slice(spaces)));
}

/**
 * Runs kramdown's list loop for one non-blank line through the open items,
 * outermost first. Returns `{ items, view, cut, sibling }`: the items still
 * open (copies), the line as the innermost remaining block sees it, `cut`,
 * the number of outer items whose content runs on unbroken (content nested
 * deeper than `cut` items ends before this line; `cut` is `items.length`
 * when nothing ends), and the level whose list the line continues with a new
 * item (-1 when none). Content ends when its item ends, when a sibling item
 * starts, and when kramdown splits an item's text where a nested list first
 * appears (each part is parsed on its own, so no fence spans the split).
 * Blank lines never change the items.
 */
function extractLine(items, text, afterBlank) {
  let view = text;
  const open = [];
  for (let level = 0; level < items.length; level += 1) {
    const item = items[level];
    if ((afterBlank && HR_LINE_RE.test(view)) || EOB_LINE_RE.test(view)) {
      return { items: open, view, cut: level, sibling: -1 };
    }
    if (isSibling(view, item)) return { items: open, view, cut: level, sibling: level };
    if (isItemContent(view, item.indent)) {
      const inner = dedent(view, item.indent);
      if (!item.nested && LIST_START_RE.test(inner)) {
        open.push({ ...item, nested: true });
        return { items: open, view: inner, cut: level, sibling: -1 };
      }
      open.push(item);
      view = inner;
    } else if (!afterBlank && isLazyLine(view, item.indent)) {
      if (item.nested && LIST_START_RE.test(view)) view = ' '.repeat(item.indent + 4) + view;
      open.push(item);
    } else {
      return { items: open, view, cut: level, sibling: -1 };
    }
  }
  return { items: open, view, cut: items.length, sibling: -1 };
}

/** After a blank line kramdown marks every open item as having nested content. */
function blankLineItems(items) {
  return items.some((item) => !item.nested) ? items.map((item) => ({ ...item, nested: true })) : items;
}

/**
 * A view of the lines after `index` as the block holding line `index` sees
 * them, for the first `depth` open `items`: `view(j)` returns line `j`
 * de-indented for those items, or `null` from the first line that leaves
 * them. Calls must use increasing `j`.
 */
function blockView(texts, index, items, depth) {
  let state = items.slice(0, depth);
  let afterBlank = false;
  let done = false;
  let at = index;
  const cache = new Map();
  return (j) => {
    while (at < j) {
      at += 1;
      if (done) {
        cache.set(at, null);
        continue;
      }
      const text = texts[at];
      if (BLANK_LINE_RE.test(text)) {
        state = blankLineItems(state);
        afterBlank = true;
        cache.set(at, text);
        continue;
      }
      const step = extractLine(state, text, afterBlank);
      afterBlank = false;
      if (step.cut < depth) {
        done = true;
        cache.set(at, null);
        continue;
      }
      state = step.items;
      cache.set(at, step.view);
    }
    return cache.get(j) ?? null;
  };
}

/* ---- fences and raw HTML ----------------------------------------------- */

/** True for the whitespace kramdown-parser-gfm's fence patterns allow around info and after a closing run. */
function isFenceSpace(c) {
  return c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';
}

/**
 * Whether `s` may follow the run kramdown-parser-gfm takes as an opening
 * fence's (`\s*?(\S+?)?\s*?\n`): at most one word, with only spaces, tabs,
 * carriage returns, form feeds and vertical tabs around it and no line feed.
 * With `spaced` false no whitespace may come before the word, as when the
 * last characters of the fence run begin it. Each character is read once.
 */
function isFenceInfo(s, spaced) {
  let i = 0;
  if (spaced) while (i < s.length && isFenceSpace(s[i])) i += 1;
  while (i < s.length && s[i] !== '\n' && !isFenceSpace(s[i])) i += 1;
  while (i < s.length && isFenceSpace(s[i])) i += 1;
  return i === s.length;
}

/**
 * The run of a line shaped like a closing fence: up to three spaces, three
 * or more `~` and backtick characters, then only the whitespace
 * `isFenceSpace` accepts. Returns `{ from, to, repeat, read }`: the run is
 * `v.slice(from, to)`, the repetition of its last character that ends it
 * begins at `repeat`, and `read` counts the characters examined from the
 * first that could belong to a run. Any other line gives `from` -1 (with
 * `read`). Time is linear in `read`.
 */
function fenceCloseRun(v) {
  let from = 0;
  while (from < 3 && v[from] === ' ') from += 1;
  let to = from;
  while (to < v.length && (v[to] === '~' || v[to] === '`')) to += 1;
  let end = to;
  if (to - from >= 3) while (end < v.length && isFenceSpace(v[end])) end += 1;
  if (to - from < 3 || end < v.length) return { from: -1, to: -1, repeat: -1, read: end - from };
  let repeat = to - 1;
  while (repeat > from && v[repeat - 1] === v[to - 1]) repeat -= 1;
  return { from, to, repeat, read: end - from };
}

/**
 * The lines of `texts` shaped like closing fences (see `fenceCloseRun`), as
 * parallel arrays `{ lines, from, to, repeat }` in ascending line order.
 * Built once per body, in time linear in its length, for the top level,
 * where every line reads as written.
 */
function fenceCloseLines(texts) {
  const out = { lines: [], from: [], to: [], repeat: [] };
  for (let j = 0; j < texts.length; j += 1) {
    const c = fenceCloseRun(texts[j]);
    if (c.from === -1) continue;
    out.lines.push(j);
    out.from.push(c.from);
    out.to.push(c.to);
    out.repeat.push(c.repeat);
  }
  return out;
}

/**
 * Line of the fence closing an opening line, following kramdown-parser-gfm
 * 1.1.0 `FENCED_CODEBLOCK_MATCH` exactly; -1 when there is none, and null
 * (unknown) once the body's lookahead budget (`LOOKAHEAD_PER_LINE`) is spent.
 * `view` is the opening line as its block sees it. Inside list items
 * `next(j)` returns line `j` the same way (`null` once the block has ended),
 * read in increasing `j`, and each line read is charged to the budget. At
 * the top level `next` is null: every line reads as written, so the search
 * visits only the closing-fence-shaped lines of an index built once per body
 * (`ctx.fenceCloses`), and `ctx.fenceMisses` remembers, per opening run,
 * from which line on no line closes it, so a later opener with the same run
 * reads nothing again. Every comparison is charged to the budget at either
 * depth.
 *
 * kramdown's fence run `([~`]){3,}` can backtrack: a run of N characters may
 * act as a shorter run of k (3 ≤ k ≤ N) with the rest taken as info, so
 * "````" can close at "```". The rest of the opening line allows k = N when
 * it is at most one word between whitespace, and every k < N when, in
 * addition, no whitespace comes before that word, which the run's last
 * N − k characters then begin. A line closes k when it holds up to three
 * spaces, the run's first k characters, more of its k-th character and then
 * only whitespace: for a line whose run shares p leading characters with
 * the opener's and ends in a repetition starting at its (r + 1)-th
 * character, exactly the k from max(3, r + 1) to p. The fence takes the
 * longest allowed k that some line closes, and the first line closing it.
 * One pass compares each line's run once, so time is linear in the lines
 * read.
 */
function kramdownFenceClose(ctx, view, index, next) {
  const m = FENCE_START_RE.exec(view);
  if (m === null) return -1;
  const run = m[1];
  const n = run.length;
  const after = view.slice(m[0].length);
  let whole = isFenceInfo(after, true);
  let shorter = n > 3 && isFenceInfo(after, false);
  const known = next === null ? ctx.fenceMisses.get(run) : undefined;
  if (known !== undefined) {
    if (index + 1 >= known.whole) whole = false;
    if (index + 1 >= known.shorter) shorter = false;
  }
  if (!whole && !shorter) return -1;
  // The longest allowed k that line `v`, whose run is `v.slice(from, to)`
  // ending in a repetition from `repeat`, closes (0 for none), charging
  // `cost` units and each character compared; null once the budget is spent.
  const longest = (v, from, to, repeat, cost) => {
    const limit = Math.min(to - from, n);
    let p = 0;
    while (p < limit && v[from + p] === run[p]) p += 1;
    if (!chargeLookahead(ctx, cost + p)) return null;
    const low = Math.max(3, repeat - from + 1);
    if (whole && p === n && low <= n) return n;
    const k = shorter ? Math.min(p, n - 1) : 0;
    return k >= low ? k : 0;
  };
  // The longest shorter k closed so far and the first line closing it.
  let best = 0;
  let bestAt = -1;
  // Takes line `j`'s answer; true once nothing later can change the result.
  const settled = (j, k) => {
    if (k > best) {
      best = k;
      bestAt = j;
    }
    return k === n || (!whole && k === n - 1);
  };
  if (next === null) {
    if (ctx.fenceCloses === null) ctx.fenceCloses = fenceCloseLines(ctx.texts);
    const { lines, from, to, repeat } = ctx.fenceCloses;
    for (let i = firstIndexAfter(lines, index); i < lines.length; i += 1) {
      const j = lines[i];
      const k = longest(ctx.texts[j], from[i], to[i], repeat[i], 1);
      if (k === null) return null;
      if (settled(j, k)) return j;
    }
    // Every later line was read: none closes the whole run when that was
    // searched for, nor any shorter one when `best` is 0, and the same holds
    // for any later opener with this run.
    if (whole || (shorter && best === 0)) {
      const entry = known ?? { whole: Infinity, shorter: Infinity };
      if (whole) entry.whole = Math.min(entry.whole, index + 1);
      if (shorter && best === 0) entry.shorter = Math.min(entry.shorter, index + 1);
      ctx.fenceMisses.set(run, entry);
    }
    return bestAt;
  }
  for (let j = index + 1; j < ctx.texts.length; j += 1) {
    if (!chargeLookahead(ctx)) return null;
    const v = next(j);
    if (v === null) break;
    const c = fenceCloseRun(v);
    if (c.from === -1) {
      if (!chargeLookahead(ctx, c.read)) return null;
      continue;
    }
    const k = longest(v, c.from, c.to, c.repeat, c.read);
    if (k === null) return null;
    if (settled(j, k)) return j;
  }
  return bestAt;
}

/**
 * Charges `cost` units of work by a search for the end of a fence or block
 * extension (a line read, or characters examined) to the body's lookahead
 * budget (`LOOKAHEAD_PER_LINE`); false once it is spent, and from then on,
 * with `ctx.exhausted` set.
 */
function chargeLookahead(ctx, cost = 1) {
  ctx.lookahead -= cost;
  if (ctx.lookahead < 0) ctx.exhausted = true;
  return !ctx.exhausted;
}

/**
 * Lines of `texts` that can end a block extension at the top level, where
 * every line reads as written: `{ generic, named }`, the ascending indexes of
 * the `{:/}` lines and, per name, of the `{:/name}` lines.
 */
function extensionStopLines(texts) {
  const generic = [];
  const named = new Map();
  for (let j = 0; j < texts.length; j += 1) {
    const m = EXTENSION_STOP_RE.exec(texts[j]);
    if (m === null) continue;
    if (m[1] === undefined) {
      generic.push(j);
    } else {
      if (!named.has(m[1])) named.set(m[1], []);
      named.get(m[1]).push(j);
    }
  }
  return { generic, named };
}

/** Position in the ascending `list` of its first entry greater than `index` (`list.length` when none), in O(log n). */
function firstIndexAfter(list, index) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first entry of the ascending `list` greater than `index`, or -1. */
function firstAfter(list, index) {
  const at = firstIndexAfter(list, index);
  return at < list.length ? list[at] : -1;
}

/**
 * Line of the first `{:/}` or `{:/name}` line after line `index` that ends
 * the block extension `name` opened there, reading the lines as the block
 * holding the opener (the first `depth` open `items`) sees them, or -1 when
 * none does before that block ends; `null` when the lookahead budget ran out
 * first. At the top level every line reads as written, so the answer comes
 * from an index of such lines built once per body (`ctx.extensionStops`)
 * and searched in O(log n); inside list items each line read is charged to
 * the budget.
 */
function extensionClose(ctx, name, index, items, depth) {
  const { texts } = ctx;
  if (depth === 0) {
    if (ctx.extensionStops === null) ctx.extensionStops = extensionStopLines(texts);
    const generic = firstAfter(ctx.extensionStops.generic, index);
    const named = firstAfter(ctx.extensionStops.named.get(name) ?? [], index);
    if (generic === -1) return named;
    return named === -1 || generic < named ? generic : named;
  }
  const stop = new RegExp(`^ {0,3}\\{:/(?:${escapeRegExp(name)})?\\}[ \\t\\r\\f\\v]*$`);
  const next = blockView(texts, index, items, depth);
  for (let j = index + 1; j < texts.length; j += 1) {
    if (!chargeLookahead(ctx)) return null;
    const v = next(j);
    if (v === null) return -1;
    if (stop.test(v)) return j;
  }
  return -1;
}

/** kramdown's element name: known HTML names lowercased, others as written. */
function kramdownName(name) {
  const lower = name.toLowerCase();
  return KNOWN_HTML_ELEMENTS.has(lower) ? lower : name;
}

/** kramdown `HTML_CONTENT_MODEL` of an element: 'block', 'span' or 'raw'. */
function contentModel(name) {
  if (HTML_CONTENT_MODEL_RAW.has(name)) return 'raw';
  if (HTML_CONTENT_MODEL_BLOCK.has(name)) return 'block';
  return HTML_CONTENT_MODEL_SPAN.has(name) ? 'span' : 'raw';
}

/**
 * The `markdown` attribute of a start tag as kramdown reads it ('0', '1',
 * 'span' or 'block'), or null. Attribute names are lowercased only on known
 * elements, and the last occurrence wins.
 */
function markdownMode(attributes, name) {
  let mode = null;
  for (const m of attributes.matchAll(KD_ATTRIBUTE_RE)) {
    const key = KNOWN_HTML_ELEMENTS.has(name) ? m[1].toLowerCase() : m[1];
    if (key !== 'markdown') continue;
    const value = m[2] ?? m[4] ?? '';
    mode = MARKDOWN_ATTR_MODES.has(value) ? value : null;
  }
  return mode;
}

/** The content model kramdown gives an element with this `markdown` mode. */
function modelFor(mode, name, fallback) {
  if (mode === '1') return contentModel(name);
  if (mode === 'span' || mode === 'block') return mode;
  return mode === '0' ? 'raw' : fallback;
}

/**
 * Offset just after the first `</name>` at or after `from` (kramdown builds
 * the pattern with `name` unescaped and matches it case-insensitively), or
 * -1.
 */
function closeTagEnd(body, name, from) {
  const re = new RegExp(`</${name}${RUBY_SPACE}*>`, 'gisu');
  re.lastIndex = from;
  const m = re.exec(body);
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * kramdown `parse_raw_html` from offset `from` inside the element `name`:
 * `offset` is just after the element's close tag, or -1 when the element
 * runs to the end of the body. Start tags open nested elements (`script` and
 * `style` run to their own close tag), a close tag ends the innermost open
 * element only when it names it and is text otherwise, and comments and
 * processing instructions are skipped. `sure` is false when a nested
 * element's `markdown` attribute makes kramdown parse its content as
 * block-level Markdown, whose end this port does not follow.
 */
function rawHtmlEnd(body, from, name) {
  const stack = [name];
  let sure = true;
  let pos = from;
  while (stack.length > 0) {
    KD_RAW_START_RE.lastIndex = pos;
    const start = KD_RAW_START_RE.exec(body);
    if (start === null) return { offset: -1, sure };
    pos = start.index;
    const comment = body.startsWith('<!--', pos) ? body.indexOf('-->', pos + 4) : -1;
    if (comment !== -1) {
      pos = comment + 3;
      continue;
    }
    const instruction = body.startsWith('<?', pos) ? body.indexOf('?>', pos + 2) : -1;
    if (instruction !== -1) {
      pos = instruction + 2;
      continue;
    }
    KD_TAG_RE.lastIndex = pos;
    const tag = KD_TAG_RE.exec(body);
    if (tag !== null) {
      pos += tag[0].length;
      const inner = kramdownName(tag[1]);
      if (inner === 'script' || inner === 'style') {
        pos = closeTagEnd(body, inner, pos);
        if (pos === -1) return { offset: -1, sure };
        continue;
      }
      if (tag[5] !== undefined || HTML_VOID_ELEMENTS.has(inner)) continue;
      const model = modelFor(markdownMode(tag[2], inner), inner, 'raw');
      if (model === 'span') {
        pos = closeTagEnd(body, inner, pos);
        if (pos === -1) return { offset: -1, sure };
        continue;
      }
      if (model === 'block') sure = false;
      stack.push(inner);
      continue;
    }
    KD_TAG_CLOSE_RE.lastIndex = pos;
    const close = KD_TAG_CLOSE_RE.exec(body);
    if (close !== null) {
      pos += close[0].length;
      const top = stack[stack.length - 1];
      if (top === (KNOWN_HTML_ELEMENTS.has(top) ? close[1].toLowerCase() : close[1])) stack.pop();
      continue;
    }
    pos += 1;
  }
  return { offset: pos, sure };
}

/**
 * Candidate ends of the HTML block whose start tag begins at offset `at`, as
 * offsets just past the block (`body.length` when it runs to the end of the
 * body), or null when kramdown reads no block-level start tag there (no
 * complete tag, or an element of running text such as `<span>`): the line is
 * then paragraph text. `inBlock(offset)` tells whether an offset still lies
 * in the block (list item) holding the tag.
 *
 * GitHub Pages leaves kramdown's `parse_block_html` off, so the content is
 * raw HTML (`rawHtmlEnd`): an element left open inside it carries the block
 * past the outer close tag, to the end of the body if nothing closes it
 * (verified). `script` and `style` run to their first close tag, and a void
 * or self-closed tag is the whole block. A `markdown` attribute switches the
 * content to span-level Markdown, which ends at the first close tag, or to
 * block-level Markdown, whose end depends on parsing not modelled here, so
 * every close tag of the element and the end of the body are candidates.
 * So are they when the raw end lies outside the list item holding the tag:
 * kramdown parses an item on its own, and a comment or tag crossing the
 * item's end could end the element elsewhere. A block inside a list item
 * also ends where the item does (see `advance`).
 */
function htmlBlockEnds(body, at, inBlock) {
  KD_TAG_RE.lastIndex = at;
  const tag = KD_TAG_RE.exec(body);
  if (tag === null || HTML_SPAN_ELEMENTS.has(tag[1].toLowerCase())) return null;
  const name = kramdownName(tag[1]);
  const tagEnd = at + tag[0].length;
  const orEnd = (offset) => (offset === -1 ? body.length : offset);
  if (name === 'script' || name === 'style') return [orEnd(closeTagEnd(body, name, tagEnd))];
  if (tag[5] !== undefined || HTML_VOID_ELEMENTS.has(name)) return [tagEnd];
  const model = modelFor(markdownMode(tag[2], name), name, 'raw');
  if (model === 'span') return [orEnd(closeTagEnd(body, name, tagEnd))];
  if (model === 'raw') {
    const end = rawHtmlEnd(body, tagEnd, name);
    if (end.sure && (end.offset === -1 || inBlock(end.offset - 1))) return [orEnd(end.offset)];
  }
  const ends = [];
  const close = new RegExp(`</${escapeRegExp(name)}${RUBY_SPACE}*>`, 'giu');
  close.lastIndex = tagEnd;
  for (let m = close.exec(body); m !== null; m = close.exec(body)) ends.push(m.index + m[0].length);
  ends.push(body.length);
  return ends;
}

/** Line of the first `needle` at or after offset `from`, or -1. */
function lineOfNext(body, lines, needle, from) {
  const at = body.indexOf(needle, from);
  return at === -1 ? -1 : lineIndexAt(lines, at);
}

/* ---- inline code ------------------------------------------------------- */

/*
 * Inline code is masked only where kramdown certainly renders it as code.
 * kramdown parses running text left to right, trying its span parsers in a
 * fixed order at each position, and several of them consume backticks that
 * would otherwise pair into code: tags and their attribute values, raw-content
 * elements such as `<kbd>` or any custom element (whose content kramdown
 * reads as HTML only, so a `<script>` written there inside backticks runs,
 * verified), autolinks, link destinations, inline math and strikethrough
 * (which kramdown parses as a separate piece of text). One misjudged backtick
 * shifts every later pairing and could mask live markup, so the walk below
 * follows kramdown's order exactly for every construct that can consume a
 * backtick, and wherever it cannot be sure (a construct that crosses a line
 * break, markup inside a link destination, a span extension, a backtick on a
 * line not certainly read as running text) it stops masking for the rest of
 * the paragraph. Text that only kramdown's harmless parsers consume
 * (emphasis, quotes, entities, typographic symbols, footnote markers) cannot
 * change the pairing and is walked as plain text. A line kramdown may read
 * as a table row is checked again as table cells (see `tableRowCodes`), and
 * Liquid tags in link destinations are read as the URL text they produce.
 *
 * The walk covers a run of lines between blank lines and fences. Because
 * every construct it accepts ends on the line where it starts, its state is
 * fresh at each line start, as kramdown's is at the start of each paragraph,
 * heading or list item in the run.
 */

/**
 * `s` with every Liquid tag on one line replaced by as many `x`: Liquid runs
 * before kramdown, and the tags used in links and attributes (`relative_url`,
 * `site.baseurl`, `post_url`, `link`) produce plain URL text. A tag holding a
 * backtick or `<` is left as written.
 */
function maskLiquid(s) {
  return s.replace(LIQUID_TAG_RE, (m) => 'x'.repeat(m.length));
}

/** True when `s` holds a character that could start or end markup (Liquid aside). */
function hasSpanDanger(s) {
  return SPAN_DANGER_RE.test(maskLiquid(s));
}

/** True for the characters Ruby's `\s` matches (ASCII whitespace). */
function isRubySpace(ch) {
  return ch !== undefined && RUBY_SPACE_CHAR_RE.test(ch);
}

/** First `needle` at or after `from` and ending by `to`, or -1; remembers misses. */
function findIn(w, needle, from, to) {
  const miss = w.misses.get(needle);
  if (miss !== undefined && from >= miss) return -1;
  const at = w.text.indexOf(needle, from);
  if (at === -1) {
    w.misses.set(needle, Math.min(from, miss ?? Infinity));
    return -1;
  }
  return at + needle.length <= to ? at : -1;
}

/**
 * Index of the first `ch` at or after `from` in `text`, or -1. `seen`
 * (`{ from, at }`) holds the last answer computed and is reused for any
 * `from` it still answers, so queries at increasing offsets read the text
 * once in all.
 */
function nextIndex(seen, text, ch, from) {
  if (seen.from === -1 || from < seen.from || (seen.at !== -1 && from > seen.at)) {
    seen.from = from;
    seen.at = text.indexOf(ch, from);
  }
  return seen.at;
}

/**
 * Length of the kramdown autolink (`KD_AUTOLINK_RE`) at `w.text[p]`, or 0.
 * After a scheme the link ends at the first `>` at least two characters past
 * the colon, with no line feed before it; the next `>` and line feed are
 * found through `w.ahead`, so a line full of unclosed `<https:` reads in
 * linear time. The address form cannot read past a `<` and is matched
 * directly.
 */
function autolinkLength(w, p) {
  const t = w.text;
  const scheme = KD_AUTOLINK_SCHEMES.find((s) => t.startsWith(s, p + 1));
  if (scheme === undefined) {
    KD_AUTOLINK_RE.lastIndex = p;
    const m = KD_AUTOLINK_RE.exec(t);
    return m === null ? 0 : m[0].length;
  }
  const rest = p + 1 + scheme.length;
  const gt = nextIndex(w.ahead.gt, t, '>', rest + 1);
  const lf = nextIndex(w.ahead.lf, t, '\n', rest);
  return gt !== -1 && (lf === -1 || gt < lf) ? gt + 1 - p : 0;
}

/**
 * Charges `cost` characters of scanning to the walk and stops it once its
 * budget, proportional to the text's length, is spent: pathological text
 * then loses masking instead of taking quadratic time.
 */
function charge(w, cost) {
  w.work -= cost;
  if (w.work < 0) w.stopped = true;
  return !w.stopped;
}

/** Enters every line that starts at or before `p`, stopping at a line kramdown may start mid-way. */
function enterLine(w, p) {
  while (w.line + 1 < w.starts.length && w.starts[w.line + 1] <= p) {
    w.line += 1;
    const { resume } = w.info[w.line];
    // Raw HTML ended mid-way along this line and kramdown starts a paragraph
    // after it; markup there could carry over to the next line from a point
    // the walk did not start at.
    if (resume !== -1 && RESUME_DANGER_RE.test(w.texts[w.line].slice(resume))) {
      w.stopped = true;
      return;
    }
  }
  w.lineEnd = w.line + 1 < w.starts.length ? w.starts[w.line + 1] : Infinity;
}

/**
 * Returns `b`, the end of a construct that hides the text it spans, after
 * stopping the walk when the construct crosses a line break or leaves the
 * current text (ends after `to`).
 */
function consumeSpan(w, b, to) {
  if (b > to || b >= w.lineEnd) w.stopped = true;
  return b;
}

/** kramdown `parse_codespan` at a run of backticks. */
function spanCode(w, from, to, p) {
  const t = w.text;
  let q = p;
  while (q < to && t[q] === '`') q += 1;
  if (!w.info[w.line].trusted) {
    w.stopped = true;
    return q;
  }
  const n = q - p;
  // A lone backtick between whitespace (or at the start) is literal.
  if (n === 1 && (p === from || isRubySpace(t[p - 1])) && q < to && isRubySpace(t[q])) return q;
  const close = findIn(w, '`'.repeat(n), q, to);
  if (close === -1) return q;
  if (close >= w.lineEnd) {
    w.stopped = true;
    return q;
  }
  w.codes.push([w.line, p, close + n]);
  return close + n;
}

/** kramdown's parsers at a backslash: typographic `\<<` and `\>>`, line breaks and escapes. */
function spanEscape(w, to, p) {
  const t = w.text;
  if ((t.startsWith('\\<<', p) || t.startsWith('\\>>', p)) && p + 3 <= to) return p + 3;
  return p + 1 < to && ESCAPABLE_GFM.has(t[p + 1]) ? p + 2 : p + 1;
}

/**
 * kramdown `parse_spans(el, stop, [:span_html])` for an element with raw
 * content starting at `from`: the offset just after its close tag, or -1 when
 * it runs to the end of the text or holds an element whose content kramdown
 * parses as Markdown (not followed here). Nested elements stack; only the
 * innermost element's close tag ends anything.
 */
function spanRawEnd(w, from, to, name) {
  const t = w.text;
  const stack = [name];
  let pos = from;
  while (pos < to) {
    if (!charge(w, 1)) return -1;
    KD_RAW_START_RE.lastIndex = pos;
    const start = KD_RAW_START_RE.exec(t);
    if (start === null || start.index >= to) return -1;
    pos = start.index;
    const top = stack[stack.length - 1];
    const stop = new RegExp(`</${escapeRegExp(top)}${RUBY_SPACE}*>`, KNOWN_HTML_ELEMENTS.has(top) ? 'iuy' : 'uy');
    stop.lastIndex = pos;
    const s = stop.exec(t);
    if (s !== null && pos + s[0].length <= to) {
      pos += s[0].length;
      stack.pop();
      if (stack.length === 0) return pos;
      continue;
    }
    const comment = t.startsWith('<!--', pos) ? t.indexOf('-->', pos + 4) : -1;
    if (comment !== -1 && comment + 3 <= to) {
      pos = comment + 3;
      continue;
    }
    const instruction = t.startsWith('<?', pos) ? t.indexOf('?>', pos + 2) : -1;
    if (instruction !== -1 && instruction + 2 <= to) {
      pos = instruction + 2;
      continue;
    }
    KD_TAG_CLOSE_RE.lastIndex = pos;
    const close = KD_TAG_CLOSE_RE.exec(t);
    if (close !== null && pos + close[0].length <= to) {
      pos += close[0].length;
      continue;
    }
    KD_TAG_RE.lastIndex = pos;
    const tag = KD_TAG_RE.exec(t);
    if (tag !== null && pos + tag[0].length <= to) {
      pos += tag[0].length;
      const inner = kramdownName(tag[1]);
      if (HTML_BLOCK_ELEMENTS.has(inner)) continue;
      const mode = markdownMode(tag[2], inner);
      if (mode === 'span' || (mode === '1' && contentModel(inner) !== 'raw')) return -1;
      if (tag[5] === undefined && !HTML_VOID_ELEMENTS.has(inner)) stack.push(inner);
      continue;
    }
    pos += 1;
  }
  return -1;
}

/**
 * kramdown `parse_span_html` (after `parse_autolink`) at a `<`. An autolink
 * on a line every reading treats as running text, within that line, is
 * noted in `w.autolinks` as `[line, start, end)`: kramdown certainly renders
 * it as a link, not as a tag.
 */
function spanAngle(w, to, p) {
  const t = w.text;
  const auto = autolinkLength(w, p);
  if (auto > 0 && p + auto <= to) {
    const end = consumeSpan(w, p + auto, to);
    if (!w.stopped && w.info[w.line].trusted) w.autolinks.push([w.line, p, end]);
    return end;
  }
  const after = p + 1 < to ? String.fromCodePoint(t.codePointAt(p + 1)) : '';
  if (!(SPAN_HTML_NEXT_RE.test(after) || t.startsWith('!--', p + 1))) {
    // Not HTML: `<<` is a typographic symbol, which hides its second `<`.
    return t.startsWith('<<', p) && p + 2 <= to ? p + 2 : p + 1;
  }
  if (t.startsWith('<!--', p)) {
    const close = findIn(w, '-->', p + 4, to);
    return close === -1 ? p + 1 : consumeSpan(w, close + 3, to);
  }
  if (t.startsWith('<?', p)) {
    const close = findIn(w, '?>', p + 2, to);
    return close === -1 ? p + 1 : consumeSpan(w, close + 2, to);
  }
  KD_TAG_CLOSE_RE.lastIndex = p;
  const close = KD_TAG_CLOSE_RE.exec(t);
  if (close !== null) return consumeSpan(w, p + close[0].length, to);
  KD_TAG_RE.lastIndex = p;
  const tag = KD_TAG_RE.exec(t);
  if (tag === null) return p + 1;
  const tagEnd = consumeSpan(w, p + tag[0].length, to);
  if (w.stopped) return tagEnd;
  const name = kramdownName(tag[1]);
  // Block-level tags are written out as text; void and self-closed tags have
  // no content.
  if (HTML_BLOCK_ELEMENTS.has(name) || tag[5] !== undefined || HTML_VOID_ELEMENTS.has(name)) return tagEnd;
  const mode = markdownMode(tag[2], name);
  let parsed = contentModel(name) !== 'raw';
  if (mode === 'span') parsed = true;
  else if (mode === '0') parsed = false;
  // Parsed content is walked as running text (its close tag is skipped like
  // any other); raw content hides every backtick up to the close tag.
  if (parsed) return tagEnd;
  const end = spanRawEnd(w, tagEnd, to, name);
  if (end === -1) {
    w.stopped = true;
    return tagEnd;
  }
  return consumeSpan(w, end, to);
}

/**
 * The link destination kramdown reads at the `(` at `p` (link.rb: `(<…>)`,
 * the parenthesis scan, an optional title) as `{ end, angle }`, `angle`
 * being the length of a leading `(<…>` (0 for none); null when it reads
 * none, and undefined when that depends on text past the current line.
 * Liquid runs before kramdown, so its tags are read as the URL text they
 * produce.
 */
function linkDestination(w, p, to) {
  // Every destination ends with `)`.
  if (findIn(w, ')', p, to) === -1) return null;
  const lim = Math.min(to, w.lineEnd - 1);
  const more = lim < to;
  if (!charge(w, lim - p)) return undefined;
  const seg = maskLiquid(w.text.slice(p, lim));
  const angle = LINK_ANGLE_RE.exec(seg);
  let pos;
  if (angle !== null) {
    pos = angle[0].length;
    if (seg[pos] === ')') return { end: p + pos + 1, angle: pos };
  } else {
    let nr = 0;
    pos = 0;
    LINK_PAREN_RE.lastIndex = 0;
    for (;;) {
      const m = LINK_PAREN_RE.exec(seg);
      if (m === null) {
        if (more) return undefined;
        break;
      }
      pos = m.index + m[0].length;
      if (m[2] !== undefined) {
        nr -= 1;
        if (nr === 0) return { end: p + pos, angle: 0 };
      } else if (m[1] !== undefined) {
        nr += 1;
      } else {
        break;
      }
    }
  }
  const title = LINK_TITLE_RE.exec(seg.slice(pos));
  if (title !== null) return { end: p + pos + title[0].length, angle: angle === null ? 0 : angle[0].length };
  return more ? undefined : null;
}

/**
 * True when the `<` at `lt`, read as running text, opens markup that could
 * reach past it: a comment, a processing instruction or an element whose
 * content kramdown keeps raw.
 */
function opensRawMarkup(w, lt) {
  const t = w.text;
  if (t.startsWith('<!--', lt) || t.startsWith('<?', lt)) return true;
  KD_TAG_RE.lastIndex = lt;
  const tag = KD_TAG_RE.exec(t);
  if (tag === null) return false;
  const name = kramdownName(tag[1]);
  if (HTML_BLOCK_ELEMENTS.has(name) || tag[5] !== undefined || HTML_VOID_ELEMENTS.has(name)) return false;
  const mode = markdownMode(tag[2], name);
  return mode === '0' || (mode !== 'span' && contentModel(name) === 'raw');
}

/**
 * kramdown's link parser after a `]`: a destination `(…)` or a reference
 * `[id]` that follows is consumed when the bracket closes a link. Whether it
 * does is not followed here, so a destination is skipped only when it holds
 * nothing that could change the pairing either way.
 */
function spanLinkTail(w, to, p) {
  const t = w.text;
  LINK_ID_RE.lastIndex = p + 1;
  const id = LINK_ID_RE.exec(t);
  if (id !== null && p + 1 + id[0].length <= to && (p + 1 + id[0].length >= w.lineEnd || hasSpanDanger(id[1]))) {
    w.stopped = true;
    return p + 1;
  }
  if (t[p + 1] !== '(') return p + 1;
  const dest = linkDestination(w, p + 1, to);
  if (dest === null) return p + 1;
  let unsure = dest === undefined;
  if (!unsure && dest.angle === 0) {
    unsure = hasSpanDanger(t.slice(p + 2, dest.end - 1));
  } else if (!unsure) {
    // An angle-bracketed URL is read without its brackets, but if the
    // bracket closes no link the `<` is running text.
    const inner = t.slice(p + 3, p + dest.angle) + t.slice(p + 1 + dest.angle, dest.end - 1);
    unsure = hasSpanDanger(inner) || opensRawMarkup(w, p + 2);
  }
  if (unsure) {
    w.stopped = true;
    return p + 1;
  }
  return dest.end;
}

/** kramdown `parse_inline_math` at `$$`. */
function spanMath(w, to, p) {
  const close = findIn(w, '$$', p + 2, to);
  return close === -1 ? p + 1 : consumeSpan(w, close + 2, to);
}

/** kramdown `parse_span_extensions` at `{:`. */
function spanBrace(w, to, p) {
  const t = w.text;
  // `{::name}` and `{:/name}` extensions can turn the rest of the paragraph
  // into raw output.
  if (t[p + 2] === ':' || t[p + 2] === '/') {
    w.stopped = true;
    return p + 2;
  }
  // A span attribute list `{:…}` is consumed after an element and is text
  // otherwise; either way it cannot change the pairing unless it holds
  // markup.
  if (findIn(w, '}', p + 2, to) === -1) return p + 1;
  let q = p + 2;
  while (q < to && t[q] !== '}') q += t[q] === '\\' && t[q + 1] === '}' ? 2 : 1;
  if (!charge(w, q - p)) return p + 1;
  // kramdown backtracks to an escaped `\}` when nothing else closes the list.
  if (q >= to) {
    if (t.slice(p + 2, to).includes('\\}')) w.stopped = true;
    return p + 1;
  }
  if (q === p + 2) return p + 1;
  if (q >= w.lineEnd || hasSpanDanger(t.slice(p + 2, q))) {
    w.stopped = true;
    return p + 1;
  }
  return q + 1;
}

/** kramdown-parser-gfm `parse_strikethrough_gfm` at `~~`: its content is parsed on its own. */
function spanStrike(w, to, p) {
  const t = w.text;
  if (p + 2 >= to || isRubySpace(t[p + 2]) || t[p + 2] === '~') return p + 1;
  const miss = w.misses.get('strike');
  if (miss !== undefined && p + 2 >= miss) return p + 1;
  STRIKE_END_RE.lastIndex = p + 2;
  const m = STRIKE_END_RE.exec(t);
  if (m === null) {
    w.misses.set('strike', Math.min(p + 2, miss ?? Infinity));
    return p + 1;
  }
  if (m.index + 3 > to) return p + 1;
  const end = consumeSpan(w, m.index + 3, to);
  if (!w.stopped) walkSpans(w, p + 2, end - 2);
  return end;
}

/** Walks the text from `from` to `to` (one piece of text kramdown parses on its own). */
function walkSpans(w, from, to) {
  const t = w.text;
  let p = from;
  while (p < to && !w.stopped) {
    SPAN_SPECIAL_RE.lastIndex = p;
    const m = SPAN_SPECIAL_RE.exec(t);
    if (m === null || m.index >= to) return;
    p = m.index;
    if (p >= w.lineEnd) {
      enterLine(w, p);
      if (w.stopped) return;
    }
    const c = t[p];
    if (c === '`') p = spanCode(w, from, to, p);
    else if (c === '\\') p = spanEscape(w, to, p);
    else if (c === '<') p = spanAngle(w, to, p);
    else if (c === ']') p = spanLinkTail(w, to, p);
    else if (c === '$') p = t[p + 1] === '$' ? spanMath(w, to, p) : p + 1;
    else if (c === '{') p = t[p + 1] === ':' ? spanBrace(w, to, p) : p + 1;
    else p = t[p + 1] === '~' ? spanStrike(w, to, p) : p + 1;
  }
}

/** A walk over one piece of text whose lines are all certainly running text. */
function walkText(text) {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const w = {
    text,
    texts: text.split('\n'),
    info: lineStarts.map(() => ({ trusted: true, resume: -1 })),
    starts: lineStarts,
    line: -1,
    lineEnd: 0,
    stopped: false,
    codes: [],
    autolinks: [],
    misses: new Map(),
    ahead: { gt: { from: -1, at: -1 }, lf: { from: -1, at: -1 } },
    work: SPAN_WORK_PER_CHAR * text.length + SPAN_WORK_BASE,
  };
  walkSpans(w, 0, text.length);
  return w;
}

/**
 * The code spans among `codes` (`[start, end)` columns found on a line read
 * as running text) that are also code if kramdown reads the line as a table
 * row (table.rb). kramdown first splits the row around literal
 * `<code>…</code>` elements, then finds code spans with no other parser
 * (escapes included) and writes each back with a delimiter one backtick
 * longer than its longest inner run, padded with spaces when longer than one;
 * it splits the rest at unescaped pipes, trims every cell and parses it on its
 * own. A lone backtick that opens a trimmed cell before whitespace is then
 * literal, so such a cell renders the HTML inside it (verified). Each cell is
 * rebuilt the same way and walked, and a span is kept only when its rewrite
 * is code there. The row's trailing spaces and tabs and each cell's
 * surrounding `rubyStrip` characters are removed in one pass each.
 */
function tableRowCodes(text, codes) {
  if (text.includes('<code')) return [];
  const row = trimSpaceTabEnd(text);
  const spans = [];
  for (let i = 0; i < row.length;) {
    if (row[i] !== '`') {
      i += 1;
      continue;
    }
    let q = i;
    while (q < row.length && row[q] === '`') q += 1;
    const n = q - i;
    const literal = n === 1 && (i === 0 || isRubySpace(row[i - 1])) && isRubySpace(row[q]);
    const close = literal ? -1 : row.indexOf('`'.repeat(n), q);
    if (close === -1) {
      i = q;
      continue;
    }
    spans.push([i, close + n]);
    i = close + n;
  }
  // Rebuild the cells, noting where each span's rewrite lands.
  const cells = [''];
  const placed = new Map();
  let from = 0;
  const addRaw = (raw) => {
    const parts = raw.split(/(?<!\\)\|/).map((part) => part.replace(/\\\|/g, '|'));
    cells[cells.length - 1] += parts[0];
    for (const part of parts.slice(1)) cells.push(part);
  };
  for (const [a, b] of spans) {
    addRaw(row.slice(from, a));
    const original = row.slice(a, b);
    let n = 0;
    while (original[n] === '`') n += 1;
    let value = original.slice(n, original.length - n);
    if (n > 1 && value.startsWith(' ')) value = value.slice(1);
    if (n > 1 && value.endsWith(' ')) value = value.slice(0, -1);
    let longest = 0;
    for (const run of value.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    const delimiter = '`'.repeat(longest + 1);
    const pad = delimiter.length > 1 ? ' ' : '';
    const rewrite = `${delimiter}${pad}${value}${pad}${delimiter}`;
    placed.set(`${a},${b}`, { cell: cells.length - 1, at: cells[cells.length - 1].length, length: rewrite.length });
    cells[cells.length - 1] += rewrite;
    from = b;
  }
  addRaw(row.slice(from));
  const cellCodes = cells.map((cell) => {
    const trimmed = rubyStrip(cell);
    const lead = cell.length - cell.replace(/^[\0\t\n\v\f\r ]+/, '').length;
    return new Set(walkText(trimmed).codes.map(([, a, b]) => `${a + lead},${b + lead}`));
  });
  return codes.filter(([a, b]) => {
    const where = placed.get(`${a},${b}`);
    return where !== undefined && cellCodes[where.cell].has(`${where.at},${where.at + where.length}`);
  });
}

/**
 * Inline code spans of the run of lines `s`…`e` (non-blank, outside fences),
 * as `[line, start, end)` with columns into each line's text. `info[j]`
 * holds whether line `j` is certainly running text (`trusted`) and the
 * column where block parsing resumed after raw HTML on it (`resume`, or -1).
 * The autolinks kramdown certainly renders as links (see `spanAngle`) are
 * added to `autolinks` in the same form; on a line kramdown may read as a
 * table row, only those holding no `|`, where it splits the row into cells.
 */
function runCodeSpans(texts, info, s, e, autolinks) {
  const starts = [];
  let length = 0;
  for (let j = s; j <= e; j += 1) {
    starts.push(length);
    length += texts[j].length + 1;
  }
  const w = {
    text: texts.slice(s, e + 1).join('\n'),
    texts: texts.slice(s, e + 1),
    info: info.slice(s, e + 1),
    starts,
    line: -1,
    lineEnd: 0,
    stopped: false,
    codes: [],
    autolinks: [],
    misses: new Map(),
    ahead: { gt: { from: -1, at: -1 }, lf: { from: -1, at: -1 } },
    work: SPAN_WORK_PER_CHAR * length + SPAN_WORK_BASE,
  };
  walkSpans(w, 0, w.text.length);
  const tableLines = new Map();
  const isTableLine = (k) => {
    if (!tableLines.has(k)) tableLines.set(k, TABLE_LINE_RE.test(w.texts[k]));
    return tableLines.get(k);
  };
  for (const [k, a, b] of w.autolinks) {
    if (isTableLine(k) && w.text.slice(a, b).includes('|')) continue;
    autolinks.push([s + k, a - starts[k], b - starts[k]]);
  }
  const out = [];
  const byLine = new Map();
  for (const [k, a, b] of w.codes) {
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push([a - starts[k], b - starts[k]]);
  }
  for (const [k, codes] of byLine) {
    const text = w.texts[k];
    for (const [a, b] of TABLE_LINE_RE.test(text) ? tableRowCodes(text, codes) : codes) out.push([s + k, a, b]);
  }
  return out;
}

/**
 * Inline code regions of every run of lines between blank lines and fences.
 * The autolinks the same walks find are added to `ctx.autolinks` as
 * `{ start, end }` offsets in the body.
 */
function inlineCodeRegions(ctx, info) {
  const { lines, texts } = ctx;
  const out = [];
  const autolinks = [];
  const isBreak = (j) => info[j].code || BLANK_LINE_RE.test(texts[j]);
  for (let s = 0; s < info.length; s += 1) {
    if (isBreak(s)) continue;
    let e = s;
    while (e + 1 < info.length && !isBreak(e + 1)) e += 1;
    for (const [line, a, b] of runCodeSpans(texts, info, s, e, autolinks)) {
      out.push({ start: lines[line].start + a, end: lines[line].start + b, kind: 'inline' });
    }
    s = e;
  }
  for (const [line, a, b] of autolinks) ctx.autolinks.push({ start: lines[line].start + a, end: lines[line].start + b });
  return out;
}

/* ---- readings ---------------------------------------------------------- */

/**
 * One reading of the body. While `skipTo` ≥ the current line it is inside a
 * fence (`skipKind` 'code') or raw content ('raw') held by the first
 * `skipDepth` list items; `resume` is the offset where raw content ends part
 * way along line `skipTo`, after which kramdown parses the rest of that line
 * as a new block, or -1. Otherwise it reads blocks. `items` are the open list
 * items (outermost first), `lazy` marks a run that an unmodelled block may
 * continue lazily, `afterBlank` that the previous line was blank, and `para`
 * that the previous line was running text the next line may continue.
 */
function reading(fields) {
  return {
    skipTo: -1,
    skipKind: null,
    skipDepth: 0,
    resume: -1,
    items: [],
    lazy: false,
    afterBlank: true,
    para: false,
    ...fields,
  };
}

function readingKey(r) {
  const items = r.items.map((it) => `${it.indent}${it.kind[0]}${it.nested ? 'n' : ''}`).join(',');
  return `${r.skipTo}|${r.skipKind}|${r.skipDepth}|${r.resume}|${r.lazy}|${r.afterBlank}|${r.para}|${items}`;
}

/** A successor reading the line as text; in a lazy run its inline code is uncertain. */
function textStep(next) {
  return { cls: next.lazy ? 'text' : 'trusted', next };
}

/** A successor reading the line as text that an unmodelled block may hold. */
function lazyTextStep(r) {
  return textStep({ ...r, lazy: true, para: true });
}

/** A successor entering a fence ('code') or raw content ('raw') that lasts through line `to`. */
function skip(next, to, kind, resume = -1) {
  return {
    cls: kind,
    next: { ...next, lazy: false, para: false, skipTo: to, skipKind: kind, skipDepth: next.items.length, resume },
  };
}

/**
 * Advances one reading by line `index` and returns its successors, each as
 * `{ cls, next, resume }` where `cls` classifies the line: 'code' (inside a
 * fence), 'raw' (raw HTML or extension content), 'text', or 'trusted'
 * (running text outside any lazy run), and `resume`, when present, is the
 * column where raw content ended part way along the line.
 */
function advance(r, index, ctx) {
  const text = ctx.texts[index];
  if (BLANK_LINE_RE.test(text)) {
    const next = { ...r, items: blankLineItems(r.items), afterBlank: true, para: false };
    if (r.skipTo >= index) {
      const done = r.skipTo === index ? { ...next, skipTo: -1, skipKind: null, resume: -1 } : next;
      return [{ cls: r.skipKind, next: done }];
    }
    return [{ cls: 'text', next: { ...next, lazy: false } }];
  }

  if (r.skipTo >= index) {
    const step = extractLine(r.items.slice(0, r.skipDepth), text, r.afterBlank);
    if (step.cut >= r.skipDepth) {
      const next = { ...r, items: step.items, afterBlank: false };
      if (r.skipTo > index) return [{ cls: r.skipKind, next }];
      const done = { ...next, skipTo: -1, skipKind: null, resume: -1 };
      if (r.resume === -1) return [{ cls: r.skipKind, next: done }];
      return resumeLine(done, index, r.resume - ctx.lines[index].start, ctx);
    }
    // The list item holding raw content ended first; kramdown closes the
    // raw block there, and this line is read normally.
    r = { ...r, skipTo: -1, skipKind: null, resume: -1 };
  }

  const step = extractLine(r.items, text, r.afterBlank);
  // A line that ends list content starts a new block in an outer one.
  const base = { ...r, items: step.items, afterBlank: false, para: r.para && step.cut === r.items.length };
  // In an unmodelled lazy run a list marker may also be plain continuation;
  // a sibling item is certain, since kramdown's list loop sees it first.
  return blockStart(base, index, step.view, ctx, step.sibling === -1 && base.lazy);
}

/**
 * Reads line `index` as a block start in the innermost open block, `view`
 * being the line as that block sees it: a list marker opens an item whose
 * first line starts the item's content.
 */
function blockStart(base, index, view, ctx, markerMayBeText) {
  const listStart = LIST_START_RE.exec(view);
  if (!listStart || HR_LINE_RE.test(view)) return blockLine(base, index, view, false, ctx);
  const item = openItem(listStart);
  const out = blockLine({ ...base, items: [...base.items, item], para: false }, index, item.content, true, ctx);
  if (markerMayBeText) {
    for (const successor of blockLine(base, index, view, false, ctx)) out.push(successor);
  }
  return out;
}

/**
 * Successors of line `index` when raw content ended at column `col` with
 * more text after it on the line: kramdown parses that text as a new block
 * (a fence, an HTML block, a list item, a paragraph; verified), and the
 * line itself counts as raw. A line holding more such restarts than the
 * per-line budget allows is left uncertain.
 */
function resumeLine(r, index, col, ctx) {
  const next = { ...r, lazy: false, para: false };
  if (ctx.budget <= 0) return [{ cls: 'raw', next: { ...next, lazy: true, para: true }, resume: col }];
  ctx.budget -= 1;
  const rest = ctx.texts[index].slice(col);
  return blockStart(next, index, rest, ctx, false).map((s) => ({ cls: 'raw', next: s.next, resume: col }));
}

/**
 * Successors of a reading whose raw content (an HTML block or comment)
 * starts on line `index` and ends just before offset `end`; kramdown skips
 * whitespace after it, and anything else left on that line starts a block.
 */
function rawUntil(r, index, end, ctx) {
  const { body, lines, texts } = ctx;
  const last = end >= body.length ? lines.length - 1 : lineIndexAt(lines, end - 1);
  const col = end - lines[last].start;
  const resume = col < texts[last].length && !BLANK_LINE_RE.test(texts[last].slice(col)) ? end : -1;
  if (last > index) return [skip(r, last, 'raw', resume)];
  if (resume === -1) return [skip(r, index, 'raw')];
  return resumeLine(r, index, col, ctx);
}

/**
 * Classifies one line read as the start of a block (or a continuation) in
 * the innermost open block, with `view` the line as that block sees it: the
 * line's text after any indentation the block removes, possibly re-indented
 * (de-indentation may expand tabs), or the part of it after raw HTML.
 */
function blockLine(r, index, view, fresh, ctx) {
  const { body, lines, texts } = ctx;
  const depth = r.items.length;
  const indentOf = (v) => (/^[ \t]*/.exec(v)[0].includes('\t') ? Infinity : leadingSpaces(v));
  // Offset in `body` of column `k` of `view`, for any column after the
  // view's leading whitespace.
  const offsetOf = (k) => lines[index].start + texts[index].length - view.length + k;
  // Whether `offset` lies in the block (list item) holding this line.
  const inBlock = (offset) => {
    const j = lineIndexAt(lines, offset);
    return depth === 0 || j <= index || blockView(texts, index, r.items, depth)(j) !== null;
  };

  // Fenced code. A search the lookahead budget cut short leaves the line
  // uncertain, and `findCodeRegions` stops masking after it.
  if (FENCE_START_RE.test(view)) {
    const close = kramdownFenceClose(ctx, view, index, depth === 0 ? null : blockView(texts, index, r.items, depth));
    if (close === null) return [lazyTextStep(r)];
    if (close === -1) return [textStep({ ...r, para: true })];
    const opened = skip(r, close, 'code');
    if (!r.lazy || fresh) return [opened];
    // A fence in a lazy run may be swallowed by the block before it; it may
    // also be a top-level fence if the run is not what it seems. When the
    // budget cuts that search short, the text reading below already keeps
    // the line uncertain and masking stops after it.
    const out = [opened];
    if (depth > 0) {
      const top = kramdownFenceClose(ctx, texts[index], index, null);
      if (top !== null && top !== -1 && top !== close) out.push(skip({ ...r, items: [] }, top, 'code'));
    }
    out.push(lazyTextStep(r));
    return out;
  }

  // Raw content: kramdown block extensions, math blocks, HTML comments and
  // HTML blocks. None of the first three ends a running paragraph, and
  // neither do `script`, `style` or names starting like those of running
  // text (kramdown `LAZY_END_HTML_START`): after such a paragraph line the
  // line may be part of the paragraph instead.
  const ext = BLOCK_EXTENSION_RE.exec(view);
  if (ext && ext[2] !== '/') {
    const stop = extensionClose(ctx, ext[1], index, r.items, depth);
    if (stop === null) return [lazyTextStep(r)];
    if (stop !== -1) {
      const raw = skip(r, stop, 'raw');
      return RAW_EXTENSIONS.has(ext[1]) && !r.para ? [raw] : [raw, lazyTextStep(r)];
    }
  }
  if (MATH_BLOCK_RE.test(view)) {
    const from = offsetOf(view.indexOf('$$')) + 2;
    const end = lineOfNext(body, lines, '$$', from);
    if (end !== -1) return [skip(r, end, 'raw'), lazyTextStep(r)];
  }
  if (view.startsWith('<!--')) {
    // kramdown reads a comment block only with `<!--` at the very start of
    // the block; an indented one is running text (verified).
    const at = offsetOf(0);
    const close = body.indexOf('-->', at + 4);
    if (close !== -1) {
      const out = rawUntil(r, index, close + 3, ctx);
      if (r.para || !inBlock(close + 2)) out.push(lazyTextStep(r));
      return out;
    }
  } else if (HTML_BLOCK_TAG_RE.test(view)) {
    const lt = view.indexOf('<');
    const ends = htmlBlockEnds(body, offsetOf(lt), inBlock);
    if (ends !== null) {
      const out = ends.flatMap((end) => rawUntil(r, index, end, ctx));
      // Several candidate ends mean Markdown content kramdown may parse.
      if (ends.length > 1 || (r.para && !LAZY_END_HTML_START_RE.test(view.slice(lt)))) out.push(lazyTextStep(r));
      return out;
    }
  }

  // Blocks that continue lazily without being modelled here.
  const next = { ...r, para: !HR_LINE_RE.test(view) };
  if (indentOf(view) > 3 || LAZY_CONTAINER_RE.test(view)) next.lazy = true;
  return [textStep(next)];
}

/**
 * Code regions of a Markdown body, as sorted, non-overlapping
 * `{ start, end, kind: 'fence' | 'inline' }` offsets into `body`. When
 * `found` is given, `found.autolinks` is set to the `{ start, end }` offsets
 * of the autolinks kramdown certainly renders as links (see `spanAngle`), in
 * the same lines and under the same rules as inline code, and
 * `found.trustedLines` to the set of start offsets of the lines every reading
 * treats as running text outside a lazy run (never raw HTML, code or the
 * content of an extension).
 *
 * - Fenced blocks span whole lines, opening and closing fence included. A
 *   fence must be closed; CommonMark would run an unclosed fence to the end,
 *   but kramdown renders the HTML after it (verified). Fences inside list
 *   items follow kramdown's item extraction, lazy lines included.
 * - Raw HTML blocks, HTML comments, math blocks and `{::nomarkdown}` or
 *   `{::comment}` extensions are never code: kramdown passes their content
 *   through, fences included, so a `<script>` inside `<details>` runs even
 *   when written between fence lines (verified). Raw HTML that ends part way
 *   along a line is followed by a new block on the rest of that line, which
 *   may open a fence or another HTML block (verified).
 * - After a blockquote, definition or footnote line, or an indented line,
 *   kramdown may continue that block lazily and swallow a fence ("> Note"
 *   then a fence renders the HTML inside it, verified); such fences are only
 *   possibilities.
 * - Inline code (see `walkSpans`) counts only where kramdown's span parsing
 *   certainly reads it as code, on lines every reading treats as running
 *   text outside a lazy run.
 * - Indented (4-space) code blocks and fences inside blockquotes are not
 *   treated as code; their content is scanned as prose, which can only
 *   produce a false finding.
 * - A `{::options}` extension can change how kramdown parses everything
 *   after it, and kramdown reads a lone carriage return as a line break; in
 *   either case nothing from that point on is treated as code.
 * - When more readings stay open than `MAX_HYPOTHESES`, nothing after the
 *   line is treated as code. When a search for the end of a fence (at any
 *   depth) or of an extension inside list items finds the lookahead budget
 *   (`LOOKAHEAD_PER_LINE`) spent, the line itself is left uncertain too and
 *   nothing after it is treated as code: an unknown end could shift every
 *   later pairing.
 */
function findCodeRegions(body, found = null) {
  const lines = splitLines(body);
  const texts = lines.map((line) => stripCr(line.text));
  const ctx = {
    body,
    lines,
    texts,
    autolinks: [],
    budget: 0,
    fenceMisses: new Map(),
    fenceCloses: null,
    extensionStops: null,
    lookahead: LOOKAHEAD_PER_LINE * lines.length + LOOKAHEAD_PER_CHAR * body.length + LOOKAHEAD_BASE,
    exhausted: false,
  };
  const loneCr = body.search(/\r(?!\n)/);
  const options = body.search(OPTIONS_EXTENSION_RE);
  const stopAt = Math.min(
    loneCr === -1 ? lines.length : lineIndexAt(lines, loneCr),
    options === -1 ? lines.length : lineIndexAt(lines, options),
  );
  const regions = [];
  const info = [];
  let readings = [reading({})];
  let codeFrom = -1;
  const closeCode = (last) => {
    if (codeFrom !== -1 && last >= codeFrom) {
      regions.push({ start: lines[codeFrom].start, end: lines[last].end, kind: 'fence' });
    }
    codeFrom = -1;
  };
  for (let index = 0; index < stopAt; index += 1) {
    ctx.budget = RESUME_BUDGET;
    const successors = new Map();
    let code = 0;
    let trusted = 0;
    let total = 0;
    let resume = -1;
    for (const r of readings) {
      for (const s of advance(r, index, ctx)) {
        total += 1;
        if (s.cls === 'code') code += 1;
        else if (s.cls === 'trusted') trusted += 1;
        if (s.resume !== undefined && (resume === -1 || s.resume < resume)) resume = s.resume;
        successors.set(readingKey(s.next), s.next);
      }
    }
    const isCode = total > 0 && code === total;
    info.push({ code: isCode, trusted: total > 0 && trusted === total, resume });
    if (isCode) {
      if (codeFrom === -1) codeFrom = index;
    } else {
      closeCode(index - 1);
    }
    readings = [...successors.values()];
    if (readings.length > MAX_HYPOTHESES || ctx.exhausted) break;
  }
  closeCode(info.length - 1);
  for (const region of inlineCodeRegions(ctx, info)) regions.push(region);
  if (found !== null) {
    found.autolinks = ctx.autolinks.sort((a, b) => a.start - b.start);
    found.trustedLines = new Set();
    for (let k = 0; k < info.length; k += 1) if (info[k].trusted) found.trustedLines.add(lines[k].start);
  }
  return regions.sort((a, b) => a.start - b.start);
}

/**
 * Returns `body` with every character inside a code region, except line
 * breaks, replaced by a space. The result has the same length and line
 * structure, so offsets and line numbers found in it are valid in `body`.
 */
function maskCode(body, regions) {
  if (regions.length === 0) return body;
  let out = '';
  let pos = 0;
  for (const r of regions) {
    out += body.slice(pos, r.start) + body.slice(r.start, r.end).replace(/[^\r\n]/g, ' ');
    pos = r.end;
  }
  return out + body.slice(pos);
}

/**
 * End offsets in `text` of the tags whose attributes begin at the offsets
 * `tagFrom` and of the attribute lists whose content begins at `listFrom`
 * (both ascending), as `{ tagEnds, listEnds }` parallel to them:
 *   - a tag ends at the `>` that closes it, skipping `>` inside quoted
 *     attribute values, or, when a quote is left open, at the first `>`
 *     after its name (as a browser would recover); -1 when no `>` follows;
 *   - a list ends at the `}` that closes it, where a backslash escapes the
 *     next character; -1 when none.
 * One backward pass from the end of the text down to the smallest queried
 * offset answers every query and keeps only scalars, so a body full of
 * unclosed `<` or `{:` cannot make a scan quadratic, memory grows with the
 * number of queries only, and no query means no pass.
 */
function extentEnds(text, tagFrom, listFrom) {
  const n = text.length;
  const tagEnds = tagFrom.map(() => -1);
  const listEnds = listFrom.map(() => -1);
  let t = tagFrom.length - 1;
  let l = listFrom.length - 1;
  // Nothing closes at or past the end of the text.
  while (t >= 0 && tagFrom[t] >= n) t -= 1;
  while (l >= 0 && listFrom[l] >= n) l -= 1;
  // Each holds its value for offset i + 1 when character i is read: `gt` is
  // the first `>`; `quoted` the end of a tag whose attributes begin there;
  // `lastDouble` (`lastSingle`) the first `"` (`'`) and `afterDouble`
  // (`afterSingle`) the `quoted` value just past it; `brace` the end of a
  // list, and `braceAfter` that value for offset i + 2.
  let gt = -1;
  let quoted = -1;
  let lastDouble = -1;
  let afterDouble = -1;
  let lastSingle = -1;
  let afterSingle = -1;
  let brace = -1;
  let braceAfter = -1;
  for (let i = n - 1; i >= 0 && (t >= 0 || l >= 0); i -= 1) {
    const c = text[i];
    if (c === '>') {
      gt = i;
      quoted = i;
    } else if (c === '"') {
      const close = lastDouble === -1 ? -1 : afterDouble;
      afterDouble = quoted;
      lastDouble = i;
      quoted = close;
    } else if (c === "'") {
      const close = lastSingle === -1 ? -1 : afterSingle;
      afterSingle = quoted;
      lastSingle = i;
      quoted = close;
    }
    let end = brace;
    if (c === '}') end = i;
    else if (c === '\\') end = braceAfter;
    braceAfter = brace;
    brace = end;
    for (; t >= 0 && tagFrom[t] === i; t -= 1) tagEnds[t] = quoted !== -1 ? quoted : gt;
    for (; l >= 0 && listFrom[l] === i; l -= 1) listEnds[l] = brace;
  }
  return { tagEnds, listEnds };
}

/**
 * Tags whose `<` lies outside code (starts of `tagRe`, which must carry the
 * `g` flag) and, when `withLists` is set, kramdown attribute lists whose
 * `{:` does, as `{ tags, lists }`: arrays of `{ start, end }` ordered by
 * start, `end` being the offset of the closing `>` or `}`; constructs that
 * never close are left out. Starts are found in the masked text, but the
 * extents come from the original text: kramdown parses an HTML tag from its
 * `<`, so backticks inside its attributes are not code
 * (`<img title="`" onerror="…" alt="`">` keeps its `onerror`, verified).
 */
function markupOutsideCode(body, masked, tagRe, withLists = false) {
  const tagStarts = [];
  const tagFrom = [];
  for (const m of masked.matchAll(tagRe)) {
    tagStarts.push(m.index);
    tagFrom.push(m.index + m[0].length);
  }
  const listStarts = [];
  if (withLists) for (const m of masked.matchAll(IAL_START_RE)) listStarts.push(m.index);
  const { tagEnds, listEnds } = extentEnds(body, tagFrom, listStarts.map((start) => start + 2));
  const closed = (starts, ends) => {
    const out = [];
    for (let k = 0; k < starts.length; k += 1) if (ends[k] !== -1) out.push({ start: starts[k], end: ends[k] });
    return out;
  };
  return { tags: closed(tagStarts, tagEnds), lists: closed(listStarts, listEnds) };
}


/* ------------------------------------------------------------------------ */
/* Front matter                                                              */
/* ------------------------------------------------------------------------ */

const FM_DELIMITER_RE = /^---[ \t]*$/;
const FM_BLANK_RE = /^[ \t]*$/;
const FM_COMMENT_RE = /^[ \t]*#/;
/** The `key:` that opens a `key: value` line (see `readKeyLine`). Group 1: the key. */
const FM_KEY_RE = /^([a-z_][a-z0-9_]*):/;
/** The characters a front-matter value may not hold: JavaScript's line terminators. */
const FM_LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;
const FM_TRAILER_RE = /^(?:[ \t]*|[ \t]+#.*)$/;
const FLOW_BARE_ITEM_RE = /[^,[\]{}"'#]+/y;
const NOT_CLOSED_QUOTE = 'a double-quoted string must close on the same line';
const NOT_CLOSED_LIST = 'a flow list must close with ] on the same line, as in tags: [a, b]';

/*
 * How Jekyll 3.10 types an unquoted (plain) YAML scalar: it reads front matter
 * with SafeYAML 1.0.5, whose transformers run in the order below (symbols are
 * off, as Jekyll leaves them). The patterns are the gem's own, with Ruby's
 * `\A`/`\Z` written as `^`/`$` and its `\s` as `RUBY_SPACE`.
 */
/** `ToInteger` matchers, tried after `_` and `,` are removed from the value. */
const YAML_INTEGER_RES = [
  /^[-+]?(?:0|[1-9][0-9_,]*)$/,
  /^0[0-7]+$/,
  /^0x[0-9a-f]+$/i,
  /^0b[01_]+$/,
  /^[-+]?0x[0-9a-fA-F_]+$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
];
/**
 * `ToFloat` matchers, tried on the value as written. A match whose digits
 * Ruby's `Float()` refuses (`1__0.5`) fails the whole load instead.
 */
const YAML_FLOAT_RES = [
  /^[-+]?(?:\d[\d_]*)?\.[\d_]+(?:[eE][-+]\d+)?$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
];
const YAML_FLOAT_WORDS = new Set(['.inf', '.Inf', '.INF', '-.inf', '-.Inf', '-.INF', '.nan', '.NaN', '.NAN']);
const YAML_NULL_RE = /^(?:~|null)$/i;
const YAML_BOOLEAN_RE = /^(?:yes|no|on|off|true|false)$/i;
const YAML_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YAML_TIME_RE = new RegExp(
  `^(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:[Tt]|${RUBY_SPACE}+)(\\d{1,2}):(\\d{2}):(\\d{2})(?:\\.\\d*)?`
  + `${RUBY_SPACE}*(?:Z|[-+]\\d{1,2}(?::?\\d{2})?)?$`,
);

/** Defines an own enumerable property, so a key such as `__proto__` cannot alter the prototype. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Reads a front-matter line as `key: value`: a lowercase key, a colon, and
 * then either nothing or a space or tab followed by the value. Returns
 * `{ key, value }`, with the value stripped of the spaces and tabs around it
 * (`''` when nothing else follows the colon), or null when the line is not
 * of that form or its value holds a line terminator (`\n`, `\r`, U+2028 or
 * U+2029). Each character is read at most twice, so time is linear in the
 * line's length.
 */
function readKeyLine(line) {
  const m = FM_KEY_RE.exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  if (FM_LINE_TERMINATOR_RE.test(rest)) return null;
  let from = 0;
  while (from < rest.length && (rest[from] === ' ' || rest[from] === '\t')) from += 1;
  return { key: m[1], value: trimSpaceTabEnd(rest.slice(from)) };
}

/**
 * Reads the double-quoted string that starts at `s[start]`. Only `\"` and
 * `\\` escapes are accepted. Returns `{ value, end }` (index after the
 * closing quote) or `{ error }`.
 */
function readQuoted(s, start) {
  let out = '';
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c === '\\') {
      const next = s[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (next === undefined) return { error: NOT_CLOSED_QUOTE };
      return { error: `unsupported escape \\${next} in a double-quoted string; only \\" and \\\\ are allowed` };
    }
    out += c;
    i += 1;
  }
  return { error: NOT_CLOSED_QUOTE };
}

/**
 * True when Ruby's `Date` (which SafeYAML builds dates and times with) accepts
 * the day: the Julian calendar before 1582-10-15 and the Gregorian one from
 * then on, so 1582-10-05 to 1582-10-14 do not exist.
 */
function isRubyCivilDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  if (year === 1582 && month === 10 && day >= 5 && day <= 14) return false;
  const leap = year < 1582 ? year % 4 === 0 : (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * What Jekyll's YAML loader makes of the plain scalar `value`: `null` when it
 * stays text, otherwise `'null'`, `'a boolean'`, `'a number'`, `'a date'` or
 * `'a time'`. A date or time Ruby cannot build stays text, as SafeYAML keeps
 * the string when `Date.parse` fails. `value` is the scalar as YAML reads it:
 * one line, without surrounding spaces and tabs.
 */
function plainScalarKind(value) {
  const digits = value.replace(/[_,]/g, '');
  if (YAML_INTEGER_RES.some((re) => re.test(digits))) return 'a number';
  if (YAML_FLOAT_RES.some((re) => re.test(value)) || YAML_FLOAT_WORDS.has(value)) return 'a number';
  if (YAML_NULL_RE.test(value)) return 'null';
  if (YAML_BOOLEAN_RE.test(value)) return 'a boolean';
  const date = YAML_DATE_RE.exec(value);
  if (date) return isRubyCivilDate(Number(date[1]), Number(date[2]), Number(date[3])) ? 'a date' : null;
  const time = YAML_TIME_RE.exec(value);
  if (time) {
    const [hour, minute, second] = [time[4], time[5], time[6]].map(Number);
    const validTime = hour <= 24 && minute <= 59 && second <= 60 && (hour < 24 || (minute === 0 && second === 0));
    return validTime && isRubyCivilDate(Number(time[1]), Number(time[2]), Number(time[3])) ? 'a time' : null;
  }
  return null;
}

/**
 * Reads the one-line flow list that starts at `s[0]`, such as `[a, "b c"]`.
 * Items are double-quoted strings or bare words; `[]` is the empty list. A
 * bare word that YAML reads as something other than text (`null`, `on`,
 * `0123`, `2026-01-15`; see `plainScalarKind`) is an error asking for double
 * quotes, since Jekyll would publish a different value or drop it.
 * Returns `{ value: string[], end }` or `{ error }`.
 */
function readFlowList(s) {
  const items = [];
  let i = 1;
  const skipBlanks = () => {
    while (s[i] === ' ' || s[i] === '\t') i += 1;
  };
  skipBlanks();
  if (s[i] === ']') return { value: items, end: i + 1 };
  for (;;) {
    skipBlanks();
    const c = s[i];
    if (c === undefined) return { error: NOT_CLOSED_LIST };
    if (c === '"') {
      const q = readQuoted(s, i);
      if (q.error) return q;
      items.push(q.value);
      i = q.end;
    } else if (c === '[' || c === '{') {
      return { error: 'nested lists and mappings are not supported inside a flow list' };
    } else if (c === "'") {
      return { error: 'single-quoted strings are not supported; use double quotes' };
    } else if (c === ',' || c === ']') {
      return { error: 'a flow list must not contain empty items' };
    } else if (c === '#') {
      return { error: 'a comment is not allowed inside a flow list' };
    } else {
      FLOW_BARE_ITEM_RE.lastIndex = i;
      const m = FLOW_BARE_ITEM_RE.exec(s);
      // `}` is the one character the pattern excludes that no branch above
      // handles; any such character is reported rather than dereferenced.
      if (m === null) return { error: `unexpected ${JSON.stringify(c)} in a flow list` };
      // YAML trims only spaces and tabs, so a no-break space stays in the tag.
      const item = trimSpaceTabEnd(m[0]);
      const kind = plainScalarKind(item);
      if (kind !== null) {
        return { error: `bare ${item} in a flow list is read by YAML as ${kind}, not text; write "${item}"` };
      }
      items.push(item);
      i += m[0].length;
    }
    skipBlanks();
    if (s[i] === ',') {
      i += 1;
      skipBlanks();
      if (s[i] === ']') return { error: 'a flow list must not end with a comma' };
      continue;
    }
    if (s[i] === ']') return { value: items, end: i + 1 };
    if (s[i] === undefined) return { error: NOT_CLOSED_LIST };
    return { error: `unexpected ${JSON.stringify(s[i])} in a flow list` };
  }
}

/**
 * Parses the value of a `key: value` line. Returns `{ value }` (a string or
 * an array of strings) or `{ error }`.
 */
function parseValue(key, raw) {
  if (raw === '' || raw.startsWith('#')) return { error: `${key} has no value` };
  const c = raw[0];
  if (c === '"') {
    const q = readQuoted(raw, 0);
    if (q.error) return q;
    if (!FM_TRAILER_RE.test(raw.slice(q.end))) {
      return { error: 'only a comment ( # …) may follow the closing quote' };
    }
    return { value: q.value };
  }
  if (c === '|' || c === '>') return { error: 'block scalars (| and >) are not supported' };
  if (c === '&' || c === '*') return { error: 'anchors and aliases (& and *) are not supported' };
  if (c === '!') return { error: 'YAML tags (!) are not supported' };
  if (c === '{') return { error: 'flow mappings ({ … }) are not supported' };
  if (c === "'") return { error: 'single-quoted strings are not supported; use double quotes' };
  // Unquoted text is a YAML plain scalar whose type YAML infers (a date, a
  // number, `true`, `null`), so the display fields must always be quoted.
  if (QUOTED_KEYS.has(key)) return { error: `${key} must be a double-quoted string` };
  if (c === '[') {
    const list = readFlowList(raw);
    if (list.error) return list;
    if (!FM_TRAILER_RE.test(raw.slice(list.end))) {
      return { error: 'only a comment ( # …) may follow the closing ]' };
    }
    return { value: list.value };
  }
  // A plain value: dates (`2026-02-10`) and anything else are kept as the raw
  // string, so `published: false` yields 'false' for the schema to reject.
  const bare = withoutPlainComment(raw).trim();
  if (bare === '') return { error: `${key} has no value` };
  return { value: bare };
}

/**
 * A plain value `raw` without its trailing comment: everything from the
 * first run of spaces or tabs that is followed by `#` with no line
 * terminator (`\n`, `\r`, U+2028, U+2029) after that `#` is removed, and
 * `raw` is returned whole when there is no such run. Each character is read
 * at most twice, so time is linear in the value's length.
 */
function withoutPlainComment(raw) {
  let from = raw.length;
  while (from > 0 && !'\n\r\u2028\u2029'.includes(raw[from - 1])) from -= 1;
  for (let i = from; i < raw.length; i += 1) {
    if (raw[i] !== ' ' && raw[i] !== '\t') continue;
    let j = i;
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j += 1;
    if (raw[j] === '#') return raw.slice(0, i);
    i = j;
  }
  return raw;
}

/**
 * Splits an article into front matter and body, reading front matter with a
 * restricted YAML subset and no library.
 *
 * Accepted front-matter lines, between a first line `---` and the next `---`
 * line (trailing spaces allowed on both): blank lines; `#` comments (leading
 * whitespace allowed; comments are never checked for `TODO:`); and
 * `key: value` lines with a lowercase key and one of these values:
 *   - a double-quoted string on one line (escapes `\"` and `\\` only),
 *     optionally followed by ` # comment`;
 *   - a one-line flow list `[a, "b"]` of bare or double-quoted strings; a
 *     bare item that YAML reads as null, a boolean, a number, a date or a
 *     time (`null`, `on`, `0123`, `2026-01-15`) must be double-quoted;
 *   - a plain value such as `2026-02-10`, kept as a string with any trailing
 *     ` # comment` removed (`title`, `summary` and `author` must be quoted).
 * Indentation, block lists, block scalars, anchors, aliases, YAML tags, flow
 * mappings and single-quoted strings are reported as errors. Keys outside the
 * article schema are kept in `data` so `validateArticle` can reject them by
 * name. A duplicate key is an error and the first value is kept.
 *
 * `body` is the exact, untrimmed remainder of `text` after the closing `---`
 * line and its line break (`''` when that line ends the file), so
 * `text.endsWith(body)` always holds and the body's first line is file line
 * `text.slice(0, text.length - body.length).split('\n').length`. When the
 * front matter is missing or never closed, `data` is `{}` and `body` is the
 * whole `text`, so the safety scanners still see every character.
 *
 * A UTF-8 byte-order mark before the opening `---` is tolerated. CRLF and LF
 * line endings parse identically.
 *
 * @param {string} text Full article source.
 * @returns {{ data: Record<string, string | string[]>, body: string, errors: string[] }}
 *   `data` is a plain object. An error about one front-matter line names its
 *   1-based file line, as in
 *   `front matter line 3: title must be a double-quoted string`; an error
 *   about the whole file (missing or unclosed front matter) names no line.
 *   No error carries a path prefix; the caller adds it.
 */
export function parseArticle(text) {
  const src = asText(text, 'text');
  const lines = splitLines(src);
  const first = stripCr(lines[0].text);
  const opening = first.startsWith('\uFEFF') ? first.slice(1) : first;
  if (!FM_DELIMITER_RE.test(opening)) {
    return { data: {}, body: src, errors: ['missing front matter: the file must start with a --- line'] };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FM_DELIMITER_RE.test(stripCr(lines[i].text))) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { data: {}, body: src, errors: ['unclosed front matter: no closing --- line'] };
  }

  const data = {};
  const errors = [];
  const seen = new Set();
  for (let i = 1; i < close; i += 1) {
    const line = stripCr(lines[i].text);
    const n = i + 1;
    if (FM_BLANK_RE.test(line) || FM_COMMENT_RE.test(line)) continue;
    const m = readKeyLine(line);
    if (m) {
      const { key } = m;
      if (seen.has(key)) {
        errors.push(`front matter line ${n}: duplicate key ${key}`);
        continue;
      }
      seen.add(key);
      const parsed = parseValue(key, m.value);
      if (parsed.error) errors.push(`front matter line ${n}: ${parsed.error}`);
      else setOwn(data, key, parsed.value);
    } else if (/^[ \t]/.test(line)) {
      errors.push(`front matter line ${n}: indentation is not supported`);
    } else if (line.startsWith('-')) {
      errors.push(`front matter line ${n}: block lists are not supported; use tags: [a, b]`);
    } else {
      errors.push(`front matter line ${n}: unsupported syntax`);
    }
  }
  return { data, body: src.slice(lines[close].next), errors };
}


/* ------------------------------------------------------------------------ */
/* Images                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Text of the capture group `group` of match `m` (found in masked text), read
 * from `body`; `base` is the offset in `body` of the text `m` was found in.
 */
function groupText(body, m, group, base = 0) {
  const span = m.indices[group];
  return span ? body.slice(base + span[0], base + span[1]) : undefined;
}

/**
 * Spans `[start, end)` of the Liquid tags `{{ … }}` and `{% … %}` in `text`,
 * read left to right as Liquid's tokenizer does. Once an opener of one kind
 * finds no closer, no later opener of that kind can, so the scan is linear.
 */
function liquidTagSpans(text) {
  const spans = [];
  let output = text.indexOf('{{');
  let tag = text.indexOf('{%');
  while (output !== -1 || tag !== -1) {
    const isOutput = tag === -1 || (output !== -1 && output < tag);
    const open = isOutput ? output : tag;
    const close = text.indexOf(isOutput ? '}}' : '%}', open + 2);
    if (close === -1) {
      if (isOutput) output = -1;
      else tag = -1;
      continue;
    }
    const pos = close + 2;
    spans.push([open, pos]);
    if (output !== -1 && output < pos) output = text.indexOf('{{', pos);
    if (tag !== -1 && tag < pos) tag = text.indexOf('{%', pos);
  }
  return spans;
}

/**
 * Spans `[start, end)` of the paragraphs of `body`: the runs of lines between
 * blank lines. kramdown parses images inside one block's text, so an image,
 * its title or its `[id]` never continues past a blank line (verified:
 * `![D](` + blank line + `)` renders as two paragraphs of text). A blank line
 * inside a Liquid tag does not separate paragraphs, as Liquid replaces the
 * whole tag before kramdown runs.
 */
function paragraphSpans(body) {
  const liquid = liquidTagSpans(body);
  const spans = [];
  let from = 0;
  let k = 0;
  for (const line of splitLines(body)) {
    if (!RUBY_BLANK_LINE_RE.test(line.text)) continue;
    while (k < liquid.length && liquid[k][1] <= line.start) k += 1;
    if (k < liquid.length && liquid[k][0] < line.start) continue;
    if (line.start > from) spans.push([from, line.start]);
    from = line.next;
  }
  if (from < body.length) spans.push([from, body.length]);
  return spans;
}

/**
 * Offset just after the `)` that closes an inline image whose destination
 * ends at `p` in the paragraph text `text`, or -1 when kramdown renders the
 * construct as text. An `<…>` destination (`angle`) must be followed directly
 * by `)`; any other may be followed by whitespace and `)`. Otherwise a title
 * must follow: after whitespace (any amount for `<…>`, at least one character
 * otherwise), a quote, at least one character, and the first matching quote
 * that only whitespace separates from `)`. `closers` caches the positions of
 * such quotes in `text`, found once per paragraph so that every lookup is a
 * binary search and an unclosed title never rescans the paragraph.
 */
function inlineImageEnd(text, p, angle, closers) {
  let q = p;
  while (q < text.length && RUBY_SPACE_CHAR_RE.test(text[q])) q += 1;
  if (text[q] === ')') return angle && q !== p ? -1 : q + 1;
  const quote = text[q];
  if ((quote !== '"' && quote !== "'") || (!angle && q === p)) return -1;
  if (closers.byQuote === null) {
    closers.byQuote = { '"': [], "'": [] };
    for (const m of text.matchAll(TITLE_CLOSE_RE)) closers.byQuote[m[0]].push(m.index);
  }
  const list = closers.byQuote[quote];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < q + 2) lo = mid + 1;
    else hi = mid;
  }
  if (lo === list.length) return -1;
  return text.indexOf(')', list[lo] + 1) + 1;
}

function unwrapAngle(s) {
  const t = s.trim();
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1).trim() : t;
}

/**
 * A reference label as kramdown compares it: each run of ASCII whitespace
 * (Ruby's `\s`, so not U+00A0) becomes one space and letters are lowercased.
 * Nothing is trimmed, so `[ pic ]` and `[pic]` are different labels.
 */
function normalizeLabel(s) {
  return s.replace(/[ \t\n\v\f\r]+/g, ' ').toLowerCase();
}

/** Shortens a long source (a `data:` URI, say) for display in a message. */
function preview(src) {
  return src.length > 80 ? `${src.slice(0, 77)}...` : src;
}

/**
 * Attributes of one tag as a `Map` of lowercase name to entity-decoded value
 * (`''` for an attribute without a value). The first occurrence of a name
 * wins, as in browsers; kramdown renders the last one instead, so each name
 * that occurs again is added to `repeated` when it is given.
 */
function readAttributes(source, repeated) {
  const attrs = new Map();
  const inner = source.replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) {
      repeated?.add(name);
      continue;
    }
    const raw = m[2] ?? m[3] ?? m[4];
    attrs.set(name, raw === undefined ? '' : decodeEntities(raw));
  }
  return attrs;
}

/**
 * Attribute-list work `imageAttributeLists` may spend, per character of the
 * body and in all. Overlapping lists (`'{:a: '.repeat(n) + '}'`) all end at
 * the same `}`, and every image may name the same definitions, so reading
 * each list for each image could take quadratic time.
 */
const ATTRIBUTE_LIST_WORK_PER_CHAR = 4;
const ATTRIBUTE_LIST_WORK_BASE = 65536;

/** kramdown's attribute and ALD name `ALD_ID_NAME` (Ruby's `\w` is ASCII, as here), sticky. */
const LIST_NAME_AT_RE = /\w[\w-]*/y;

/** The `name:` that starts the text of an ALD definition `{:name: …}`, sticky. */
const ALD_NAME_AT_RE = /(\w[\w-]*):/y;

/** A quote that can close an attribute-list value: one followed by Ruby whitespace or the end. */
const LIST_VALUE_CLOSE_RE = /["'](?=[ \t\n\v\f\r]|$)/g;

/** Text of a span extension tag `{::name}`, `{::name …}` or self-closing `{::name …/}` (kramdown `EXT_START_STR`). */
const SPAN_EXTENSION_TAG_RE = /^:(\w+)(?:[ \t\n\v\f\r][\s\S]*|\/)?$/;

/** Text of a span extension stop tag `{:/}` or `{:/name}`, which kramdown renders as text after an image. */
const SPAN_EXTENSION_STOP_RE = /^\/(?:\w[\w-]*)?$/;

/** The extensions kramdown knows; it renders any other `{::name}` as text. */
const KNOWN_EXTENSIONS = new Set(['comment', 'nomarkdown', 'options']);

const LIST_ESCAPES = 'attribute list on the image cannot be checked; remove its backslash escapes';
const LIST_OPTIONS = 'attribute list on the image cannot be checked after {::options} with content; write {::options … /}';
const LIST_BUDGET = 'too many attribute lists to check; simplify the markup';

/**
 * Reads the text of a kramdown attribute list (between `{:` and `}`, or after
 * an ALD's `name:`) as `parse_attribute_list` in kramdown 2.4.0 does. Items
 * start at the beginning or after whitespace and end before whitespace or the
 * end, and the scan resumes where an item ended. `key="value"` or
 * `key='value'` sets an attribute: its value runs to the first matching quote
 * that whitespace or the end follows, so it may hold spaces and other quotes
 * but not U+0002 (kramdown's `[^\}\2]` is an octal escape, not a
 * back-reference), and a quoted value never starts an item. A bare name
 * refers to an ALD; an unquoted value, `#id` and `.class` set nothing an
 * image check needs. Returns `{ pairs, refs }`: `[key, value]` in order, with
 * keys as written, and the names referred to. Returns `null` for text holding
 * a backslash, whose `\}` and `\"` escapes also move where kramdown ends the
 * list and the value.
 */
function parseAttributeList(text) {
  if (text.includes('\\')) return null;
  const pairs = [];
  const refs = [];
  const closers = { '"': [], "'": [] };
  for (const m of text.matchAll(LIST_VALUE_CLOSE_RE)) closers[m[0]].push(m.index);
  const next = { '"': 0, "'": 0 };
  const barriers = [];
  for (let k = text.indexOf('\u0002'); k !== -1; k = text.indexOf('\u0002', k + 1)) barriers.push(k);
  let barrier = 0;
  let resume = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (i > 0 && (i - 1 < resume || !RUBY_SPACE_CHAR_RE.test(text[i - 1]))) continue;
    LIST_NAME_AT_RE.lastIndex = i;
    const name = LIST_NAME_AT_RE.exec(text);
    if (name === null) continue;
    const after = i + name[0].length;
    const quote = text[after + 1];
    if (text[after] === '=' && (quote === '"' || quote === "'")) {
      // Value starts only grow, so the first closer and U+0002 at or after each one are found by moving forward.
      const list = closers[quote];
      while (next[quote] < list.length && list[next[quote]] < after + 2) next[quote] += 1;
      while (barrier < barriers.length && barriers[barrier] < after + 2) barrier += 1;
      if (next[quote] < list.length
        && (barrier === barriers.length || list[next[quote]] < barriers[barrier])) {
        const close = list[next[quote]];
        pairs.push([name[0], text.slice(after + 2, close)]);
        resume = close + 1;
        i = close;
        continue;
      }
    }
    if (after === text.length || RUBY_SPACE_CHAR_RE.test(text[after])) refs.push(name[0]);
  }
  return { pairs, refs };
}

/**
 * The kramdown attribute lists of a body that can set attributes of its
 * images, read as kramdown 2.4.0 applies them:
 *   - `spanLists(end)`: the span IALs that start right where an image ends,
 *     chained, as kramdown applies `{: .a}{: src="…"}` to the image both
 *     times; a self-closing extension tag (`{::comment /}`) adds no element,
 *     so the chain goes on after it;
 *   - `definitionLists(start, end)`: the block IALs on the lines right after
 *     and right before a link definition whose lines run from `start` to
 *     `end`, which kramdown applies to every image that uses the definition;
 *   - `blockListsStart(start)`: the start of the first of the block IAL
 *     lines directly before the line starting at `start`, or `start`;
 *   - `effect(lists)`: what such lists give an image, through every ALD
 *     (`{:name: …}`) they name, every definition of that name and the names
 *     those name in turn, as `{ srcs, alts, srcset, problem }`: the `src`
 *     and `alt` values set, in any letter case, whether `srcset` is set, and
 *     a message when the lists cannot be read with certainty.
 * A list runs from a `{:` outside code to the first `}` after it, read from
 * the original text, as kramdown matches it there. Where this reading could
 * differ from kramdown's it reports `problem` rather than guess: a list
 * holding a backslash, as kramdown's `\}` escape moves its end; an
 * `{::options}` block with content, after which kramdown goes on applying
 * lists to the image; and work beyond `ATTRIBUTE_LIST_WORK_PER_CHAR`. ALD
 * definitions count wherever they stand outside code (kramdown also reads
 * them in blockquotes and list items, and resolves them after the whole
 * body is parsed); one that kramdown would not read only adds values to
 * check.
 */
function imageAttributeLists(body, masked) {
  const ends = new Map();
  const alds = new Map();
  const braces = [];
  for (let k = body.indexOf('}'); k !== -1; k = body.indexOf('}', k + 1)) braces.push(k);
  let b = 0;
  for (let s = masked.indexOf('{:'); s !== -1; s = masked.indexOf('{:', s + 2)) {
    while (b < braces.length && braces[b] < s + 2) b += 1;
    // No later `{:` closes either.
    if (b === braces.length) break;
    ends.set(s, braces[b]);
    ALD_NAME_AT_RE.lastIndex = s + 2;
    const ald = ALD_NAME_AT_RE.exec(body);
    if (ald !== null) {
      if (!alds.has(ald[1])) alds.set(ald[1], []);
      alds.get(ald[1]).push([s + 2 + ald[0].length, braces[b]]);
    }
  }

  let work = ATTRIBUTE_LIST_WORK_PER_CHAR * body.length + ATTRIBUTE_LIST_WORK_BASE;
  const parsed = new Map();
  const read = ([from, to]) => {
    if (!parsed.has(from)) {
      work -= to - from;
      const list = work < 0 ? { problem: LIST_BUDGET } : parseAttributeList(body.slice(from, to));
      parsed.set(from, list ?? { problem: LIST_ESCAPES });
    }
    return parsed.get(from);
  };

  const chains = new Map();
  const spanLists = (end) => {
    if (chains.has(end)) return chains.get(end);
    const chain = { lists: [], problem: undefined };
    for (let s = end; ends.has(s);) {
      const close = ends.get(s);
      work -= close + 1 - s;
      if (work < 0) {
        chain.problem = LIST_BUDGET;
        break;
      }
      const text = body.slice(s + 2, close);
      // `{:}` and stop tags are text, and lists after text apply to nothing.
      if (text === '' || SPAN_EXTENSION_STOP_RE.test(text)) break;
      if (text.includes('\\')) {
        chain.problem = LIST_ESCAPES;
        break;
      }
      const extension = SPAN_EXTENSION_TAG_RE.exec(text);
      if (extension === null) {
        chain.lists.push([s + 2, close]);
      } else if (!KNOWN_EXTENSIONS.has(extension[1])) {
        break;
      } else if (!text.endsWith('/')) {
        // A comment or raw element now follows the image; `options` adds none.
        if (extension[1] === 'options') chain.problem = LIST_OPTIONS;
        break;
      }
      s = close + 1;
    }
    chains.set(end, chain);
    return chain;
  };

  // The block IALs: a list that opens the content of its line (`containerContentStart`) and is
  // followed on the line of its `}` by whitespace only. `{:}` is text, `{::…}` and `{:/…}` are
  // extensions, and `{:name: …}` is read as an ALD first. Each is found by the start of its line
  // (`byLine`) and by the start of the line after its `}` (`byNext`).
  const byLine = new Map();
  const byNext = new Map();
  let lineStart = 0;
  let lineEnd = -1;
  let content = -1;
  for (const [s, close] of ends) {
    if (s > lineEnd) {
      lineStart = body.lastIndexOf('\n', s - 1) + 1;
      const nl = body.indexOf('\n', s);
      lineEnd = nl === -1 ? body.length : nl;
      content = containerContentStart(body, lineStart, lineEnd).at;
    }
    if (s !== content || close === s + 2 || body[s + 2] === ':' || body[s + 2] === '/') continue;
    ALD_NAME_AT_RE.lastIndex = s + 2;
    if (ALD_NAME_AT_RE.test(body)) continue;
    const nl = body.indexOf('\n', close);
    const rest = body.slice(close + 1, nl === -1 ? body.length : nl);
    if (!RUBY_BLANK_LINE_RE.test(rest)) continue;
    const list = { range: [s + 2, close], lineStart, next: nl === -1 ? -1 : nl + 1 };
    byLine.set(lineStart, list);
    if (list.next !== -1) byNext.set(list.next, list);
  }

  const definitionLists = (start, end) => {
    const lists = [];
    // kramdown applies the block IALs right after a definition to it, and those right before it
    // when nothing before them takes them, as a blank line or another IAL does not; here the
    // lines before are taken whenever they are there.
    const nl = body.indexOf('\n', end);
    for (let at = nl === -1 ? -1 : nl + 1; byLine.has(at);) {
      const list = byLine.get(at);
      lists.push(list.range);
      at = list.next;
    }
    for (let at = start; byNext.has(at);) {
      const list = byNext.get(at);
      lists.push(list.range);
      at = list.lineStart;
    }
    return lists;
  };

  // The start of the first line of the block IALs that directly precede the line starting at
  // `start`, or `start` when none does.
  const blockListsStart = (start) => {
    let at = start;
    while (byNext.has(at)) at = byNext.get(at).lineStart;
    return at;
  };

  const effect = (lists) => {
    const result = { srcs: [], alts: [], srcset: false, problem: undefined };
    const named = new Set();
    const queue = [...lists];
    for (let q = 0; q < queue.length; q += 1) {
      const list = read(queue[q]);
      if (list.problem !== undefined) {
        result.problem = list.problem;
        break;
      }
      work -= 1 + list.pairs.length + list.refs.length;
      if (work < 0) {
        result.problem = LIST_BUDGET;
        break;
      }
      for (const [key, value] of list.pairs) {
        const name = key.toLowerCase();
        if (name === 'src') result.srcs.push(value);
        else if (name === 'alt') result.alts.push(value);
        else if (name === 'srcset') result.srcset = true;
      }
      // kramdown ignores a name nothing defines.
      for (const ref of list.refs) {
        if (named.has(ref) || !alds.has(ref)) continue;
        named.add(ref);
        for (const definition of alds.get(ref)) queue.push(definition);
      }
    }
    return result;
  };

  return { spanLists, definitionLists, blockListsStart, effect };
}

/** A character JavaScript's `\s` matches. */
const JS_WHITESPACE_RE = /\s/;

/** A line terminator as a multiline regular expression's `^` and `$` read it. */
function isLineTerminator(c) {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

/**
 * Link reference definitions `[id]: dest "title"` in `text`, in order, as
 * `{ start, end, label, dest }`: `label` and `dest` are `[start, end)` spans
 * and `end` is where the definition's line ends. Like kramdown, `dest` runs
 * to the end of the line, spaces included, before an optional title; it may
 * stand on the line after `]:`, and the title on the line after `dest`.
 *
 * The result is exactly that of matching
 * `/^ {0,3}\[([^\]\n]+)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|[^\n]*?\S)(?:(?:[ \t]*\n|[ \t]+)[ \t]*(["'])[^\n]*?\3)?[ \t]*$/gm`
 * with `matchAll` (groups 1 and 2 are `label` and `dest`). That pattern
 * backtracks over every split of a long run of spaces or quotes, so each of
 * its decisions is read here from tables built in one pass from the end of
 * `text`, and the time is linear in its length:
 *   - `finish(e)`: where a definition whose `dest` ends at `e` ends, taking
 *     the title when one closes on its line (the pattern tries the title
 *     first), or -1;
 *   - `nextGood[e]`: the first end at or after `e` that `finish` accepts
 *     after a non-whitespace character, the lazy `dest`'s first success.
 */
function linkDefinitions(text) {
  const out = [];
  if (!text.includes(']:')) return out;
  const n = text.length;
  const NONE = -1;
  // First index at or after i that is not a space or tab.
  const skip = new Int32Array(n + 1);
  // Whether `[ \t]*$` matches at i.
  const endOk = new Uint8Array(n + 1);
  const nextNl = new Int32Array(n + 1);
  // First `]` or line feed, and first `>` or line feed, at or after i.
  const labelStop = new Int32Array(n + 1);
  const angleStop = new Int32Array(n + 1);
  // First quote of each kind at or after i, before a line feed, after which `[ \t]*$` matches.
  const closeDouble = new Int32Array(n + 1);
  const closeSingle = new Int32Array(n + 1);
  skip[n] = n;
  endOk[n] = 1;
  nextNl[n] = n;
  labelStop[n] = n;
  angleStop[n] = n;
  closeDouble[n] = NONE;
  closeSingle[n] = NONE;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = text[i];
    const spaceOrTab = c === ' ' || c === '\t';
    skip[i] = spaceOrTab ? skip[i + 1] : i;
    endOk[i] = isLineTerminator(c) || (spaceOrTab && endOk[i + 1] === 1) ? 1 : 0;
    nextNl[i] = c === '\n' ? i : nextNl[i + 1];
    labelStop[i] = c === ']' || c === '\n' ? i : labelStop[i + 1];
    angleStop[i] = c === '>' || c === '\n' ? i : angleStop[i + 1];
    closeDouble[i] = c === '\n' ? NONE : c === '"' && endOk[i + 1] === 1 ? i : closeDouble[i + 1];
    closeSingle[i] = c === '\n' ? NONE : c === "'" && endOk[i + 1] === 1 ? i : closeSingle[i + 1];
  }
  const finish = (e) => {
    // The title's opening quote: after spaces, a line feed and spaces, or after at least one space.
    const w = skip[e];
    const t = w < n && text[w] === '\n' ? skip[w + 1] : w > e ? w : NONE;
    if (t !== NONE && t < n && (text[t] === '"' || text[t] === "'")) {
      const u = (text[t] === '"' ? closeDouble : closeSingle)[t + 1];
      if (u !== NONE) return skip[u + 1];
    }
    return endOk[e] === 1 ? skip[e] : NONE;
  };
  const nextGood = new Int32Array(n + 2);
  nextGood[n + 1] = NONE;
  for (let e = n; e >= 1; e -= 1) {
    nextGood[e] = !JS_WHITESPACE_RE.test(text[e - 1]) && finish(e) !== NONE ? e : nextGood[e + 1];
  }
  let from = 0;
  for (let p = 0; p < n; p += 1) {
    if (p < from || (p > 0 && !isLineTerminator(text[p - 1]))) continue;
    let i = p;
    while (i < p + 3 && text[i] === ' ') i += 1;
    if (text[i] !== '[') continue;
    const j = labelStop[i + 1];
    if (j === i + 1 || j >= n - 1 || text[j] !== ']' || text[j + 1] !== ':') continue;
    const b = skip[j + 2];
    const s = b < n && text[b] === '\n' ? skip[b + 1] : b;
    let e = NONE;
    let end = NONE;
    if (s < n && text[s] === '<') {
      const f = angleStop[s + 1];
      if (f < n && text[f] === '>') {
        end = finish(f + 1);
        if (end !== NONE) e = f + 1;
      }
    }
    if (e === NONE && s < n) {
      const g = nextGood[s + 1];
      if (g !== NONE && g - 1 < nextNl[s]) {
        e = g;
        end = finish(g);
      }
    }
    if (e === NONE) continue;
    out.push({ start: p, end, label: [i + 1, j], dest: [s, e] });
    from = end;
  }
  return out;
}

/**
 * Where the content of the line starting at `p` (and ending at `lineEnd`)
 * begins once the markers of the blocks that contain it are passed:
 * blockquote `>`, list markers (`-`, `+`, `*`, `1.` or `1)` before a space
 * or tab), definition markers (`:` before a space or tab) and footnote
 * labels (`[^…]:`), in any order and with any spaces and tabs around them.
 * Returns `{ at, markers }`, `markers` counting the markers passed. kramdown
 * parses such content as blocks of its own, link definitions and attribute
 * lists included. Time is linear in the line's length.
 */
function containerContentStart(text, p, lineEnd) {
  const spaceOrTab = (k) => text[k] === ' ' || text[k] === '\t';
  let i = p;
  let markers = 0;
  for (;;) {
    while (i < lineEnd && spaceOrTab(i)) i += 1;
    const c = text[i];
    let next = -1;
    if (c === '>') next = i + 1;
    else if ((c === '-' || c === '+' || c === '*' || c === ':') && spaceOrTab(i + 1)) next = i + 1;
    else if (c >= '0' && c <= '9') {
      let k = i;
      while (k < lineEnd && k < i + 9 && text[k] >= '0' && text[k] <= '9') k += 1;
      if ((text[k] === '.' || text[k] === ')') && spaceOrTab(k + 1)) next = k + 1;
    } else if (c === '[' && text[i + 1] === '^') {
      const close = text.indexOf(']', i + 2);
      if (close > i + 2 && close < lineEnd && text[close + 1] === ':') next = close + 2;
    }
    if (next === -1 || next > lineEnd) return { at: i, markers };
    i = next;
    markers += 1;
  }
}

/**
 * Link reference definitions that `linkDefinitions` does not see because a
 * block contains them: lines whose content, after `containerContentStart`,
 * is a definition `[id]: dest "title"` on that line, when at least one
 * container marker or more than three spaces of indentation (or a tab)
 * precede it. kramdown reads definitions in blockquotes, list items,
 * definition lists and footnotes as definitions of the whole document. Each
 * is `{ start, end, label, dest }` as from `linkDefinitions`, with `start`
 * the line's start. Time is linear in `text`'s length.
 */
function containerLinkDefinitions(text) {
  const out = [];
  if (!text.includes(']:')) return out;
  for (let p = 0; p < text.length;) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    const { at, markers } = containerContentStart(text, p, lineEnd);
    const indent = text.slice(p, at);
    if (text[at] === '[' && (markers > 0 || indent.length > 3 || indent.includes('\t'))) {
      const [definition] = linkDefinitions(text.slice(at, lineEnd));
      if (definition !== undefined) {
        out.push({
          start: p,
          end: at + definition.end,
          label: [at + definition.label[0], at + definition.label[1]],
          dest: [at + definition.dest[0], at + definition.dest[1]],
        });
      }
    }
    p = lineEnd + 1;
  }
  return out;
}

/**
 * Every image in a body, outside code, ordered by position:
 * `{ offset, alt, src, html, srcset, repeated, attributes, definition }`.
 * Covers Markdown inline images, reference images resolved against link
 * definitions (the last definition of a label wins, as in kramdown;
 * unresolved references render as text and are ignored), and raw `<img>`
 * tags. `trustedLines` holds the start offsets of the lines every reading
 * treats as running text (`findCodeRegions`); a link definition elsewhere
 * may be text to kramdown. Markdown images are matched
 * within one paragraph (`paragraphSpans`), and an inline image is kept only
 * when it closes as kramdown requires (`inlineImageEnd`). Positions are found
 * in the masked body; alt text and sources are read from the original, with
 * character references in alt text decoded, as the browser shows it. A
 * Markdown image with an empty or whitespace destination has `src: ''`; an
 * `<img>` without a `src` attribute has `src: undefined`, and `repeated`
 * names its `src`, `alt` and `srcset` attributes that occur more than once.
 * `attributes` is what the kramdown attribute lists right after the image
 * give it (`imageAttributeLists`), or `undefined` when none applies. A
 * reference image's `definition`, one object shared by every image of its
 * label, holds what its link definitions give it: `src`, the distinct other
 * sources that earlier definitions kramdown may render instead name
 * (`others`), and the `attributes` of their attribute lists (or
 * `undefined`). When
 * overlapping `<img>` tags exceed the tag-reading budget
 * (`IMAGE_TAG_WORK_PER_CHAR`), the tags from there on go
 * unread and one entry `{ offset, html: true, unchecked: true }` stands for
 * them, so validation fails instead of passing images it never read.
 */
function collectImages(body, masked, trustedLines) {
  const images = [];
  const inlineSpans = [];
  const paragraphs = paragraphSpans(body);
  const lists = imageAttributeLists(body, masked);
  // What the attribute lists right after an image ending at `end` give it.
  const listsFor = (end) => {
    const chain = lists.spanLists(end);
    if (chain.lists.length === 0 && chain.problem === undefined) return undefined;
    const result = lists.effect(chain.lists);
    result.problem ??= chain.problem;
    return result;
  };
  for (const [from, to] of paragraphs) {
    const text = masked.slice(from, to);
    const head = new RegExp(IMG_INLINE_HEAD_RE.source, 'gd');
    const closers = { byQuote: null };
    let m;
    while ((m = head.exec(text)) !== null) {
      const angle = groupText(body, m, 2, from);
      const end = inlineImageEnd(text, m.index + m[0].length, angle !== undefined, closers);
      if (end === -1) {
        // Text, as when the whole pattern fails here: look again one character on.
        head.lastIndex = m.index + 1;
        continue;
      }
      const src = angle === undefined ? groupText(body, m, 3, from).trim() : unwrapAngle(angle);
      images.push({
        offset: from + m.index,
        alt: decodeEntities(groupText(body, m, 1, from)),
        src,
        html: false,
        attributes: listsFor(from + end),
      });
      inlineSpans.push([from + m.index, from + end]);
      head.lastIndex = end;
    }
  }
  // kramdown renders the last definition of a label it reads as one. What is found here may also
  // be text kramdown reads otherwise (inside raw HTML, continuing a paragraph, or as a header or
  // table row), so a definition overrides the earlier ones only when it is `certain`, and every
  // definition of a label from its last certain one on, in document order, is a source its images
  // may load.
  const definitions = new Map();
  const top = linkDefinitions(masked);
  const found = [...top, ...containerLinkDefinitions(masked)].sort((a, b) => a.start - b.start);
  const topLevel = new Set(top);
  const certainEnds = new Set();
  const lineEndAt = (p) => {
    const nl = body.indexOf('\n', p);
    return nl === -1 ? body.length : nl;
  };
  // Whether kramdown starts a block at the line starting at `start` (a real line start): first in
  // the body, after a blank line, or after a certain definition, with any block IALs between.
  const startsBlock = (start) => {
    const at = lists.blockListsStart(start);
    if (at === 0) return true;
    const q = at - 1;
    if (certainEnds.has(q) || (q > 0 && body[q - 1] === '\r' && certainEnds.has(q - 1))) return true;
    return BLANK_LINE_RE.test(stripCr(body.slice(body.lastIndexOf('\n', q - 1) + 1, q)));
  };
  for (const definition of found) {
    const { start, end, label, dest } = definition;
    const firstEnd = lineEndAt(start);
    // Certain: at the top level, on a line every reading treats as running text, and starting a
    // block. kramdown tries the footnote, table and setext header parsers before the link
    // definition one (`@block_parsers`), reads the destination only on the line of `]:`, and
    // declines one holding a space before a quote, so a `[^` label, a table row, a line followed
    // by `-` or `=`, a destination on the next line and any quote (a title included) leave it
    // uncertain.
    const certain = topLevel.has(definition)
      && trustedLines.has(start)
      && dest[0] < firstEnd
      && body[label[0]] !== '^'
      && !TABLE_LINE_RE.test(stripCr(body.slice(start, firstEnd)))
      && !(firstEnd < body.length && (body[firstEnd + 1] === '-' || body[firstEnd + 1] === '='))
      && !/["']/.test(body.slice(label[1], end))
      && startsBlock(start);
    if (certain) certainEnds.add(end);
    const key = normalizeLabel(body.slice(label[0], label[1]));
    if (!definitions.has(key)) definitions.set(key, []);
    definitions.get(key).push({
      src: unwrapAngle(body.slice(dest[0], dest[1])),
      certain,
      lists: lists.definitionLists(start, end),
    });
  }
  // Every image of a label shares one record, built on first use, so many images of a label with
  // many definitions cost the sum of the two rather than their product.
  const records = new Map();
  const recordFor = (key) => {
    if (!records.has(key)) {
      const candidates = definitions.get(key);
      let first = candidates.length - 1;
      while (first > 0 && !candidates[first].certain) first -= 1;
      const live = candidates.slice(first);
      const src = live[live.length - 1].src;
      const others = new Set();
      for (let k = 0; k < live.length - 1; k += 1) others.add(live[k].src.trim());
      others.delete(src);
      const applied = live.flatMap((candidate) => candidate.lists);
      records.set(key, { src, others: [...others], attributes: applied.length === 0 ? undefined : lists.effect(applied) });
    }
    return records.get(key);
  };
  let span = 0;
  for (const [from, to] of paragraphs) {
    for (const m of masked.slice(from, to).matchAll(new RegExp(IMG_REFERENCE_RE.source, 'gd'))) {
      const at = from + m.index;
      while (span < inlineSpans.length && inlineSpans[span][1] <= at) span += 1;
      if (span < inlineSpans.length && inlineSpans[span][0] <= at) continue;
      const alt = groupText(body, m, 1, from);
      const label = normalizeLabel(m[2] ? groupText(body, m, 2, from) : alt);
      if (definitions.has(label)) {
        const definition = recordFor(label);
        images.push({
          offset: at,
          alt: decodeEntities(alt),
          src: definition.src,
          definition,
          html: false,
          attributes: listsFor(at + m[0].length),
        });
      }
    }
  }
  let work = IMAGE_TAG_WORK_PER_CHAR * body.length + IMAGE_TAG_WORK_BASE;
  for (const tag of markupOutsideCode(body, masked, IMG_TAG_START_RE).tags) {
    work -= tag.end + 1 - tag.start;
    if (work < 0) {
      images.push({ offset: tag.start, html: true, unchecked: true });
      break;
    }
    const repeated = new Set();
    const attrs = readAttributes(body.slice(tag.start, tag.end + 1), repeated);
    images.push({
      offset: tag.start,
      alt: attrs.get('alt'),
      src: attrs.has('src') ? attrs.get('src').trim() : undefined,
      html: true,
      srcset: attrs.has('srcset'),
      repeated: ['src', 'alt', 'srcset'].filter((name) => repeated.has(name)),
      attributes: listsFor(tag.end + 1),
    });
  }
  return images.sort((a, b) => a.offset - b.offset);
}

/**
 * A character reference a browser decodes in an attribute value: named,
 * decimal or hexadecimal, ended by `;`. kramdown passes these through to the
 * rendered attribute unchanged.
 */
const CHARACTER_REFERENCE_RE = /&#?[A-Za-z0-9]+;/;

/**
 * Maps an image source to the public path it loads and applies the source
 * rules. `slug` is the article's slug (or `null` when the filename gave none,
 * which skips the folder rule). Returns `{ path }` or `{ error }`; `path` is
 * the root-relative file path the browser requests: percent-decoded, without
 * query or fragment, and with `.` segments removed. Character references
 * anywhere, and before the query or fragment percent-encoding that is
 * malformed or not UTF-8, control characters, backslashes and `..` segments
 * are rejected, so the path checked is the path requested; the article's
 * folder prefix must be written before any `.` segment.
 */
function imagePublicPath(src, slug, kind) {
  const folder = kind === 'draft' ? 'drafts' : 'blog';
  const hint = `use {{ '/assets/${folder}/${slug ?? '<slug>'}/…' | relative_url }}`;
  let path;
  let m;
  if ((m = LIQUID_RELATIVE_URL_RE.exec(src)) !== null) path = m[2];
  else if ((m = LIQUID_BASEURL_RE.exec(src)) !== null) path = m[1];
  else if (src.includes('{{') || src.includes('{%')) return { error: `unsupported image source ${preview(src)}; ${hint}` };
  else path = src;

  if (/^data:/i.test(path)) return { error: `data: images are not allowed (${preview(src)})` };
  if (URL_SCHEME_RE.test(path)) return { error: `external images are not allowed (${preview(src)})` };
  // Browsers read a leading `/\` like `//`, so both are protocol-relative.
  if (/^[/\\]{2}/.test(path)) return { error: `external images are not allowed (${preview(src)})` };
  if (!path.startsWith('/')) return { error: `page-relative image path ${preview(src)} is not allowed; ${hint}` };

  // kramdown keeps character references in the rendered attribute and the browser decodes them
  // before it reads the URL, so `&#46;&#46;`, `&percnt;2e` or `&bsol;` would become `..`, `%2e`
  // or `\` after these checks, and the `#` of `&#46;` is no fragment.
  if (CHARACTER_REFERENCE_RE.test(path)) {
    return { error: `image path ${preview(src)} must not contain character references (&…;); write the characters themselves` };
  }
  const bare = path.replace(/[?#].*$/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A `%` without two hex digits, or escapes that are not UTF-8 (`%ff`). Checking the raw text
    // instead would let a `%2e%2e` elsewhere in the path through, which the browser reads as `..`.
    return { error: `image path ${preview(src)} has malformed percent-encoding; write % itself as %25` };
  }
  // The browser drops tabs and line breaks from a URL, so `.<tab>.` would load as `..`.
  if (/[\u0000-\u001f\u007f]/.test(decoded)) {
    return { error: `image path ${preview(src)} must not contain tabs, line breaks or other control characters` };
  }
  if (decoded.includes('\\')) return { error: `image path ${preview(src)} must not contain backslashes` };
  const segments = decoded.split('/');
  if (segments.includes('..')) return { error: `image path ${preview(src)} must not contain .. segments` };
  // The browser drops `.` segments when it resolves the URL; a trailing one leaves a trailing slash.
  const normalized = segments.filter((s) => s !== '.').join('/') + (segments.at(-1) === '.' ? '/' : '');
  if (slug !== null) {
    const prefix = `/assets/${folder}/${slug}/`;
    // The folder prefix must stand before any `.` segment (`/assets/./drafts/…` is refused):
    // publish and unpublish rewrite it as text, and would otherwise leave the image behind.
    if (!decoded.startsWith(prefix) || !normalized.startsWith(prefix)
      || normalized.length === prefix.length || normalized.endsWith('/')) {
      return { error: `image ${preview(src)} must be under ${prefix}` };
    }
  }
  return { path: normalized };
}

/**
 * Findings for `attributes`, what kramdown attribute lists give an image
 * (`collectImages`), whose own source is `src`. Every value they set is held
 * to the image rules, whether kramdown renders it over the image's own or
 * beside it (a `SRC` on a link definition renders before `src`, and browsers
 * read the first): every `src` other than `src` must pass `sourceProblem`
 * (the `imagePublicPath` and `imageExists` rules), no `alt` may be blank
 * once character references are decoded, and `srcset` is rejected, as in an
 * `<img>` tag.
 */
function attributeListErrors(attributes, src, sourceProblem) {
  const errors = [];
  const listError = (message) => errors.push(`attribute list on the image: ${message}`);
  if (attributes.problem !== undefined) errors.push(attributes.problem);
  if (attributes.srcset) listError('srcset is not supported; use a single src');
  if (attributes.alts.some((alt) => decodeEntities(alt).trim() === '')) listError('alt text is blank');
  for (const value of new Set(attributes.srcs.map((s) => s.trim()))) {
    if (value === src) continue;
    if (value === '') {
      listError('src is empty');
      continue;
    }
    const problem = sourceProblem(value);
    if (problem !== null) listError(problem);
  }
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Article validation                                                        */
/* ------------------------------------------------------------------------ */

function futureDateMessage(path, date, today) {
  return `${path}: dated ${date}, after today (UTC ${today}); future-dated posts are not allowed`;
}

/**
 * Applies the article schema, date, `TODO:` and image rules to one parsed
 * article. It does not scan for unsafe markup; callers run
 * `scanUnsafeMarkup` as well (`checkTrackedContent` runs both), so no finding
 * is reported twice.
 *
 * Rules:
 *   - filename: posts are `YYYY-MM-DD-<slug>.md` with a real date not after
 *     `todayUtc`; drafts are `<slug>.md`; the slug matches `SLUG_RE` and has
 *     at most `SLUG_MAX` characters;
 *   - keys: only `title`, `summary`, `tags`, `updated`, `author`; every other
 *     key, `published` included, is rejected by name;
 *   - `title` 1–100 and `summary` 1–200 characters (counted by code point;
 *     blank counts as missing); `tags` a list of 1–5 lowercase kebab-case
 *     tags; `updated` optional, a real date not earlier than a post's date;
 *     `author` optional and non-empty; the body non-empty;
 *   - no `TODO:` left in any front-matter value or in the body outside code;
 *   - images (outside code) have alt text and load a local file in the
 *     article's own folder, `/assets/drafts/<slug>/` for a draft or
 *     `/assets/blog/<slug>/` for a post, written as
 *     `{{ '/assets/…' | relative_url }}`, `{{ site.baseurl }}/assets/…` or
 *     `/assets/…`; empty, external, protocol-relative, `data:`, page-relative
 *     and `..` sources, sources whose character references, malformed
 *     percent-encoding or control characters would make the browser request
 *     another path, and `srcset` are rejected. The rules hold for what the
 *     page renders: kramdown attribute lists that apply to an image (`{: …}`
 *     right after it, those on the link definition it uses and the ALDs they
 *     name) must set no `srcset`, no blank `alt` and only a `src` that passes
 *     them too, and an `<img>` must not repeat `src`, `alt` or `srcset`.
 *
 * @param {object} args
 * @param {string} args.path Repository-relative path, such as `_posts/2026-01-15-foo.md` or `_drafts/foo.md`.
 * @param {Record<string, unknown>} [args.data] `data` from `parseArticle` (missing → `{}`).
 * @param {string} [args.body] `body` from `parseArticle` (missing → `''`).
 * @param {'draft' | 'post'} args.kind Which folder rules apply.
 * @param {string} [args.todayUtc] Today as `YYYY-MM-DD` in UTC (default: the current UTC date).
 * @param {(publicPath: string) => boolean} [args.imageExists] Called with a root-relative public
 *   path such as `/assets/blog/foo/fig.png` (percent-decoded, without query, fragment or `.`
 *   segments) for each image that passed the other rules; `false`
 *   reports the image as missing. Omit it to skip the existence check.
 * @param {number} [args.bodyStartLine] File line on which `body` starts (default 1). Pass
 *   `text.slice(0, text.length - body.length).split('\n').length` so body findings carry file lines.
 * @returns {string[]} Errors, each starting with `path`: `${path}: …` for file-level findings and
 *   `${path}:${line}: …` for body findings.
 */
export function validateArticle({ path, data, body, kind, todayUtc, imageExists, bodyStartLine } = {}) {
  return validateWithAnalysis({ path, data, body, kind, todayUtc, imageExists, bodyStartLine }, null);
}

/**
 * The part of an article check that depends on nothing but the body: a line
 * locator for its offsets, the lines carrying a leftover template placeholder
 * outside code, and every image outside code (`collectImages`). Code regions
 * are found once and the masked body is not kept. Because neither path, date
 * nor tree enters it, one analysis serves every check of the same body.
 *
 * @param {string} body Markdown body (from `parseArticle`).
 * @returns {{ lineAt: (offset: number) => number, todoLines: number[], images: object[] }}
 *   `todoLines` are 1-based lines of `body` in ascending order.
 */
function analyzeBody(body) {
  const code = {};
  const masked = maskCode(body, findCodeRegions(body, code));
  const todo = lineFindings(body);
  for (const m of masked.matchAll(/TODO:/g)) todo.note(m.index);
  return {
    lineAt: lineLocator(body),
    todoLines: todo.list().map((finding) => finding.line),
    images: collectImages(body, masked, code.trustedLines),
  };
}

/**
 * `validateArticle` given `analysis`, the `analyzeBody` result for `body`,
 * or `null` to compute it here. Only that analysis may come from an earlier
 * check of the same body: the filename, schema, date, folder and existence
 * rules always run, as they depend on `path`, `todayUtc` and `imageExists`.
 */
function validateWithAnalysis({ path, data, body, kind, todayUtc, imageExists, bodyStartLine }, analysis) {
  if (typeof path !== 'string' || path === '') throw new TypeError('path must be a non-empty string');
  if (kind !== 'draft' && kind !== 'post') {
    throw new TypeError(`kind must be 'draft' or 'post', got ${JSON.stringify(kind)}`);
  }
  if (imageExists !== undefined && imageExists !== null && typeof imageExists !== 'function') {
    throw new TypeError('imageExists must be a function');
  }
  const startLine = bodyStartLine === undefined || bodyStartLine === null ? 1 : bodyStartLine;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new TypeError(`bodyStartLine must be a positive integer, got ${JSON.stringify(bodyStartLine)}`);
  }
  const today = resolveToday(todayUtc);
  const fields = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const text = asText(body, 'body');

  const errors = [];
  const fileError = (message) => errors.push(`${path}: ${message}`);
  const { lineAt, todoLines, images } = analysis ?? analyzeBody(text);
  const bodyError = (offset, message) => errors.push(`${path}:${startLine + lineAt(offset) - 1}: ${message}`);

  // Filename, slug and date.
  const base = posix.basename(path);
  let slug = null;
  let date = null;
  if (kind === 'post') {
    const m = POST_FILENAME_RE.exec(base);
    if (m) {
      date = m[1];
      slug = m[2];
    } else {
      fileError('post filename must be YYYY-MM-DD-<slug>.md');
    }
  } else {
    const m = DRAFT_FILENAME_RE.exec(base);
    if (m) slug = m[1];
    else fileError('draft filename must be <slug>.md');
  }
  if (slug !== null) {
    if (!SLUG_RE.test(slug)) {
      fileError(`slug must be lowercase letters, digits and single hyphens (got "${slug}")`);
    } else if (charCount(slug) > SLUG_MAX) {
      fileError(`slug must be at most ${SLUG_MAX} characters (got ${charCount(slug)})`);
    }
  }
  if (date !== null) {
    if (!isCalendarDate(date)) fileError(`filename date ${date} is not a real calendar date`);
    else if (date > today) errors.push(futureDateMessage(path, date, today));
  }

  // Keys outside the schema.
  for (const key of Object.keys(fields)) {
    if (ALLOWED_KEYS.includes(key)) continue;
    fileError(Object.hasOwn(REJECTED_KEY_REASONS, key) ? REJECTED_KEY_REASONS[key] : `unknown front-matter key ${key}`);
  }

  // Field rules.
  for (const [key, max] of [['title', TITLE_MAX], ['summary', SUMMARY_MAX]]) {
    const value = fields[key];
    if (!Object.hasOwn(fields, key) || (typeof value === 'string' && value.trim() === '')) {
      fileError(`${key} is required`);
    } else if (typeof value !== 'string') {
      fileError(`${key} must be a double-quoted string`);
    } else if (charCount(value) > max) {
      fileError(`${key} must be 1 to ${max} characters (got ${charCount(value)})`);
    }
  }
  if (!Object.hasOwn(fields, 'tags')) {
    fileError(`tags must list ${TAGS_MIN} to ${TAGS_MAX} tags (tags is missing)`);
  } else if (!Array.isArray(fields.tags)) {
    fileError('tags must be a flow list such as [a, b]');
  } else {
    const { tags } = fields;
    if (tags.length < TAGS_MIN || tags.length > TAGS_MAX) {
      fileError(`tags must list ${TAGS_MIN} to ${TAGS_MAX} tags (got ${tags.length})`);
    }
    for (const tag of tags) {
      if (typeof tag !== 'string' || !SLUG_RE.test(tag)) fileError(`tag "${String(tag)}" must be lowercase kebab-case`);
    }
  }
  if (Object.hasOwn(fields, 'updated')) {
    const updated = fields.updated;
    if (!isCalendarDate(updated)) {
      fileError(`updated must be a real date written YYYY-MM-DD (got ${JSON.stringify(updated)})`);
    } else if (date !== null && isCalendarDate(date) && updated < date) {
      fileError(`updated ${updated} is earlier than the post date ${date}`);
    }
  }
  if (Object.hasOwn(fields, 'author') && !isFilled(fields.author)) {
    fileError('author must be a non-empty double-quoted string');
  }
  if (text.trim() === '') fileError('body is empty');

  // Placeholder markers ("TODO:") left over from the article template.
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    const marked = typeof value === 'string'
      ? value.includes('TODO:')
      : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.includes('TODO:'));
    if (marked) fileError(`${key} still contains a TODO: placeholder`);
  }
  for (const line of todoLines) {
    errors.push(`${path}:${startLine + line - 1}: body still contains a TODO: placeholder`);
  }

  // Images. Each distinct source is checked once (`sourceProblem`, the rule it breaks or `null`), and
  // what a label's link definitions give its images once, at the first image of the label.
  const sources = new Map();
  const sourceProblem = (value) => {
    if (!sources.has(value)) {
      const result = imagePublicPath(value, slug, kind);
      let problem = null;
      if (result.error) problem = result.error;
      else if (typeof imageExists === 'function' && !imageExists(result.path)) {
        problem = `image ${preview(result.path)} does not exist`;
      }
      sources.set(value, problem);
    }
    return sources.get(value);
  };
  const checkedDefinitions = new Set();
  for (const image of images) {
    if (image.unchecked) { bodyError(image.offset, 'too many overlapping <img> tags to check; simplify the markup'); continue; }
    const at = image.offset;
    const src = image.src ?? '';
    if (image.html && image.srcset) bodyError(at, 'srcset is not supported; use a single src');
    // kramdown renders the last of a repeated attribute and browsers reading the tag as written the first.
    for (const name of image.repeated ?? []) bodyError(at, `<img> repeats the ${name} attribute; write it once`);
    // kramdown renders an empty Markdown destination as `<img src="">`, which loads nothing.
    if (src === '') bodyError(at, image.html ? '<img> has no src' : 'image has no source');
    if (typeof image.alt !== 'string' || image.alt.trim() === '') {
      bodyError(at, `image has no alt text${src === '' ? '' : ` (${preview(src)})`}`);
    }
    if (src !== '') {
      const problem = sourceProblem(src);
      if (problem !== null) bodyError(at, problem);
    }
    const { definition } = image;
    if (definition !== undefined && !checkedDefinitions.has(definition)) {
      checkedDefinitions.add(definition);
      // The other definitions of the label, any of which kramdown may render.
      for (const other of definition.others) {
        if (other === '') {
          bodyError(at, 'another link definition of this image\'s label gives it no source');
          continue;
        }
        const problem = sourceProblem(other);
        if (problem !== null) bodyError(at, `another link definition of this image's label: ${problem}`);
      }
      if (definition.attributes !== undefined) {
        for (const message of attributeListErrors(definition.attributes, src, sourceProblem)) bodyError(at, message);
      }
    }
    if (image.attributes !== undefined) {
      for (const message of attributeListErrors(image.attributes, src, sourceProblem)) bodyError(at, message);
    }
  }
  return errors;
}


/* ------------------------------------------------------------------------ */
/* Unsafe markup                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Start of a raw HTML start tag through its name, for attribute scanning.
 * The name is one kramdown reads (REXML's `UNAME`: letters of any script,
 * digits, `-`, `_`, `.` and one `prefix:`) or one a browser reads in the
 * rendered page (an ASCII letter, then anything but whitespace, `/` and
 * `>`), since kramdown copies unknown and custom elements, and the content
 * of raw elements, through unchanged. Nothing follows the name in the
 * pattern, so the search never backtracks into it; a tag that never closes
 * is dropped by `markupOutsideCode`. Autolinks kramdown certainly renders as
 * links are removed beforehand by `hideAutolinks`.
 */
const TAG_START_RE = new RegExp(`<(?:[a-zA-Z][^\\s/>]*|${UNAME})`, 'gu');

/**
 * `masked` with the `<` of each of `autolinks` (sorted `{ start, end }`
 * offsets, from `findCodeRegions`) replaced by a space, so tag discovery
 * passes over `<https://…>`, `<mailto:…>` and `<a@b.example>` where kramdown
 * renders them as links: in running text on every reading. Anywhere else,
 * as at the start of an HTML block (`<http:x onclick="…">`) or inside raw
 * HTML, kramdown may keep the same text as a tag, so it is scanned like one.
 */
function hideAutolinks(masked, autolinks) {
  if (autolinks.length === 0) return masked;
  let out = '';
  let pos = 0;
  for (const { start } of autolinks) {
    out += `${masked.slice(pos, start)} `;
    pos = start + 1;
  }
  return out + masked.slice(pos);
}

/**
 * Notes every event-handler attribute and `javascript:` value in `source`,
 * text of a tag or attribute list starting at offset `start`, on the line
 * where each one stands. The value check also looks through character
 * references (`&#106;avascript:`), which kramdown passes through and
 * browsers decode (verified with kramdown 2.4.0); a decoded match is noted
 * where its text starts in the source. `eventRe` must carry the `g` flag.
 */
function noteAttributeRisks(found, { start, source }, eventRe) {
  for (const m of source.matchAll(eventRe)) found.note(start + m.index + 1);
  for (const m of source.matchAll(JS_URL_ATTR_RE)) found.note(start + m.index);
  if (!source.includes('&')) return;
  const decoded = decodeEntitiesMapped(source);
  for (const m of decoded.text.matchAll(JS_URL_ATTR_RE)) found.note(start + decoded.from[m.index]);
}

/**
 * `noteAttributeRisks` for every construct in `extents` (`{ start, end }`
 * of one kind, ordered by start), reading each character of `text` once
 * however much the constructs overlap: `'<img '.repeat(n) + '>'` holds n
 * tags ending at the same `>`. Taken in start order, each construct is
 * scanned only past `covered`, the furthest end scanned so far, and skipped
 * when it ends by then. This finds exactly what scanning each construct
 * whole would: a skipped part lies inside a construct already scanned, and
 * no match crosses from one scanned window into the next, because windows
 * meet only just after a `>` or `}` or at a `<` or `{`, and no
 * event-handler or `javascript:` match, decoded or raw, holds any of these
 * (a character reference is made of none of them either).
 */
function noteExtentRisks(found, text, extents, eventRe) {
  let covered = -1;
  for (const { start, end } of extents) {
    if (end <= covered) continue;
    const from = Math.max(start, covered + 1);
    noteAttributeRisks(found, { start: from, source: text.slice(from, end + 1) }, eventRe);
    covered = end;
  }
}

/**
 * Notes every `javascript:` URL in a Markdown URL position of `masked` (the
 * body with its code blanked) at the offset of its delimiter. The delimiters
 * (`MD_URL_START_RE`) are found in `masked` itself, so each is a literal
 * source character outside code; the URL after one is read in `masked`
 * decoded once, at the first decoded character whose source offset
 * (`decodeEntitiesMapped`) is not before the delimiter's end. One decoding
 * and one forward pointer serve every delimiter, so dense delimiters such as
 * `<<<<` or `](](` keep the scan linear.
 */
function noteMarkdownUrlRisks(found, masked) {
  const { text, from } = masked.includes('&') ? decodeEntitiesMapped(masked) : { text: masked, from: null };
  let k = 0;
  for (const m of masked.matchAll(MD_URL_START_RE)) {
    const end = m.index + m[0].length;
    if (from === null) k = end;
    else while (k < text.length && from[k] < end) k += 1;
    JS_URL_DEST_RE.lastIndex = k;
    if (JS_URL_DEST_RE.test(text)) found.note(m.index);
  }
}

/**
 * Finds markup in a Markdown body that could run script or change the page.
 * Code the model identifies with certainty, fenced and inline code as
 * kramdown reads them, is skipped. Forms it cannot decide, such as indented
 * code, code inside a blockquote and other ambiguous cases, are scanned as
 * prose, so HTML shown there as a code sample may be reported. The same
 * patterns as the built-page prose scan:
 *   - opening `script`, `iframe`, `object`, `embed`, `form`, `base`, `meta`,
 *     `link` and `style` tags, in any letter case;
 *   - `on…=` event-handler attributes in any raw start tag, whatever name
 *     kramdown or a browser reads for it (`<x:note>`, `<x_note>`, `<x.note>`,
 *     `<é>`), except Markdown autolinks such as `<https://…>` in running
 *     text, which kramdown renders as links (`hideAutolinks`), and in
 *     kramdown attribute lists such as `{: onclick="…"}`, which add
 *     attributes to the rendered element;
 *   - `javascript:` URLs (whitespace before the colon allowed, any letter
 *     case) in URL positions only: after `](`, after `]:`, after `<`, and
 *     after `=` inside a tag or attribute list, each read through the
 *     character references a browser decodes there (`&#106;avascript:`,
 *     `javascript&colon;`).
 *
 * This source scan does not evaluate Liquid or run kramdown; the built-page
 * prose scan over rendered HTML remains the check of record.
 *
 * @param {string} body Markdown body (from `parseArticle`).
 * @returns {Array<{ line: number, text: string }>} One finding per line, ordered by line;
 *   `line` is 1-based within `body` and `text` is that line of `body`, trimmed.
 */
export function scanUnsafeMarkup(body) {
  const text = asText(body, 'body');
  const code = {};
  const masked = maskCode(text, findCodeRegions(text, code));
  const found = lineFindings(text);
  for (const m of masked.matchAll(UNSAFE_TAG_RE)) found.note(m.index);
  const { tags, lists } = markupOutsideCode(text, hideAutolinks(masked, code.autolinks), TAG_START_RE, true);
  noteExtentRisks(found, text, tags, TAG_EVENT_ATTR_RE);
  noteExtentRisks(found, text, lists, IAL_EVENT_ATTR_RE);
  noteMarkdownUrlRisks(found, masked);
  return found.list();
}

/* ------------------------------------------------------------------------ */
/* Liquid inside code                                                        */
/* ------------------------------------------------------------------------ */

/**
 * `{% raw %}` regions of `text`: each `raw` tag through the next `endraw`
 * tag, or to the end when it is never closed. The tags usually wrap a fence
 * from outside, so a region covers the whole block between them.
 */
function rawRegions(text) {
  const regions = [];
  const open = new RegExp(RAW_OPEN_RE.source, 'g');
  const close = new RegExp(RAW_CLOSE_RE.source, 'g');
  let m;
  while ((m = open.exec(text)) !== null) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(text);
    const end = c ? c.index + c[0].length : text.length;
    regions.push({ start: m.index, end });
    open.lastIndex = end;
  }
  return regions;
}

/**
 * Pairs the backtick runs of one paragraph, `text` from `from` to `to`, as
 * kramdown's `parse_codespan` does when no other span parser takes them, and
 * appends each span to `out` as `{ start, end }`. `at` and `len` hold the
 * paragraph's runs (offset and length, ascending). A run of n backticks opens
 * a span that ends n backticks into the first later run at least n long,
 * whose remaining backticks open the next span; a single backtick at the
 * start or after whitespace and before whitespace is literal; and after an
 * odd number of backslashes a run loses its first backtick to the escape.
 * Linear in the paragraph's runs: a suffix maximum of their lengths rejects
 * a search that cannot succeed at once, and a search that succeeds visits
 * only the runs inside its span.
 */
function pairBackticks(text, from, to, at, len, out) {
  const longest = new Array(at.length + 1).fill(0);
  for (let k = at.length - 1; k >= 0; k -= 1) longest[k] = Math.max(len[k], longest[k + 1]);
  let carry = -1;
  let carried = 0;
  for (let k = 0; k < at.length;) {
    let start = at[k];
    let size = len[k];
    if (carry !== -1) {
      // Backticks left over from the run that closed the previous span.
      start = carry;
      size = carried;
      carry = -1;
    } else {
      let slashes = 0;
      while (start - slashes - 1 >= from && text[start - slashes - 1] === '\\') slashes += 1;
      if (slashes % 2 === 1) {
        start += 1;
        size -= 1;
      }
      const lone = size === 1 && (start === from || isRubySpace(text[start - 1]))
        && start + 1 < to && isRubySpace(text[start + 1]);
      if (size === 0 || lone) {
        k += 1;
        continue;
      }
    }
    if (longest[k + 1] < size) {
      k += 1;
      continue;
    }
    let j = k + 1;
    while (len[j] < size) j += 1;
    out.push({ start, end: at[j] + size });
    if (len[j] > size) {
      carry = at[j] + size;
      carried = len[j] - size;
      k = j;
    } else {
      k = j + 1;
    }
  }
}

/**
 * Inline code spans kramdown could read in `masked`, a body whose certain
 * code regions `maskCode` has blanked, as sorted `{ start, end }` offsets:
 * the backtick pairs of every paragraph (run of non-blank lines), across
 * line breaks included (`pairBackticks`). The backtick runs are listed in
 * one pass over the body and each paragraph is handed only its own, so the
 * work stays linear however many paragraphs the body has.
 */
function possibleCodeSpans(masked) {
  const spans = [];
  const at = [];
  const len = [];
  for (const m of masked.matchAll(/`+/g)) {
    at.push(m.index);
    len.push(m[0].length);
  }
  if (at.length === 0) return spans;
  const lines = splitLines(masked);
  const blank = (j) => BLANK_LINE_RE.test(stripCr(lines[j].text));
  let r = 0;
  for (let s = 0; s < lines.length && r < at.length; s += 1) {
    if (blank(s)) continue;
    let e = s;
    while (e + 1 < lines.length && !blank(e + 1)) e += 1;
    const from = lines[s].start;
    const to = lines[e].end;
    // A run never holds a line break, so it lies within one paragraph.
    while (r < at.length && at[r] < from) r += 1;
    let q = r;
    while (q < at.length && at[q] < to) q += 1;
    if (q > r) pairBackticks(masked, from, to, at.slice(r, q), len.slice(r, q), spans);
    r = q;
    s = e;
  }
  return spans;
}

/**
 * The union of two lists of `{ start, end }` regions, each sorted by start
 * and disjoint, as sorted, disjoint regions (overlapping or touching ones
 * joined).
 */
function mergeRegions(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const r = j >= b.length || (i < a.length && a[i].start <= b[j].start) ? a[i++] : b[j++];
    const last = out[out.length - 1];
    if (last !== undefined && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Code regions for the Liquid-in-code warning only, as sorted, disjoint
 * `{ start, end }` offsets: the certain regions of `findCodeRegions` and
 * every inline span kramdown could read in the rest of the body
 * (`possibleCodeSpans`). kramdown pairs backticks across line breaks within
 * a paragraph, and the marker runs of a fence inside a blockquote or an
 * indented one pair the same way; the safety mask leaves all of these to
 * prose, while Liquid evaluates them first all the same. Warnings may
 * therefore over-report. This never changes the mask that
 * `scanUnsafeMarkup` and `validateArticle` use.
 */
function possibleCodeRegions(text) {
  const certain = findCodeRegions(text);
  return mergeRegions(certain, possibleCodeSpans(maskCode(text, certain)));
}

/**
 * Finds Liquid syntax (`{{` or `{%`) inside fenced or inline code that no
 * `{% raw %}…{% endraw %}` region protects. Jekyll runs Liquid before
 * Markdown, so such text is evaluated instead of shown and can break the
 * build. `raw` and `endraw` tags themselves are not reported. Callers treat
 * the findings as warnings. Code here includes what kramdown may read as
 * code but the unsafe-markup scan's conservative mask does not, such as an
 * inline span across a line break (see `possibleCodeRegions`), so a warning
 * may be raised for text that renders as prose.
 *
 * @param {string} body Markdown body (from `parseArticle`).
 * @returns {Array<{ line: number, text: string }>} One finding per line, ordered by line;
 *   `line` is 1-based within `body`.
 */
export function findUnrawLiquidInCode(body) {
  const text = asText(body, 'body');
  const raw = rawRegions(text);
  const found = lineFindings(text);
  // Code regions and the matches in each come in ascending order, and raw
  // regions are ordered and disjoint, so one cursor finds the raw region
  // that could hold each match.
  let next = 0;
  for (const region of possibleCodeRegions(text)) {
    for (const m of text.slice(region.start, region.end).matchAll(LIQUID_IN_CODE_RE)) {
      const at = region.start + m.index;
      while (next < raw.length && raw[next].end <= at) next += 1;
      if (next < raw.length && raw[next].start <= at) continue;
      RAW_TAG_AT_RE.lastIndex = at;
      if (RAW_TAG_AT_RE.test(text)) continue;
      found.note(at);
    }
  }
  return found.list();
}

/* ------------------------------------------------------------------------ */
/* Inbound references                                                        */
/* ------------------------------------------------------------------------ */

/** Filename stem named by a `post_url` or `link` tag argument. */
function tagTargetStem(arg) {
  return posix.basename(arg.replace(/^["']|["']$/g, '')).replace(/\.md$/, '');
}

/**
 * Finds references to one article in other articles, so it is not
 * unpublished while they remain: a remaining `post_url` would fail the Pages
 * build and leave the old page live, and an ordinary link would break.
 *
 * Matches, anywhere in each article's full text (front matter included):
 *   - `{% post_url <stem> %}` and `{% link …/<stem>.md %}` tags whose target
 *     filename is the article's (both fail the build once it is gone);
 *   - links to `/blog/<slug>` in any form: root-relative, after
 *     `{{ site.baseurl }}` or inside `relative_url`, under a project base path
 *     (`/cabrillo-coast/blog/<slug>/`), absolute on any host, and
 *     page-relative `../<slug>/`; `/blog/<slug>-more/` does not match.
 *
 * @param {string} slug The article's slug.
 * @param {string} postFile The article's filename stem, such as `2026-01-15-foo`
 *   (a trailing `.md` or leading folders are ignored).
 * @param {Array<{ path: string, text: string }>} articles Articles to search. The one whose
 *   basename is `<postFile>.md` is skipped.
 * @returns {Array<{ file: string, line: number, text: string }>} One entry per file and line,
 *   in input order and then line order; `line` is 1-based and `text` the trimmed line.
 */
export function findInboundReferences(slug, postFile, articles) {
  if (typeof slug !== 'string' || slug === '') throw new TypeError('slug must be a non-empty string');
  if (typeof postFile !== 'string' || postFile === '') throw new TypeError('postFile must be a non-empty string');
  const stem = posix.basename(postFile).replace(/\.md$/, '');
  const link = new RegExp(`(?:/blog/|\\.\\./)${escapeRegExp(slug)}(?=[/#?"'()\\s>]|$)`, 'g');
  const results = [];
  for (const article of articles ?? []) {
    const file = article?.path;
    if (typeof file !== 'string' || file === '') throw new TypeError('each article needs a non-empty path');
    if (posix.basename(file) === `${stem}.md`) continue;
    const text = asText(article.text, `text of ${file}`);
    const found = lineFindings(text);
    for (const re of [POST_URL_TAG_RE, LINK_TAG_RE]) {
      for (const m of text.matchAll(re)) {
        if (tagTargetStem(m[1]) === stem) found.note(m.index);
      }
    }
    for (const m of text.matchAll(link)) found.note(m.index);
    for (const finding of found.list()) results.push({ file, line: finding.line, text: finding.text });
  }
  return results;
}

/* ------------------------------------------------------------------------ */
/* Tracked content                                                           */
/* ------------------------------------------------------------------------ */

function normalizePath(p) {
  return p.replace(/^(?:\.\/)+/, '');
}

/**
 * The folder refusal for one tracked path, or null. Each folder below keeps
 * a file from the site, or puts it there unchecked, while GitHub shows it:
 *   - a `_drafts/` folder at any depth, or `assets/drafts/` (rule 1 of
 *     `checkTrackedContent`). Jekyll reads `<dir>/_drafts/` in every folder it
 *     builds when run with `--drafts`;
 *   - a `_posts/` folder below the root. Jekyll reads `<dir>/_posts/` in every
 *     folder it builds as posts, but `ARTICLE_PATH_RE` and the article checks
 *     cover only the root one;
 *   - a folder inside the root `_posts/` whose name starts with `_`, `.`, `#`
 *     or `~`. Jekyll 3.10.0 skips such a folder directly below `_posts/`, so
 *     its posts never reach the site. It reads deeper ones, so refusing them
 *     at every depth is stricter than Jekyll on purpose: a misjudgement here
 *     can only produce a false finding, which the author fixes by renaming
 *     the folder, never a missed one.
 * Folder names are matched whole: `notes/my_drafts/` and `_posts/sub/` pass.
 */
function folderRefusal(p) {
  if (DRAFTS_FOLDER_RE.test(p) || p.startsWith('assets/drafts/')) {
    return `${p}: drafts and draft images must never be tracked (git rm --cached; they belong only in your working copy)`;
  }
  if (NESTED_POSTS_FOLDER_RE.test(p)) {
    return `${p}: articles belong only in the root _posts/ folder; Jekyll can read a nested _posts/ folder `
      + 'as posts, but the article checks cover only the root one';
  }
  if (p.startsWith('_posts/')) {
    const skipped = p.split('/').slice(1, -1).find((name) => SKIPPED_FOLDER_RE.test(name));
    if (skipped !== undefined) {
      return `${p}: folder ${skipped}/ is not allowed in _posts/; Jekyll can skip folders whose names start `
        + 'with _, ., # or ~, so a post in one could stay off the site while public on GitHub';
    }
  }
  return null;
}

/** Every entry `analyzeArticle` made; a cache value from anywhere else is never reused. */
const ARTICLE_ANALYSES = new WeakSet();

/**
 * Everything `checkTrackedContent` derives from an article's text alone: the
 * parse, the file line on which the body starts, the `analyzeBody` result
 * and the `scanUnsafeMarkup` findings. `text` is kept so that a cached entry
 * is reused only for identical text.
 */
function analyzeArticle(text) {
  const { data, body, errors } = parseArticle(text);
  const entry = {
    text,
    data,
    body,
    parseErrors: errors,
    bodyStartLine: text.slice(0, text.length - body.length).split('\n').length,
    bodyAnalysis: analyzeBody(body),
    unsafe: scanUnsafeMarkup(body),
  };
  ARTICLE_ANALYSES.add(entry);
  return entry;
}

/**
 * Applies the rules for content that may sit in the public repository to a
 * complete tree (the staged index for `guard --staged`, each pushed commit
 * for `guard --pre-push`, the working tree for the AC-01 test):
 *   1. nothing in a `_drafts/` folder at any depth (`blog/_drafts/` and
 *      `_posts/_drafts/` included) or under `assets/drafts/` is tracked;
 *   2. no article has a `published:` key (through `validateArticle`);
 *   3. no article path (`ARTICLE_PATH_RE`) carries a date after `todayUtc`;
 *   4. every `assets/blog/<slug>/` folder has a matching
 *      `_posts/…/YYYY-MM-DD-<slug>.md`, and no file sits directly in
 *      `assets/blog/`. Because `paths` is the whole tree, a deletion of a
 *      post whose image folder remains is caught.
 * Each rule keeps material from being hidden from the site while staying
 * world-readable on GitHub. For the same reason:
 *   - nothing is tracked in a `_posts/` folder below the root, such as
 *     `blog/_posts/`: Jekyll can publish it as posts, but rules 2 and 3 and the
 *     article checks cover only the root `_posts/` and `tests/fixtures/posts/`;
 *   - no folder inside `_posts/` has a name starting with `_`, `.`, `#` or `~`,
 *     such as `_posts/_hold/`: Jekyll skips it, so its posts stay off the site
 *     (deeper ones, which Jekyll reads, are refused too; see `folderRefusal`);
 *   - every file in `_posts/` must be a correctly named Markdown article
 *     (Jekyll silently skips a misnamed post);
 *   - two posts may not share a slug (they would publish to the same URL and
 *     one would vanish).
 * A path refused by rule 1 or either folder rule gets one such refusal and
 * is not counted as a post: it is never a duplicate slug and never the post
 * of an `assets/blog/<slug>/` folder.
 *
 * Each given article is then parsed, validated as a post with its images
 * checked against `paths`, and scanned for unsafe markup, with every finding
 * on its file line. What depends on an article's text alone (its parse, code
 * regions, placeholder lines, images and unsafe-markup findings) is stored in
 * `cache` under the article's `id`, so a caller checking the same blob in
 * several trees, as `guard --pre-push` does across commits, parses it once.
 * An entry is reused only for identical text, and the filename, date, folder
 * and image-existence rules run for every article on every call.
 *
 * @param {object} args
 * @param {string[]} args.paths The complete tree as repository-relative POSIX paths
 *   (a leading `./` is removed; empty strings are ignored).
 * @param {Array<{ path: string, text: string, id?: string }>} [args.articles] Articles to
 *   validate, typically those added or changed (default `[]`). `id`, such as the git blob id,
 *   names the text in `cache`; it must be a non-empty string when given, and an article
 *   without one is analysed afresh.
 * @param {Map<string, object> | null} [args.cache] Text analyses by `id`, owned by the caller
 *   and passed to every call that should share them. Omitted, `null` or `undefined`, it is a
 *   new `Map` for this call only. Its values are opaque; any not made here is replaced. Any
 *   other value that is not a `Map` is a `TypeError`.
 * @param {string} [args.todayUtc] Today as `YYYY-MM-DD` in UTC (default: the current UTC date).
 * @returns {string[]} Errors, each starting with its path; path rules first, then the
 *   articles in input order. Identical messages are reported once.
 */
export function checkTrackedContent({ paths, articles, todayUtc, cache } = {}) {
  const today = resolveToday(todayUtc);
  if (cache !== undefined && cache !== null && !(cache instanceof Map)) throw new TypeError('cache must be a Map');
  const analyses = cache ?? new Map();
  const tree = [];
  const pathSet = new Set();
  for (const p of paths ?? []) {
    if (typeof p !== 'string') throw new TypeError('paths must contain strings');
    const n = normalizePath(p);
    if (n === '' || pathSet.has(n)) continue;
    pathSet.add(n);
    tree.push(n);
  }
  const errors = [];

  // Rule 1 and the folder rules (`folderRefusal`): drafts and draft images,
  // nested _posts/ folders and skipped folders in _posts/, at most one per path.
  const misplaced = new Set();
  for (const p of tree) {
    const refusal = folderRefusal(p);
    if (refusal === null) continue;
    misplaced.add(p);
    errors.push(refusal);
  }

  // Files in _posts/: Markdown articles only, correctly named, one per slug.
  // A path refused above is not counted as a post, so it neither collides
  // with another post nor stands as an image folder's post.
  const postsBySlug = new Map();
  for (const p of tree) {
    if (!p.startsWith('_posts/')) continue;
    if (!p.endsWith('.md')) {
      errors.push(`${p}: only Markdown articles named YYYY-MM-DD-<slug>.md may be tracked in _posts/`);
      continue;
    }
    const m = POST_PATH_RE.exec(p);
    if (!m) {
      errors.push(`${p}: post filename must be YYYY-MM-DD-<slug>.md`);
      continue;
    }
    const slug = m[2];
    if (misplaced.has(p)) continue;
    if (postsBySlug.has(slug)) {
      errors.push(`${p}: slug ${slug} is already used by ${postsBySlug.get(slug)}; both would publish to /blog/${slug}/`);
    } else {
      postsBySlug.set(slug, p);
    }
  }

  // Rule 3: future-dated articles.
  for (const p of tree) {
    if (!ARTICLE_PATH_RE.test(p)) continue;
    const m = DATED_BASENAME_RE.exec(posix.basename(p));
    if (m && isCalendarDate(m[1]) && m[1] > today) errors.push(futureDateMessage(p, m[1], today));
  }

  // Rule 4: article image folders need their post.
  const imageSlugs = new Set();
  for (const p of tree) {
    if (!p.startsWith('assets/blog/')) continue;
    const rest = p.slice('assets/blog/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) {
      errors.push(`${p}: files directly in assets/blog/ are not allowed; images belong in assets/blog/<slug>/`);
      continue;
    }
    const slug = rest.slice(0, slash);
    if (imageSlugs.has(slug)) continue;
    imageSlugs.add(slug);
    if (!postsBySlug.has(slug)) {
      errors.push(`assets/blog/${slug}/: image folder has no matching _posts/*-${slug}.md`);
    }
  }

  // Article rules on the given articles.
  const imageExists = (publicPath) => pathSet.has(publicPath.replace(/^\//, ''));
  for (const article of articles ?? []) {
    if (typeof article?.path !== 'string' || article.path === '') {
      throw new TypeError('each article needs a non-empty path');
    }
    const path = normalizePath(article.path);
    const text = asText(article.text, `text of ${path}`);
    const id = article.id ?? null;
    if (id !== null && (typeof id !== 'string' || id === '')) {
      throw new TypeError(`id of ${path} must be a non-empty string`);
    }
    let entry = id === null ? undefined : analyses.get(id);
    if (!ARTICLE_ANALYSES.has(entry) || entry.text !== text) {
      entry = analyzeArticle(text);
      if (id !== null) analyses.set(id, entry);
    }
    const { data, body, parseErrors, bodyStartLine, bodyAnalysis, unsafe } = entry;
    for (const e of parseErrors) errors.push(`${path}: ${e}`);
    const articleErrors = validateWithAnalysis(
      { path, data, body, kind: 'post', todayUtc: today, imageExists, bodyStartLine },
      bodyAnalysis,
    );
    for (const e of articleErrors) errors.push(e);
    for (const finding of unsafe) {
      errors.push(`${path}:${bodyStartLine + finding.line - 1}: unsafe markup: ${finding.text}`);
    }
  }
  return [...new Set(errors)];
}
