'use strict';

// Synopses and trailers (TMDB), the "Dreamer indica" selection and its match against the catalog.
App.discovery = (function () {
  var FEED_URL = 'https://dreamerjp.github.io/Dreamer/Assets/Filmes/minha_lista_filmes.json';
  var TMDB = 'https://api.themoviedb.org/3/';
  var key = App.config.tmdbKey || '';
  var feed = null;
  var feedTime = 0;
  var detailsCache = null;
  var matchCache = null;
  var identity = App.identity;

  function tmdb(path, params, language) {
    var url = TMDB + path + '?api_key=' + encodeURIComponent(key);
    if (language !== null) url += '&language=' + (language || 'pt-BR');
    Object.keys(params || {}).forEach(function (k) { url += '&' + k + '=' + encodeURIComponent(params[k]); });
    return App.getJson(url, { timeout: 18000 });
  }

  function trailerId(value) {
    value = String(value || '');
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
    try {
      var u = new URL(value);
      var host = u.hostname.toLowerCase();
      var candidate = null;
      if (host === 'youtu.be') candidate = u.pathname.replace(/^\/+|\/+$/g, '');
      else if (/^(www\.|m\.)?youtube(-nocookie)?\.com$/.test(host)) {
        if (u.pathname === '/watch') candidate = u.searchParams.get('v');
        else if (/^\/(embed|shorts)\//.test(u.pathname)) candidate = u.pathname.split('/').pop();
      }
      return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : '';
    } catch (e) {
      return '';
    }
  }

  function image(path, size) { return path && path.charAt(0) === '/' ? 'https://image.tmdb.org/t/p/' + size + path : ''; }

  function cleanTitle(title) {
    return String(title).replace(/\s*[\[(](?:19|20)\d{2}[\])]/g, '').replace(/\b(?:1080p|720p|2160p|4k|dublado|legendado)\b/gi, '').trim();
  }

  function artworkKey(url) {
    var m = /^https?:\/\/(?:image\.tmdb\.org|www\.themoviedb\.org)\/t\/p\/[^/]+\/([A-Za-z0-9]+\.(?:jpg|png|webp))$/i.exec(String(url || ''));
    return m ? m[1] : '';
  }

  function parseFeed(raw) {
    var films = (JSON.parse(raw).films || []).map(function (item) {
      var title = String(item.title || '').trim();
      var year = parseInt(item.year, 10);
      if (!title || !(year >= 1880 && year <= 2100)) return null;
      var originalSlug = '';
      try { var u = new URL(item.url); if (u.hostname === 'letterboxd.com') originalSlug = u.pathname.replace(/^\/film\//, '').replace(/\/+$/, ''); } catch (e) {}
      return {
        slug: item.slug || title + '-' + year,
        title: title,
        year: year,
        originalTitle: item.original_title || '',
        director: item.director || '',
        releaseDate: item.released || '',
        originalSlug: originalSlug,
        details: {
          title: title, year: year, overview: item.plot || '', poster: item.poster || '', backdrop: item.backdrop || '',
          genres: item.genre || '', runtime: item.runtime || '', trailerId: trailerId(item.trailer), trailerLanguage: '', fromTmdb: false,
        },
      };
    }).filter(Boolean);
    var seen = {};
    return films.filter(function (f) {
      var k = identity.normalize(f.title) + '|' + f.year;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function loadFeed() {
    var load = feed ? Promise.resolve() : App.db.get('feed').then(function (saved) { if (saved) { feed = saved.films; feedTime = saved.time; } });
    return load.then(function () {
      if (feed && Date.now() - feedTime < 15 * 60000) return { films: feed, stale: false };
      return App.request(FEED_URL, { timeout: 18000 }).then(function (r) {
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        feed = parseFeed(r.text);
        feedTime = Date.now();
        App.db.set('feed', { films: feed, time: feedTime });
        return { films: feed, stale: false };
      }).catch(function () {
        if (feed) return { films: feed, stale: true };
        throw new Error('Não foi possível carregar Dreamer indica.');
      });
    });
  }

  function details(title, isSeries, poster) {
    var id = identity.parse(title);
    var cacheKey = isSeries + '|' + id.title + '|' + id.year + '|' + artworkKey(poster);
    var load = detailsCache ? Promise.resolve() : App.db.get('details').then(function (d) { detailsCache = d || {}; });
    return load.then(function () {
      var cached = detailsCache[cacheKey];
      if (cached && Date.now() - cached.time < 7 * 86400000) return cached.value;
      if (!key) return null;
      var type = isSeries ? 'tv' : 'movie';
      var params = { query: cleanTitle(title) };
      if (id.year) params[isSeries ? 'first_air_date_year' : 'year'] = id.year;
      return tmdb('search/' + type, params).then(function (search) {
        var candidates = (search.results || []).filter(function (item) {
          var year = parseInt(String(item[isSeries ? 'first_air_date' : 'release_date'] || '').slice(0, 4), 10);
          return (id.year === null || year === id.year) &&
            [item[isSeries ? 'name' : 'title'], item[isSeries ? 'original_name' : 'original_title']].some(function (t) { return identity.parse(t).title === id.title; });
        });
        var unique = {};
        candidates.forEach(function (c) { unique[c.id] = c; });
        candidates = Object.keys(unique).map(function (k) { return unique[k]; });
        return selectCandidate(candidates, type, artworkKey(poster));
      }).then(function (selected) {
        if (!selected) return null;
        return tmdb(type + '/' + selected.id, { append_to_response: 'videos' }).then(function (item) {
          var pick = function (list) {
            return (list || []).filter(function (v) { return v.site === 'YouTube' && v.type === 'Trailer' && trailerId(v.key); })
              .sort(function (a, b) { return ((b.iso_639_1 === 'pt') - (a.iso_639_1 === 'pt')) || ((b.official ? 1 : 0) - (a.official ? 1 : 0)); })[0];
          };
          var video = pick(item.videos && item.videos.results);
          var extra = video ? Promise.resolve(video) : tmdb(type + '/' + selected.id + '/videos', {}, 'en-US').then(function (v) { return pick(v.results); }).catch(function () { return null; });
          return extra.then(function (v) {
            var result = {
              title: item[isSeries ? 'name' : 'title'] || cleanTitle(title),
              year: parseInt(String(item[isSeries ? 'first_air_date' : 'release_date'] || '').slice(0, 4), 10) || null,
              overview: item.overview || '',
              poster: image(item.poster_path, 'w500'),
              backdrop: image(item.backdrop_path, 'w1280'),
              genres: (item.genres || []).map(function (g) { return g.name; }).join(' · '),
              runtime: item.runtime ? item.runtime + ' min' : '',
              trailerId: v ? v.key : '',
              trailerLanguage: v ? v.iso_639_1 || '' : '',
              fromTmdb: true,
            };
            detailsCache[cacheKey] = { time: Date.now(), value: result };
            var keys = Object.keys(detailsCache);
            while (keys.length > 100) delete detailsCache[keys.shift()];
            App.db.set('details', detailsCache);
            return result;
          });
        });
      }).catch(function () { return cached ? cached.value : null; });
    });
  }

  function selectCandidate(candidates, type, artwork) {
    if (!artwork) return Promise.resolve(candidates.length === 1 ? candidates[0] : null);
    if (!candidates.length) return Promise.resolve(null);
    return Promise.all(candidates.map(function (c) {
      return tmdb(type + '/' + c.id + '/images', {}, null).then(function (img) {
        return (img.posters || []).some(function (p) { return String(p.file_path).split('/').pop() === artwork; }) ? c : null;
      }).catch(function () { return null; });
    })).then(function (found) {
      found = found.filter(Boolean);
      return found.length === 1 ? found[0] : null;
    });
  }

  // Recommendation matching ---------------------------------------------------

  function catalogIndex(movies) {
    var byName = {};
    movies.forEach(function (m) {
      var k = identity.parse(m.title).title;
      (byName[k] = byName[k] || []).push(m);
    });
    return byName;
  }

  function candidatesFor(byName, titles, year) {
    var seen = {};
    var found = [];
    titles.forEach(function (t) {
      if (!t) return;
      var variants = [t];
      var main = t.split(':')[0].split(' - ')[0].trim();
      if (main !== t && main.split(/\s+/).length >= 2) variants.push(main);
      variants.forEach(function (v) {
        (byName[identity.parse(v).title] || []).forEach(function (m) {
          if (seen[m.id]) return;
          var y = identity.parse(m.title).year;
          if (y === null || y === year) { seen[m.id] = true; found.push(m); }
        });
      });
    });
    return found;
  }

  /** TMDB edition of a recommended film: its official and alternative titles for the same year. */
  function edition(film) {
    if (!key) return Promise.resolve(null);
    var queries = [film.title, film.originalTitle, film.slug.replace('-' + film.year, '').replace(/-/g, ' '), film.originalSlug.replace('-' + film.year, '').replace(/-/g, ' ')]
      .filter(Boolean);
    var names = queries.map(function (q) { return identity.parse(q).title; });
    function select(results) {
      var exact = (results || []).filter(function (m) {
        return parseInt(String(m.release_date || '').slice(0, 4), 10) === film.year &&
          [m.title, m.original_title].some(function (t) { return names.indexOf(identity.parse(t).title) >= 0; });
      });
      var ids = {};
      exact = exact.filter(function (m) { if (ids[m.id]) return false; ids[m.id] = true; return true; });
      if (exact.length === 1) return exact[0];
      var dated = exact.filter(function (m) { return /^\d{4}-\d{2}-\d{2}$/.test(film.releaseDate) && m.release_date === film.releaseDate; });
      return dated.length === 1 ? dated[0] : null;
    }
    var attempt = function (i) {
      if (i >= queries.length) return Promise.resolve(null);
      return tmdb('search/movie', { query: queries[i], year: film.year }).then(function (pt) {
        return select(pt.results) || tmdb('search/movie', { query: queries[i], year: film.year }, 'en-US').then(function (en) { return select(en.results); });
      }).then(function (chosen) {
        if (!chosen) return attempt(i + 1);
        return tmdb('movie/' + chosen.id, { append_to_response: 'alternative_titles,credits' }).then(function (d) {
          if (parseInt(String(d.release_date || '').slice(0, 4), 10) !== film.year) return attempt(i + 1);
          if (film.director && film.director !== 'N/A' && d.credits && d.credits.crew) {
            var directs = d.credits.crew.some(function (c) {
              return c.job === 'Director' && [c.name, c.original_name].some(function (n) { return identity.normalize(n) === identity.normalize(film.director); });
            });
            if (!directs) return attempt(i + 1);
          }
          var titles = [film.title, film.originalTitle, d.title, d.original_title];
          ((d.alternative_titles && d.alternative_titles.titles) || []).forEach(function (a) {
            if (['BR', 'PT', 'US', 'GB'].indexOf(a.iso_3166_1) >= 0) titles.push(a.title);
          });
          return { id: d.id, titles: titles.filter(Boolean) };
        });
      });
    };
    return attempt(0);
  }

  function resolve(film, byName) {
    var direct = candidatesFor(byName, [film.title, film.originalTitle], film.year)
      .filter(function (m) { return identity.parse(m.title).year === film.year; });
    if (direct.length) return Promise.resolve({ availability: 'AVAILABLE', sources: direct, candidates: [] });
    return edition(film).then(function (ed) {
      if (!ed) {
        var loose = candidatesFor(byName, [film.title, film.originalTitle], film.year);
        return loose.length ? { availability: 'UNCONFIRMED', sources: [], candidates: loose } : { availability: 'UNAVAILABLE', sources: [], candidates: [] };
      }
      var named = candidatesFor(byName, ed.titles, film.year);
      var dated = named.filter(function (m) { return identity.parse(m.title).year === film.year; });
      if (dated.length) return { availability: 'AVAILABLE', sources: dated, candidates: [] };
      if (named.length) return { availability: 'UNCONFIRMED', sources: [], candidates: named };
      return { availability: 'UNAVAILABLE', sources: [], candidates: [] };
    }).catch(function () {
      return { availability: 'CHECKING', sources: [], candidates: [], failed: true };
    });
  }

  /**
   * Publishes pages while the selection is matched against the full movie list:
   * onPage({films:[{film, availability, sources, candidates}], stale, catalogReady, verifying, total, checked}).
   */
  function recommendations(onPage, signal) {
    var catalog = App.catalog;
    return Promise.all([loadFeed(), matchCache ? Promise.resolve() : App.db.get('matches').then(function (m) { matchCache = m || {}; })]).then(function (r) {
      var feedResult = r[0];
      var films = feedResult.films;
      var ready = catalog.fullListReady;
      var revision = catalog.catalogRevision;
      var movies = catalog.allMovies;
      var byId = {};
      movies.forEach(function (m) { byId[m.id] = m; });
      var byName = catalogIndex(movies);
      var rows = films.map(function (film) {
        var saved = matchCache[film.slug + '|' + film.year];
        if (ready && saved && saved.revision === revision && Date.now() - saved.time < 86400000) {
          return {
            film: film, availability: saved.availability,
            sources: saved.sources.map(function (id) { return byId[id]; }).filter(Boolean),
            candidates: saved.candidates.map(function (id) { return byId[id]; }).filter(Boolean),
          };
        }
        return { film: film, availability: 'CHECKING', sources: [], candidates: [] };
      });
      var publish = function () {
        var pending = rows.filter(function (x) { return x.availability === 'CHECKING'; }).length;
        onPage({ films: rows.slice(), stale: feedResult.stale, catalogReady: ready, verifying: ready && pending > 0, total: rows.length, checked: rows.length - pending });
      };
      publish();
      if (!ready) return;
      var todo = rows.map(function (x, i) { return i; }).filter(function (i) { return rows[i].availability === 'CHECKING'; });
      var lastPublish = 0;
      return App.pool(todo, 4, function (i) {
        if (signal && signal.cancelled) return;
        return resolve(rows[i].film, byName).then(function (result) {
          if (signal && signal.cancelled) return;
          rows[i] = Object.assign({ film: rows[i].film }, result);
          if (!result.failed) {
            matchCache[rows[i].film.slug + '|' + rows[i].film.year] = {
              revision: revision, time: Date.now(), availability: result.availability,
              sources: result.sources.map(function (m) { return m.id; }), candidates: result.candidates.map(function (m) { return m.id; }),
            };
          }
          if (Date.now() - lastPublish > 800) { lastPublish = Date.now(); publish(); }
        });
      }).then(function () {
        if (signal && signal.cancelled) return;
        rows.forEach(function (x) { if (x.availability === 'CHECKING') x.availability = 'UNAVAILABLE'; });
        App.db.set('matches', matchCache);
        publish();
      });
    });
  }

  function websiteDetails(title) {
    var id = identity.parse(title);
    if (id.year === null) return Promise.resolve(null);
    return loadFeed().then(function (r) {
      var found = r.films.filter(function (f) {
        return f.year === id.year && [f.title, f.originalTitle].filter(Boolean).some(function (t) { return identity.parse(t).title === id.title; });
      });
      return found.length === 1 ? found[0].details : null;
    }).catch(function () { return null; });
  }

  return {
    hasTmdb: !!key,
    trailerId: trailerId,
    details: details,
    websiteDetails: websiteDetails,
    recommendations: recommendations,
    invalidate: function () { feedTime = 0; matchCache = {}; App.db.remove('matches'); },
    clearCaches: function () {
      detailsCache = {};
      matchCache = {};
      return Promise.all([App.db.remove('details'), App.db.remove('matches'), App.db.remove('feed')]).then(function () { feed = null; feedTime = 0; });
    },
  };
})();
