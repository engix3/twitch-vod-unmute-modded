'use strict';

const assert = require('node:assert/strict');
global.VODHelpers = require('./helpers.js');

const event = () => ({ addListener() {} });
const vodBase = 'https://dgeft87wbj63p.cloudfront.net/abcdef_streamer_123_456';
const playlistURL = `${vodBase}/720p60/index-muted-JW6XYZ.m3u8`;
const playlist = [
    '#EXTM3U',
    '#EXTINF:10,',
    '0-muted.mp4',
    '#EXTINF:10,',
    '1-muted.mp4',
    '#EXTINF:10,',
    '2-muted.mp4',
    '#EXTINF:10,',
    '3.mp4',
    ''
].join('\n');

// Only 0 and 1 still have unmuted originals; 2 is gone at every quality.
const availableInPage = new Set([
    `${vodBase}/720p60/0.mp4`,
    `${vodBase}/720p60/1.mp4`
]);

let sessionRules = [];
const injections = [];

global.chrome = {
    runtime: { onInstalled: event(), onMessage: event() },
    storage: {
        sync: {
            async get(keys) {
                const all = { enabled: true, quality: true, seekbar: true, unmutedColour: '#00FF00', qualityColour: '#FFFF00', opacity: 0.5 };
                if (typeof keys === 'string') return { [keys]: all[keys] };
                return Object.fromEntries((keys || []).map((key) => [key, all[key]]));
            },
            async set() {}
        },
        onChanged: event()
    },
    tabs: {
        onRemoved: event(),
        onUpdated: event(),
        async query() { return [{ id: 5 }]; }
    },
    webRequest: { onCompleted: event(), onBeforeRequest: event() },
    declarativeNetRequest: {
        async getSessionRules() { return JSON.parse(JSON.stringify(sessionRules)); },
        async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
            sessionRules = sessionRules.filter((rule) => !removeRuleIds.includes(rule.id));
            sessionRules.push(...JSON.parse(JSON.stringify(addRules)));
        }
    },
    scripting: {
        async executeScript({ args, func }) {
            injections.push(args);
            // Emulate the page context: fetch resolves for stored objects only.
            const result = await func(...args, ...[]);
            return [{ result }];
        }
    }
};

// The injected functions call fetch inside the page; emulate CDN behaviour.
global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === playlistURL) {
        return { ok: true, status: 200, async text() { return playlist; } };
    }
    const ok = availableInPage.has(target);
    return { ok, status: ok ? (options.headers?.Range ? 206 : 200) : 403, async text() { return ''; } };
};

const { VODUnmute } = require('./background.js');

(async () => {
    const manager = new VODUnmute();
    await manager.process({ tabId: 5, url: playlistURL, epoch: manager.epoch(5) });

    assert.equal(sessionRules.length, 2, 'one exact redirect rule per restorable segment');
    const filters = sessionRules.map((rule) => rule.condition.urlFilter).sort();
    assert.deepEqual(filters, [
        `${vodBase}/720p60/0-muted.mp4`,
        `${vodBase}/720p60/1-muted.mp4`
    ]);
    const targets = sessionRules.map((rule) => rule.action.redirect.url).sort();
    assert.deepEqual(targets, [`${vodBase}/720p60/0.mp4`, `${vodBase}/720p60/1.mp4`]);
    assert.deepEqual(sessionRules[0].condition.tabIds, [5]);

    const stats = manager.statsFor(5);
    assert.equal(stats.state, 'ready');
    assert.equal(stats.candidates, 2);
    assert.equal(stats.unmuted, 2);
    assert.equal(stats.muted, 1, 'segment without any unmuted original stays muted');

    const before = sessionRules.length;
    await manager.process({ tabId: 5, url: playlistURL, epoch: manager.epoch(5) });
    assert.equal(sessionRules.length, before, 'unchanged playlist must not duplicate rules');

    await manager.cleanupTab(5);
    assert.equal(sessionRules.length, 0);
    assert.equal(manager.tabs.has(5), false);

    assert.ok(injections.length > 0, 'validation must run through page injection');

    // Quality tracking: once the player reveals its rendition, other renditions
    // must be skipped instead of consuming probes.
    manager.onSegmentRequest({ tabId: 5, url: `${vodBase}/720p60/7.mp4` });
    assert.equal(manager.activeQuality.get(5), '720p60');

    const rulesBeforeOtherQuality = sessionRules.length;
    await manager.process({ tabId: 5, url: `${vodBase}/160p30/index-muted-JW6XYZ.m3u8`, epoch: manager.epoch(5) });
    assert.equal(sessionRules.length, rulesBeforeOtherQuality, 'inactive rendition must not install rules');
    assert.match(manager.tabs.get(5).renditions.get('160p30').stats.message, /not the rendition in use/);
    assert.equal(manager.tabs.get(5).renditions.get('160p30').playlistURL,
        `${vodBase}/160p30/index-muted-JW6XYZ.m3u8`, 'skipped playlist URL is remembered for a later switch');

    // Switching to that rendition must start processing it without a new Twitch request.
    manager.onSegmentRequest({ tabId: 5, url: `${vodBase}/160p30/7.mp4` });
    assert.equal(manager.activeQuality.get(5), '160p30');
    assert.equal(manager.working, true, 'quality switch immediately processes the remembered playlist');
    while (manager.working) await new Promise((resolve) => setTimeout(resolve, 5));

    console.log('background.test.js: all tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
