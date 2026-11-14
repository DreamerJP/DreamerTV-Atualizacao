'use strict';

/*
 * Provider catalog. The provider renumbers categories, moves channels and movies to other servers
 * and answers old categories with an empty list, so nothing saved is permanent: categories are
 * compared on every opening, channels at most every 10 minutes, and the full movie and series
 * lists are replaced once a day.
 */
App.catalog = (function () {
  var prefs = App.prefs;
  var CHANNEL_SYNC_MS = 10 * 60 * 1000;
  var FULL_LIST_MS = 24 * 60 * 60 * 1000;
  var empty = function () {
    return {
      accountKey: '', roots: {}, liveCategories: [], liveChannels: [], created24hCategories: [], created24hChannels: [],
      movieCategories: [], serieCategories: [], searchMovies: [], searchSeries: [], searchUpdatedAt: 0,
    };
  };
  var data = empty();
  var memo = { movies: {}, series: {}, episodes: {} };
  var memoOrder = { movies: [], series: [], episodes: [] };
  var syncTimes = {};
  var running = {};
  var searchIndex = null;
  var searchState = 'idle';
  var listeners = [];
  var ready = App.db.get('catalog').then(function (saved) { if (saved && saved.roots) data = Object.assign(empty(), saved); });

  function accountKey(server, user) { return String(server || '').replace(/\/+$/, '').toLowerCase() + '|' + user; }
  function save() { return App.db.set('catalog', data); }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function once(key, work) {
    if (!running[key]) running[key] = Promise.resolve().then(work).then(function (v) { delete running[key]; return v; }, function (e) { delete running[key]; throw e; });
    return running[key];
  }
  function remember(kind, key, value) {
    memo[kind][key] = value;
    memoOrder[kind] = memoOrder[kind].filter(function (k) { return k !== key; }).concat(key);
    var limit = kind === 'episodes' ? 30 : 10;
    while (memoOrder[kind].length > limit) delete memo[kind][memoOrder[kind].shift()];
  }

  function endpoint(path) {
    return prefs.serverUrl.replace(/\/+$/, '') + '/ssiptv/get/' + encodeURIComponent(prefs.username) + '/' + encodeURIComponent(prefs.password) + '/' + path;
  }
  function route(name, fallback) {
    var source = data.roots[name] || (name === 'SÉRIES' ? data.roots.SERIES : null);
    return prefs.refreshUrl(source || endpoint(fallback));
  }

  /** Downloads a provider list; 401/403 means the server refused the account. */
  function fetchList(url, description) {
    return App.request(url, { timeout: 45000 }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new App.AccessDenied();
      if (r.status < 200 || r.status >= 300) throw new Error('Não foi possível carregar ' + description + ' (HTTP ' + r.status + ').');
      if (!App.m3u.looksLikeM3u(r.text)) throw new Error('O servidor não retornou uma lista válida de ' + description + '.');
      return r.text;
    }, function () {
      throw new Error('Não foi possível carregar ' + description + '. Verifique a conexão.');
    });
  }

  function distinct(list) {
    var seen = {};
    return list.filter(function (i) { if (seen[i.id]) return false; seen[i.id] = true; return true; });
  }

  function ordered(categories) {
    return categories.slice().sort(function (a, b) {
      return (/VER TUDO/i.test(a.name) ? 1 : 0) - (/VER TUDO/i.test(b.name) ? 1 : 0);
    });
  }

  function freshChannels(list) {
    var fav = prefs.favoriteIds('CHANNEL');
    return list.map(function (c) { return Object.assign({}, c, { isFavorite: fav.indexOf(c.id) >= 0, streamUrl: prefs.refreshUrl(c.streamUrl) }); });
  }
  function freshMovies(list) {
    var fav = prefs.favoriteIds('MOVIE');
    return list.map(function (m) {
      return Object.assign({}, m, { isFavorite: fav.indexOf(m.id) >= 0, lastPositionMs: prefs.savedPosition(m.id, 'MOVIE'), streamUrl: prefs.refreshUrl(m.streamUrl) });
    });
  }
  function freshSeries(list) {
    var fav = prefs.favoriteIds('SERIES');
    return list.map(function (s) { return Object.assign({}, s, { isFavorite: fav.indexOf(s.id) >= 0, episodesUrl: prefs.refreshUrl(s.episodesUrl) }); });
  }
  function freshEpisodes(list) {
    return list.map(function (e) { return Object.assign({}, e, { streamUrl: prefs.refreshUrl(e.streamUrl) }); });
  }

  function rebuildIndex() {
    var norm = App.normalize;
    var movies = data.searchMovies.length ? data.searchMovies : flatten(memo.movies);
    var series = data.searchSeries.length ? data.searchSeries : flatten(memo.series);
    var channels = distinct(data.liveChannels.concat(data.created24hChannels));
    searchIndex = {
      channels: channels.map(function (c) { return [norm(c.name + ' ' + c.category), c]; }),
      movies: movies.map(function (m) { return [norm(m.title), m]; }),
      series: series.map(function (s) { return [norm(s.title), s]; }),
    };
  }
  function flatten(map) {
    return distinct(Object.keys(map).reduce(function (all, k) { return all.concat(map[k]); }, []));
  }

  var api = {
    ready: ready,
    onChange: function (f) { listeners.push(f); },
    get liveCategories() { return data.liveCategories; },
    get liveChannels() { return freshChannels(data.liveChannels); },
    get created24hCategories() { return data.created24hCategories; },
    get created24hChannels() { return freshChannels(data.created24hChannels); },
    get movieCategories() { return data.movieCategories.filter(function (c) { return c.hasContent !== false; }); },
    get serieCategories() { return data.serieCategories.filter(function (c) { return c.hasContent !== false; }); },
    get allSeries() { return data.searchSeries; },
    get allMovies() { return data.searchMovies; },
    get fullListReady() { return data.searchMovies.length > 0; },
    get searchState() { return searchState; },
    get catalogRevision() { return data.accountKey + '|' + data.searchUpdatedAt; },
    findMovie: function (id) { return data.searchMovies.filter(function (m) { return m.id === id; })[0] || null; },
    findSeries: function (id) { return data.searchSeries.filter(function (s) { return s.id === id; })[0] || null; },
    refreshUrl: function (url) { return prefs.refreshUrl(url); },

    /** Credentials replace the saved session only after the server returns the lists. */
    login: function (user, pass, server, remember) {
      return ready.then(function () {
        var base = server.replace(/\/+$/, '');
        var acceptedBefore = prefs.isLoggedIn() && prefs.username === user && prefs.password === pass &&
          prefs.serverUrl.replace(/\/+$/, '').toLowerCase() === base.toLowerCase();
        var identity = accountKey(base, user);
        try { new URL(base); } catch (e) { return Promise.reject(new Error('INVALID_SERVER')); }
        var url = base + '/ssiptv/get/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/download_m3u/';
        return fetchList(url, 'catálogo').then(function (text) {
          var roots = App.m3u.roots(text);
          if (!Object.keys(roots).length) return false;
          var same = data.accountKey === identity;
          prefs.setCredentials(user, pass, base, remember);
          if (!same) { data = empty(); memo = { movies: {}, series: {}, episodes: {} }; searchIndex = null; }
          data.accountKey = identity;
          data.roots = roots;
          return save().then(function () { return true; });
        }, function (error) {
          if (error instanceof App.AccessDenied) throw error;
          if (acceptedBefore && data.accountKey === identity && Object.keys(data.roots).length) return true;
          throw error;
        });
      });
    },

    logout: function () {
      prefs.clearAuth();
      data = empty();
      memo = { movies: {}, series: {}, episodes: {} };
      searchIndex = null;
      return App.db.clear();
    },

    loadLiveChannels: function (force) { return api._loadChannels(false, force); },
    load24hChannels: function (force) { return api._loadChannels(true, force); },
    _loadChannels: function (created24h, force) {
      return ready.then(function () {
        var list = created24h ? data.created24hChannels : data.liveChannels;
        if (list.length && !force) return;
        return once('channels' + created24h, function () {
          var url = created24h ? route('24 HORAS', 'list_created_channels/') : route('CANAIS', 'list_lives/');
          return fetchList(url, created24h ? 'canais 24h' : 'canais').then(function (text) {
            var parsed = App.m3u.channels(text, created24h ? '24 Horas' : 'Geral');
            if (created24h) { data.created24hCategories = parsed.categories; data.created24hChannels = distinct(parsed.channels); }
            else { data.liveCategories = parsed.categories; data.liveChannels = distinct(parsed.channels); }
            syncTimes[created24h] = Date.now();
            searchIndex = null;
            return save();
          });
        });
      });
    },

    /** Returns whether the channel list changed. An empty answer or a failure keeps the saved list. */
    syncChannels: function (created24h) {
      return ready.then(function () {
        if (syncTimes[created24h] && Date.now() - syncTimes[created24h] < CHANNEL_SYNC_MS) return false;
        var url = created24h ? route('24 HORAS', 'list_created_channels/') : route('CANAIS', 'list_lives/');
        return fetchList(url, 'canais').then(function (text) {
          syncTimes[created24h] = Date.now();
          var parsed = App.m3u.channels(text, created24h ? '24 Horas' : 'Geral');
          var unique = distinct(parsed.channels);
          if (!unique.length) return false;
          var current = created24h ? data.created24hChannels : data.liveChannels;
          if (JSON.stringify(current) === JSON.stringify(unique)) return false;
          if (created24h) { data.created24hCategories = parsed.categories; data.created24hChannels = unique; }
          else { data.liveCategories = parsed.categories; data.liveChannels = unique; }
          searchIndex = null;
          save();
          return true;
        }, function () { return false; });
      });
    },

    allPlaybackChannels: function () { return distinct(freshChannels(data.liveChannels.concat(data.created24hChannels))); },
    favoriteChannels: function () {
      var ids = prefs.favoriteIds('CHANNEL');
      return api.allPlaybackChannels().filter(function (c) { return ids.indexOf(c.id) >= 0; });
    },
    favoriteMovies: function () { return freshMovies(prefs.favoriteMovies()); },
    favoriteSeries: function () { return freshSeries(prefs.favoriteSeries()); },

    /** The saved list stays when the provider fails; unchanged categories keep their content check. */
    syncCategories: function (series) {
      return ready.then(function () {
        var saved = series ? data.serieCategories : data.movieCategories;
        var url = series ? route('SÉRIES', 'serie_categories/') : route('FILMES', 'movie_categories/');
        return fetchList(url, series ? 'categorias de séries' : 'categorias de filmes').then(function (text) {
          var fetched = App.m3u.categories(text);
          if (!fetched.length && saved.length) return;
          var checked = {};
          saved.forEach(function (c) { checked[c.id + '|' + c.name] = c.hasContent; });
          var replacement = ordered(fetched).map(function (c) {
            var known = checked[c.id + '|' + c.name];
            return known === undefined ? c : Object.assign(c, { hasContent: known });
          });
          if (JSON.stringify(replacement) === JSON.stringify(saved)) return;
          if (series) data.serieCategories = replacement; else data.movieCategories = replacement;
          return save();
        }, function (error) { if (!saved.length) throw error; });
      });
    },

    /** Hides categories the provider answers with an empty list. Failed checks keep them visible. */
    verifyCategories: function (series) {
      var list = series ? data.serieCategories : data.movieCategories;
      var unchecked = list.filter(function (c) { return c.hasContent === null || c.hasContent === undefined; });
      if (!unchecked.length) return Promise.resolve(false);
      return App.pool(unchecked, 4, function (c) {
        var url = prefs.refreshUrl(c.url || endpoint((series ? 'list_series/' : 'list_movies/') + c.id + '/'));
        return fetchList(url, 'categoria').then(function (text) { c.hasContent = App.m3u.hasEntries(text); });
      }).then(function () { save(); return true; });
    },

    loadMovies: function (category, force) {
      return ready.then(function () {
        if (!force && memo.movies[category.id]) return freshMovies(memo.movies[category.id]);
        var url = prefs.refreshUrl(category.url || endpoint('list_movies/' + category.id + '/'));
        return once('movies' + category.id, function () {
          return fetchList(url, 'filmes').then(function (text) {
            var list = distinct(App.m3u.movies(text, category.id, category.name));
            remember('movies', category.id, list);
            if (!data.searchMovies.length) searchIndex = null;
            return list;
          });
        }).then(freshMovies);
      });
    },

    loadSeries: function (category, force) {
      return ready.then(function () {
        if (!force && memo.series[category.id]) return freshSeries(memo.series[category.id]);
        var url = prefs.refreshUrl(category.url || endpoint('list_series/' + category.id + '/'));
        return once('series' + category.id, function () {
          return fetchList(url, 'séries').then(function (text) {
            var list = distinct(App.m3u.series(text, category.id, category.name));
            remember('series', category.id, list);
            if (!data.searchSeries.length) searchIndex = null;
            return list;
          });
        }).then(freshSeries);
      });
    },

    loadEpisodes: function (series, force) {
      return ready.then(function () {
        if (!force && memo.episodes[series.id]) return freshEpisodes(memo.episodes[series.id]);
        var url = prefs.refreshUrl(series.episodesUrl || endpoint('list_episodes/' + series.id + '/'));
        return once('episodes' + series.id, function () {
          return fetchList(url, 'episódios').then(function (text) {
            var list = distinct(App.m3u.episodes(text));
            remember('episodes', series.id, list);
            return list;
          });
        }).then(freshEpisodes);
      });
    },

    /** Full movie and series lists, replaced once a day; the old copy stays searchable meanwhile. */
    buildFullLists: function (force) {
      return ready.then(function () {
        var available = data.searchMovies.length && data.searchSeries.length;
        if (!force && available && Date.now() - data.searchUpdatedAt < FULL_LIST_MS) { searchState = 'ready'; return; }
        return once('fullLists', function () {
          if (!available) { searchState = 'loading'; emit(); }
          return Promise.all([
            fetchList(endpoint('list_series/-1/'), 'séries'),
            fetchList(endpoint('list_movies/-1/'), 'filmes'),
          ]).then(function (texts) {
            data.searchSeries = distinct(App.m3u.series(texts[0], '-1', 'Geral'));
            data.searchMovies = distinct(App.m3u.movies(texts[1], '-1', 'Geral'));
            data.searchUpdatedAt = Date.now();
            searchIndex = null;
            searchState = 'ready';
            emit();
            return save().then(api.relinkSavedMovies);
          }, function (error) {
            if (!available) searchState = 'error';
            emit();
            throw error;
          });
        });
      });
    },

    /** Complete replacement, downloaded before touching the saved copy. */
    refreshAll: function () {
      return ready.then(function () {
        var base = prefs.serverUrl.replace(/\/+$/, '');
        return fetchList(base + '/ssiptv/get/' + encodeURIComponent(prefs.username) + '/' + encodeURIComponent(prefs.password) + '/download_m3u/', 'catálogo')
          .then(function (text) {
            var roots = App.m3u.roots(text);
            if (!Object.keys(roots).length) throw new Error('O servidor não retornou o catálogo.');
            var old = data.roots;
            data.roots = roots;
            var r = function (name, fb) { return route(name, fb); };
            return Promise.all([
              fetchList(r('CANAIS', 'list_lives/'), 'canais'),
              fetchList(r('24 HORAS', 'list_created_channels/'), 'canais 24h'),
              fetchList(r('FILMES', 'movie_categories/'), 'categorias de filmes'),
              fetchList(r('SÉRIES', 'serie_categories/'), 'categorias de séries'),
              fetchList(endpoint('list_movies/-1/'), 'filmes'),
              fetchList(endpoint('list_series/-1/'), 'séries'),
            ]).then(function (t) {
              var live = App.m3u.channels(t[0], 'Geral');
              var h24 = App.m3u.channels(t[1], '24 Horas');
              data = Object.assign(empty(), {
                accountKey: data.accountKey, roots: roots,
                liveCategories: live.categories, liveChannels: distinct(live.channels),
                created24hCategories: h24.categories, created24hChannels: distinct(h24.channels),
                movieCategories: ordered(App.m3u.categories(t[2])), serieCategories: ordered(App.m3u.categories(t[3])),
                searchMovies: distinct(App.m3u.movies(t[4], '-1', 'Geral')), searchSeries: distinct(App.m3u.series(t[5], '-1', 'Geral')),
                searchUpdatedAt: Date.now(),
              });
              memo = { movies: {}, series: {}, episodes: {} };
              syncTimes = {};
              searchIndex = null;
              searchState = 'ready';
              emit();
              return save().then(api.relinkSavedMovies);
            }, function (error) { data.roots = old; throw error; });
          });
      });
    },

    /**
     * Saved movies whose number vanished are found again by title and year. Copies sharing a title
     * differ only by the subtitled category, so the copy outside it is preferred.
     */
    relinkSavedMovies: function () {
      var current = {};
      data.searchMovies.forEach(function (m) { current[m.id] = true; });
      var saved = prefs.history().filter(function (h) { return h.mediaType === 'MOVIE'; }).map(function (h) { return [h.id, h.title]; })
        .concat(prefs.favoriteMovies().map(function (m) { return [m.id, m.title]; }));
      var missing = saved.filter(function (s) { return !current[s[0]]; });
      if (!missing.length) return Promise.resolve();
      var byTitle = {};
      data.searchMovies.forEach(function (m) {
        var key = App.identity.parse(m.title).title;
        (byTitle[key] = byTitle[key] || []).push(m);
      });
      var copies = {};
      missing.forEach(function (s) {
        var wanted = App.identity.parse(s[1]);
        var found = (byTitle[wanted.title] || []).filter(function (m) { return wanted.year === null || App.identity.parse(m.title).year === wanted.year; });
        if (found.length) copies[s[0]] = found;
      });
      var ids = Object.keys(copies);
      if (!ids.length) return Promise.resolve();
      var needSubtitled = ids.some(function (id) { return copies[id].length > 1; });
      return (needSubtitled ? api.subtitledMovieIds() : Promise.resolve({})).then(function (subtitled) {
        var replacements = {};
        ids.forEach(function (id) {
          replacements[id] = copies[id].filter(function (m) { return !subtitled[m.id]; })[0] || copies[id][0];
        });
        prefs.relinkMovies(replacements);
      });
    },

    subtitledMovieIds: function () {
      return fetchList(route('FILMES', 'movie_categories/'), 'categorias de filmes').then(function (text) {
        var category = App.m3u.categories(text).filter(function (c) { return App.identity.normalize(c.name).indexOf('legendad') >= 0; })[0];
        if (!category) return {};
        return fetchList(prefs.refreshUrl(category.url), 'filmes').then(function (t) {
          var ids = {};
          App.m3u.movies(t, category.id, category.name).forEach(function (m) { ids[m.id] = true; });
          return ids;
        });
      }).catch(function () { return {}; });
    },

    search: function (query, type, offset, limit) {
      var key = App.normalize(query.trim());
      if (key.length < 2) return { channels: [], movies: [], series: [] };
      if (!searchIndex) rebuildIndex();
      offset = offset || 0;
      limit = limit || 50;
      function page(list, kind) {
        if (type && type !== kind) return [];
        var matches = [];
        var skipped = 0;
        for (var i = 0; i < list.length && matches.length < limit; i++) {
          if (list[i][0].indexOf(key) >= 0) {
            if (skipped < offset) skipped++;
            else matches.push(list[i][1]);
          }
        }
        return matches;
      }
      return {
        channels: freshChannels(page(searchIndex.channels, 'CHANNEL')),
        movies: freshMovies(page(searchIndex.movies, 'MOVIE')),
        series: freshSeries(page(searchIndex.series, 'SERIES')),
      };
    },

    /** Adds poster and series data found in the current catalog to a history entry. */
    enrichHistory: function (item) {
      var series = item.mediaType === 'EPISODE' || item.mediaType === 'SERIES' ? api.findSeries(item.seriesId || '') : null;
      var movie = item.mediaType === 'MOVIE' ? api.findMovie(item.id) : null;
      return Object.assign({}, item, {
        poster: (series && series.poster) || (movie && movie.poster) || item.poster,
        seriesTitle: (series && series.title) || item.seriesTitle,
        seriesEpisodesUrl: (series && prefs.refreshUrl(series.episodesUrl)) || item.seriesEpisodesUrl,
      });
    },

    storageEstimate: function () {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().then(function (e) { return e.usage || 0; });
      return Promise.resolve(null);
    },
  };
  return api;
})();
