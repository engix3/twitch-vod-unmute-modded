(function (root, factory) {
    const helpers = factory();
    if (typeof module === 'object' && module.exports) module.exports = helpers;
    root.VODHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
        parts[parts.length - 1] = parts[parts.length - 1].replace('-muted', '');
        parsed.pathname = parts.join('/');
        return parsed.href;
    }

    function isMutedURL(sourceURL) {
        try {
            const filename = new URL(sourceURL).pathname.split('/').pop();
            return filename.includes('-muted');
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

    function exactURLRegex(url) {
        return '^' + String(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    }

    function asciiRegex(value, limit = 2000) {
        return typeof value === 'string' && value.length <= limit && /^[\x00-\x7F]*$/.test(value);
    }

    function commonPrefix(values) {
        if (!values.length) return '';
        let prefix = values[0];
        for (const value of values.slice(1)) {
            let length = 0;
            while (length < prefix.length && prefix[length] === value[length]) length++;
            prefix = prefix.slice(0, length);
        }
        return prefix;
    }

    function createDnrRuleSpec(entries, candidates, requestedQuality, replacementQuality) {
        if (!Array.isArray(entries) || !entries.length || entries.length !== candidates.length) return null;
        const sources = entries.map((entry) => new URL(entry.url));
        const targets = candidates.map((candidate) => new URL(candidate.url));
        if (sources.some((url) => !isAllowedMediaURL(url.href)) || targets.some((url) => !isAllowedMediaURL(url.href))) return null;
        if (sources.some((url) => url.protocol !== 'https:' || url.origin !== sources[0].origin)) return null;
        if (targets.some((url) => url.protocol !== 'https:' || url.origin !== targets[0].origin)) return null;

        const sourcePaths = sources.map((url) => url.pathname);
        const escapedOrigin = String(sources[0].origin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let regex;
        let substitution;
        const sourceDirectories = sourcePaths.map((path) => path.slice(0, path.lastIndexOf('/') + 1));
        const sourceDirectory = sourceDirectories[0];
        if (sourceDirectories.some((directory) => directory !== sourceDirectory)) return null;
        const targetDirectories = targets.map((url) => url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1));
        const targetDirectory = targetDirectories[0];
        if (targetDirectories.some((directory) => directory !== targetDirectory)) return null;
        if (!replacementQuality) {
            if (targets.some((url, index) => url.origin !== sources[index].origin || url.pathname !== sourcePaths[index].replace(/-muted/, '') || url.search !== sources[index].search)) return null;
            const escapedDirectory = sourceDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = `^${escapedOrigin}${escapedDirectory}([^/?#]+)-muted([^/?#]*)(\\?.*)?$`;
            substitution = `${sources[0].origin}${sourceDirectory}\\1\\2\\3`;
        } else {
            const qualityMarker = `/${requestedQuality}/`;
            if (!sourceDirectory.endsWith(qualityMarker) || !targetDirectory.endsWith(`/${replacementQuality}/`)) return null;
            if (targets.some((url, index) => url.origin !== sources[index].origin || url.pathname !== sourcePaths[index].replace(qualityMarker, `/${replacementQuality}/`).replace(/-muted/, '') || url.search !== sources[index].search)) return null;
            const escapedDirectory = sourceDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = `^${escapedOrigin}${escapedDirectory}([^/?#]+)-muted([^/?#]*)(\\?.*)?$`;
            substitution = `${sources[0].origin}${targetDirectory}\\1\\2\\3`;
        }
        if (!asciiRegex(regex) || !asciiRegex(substitution)) return null;
        const check = new RegExp(regex);
        if (sources.some((url) => !check.test(url.href))) return null;
        return { regexFilter: regex, regexSubstitution: substitution };
    }

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

    function targetKey(tabId, url) {
        return `${tabId}\n${url}`;
    }

    function resolveTargetRule(targetIndex, tabId, url) {
        if (tabId >= 0) {
            const ids = targetIndex.get(targetKey(tabId, url));
            return ids && ids.size === 1 ? ids.values().next().value : null;
        }
        const matches = new Set();
        for (const [key, ids] of targetIndex) {
            if (key.slice(key.indexOf('\n') + 1) !== url) continue;
            for (const id of ids) matches.add(id);
        }
        return matches.size === 1 ? matches.values().next().value : null;
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
        createDnrRuleSpec,
        exactURLRegex,
        isAllowedMediaURL,
        isMutedURL,
        isTwitchURL,
        isTwitchVodURL,
        parseHlsPlaylist,
        replaceQualityComponent,
        resolveTargetRule,
        targetKey,
        unmuteURL
    };
});
