// Twitch VOD Unmute 1.6.1
// Validation and playlist download run inside the Twitch page, because the CDN
// answers 403 to the same requests made from the extension origin.
// Redirects are exact per-segment rules, like the original extension.
if (typeof importScripts === 'function') importScripts('helpers.js');

const QUALITIES = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];
const PLAYLIST_PATTERN = /index-muted-[A-Z0-9]+\.m3u8/i;
const BATCH_SIZE = 6;
const MAX_RULES = 4500;

class VODUnmute {
    constructor() {
        this.tabs = new Map();   // tabId -> { vodBase, renditions: Map<quality, rendition> }
        this.epochs = new Map();
        this.activeQuality = new Map(); // tabId -> quality the player is actually requesting
        this.probeCache = new Map();    // candidate URL -> { status, at }
        this.queue = [];
        this.working = false;
        this.mutations = Promise.resolve();
        this.nextRuleId = 1;
        this.setupListeners();
    }

    // --- lifecycle ----------------------------------------------------------

    setupListeners() {
        chrome.runtime.onInstalled.addListener(async () => {
            await this.ensureDefaults();
            await this.clearAll();
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync') return;
            if (changes.enabled && changes.enabled.newValue !== true) this.clearAll().catch(() => {});
        });

        chrome.tabs.onRemoved.addListener((tabId) => this.cleanupTab(tabId).catch(() => {}));
        chrome.tabs.onUpdated.addListener((tabId, change) => {
            if (change.status === 'loading' || change.url) this.cleanupTab(tabId).catch(() => {});
        });

        chrome.webRequest.onCompleted.addListener(
            (details) => this.onPlaylist(details),
            { types: ['xmlhttprequest', 'media', 'other'], urls: ['https://*.cloudfront.net/*', 'https://*.ttvnw.net/*'] }
        );

        // The rendition the player is really pulling is the one whose segments
        // are being requested, so watch segment traffic instead of guessing.
        chrome.webRequest.onBeforeRequest.addListener(
            (details) => this.onSegmentRequest(details),
            { types: ['xmlhttprequest', 'media', 'other'], urls: ['https://*.cloudfront.net/*', 'https://*.ttvnw.net/*'] }
        );

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action !== 'getStats') return false;
            chrome.tabs.query({ active: true, currentWindow: true })
                .then((tabs) => sendResponse(this.statsFor(tabs[0]?.id)))
                .catch(() => sendResponse(this.emptyStats()));
            return true;
        });
    }

    async ensureDefaults() {
        const defaults = { enabled: true, seekbar: true, unmutedColour: '#00FF00', qualityColour: '#FFFF00', opacity: 0.5, quality: true };
        const values = await chrome.storage.sync.get(Object.keys(defaults));
        const missing = {};
        for (const [key, value] of Object.entries(defaults)) if (values[key] === undefined) missing[key] = value;
        if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
    }

    emptyStats() {
        return { unmuted: 0, lowerQuality: 0, muted: 0, candidates: 0, state: 'waiting', message: 'Waiting for a Twitch VOD playlist...' };
    }

    epoch(tabId) { return this.epochs.get(tabId) || 0; }
    bump(tabId) { const value = this.epoch(tabId) + 1; this.epochs.set(tabId, value); return value; }
    serialize(task) { const result = this.mutations.then(task, task); this.mutations = result.catch(() => {}); return result; }

    statsFor(tabId) {
        const entry = this.tabs.get(tabId);
        if (!entry || !entry.renditions.size) return this.emptyStats();
        // An in-progress check must stay visible: otherwise an already finished
        // rendition hides the progress of the one the player is actually using.
        const rank = (rendition) => {
            if (rendition.stats.state === 'processing') return 3;
            if (rendition.ruleIds.length) return 2;
            if (rendition.stats.muted || rendition.stats.candidates) return 1;
            return 0;
        };
        return [...entry.renditions.values()].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)[0].stats;
    }

    rendition(tabId, vodBase, quality) {
        let entry = this.tabs.get(tabId);
        if (!entry || entry.vodBase !== vodBase) {
            entry = { vodBase, renditions: new Map() };
            this.tabs.set(tabId, entry);
        }
        if (!entry.renditions.has(quality)) {
            entry.renditions.set(quality, { quality, ruleIds: [], signature: null, stats: this.emptyStats(), playlistURL: undefined, updatedAt: Date.now() });
        }
        return entry.renditions.get(quality);
    }

    setStats(tabId, vodBase, quality, patch) {
        const rendition = this.rendition(tabId, vodBase, quality);
        rendition.stats = { ...rendition.stats, ...patch };
        rendition.updatedAt = Date.now();
    }

    // --- playlist detection -------------------------------------------------

    onPlaylist(details) {
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
        if (!PLAYLIST_PATTERN.test(details.url.split('/').at(-1))) return;
        if (this.queue.some((item) => item.tabId === details.tabId && item.url === details.url)) return;
        this.queue.push({ tabId: details.tabId, url: details.url, epoch: this.epoch(details.tabId) });
        this.sortQueue(details.tabId);
        if (!this.working) this.drain().catch((error) => console.warn('[VOD Unmute] Queue failed:', error));
    }

    onSegmentRequest(details) {
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
        const parts = details.url.split('/');
        const file = parts.at(-1) || '';
        if (!/\.(?:ts|mp4|m4s|aac)(?:\?|$)/i.test(file)) return;
        const quality = parts.at(-2);
        if (!quality) return;
        if (this.activeQuality.get(details.tabId) === quality) return;
        this.activeQuality.set(details.tabId, quality);
        console.log(`[VOD Unmute] Player is using ${quality}.`);
        this.sortQueue(details.tabId);
        // Switching quality mid-playback must trigger a check for the new one,
        // because its playlist was already fetched and will not repeat.
        this.requeueActive(details.tabId, quality);
    }

    requeueActive(tabId, quality) {
        const entry = this.tabs.get(tabId);
        const rendition = entry?.renditions.get(quality);
        if (!entry || !rendition || rendition.ruleIds.length || rendition.playlistURL === undefined) return;
        if (this.queue.some((item) => item.tabId === tabId && item.url === rendition.playlistURL)) return;
        rendition.signature = null;
        this.queue.unshift({ tabId, url: rendition.playlistURL, epoch: this.epoch(tabId) });
        if (!this.working) this.drain().catch((error) => console.warn('[VOD Unmute] Queue failed:', error));
    }

    // Check the rendition the player is playing first: a background rendition
    // must never delay the quality the user actually watches.
    sortQueue(tabId) {
        const active = this.activeQuality.get(tabId);
        if (!active) return;
        this.queue.sort((a, b) => {
            const score = (item) => (item.tabId === tabId && item.url.split('/').at(-2) === active ? 0 : 1);
            return score(a) - score(b);
        });
    }

    async drain() {
        this.working = true;
        try {
            while (this.queue.length) {
                const item = this.queue.shift();
                try {
                    await this.process(item);
                } catch (error) {
                    console.warn('[VOD Unmute] Playlist processing failed:', error);
                }
            }
        } finally {
            this.working = false;
        }
    }

    async process({ tabId, url, epoch }) {
        if ((await chrome.storage.sync.get('enabled')).enabled !== true) return;
        if (epoch !== this.epoch(tabId)) return;

        const parts = url.split('/');
        const quality = parts.at(-2);
        const vodBase = parts.slice(0, -2).join('/');

        // Only spend probes on the rendition the player is actually pulling.
        // Other renditions are recorded and processed when the user switches.
        const active = this.activeQuality.get(tabId);
        if (active && active !== quality) {
            this.setStats(tabId, vodBase, quality, {
                state: 'waiting',
                message: `${quality} is not the rendition in use (${active}); skipped.`
            });
            // Remember where the playlist lives so a later quality switch can
            // process it without waiting for Twitch to request it again.
            this.rendition(tabId, vodBase, quality).playlistURL = url;
            console.log(`[VOD Unmute] Skipping ${quality}: player is using ${active}.`);
            return;
        }
        this.rendition(tabId, vodBase, quality).playlistURL = url;

        // A different VOD in the same tab must drop old rules; a different
        // rendition of the same VOD must not touch the others.
        const known = this.tabs.get(tabId);
        if (known && known.vodBase !== vodBase) {
            await this.cleanupTab(tabId);
            epoch = this.epoch(tabId);
        }

        const text = await this.fetchInPage(tabId, url);
        if (text === null) {
            console.warn('[VOD Unmute] Playlist download failed in page context:', url);
            return;
        }
        if (epoch !== this.epoch(tabId)) return;

        const segmentRegex = /^[^#\s][^\s]*\.(?:ts|mp4|m4s|aac)(?:\?[^\s]*)?$/gm;
        const allSegments = text.match(segmentRegex) || [];
        if (!allSegments.length) return;

        // fMP4 playlists carry an init segment in #EXT-X-MAP. It defines the audio
        // track parameters, so mixing a muted init with unmuted media segments
        // breaks decoding and Twitch reports error #2000.
        const initSegments = [...text.matchAll(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/gi)].map((match) => match[1]);
        const mutedInits = [...new Set(initSegments.filter((uri) => uri.includes('-muted')))];

        const muted = [...new Set(allSegments.filter((line) => line.includes('-muted')))];
        console.log(`[VOD Unmute] ${quality}: ${allSegments.length} segments, ${muted.length} muted, ${mutedInits.length} muted init.`);

        const signature = `${muted.length}:${allSegments.length}:${muted[0] || ''}`;
        const rendition = this.rendition(tabId, vodBase, quality);
        if (rendition.signature === signature && rendition.ruleIds.length) return;

        if (!muted.length) {
            this.setStats(tabId, vodBase, quality, { ...this.emptyStats(), state: 'ready', message: `No muted segments in ${quality}.` });
            return;
        }

        this.setStats(tabId, vodBase, quality, {
            ...this.emptyStats(), muted: muted.length, state: 'processing',
            message: `Checking ${muted.length} muted segments...`
        });

        const allowLower = (await chrome.storage.sync.get('quality')).quality === true;
        const positions = new Map(allSegments.map((segment, index) => [segment, index]));
        const results = [];
        let checked = 0;

        // Redirecting media segments to a lower rendition while the player keeps
        // the current init segment produces a codec mismatch, so only same-quality
        // candidates are ever installed for fMP4 playlists.
        const fmp4 = initSegments.length > 0 || allSegments.some((segment) => /\.(?:mp4|m4s)(?:\?|$)/i.test(segment));
        const perSegmentLower = allowLower && !fmp4;
        if (allowLower && fmp4) {
            console.log('[VOD Unmute] fMP4 playlist: lower-quality fallback disabled to keep the audio track consistent.');
        }
        console.log(`[VOD Unmute] ${quality}: probing ${muted.length} candidates...`);

        for (let start = 0; start < muted.length; start += BATCH_SIZE) {
            if (epoch !== this.epoch(tabId)) return;
            const batch = muted.slice(start, start + BATCH_SIZE);
            const attempts = batch.map((segment) => this.candidatesFor(segment, quality, vodBase, perSegmentLower));
            const responses = await this.probeInPage(tabId, attempts.map((list) => list.map((item) => item.url)));
            if (responses === null) {
                console.warn(`[VOD Unmute] ${quality}: probing stopped, the tab is no longer scriptable.`);
                this.setStats(tabId, vodBase, quality, {
                    state: 'unavailable',
                    message: `${quality}: checks stopped after ${checked}/${muted.length}; reload the page to retry.`
                });
                return;
            }
            if (epoch !== this.epoch(tabId)) return;

            batch.forEach((segment, index) => {
                const statuses = responses[index] || [];
                const found = statuses.findIndex((status) => status === 200 || status === 206);
                results.push({
                    segment,
                    position: positions.get(segment) ?? 0,
                    quality: found >= 0 ? attempts[index][found].quality : null,
                    url: found >= 0 ? attempts[index][found].url : null,
                    statuses
                });
            });

            checked += batch.length;
            const found = results.filter((item) => item.url).length;
            this.setStats(tabId, vodBase, quality, {
                state: 'processing',
                candidates: found,
                message: `${quality}: checked ${checked}/${muted.length}, ${found} restorable so far...`
            });
        }

        // The init segment must be redirected too, otherwise the decoder is
        // configured from muted audio and the unmuted media segments cannot play.
        const initRedirects = [];
        if (mutedInits.length) {
            const initGroups = mutedInits.map((uri) => [this.resolveSegment(vodBase, quality, uri.replace('-muted', ''))]);
            const initStatuses = await this.probeInPage(tabId, initGroups);
            if (initStatuses === null || epoch !== this.epoch(tabId)) return;
            mutedInits.forEach((uri, index) => {
                const status = initStatuses[index]?.[0];
                if (status === 200 || status === 206) {
                    initRedirects.push({ segment: uri, url: initGroups[index][0], quality, position: 0, statuses: [status] });
                } else {
                    console.warn(`[VOD Unmute] Muted init segment has no unmuted original (status=${status}); skipping redirects to avoid error #2000.`, uri);
                }
            });
            if (initRedirects.length !== mutedInits.length) {
                this.setStats(tabId, vodBase, quality, {
                    ...this.emptyStats(),
                    muted: muted.length,
                    state: 'unavailable',
                    message: 'The muted init segment cannot be replaced, so redirects would break playback.'
                });
                return;
            }
        }

        const restored = results.filter((item) => item.url);
        const stats = {
            ...this.emptyStats(),
            candidates: restored.length,
            unmuted: restored.filter((item) => item.quality === quality).length,
            lowerQuality: restored.filter((item) => item.quality !== quality).length,
            muted: results.length - restored.length
        };

        if (!restored.length) {
            // The muted original is played by Twitch, so it must be reachable.
            // If it is not, our probing method is at fault rather than the CDN.
            const control = await this.probeInPage(tabId, [[`${vodBase}/${quality}/${results[0].segment.split('?')[0]}`]]);
            const controlStatus = control?.[0]?.[0];
            const codes = [...new Set(results.flatMap((item) => item.statuses))].join(', ') || 'none';
            console.warn(`[VOD Unmute] ${quality}: no unmuted files. statuses=${codes}, muted control=${controlStatus}.`,
                'Sample:', `${vodBase}/${quality}/${results[0].segment.replace('-muted', '')}`);
            this.setStats(tabId, vodBase, quality, {
                ...stats,
                state: 'unavailable',
                message: controlStatus === 200 || controlStatus === 206
                    ? 'Twitch does not store unmuted files for this VOD; audio cannot be restored.'
                    : `Segment probing is being blocked (control=${controlStatus}); result is not reliable.`
            });
            return;
        }

        await this.installRules(tabId, vodBase, quality, signature, [...initRedirects, ...restored], epoch, stats);
        if (epoch !== this.epoch(tabId)) return;
        await this.paintSeekbar(tabId, results, allSegments.length, quality);
    }

    resolveSegment(vodBase, quality, uri) {
        if (/^https?:\/\//i.test(uri)) return uri;
        return `${vodBase}/${quality}/${uri.replace(/^\.?\//, '')}`;
    }

    candidatesFor(segment, requestedQuality, vodBase, allowLower) {
        const unmuted = segment.replace('-muted', '');
        const index = QUALITIES.indexOf(requestedQuality);
        const list = allowLower && index >= 0 ? QUALITIES.slice(index) : [requestedQuality];
        return list.map((quality) => ({ quality, url: `${vodBase}/${quality}/${unmuted}` }));
    }

    // --- page-context networking --------------------------------------------

    async fetchInPage(tabId, url) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                args: [url],
                func: async (target) => {
                    try {
                        const response = await fetch(target);
                        if (!response.ok) return null;
                        return await response.text();
                    } catch {
                        return null;
                    }
                }
            });
            return result?.result ?? null;
        } catch (error) {
            console.debug('[VOD Unmute] executeScript failed:', error.message);
            return null;
        }
    }

    async probeInPage(tabId, urlGroups) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                args: [urlGroups],
                func: async (groups) => {
                    // Same shape as the upstream extension: plain GET, aborted as
                    // soon as headers arrive, retried a couple of times because
                    // the CDN refuses streams under parallel load.
                    const probe = async (url) => {
                        let status = 0;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            const controller = new AbortController();
                            try {
                                const response = await fetch(url, { signal: controller.signal });
                                status = response.status;
                                // Release the body without downloading the segment.
                                controller.abort();
                                break;
                            } catch {
                                controller.abort();
                                status = 0;
                            }
                        }
                        return status;
                    };
                    return await Promise.all(groups.map(async (urls) => {
                        const statuses = [];
                        for (const url of urls) {
                            const status = await probe(url);
                            statuses.push(status);
                            if (status === 200 || status === 206) break;
                        }
                        return statuses;
                    }));
                }
            });
            return result?.result ?? null;
        } catch (error) {
            console.debug('[VOD Unmute] Probe failed:', error.message);
            return null;
        }
    }

    // --- rules --------------------------------------------------------------

    async installRules(tabId, vodBase, quality, signature, restored, epoch, stats) {
        await this.serialize(async () => {
            if (epoch !== this.epoch(tabId)) return;
            const live = await chrome.declarativeNetRequest.getSessionRules();
            this.nextRuleId = Math.max(this.nextRuleId, live.reduce((max, rule) => Math.max(max, rule.id), 0) + 1);
            if (this.nextRuleId > 2147480000) this.nextRuleId = 1;

            const entry = this.tabs.get(tabId);
            if (!entry || entry.vodBase !== vodBase) return;
            const rendition = entry.renditions.get(quality);
            if (!rendition) return;

            // Only this rendition's rules are replaced: other qualities of the
            // same VOD keep working.
            const removeRuleIds = rendition.ruleIds.filter((id) => live.some((rule) => rule.id === id));

            const addRules = restored.slice(0, MAX_RULES).map((item) => ({
                id: this.nextRuleId++,
                priority: 1,
                action: { type: 'redirect', redirect: { url: item.url } },
                condition: {
                    urlFilter: `${vodBase}/${quality}/${item.segment.split('?')[0]}`,
                    tabIds: [tabId],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            }));

            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });

            if (epoch !== this.epoch(tabId)) {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map((rule) => rule.id) });
                return;
            }

            rendition.ruleIds = addRules.map((rule) => rule.id);
            rendition.signature = signature;
            rendition.updatedAt = Date.now();
            rendition.stats = {
                ...stats,
                state: 'ready',
                message: stats.muted
                    ? `Redirecting ${stats.candidates} segments in ${quality}; ${stats.muted} unavailable.`
                    : `Redirecting all ${stats.candidates} muted segments in ${quality}.`
            };
            console.log(`[VOD Unmute] Installed ${addRules.length} redirect rules for ${quality}.`);
        });
    }

    async cleanupTab(tabId) {
        this.bump(tabId);
        const epoch = this.epoch(tabId);
        this.queue = this.queue.filter((item) => item.tabId !== tabId);
        await this.serialize(async () => {
            const live = await chrome.declarativeNetRequest.getSessionRules();
            const entry = this.tabs.get(tabId);
            const removeRuleIds = [...new Set([
                ...(entry ? [...entry.renditions.values()].flatMap((rendition) => rendition.ruleIds) : []),
                ...live.filter((rule) => rule.condition?.tabIds?.includes(tabId)).map((rule) => rule.id)
            ])];
            if (removeRuleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
            if (this.epoch(tabId) === epoch) this.tabs.delete(tabId);
        });
    }

    async clearAll() {
        for (const tabId of [...this.tabs.keys(), ...this.epochs.keys()]) this.bump(tabId);
        this.queue = [];
        await this.serialize(async () => {
            const live = await chrome.declarativeNetRequest.getSessionRules();
            if (live.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: live.map((rule) => rule.id) });
            this.tabs.clear();
        });
    }

    // --- seekbar ------------------------------------------------------------

    async paintSeekbar(tabId, results, totalSegments, quality) {
        const settings = await chrome.storage.sync.get(['seekbar', 'unmutedColour', 'qualityColour', 'opacity']);
        if (settings.seekbar !== true) return;
        const opacityHex = Math.round((Number.isFinite(settings.opacity) ? settings.opacity : 0.5) * 255).toString(16).padStart(2, '0');
        const colours = {
            unmuted: (/^#[0-9a-f]{6}$/i.test(settings.unmutedColour) ? settings.unmutedColour : '#00FF00') + opacityHex,
            lower: (/^#[0-9a-f]{6}$/i.test(settings.qualityColour) ? settings.qualityColour : '#FFFF00') + opacityHex
        };
        const ranges = [];
        for (const item of results.filter((entry) => entry.url).sort((a, b) => a.position - b.position)) {
            const previous = ranges.at(-1);
            const kind = item.quality === quality ? 'unmuted' : 'lower';
            if (previous && previous.kind === kind && item.position === previous.end + 1) previous.end = item.position;
            else ranges.push({ start: item.position, end: item.position, kind });
        }
        const segments = ranges.map((range) => ({
            left: (range.start / totalSegments) * 100,
            width: ((range.end - range.start + 1) / totalSegments) * 100,
            colour: colours[range.kind]
        }));

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                args: [segments],
                func: (ranges) => {
                    const bar = document.querySelector('div.seekbar-bar');
                    if (!bar || !bar.firstElementChild) return;
                    bar.querySelectorAll('[data-vod-unmute]').forEach((node) => node.remove());
                    const template = bar.firstElementChild;
                    const thumb = bar.lastElementChild;
                    for (const range of ranges) {
                        const span = template.cloneNode(false);
                        span.dataset.vodUnmute = '';
                        span.style.insetInlineStart = `${range.left}%`;
                        span.style.width = `${range.width}%`;
                        span.style.backgroundColor = range.colour;
                        bar.insertBefore(span, thumb);
                    }
                }
            });
        } catch {}
    }
}

if (typeof module === 'object' && module.exports) module.exports = { VODUnmute };
else new VODUnmute();
