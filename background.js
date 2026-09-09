// Twitch VOD Unmute — Modded
// Playlist download and segment probing run inside the Twitch page, because the
// CDN answers 403 to the same requests made from the extension origin.
// Redirects are exact per-segment rules, like the original extension.
if (typeof importScripts === 'function') importScripts('helpers.js');

const QUALITIES = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];
const PLAYLIST_PATTERN = /index-muted-[A-Z0-9]+\.m3u8/i;
const SEGMENT_PATTERN = /\.(?:ts|mp4|m4s|aac)(?:\?|$)/i;
const QUALITY_DIR_PATTERN = /^(?:chunked|audio_only|\d{3,4}p\d{2})$/;
const BATCH_SIZE = 6;
const MAX_RULES_PER_RENDITION = 4500;
const RULE_RESERVE = 100;              // keep room for other tabs and extensions
const DEFAULT_RULE_LIMIT = 5000;
const MAX_RULE_ID = 2147480000;
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_LIMIT = 20000;
const HIT_STATUSES = new Set([200, 206]);

class VODUnmute {
    constructor() {
        this.tabs = new Map();            // tabId -> { vodBase, renditions: Map<quality, rendition> }
        this.epochs = new Map();          // tabId -> invalidation counter
        this.activeQuality = new Map();   // tabId -> quality the player is actually requesting
        this.knownPlaylists = new Map();  // tabId -> Set<playlistURL>
        this.paintData = new Map();       // tabId -> { ranges, totalDuration }
        this.probeCache = new Map();      // candidate URL -> { status, at }
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
            this.onSettingsChanged(changes).catch((error) => console.warn('[VOD Unmute] Settings update failed:', error));
        });

        chrome.tabs.onRemoved.addListener((tabId) => this.forgetTab(tabId).catch(() => {}));
        chrome.tabs.onUpdated.addListener((tabId, change) => {
            if (change.status === 'loading' || change.url) this.cleanupTab(tabId).catch(() => {});
        });

        // Playlists are picked up when the request starts, not when it finishes,
        // so the rules are ready as early as possible.
        chrome.webRequest.onBeforeRequest.addListener(
            (details) => this.onRequest(details),
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

    async onSettingsChanged(changes) {
        if (changes.enabled) {
            if (changes.enabled.newValue === true) await this.reprocessKnown();
            else await this.clearAll();
            return;
        }
        // Switching the fallback on or off changes which candidates are valid,
        // so the known playlists have to be checked again.
        if (changes.quality) {
            await this.reprocessKnown();
            return;
        }
        if (changes.seekbar || changes.unmutedColour || changes.qualityColour || changes.opacity) {
            await this.repaintAll();
        }
    }

    async ensureDefaults() {
        const defaults = { enabled: true, seekbar: true, unmutedColour: '#00FF00', qualityColour: '#FFFF00', opacity: 0.5, quality: true };
        const values = await chrome.storage.sync.get(Object.keys(defaults));
        const missing = {};
        for (const [key, value] of Object.entries(defaults)) if (values[key] === undefined) missing[key] = value;
        if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
    }

    emptyStats() {
        return {
            unmuted: 0,
            lowerQuality: 0,
            muted: 0,
            candidates: 0,
            truncated: 0,
            quality: null,
            state: 'waiting',
            message: 'Ожидание плейлиста Twitch VOD…'
        };
    }

    epoch(tabId) { return this.epochs.get(tabId) || 0; }
    bump(tabId) { const value = this.epoch(tabId) + 1; this.epochs.set(tabId, value); return value; }
    serialize(task) { const result = this.mutations.then(task, task); this.mutations = result.catch(() => {}); return result; }
    ruleLimit() {
        const limit = chrome.declarativeNetRequest?.MAX_NUMBER_OF_SESSION_RULES;
        return (Number.isInteger(limit) ? limit : DEFAULT_RULE_LIMIT) - RULE_RESERVE;
    }

    statsFor(tabId) {
        const entry = this.tabs.get(tabId);
        if (!entry || !entry.renditions.size) return this.emptyStats();
        // An in-progress check must stay visible: otherwise an already finished
        // rendition hides the progress of the one the player is actually using.
        const active = this.activeQuality.get(tabId);
        const rank = (rendition) => {
            if (rendition.quality === active && rendition.stats.state !== 'waiting') return 4;
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
        rendition.stats = { ...rendition.stats, ...patch, quality };
        rendition.updatedAt = Date.now();
    }

    remember(tabId, url) {
        if (!this.knownPlaylists.has(tabId)) this.knownPlaylists.set(tabId, new Set());
        this.knownPlaylists.get(tabId).add(url);
    }

    // --- playlist detection -------------------------------------------------

    onRequest(details) {
        if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
        const file = details.url.split('/').at(-1) || '';
        if (PLAYLIST_PATTERN.test(file)) {
            this.onPlaylist(details);
            return;
        }
        if (SEGMENT_PATTERN.test(file)) this.onSegmentRequest(details);
    }

    onPlaylist(details) {
        this.remember(details.tabId, details.url);
        this.enqueue(details.tabId, details.url);
    }

    enqueue(tabId, url) {
        if (this.queue.some((item) => item.tabId === tabId && item.url === url)) return;
        this.queue.push({ tabId, url, epoch: this.epoch(tabId) });
        this.sortQueue(tabId);
        if (!this.working) this.drain().catch((error) => console.warn('[VOD Unmute] Queue failed:', error));
    }

    onSegmentRequest(details) {
        const parts = details.url.split('/');
        const quality = parts.at(-2);
        if (!quality || !QUALITY_DIR_PATTERN.test(quality)) return;
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
        rendition.signature = null;
        this.enqueue(tabId, rendition.playlistURL);
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

    async reprocessKnown() {
        for (const [tabId, urls] of this.knownPlaylists) {
            const entry = this.tabs.get(tabId);
            if (entry) for (const rendition of entry.renditions.values()) rendition.signature = null;
            for (const url of urls) this.enqueue(tabId, url);
        }
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
        if (!quality || !vodBase) return;

        // A different VOD in the same tab must drop the old rules before any new
        // state is created for it.
        const known = this.tabs.get(tabId);
        if (known && known.vodBase !== vodBase) {
            await this.cleanupTab(tabId);
            epoch = this.epoch(tabId);
        }

        this.remember(tabId, url);
        // Remember where the playlist lives so a later quality switch can process
        // it without waiting for Twitch to request it again.
        this.rendition(tabId, vodBase, quality).playlistURL = url;

        // Only spend probes on the rendition the player is actually pulling.
        const active = this.activeQuality.get(tabId);
        if (active && active !== quality) {
            this.setStats(tabId, vodBase, quality, {
                state: 'waiting',
                message: `${quality} сейчас не воспроизводится (играет ${active}) — пропущено.`
            });
            console.log(`[VOD Unmute] Skipping ${quality}: player is using ${active}.`);
            return;
        }

        const text = await this.fetchInPage(tabId, url);
        if (text === null) {
            console.warn('[VOD Unmute] Playlist download failed in page context:', url);
            return;
        }
        if (epoch !== this.epoch(tabId)) return;

        let playlist;
        try {
            playlist = VODHelpers.parseHlsPlaylist(text, url);
        } catch (error) {
            console.warn('[VOD Unmute] Not a valid M3U8 playlist:', error.message);
            return;
        }

        const media = playlist.entries.filter((entry) => !entry.isMap);
        if (!media.length) return;
        const maps = playlist.entries.filter((entry) => entry.isMap);
        const mutedMedia = this.dedupe(media.filter((entry) => VODHelpers.isMutedURL(entry.url)));
        const mutedMaps = this.dedupe(maps.filter((entry) => VODHelpers.isMutedURL(entry.url)));
        console.log(`[VOD Unmute] ${quality}: ${media.length} segments, ${mutedMedia.length} muted, ${mutedMaps.length} muted init.`);

        const signature = `${mutedMedia.length}:${media.length}:${mutedMedia[0]?.url || ''}`;
        const rendition = this.rendition(tabId, vodBase, quality);
        if (rendition.signature === signature && rendition.ruleIds.length) return;

        if (!mutedMedia.length) {
            this.setStats(tabId, vodBase, quality, { ...this.emptyStats(), state: 'ready', message: `В ${quality} нет заглушённых сегментов.` });
            return;
        }

        this.setStats(tabId, vodBase, quality, {
            ...this.emptyStats(), muted: mutedMedia.length, state: 'processing',
            message: `${quality}: проверяю ${mutedMedia.length} заглушённых сегментов…`
        });

        // Redirecting media segments to a lower rendition while the player keeps
        // the current init segment produces a codec mismatch, so only same-quality
        // candidates are ever installed for fMP4 playlists.
        const allowLower = (await chrome.storage.sync.get('quality')).quality === true;
        const fmp4 = maps.length > 0 || media.some((entry) => /\.(?:mp4|m4s)(?:\?|$)/i.test(entry.url));
        const perSegmentLower = allowLower && !fmp4;
        if (allowLower && fmp4) {
            console.log('[VOD Unmute] fMP4 playlist: lower-quality fallback disabled to keep the audio track consistent.');
        }

        const results = [];
        let checked = 0;
        for (let start = 0; start < mutedMedia.length; start += BATCH_SIZE) {
            if (epoch !== this.epoch(tabId)) return;
            const batch = mutedMedia.slice(start, start + BATCH_SIZE);
            const attempts = batch.map((entry) => this.candidatesFor(entry, quality, perSegmentLower));
            const responses = await this.probe(tabId, attempts.map((list) => list.map((item) => item.url)));
            if (responses === null) {
                console.warn(`[VOD Unmute] ${quality}: probing stopped, the tab is no longer scriptable.`);
                this.setStats(tabId, vodBase, quality, {
                    state: 'unavailable',
                    message: `${quality}: проверка остановлена на ${checked}/${mutedMedia.length}; перезагрузите страницу.`
                });
                return;
            }
            if (epoch !== this.epoch(tabId)) return;

            batch.forEach((entry, index) => {
                const statuses = responses[index] || [];
                const found = statuses.findIndex((status) => VODHelpers.classifyValidation(status).valid);
                results.push({
                    source: entry.url,
                    startTime: entry.startTime,
                    duration: entry.duration,
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
                message: `${quality}: проверено ${checked}/${mutedMedia.length}, доступно ${found}…`
            });
        }

        // The init segment must be redirected too, otherwise the decoder is
        // configured from muted audio and the unmuted media segments cannot play.
        const initRedirects = [];
        if (mutedMaps.length) {
            const groups = mutedMaps.map((entry) => [VODHelpers.unmuteURL(entry.url)]);
            const statuses = await this.probe(tabId, groups);
            if (statuses === null || epoch !== this.epoch(tabId)) return;
            mutedMaps.forEach((entry, index) => {
                const status = statuses[index]?.[0];
                if (VODHelpers.classifyValidation(status).valid) {
                    initRedirects.push({ source: entry.url, url: groups[index][0], quality });
                } else {
                    console.warn(`[VOD Unmute] Muted init segment has no unmuted original (status=${status}); skipping redirects to avoid error #2000.`, entry.url);
                }
            });
            if (initRedirects.length !== mutedMaps.length) {
                this.setStats(tabId, vodBase, quality, {
                    ...this.emptyStats(),
                    muted: mutedMedia.length,
                    state: 'unavailable',
                    message: 'Init-сегмент заглушён, а оригинала нет — подмена сломала бы воспроизведение.'
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
            const control = await this.probe(tabId, [[results[0].source]]);
            const controlStatus = control?.[0]?.[0];
            const codes = [...new Set(results.flatMap((item) => item.statuses))].join(', ') || 'нет';
            console.warn(`[VOD Unmute] ${quality}: no unmuted files. statuses=${codes}, muted control=${controlStatus}.`,
                'Sample:', VODHelpers.unmuteURL(results[0].source));
            this.setStats(tabId, vodBase, quality, {
                ...stats,
                state: 'unavailable',
                message: HIT_STATUSES.has(controlStatus)
                    ? 'Twitch не хранит оригиналы без «-muted» для этой записи — звук вернуть нельзя.'
                    : `Проверка сегментов блокируется (контроль=${controlStatus}) — результат ненадёжен.`
            });
            return;
        }

        await this.installRules(tabId, vodBase, quality, signature, initRedirects, restored, epoch, stats);
        if (epoch !== this.epoch(tabId)) return;
        await this.paintSeekbar(tabId, results, quality, playlist.totalDuration);
    }

    dedupe(entries) {
        const seen = new Map();
        for (const entry of entries) if (!seen.has(entry.url)) seen.set(entry.url, entry);
        return [...seen.values()];
    }

    candidatesFor(entry, requestedQuality, allowLower) {
        const unmuted = VODHelpers.unmuteURL(entry.url);
        const index = QUALITIES.indexOf(requestedQuality);
        const list = allowLower && index >= 0 ? QUALITIES.slice(index) : [requestedQuality];
        const candidates = [];
        for (const quality of list) {
            const url = quality === requestedQuality
                ? unmuted
                : VODHelpers.replaceQualityComponent(unmuted, requestedQuality, quality);
            if (url && VODHelpers.isAllowedMediaURL(url)) candidates.push({ quality, url });
        }
        return candidates;
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

    cachedStatus(url) {
        const hit = this.probeCache.get(url);
        if (!hit) return undefined;
        if (Date.now() - hit.at > PROBE_TTL_MS) {
            this.probeCache.delete(url);
            return undefined;
        }
        return hit.status;
    }

    rememberStatus(url, status) {
        // Only definitive answers are cached: a throttled or failed request must
        // be retried later instead of poisoning the result for ten minutes.
        if (!HIT_STATUSES.has(status) && status !== 404 && status !== 410) return;
        if (this.probeCache.size >= PROBE_CACHE_LIMIT) this.probeCache.clear();
        this.probeCache.set(url, { status, at: Date.now() });
    }

    // Resolves each candidate group, asking the page only about URLs whose status
    // is not already known.
    async probe(tabId, urlGroups) {
        const statuses = urlGroups.map(() => []);
        const pending = [];
        const owners = [];

        urlGroups.forEach((urls, index) => {
            let cursor = 0;
            let settled = false;
            for (; cursor < urls.length; cursor++) {
                const cached = this.cachedStatus(urls[cursor]);
                if (cached === undefined) break;
                statuses[index].push(cached);
                if (HIT_STATUSES.has(cached)) {
                    settled = true;
                    cursor++;
                    break;
                }
            }
            if (!settled && cursor < urls.length) {
                owners.push(index);
                pending.push(urls.slice(cursor));
            }
        });

        if (!pending.length) return statuses;

        const fresh = await this.probeInPage(tabId, pending);
        if (fresh === null) return null;
        fresh.forEach((group, position) => {
            const index = owners[position];
            (group || []).forEach((status, offset) => {
                this.rememberStatus(pending[position][offset], status);
                statuses[index].push(status);
            });
        });
        return statuses;
    }

    async probeInPage(tabId, urlGroups) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                args: [urlGroups],
                func: async (groups) => {
                    // A two-byte range request is enough to learn whether the file
                    // exists, and it never downloads the segment.
                    const hit = (status) => status === 200 || status === 206;
                    const definitive = (status) => hit(status) || status === 404 || status === 410;
                    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    const probe = async (url) => {
                        let status = 0;
                        for (let attempt = 0; attempt < 3; attempt++) {
                            const controller = new AbortController();
                            try {
                                const response = await fetch(url, {
                                    method: 'GET',
                                    headers: { Range: 'bytes=0-1' },
                                    cache: 'no-store',
                                    signal: controller.signal
                                });
                                status = response.status;
                                controller.abort();
                                // 404/410 mean the file is gone; only throttling and
                                // server errors are worth another attempt.
                                if (definitive(status)) return status;
                            } catch {
                                controller.abort();
                                status = 0;
                            }
                            await wait(200 * (attempt + 1));
                        }
                        return status;
                    };
                    return await Promise.all(groups.map(async (urls) => {
                        const statuses = [];
                        for (const url of urls) {
                            const status = await probe(url);
                            statuses.push(status);
                            if (hit(status)) break;
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

    allocateRuleId(used) {
        for (let guard = 0; guard < 1e7; guard++) {
            if (this.nextRuleId > MAX_RULE_ID) this.nextRuleId = 1;
            const id = this.nextRuleId++;
            // After a wrap-around the counter can land on an id another tab is
            // already using, so taken ids are skipped instead of overwritten.
            if (!used.has(id)) {
                used.add(id);
                return id;
            }
        }
        throw new Error('No free declarativeNetRequest rule id');
    }

    async installRules(tabId, vodBase, quality, signature, initRedirects, restored, epoch, stats) {
        await this.serialize(async () => {
            if (epoch !== this.epoch(tabId)) return;
            const entry = this.tabs.get(tabId);
            if (!entry || entry.vodBase !== vodBase) return;
            const rendition = entry.renditions.get(quality);
            if (!rendition) return;

            let live;
            try {
                live = await chrome.declarativeNetRequest.getSessionRules();
            } catch (error) {
                this.setStats(tabId, vodBase, quality, { ...stats, state: 'unavailable', message: `Не удалось прочитать правила: ${error.message}` });
                return;
            }

            // Only this rendition's rules are replaced: other qualities of the
            // same VOD keep working.
            const ownIds = new Set(rendition.ruleIds);
            const removeRuleIds = live.filter((rule) => ownIds.has(rule.id)).map((rule) => rule.id);
            const foreign = live.filter((rule) => !ownIds.has(rule.id));
            const used = new Set(foreign.map((rule) => rule.id));
            const budget = Math.max(0, Math.min(MAX_RULES_PER_RENDITION, this.ruleLimit() - foreign.length));

            if (budget <= initRedirects.length) {
                this.setStats(tabId, vodBase, quality, {
                    ...stats,
                    state: 'unavailable',
                    message: 'Лимит правил Chrome исчерпан другими вкладками — закройте лишние записи и обновите страницу.'
                });
                return;
            }

            const planned = [...initRedirects, ...restored].slice(0, budget);
            const truncated = initRedirects.length + restored.length - planned.length;
            const addRules = planned.map((item) => ({
                id: this.allocateRuleId(used),
                priority: 1,
                action: { type: 'redirect', redirect: { url: item.url } },
                condition: {
                    // `|` anchors the filter to the start of the URL, so the rule
                    // matches this exact segment and nothing else.
                    urlFilter: `|${item.source.split('?')[0]}`,
                    tabIds: [tabId],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            }));

            try {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
            } catch (error) {
                console.warn('[VOD Unmute] Installing rules failed:', error);
                rendition.ruleIds = [];
                rendition.signature = null;
                this.setStats(tabId, vodBase, quality, { ...stats, state: 'unavailable', message: `Не удалось установить правила: ${error.message}` });
                return;
            }

            if (epoch !== this.epoch(tabId)) {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map((rule) => rule.id) }).catch(() => {});
                return;
            }

            rendition.ruleIds = addRules.map((rule) => rule.id);
            rendition.signature = signature;
            rendition.updatedAt = Date.now();
            const installed = Math.max(0, addRules.length - initRedirects.length);
            const tail = truncated ? ` Лимит правил Chmore: ${truncated} сегментов пропущено.` : '';
            rendition.stats = {
                ...stats,
                truncated,
                quality,
                state: 'ready',
                message: (stats.muted
                    ? `Подменяю ${installed} сегментов в ${quality}; ${stats.muted} недоступны.`
                    : `Подменяю все ${installed} заглушённых сегментов в ${quality}.`) + tail
            };
            console.log(`[VOD Unmute] Installed ${addRules.length} redirect rules for ${quality}${truncated ? ` (${truncated} skipped, rule limit)` : ''}.`);
        });
    }

    async cleanupTab(tabId) {
        this.bump(tabId);
        const epoch = this.epoch(tabId);
        this.queue = this.queue.filter((item) => item.tabId !== tabId);
        this.activeQuality.delete(tabId);
        this.knownPlaylists.delete(tabId);
        this.paintData.delete(tabId);
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

    // A closed tab can never come back, so its counters are dropped too.
    async forgetTab(tabId) {
        await this.cleanupTab(tabId);
        this.epochs.delete(tabId);
    }

    async clearAll() {
        for (const tabId of [...this.tabs.keys(), ...this.epochs.keys()]) this.bump(tabId);
        this.queue = [];
        this.activeQuality.clear();
        const painted = [...this.paintData.keys()];
        this.paintData.clear();
        await this.serialize(async () => {
            const live = await chrome.declarativeNetRequest.getSessionRules();
            if (live.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: live.map((rule) => rule.id) });
            this.tabs.clear();
        });
        for (const tabId of painted) await this.injectPainter(tabId, []);
    }

    // --- seekbar ------------------------------------------------------------

    async paintSeekbar(tabId, results, quality, totalDuration) {
        const ranges = results.filter((item) => item.url).map((item) => ({
            startTime: item.startTime,
            duration: item.duration,
            quality: item.quality === quality ? 'unmuted' : 'lower'
        }));
        this.paintData.set(tabId, { ranges, totalDuration });
        await this.renderSeekbar(tabId);
    }

    async repaintAll() {
        for (const tabId of [...this.paintData.keys()]) await this.renderSeekbar(tabId);
    }

    async renderSeekbar(tabId) {
        const data = this.paintData.get(tabId);
        if (!data) return;
        const settings = await chrome.storage.sync.get(['seekbar', 'unmutedColour', 'qualityColour', 'opacity']);
        const segments = settings.seekbar === true ? this.colourize(data, settings) : [];
        await this.injectPainter(tabId, segments);
    }

    colourize({ ranges, totalDuration }, settings) {
        const opacity = Number.isFinite(settings.opacity) ? Math.min(1, Math.max(0, settings.opacity)) : 0.5;
        const suffix = Math.round(opacity * 255).toString(16).padStart(2, '0');
        const colours = {
            unmuted: (/^#[0-9a-f]{6}$/i.test(settings.unmutedColour) ? settings.unmutedColour : '#00FF00') + suffix,
            lower: (/^#[0-9a-f]{6}$/i.test(settings.qualityColour) ? settings.qualityColour : '#FFFF00') + suffix
        };
        return VODHelpers.calculateSeekbarSegments(ranges, totalDuration).map((range) => ({
            left: range.left,
            width: range.width,
            colour: colours[range.quality] || colours.unmuted
        }));
    }

    async injectPainter(tabId, segments) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                args: [segments],
                func: (ranges) => {
                    const state = window.__vodUnmute || (window.__vodUnmute = {});
                    state.ranges = ranges;
                    if (!state.paint) {
                        state.paint = () => {
                            const bar = document.querySelector('div.seekbar-bar');
                            if (!bar || !bar.firstElementChild) return;
                            bar.querySelectorAll('[data-vod-unmute]').forEach((node) => node.remove());
                            const list = state.ranges || [];
                            if (!list.length) return;
                            const template = bar.firstElementChild;
                            const thumb = bar.lastElementChild;
                            for (const range of list) {
                                const span = template.cloneNode(false);
                                span.dataset.vodUnmute = '';
                                span.style.position = 'absolute';
                                span.style.insetInlineStart = `${range.left}%`;
                                span.style.width = `${range.width}%`;
                                span.style.backgroundColor = range.colour;
                                bar.insertBefore(span, thumb);
                            }
                        };

                        let scheduled = false;
                        let lastSweep = 0;
                        const schedule = () => {
                            if (scheduled) return;
                            scheduled = true;
                            requestAnimationFrame(() => {
                                scheduled = false;
                                state.paint();
                            });
                        };
                        // Twitch rebuilds the player on fullscreen, theatre mode and
                        // in-app navigation, which throws the overlay away, so the
                        // seekbar is watched and repainted instead of painted once.
                        state.observer = new MutationObserver((mutations) => {
                            for (const mutation of mutations) {
                                for (const node of mutation.addedNodes) {
                                    if (node.nodeType !== 1) continue;
                                    if (node.matches?.('div.seekbar-bar') || node.querySelector?.('div.seekbar-bar')) {
                                        schedule();
                                        return;
                                    }
                                }
                            }
                            const now = Date.now();
                            if (now - lastSwe