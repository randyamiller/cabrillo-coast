/* Cabrillo Coast blog search: ES5, text-only output. */
(function (window, document) {
  "use strict";

  function normalize(text) {
    var s = String(text == null ? "" : text).toLowerCase();
    return typeof s.normalize === "function" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : s;
  }

  function tokenize(query) {
    var p = normalize(query).split(/\s+/), out = [], i;
    for (i = 0; i < p.length; i++) if (p[i]) out.push(p[i]);
    return out;
  }

  // Shallow copies; inputs untouched.
  function prepare(entries) {
    var out = [], i, e, c, k;
    for (i = 0; Array.isArray(entries) && i < entries.length; i++) {
      e = entries[i] || {};
      c = {};
      for (k in e) if ({}.hasOwnProperty.call(e, k)) c[k] = e[k];
      c.norm = { title: normalize(e.title), summary: normalize(e.summary), body: normalize(e.body),
        tags: normalize(Array.isArray(e.tags) ? e.tags.join(" ") : "") };
      c.order = i;
      out.push(c);
    }
    return out;
  }

  // Literal match; no RegExp from input.
  function hit(f, t, w) { return (f || "").indexOf(t) !== -1 ? w : 0; }

  function rank(prepared, query) {
    var terms = tokenize(query), hits = [], i, j, n, s, t, w;
    if (!terms.length) return null;
    for (i = 0; i < prepared.length; i++) {
      n = prepared[i].norm;
      for (s = 0, j = 0; j < terms.length; j++) {
        w = terms[j];
        t = hit(n.title, w, 4) + hit(n.tags, w, 3) + hit(n.summary, w, 2) + hit(n.body, w, 1);
        if (!t) break;
        s += t;
      }
      if (j === terms.length) hits.push({ e: prepared[i], s: s });
    }
    hits.sort(function (a, b) { return b.s - a.s || a.e.order - b.e.order; });
    for (i = 0; i < hits.length; i++) hits[i] = hits[i].e;
    return hits;
  }

  window.CabrilloBlogSearch = { normalize: normalize, tokenize: tokenize, prepare: prepare, rank: rank };

  function $(id) { return document.getElementById(id); }
  var form = $("blog-search"), input = $("blog-search-input"), status = $("blog-search-status"), list = $("post-list");
  if (!form || !input || !status || !list || !window.fetch) return;

  var items = list.querySelectorAll("li[data-url]"), byUrl = Object.create(null), i;
  for (i = 0; i < items.length; i++) byUrl[items[i].getAttribute("data-url")] = items[i];
  var indexUrl = form.getAttribute("data-index");
  if (!items.length || !indexUrl) return;
  form.hidden = false;

  var entries = null, started = false, failed = false, moved, timer;

  function apply(late, f) {
    var q = input.value.trim(), res = entries && rank(entries, q), n = 0, j, li, raf = window.requestAnimationFrame;
    f = f || document.activeElement;
    if (!failed && !entries) return load();
    if (late === 1 && (res || failed)) { // load ended: redraw 2 frames on (no CLS)
      list.hidden = true;
      return raf(function () { raf(function () { apply(2, f); }); });
    }
    for (j = 0; j < items.length; j++) {
      items[j].hidden = !!res;
      if (!res && moved) list.appendChild(items[j]);
    }
    moved = !!res;
    for (j = 0; res && j < res.length; j++) {
      li = byUrl[res[j].url];
      if (li) { li.hidden = false; list.appendChild(li); n++; }
    }
    list.hidden = !!res && !n;
    if (f && f !== document.activeElement) f.focus();
    status.textContent = !entries ? "Search is unavailable right now; all articles are listed below." : !res ? "" :
      (n ? n + (n > 1 ? " articles match " : " article matches ") : "No articles match ") + "\u201c" + q + "\u201d" +
      (n ? "." : ". Try fewer or different words.");
  }

  function fail() { if (!entries && !failed) { failed = true; apply(1); } }

  function load() { // once; fails at 15 s
    if (started) return;
    started = true;
    window.setTimeout(fail, 15000);
    window.fetch(indexUrl).then(function (r) {
      if (!r.ok) throw new Error("index");
      return r.text();
    }).then(function (text) {
      entries = prepare(JSON.parse(text));
      apply(1);
    }).catch(fail);
  }

  function now() {
    var q = input.value.trim(), h = window.history, l = window.location;
    window.clearTimeout(timer);
    apply();
    try {
      if (h && h.replaceState) h.replaceState(null, "", l.pathname + (q ? "?q=" + encodeURIComponent(q) : "") + l.hash);
    } catch (err) { /* URL kept */ }
  }

  input.addEventListener("focus", load);
  input.addEventListener("input", function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(now, 150);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape" || e.key === "Esc") { input.value = ""; now(); }
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); now(); });

  // Nonblank ?q= loads now, else first focus/input.
  var m = /(?:^\?|&)q=([^&#]*)/.exec(window.location.search), raw = m ? m[1].replace(/\+/g, " ") : "", q0;
  try { q0 = decodeURIComponent(raw); } catch (err) { q0 = raw; }
  if (q0.trim()) { input.value = q0.replace(/[\r\n]+/g, " "); load(); }
})(window, document);
