'use strict';

// Provider list format (SSIPTV/M3U) and the title rules shared with the Android app.
App.m3u = (function () {
  function lines(text) { return String(text || '').split(/\r?\n/); }

  function clean(line) { return line.trim().replace(/^﻿/, ''); }

  function title(extinf) {
    var quoted = false;
    for (var i = 0; i < extinf.length; i++) {
      var c = extinf.charAt(i);
      if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) return i < extinf.length - 1 ? extinf.slice(i + 1).trim() : '';
    }
    var last = extinf.lastIndexOf(',');
    return last !== -1 && last < extinf.length - 1 ? extinf.slice(last + 1).trim() : '';
  }

  function attr(line, name) {
    var target = name + '="';
    var start = line.indexOf(target);
    if (start === -1) return '';
    var from = start + target.length;
    var end = line.indexOf('"', from);
    return end === -1 ? '' : line.slice(from, end);
  }

  /** Calls visit(extinfLine, url, index) for each entry. */
  function entries(text, visit) {
    var current = null;
    var index = 1;
    lines(text).forEach(function (raw) {
      var line = clean(raw);
      if (line.indexOf('#EXTINF') === 0) current = line;
      else if (current !== null && line && line.charAt(0) !== '#') {
        visit(current, line, index++);
        current = null;
      }
    });
  }

  function looksLikeM3u(text) {
    return String(text || '').slice(0, 8192).replace(/^[﻿\s]+/, '').split(/\r?\n/).some(function (l) {
      l = l.trim();
      return l.indexOf('#EXTM3U') === 0 || l.indexOf('#EXTINF') === 0;
    });
  }

  function lastSegment(url) {
    return url.replace(/\/+$/, '').split('/').pop();
  }

  return {
    looksLikeM3u: looksLikeM3u,

    hasEntries: function (text) {
      var found = false;
      entries(text, function () { found = true; });
      return found;
    },

    roots: function (text) {
      var map = {};
      entries(text, function (extinf, url) {
        var name = title(extinf);
        if (name) map[name.toUpperCase()] = url;
      });
      return map;
    },

    categories: function (text) {
      var list = [];
      entries(text, function (extinf, url) {
        var name = title(extinf);
        if (name) list.push({ id: lastSegment(url), name: name, url: url, count: 0, hasContent: null });
      });
      return list;
    },

    channels: function (text, defaultCategory) {
      var channels = [];
      var counts = {};
      var order = [];
      entries(text, function (extinf, url, n) {
        var category = attr(extinf, 'group-title') || defaultCategory;
        channels.push({
          id: url.split('/').pop() || 'ch_' + n,
          name: title(extinf) || 'Canal ' + n,
          logo: attr(extinf, 'tvg-logo'),
          category: category,
          streamUrl: url,
          number: n,
        });
        if (!(category in counts)) { counts[category] = 0; order.push(category); }
        counts[category]++;
      });
      var categories = order.map(function (name) { return { id: name, name: name, count: counts[name] }; });
      categories.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return { categories: categories, channels: channels };
    },

    movies: function (text, categoryId, categoryName) {
      var list = [];
      entries(text, function (extinf, url, n) {
        var id = url.split('/').pop().replace(/\.mp4$/, '').replace(/\.mkv$/, '');
        list.push({
          id: id || 'mv_' + n,
          title: title(extinf) || 'Filme ' + n,
          poster: attr(extinf, 'tvg-logo'),
          categoryId: categoryId,
          categoryName: categoryName,
          description: attr(extinf, 'description'),
          streamUrl: url,
        });
      });
      return list;
    },

    series: function (text, categoryId, categoryName) {
      var list = [];
      entries(text, function (extinf, url, n) {
        list.push({
          id: lastSegment(url) || 'sr_' + n,
          title: title(extinf) || 'Série ' + n,
          poster: attr(extinf, 'tvg-logo'),
          categoryId: categoryId,
          categoryName: categoryName,
          description: attr(extinf, 'description'),
          episodesUrl: url,
        });
      });
      return list;
    },

    episodes: function (text) {
      var list = [];
      entries(text, function (extinf, url, n) {
        list.push({
          id: url.replace(/\.+$/, '').split('/').pop() || 'ep_' + n,
          title: title(extinf) || 'Episódio ' + n,
          season: attr(extinf, 'group-title') || App.season.UNNAMED,
          episodeCode: attr(extinf, 'description') || 'T1E' + n,
          streamUrl: url,
        });
      });
      return list;
    },
  };
})();

/** Year is part of a movie identity: a title alone never confirms a match. */
App.identity = (function () {
  var yearPattern = /(?:\(|\[|\s[-–]\s)((?:19|20)\d{2})(?:\)|\]|\s*$)/g;
  var enclosedYear = /[\[(](?:19|20)\d{2}[\])]/g;
  var deliveryTag = /[\[(](?:dublado|legendado|l|dual\s*[aá]udio|1080p|720p|2160p|4k)[\])]/gi;
  var trailingYear = /\s[-–]\s(?:19|20)\d{2}\s*$/;
  var quality = /\b(?:1080p|720p|2160p|4k|full\s*hd|uhd|dublado|legendado|dual\s*[aá]udio)\b/gi;

  function normalize(value) {
    return String(value || '')
      .replace(/(\d)[ºª°]/g, '$1')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/([a-z])['’]([a-z])/g, '$1$2')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function searchTitle(value) {
    return String(value || '')
      .replace(enclosedYear, ' ')
      .replace(deliveryTag, ' ')
      .replace(trailingYear, '')
      .replace(quality, ' ')
      .trim();
  }

  return {
    normalize: normalize,
    searchTitle: searchTitle,
    parse: function (value) {
      var year = null;
      var match;
      yearPattern.lastIndex = 0;
      while ((match = yearPattern.exec(String(value || ''))) !== null) year = parseInt(match[1], 10);
      return { title: normalize(searchTitle(value)), year: year };
    },
  };
})();

App.season = {
  UNNAMED: '1º Temporada',
  display: function (season) { return season === App.season.UNNAMED ? '1ª Temporada' : season; },
  displaySubtitle: function (text) {
    text = text || '';
    return text.indexOf(App.season.UNNAMED) === 0 ? '1ª Temporada' + text.slice(App.season.UNNAMED.length) : text;
  },
};

App.categoryName = {
  movie: function (name) { return (name.replace(/^\s*filmes\s*\|\s*/i, '').trim()) || name; },
  series: function (name) { return (name.replace(/^\s*s[ée]ries\s*\|\s*/i, '').trim()) || name; },
};
