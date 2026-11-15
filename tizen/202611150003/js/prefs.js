'use strict';

// Account, settings, favorites, history and resume positions (same rules as the Android app).
App.prefs = (function () {
  var kv = App.kv;
  var DEFAULT_SERVER = App.config.defaultServer || '';
  var stored = kv.get('dtv.credentials', null);
  var session = stored || { username: '', password: '', serverUrl: DEFAULT_SERVER, remember: true };
  var settings = Object.assign({ bufferProfile: 'ULTRA_STABLE', showClock: false, autoBoot: false, lastChannelId: '', videoReserve: true }, kv.get('dtv.settings', {}));
  var favorites = Object.assign({ CHANNEL: [], MOVIE: [], SERIES: [] }, kv.get('dtv.favorites', {}));
  var favMovies = kv.get('dtv.favMovies', []);
  var favSeries = kv.get('dtv.favSeries', []);
  var history = kv.get('dtv.history', []);
  var positions = kv.get('dtv.positions', {});
  var watched = kv.get('dtv.watched', []);
  var seasons = kv.get('dtv.seasons', {});
  var knownUsers = kv.get('dtv.knownUsers', []);

  function saveSettings() { kv.set('dtv.settings', settings); }
  function positionKey(id, type) { return type + '|' + id; }

  function persistCredentials() {
    if (session.remember) kv.set('dtv.credentials', session);
    else kv.set('dtv.credentials', { username: '', password: '', serverUrl: session.serverUrl, remember: false });
  }

  var panelRoutes = ['download_m3u', 'list_lives', 'list_created_channels', 'movie_categories', 'serie_categories', 'list_movies', 'list_series', 'list_episodes'];
  var contentId = /^\d+(?:\.[A-Za-z0-9]*)?$/;

  function credentialSlots(parts) {
    if (parts.length >= 5 && parts[0] === 'ssiptv' && parts[1] === 'get' && panelRoutes.indexOf(parts[4]) >= 0) return [2, 3];
    if (parts.length === 4 && (parts[0] === 'movie' || parts[0] === 'series') && contentId.test(parts[3])) return [1, 2];
    if (parts.length === 3 && contentId.test(parts[2])) return [0, 1];
    return null;
  }

  function origin(u) { return u.protocol + '//' + u.host; }

  var api = {
    DEFAULT_SERVER: DEFAULT_SERVER,
    get username() { return session.username; },
    get password() { return session.password; },
    get serverUrl() { return session.serverUrl || DEFAULT_SERVER; },
    get rememberMe() { return session.remember !== false; },
    set rememberMe(value) { session.remember = value; persistCredentials(); },
    isLoggedIn: function () { return !!(session.username && session.password); },

    setCredentials: function (user, pass, server, remember) {
      session = { username: user, password: pass, serverUrl: server, remember: remember };
      if (knownUsers.indexOf(user) < 0) { knownUsers.push(user); kv.set('dtv.knownUsers', knownUsers); }
      persistCredentials();
    },

    clearAuth: function () {
      session = { username: '', password: '', serverUrl: session.serverUrl, remember: session.remember };
      persistCredentials();
    },

    settings: settings,
    setSetting: function (key, value) { settings[key] = value; saveSettings(); },

    /** Renews user and password inside catalog addresses; other hosts and token links stay intact. */
    refreshUrl: function (url) {
      if (!api.isLoggedIn() || !url) return url;
      var u;
      try { u = new URL(url); } catch (error) { return url; }
      if (u.username || u.password || u.search) return url;
      var parts = u.pathname.split('/').filter(function (p) { return p !== ''; });
      var slots = credentialSlots(parts);
      if (!slots) return url;
      var originalUser = decodeURIComponent(parts[slots[0]]);
      if (knownUsers.indexOf(originalUser) < 0 && originalUser !== session.username) return url;
      if (slots[0] === 2) {
        try { if (origin(u) !== origin(new URL(api.serverUrl))) return url; } catch (error) { return url; }
      }
      parts[slots[0]] = encodeURIComponent(session.username);
      parts[slots[1]] = encodeURIComponent(session.password);
      var trailing = /\/$/.test(u.pathname) ? '/' : '';
      return origin(u) + '/' + parts.join('/') + trailing;
    },

    // Favorites ---------------------------------------------------------------
    favoriteIds: function (type) { return favorites[type] || []; },
    isFavorite: function (id, type) { return (favorites[type] || []).indexOf(id) >= 0; },
    toggleFavorite: function (id, type) {
      var list = favorites[type] || [];
      var at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1); else list.unshift(id);
      favorites[type] = list;
      kv.set('dtv.favorites', favorites);
      return at < 0;
    },
    toggleFavoriteMovie: function (movie) {
      var added = api.toggleFavorite(movie.id, 'MOVIE');
      favMovies = favMovies.filter(function (m) { return m.id !== movie.id; });
      if (added) favMovies.unshift(Object.assign({}, movie, { isFavorite: true }));
      kv.set('dtv.favMovies', favMovies);
      return added;
    },
    toggleFavoriteSeries: function (series) {
      var added = api.toggleFavorite(series.id, 'SERIES');
      favSeries = favSeries.filter(function (s) { return s.id !== series.id; });
      if (added) favSeries.unshift(Object.assign({}, series, { isFavorite: true }));
      kv.set('dtv.favSeries', favSeries);
      return added;
    },
    favoriteMovies: function () {
      return favMovies.filter(function (m) { return api.isFavorite(m.id, 'MOVIE'); }).map(function (m) {
        return Object.assign({}, m, { isFavorite: true, streamUrl: api.refreshUrl(m.streamUrl) });
      });
    },
    favoriteSeries: function () {
      return favSeries.filter(function (s) { return api.isFavorite(s.id, 'SERIES'); }).map(function (s) {
        return Object.assign({}, s, { isFavorite: true, episodesUrl: api.refreshUrl(s.episodesUrl) });
      });
    },

    // Positions and history -----------------------------------------------------
    savedPosition: function (id, type) { return positions[positionKey(id, type)] || 0; },
    savePosition: function (id, ms, type) {
      if (!id) return;
      if (ms > 0) positions[positionKey(id, type)] = ms;
      else delete positions[positionKey(id, type)];
      kv.set('dtv.positions', positions);
    },

    savePlaybackProgress: function (item, completed, watchedEpisode) {
      if (!item.id) return;
      var type = item.mediaType;
      api.savePosition(item.id, completed ? 0 : Math.max(0, item.positionMs), type);
      var rest = history.filter(function (h) { return !(h.id === item.id && h.mediaType === type); });
      history = completed ? rest : [Object.assign({}, item, { timestamp: Date.now() })].concat(rest).slice(0, 20);
      kv.set('dtv.history', history);
      if (type === 'EPISODE' && watchedEpisode && watched.indexOf(item.id) < 0) {
        watched.push(item.id);
        kv.set('dtv.watched', watched);
      }
    },

    history: function () {
      return history.map(function (h) {
        return Object.assign({}, h, {
          streamUrl: api.refreshUrl(h.streamUrl),
          seriesEpisodesUrl: h.seriesEpisodesUrl ? api.refreshUrl(h.seriesEpisodesUrl) : h.seriesEpisodesUrl,
          positionMs: api.savedPosition(h.id, h.mediaType) || h.positionMs,
        });
      });
    },
    removeHistory: function (id, type) {
      history = history.filter(function (h) { return !(h.id === id && (!type || h.mediaType === type)); });
      kv.set('dtv.history', history);
    },
    removeSeriesHistory: function (item) {
      var key = App.prefs.seriesKey(item);
      history = history.filter(function (h) { return !(api.isSeriesItem(h) && api.seriesKey(h) === key); });
      kv.set('dtv.history', history);
    },
    isSeriesItem: function (h) { return h.mediaType === 'EPISODE' || h.mediaType === 'SERIES'; },
    seriesKey: function (h) {
      if (h.seriesId) return 'series:' + h.seriesId;
      if (h.seriesEpisodesUrl) return 'url:' + h.seriesEpisodesUrl;
      if (h.seriesTitle) return 'title:' + h.seriesTitle;
      return 'episode:' + h.id;
    },
    movieHistory: function () {
      return api.history().filter(function (h) { return h.mediaType === 'MOVIE'; })
        .sort(function (a, b) { return b.timestamp - a.timestamp; });
    },
    seriesHistory: function () {
      var seen = {};
      return api.history().filter(api.isSeriesItem).sort(function (a, b) { return b.timestamp - a.timestamp; })
        .filter(function (h) {
          var key = api.seriesKey(h);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
    },
    watchedEpisodes: function () { return watched; },
    lastSeason: function (seriesId) { return seasons[seriesId] || null; },
    saveLastSeason: function (seriesId, season) {
      if (!seriesId || seasons[seriesId] === season) return;
      seasons[seriesId] = season;
      kv.set('dtv.seasons', seasons);
    },

    /** Movies renumbered by the provider: points saved items at their new numbers. */
    relinkMovies: function (replacements) {
      var ids = Object.keys(replacements);
      if (!ids.length) return;
      ids.forEach(function (old) {
        var movie = replacements[old];
        var pos = api.savedPosition(old, 'MOVIE');
        if (pos > 0 && !api.savedPosition(movie.id, 'MOVIE')) positions[positionKey(movie.id, 'MOVIE')] = pos;
        delete positions[positionKey(old, 'MOVIE')];
      });
      history = history.map(function (h) {
        var m = h.mediaType === 'MOVIE' && replacements[h.id];
        return m ? Object.assign({}, h, { id: m.id, streamUrl: m.streamUrl, poster: m.poster }) : h;
      });
      favMovies = favMovies.map(function (m) { return replacements[m.id] ? Object.assign({}, replacements[m.id], { isFavorite: true }) : m; });
      favorites.MOVIE = favorites.MOVIE.map(function (id) { return replacements[id] ? replacements[id].id : id; });
      kv.set('dtv.positions', positions);
      kv.set('dtv.history', history);
      kv.set('dtv.favMovies', favMovies);
      kv.set('dtv.favorites', favorites);
    },
  };
  return api;
})();

App.bufferProfiles = {
  ULTRA_STABLE: { label: 'Mais estável', description: 'Maior reserva de vídeo para reduzir pausas quando a entrega do servidor oscila.', startS: 2, resumeS: 5 },
  BALANCED: { label: 'Equilibrado', description: 'Bom equilíbrio entre velocidade de início e estabilidade.', startS: 1, resumeS: 3 },
  FAST: { label: 'Início rápido', description: 'Começa a reproduzir mais rápido, com menor reserva de vídeo.', startS: 1, resumeS: 2 },
};
