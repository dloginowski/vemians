/*
 * The storefront's enhancement layer. Runs in the BROWSER, not in the Worker.
 *
 * It is imported into the Worker bundle as a TEXT module (the `**\/*.client.js`
 * rule in store/wrangler.toml) and served verbatim at /s.js, so it is one
 * cacheable file that lives next to the markup that mounts it rather than a
 * string pasted into a template. `.client.js` is the extension, not `.js`,
 * precisely so the bundler cannot mistake it for a module the Worker executes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS ALLOWED TO BE
 * ─────────────────────────────────────────────────────────────────────────────
 * An ENHANCEMENT. Every function of the storefront works with JavaScript off:
 *
 *   filter and sort   a <form method="get">, in normal flow, that submits
 *   load more         an <a href="/?n=16">, a real navigation
 *   the images        <img src> with explicit dimensions, visible by default
 *   the header        position: sticky, always shown
 *   the wishlist      absent — see below
 *
 * The wishlist is the one control that does not exist without JavaScript, and
 * so the server does not render it as a control. It renders the ♡ glyph as an
 * aria-hidden <span>, and this file REPLACES that span with a real button. A
 * dead button that silently does nothing is worse than no button.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OBSERVED vs INFERRED
 * ─────────────────────────────────────────────────────────────────────────────
 * The reference (Mytheresa) is EGRESS-BLOCKED from this environment and nobody
 * here has observed its behaviour. docs/design-direction.md §5 lists hover
 * behaviour and the filter/sort panels as unobserved outright.
 *
 * EVERY BEHAVIOUR IN THIS FILE IS INFERRED — genre convention, not observation:
 * the hover image swap and its preload-on-intent, the fade on decode, the
 * direction rules and thresholds of the hide-on-scroll header, the wishlist
 * existing at all, the panel being a side dialog, and load-more over paging.
 * Individual blocks repeat the marker so it survives being read out of context.
 *
 * What is NOT inferred, and must not be traded away for any of it: the 8:9
 * slot never moves, the first still frame is a complete page, and every
 * transition is removed — not shortened — under prefers-reduced-motion.
 */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var noop = function () {};

  /* A fine pointer means hover is a real, reversible gesture. A coarse one
     does not: a tap that "hovers" has no matching un-hover, which is why
     there is NO hover behaviour on touch, here or in interaction.css. */
  var FINE = window.matchMedia ? window.matchMedia("(pointer: fine)") : { matches: false };

  /* ── Wishlist storage ────────────────────────────────────────────────────
   * localStorage THROWS, not returns null, in several ordinary contexts:
   * a browser set to block site data, some private windows, an iframe under a
   * third-party-storage policy, and a full quota. Every access is wrapped.
   * RULES.md classes localStorage quirks as a benign fallback, so this is
   * DEBUG-level and never an ERROR — the failure mode is "the heart does not
   * persist", not "the shop is broken". No network is involved either way.
   */
  var KEY = "vemians:wishlist";

  function readWishlist() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list : []);
    } catch (err) {
      console.debug("store: wishlist unreadable, running in-memory:", err && err.message);
      return new Set();
    }
  }

  function writeWishlist(set) {
    try {
      /* Array.from, not Array.prototype.slice.call: a Set has no length and no
         indices, so slice() on one silently yields [] and the wishlist quietly
         never persists. */
      window.localStorage.setItem(KEY, JSON.stringify(Array.from(set)));
    } catch (err) {
      console.debug("store: wishlist not persisted:", err && err.message);
    }
  }

  var wish = readWishlist();

  /* ── 1. Images fade in as they decode ────────────────────────────────────
   * INFERRED timing (interaction.css --motion-slow); the grey 8:9 slot behind
   * it is measured (design-direction.md §3.1, §6).
   *
   * NOT a scroll observer, and nothing is parked at opacity 0 waiting on one.
   * There is no IntersectionObserver in this file at all. An image is parked
   * ONLY if it has not finished loading at the moment we look at it, and it is
   * released by its own load event. An image already in the cache is never
   * parked, so a repeat visit does not fade at all.
   *
   * decode() is called AFTER load rather than instead of it, deliberately:
   * calling decode() on a loading="lazy" image forces the browser to fetch it
   * immediately, which would quietly cancel lazy-loading for the whole grid.
   */
  function fadeOnDecode(img) {
    if (img.complete) return;          // already there: never hide it
    img.dataset.fade = "wait";
    var show = function () { img.removeAttribute("data-fade"); };
    var settle = function () {
      if (!img.decode) return show();
      img.decode().catch(noop).then(show);
    };
    img.addEventListener("load", settle, { once: true });
    img.addEventListener("error", show, { once: true });   // a broken image is not a hidden card
  }

  /* ── 2. Card hover: cross-fade to a second image ─────────────────────────
   * INFERRED — design-direction.md §5 calls the alternate-image swap "a genre
   * convention but unverified here".
   *
   * The second image is NOT in the page source and is NOT fetched on load. It
   * is created on hover intent, which is what keeps a 12-card grid from paying
   * for 24 images to show 12. It becomes eligible to appear only once it has
   * decoded (.ready), so the swap is always image-to-image and never
   * image-to-empty-slot.
   *
   * Everything here is gated on a fine pointer, including the keyboard path,
   * so a touch device downloads nothing extra and can never get stuck showing
   * the alternate shot. The visual swap itself is CSS: :hover / :focus-within
   * inside @media (pointer: fine).
   */
  function armHoverSwap(card) {
    var media = card.querySelector(".card-media");
    var src = media && media.getAttribute("data-alt");
    if (!src) return;
    var armed = false;

    function arm() {
      if (armed || !FINE.matches) return;
      armed = true;
      var img = new Image(800, 900);
      img.className = "shot shot-alt";
      img.decoding = "async";
      img.alt = "";                       // decorative: the primary shot is named
      img.setAttribute("aria-hidden", "true");
      img.addEventListener("load", function () {
        var ready = function () { img.classList.add("ready"); };
        if (!img.decode) return ready();
        img.decode().catch(noop).then(ready);
      }, { once: true });
      img.addEventListener("error", function () {
        console.debug("store: alternate shot unavailable:", src);
        img.remove();
      }, { once: true });
      img.src = src;
      media.appendChild(img);
    }

    /* pointerenter fires for touch as well, hence the pointerType gate on top
       of the media-query gate. focusin is the keyboard's route to the same
       preview, so a keyboard user is not shown less than a mouse user. */
    card.addEventListener("pointerenter", function (ev) {
      if (ev.pointerType === "mouse") arm();
    });
    card.addEventListener("focusin", arm);
  }

  /* ── 3. Wishlist heart ───────────────────────────────────────────────────
   * INFERRED that a wishlist exists at all; its position and size are §4.
   *
   * A native <button> is built here rather than shipped in the HTML, because
   * without this script there is nothing for it to do. One builder, used by
   * the first render and by every card load-more appends — there is no second
   * path that creates a heart.
   *
   * Plain `click` only: a real <button> already fires click from touch, from
   * Enter and from Space, so adding pointerup/touchend handlers on top would
   * double-fire rather than fix anything.
   */
  function buildHeart(span) {
    var handle = span.getAttribute("data-heart");
    var name = span.getAttribute("data-name") || "";
    if (!handle) return;

    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "heart";
    btn.id = "wish-" + handle;              // unique per rendered instance
    btn.setAttribute("data-heart", handle);
    btn.setAttribute("aria-pressed", String(wish.has(handle)));
    btn.setAttribute("aria-label", "Wishlist: " + name);

    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      if (on) wish.add(handle); else wish.delete(handle);
      writeWishlist(wish);
    });

    span.replaceWith(btn);
  }

  /* ── 4. Header: sticky, hides on scroll down, reveals on scroll up ───────
   * INFERRED behaviour and thresholds.
   *
   * Transform only — the header never changes height, never leaves the flow it
   * is already in and never grows a shadow. Reads are batched into one
   * requestAnimationFrame so a scroll never triggers a synchronous layout.
   *
   * DEAD_ZONE swallows sub-pixel drift and trackpad rubber-banding; it is
   * deliberately NOT applied to `lastY`, so slow scrolling accumulates and
   * eventually crosses the threshold rather than being ignored forever.
   */
  var DEAD_ZONE = 8;

  function armHeader(head) {
    if (!head) return;
    var lastY = window.scrollY;
    var queued = false;

    function paint() {
      queued = false;
      var y = window.scrollY;

      /* At the top the header is shown, and shown instantly: arriving back at
         the top of a page should not look like an animation. */
      if (y <= head.offsetHeight) {
        head.setAttribute("data-head", "top");
        lastY = y;
        return;
      }

      var dy = y - lastY;
      if (Math.abs(dy) < DEAD_ZONE) return;
      head.setAttribute("data-head", dy > 0 ? "hidden" : "shown");
      lastY = y;
    }

    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(paint);
    }, { passive: true });

    paint();
  }

  /* ── 5. Filter and sort: a real dialog ───────────────────────────────────
   * INFERRED entirely (design-direction.md §5 — unobserved).
   *
   * The same <form> the no-JS page submits inline becomes the dialog's
   * contents. Nothing is re-rendered and no markup moves: the .js class was
   * already on <html> before first paint, so the form was laid out as a panel
   * from the very first frame and the upgrade costs no reflow.
   *
   * It is a DIALOG, not a dropdown: modal, focus-trapped, Escape-closable,
   * with the background scrolled locked and focus returned to the trigger it
   * came from.
   */
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function armPanel() {
    var panel = doc.getElementById("filters");
    var trigger = doc.querySelector(".filter-open");
    if (!panel || !trigger) return;

    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Filter and sort");
    panel.setAttribute("data-open", "false");

    var scrim = doc.createElement("div");
    scrim.className = "scrim";
    scrim.setAttribute("data-open", "false");
    doc.body.appendChild(scrim);

    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "filters");

    var returnTo = null;

    var isOpen = function () { return panel.getAttribute("data-open") === "true"; };
    var focusables = function () {
      return Array.prototype.filter.call(panel.querySelectorAll(FOCUSABLE), function (el) {
        return el.offsetParent !== null || el === doc.activeElement;
      });
    };

    /* Locking the background removes the scrollbar, which would widen the page
       by its width. --sbw is measured at lock time and given back as padding,
       so opening the panel shifts nothing. Overlay scrollbars measure 0 and the
       compensation is a no-op, which is correct. */
    function lock(on) {
      if (on) {
        root.style.setProperty("--sbw", (window.innerWidth - root.clientWidth) + "px");
        root.classList.add("scroll-locked");
      } else {
        root.classList.remove("scroll-locked");
        root.style.removeProperty("--sbw");
      }
    }

    function open() {
      returnTo = doc.activeElement;
      panel.setAttribute("data-open", "true");
      scrim.setAttribute("data-open", "true");
      trigger.setAttribute("aria-expanded", "true");
      lock(true);
      var f = focusables();
      (f[0] || panel).focus();
    }

    function close() {
      if (!isOpen()) return;
      panel.setAttribute("data-open", "false");
      scrim.setAttribute("data-open", "false");
      trigger.setAttribute("aria-expanded", "false");
      lock(false);
      /* Focus goes back where it came from. A dialog that closes into the top
         of the document has thrown a keyboard user's place away. */
      if (returnTo && returnTo.focus) returnTo.focus();
      else trigger.focus();
      returnTo = null;
    }

    trigger.addEventListener("click", open);
    scrim.addEventListener("click", close);
    Array.prototype.forEach.call(panel.querySelectorAll(".panel-close"), function (el) {
      el.addEventListener("click", close);
    });

    doc.addEventListener("keydown", function (ev) {
      if (!isOpen()) return;

      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key !== "Tab") return;

      var f = focusables();
      if (!f.length) return;
      var first = f[0];
      var last = f[f.length - 1];

      if (!panel.contains(doc.activeElement)) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && doc.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && doc.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    });
  }

  /* ── 6. Load more ────────────────────────────────────────────────────────
   * INFERRED.
   *
   * Deliberately NOT infinite scroll. Infinite scroll appends content between
   * a keyboard user and the footer faster than they can tab past it; there is
   * no keyboard-accessible way out of a grid that grows as you approach its
   * end. This is one control, in the tab order, between the grid and the foot.
   *
   * The control is an <a href> to the same page with a larger `n`. With this
   * script the navigation is replaced by a fetch of the same URL's fragment
   * and the cards are APPENDED — appending to the end of a grid cannot move
   * anything already in it, so there is no jump. history.replaceState keeps
   * the address bar equal to the no-JS URL, so a reload restores the same set.
   *
   * If the fetch fails the click is not swallowed: it falls through to the
   * navigation the link already described, and the failure is logged.
   */
  function armMore(catalog, moreRow, status) {
    var link = moreRow && moreRow.querySelector("a.more");
    if (!link) return;

    link.addEventListener("click", function (ev) {
      /* Leave modified clicks and middle-clicks to the browser: "open in a new
         tab" on a load-more link is a real thing people do. */
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();

      var href = link.getAttribute("href");
      var hadFocus = moreRow.contains(doc.activeElement);
      link.setAttribute("aria-busy", "true");

      fetch(href + (href.indexOf("?") < 0 ? "?" : "&") + "partial=1", {
        headers: { accept: "text/html" },
        credentials: "same-origin",
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (text) {
          var frag = new DOMParser().parseFromString(text, "text/html");
          var added = frag.querySelectorAll(".catalog-part > .card");
          Array.prototype.forEach.call(added, function (node) {
            var card = doc.importNode(node, true);
            catalog.appendChild(card);
            hydrate(card);
          });

          var nextRow = frag.querySelector(".more-part");
          moreRow.innerHTML = nextRow ? nextRow.innerHTML : "";
          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, "", href);
          }
          var said = frag.querySelector(".status-part");
          if (status && said) status.textContent = said.textContent;

          var next = moreRow.querySelector("a.more");
          if (next) {
            armMore(catalog, moreRow, status);
            if (hadFocus) next.focus();
          } else if (hadFocus && status) {
            /* The control just removed itself from under the caret. Park focus
               on the status line rather than dropping it to <body>. */
            status.tabIndex = -1;
            status.focus();
          }
        })
        .catch(function (err) {
          console.error("ERROR store: load-more fetch failed, falling back to navigation:", err && err.message);
          window.location.href = href;
        });
    });
  }

  /* ── Hydration ───────────────────────────────────────────────────────────
   * One entry point, used for the server-rendered grid and for every card
   * load-more appends. There is no second path that arms a card.
   */
  function hydrate(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll("img.shot"), fadeOnDecode);
    Array.prototype.forEach.call(scope.querySelectorAll(".card"), armHoverSwap);
    Array.prototype.forEach.call(scope.querySelectorAll("span.heart[data-heart]"), buildHeart);
  }

  function start() {
    var catalog = doc.getElementById("catalog");
    if (catalog) hydrate(catalog);
    armHeader(doc.querySelector(".masthead"));
    armPanel();
    armMore(catalog, doc.getElementById("more-row"), doc.getElementById("catalog-status"));
    root.setAttribute("data-enhanced", "true");   // a handle for tests and for CSS
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
})();
