// NOT AGAIN: SPIKEY — browser platform layer (DECISIONS §61).
//
// The Godot game talks to this file through JavaScriptBridge. Everything is exposed as
// window.NAG. The game never waits on a promise: it starts an operation with
// NAG.call(name, argsArray) → an op id, then polls NAG.poll(id) until it is done.
//
//   Ads       H5 Games Ads (adBreak / adConfig from AdSense). No client id = no ads.
//   Accounts  Supabase Auth over plain fetch: e-mail 6-digit code (or the magic link in
//             the same e-mail). No passwords, no SDK, no extra download.
//   Saves     one JSON row per player in the "saves" table (row-level security).
//   Payments  Stripe Checkout, created by the "create-checkout" Supabase function;
//             the "stripe-webhook" function records paid orders; the game collects
//             them once with the claim_purchases() database function.
//   Phones    full screen + landscape lock on the first tap, rotate-your-phone card,
//             "Add to Home Screen" hint on iPhone (Safari has no full-screen API).
(function () {
  "use strict";
  var cfg = window.NAG_CONFIG || {};
  var SESSION_KEY = "nag_session_v1";
  var ops = {};
  var nextOp = 1;
  var session = null;
  var checkoutResult = "";
  var lastMessage = "";
  var adsState = "none"; // none | loading | ready | blocked
  var adPlaying = false;
  var modalOpen = false;
  var modalReason = "";
  var magicLinkError = "";

  function supaOn() { return !!(cfg.supabaseUrl && cfg.supabaseAnonKey); }
  function payOn() { return supaOn() && !!cfg.paymentsEnabled; }
  function base() { return String(cfg.supabaseUrl || "").replace(/\/+$/, ""); }
  function now() { return Math.floor(Date.now() / 1000); }

  // ---------------------------------------------------------------- ops
  function newOp() {
    var id = nextOp++;
    ops[id] = { status: "pending" };
    return id;
  }
  function done(id, result) { if (ops[id]) { ops[id].status = "done"; ops[id].result = result; } }
  function fail(id, msg) { if (ops[id]) { ops[id].status = "error"; ops[id].error = String(msg || "error"); } }
  function run(promiseFn) {
    var id = newOp();
    Promise.resolve().then(promiseFn).then(function (r) { done(id, r === undefined ? null : r); },
      function (e) { fail(id, e && e.message ? e.message : e); });
    return id;
  }

  // ---------------------------------------------------------------- session
  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { session = null; }
    if (session && !(session.access_token && session.refresh_token && session.user)) session = null;
  }
  function storeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private mode: session lasts this tab only */ }
  }
  function sessionFrom(body) {
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at || (now() + (body.expires_in || 3600)),
      user: { id: body.user && body.user.id, email: body.user && body.user.email }
    };
  }

  function http(method, path, body, auth, extraHeaders) {
    var h = { "apikey": cfg.supabaseAnonKey, "Content-Type": "application/json" };
    if (auth && session) h["Authorization"] = "Bearer " + session.access_token;
    else h["Authorization"] = "Bearer " + cfg.supabaseAnonKey;
    if (extraHeaders) for (var k in extraHeaders) h[k] = extraHeaders[k];
    return fetch(base() + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
          if (!res.ok) {
            var msg = (data && (data.msg || data.message || data.error_description || data.error)) || ("HTTP " + res.status);
            var err = new Error(String(msg));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  function freshSession() {
    if (!session) return Promise.reject(new Error("not signed in"));
    if (session.expires_at - 60 > now()) return Promise.resolve(session);
    return http("POST", "/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token }, false)
      .then(function (b) { storeSession(sessionFrom(b)); return session; },
        function (e) {
          if (e.status === 400 || e.status === 401) storeSession(null); // refresh token revoked / expired
          throw e;
        });
  }
  function authed(method, path, body, headers) {
    return freshSession().then(function () { return http(method, path, body, true, headers); });
  }

  // Magic-link return: #access_token=...&refresh_token=...  (also error=... on expiry).
  function readMagicLink() {
    if (!location.hash || location.hash.length < 2) return Promise.resolve();
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.get("error_description")) {
      magicLinkError = p.get("error_description");
      history.replaceState(null, "", location.pathname + location.search);
      return Promise.resolve();
    }
    if (!p.get("access_token") || !p.get("refresh_token")) return Promise.resolve();
    history.replaceState(null, "", location.pathname + location.search);
    var tmp = { access_token: p.get("access_token"), refresh_token: p.get("refresh_token"),
      expires_at: Number(p.get("expires_at")) || now() + Number(p.get("expires_in") || 3600), user: { id: "", email: "" } };
    session = tmp;
    return http("GET", "/auth/v1/user", undefined, true).then(function (u) {
      tmp.user = { id: u.id, email: u.email };
      storeSession(tmp);
      lastMessage = "Signed in as " + u.email;
    }, function () { storeSession(null); });
  }

  function readCheckoutReturn() {
    var q = new URLSearchParams(location.search);
    var r = q.get("nag_checkout");
    if (!r) return;
    checkoutResult = r === "success" ? "success" : "cancel";
    q.delete("nag_checkout");
    var rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  }

  // ---------------------------------------------------------------- auth API
  function sendCode(email) {
    var redirect = encodeURIComponent(location.origin + location.pathname);
    return http("POST", "/auth/v1/otp?redirect_to=" + redirect, { email: email, create_user: true }, false);
  }
  function verifyCode(email, code) {
    // "email" is the current type; older projects issue "magiclink" codes for existing users.
    return http("POST", "/auth/v1/verify", { type: "email", email: email, token: code }, false)
      .catch(function (e) {
        return http("POST", "/auth/v1/verify", { type: "magiclink", email: email, token: code }, false).catch(function () { throw e; });
      })
      .then(function (b) { storeSession(sessionFrom(b)); return session.user; });
  }
  function signOut() {
    var s = session;
    storeSession(null);
    if (!s) return Promise.resolve();
    return fetch(base() + "/auth/v1/logout", { method: "POST",
      headers: { "apikey": cfg.supabaseAnonKey, "Authorization": "Bearer " + s.access_token } }).catch(function () {});
  }

  // ---------------------------------------------------------------- saves
  function fetchSave() {
    return authed("GET", "/rest/v1/saves?select=data,updated_at&user_id=eq." + encodeURIComponent(session.user.id))
      .then(function (rows) { return rows && rows.length ? { data: rows[0].data, updated_at: rows[0].updated_at } : { data: null }; });
  }
  function pushSave(json) {
    var obj = typeof json === "string" ? JSON.parse(json) : json;
    return authed("POST", "/rest/v1/saves?on_conflict=user_id",
      { user_id: session.user.id, data: obj, updated_at: new Date().toISOString() },
      { "Prefer": "resolution=merge-duplicates,return=minimal" }).then(function () { return { ok: true }; });
  }

  // ---------------------------------------------------------------- purchases
  function claimPurchases() {
    return authed("POST", "/rest/v1/rpc/claim_purchases", {}).then(function (rows) { return rows || []; });
  }
  function listPurchases() {
    return authed("GET", "/rest/v1/purchases?select=product_id,created_at&order=created_at.asc").then(function (rows) { return rows || []; });
  }
  function startCheckout(productId) {
    if (!payOn()) return Promise.reject(new Error("payments are off"));
    var ret = location.origin + location.pathname;
    return freshSession().then(function () {
      return fetch(base() + "/functions/v1/create-checkout", {
        method: "POST",
        headers: { "apikey": cfg.supabaseAnonKey, "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, return_url: ret })
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || !b.url) throw new Error(b.error || ("checkout failed (" + res.status + ")"));
        // Give the game a moment to finish writing its save, then leave for Stripe.
        setTimeout(function () { NAG._navigate(b.url); }, 700);
        return { url: b.url };
      });
    });
  }
  function deleteAccount() {
    return authed("POST", "/rest/v1/rpc/delete_my_account", {}).then(function () { storeSession(null); return { ok: true }; });
  }

  // ---------------------------------------------------------------- ads
  function loadAds() {
    if (!cfg.adsenseClient) return;
    adsState = "loading";
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute("data-ad-client", cfg.adsenseClient);
    if (cfg.adsTestMode !== false) s.setAttribute("data-adbreak-test", "on");
    s.setAttribute("data-ad-frequency-hint", "120s");
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(cfg.adsenseClient);
    s.onerror = function () { adsState = "blocked"; };
    document.head.appendChild(s);
    window.adConfig({ preloadAdBreaks: "on", sound: "on", onReady: function () { if (adsState !== "blocked") adsState = "ready"; } });
  }
  function adBreakOp(type, name) {
    var id = newOp();
    if (!cfg.adsenseClient) { done(id, "noprovider"); return id; }
    if (adsState === "blocked" || typeof window.adBreak !== "function") { done(id, "unavailable"); return id; }
    var viewed = false, started = false, finished = false;
    function finish(r) { if (finished) return; finished = true; adPlaying = false; done(id, r); }
    // Ad blockers leave adBreak queued forever: give up if nothing starts soon.
    setTimeout(function () { if (!started) finish("unavailable"); }, 8000);
    setTimeout(function () { finish(viewed ? "viewed" : "unavailable"); }, 150000);
    var o = {
      type: type,
      name: name,
      beforeAd: function () { started = true; adPlaying = true; ops[id] && (ops[id].playing = true); },
      afterAd: function () { adPlaying = false; ops[id] && (ops[id].playing = false); },
      adBreakDone: function (info) {
        started = true;
        var st = info && info.breakStatus;
        if (type === "reward") finish(viewed ? "viewed" : (st === "dismissed" ? "dismissed" : "unavailable"));
        else finish(st === "viewed" ? "viewed" : "skipped");
      }
    };
    if (type === "reward") {
      // The player already pressed "watch an ad", so show it straight away.
      o.beforeReward = function (showAdFn) { started = true; showAdFn(); };
      o.adDismissed = function () {};
      o.adViewed = function () { viewed = true; };
    }
    try { window.adBreak(o); } catch (e) { finish("unavailable"); }
    return id;
  }

  // ---------------------------------------------------------------- account box (HTML over the game)
  var CSS = "" +
    "#nag-acct{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(14,11,10,.78);font:16px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#f7eed9;padding:12px;box-sizing:border-box}" +
    "#nag-acct .box{background:#2c2624;border:4px solid #0e0b0a;border-radius:14px;box-shadow:0 8px 0 #0e0b0a;max-width:420px;width:100%;padding:22px 22px 18px;box-sizing:border-box;max-height:100%;overflow:auto}" +
    "#nag-acct h2{margin:0 0 6px;font-size:24px;letter-spacing:.5px}" +
    "#nag-acct p{margin:6px 0 12px;color:#d9ccb6}" +
    "#nag-acct .why{color:#fab836;font-weight:600}" +
    "#nag-acct input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border-radius:8px;border:3px solid #0e0b0a;background:#f7eed9;color:#211d1c;margin:4px 0 10px}" +
    "#nag-acct input.code{letter-spacing:8px;text-align:center;font-size:26px;font-weight:700}" +
    "#nag-acct button{font:700 18px system-ui,sans-serif;padding:12px 16px;border-radius:10px;border:3px solid #0e0b0a;background:#f7eed9;color:#211d1c;cursor:pointer;margin:4px 6px 4px 0}" +
    "#nag-acct button.go{background:#fab836}" +
    "#nag-acct button.danger{background:#d9534a;color:#fff}" +
    "#nag-acct button.link{background:none;border:none;color:#c2b5a0;text-decoration:underline;padding:8px 0;font-weight:500;font-size:15px}" +
    "#nag-acct .err{color:#ff8f86;min-height:20px;font-weight:600}" +
    "#nag-acct .ok{color:#9be28f;font-weight:600}" +
    "#nag-acct small{display:block;color:#a99c88;margin-top:10px;font-size:13px}";

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }
  var pendingEmail = "";

  function openAccount(reason) {
    if (!supaOn()) return false;
    modalReason = reason || "";
    if (!document.getElementById("nag-acct-css")) {
      var st = el("style", { id: "nag-acct-css" });
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    closeAccount();
    var wrap = el("div", { id: "nag-acct", role: "dialog", "aria-modal": "true" });
    // Typing in the box must not reach the game (space = jump, Esc = pause...).
    ["keydown", "keyup", "keypress", "pointerdown", "touchstart", "mousedown", "wheel"].forEach(function (t) {
      wrap.addEventListener(t, function (ev) { ev.stopPropagation(); }, false);
    });
    wrap.addEventListener("click", function (ev) { if (ev.target === wrap) closeAccount(); });
    var box = el("div", { "class": "box" });
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    modalOpen = true;
    if (session) renderSignedIn(box); else if (pendingEmail) renderCode(box); else renderEmail(box);
    return true;
  }
  function closeAccount() {
    var w = document.getElementById("nag-acct");
    if (w) w.remove();
    modalOpen = false;
    var c = document.getElementById("canvas") || document.querySelector("canvas");
    if (c && c.focus) try { c.focus(); } catch (e) {}
  }
  function reasonLine(box) {
    var map = {
      buy: "Sign in to buy. Purchases are kept on your account, on every device.",
      backup: "Sign in to back up your progress and carry it to any phone or computer.",
      restore: "Sign in to get back what you bought."
    };
    if (map[modalReason]) box.appendChild(el("p", { "class": "why" }, map[modalReason]));
  }
  function renderEmail(box) {
    box.innerHTML = "";
    box.appendChild(el("h2", null, "Sign in"));
    reasonLine(box);
    box.appendChild(el("p", null, "No password. We e-mail you a 6-digit code. Your guest progress is kept."));
    var inp = el("input", { type: "email", autocomplete: "email", inputmode: "email", placeholder: "you@example.com", id: "nag-email" });
    box.appendChild(inp);
    var err = el("div", { "class": "err" }, magicLinkError ? "That sign-in link expired. Ask for a new code." : "");
    magicLinkError = "";
    var send = el("button", { "class": "go", id: "nag-send" }, "SEND CODE");
    var cancel = el("button", { id: "nag-cancel" }, "NOT NOW");
    box.appendChild(send); box.appendChild(cancel); box.appendChild(err);
    box.appendChild(el("small", null, "Accounts are run by " + (cfg.studioName || "the developer") + " on Supabase. We store your e-mail, your save and your purchases. See PRIVACY in the game."));
    cancel.onclick = closeAccount;
    function go() {
      var email = inp.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "That does not look like an e-mail address."; return; }
      send.disabled = true; send.textContent = "SENDING…"; err.textContent = "";
      sendCode(email).then(function () { pendingEmail = email; renderCode(box); },
        function (e) { send.disabled = false; send.textContent = "SEND CODE"; err.textContent = friendly(e); });
    }
    send.onclick = go;
    inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") go(); });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
  }
  function renderCode(box) {
    box.innerHTML = "";
    box.appendChild(el("h2", null, "Check your e-mail"));
    box.appendChild(el("p", null, "We sent a code to " + pendingEmail + ". Type it here, or tap the link in the e-mail on this device."));
    var inp = el("input", { "class": "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "10", placeholder: "000000", id: "nag-code" });
    box.appendChild(inp);
    var err = el("div", { "class": "err" });
    var ok = el("button", { "class": "go", id: "nag-verify" }, "SIGN IN");
    var back = el("button", { "class": "link", id: "nag-other" }, "Use a different e-mail");
    box.appendChild(ok); box.appendChild(err); box.appendChild(back);
    back.onclick = function () { pendingEmail = ""; renderEmail(box); };
    function go() {
      var code = inp.value.replace(/\D/g, "");
      if (code.length < 6) { err.textContent = "The code has 6 digits."; return; }
      ok.disabled = true; ok.textContent = "CHECKING…"; err.textContent = "";
      verifyCode(pendingEmail, code).then(function (u) {
        pendingEmail = "";
        lastMessage = "Signed in as " + u.email;
        closeAccount();
      }, function (e) { ok.disabled = false; ok.textContent = "SIGN IN"; err.textContent = friendly(e, true); });
    }
    ok.onclick = go;
    inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") go(); });
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
  }
  function renderSignedIn(box) {
    box.innerHTML = "";
    box.appendChild(el("h2", null, "Your account"));
    box.appendChild(el("p", { "class": "ok" }, "Signed in as " + session.user.email));
    box.appendChild(el("p", null, "Your progress backs up automatically. Sign in with the same e-mail on any device to carry on."));
    var close = el("button", { "class": "go", id: "nag-close" }, "CLOSE");
    var out = el("button", { id: "nag-signout" }, "SIGN OUT");
    var del = el("button", { "class": "link", id: "nag-delete" }, "Delete my account");
    var err = el("div", { "class": "err" });
    box.appendChild(close); box.appendChild(out); box.appendChild(err); box.appendChild(del);
    close.onclick = closeAccount;
    out.onclick = function () { signOut().then(function () { lastMessage = "Signed out. Progress on this device is kept."; closeAccount(); }); };
    del.onclick = function () {
      box.innerHTML = "";
      box.appendChild(el("h2", null, "Delete account?"));
      box.appendChild(el("p", null, "This deletes your e-mail, your online save and your purchase records from our server, for good. Progress on this device stays. Bought items cannot be restored after this."));
      var yes = el("button", { "class": "danger", id: "nag-delete-yes" }, "DELETE FOREVER");
      var no = el("button", { "class": "go" }, "KEEP IT");
      var e2 = el("div", { "class": "err" });
      box.appendChild(no); box.appendChild(yes); box.appendChild(e2);
      no.onclick = function () { renderSignedIn(box); };
      yes.onclick = function () {
        yes.disabled = true;
        deleteAccount().then(function () { lastMessage = "Account deleted."; closeAccount(); },
          function (e) { yes.disabled = false; e2.textContent = friendly(e); });
      };
    };
  }
  function friendly(e, isCode) {
    var m = String(e && e.message || e || "");
    if (/fetch|network|Failed/i.test(m)) return "No connection. Check your internet and try again.";
    if (e && e.status === 429 || /rate|seconds/i.test(m)) return "Too many tries. Wait a minute, then try again.";
    if (isCode && (e && (e.status === 400 || e.status === 401 || e.status === 403) || /expired|invalid/i.test(m))) return "Wrong or expired code. Check the newest e-mail.";
    return m || "Something went wrong.";
  }

  // ---------------------------------------------------------------- phones
  var touch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches) || navigator.standalone === true;
  function canFullscreen() { var d = document.documentElement; return !!(d.requestFullscreen || d.webkitRequestFullscreen); }
  function goFull() {
    if (modalOpen || standalone) return;
    var d = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      var p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: "hide" }) : (d.webkitRequestFullscreen && d.webkitRequestFullscreen());
      if (p && p.then) p.then(function () {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }
  function addRotateCard() {
    if (document.getElementById("na-rotate")) return;
    var d = el("div", { id: "na-rotate" });
    var tip = isIOS && !standalone
      ? "Tip: tap Share → Add to Home Screen to play full screen."
      : "Tap after turning to go full screen.";
    d.innerHTML = '<div class="phone"></div>Turn your phone sideways<small>NOT AGAIN: SPIKEY plays in landscape. ' + tip + "</small>";
    document.body.appendChild(d);
  }
  if (touch) window.addEventListener("pointerdown", function () { goFull(); }, { passive: true });

  // ---------------------------------------------------------------- public API
  var api = {
    version: 1,
    // Everything the game needs in one cheap JSON string.
    state: function () {
      var s = {
        ads: cfg.adsenseClient ? (adsState === "blocked" ? "blocked" : "adsense") : "none",
        adPlaying: adPlaying,
        accounts: supaOn(),
        payments: payOn(),
        signedIn: !!session,
        email: session ? session.user.email : "",
        userId: session ? session.user.id : "",
        modal: modalOpen,
        checkout: checkoutResult,
        message: lastMessage,
        touch: touch,
        iOS: isIOS,
        standalone: standalone,
        canFullscreen: canFullscreen()
      };
      return JSON.stringify(s);
    },
    ackMessage: function () { lastMessage = ""; },
    ackCheckout: function () { checkoutResult = ""; },
    poll: function (id) {
      var o = ops[id];
      if (!o) return JSON.stringify({ status: "unknown" });
      var out = JSON.stringify(o);
      if (o.status !== "pending") delete ops[id];
      return out;
    },
    // Dispatcher used by the game: NAG.call("fetchSave", []) → op id.
    call: function (name, args) {
      args = args || [];
      switch (name) {
        case "showRewarded": return adBreakOp("reward", String(args[0] || "reward"));
        case "showInterstitial": return adBreakOp("next", String(args[0] || "level_clear"));
        case "fetchSave": return run(fetchSave);
        case "pushSave": return run(function () { return pushSave(args[0]); });
        case "claimPurchases": return run(claimPurchases);
        case "listPurchases": return run(listPurchases);
        case "checkout": return run(function () { return startCheckout(String(args[0])); });
        case "signOut": return run(signOut);
        default: var id = newOp(); fail(id, "unknown call " + name); return id;
      }
    },
    openAccount: function (reason) { return openAccount(reason); },
    closeAccount: closeAccount,
    fullscreen: goFull,
    _navigate: function (url) { location.href = url; },
    _config: cfg
  };
  window.NAG = api;

  // ---------------------------------------------------------------- boot
  loadSession();
  readCheckoutReturn();
  if (supaOn()) readMagicLink();
  loadAds();
  if (document.body) addRotateCard(); else document.addEventListener("DOMContentLoaded", addRotateCard);
})();
