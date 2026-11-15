'use strict';

// Filmes, Séries, Favoritos, the details screen, the episode list and the trailer.
(function () {
  var el = App.el, ui = App.ui, catalog = App.catalog, prefs = App.prefs;
  var CONTINUE = 'continue_watching', PICKS = 'dreamer_recommendations';

  function progressOf(item) {
    return item.durationMs > 0 ? Math.max(5, Math.min(100, Math.round(item.positionMs / item.durationMs * 100))) : null;
  }

  // Playback descriptions -----------------------------------------------------

  function moviePlayback(movie, restart) {
    if (restart) prefs.savePosition(movie.id, 0, 'MOVIE');
    return {
      url: catalog.refreshUrl(movie.streamUrl), title: movie.title, subtitle: movie.categoryName || '', live: false,
      startMs: restart ? 0 : prefs.savedPosition(movie.id, 'MOVIE'), posterUrl: movie.poster, mediaId: movie.id, mediaType: 'MOVIE',
    };
  }

  function episodePlayback(series, episode, episodes) {
    return {
      url: catalog.refreshUrl(episode.streamUrl), title: series.title + ' - ' + episode.title,
      subtitle: App.season.display(episode.season) + ' (' + episode.episodeCode + ')', live: false,
      startMs: prefs.savedPosition(episode.id, 'EPISODE'), episodes: episodes,
      episodeIndex: episodes.findIndex(function (e) { return e.id === episode.id; }),
      posterUrl: series.poster, mediaId: episode.id, mediaType: 'EPISODE', seriesId: series.id, seriesTitle: series.title,
      seriesEpisodesUrl: series.episodesUrl, season: episode.season, episodeCode: episode.episodeCode,
    };
  }

  /** Rebuilds a history entry, recovering the series only from an unambiguous title prefix. */
  function historyPlayback(item) {
    var h = catalog.enrichHistory(item);
    var seriesId = h.seriesId || '', seriesTitle = h.seriesTitle || '', seriesUrl = h.seriesEpisodesUrl || '';
    if (h.mediaType === 'EPISODE' && !seriesId) {
      var candidates = catalog.allSeries.filter(function (s) { return h.title.toLowerCase().indexOf(s.title.toLowerCase() + ' - ') === 0; });
      var longest = Math.max.apply(null, candidates.map(function (s) { return s.title.length; }).concat([0]));
      var inferred = candidates.filter(function (s) { return s.title.length === longest; });
      if (inferred.length === 1) { seriesId = inferred[0].id; seriesTitle = inferred[0].title; seriesUrl = inferred[0].episodesUrl; }
    }
    var series = h.mediaType === 'EPISODE' && seriesId ? { id: seriesId, title: seriesTitle, poster: h.poster, episodesUrl: seriesUrl } : null;
    var load = series ? catalog.loadEpisodes(series).catch(function () { return []; }) : Promise.resolve([]);
    return load.then(function (episodes) {
      var episode = episodes.filter(function (e) { return e.id === h.id; })[0];
      return {
        url: catalog.refreshUrl(episode ? episode.streamUrl : h.streamUrl), title: h.title, subtitle: h.subtitle, live: false,
        startMs: prefs.savedPosition(h.id, h.mediaType), episodes: episodes, episodeIndex: episodes.findIndex(function (e) { return e.id === h.id; }),
        posterUrl: h.poster, mediaId: h.id, mediaType: h.mediaType, seriesId: seriesId, seriesTitle: seriesTitle,
        seriesEpisodesUrl: seriesUrl, season: episode ? episode.season : h.season || '', episodeCode: episode ? episode.episodeCode : h.episodeCode || '',
      };
    });
  }

  function playWithResumeChoice(info) {
    if (info.startMs <= 0) { App.playerScreen.openVod(info); return; }
    App.dialog.confirm(info.title, null, [
      { label: 'Cancelar' },
      { label: 'Assistir do início', action: function () { prefs.savePosition(info.mediaId, 0, info.mediaType); App.playerScreen.openVod(Object.assign({}, info, { startMs: 0 })); } },
      { label: 'Continuar (' + App.positionLabel(info.startMs) + ')', primary: true, action: function () { App.playerScreen.openVod(info); } },
    ]);
  }

  // Episode list ------------------------------------------------------------------

  function showEpisodes(series) {
    var overlay = el('div', { class: 'modal' });
    var seasonsList = el('div', { class: 'list scroll', 'data-group': 'seasons' });
    var episodesList = el('div', { class: 'list scroll', 'data-group': 'episodes' });
    var heading = el('h3', { text: 'Episódios' });
    var status = el('div', { class: 'grid-summary hidden', style: 'margin:24px 0' });
    var spinner = el('div', { class: 'spinner', style: 'margin:48px auto' });
    var retry = ui.button('Tentar novamente', load);
    retry.classList.add('hidden');
    var close = ui.button('Fechar', function () { finish(); });
    close.style.width = '200px';
    var posterBox = el('div', { class: 'poster' });
    if (series.poster) posterBox.style.backgroundImage = 'url("' + series.poster + '")';
    var panel = el('div', { class: 'episodes-panel' }, [
      el('div', { class: 'top' }, [
        el('div', { class: 'info' }, [el('div', { class: 'stitle', text: series.title }), el('div', { class: 'scat', text: series.categoryName || '' })]),
        close,
      ]),
      el('div', { class: 'cols' }, [
        el('div', { class: 'pcol' }, [posterBox, el('p', { text: 'Escolha uma temporada e um episódio para assistir.' })]),
        el('div', { class: 'scol' }, [el('h3', { text: 'Temporadas' }), seasonsList]),
        el('div', { class: 'ecol' }, [heading, spinner, status, retry, episodesList]),
      ]),
    ]);
    overlay.appendChild(panel);
    App.$('#stage').appendChild(overlay);
    var layer = { root: overlay, initial: close, onBack: function () { finish(); } };
    var done = false;
    function finish() { if (done) return; done = true; overlay.remove(); App.nav.pop(layer); }
    App.nav.push(layer);
    var all = [];

    function showSeason(season, focusFirst) {
      var items = all.filter(function (e) { return e.season.toLowerCase() === season.toLowerCase(); });
      App.$$('.choice', seasonsList).forEach(function (n) { n.classList.toggle('selected', n.dataset.season === season); });
      heading.textContent = App.season.display(season) + ' · ' + items.length + (items.length === 1 ? ' episódio' : ' episódios');
      var watched = prefs.watchedEpisodes();
      App.lazyList(episodesList, items, function (ep) {
        return ui.focusable('div', { class: 'episode', onclick: function () {
          prefs.saveLastSeason(series.id, ep.season);
          finish();
          playWithResumeChoice(episodePlayback(series, ep, all));
        } }, [
          el('span', { class: 'code', text: ep.episodeCode }),
          el('span', { class: 'et', text: ep.title }),
          watched.indexOf(ep.id) >= 0 ? el('span', { class: 'seen', text: 'VISTO' }) : null,
        ]);
      }, 60);
      episodesList.scrollTop = 0;
      if (focusFirst && episodesList.firstChild) App.nav.focus(episodesList.firstChild);
    }

    function load() {
      spinner.classList.remove('hidden');
      status.classList.add('hidden');
      retry.classList.add('hidden');
      catalog.loadEpisodes(series).then(function (episodes) {
        if (done) return;
        spinner.classList.add('hidden');
        all = episodes;
        var seasons = [];
        episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
        var saved = prefs.lastSeason(series.id);
        var initial = seasons.filter(function (s) { return saved && s.toLowerCase() === saved.toLowerCase(); })[0] || seasons[0];
        App.clear(seasonsList);
        seasons.forEach(function (season) {
          var count = episodes.filter(function (e) { return e.season === season; }).length;
          var countText = count + (count === 1 ? ' episódio' : ' episódios');
          var node = ui.focusable('div', { class: 'choice', onclick: function () { showSeason(season, true); } }, [
            el('span', { text: App.season.display(season) }),
            el('small', { text: saved && season.toLowerCase() === saved.toLowerCase() ? countText + ' · Atual' : countText }),
          ]);
          node.dataset.season = season;
          seasonsList.appendChild(node);
        });
        if (initial) {
          showSeason(initial, false);
          var node = App.$$('.choice', seasonsList).filter(function (n) { return n.dataset.season === initial; })[0];
          if (node) App.nav.focus(node);
        } else {
          status.textContent = 'Nenhum episódio disponível nesta série.';
          status.classList.remove('hidden');
        }
      }, function () {
        if (done) return;
        spinner.classList.add('hidden');
        status.textContent = 'Não foi possível carregar os episódios. Confira a conexão e tente novamente.';
        status.classList.remove('hidden');
        retry.classList.remove('hidden');
        App.nav.focus(retry);
      });
    }
    load();
  }

  // Details screen -------------------------------------------------------------------

  App.detailsScreen = (function () {
    var root = App.$('#details');
    var state = null;
    var parts = null;

    function build() {
      parts = {
        backdrop: el('div', { class: 'backdrop' }),
        poster: el('div', { class: 'poster' }),
        eyebrow: el('div', { class: 'eyebrow' }),
        title: el('div', { class: 'dtitle' }),
        facts: el('div', { class: 'facts' }),
        synopsis: el('div', { class: 'synopsis' }),
        status: el('div', { class: 'status' }),
      };
      parts.close = ui.button('Voltar', function () { App.screens.close(); });
      parts.close.style.width = '200px';
      parts.watch = ui.button('Assistir Agora', function () { watch(false); });
      parts.trailer = ui.button('Trailer', openTrailer);
      parts.favorite = ui.button('Favoritar', toggleFavorite);
      parts.restart = ui.button('Assistir do início', function () {
        if (state.series && state.history) showEpisodes(state.series);
        else watch(true);
      }, 'restart');
      root.appendChild(parts.backdrop);
      root.appendChild(el('div', { class: 'shade' }));
      root.appendChild(el('div', { class: 'wrap' }, [
        el('div', { class: 'head' }, [el('span', { text: 'DreamerTV' }), parts.close]),
        el('div', { class: 'body' }, [
          parts.poster,
          el('div', { class: 'col' }, [
            parts.eyebrow, parts.title, parts.facts, parts.synopsis, parts.status,
            el('div', { class: 'actions' }, [parts.watch, parts.trailer, parts.favorite]),
            el('div', {}, [parts.restart]),
          ]),
        ]),
      ]));
    }

    function isSeries() { return !!state.series || (state.history && state.history.mediaType !== 'MOVIE'); }

    function resolveHistory() {
      var h = state.history;
      if (!h) return;
      h = state.history = catalog.enrichHistory(h);
      if (h.mediaType === 'MOVIE') {
        state.movie = catalog.findMovie(h.id) || { id: h.id, title: h.title, poster: h.poster, categoryName: h.subtitle, description: '', streamUrl: h.streamUrl };
      } else if (h.seriesId) {
        state.series = catalog.findSeries(h.seriesId) || { id: h.seriesId, title: h.seriesTitle || h.title.split(' - ')[0], poster: h.poster, categoryName: '', description: '', episodesUrl: h.seriesEpisodesUrl || '' };
      }
    }

    function render() {
      var d = state.details;
      parts.eyebrow.textContent = state.recommendation ? 'SELEÇÃO DREAMER' : isSeries() ? 'SÉRIE' : 'FILME';
      parts.title.textContent = d.title;
      parts.facts.textContent = [d.year, d.runtime, d.genres].filter(Boolean).join('  ·  ');
      parts.synopsis.textContent = d.overview || 'Sinopse em português não disponível para este título.';
      parts.poster.style.backgroundImage = d.poster ? 'url("' + d.poster + '")' : '';
      parts.backdrop.style.backgroundImage = d.backdrop ? 'url("' + d.backdrop + '")' : '';
      var text = '';
      if (state.loading) text = 'Buscando sinopse e trailer…';
      else if (state.recommendation && !state.catalogReady) text = 'Não foi possível conferir a disponibilidade. Atualize a lista e tente novamente.';
      else if (state.recommendation && state.unconfirmed) text = state.candidates.length ? 'Há itens com título compatível no servidor, mas faltam dados para confirmar a edição. Você pode conferir as opções no catálogo.' : 'Não foi possível confirmar a edição deste filme no servidor. A reprodução fica indisponível para evitar abrir outro filme com o mesmo nome.';
      else if (state.recommendation && !state.movie) text = 'Não disponível no catálogo com título e ano confirmados.';
      else if (d.fromTmdb) text = d.trailerLanguage && d.trailerLanguage !== 'pt' ? 'Informações: TMDB · Trailer em outro idioma' : 'Informações: TMDB';
      else if (state.recommendation) text = 'Informações: seleção Dreamer';
      else if (!d.trailerId) text = 'Não foi encontrado um trailer para este título.';
      parts.status.textContent = text;
      updateActions();
    }

    function updateActions() {
      var position = state.movie ? prefs.savedPosition(state.movie.id, 'MOVIE') : 0;
      var label = state.unconfirmed && state.candidates.length ? 'Ver opções no catálogo' : state.series ? 'Temporadas e episódios' : 'Assistir Agora';
      if (state.history && isSeries()) label = 'Continuar episódio';
      else if (position > 0 && !state.series) label = 'Continuar (' + App.positionLabel(position) + ')';
      parts.watch.textContent = label;
      parts.watch.classList.toggle('disabled', !(state.movie || state.series || state.history || state.candidates.length));
      parts.restart.classList.toggle('hidden', !((position > 0 && !state.series) || (state.series && state.history)));
      parts.restart.textContent = state.series ? 'Temporadas e episódios' : 'Assistir do início';
      parts.trailer.classList.toggle('disabled', !state.details.trailerId);
      parts.favorite.classList.toggle('disabled', !(state.movie || state.series));
      var fav = state.movie ? prefs.isFavorite(state.movie.id, 'MOVIE') : state.series ? prefs.isFavorite(state.series.id, 'SERIES') : false;
      parts.favorite.textContent = fav ? 'Favoritado' : 'Favoritar';
    }

    function watch(restart) {
      if (!state.movie && state.unconfirmed && state.candidates.length) { showCatalogOptions(); return; }
      if (state.history && isSeries()) {
        historyPlayback(state.history).then(App.playerScreen.openVod, function () { App.toast('Não foi possível retomar este item. Tente novamente.'); });
        return;
      }
      if (state.series) { showEpisodes(state.series); return; }
      if (!state.movie) return;
      if (state.sources.length > 1) {
        App.dialog.choose('Escolha a versão disponível', state.sources.map(function (m) {
          return { label: m.title, action: function () { App.playerScreen.openVod(moviePlayback(m, restart)); } };
        }));
      } else App.playerScreen.openVod(moviePlayback(state.movie, restart));
    }

    function showCatalogOptions() {
      var overlay = el('div', { class: 'modal' });
      var cards = el('div', { class: 'cards' });
      var box = el('div', { class: 'modal-box wide', style: 'height:960px' }, [
        el('div', { class: 'modal-title', text: 'Ver opções no catálogo' }),
        el('div', { class: 'modal-message', text: 'A edição não pôde ser confirmada. Confira a capa e os dados do item antes de assistir.' }),
        el('div', { class: 'scroll', style: 'flex:1' }, [cards]),
      ]);
      var layer;
      function close() { overlay.remove(); App.nav.pop(layer); }
      state.candidates.forEach(function (m) {
        cards.appendChild(ui.card({ title: m.title, poster: m.poster, onClick: function () { close(); App.detailsScreen.open({ movie: m }); } }));
      });
      box.appendChild(ui.button('Voltar', close));
      overlay.appendChild(box);
      App.$('#stage').appendChild(overlay);
      layer = { root: overlay, onBack: close };
      App.nav.push(layer);
    }

    function toggleFavorite() {
      if (state.movie) prefs.toggleFavoriteMovie(state.movie);
      else if (state.series) prefs.toggleFavoriteSeries(state.series);
      updateActions();
    }

    function openTrailer() {
      if (state.details.trailerId) App.trailerScreen.open(state.details.trailerId, state.details.title);
      else App.toast('Não foi encontrado um trailer para este título.');
    }

    function loadDetails(token) {
      var title = (state.movie && state.movie.title) || (state.series && state.series.title) || state.details.title;
      var poster = (state.movie && state.movie.poster) || (state.series && state.series.poster) || state.details.poster;
      var first = isSeries() ? Promise.resolve(null) : App.discovery.websiteDetails(title);
      return first.then(function (site) {
        return site || App.discovery.details(title, isSeries(), poster);
      }).then(function (fetched) {
        if (token !== state) return;
        if (fetched) {
          var prev = state.details;
          state.details = Object.assign({}, fetched, {
            overview: fetched.overview || prev.overview, poster: fetched.poster || prev.poster, genres: fetched.genres || prev.genres,
          });
        }
      });
    }

    function open(input) {
      if (!parts) build();
      state = {
        movie: input.movie || null, series: input.series || null, history: input.history || null,
        recommendation: input.recommendation || null, sources: [], candidates: [], unconfirmed: false,
        catalogReady: input.catalogReady !== false, loading: true,
      };
      resolveHistory();
      var title = (state.recommendation && state.recommendation.film.title) || (state.movie && state.movie.title) ||
        (state.series && state.series.title) || (state.history && (state.history.seriesTitle || state.history.title.split(' - ')[0]));
      state.details = state.recommendation ? Object.assign({}, state.recommendation.film.details) : {
        title: title, year: App.identity.parse(title).year,
        overview: (state.movie && state.movie.description) || (state.series && state.series.description) || '',
        poster: (state.movie && state.movie.poster) || (state.series && state.series.poster) || (state.history && state.history.poster) || '',
        genres: (state.movie && state.movie.categoryName) || (state.series && state.series.categoryName) || '',
      };
      if (state.recommendation) {
        var rec = state.recommendation;
        state.sources = rec.sources;
        state.candidates = rec.candidates;
        state.movie = rec.sources[0] || null;
        state.unconfirmed = rec.availability === 'UNCONFIRMED' || rec.availability === 'CHECKING';
      }
      var token = state;
      render();
      var layer = {
        root: root,
        initial: parts.watch.classList.contains('disabled') ? (parts.trailer.classList.contains('disabled') ? parts.close : parts.trailer) : parts.watch,
        onBack: function () { App.screens.close(); },
        onReturn: function () {
          if (state.history && isSeries()) {
            var key = prefs.seriesKey(state.history);
            var latest = prefs.history().filter(function (h) { return prefs.isSeriesItem(h) && prefs.seriesKey(h) === key; })[0];
            if (latest) state.history = latest;
          }
          updateActions();
        },
      };
      App.screens.open('details', layer);
      var work = state.recommendation ? Promise.resolve() : catalog.ready.then(function () { resolveHistory(); return loadDetails(token); });
      work.catch(function () {}).then(function () {
        if (token !== state) return;
        state.loading = false;
        if (state.movie) {
          state.movie = Object.assign({}, state.movie, {
            poster: state.movie.poster || state.details.poster, description: state.movie.description || state.details.overview,
          });
        }
        render();
      });
    }

    return { open: open };
  })();

  // Trailer ----------------------------------------------------------------------------

  App.trailerScreen = (function () {
    var root = App.$('#trailer');
    var frame, title, status, playBtn, playing = true, layer;

    function command(func) {
      try { frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: [] }), '*'); } catch (e) {}
    }

    function close() {
      App.clear(App.$('.frame', root));
      window.removeEventListener('message', onMessage);
      App.screens.close();
    }

    function onMessage(e) {
      if (!/youtube/.test(String(e.origin))) return;
      var data;
      try { data = JSON.parse(e.data); } catch (x) { return; }
      if (data.event === 'onReady' || (data.event === 'infoDelivery' && data.info && data.info.playerState === 1)) {
        status.textContent = 'YouTube · Use Reproduzir / pausar ou os controles do vídeo. VOLTAR fecha o trailer.';
      }
      if (data.event === 'onError') status.textContent = 'Este trailer não pode ser reproduzido aqui. Você pode voltar e assistir ao conteúdo normalmente.';
    }

    return {
      open: function (id, name) {
        if (!frame) {
          title = el('div', { class: 'ttitle' });
          playBtn = ui.button('Reproduzir / pausar', function () { playing = !playing; command(playing ? 'playVideo' : 'pauseVideo'); });
          status = el('div', { class: 'tstatus' });
          root.appendChild(el('div', { class: 'bar' }, [title, playBtn, ui.button('Voltar', close)]));
          root.appendChild(el('div', { class: 'frame' }));
          root.appendChild(status);
        }
        title.textContent = name;
        status.textContent = 'Preparando trailer…';
        playing = true;
        frame = el('iframe', { allow: 'autoplay; encrypted-media', src: 'https://www.youtube.com/embed/' + id + '?autoplay=1&enablejsapi=1&rel=0&playsinline=1&fs=0&hl=pt' });
        frame.onload = function () {
          try { frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*'); } catch (e) {}
        };
        App.$('.frame', root).appendChild(frame);
        window.addEventListener('message', onMessage);
        layer = {
          root: root,
          initial: playBtn,
          onBack: close,
          onKey: function (e) {
            var K = App.keys;
            if ([K.PLAY_PAUSE, K.PLAY, K.PAUSE].indexOf(e.keyCode) >= 0) {
              playing = e.keyCode === K.PLAY ? true : e.keyCode === K.PAUSE ? false : !playing;
              command(playing ? 'playVideo' : 'pauseVideo');
              return true;
            }
            return false;
          },
        };
        App.screens.open('trailer', layer);
        setTimeout(function () {
          if (status.textContent === 'Preparando trailer…') status.textContent = 'Não foi possível carregar o trailer. Confira a conexão e tente novamente.';
        }, 20000);
      },
    };
  })();

  // Movie and series grids ---------------------------------------------------------------

  function vodView(series) {
    var root = App.$(series ? '#view-series' : '#view-movies');
    var built = false, active = false;
    var cats, grid, title, summary, cards, spinner;
    var selected = null, request = 0, recSignal = null;

    function build() {
      built = true;
      cats = el('div', { class: 'list scroll' });
      title = el('div', { class: 'grid-title' });
      summary = el('div', { class: 'grid-summary hidden' });
      cards = el('div', { class: 'cards' });
      grid = el('div', { class: 'grid scroll', 'data-group': 'grid' }, [title, summary, cards]);
      spinner = el('div', { class: 'loading-overlay hidden' }, [el('div', { class: 'spinner' })]);
      root.appendChild(el('div', { class: 'side', style: 'width:480px', 'data-group': 'cats' }, [el('div', { class: 'heading', text: 'GÊNEROS' }), cats]));
      root.appendChild(el('div', { class: 'grid-area' }, [grid, spinner]));
    }

    function categories() {
      var fixed = [{ id: CONTINUE, name: 'Continuar assistindo' }];
      if (!series) fixed.push({ id: PICKS, name: 'Dreamer indica' });
      return fixed.concat(series ? catalog.serieCategories : catalog.movieCategories);
    }

    function displayName(c) { return series ? App.categoryName.series(c.name) : App.categoryName.movie(c.name); }

    function renderCategories(reload) {
      var list = categories();
      var chosen = list.filter(function (c) { return c.id === selected; })[0];
      if (!chosen && selected && !reload) chosen = null;
      var activeCat = chosen || list[0];
      var focused = App.nav.current();
      var focusId = focused && focused.dataset ? focused.dataset.cat : null;
      App.clear(cats);
      list.forEach(function (c) {
        var node = ui.category({}, displayName(c), function () { select(c, true); });
        node.dataset.cat = c.id;
        if (c.id === activeCat.id) node.classList.add('selected');
        cats.appendChild(node);
      });
      if (focusId) {
        var again = App.$$('.cat', cats).filter(function (n) { return n.dataset.cat === focusId; })[0];
        if (again) App.nav.focus(again);
      }
      if (reload || selected !== activeCat.id) select(activeCat, false);
    }

    function setSummary(text) { summary.textContent = text || ''; summary.classList.toggle('hidden', !text); }

    function select(c, resetScroll) {
      var mine = ++request;
      if (recSignal) recSignal.cancelled = true;
      selected = c.id;
      App.$$('.cat', cats).forEach(function (n) { n.classList.toggle('selected', n.dataset.cat === c.id); });
      title.textContent = c.id === PICKS ? 'Dreamer indica' : displayName(c).toUpperCase();
      setSummary('');
      if (resetScroll) grid.scrollTop = 0;
      if (c.id === CONTINUE) { renderHistory(); return; }
      if (c.id === PICKS) { renderRecommendations(mine); return; }
      App.clear(cards);
      spinner.classList.remove('hidden');
      (series ? catalog.loadSeries(c) : catalog.loadMovies(c)).then(function (items) {
        if (mine !== request) return;
        spinner.classList.add('hidden');
        App.lazyList(cards, items, function (item) {
          return ui.card({
            title: item.title, poster: item.poster, fav: item.isFavorite,
            onClick: function () { App.detailsScreen.open(series ? { series: item } : { movie: item }); },
            onLong: function (e) {
              var added = series ? prefs.toggleFavoriteSeries(item) : prefs.toggleFavoriteMovie(item);
              e.currentTarget.classList.toggle('is-fav', added);
              App.toast(added ? 'Adicionado aos Favoritos' : 'Removido dos Favoritos');
            },
          });
        }, 50);
      }, function () {
        if (mine !== request) return;
        spinner.classList.add('hidden');
        App.toast(series ? 'Não foi possível carregar as séries. Tente novamente.' : 'Não foi possível carregar os filmes. Tente novamente.');
      });
    }

    function renderHistory() {
      spinner.classList.add('hidden');
      var items = (series ? prefs.seriesHistory() : prefs.movieHistory()).map(catalog.enrichHistory);
      setSummary(items.length ? 'Segure OK sobre um título para removê-lo desta lista.' : series ? 'As séries que você começar a assistir aparecerão aqui.' : 'Os filmes que você começar a assistir aparecerão aqui.');
      App.lazyList(cards, items, function (item) {
        return ui.card({
          title: series ? item.seriesTitle || item.title : item.title, poster: item.poster, progress: progressOf(item),
          sub: App.season.displaySubtitle(item.subtitle || ''),
          onClick: function () { App.detailsScreen.open({ history: item }); },
          onLong: function () {
            if (series) prefs.removeSeriesHistory(item); else prefs.removeHistory(item.id, item.mediaType);
            App.toast(series ? 'Série removida de Continuar Assistindo' : item.title + ' removido de Continuar Assistindo');
            renderHistory();
            App.nav.refocus();
          },
        });
      }, 50);
    }

    function renderRecommendations(mine) {
      App.clear(cards);
      spinner.classList.remove('hidden');
      setSummary('Carregando as recomendações do Dreamer…');
      var signal = recSignal = { cancelled: false };
      var first = true;
      catalog.buildFullLists().catch(function () {}).then(function () {
        if (signal.cancelled) return;
        return App.discovery.recommendations(function (page) {
          if (signal.cancelled || mine !== request) return;
          spinner.classList.add('hidden');
          var focusedIndex = -1;
          var focused = App.nav.current();
          if (focused && cards.contains(focused)) focusedIndex = Array.prototype.indexOf.call(cards.children, focused);
          var available = page.films.filter(function (f) { return f.sources.length; }).length;
          var unconfirmed = page.films.filter(function (f) { return f.availability === 'UNCONFIRMED'; }).length;
          setSummary(page.verifying ? 'Conferindo disponibilidade: ' + page.checked + ' de ' + page.total
            : page.stale ? 'Exibindo a última seleção salva. A atualização será tentada novamente.'
            : !page.catalogReady ? 'Não foi possível conferir a disponibilidade. Atualize a lista e tente novamente.'
            : 'Seleção: ' + page.films.length + ' · Disponíveis: ' + available + ' · A confirmar: ' + unconfirmed);
          App.clear(cards);
          page.films.forEach(function (row) {
            var year = row.film.year;
            var status = !page.catalogReady ? year + ' · A conferir' : row.availability === 'CHECKING' ? year + ' · Conferindo'
              : row.availability === 'UNCONFIRMED' ? year + ' · A confirmar' : row.availability === 'UNAVAILABLE' ? year + ' · Indisponível' : year + ' · Disponível';
            cards.appendChild(ui.card({
              title: row.film.title, poster: row.film.details.poster, sub: status, subMuted: true,
              dim: page.catalogReady && row.availability === 'UNAVAILABLE',
              onClick: function () { App.detailsScreen.open({ recommendation: row, catalogReady: page.catalogReady }); },
            }));
          });
          if (focusedIndex >= 0 && cards.children[focusedIndex]) App.nav.focus(cards.children[focusedIndex]);
          if (first) { first = false; grid.scrollTop = 0; }
        }, signal);
      }).catch(function () {
        if (mine !== request) return;
        spinner.classList.add('hidden');
        setSummary('Não foi possível carregar as recomendações. Selecione Dreamer indica para tentar novamente.');
      });
    }

    return {
      root: root,
      show: function () {
        if (!built) build();
        active = true;
        renderCategories(true);
        catalog.syncCategories(series).then(function () {
          if (!active) return;
          renderCategories(false);
          return catalog.verifyCategories(series).then(function (changed) { if (changed && active) renderCategories(false); });
        }).catch(function () { if (active) App.toast('Não foi possível carregar as categorias. Tente novamente.'); });
      },
      hide: function () { active = false; if (recSignal) recSignal.cancelled = true; },
      onReturn: function () {
        if (selected === CONTINUE) renderHistory();
      },
      initialFocus: function () { return App.$('.cat.selected', cats); },
    };
  }

  App.moviesView = vodView(false);
  App.seriesView = vodView(true);

  // Favorites ---------------------------------------------------------------------------

  App.favoritesView = (function () {
    var root = App.$('#view-favorites');
    function section(titleText, items, render) {
      var row = el('div', { class: 'row-list', 'data-group': titleText });
      items.forEach(function (i) { row.appendChild(render(i)); });
      return el('div', { class: 'fav-section' }, [el('h2', { text: titleText }), row]);
    }
    function render() {
      App.clear(root);
      var channels = catalog.favoriteChannels(), movies = catalog.favoriteMovies(), shows = catalog.favoriteSeries();
      if (!channels.length && !movies.length && !shows.length) {
        root.appendChild(el('div', { class: 'empty' }, [
          ui.icon('star'),
          el('div', { class: 'big', text: 'Nenhum favorito adicionado ainda' }),
          el('div', { class: 'small', text: 'Para adicionar qualquer canal, filme ou novela aqui,\nbasta segurar o botão OK do controle remoto em cima dele.' }),
        ]));
        return;
      }
      var box = el('div', { class: 'scroll', style: 'flex:1' });
      if (channels.length) box.appendChild(section('CANAIS FAVORITOS', channels, function (c) {
        return ui.channel(c, function () { App.playerScreen.openLive(c, channels, null); }, function () {
          prefs.toggleFavorite(c.id, 'CHANNEL'); App.toast('Removido dos Favoritos'); render(); App.nav.refocus();
        });
      }));
      if (movies.length) box.appendChild(section('FILMES FAVORITOS', movies, function (m) {
        return ui.card({ title: m.title, poster: m.poster, fav: true, onClick: function () { App.detailsScreen.open({ movie: m }); },
          onLong: function () { prefs.toggleFavoriteMovie(m); App.toast('Removido dos Favoritos'); render(); App.nav.refocus(); } });
      }));
      if (shows.length) box.appendChild(section('SÉRIES & NOVELAS FAVORITAS', shows, function (s) {
        return ui.card({ title: s.title, poster: s.poster, fav: true, onClick: function () { App.detailsScreen.open({ series: s }); },
          onLong: function () { prefs.toggleFavoriteSeries(s); App.toast('Removido dos Favoritos'); render(); App.nav.refocus(); } });
      }));
      root.appendChild(box);
    }
    return {
      root: root,
      show: function () { catalog.ready.then(render); },
      hide: function () {},
      onReturn: render,
      initialFocus: function () { return App.$('.focusable', root); },
    };
  })();

  App.vod = { historyPlayback: historyPlayback, playWithResumeChoice: playWithResumeChoice, moviePlayback: moviePlayback };
})();
