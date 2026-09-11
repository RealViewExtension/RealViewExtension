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
function fakeChrome(stored, version) {
  const calls = { badgeText: [], badgeColour: [] };
  const listeners = {};
  const chrome = {
    runtime: {
      getManifest: () => ({ version }),
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } }
    },
    storage: {
      local: {
        get(defaults, callback) {
          const out = {};
          Object.keys(defaults).forEach((key) => {
            out[key] = stored[key] === undefined ? defaults[key] : stored[key];
          });
          callback(out);
        },
        set(values, callback) {
          Object.keys(values).forEach((key) => { stored[key] = values[key]; });
          if (callback) callback();
        }
      }
    },
    action: {
      setBadgeText(details) { calls.badgeText.push(details.text); },
      setBadgeBackgroundColor(details) { calls.badgeColour.push(details.color); }
    }
  };
  return { chrome, calls, listeners, stored };
}

function loadBackground(stored, version) {
  const env = fakeChrome(stored || {}, version || manifest.version);
  const source = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
  vm.runInNewContext(source, { chrome: env.chrome, console });
  return env;
}

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
