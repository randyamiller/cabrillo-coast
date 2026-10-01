/* Cabrillo Coast LLC — unit tests for the blog search logic (AC-09, F-019) */
/**
 * `blog/search.js` filters and ranks the server-rendered article listing in
 * the browser. Its four pure functions are exported as
 * `window.CabrilloBlogSearch` before the script touches the DOM, so this
 * suite runs the real, unmodified file in a `node:vm` context and tests the
 * search contract directly:
 *   - normalize(text): lowercases and strips diacritics (NFD decomposition
 *     minus combining marks) where `String.prototype.normalize` exists;
 *   - tokenize(query): splits a query into terms on any whitespace and drops
 *     empty terms;
 *   - prepare(entries): returns copies carrying normalized fields (`norm`)
 *     and their input position (`order`), leaving the inputs untouched;
 *   - rank(prepared, query): `null` for an empty query; otherwise the
 *     prepared entries in which every term occurs, as a literal substring, in
 *     at least one field. Each entry scores the sum, over the terms, of the
 *     weights of the fields holding the term (title 4, tags 3, summary 2,
 *     body 1); results sort by score, ties keeping newest-first input order.
 *
 * The sandbox is a stand-in `window` whose every DOM lookup returns `null`
 * and which has no `fetch`, so the script's guarded DOM wiring returns before
 * it does anything and only the exported API is exercised. The wiring itself
 * (form, status line, `?q=` and the index fetch) is checked in headless
 * Chrome (AC-13). The sandbox must never be given a lookup that succeeds, and
 * `blog/search.js` is never changed to suit this suite.
 *
 * Entries mirror the built `blog/search.json`: `{ url, title, summary, tags,
 * date, body }`, where `body` is already the lowercased distinct tokens of the
 * article text.
 *
 * Cross-realm values: arrays and objects created inside the vm context carry
 * that context's prototypes, which `assert.deepStrictEqual` treats as
 * different from local literals. Results are copied into this realm
 * (`Array.from`, `urls`) before any deep comparison; primitives are compared
 * directly.
 *
 * Run: node --test tests/unit/search.test.mjs (Node 22 or later), or as part
 * of `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build, browser
 * or network, and writes no files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/* ------------------------------------------------------------------------ */
/* Loading blog/search.js                                                    */
/* ------------------------------------------------------------------------ */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SEARCH_JS = path.join(ROOT, 'blog', 'search.js');
const src = fs.readFileSync(SEARCH_JS, 'utf8');

/**
 * The global object the script sees as both `window` and the context global.
 * `document` lookups all fail, `location.search` is empty and `history` has
 * no `replaceState`. `addEventListener` stubs are inert, because site scripts
 * may register listeners at load (as `main.js` does). `fetch` is deliberately
 * absent: it is one of the conditions the DOM wiring requires.
 */
const sandbox = {
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  location: { search: '' },
  history: {},
  addEventListener() {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'blog/search.js' });

/** The API under test, as the script exported it. */
const S = sandbox.CabrilloBlogSearch;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ */
/* Cases                                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-09][F-019] search.js exports the API before touching the DOM', () => {
  assert.equal(typeof S, 'object', 'window.CabrilloBlogSearch must be an object');
  assert.notEqual(S, null, 'window.CabrilloBlogSearch must not be null');
  for (const name of ['normalize', 'tokenize', 'prepare', 'rank']) {
    assert.equal(typeof S[name], 'function', `CabrilloBlogSearch.${name} must be a function`);
  }
});

test('[AC-09][F-019] normalize lowercases and strips diacritics', () => {
  assert.equal(S.normalize('Kubernetes'), 'kubernetes');
  assert.equal(S.normalize('CAFÉ'), 'cafe');
  assert.equal(S.normalize('Café'), 'cafe');
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
