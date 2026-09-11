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
})();
