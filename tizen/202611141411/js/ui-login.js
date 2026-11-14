'use strict';

// Sign-in screen: same fields, messages and automatic entry as the Android app.
App.loginScreen = (function () {
  var el = App.el, ui = App.ui, prefs = App.prefs;
  var root = App.$('#login');
  var built = false;
  var user, pass, server, remember, error, form, loading, status, connect;
  var attempt = 0;
  var layer;

  function build() {
    if (built) return;
    built = true;
    user = el('input', { class: 'input focusable', placeholder: 'Usuário', autocomplete: 'off' });
    pass = el('input', { class: 'input focusable', type: 'password', placeholder: 'Senha', autocomplete: 'off' });
    server = el('input', { class: 'input focusable', placeholder: 'Servidor (opcional)', autocomplete: 'off' });
    remember = ui.focusable('div', { class: 'check', onclick: function () {
      remember.classList.toggle('on');
      prefs.rememberMe = remember.classList.contains('on');
    } }, [el('span', { class: 'box-mark' }), el('span', { text: 'Lembrar meu acesso' })]);
    connect = ui.button('Entrar', submit, 'wide');
    error = el('div', { class: 'error hidden' });
    // 65376 is "Done" on the TV keyboard: it moves to the next field like the Android form.
    [user, pass, server].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.keyCode === 65376) { e.preventDefault(); input.blur(); if (input === server) App.nav.focus(connect); else App.nav.move(App.keys.DOWN); }
      });
    });
    form = el('div', { class: 'form' }, [
      el('div', { class: 'brandline' }, [el('img', { src: 'img/logo.png', alt: '' }), 'DreamerTV']),
      el('h1', { text: 'Entrar' }),
      user, pass, server, remember, connect, error,
    ]);
    status = el('div', { class: 's1', text: 'Preparando seu acesso…' });
    loading = el('div', { class: 'loading hidden' }, [
      el('img', { src: 'img/logo.png', alt: '' }),
      el('h1', { text: 'Entrando' }),
      el('div', { class: 'spinner' }),
      status,
      el('div', { class: 's2', text: 'Aguarde alguns instantes' }),
    ]);
    root.appendChild(el('img', { class: 'big-logo', src: 'img/logo.png', alt: '' }));
    root.appendChild(form);
    root.appendChild(loading);
  }

  function setLoading(value) {
    form.classList.toggle('hidden', value);
    loading.classList.toggle('hidden', !value);
    if (value) status.textContent = 'Preparando seu acesso…';
    else App.nav.focus(connect);
  }

  function showError(text) {
    error.textContent = text;
    error.classList.remove('hidden');
  }

  function failureMessage(e, serverText) {
    if (e instanceof App.AccessDenied) return 'O provedor recusou o acesso. Confira usuário, senha e se a assinatura está ativa.';
    if (e && e.message === 'INVALID_SERVER') return 'O endereço do servidor é inválido.';
    try { new URL(serverText.replace(/\/+$/, '')); } catch (x) { return 'O endereço do servidor é inválido.'; }
    if (!navigator.onLine) return 'Sem conexão com a internet. Confira a rede da TV.';
    return 'O provedor não respondeu. Pode ser instabilidade, tente de novo em alguns minutos.';
  }

  function submit() {
    var u = user.value.trim(), p = pass.value.trim();
    var s = server.value.trim() || prefs.serverUrl;
    if (!u || !p) { showError('Preencha usuário e senha'); return; }
    run(u, p, s);
  }

  function run(u, p, s) {
    var mine = ++attempt;
    error.classList.add('hidden');
    setLoading(true);
    status.textContent = 'Conectando à sua conta…';
    App.catalog.login(u, p, s, remember.classList.contains('on')).then(function (ok) {
      if (mine !== attempt) return;
      if (!ok) { setLoading(false); showError(failureMessage(null, s)); return; }
      status.textContent = 'Abrindo seu catálogo…';
      App.mainScreen.open();
    }, function (e) {
      if (mine !== attempt) return;
      setLoading(false);
      showError(failureMessage(e, s));
    });
  }

  return {
    open: function () {
      build();
      user.value = prefs.rememberMe ? prefs.username : '';
      pass.value = prefs.rememberMe ? prefs.password : '';
      server.value = prefs.serverUrl;
      remember.classList.toggle('on', prefs.rememberMe);
      error.classList.add('hidden');
      layer = {
        root: root,
        initial: user.value ? connect : user,
        onBack: function () {
          if (!loading.classList.contains('hidden')) {
            attempt++;
            setLoading(false);
            showError('Entrada cancelada. Você pode tentar novamente.');
          } else App.exitApp();
        },
      };
      App.screens.reset('login', layer);
      setLoading(false);
      if (prefs.isLoggedIn() && prefs.rememberMe) run(prefs.username, prefs.password, prefs.serverUrl);
    },
  };
})();
