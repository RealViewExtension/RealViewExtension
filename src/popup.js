(function () {
  'use strict';

  var DEFAULTS = { rewrite: true, color: true, toast: true, debug: false };
  var inputs = {
    rewrite: document.getElementById('rewrite'),
    color: document.getElementById('color'),
    toast: document.getElementById('toast'),
    debug: document.getElementById('debug')
  };

  // The chart colour only means anything while the figures are being converted,
  // so the switch follows the main one rather than standing on its own.
  function reflectDependency() {
    var converting = inputs.rewrite.checked;
    inputs.color.disabled = !converting;
    inputs.color.closest('.row').classList.toggle('disabled', !converting);
  }

  chrome.storage.sync.get(DEFAULTS, function (stored) {
    inputs.rewrite.checked = stored.rewrite !== false;
    inputs.color.checked = stored.color !== false;
    // The update card says nothing about views, so it stands on its own rather
    // than following the main switch the way the chart colour does.
    inputs.toast.checked = stored.toast !== false;
    inputs.debug.checked = stored.debug === true;
    reflectDependency();
  });

  function save() {
    reflectDependency();
    chrome.storage.sync.set({
      rewrite: inputs.rewrite.checked,
      color: inputs.color.checked,
      toast: inputs.toast.checked,
      debug: inputs.debug.checked
    });
  }

  Object.keys(inputs).forEach(function (name) {
    inputs[name].addEventListener('change', save);
  });

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  // How long ago a moment was, in the coarsest unit that still says something:
  // minutes, then hours, days, weeks, months and years.
  function relativeTime(then, now) {
    var elapsed = now - then;
    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) return Math.floor(elapsed / MINUTE) + 'm ago';
    if (elapsed < DAY) return Math.floor(elapsed / HOUR) + 'h ago';
    var days = Math.floor(elapsed / DAY);
    if (days < 7) return days + 'd ago';
    if (days < 30) return Math.floor(days / 7) + 'w ago';
    if (days < 365) return Math.floor(days / 30) + 'mo ago';
    return Math.floor(days / 365) + 'yr ago';
  }

  // The dates are stored the sortable way round, but nobody reads "2026-09-11"
  // at a glance, so they are turned into "Sept 11 2026 (3d ago)". The day is
  // taken to start at local midnight, the same calendar the reader is on.
  function formatDate(iso, now) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!parts) return '';
    var month = MONTHS[Number(parts[2]) - 1];
    if (!month) return '';
    var then = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime();
    var text = month + ' ' + Number(parts[3]) + ' ' + parts[1];
    if (then <= now) text += ' (' + relativeTime(then, now) + ')';
    return text;
  }

  // The file is ordered newest first, so everything sitting above the version the
  // user last read is new to them. A version we cannot find counts only the top
  // entry as new, which covers both the user who installed before this feature
  // existed and the user whose version has since been dropped from the file.
  // Showing somebody the entire history as though it all just happened would be
  // a poor welcome either way.
  function partitionEntries(entries, lastSeenVersion) {
    var index = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].version === lastSeenVersion) {
        index = i;
        break;
      }
    }
    var cut = index === -1 ? 1 : index;
    if (cut > entries.length) cut = entries.length;
    return { fresh: entries.slice(0, cut), earlier: entries.slice(cut) };
  }

  // Anything malformed is treated as no changelog at all rather than as an error
  // to show the user, who came here to flip two switches and not to read about
  // our broken JSON.
  function isUsableChangelog(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    return data.every(function (entry) {
      return entry && typeof entry.version === 'string' && Array.isArray(entry.changes);
    });
  }

  function buildEntry(entry) {
    var wrapper = document.createElement('div');
    wrapper.className = 'entry';

    var heading = document.createElement('h2');
    heading.textContent = entry.version;
    var date = formatDate(entry.date, Date.now());
    if (date) {
      var dateEl = document.createElement('span');
      dateEl.textContent = date;
      heading.appendChild(dateEl);
    }
    wrapper.appendChild(heading);

    var list = document.createElement('ul');
    entry.changes.forEach(function (change) {
      var item = document.createElement('li');
      item.textContent = String(change);
      list.appendChild(item);
    });
    wrapper.appendChild(list);

    return wrapper;
  }

  function renderChangelog(entries, lastSeenVersion, unread) {
    var details = document.getElementById('whats-new');
    var summary = document.getElementById('whats-new-summary');
    var list = document.getElementById('changelog');
    var moreButton = document.getElementById('show-earlier');
    var version = chrome.runtime.getManifest().version;

    if (unread) {
      summary.appendChild(document.createTextNode("What's new in " + version));
      var tag = document.createElement('span');
      tag.className = 'new-tag';
      tag.textContent = 'NEW';
      summary.appendChild(tag);
    } else {
      summary.textContent = 'Version ' + version;
    }

    var split = partitionEntries(entries, lastSeenVersion);
    // Someone who has already read everything would otherwise open the section
    // onto an empty box, so the newest entry stands in as what it is worth
    // looking at.
    var fresh = split.fresh.length ? split.fresh : entries.slice(0, 1);
    var earlier = split.fresh.length ? split.earlier : entries.slice(1);

    fresh.forEach(function (entry) {
      list.appendChild(buildEntry(entry));
    });

    if (earlier.length) {
      // Only the history scrolls: what is new is always shown whole, so nothing
      // the user was told about sits below a fold they have no reason to look
      // past.
      var earlierBox = document.createElement('div');
      earlierBox.className = 'earlier';
      earlierBox.hidden = true;
      earlier.forEach(function (entry) {
        earlierBox.appendChild(buildEntry(entry));
      });
      list.appendChild(earlierBox);

      moreButton.hidden = false;
      moreButton.addEventListener('click', function () {
        earlierBox.hidden = !earlierBox.hidden;
        moreButton.textContent = earlierBox.hidden ? 'Show earlier versions' : 'Hide earlier versions';
      });
    }

    // An update the user has not seen yet is worth opening on; otherwise the
    // section keeps to itself and waits to be asked.
    details.open = !!unread;
    details.hidden = false;
  }

  chrome.storage.local.get(['lastSeenVersion', 'unread'], function (state) {
    var lastSeenVersion = state && state.lastSeenVersion;
    var unread = !!(state && state.unread);

    // Opening the popup is the moment the news is delivered, whether or not the
    // section is expanded. Waiting for an expand would leave a badge sitting on
    // the toolbar for ever for anyone who never opens it.
    if (unread) {
      chrome.storage.local.set({ lastSeenVersion: chrome.runtime.getManifest().version, unread: false });
      if (chrome.action && chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ text: '' });
      }
    }

    fetch(chrome.runtime.getURL('changelog.json'))
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        if (!isUsableChangelog(data)) return;
        renderChangelog(data, lastSeenVersion, unread);
      })
      .catch(function () {
        // Nothing to say and nothing to show: the section simply stays hidden.
      });
  });
})();
