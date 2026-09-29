/**
 * GreenTee Spin to Win: cart progress bar.
 *
 * - <gt-cart-progress> is a custom element, so every copy the theme renders
 *   (cart page, drawer, a drawer re-rendered over AJAX) sets itself up.
 * - The subtotal comes from the cart: `total_price` from /cart.js, which is
 *   the cart after discounts and before shipping and tax, the same basis as
 *   the order's currentSubtotalPriceSet that spin eligibility reads.
 * - The threshold and whether the campaign is on come from the app proxy.
 *   Until that answers "open", nothing shows. A failed request shows nothing.
 * - Cart changes are noticed by watching fetch and XMLHttpRequest calls to
 *   the cart endpoints; after each one, /cart.js is re-read and every bar on
 *   the page updates, whether or not the theme re-rendered it.
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.customElements) return;
  if (window.customElements.get("gt-cart-progress")) return;

  var CONFIG_TTL_MS = 60 * 1000;
  var STORAGE_KEY = "gtsw-cart-progress";
  var PREVIEW_KEY = "gtsw-cart-progress-preview";
  var PREVIEW_PARAM = "spin-embed"; // ?spin-embed=test shows the bar on the live site; ?spin-embed=off ends it

  /*
   * The banner is a single dark pill, one line, in the element's shadow
   * root so theme CSS cannot touch it. The font is inherited from the host
   * on purpose so it reads as part of the theme; everything else is pinned.
   */
  var TEMPLATE =
    "<style>" +
    ":host{display:block;box-sizing:border-box;width:100%;margin:var(--gtsw-margin,12px) 0;" +
    "font-size:13px;line-height:1.3;text-transform:none;letter-spacing:normal}" +
    ":host([hidden]){display:none}" +
    ".pill{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;margin:0;padding:10px 14px;" +
    "border-radius:999px;background:#111;color:#fff;font-weight:500}" +
    ".pill svg{flex:0 0 auto;width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round}" +
    ".pill[data-icon=''] svg{display:none}" +
    ".text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".text strong{font-weight:700}" +
    "</style>" +
    '<p class="pill" data-pill>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.6"/>' +
    '<path d="M12 3v7.4M21 12h-7.4M12 21v-7.4M3 12h7.4M18.4 5.6l-5.2 5.2M18.4 18.4l-5.2-5.2M5.6 18.4l5.2-5.2M5.6 5.6l5.2 5.2"/></svg>' +
    '<span class="text" data-line aria-live="polite"></span>' +
    "</p>";

  /** Live-site preview: ?spin-embed=test turns it on for the browser session, ?spin-embed=off turns it off. */
  function livePreview() {
    try {
      var v = new URLSearchParams(window.location.search).get(PREVIEW_PARAM);
      if (v === "test") window.sessionStorage.setItem(PREVIEW_KEY, "1");
      else if (v === "off") window.sessionStorage.removeItem(PREVIEW_KEY);
      return window.sessionStorage.getItem(PREVIEW_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  var CART_ENDPOINT = /\/cart\/(add|change|update|clear|remove)(\.js|\.json)?(\?|$)/;

  var instances = [];
  var config = null; // { open, minSubtotal, currency, fetchedAt }
  var configPromise = null;
  var cart = null; // { subtotal (minor units), currency }

  function readStoredConfig() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.fetchedAt > CONFIG_TTL_MS) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function storeConfig(c) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    } catch (e) {
      /* private mode etc. */
    }
  }

  /** The cached answer while it is fresh; an expired one must not drive a render. */
  function currentConfig() {
    return config && Date.now() - config.fetchedAt <= CONFIG_TTL_MS ? config : null;
  }

  function loadConfig(proxyPath) {
    if (currentConfig()) return Promise.resolve(config);
    var stored = readStoredConfig();
    if (stored) {
      config = stored;
      return Promise.resolve(config);
    }
    if (configPromise) return configPromise;
    configPromise = fetch(proxyPath + "/campaign", { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (body) {
        if (!body || typeof body.minSubtotal !== "number") return null;
        config = {
          open: body.open === true,
          minSubtotal: body.minSubtotal,
          currency: body.currency || "CAD",
          fetchedAt: Date.now(),
        };
        storeConfig(config);
        return config;
      })
      .catch(function () {
        return null;
      })
      .then(function (c) {
        configPromise = null;
        return c;
      });
    return configPromise;
  }

  /**
   * "$176.55" / "$50" for CAD in a Canadian storefront. The theme's locale is
   * a bare language code ("en", "fr"); pinned to a Canadian region so the
   * symbol is "$", not "CA$". narrowSymbol drops the country prefix.
   */
  function formatMoney(minor, currency, locale) {
    var amount = minor / 100;
    var lang = String(locale || "en").split("-")[0];
    var tag = lang + "-CA";
    try {
      return new Intl.NumberFormat(tag, {
        style: "currency",
        currency: currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (e) {
      return "$" + amount.toFixed(2);
    }
  }

  /** Fills `[amount]` in a copy template, as a bold run, into `node`. */
  function fillLine(node, template, amount) {
    while (node.firstChild) node.removeChild(node.firstChild);
    var parts = String(template || "").split("[amount]");
    node.appendChild(document.createTextNode(parts[0]));
    if (parts.length > 1) {
      var strong = document.createElement("strong");
      strong.textContent = amount;
      node.appendChild(strong);
      node.appendChild(document.createTextNode(parts.slice(1).join("[amount]")));
    }
  }

  function refreshCart() {
    return fetch("/cart.js", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (body) {
        if (!body || typeof body.total_price !== "number") return;
        cart = { subtotal: body.total_price, currency: body.currency };
        for (var i = 0; i < instances.length; i++) instances[i].render();
      })
      .catch(function () {
        /* keep the last known value */
      });
  }

  var watching = false;
  function watchCart() {
    if (watching) return;
    watching = true;
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && input.url;
        var result = nativeFetch.apply(this, arguments);
        if (url && CART_ENDPOINT.test(url)) {
          result.then(
            function () {
              refreshCart();
            },
            function () {},
          );
        }
        return result;
      };
    }
    var xhrOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
    if (xhrOpen) {
      window.XMLHttpRequest.prototype.open = function (method, url) {
        if (url && CART_ENDPOINT.test(String(url))) {
          this.addEventListener("loadend", function () {
            refreshCart();
          });
        }
        return xhrOpen.apply(this, arguments);
      };
    }
    // Back/forward cache restores can show a cart that changed on another page.
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) refreshCart();
    });
  }

  function CartProgress() {
    return Reflect.construct(HTMLElement, [], CartProgress);
  }
  CartProgress.prototype = Object.create(HTMLElement.prototype);
  CartProgress.prototype.constructor = CartProgress;

  CartProgress.prototype.connectedCallback = function () {
    var self = this;
    if (instances.indexOf(self) === -1) instances.push(self);
    if (!self.shadowRoot) {
      // Anything the theme rendered inside is discarded; the shadow root is the UI.
      while (self.firstChild) self.removeChild(self.firstChild);
      var root = self.attachShadow ? self.attachShadow({ mode: "open" }) : self;
      root.innerHTML = TEMPLATE;
      self.ui = root;
    }
    self.proxyPath = (self.getAttribute("data-proxy-path") || "/apps/spin").replace(/\/+$/, "");
    // The value the theme rendered is right for this render; a drawer
    // re-rendered over AJAX carries the new cart in this attribute too.
    var attr = self.getAttribute("data-subtotal");
    if (attr !== null && attr !== "" && !isNaN(Number(attr))) {
      cart = { subtotal: Number(attr), currency: self.getAttribute("data-currency") };
    } else {
      // Injected by the embed: nothing was rendered for this cart, so read it.
      // The drawer only re-renders because the cart changed, so a cached
      // value could be stale.
      refreshCart();
    }
    watchCart();
    loadConfig(self.proxyPath).then(function () {
      self.render();
    });
    self.render();
  };

  CartProgress.prototype.disconnectedCallback = function () {
    var i = instances.indexOf(this);
    if (i !== -1) instances.splice(i, 1);
  };

  /** Theme editor preview: shown regardless of campaign state, threshold from the server if it answered. */
  var PREVIEW_THRESHOLD = 300;

  CartProgress.prototype.render = function () {
    var preview = this.getAttribute("data-preview") === "true" || livePreview();
    var config = currentConfig();
    if (preview) {
      config = {
        open: true,
        minSubtotal: config ? config.minSubtotal : PREVIEW_THRESHOLD,
        currency: config ? config.currency : "CAD",
      };
      if (!cart) cart = { subtotal: 0, currency: config.currency };
    }
    if (!config || !config.open || !cart) {
      this.hidden = true;
      return;
    }
    // Compare in the threshold's currency only; the block already renders
    // nothing when the cart is presented in another currency.
    if (!preview && cart.currency && cart.currency !== config.currency) {
      this.hidden = true;
      return;
    }
    var ui = this.ui || this;
    var threshold = Math.round(config.minSubtotal * 100);
    var subtotal = Math.max(0, cart.subtotal);
    // An empty cart gets no nudge; the drawer's own empty state does the talking.
    if (subtotal <= 0 && !preview) {
      this.hidden = true;
      return;
    }
    var pill = ui.querySelector("[data-pill]");
    if (pill)
      pill.setAttribute("data-icon", this.getAttribute("data-icon") === "true" ? "true" : "");
    var margin = parseInt(this.getAttribute("data-margin"), 10);
    this.style.setProperty("--gtsw-margin", (isNaN(margin) ? 12 : margin) + "px");
    var reached = subtotal >= threshold;
    var locale = this.getAttribute("data-locale") || "en-CA";
    var line = ui.querySelector("[data-line]");
    if (line) {
      if (reached) line.textContent = this.getAttribute("data-copy-reached") || "";
      else
        fillLine(
          line,
          this.getAttribute("data-copy-remaining"),
          formatMoney(threshold - subtotal, config.currency, locale),
        );
    }
    this.classList.toggle("gt-cartbar--reached", reached);
    this.hidden = false;
  };

  window.customElements.define("gt-cart-progress", CartProgress);

  /**
   * App embed mode. The embed renders a <template> with the element inside
   * and two targets (drawer, page). Clone it next to each target that
   * exists, and do it again whenever the theme swaps that part of the DOM,
   * which is what an AJAX cart drawer does on every change.
   */
  function setupEmbed() {
    var tpl = document.querySelector("template[data-gt-cartbar-template]");
    if (!tpl || !tpl.content) return;
    var targets = [
      {
        sel: tpl.getAttribute("data-drawer-selector"),
        pos: tpl.getAttribute("data-drawer-position"),
      },
      { sel: tpl.getAttribute("data-page-selector"), pos: tpl.getAttribute("data-page-position") },
    ];
    var placed = typeof WeakMap === "function" ? new WeakMap() : null;

    function insert(target, pos) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.setAttribute("data-gt-cartbar-embed", "");
      if (pos === "before") target.parentNode.insertBefore(node, target);
      else if (pos === "prepend") target.insertBefore(node, target.firstChild);
      else if (pos === "append") target.appendChild(node);
      else target.parentNode.insertBefore(node, target.nextSibling);
      return node;
    }

    /** Is there already a bar where this target's bar would go? Checked in the DOM, not just memory. */
    function hasBar(target, pos) {
      var n =
        pos === "before"
          ? target.previousElementSibling
          : pos === "prepend"
            ? target.firstElementChild
            : pos === "append"
              ? target.lastElementChild
              : target.nextElementSibling;
      return !!(n && n.hasAttribute && n.hasAttribute("data-gt-cartbar-embed"));
    }

    function inject() {
      for (var i = 0; i < targets.length; i++) {
        var sel = (targets[i].sel || "").trim();
        if (!sel) continue;
        var target;
        try {
          target = document.querySelector(sel);
        } catch (e) {
          continue; // a bad selector typed into the setting
        }
        if (!target) continue;
        var existing = placed && placed.get(target);
        if (existing && existing.isConnected) continue;
        if (hasBar(target, targets[i].pos)) continue;
        var node = insert(target, targets[i].pos);
        if (placed) placed.set(target, node);
      }
    }

    // setTimeout, not requestAnimationFrame: a drawer can change while the
    // tab is in the background, and animation frames do not run there.
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        inject();
      }, 0);
    }

    inject();
    if (window.MutationObserver) {
      // One watcher per page. If the script somehow runs twice (a theme that
      // loads it in two places), the later run replaces the earlier watcher.
      if (window.__gtswCartbarObserver) window.__gtswCartbarObserver.disconnect();
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes.length || mutations[i].removedNodes.length) {
            schedule();
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__gtswCartbarObserver = observer;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupEmbed);
  else setupEmbed();
})();
