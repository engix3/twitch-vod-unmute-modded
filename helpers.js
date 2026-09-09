(function (root, factory) {
    const helpers = factory();
    if (typeof module === 'object' && module.exports) module.exports = helpers;
    root.VODHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // `-muted` is a marker only when it closes the file name, right before the
    // extension or at the very end: `1-muted.ts` is muted, `1-mutedmix.ts` is a
    // different file that must never be rewritten.
    const MUTED_MARKER = /-muted(?=\.[^.]*$|$)/;

    function isAllowedMediaURL(value) {
        try {
            const hostname = new URL(value).hostname.toLowerCase();
            return hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv') ||
                hostname === 'ttvnw.net' || hostname.endsWith('.ttvnw.net') ||
                hostname === 'cloudfront.net' || hostname.endsWith('.cloudfront.net');
        } catch {
            return false;
        }
    }

    function isTwitchURL(value) {
        try {
            const hostname = new URL(value).hostname.toLowerCase();
            return hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv');
        } catch {
            return false;
        }
    }

    function isTwitchVodURL(value) {
        try {
            const parsed = new URL(value);
            return isTwitchURL(value) && /^\/videos\/\d+(?:\/|$)/.test(parsed.pathname);
        } catch {
            return false;
        }
    }

    function parseAttributeURI(line) {
        const match = line.match(/(?:^|,)URI=(?:"([^"]+)"|([^,]+))/i);
        return match ? (match[1] || match[2] || '').trim() : null;
    }

    // Playlist lines may be relative (`1.ts`, `../720p60/1.ts`) or absolute, so
    // every URI has to be resolved against the playlist URL instead of being
    // glued to a base string.
    function resolveMediaURL(uri, playlistURL) {
        try {
            const url = new URL(uri, playlistURL).href;
            return isAllowedMediaURL(url) ? url : null;
        } catch {
            return null;
        }
    }

    function parseHlsPlaylist(text, playlistURL) {
        if (typeof text !== 'string' || !/^#EXTM3U(?:\r?\n|$)/.test(text.trimStart())) {
            throw new Error('Invalid M3U8 playlist');
        }

        const entries = [];
        const lines = text.split(/\r?\n/);
        let startTime = 0;
        let pendingDuration = null;
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.startsWith('#EXTINF:')) {
                const duration = Number.parseFloat(line.slice(8).split(',')[0]);
                pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
                continue;
            }
            if (line.startsWith('#EXT-X-MAP:')) {
                const uri = parseAttributeURI(line.slice(11));
                if (uri) {
                    const url = resolveMediaURL(uri, playlistURL);
                    if (url) {
                        entries.push({ uri, url, isMap: true, startTime, duration: 0 });
                    }
                }
                continue;
            }
            if (line.startsWith('#')) continue;
            if (pendingDuration === null) continue;
            const url = resolveMediaURL(line, playlistURL);
            if (url) {
                entries.push({ uri: line, url, isMap: false, startTime, duration: pendingDuration });
            }
            startTime += pendingDuration;
            pendingDuration = null;
        }
        return { entries, totalDuration: startTime };
    }

    function unmuteURL(sourceURL) {
        const parsed = new URL(sourceURL);
        const parts = parsed.pathname.split('/');
        const filename = parts[parts.length - 1];
        if (!MUTED_MARKER.test(filename)) return parsed.href;
        parts[parts.length - 1] = filename.replace(MUTED_MARKER, '');
        parsed.pathname = parts.join('/');
        return parsed.href;
    }

    function isMutedURL(sourceURL) {
        try {
            const filename = new URL(sourceURL).pathname.split('/').pop() || '';
            return MUTED_MARKER.test(filename);
        } catch {
            return false;
        }
    }

    function replaceQualityComponent(sourceURL, requestedQuality, replacementQuality) {
        const parsed = new URL(sourceURL);
        const parts = parsed.pathname.split('/');
        const index = parts.lastIndexOf(requestedQuality);
        if (index < 0) return null;
        parts[index] = replacementQuality;
        parsed.pathname = parts.join('/');
        for (const [key, value] of parsed.searchParams) {
            if (value === requestedQuality) parsed.searchParams.set(key, replacementQuality);
        }
        return parsed.href;
    }

    // Distinguishes "this file does not exist" from "the CDN is throttling us":
    // a transient answer must be retried, a definitive one must not.
    function classifyValidation(status, contentType) {
        if (status === 404 || status === 410) return { valid: false, definitive: true, status };
        if (status === 429 || status >= 500) return { valid: false, transient: true, status };
        if (status !== 200 && status !== 206) return { valid: false, transient: true, status };
        const mime = String(contentType || '').toLowerCase();
        const valid = !mime || mime.includes('video/') || mime.includes('audio/') ||
            mime.includes('application/mp4') || mime.includes('application/octet-stream') || mime.includes('binary');
        return valid
            ? { valid: true, status, contentType }
            : { valid: false, transient: true, status, contentType };
    }

    function calculateSeekbarSegments(results, totalDuration) {
        if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];
        const sorted = results
            .filter((item) => Number.isFinite(item.startTime) && Number.isFinite(item.duration) && item.duration > 0)
            .sort((a, b) => a.startTime - b.startTime || a.duration - b.duration);
        const ranges = [];
        for (const item of sorted) {
            const end = Math.min(totalDuration, item.startTime + item.duration);
            const previous = ranges[ranges.length - 1];
            if (previous && previous.quality === item.quality && item.startTime <= previous.end + 0.01) {
                previous.end = Math.max(previous.end, end);
            } else {
                ranges.push({ start: Math.max(0, item.startTime), end, quality: item.quality });
            }
        }
        return ranges.map((range) => ({
            left: (range.start / totalDuration) * 100,
            width: ((range.end - range.start) / totalDuration) * 100,
            quality: range.quality
        }));
    }

    return {
        calculateSeekbarSegments,
        classifyValidation,
        isAllowedMediaURL,
        isMutedURL,
        isTwitchURL,
        isTwitchVodURL,
        parseHlsPlaylist,
        replaceQualityComponent,
        resolveMediaURL,
        unmuteURL
    };
});
