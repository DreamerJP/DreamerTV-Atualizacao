'use strict';

// Shared screen pieces: icons, list rows, poster cards, loading box and screen switching.
App.ui = (function () {
  var el = App.el;
  var icons = {
    star: 'M12,17.27L18.18,21l-1.64,-7.03L22,9.24l-7.19,-0.61L12,2 9.19,8.63 2,9.24l5.46,4.73L5.82,21z',
    search: 'M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z',
  };

  function icon(name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (cls) svg.setAttribute('class', cls);
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', icons[name]);
    svg.appendChild(path);
    return svg;
  }

  function focusable(tag, attrs, children) {
    var node = el(tag, attrs, children);
    node.classList.add('focusable');
    node.setAttribute('tabindex', '-1');
    return node;
  }

  function button(label, onClick, cls) {
    return focusable('div', { class: 'btn' + (cls ? ' ' + cls : ''), text: label, onclick: onClick });
  }

  function category(item, name, onClick, onLong) {
    var node = focusable('div', { class: 'cat', onclick: onClick }, [
      el('span', { class: 'name', text: name }),
      item.count ? el('span', { class: 'count', text: String(item.count) }) : null,
    ]);
    if (onLong) node.addEventListener('longpress', onLong);
    return node;
  }

  function channel(item, onClick, onLong) {
    var logo = el('img', { class: 'logo', alt: '' });
    if (item.logo) { logo.src = item.logo; logo.onerror = function () { logo.style.visibility = 'hidden'; }; }
    else logo.style.visibility = 'hidden';
    var row = focusable('div', { class: 'channel' + (item.isFavorite ? ' fav' : ''), onclick: onClick }, [
      el('span', { class: 'num', text: App.pad(item.number) }),
      logo,
      el('span', { class: 'name', text: item.name }),
      icon('star', 'star'),
    ]);
    if (onLong) row.addEventListener('longpress', onLong);
    row.dataset.id = item.id;
    return row;
  }

  function poster(url) {
    var img = el('div', { class: 'img placeholder' });
    if (url) {
      var probe = new Image();
      probe.onload = function () { img.classList.remove('placeholder'); img.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")'; };
      probe.src = url;
    }
    return img;
  }

  /** Poster card. opts: {title, poster, sub, subMuted, fav, progress (0-100), dim, onClick, onLong}. */
  function card(opts) {
    var img = poster(opts.poster);
    if (opts.progress !== undefined && opts.progress !== null) {
      img.appendChild(el('div', { class: 'progress' }, [el('div', { style: 'width:' + opts.progress + '%' })]));
    }
    var node = focusable('div', { class: 'card' + (opts.fav ? ' is-fav' : '') + (opts.dim ? ' dim' : ''), onclick: opts.onClick }, [
      img,
      icon('star', 'fav'),
      el('div', { class: 't', text: opts.title }),
      opts.sub !== undefined ? el('div', { class: 'sub' + (opts.subMuted ? ' muted' : ''), text: opts.sub }) : null,
    ]);
    if (opts.onLong) node.addEventListener('longpress', opts.onLong);
    return node;
  }

  /** Buffering/error box like the Android PlaybackLoadingView. */
  function loadingBox() {
    var pct = el('div', { class: 'pct' });
    var ring = el('div', { class: 'ring' }, [el('div', { class: 'spinner' }), pct]);
    var status = el('div', { class: 'status' });
    var detail = el('div', { class: 'detail' });
    var box = el('div', { class: 'loading-box hidden' }, [ring, status, detail]);
    return {
      node: box,
      show: function (message, percent, extra) {
        box.classList.remove('hidden');
        ring.classList.remove('hidden');
        pct.textContent = percent !== null && percent !== undefined ? percent + '%' : '';
        status.textContent = message || (percent ? 'Carregando' : 'Conectando');
        detail.textContent = extra || '';
        detail.classList.toggle('hidden', !extra);
      },
      error: function (message, hint) {
        box.classList.remove('hidden');
        ring.classList.add('hidden');
        status.textContent = message;
        detail.textContent = hint;
        detail.classList.remove('hidden');
      },
      hide: function () { box.classList.add('hidden'); },
      get visible() { return !box.classList.contains('hidden'); },
    };
  }

  var screens = ['login', 'main', 'details', 'player', 'trailer'];
  function show(id) {
    screens.forEach(function (s) { App.$('#' + s).classList.toggle('active', s === id); });
  }

  return { icon: icon, focusable: focusable, button: button, category: category, channel: channel, card: card, loadingBox: loadingBox, show: show };
})();
