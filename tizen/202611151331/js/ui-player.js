'use strict';

// Full-screen player: controls, channel list, resume, next episode, subtitles and remote seeking.
App.playerScreen = (function () {
  var el = App.el, ui = App.ui, prefs = App.prefs, player = App.player, K = App.keys;
  var root = App.$('#player');
  var parts = null, layer = null;
  var info = null, onReturn = null;
  var channels = [], channelIndex = 0, episodes = [], episodeIndex = -1;
  var osdTimer = null, tickTimer = null, subtitleTimer = null, subtitleHide = null;
  var prepared = false, terminalError = false, nextTriggered = false, ending = false;
  var lastSave = 0, duration = 0, lastPosition = 0;
  var cues = null, subtitleRequest = 0;
  var seek = null;
  var aspects = [['FIT', 'Ajustar (Original)'], ['ZOOM', 'Preencher Tela (Zoom)'], ['FILL', 'Esticar 16:9']];

  function build() {
    parts = {};
    parts.title = el('div', { class: 'ptitle' });
    parts.clock = el('div', { class: 'pclock' });
    parts.hint = el('span', { text: 'Toque nas setas: 10 s · Segure: avanço rápido' });
    parts.reserve = el('span', { class: 'reserve' });
    parts.hintRow = el('div', { class: 'hints' }, [parts.hint, parts.reserve]);
    parts.current = el('span', { text: '00:00' });
    parts.total = el('span', { text: '00:00' });
    parts.fill = el('div', { class: 'fill' });
    parts.knob = el('div', { class: 'knob' });
    parts.bar = ui.focusable('div', { class: 'bar', onclick: function () { player.toggle(); showOsd(); } }, [parts.fill, parts.knob]);
    parts.bar.addEventListener('focus', function () { parts.bar.classList.add('focused'); });
    parts.bar.addEventListener('blur', function () { parts.bar.classList.remove('focused'); });
    parts.progress = el('div', { class: 'progress-row' }, [parts.current, parts.bar, parts.total]);
    parts.aspect = ui.button('Proporção: Ajustar (Original)', cycleAspect);
    parts.audio = ui.button('Áudio', chooseAudio);
    parts.subs = ui.button('Legendas', chooseSubtitles);
    parts.list = ui.button('Lista de Canais', toggleDrawer);
    parts.vodRows = el('div', {}, [parts.hintRow, parts.progress]);
    parts.osd = el('div', { class: 'osd' }, [
      el('div', { class: 'top' }, [parts.title, parts.clock]),
      el('div', { class: 'bottom' }, [parts.vodRows, el('div', { class: 'buttons', 'data-group': 'osd-buttons', 'data-enter': 'first' }, [parts.aspect, parts.audio, parts.subs, parts.list])]),
    ]);
    parts.subtitle = el('div', { class: 'subs' });
    parts.loading = ui.loadingBox();
    parts.nextText = el('span');
    parts.next = el('div', { class: 'next hidden' }, [parts.nextText, ui.button('Assistir Agora', playNext)]);
    parts.drawerList = el('div', { class: 'list scroll' });
    parts.drawer = el('div', { class: 'drawer hidden', 'data-group': 'drawer' }, [el('div', { class: 'heading', text: 'CANAIS' }), parts.drawerList]);
    [parts.subtitle, parts.osd, parts.loading.node, parts.next, parts.drawer].forEach(function (n) { root.appendChild(n); });
    document.addEventListener('keyup', onKeyUp, true);
  }

  function isActive() { return layer && App.nav.top === layer; }

  // OSD -------------------------------------------------------------------------------

  function showOsd(ms) {
    parts.osd.classList.remove('hidden');
    root.classList.add('osd-on');
    parts.clock.textContent = prefs.settings.showClock ? App.clock() : '';
    clearTimeout(osdTimer);
    osdTimer = setTimeout(hideOsd, ms || 5000);
    var focused = App.nav.current();
    if (!focused || !parts.osd.contains(focused)) App.nav.focus(info.live ? parts.aspect : parts.bar);
  }

  function hideOsd() {
    if (seek) return;
    parts.osd.classList.add('hidden');
    root.classList.remove('osd-on');
    App.$$('.focused', parts.osd).forEach(function (n) { n.classList.remove('focused'); });
    if (document.activeElement && parts.osd.contains(document.activeElement)) document.activeElement.blur();
  }

  function osdVisible() { return !parts.osd.classList.contains('hidden'); }

  function updateTitle() {
    var channel = channels[channelIndex];
    if (info.live && channel) parts.title.textContent = App.pad(channel.number > 0 ? channel.number : channelIndex + 1, 3) + '  ' + info.title;
    else parts.title.textContent = info.title;
  }

  function cycleAspect() {
    var at = aspects.findIndex(function (a) { return a[0] === player.aspect; });
    var next = aspects[(at + 1) % aspects.length];
    player.setAspect(next[0]);
    parts.aspect.textContent = 'Proporção: ' + next[1];
    showOsd();
  }

  // Progress -------------------------------------------------------------------------

  function renderProgress(position) {
    if (info.live || !prepared) return;
    duration = player.duration() || duration;
    if (duration <= 0) return;
    var shown = seek ? seek.target : position;
    var pct = Math.max(0, Math.min(100, shown / duration * 100));
    parts.fill.style.width = pct + '%';
    parts.knob.style.left = pct + '%';
    parts.current.textContent = App.formatTime(shown);
    parts.total.textContent = App.formatTime(duration);
    var remaining = duration - position;
    if (remaining >= 1000 && remaining <= 20000 && hasNext()) {
      parts.nextText.textContent = 'Próximo episódio em ' + Math.floor(remaining / 1000) + 's…';
      if (parts.next.classList.contains('hidden')) parts.next.classList.remove('hidden');
    } else parts.next.classList.add('hidden');
  }

  function progressItem(position, total) {
    return {
      id: info.mediaId || String(info.url.length), title: info.title, subtitle: info.subtitle || '', poster: info.posterUrl || '',
      streamUrl: info.url, positionMs: position, durationMs: Math.max(0, total), mediaType: info.mediaType,
      seriesId: info.seriesId || '', seriesTitle: info.seriesTitle || '', seriesEpisodesUrl: info.seriesEpisodesUrl || '',
      season: info.season || '', episodeCode: info.episodeCode || '',
    };
  }

  function saveProgress(force) {
    if (!info || info.live || !prepared) return;
    var position = Math.max(0, player.time());
    var total = player.duration() || duration;
    lastPosition = position;
    if (position === 0) return;
    if (!force && lastSave && Date.now() - lastSave < 60000) return;
    lastSave = Date.now();
    prefs.savePlaybackProgress(progressItem(position, total), total > 60000 && position >= total * 0.97, total > 60000 && position >= total * 0.85);
  }

  function completeItem() {
    if (!info || info.live) return;
    prefs.savePlaybackProgress(progressItem(0, duration), true, true);
  }

  // Episodes -------------------------------------------------------------------------

  function hasNext() { return episodeIndex >= 0 && episodeIndex + 1 < episodes.length; }

  function playNext() {
    if (!hasNext() || nextTriggered) return;
    nextTriggered = true;
    completeItem();
    episodeIndex++;
    var next = episodes[episodeIndex];
    var seriesTitle = info.seriesTitle || info.title.split(' - ')[0];
    info = Object.assign({}, info, {
      url: App.catalog.refreshUrl(next.streamUrl), title: seriesTitle ? seriesTitle + ' - ' + next.title : next.title,
      subtitle: App.season.display(next.season) + ' (' + next.episodeCode + ')', startMs: 0, mediaId: next.id, mediaType: 'EPISODE',
      seriesTitle: seriesTitle, season: next.season, episodeCode: next.episodeCode,
    });
    if (info.seriesId) prefs.saveLastSeason(info.seriesId, next.season);
    start();
  }

  function handleEnded() {
    if (info.live || ending) return;
    ending = true;
    completeItem();
    if (hasNext()) playNext();
    else close();
  }

  // Channels ---------------------------------------------------------------------------

  function switchChannel(index) {
    var channel = channels[index];
    if (!channel) return;
    channelIndex = index;
    prefs.setSetting('lastChannelId', channel.id);
    info = Object.assign({}, info, { url: channel.streamUrl, title: channel.name, subtitle: channel.category, mediaId: channel.id, posterUrl: channel.logo });
    App.$$('.channel', parts.drawerList).forEach(function (row) { row.classList.toggle('selected', row.dataset.id === channel.id); });
    start();
  }

  function toggleDrawer() {
    if (!parts.drawer.classList.contains('hidden')) { parts.drawer.classList.add('hidden'); showOsd(); return; }
    if (!channels.length) return;
    hideOsd();
    parts.drawer.classList.remove('hidden');
    App.lazyList(parts.drawerList, channels, function (c, i) {
      var row = ui.channel(c, function () { parts.drawer.classList.add('hidden'); switchChannel(i); });
      if (i === channelIndex) row.classList.add('selected');
      return row;
    }, Math.max(80, channelIndex + 20));
    var current = App.$('.channel.selected', parts.drawerList);
    if (current) App.nav.focus(current);
  }

  // Tracks and subtitles ---------------------------------------------------------------

  function chooseAudio() {
    var tracks = player.audioTracks();
    if (!tracks.length) return;
    App.dialog.choose('Selecionar Áudio', tracks.map(function (t) {
      return { label: t.name, selected: t.selected, action: function () { player.selectTrack('AUDIO', t.index); } };
    }));
  }

  function stopExternal() {
    cues = null;
    clearInterval(subtitleTimer);
    parts.subtitle.textContent = '';
  }

  function chooseSubtitles() {
    var tracks = player.textTracks();
    var options = [{ label: 'Desativada', selected: !cues && !tracks.some(function (t) { return t.selected; }), action: function () {
      subtitleRequest++; stopExternal(); player.silentSubtitles(true);
    } }];
    tracks.forEach(function (t) {
      options.push({ label: t.name + ' (Embutida)', selected: !cues && t.selected, action: function () {
        subtitleRequest++; stopExternal(); player.silentSubtitles(false); player.selectTrack('TEXT', t.index);
      } });
    });
    if (cues) options.push({ label: 'Português (PT-BR) (Online)', selected: true, action: function () {} });
    options.push({ label: 'Buscar Legenda Online (PT-BR)', action: fetchOnline });
    App.dialog.choose('Selecionar Legenda', options);
  }

  function fetchOnline() {
    var request = ++subtitleRequest;
    var target = info;
    var isSeries = info.mediaType === 'EPISODE' || !!info.seriesId;
    var name = isSeries ? (info.seriesTitle || info.title.split(' - ')[0]) : info.title;
    var episode = episodes[episodeIndex];
    App.toast('Buscando legenda em português...');
    App.subtitles.findTitles(name, isSeries).then(function (titles) {
      if (titles.length === 1) return titles[0];
      return new Promise(function (resolve, reject) {
        App.dialog.choose('Confirme o título da legenda', titles.map(function (t) {
          return { label: t.name + (t.year ? ' (' + t.year + ')' : ''), action: function () { resolve(t); } };
        }), { onCancel: function () { reject(null); } });
      });
    }).then(function (title) {
      return App.subtitles.download(title.id, isSeries, episode ? episode.season : info.season, episode ? episode.episodeCode : info.episodeCode, episode ? episode.title : info.title);
    }).then(function (list) {
      if (request !== subtitleRequest || info !== target) return;
      player.silentSubtitles(true);
      cues = list;
      clearInterval(subtitleTimer);
      subtitleTimer = setInterval(function () { parts.subtitle.innerHTML = ''; var t = App.subtitles.cueAt(cues || [], player.time()); if (t) parts.subtitle.appendChild(el('span', { text: t })); }, 250);
      App.toast('Legenda em português aplicada.');
    }).catch(function (error) {
      if (!error || request !== subtitleRequest) return;
      App.toast(error.forUser ? error.message : 'Não foi possível buscar a legenda. Tente novamente.');
    });
  }

  // Remote seek ----------------------------------------------------------------------

  function seekStep(heldMs) {
    if (heldMs >= 10000) return 300000;
    if (heldMs >= 6000) return 120000;
    if (heldMs >= 3000) return 60000;
    if (heldMs >= 1200) return 30000;
    return 10000;
  }

  function handleSeekKey(e) {
    var forward = e.keyCode === K.RIGHT || e.keyCode === K.FF;
    if (info.live || terminalError || !prepared || duration <= 0) return false;
    if (!parts.drawer.classList.contains('hidden')) return false;
    var focused = App.nav.current();
    if (!seek && osdVisible() && focused !== parts.bar && e.keyCode !== K.FF && e.keyCode !== K.RW) return false;
    var now = Date.now();
    if (!seek || seek.forward !== forward) {
      var wasPlaying = seek ? seek.wasPlaying : player.isPlaying();
      seek = { forward: forward, target: seek ? seek.target : player.time(), since: now, last: 0, wasPlaying: wasPlaying };
      player.pause();
    }
    if (seek.last && now - seek.last < 400) return true;
    var step = seek.last ? seekStep(now - seek.since) : 10000;
    seek.last = now;
    seek.target = forward ? Math.min(duration, seek.target + step) : Math.max(0, seek.target - step);
    parts.hint.textContent = 'Solte para assistir a partir de ' + App.formatTime(seek.target);
    showOsd();
    App.nav.focus(parts.bar);
    renderProgress(player.time());
    return true;
  }

  function finishSeek(commit) {
    if (!seek) return;
    var s = seek;
    seek = null;
    parts.hint.textContent = 'Toque nas setas: 10 s · Segure: avanço rápido';
    if (commit) {
      player.seekTo(s.target, function () { if (s.wasPlaying) player.resume(); });
      lastPosition = s.target;
      saveProgress(true);
    } else if (s.wasPlaying) player.resume();
    showOsd();
  }

  function onKeyUp(e) {
    if (!isActive() || !seek) return;
    if ([K.LEFT, K.RIGHT, K.FF, K.RW].indexOf(e.keyCode) >= 0) finishSeek(true);
  }

  function onKey(e, focused) {
    var key = e.keyCode;
    if (seek && [K.LEFT, K.RIGHT, K.FF, K.RW].indexOf(key) < 0) finishSeek(true);
    if ([K.LEFT, K.RIGHT, K.FF, K.RW].indexOf(key) >= 0 && handleSeekKey(e)) return true;
    if (key === K.PLAY_PAUSE || key === K.PLAY || key === K.PAUSE || key === K.STOP) {
      if (key === K.STOP) { close(); return true; }
      if (key === K.PLAY) player.resume(); else if (key === K.PAUSE) player.pause(); else player.toggle();
      if (!info.live) saveProgress(true);
      showOsd();
      return true;
    }
    if (key === K.CH_UP || key === K.CH_DOWN) {
      if (info.live && channels.length) switchChannel((channelIndex + (key === K.CH_UP ? 1 : -1) + channels.length) % channels.length);
      return true;
    }
    var drawerOpen = !parts.drawer.classList.contains('hidden');
    if (key === K.ENTER) {
      if (terminalError && !drawerOpen) { if (!e.repeat) start(true); return true; }
      if (drawerOpen) return false;
      if (!parts.next.classList.contains('hidden')) { playNext(); return true; }
      if (!osdVisible()) { showOsd(); return true; }
      if (focused === parts.bar) { player.toggle(); showOsd(); return true; }
      showOsd();
      return false;
    }
    if (key === K.UP || key === K.DOWN) {
      if (drawerOpen) return false;
      if (info.live && !osdVisible() && channels.length) {
        switchChannel((channelIndex + (key === K.UP ? -1 : 1) + channels.length) % channels.length);
        return true;
      }
      if (!osdVisible()) { showOsd(); return true; }
      showOsd();
      return false;
    }
    if (key === K.LEFT || key === K.RIGHT) {
      if (drawerOpen) return false;
      if (!osdVisible()) {
        if (info.live && key === K.LEFT && channels.length) { toggleDrawer(); return true; }
        showOsd();
        return true;
      }
      showOsd();
      return false;
    }
    return false;
  }

  function onBack() {
    if (!parts.drawer.classList.contains('hidden')) { parts.drawer.classList.add('hidden'); return; }
    if (osdVisible() && !terminalError) { hideOsd(); return; }
    close();
  }

  // Playback -----------------------------------------------------------------------------

  function attach() {
    player.handlers = {
      buffering: function (pct) { if (!terminalError) parts.loading.show(pct ? 'Carregando' : (prepared ? 'Carregando' : 'Conectando'), pct); },
      ready: function () {
        prepared = true;
        terminalError = false;
        parts.loading.hide();
        duration = player.duration();
        renderProgress(player.time());
      },
      retry: function (n, max) { terminalError = false; parts.loading.show('Reconectando', null, 'Tentativa ' + n + ' de ' + max); },
      error: function (message) {
        finishSeek(false);
        terminalError = true;
        parts.loading.error(message, 'OK: tentar novamente · VOLTAR: sair');
      },
      ended: handleEnded,
      time: function (ms) {
        if (!info.live) { renderProgress(ms); saveProgress(false); }
      },
      subtitle: function (text, ms) {
        if (cues) return;
        parts.subtitle.innerHTML = '';
        if (text) parts.subtitle.appendChild(el('span', { html: String(text).replace(/<(?!\/?(i|b|br)\b)[^>]*>/gi, '') }));
        clearTimeout(subtitleHide);
        subtitleHide = setTimeout(function () { parts.subtitle.innerHTML = ''; }, Math.max(500, ms || 3000));
      },
    };
  }

  function start(retry) {
    terminalError = false;
    prepared = false;
    nextTriggered = false;
    ending = false;
    lastSave = 0;
    duration = 0;
    subtitleRequest++;
    stopExternal();
    seek = null;
    parts.next.classList.add('hidden');
    parts.loading.show('Conectando');
    updateTitle();
    attach();
    player.fullscreen();
    var startMs = retry ? lastPosition : (info.startMs || 0);
    lastPosition = startMs;
    player.play({ url: App.catalog.refreshUrl(info.url), live: info.live, id: info.mediaId }, startMs);
    showOsd(info.live ? 3000 : 5000);
  }

  function open(newInfo, back) {
    if (!parts) build();
    info = newInfo;
    onReturn = back;
    root.classList.toggle('live', !!info.live);
    parts.vodRows.classList.toggle('hidden', !!info.live);
    parts.subs.classList.toggle('hidden', !!info.live);
    parts.list.classList.toggle('hidden', !(info.live && channels.length));
    parts.drawer.classList.add('hidden');
    parts.subtitle.textContent = '';
    layer = { root: root, onBack: onBack, onKey: onKey };
    App.screens.open('player', layer);
    clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      if (!osdVisible()) return;
      if (prefs.settings.showClock) parts.clock.textContent = App.clock();
      var bytes = player.diskReserveBytes();
      parts.reserve.textContent = bytes === null ? '' : 'Reserva: ' + (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
    }, 1000);
  }

  function close() {
    if (!info) return;
    finishSeek(false);
    saveProgress(true);
    clearInterval(tickTimer);
    clearTimeout(osdTimer);
    subtitleRequest++;
    stopExternal();
    var wasLive = info.live;
    var channel = channels[channelIndex];
    var back = onReturn;
    if (!wasLive || !back) player.stop();
    info = null;
    layer = null;
    App.screens.close();
    if (back) back(wasLive ? channel : null);
  }

  return {
    /** Keeps the preview's playback when it is already the same channel. */
    openLive: function (channel, list, back) {
      channels = list && list.length ? list : [channel];
      channelIndex = Math.max(0, channels.findIndex(function (c) { return c.id === channel.id; }));
      episodes = [];
      episodeIndex = -1;
      open({ url: channel.streamUrl, title: channel.name, subtitle: channel.category, live: true, mediaId: channel.id, mediaType: 'CHANNEL', posterUrl: channel.logo }, back);
      var playing = player.current;
      if (playing && playing.live && playing.id === channel.id && player.state() !== 'NONE' && player.state() !== 'IDLE') {
        prepared = true;
        terminalError = false;
        attach();
        player.fullscreen();
        parts.loading.hide();
        updateTitle();
        showOsd(3000);
      } else start();
    },
    openVod: function (newInfo) {
      channels = [];
      episodes = newInfo.episodes || [];
      episodeIndex = newInfo.episodeIndex !== undefined ? newInfo.episodeIndex : -1;
      open(newInfo, null);
      start();
    },
    isOpen: function () { return !!info; },
    background: function () {
      if (!info) return;
      saveProgress(true);
      if (info.live) player.stop(); else player.suspend();
    },
    foreground: function () {
      if (!info) return;
      if (info.live) start(); else player.restore();
    },
  };
})();
