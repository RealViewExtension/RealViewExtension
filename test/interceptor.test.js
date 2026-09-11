'use strict';

const assert = require('assert');
const { createEnvironment, request } = require('./harness');

const CHANNEL = 'UCtest';
const OFFSET = -10800;
const DAY = 86400000;
const HOUR = 3600000;

// The dates the fixtures use, expressed the way the API does.
function dateId(ms) {
  const d = new Date(ms + OFFSET * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function dayStart(offsetDays) {
  const todayStart = Math.floor((Date.now() + OFFSET * 1000) / DAY) * DAY - OFFSET * 1000;
  return todayStart + offsetDays * DAY;
}

function screenRequest(entity = { channelId: CHANNEL }, period = 'ANALYTICS_TIME_PERIOD_TYPE_WEEK') {
  return JSON.stringify({
    context: { client: { clientName: 62 } },
    screenConfig: { entity, timePeriod: { timePeriodType: period }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    desktopState: { tabId: 'ANALYTICS_TAB_ID_OVERVIEW' }
  });
}

// A screen with a headline card, its daily chart, the sentence above it and a
// per-video table - the four things the extension has to convert.
function screenResponse() {
  const datums = [];
  for (let i = 7; i >= 1; i--) datums.push({ x: dayStart(-i), y: i });
  return JSON.stringify({
    cards: [
      { personalizedHeaderCardData: { title: 'Your channel got 28 views in the last 7 days' } },
      {
        keyMetricCardData: {
          keyMetricTabs: [
            {
              metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
              primaryContent: {
                metric: 'EXTERNAL_VIEWS',
                total: 28,
                previousTotal: 20,
                mainSeries: { datums, timeUnit: 'TIME_PERIOD_UNIT_DAYS' },
                typicalPerformanceTotal: { typicalValue: 30 },
                anomalies: [{ type: 'ANALYTICS_ANOMALY_TYPE_NEW_VOD_VIEW_COUNT_EXTERNAL_VIEWS_COUNTING' }]
              }
            },
            { metricTabConfig: { metric: 'EXTERNAL_WATCH_TIME' }, primaryContent: { metric: 'EXTERNAL_WATCH_TIME', total: 500 } }
          ]
        }
      },
      {
        tableCardData: {
          mainTableData: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [20, 8] } }]
          }
        }
      }
    ]
  });
}

// A realtime card: 48 hourly buckets plus a top-videos table.
function realtimeResponse() {
  const timestamps = [];
  const base = Math.floor(Date.now() / 3600000) * 3600000 - 47 * 3600000;
  for (let i = 0; i < 48; i++) timestamps.push(base + i * 3600000);
  return JSON.stringify({
    cards: [{
      latestActivityCardData: {
        datas: [{
          timePeriod: 'ANALYTICS_TIME_PERIOD_TYPE_REALTIME_LAST_48_HOURS',
          mainChartData: {
            dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: timestamps } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: timestamps.map(() => 1) } }]
          },
          topEntitiesData: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
            metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [14, 2] } }]
          }
        }]
      }
    }]
  });
}

// Answers any query with a fixed engaged number, so assertions can tell
// substituted figures from the raw ones at a glance.
function joinResponder(perLabel = {}, scalar = 7) {
  return (body) => {
    const parsed = JSON.parse(body);
    const results = parsed.nodes.map((node) => {
      const query = node.value.query;
      const dimension = query.dimensions[0] && query.dimensions[0].type;
      if (!dimension) {
        return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [scalar] } }] } } };
      }
      if (dimension === 'VIDEO') {
        const ids = Object.keys(perLabel).length ? Object.keys(perLabel) : ['vidA', 'vidB'];
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ids } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: ids.map((id) => (perLabel[id] === undefined ? 3 : perLabel[id])) } }]
            }
          }
        };
      }
      if (dimension === 'DAY') {
        const start = query.timeRange.dateIdRange.inclusiveStart;
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'DAY' }, dateIds: { values: [start] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }]
            }
          }
        };
      }
      if (dimension === 'HOUR') {
        const startSec = Number(query.timeRange.unixTimeRange.inclusiveStart);
        return {
          key: node.key,
          value: {
            resultTable: {
              dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: [startSec * 1000] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [9] } }]
            }
          }
        };
      }
      return { key: node.key, value: {} };
    });
    return { status: 200, text: JSON.stringify({ results }) };
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('screen: headline, chart, sentence and table are all substituted', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const payload = JSON.parse(result.text);

  const content = payload.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.metric, 'ENGAGED_VIEWS', 'headline metric renamed');
  assert.strictEqual(content.total, 7, 'headline total substituted');
  assert.strictEqual(content.previousTotal, 7, 'previous total substituted');
  assert.strictEqual(content.typicalPerformanceTotal, undefined, 'typical range dropped');
  assert.strictEqual(content.anomalies, undefined, 'view-counting anomaly dropped');

  const series = content.mainSeries.datums;
  assert.strictEqual(series.filter((d) => d.y === 5).length, 1, 'the one day with data is filled in');
  assert.strictEqual(series.filter((d) => d.y === 0).length, series.length - 1, 'days without data become zero');

  assert.strictEqual(payload.cards[1].keyMetricCardData.keyMetricTabs[0].metricTabConfig.metric, 'ENGAGED_VIEWS', 'tab renamed');
  assert.strictEqual(payload.cards[1].keyMetricCardData.keyMetricTabs[1].metricTabConfig.metric, 'EXTERNAL_WATCH_TIME', 'other metrics untouched');

  assert.strictEqual(payload.cards[0].personalizedHeaderCardData.title, 'Your channel got 7 engaged views in the last 7 days');

  const table = payload.cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.strictEqual(table.metric.type, 'EXTERNAL_VIEWS', 'the column keeps the name Studio configured');
  assert.deepStrictEqual(table.counts.values, [11, 4], 'table rows matched by video id');
});

test('screen: the engaged query runs in parallel, not after the screen', async () => {
  const order = [];
  const env = createEnvironment({
    'get_screen': (body) => { order.push('screen'); return { status: 200, text: screenResponse() }; },
    'yta_web/join': (body) => { order.push('join'); return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.ok(order.indexOf('join') <= order.indexOf('screen') + 1, 'join is issued alongside the screen request');
  assert.strictEqual(order[0], 'join', 'the guessed query goes out first, before the screen answers');
});

test('cards: the request goes out exactly as Studio wrote it', async () => {
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': joinResponder({ vidA: 5, vidB: 1 })
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, timePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_WEEK' }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: [{ keyMetricCardConfig: { metricTabConfigs: [{ metric: 'EXTERNAL_VIEWS' }] } }]
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);

  const outgoing = env.sent.find((entry) => entry.url.includes('get_cards'));
  assert.strictEqual(outgoing.body, body, 'the request is not rewritten at all');
});

test('a converted column keeps the name Studio configured for it', async () => {
  // Studio matches a card's configured metric against the columns it gets back.
  // Renaming a column it cannot then find makes it discard the whole screen.
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder({ vidA: 11, vidB: 4 }) });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const payload = JSON.parse(result.text);

  const column = payload.cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.strictEqual(column.metric.type, 'EXTERNAL_VIEWS', 'name untouched');
  assert.deepStrictEqual(column.counts.values, [11, 4], 'numbers replaced');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'flagged so the wording can be corrected in the page');
});

test('a half-converted screen is not flagged for relabelling', async () => {
  // One table answers, the other does not, so the wording must stay as Studio
  // wrote it rather than claim more than the numbers deliver.
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const parsed = JSON.parse(body);
      return {
        status: 200,
        text: JSON.stringify({
          results: parsed.nodes
            .filter((node) => !node.key.startsWith('rv_table'))
            .map((node) => ({ key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }] } } }))
        })
      };
    }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.notStrictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'not flagged for relabelling');
});

test('the realtime table uses its own 48 hours, not the screen period', async () => {
  const queries = [];
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': (body) => {
      JSON.parse(body).nodes.forEach((node) => queries.push(node.value.query));
      return joinResponder({ vidA: 5, vidB: 1 })(body);
    }
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, timePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS' }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: []
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);

  const videoQuery = queries.find((q) => q.dimensions[0] && q.dimensions[0].type === 'VIDEO');
  assert.ok(videoQuery, 'the video table was queried');
  assert.ok(videoQuery.timeRange.unixTimeRange, 'over an hourly window rather than the 28 day period');
  const span = Number(videoQuery.timeRange.unixTimeRange.exclusiveEnd) - Number(videoQuery.timeRange.unixTimeRange.inclusiveStart);
  assert.strictEqual(span, 48 * 3600, 'exactly the 48 hours the card covers');

  const top = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].topEntitiesData.metricColumns[0];
  assert.deepStrictEqual(top.counts.values, [5, 1], 'and the card shows those hours');
});

test('dashboard: a query already asking for both metrics is left alone', async () => {
  const env = createEnvironment({ 'yta_web/join': () => ({ status: 200, text: '{"results":[]}' }) });
  const body = JSON.stringify({
    context: {},
    nodes: [{ key: 'a', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }, { type: 'ENGAGED_VIEWS' }] } } }]
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);
  assert.strictEqual(env.sent[0].body, body, 'passed through unchanged');
});

test('a table split by two dimensions at once is skipped, not mangled', async () => {
  const env = createEnvironment({
    'get_cards': JSON.stringify({
      cards: [{
        latestActivityCardData: {
          datas: [{
            sparkChartData: {
              dimensionColumns: [
                { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
                { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
              ],
              metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
            }
          }]
        }
      }]
    }),
    'yta_web/join': joinResponder()
  });
  const body = JSON.stringify({ context: {}, screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET }, cardConfigs: [] });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);
  const column = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].sparkChartData.metricColumns[0];
  assert.strictEqual(column.metric.type, 'EXTERNAL_VIEWS', 'left raw rather than half-converted');
  assert.deepStrictEqual(column.counts.values, [3, 4]);
});

test('realtime: the 48-hour card is substituted from its own hourly window', async () => {
  const env = createEnvironment({
    'get_cards': realtimeResponse(),
    'yta_web/join': joinResponder({ vidA: 5, vidB: 1 })
  });
  const body = JSON.stringify({
    context: {},
    screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    cardConfigs: []
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_cards?alt=json', body);
  const data = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0];

  assert.strictEqual(data.mainChartData.metricColumns[0].metric.type, 'EXTERNAL_VIEWS', 'the column keeps its configured name');
  const hourly = data.mainChartData.metricColumns[0].counts.values;
  assert.strictEqual(hourly.filter((v) => v === 9).length, 1, 'the hour with data is filled in');
  assert.strictEqual(hourly.filter((v) => v === 0).length, 47, 'hours without data become zero');

  assert.deepStrictEqual(data.topEntitiesData.metricColumns[0].counts.values, [5, 1], 'top videos substituted by id');

  const query = JSON.parse(env.sent.find((e) => e.url.includes('join')).body).nodes
    .map((n) => n.value.query).find((q) => q.dimensions[0] && q.dimensions[0].type === 'HOUR');
  assert.ok(query.timeRange.unixTimeRange, 'the hourly query uses a unix time range');
  const span = Number(query.timeRange.unixTimeRange.exclusiveEnd) - Number(query.timeRange.unixTimeRange.inclusiveStart);
  assert.strictEqual(span, 48 * 3600, 'the window is exactly the 48 hours the card draws');
});

test('dashboard: a page query is swapped out and renamed back', async () => {
  const env = createEnvironment({
    'yta_web/join': () => ({ status: 200, text: JSON.stringify({ results: [{ key: '0__X', value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } }] }) })
  });
  const body = JSON.stringify({
    context: {},
    nodes: [{ key: '0__X', value: { query: { dimensions: [], metrics: [{ type: 'EXTERNAL_VIEWS' }] } } }],
    trackingLabel: 'web_creator_channel_dashboard_mixer'
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);

  assert.ok(env.sent[0].body.includes('"ENGAGED_VIEWS"'), 'the query asks for engaged views');
  assert.ok(result.text.includes('"EXTERNAL_VIEWS"'), 'the answer is renamed back for the caller');
  assert.ok(!result.text.includes('"ENGAGED_VIEWS"'), 'no engaged name leaks into the caller');
  assert.strictEqual(env.attributes['data-realview-converted-dashboard'], 'yes', 'dashboard flagged for relabelling');
});

test("dashboard: the extension's own queries are left alone", async () => {
  const env = createEnvironment({ 'yta_web/join': () => ({ status: 200, text: '{"results":[]}' }) });
  const body = JSON.stringify({ context: {}, trackingLabel: 'realview', nodes: [{ key: 'rv', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }] } } }] });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json', body);
  assert.ok(env.sent[0].body.includes('"EXTERNAL_VIEWS"'), 'its own request is not rewritten again');
});

test('content tab: lifetime view counts are replaced per video', async () => {
  const env = createEnvironment({
    'list_creator_videos': JSON.stringify({
      videos: [
        { videoId: 'vidA', channelId: CHANNEL, publicMetrics: { viewCount: '100', externalViewCount: '100', likeCount: '2' } },
        { videoId: 'vidB', channelId: CHANNEL, publicMetrics: { viewCount: '50', externalViewCount: '50', likeCount: '1' } }
      ]
    }),
    'yta_web/join': joinResponder({ vidA: 40, vidB: 25 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/list_creator_videos?alt=json', JSON.stringify({ context: {} }));
  const videos = JSON.parse(result.text).videos;

  assert.strictEqual(videos[0].publicMetrics.viewCount, '40');
  assert.strictEqual(videos[0].publicMetrics.externalViewCount, '40');
  assert.strictEqual(videos[1].publicMetrics.viewCount, '25');
  assert.strictEqual(videos[0].publicMetrics.likeCount, '2', 'other metrics untouched');
  assert.strictEqual(env.attributes['data-realview-converted-videolist'], 'yes', 'video list flagged for relabelling');
});

test('a query that never answers cannot hold the screen open', async () => {
  const stalled = () => ({ status: 200, text: '{"results":[]}' });
  stalled.__delay = Infinity;
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': stalled });

  const started = Date.now();
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const waited = Date.now() - started;

  assert.ok(waited < 9000, 'delivered within the query budget, took ' + waited + 'ms');
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.metric, 'EXTERNAL_VIEWS', 'untouched rather than relabelled');
  assert.strictEqual(content.total, 28, 'the original figure survives');
});

test('a failed query leaves the response exactly as it was', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.text, screenResponse(), 'byte-identical passthrough');
});

test('an error from Studio itself is passed straight through', async () => {
  const env = createEnvironment({
    'get_screen': () => ({ status: 503, text: 'unavailable' }),
    'yta_web/join': joinResponder()
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.text, 'unavailable');
});

test('a repeated screen is served from cache without querying again', async () => {
  let joins = 0;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => { joins++; return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const first = joins;
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(joins, first, 'the second screen asked nothing new');
});

test('turning the extension off restores plain Studio behaviour', async () => {
  const env = createEnvironment(
    { 'get_screen': screenResponse(), 'yta_web/join': joinResponder() },
    { attributes: { 'data-realview-rewrite': 'off' } }
  );
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(result.text, screenResponse());
  assert.strictEqual(env.sent.filter((e) => e.url.includes('join')).length, 0, 'no extra requests at all');
});

test('a video-scoped screen filters by video rather than by channel', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest({ videoId: 'vidA' }));
  const query = JSON.parse(env.sent.find((e) => e.url.includes('join')).body).nodes[0].value.query;
  assert.deepStrictEqual(query.restricts[0], { dimension: { type: 'VIDEO' }, inValues: ['vidA'] });
});

test('a rewritten response is announced only once, as finished', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const states = [];
  const events = [];

  await new Promise((resolve) => {
    const xhr = new env.FakeXHR();
    xhr.open('POST', 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json');
    xhr.onreadystatechange = () => { states.push(xhr.readyState); events.push('readystatechange'); };
    xhr.addEventListener('load', () => { events.push('load'); });
    xhr.addEventListener('loadend', () => { events.push('loadend'); resolve(); });
    xhr.send(screenRequest());
  });

  assert.deepStrictEqual(states, [4], 'no intermediate states are replayed');
  assert.deepStrictEqual(events, ['readystatechange', 'load', 'loadend'], 'each event fires once, in order');
});

test('an exception anywhere in the extension still lets the request through', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });

  // Break the settings lookup the way a hostile page or a future Chrome change
  // might; the request must still reach Studio.
  const documentElement = env.attributes;
  const original = Object.getOwnPropertyDescriptor(env, 'attributes');
  const xhr = new env.FakeXHR();
  xhr.open('POST', 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json');
  Object.defineProperty(xhr, '__realViewUrl', {
    configurable: true,
    get() { throw new Error('boom'); }
  });

  const result = await new Promise((resolve) => {
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ status: xhr.status, error: true });
    xhr.send(screenRequest());
  });

  assert.strictEqual(result.status, 200, 'the request went out despite the failure');
  assert.strictEqual(result.text, screenResponse(), 'and returned Studio\'s own answer');
  if (original) Object.defineProperty(env, 'attributes', original);
  assert.ok(documentElement, 'settings object untouched');
});

test('a json response type receives both the object and the text', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest(), 'json');

  assert.strictEqual(typeof result.response, 'object', 'json readers get a parsed object');
  assert.strictEqual(typeof result.text, 'string', 'text readers get the body rather than nothing');
  assert.strictEqual(result.response.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent.total, 7);
});

test('a wrongly guessed period is discarded rather than used', async () => {
  const queries = [];
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => queries.push(n.value.query.timeRange.dateIdRange.inclusiveStart)); return joinResponder()(body); }
  });
  // The request claims a year while the response describes a week, so the
  // figures must come from a query matching the response.
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest({ channelId: CHANNEL }, 'ANALYTICS_TIME_PERIOD_TYPE_YEAR'));

  const responseStart = dateId(dayStart(-7));
  assert.ok(queries.includes(responseStart), 'a query was made for the range the response actually covers');
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.total, 7, 'and the substituted figure comes from it');
});

test('repeated faults make the extension stand down instead of repeating', async () => {
  let screenCalls = 0;
  const env = createEnvironment({
    'get_screen': () => { screenCalls++; return { status: 200, text: screenResponse() }; },
    // Every conversion attempt fails, the way a broken query endpoint would.
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });

  const attempts = [];
  for (let i = 0; i < 4; i++) {
    const before = env.sent.filter((entry) => entry.url.includes('join')).length;
    const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
    assert.strictEqual(result.text, screenResponse(), 'every attempt still returns a working screen');
    attempts.push(env.sent.filter((entry) => entry.url.includes('join')).length - before);
  }

  assert.ok(attempts[0] >= 1, 'it did try at first');
  assert.strictEqual(attempts[3], 0, 'and had stopped trying by the end, attempts were ' + attempts.join(','));
  assert.strictEqual(screenCalls, 4, 'and Studio kept getting its screens throughout');
});

// The content tab asks one query for its whole page, so it either succeeds or
// fails as a whole: the simplest surface to watch a failed query on.
const VIDEO_LIST_URL = 'https://studio.youtube.com/youtubei/v1/creator/list_creator_videos?alt=json';

function videoListPage() {
  return JSON.stringify({ videos: [{ videoId: 'vidA', channelId: CHANNEL, publicMetrics: { viewCount: '100' } }] });
}

function lifetimeCount(result) {
  return JSON.parse(result.text).videos[0].publicMetrics.viewCount;
}

// A clock for the interceptor alone, so a retry due in a minute can be watched
// without waiting one. The harness hands these to it in place of the page's
// own setTimeout and clearTimeout.
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, delay) { pending.set(next, { fn, due: now + (delay || 0) }); return next++; },
    clearTimeout(id) { pending.delete(id); },
    // Runs a test with Date.now following this clock, so a cached answer that
    // lasts a minute expires when the clock says a minute has gone by.
    async holding(run) {
      const real = Date.now;
      const started = real();
      Date.now = () => started + now;
      try { return await run(); } finally { Date.now = real; }
    },
    // Moves the clock on and runs whatever that makes due, letting whatever
    // each one sets off finish before the next.
    async advance(ms) {
      now += ms;
      const due = [...pending].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due);
      for (const [id, timer] of due) {
        pending.delete(id);
        timer.fn();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
}

test('a query that failed is asked again rather than remembered as a failure', async () => {
  let asked = 0;
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    // The first query is refused, everything after it is answered.
    'yta_web/join': (body) => (++asked === 1 ? { status: 500, text: 'nope' } : joinResponder({ vidA: 40 })(body))
  });

  const first = await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  assert.strictEqual(lifetimeCount(first), '100', 'the refused query leaves the count raw');

  // A failure kept in the cache would be handed to every request for the next
  // minute without anybody asking the server again.
  const second = await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  assert.strictEqual(lifetimeCount(second), '40', 'and the next request really does ask again');
});

test('a query that fails is answered from the figures it last really got', async () => {
  let failing = false;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => (failing ? { status: 500, text: 'nope' } : joinResponder()(body))
  });
  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';

  const first = await request(env, url, screenRequest());
  assert.strictEqual(JSON.parse(first.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent.total, 7);

  // Two minutes on, the cached answers have expired and the screen really asks
  // again - and the query endpoint has stopped answering.
  failing = true;
  const later = await at(Date.now() + 2 * 60000, () => request(env, url, screenRequest()));
  const content = JSON.parse(later.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.total, 7, 'the figures the screen last really had are shown');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'and it is still an engaged screen');
});

test('figures older than a quarter of an hour are not shown at all', async () => {
  let failing = false;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => (failing ? { status: 500, text: 'nope' } : joinResponder()(body))
  });
  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';

  await request(env, url, screenRequest());
  failing = true;
  const later = await at(Date.now() + 16 * 60000, () => request(env, url, screenRequest()));

  assert.strictEqual(later.text, screenResponse(), 'the screen is served exactly as Studio sent it');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no', 'and the wording says so rather than claiming engaged views');
});

test('standing down still shows what it remembers, and asks for nothing', async () => {
  let failing = false;
  let refusals = 0;
  let stoodDownAt = null;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      if (!failing) return joinResponder()(body);
      // The second refusal is the one that reaches the fault limit, and the
      // fault is counted the moment this reply is handed over. Whatever is
      // sent from this point on is sent by an extension that has promised to
      // send nothing - so the count starts here rather than at the next
      // request, which would let a fan-out behind this very batch through.
      if (++refusals === 2) stoodDownAt = env.sent.length;
      return { status: 500, text: 'nope' };
    }
  });
  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';

  await request(env, url, screenRequest());
  // The query endpoint breaks, which is what stands the extension down.
  failing = true;
  await at(Date.now() + 2 * 60000, () => request(env, url, screenRequest()));
  const later = await at(Date.now() + 3 * 60000, () => request(env, url, screenRequest()));

  assert.ok(stoodDownAt !== null, 'the queries really did fail twice');
  assert.deepStrictEqual(
    env.sent.slice(stoodDownAt).map((entry) => entry.url),
    [url],
    "the only thing sent afterwards was Studio's own screen request, relayed - no query, no video lookup"
  );
  const content = JSON.parse(later.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.total, 7, 'and the screen still carries the figures it remembers');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('standing down does not look a video up either', async () => {
  // The ranking dates its videos from Studio's own video list, which is a
  // request like any other: once the extension has stood down it goes without.
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidD' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidE' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const env = createEnvironment({
    'get_screen': JSON.stringify({ cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidD' }, ranking } }] }),
    'list_creator_videos': () => ({ status: 500, text: 'nope' }),
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });
  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  // The first screen's own queries all fail, which is what stands the
  // extension down; from the next request on it sends nothing of its own.
  await request(env, url, screenRequest());
  const before = env.sent.length;
  const later = await request(env, url, screenRequest());

  assert.deepStrictEqual(
    env.sent.slice(before).map((entry) => entry.url),
    [url],
    "Studio's own screen request was relayed and nothing else went out - no video lookup, no query"
  );
  const entities = JSON.parse(later.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.entity.videoId), ['vidD', 'vidE'], 'and the ranking is left exactly as the server sent it');
});

test('a batch already in flight when it stands down is not split up and sent again', async () => {
  // A batch that comes back missing is normally asked again query by query,
  // which is several fresh requests. If it was that batch's own failure that
  // reached the fault limit, those requests would go out from an extension
  // that had just promised to send nothing at all.
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    'get_screen': screenResponse(),
    'yta_web/join': () => ({ status: 500, text: 'nope' })
  });
  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';

  // The video list asks one question, so its refusal is one fault and there is
  // nothing to split up: the extension is one fault short of standing down.
  await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  const before = env.sent.length;

  // The screen asks several questions at once, and the refusal of that batch
  // is the fault that stands the extension down.
  const later = await request(env, url, screenRequest());

  const joins = env.sent.slice(before).filter((entry) => entry.url.includes('yta_web/join'));
  assert.strictEqual(joins.length, 1, 'the batch went out once and no stragglers followed it');
  assert.ok(JSON.parse(joins[0].body).nodes.length > 1, 'and it really was a batch of several queries');
  assert.strictEqual(later.text, screenResponse(), 'the screen is served exactly as Studio sent it');
});

test('a failed query is asked again at five, fifteen and sixty seconds', async () => {
  const timers = fakeTimers();
  let joins = 0;
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    'yta_web/join': () => { joins++; return { status: 500, text: 'nope' }; }
  }, { timers });

  await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  const asked = joins;

  await timers.advance(4000);
  assert.strictEqual(joins, asked, 'nothing before the first delay is up');
  await timers.advance(1000);
  assert.strictEqual(joins, asked + 1, 'the first retry goes out five seconds after the failure');
  await timers.advance(15000);
  assert.strictEqual(joins, asked + 2, 'the second fifteen seconds after that one');
  await timers.advance(60000);
  assert.strictEqual(joins, asked + 3, 'and the third a minute after that');
  await timers.advance(600000);
  assert.strictEqual(joins, asked + 3, 'then it gives up rather than asking forever');

  // None of those three counted as a fault, so the extension has not stood
  // down and a request of Studio's own still gets a query of its own.
  await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  assert.strictEqual(joins, asked + 4, 'a retry that fails is not a fault');
});

test("a retry's answer is waiting for the next request", async () => {
  const timers = fakeTimers();
  let joins = 0;
  let failing = true;
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    'yta_web/join': (body) => { joins++; return failing ? { status: 500, text: 'nope' } : joinResponder({ vidA: 40 })(body); }
  }, { timers });

  const first = await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  assert.strictEqual(lifetimeCount(first), '100', 'the first page is served raw');

  failing = false;
  await timers.advance(5000);
  assert.strictEqual(joins, 2, 'the retry went out on its own');

  const second = await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  assert.strictEqual(lifetimeCount(second), '40', 'and the next page is converted');
  assert.strictEqual(joins, 2, 'from the answer already waiting, without asking again');
});

test('a request of its own calls off the retry behind it', async () => {
  const timers = fakeTimers();
  let joins = 0;
  let failing = true;
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    'yta_web/join': (body) => { joins++; return failing ? { status: 500, text: 'nope' } : joinResponder({ vidA: 40 })(body); }
  }, { timers });

  await timers.holding(async () => {
    await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
    await timers.advance(5000);
    await timers.advance(15000);

    // A request of Studio's own makes the attempt the chain was waiting to
    // make, so the third retry has nothing left to do.
    failing = false;
    const second = await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
    assert.strictEqual(lifetimeCount(second), '40', 'the request asked for itself and was answered');

    // Far enough past the third retry that its answer would have expired too,
    // so a chain still running would really have sent something.
    const asked = joins;
    await timers.advance(70000);
    assert.strictEqual(joins, asked, 'and the chain behind it was called off rather than asking again');
  });
});

test('standing down calls off the retries as well', async () => {
  const timers = fakeTimers();
  let joins = 0;
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': () => { joins++; return { status: 500, text: 'nope' }; }
  }, { timers });

  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const asked = joins;

  await timers.advance(600000);
  assert.strictEqual(joins, asked, 'nothing was asked again once it had stood down');
});

test('a retry scheduled before the extension was turned off does not go out', async () => {
  // The retries run a minute and more behind the request that scheduled them,
  // which is long enough for the popup's switch to have moved. An extension
  // that is off sends nothing, in the background as much as in front of a
  // waiting screen.
  const timers = fakeTimers();
  let joins = 0;
  const env = createEnvironment({
    'list_creator_videos': videoListPage(),
    'yta_web/join': () => { joins++; return { status: 500, text: 'nope' }; }
  }, { timers });

  await request(env, VIDEO_LIST_URL, JSON.stringify({ context: {} }));
  const asked = joins;

  // The bridge mirrors the popup's switch onto the document element, which is
  // where the interceptor reads it.
  env.attributes['data-realview-rewrite'] = 'off';

  await timers.advance(5000);
  assert.strictEqual(joins, asked, 'the retry that was due says nothing');
  await timers.advance(600000);
  assert.strictEqual(joins, asked, 'and the chain behind it is not carried on either');
});

test('the channel dashboard asks for the engaged metric and reads back its own', async () => {
  const env = createEnvironment({
    'get_channel_dashboard': () => ({ status: 200, text: JSON.stringify({ cards: [{ body: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [47] } }] } } }] }) })
  });
  const body = JSON.stringify({
    context: {},
    dashboardParams: { channelId: CHANNEL, facts: [{ query: { metrics: [{ type: 'EXTERNAL_VIEWS' }] } }] }
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_channel_dashboard?alt=json', body);

  const outgoing = env.sent.find((entry) => entry.url.includes('get_channel_dashboard'));
  assert.ok(outgoing.body.includes('"ENGAGED_VIEWS"'), 'the dashboard query asks for engaged views');
  assert.ok(result.text.includes('"EXTERNAL_VIEWS"'), 'and the answer is renamed back for the caller');
  assert.ok(result.text.includes('47'), 'carrying the engaged figure');
  assert.strictEqual(env.attributes['data-realview-converted-dashboard'], 'yes');
});

test('the card gets a typical range worked out from engaged history', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const parsed = JSON.parse(body);
      return {
        status: 200,
        text: JSON.stringify({
          results: parsed.nodes.map((node) => {
            const query = node.value.query;
            const daily = query.dimensions[0] && query.dimensions[0].type === 'DAY';
            const start = query.timeRange.dateIdRange.inclusiveStart;
            const end = query.timeRange.dateIdRange.exclusiveEnd;
            // The history query is the long one; answer it with a run of days.
            if (daily && String(end - start).length > 2) {
              const labels = [];
              const values = [];
              let ms = dayStart(-1 - 8 * 7);
              for (let i = 0; i < 8 * 7; i++) { labels.push(dateId(ms)); values.push(1 + Math.floor(i / 7)); ms += DAY; }
              return { key: node.key, value: { resultTable: { dimensionColumns: [{ dimension: { type: 'DAY' }, dateIds: { values: labels } }], metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }] } } };
            }
            return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } };
          })
        })
      };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.ok(content.typicalPerformanceTotal, 'the card keeps a typical range rather than losing it');
  const band = content.typicalPerformanceTotal.typicalRange;
  assert.ok(band.lowerBound <= content.typicalPerformanceTotal.typicalValue, 'band brackets the middle value');
  assert.ok(band.upperBound >= content.typicalPerformanceTotal.typicalValue, 'band brackets the middle value');
  assert.notStrictEqual(content.typicalPerformanceTotal.typicalValue, 30, 'not the raw figure the fixture shipped with');
});

test('a card with too little history loses its typical range rather than inventing one', async () => {
  const env = createEnvironment({ 'get_screen': screenResponse(), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;
  assert.strictEqual(content.typicalPerformanceTotal, undefined);
});

test('a typical performance query is never asked for the engaged metric', async () => {
  // The server answers such a query with nothing, which is what removed the
  // comparison from the dashboard in the first place.
  const env = createEnvironment({ 'get_channel_dashboard': () => ({ status: 200, text: '{"cards":[]}' }) });
  const body = JSON.stringify({
    context: {},
    dashboardParams: {
      channelId: 'UCtest',
      nodes: [
        { key: 'current', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }], timeRange: { dateIdRange: { inclusiveStart: 20260803, exclusiveEnd: 20260831 } } } } },
        { key: 'typical', value: { getTypicalPerformance: { query: { metrics: [{ metric: { type: 'EXTERNAL_VIEWS' } }] } } } }
      ]
    }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_channel_dashboard?alt=json', body);

  const sent = JSON.parse(env.sent.find((e) => e.url.includes('get_channel_dashboard')).body);
  const nodes = sent.dashboardParams.nodes;
  assert.strictEqual(nodes[0].value.query.metrics[0].type, 'ENGAGED_VIEWS', 'the ordinary query is swapped');
  assert.strictEqual(nodes[1].value.getTypicalPerformance.query.metrics[0].metric.type, 'EXTERNAL_VIEWS', 'the typical query is left alone');
});

test('a screen carrying a latest-video snapshot is not relabelled', async () => {
  // That card's figures are not metric columns, so they stay raw. Relabelling
  // the screen would caption a raw count as an engaged one.
  const withSnapshot = JSON.parse(screenResponse());
  withSnapshot.cards.push({ entitySnapshotCardData: { item: { viewCount: '149600' } } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(withSnapshot),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  assert.notStrictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'wording left as Studio wrote it');
  const column = JSON.parse(result.text).cards[2].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [11, 4], 'the figures it can convert are still converted');
});

test('a traffic source table is converted and its share column follows', async () => {
  const payload = {
    cards: [{
      tableCardData: {
        mainTableData: {
          dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['SUBSCRIBER', 'YT_SEARCH'] } }],
          metricColumns: [
            { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [800, 200] } },
            { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [80, 20] } }
          ]
        }
      }
    }]
  };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => ({
          key: node.key,
          value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH', 'SUBSCRIBER'] } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [100, 300] } }]
          } }
        }))
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(columns[0].counts.values, [300, 100], 'rows matched by enumerated name, not position');
  assert.deepStrictEqual(columns[1].percentages.values, [75, 25], 'the share column is recomputed from them');
});

test('a cumulative chart is rebuilt as a running total ending at the figure shown', async () => {
  const datums = [];
  for (let i = 7; i >= 1; i--) datums.push({ x: dayStart(-i), y: i * 10 });
  const payload = {
    cards: [{
      keyMetricCardData: {
        keyMetricTabs: [{
          metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
          primaryContent: {
            metric: 'EXTERNAL_VIEWS',
            total: 70,
            mainSeries: { datums, isCumulative: true, timeUnit: 'TIME_PERIOD_UNIT_NTH_DAYS' },
            typicalPerformanceSeries: { datums: [{ x: 1, y: 2 }] }
          }
        }]
      }
    }]
  };
  const env = createEnvironment({ 'get_screen': JSON.stringify(payload), 'yta_web/join': joinResponder() });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[0].keyMetricCardData.keyMetricTabs[0].primaryContent;

  const ys = content.mainSeries.datums.map((d) => d.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], 'the line only ever climbs');
  assert.strictEqual(ys[ys.length - 1], content.total, 'and ends on the figure the card reports');
  assert.strictEqual(content.typicalPerformanceSeries, undefined, 'the raw band behind it is dropped');
});

test("a cumulative total takes today's figures from the live store", async () => {
  const datums = [];
  for (let i = 3; i >= 1; i--) datums.push({ x: dayStart(-i), y: i });
  const payload = { cards: [{ keyMetricCardData: { keyMetricTabs: [{ metricTabConfig: { metric: 'EXTERNAL_VIEWS' }, primaryContent: { metric: 'EXTERNAL_VIEWS', total: 5, mainSeries: { datums, isCumulative: true } } }] } }] };
  const queries = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => queries.push(n)); return joinResponder()(body); }
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  // Whole days come from the daily store; today comes by the hour, because a
  // query with no dimension is refused over a clock-time range.
  const live = queries.filter((n) => n.value.query.timeRange.unixTimeRange);
  assert.ok(live.length, 'part of the window is asked for by clock time');
  assert.ok(live.every((n) => n.value.query.dimensions.length > 0), 'and always with a dimension');
  assert.ok(live.some((n) => (n.value.query.dimensions[0] || {}).type === 'HOUR'), 'today is asked for by the hour');

  const daily = queries.filter((n) => n.value.query.timeRange.dateIdRange && n.value.query.dimensions.length === 0);
  assert.ok(daily.length, 'the settled days are asked for as whole days');
});

test('a screen with a figure left raw is not relabelled', async () => {
  // The join answers the headline but not the table, so one column keeps its
  // raw figure and the screen must keep Studio's wording.
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes
          .filter((node) => !node.key.startsWith('rv_table'))
          .map((node) => ({ key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [5] } }] } } }))
      })
    })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no', 'and says so, in case an earlier response said otherwise');
});

test('one query the server rejects does not take the others down with it', async () => {
  const env = createEnvironment({
    'get_screen': screenResponse(),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      // The server fails the whole request when any query in it is unsupported.
      const poisoned = nodes.some((n) => n.value.query.timeRange.unixTimeRange);
      return {
        status: 200,
        text: JSON.stringify({
          results: nodes.map((n) => (poisoned
            ? { key: n.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } }
            : joinResponder({ vidA: 11, vidB: 4 })(JSON.stringify({ nodes: [n] })).text
              ? JSON.parse(joinResponder({ vidA: 11, vidB: 4 })(JSON.stringify({ nodes: [n] })).text).results[0]
              : { key: n.key, value: {} }))
        })
      };
    }
  });

  // A cumulative card asks for its total by clock time as well, and that is the
  // query this fixture refuses.
  const payload = JSON.parse(screenResponse());
  payload.cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent.mainSeries.isCumulative = true;
  env.routes = null;

  const withCumulative = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      const poisoned = nodes.some((n) => n.value.query.timeRange.unixTimeRange);
      if (poisoned) return { status: 200, text: JSON.stringify({ results: nodes.map((n) => ({ key: n.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } })) }) };
      return joinResponder({ vidA: 11, vidB: 4 })(body);
    }
  });

  const result = await request(withCumulative, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[1].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.metric, 'ENGAGED_VIEWS', 'the card still converted');
  assert.strictEqual(content.total, 7, 'from the query the server did accept');
});

test('a sparkline that cannot be converted does not block the wording', async () => {
  // Split by two dimensions, so it is skipped by design. It draws a shape
  // rather than a captioned figure, so it must not hold back the relabelling.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({
    latestActivityCardData: {
      datas: [{
        sparkChartData: {
          dimensionColumns: [
            { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
            { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
          ],
          metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
        }
      }]
    }
  });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('several points inside one bucket are not each credited with it', async () => {
  // A "since published" chart draws many points inside the first day. Adding
  // that day's figure once per point inflated the line to several times the
  // real total before it snapped back at the end.
  const dayOne = dayStart(-1);
  const datums = [];
  for (let i = 0; i < 6; i++) datums.push({ x: dayOne + i * 3 * 3600000, y: 1000 * (i + 1) });

  const payload = { cards: [{ keyMetricCardData: { keyMetricTabs: [{
    metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
    primaryContent: { metric: 'EXTERNAL_VIEWS', total: 90000, mainSeries: { datums, isCumulative: true } }
  }] } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const dimension = (node.value.query.dimensions[0] || {}).type;
          if (dimension !== 'HOUR') return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [999999] } }] } } };
          // Six hourly buckets of 100 each, spread across the same day.
          const labels = [];
          const values = [];
          for (let i = 0; i < 6; i++) { labels.push(dayOne + i * 3 * 3600000); values.push(100); }
          return { key: node.key, value: { resultTable: { dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: labels } }], metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }] } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[0].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.total, 600, 'the figure is the sum of the buckets, counted once each');
  const ys = content.mainSeries.datums.map((d) => d.y);
  assert.deepStrictEqual(ys, [100, 200, 300, 400, 500, 600], 'and the line is their running total');
  assert.strictEqual(ys[ys.length - 1], content.total, 'ending exactly on the figure shown');
});

test('points finer than the hourly buckets climb steadily rather than once an hour', async () => {
  // A new video's chart marks every few minutes, while the engaged figures
  // only come by the hour. Crediting each hour whole at its start drew a
  // staircase: flat for an hour, then a jump. Each hour is spread across its
  // minutes instead.
  const start = dayStart(-1);
  const datums = [];
  for (let i = 0; i <= 12; i++) datums.push({ x: start + i * 10 * 60000, y: 0 });

  const payload = { cards: [{ keyMetricCardData: { keyMetricTabs: [{
    metricTabConfig: { metric: 'EXTERNAL_VIEWS' },
    primaryContent: { metric: 'EXTERNAL_VIEWS', total: 9000, mainSeries: { datums, isCumulative: true } }
  }] } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const dimension = (node.value.query.dimensions[0] || {}).type;
          if (dimension !== 'HOUR') return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [999999] } }] } } };
          // Two hourly buckets: 600 in the first hour, 300 in the second.
          const labels = [start, start + 3600000];
          const values = [600, 300];
          return { key: node.key, value: { resultTable: { dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: labels } }], metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }] } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const content = JSON.parse(result.text).cards[0].keyMetricCardData.keyMetricTabs[0].primaryContent;

  assert.strictEqual(content.total, 900);
  const ys = content.mainSeries.datums.map((d) => Math.round(d.y));
  assert.deepStrictEqual(ys, [0, 100, 200, 300, 400, 500, 600, 650, 700, 750, 800, 850, 900], 'every ten minutes adds its share of the hour');
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], 'and the line never falls');
});

test('a card reporting figures in an unfamiliar shape withdraws the relabelling', async () => {
  // Nothing here is a metric column, so the substitution had no way in. Saying
  // nothing would leave the card's raw count captioned as an engaged one.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ videoTrafficSourcesCardData: { rows: [{ source: 'BROWSE', metric: 'EXTERNAL_VIEWS', value: 130400 }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no');
});

test('a hidden card is not treated as showing anything', async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ isHidden: true, videoTrafficSourcesCardData: { rows: [{ metric: 'EXTERNAL_VIEWS', value: 1 }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('a share-only table is converted from figures fetched for it', async () => {
  const payload = {
    cards: [{
      tableCardData: {
        mainTableData: {
          dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['US', 'GB'] } }],
          metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [90, 10] } }]
        }
      }
    }]
  };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => ({
          key: node.key,
          value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['US', 'GB'] } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [30, 70] } }]
          } }
        }))
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.percentages.values, [30, 70], 'the shares describe the engaged figures now');
});

test('a real table split two ways still blocks the wording', async () => {
  // Not a sparkline: no time axis, so these are captioned figures on screen.
  // They cannot be converted, so the wording must stay as Studio wrote it.
  const payload = JSON.parse(screenResponse());
  payload.cards.push({
    tableCardData: {
      mainTableData: {
        dimensionColumns: [
          { dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH'] } },
          { dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_SEARCH.thing'] } }
        ],
        metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [130400] } }]
      }
    }
  });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no');
});

test('detail rows are asked for one source type at a time', async () => {
  // The server refuses a traffic detail query that does not say which kind of
  // source it means. The row names carry that as a prefix.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_SEARCH.one', 'YT_SEARCH.two', 'EXT_URL.site'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20, 30] } }]
  } } }] };

  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const nodes = JSON.parse(body).nodes;
      return {
        status: 200,
        text: JSON.stringify({
          results: nodes.map((node) => {
            const restrict = node.value.query.restricts.find((r) => r.dimension.type === 'TRAFFIC_SOURCE_TYPE');
            if (restrict) asked.push(restrict.inValues[0]);
            const rows = restrict && restrict.inValues[0] === 'YT_SEARCH'
              ? { labels: ['YT_SEARCH.one', 'YT_SEARCH.two'], values: [1, 2] }
              : { labels: ['EXT_URL.site'], values: [3] };
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: rows.labels } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: rows.values } }]
            } } };
          })
        })
      };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  assert.deepStrictEqual(asked.sort(), ['EXT_URL', 'YT_SEARCH'], 'one query per kind of source');
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [1, 2, 3], 'and the rows are stitched back together in order');
});

test('a table whose answer has no rows becomes zeros, not a failure', async () => {
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_SEARCH'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [14] } }]
  } } }] };
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({ results: JSON.parse(body).nodes.map((n) => ({ key: n.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [] } }] } } })) })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [0], 'no engaged views in that window means zero, not raw');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test("a card's own view count for a video is converted too", async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ audienceRetentionHighlightsCardData: { videosData: [{ videoId: 'vidA', metricTotals: { avgPercentageWatched: 0.55, views: 3693 } }] } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const totals = JSON.parse(result.text).cards[3].audienceRetentionHighlightsCardData.videosData[0].metricTotals;

  assert.strictEqual(totals.views, 11, 'the count follows the metric');
  assert.strictEqual(totals.avgPercentageWatched, 0.55, 'and nothing else on the card is touched');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes');
});

test('a table listing sources with their details is rebuilt from both', async () => {
  // "YouTube recommendations" with "YouTube Home" and "Up next" beneath it. The
  // server answers each level on its own but not the two together.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [
      { dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_RELATED', 'YT_RELATED', 'YT_RELATED', 'SUBSCRIBER'] } },
      { dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['', 'YT_RELATED.home', 'YT_RELATED.upnext', ''] } }
    ],
    metricColumns: [
      { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [130400, 120400, 10000, 11600] } },
      { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [86.3, 79.7, 6.6, 7.7] } }
    ]
  } } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => ({
      status: 200,
      text: JSON.stringify({
        results: JSON.parse(body).nodes.map((node) => {
          const dimension = (node.value.query.dimensions[0] || {}).type;
          if (dimension === 'TRAFFIC_SOURCE_TYPE') {
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_TYPE' }, enumValues: { values: ['YT_RELATED', 'SUBSCRIBER'] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [60, 8] } }]
            } } };
          }
          if (dimension === 'TRAFFIC_SOURCE_DETAIL') {
            return { key: node.key, value: { resultTable: {
              dimensionColumns: [{ dimension: { type: 'TRAFFIC_SOURCE_DETAIL' }, strings: { values: ['YT_RELATED.home', 'YT_RELATED.upnext'] } }],
              metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [55, 5] } }]
            } } };
          }
          return { key: node.key, value: { resultTable: { metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [7] } }] } } };
        })
      })
    })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(columns[0].counts.values, [60, 55, 5, 8], 'parents from the source figures, children from the detail ones');
  assert.deepStrictEqual(columns[1].percentages.values.map(Math.round), [47, 43, 4, 6], 'shares follow');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'and the wording may be corrected');
});

test("the latest-video card's views row is converted", async () => {
  const payload = JSON.parse(screenResponse());
  payload.cards.push({ entitySnapshotCardData: {
    video: { externalVideoId: 'vidA', videoFormat: 'VIDEO_FORMAT_VOD' },
    metricsTable: { metricRows: [
      { metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 149600 }, typicalRange: {} },
      { metric: { type: 'AVERAGE_WATCH_TIME' }, value: { double: 476 }, typicalRange: {} }
    ] }
  } });

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': joinResponder({ vidA: 11, vidB: 4 })
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const rows = JSON.parse(result.text).cards[3].entitySnapshotCardData.metricsTable.metricRows;

  assert.strictEqual(rows[0].value.double, 11, 'the views row follows the metric');
  assert.strictEqual(rows[1].value.double, 476, 'and the other rows are left alone');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'yes', 'so the card no longer holds the wording back');
});

// The ranking asks about each video hour by hour, so a fixture answers a HOUR
// query with the buckets of the window it names and anything else with a plain
// per-video total. By default a video's whole figure sits in the window's first
// hour, which keeps the arithmetic out of the way of a test about the order;
// `everyHour` puts that much in every hour instead, for the tests about how the
// last one is prorated. The server omits an hour with no views, so the fixture
// does too.
function rankingResponder(engaged, options = {}) {
  const refuse = options.refuse || [];
  // `refuse` names a video the server will not break down by hour but will
  // still total; `deny` names one it will not answer for at all.
  const deny = options.deny || [];
  return (body) => ({
    status: 200,
    text: JSON.stringify({
      results: JSON.parse(body).nodes.map((node) => {
        const query = node.value.query;
        if (options.queries) options.queries.push(query);
        const wanted = (query.restricts.find((r) => r.dimension.type === 'VIDEO') || { inValues: [] }).inValues;
        const figure = (id) => (engaged[id] === undefined ? 0 : engaged[id]);

        if (wanted.length === 1 && deny.indexOf(wanted[0]) !== -1) {
          return { key: node.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } };
        }
        if ((query.dimensions[0] || {}).type !== 'HOUR') {
          return { key: node.key, value: { resultTable: {
            dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: wanted } }],
            metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: wanted.map(figure) } }]
          } } };
        }
        if (refuse.indexOf(wanted[0]) !== -1) return { key: node.key, value: { failure: { errorCode: 'INVALID_ARGUMENT' } } };

        const start = Number(query.timeRange.unixTimeRange.inclusiveStart) * 1000;
        const end = Number(query.timeRange.unixTimeRange.exclusiveEnd) * 1000;
        const labels = [];
        const values = [];
        for (let at = start; at < end; at += HOUR) {
          if (!options.everyHour && at !== start) continue;
          labels.push(String(at));
          values.push(figure(wanted[0]));
        }
        return { key: node.key, value: { resultTable: {
          dimensionColumns: [{ dimension: { type: 'HOUR' }, timestamps: { values: labels } }],
          metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values } }]
        } } };
      })
    })
  });
}

// The publish times a ranking fixture hands back, as the video list states them.
function videoList(times) {
  return () => ({ status: 200, text: JSON.stringify({
    videos: Object.keys(times).map((id) => ({ videoId: id, timePublishedSeconds: String(Math.floor(times[id] / 1000)) }))
  }) });
}

// Freezes the clock so a prorated figure comes out to an exact number.
async function at(moment, run) {
  const real = Date.now;
  Date.now = () => moment;
  try { return await run(); } finally { Date.now = real; }
}

test('the latest-video ranking is rebuilt from engaged views', async () => {
  // Studio ranks the newest video against recent uploads over the same stretch
  // of each one's life. Raw order here is A, B, C; engaged order is C, A, B.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } },
    { rank: 3, entity: { videoId: 'vidC' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 100 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const engaged = { vidA: 20, vidB: 5, vidC: 60 };
  const queries = [];

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 3 * HOUR, vidB: now - 40 * HOUR, vidC: now - 90 * HOUR }),
    'yta_web/join': rankingResponder(engaged, { queries })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  assert.deepStrictEqual(entities.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'reordered by engaged views');
  assert.deepStrictEqual(entities.map((e) => e.value.double), [60, 20, 5], 'showing the engaged figures');
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2, 3], 'and renumbered');

  // Each video is counted hour by hour rather than as one total over a window
  // rounded out to whole hours, which is what lets every figure move between
  // one hour and the next.
  const asked = queries.filter((q) => q.restricts.some((r) => r.dimension.type === 'VIDEO'));
  assert.strictEqual(asked.length, 3, 'one query per video in the list');
  assert.ok(asked.every((q) => q.dimensions[0].type === 'HOUR'), 'every one of them asked for hours');
});

test('videos share a place when their figures tie', async () => {
  const now = Date.now();
  const ranking = { entities: ['vidA', 'vidB', 'vidC'].map((id, i) => ({
    rank: i + 1, entity: { videoId: id }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 10 - i }
  })) };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 2 * HOUR, vidB: now - 12 * HOUR, vidC: now - 22 * HOUR }),
    'yta_web/join': rankingResponder({ vidA: 1, vidB: 0, vidC: 0 })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2, 2], 'the two tied videos share second place');
});

test('a ranking is left alone when a video cannot be dated', async () => {
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    // Only one of the two videos comes back with a publish time.
    'list_creator_videos': () => ({ status: 200, text: JSON.stringify({ videos: [{ videoId: 'vidA', timePublishedSeconds: '1780000000' }] }) }),
    'yta_web/join': joinResponder()
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.value.double), [900, 500], 'figures untouched');
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2], 'order untouched');
});

test("the hour a video's window ends inside is counted by its minutes", async () => {
  // Every video is measured over exactly the newest one's age, which almost
  // never lands on an hour boundary. Rounding that out used to freeze the nine
  // older figures until the rounding grew; the hour the window ends inside is
  // counted by the minutes of it the video has lived through instead.
  const now = Math.floor(1780000000000 / HOUR) * HOUR;
  const newest = now - 2 * HOUR - 10 * 60000;   // two hours and ten minutes old
  const older = now - 10 * HOUR + 20 * 60000;   // published at twenty past the hour

  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidNew' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidOld' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidNew' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidNew: newest, vidOld: older }),
    'yta_web/join': rankingResponder({ vidNew: 100, vidOld: 100 }, { everyHour: true })
  });

  const result = await at(now, () => request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest()));
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  const figures = {};
  entities.forEach((e) => { figures[e.entity.videoId] = e.value.double; });

  // The older video's two hours and ten minutes run from twenty past, so it
  // gets two whole hours and half of the one it ends in.
  assert.strictEqual(figures.vidOld, 250, 'two full hours plus half of the third');
  assert.strictEqual(figures.vidNew, 300, 'and the newest video its three whole hours');
});

test("the hour the newest video is living through counts whole", async () => {
  // The newest video's window ends at this moment, so the hour it is in is the
  // hour the server is still filling: what it holds is all there is so far, and
  // scaling it down would report less than has really happened.
  const hour = Math.floor(1780000000000 / HOUR) * HOUR;
  const now = hour + 15 * 60000;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidNew' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidOld' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidNew' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidNew: now - 2 * HOUR, vidOld: now - 10 * HOUR }),
    'yta_web/join': rankingResponder({ vidNew: 100, vidOld: 100 }, { everyHour: true })
  });

  const result = await at(now, () => request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest()));
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  const figures = {};
  entities.forEach((e) => { figures[e.entity.videoId] = e.value.double; });

  assert.strictEqual(figures.vidNew, 300, 'the hour still being filled counts for everything it holds');
  assert.strictEqual(figures.vidOld, 225, 'while an hour in the past is worth the minutes of it that count');
});

test('the figures move between one hour and the next', async () => {
  // The complaint this fixes: nine of the ten bars stood still for up to an
  // hour and then jumped together. Five minutes later the same card, answered
  // the same way, has to read differently.
  const start = Math.floor(1780000000000 / HOUR) * HOUR;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidNew' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidOld' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidNew' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidNew: start - 3 * HOUR, vidOld: start - 20 * HOUR }),
    'yta_web/join': rankingResponder({ vidNew: 150, vidOld: 100 }, { everyHour: true })
  });

  function figureFor(result, id) {
    const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
    return entities.filter((e) => e.entity.videoId === id)[0].value.double;
  }

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  const first = await at(start, () => request(env, url, screenRequest()));
  const second = await at(start + 5 * 60000, () => request(env, url, screenRequest()));

  // Studio prints these figures as text, so they are rounded before they are
  // sorted and numbered; five minutes of the fourth hour still has to show.
  assert.strictEqual(figureFor(first, 'vidOld'), 300, 'three whole hours to begin with');
  assert.strictEqual(figureFor(second, 'vidOld'), 308, 'and five minutes of the fourth hour five minutes later');
});

test('a video the server will not break down by hour falls back to its total', async () => {
  // An hourly query the server refuses costs that video its proration and
  // nothing else: it is asked for again as a single total, and the other nine
  // keep the figures they already have. The clock is held still on a whole
  // hour of the newest video's life, so the window the total covers needs no
  // rounding and the figure arrives as the server stated it.
  const now = Math.floor(1780000000000 / HOUR) * HOUR;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const queries = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 3 * HOUR, vidB: now - 30 * HOUR }),
    'yta_web/join': rankingResponder({ vidA: 20, vidB: 50 }, { refuse: ['vidB'], queries })
  });

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  const result = await at(now, () => request(env, url, screenRequest()));
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  assert.deepStrictEqual(entities.map((e) => e.entity.videoId), ['vidB', 'vidA'], 'the ranking is still rebuilt');
  assert.deepStrictEqual(entities.map((e) => e.value.double), [50, 20], 'the refused video counted as one total');

  const totals = queries.filter((q) => (q.dimensions[0] || {}).type === 'VIDEO');
  assert.strictEqual(totals.length, 1, 'only the refused video was asked for again');
  assert.deepStrictEqual(totals[0].restricts.filter((r) => r.dimension.type === 'VIDEO')[0].inValues, ['vidB']);
  // Three requests carry ranking queries: the batch, the straggler retry the
  // extension makes for anything a batch comes back missing, and the single
  // total. The nine videos the server did answer are never asked about twice.
  const rankingJoins = env.sent
    .filter((r) => r.url.includes('yta_web/join'))
    .map((r) => JSON.parse(r.body).nodes.map((n) => n.key))
    .filter((keys) => keys.some((key) => key.indexOf('rv_rank') === 0));
  assert.deepStrictEqual(rankingJoins, [
    ['rv_rank_hours_0', 'rv_rank_hours_1'],
    ['rv_rank_hours_1'],
    ['rv_rank_1']
  ], 'the batch, the retry, and the one total');
});

test("a refused video's whole-hour total is scaled back to the window the others were counted over", async () => {
  // The others are counted to the minute - two and a half hours of life - and
  // the total the server will answer with covers three whole hours. Handing
  // that over as it stands would credit this video with up to another
  // fifty-nine minutes nobody else was given.
  const now = Math.floor(1780000000000 / HOUR) * HOUR + 30 * 60000;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    // vidA is the newest, so the list covers two and a half hours of each.
    'list_creator_videos': videoList({ vidA: now - 2 * HOUR - 30 * 60000, vidB: now - 12 * HOUR }),
    'yta_web/join': rankingResponder({ vidA: 100, vidB: 300 }, { refuse: ['vidB'] })
  });

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  const result = await at(now, () => request(env, url, screenRequest()));
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  assert.deepStrictEqual(entities.map((e) => e.entity.videoId), ['vidB', 'vidA']);
  assert.deepStrictEqual(entities.map((e) => e.value.double), [250, 100],
    'three hundred over three hours, counted for the two and a half the rest were given');
});

test('a ranking older than a fortnight is asked for as whole-hour totals', async () => {
  // Ten videos broken down by the hour over months would be a great many
  // buckets to ask for at once, so past a fortnight the old whole-hour total
  // stands.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const queries = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 20 * DAY, vidB: now - 60 * DAY }),
    'yta_web/join': rankingResponder({ vidA: 20, vidB: 50 }, { queries })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  assert.deepStrictEqual(entities.map((e) => e.value.double), [50, 20], 'still rebuilt from engaged views');
  const asked = queries.filter((q) => q.restricts.some((r) => r.dimension.type === 'VIDEO'));
  assert.strictEqual(asked.length, 2, 'one query per video');
  assert.ok(asked.every((q) => q.dimensions[0].type === 'VIDEO'), 'and not an hourly one among them');
});

test('the video list is only fetched once', async () => {
  // A publish time never changes and the card loads constantly, so the list is
  // remembered rather than asked for again.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 3 * HOUR, vidB: now - 30 * HOUR }),
    'yta_web/join': rankingResponder({ vidA: 20, vidB: 50 })
  });

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  await request(env, url, screenRequest());
  const second = await request(env, url, screenRequest());

  const entities = JSON.parse(second.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.value.double), [50, 20], 'the second card is rebuilt from the remembered times');
  assert.strictEqual(env.sent.filter((r) => r.url.includes('list_creator_videos')).length, 1, 'and the list was asked for once');
});

test('a ranking with a video that has not gone up yet is left alone', async () => {
  // An unpublished video reports a publish time of "0". It has no life to
  // measure, so the ranking is left exactly as the server sent it rather than
  // measured from 1970.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': () => ({ status: 200, text: JSON.stringify({ videos: [
      { videoId: 'vidA', timePublishedSeconds: String(Math.floor((now - 3 * HOUR) / 1000)) },
      { videoId: 'vidB', timePublishedSeconds: '0' }
    ] }) }),
    'yta_web/join': rankingResponder({ vidA: 20, vidB: 50 })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const entities = JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(entities.map((e) => e.value.double), [900, 500], 'figures untouched');
  assert.deepStrictEqual(entities.map((e) => e.rank), [1, 2], 'order untouched');
});

test("the card's own comparison is redone from the rebuilt ranking", async () => {
  // The row beside the ranking says whether the video is doing better or worse
  // than usual, judged by the server on raw views. Once the ranking is engaged,
  // the band and the arrow have to be too: raw said "up", engaged says typical.
  const now = Date.now();
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } },
    { rank: 3, entity: { videoId: 'vidC' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 100 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: {
    video: { externalVideoId: 'vidA' },
    ranking,
    headline: { text: 'Looking good! This video is performing better than usual.' },
    metricsTable: { metricRows: [
      {
        metric: { type: 'EXTERNAL_VIEWS' },
        value: { double: 900 },
        trend: 'TREND_TYPE_UP',
        typicalRange: { typicalRange: { lowerBound: 800, upperBound: 2000 } },
        performanceAnalysis: 'Better than usual'
      },
      {
        metric: { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR' },
        value: { double: 5 },
        trend: 'TREND_TYPE_UP',
        typicalRange: { typicalRange: { lowerBound: 1, upperBound: 9 } }
      }
    ] }
  } }] };

  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: now - 3 * HOUR, vidB: now - 33 * HOUR, vidC: now - 63 * HOUR }),
    'yta_web/join': rankingResponder({ vidA: 20, vidB: 5, vidC: 60 })
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const card = JSON.parse(result.text).cards[0].entitySnapshotCardData;
  const rows = card.metricsTable.metricRows;

  // Engaged figures 5, 20, 60: the middle half runs 13 to 40, and vidA's 20
  // sits inside it.
  assert.deepStrictEqual(rows[0].typicalRange.typicalRange, { lowerBound: 13, upperBound: 40 }, 'the band is the middle half of the engaged figures');
  assert.strictEqual(rows[0].trend, 'TREND_TYPE_TYPICAL', 'the arrow now matches the engaged figure');
  assert.strictEqual(rows[0].value.double, 20, 'the figure itself is engaged');
  assert.strictEqual(card.headline, undefined, 'the old verdict sentence is dropped rather than left to lie');
  assert.strictEqual(rows[0].performanceAnalysis, undefined, 'and so is its tooltip');
  assert.strictEqual(rows[1].trend, 'TREND_TYPE_UP', 'a row for another metric keeps its own judgement');
  assert.deepStrictEqual(rows[1].typicalRange.typicalRange, { lowerBound: 1, upperBound: 9 }, 'and its own band');
});

test('a ranking whose queries fail keeps the order it last had', async () => {
  // A minute before the hour turns, so that two minutes later every window the
  // ranking asks about has moved on and nothing it needs is cached.
  const before = Math.floor(1780000000000 / HOUR) * HOUR + 59 * 60000;
  const after = before + 2 * 60000;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } },
    { rank: 3, entity: { videoId: 'vidC' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 100 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: {
    video: { externalVideoId: 'vidA' },
    ranking,
    metricsTable: { metricRows: [{
      metric: { type: 'EXTERNAL_VIEWS' },
      value: { double: 900 },
      trend: 'TREND_TYPE_UP',
      typicalRange: { typicalRange: { lowerBound: 800, upperBound: 2000 } }
    }] }
  } }] };

  let failing = false;
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: before - 3 * HOUR, vidB: before - 33 * HOUR, vidC: before - 63 * HOUR }),
    'yta_web/join': (body) => (failing ? { status: 500, text: 'nope' } : rankingResponder({ vidA: 20, vidB: 5, vidC: 60 })(body))
  });

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  const first = await at(before, () => request(env, url, screenRequest()));
  const firstOrder = JSON.parse(first.text).cards[0].entitySnapshotCardData.ranking.entities;
  assert.deepStrictEqual(firstOrder.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'rebuilt while the queries worked');

  // Both the hourly queries and the totals behind them now fail, and none of
  // the answers to them fit the windows this card wants, so the whole ranking
  // is put back together from the figures it last really had.
  failing = true;
  const later = await at(after, () => request(env, url, screenRequest()));
  const card = JSON.parse(later.text).cards[0].entitySnapshotCardData;

  assert.deepStrictEqual(card.ranking.entities.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'the order it last had');
  assert.deepStrictEqual(card.ranking.entities.map((e) => e.value.double), [60, 20, 5], 'the figures it last had');
  assert.deepStrictEqual(card.ranking.entities.map((e) => e.rank), [1, 2, 3], 'and the places that go with them');
  assert.deepStrictEqual(card.metricsTable.metricRows[0].typicalRange.typicalRange, { lowerBound: 13, upperBound: 40 }, 'with the band beside it drawn from the same figures');
});

test('a ranking is put back together whole rather than one stale figure among fresh ones', async () => {
  // A ranking's windows are rounded out to whole hours, so the same ten
  // questions are asked all through an hour. Answering the one that failed
  // from the memory kept per question would hand the card nine figures from
  // this minute and one from ten minutes ago, and would keep marking that
  // mixture as freshly remembered - so the card could go on being rebuilt out
  // of an old figure indefinitely. The ranking is remembered whole instead.
  const hour = Math.floor(1780000000000 / HOUR) * HOUR;
  const first = hour + 10 * 60000;
  const second = hour + 20 * 60000;
  const third = first + 16 * 60000;

  // Whole hours apart, so each video's window rounds to the same pair of hours
  // all through this one: the questions at twenty past really are the same
  // questions as the ones at ten past.
  const newest = first - 3 * HOUR;
  const ranking = { entities: [
    { rank: 1, entity: { videoId: 'vidA' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 900 } },
    { rank: 2, entity: { videoId: 'vidB' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 500 } },
    { rank: 3, entity: { videoId: 'vidC' }, metric: { type: 'EXTERNAL_VIEWS' }, value: { double: 100 } }
  ] };
  const payload = { cards: [{ entitySnapshotCardData: { video: { externalVideoId: 'vidA' }, ranking } }] };

  const engaged = { vidA: 20, vidB: 5, vidC: 60 };
  let denied = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'list_creator_videos': videoList({ vidA: newest, vidB: newest - 10 * HOUR, vidC: newest - 20 * HOUR }),
    'yta_web/join': (body) => rankingResponder(engaged, { deny: denied })(body)
  });

  const url = 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json';
  const entitiesOf = (result) => JSON.parse(result.text).cards[0].entitySnapshotCardData.ranking.entities;

  const one = entitiesOf(await at(first, () => request(env, url, screenRequest())));
  assert.deepStrictEqual(one.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'rebuilt while every query answered');
  assert.deepStrictEqual(one.map((e) => e.value.double), [60, 20, 5]);

  // Ten minutes on, the server will not answer for vidB either by the hour or
  // as a total - and the other two have gone on gathering views.
  denied = ['vidB'];
  engaged.vidA = 200;
  engaged.vidC = 600;
  const two = entitiesOf(await at(second, () => request(env, url, screenRequest())));

  assert.deepStrictEqual(two.map((e) => e.entity.videoId), ['vidC', 'vidA', 'vidB'], 'the order it last had');
  assert.deepStrictEqual(two.map((e) => e.value.double), [60, 20, 5],
    'every figure out of the one list it remembered, not this minute\'s answers for the two that did reply');
  assert.deepStrictEqual(two.map((e) => e.rank), [1, 2, 3], 'and the places that go with them');

  // Sixteen minutes after the figures were really gathered. Putting the
  // remembered ones back must not have made them look any newer than they are,
  // or the card would keep showing them for as long as vidB went on failing.
  const three = entitiesOf(await at(third, () => request(env, url, screenRequest())));
  assert.deepStrictEqual(three.map((e) => e.entity.videoId), ['vidA', 'vidB', 'vidC'], 'left exactly as the server sent it');
  assert.deepStrictEqual(three.map((e) => e.value.double), [900, 500, 100], 'showing raw views rather than figures a quarter of an hour old');
});

test("a dashboard column the swapped query already answered is not asked again", async () => {
  // The top-content list is answered by the dashboard's own query over the
  // server's window for it - the last 48 hours - with the metric swapped on
  // the way out. Converting it again would swap that window for the request's
  // 28-day one and overwrite the right figures.
  const env = createEnvironment({
    'get_channel_dashboard': () => ({ status: 200, text: JSON.stringify({ cards: [{ body: { basicCard: { item: { channelFactsItem: { channelFactsData: { results: [
      { key: 'TOP_VIDEOS', value: { resultTable: {
        dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB', 'vidC'] } }],
        metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [6, 4, 2] } }]
      } } }
    ] } } } } } }] }) }),
    'yta_web/join': joinResponder({ vidA: 46, vidB: 0, vidC: 0 })
  });
  const body = JSON.stringify({
    context: {},
    dashboardParams: {
      channelId: CHANNEL,
      nodes: [{ key: 'current', value: { query: { metrics: [{ type: 'EXTERNAL_VIEWS' }], timeRange: { dateIdRange: { inclusiveStart: 20260803, exclusiveEnd: 20260831 } } } } }]
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_channel_dashboard?alt=json', body);
  const table = JSON.parse(result.text).cards[0].body.basicCard.item.channelFactsItem.channelFactsData.results[0].value.resultTable;

  assert.strictEqual(table.metricColumns[0].metric.type, 'EXTERNAL_VIEWS', 'renamed back for the caller');
  assert.deepStrictEqual(table.metricColumns[0].counts.values, [6, 4, 2], 'still the figures the swapped query was answered with');

  const videoJoins = env.sent.filter((entry) => entry.url.includes('join') && entry.body.includes('"VIDEO"'));
  assert.strictEqual(videoJoins.length, 0, 'no per-video query was sent to redo it');
});

test('a table split by two dimensions is matched on the pair', async () => {
  // Age against gender: each row is identified by both names, so the answer has
  // to be lined up on the pair rather than on either half.
  const payload = { cards: [{ tableCardData: { mainTableData: {
    dimensionColumns: [
      { dimension: { type: 'VIEWER_AGE' }, enumValues: { values: ['AGE_18_24', 'AGE_18_24', 'AGE_25_34'] } },
      { dimension: { type: 'VIEWER_GENDER' }, enumValues: { values: ['GENDER_FEMALE', 'GENDER_MALE', 'GENDER_MALE'] } }
    ],
    metricColumns: [
      { metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20, 70] } },
      { metric: { type: 'EXTERNAL_VIEWS', asPercentagesOfTotal: true }, percentages: { values: [10, 20, 70] } }
    ]
  } } }] };

  let asked = null;
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const node = JSON.parse(body).nodes[0];
      asked = node.value.query.dimensions.map((d) => d.type);
      return { status: 200, text: JSON.stringify({ results: [{ key: node.key, value: { resultTable: {
        // Deliberately a different row order, and the columns the other way round.
        dimensionColumns: [
          { dimension: { type: 'VIEWER_GENDER' }, enumValues: { values: ['GENDER_MALE', 'GENDER_MALE', 'GENDER_FEMALE'] } },
          { dimension: { type: 'VIEWER_AGE' }, enumValues: { values: ['AGE_25_34', 'AGE_18_24', 'AGE_18_24'] } }
        ],
        metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: [30, 5, 15] } }]
      } } }] }) };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const columns = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns;

  assert.deepStrictEqual(asked, ['VIEWER_AGE', 'VIEWER_GENDER'], 'asked for both dimensions at once');
  assert.deepStrictEqual(columns[0].counts.values, [15, 5, 30], 'each row took the figure for its own pair');
  assert.deepStrictEqual(columns[1].percentages.values, [30, 10, 60], 'and the shares follow');
});

test('a screen that names no period takes the one its response states', async () => {
  // The Audience screen asks for itself with a channel and nothing else. Its
  // period is only stated in the answer, and without reading it there is no
  // range and every table on the screen stays raw.
  const payload = {
    layout: { desktopLayout: { selectedTimePeriod: { timePeriodType: 'ANALYTICS_TIME_PERIOD_TYPE_WEEK' } } },
    cards: [{ tableCardData: { mainTableData: {
      dimensionColumns: [{ dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }],
      metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [20, 8] } }]
    } } }]
  };
  const request_ = JSON.stringify({
    context: { client: { clientName: 62 } },
    screenConfig: { entity: { channelId: CHANNEL }, currency: 'CAD', timeZoneOffsetSecs: OFFSET },
    desktopState: { tabId: 'ANALYTICS_TAB_ID_AUDIENCE' }
  });

  const env = createEnvironment({ 'get_screen': JSON.stringify(payload), 'yta_web/join': joinResponder({ vidA: 11, vidB: 4 }) });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', request_);
  const column = JSON.parse(result.text).cards[0].tableCardData.mainTableData.metricColumns[0];

  assert.deepStrictEqual(column.counts.values, [11, 4], 'converted from the period the response named');
});

test('each tab of a by-content-type card is asked for its own kind of content', async () => {
  // One breakdown repeated per content type: the tables are identical apart
  // from the kind of content they cover, so each needs its own query.
  const table = () => ({ tableCard: { mainTableData: {
    dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['CA', 'US'] } }],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [10, 20] } }]
  } } });
  const payload = { cards: [{ tableCardByContentTypeCardData: { tables: [
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_ALL_CONTENT' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_VIDEO' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_SHORTS' }, table()),
    Object.assign({ contentType: 'CONTENT_ANALYSIS_TYPE_PODCASTS' }, table())
  ] } }] };

  // Each kind of content answers with a figure of its own, so a table filled
  // from the wrong query is visible in the result.
  const byKind = { none: [1, 2], VIDEO_ON_DEMAND: [3, 4], SHORTS: [5, 6] };
  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => {
      const results = JSON.parse(body).nodes.map((node) => {
        const restrict = node.value.query.restricts.find((r) => r.dimension.type === 'CREATOR_CONTENT_TYPE');
        const kind = restrict ? restrict.inValues[0] : 'none';
        if ((node.value.query.dimensions[0] || {}).type === 'COUNTRY') asked.push(kind);
        return { key: node.key, value: { resultTable: {
          dimensionColumns: [{ dimension: { type: 'COUNTRY' }, strings: { values: ['CA', 'US'] } }],
          metricColumns: [{ metric: { type: 'ENGAGED_VIEWS' }, counts: { values: byKind[kind] } }]
        } } };
      });
      return { status: 200, text: JSON.stringify({ results }) };
    }
  });

  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());
  const tables = JSON.parse(result.text).cards[0].tableCardByContentTypeCardData.tables;

  assert.deepStrictEqual(asked.sort(), ['SHORTS', 'VIDEO_ON_DEMAND', 'none'], 'one query per kind, and none for the podcast tab');
  assert.deepStrictEqual(tables[0].tableCard.mainTableData.metricColumns[0].counts.values, [1, 2], 'all content');
  assert.deepStrictEqual(tables[1].tableCard.mainTableData.metricColumns[0].counts.values, [3, 4], 'videos only');
  assert.deepStrictEqual(tables[2].tableCard.mainTableData.metricColumns[0].counts.values, [5, 6], 'shorts only');
  assert.deepStrictEqual(tables[3].tableCard.mainTableData.metricColumns[0].counts.values, [10, 20], 'the podcast tab is left as it was');
  assert.strictEqual(env.attributes['data-realview-converted-analytics'], 'no',
    'and the screen is not relabelled while a raw table remains');
});

test('a sparkline over time is still left alone', async () => {
  const payload = { cards: [{ latestActivityCardData: { datas: [{ sparkChartData: {
    dimensionColumns: [
      { dimension: { type: 'HOUR' }, timestamps: { values: [Date.now() - 3600000, Date.now()] } },
      { dimension: { type: 'VIDEO' }, strings: { values: ['vidA', 'vidB'] } }
    ],
    metricColumns: [{ metric: { type: 'EXTERNAL_VIEWS' }, counts: { values: [3, 4] } }]
  } }] } }] };

  const asked = [];
  const env = createEnvironment({
    'get_screen': JSON.stringify(payload),
    'yta_web/join': (body) => { JSON.parse(body).nodes.forEach((n) => asked.push(n.value.query.dimensions.map((d) => d.type).join('+'))); return joinResponder()(body); }
  });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/yta_web/get_screen?alt=json', screenRequest());

  assert.ok(!asked.includes('HOUR+VIDEO'), 'no query for the sparkline pairing');
  const column = JSON.parse(result.text).cards[0].latestActivityCardData.datas[0].sparkChartData.metricColumns[0];
  assert.deepStrictEqual(column.counts.values, [3, 4], 'left as it was');
});

test('an unrelated request is not touched', async () => {
  const env = createEnvironment({ 'creator/get_creator_channels': '{"channels":[]}' });
  const result = await request(env, 'https://studio.youtube.com/youtubei/v1/creator/get_creator_channels?alt=json', '{}');
  assert.strictEqual(result.text, '{"channels":[]}');
  assert.strictEqual(env.sent.length, 1, 'passed through on the original object');
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
