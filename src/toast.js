/*
 * RealView - the "what's new" card on YouTube Studio.
 *
 * After an update the background worker answers show:true exactly once, and
 * this draws a small card in the corner saying what changed. Nothing is opened
 * and nothing is stolen from Studio: no tab, no notification, no focus change,
 * no key listener, and no auto-hide timer. The card waits to be closed.
 *
 * Everything lives in a shadow root with a constructed stylesheet, so Studio's
 * own CSS cannot reach in and the extension is not asking the page's content
 * security policy for permission to add a <style> tag. Chrome 111 is the floor
 * for the extension, and adoptedStyleSheets has been writable since 99.
 */
(function () {
  'use strict';

  // Studio paints a loading spinner for about a second after the page load, so
  // the card is held back until the screen it belongs to is actually there.
  var SETTLE_MS = 1500;
  var REMOVE_MS = 250;
  var FIRST_BULLETS = 2;

  var CSS = [
    '.card {',
    '  position: fixed; bottom: 24px; right: 24px; width: 320px;',
    '  z-index: 2147483647; box-sizing: border-box; padding: 14px 16px;',
    '  background: #212121; color: #f1f1f1;',
    '  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px;',
    '  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);',
    '  font-family: "Roboto", system-ui, -apple-system, sans-serif;',
    '  font-size: 13px; text-align: left;',
    '  transform: translateY(16px); opacity: 0;',
    '  transition: transform 200ms ease, opacity 200ms ease;',
    '}',
    '.card.shown { transform: none; opacity: 1; }',
    '@media (prefers-reduced-motion: reduce) { .card { transition: none; } }',
    '.head { display: flex; align-items: center; justify-content: space-between; }',
    '.brand {',
    '  color: #ff5c5c; font-size: 11px; font-weight: 700;',
    '  letter-spacing: 0.04em; text-transform: uppercase;',
    '}',
    '.close {',
    '  width: 20px; height: 20px; padding: 0; border: 0; background: none;',
    '  color: #aaa; font: inherit; font-size: 16px; line-height: 20px;',
    '  cursor: pointer;',
    '}',
    '.title { margin-top: 2px; font-size: 14px; font-weight: 500; }',
    'ul { margin: 6px 0 0; padding-left: 16px; opacity: 0.75; line-height: 1.4; }',
    '.more {',
    '  margin-top: 6px; padding: 0; border: 0; background: none; font: inherit;',
    '  color: #aaa; text-decoration: underline; cursor: pointer;',
    '}',
    '.foot { margin-top: 8px; font-size: 11px; opacity: 0.55; line-height: 1.4; }'
  ].join('\n');

  // An update leaves the old content script running against an extension that
  // no longer exists, and sendMessage then throws "Extension context
  // invalidated". Reading lastError in the callback settles the same failure on
  // the asynchronous side. Either way the page is simply left alone.
  function send(message, done) {
    try {
      chrome.runtime.sendMessage(message, function (reply) {
        var failed = chrome.runtime.lastError;
        if (done) done(failed ? null : reply);
      });
    } catch (error) {
      if (done) done(null);
    }
  }

  function bullet(list, text) {
    var item = document.createElement('li');
    item.textContent = text;
    list.appendChild(item);
  }

  function dismiss(host, card) {
    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      host.remove();
    }
    card.addEventListener('transitionend', remove);
    card.classList.remove('shown');
    // With reduced motion there is no transition to end, and a transition can
    // also be cut short, so the card is removed on a timer regardless.
    setTimeout(remove, REMOVE_MS);
  }

  function mount(reply) {
    var host = document.createElement('div');
    var shadow = host.attachShadow({ mode: 'open' });
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];

    var card = document.createElement('div');
    card.className = 'card';

    var head = document.createElement('div');
    head.className = 'head';
    var brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'RealView';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.appendChild(brand);
    head.appendChild(close);
    card.appendChild(head);

    var title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Updated to ' + reply.version;
    card.appendChild(title);

    var changes = reply.changes || [];
    var list = document.createElement('ul');
    for (var i = 0; i < changes.length && i < FIRST_BULLETS; i++) bullet(list, changes[i]);
    card.appendChild(list);

    // A long update would otherwise make the card tall enough to cover Studio's
    // own controls, so the rest of the list is offered rather than shown.
    if (changes.length > FIRST_BULLETS) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'more';
      more.textContent = 'Show all ' + changes.length + ' changes';
      more.addEventListener('click', function () {
        for (var j = FIRST_BULLETS; j < changes.length; j++) bullet(list, changes[j]);
        more.remove();
      });
      card.appendChild(more);
    }

    var foot = document.createElement('div');
    foot.className = 'foot';
    foot.textContent = 'The full history is in the RealView popup on the toolbar.';
    card.appendChild(foot);

    close.addEventListener('click', function () {
      send({ type: 'realview-toast-seen' });
      dismiss(host, card);
    });

    shadow.appendChild(card);
    document.body.appendChild(host);

    // The card has to be laid out in its starting position before the class is
    // added, or the browser collapses the two styles into one and there is no
    // slide at all. Waiting two frames guarantees a style pass in between.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { card.classList.add('shown'); });
    });
  }

  // Studio is a single page app, but the background worker answers show:true
  // only once per version, so running on the full page load alone is enough and
  // there is no reason to watch navigation.
  send({ type: 'realview-toast-query' }, function (reply) {
    if (!reply || reply.show !== true) return;
    setTimeout(function () {
      if (document.body) mount(reply);
    }, SETTLE_MS);
  });
})();
