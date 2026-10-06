/*
 * RealView - the "Top recent videos" card on the channel dashboard.
 *
 * The latest-video card ranks the newest upload against the channel's recent
 * ones ("9 of 10"), but the full list only appears in a panel opened from that
 * row, and the panel will not open on a phone. The interceptor hands over the
 * ranking once it holds engaged figures, and this draws the same ten videos as
 * a card of their own, in the same column as the latest-video card.
 *
 * Studio's markup is not a stable interface, so the card is placed by what the
 * page shows rather than by its element names: the latest-video card is found
 * from its ranking row or the newest video's thumbnail, and the column is the
 * element that stacks it with the other cards. Anything that cannot be found
 * leaves the dashboard exactly as Studio drew it.
 *
 * Everything lives in a shadow root with a constructed stylesheet, the same as
 * the update card, so Studio's CSS cannot reach in. Colours come from Studio's
 * own theme variables, which inherit into the shadow root, so the card follows
 * the light and dark themes.
 */
(function () {
  'use strict';

  var SETTLE_MS = 300;
  var MIN_CARD_WIDTH = 200;

  var CSS = [
    ':host { display: block; }',
    '.card {',
    '  box-sizing: border-box; padding: 16px 24px 12px;',
    '  color: var(--yt-spec-text-primary, #f1f1f1);',
    '  font-family: "Roboto", system-ui, -apple-system, sans-serif; font-size: 13px;',
    '}',
    '.head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }',
    'h2 {',
    '  margin: 0; font-family: "YouTube Sans", "Roboto", sans-serif;',
    '  font-size: 20px; font-weight: 600; line-height: 28px;',
    '}',
    '.brand {',
    '  color: #ff5c5c; font-size: 11px; font-weight: 700;',
    '  letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;',
    '}',
    '.sub, .span { color: var(--yt-spec-text-secondary, #aaa); }',
    '.sub { margin-top: 2px; }',
    '.span { margin: 12px 0 4px; }',
    'ol { list-style: none; margin: 0 -8px; padding: 0; }',
    'a {',
    '  display: flex; align-items: center; gap: 10px; padding: 5px 8px;',
    '  border-radius: 8px; color: inherit; text-decoration: none;',
    '}',
    'a:hover, a:focus-visible { background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.1)); outline: none; }',
    'li.mine a { background: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.05)); }',
    '.rank { flex: none; width: 16px; color: var(--yt-spec-text-secondary, #aaa); }',
    'img, .thumb {',
    '  flex: none; width: 56px; height: 32px; border-radius: 4px; object-fit: cover;',
    '  background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.1));',
    '}',
    '.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }',
    '.value { flex: none; font-variant-numeric: tabular-nums; }'
  ].join('\n');

  var host = null;
  var anchor = null;
  var drawn = '';

  function attr(name) {
    return document.documentElement.getAttribute(name);
  }

  // The card shows engaged figures, so it goes with the main switch as well as
  // its own.
  function enabled() {
    return attr('data-realview-rewrite') !== 'off' && attr('data-realview-top-videos') !== 'off';
  }

  function onDashboard() {
    return /^\/channel\/[^/]+\/?$/.test(location.pathname);
  }

  // A ranking from another screen - a video's own analytics, say - is never
  // drawn here, so the list always belongs to the latest-video card beside it.
  function ranking() {
    var raw = attr('data-realview-ranking');
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed.path !== location.pathname || !Array.isArray(parsed.rows) || !parsed.rows.length) return null;
      parsed.raw = raw;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ placement */

  // Studio draws some of its cards inside shadow roots, so every search walks
  // into them as well.
  function eachElement(root, visit) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      if (visit(node)) return node;
      if (node.shadowRoot) {
        var inner = eachElement(node.shadowRoot, visit);
        if (inner) return inner;
      }
    }
    return null;
  }

  // The ranking row names itself ("Ranking by engaged views") in English, and
  // the card always shows the newest video's thumbnail whatever the language.
  function findAnchor(videoId) {
    var row = eachElement(document.body, function (el) {
      if (host && (el === host || host.contains(el))) return false;
      var text = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.firstChild.nodeValue : '';
      return /^\s*Ranking by\b/.test(text);
    });
    if (row) return row;
    var marker = '/vi/' + videoId + '/';
    return eachElement(document.body, function (el) {
      if (host && (el === host || host.contains(el))) return false;
      return el.tagName === 'IMG' && (el.getAttribute('src') || '').indexOf(marker) !== -1;
    });
  }

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    var root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }

  function transparent(colour) {
    return !colour || colour === 'transparent' || /rgba\(.*,\s*0\)$/.test(colour);
  }

  function looksLikeCard(el) {
    var style = getComputedStyle(el);
    var bordered = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none';
    var shadowed = style.boxShadow && style.boxShadow !== 'none';
    var filled = !transparent(style.backgroundColor) && parseFloat(style.borderTopLeftRadius) > 0;
    return bordered || shadowed || filled;
  }

  // A card has an edge: a border, a shadow, or a filled and rounded background.
  // Studio puts that edge a few wrappers inside the element stacked in the
  // column (ytcd-card, then a badge wrapper, then ytcd-basic-card), so the
  // search goes down through whichever child fills the same box. The element
  // carrying the edge is returned, so the copy can borrow the same look.
  var SURFACE_DEPTH = 4;

  function cardSurface(el) {
    var current = el;
    for (var depth = 0; current && depth <= SURFACE_DEPTH; depth++) {
      if (looksLikeCard(current)) return current;
      var rect = current.getBoundingClientRect();
      var filling = null;
      for (var i = 0; i < current.children.length && !filling; i++) {
        var box = current.children[i].getBoundingClientRect();
        if (box.height > 0 && Math.abs(box.width - rect.width) <= 2 && Math.abs(box.top - rect.top) <= 2) {
          filling = current.children[i];
        }
      }
      current = filling;
    }
    return null;
  }

  // Studio's own names, when they are there: each card is a ytcd-card stacked
  // in a ytcd-card-column.
  function studioCard(from) {
    for (var el = from; el && el !== document.body; el = parentOf(el)) {
      var parent = parentOf(el);
      if (el.tagName === 'YTCD-CARD' && parent && parent.tagName === 'YTCD-CARD-COLUMN') {
        return { card: el, surface: cardSurface(el) || el, column: parent };
      }
    }
    return null;
  }

  // Otherwise the card holding the anchor is the first ancestor that looks
  // like a card and is stacked above or below another card of the same width:
  // that other card is its neighbour in the column. Sections inside the card
  // fail one test or the other, and so do the columns themselves, which sit
  // side by side.
  function findCard(from) {
    var named = studioCard(from);
    if (named) return named;
    for (var el = from; el && el !== document.body; el = parentOf(el)) {
      var parent = parentOf(el);
      if (!parent) return null;
      var rect = el.getBoundingClientRect();
      if (rect.width < MIN_CARD_WIDTH) continue;
      var surface = cardSurface(el);
      if (!surface) continue;
      var siblings = parent.children;
      for (var i = 0; i < siblings.length; i++) {
        var other = siblings[i];
        if (other === el || other === host) continue;
        var box = other.getBoundingClientRect();
        if (Math.abs(box.width - rect.width) > 2 || Math.abs(box.top - rect.top) < 1) continue;
        if (cardSurface(other)) return { card: el, surface: surface, column: parent };
      }
    }
    return null;
  }

  // With the cards in columns the new one goes at the foot of the latest-video
  // card's column. With everything in one column it would end up below every
  // other card, so it goes straight after the latest-video card instead.
  function sideBySide(column) {
    var parent = parentOf(column);
    if (!parent) return false;
    var rect = column.getBoundingClientRect();
    for (var i = 0; i < parent.children.length; i++) {
      var other = parent.children[i];
      if (other === column) continue;
      var box = other.getBoundingClientRect();
      if (box.width > 0 && Math.abs(box.top - rect.top) < 2 && box.left !== rect.left) return true;
    }
    return false;
  }

  // The copy borrows its edge from the card it sits under, and its spacing from
  // the gap Studio leaves between cards.
  function matchLook(found) {
    var style = getComputedStyle(found.surface);
    var card = host.shadowRoot.querySelector('.card');
    ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRightWidth',
      'borderRightStyle', 'borderRightColor', 'borderBottomWidth', 'borderBottomStyle',
      'borderBottomColor', 'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
      'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius',
      'borderBottomRightRadius', 'boxShadow'].forEach(function (name) {
      card.style[name] = style[name];
    });

    var gap = parseFloat(getComputedStyle(found.column).rowGap);
    if (gap > 0) { host.style.margin = '0'; return; }
    var own = getComputedStyle(found.card);
    host.style.marginTop = own.marginBottom === '0px' ? own.marginTop : own.marginBottom;
    host.style.marginBottom = own.marginBottom;
  }

  /* -------------------------------------------------------------- drawing */

  function compact(value) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        notation: 'compact', maximumFractionDigits: 1
      }).format(value);
    } catch (e) {
      return String(value);
    }
  }

  // Studio heads the list with the stretch every video is measured over, in
  // the form "First 1 day 23 hours".
  function describeSpan(ms) {
    var minutes = Math.floor(ms / 60000);
    if (minutes < 60) return 'First ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);
    hours %= 24;
    var parts = [];
    if (days) parts.push(days + (days === 1 ? ' day' : ' days'));
    if (hours) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
    return 'First ' + parts.join(' ');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fill(data) {
    var card = host.shadowRoot.querySelector('.card');
    card.textContent = '';

    var head = el('div', 'head');
    head.appendChild(el('h2', '', 'Top recent videos'));
    // Studio has cards of its own on this screen, so this one says plainly
    // that it comes from an extension.
    head.appendChild(el('span', 'brand', 'RealView'));
    card.appendChild(head);
    card.appendChild(el('div', 'sub', 'Engaged views'));
    if (typeof data.spanMs === 'number') card.appendChild(el('div', 'span', describeSpan(data.spanMs) + ':'));

    var list = el('ol');
    data.rows.forEach(function (row) {
      var item = el('li', row.id === data.video ? 'mine' : '');
      var link = el('a');
      link.href = '/video/' + encodeURIComponent(row.id) + '/analytics/tab-overview/period-default';
      link.title = row.title;
      link.appendChild(el('span', 'rank', String(row.rank)));
      var thumb = el('img');
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(row.id) + '/mqdefault.jpg';
      // A private video's thumbnail is not public, so a failed image becomes
      // a plain placeholder of the same size rather than a broken icon.
      thumb.addEventListener('error', function () { thumb.replaceWith(el('span', 'thumb')); });
      link.appendChild(thumb);
      link.appendChild(el('span', 'title', row.title));
      link.appendChild(el('span', 'value', compact(row.value)));
      item.appendChild(link);
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  function create() {
    host = document.createElement('div');
    host.setAttribute('data-realview-top-videos-card', '');
    var shadow = host.attachShadow({ mode: 'open' });
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    shadow.appendChild(el('section', 'card'));
    drawn = '';
  }

  // A copy of the page's markup carries the host element along but not its
  // shadow root, so anything but the card itself is an empty leftover.
  function sweepStrays() {
    var strays = document.querySelectorAll('[data-realview-top-videos-card]');
    for (var i = 0; i < strays.length; i++) if (strays[i] !== host) strays[i].remove();
  }

  function remove() {
    if (host) host.remove();
    anchor = null;
    sweepStrays();
  }

  function update() {
    var data = enabled() && onDashboard() ? ranking() : null;
    if (!data) { remove(); return; }

    // Studio redraws its cards as data arrives, which can take the copy out of
    // the page or the latest-video card away from under it.
    var placed = host && host.isConnected && anchor && anchor.isConnected;
    if (!placed) {
      var from = findAnchor(data.video);
      var found = from && findCard(from);
      if (!found) { remove(); return; }
      if (!host) create();
      anchor = from;
      if (sideBySide(found.column)) found.column.appendChild(host);
      else found.card.insertAdjacentElement('afterend', host);
      matchLook(found);
      sweepStrays();
    }

    if (drawn !== data.raw) {
      fill(data);
      drawn = data.raw;
    }
  }

  var timer = null;
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(function () {
      timer = null;
      try { update(); } catch (e) { /* a page that cannot be read is left alone */ }
    }, SETTLE_MS);
  }

  // Mutations only matter while there is a list to draw, so the observer does
  // nothing at all on every other screen.
  new MutationObserver(function (mutations) {
    if (!onDashboard() || !attr('data-realview-ranking')) return;
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (host && (target === host || host.contains(target))) continue;
      schedule();
      return;
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-realview-ranking', 'data-realview-rewrite', 'data-realview-top-videos']
  });

  window.addEventListener('yt-navigate-finish', schedule);
  window.addEventListener('resize', function () { anchor = null; schedule(); });
  schedule();
})();
