const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'https://d1.cloudfront.net/abcdef';
const QUALITY = '720p60';
const PLAYLIST = `${BASE}/${QUALITY}/index-muted-ABC123.m3u8`;

function makePlaylist(segments, map) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:10'];
    if (map) lines.push(`#EXT-X-MAP:URI="${map}"`);
    for (const name of segments) lines.push('#EXTINF:10.000,', name);
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

function createEnvironment({ playlists = {}, statuses = {}, settings = {}, existingRules = [] } = {}) {
    const env = {
        fetches: [],
        updates: [],
        rules: existingRules.map((rule) => ({ ...rule })),
        settings: {
            enabled: true, seekbar: true, quality: true,
            unmutedColour: '#00FF00', qualityColour: '#FFFF00', opacity: 0.5,
            ...settings
        }
    };

    const statusFor = (url) => {
        const value = statuses[url];
        if (value === undefined) return 404;
        if (Array.isArray(value)) return value.length > 1 ? value.shift() : value[0];
        return value;
    };

    globalThis.fetch = async (url, options = {}) => {
        env.fetches.push({ url, options });
        if (url in playlists) return { ok: true, status: 200, text: async () => playlists[url] };
        const status = statusFor(url);
        return { ok: status >= 200 && status < 300, status, text: async () => '' };
    };

    globalThis.window = {};
    globalThis.chrome = {
        runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
        tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, query: async () => [{ id: 1 }] },
        webRequest: { onBeforeRequest: { addListener() {} } },
        storage: {
            onChanged: { addListener() {} },
            sync: {
                get: async (keys) => {
                    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
                    return Object.fromEntries(list
                        .filter((key) => env.settings[key] !== undefined)
                        .map((key) => [key, env.settings[key]]));
                },
                set: async (values) => { Object.assign(env.settings, values); }
            }
        },
        // The injected functions are executed directly, so the page-side probing
        // and painting code is covered by the tests too.
        scripting: { executeScript: async ({ args = [], func }) => [{ result: await func(...args) }] },
        declarativeNetRequest: {
            MAX_NUMBER_OF_SESSION_RULES: 5000,
            getSessionRules: async () => env.rules.map((rule) => ({ ...rule })),
            updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
                env.updates.push({ removeRuleIds, addRules });
                env.rules = env.rules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
            }
        }
    };

    globalThis.VODHelpers = require('./helpers.js');
    globalThis.VODNet = require('./net.js');
    globalThis.VODRules = require('./rules.js');
    globalThis.VODSeekbar = require('./seekbar.js');
    const { VODUnmute } = require('./background.js');
    env.unmute = new VODUnmute();
    return env;
}

const run = (env, epoch = 0) => env.unmute.process({ tabId: 1, url: PLAYLIST, epoch });
const probes = (env, url) => env.fetches.filter((item) => item.url === url).length;

test('muted segments become exact redirect rules', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts', '2-muted.ts', '3-muted.ts']) },
        statuses: {
            [`${BASE}/${QUALITY}/1.ts`]: 200,
            [`${BASE}/${QUALITY}/2.ts`]: 206,
            [`${BASE}/${QUALITY}/3.ts`]: 200
        }
    });

    await run(env);

    assert.equal(env.updates.length, 1);
    assert.equal(env.updates[0].addRules.length, 3);
    assert.equal(env.updates[0].addRules[0].condition.urlFilter, `|${BASE}/${QUALITY}/1-muted.ts`);
    assert.equal(env.updates[0].addRules[0].action.redirect.url, `${BASE}/${QUALITY}/1.ts`);
    assert.deepEqual(env.updates[0].addRules[0].condition.tabIds, [1]);

    // Segments are probed with a two-byte range request, never downloaded.
    const segmentFetches = env.fetches.filter((item) => item.url !== PLAYLIST);
    assert.equal(segmentFetches.length, 3);
    assert.equal(segmentFetches.every((item) => item.options.headers.Range === 'bytes=0-1'), true);

    const stats = env.unmute.statsFor(1);
    assert.equal(stats.state, 'ready');
    assert.equal(stats.unmuted, 3);
    assert.equal(stats.lowerQuality, 0);
    assert.equal(stats.muted, 0);
    assert.equal(stats.quality, QUALITY);

    await env.unmute.clearAll();
    assert.equal(env.rules.length, 0);
});

test('audio is taken from a lower rendition when the original is gone', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: {
            [`${BASE}/${QUALITY}/1.ts`]: 404,
            [`${BASE}/480p30/1.ts`]: 200
        }
    });

    await run(env);

    assert.equal(env.updates[0].addRules[0].action.redirect.url, `${BASE}/480p30/1.ts`);
    const stats = env.unmute.statsFor(1);
    assert.equal(stats.lowerQuality, 1);
    assert.equal(stats.unmuted, 0);
});

test('an fMP4 init segment is redirected together with the media', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.m4s'], 'init-muted.mp4') },
        statuses: {
            [`${BASE}/${QUALITY}/1.m4s`]: 200,
            [`${BASE}/${QUALITY}/init.mp4`]: 200
        }
    });

    await run(env);

    const redirects = env.updates[0].addRules.map((rule) => rule.action.redirect.url);
    assert.deepEqual(redirects, [`${BASE}/${QUALITY}/init.mp4`, `${BASE}/${QUALITY}/1.m4s`]);
});

test('nothing is redirected when the muted init segment has no original', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.m4s'], 'init-muted.mp4') },
        statuses: { [`${BASE}/${QUALITY}/1.m4s`]: 200 }
    });

    await run(env);

    assert.equal(env.updates.length, 0);
    assert.equal(env.unmute.statsFor(1).state, 'unavailable');
});

test('probe results are cached between playlist reloads', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 }
    });

    await run(env);
    const before = env.fetches.length;
    env.unmute.tabs.get(1).renditions.get(QUALITY).signature = null;
    await run(env);

    // Only the playlist is downloaded again; the segment is not re-probed.
    assert.equal(env.fetches.length, before + 1);
});

test('throttled probes are retried, missing files are not', async () => {
    const env = createEnvironment({
        settings: { quality: false },
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts', '2-muted.ts']) },
        statuses: {
            [`${BASE}/${QUALITY}/1.ts`]: [503, 200],
            [`${BASE}/${QUALITY}/2.ts`]: 404
        }
    });

    await run(env);

    assert.equal(probes(env, `${BASE}/${QUALITY}/1.ts`), 2);
    assert.equal(probes(env, `${BASE}/${QUALITY}/2.ts`), 1);
    const stats = env.unmute.statsFor(1);
    assert.equal(stats.unmuted, 1);
    assert.equal(stats.muted, 1);
});

test('the Chrome session rule budget is respected and reported', async () => {
    const segments = [];
    const statuses = {};
    for (let index = 1; index <= 20; index++) {
        segments.push(`${index}-muted.ts`);
        statuses[`${BASE}/${QUALITY}/${index}.ts`] = 200;
    }
    const existingRules = Array.from({ length: 4890 }, (unused, index) => ({
        id: 100000 + index,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '|https://example.com/', tabIds: [2] }
    }));

    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(segments) },
        statuses,
        existingRules
    });

    await run(env);

    assert.equal(env.updates[0].addRules.length, 10);
    const stats = env.unmute.statsFor(1);
    assert.equal(stats.truncated, 10);
    assert.match(stats.message, /Лимит правил Chrome/);
});
