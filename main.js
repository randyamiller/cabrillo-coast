/* Cabrillo Coast LLC — interactions (vanilla, no dependencies) */
(function () {
  "use strict";

  /* ---- Current year in footer ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- Sticky header shadow on scroll ---- */
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- Mobile menu toggle ---- */
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      menu.hidden = open;
      menu.dataset.open = String(!open);
    });
    // close after tapping a link
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        toggle.setAttribute("aria-expanded", "false");
        menu.hidden = true;
        menu.dataset.open = "false";
      });
    });
  }

  /* ---- Contact form (Formspree AJAX) ---- */
  var form = document.getElementById("contact-form");
  var status = document.getElementById("form-status");

  function setStatus(msg, kind) {
    if (!status) return;
    status.textContent = msg;
    status.className = "form-status" + (kind ? " " + kind : "");
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Post to FormSubmit's AJAX endpoint (keeps us on-page); the form's plain
      // action stays the no-JS fallback. e.g. formsubmit.co/x -> formsubmit.co/ajax/x
      var endpoint = form.getAttribute("action").replace(
        "formsubmit.co/",
        "formsubmit.co/ajax/"
      );

      var btn = form.querySelector("button[type=submit]");
      var original = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      setStatus("", "");

      fetch(endpoint, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" }
      })
        .then(function (res) {
          if (res.ok) {
            form.reset();
            setStatus("Thanks — your message is on its way. We'll be in touch shortly.", "ok");
          } else {
            return res.json().then(function (data) {
              var msg =
                (data && (data.message ||
                  (data.errors && data.errors.map(function (x) { return x.message; }).join(", ")))) ||
                "Something went wrong. Please try again, or email hello@cabrillocoast.com.";
              setStatus(msg, "err");
            }).catch(function () {
              setStatus("Something went wrong. Please try again in a moment.", "err");
            });
          }
        })
        .catch(function () {
          setStatus("Network error — please try again, or email hello@cabrillocoast.com.", "err");
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = original; }
        });
    });
  }
})();
