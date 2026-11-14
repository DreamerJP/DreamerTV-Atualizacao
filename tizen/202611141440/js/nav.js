'use strict';

/*
 * Remote control navigation. Every selectable element has the "focusable" class. Arrows move to the
 * nearest element in that direction; when entering another column ("data-group"), the column's
 * selected or last used item receives the focus. Holding OK fires "longpress" instead of "click".
 */
App.keys = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27,
  PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412, CH_UP: 427, CH_DOWN: 428,
};

App.nav = (function () {
  var K = App.keys;
  var layers = [];
  var enterTimer = null;
  var enterLong = false;
  var enterDown = false;

  function top() { return layers[layers.length - 1]; }

  function visible(el) {
    if (!el || el.disabled || el.classList.contains('disabled')) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function focusables(root) {
    return App.$$('.focusable', root).filter(visible);
  }

  function focus(el) {
    if (!el) return;
    if (!el.hasAttribute('tabindex') && !/^(INPUT|BUTTON|TEXTAREA)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
    // The highlight follows a class: the page may not own the system focus (for example during start-up).
    App.$$('.focused').forEach(function (old) { if (old !== el) old.classList.remove('focused'); });
    el.classList.add('focused');
    el.focus({ preventScroll: true });
    // Long lists grow from here: the browser sends no focus event while the page lacks system focus.
    for (var node = el; node.parentElement; node = node.parentElement) {
      if (node.parentElement._onNavFocus) { node.parentElement._onNavFocus(node); break; }
    }
    scrollIntoView(el);
    var group = el.closest('[data-group]');
    if (group) group._last = el;
    var layer = top();
    if (layer) layer.last = el;
  }

  function scrollIntoView(el) {
    var parent = el.parentElement;
    while (parent && parent !== document.body) {
      var style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
        var r = el.getBoundingClientRect();
        var p = parent.getBoundingClientRect();
        var scale = App.stageScale || 1;
        var margin = 24 * scale;
        if (r.top < p.top + margin) parent.scrollTop -= (p.top + margin - r.top) / scale;
        else if (r.bottom > p.bottom - margin) parent.scrollTop += (r.bottom - p.bottom + margin) / scale;
      }
      if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
        var rx = el.getBoundingClientRect();
        var px = parent.getBoundingClientRect();
        var s = App.stageScale || 1;
        if (rx.left < px.left) parent.scrollLeft -= (px.left - rx.left) / s + 12;
        else if (rx.right > px.right) parent.scrollLeft += (rx.right - px.right) / s + 12;
      }
      parent = parent.parentElement;
    }
  }

  function current() {
    var layer = top();
    if (!layer) return null;
    var active = App.$('.focusable.focused', layer.root) || document.activeElement;
    if (active && layer.root.contains(active) && active.classList.contains('focusable') && visible(active)) return active;
    return null;
  }

  function preferredIn(group) {
    if (group._last && group.contains(group._last) && visible(group._last)) return group._last;
    var selected = App.$('.focusable.selected', group);
    if (selected && visible(selected)) return selected;
    if (group.dataset.enter === 'first') return focusables(group)[0] || null;
    return null;
  }

  // In long lists only the neighbours of the current item can be the next one; measuring every loaded
  // card on each arrow press made the response grow with the list.
  var NEAR = 40;
  function candidates(root, from) {
    var parent = from.parentElement;
    var siblings = parent.children;
    if (siblings.length <= NEAR * 2) return focusables(root);
    var at = Array.prototype.indexOf.call(siblings, from);
    var out = App.$$('.focusable', root).filter(function (el) { return el.parentElement !== parent; });
    for (var i = Math.max(0, at - NEAR); i < Math.min(siblings.length, at + NEAR + 1); i++) {
      if (siblings[i].classList.contains('focusable')) out.push(siblings[i]);
    }
    return out.filter(visible);
  }

  function move(direction) {
    var layer = top();
    if (!layer) return;
    var from = current();
    if (!from) { var all = focusables(layer.root); focus(layer.initial && visible(layer.initial) ? layer.initial : all[0]); return; }
    var list = candidates(layer.root, from);
    var a = from.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var best = null, bestScore = Infinity;
    list.forEach(function (el) {
      if (el === from) return;
      var b = el.getBoundingClientRect();
      var bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var primary, secondary;
      if (direction === K.LEFT) { if (b.right > a.left + 2) return; primary = a.left - b.right; secondary = Math.abs(ay - by); }
      else if (direction === K.RIGHT) { if (b.left < a.right - 2) return; primary = b.left - a.right; secondary = Math.abs(ay - by); }
      else if (direction === K.UP) { if (b.bottom > a.top + 2) return; primary = a.top - b.bottom; secondary = Math.abs(ax - bx); }
      else { if (b.top < a.bottom - 2) return; primary = b.top - a.bottom; secondary = Math.abs(ax - bx); }
      var score = Math.max(0, primary) + secondary * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (!best) return;
    var fromGroup = from.closest('[data-group]');
    var toGroup = best.closest('[data-group]');
    if (toGroup && toGroup !== fromGroup) best = preferredIn(toGroup) || best;
    focus(best);
  }

  function handler(el, key) {
    var node = el;
    while (node && node !== document.body) {
      if (node.navKey && node.navKey(key, el) === true) return true;
      node = node.parentElement;
    }
    return false;
  }

  function onKeyDown(e) {
    var key = e.keyCode;
    var layer = top();
    if (!layer) return;
    var el = current();
    if (key === K.BACK || key === K.ESC || (key === 8 && !(el && el.tagName === 'INPUT'))) {
      e.preventDefault();
      if (layer.onBack) layer.onBack();
      return;
    }
    if (layer.onKey && layer.onKey(e, el) === true) { e.preventDefault(); return; }
    if (key === K.ENTER) {
      if (el && el.tagName === 'INPUT') return;
      e.preventDefault();
      if (e.repeat || enterDown) return;
      enterDown = true;
      enterLong = false;
      clearTimeout(enterTimer);
      enterTimer = setTimeout(function () {
        enterLong = true;
        var target = current();
        if (target) target.dispatchEvent(new CustomEvent('longpress', { bubbles: true }));
      }, 750);
      return;
    }
    if (key >= K.LEFT && key <= K.DOWN) {
      if (el && el.tagName === 'INPUT' && (key === K.LEFT || key === K.RIGHT)) {
        var atStart = el.selectionStart === 0, atEnd = el.selectionEnd === el.value.length;
        if ((key === K.LEFT && !atStart) || (key === K.RIGHT && !atEnd)) return;
      }
      e.preventDefault();
      if (el && handler(el, key)) return;
      move(key);
    }
  }

  function onKeyUp(e) {
    if (e.keyCode !== K.ENTER) return;
    var el = current();
    if (el && el.tagName === 'INPUT') return;
    clearTimeout(enterTimer);
    var wasDown = enterDown;
    enterDown = false;
    if (wasDown && !enterLong && el) el.click();
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  return {
    focus: focus,
    current: current,
    move: move,
    refocus: function () {
      var layer = top();
      if (!layer) return;
      var target = current() || (layer.last && visible(layer.last) ? layer.last : null) || (layer.initial && visible(layer.initial) ? layer.initial : null) || focusables(layer.root)[0];
      if (target) focus(target);
    },
    /** layer: {root, initial, onBack, onKey}. */
    push: function (layer) { layers.push(layer); setTimeout(function () { App.nav.refocus(); }, 0); },
    pop: function (layer) {
      layers = layers.filter(function (l) { return l !== layer; });
      setTimeout(function () { App.nav.refocus(); }, 0);
    },
    replaceBase: function (layer) { layers = [layer]; setTimeout(function () { App.nav.refocus(); }, 0); },
    get top() { return top(); },
  };
})();

/** Modal choices drawn like the Android dialogs. */
App.dialog = {
  /** options: [{label, selected, action}] */
  choose: function (title, options, extra) {
    extra = extra || {};
    var overlay = App.el('div', { class: 'modal' });
    var box = App.el('div', { class: 'modal-box' + (extra.wide ? ' wide' : '') });
    box.appendChild(App.el('div', { class: 'modal-title', text: title }));
    if (extra.message) box.appendChild(App.el('div', { class: 'modal-message', text: extra.message }));
    var list = App.el('div', { class: 'modal-list' });
    var initial = null;
    var layer;
    function close() { overlay.remove(); App.nav.pop(layer); }
    options.forEach(function (option) {
      var item = App.el('div', {
        class: 'focusable choice' + (option.selected ? ' selected' : ''), tabindex: '-1',
        onclick: function () { close(); if (option.action) option.action(); },
      }, [App.el('span', { text: option.label })]);
      if (option.selected || (!initial && option.primary)) initial = item;
      list.appendChild(item);
    });
    box.appendChild(list);
    overlay.appendChild(box);
    App.$('#stage').appendChild(overlay);
    layer = { root: overlay, initial: initial || list.firstChild, onBack: function () { close(); if (extra.onCancel) extra.onCancel(); } };
    App.nav.push(layer);
    return close;
  },

  confirm: function (title, message, buttons, onCancel) {
    var overlay = App.el('div', { class: 'modal' });
    var box = App.el('div', { class: 'modal-box' });
    box.appendChild(App.el('div', { class: 'modal-title', text: title }));
    if (message) box.appendChild(App.el('div', { class: 'modal-message', text: message }));
    var row = App.el('div', { class: 'modal-buttons' });
    var initial = null;
    var layer;
    function close() { overlay.remove(); App.nav.pop(layer); }
    buttons.forEach(function (b) {
      var button = App.el('div', { class: 'focusable btn', tabindex: '-1', text: b.label, onclick: function () { close(); if (b.action) b.action(); } });
      if (b.primary) initial = button;
      row.appendChild(button);
    });
    box.appendChild(row);
    overlay.appendChild(box);
    App.$('#stage').appendChild(overlay);
    layer = { root: overlay, initial: initial || row.firstChild, onBack: function () { close(); if (onCancel) onCancel(); } };
    App.nav.push(layer);
  },
};

/** Appends items in chunks as the focus approaches the end, so long lists open instantly. */
App.lazyList = function (container, items, render, chunk) {
  chunk = chunk || 60;
  var rendered = 0;
  App.clear(container);
  function more() {
    var end = Math.min(items.length, rendered + chunk);
    var fragment = document.createDocumentFragment();
    for (var i = rendered; i < end; i++) {
      var node = render(items[i], i);
      node._index = i;
      fragment.appendChild(node);
    }
    container.appendChild(fragment);
    rendered = end;
  }
  more();
  container._onNavFocus = function (node) {
    if (node._index !== undefined && node._index >= rendered - Math.max(15, chunk / 3) && rendered < items.length) more();
  };
  container.onfocusin = null;
  return { more: more, get count() { return rendered; } };
};
