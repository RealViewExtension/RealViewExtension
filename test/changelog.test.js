'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const changelog = JSON.parse(fs.readFileSync(path.join(SRC, 'changelog.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// Newest first is the order the popup reads in, so "later" has to mean
// numerically later rather than alphabetically: 1.5.10 comes after 1.5.9.
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// A fake Chrome for src/background.js: listeners are captured so a test can
// call them, storage is a plain object, and badge calls are recorded.
function fakeChrome(stored, version, synced) {
  const calls = { badgeText: [], badgeColour: [] };
  const listeners = {};
  // Both storage areas answer the same way: the defaults the caller asked for,
  // overlaid with whatever has actually been stored.
  function area(store) {
    return {
      get(defaults, callback) {
        const out = {};
        Object.keys(defaults).forEach((key) => {
          out[key] = store[key] === undefined ? defaults[key] : store[key];
        });
        callback(out);
      },
      set(values, callback) {
        Object.keys(values).forEach((key) => { store[key] = values[key]; });
        if (callback) callback();
      }
    };
  }
  const chrome = {
    runtime: {
      getManifest: () => ({ version }),
      getURL: (file) => 'chrome-extension://realview/' + file,
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      onMessage: { addListener(fn) { listeners.message = fn; } }
    },
    storage: {
      local: area(stored),
      sync: area(synced)
    },
    action: {
      setBadgeText(details) { calls.badgeText.push(details.text); },
      setBadgeBackgroundColor(details) { calls.badgeColour.push(details.color); }
    }
  };
  return { chrome, calls, listeners, stored, synced };
}

function loadBackground(stored, version, synced) {
  const env = fakeChrome(stored || {}, version || manifest.version, synced || {});
  const source = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
  // The background reaches for changelog.json over fetch, which a bare vm
  // context has no notion of, so it is served the real file from disk.
  const fetch = () => Promise.resolve({ json: () => Promise.resolve(changelog) });
  vm.runInNewContext(source, { chrome: env.chrome, console, fetch });
  return env;
}

// The answer is built inside the vm context, so its prototype is that realm's
// Object rather than this one's and a deep comparison would fail on that alone.
// Only the fields matter here, so they are copied into a plain local object.
function plain(response) {
  const out = {};
  Object.keys(response).forEach((key) => { out[key] = response[key]; });
  return out;
}

// A message is answered through a callback rather than a return value, so the
// call is turned into a promise. The value the listener returned is handed back
// alongside it, since that is what decides whether the channel stays open.
function sendMessage(env, message) {
  let settle;
  const answered = new Promise((resolve) => { settle = resolve; });
  const kept = env.listeners.message(message, {}, (response) => settle(response));
  return { kept, answered };
}

// Whether an answer ever arrives at all: a listener that declines a message
// must never call back, and the only way to see that is to wait a moment.
function answeredWithin(promise) {
  const nothing = Symbol('nothing');
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(nothing), 25))
  ]).then((value) => (value === nothing ? null : { value }));
}

// The toast reports the version it is actually running, so these tests pin
// themselves to the newest entry rather than to whatever the manifest says,
// which lets them pass while a release is half done.
const NEWEST = changelog[0];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('the changelog is a non-empty list', () => {
  assert.ok(Array.isArray(changelog), 'changelog.json holds an array');
  assert.ok(changelog.length > 0, 'with at least one entry');
});

test('every entry is a version, a date and some changes', () => {
  changelog.forEach((entry, index) => {
    const where = 'entry ' + index;
    assert.strictEqual(typeof entry.version, 'string', where + ' has a version');
    assert.ok(/^\d+\.\d+\.\d+$/.test(entry.version), where + ' version is three numbers: ' + entry.version);

    assert.strictEqual(typeof entry.date, 'string', where + ' has a date');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), where + ' date is yyyy-mm-dd: ' + entry.date);
    const parsed = new Date(entry.date + 'T00:00:00Z');
    assert.ok(!isNaN(parsed.getTime()), where + ' date is a real date: ' + entry.date);
    assert.strictEqual(parsed.toISOString().slice(0, 10), entry.date, where + ' date exists in the calendar: ' + entry.date);

    assert.ok(Array.isArray(entry.changes), where + ' has a list of changes');
    assert.ok(entry.changes.length > 0, where + ' lists at least one change');
    entry.changes.forEach((change, line) => {
      assert.strictEqual(typeof change, 'string', where + ' change ' + line + ' is a string');
      assert.ok(change.trim().length > 0, where + ' change ' + line + ' is not empty');
    });
  });
});

test('entries run newest first, with no version twice', () => {
  const seen = new Set();
  changelog.forEach((entry) => {
    assert.ok(!seen.has(entry.version), 'version listed only once: ' + entry.version);
    seen.add(entry.version);
  });
  for (let i = 1; i < changelog.length; i++) {
    const newer = changelog[i - 1].version;
    const older = changelog[i].version;
    assert.ok(compareVersions(newer, older) > 0, newer + ' comes before ' + older);
  }
});

test('the newest entry is the version being shipped', () => {
  // The guard for bumping the manifest and forgetting to say what changed.
  assert.strictEqual(changelog[0].version, manifest.version,
    'changelog.json starts with the manifest version ' + manifest.version);
});

test('the manifest registers the service worker', () => {
  assert.ok(manifest.background, 'a background key');
  assert.strictEqual(manifest.background.service_worker, 'background.js');
});

test('an update remembers the version left behind and shows the badge', () => {
  const env = loadBackground({}, '1.5.4');
  env.listeners.installed({ reason: 'update', previousVersion: '1.5.3' });

  assert.strictEqual(env.stored.lastSeenVersion, '1.5.3', 'the version last read is the one replaced');
  assert.strictEqual(env.stored.unread, true);
  assert.deepStrictEqual(env.calls.badgeText, ['1']);
  assert.deepStrictEqual(env.calls.badgeColour, ['#c00']);
});

test('a second update while still unread keeps the version actually read', () => {
  const env = loadBackground({ lastSeenVersion: '1.5.3', unread: true }, '1.5.5');
  env.listeners.installed({ reason: 'update', previousVersion: '1.5.4' });

  assert.strictEqual(env.stored.lastSeenVersion, '1.5.3', 'so both updates are still shown');
  assert.strictEqual(env.stored.unread, true);
});

test('a fresh install has nothing new to read', () => {
  const env = loadBackground({}, '1.5.4');
  env.listeners.installed({ reason: 'install' });

  assert.strictEqual(env.stored.lastSeenVersion, '1.5.4');
  assert.strictEqual(env.stored.unread, false);
  assert.deepStrictEqual(env.calls.badgeText, [], 'no badge');
});

test('a Chrome update is not an extension update', () => {
  const env = loadBackground({}, '1.5.4');
  env.listeners.installed({ reason: 'chrome_update' });
  env.listeners.installed({ reason: 'shared_module_update' });

  assert.deepStrictEqual(env.stored, {}, 'nothing stored');
  assert.deepStrictEqual(env.calls.badgeText, [], 'no badge');
});

test('a restart puts an unread badge back', () => {
  const env = loadBackground({ lastSeenVersion: '1.5.3', unread: true }, '1.5.4');
  env.listeners.startup();
  assert.deepStrictEqual(env.calls.badgeText, ['1']);
  assert.deepStrictEqual(env.calls.badgeColour, ['#c00']);
});

test('a restart with nothing unread leaves the toolbar alone', () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: false }, '1.5.4');
  env.listeners.startup();
  assert.deepStrictEqual(env.calls.badgeText, []);
});

test('an unread update answers the toast with this version\'s entry', async () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: true }, NEWEST.version, {});
  const { kept, answered } = sendMessage(env, { type: 'realview-toast-query' });

  assert.strictEqual(kept, true, 'the channel is held open for the async answer');
  const reply = await answered;
  assert.strictEqual(reply.show, true);
  assert.strictEqual(reply.version, NEWEST.version);
  assert.strictEqual(reply.date, NEWEST.date);
  assert.deepStrictEqual(reply.changes, NEWEST.changes);
  assert.strictEqual(env.stored.toastShownFor, NEWEST.version, 'the card is marked as shown');
});

test('the toast is answered once per version and not again', async () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: true }, NEWEST.version, {});
  await sendMessage(env, { type: 'realview-toast-query' }).answered;

  const second = await sendMessage(env, { type: 'realview-toast-query' }).answered;
  assert.deepStrictEqual(plain(second), { show: false }, 'a second Studio tab gets no card');
});

test('the toast switch turned off keeps the card away', async () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: true }, NEWEST.version, { toast: false });
  const reply = await sendMessage(env, { type: 'realview-toast-query' }).answered;

  assert.deepStrictEqual(plain(reply), { show: false });
  assert.strictEqual(env.stored.toastShownFor, undefined,
    'and nothing is spent, so the card still waits for the switch to come back on');
});

test('nothing unread means nothing to say', async () => {
  const env = loadBackground({ lastSeenVersion: NEWEST.version, unread: false }, NEWEST.version, {});
  const reply = await sendMessage(env, { type: 'realview-toast-query' }).answered;
  assert.deepStrictEqual(plain(reply), { show: false });
});

test('closing the card counts as having read the news', async () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: true }, NEWEST.version, {});
  const { kept, answered } = sendMessage(env, { type: 'realview-toast-seen' });

  assert.strictEqual(kept, true);
  assert.deepStrictEqual(plain(await answered), { ok: true });
  assert.strictEqual(env.stored.unread, false);
  assert.strictEqual(env.stored.lastSeenVersion, NEWEST.version);
  assert.deepStrictEqual(env.calls.badgeText, [''], 'the badge is cleared');
});

test('a message meant for somebody else is left alone', async () => {
  const env = loadBackground({ lastSeenVersion: '1.5.4', unread: true }, NEWEST.version, {});
  const { kept, answered } = sendMessage(env, { type: 'something-else-entirely' });

  assert.strictEqual(kept, false, 'so another listener could still answer it');
  assert.strictEqual(await answeredWithin(answered), null, 'and no answer is sent');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (error) {
      failed++;
      console.log('  FAIL ' + name);
      console.log('       ' + error.message);
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passing');
  process.exit(failed ? 1 : 0);
})();
