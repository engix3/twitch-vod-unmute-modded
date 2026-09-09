const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers.js');

const BASE = 'https://d1.cloudfront.net/abcdef';
const PLAYLIST = `${BASE}/720p60/index-muted-ABC123.m3u8`;

test('only Twitch CDN hosts are accepted', () => {
    assert.equal(helpers.isAllowedMediaURL(`${BASE}/720p60/1.ts`), true);
    assert.equal(helpers.isAllowedMediaURL('https://video-edge.ttvnw.net/1.ts'), true);
    assert.equal(helpers.isAllowedMediaURL('https://evil.example.com/1.ts'), false);
    assert.equal(helpers.isAllowedMediaURL('not a url'), false);
    assert.equal(helpers.isTwitchURL('https://www.twitch.tv/videos/1'), true);
    assert.equal(helpers.isTwitchVodURL('https://www.twitch.tv/videos/12345'), true);
    assert.equal(helpers.isTwitchVodURL('https://www.twitch.tv/directory'), false);
});

test('playlist URIs are resolved against the playlist URL', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-VERSION:4',
        '#EXTINF:10.000,',
        '1-muted.ts',
        '#EXTINF:5.500,',
        '../480p30/2-muted.ts',
        '#EXTINF:4.000,',
        `${BASE}/720p60/3.ts`,
        '#EXT-X-ENDLIST'
    ].join('\n');

    const { entries, totalDuration } = helpers.parseHlsPlaylist(text, PLAYLIST);
    assert.deepEqual(entries.map((entry) => entry.url), [
        `${BASE}/720p60/1-muted.ts`,
        `${BASE}/480p30/2-muted.ts`,
        `${BASE}/720p60/3.ts`
    ]);
    assert.deepEqual(entries.map((entry) => entry.startTime), [0, 10, 15.5]);
    assert.equal(totalDuration, 19.5);
    assert.equal(entries.every((entry) => entry.isMap === false), true);
});

test('the fMP4 init segment is parsed from #EXT-X-MAP', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init-muted.mp4",BYTERANGE="718@0"',
        '#EXTINF:10.000,',
        '1-muted.m4s',
        '#EXT-X-ENDLIST'
    ].join('\n');

    const maps = helpers.parseHlsPlaylist(text, PLAYLIST).entries.filter((entry) => entry.isMap);
    assert.equal(maps.length, 1);
    assert.equal(maps[0].url, `${BASE}/720p60/init-muted.mp4`);
});

test('playlists that are not M3U8 are rejected', () => {
    assert.throws(() => helpers.parseHlsPlaylist('<html></html>', PLAYLIST), /Invalid M3U8/);
});

test('the -muted marker is anchored to the end of the file name', () => {
    assert.equal(helpers.isMutedURL(`${BASE}/720p60/1-muted.ts`), true);
    assert.equal(helpers.isMutedURL(`${BASE}/720p60/1-mutedmix.ts`), false);
    assert.equal(helpers.isMutedURL(`${BASE}/720p60/1.ts`), false);
    assert.equal(helpers.unmuteURL(`${BASE}/720p60/1-muted.ts`), `${BASE}/720p60/1.ts`);
    assert.equal(helpers.unmuteURL(`${BASE}/720p60/1-mutedmix.ts`), `${BASE}/720p60/1-mutedmix.ts`);
});

test('the quality directory is swapped without touching the rest of the path', () => {
    assert.equal(
        helpers.replaceQualityComponent(`${BASE}/720p60/1.ts`, '720p60', '480p30'),
        `${BASE}/480p30/1.ts`
    );
    assert.equal(helpers.replaceQualityComponent(`${BASE}/720p60/1.ts`, 'chunked', '480p30'), null);
});

test('transient statuses are separated from definitive ones', () => {
    assert.deepEqual(helpers.classifyValidation(200, 'video/mp2t').valid, true);
    assert.equal(helpers.classifyValidation(206).valid, true);
    assert.equal(helpers.classifyValidation(404).definitive, true);
    assert.equal(helpers.classifyValidation(410).definitive, true);
    assert.equal(helpers.classifyValidation(429).transient, true);
    assert.equal(helpers.classifyValidation(503).transient, true);
    assert.equal(helpers.classifyValidation(0).transient, true);
    assert.equal(helpers.classifyValidation(200, 'text/html').valid, false);
});

test('seekbar ranges are duration based and merge neighbours', () => {
    const segments = helpers.calculateSeekbarSegments([
        { startTime: 0, duration: 10, quality: 'unmuted' },
        { startTime: 10, duration: 10, quality: 'unmuted' },
        { startTime: 50, duration: 25, quality: 'lower' }
    ], 100);

    assert.deepEqual(segments, [
        { left: 0, width: 20, quality: 'unmuted' },
        { left: 50, width: 25, quality: 'lower' }
    ]);
    assert.deepEqual(helpers.calculateSeekbarSegments([{ startTime: 0, duration: 10 }], 0), []);
});
