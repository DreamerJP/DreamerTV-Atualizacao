'use strict';

// Portuguese subtitles found online (OpenSubtitles through Stremio) and the SRT reader.
App.subtitles = (function () {
  var LANGUAGES = ['pob', 'pt-br', 'por', 'pt'];

  function lookupError(message) {
    var e = new Error(message);
    e.forUser = true;
    return e;
  }

  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function query(title) {
    var m = /[\[(]((?:19|20)\d{2})[\])]/.exec(title);
    var clean = String(title)
      .replace(/\s*-\s*(?:epis[oó]dio\s*\d+|t\d+e\d+).*/i, '')
      .replace(/\s*\[.*?\]|\(.*?\)|\b(?:1080p|720p|2160p|4k|dublado|legendado|dual\s*áudio)\b/gi, '')
      .trim();
    return { title: clean, year: m ? parseInt(m[1], 10) : null };
  }

  /** Narrows a lookup without confusing a remake with another release. */
  function candidates(q, titles) {
    var seen = {};
    var valid = titles.filter(function (t) {
      if (!/^tt\d+$/.test(t.id) || !t.name || seen[t.id]) return false;
      seen[t.id] = true;
      return true;
    });
    var byYear = q.year === null ? valid : valid.filter(function (t) {
      var y = /(?:19|20)\d{2}/.exec(t.year || '');
      return y && parseInt(y[0], 10) === q.year;
    });
    if (q.year !== null && !byYear.length) byYear = valid.filter(function (t) { return !t.year; });
    var exact = byYear.filter(function (t) { return normalize(t.name) === normalize(q.title); });
    return exact.length ? exact : byYear;
  }

  function findTitles(target, isSeries) {
    var q = query(target);
    if (!q.title) return Promise.reject(lookupError('Não foi possível identificar o título para a legenda.'));
    var url = 'https://v3-cinemeta.strem.io/catalog/' + (isSeries ? 'series' : 'movie') + '/top/search=' + encodeURIComponent(q.title) + '.json';
    return App.getJson(url, { timeout: 20000 }).then(function (data) {
      var metas = data.metas || [];
      if (!metas.length) throw lookupError('Título não encontrado no catálogo de legendas.');
      var found = candidates(q, metas.map(function (m) { return { id: m.imdb_id || m.id, name: m.name, year: m.releaseInfo || m.year || '' }; }));
      if (!found.length) throw lookupError('Não foi encontrada uma correspondência para este título e ano.');
      return found;
    });
  }

  function decode(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = new TextDecoder('utf-8').decode(bytes);
    if (text.indexOf('�') >= 0) text = new TextDecoder('windows-1252').decode(bytes);
    return text;
  }

  function download(imdbId, isSeries, season, episodeCode, title) {
    var seasonNumber = parseInt((/\d+/.exec(season || '') || ['1'])[0], 10);
    var ep = /(?:e|ep|epis[oó]dio)\s*(\d+)/i.exec(episodeCode || '') || /(?:e|ep|epis[oó]dio)\s*(\d+)/i.exec(title || '');
    if (isSeries && !ep) return Promise.reject(lookupError('Não foi possível identificar o episódio para a legenda.'));
    var url = isSeries
      ? 'https://opensubtitles-v3.strem.io/subtitles/series/' + imdbId + ':' + seasonNumber + ':' + parseInt(ep[1], 10) + '.json'
      : 'https://opensubtitles-v3.strem.io/subtitles/movie/' + imdbId + '.json';
    return App.getJson(url, { timeout: 20000 }).then(function (data) {
      var best = (data.subtitles || []).filter(function (s) { return s.url && LANGUAGES.indexOf(String(s.lang).toLowerCase()) >= 0; })
        .sort(function (a, b) { return LANGUAGES.indexOf(String(a.lang).toLowerCase()) - LANGUAGES.indexOf(String(b.lang).toLowerCase()); })[0];
      if (!best) throw lookupError('Nenhuma legenda em português encontrada.');
      return App.request(best.url, { type: 'arraybuffer', timeout: 20000 });
    }).then(function (r) {
      if (r.status !== 200 || !r.body || !r.body.byteLength) throw lookupError('O arquivo de legenda está vazio.');
      return parseSrt(decode(r.body));
    });
  }

  function parseSrt(text) {
    var cues = [];
    text.replace(/\r/g, '').split(/\n{2,}/).forEach(function (block) {
      var m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(block);
      if (!m) return;
      var start = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
      var end = ((+m[5] * 60 + +m[6]) * 60 + +m[7]) * 1000 + +m[8];
      var lines = block.split('\n');
      var at = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
      var body = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
      if (body) cues.push({ start: start, end: end, text: body });
    });
    if (!cues.length) throw lookupError('O arquivo de legenda está vazio.');
    return cues;
  }

  function cueAt(cues, ms) {
    var lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].end < ms) lo = mid + 1;
      else if (cues[mid].start > ms) hi = mid - 1;
      else return cues[mid].text;
    }
    return '';
  }

  return { findTitles: findTitles, download: download, cueAt: cueAt };
})();
