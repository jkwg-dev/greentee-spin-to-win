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

  CartProgress.prototype.render = function () {
    var config = currentConfig();
    if (!config || !config.open || !cart) {
      this.hidden = true;
      return;
    }
    // Compare in the threshold's currency only; the block already renders
    // nothing when the cart is presented in another currency.
    if (cart.currency && cart.currency !== config.currency) {
      this.hidden = true;
      return;
    }
    var threshold = Math.round(config.minSubtotal * 100);
    var subtotal = Math.max(0, cart.subtotal);
    // An empty cart gets no nudge; the drawer's own empty state does the talking.
    if (subtotal <= 0) {
      this.hidden = true;
      return;
    }
    var reached = subtotal >= threshold;
    var pct = threshold > 0 ? Math.min(100, Math.round((subtotal / threshold) * 1000) / 10) : 100;
    var line = this.querySelector("[data-line]");
    var track = this.querySelector("[data-track]");
    var bar = this.querySelector("[data-fill]");
    var locale = this.getAttribute("data-locale") || "en-CA";
    if (line) {
      if (reached) line.textContent = this.getAttribute("data-copy-reached") || "";
      else
        fillLine(
          line,
          this.getAttribute("data-copy-remaining"),
          formatMoney(threshold - subtotal, config.currency, locale),
        );
    }
    var tier = this.querySelector("[data-tier]");
    if (tier) tier.textContent = formatMoney(threshold, config.currency, locale);
    if (bar) bar.style.width = pct + "%";
    if (track) track.setAttribute("aria-valuenow", String(Math.round(pct)));
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
