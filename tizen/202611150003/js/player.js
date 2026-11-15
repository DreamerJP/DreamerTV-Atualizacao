'use strict';

/*
 * Samsung player (AVPlay). There is one video plane: the live preview and the full screen share the
 * same playback and only change its rectangle, so opening the full screen never restarts a channel.
 * Live channels always use it; movies and episodes use it when the reserve player cannot.
 */
App.avplayer = (function () {
  var av = null;
  try { av = webapis.avplay; } catch (e) {}
  var current = null;
  var generation = 0;
  var retries = 0;
  var MAX_RETRIES = 5;
  var retryTimer = null;
  var rect = [0, 0, 1920, 1080];
  var aspect = 'FIT';
  var handlers = {};
  var lastTime = 0;
  // AVPlay may wait forever without reporting an error; these limits turn a silent stall into a retry
  // with a renewed address, like the read timeout of the Android player.
  var watch = { openedAt: 0, prepared: false, bufferingSince: 0, progressAt: 0, position: -1 };
  var PREPARE_LIMIT_MS = 25000, LIVE_STALL_MS = 15000, VOD_STALL_MS = 25000, LIVE_FROZEN_MS = 12000;
  var fatal = ['PLAYER_ERROR_NOT_SUPPORTED_FILE', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT', 'PLAYER_ERROR_INVALID_URI', 'PLAYER_ERROR_INVALID_PARAMETER'];

  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (handlers[name]) { try { handlers[name].apply(null, args); } catch (e) {} }
  }

  function safe(action) { try { return action(); } catch (e) { return undefined; } }

  function applyAspect() {
    if (!av) return;
    var modes = {
      FIT: ['PLAYER_DISPLAY_MODE_LETTER_BOX'],
      ZOOM: ['PLAYER_DISPLAY_MODE_CROPPED_FULL', 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO'],
      FILL: ['PLAYER_DISPLAY_MODE_FULL_SCREEN'],
    }[aspect];
    for (var i = 0; i < modes.length; i++) {
      try { av.setDisplayMethod(modes[i]); return; } catch (e) {}
    }
  }

  function close() {
    clearTimeout(retryTimer);
    if (!av) return;
    safe(function () { av.stop(); });
    safe(function () { av.close(); });
  }

  function errorMessage(type) {
    if (/NOT_SUPPORTED|CODEC|DECODER/.test(type)) return 'Este formato não pôde ser reproduzido neste aparelho.';
    if (/INVALID_URI|INVALID_PARAMETER/.test(type)) return 'Este conteúdo não está disponível no servidor.';
    if (/CONNECTION|NETWORK|TIMEOUT|BUFFER/.test(type)) return 'Não foi possível reconectar. Verifique a conexão e tente novamente.';
    return 'Não foi possível reproduzir este conteúdo. Tente outro canal ou vídeo.';
  }

  function open(item, startMs) {
    var mine = ++generation;
    close();
    current = item;
    lastTime = startMs || 0;
    watch = { openedAt: Date.now(), prepared: false, bufferingSince: 0, progressAt: Date.now(), position: -1 };
    if (!av) {
      call('error', 'O player da Samsung não está disponível neste aparelho.');
      return;
    }
    var profile = App.bufferProfiles[App.prefs.settings.bufferProfile] || App.bufferProfiles.ULTRA_STABLE;
    try {
      av.open(item.url);
      av.setListener({
        onbufferingstart: function () { if (mine === generation) { watch.bufferingSince = watch.bufferingSince || Date.now(); call('buffering', null); } },
        onbufferingprogress: function (pct) { if (mine === generation) call('buffering', pct); },
        onbufferingcomplete: function () { if (mine === generation) { watch.bufferingSince = 0; call('ready'); } },
        oncurrentplaytime: function (ms) { if (mine === generation) { lastTime = ms; call('time', ms); } },
        onstreamcompleted: function () { if (mine === generation) call('ended'); },
        onsubtitlechange: function (duration, text) { if (mine === generation) call('subtitle', text, duration); },
        onevent: function () {},
        onerror: function (type) { if (mine === generation) failed(String(type)); },
      });
      av.setDisplayRect(rect[0], rect[1], rect[2], rect[3]);
      applyAspect();
      safe(function () { av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', profile.startS); });
      safe(function () { av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', item.live ? profile.resumeS : profile.resumeS + 2); });
    } catch (e) {
      failed(e && e.name ? e.name : 'PLAYER_ERROR_INVALID_URI');
      return;
    }
    call('buffering', null);
    av.prepareAsync(function () {
      if (mine !== generation) return;
      retries = 0;
      watch.prepared = true;
      watch.progressAt = Date.now();
      var start = function () {
        if (mine !== generation) return;
        if (item.playWhenReady === false) safe(function () { av.pause(); });
        else safe(function () { av.play(); });
        call('ready');
      };
      if (!item.live && startMs > 0) av.seekTo(startMs, start, start);
      else start();
    }, function (e) {
      if (mine === generation) failed(e && e.name ? e.name : 'PLAYER_ERROR_CONNECTION_FAILED');
    });
  }

  /** The player does not report HTTP answers; a missing or refused file must not be retried. */
  function probe(url) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      var done = false;
      function finish(status) { if (done) return; done = true; try { xhr.abort(); } catch (e) {} resolve(status); }
      try {
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Range', 'bytes=0-1');
        xhr.timeout = 10000;
        xhr.onreadystatechange = function () { if (xhr.readyState >= 2) finish(xhr.status); };
        xhr.onerror = function () { finish(0); };
        xhr.ontimeout = function () { finish(0); };
        xhr.send();
      } catch (e) { finish(0); }
    });
  }

  function failed(type) {
    var transient = fatal.indexOf(type) < 0;
    if (transient && current && !current.live && retries === 0) {
      var mine = generation;
      var item = current;
      probe(item.url).then(function (status) {
        if (mine !== generation) return;
        if (status === 404 || status === 410) { close(); call('error', 'Este conteúdo não está disponível no servidor.'); return; }
        if (status === 401 || status === 403) { close(); call('error', 'Acesso não autorizado pelo servidor. Verifique sua conta.'); return; }
        retryLater(type);
      });
      return;
    }
    retryLater(type);
  }

  function retryLater(type) {
    var transient = fatal.indexOf(type) < 0;
    if (transient && retries < MAX_RETRIES && current) {
      retries++;
      call('retry', retries, MAX_RETRIES);
      var item = Object.assign({}, current, { url: App.prefs.refreshUrl(current.url) });
      var resumeAt = item.live ? 0 : lastTime;
      var mine = generation;
      retryTimer = setTimeout(function () { if (mine === generation) open(item, resumeAt); }, Math.min(retries * 1200, 5000));
      return;
    }
    close();
    call('error', errorMessage(type));
  }

  function stalled() {
    watch.prepared = true;
    watch.bufferingSince = 0;
    watch.progressAt = Date.now();
    failed('PLAYER_ERROR_CONNECTION_TIMEOUT');
  }

  setInterval(function () {
    if (!current || !av) return;
    var now = Date.now();
    if (!watch.prepared) {
      if (now - watch.openedAt > PREPARE_LIMIT_MS) stalled();
      return;
    }
    if (watch.bufferingSince && now - watch.bufferingSince > (current.live ? LIVE_STALL_MS : VOD_STALL_MS)) { stalled(); return; }
    if (safe(function () { return av.getState(); }) === 'PLAYING') {
      var position = safe(function () { return av.getCurrentTime(); });
      if (position !== watch.position) { watch.position = position; watch.progressAt = now; }
      else if (current.live && now - watch.progressAt > LIVE_FROZEN_MS) stalled();
    } else watch.progressAt = now;
  }, 2000);

  function tracks(type) {
    var all = safe(function () { return av.getTotalTrackInfo(); }) || [];
    var selected = safe(function () { return av.getCurrentStreamInfo(); }) || [];
    var selectedIndex = (selected.filter(function (s) { return s.type === type; })[0] || {}).index;
    return all.filter(function (t) { return t.type === type; }).map(function (t, n) {
      var info = {};
      try { info = JSON.parse(t.extra_info); } catch (e) {}
      var language = info.language || info.track_lang || '';
      return { index: t.index, name: language ? language.toUpperCase() : (type === 'AUDIO' ? 'Áudio ' : 'Legenda ') + (n + 1), selected: t.index === selectedIndex };
    });
  }

  return {
    available: !!av,
    set handlers(value) { handlers = value || {}; },
    get current() { return current; },

    /** item: {url, live, playWhenReady}. Opening the same address again keeps the playback. */
    play: function (item, startMs) { retries = 0; open(item, startMs); },
    reopen: function () { if (current) { retries = 0; open(Object.assign({}, current, { url: App.prefs.refreshUrl(current.url) }), current.live ? 0 : lastTime); } },
    stop: function () { generation++; close(); current = null; },

    setRect: function (x, y, w, h) {
      rect = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
      if (av && current) safe(function () { av.setDisplayRect(rect[0], rect[1], rect[2], rect[3]); });
    },
    fullscreen: function () { this.setRect(0, 0, 1920, 1080); },

    setAspect: function (mode) { aspect = mode; applyAspect(); },
    get aspect() { return aspect; },

    state: function () { return safe(function () { return av.getState(); }) || 'NONE'; },
    isPlaying: function () { return this.state() === 'PLAYING'; },
    pause: function () { safe(function () { av.pause(); }); },
    resume: function () { safe(function () { av.play(); }); },
    toggle: function () { if (this.isPlaying()) this.pause(); else this.resume(); },
    time: function () { var t = safe(function () { return av.getCurrentTime(); }); return typeof t === 'number' ? t : lastTime; },
    duration: function () { return safe(function () { return av.getDuration(); }) || 0; },
    seekTo: function (ms, done) {
      lastTime = ms;
      try { av.seekTo(Math.max(0, Math.round(ms)), done || function () {}, done || function () {}); } catch (e) { if (done) done(); }
    },

    audioTracks: function () { return tracks('AUDIO'); },
    textTracks: function () { return tracks('TEXT'); },
    selectTrack: function (type, index) { safe(function () { av.setSelectTrack(type, index); }); },
    silentSubtitles: function (silent) { safe(function () { av.setSilentSubtitle(silent); }); },

    suspend: function () { safe(function () { av.suspend(); }); },
    restore: function () { safe(function () { av.restore(); }); },
  };
})();
