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

      // Guard: form endpoint not configured yet.
      if (form.action.indexOf("YOUR_FORM_ID") !== -1) {
        setStatus(
          "This form isn't connected yet. Set up a free endpoint at formspree.io and drop the ID into index.html — or email hello@cabrillocoast.com in the meantime.",
          "err"
        );
        return;
      }

      var btn = form.querySelector("button[type=submit]");
      var original = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      setStatus("", "");

      fetch(form.action, {
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
                data && data.errors && data.errors.length
                  ? data.errors.map(function (x) { return x.message; }).join(", ")
                  : "Something went wrong. Please try again, or email hello@cabrillocoast.com.";
              setStatus(msg, "err");
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
