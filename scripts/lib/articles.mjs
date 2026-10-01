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
 * Front matter accepts `title`, `summary`, `tags`, `updated` and `author` only,
 * written in a restricted YAML subset that `parseArticle` reads without a
 * library.
 *
 * How the Markdown scanners decide what is code: the live site is rendered by
 * kramdown 2.4.0 with GFM input, so a scanner that treats text as code when
 * kramdown does not would hide real markup. Text is therefore masked as code
 * only where both CommonMark and kramdown agree that it is code, and every
 * uncertain case is scanned as prose. A misjudgement can only produce a false
 * finding, which the author fixes by rewording, never a missed one. Each place
 * where these rules are narrower than plain CommonMark is commented below with
 * the kramdown behaviour that decided it.
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

/** Front-matter keys that Jekyll understands but this schema sets elsewhere. */
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

/** Start of an HTML tag. Markdown autolinks such as `<https://…>` do not match. */
const TAG_START_RE = /<[a-zA-Z][a-zA-Z0-9-]*(?=[\s/>])/g;

/** Start of a kramdown attribute list (`{: …}`, `{:#id}`, ALDs). */
const IAL_START_RE = /\{:/g;

/** Event-handler attribute inside a tag, and inside an attribute list. */
const TAG_EVENT_ATTR_RE = /[\s"'/]on[a-z]+\s*=/i;
const IAL_EVENT_ATTR_RE = /[\s"'/:]on[a-z]+\s*=/i;

/**
 * The `javascript` scheme. Browsers remove tabs and line breaks anywhere in a
 * URL and ignore leading spaces and control characters, so those are allowed
 * between the letters and before the scheme; whitespace before the colon is
 * tolerated as well.
 */
const JS_SCHEME = 'j[\\t\\n\\r]*a[\\t\\n\\r]*v[\\t\\n\\r]*a[\\t\\n\\r]*s[\\t\\n\\r]*c[\\t\\n\\r]*'
  + 'r[\\t\\n\\r]*i[\\t\\n\\r]*p[\\t\\n\\r]*t\\s*:';

/**
 * `javascript:` in Markdown URL positions: an inline link or image
 * destination `](`, a link definition `]:`, and an angle-bracket URL `<`.
 *
 * The scheme is matched only where a URL can stand, never as a bare word, so
 * prose such as a heading "JavaScript: closures explained" does not block
 * publishing a technical article, while every way a URL can be written is
 * still caught.
 */
const JS_URL_MARKDOWN_RE = new RegExp(`(?:\\]\\(\\s*<?|\\]:\\s*<?|<)[\\s\\u0000-\\u001f]*${JS_SCHEME}`, 'gi');

/** Link text as kramdown counts brackets in it, one level of nesting deep. */
const BRACKETED_TEXT = '(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*';

/** `javascript:` after `=` (optionally quoted), applied inside tags and attribute lists only. */
const JS_URL_ATTR_RE = new RegExp(`=\\s*["']?[\\s\\u0000-\\u001f]*${JS_SCHEME}`, 'i');

/**
 * Markdown inline image `![alt](dest "title")` as kramdown's link parser reads
 * it: the alt text may hold bracketed text, `dest` may be a Liquid
 * expression, an `<…>` URL, or a URL holding spaces (except before a quote,
 * which starts the title) and balanced parentheses (kramdown has no
 * parenthesised titles; verified). Groups: 1 alt, 2 destination. The
 * captures are possessive, as no shorter match could succeed.
 */
const IMG_INLINE_RE = new RegExp(
  `!\\[(?=(${BRACKETED_TEXT}))\\1\\]\\(\\s*`
  + `(?=(\\{\\{[\\s\\S]*?\\}\\}[^\\s)]*|<[^>\\n]*>|(?:[^\\s()]|[ \\t]+(?=[^\\s"')])|\\([^()\\n]*\\))+))\\2`
  + `(?:\\s+(?:"[^"]*"|'[^']*'))?\\s*\\)`,
  'g',
);

/**
 * Markdown reference image `![alt][id]`, `![alt][]` or shortcut `![alt]`;
 * kramdown allows any whitespace, a line break included, before `[id]`.
 */
const IMG_REFERENCE_RE = new RegExp(`!\\[(${BRACKETED_TEXT})\\](?:\\s*?\\[([^\\]]*)\\])?`, 'g');

/**
 * Link reference definition `[id]: dest "title"`; like kramdown, `dest` runs
 * to the end of the line, spaces included, before an optional title.
 */
const LINK_DEFINITION_RE = /^ {0,3}\[([^\]\n]+)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|[^\n]*?\S)(?:(?:[ \t]*\n|[ \t]+)[ \t]*(["'])[^\n]*?\3)?[ \t]*$/gm;

/** Raw HTML `<img …>` start. */
const IMG_TAG_START_RE = /<img(?=[\s/>])/gi;

/** One attribute inside a tag: name, then a double-quoted, single-quoted or bare value. */
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const LIQUID_RELATIVE_URL_RE = /^\{\{-?\s*(['"])(\/[^'"]*)\1\s*\|\s*relative_url\s*-?\}\}$/;
const LIQUID_BASEURL_RE = /^\{\{-?\s*site\.baseurl\s*-?\}\}(\/.*)$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const RAW_OPEN_RE = /\{%-?\s*raw\s*-?%\}/g;
const RAW_CLOSE_RE = /\{%-?\s*endraw\s*-?%\}/g;
const RAW_TAG_AT_RE = /\{%-?\s*(?:end)?raw\s*-?%\}/y;
const LIQUID_IN_CODE_RE = /\{\{|\{%/g;

const POST_URL_TAG_RE = /\{%-?\s*post_url\s+([^\s%]+)\s*-?%\}/g;
const LINK_TAG_RE = /\{%-?\s*link\s+([^\s%]+)\s*-?%\}/g;

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

/** Counts characters by code point, so an emoji or accented letter counts once. */
function charCount(s) {
  return [...s].length;
}

/** True for a string that is not empty after trimming. */
function isFilled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Returns `lineAt(offset)` for `text`: the 1-based line number of `offset`,
 * that is 1 plus the newlines before it. Line starts are indexed once and
 * searched in O(log n), so scanners stay linear however many findings a body
 * produces.
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
 * Decodes the HTML character references a browser would decode in an
 * attribute value: numeric references (the semicolon is optional, as browsers
 * allow) and the named references that can spell a URL scheme. Used only to
 * look through obfuscation such as `&#106;avascript:`; reported text always
 * comes from the original source.
 */
function decodeEntities(s) {
  return s
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (all, hex) => codePointText(Number.parseInt(hex, 16), all))
    .replace(/&#(\d+);?/g, (all, dec) => codePointText(Number.parseInt(dec, 10), all))
    .replace(/&([a-zA-Z]+);/g, (all, name) => {
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : all;
    });
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
 *
 * The model was checked against kramdown's own output on more than 140,000
 * generated documents: none had live markup masked.
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
/** kramdown `HTML_TAG_RE` (sticky). Groups: 1 name, 2 attributes, 5 the self-closing slash. */
const KD_TAG_RE = new RegExp(
  `<(?=(${UNAME}))\\1${RUBY_SPACE}*`
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
/** kramdown `HTML_RAW_START`: where raw HTML parsing looks for the next tag. */
const KD_RAW_START_RE = /<(?=[\p{Alpha}_/?]|!--)/gu;
/** kramdown `HTML_MARKDOWN_ATTR_MAP` values. */
const MARKDOWN_ATTR_MODES = new Set(['0', '1', 'span', 'block']);

const BLANK_LINE_RE = /^[ \t]*$/;
/** kramdown-parser-gfm `FENCED_CODEBLOCK_START`. */
const FENCE_START_RE = /^ {0,3}([~`]{3,})/;
/** Rest of an opening fence line: at most one word of info (kramdown's `\s*?(\S+?)?\s*?\n`). */
const FENCE_TAIL_RE = /^[ \t\r\f\v]*[^ \t\r\n\f\v]*[ \t\r\f\v]*$/;
/** kramdown `LIST_START_UL` / `LIST_START_OL`: indentation, marker, rest of the line. */
const LIST_START_RE = /^( {0,3})(?:([+*-])|\d+\.)([\t| ].*)$/;
/** kramdown `LIST_ITEM_IAL_CHECK`: an item whose first line is empty or only an IAL. */
const LIST_ITEM_EMPTY_RE = /^[ \t]*(?:\{:(?![\w-]*:|\/)(?:\\\}|[^}])+\})?[ \t]*$/;
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
const OPTIONS_EXTENSION_RE = /\{::options\b/;
const RAW_EXTENSIONS = new Set(['comment', 'nomarkdown']);
const MATH_BLOCK_RE = /^ {0,3}\\?\$\$/;
/** Above this many open readings the model stops masking for the rest of the body. */
const MAX_HYPOTHESES = 64;
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
/** What Ruby's `String#strip` removes. */
const RUBY_STRIP_RE = /^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g;
/** Text after raw HTML on a line that could carry span markup on to the next line. */
const RESUME_DANGER_RE = /[`<\]]|\$\$|\{:|~~/;

function stripCr(s) {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function leadingSpaces(s) {
  return /^ */.exec(s)[0].length;
}

/* ---- kramdown list extraction ------------------------------------------ */

/**
 * The list item a line opens, following kramdown's `parse_first_list_line`:
 * `{ indent, kind, content }`, where `indent` is the content indentation
 * relative to the enclosing block and `content` the item's first line as its
 * content sees it. `m` is a `LIST_START_RE` match.
 */
function openItem(m) {
  const kind = m[2] ? 'bullet' : 'ordered';
  let indent = m[0].length - m[3].length;
  let content = m[3];
  if (LIST_ITEM_EMPTY_RE.test(content)) {
    indent = 4;
  } else {
    while (/^ *\t/.test(content)) {
      const temp = leadingSpaces(content) + indent;
      const expand = (all, sp, tabs) => sp + ' '.repeat(4 - (temp % 4) + (tabs.length - 1) * 4);
      content = content.replace(/^( *)(\t+)/, expand);
    }
    indent += leadingSpaces(content);
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

/**
 * Line of the fence closing an opening line, following kramdown-parser-gfm
 * 1.1.0 `FENCED_CODEBLOCK_MATCH` exactly, or -1 when there is none. `view`
 * is the opening line as its block sees it; `next(j)` returns line `j` the
 * same way (`null` once the block has ended), and `misses`, given only when
 * every reading sees the same lines (the top level), remembers closing
 * patterns no later line matches.
 *
 * kramdown's fence run `([~`]){3,}` can backtrack: a run of N characters may
 * act as a shorter run of k (3 ≤ k ≤ N) with the rest taken as info, so
 * "````" can close at "```". Each k is tried from N down, and for each the
 * first line holding the k-character prefix, more of its last character and
 * nothing else closes the fence.
 */
function kramdownFenceClose(view, index, lineCount, next, misses = null) {
  const m = FENCE_START_RE.exec(view);
  if (!m) return -1;
  const run = m[1];
  const after = view.slice(m[0].length);
  // Lines are fetched only as far as a search needs them.
  const seen = [];
  let ended = false;
  const viewAt = (i) => {
    while (!ended && seen.length <= i) {
      const j = index + 1 + seen.length;
      const v = j < lineCount ? next(j) : null;
      if (v === null) ended = true;
      else seen.push(v);
    }
    return i < seen.length ? seen[i] : null;
  };
  for (let k = run.length; k >= 3; k -= 1) {
    const prefix = run.slice(0, k);
    if (!FENCE_TAIL_RE.test(run.slice(k) + after)) continue;
    const close = new RegExp(`^ {0,3}${escapeRegExp(prefix)}${escapeRegExp(prefix[k - 1])}*[ \\t\\r\\f\\v]*$`);
    const missFrom = misses?.get(close.source);
    if (missFrom !== undefined && index + 1 >= missFrom) continue;
    for (let i = 0; ; i += 1) {
      const v = viewAt(i);
      if (v === null) {
        // No line from here on closes such a fence; the same holds for any
        // later opener reading the same lines.
        misses?.set(close.source, Math.min(index + 1, missFrom ?? Infinity));
        break;
      }
      if (close.test(v)) return index + 1 + i;
    }
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
 * Returns `b`, the end of a construct starting at `a` that hides the text it
 * spans, after stopping the walk when the construct crosses a line break or
 * leaves the current text.
 */
function consumeSpan(w, a, b, to) {
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

/** kramdown `parse_span_html` (after `parse_autolink`) at a `<`. */
function spanAngle(w, to, p) {
  const t = w.text;
  KD_AUTOLINK_RE.lastIndex = p;
  const auto = KD_AUTOLINK_RE.exec(t);
  if (auto !== null && p + auto[0].length <= to) return consumeSpan(w, p, p + auto[0].length, to);
  const after = p + 1 < to ? String.fromCodePoint(t.codePointAt(p + 1)) : '';
  if (!(SPAN_HTML_NEXT_RE.test(after) || t.startsWith('!--', p + 1))) {
    // Not HTML: `<<` is a typographic symbol, which hides its second `<`.
    return t.startsWith('<<', p) && p + 2 <= to ? p + 2 : p + 1;
  }
  if (t.startsWith('<!--', p)) {
    const close = findIn(w, '-->', p + 4, to);
    return close === -1 ? p + 1 : consumeSpan(w, p, close + 3, to);
  }
  if (t.startsWith('<?', p)) {
    const close = findIn(w, '?>', p + 2, to);
    return close === -1 ? p + 1 : consumeSpan(w, p, close + 2, to);
  }
  KD_TAG_CLOSE_RE.lastIndex = p;
  const close = KD_TAG_CLOSE_RE.exec(t);
  if (close !== null) return consumeSpan(w, p, p + close[0].length, to);
  KD_TAG_RE.lastIndex = p;
  const tag = KD_TAG_RE.exec(t);
  if (tag === null) return p + 1;
  const tagEnd = consumeSpan(w, p, p + tag[0].length, to);
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
  return consumeSpan(w, p, end, to);
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
  return close === -1 ? p + 1 : consumeSpan(w, p, close + 2, to);
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
  const end = consumeSpan(w, p, m.index + 3, to);
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
    misses: new Map(),
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
 * is code there.
 */
function tableRowCodes(text, codes) {
  if (text.includes('<code')) return [];
  const row = text.replace(/[ \t]+$/, '');
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
    const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
    const delimiter = '`'.repeat(longest + 1);
    const pad = delimiter.length > 1 ? ' ' : '';
    const rewrite = `${delimiter}${pad}${value}${pad}${delimiter}`;
    placed.set(`${a},${b}`, { cell: cells.length - 1, at: cells[cells.length - 1].length, length: rewrite.length });
    cells[cells.length - 1] += rewrite;
    from = b;
  }
  addRaw(row.slice(from));
  const cellCodes = cells.map((cell) => {
    const trimmed = cell.replace(RUBY_STRIP_RE, '');
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
 */
function runCodeSpans(texts, info, s, e) {
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
    misses: new Map(),
    work: SPAN_WORK_PER_CHAR * length + SPAN_WORK_BASE,
  };
  walkSpans(w, 0, w.text.length);
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

/** Inline code regions of every run of lines between blank lines and fences. */
function inlineCodeRegions(ctx, info) {
  const { lines, texts } = ctx;
  const out = [];
  const isBreak = (j) => info[j].code || BLANK_LINE_RE.test(texts[j]);
  for (let s = 0; s < info.length; s += 1) {
    if (isBreak(s)) continue;
    let e = s;
    while (e + 1 < info.length && !isBreak(e + 1)) e += 1;
    for (const [line, a, b] of runCodeSpans(texts, info, s, e)) {
      out.push({ start: lines[line].start + a, end: lines[line].start + b, kind: 'inline' });
    }
    s = e;
  }
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
  if (markerMayBeText) out.push(...blockLine(base, index, view, false, ctx));
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

  // Fenced code.
  if (FENCE_START_RE.test(view)) {
    const misses = depth === 0 ? ctx.fenceMisses : null;
    const close = kramdownFenceClose(view, index, texts.length, blockView(texts, index, r.items, depth), misses);
    if (close === -1) return [textStep({ ...r, para: true })];
    const opened = skip(r, close, 'code');
    if (!r.lazy || fresh) return [opened];
    // A fence in a lazy run may be swallowed by the block before it; it may
    // also be a top-level fence if the run is not what it seems.
    const out = [opened];
    if (depth > 0) {
      const top = kramdownFenceClose(texts[index], index, texts.length, (j) => texts[j], ctx.fenceMisses);
      if (top !== -1 && top !== close) out.push(skip({ ...r, items: [] }, top, 'code'));
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
    const stop = new RegExp(`^ {0,3}\\{:/(?:${escapeRegExp(ext[1])})?\\}[ \\t\\r\\f\\v]*$`);
    const next = blockView(texts, index, r.items, depth);
    for (let j = index + 1; j < texts.length; j += 1) {
      const v = next(j);
      if (v === null) break;
      if (stop.test(v)) {
        const raw = skip(r, j, 'raw');
        return RAW_EXTENSIONS.has(ext[1]) && !r.para ? [raw] : [raw, lazyTextStep(r)];
      }
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
 * `{ start, end, kind: 'fence' | 'inline' }` offsets into `body`.
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
 */
function findCodeRegions(body) {
  const lines = splitLines(body);
  const texts = lines.map((line) => stripCr(line.text));
  const ctx = { body, lines, texts, budget: 0, fenceMisses: new Map() };
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
    if (readings.length > MAX_HYPOTHESES) break;
  }
  closeCode(info.length - 1);
  regions.push(...inlineCodeRegions(ctx, info));
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
 * End offsets of tags and attribute lists in `text`, computed in one
 * backward pass so every lookup is O(1) and a body full of unclosed `<` or
 * `{:` cannot make a scan quadratic. For an offset `i` where a tag's
 * attributes or a list's content begins:
 *   - `quoted[i]`: the `>` that ends the tag, skipping `>` inside quoted
 *     attribute values; -1 when a quote is left open or no `>` follows;
 *   - `nextGt[i]`: the first `>` at or after `i` (the extent used when a
 *     quote is left open, as a browser would recover); -1 when none;
 *   - `brace[i]`: the `}` that ends a kramdown attribute list, where a
 *     backslash escapes the next character; -1 when none.
 */
function extentIndex(text) {
  const n = text.length;
  const nextGt = new Int32Array(n + 1).fill(-1);
  const nextDouble = new Int32Array(n + 1).fill(-1);
  const nextSingle = new Int32Array(n + 1).fill(-1);
  const quoted = new Int32Array(n + 1).fill(-1);
  const brace = new Int32Array(n + 2).fill(-1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = text[i];
    nextGt[i] = c === '>' ? i : nextGt[i + 1];
    nextDouble[i] = c === '"' ? i : nextDouble[i + 1];
    nextSingle[i] = c === "'" ? i : nextSingle[i + 1];
    if (c === '>') {
      quoted[i] = i;
    } else if (c === '"' || c === "'") {
      const close = (c === '"' ? nextDouble : nextSingle)[i + 1];
      quoted[i] = close === -1 ? -1 : quoted[close + 1];
    } else {
      quoted[i] = quoted[i + 1];
    }
    if (c === '}') brace[i] = i;
    else if (c === '\\') brace[i] = i + 1 < n ? brace[i + 2] : -1;
    else brace[i] = brace[i + 1];
  }
  return { nextGt, quoted, brace };
}

/**
 * Tags whose `<` lies outside code, as `{ start, source }`. The start is
 * found in the masked text, but the extent comes from the original text:
 * kramdown parses an HTML tag from its `<`, so backticks inside its
 * attributes are not code (`<img title="`" onerror="…" alt="`">` keeps its
 * `onerror`, verified). `startRe` must carry the `g` flag.
 */
function* tagsOutsideCode(body, masked, extents, startRe = TAG_START_RE) {
  for (const m of masked.matchAll(startRe)) {
    const attrStart = m.index + m[0].length;
    const end = extents.quoted[attrStart] !== -1 ? extents.quoted[attrStart] : extents.nextGt[attrStart];
    if (end !== -1) yield { start: m.index, source: body.slice(m.index, end + 1) };
  }
}

/** kramdown attribute lists outside code, with extents from the original text. */
function* attributeListsOutsideCode(body, masked, extents) {
  for (const m of masked.matchAll(IAL_START_RE)) {
    const end = extents.brace[m.index + 2];
    if (end !== -1) yield { start: m.index, source: body.slice(m.index, end + 1) };
  }
}

/** Text matched by the sticky regex `re` at `offset`, or `null`. */
function extentAt(text, offset, re) {
  const sticky = new RegExp(re.source, re.flags.includes('y') ? re.flags : `${re.flags}y`);
  sticky.lastIndex = offset;
  const m = sticky.exec(text);
  return m ? m[0] : null;
}


/* ------------------------------------------------------------------------ */
/* Front matter                                                              */
/* ------------------------------------------------------------------------ */

const FM_DELIMITER_RE = /^---[ \t]*$/;
const FM_BLANK_RE = /^[ \t]*$/;
const FM_COMMENT_RE = /^[ \t]*#/;
const FM_KEY_RE = /^([a-z_][a-z0-9_]*):(?:[ \t]+(.*?))?[ \t]*$/;
const FM_TRAILER_RE = /^(?:[ \t]*|[ \t]+#.*)$/;
const FLOW_BARE_ITEM_RE = /[^,[\]{}"'#]+/y;
const NOT_CLOSED_QUOTE = 'a double-quoted string must close on the same line';
const NOT_CLOSED_LIST = 'a flow list must close with ] on the same line, as in tags: [a, b]';

/** Defines an own enumerable property, so a key such as `__proto__` cannot alter the prototype. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
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
 * Reads the one-line flow list that starts at `s[0]`, such as `[a, "b c"]`.
 * Items are double-quoted strings or bare words; `[]` is the empty list.
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
      items.push(m[0].trim());
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
  const bare = raw.replace(/[ \t]+#.*$/, '').trim();
  if (bare === '') return { error: `${key} has no value` };
  return { value: bare };
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
 *   - a one-line flow list `[a, "b"]` of bare or double-quoted strings;
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
 *   `data` is a plain object. `errors` name the 1-based file line, as in
 *   `front matter line 3: title must be a double-quoted string`, and carry no
 *   path prefix; the caller adds it.
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
    const m = FM_KEY_RE.exec(line);
    if (m) {
      const key = m[1];
      if (seen.has(key)) {
        errors.push(`front matter line ${n}: duplicate key ${key}`);
        continue;
      }
      seen.add(key);
      const parsed = parseValue(key, m[2] ?? '');
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

/** Text of the capture group `group` of match `m` (found in masked text), read from `body`. */
function groupText(body, m, group) {
  const span = m.indices[group];
  return span ? body.slice(span[0], span[1]) : undefined;
}

function unwrapAngle(s) {
  const t = s.trim();
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1).trim() : t;
}

function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Shortens a long source (a `data:` URI, say) for display in a message. */
function preview(src) {
  return src.length > 80 ? `${src.slice(0, 77)}...` : src;
}

/**
 * Attributes of one tag as a `Map` of lowercase name to entity-decoded value
 * (`''` for an attribute without a value). The first occurrence of a name
 * wins, as in browsers.
 */
function readAttributes(source) {
  const attrs = new Map();
  const inner = source.replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (attrs.has(name)) continue;
    const raw = m[2] ?? m[3] ?? m[4];
    attrs.set(name, raw === undefined ? '' : decodeEntities(raw));
  }
  return attrs;
}

/**
 * Every image in a body, outside code, ordered by position:
 * `{ offset, alt, src, html, srcset }`. Covers Markdown inline images,
 * reference images resolved against link definitions (unresolved references
 * render as text and are ignored), and raw `<img>` tags. Positions are found
 * in the masked body; alt text and sources are read from the original.
 */
function collectImages(body, masked) {
  const images = [];
  const inlineSpans = [];
  for (const m of masked.matchAll(new RegExp(IMG_INLINE_RE.source, 'gd'))) {
    images.push({ offset: m.index, alt: groupText(body, m, 1), src: unwrapAngle(groupText(body, m, 2)), html: false });
    inlineSpans.push([m.index, m.index + m[0].length]);
  }
  const definitions = new Map();
  for (const m of masked.matchAll(new RegExp(LINK_DEFINITION_RE.source, 'gmd'))) {
    const label = normalizeLabel(groupText(body, m, 1));
    if (!definitions.has(label)) definitions.set(label, unwrapAngle(groupText(body, m, 2)));
  }
  let span = 0;
  for (const m of masked.matchAll(new RegExp(IMG_REFERENCE_RE.source, 'gd'))) {
    while (span < inlineSpans.length && inlineSpans[span][1] <= m.index) span += 1;
    if (span < inlineSpans.length && inlineSpans[span][0] <= m.index) continue;
    const alt = groupText(body, m, 1);
    const label = normalizeLabel(m[2] ? groupText(body, m, 2) : alt);
    if (definitions.has(label)) {
      images.push({ offset: m.index, alt, src: definitions.get(label), html: false });
    }
  }
  for (const tag of tagsOutsideCode(body, masked, extentIndex(body), IMG_TAG_START_RE)) {
    const attrs = readAttributes(tag.source);
    images.push({
      offset: tag.start,
      alt: attrs.get('alt'),
      src: attrs.has('src') ? attrs.get('src').trim() : undefined,
      html: true,
      srcset: attrs.has('srcset'),
    });
  }
  return images.sort((a, b) => a.offset - b.offset);
}

/**
 * Maps an image source to the public path it loads and applies the source
 * rules. `slug` is the article's slug (or `null` when the filename gave none,
 * which skips the folder rule). Returns `{ path }` or `{ error }`.
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

  const bare = path.replace(/[?#].*$/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  if (decoded.includes('\\')) return { error: `image path ${preview(src)} must not contain backslashes` };
  if (decoded.split('/').includes('..')) return { error: `image path ${preview(src)} must not contain .. segments` };
  if (slug !== null) {
    const prefix = `/assets/${folder}/${slug}/`;
    if (!decoded.startsWith(prefix) || decoded.length === prefix.length || decoded.endsWith('/')) {
      return { error: `image ${preview(src)} must be under ${prefix}` };
    }
  }
  return { path: decoded };
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
 *     `/assets/…`; external, protocol-relative, `data:`, page-relative and
 *     `..` sources and `srcset` are rejected.
 *
 * @param {object} args
 * @param {string} args.path Repository-relative path, such as `_posts/2026-01-15-foo.md` or `_drafts/foo.md`.
 * @param {Record<string, unknown>} [args.data] `data` from `parseArticle` (missing → `{}`).
 * @param {string} [args.body] `body` from `parseArticle` (missing → `''`).
 * @param {'draft' | 'post'} args.kind Which folder rules apply.
 * @param {string} [args.todayUtc] Today as `YYYY-MM-DD` in UTC (default: the current UTC date).
 * @param {(publicPath: string) => boolean} [args.imageExists] Called with a root-relative public
 *   path such as `/assets/blog/foo/fig.png` for each image that passed the other rules; `false`
 *   reports the image as missing. Omit it to skip the existence check.
 * @param {number} [args.bodyStartLine] File line on which `body` starts (default 1). Pass
 *   `text.slice(0, text.length - body.length).split('\n').length` so body findings carry file lines.
 * @returns {string[]} Errors, each starting with `path`: `${path}: …` for file-level findings and
 *   `${path}:${line}: …` for body findings.
 */
export function validateArticle({ path, data, body, kind, todayUtc, imageExists, bodyStartLine } = {}) {
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
  const lineAt = lineLocator(text);
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
  const masked = maskCode(text, findCodeRegions(text));
  const todo = lineFindings(text);
  for (const m of masked.matchAll(/TODO:/g)) todo.note(m.index);
  for (const finding of todo.list()) {
    errors.push(`${path}:${startLine + finding.line - 1}: body still contains a TODO: placeholder`);
  }

  // Images.
  for (const image of collectImages(text, masked)) {
    const at = image.offset;
    const src = image.src ?? '';
    if (image.html && image.srcset) bodyError(at, 'srcset is not supported; use a single src');
    if (image.html && src === '') bodyError(at, '<img> has no src');
    if (typeof image.alt !== 'string' || image.alt.trim() === '') {
      bodyError(at, `image has no alt text${src === '' ? '' : ` (${preview(src)})`}`);
    }
    if (src === '') continue;
    const result = imagePublicPath(src, slug, kind);
    if (result.error) bodyError(at, result.error);
    else if (typeof imageExists === 'function' && !imageExists(result.path)) {
      bodyError(at, `image ${result.path} does not exist`);
    }
  }
  return errors;
}


/* ------------------------------------------------------------------------ */
/* Unsafe markup                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Notes event-handler attributes and `javascript:` values in one tag or
 * attribute list. The value check also looks through character references
 * (`&#106;avascript:`), which kramdown passes through and browsers decode
 * (verified with kramdown 2.4.0).
 */
function noteAttributeRisks(found, { start, source }, eventRe) {
  const event = eventRe.exec(source);
  if (event) found.note(start + event.index + 1);
  const js = JS_URL_ATTR_RE.exec(source);
  if (js) found.note(start + js.index);
  else if (JS_URL_ATTR_RE.test(decodeEntities(source))) found.note(start);
}

/**
 * Finds markup in a Markdown body that could run script or change the page,
 * outside fenced and inline code (HTML shown as a code sample is never
 * flagged). The same patterns as the built-page prose scan:
 *   - opening `script`, `iframe`, `object`, `embed`, `form`, `base`, `meta`,
 *     `link` and `style` tags, in any letter case;
 *   - `on…=` event-handler attributes in any tag, and in kramdown attribute
 *     lists such as `{: onclick="…"}`, which add attributes to the rendered
 *     element;
 *   - `javascript:` URLs (whitespace before the colon allowed, any letter
 *     case) in URL positions only: after `](`, after `]:`, after `<`, and
 *     after `=` inside a tag or attribute list.
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
  const masked = maskCode(text, findCodeRegions(text));
  const found = lineFindings(text);
  for (const m of masked.matchAll(UNSAFE_TAG_RE)) found.note(m.index);
  const extents = extentIndex(text);
  for (const tag of tagsOutsideCode(text, masked, extents)) noteAttributeRisks(found, tag, TAG_EVENT_ATTR_RE);
  for (const list of attributeListsOutsideCode(text, masked, extents)) {
    noteAttributeRisks(found, list, IAL_EVENT_ATTR_RE);
  }
  for (const m of masked.matchAll(JS_URL_MARKDOWN_RE)) found.note(m.index);
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
 * Finds Liquid syntax (`{{` or `{%`) inside fenced or inline code that no
 * `{% raw %}…{% endraw %}` region protects. Jekyll runs Liquid before
 * Markdown, so such text is evaluated instead of shown and can break the
 * build. `raw` and `endraw` tags themselves are not reported. Callers treat
 * the findings as warnings.
 *
 * @param {string} body Markdown body (from `parseArticle`).
 * @returns {Array<{ line: number, text: string }>} One finding per line, ordered by line;
 *   `line` is 1-based within `body`.
 */
export function findUnrawLiquidInCode(body) {
  const text = asText(body, 'body');
  const raw = rawRegions(text);
  const found = lineFindings(text);
  for (const region of findCodeRegions(text)) {
    for (const m of text.slice(region.start, region.end).matchAll(LIQUID_IN_CODE_RE)) {
      const at = region.start + m.index;
      if (raw.some((r) => at >= r.start && at < r.end)) continue;
      if (extentAt(text, at, RAW_TAG_AT_RE) !== null) continue;
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
 * Applies the rules for content that may sit in the public repository to a
 * complete tree (the staged index for `guard --staged`, each pushed commit
 * for `guard --pre-push`, the working tree for the AC-01 test):
 *   1. nothing under `_drafts/` or `assets/drafts/` is tracked;
 *   2. no article has a `published:` key (through `validateArticle`);
 *   3. no article path (`ARTICLE_PATH_RE`) carries a date after `todayUtc`;
 *   4. every `assets/blog/<slug>/` folder has a matching
 *      `_posts/…/YYYY-MM-DD-<slug>.md`, and no file sits directly in
 *      `assets/blog/`. Because `paths` is the whole tree, a deletion of a
 *      post whose image folder remains is caught.
 * Each rule keeps material from being hidden from the site while staying
 * world-readable on GitHub. For the same reason every file in `_posts/` must
 * be a correctly named Markdown article (Jekyll silently skips a misnamed
 * post), and two posts may not share a slug (they would publish to the same
 * URL and one would vanish).
 *
 * Each given article is then parsed, validated as a post with its images
 * checked against `paths`, and scanned for unsafe markup, with every finding
 * on its file line.
 *
 * @param {object} args
 * @param {string[]} args.paths The complete tree as repository-relative POSIX paths
 *   (a leading `./` is removed; empty strings are ignored).
 * @param {Array<{ path: string, text: string }>} [args.articles] Articles to validate,
 *   typically those added or changed (default `[]`).
 * @param {string} [args.todayUtc] Today as `YYYY-MM-DD` in UTC (default: the current UTC date).
 * @returns {string[]} Errors, each starting with its path; path rules first, then the
 *   articles in input order. Identical messages are reported once.
 */
export function checkTrackedContent({ paths, articles, todayUtc } = {}) {
  const today = resolveToday(todayUtc);
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

  // Rule 1: drafts and draft images.
  for (const p of tree) {
    if (p.startsWith('_drafts/') || p.startsWith('assets/drafts/')) {
      errors.push(`${p}: drafts and draft images must never be tracked (git rm --cached; they belong only in your working copy)`);
    }
  }

  // Files in _posts/: Markdown articles only, correctly named, one per slug.
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
    const { data, body, errors: parseErrors } = parseArticle(text);
    for (const e of parseErrors) errors.push(`${path}: ${e}`);
    const bodyStartLine = text.slice(0, text.length - body.length).split('\n').length;
    errors.push(...validateArticle({ path, data, body, kind: 'post', todayUtc: today, imageExists, bodyStartLine }));
    for (const finding of scanUnsafeMarkup(body)) {
      errors.push(`${path}:${bodyStartLine + finding.line - 1}: unsafe markup: ${finding.text}`);
    }
  }
  return [...new Set(errors)];
}
