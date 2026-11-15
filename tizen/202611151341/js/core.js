'use strict';

// Shared helpers: DOM, text, network, storage and small UI messages.
var App = window.App = { config: window.DreamerConfig || {} };

App.el = function (tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
      else if (key === 'style') node.setAttribute('style', value);
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    });
  }
  (children || []).forEach(function (child) {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
};

App.$ = function (selector, root) { return (root || document).querySelector(selector); };
App.$$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

App.clear = function (node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

App.normalize = function (value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
};

App.pad = function (n, size) {
  var s = String(n);
  while (s.length < (size || 2)) s = '0' + s;
  return s;
};

App.formatTime = function (ms) {
  ms = Math.max(0, ms || 0);
  var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return h > 0 ? App.pad(h) + ':' + App.pad(m) + ':' + App.pad(s) : App.pad(m) + ':' + App.pad(s);
};

App.positionLabel = function (ms) {
  var minutes = Math.floor(Math.max(0, ms) / 60000);
  return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'min' : minutes + 'min';
};

App.clock = function () {
  var d = new Date();
  return App.pad(d.getHours()) + ':' + App.pad(d.getMinutes());
};

App.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/** Thrown when the provider answers 401/403: the server refused the account. */
App.AccessDenied = function (message) {
  this.name = 'AccessDenied';
  this.message = message || 'Acesso recusado pelo servidor.';
};
App.AccessDenied.prototype = Object.create(Error.prototype);

/** Plain GET. Resolves with status, final address and text; rejects only on network failure. */
App.request = function (url, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    try {
      xhr.open(options.method || 'GET', url, true);
    } catch (error) {
      reject(new Error('Endereço inválido.'));
      return;
    }
    xhr.timeout = options.timeout || 30000;
    if (options.type) xhr.responseType = options.type;
    Object.keys(options.headers || {}).forEach(function (key) { xhr.setRequestHeader(key, options.headers[key]); });
    if (options.signal) options.signal.onabort = function () { xhr.abort(); };
    xhr.onload = function () {
      resolve({
        status: xhr.status,
        url: xhr.responseURL || url,
        text: options.type ? null : xhr.responseText,
        body: options.type ? xhr.response : null,
        header: function (name) { return xhr.getResponseHeader(name); },
      });
    };
    xhr.onerror = function () { reject(new Error('Falha de conexão.')); };
    xhr.ontimeout = function () { reject(new Error('Sem resposta do servidor.')); };
    xhr.onabort = function () { reject(new Error('Cancelado.')); };
    xhr.send(options.body || null);
  });
};

App.getJson = function (url, options) {
  return App.request(url, options).then(function (r) {
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.text);
  });
};

/** Small values (settings, favorites, history) live in localStorage. */
App.kv = {
  get: function (key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  },
  set: function (key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {}
  },
  remove: function (key) {
    try { localStorage.removeItem(key); } catch (error) {}
  },
};

/** Large data (catalog, full lists, metadata caches) lives in IndexedDB. */
App.db = (function () {
  var opening = null;
  function open() {
    if (!opening) {
      opening = new Promise(function (resolve, reject) {
        var request = indexedDB.open('dreamertv', 1);
        request.onupgradeneeded = function () { request.result.createObjectStore('dados'); };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }
    return opening;
  }
  function run(mode, action) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('dados', mode);
        var request = action(tx.objectStore('dados'));
        tx.oncomplete = function () { resolve(request && request.result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }
  return {
    get: function (key) { return run('readonly', function (s) { return s.get(key); }).catch(function () { return undefined; }); },
    set: function (key, value) { return run('readwrite', function (s) { return s.put(value, key); }).catch(function () {}); },
    remove: function (key) { return run('readwrite', function (s) { return s.delete(key); }).catch(function () {}); },
    clear: function () { return run('readwrite', function (s) { return s.clear(); }).catch(function () {}); },
  };
})();

App.toast = (function () {
  var timer = null;
  return function (message, ms) {
    var node = App.$('#toast');
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(function () { node.classList.remove('visible'); }, ms || 2600);
  };
})();

/** Runs async tasks with a concurrency limit. */
App.pool = function (items, limit, worker) {
  var index = 0;
  var results = [];
  function next() {
    if (index >= items.length) return Promise.resolve();
    var current = index++;
    return Promise.resolve(worker(items[current], current)).then(function (value) {
      results[current] = value;
      return next();
    }, function () {
      results[current] = undefined;
      return next();
    });
  }
  var runners = [];
  for (var i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  return Promise.all(runners).then(function () { return results; });
};
