'use strict';

// Ajustes: list refresh, playback, storage and account.
App.settingsView = (function () {
  var el = App.el, ui = App.ui, prefs = App.prefs, catalog = App.catalog;
  var root = App.$('#view-settings');
  var built = false, section = 'content';
  var nav = {}, panels = {}, titleText, descText, refreshBtn, bufferBtns = {}, bufferDesc, clockBtn, reserveBtn, autoBtn, storageText, clearBtn, accountText, versionText, layoutText, layoutBtn;
  var info = {
    content: ['Lista de conteúdo', 'Mantenha seu catálogo atualizado.'],
    playback: ['Reprodução', 'Escolha como o aplicativo prepara os vídeos.'],
    storage: ['Armazenamento', 'Consulte o espaço usado e limpe os temporários.'],
    account: ['Conta e aplicativo', 'Acesso, inicialização e informações do DreamerTV.'],
  };

  function toggleRow(title, description, button) {
    return el('div', { class: 'box row' }, [el('div', { class: 'grow' }, [el('h3', { text: title }), el('p', { text: description, style: 'margin:0' })]), button]);
  }

  function build() {
    built = true;
    var side = el('div', { class: 'settings-nav', 'data-group': 'settings-nav' }, [el('h1', { text: 'Ajustes' })]);
    Object.keys(info).forEach(function (key) {
      nav[key] = ui.button(info[key][0], function () { show(key, true); });
      side.appendChild(nav[key]);
    });
    titleText = el('h2');
    descText = el('div', { class: 'desc' });

    refreshBtn = ui.button('Atualizar canais, filmes e séries', refresh);
    layoutText = el('p');
    layoutBtn = ui.button('Restaurar ordem padrão', resetLayout);
    panels.content = el('div', {}, [el('div', { class: 'box' }, [
      el('h3', { text: 'Atualizar sua lista' }),
      el('p', { text: 'Busque novos canais, filmes e séries. Se a conexão falhar, sua lista atual será mantida.' }),
      refreshBtn,
      el('p', { class: 'small', text: 'Seu acesso, favoritos e histórico são preservados.' }),
    ]), el('div', { class: 'box' }, [
      el('h3', { text: 'Categorias de canais' }),
      layoutText,
      layoutBtn,
      el('p', { class: 'small', text: 'Para fixar ou ocultar, segure OK sobre a categoria em TV ao vivo ou 24 horas.' }),
    ])]);

    var choices = el('div', { class: 'choices' });
    Object.keys(App.bufferProfiles).forEach(function (k) {
      bufferBtns[k] = ui.button(App.bufferProfiles[k].label, function () { prefs.setSetting('bufferProfile', k); update(); });
      choices.appendChild(bufferBtns[k]);
    });
    bufferDesc = el('p', { class: 'small' });
    clockBtn = ui.button('', function () { prefs.setSetting('showClock', !prefs.settings.showClock); update(); }, 'toggle');
    reserveBtn = ui.button('', function () { prefs.setSetting('videoReserve', !prefs.settings.videoReserve); update(); }, 'toggle');
    panels.playback = el('div', {}, [
      el('div', { class: 'box' }, [el('h3', { text: 'Estabilidade da reprodução' }), choices, bufferDesc]),
      toggleRow('Reserva de vídeo', 'Baixa trechos adiante para reduzir pausas em filmes e séries. Usa até 256 MB e limpa a reserva ao fechar o vídeo. Se o vídeo não tocar assim, o player da Samsung assume.', reserveBtn),
      toggleRow('Relógio no vídeo', 'Mostra a hora junto aos controles durante a reprodução.', clockBtn),
    ]);

    storageText = el('p', { text: 'Consultando o espaço usado…' });
    clearBtn = ui.button('Limpar arquivos temporários', clearTemporary);
    panels.storage = el('div', {}, [el('div', { class: 'box' }, [
      el('h3', { text: 'Espaço usado' }), storageText, clearBtn,
      el('p', { class: 'small', text: 'Remove sinopses, trailers e recomendações guardadas. Seu catálogo, acesso, favoritos e histórico são mantidos.' }),
    ])]);

    autoBtn = ui.button('', function () { prefs.setSetting('autoBoot', !prefs.settings.autoBoot); update(); }, 'toggle');
    versionText = el('p');
    accountText = el('p');
    panels.account = el('div', {}, [
      toggleRow('Abrir no último canal', 'Ao abrir o DreamerTV, inicia o último canal assistido em tela cheia.', autoBtn),
      el('div', { class: 'box' }, [
        el('h3', { text: 'Aplicativo' }), versionText,
        el('div', { class: 'attribution', text: 'Informações de filmes e séries: TMDB.\nThis product uses the TMDB API but is not endorsed or certified by TMDB.' }),
      ]),
      el('div', { class: 'box' }, [el('h3', { text: 'Sua conta' }), accountText, ui.button('Desconectar', logout)]),
    ]);

    var mainCol = el('div', { class: 'settings-main' }, [titleText, descText, el('div', { class: 'scroll', style: 'flex:1', 'data-group': 'settings-body' }, [
      panels.content, panels.playback, panels.storage, panels.account,
    ])]);
    root.appendChild(side);
    root.appendChild(mainCol);
  }

  function show(key, fromClick) {
    section = key;
    Object.keys(panels).forEach(function (k) { panels[k].classList.toggle('hidden', k !== key); nav[k].classList.toggle('selected', k === key); });
    titleText.textContent = info[key][0];
    descText.textContent = info[key][1];
    if (key === 'storage') updateStorage();
    if (fromClick) {
      var first = App.$('.focusable', panels[key]);
      if (first) App.nav.focus(first);
    }
  }

  function update() {
    var profile = prefs.settings.bufferProfile;
    Object.keys(bufferBtns).forEach(function (k) { bufferBtns[k].classList.toggle('selected', k === profile); });
    bufferDesc.textContent = (App.bufferProfiles[profile] || App.bufferProfiles.ULTRA_STABLE).description;
    reserveBtn.textContent = prefs.settings.videoReserve !== false ? 'Ativada' : 'Desativada';
    reserveBtn.classList.toggle('selected', prefs.settings.videoReserve !== false);
    clockBtn.textContent = prefs.settings.showClock ? 'Ativado' : 'Desativado';
    clockBtn.classList.toggle('selected', prefs.settings.showClock);
    autoBtn.textContent = prefs.settings.autoBoot ? 'Ativado' : 'Desativado';
    autoBtn.classList.toggle('selected', prefs.settings.autoBoot);
    versionText.textContent = 'DreamerTV ' + (App.config.version || '1.0.0') + ' para Samsung' + updateLines();
    updateLayout();
    accountText.textContent = 'Usuário conectado: ' + prefs.username + '\nServidor: ' + prefs.serverUrl;
  }

  var LISTS = [['live', 'TV ao vivo', function () { return catalog.liveCategories; }], ['24h', '24 horas', function () { return catalog.created24hCategories; }]];

  /** Pinned and hidden categories per list; a name missing from the current list is marked. */
  function updateLayout() {
    var cl = App.categoryLayout, lines = [];
    LISTS.forEach(function (list) {
      var l = cl.get(list[0]);
      var present = (list[2]() || []).map(function (c) { return cl.norm(c.name); });
      var show = function (n) { return n + (present.length && present.indexOf(cl.norm(n)) < 0 ? ' (fora da lista atual)' : ''); };
      if (l.pins.length) lines.push(list[1] + ', fixadas: ' + l.pins.map(show).join(', '));
      if (l.hidden.length) lines.push(list[1] + ', ocultas: ' + l.hidden.map(show).join(', '));
    });
    layoutText.textContent = lines.length ? lines.join('\n') : 'Nenhuma categoria fixada ou oculta.';
    layoutBtn.classList.toggle('disabled', !lines.length);
  }

  function resetLayout() {
    if (layoutBtn.classList.contains('disabled')) return;
    LISTS.forEach(function (list) { App.categoryLayout.reset(list[0]); });
    updateLayout();
    App.toast('Categorias na ordem padrão');
  }

  function versionDate(v) {
    var s = String(v);
    return s.length === 12 ? s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12) : '';
  }

  function updateLines() {
    var u = window.DreamerUpdate && DreamerUpdate.info();
    if (!u || !u.running) return '';
    var text = '\nCódigo: ' + versionDate(u.running) + (u.online ? ' (atualização automática)' : '');
    if (u.pending) text += '\nAtualização pendente: ' + versionDate(u.pending);
    return text;
  }

  function updateStorage() {
    catalog.storageEstimate().then(function (bytes) {
      storageText.textContent = bytes === null ? 'Não foi possível consultar o espaço usado.' : 'Catálogo e dados salvos: ' + Math.round(bytes / 1048576) + ' MB';
    });
  }

  function refresh() {
    if (refreshBtn.classList.contains('disabled')) return;
    refreshBtn.classList.add('disabled');
    refreshBtn.textContent = 'Atualizando lista…';
    catalog.refreshAll().then(function () {
      App.discovery.invalidate();
      App.toast('Lista atualizada com sucesso!');
    }, function () {
      App.toast('Não foi possível atualizar. O catálogo anterior foi mantido.', 4000);
    }).then(function () {
      refreshBtn.classList.remove('disabled');
      refreshBtn.textContent = 'Atualizar canais, filmes e séries';
    });
  }

  function clearTemporary() {
    App.reservePlayer.clear();
    App.discovery.clearCaches().then(function () {
      updateStorage();
      App.toast('Temporários limpos. Seu catálogo foi preservado.');
    });
  }

  function logout() {
    App.dialog.confirm('Desconectar desta conta?', 'Para assistir novamente, será preciso informar os dados de acesso.', [
      { label: 'Cancelar', primary: true },
      { label: 'Desconectar', action: function () {
        App.player.stop();
        catalog.logout().then(function () { App.loginScreen.open(); });
      } },
    ]);
  }

  return {
    root: root,
    show: function () { if (!built) build(); show(section, false); update(); },
    hide: function () {},
    initialFocus: function () { return nav[section]; },
  };
})();
