/* opium: Roblox web client - join any experience.
 * Loaded by main.js's EXTENSIONS entry for play.roblox.com / www.roblox.com.
 * Spoofs the desktop join identity, synthesises the qdmux endpoint the wasm engine needs, hooks the
 * engine's worker, and turns the Play button into a hop to play.roblox.com.
 * No scramjet/jet/transport patching - extension mechanism only.
 */
(function RBX_WEBJOIN() {
  var W = self;
  if (W.__rbxWebJoin) return;
  W.__rbxWebJoin = true;

  // Under jet this page's own location is the proxy (opium.best), and a proxied URL is opaque
  // (`/.~/<encoded>`). The *real* address is what the portal's address bar shows, and the frame is
  // same-origin with it, so read it from there.
  function realUrl() {
    try {
      var p = (typeof parent !== 'undefined') ? parent : null;
      var bar = p && p.document && p.document.getElementById('addrInput');
      if (bar && bar.value) return bar.value;
    } catch (e) {}
    return (W.location && W.location.href) || '';
  }

  // Decode a jet path back to the real URL using the portal's own codec.
  function decodeProxy(raw) {
    try {
      var u = new URL(raw, (W.location && W.location.href) || undefined);
      var i = u.pathname.indexOf('/~/');
      if (i < 0) return raw;
      var codec = (typeof parent !== 'undefined' && parent.controller && parent.controller.config &&
                   parent.controller.config.codec);
      return codec ? codec.decode(u.pathname.slice(i + 3)) : raw;
    } catch (e) { return raw; }
  }
  W.__rbxWebJoinDecode = decodeProxy;

  var SPOOF = 'Roblox/WinInet';
  var JOIN_BODY = 'gameJoinAttemptId';

  function hex2(n) { return Number(n).toString(16).padStart(2, '0').slice(-2); }

  function b64ToHex(b64) {
    var s = atob(b64), out = '';
    for (var i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(2, '0');
    return out;
  }

  // desktop join script -> web join script (see the reverse-engineering notes)
  function rewrite(j) {
    var js = j && j.joinScript;
    if (!js || !js.NetStackTokenValue || js.gameFqdn) return j;
    if (String(js.NetStackTokenValue).indexOf('==') === -1) return j;   // already hex
    try {
      var tok = b64ToHex(js.NetStackTokenValue);
      var mach = String(js.MachineAddress).split('.').map(hex2).join('');
      var port = Number(js.NetStackPort).toString(16).padStart(4, '0');
      var eps = js.UdmuxEndpoints || [];
      if (!eps.length) return j;
      var oct = String(eps[0].Address).split('.').map(Number);
      oct[3] = oct[3] + 1;                                    // the QUIC front is udmux + 1
      var front = oct.map(hex2).join('');
      js.NetStackTokenValue = tok;
      js.gameFqdn = tok + '-' + mach + '-' + port + '.' + front + '.qdmux.roblox.com';
      eps[0].Address = oct.join('.');
      console.log('[webjoin] rewritten -> ' + js.gameFqdn + ':' + js.NetStackPort);
    } catch (e) { console.warn('[webjoin] rewrite failed', e); }
    return j;
  }
  W.__rbxWebJoinRewrite = rewrite;                            // exposed for testing

  function bodyHasJoin(b) {
    if (!b) return false;
    if (typeof b === 'string') return b.indexOf(JOIN_BODY) > -1;
    try { return String(b).indexOf(JOIN_BODY) > -1; } catch (e) { return false; }
  }

  // ---- XHR (emscripten_fetch uses this, from the worker) ----
  var XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
  if (XP && !XP.__rbxWj) {
    var oSend = XP.send, oSet = XP.setRequestHeader, oOpen = XP.open;
    XP.open = function (m, u) { try { this.__wjUrl = String(u); } catch (e) {} return oOpen.apply(this, arguments); };
    XP.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'rbx-user-agent') v = SPOOF; } catch (e) {}
      return oSet.call(this, k, v);
    };
    XP.send = function (body) {
      var xhr = this, isJoin = bodyHasJoin(body) || (this.__wjUrl && this.__wjUrl.indexOf('join-game') > -1);
      if (isJoin) {
        try { oSet.call(this, 'rbx-user-agent', SPOOF); } catch (e) {}
        console.log('[webjoin] join XHR seen');
        this.addEventListener('readystatechange', function () {
          if (xhr.readyState !== 4 || xhr.status !== 200) return;
          try {
            var buf = xhr.response;
            var text = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
            var j = rewrite(JSON.parse(text));
            var out = new TextEncoder().encode(JSON.stringify(j));
            Object.defineProperty(xhr, 'response', { configurable: true, get: function () { return out.buffer; } });
            Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return JSON.stringify(j); } });
          } catch (e) { console.warn('[webjoin] xhr patch failed', e); }
        }, false);
      }
      return oSend.apply(this, arguments);
    };
    XP.__rbxWj = true;
  }

  // ---- fetch (GameJoinV2 path) ----
  var oFetch = W.fetch;
  if (oFetch && !oFetch.__rbxWj) {
    var patchFetch = function (input, init) {
      var isJoin = bodyHasJoin(init && init.body) || (function () {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        return u.indexOf('join-game') > -1;
      })();
      if (!isJoin) return oFetch.apply(this, arguments);
      var req;
      try { req = new Request(input, init); } catch (e) { return oFetch.apply(this, arguments); }
      var h = new Headers(req.headers);
      h.set('rbx-user-agent', SPOOF);
      return oFetch.call(this, new Request(req, { headers: h })).then(function (res) {
        return res.clone().json().then(function (j) {
          rewrite(j);
          return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
        }).catch(function () { return res; });
      });
    };
    patchFetch.__rbxWj = true;
    W.fetch = patchFetch;
  }

  // ---- the engine's worker: hook it before the wasm glue boots ----
  if (W.Worker && !W.Worker.__rbxWj) {
    var OW = W.Worker;
    var Patched = function (url, opts) {
      try {
        var raw = typeof url === 'string' ? url : (url && url.href) || '';
        var direct = new URL(raw, (W.location && W.location.href) || undefined);
        var engine = direct.searchParams.get('src');
        var real = decodeProxy(raw);
        if (!engine) {
          // jet hides the query inside the encoded path; look at the decoded form too
          var m = /[?&]src=([^&]+)/.exec(real);
          if (m) { try { engine = decodeURIComponent(m[1]); } catch (e) { engine = m[1]; } }
        }
        var looksEngine = !!engine || /stub\.js|webclient/i.test(real);
        if (looksEngine) {
          var src = '(' + RBX_WEBJOIN.toString() + ')();';
          // If we know the engine script, boot it directly; otherwise re-import the stub itself so
          // the hooks at least live inside the worker.
          var importUrl = engine || raw;
          var blob = new Blob([src + '\nimportScripts(' + JSON.stringify(importUrl) + ');'],
            { type: 'text/javascript' });
          console.log('[webjoin] wrapping worker -> ' + String(importUrl).slice(0, 90));
          return new OW(URL.createObjectURL(blob), opts);
        }
      } catch (e) { console.warn('[webjoin] worker wrap failed', e); }
      return new OW(url, opts);
    };
    Patched.prototype = OW.prototype;
    try { Object.setPrototypeOf(Patched, OW); } catch (e) {}
    Patched.__rbxWj = true;
    W.Worker = Patched;
  }

  // ---- Play button: game page -> play.roblox.com ----
  // No hostname gate: inside the proxy the hostname is the portal's, so the page identity comes
  // from the real (decoded) address instead.
  if (!W.__rbxWjPlay) {
    W.__rbxWjPlay = true;
    var toPlay = function () {
      var m = /[/]games[/](\d+)/.exec(realUrl());
      if (!m) return false;
      var target = 'https://play.roblox.com/games/start?placeId=' + m[1];
      // Assigning location.href inside a jet frame is silently ignored (the client owns location),
      // so hop through the portal's own navigate(), which encodes the URL and drives the frame.
      try {
        if (typeof parent !== 'undefined' && typeof parent.navigate === 'function') {
          parent.navigate(target);
          console.log('[webjoin] -> ' + target);
          return true;
        }
      } catch (e) {}
      try { W.location.href = target; return true; } catch (e) {}
      return false;
    };
    W.document.addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== W.document.body) {
        var t = (el.textContent || '').trim().toLowerCase();
        if (t === 'play' || (el.id && /play/i.test(el.id)) ||
            (el.getAttribute && /play/i.test(el.getAttribute('data-testid') || ''))) {
          if (toPlay()) { ev.preventDefault(); ev.stopPropagation(); }
          return;
        }
        el = el.parentElement;
      }
    }, true);
  }

  console.log('[webjoin] installed in ' + (typeof importScripts === 'function' ? 'worker' : 'page'));
})();
