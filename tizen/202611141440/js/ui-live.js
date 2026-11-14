'use strict';

/*
 * TV ao vivo and 24 horas. The preview and the full screen share one playback: opening the full
 * screen only enlarges the video, and returning shrinks it back into the preview card.
 */
App.liveView = function (is24h) {
  var el = App.el, ui = App.ui, catalog = App.catalog, prefs = App.prefs;
  var root = App.$(is24h ? '#view-24h' : '#view-live');
  var built = false, active = false;
  var cats, chans, header, previewCard, videoBox, nameText, catText, loading, spinner;
  var allChannels = [], rawCategories = [], filtered = [], current = null, selectedCategory = null;
  var FAVORITES = 'FAV';

  function build() {
    built = true;
    cats = el('div', { class: 'list scroll' });
    chans = el('div', { class: 'list scroll' });
    header = el('div', { class: 'heading muted', text: 'CANAIS' });
    spinner = el('div', { class: 'loading-overlay hidden' }, [el('div', { class: 'spinner' })]);
    loading = ui.loadingBox();
    videoBox = el('div', { class: 'video' }, [loading.node]);
    catText = el('span', { class: 'cat-name' });
    nameText = el('div', { class: 'title' });
    previewCard = ui.focusable('div', { class: 'preview', onclick: openFullscreen }, [
      videoBox,
      el('div', { class: 'info' }, [
        el('div', { style: 'display:flex;align-items:center' }, [el('span', { class: 'badge-live', text: 'AO VIVO' }), catText]),
        nameText,
        el('div', { class: 'hint', text: 'Pressione OK para tela cheia' }),
      ]),
    ]);
    root.appendChild(el('div', { class: 'side', style: 'width:440px', 'data-group': 'cats' }, [el('div', { class: 'heading', text: 'CATEGORIAS' }), cats]));
    root.appendChild(el('div', { class: 'side', style: 'width:640px;background:var(--bg-dark);position:relative', 'data-group': 'channels' }, [header, chans, spinner]));
    root.appendChild(el('div', { class: 'preview-col' }, [previewCard]));
  }

  function adopt() {
    allChannels = is24h ? catalog.created24hChannels : catalog.liveChannels;
    rawCategories = allChannels.length ? (is24h ? catalog.created24hCategories : catalog.liveCategories) : [];
    var lastId = prefs.settings.lastChannelId;
    current = allChannels.filter(function (c) { return c.id === lastId; })[0] ||
      (current && allChannels.filter(function (c) { return c.id === current.id; })[0]) || null;
  }

  function categories() {
    var favorites = allChannels.filter(function (c) { return c.isFavorite; }).length;
    return (favorites ? [{ id: FAVORITES, name: 'FAVORITOS', count: favorites }] : []).concat(rawCategories);
  }

  function renderCategories() {
    var list = categories();
    var selected = list.filter(function (c) { return c.id === selectedCategory; })[0] ||
      (current && list.filter(function (c) { return c.name.toLowerCase() === String(current.category).toLowerCase(); })[0]) || list[0];
    App.clear(cats);
    list.forEach(function (c) {
      var node = ui.category(c, c.name, function () { selectCategory(c, true); });
      if (selected && c.id === selected.id) node.classList.add('selected');
      cats.appendChild(node);
    });
    if (selected) selectCategory(selected, false);
    else {
      selectedCategory = null;
      header.textContent = 'CANAIS';
      filtered = [];
      App.clear(chans);
      clearPreview('Nenhum canal disponível');
    }
  }

  function selectCategory(category, fromClick) {
    selectedCategory = category.id;
    var list = categories();
    App.$$('.cat', cats).forEach(function (n, i) { n.classList.toggle('selected', list[i] && list[i].id === category.id); });
    header.textContent = category.name.toUpperCase();
    filtered = category.id === FAVORITES ? allChannels.filter(function (c) { return c.isFavorite; })
      : allChannels.filter(function (c) { return String(c.category).toLowerCase() === category.name.toLowerCase(); });
    App.lazyList(chans, filtered, function (c) {
      var row = ui.channel(c, function () { playInPreview(c); }, function () { toggleFavorite(c); });
      if (current && c.id === current.id) row.classList.add('selected');
      return row;
    }, 80);
    var pick = filtered.filter(function (c) { return current && c.id === current.id; })[0] || filtered[0];
    if (pick) playInPreview(pick);
    else clearPreview('Nenhum canal nesta categoria');
    if (fromClick) chans.scrollTop = 0;
  }

  function toggleFavorite(c) {
    var now = prefs.toggleFavorite(c.id, 'CHANNEL');
    App.toast(c.name + (now ? ' adicionado aos' : ' removido dos') + ' Favoritos');
    allChannels.forEach(function (x) { if (x.id === c.id) x.isFavorite = now; });
    App.$$('.channel', chans).forEach(function (row) { if (row.dataset.id === c.id) row.classList.toggle('fav', now); });
    var focused = App.nav.current();
    var list = categories();
    var keep = selectedCategory;
    App.clear(cats);
    list.forEach(function (cat) {
      var node = ui.category(cat, cat.name, function () { selectCategory(cat, true); });
      if (cat.id === keep) node.classList.add('selected');
      cats.appendChild(node);
    });
    if (focused) App.nav.focus(focused);
  }

  function playInPreview(c) {
    current = c;
    prefs.setSetting('lastChannelId', c.id);
    App.$$('.channel', chans).forEach(function (row) { row.classList.toggle('selected', row.dataset.id === c.id); });
    previewCard.classList.remove('disabled');
    nameText.textContent = c.name;
    catText.textContent = c.category;
    startPreview();
  }

  function placeVideo() {
    var r = videoBox.getBoundingClientRect();
    var s = App.stageScale || 1;
    App.player.setRect(r.left / s, r.top / s, r.width / s, r.height / s);
  }

  function attachHandlers() {
    App.player.handlers = {
      buffering: function (pct) { loading.show(pct ? 'Carregando' : 'Conectando', pct); },
      ready: function () { loading.hide(); },
      retry: function (n, max) { loading.show('Reconectando', null, 'Tentativa ' + n + ' de ' + max); },
      error: function (message) { loading.error(message, 'Escolha outro canal ou abra a tela cheia.'); },
    };
  }

  function startPreview() {
    if (!active || !current) return;
    placeVideo();
    attachHandlers();
    var playing = App.player.current;
    if (playing && playing.live && playing.id === current.id) return;
    App.player.play({ url: current.streamUrl, live: true, id: current.id });
  }

  function clearPreview(message) {
    App.player.stop();
    loading.hide();
    current = null;
    previewCard.classList.add('disabled');
    nameText.textContent = message;
    catText.textContent = '';
  }

  function openFullscreen() {
    if (!current || filtered.every(function (c) { return c.id !== current.id; })) return;
    App.playerScreen.openLive(current, filtered, function onReturn(channel) {
      if (channel) {
        current = allChannels.filter(function (c) { return c.id === channel.id; })[0] || channel;
        if (filtered.every(function (c) { return c.id !== current.id; })) {
          var cat = rawCategories.filter(function (c) { return c.name.toLowerCase() === String(current.category).toLowerCase(); })[0];
          if (cat) selectCategory(cat, false);
        } else playInPreview(current);
      }
      startPreview();
    });
  }

  function load() {
    spinner.classList.remove('hidden');
    return (is24h ? catalog.load24hChannels() : catalog.loadLiveChannels()).then(function () {
      adopt();
      renderCategories();
      maybeAutoBoot();
      return catalog.syncChannels(is24h).then(function (changed) {
        if (changed && active) { adopt(); renderCategories(); }
      });
    }, function () {
      header.textContent = 'Não foi possível carregar os canais. Tente atualizar a lista.';
    }).then(function () { spinner.classList.add('hidden'); });
  }

  function maybeAutoBoot() {
    if (is24h || !current || !active) return;
    if (App.consumeAutoBoot(current.id)) openFullscreen();
  }

  return {
    root: root,
    show: function () {
      if (!built) build();
      active = true;
      App.$('#main').classList.add('live-mode');
      if (!allChannels.length) load();
      else {
        adopt();
        renderCategories();
        catalog.syncChannels(is24h).then(function (changed) { if (changed && active) { adopt(); renderCategories(); } });
      }
    },
    hide: function () {
      active = false;
      App.$('#main').classList.remove('live-mode');
      App.player.stop();
      loading && loading.hide();
    },
    // Returning from the full screen keeps its playback; only an idle preview starts again.
    resumeAfterBackground: function () { if (active && !App.player.current) startPreview(); },
    initialFocus: function () { return App.$('.channel.selected', chans) || App.$('.cat.selected', cats); },
  };
};
