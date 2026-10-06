(function () {
  // Swaps Owncast's generated chat avatars for Discord avatars.
  // Owncast has no avatar-URL API for plugins, so this is a viewer-side override.
  // The selectors below are best guesses at Owncast's chat markup: if avatars don't
  // change, inspect a chat message in dev tools and adjust MESSAGE_SELECTOR / NAME_SELECTOR.
  var MESSAGE_SELECTOR = '[class*="ChatUserMessage"], [class*="chat-message"], [class*="message"]';
  var NAME_SELECTOR = '[class*="user"], [class*="Name"], [class*="name"]';
  var avatars = {};

  function apply(root) {
    var messages = root.querySelectorAll ? root.querySelectorAll(MESSAGE_SELECTOR) : [];
    messages.forEach(function (msg) {
      var img = msg.querySelector('img');
      if (!img || img.dataset.discordDone === '1') return;
      var nameEl = msg.querySelector(NAME_SELECTOR);
      var name = nameEl && nameEl.textContent ? nameEl.textContent.trim() : '';
      var url = avatars[name];
      if (url) {
        img.src = url;
        img.srcset = '';
        img.dataset.discordDone = '1';
      }
    });
  }

  function load() {
    return fetch('/plugins/discord-auth/avatars.json', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (m) { avatars = m || {}; })
      .catch(function () {});
  }

  load().then(function () {
    apply(document);
    new MutationObserver(function (muts) {
      var needsReload = false;
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          apply(n.parentNode || document);
          var nm = n.textContent ? n.textContent.trim() : '';
          if (nm && !needsReload && Object.keys(avatars).length === 0) needsReload = true;
        });
      });
      if (needsReload) load();
    }).observe(document.body, { childList: true, subtree: true });
    // Pick up newly logged-in users.
    setInterval(function () { load().then(function () { apply(document); }); }, 60000);
  });
})();
