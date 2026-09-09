const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'https://d1.cloudfront.net/abcdef';
const QUALITY = '720p60';
const PLAYLIST = `${BASE}/${QUALITY}/index-muted-ABC123.m3u8`;
const PAGE = 'https://www.twitch.tv/videos/123456789';

function makePlaylist(segments, map) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:10'];
    if (map) lines.push(`#EXT-X-MAP:URI="${map}"`);
    for (const name of segments) lines.push('#EXTINF:10.000,', name);
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

function createEnvironment({ playlists = {}, statuses = {}, settings = {}, existingRules = [], resources = [] } = {}) {
    const env = {
        fetches: [],
        updates: [],
        listeners: {},
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

    // The page timeline is what playlist recovery reads.
    const timeline = { getEntriesByType: () => resources.map((name) => ({ name })) };
    try {
        Object.defineProperty(globalThis, 'performance', { value: timeline, configurable: true, writable: true });
    } catch {
        globalThis.performance = timeline;
    }

    globalThis.window = {};
    globalThis.chrome = {
        runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { env.listeners.message = fn; } } },
        tabs: {
            onRemoved: { addListener() {} },
            onUpdated: { addListener(fn) { env.listeners.tabUpdated = fn; } },
            query: async () => [{ id: 1 }]
        },
        webRequest: { onBeforeRequest: { addListener(fn) { env.listeners.request = fn; } } },
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
const forget = (env) => {
    const rendition = env.unmute.tabs.get(1).renditions.get(QUALITY);
    rendition.signature = null;
    rendition.checkedAt = 0;
};
const settle = async (env) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await env.unmute.mutations;
};
const waitForState = async (env, state) => {
    for (let attempt = 0; attempt < 200 && env.unmute.statsFor(1).state !== state; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return env.unmute.statsFor(1);
};

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

    // Segments are probed with a plain GET that is aborted before the body arrives.
    const segmentFetches = env.fetches.filter((item) => item.url !== PLAYLIST);
    assert.equal(segmentFetches.length, 3);
    assert.equal(segmentFetches.every((item) => !item.options.headers), true);

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
    forget(env);
    await run(env);

    // Only the playlist is downloaded again; the segment is not re-probed.
    assert.equal(env.fetches.length, before + 1);
});

test('an unchanged playlist is not processed again', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 403 }
    });

    await run(env);
    const before = env.fetches.length;
    // The player keeps re-requesting the same playlist: the stored verdict has
    // to stop the check instead of restarting it in a loop.
    await run(env);
    await run(env);
    assert.equal(env.fetches.length, before);
    assert.equal(env.updates.length, 0);

    // After the cooldown the playlist is fetched again, but the verdict matches
    // so no segment is probed a second time.
    forget(env);
    await run(env);
    assert.equal(env.fetches.length, before + 1);
});

test('a forbidden answer is final and is reported as such', async () => {
    const env = createEnvironment({
        settings: { quality: false },
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: {
            [`${BASE}/${QUALITY}/1.ts`]: 403,
            [`${BASE}/${QUALITY}/1-muted.ts`]: 206
        }
    });

    await run(env);

    // 403 means "the CDN does not serve this object", so it must not be retried.
    assert.equal(probes(env, `${BASE}/${QUALITY}/1.ts`), 1);
    const stats = env.unmute.statsFor(1);
    assert.equal(stats.state, 'unavailable');
    assert.match(stats.message, /403/);
});

test('quality switching does not restart a finished check', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 }
    });

    env.unmute.onSegmentRequest({ tabId: 1, url: `${BASE}/${QUALITY}/1-muted.ts` });
    await run(env);
    const before = env.fetches.length;

    // Adaptive streaming flips between renditions; a rendition that already has
    // a verdict must not be queued again on every flip.
    env.unmute.onSegmentRequest({ tabId: 1, url: `${BASE}/360p30/1.ts` });
    env.unmute.onSegmentRequest({ tabId: 1, url: `${BASE}/${QUALITY}/2.ts` });
    assert.equal(env.unmute.queue.length, 0);

    // Both renditions count as playing, so the watched one is still processed.
    assert.equal(env.unmute.isActiveQuality(1, QUALITY), true);
    assert.equal(env.unmute.isActiveQuality(1, '360p30'), true);
    assert.equal(env.unmute.isActiveQuality(1, '160p30'), false);
    assert.equal(env.fetches.length, before);
});

test('a URL change inside the same recording keeps the installed rules', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 }
    });

    await run(env);
    assert.equal(env.unmute.statsFor(1).state, 'ready');

    // Twitch rewrites the URL while playing (seek timestamps, filters): that is
    // the same recording and must not drop the state, otherwise the popup is
    // stuck on "waiting for a playlist" with no request left to catch.
    env.listeners.tabUpdated(1, { url: PAGE });
    env.listeners.tabUpdated(1, { url: `${PAGE}?t=1h2m3s` });
    await settle(env);
    assert.equal(env.unmute.statsFor(1).state, 'ready');
    assert.equal(env.rules.length, 1);

    // A different recording is a real reset.
    env.listeners.tabUpdated(1, { url: 'https://www.twitch.tv/videos/987654321' });
    await settle(env);
    assert.equal(env.unmute.statsFor(1).state, 'waiting');
    assert.equal(env.rules.length, 0);
});

test('a missed playlist is recovered from the page resource timeline', async () => {
    const env = createEnvironment({
        resources: ['https://www.twitch.tv/app.js', PLAYLIST],
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 }
    });

    // The playlist request was never seen by the extension.
    assert.equal(env.unmute.statsFor(1).state, 'waiting');

    await env.unmute.discover(1);
    const stats = await waitForState(env, 'ready');

    assert.equal(stats.state, 'ready');
    assert.equal(stats.unmuted, 1);
    assert.equal(env.updates[0].addRules[0].condition.urlFilter, `|${BASE}/${QUALITY}/1-muted.ts`);
});

test('rules left behind by a previous service worker are replaced', async () => {
    const env = createEnvironment({
        settings: { quality: false },
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 },
        existingRules: [{
            id: 777,
            priority: 1,
            action: { type: 'redirect', redirect: { url: `${BASE}/${QUALITY}/1.ts` } },
            condition: { urlFilter: `|${BASE}/${QUALITY}/1-muted.ts`, tabIds: [1], resourceTypes: ['media'] }
        }]
    });

    await run(env);

    assert.deepEqual(env.updates[0].removeRuleIds, [777]);
    assert.equal(env.rules.length, 1);
    assert.equal(env.rules.filter((rule) => rule.condition.urlFilter === `|${BASE}/${QUALITY}/1-muted.ts`).length, 1);
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

test('the extension does not mistake its own probes for the player', async () => {
    const env = createEnvironment({
        playlists: { [PLAYLIST]: makePlaylist(['1-muted.ts']) },
        statuses: { [`${BASE}/${QUALITY}/1.ts`]: 200 }
    });

    const probed = `${BASE}/${QUALITY}/9.mp4`;
    env.unmute.probing.add(probed);
    env.listeners.request({ tabId: 1, url: probed });

    // A URL the extension is checking itself is not player traffic.
    assert.deepEqual(env.unmute.activeQualitiesFor(1), []);

    env.unmute.probing.delete(probed);
    env.listeners.request({ tabId: 1, url: probed });
    assert.deepEqual(env.unmute.activeQualitiesFor(1), [QUALITY]);
});
