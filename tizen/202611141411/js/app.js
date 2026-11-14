'use strict';

// Screen stack, main shell (tabs, clock, search), TV lifecycle and start-up.
App.screens = (function () {
  var stack = [];
  return {
    get current() { return stack[stack.length - 1]; },
    reset: function (id, layer) { stack = [{ id: id, layer: layer }]; App.ui.show(id); App.nav.replaceBase(layer); },
    open: function (id, layer) { stack.push({ id: id, layer: layer }); App.ui.show(id); App.nav.push(layer); },
    close: function () {
      if (stack.length < 2) return;
      var top = stack.pop();
      App.nav.pop(top.layer);
      var prev = stack[stack.length - 1];
      App.ui.show(prev.id);
      if (prev.layer.onReturn) prev.layer.onReturn();
    },
  };
})();

App.exitApp = function () {
  try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
};

App.consumeAutoBoot = (function () {
  var consumed = false;
  return function () {
    if (consumed || !App.prefs.settings.autoBoot) return false;
    consumed = true;
    return true;
  };
})();

App.mainScreen = (function () {
  var el = App.el, ui = App.ui;
  var root = App.$('#main');
  var tabs = [['live', 'TV ao vivo'], ['movies', 'Filmes'], ['series', 'Séries'], ['24h', '24 horas'], ['favorites', 'Favoritos'], ['settings', 'Ajustes']];
  var views = null, buttons = {}, active = null, layer = null, built = false, backAt = 0, clockTimer = null;

  function build() {
    built = true;
    views = {
      live: App.liveView(false), movies: App.moviesView, series: App.seriesView,
      '24h': App.liveView(true), favorites: App.favoritesView, settings: App.settingsView,
    };
    var bar = App.$('#tabs');
    tabs.forEach(function (t) {
      buttons[t[0]] = ui.button(t[1], function () { switchTab(t[0]); }, 'tab');
      bar.appendChild(buttons[t[0]]);
    });
    var search = App.$('#btn-search');
    search.appendChild(ui.icon('search'));
    search.appendChild(document.createTextNode('Buscar'));
    search.onclick = openSearch;
  }

  function switchTab(tag) {
    if (active === tag) return;
    if (active) {
      views[active].hide();
      App.$('#' + views[active].root.id).classList.remove('active');
    }
    active = tag;
    App.kv.set('dtv.tab', tag);
    Object.keys(buttons).forEach(function (k) { buttons[k].classList.toggle('selected', k === tag); });
    views[tag].root.classList.add('active');
    views[tag].show();
  }

  function onBack() {
    var focused = App.nav.current();
    if (focused && !App.$('#topbar').contains(focused)) { App.nav.focus(buttons[active]); return; }
    if (Date.now() - backAt < 2000) App.exitApp();
    else { backAt = Date.now(); App.toast('Pressione VOLTAR novamente para sair'); }
  }

  // Search ------------------------------------------------------------------------------
  function openSearch() {
    App.catalog.buildFullLists().catch(function () {});
    var input = el('input', { class: 'input focusable', placeholder: 'Digite o nome do canal, filme ou novela…', autocomplete: 'off' });
    var results = el('div', { class: 'search-results scroll' });
    var overlay = el('div', { class: 'modal' }, [el('div', { class: 'search-box' }, [
      el('div', { class: 'search-bar' }, [ui.icon('search'), input]), results,
    ])]);
    var timer = null, query = '';
    var layer2;
    function close() { overlay.remove(); App.nav.pop(layer2); }

    function row(title, kind, items, render) {
      var list = el('div', { class: 'row-list', 'data-group': kind });
      var offset = 0;
      function add(batch) { batch.forEach(function (i) { list.appendChild(render(i)); }); offset += batch.length; }
      add(items);
      list.navKey = function (key, from) {
        if (key === App.keys.RIGHT && from === list.lastChild) {
          var more = App.catalog.search(query, kind, offset);
          var batch = kind === 'CHANNEL' ? more.channels : kind === 'MOVIE' ? more.movies : more.series;
          if (batch.length) { add(batch); return false; }
        }
        return false;
      };
      return [el('h2', { text: title }), list];
    }

    function render() {
      App.clear(results);
      query = input.value.trim();
      if (query.length < 2) { results.appendChild(el('div', { class: 'none', text: 'Digite pelo menos duas letras para pesquisar' })); return; }
      var r = App.catalog.search(query);
      if (r.channels.length) row('CANAIS AO VIVO', 'CHANNEL', r.channels, function (c) {
        return ui.channel(c, function () { close(); App.playerScreen.openLive(c, App.catalog.allPlaybackChannels(), null); });
      }).forEach(function (n) { results.appendChild(n); });
      if (r.movies.length) row('FILMES', 'MOVIE', r.movies, function (m) {
        return ui.card({ title: m.title, poster: m.poster, fav: m.isFavorite, onClick: function () { close(); App.detailsScreen.open({ movie: m }); } });
      }).forEach(function (n) { results.appendChild(n); });
      if (r.series.length) row('SÉRIES & NOVELAS', 'SERIES', r.series, function (s) {
        return ui.card({ title: s.title, poster: s.poster, fav: s.isFavorite, onClick: function () { close(); App.detailsScreen.open({ series: s }); } });
      }).forEach(function (n) { results.appendChild(n); });
      var empty = !r.channels.length && !r.movies.length && !r.series.length;
      var state = App.catalog.searchState;
      if (empty || state === 'error') {
        results.appendChild(el('div', { class: 'none', text: state === 'loading' ? 'Carregando catálogo completo…' : state === 'error'
          ? 'Não foi possível completar o catálogo. Os itens já carregados continuam disponíveis.' : 'Nenhum resultado para "' + query + '"' }));
      }
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(render, 300); });
    App.catalog.onChange(function () { if (overlay.isConnected) render(); });
    App.$('#stage').appendChild(overlay);
    layer2 = { root: overlay, initial: input, onBack: close };
    App.nav.push(layer2);
    render();
  }

  return {
    open: function () {
      if (!built) build();
      layer = {
        root: root,
        onBack: onBack,
        onReturn: function () {
          var view = views[active];
          if (view.onReturn) view.onReturn();
          if (view.resumeAfterBackground) view.resumeAfterBackground();
        },
      };
      App.screens.reset('main', layer);
      var saved = App.kv.get('dtv.tab', 'live');
      active = null;
      switchTab(views[saved] ? saved : 'live');
      setTimeout(function () {
        var initial = views[active].initialFocus && views[active].initialFocus();
        App.nav.focus(initial || buttons[active]);
      }, 50);
      clearInterval(clockTimer);
      App.$('#clock').textContent = App.clock();
      clockTimer = setInterval(function () { App.$('#clock').textContent = App.clock(); }, 1000);
      App.catalog.buildFullLists().catch(function () {});
    },
    background: function () { if (active && views[active].hide && (active === 'live' || active === '24h')) App.player.stop(); },
    foreground: function () { if (active && views[active].resumeAfterBackground && App.screens.current && App.screens.current.id === 'main') views[active].resumeAfterBackground(); },
  };
})();

(function boot() {
  function scale() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
    App.stageScale = s;
    App.$('#stage').style.transform = 'scale(' + s + ')';
  }
  scale();
  window.addEventListener('resize', scale);

  try {
    tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'ChannelUp', 'ChannelDown']);
  } catch (e) {}

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (App.playerScreen.isOpen()) App.playerScreen.background();
      else App.mainScreen.background();
    } else {
      if (App.playerScreen.isOpen()) App.playerScreen.foreground();
      else App.mainScreen.foreground();
    }
  });

  App.catalog.ready.then(function () { App.loginScreen.open(); });
  if (window.DreamerUpdate) DreamerUpdate.bootOk();
})();
