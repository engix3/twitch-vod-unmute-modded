'use strict';

const assert = require('node:assert/strict');
const helpers = require('./helpers.js');

const playlistURL = 'https://video.example.cloudfront.net/vod/720p60/index-muted-A1.m3u8?token=playlist';
const parsed = helpers.parseHlsPlaylist(`#EXTM3U
#EXT-X-MAP:URI="init/init-muted.mp4?map=1"
#EXTINF:2.5,
segments/one-muted.ts?segment=1
#EXTINF:7.25,
../shared/two-muted.aac?segment=2
#EXTINF:1,
https://other.cloudfront.net/absolute-muted.m4s?segment=3
`, playlistURL);

assert.equal(parsed.totalDuration, 10.75);
assert.deepEqual(parsed.entries.map((entry) => entry.url), [
    'https://video.example.cloudfront.net/vod/720p60/init/init-muted.mp4?map=1',
    'https://video.example.cloudfront.net/vod/720p60/segments/one-muted.ts?segment=1',
    'https://video.example.cloudfront.net/vod/shared/two-muted.aac?segment=2',
    'https://other.cloudfront.net/absolute-muted.m4s?segment=3'
]);
assert.equal(helpers.unmuteURL(parsed.entries[1].url),
    'https://video.example.cloudfront.net/vod/720p60/segments/one.ts?segment=1');
assert.equal(helpers.isMutedURL(parsed.entries[1].url), true);
assert.equal(helpers.isMutedURL('https://video.example.cloudfront.net/vod/720p60/one.ts?note=-muted'), false);
assert.equal(helpers.replaceQualityComponent(parsed.entries[1].url, '720p60', '480p30'),
    'https://video.example.cloudfront.net/vod/480p30/segments/one-muted.ts?segment=1');
assert.equal(helpers.replaceQualityComponent(
    'https://video.example.cloudfront.net/vod/720p60/one-muted.ts?quality=720p60&token=x', '720p60', '480p30'),
    'https://video.example.cloudfront.net/vod/480p30/one-muted.ts?quality=480p30&token=x');
assert.match(parsed.entries[1].url, new RegExp(helpers.exactURLRegex(parsed.entries[1].url)));
assert.doesNotMatch(parsed.entries[1].url + '&extra=1', new RegExp(helpers.exactURLRegex(parsed.entries[1].url)));

const ranges = helpers.calculateSeekbarSegments([
    { startTime: 0, duration: 2.5, quality: '720p60' },
    { startTime: 2.5, duration: 7.25, quality: '720p60' },
    { startTime: 9.75, duration: 1, quality: '480p30' }
], 10.75);
assert.deepEqual(ranges, [
    { left: 0, width: (9.75 / 10.75) * 100, quality: '720p60' },
    { left: (9.75 / 10.75) * 100, width: (1 / 10.75) * 100, quality: '480p30' }
]);

const targets = new Map();
targets.set(helpers.targetKey(1, 'https://cdn.test/file.ts'), new Set([10]));
targets.set(helpers.targetKey(2, 'https://cdn.test/file.ts'), new Set([20]));
assert.equal(helpers.resolveTargetRule(targets, 1, 'https://cdn.test/file.ts'), 10);
assert.equal(helpers.resolveTargetRule(targets, -1, 'https://cdn.test/file.ts'), null);
targets.delete(helpers.targetKey(2, 'https://cdn.test/file.ts'));
assert.equal(helpers.resolveTargetRule(targets, -1, 'https://cdn.test/file.ts'), 10);

assert.equal(helpers.classifyValidation(404, '').definitive, true);
assert.equal(helpers.classifyValidation(410, '').definitive, true);
assert.equal(helpers.classifyValidation(429, '').transient, true);
assert.equal(helpers.classifyValidation(503, '').transient, true);
assert.equal(helpers.classifyValidation(200, 'audio/aac').valid, true);
assert.equal(helpers.classifyValidation(200, 'application/mp4').valid, true);
assert.equal(helpers.isTwitchURL('https://twitch.tv/videos/1'), true);
assert.equal(helpers.isTwitchURL('https://www.twitch.tv/videos/1'), true);
assert.equal(helpers.isTwitchURL('https://eviltwitch.tv/videos/1'), false);
assert.equal(helpers.isTwitchVodURL('https://www.twitch.tv/videos/123'), true);
assert.equal(helpers.isTwitchVodURL('https://www.twitch.tv/directory'), false);
assert.equal(helpers.isTwitchVodURL('https://twitch.tv/videos/123'), true);
assert.equal(helpers.isAllowedMediaURL('https://usher.ttvnw.net/vod/index-muted-A.m3u8'), true);
const ruleSpec = helpers.createDnrRuleSpec(
    [
        { url: 'https://cdn.cloudfront.net/vod/720p60/one-muted.ts' },
        { url: 'https://cdn.cloudfront.net/vod/720p60/two-muted.ts' }
    ],
    [
        { url: 'https://cdn.cloudfront.net/vod/720p60/one.ts' },
        { url: 'https://cdn.cloudfront.net/vod/720p60/two.ts' }
    ], '720p60', null
);
assert.ok(ruleSpec);
assert.equal(new RegExp(ruleSpec.regexFilter).test('https://cdn.cloudfront.net/vod/720p60/three-muted.ts'), true);
const spec = helpers.createDnrRuleSpec(
    [{ url: 'https://cdn.cloudfront.net/vod/720p60/one-muted.ts?x=1' }, { url: 'https://cdn.cloudfront.net/vod/720p60/two-muted.ts?x=2' }],
    [{ url: 'https://cdn.cloudfront.net/vod/720p60/one.ts?x=1', quality: '720p60' }, { url: 'https://cdn.cloudfront.net/vod/720p60/two.ts?x=2', quality: '720p60' }], '720p60', null);
assert.ok(spec && spec.regexFilter.includes('720p60'));
assert.ok(new RegExp(spec.regexFilter).test('https://cdn.cloudfront.net/vod/720p60/one-muted.ts?x=1'));
assert.equal(helpers.createDnrRuleSpec([{ url: 'https://cdn.cloudfront.net/vod/720p60/one-muted.ts' }], [{ url: 'https://cdn.cloudfront.net/vod/480p30/other.ts' }], '720p60', '480p30'), null);
assert.equal(helpers.createDnrRuleSpec([{ url: 'https://cdn.cloudfront.net/vod/720p60/one-muted.ts?q=720p60' }], [{ url: 'https://cdn.cloudfront.net/vod/480p30/one.ts?q=480p30' }], '720p60', '480p30'), null);

const malformed = helpers.parseHlsPlaylist(`#EXTM3U
#EXTINF:1,
https://%
#EXTINF:2,
valid-muted.ts
`, playlistURL);
assert.equal(malformed.totalDuration, 3);
assert.equal(malformed.entries.length, 1);
assert.equal(malformed.entries[0].startTime, 1);

console.log('helpers.test.js: all tests passed');
