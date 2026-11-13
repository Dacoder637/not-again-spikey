// NOT AGAIN: SPIKEY — static asset cache (round 17, DECISIONS §72).
//
// Why: on a tablet the page used to spend seconds fetching the platform scripts, fonts
// and icons on every visit, on top of the .pck. This worker keeps those in the browser's
// cache so a second visit opens instantly and a flaky connection cannot leave the game
// half-loaded.
//
// What it deliberately does NOT do: cache index.html, index.js, index.wasm or index.pck
// from the cache first. Those are the build. A stale .pck against a new index.js is a
// black screen, so they are always fetched from the network (and refreshed in the cache
// for when the network is gone entirely).
//
// Registered by nag_platform.js. Bump CACHE_NAME when the platform files change.
var CACHE_NAME = "nag-static-v1";
var STATIC = [
  "nag_config.js",
  "nag_platform.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
  "privacy.html",
  "terms.html"
];
var BUILD = ["index.html", "index.js", "index.wasm", "index.pck"];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE_NAME).then(function (c) {
      // addAll fails the whole install if one file is missing; add them one by one.
      return Promise.all(STATIC.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE_NAME ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // ads, Supabase, Flutterwave
  var name = url.pathname.split("/").pop() || "";

  // The build itself: network first, cache only as an offline fallback.
  if (BUILD.indexOf(name) >= 0) {
    ev.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        });
      })
    );
    return;
  }

  // Platform files and icons: cache first, refresh in the background.
  if (STATIC.indexOf(name) >= 0) {
    ev.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) {
          fetch(req).then(function (res) {
            if (res && res.ok) {
              var copy = res.clone();
              caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
            }
          }).catch(function () {});
          return hit;
        }
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
});
