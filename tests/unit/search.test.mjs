/* Cabrillo Coast LLC — unit tests for the blog search logic (AC-09, F-019) */
/**
 * Runs the real, unmodified `blog/search.js` in a `node:vm` context and tests
 * the API it exports as `window.CabrilloBlogSearch` (AC-09).
 *
 * Each sandbox (`makeSandbox`) is a stand-in `window` whose every DOM lookup
 * returns `null` and which has no `fetch`, so the script's guarded DOM wiring
 * returns before it does anything; that wiring is checked in headless Chrome
 * (AC-13). The sandbox must never be given a lookup that succeeds, and
 * `blog/search.js` is never changed to suit this suite. Its stub `document`
 * records what was exported at each call, which proves the API exists before
 * the first DOM access rather than merely after the script has run.
 *
 * The fallback case builds a separate realm and deletes its
 * `String.prototype.normalize`; each vm context has its own built-ins, so the
 * deletion reaches no other realm. Values created inside a vm context carry
 * its prototypes, which `assert.deepStrictEqual` treats as different from
 * local literals, so results are copied into this realm (`Array.from`,
 * `urls`) before any deep comparison.
 *
 * Entries mirror the built `blog/search.json`, whose `body` is already the
 * lowercased distinct tokens of the article text.
 *
 * Run: node --test tests/unit/search.test.mjs (Node 22 or later). It needs no
 * Jekyll build, browser or network, and writes no files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/* Loading blog/search.js */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SEARCH_JS = path.join(ROOT, 'blog', 'search.js');
const src = fs.readFileSync(SEARCH_JS, 'utf8');

const API_NAMES = ['normalize', 'tokenize', 'prepare', 'rank'];

/**
 * One call the script made on the stub `document`, captured as it happened.
 * @typedef {object} DomAccess
 * @property {string} method the `document` method called
 * @property {unknown} arg its first argument
 * @property {string[]} api the `API_NAMES` that were functions on
 *   `window.CabrilloBlogSearch` at that moment (an array of this realm)
 * @property {unknown} exported `window.CabrilloBlogSearch` at that moment
 */

/**
 * A fresh global object for one vm context, which the script sees as both
 * `window` and the context global. `document` lookups all fail,
 * `location.search` is empty and `history` has no `replaceState`.
 * `addEventListener` stubs are inert, because site scripts may register
 * listeners at load (as `main.js` does). `fetch` is deliberately absent: it
 * is one of the conditions the DOM wiring requires.
 *
 * Every `document` method appends a `DomAccess` to `domAccesses` when it is
 * called and never throws, since a throw would abort loading the script;
 * cases assert on the records afterwards.
 * @returns {{ sandbox: Record<string, unknown>, domAccesses: DomAccess[] }}
 */
function makeSandbox() {
  /** @type {DomAccess[]} */
  const domAccesses = [];
  const sandbox = {
    document: {
      getElementById: (id) => record('getElementById', id, null),
      querySelector: (selector) => record('querySelector', selector, null),
      querySelectorAll: (selector) => record('querySelectorAll', selector, []),
      addEventListener(type) { record('addEventListener', type, undefined); },
    },
    location: { search: '' },
    history: {},
    addEventListener() {},
  };
  sandbox.window = sandbox;

  /**
   * Records one `document` call and returns the stub's fixed result.
   * @template T
   * @param {string} method
   * @param {unknown} arg
   * @param {T} result
   * @returns {T}
   */
  function record(method, arg, result) {
    const exported = sandbox.CabrilloBlogSearch;
    const api = API_NAMES.filter((name) => exported != null && typeof exported[name] === 'function');
    domAccesses.push({ method, arg, api, exported });
    return result;
  }

  return { sandbox, domAccesses };
}

const shared = makeSandbox();
vm.createContext(shared.sandbox);
vm.runInContext(src, shared.sandbox, { filename: 'blog/search.js' });

const S = shared.sandbox.CabrilloBlogSearch;

/* Helpers */

/** Default `date`, in the `date_to_xmlschema` form the built index uses. */
const DEFAULT_DATE = '2026-01-01T00:00:00+00:00';

/**
 * One search-index entry. Fields a case does not name are empty, so a term
 * can only match where the case put it.
 * @param {string} url
 * @param {{ title?: string, summary?: string, tags?: string[], body?: string, date?: string }} [fields]
 * @returns {{ url: string, title: string, summary: string, tags: string[], date: string, body: string }}
 */
function entry(url, { title = '', summary = '', tags = [], body = '', date = DEFAULT_DATE } = {}) {
  return { url, title, summary, tags, date, body };
}

/**
 * The `url` of every ranked entry, in rank order, as an array of this realm.
 * @param {unknown} result a `rank` result for a non-empty query
 * @returns {string[]}
 */
function urls(result) {
  assert.notEqual(result, null, 'rank returned null for a non-empty query');
  assert.ok(Array.isArray(result), 'rank must return an array for a non-empty query');
  return Array.from(result, (e) => e.url);
}

/**
 * Prepares `list` and ranks it against `query`, as the page does once the
 * index has loaded.
 * @param {ReturnType<typeof entry>[]} list
 * @param {string} query
 * @returns {string[]}
 */
function search(list, query) {
  return urls(S.rank(S.prepare(list), query));
}

/**
 * Asserts that `a` and `b` tie on `query`: each ranks first whenever it comes
 * first in the input, so any score difference fails one of the two orders.
 * `control` lacks the query, sits between them and must never be returned.
 * @param {string} query
 * @param {ReturnType<typeof entry>} a
 * @param {ReturnType<typeof entry>} b
 * @param {ReturnType<typeof entry>} control
 * @param {string} label the scores the two entries should share
 */
function assertTie(query, a, b, control, label) {
  assert.deepEqual(search([a, control, b], query), [a.url, b.url], `${label}: ${a.url} first in the input ranks first`);
  assert.deepEqual(search([b, control, a], query), [b.url, a.url], `${label}: ${b.url} first in the input ranks first`);
}

/**
 * Asserts that the script looked up elements by id, and that every
 * `document` call it made came after `window.CabrilloBlogSearch` held all
 * four functions and was the object it finally exported.
 * @param {DomAccess[]} domAccesses the records of one realm
 * @param {unknown} api that realm's `window.CabrilloBlogSearch`
 */
function assertExportedBeforeDomAccess(domAccesses, api) {
  assert.ok(
    domAccesses.some((access) => access.method === 'getElementById'),
    'the script must look up its elements with document.getElementById; with no recorded lookup the export-order check would be vacuous',
  );
  for (const access of domAccesses) {
    const arg = typeof access.arg === 'string' ? JSON.stringify(access.arg) : typeof access.arg;
    const call = `document.${access.method}(${arg})`;
    assert.deepEqual(access.api, API_NAMES, `all four API functions must be exported before ${call}`);
    assert.equal(access.exported, api, `window.CabrilloBlogSearch must already be the exported API at ${call}`);
  }
}

/* Cases */

test('[AC-09][F-019] search.js exports the API before touching the DOM', () => {
  assert.equal(typeof S, 'object', 'window.CabrilloBlogSearch must be an object');
  assert.notEqual(S, null, 'window.CabrilloBlogSearch must not be null');
  for (const name of API_NAMES) {
    assert.equal(typeof S[name], 'function', `CabrilloBlogSearch.${name} must be a function`);
  }

  assertExportedBeforeDomAccess(shared.domAccesses, S);
});

test('[AC-09][F-019] normalize lowercases and strips diacritics', () => {
  assert.equal(S.normalize('Kubernetes'), 'kubernetes');
  assert.equal(S.normalize('CAFÉ'), 'cafe');
  assert.equal(S.normalize('Café'), 'cafe');
});

test('[AC-09][F-019] normalize falls back to lowercase only without String.prototype.normalize', () => {
  // A realm of its own: each vm context has its own built-ins, so deleting
  // the method here reaches neither this realm nor the shared one.
  const fallback = makeSandbox();
  vm.createContext(fallback.sandbox);
  vm.runInContext('delete String.prototype.normalize;', fallback.sandbox);
  assert.equal(
    vm.runInContext("typeof ''.normalize", fallback.sandbox),
    'undefined',
    'the fallback realm must lack String.prototype.normalize before the script loads',
  );
  vm.runInContext(src, fallback.sandbox, { filename: 'blog/search.js' });
  const F = fallback.sandbox.CabrilloBlogSearch;

  assertExportedBeforeDomAccess(fallback.domAccesses, F);

  assert.equal(F.normalize('CAF\u00c9'), 'caf\u00e9', 'without NFD the text is lowercased and keeps its accent');
  assert.equal(F.normalize('Kubernetes'), 'kubernetes');
  assert.equal(F.normalize('Cafe\u0301'), 'cafe\u0301', 'without NFD a combining mark is kept, not stripped');
  assert.deepEqual(Array.from(F.tokenize('  Caf\u00e9\tCR\u00c8ME ')), ['caf\u00e9', 'cr\u00e8me']);

  const list = [
    entry('/blog/accented/', { title: 'Caf\u00e9 Ops' }),
    entry('/blog/plain/', { title: 'Cafe Ops' }),
  ];
  const prepared = F.prepare(list);
  assert.equal(prepared[0].norm.title, 'caf\u00e9 ops', 'prepare keeps the accent in the normalized title');
  assert.deepEqual(urls(F.rank(prepared, 'CAF\u00c9')), ['/blog/accented/'], 'CAF\u00c9 matches only the accented entry');
  assert.deepEqual(urls(F.rank(prepared, 'cafe')), ['/blog/plain/'], 'cafe matches only the plain entry');
  assert.deepEqual(urls(F.rank(prepared, 'ops')), ['/blog/accented/', '/blog/plain/'], 'a shared term matches both, in input order');

  assert.equal(S.normalize('CAF\u00c9'), 'cafe', 'the shared realm still strips diacritics');
});

test('[AC-09][F-019] tokenize splits on any whitespace and drops empties', () => {
  assert.deepEqual(Array.from(S.tokenize('  helm\tcharts\n  k8s ')), ['helm', 'charts', 'k8s']);
  assert.equal(S.tokenize('').length, 0, 'an empty query has no terms');
  assert.equal(S.tokenize('   ').length, 0, 'a whitespace-only query has no terms');
});

test('[AC-09][F-019] prepare leaves inputs untouched and preserves originals', () => {
  const input = [
    entry('/blog/cafe-ops/', {
      title: 'Café Ops at Scale',
      summary: 'Résumé of an on-call rotation.',
      tags: ['ops', 'sre'],
      body: 'café on-call rotation pager',
      date: '2026-03-02T00:00:00+00:00',
    }),
    entry('/blog/second/', { title: 'Second Article', summary: 'Plain text.', tags: ['notes'], body: 'second body' }),
  ];
  const before = JSON.stringify(input);
  const result = S.prepare(input);

  assert.equal(JSON.stringify(input), before, 'prepare must not modify its input entries');
  assert.equal(result.length, input.length, 'prepare returns one entry per input entry');
  input.forEach((original, i) => {
    const copy = result[i];
    assert.notEqual(copy, original, `entry ${i} must be a copy, not the input object`);
    assert.equal(copy.url, original.url, `entry ${i} keeps its url`);
    assert.equal(copy.title, original.title, `entry ${i} keeps its original title`);
    assert.equal(copy.summary, original.summary, `entry ${i} keeps its original summary`);
    assert.equal(copy.body, original.body, `entry ${i} keeps its original body`);
    assert.equal(copy.date, original.date, `entry ${i} keeps its date`);
    assert.equal(JSON.stringify(copy.tags), JSON.stringify(original.tags), `entry ${i} keeps its tags`);
    assert.equal(copy.norm.title, S.normalize(original.title), `entry ${i} carries a normalized title`);
    assert.equal(copy.norm.summary, S.normalize(original.summary), `entry ${i} carries a normalized summary`);
    assert.equal(copy.norm.body, S.normalize(original.body), `entry ${i} carries a normalized body`);
    assert.equal(typeof copy.order, 'number', `entry ${i} carries a numeric order`);
  });
});

test('[AC-09][F-019] rank returns null for an empty query', () => {
  const prepared = S.prepare([
    entry('/blog/a/', { title: 'Kubernetes in production', body: 'helm charts' }),
    entry('/blog/b/', { title: 'Kubernetes basics', body: 'pods services' }),
  ]);
  assert.equal(S.rank(prepared, ''), null, 'an empty query restores the full listing');
  assert.equal(S.rank(prepared, '   '), null, 'a whitespace-only query restores the full listing');
});

test('[AC-09][F-019] AND matching across fields', () => {
  const list = [
    entry('/blog/a/', { title: 'Kubernetes in production', body: 'helm charts' }),
    entry('/blog/b/', { title: 'Kubernetes basics', body: 'pods services' }),
  ];
  const prepared = S.prepare(list);

  assert.deepEqual(urls(S.rank(prepared, 'kubernetes')), ['/blog/a/', '/blog/b/'], 'a single shared term matches both');

  const both = S.rank(prepared, 'kubernetes helm');
  assert.deepEqual(urls(both), ['/blog/a/'], 'every term must match, each in any field');
  assert.equal(both[0], prepared[0], 'rank returns the prepared entries themselves');

  const none = S.rank(prepared, 'kubernetes zzzz');
  assert.notEqual(none, null, 'a non-empty query with no match is not the empty-query result');
  assert.ok(Array.isArray(none), 'a non-empty query returns an array');
  assert.equal(none.length, 0, 'one unmatched term excludes every entry');
});

test('[AC-09][F-019] field weights order results title > tags > summary > body', () => {
  // Input order is the reverse of the expected order, so only the weights
  // can produce the expected result.
  const list = [
    entry('/blog/in-body/', { title: 'Tracing notes', summary: 'Spans and traces.', tags: ['tracing'], body: 'observability spans traces' }),
    entry('/blog/in-summary/', { title: 'Metrics notes', summary: 'Observability from counters.', tags: ['metrics'], body: 'counters gauges' }),
    entry('/blog/in-tags/', { title: 'Logging notes', summary: 'Structured logs.', tags: ['observability'], body: 'structured logs' }),
    entry('/blog/in-title/', { title: 'Observability at scale', summary: 'Signals.', tags: ['signals'], body: 'signals budgets' }),
  ];
  assert.deepEqual(search(list, 'observability'), ['/blog/in-title/', '/blog/in-tags/', '/blog/in-summary/', '/blog/in-body/']);

  // Weights sum over terms: both terms in the title (4 + 4) outrank one term
  // in the title and the other in the body (4 + 1), despite input order.
  const summed = [
    entry('/blog/newer/', { title: 'Rust tooling', body: 'cargo async' }),
    entry('/blog/older/', { title: 'Rust async runtimes', body: 'executors' }),
  ];
  assert.deepEqual(search(summed, 'rust async'), ['/blog/older/', '/blog/newer/']);
});

test('[AC-09][F-019] field weights add across fields as 4/3/2/1 and count each field once', () => {
  // One term, `kafka`, held by exactly the fields each url names; the other
  // fields are empty. `none` fills every field without the term and must
  // never be returned.
  const all4 = entry('/blog/all-four/', { title: 'Kafka basics', tags: ['kafka'], summary: 'Why Kafka.', body: 'kafka brokers' });
  const tB = entry('/blog/title-body/', { title: 'Kafka basics', body: 'kafka brokers' });
  const gS = entry('/blog/tags-summary/', { tags: ['kafka'], summary: 'Why Kafka.' });
  const t = entry('/blog/title/', { title: 'Kafka basics' });
  const gB = entry('/blog/tags-body/', { tags: ['kafka'], body: 'kafka brokers' });
  const tRep = entry('/blog/title-repeated/', { title: 'Kafka on Kafka' });
  const g = entry('/blog/tags/', { tags: ['kafka'] });
  const sB = entry('/blog/summary-body/', { summary: 'Why Kafka.', body: 'kafka brokers' });
  const s = entry('/blog/summary/', { summary: 'Kafka.' });
  // Three occurrences, kept in the distinct-token form of a built body.
  const bRep = entry('/blog/body-repeated/', { body: 'kafka kafka-connect kafka-streams' });
  const none = entry('/blog/none/', { title: 'Pulsar basics', tags: ['pulsar'], summary: 'Why Pulsar.', body: 'pulsar brokers' });

  // (a) Weights add across fields: tags + summary (3 + 2) outranks the title
  // alone (4) placed ahead of it. A per-term maximum of the field weights, or
  // a title weight of 5 or more, fails here.
  assert.deepEqual(search([t, none, gS], 'kafka'), [gS.url, t.url], 'tags + summary (5) outranks title (4)');

  // (b) Ties, each checked in both input orders so that any score difference
  // fails one of them. With T, G, S and B the title, tags, summary and body
  // weights: T = G + B and G = S + B give T = S + 2B, and T + B = G + S then
  // forces S = 2B, so G = 3B and T = 4B. The three ties pin the weights to
  // exactly 4:3:2:1, which is all a ranking can show of them.
  assertTie('kafka', t, gB, none, 'title (4) ties tags + body (3 + 1)');
  assertTie('kafka', g, sB, none, 'tags (3) ties summary + body (2 + 1)');
  assertTie('kafka', tB, gS, none, 'title + body (4 + 1) ties tags + summary (3 + 2)');

  // (c) A field counts once, however often it holds the term.
  assert.deepEqual(search([bRep, none, s], 'kafka'), [s.url, bRep.url], 'three body occurrences (1) stay behind one in the summary (2)');
  assertTie('kafka', tRep, t, none, 'a title holding the term twice (4) ties one holding it once (4)');
  assert.deepEqual(search([tRep, none, tB], 'kafka'), [tB.url, tRep.url], 'a title holding the term twice (4) stays behind title + body (5)');

  // (d) The whole ladder, scoring 10, 5, 5, 4, 4, 4, 3, 3, 2 and 1, in both
  // input orders: every tie group must keep the input order it was given.
  const ladder = [none, bRep, s, sB, g, gB, tRep, t, gS, tB, all4];
  assert.deepEqual(search(ladder, 'kafka'), [
    '/blog/all-four/', '/blog/tags-summary/', '/blog/title-body/', '/blog/tags-body/', '/blog/title-repeated/',
    '/blog/title/', '/blog/summary-body/', '/blog/tags/', '/blog/summary/', '/blog/body-repeated/',
  ]);
  assert.deepEqual(search([...ladder].reverse(), 'kafka'), [
    '/blog/all-four/', '/blog/title-body/', '/blog/tags-summary/', '/blog/title/', '/blog/title-repeated/',
    '/blog/tags-body/', '/blog/tags/', '/blog/summary-body/', '/blog/summary/', '/blog/body-repeated/',
  ]);
});

test('[AC-09][F-019] ties keep newest-first input order', () => {
  const list = [
    entry('/blog/new/', { title: 'Newest', summary: 'Terraform modules.', date: '2026-03-01T00:00:00+00:00' }),
    entry('/blog/mid/', { title: 'Middle', summary: 'Terraform state.', date: '2026-02-01T00:00:00+00:00' }),
    entry('/blog/old/', { title: 'Oldest', summary: 'Terraform basics.', date: '2026-01-01T00:00:00+00:00' }),
  ];
  assert.deepEqual(search(list, 'terraform'), ['/blog/new/', '/blog/mid/', '/blog/old/']);

  // A higher-scoring entry among the ties moves ahead; the ties around it keep
  // their input order.
  const mixed = [list[0], entry('/blog/top/', { title: 'Terraform in depth' }), list[1], list[2]];
  assert.deepEqual(search(mixed, 'terraform'), ['/blog/top/', '/blog/new/', '/blog/mid/', '/blog/old/']);
});

test('[AC-09][F-019] matching is literal substring, never regex', () => {
  const list = [
    entry('/blog/cpp/', { title: 'Modern C++ tips', body: 'templates ranges' }),
    entry('/blog/fx/', { title: 'Function notation', body: 'f(x) notation' }),
    entry('/blog/regex/', { title: 'Pattern matching', body: 'regex .* wildcard' }),
    entry('/blog/kube/', { title: 'Kubernetes operators', body: 'controllers reconcile' }),
  ];
  let result;
  assert.doesNotThrow(() => { result = search(list, 'c++'); }, 'c++ must not be read as a pattern');
  assert.deepEqual(result, ['/blog/cpp/']);
  assert.doesNotThrow(() => { result = search(list, '('); }, '( must not be read as a pattern');
  assert.deepEqual(result, ['/blog/fx/']);
  assert.doesNotThrow(() => { result = search(list, '.*'); }, '.* must not be read as a pattern');
  assert.deepEqual(result, ['/blog/regex/']);
  assert.deepEqual(search(list, 'kube'), ['/blog/kube/'], 'a prefix matches as a substring');
});

test('[AC-09][F-019] diacritics are ignored in both directions', () => {
  const list = [
    entry('/blog/accented/', { title: 'Morning brew', body: 'café au lait' }),
    entry('/blog/plain/', { title: 'City walks', body: 'cafe culture' }),
  ];
  assert.deepEqual(search(list, 'cafe'), ['/blog/accented/', '/blog/plain/'], 'cafe matches an indexed café');
  assert.deepEqual(search(list, 'CAFÉ'), ['/blog/accented/', '/blog/plain/'], 'CAFÉ matches an indexed cafe');
});

test('[AC-09][F-019] body-only r&d matches', () => {
  const rd = entry('/blog/rd/', { title: 'Lab notes', summary: 'How the lab works.', tags: ['research'], body: 'r&d budgets lab' });
  const other = entry('/blog/other/', { title: 'Research roadmap', summary: 'Planning research.', tags: ['research'], body: 'roadmap planning' });
  const outsideBody = S.normalize([rd.title, rd.summary, rd.tags.join(' ')].join(' '));
  assert.equal(outsideBody.indexOf('r&d'), -1, 'the fixture holds r&d in its body only');

  assert.deepEqual(search([rd, other], 'r&d'), ['/blog/rd/']);
  assert.deepEqual(search([rd, other], 'R&D'), ['/blog/rd/']);
});
