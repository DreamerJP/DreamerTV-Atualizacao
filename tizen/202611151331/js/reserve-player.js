'use strict';

/*
 * Reserve player for movies and episodes, the counterpart of the Android disk reserve. One connection
 * downloads the file ahead into the app's storage (at most 256 MB, keeping 512 MB free); the TV's video
 * element receives only about a minute at a time. Each new request repeats the last 4 KB received and
 * must return the same bytes, because some servers give no version or date for the file. When the format,
 * the storage or the decoder does not cooperate, playback moves to the Samsung player at the same position.
 */
App.reservePlayer = (function () {
  var MB = 1048576;
  var CHUNK = 2 * MB, MEMORY_LIMIT = 8 * MB, MAX_RESERVE = 256 * MB, FREE_RESERVE = 512 * MB, MIN_RESERVE = 16 * MB;
  var OVERLAP = 4096, AHEAD_S = 60, KEEP_BEHIND_S = 30, STALL_MS = 9000, START_LIMIT_MS = 30000;
  var DIR = 'wgt-private/reserva';
  var video = null, session = null, handlers = {}, aspect = 'FIT', sequence = 0;

  var supported = typeof MediaSource !== 'undefined' && typeof MP4Box !== 'undefined';
  var fs = (function () { try { return tizen.filesystem; } catch (e) { return null; } })();

  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (handlers[name]) { try { handlers[name].apply(null, args); } catch (e) {} }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Storage -----------------------------------------------------------------------------
  function ensureDir() {
    if (!fs) return false;
    try { fs.createDirectory(DIR, true); } catch (e) {}
    try { return fs.isDirectory(DIR); } catch (e) { return false; }
  }
  function clearDir() {
    if (!fs) return;
    try {
      fs.listDirectory(DIR, function (names) {
        names.forEach(function (n) { try { fs.deleteFile(DIR + '/' + n); } catch (e) {} });
      }, function () {});
    } catch (e) {}
  }
  function writeFile(path, bytes) {
    return new Promise(function (resolve, reject) {
      try {
        var handle = fs.openFile(path, 'w');
        handle.writeDataNonBlocking(bytes, function () {
          try { handle.close(); } catch (e) {}
          resolve();
        }, function (e) { try { handle.close(); } catch (x) {} reject(e); });
      } catch (e) { reject(e); }
    });
  }
  function readFile(path, size) {
    return new Promise(function (resolve, reject) {
      try {
        var handle = fs.openFile(path, 'r');
        handle.readDataNonBlocking(function (data) {
          try { handle.close(); } catch (e) {}
          resolve(data);
        }, function (e) { try { handle.close(); } catch (x) {} reject(e); }, size);
      } catch (e) { reject(e); }
    });
  }
  function deleteFile(path) { try { fs.deleteFile(path); } catch (e) {} }
  function freeSpace() {
    return new Promise(function (resolve) {
      try {
        tizen.systeminfo.getPropertyValue('STORAGE', function (s) {
          var internal = s.units.filter(function (u) { return u.type === 'INTERNAL'; })[0] || s.units[0];
          resolve(internal ? internal.availableCapacity : 0);
        }, function () { resolve(0); });
      } catch (e) { resolve(0); }
    });
  }

  // Network ---------------------------------------------------------------------------------
  function getRange(url, from, to) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 30000;
      xhr.setRequestHeader('Range', 'bytes=' + from + '-' + to);
      // A server that ignores the range answers with the whole file (or an endless stream);
      // it is cut at the headers instead of downloading it into memory.
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2 && xhr.status === 200) { var status = xhr.status; xhr.onload = null; xhr.abort(); resolve({ status: status, body: null, range: null }); }
      };
      xhr.onload = function () { resolve({ status: xhr.status, body: xhr.response, range: xhr.getResponseHeader('Content-Range') }); };
      xhr.onerror = function () { reject(new Error('rede')); };
      xhr.ontimeout = function () { reject(new Error('tempo')); };
      xhr.send();
    });
  }
  function parseRange(header) {
    var m = /bytes (\d+)-(\d+)\/(\d+)/.exec(header || '');
    return m ? { start: +m[1], end: +m[2], total: +m[3] } : null;
  }

  function Fallback(reason) { this.reason = reason; }

  // Element -----------------------------------------------------------------------------------
  function element() {
    if (video) return video;
    video = document.createElement('video');
    video.id = 'reserve-video';
    video.setAttribute('style', 'position:absolute;left:0;top:0;width:1920px;height:1080px;background:#000;display:none');
    App.$('#stage').insertBefore(video, App.$('#av-player').nextSibling);
    applyAspect();
    return video;
  }
  function applyAspect() {
    if (video) video.style.objectFit = { FIT: 'contain', ZOOM: 'cover', FILL: 'fill' }[aspect];
  }

  // Session -----------------------------------------------------------------------------------
  function bufferedAhead(s) {
    var v = s.video, t = v.currentTime;
    for (var i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
    return 0;
  }

  function pump(s, id) {
    var sb = s.buffers[id];
    if (!sb || sb.updating || !s.queues[id].length || s.ms.readyState !== 'open') return;
    var buffer = s.queues[id].shift();
    try { sb.appendBuffer(buffer); } catch (e) {
      if (e.name === 'QuotaExceededError') { s.queues[id].unshift(buffer); trimBehind(s, true); setTimeout(function () { pump(s, id); }, 1000); }
      else s.fail(new Fallback('append ' + e.name));
    }
  }
  function queued(s) { return Object.keys(s.queues).reduce(function (n, id) { return n + s.queues[id].length; }, 0); }
  function trimBehind(s, force) {
    var t = s.video.currentTime;
    if (t < KEEP_BEHIND_S && !force) return;
    Object.keys(s.buffers).forEach(function (id) {
      var sb = s.buffers[id];
      if (!sb.updating && sb.buffered.length && sb.buffered.start(0) < t - KEEP_BEHIND_S) {
        try { sb.remove(0, Math.max(0, t - KEEP_BEHIND_S)); } catch (e) {}
      }
    });
  }

  function start(item, startMs, audioId, onFallback) {
    var s = {
      id: ++sequence, item: item, startMs: startMs || 0, audioId: audioId, onFallback: onFallback,
      video: element(), ms: new MediaSource(), mp4: MP4Box.createFile(), buffers: {}, queues: {}, info: null,
      size: 0, downloadPos: 0, durationMs: 0, queue: [], memoryBytes: 0, diskBytes: 0, disk: false, target: MIN_RESERVE,
      capacity: 0, tail: null, stopped: false, ready: false, playing: false, failures: 0, openedAt: Date.now(),
      progressAt: Date.now(), position: -1, chunkNo: 0, ended: false, kick: null,
    };
    session = s;
    s.url = function () { return App.prefs.refreshUrl(item.url); };
    s.alive = function () { return session === s && !s.stopped; };
    s.fail = function (error) {
      if (!s.alive()) return;
      if (error instanceof Fallback) {
        var at = s.ready ? Math.round(s.video.currentTime * 1000) : s.startMs;
        stop();
        onFallback(at, error.reason);
      } else {
        stop();
        call('error', error && error.forUser ? error.message : 'Não foi possível reconectar. Verifique a conexão e tente novamente.');
      }
    };
    var v = s.video;
    v.style.display = 'block';
    v.src = URL.createObjectURL(s.ms);
    v.onwaiting = function () { if (s.alive() && s.ready) report(s); };
    v.onplaying = function () { if (s.alive()) { s.playing = true; call('ready'); } };
    v.ontimeupdate = function () { if (s.alive()) call('time', Math.round(v.currentTime * 1000)); };
    v.onended = function () { if (s.alive()) call('ended'); };
    v.onerror = function () { s.fail(new Fallback('vídeo ' + (v.error && v.error.code))); };
    call('buffering', null);
    s.ms.addEventListener('sourceopen', function () {
      if (!s.alive()) return;
      prepare(s).then(function () { download(s); feed(s); watchdog(s); }).catch(function (e) { s.fail(e); });
    }, { once: true });
    return s;
  }

  function report(s) {
    var resume = (App.bufferProfiles[App.prefs.settings.bufferProfile] || App.bufferProfiles.ULTRA_STABLE).resumeS + 2;
    call('buffering', Math.min(99, Math.round(bufferedAhead(s) / resume * 100)));
  }

  /** Reads the file layout (moov), chooses the tracks and finds the starting offset. */
  function prepare(s) {
    var mp4 = s.mp4;
    var readyInfo = null;
    mp4.onReady = function (info) { readyInfo = info; };
    mp4.onError = function (e) { s.fail(new Fallback('leitura ' + e)); };
    mp4.onSegment = function (id, user, buffer, sampleNumber) {
      if (!s.alive() || !s.queues[id]) return;
      s.queues[id].push(buffer);
      pump(s, id);
      try { mp4.releaseUsedSamples(id, sampleNumber); } catch (e) {}
    };
    var position = 0, fed = 0;
    function step() {
      if (!s.alive()) return Promise.reject(new Fallback('parado'));
      return getRange(s.url(), position, position + CHUNK - 1).then(function (r) {
        if (r.status === 404 || r.status === 410) { var e = new Error('Este conteúdo não está disponível no servidor.'); e.forUser = true; throw e; }
        if (r.status === 401 || r.status === 403) { var d = new Error('Acesso não autorizado pelo servidor. Verifique sua conta.'); d.forUser = true; throw d; }
        var range = parseRange(r.range);
        if (r.status !== 206 || !range) throw new Fallback('sem pedido por faixa');
        if (!s.size) {
          s.size = range.total;
          var head = new Uint8Array(r.body, 4, 4);
          if (String.fromCharCode.apply(null, head) !== 'ftyp') throw new Fallback('não é MP4');
        }
        var buf = r.body;
        buf.fileStart = range.start;
        fed += buf.byteLength;
        var next = mp4.appendBuffer(buf);
        position = typeof next === 'number' && next > 0 ? next : range.end + 1;
        if (readyInfo) return readyInfo;
        if (fed > 64 * MB || position >= s.size) throw new Fallback('índice do vídeo não encontrado');
        return step();
      }, function (e) {
        if (e instanceof Fallback || e.forUser) throw e;
        if (++s.failures > 4) throw new Fallback('sem resposta: ' + e.message);
        return sleep(Math.min(s.failures * 1200, 5000)).then(step);
      });
    }
    return Promise.all([step(), freeSpace()]).then(function (results) {
      var info = results[0];
      s.failures = 0;
      s.info = info;
      s.durationMs = Math.round(info.duration / info.timescale * 1000);
      var videoTrack = info.videoTracks[0];
      var audioTracks = info.audioTracks;
      var audio = audioTracks.filter(function (t) { return t.id === s.audioId; })[0] ||
        audioTracks.filter(function (t) { return /^(por|pt)/i.test(t.language || ''); })[0] || audioTracks[0];
      if (!videoTrack) throw new Fallback('sem imagem');
      [videoTrack, audio].filter(Boolean).forEach(function (t) {
        var mime = (t === videoTrack ? 'video' : 'audio') + '/mp4; codecs="' + t.codec + '"';
        if (!MediaSource.isTypeSupported(mime)) throw new Fallback('formato ' + t.codec);
        var sb = s.ms.addSourceBuffer(mime);
        s.buffers[t.id] = sb;
        s.queues[t.id] = [];
        sb.addEventListener('updateend', function () { pump(s, t.id); if (s.kick) s.kick(); });
        mp4.setSegmentOptions(t.id, null, { nbSamples: t === videoTrack ? 120 : 300 });
      });
      s.audioId = audio ? audio.id : null;
      s.ms.duration = s.durationMs / 1000;
      mp4.initializeSegmentation().forEach(function (seg) { s.queues[seg.id].push(seg.buffer); pump(s, seg.id); });
      // The library's own seek also looks at tracks that are not played (text, chapters), which can
      // send it back to the beginning; only the chosen image and sound tracks decide here.
      var trakOf = function (id) { return mp4.moov.traks.filter(function (tr) { return tr.tkhd.track_id === id; })[0]; };
      var vSeek = mp4.seekTrack(s.startMs / 1000, true, trakOf(videoTrack.id));
      var aSeek = audio ? mp4.seekTrack(vSeek.time, false, trakOf(audio.id)) : null;
      var seek = { time: vSeek.time, offset: mp4.stream.getEndFilePositionAfter(Math.min(vSeek.offset, aSeek ? aSeek.offset : Infinity)) };
      s.downloadPos = seek.offset;
      // The TV ignores a position set before the video knows its tracks, so it is applied once they arrive.
      s.seekTime = seek.time;
      var v = s.video;
      if (v.readyState >= 1) v.currentTime = seek.time;
      else v.addEventListener('loadedmetadata', function () { if (s.alive()) v.currentTime = s.seekTime; }, { once: true });
      mp4.start();
      var free = results[1];
      s.disk = ensureDir() && free > FREE_RESERVE + MIN_RESERVE;
      s.capacity = s.disk ? Math.max(MIN_RESERVE, Math.min(MAX_RESERVE, free - FREE_RESERVE)) : MEMORY_LIMIT;
      s.target = 2 * MB;
      s.ready = true;
      if (s.item.playWhenReady !== false) s.video.play().catch(function () {});
    });
  }

  /** Ten minutes of the file at its average rate once playback starts, within the capacity. */
  function updateTarget(s) {
    if (!s.playing) { s.target = 2 * MB; return; }
    var target = s.durationMs > 0 && s.size > 0 ? s.size * 600000 / s.durationMs : 32 * MB;
    s.target = Math.max(Math.min(MIN_RESERVE, s.capacity), Math.min(s.capacity, target));
  }

  function download(s) {
    if (!s.alive()) return;
    updateTarget(s);
    if (s.downloadPos >= s.size) return;
    if (s.memoryBytes + s.diskBytes >= s.target) { setTimeout(function () { download(s); }, 400); return; }
    var from = s.downloadPos;
    var overlap = s.tail ? Math.min(OVERLAP, from) : 0;
    var to = Math.min(s.size - 1, from + CHUNK - 1);
    getRange(s.url(), from - overlap, to).then(function (r) {
      if (!s.alive()) return;
      var range = parseRange(r.range);
      if (r.status !== 206 || !range || range.start !== from - overlap || range.total !== s.size) throw new Fallback('o arquivo mudou');
      var bytes = new Uint8Array(r.body);
      if (overlap) {
        var previous = s.tail.subarray(s.tail.length - overlap);
        for (var i = 0; i < overlap; i++) if (bytes[i] !== previous[i]) throw new Fallback('o arquivo mudou');
      }
      var data = r.body.slice(overlap);
      s.tail = new Uint8Array(data.slice(Math.max(0, data.byteLength - OVERLAP)));
      s.failures = 0;
      s.downloadPos = from + data.byteLength;
      var entry = { start: from, length: data.byteLength, data: null, path: null };
      var keep = !s.disk || s.memoryBytes + data.byteLength <= MEMORY_LIMIT;
      var path = DIR + '/c' + s.id + '_' + (s.chunkNo++) + '.bin';
      var stored = keep ? Promise.resolve() : writeFile(path, new Uint8Array(data)).then(function () {
        entry.path = path;
        s.diskBytes += entry.length;
      }, function () {
        s.disk = false;
        s.capacity = MEMORY_LIMIT;
        keep = true;
      });
      return stored.then(function () {
        if (keep || !entry.path) { entry.data = data; s.memoryBytes += entry.length; }
        s.queue.push(entry);
        if (s.kick) s.kick();
        download(s);
      });
    }).catch(function (e) {
      if (!s.alive()) return;
      if (e instanceof Fallback) { s.fail(e); return; }
      s.failures++;
      if (bufferedAhead(s) < 2 && s.failures > 1) call('retry', Math.min(s.failures, 5), 5);
      if (s.failures > 6 && !s.queue.length && bufferedAhead(s) < 1) { s.fail(e); return; }
      setTimeout(function () { download(s); }, Math.min(s.failures * 1200, 5000));
    });
  }

  function feed(s) {
    if (!s.alive()) return;
    s.kick = null;
    var ahead = bufferedAhead(s);
    if (queued(s) > 0 || ahead > AHEAD_S || !s.queue.length) {
      if (!s.queue.length && s.downloadPos >= s.size && queued(s) === 0 && !s.ended) {
        s.ended = true;
        try { s.mp4.flush(); } catch (e) {}
        setTimeout(function () { if (s.alive() && queued(s) === 0) { try { s.ms.endOfStream(); } catch (e) {} } }, 500);
      }
      var timer = setTimeout(function () { feed(s); }, 500);
      s.kick = function () { clearTimeout(timer); s.kick = null; setTimeout(function () { feed(s); }, 0); };
      return;
    }
    var entry = s.queue.shift();
    var load = entry.data ? Promise.resolve(entry.data) : readFile(entry.path, entry.length).then(function (bytes) {
      deleteFile(entry.path);
      return bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
    });
    load.then(function (buffer) {
      if (!s.alive()) return;
      if (entry.data) s.memoryBytes -= entry.length; else s.diskBytes -= entry.length;
      buffer.fileStart = entry.start;
      s.mp4.appendBuffer(buffer);
      trimBehind(s, false);
      feed(s);
    }, function () { s.fail(new Fallback('reserva ilegível')); });
  }

  /** Falls back when the decoder stops with data available, or when nothing plays at all. */
  function watchdog(s) {
    var timer = setInterval(function () {
      if (!s.alive()) { clearInterval(timer); return; }
      var v = s.video, now = Date.now();
      if (!s.playing) {
        if (now - s.openedAt > START_LIMIT_MS && bufferedAhead(s) > 3) s.fail(new Fallback('não começou'));
        return;
      }
      if (v.paused || v.ended) { s.progressAt = now; return; }
      if (v.currentTime !== s.position) { s.position = v.currentTime; s.progressAt = now; return; }
      if (bufferedAhead(s) > 4 && now - s.progressAt > STALL_MS) s.fail(new Fallback('imagem parada'));
      else if (bufferedAhead(s) < 1) report(s);
    }, 1000);
  }

  function stop() {
    var s = session;
    session = null;
    if (s) {
      s.stopped = true;
      try { s.video.pause(); } catch (e) {}
      try { URL.revokeObjectURL(s.video.src); } catch (e) {}
    }
    if (video) {
      // The element is discarded so the TV hands the video decoder back to the Samsung player.
      video.onwaiting = video.onplaying = video.ontimeupdate = video.onended = video.onerror = null;
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
      video.remove();
      video = null;
    }
    clearDir();
  }

  return {
    get supported() { return supported; },
    set handlers(value) { handlers = value || {}; },
    get active() { return !!session; },
    get current() { return session ? session.item : null; },
    play: function (item, startMs, onFallback, audioId) { stop(); start(item, startMs, audioId, onFallback); },
    stop: stop,
    setAspect: function (mode) { aspect = mode; applyAspect(); },
    state: function () {
      if (!session) return 'NONE';
      if (!session.ready) return 'IDLE';
      return session.video.paused ? 'PAUSED' : 'PLAYING';
    },
    pause: function () { if (session) session.video.pause(); },
    resume: function () { if (session) session.video.play().catch(function () {}); },
    time: function () { return session && session.ready ? Math.round(session.video.currentTime * 1000) : (session ? session.startMs : 0); },
    duration: function () { return session ? session.durationMs : 0; },
    /** Inside the downloaded part the jump is immediate; elsewhere the download restarts there. */
    seekTo: function (ms, done) {
      var s = session;
      if (!s || !s.ready) { if (done) done(); return; }
      var t = ms / 1000, v = s.video;
      for (var i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t && v.buffered.end(i) > t + 1) { v.currentTime = t; if (done) done(); return; }
      }
      var playing = !v.paused;
      var item = Object.assign({}, s.item, { playWhenReady: playing });
      var fallback = s.onFallback;
      var audioId = s.audioId;
      stop();
      start(item, ms, audioId, fallback);
      if (done) done();
    },
    audioTracks: function () {
      if (!session || !session.info) return [];
      return session.info.audioTracks.map(function (t, n) {
        return { index: t.id, name: t.language && t.language !== 'und' ? t.language.toUpperCase() : 'Áudio ' + (n + 1), selected: t.id === session.audioId };
      });
    },
    selectAudio: function (id) {
      var s = session;
      if (!s || id === s.audioId) return;
      var at = Math.round(s.video.currentTime * 1000);
      var item = Object.assign({}, s.item, { playWhenReady: !s.video.paused });
      var fallback = s.onFallback;
      stop();
      start(item, at, id, fallback);
    },
    diskReserveBytes: function () { return session && session.ready ? session.diskBytes + session.memoryBytes : null; },
    debug: function () {
      var s = session;
      if (!s) return null;
      var v = s.video, ranges = [];
      for (var i = 0; i < v.buffered.length; i++) ranges.push(Math.round(v.buffered.start(i)) + '-' + Math.round(v.buffered.end(i)));
      return { pedido: Math.round(s.startMs / 1000), posicaoLida: s.seekTime, baixado: s.downloadPos, tamanho: s.size, carregado: ranges.join(','), prontidao: v.readyState, atual: v.currentTime, fila: s.queue.length, pendentes: queued(s) };
    },
    clear: clearDir,
  };
})();

/**
 * The player used by the screens. Movies and episodes start in the reserve player when it is enabled;
 * live channels, HLS and anything it cannot play go to the Samsung player.
 */
App.player = (function () {
  var av = App.avplayer, rp = App.reservePlayer;
  var handlers = {};
  var usingReserve = false;
  var fallbackFor = null;

  function canReserve(item) {
    return !item.live && rp.supported && App.prefs.settings.videoReserve !== false && !/\.m3u8(\?|$)/i.test(item.url) && fallbackFor !== item.url;
  }
  function active() { return usingReserve ? rp : av; }

  return {
    get available() { return av.available || rp.supported; },
    set handlers(value) { handlers = value || {}; av.handlers = handlers; rp.handlers = handlers; },
    get current() { return active().current; },
    play: function (item, startMs) {
      av.stop();
      rp.stop();
      if (fallbackFor && fallbackFor !== item.url) fallbackFor = null;
      if (canReserve(item)) {
        usingReserve = true;
        rp.play(item, startMs, function (at) {
          // The same item is not retried in the reserve player until another one is opened.
          fallbackFor = item.url;
          usingReserve = false;
          // A short pause lets the TV release the decoder held by the reserve player.
          setTimeout(function () { if (!usingReserve && fallbackFor === item.url) av.play(item, at); }, 800);
        });
      } else {
        usingReserve = false;
        av.play(item, startMs);
      }
    },
    reopen: function () { if (usingReserve) { var item = rp.current; var at = rp.time(); if (item) this.play(item, at); } else av.reopen(); },
    stop: function () { av.stop(); rp.stop(); usingReserve = false; },
    setRect: function (x, y, w, h) { av.setRect(x, y, w, h); },
    fullscreen: function () { av.fullscreen(); },
    setAspect: function (mode) { av.setAspect(mode); rp.setAspect(mode); },
    get aspect() { return av.aspect; },
    state: function () { return active().state(); },
    isPlaying: function () { return active().state() === 'PLAYING'; },
    pause: function () { active().pause(); },
    resume: function () { active().resume(); },
    toggle: function () { if (this.isPlaying()) this.pause(); else this.resume(); },
    time: function () { return active().time(); },
    duration: function () { return active().duration(); },
    seekTo: function (ms, done) { active().seekTo(ms, done); },
    audioTracks: function () { return active().audioTracks(); },
    textTracks: function () { return usingReserve ? [] : av.textTracks(); },
    selectTrack: function (type, index) { if (usingReserve) { if (type === 'AUDIO') rp.selectAudio(index); } else av.selectTrack(type, index); },
    silentSubtitles: function (silent) { if (!usingReserve) av.silentSubtitles(silent); },
    suspend: function () { if (usingReserve) rp.pause(); else av.suspend(); },
    restore: function () { if (usingReserve) rp.resume(); else av.restore(); },
    diskReserveBytes: function () { return usingReserve ? rp.diskReserveBytes() : null; },
    get usingReserve() { return usingReserve; },
  };
})();
