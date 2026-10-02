/* Cabrillo Coast blog search: ES5, no deps, text-only output. */
(function (window, document) {
  "use strict";

  // Pure, exported before DOM use.
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

  // AND match, field-weighted.
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
    hits.sort(function (a, b) { return b.s - a.s || a.e.order - b.e.order; }); // ES5 may be unstable
    for (i = 0; i < hits.length; i++) hits[i] = hits[i].e;
    return hits;
  }

  window.CabrilloBlogSearch = { normalize: normalize, tokenize: tokenize, prepare: prepare, rank: rank };

  function $(id) { return document.getElementById(id); }
  var form = $("blog-search"), input = $("blog-search-input"), status = $("blog-search-status"), list = $("post-list");
  if (!form || !input || !status || !list || typeof window.fetch !== "function") return;

  var nodes = list.querySelectorAll("li[data-url]"), items = [], byUrl = Object.create(null), i;
  for (i = 0; i < nodes.length; i++) {
    items.push(nodes[i]);
    byUrl[nodes[i].getAttribute("data-url")] = nodes[i];
  }
  var indexUrl = form.getAttribute("data-index");
  if (!items.length || !indexUrl) return;
  form.hidden = false;

  var entries = null, started = false, failed = false, moved, timer;

  function apply(raw) {
    var q = String(raw).trim(), res, n = 0, j, li, quoted = "\u201c" + q + "\u201d", f = document.activeElement;
    if (!failed && !entries) { load(); return; } // load applies it when done
    res = failed ? null : rank(entries, q);
    for (j = 0; j < items.length; j++) {
      items[j].hidden = !!res;
      if (!res && moved) list.appendChild(items[j]); // original order
    }
    moved = !!res;
    for (j = 0; res && j < res.length; j++) {
      li = byUrl[res[j].url];
      if (li) { li.hidden = false; list.appendChild(li); n++; }
    }
    if (f && f !== document.activeElement) f.focus();
    list.hidden = !!res && !n;
    status.textContent = failed ? "Search is unavailable right now; all articles are listed below." :
      !res ? "" : n === 1 ? "1 article matches " + quoted + "." : n ? n + " articles match " + quoted + "." :
      "No articles match " + quoted + ". Try fewer or different words.";
  }

  function load() { // once; no retry
    if (started) return;
    started = true;
    window.fetch(indexUrl).then(function (r) {
      if (!r.ok) throw new Error("index");
      return r.text();
    }).then(function (text) {
      entries = prepare(JSON.parse(text));
      apply(input.value);
    }).catch(function () {
      failed = true;
      apply("");
    });
  }

  function now() { // apply, sync ?q=
    var q = input.value.trim(), h = window.history, l = window.location;
    window.clearTimeout(timer);
    apply(q);
    try {
      if (h && h.replaceState) h.replaceState(null, "", l.pathname + (q ? "?q=" + encodeURIComponent(q) : "") + l.hash);
    } catch (err) { /* optional; URL kept */ }
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
