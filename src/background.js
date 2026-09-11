(function () {
  'use strict';

  // One "1" in the extension's own red, so the toolbar says there is something
  // to read without anything opening on its own.
  var BADGE_TEXT = '1';
  var BADGE_COLOUR = '#c00';

  function showBadge() {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOUR });
    chrome.action.setBadgeText({ text: BADGE_TEXT });
  }

  chrome.runtime.onInstalled.addListener(function (details) {
    var current = chrome.runtime.getManifest().version;

    // A fresh install has nothing to catch up on: everything it does is new.
    if (details.reason === 'install') {
      chrome.storage.local.set({ lastSeenVersion: current, unread: false });
      return;
    }

    // chrome_update and shared_module_update are not this extension changing.
    if (details.reason !== 'update') return;

    // Reloading the same version during development is not an update either.
    if (details.previousVersion === current) return;

    chrome.storage.local.get({ lastSeenVersion: '', unread: false }, function (stored) {
      // Two updates without the popup being opened in between must still show
      // everything since the version the user last actually read, so the older
      // mark is kept rather than moved forward to the version just replaced.
      var lastSeen = stored.unread && stored.lastSeenVersion
        ? stored.lastSeenVersion
        : details.previousVersion;
      chrome.storage.local.set({ lastSeenVersion: lastSeen, unread: true });
      showBadge();
    });
  });

  // Badge text does not survive a browser restart, but storage does, so the
  // badge has to be put back from what was stored.
  chrome.runtime.onStartup.addListener(function () {
    chrome.storage.local.get({ unread: false }, function (stored) {
      if (stored.unread) showBadge();
    });
  });

  // The card shown in Studio's corner lives in a content script, and a content
  // script cannot fetch changelog.json unless the file is declared web
  // accessible, which would hand it to every page on the web for no gain. So
  // the background reads the file, which it is allowed to do, and passes the
  // one entry the card needs across instead.
  //
  // Registered at the top level like the listeners above: a service worker is
  // woken by the message, and a listener added later than the first turn of the
  // event loop would miss the message that woke it.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // The card sends an object, but a bare string is the other obvious way to
    // name a message, so both are understood rather than silently ignored.
    var type = typeof message === 'string' ? message : (message && message.type);
    var current = chrome.runtime.getManifest().version;

    if (type === 'realview-toast-query') {
      chrome.storage.sync.get({ toast: true }, function (settings) {
        chrome.storage.local.get({ unread: false, toastShownFor: '' }, function (state) {
          // Three separate reasons to stay quiet: there is nothing new to
          // report, the user has turned the card off, or this version's card
          // has already been shown once, closed or not.
          if (!state.unread || settings.toast === false || state.toastShownFor === current) {
            sendResponse({ show: false });
            return;
          }

          fetch(chrome.runtime.getURL('changelog.json'))
            .then(function (response) {
              return response.json();
            })
            .then(function (entries) {
              if (!Array.isArray(entries) || entries.length === 0) {
                throw new Error('the changelog is empty');
              }
              // The version being run should have its own entry, but a release
              // that forgot one would otherwise show nothing at all, and the
              // newest entry is the closest thing to the truth we have.
              var entry = null;
              for (var i = 0; i < entries.length; i++) {
                if (entries[i] && entries[i].version === current) {
                  entry = entries[i];
                  break;
                }
              }
              if (!entry) entry = entries[0];

              // Remembered before the card is even drawn, so an update shows
              // its card once and not on every Studio page load afterwards.
              chrome.storage.local.set({ toastShownFor: current });
              sendResponse({ show: true, version: current, date: entry.date, changes: entry.changes });
            })
            .catch(function () {
              // A missing or broken changelog is not worth telling the user
              // about: the card simply does not appear, and the badge still
              // says there is something to read in the popup.
              sendResponse({ show: false });
            });
        });
      });
      // The answer comes back from storage and a fetch, so the channel has to
      // be held open until then.
      return true;
    }

    if (type === 'realview-toast-seen') {
      // Closing the card counts as having read the news, exactly as opening the
      // popup does, so it clears the badge the same way.
      chrome.storage.local.set({ lastSeenVersion: current, unread: false });
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
      return true;
    }

    // Anything else is not ours. Returning false leaves the message to whatever
    // other listener it was meant for.
    return false;
  });
})();
