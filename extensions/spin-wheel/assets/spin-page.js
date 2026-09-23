/*
 * GreenTee Spin to Win: storefront spin page.
 *
 * Invariants:
 * - The server decides the slice. This script never derives an outcome; it
 *   animates to the index the execute endpoint returns.
 * - A missing, invalid or expired token shows a plain message and nothing else.
 * - A refresh, back navigation or second visit shows the stored result
 *   instead of spinning again (the state endpoint returns it).
 * - If the spin request fails mid animation the wheel is stopped, the error
 *   is shown, and Try again re-sends the request. The server is idempotent,
 *   so a retry after a partial success returns the same reward.
 * - prefers-reduced-motion shortens the animation to a brief settle.
 *
 * Visuals: spin-wheel draws the coloured slices; labels with icons live in an
 * HTML layer that rotates with the wheel while each label counter-rotates so
 * text stays upright, matching the design at rest for every outcome.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-gt-spin]");
  if (!root || typeof spinWheel === "undefined") return;

  var els = {
    status: root.querySelector("[data-status]"),
    stage: root.querySelector("[data-stage]"),
    wheel: root.querySelector("[data-wheel]"),
    labels: root.querySelector("[data-labels]"),
    spin: root.querySelector("[data-spin]"),
    retry: root.querySelector("[data-retry]"),
    result: root.querySelector("[data-result]"),
    close: root.querySelector("[data-close]"),
  };

  var styles = getComputedStyle(root);
  function cssVar(name, fallback) {
    var v = styles.getPropertyValue(name).trim();
    return v || fallback;
  }

  var cfg = {
    proxyPath: (root.getAttribute("data-proxy-path") || "/apps/spin").replace(/\/+$/, ""),
    intro: root.getAttribute("data-intro") || "",
    backLabel: root.getAttribute("data-back-label") || "Back to your order",
    overlay: root.getAttribute("data-overlay") === "true",
    colors: {
      navy: cssVar("--gt-navy", "#1b2a3d"),
      cream: cssVar("--gt-cream", "#efe9dc"),
      green: cssVar("--gt-green", "#2e5a3e"),
      gold: cssVar("--gt-gold", "#c9a961"),
    },
  };

  // Slice palette by position, as in the design: navy, cream, green, repeating.
  var PALETTE = [
    { bg: cfg.colors.navy, text: cfg.colors.cream },
    { bg: cfg.colors.cream, text: cfg.colors.navy },
    { bg: cfg.colors.green, text: cfg.colors.cream },
  ];

  var ICONS = {
    club: '<path d="M14.5 3 9 16.5"/><path d="M9 16.5c-2 1.2-1.7 4.1.8 4.4 1.7.2 3.3-.6 4.8-2.3l1.6-1.8-4.4-1.9c-1-.4-2.1-.2-2.8.6z"/>',
    glove:
      '<path d="M7 21h6.5a3.5 3.5 0 0 0 3.5-3.5V11a1.5 1.5 0 0 0-3 0V9.5a1.5 1.5 0 0 0-3 0V7.5a1.5 1.5 0 0 0-3 0V15l-2.3-2.3a1.4 1.4 0 0 0-2 2L7 18z"/>',
    brush: '<path d="M4 8h9v6H4z"/><path d="M13 11h7"/><path d="M6 14v4M8.5 14v5M11 14v4"/>',
    sock: '<path d="M8 3h7v9.5l3.3 3.3a3.4 3.4 0 0 1-4.8 4.8L9 16.1A3 3 0 0 1 8 13.9z"/><path d="M8 6.5h7"/>',
    shirt:
      '<path d="M8.5 4 12 5.5 15.5 4l4.2 2.8-2.2 3.2-1.5-.8V20h-8V9.2l-1.5.8-2.2-3.2z"/><path d="M12 5.5v4"/>',
    bag: '<path d="M6 8h12l1 13H5z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    trophy:
      '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3"/><path d="M12 13v3"/><path d="M9 20h6"/><path d="M10 16h4v4h-4z"/>',
  };

  var COPY = {
    checking: "Checking your order…",
    pending: "Just a moment while we find your order…",
    invalid:
      "This spin link is invalid or has expired. Your reward, if you have one, is on your order status page.",
    closed: "Spin to Win is closed right now. Thanks for shopping with GreenTee!",
    ready: cfg.intro,
    spinning: "Spinning…",
    loadFailed: "We couldn't load your spin. Please try again.",
    spinFailed: "We couldn't complete your spin. Nothing was lost. Press Try again.",
    stillPending: "Your order is still being confirmed. Please try again in a moment.",
    forceDenied: "That option isn't available. Press Try again to spin.",
    keepSafe:
      "Keep this code somewhere safe. You can also find it later through the link in your order confirmation email.",
    giftIntro: "It's on us. Added to this order at no charge.",
    giftConfirm: "Add to my order",
    giftAdding: "Adding to your order…",
    giftAdded: "It ships with the rest of your items at no charge.",
    giftFailed: "We couldn't add your gift just now. Nothing was lost. Please try again.",
    giftOfferMissing: "We couldn't load your gift options. Please try again.",
    giftPendingElsewhere: "Your gift hasn't been added yet. Contact us and we'll sort it out.",
  };

  var PENDING_DELAYS = [1500, 2500, 4000, 6000, 8000];
  var SPIN_DURATION = 5200;
  var SPIN_REVOLUTIONS = 4;
  var REDUCED_DURATION = 700;
  var LABEL_RADIUS = 0.64; // fraction of the wheel radius
  var sliceDeg = 36; // recomputed from the number of slices the server sends

  var params = new URLSearchParams(window.location.search);
  var token = params.get("token");
  var forceSlice = params.get("force"); // test users only; the server enforces it
  var reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var wheel = null;
  var wheelReady = false;
  var labelEls = [];
  var busy = false;
  var revealTimer = null;
  var lastAction = null; // "load" | "spin", for the retry button
  var orderUrl = null;
  var pendingReveal = null;

  if (cfg.overlay) document.documentElement.classList.add("gt-spin-open");

  // ---------------------------------------------------------------- helpers

  function show(el, on) {
    if (el) el.hidden = !on;
  }

  function setStatus(text, isError) {
    els.status.textContent = text || "";
    els.status.classList.toggle("gt-spin__status--error", !!isError);
    show(els.status, !!text);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatExpiry(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      // en-US: "November 2, 2026 at 9:00 AM PST" (en-CA would end in "a.m." and fight the sentence's period).
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Vancouver",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch (e) {
      return d.toLocaleString();
    }
  }

  function api(path, options) {
    var init = {
      method: (options && options.method) || "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    };
    if (options && options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(cfg.proxyPath + path, init).then(
      function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { ok: res.ok, status: res.status, body: body };
          });
      },
      function () {
        return { ok: false, status: 0, body: null };
      },
    );
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function setOrderUrl(url) {
    orderUrl = typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
    if (els.close) {
      if (orderUrl) els.close.setAttribute("href", orderUrl);
      else els.close.removeAttribute("href");
      show(els.close, !!orderUrl);
    }
  }

  // ------------------------------------------------------------------ wheel

  function buildWheel(slices) {
    if (wheelReady || !Array.isArray(slices) || slices.length === 0) return;
    var items = slices.map(function (s, i) {
      var p = PALETTE[i % PALETTE.length];
      return { label: "", backgroundColor: p.bg };
    });
    wheel = new spinWheel.Wheel(els.wheel, {
      items: items,
      isInteractive: false,
      pointerAngle: 0,
      radius: 1,
      borderWidth: 0,
      lineWidth: 2,
      lineColor: "#ffffff",
      rotationResistance: 0,
      rotationSpeedMax: 320,
      onRest: onWheelRest,
    });
    // Rest position: slice 1 centred under the pointer, as in the design.
    sliceDeg = 360 / items.length;
    wheel.rotation = -sliceDeg / 2;
    buildLabels(slices);
    wheelReady = true;
    show(els.stage, true);
    syncLabels(true);
    requestAnimationFrame(tick);
  }

  function buildLabels(slices) {
    var layer = els.labels;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    labelEls = slices.map(function (s, i) {
      var p = PALETTE[i % PALETTE.length];
      var centre = i * sliceDeg + sliceDeg / 2; // wheel angle, 0 = top, clockwise
      var rad = (centre * Math.PI) / 180;
      var label = el("div", "gt-spin__label");
      label.style.left = 50 + LABEL_RADIUS * 50 * Math.sin(rad) + "%";
      label.style.top = 50 - LABEL_RADIUS * 50 * Math.cos(rad) + "%";
      label.style.color = p.text;
      var icon = ICONS[s.icon] || ICONS.trophy;
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = icon;
      label.appendChild(svg);
      label.appendChild(el("span", "gt-spin__label-text", String(s.label || "")));
      layer.appendChild(label);
      return label;
    });
  }

  var lastRotation = null;

  function syncLabels(force) {
    if (!wheel) return;
    var r = wheel.rotation;
    if (!force && r === lastRotation) return;
    lastRotation = r;
    els.labels.style.transform = "rotate(" + r + "deg)";
    var counter = "translate(-50%, -50%) rotate(" + -r + "deg)";
    for (var i = 0; i < labelEls.length; i++) labelEls[i].style.transform = counter;
  }

  function tick() {
    syncLabels(false);
    requestAnimationFrame(tick);
  }

  function onWheelRest() {
    if (!pendingReveal) return;
    var reveal = pendingReveal;
    pendingReveal = null;
    if (revealTimer) clearTimeout(revealTimer);
    syncLabels(true);
    reveal();
  }

  /** Animates to the slice and then calls done. Never leaves the wheel spinning forever. */
  function landOn(sliceIndex, done) {
    var index = Math.max(0, Math.min(wheel.items.length - 1, sliceIndex - 1));
    pendingReveal = done;
    var duration = reducedMotion ? REDUCED_DURATION : SPIN_DURATION;
    var revolutions = reducedMotion ? 0 : SPIN_REVOLUTIONS;
    wheel.spinToItem(index, duration, true, revolutions, 1);
    // Safety net in case onRest never fires (tab hidden, frame throttling).
    revealTimer = setTimeout(function () {
      if (pendingReveal) {
        wheel.stop();
        wheel.spinToItem(index, 0, true, 0, 1);
        onWheelRest();
      }
    }, duration + 1500);
  }

  function placeAt(sliceIndex) {
    var index = Math.max(0, Math.min(wheel.items.length - 1, sliceIndex - 1));
    wheel.spinToItem(index, 0, true, 0, 1);
    syncLabels(true);
  }

  // ---------------------------------------------------------------- render

  function hideAll() {
    show(els.spin, false);
    show(els.retry, false);
    show(els.result, false);
  }

  function renderInvalid() {
    hideAll();
    show(els.stage, false);
    setStatus(COPY.invalid, false);
  }

  function renderClosed() {
    hideAll();
    show(els.stage, false);
    setStatus(COPY.closed, false);
  }

  function renderIneligible(message) {
    hideAll();
    setStatus(message || COPY.closed, false);
  }

  function renderReady() {
    setStatus(COPY.ready, false);
    show(els.spin, true);
    els.spin.disabled = false;
    show(els.retry, false);
    show(els.result, false);
  }

  function renderError(message, action) {
    lastAction = action;
    setStatus(message, true);
    show(els.spin, false);
    show(els.retry, true);
    els.retry.disabled = false;
  }

  /**
   * Renders the reward. For gifts, `extras.offer` (from the state or execute
   * response) drives the confirm step; `extras.message` is a server line such
   * as the out-of-stock notice.
   */
  function renderResult(result, extras) {
    extras = extras || {};
    setStatus("", false);
    show(els.spin, false);
    show(els.retry, false);
    var box = els.result;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.classList.toggle("gt-spin__result--expired", !!result.expired);

    var expiry = formatExpiry(result.expiresAt);

    if (result.rewardType === "gift") {
      renderGift(box, result, extras.offer || null, extras.message || null);
    } else if (result.expired) {
      box.appendChild(el("h2", "gt-spin__result-heading", "Your Spin to Win code has expired"));
      box.appendChild(el("div", "gt-spin__code", result.code || ""));
      box.appendChild(
        el("p", "gt-spin__note", result.rewardLabel + ". Expired on " + expiry + "."),
      );
    } else {
      box.appendChild(el("h2", "gt-spin__result-heading", "You won " + result.rewardLabel + "!"));
      box.appendChild(el("div", "gt-spin__code", result.code || ""));
      var copy = el(
        "button",
        "gt-spin__button gt-spin__button--secondary gt-spin__copy",
        "Copy code",
      );
      copy.type = "button";
      copy.addEventListener("click", function () {
        copyText(result.code || "", copy);
      });
      box.appendChild(copy);
      box.appendChild(
        el(
          "p",
          "gt-spin__note",
          "Use it on your next GreenTee order. One use, and it's yours only. Valid until " +
            expiry +
            ".",
        ),
      );
      box.appendChild(el("p", "gt-spin__note", COPY.keepSafe));
    }
    if (result.testMode) box.appendChild(el("span", "gt-spin__badge", "Test spin"));

    if (orderUrl) {
      var giftPending =
        result.rewardType === "gift" && (!result.gift || result.gift.status !== "added");
      // While a gift still needs confirming, the back link stays quiet so the
      // confirm button is the one obvious action on the card.
      var back = el(
        "a",
        giftPending
          ? "gt-spin__back gt-spin__back--quiet"
          : "gt-spin__button gt-spin__button--secondary gt-spin__back",
        cfg.backLabel,
      );
      back.setAttribute("href", orderUrl);
      box.appendChild(back);
    }

    show(box, true);
    box.setAttribute("tabindex", "-1");
    try {
      box.focus({ preventScroll: true });
      box.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    } catch (e) {
      /* ignore */
    }
  }

  function renderGift(box, result, offer, message) {
    var gift = result.gift || { status: "pending" };

    if (gift.status === "added") {
      box.appendChild(el("h2", "gt-spin__result-heading", "You won " + result.rewardLabel + "!"));
      var what = gift.variantTitle
        ? result.rewardLabel + " (" + gift.variantTitle + ")"
        : result.rewardLabel;
      box.appendChild(el("p", "gt-spin__note", "Added to your order: " + what + "."));
      box.appendChild(el("p", "gt-spin__note", COPY.giftAdded));
      return;
    }

    // Pending: the card is the confirm step. Image, name, chips (gloves), one primary button.
    if (offer && offer.imageUrl) {
      var img = document.createElement("img");
      img.className = "gt-spin__gift-image";
      img.src = offer.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      box.appendChild(img);
    }
    box.appendChild(el("h2", "gt-spin__result-heading", "You won " + result.rewardLabel + "!"));
    if (offer && offer.note) box.appendChild(el("p", "gt-spin__note", offer.note));
    if (message) box.appendChild(el("p", "gt-spin__note gt-spin__note--warn", message));

    if (!offer) {
      box.appendChild(el("p", "gt-spin__note", COPY.giftOfferMissing));
      var reloadBtn = el("button", "gt-spin__button gt-spin__gift-confirm", "Try again");
      reloadBtn.type = "button";
      reloadBtn.addEventListener("click", function () {
        if (!busy) load();
      });
      box.appendChild(reloadBtn);
      return;
    }

    if (!offer.anyAvailable) {
      if (!message)
        box.appendChild(el("p", "gt-spin__note gt-spin__note--warn", COPY.giftPendingElsewhere));
      return;
    }

    var selection = null;
    if (offer.customerOption && offer.choices) {
      var current = offer.preselect;
      var group = el("div", "gt-spin__choices");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Choose your " + offer.customerOption);
      box.appendChild(
        el("p", "gt-spin__choice-label", "Choose your " + offer.customerOption.toLowerCase()),
      );
      var chips = offer.choices.map(function (choice) {
        var chip = el("button", "gt-spin__chip", choice.value);
        chip.type = "button";
        chip.setAttribute("role", "radio");
        chip.setAttribute("data-value", choice.value);
        if (!choice.available) {
          chip.disabled = true;
          chip.setAttribute("aria-disabled", "true");
          chip.title = "Sold out";
        }
        chip.addEventListener("click", function () {
          if (chip.disabled) return;
          current = choice.value;
          chips.forEach(function (c) {
            c.setAttribute("aria-checked", c === chip ? "true" : "false");
            c.classList.toggle("gt-spin__chip--selected", c === chip);
          });
        });
        group.appendChild(chip);
        return chip;
      });
      chips.forEach(function (c) {
        var on = c.getAttribute("data-value") === current;
        c.setAttribute("aria-checked", on ? "true" : "false");
        c.classList.toggle("gt-spin__chip--selected", on);
      });
      box.appendChild(group);
      selection = function () {
        var out = {};
        out[offer.customerOption] = current;
        return current ? out : null;
      };
    }

    var errorLine = el("p", "gt-spin__note gt-spin__note--warn", "");
    errorLine.hidden = true;
    var confirm = el("button", "gt-spin__button gt-spin__gift-confirm", COPY.giftConfirm);
    confirm.type = "button";
    confirm.addEventListener("click", function () {
      confirmGift(confirm, errorLine, selection ? selection() : null);
    });
    box.appendChild(confirm);
    box.appendChild(el("p", "gt-spin__note gt-spin__note--small", COPY.giftIntro));
    box.appendChild(errorLine);
  }

  function confirmGift(button, errorLine, selection) {
    if (busy) return Promise.resolve();
    busy = true;
    button.disabled = true;
    var label = button.textContent;
    button.textContent = COPY.giftAdding;
    errorLine.hidden = true;
    var body = { token: token };
    if (selection) body.selection = selection;
    return api("/gift", { method: "POST", body: body }).then(function (r) {
      busy = false;
      if (r.status === 401 || r.status === 403) return renderInvalid();
      if (r.ok && r.body && r.body.result) {
        return renderResult(r.body.result, { offer: r.body.giftOffer, message: r.body.message });
      }
      button.disabled = false;
      button.textContent = label;
      errorLine.textContent =
        r.body && r.body.message && r.status < 500 ? r.body.message : COPY.giftFailed;
      errorLine.hidden = false;
    });
  }

  function copyText(text, button) {
    var done = function () {
      var original = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = original;
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  // ------------------------------------------------------------------ flows

  function load() {
    if (!token) {
      renderInvalid();
      return Promise.resolve();
    }
    busy = true;
    lastAction = "load";
    show(els.retry, false);
    setStatus(COPY.checking, false);
    var attempt = 0;

    function step() {
      return api("/state?token=" + encodeURIComponent(token)).then(function (r) {
        if (r.status === 401 || r.status === 403) return renderInvalid();
        if (!r.ok || !r.body) return renderError(COPY.loadFailed, "load");
        var s = r.body;
        if (s.campaignOpen === false) return renderClosed();
        if (s.pending) {
          var delay = PENDING_DELAYS[attempt++];
          if (delay === undefined) return renderError(COPY.stillPending, "load");
          setStatus(COPY.pending, false);
          return sleep(delay).then(step);
        }
        setOrderUrl(s.orderUrl);
        buildWheel(s.wheel);
        if (s.alreadySpun && s.result) {
          placeAt(s.result.sliceIndex);
          return renderResult(s.result, { offer: s.giftOffer });
        }
        if (s.eligible === false) return renderIneligible(s.message);
        if (s.eligible === true) return renderReady();
        return renderError(COPY.loadFailed, "load");
      });
    }

    return step().then(function () {
      busy = false;
    });
  }

  function spin() {
    if (busy || !wheelReady) return Promise.resolve();
    busy = true;
    lastAction = "spin";
    els.spin.disabled = true;
    show(els.retry, false);
    setStatus(COPY.spinning, false);
    // Idle spin while we wait for the server (rotationResistance is 0, so it keeps going).
    if (!reducedMotion) wheel.spin(220);

    var body = { token: token };
    if (forceSlice) body.forceSlice = forceSlice;

    return api("/execute", { method: "POST", body: body }).then(function (r) {
      if (r.status === 403 && r.body && r.body.error === "force_not_allowed") {
        // A real customer edited the URL. Drop the parameter, say so plainly,
        // and let Try again run a normal spin. The wheel is stopped, not stuck.
        wheel.stop();
        busy = false;
        forceSlice = null;
        return renderError(COPY.forceDenied, "spin");
      }
      if (r.status === 401 || r.status === 403) {
        wheel.stop();
        busy = false;
        return renderInvalid();
      }
      if (r.ok && r.body && r.body.campaignOpen === false) {
        wheel.stop();
        busy = false;
        return renderClosed();
      }
      if (!r.ok || !r.body || !r.body.result) {
        wheel.stop();
        busy = false;
        var msg = r.body && r.body.message && r.status === 409 ? r.body.message : COPY.spinFailed;
        if (r.status === 409) return renderIneligible(msg);
        return renderError(msg, "spin");
      }
      var result = r.body.result;
      var offer = r.body.giftOffer || null;
      landOn(result.sliceIndex, function () {
        busy = false;
        renderResult(result, { offer: offer });
      });
    });
  }

  els.spin.addEventListener("click", function () {
    spin();
  });
  els.retry.addEventListener("click", function () {
    if (busy) return;
    if (lastAction === "spin" && wheelReady) spin();
    else load();
  });

  // Coming back via bfcache: re-check state so a completed spin is shown, not the button.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted && !busy) load();
  });

  load();
})();
