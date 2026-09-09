// Twitch VOD Unmute — Modded
// Playlist download and segment probing run inside the Twitch page (see net.js),
// because the CDN answers 403 to the same requests made from the extension
// origin. Redirects are exact per-segment rules, like the original extension.
if (typeof importScripts === 'function') importScripts('helpers.js', 'net.js', 'rules.js', 'seekbar.js');

const QUALITIES = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];
const PLAYLIST_PATTERN = /index-muted-[A-Z0-9]+\.m3u8/i;
const SEGMENT_PATTERN = /\.(?:ts|mp4|m4s|aac)(?:\?|$)/i;
const QUALITY_DIR_PATTERN = /^(?:chunked|audio_only|\d{3,4}p\d{2})$/;
const BATCH_SIZE = 6;
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_LIMIT = 20000;
// Adaptive streaming keeps several renditions warm, so a quality counts as
// playing while its segments were requested recently.
const ACTIVE_TTL_MS = 60 * 1000;
// Twitch re-requests the same media playlist over and over; a rendition with a
// verdict is not downloaded again until this window passes.
const RECHECK_AFTER_MS = 30 * 1000;
// How often the page timeline may be scanned for playlists we never saw.
const DISCOVER_EVERY_MS = 10 * 1000;
const HIT_STATUSES = new Set([200, 206]);

class VODUnmute {
    constructor() {
        this.tabs = new Map();            // tabId -> { vodBase, renditions: Map<quality, rendition> }
        this.epochs = new Map();          // tabId -> invalidation counter
        this.activeQualities = new Map(); // tabId -> Map<quality, last segment request>
        this.knownPlaylists = new Map();  // tabId -> Set<playlistURL>
        this.paintData = new Map();       // tabId -> { ranges, totalDuration }
        this.probeCache = new Map();      // candidate URL -> { status, at }
        this.tabPages = new Map();        // tabId -> page identity (VOD id)
        this.discoveredAt = new Map();    // tabId -> last timeline scan
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
        chrome.tabs.onUpdated.addListener((tabId, change) => this.onTabUpdated(tabId, change));

        // Playlists are picked up when the request starts, not when it finishes,
        // so the rules are ready as early as possible.
        chrome.webRequest.onBeforeRequest.addListener(
            (details) => this.onRequest(details),
            { types: ['xmlhttprequest', 'media', 'other'], urls: ['https://*.cloudfront.net/*', 'https://*.ttvnw.net/*'] }
        );

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action !== 'getStats') return false;
            chrome.tabs.query({ active: true, currentWindow: true })
                .then((tabs) => {
                    const tabId = tabs[0]?.id;
                    const stats = this.statsFor(tabId);
                    // Nothing is known about this tab: the playlist request was
                    // probably missed, so it is looked up in the page timeline.
                    if (stats.state === 'waiting' && Number.isInteger(tabId)) {
                        this.discover(tabId).catch(() => {});
                    }
                    sendResponse(stats);
                })
                .catch(() => sendResponse(this.emptyStats()));
            return true;
        });
    }

    // Twitch is a single-page app: it rewrites the URL while playing (seek
    // timestamps, filters, chat state). Wiping the tab there used to abort the
    // running check and leave the popup on "waiting for a playlist" forever,
    // because Twitch never requests the same playlist twice.
    onTabUpdated(tabId, change) {
        if (typeof change.url === 'string') {
            const page = this.pageKey(change.url);
            const previous = this.tabPages.get(tabId);
            this.tabPages.set(tabId, page);
            if (previous === undefined || previous === page) return;
            this.cleanupTab(tabId).catch(() => {});
            return;
        }
        // A real document load (F5, back/forward) does re-request everything.
        if (change.status === 'loading') this.cleanupTab(tabId).catch(() => {});
    }

    // Two URLs of the same recording share an identity, so `?t=1h2m3s` is not a
    // new page.
    pageKey(url) {
        try {
            const parsed = new URL(url);
            const video = parsed.pathname.match(/\/videos\/(\d+)/);
            return video ? `video:${video[1]}` : `${parsed.origin}${parsed.pathname}`;
        } catch {
            return url;
        }
    }

    async onSettingsChanged(changes) {
        // Turning the extension back on used to require a manual reload: the
        // known playlists are re-checked instead.
        if (changes.enabled) {
            if (changes.enabled.newValue === true) await this.reprocessKnown();
            else await this.clearAll();
            return;
        }
        // The fallback switch changes which candidates are valid, so the known
        // playlists have to be probed again.
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

    statsFor(tabId) {
        const entry = this.tabs.get(tabId);
        if (!entry || !entry.renditions.size) return this.emptyStats();
        // The rendition the player is using wins, then an in-progress check:
        // otherwise a finished rendition hides the one being watched.
        const active = this.activeQualitiesFor(tabId);
        const rank = (rendition) => {
            if (active.includes(rendition.quality) && rendition.stats.state !== 'waiting') return 4;
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
            entry.renditions.set(quality, { quality, ruleIds: [], signature: null, checkedAt: 0, stats: this.emptyStats(), playlistURL: undefined, updatedAt: Date.now() });
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
            this.remember(details.tabId, details.url);
            this.enqueue(details.tabId, details.url);
            return;
        }
        if (SEGMENT_PATTERN.test(file)) this.onSegmentRequest(details);
    }

    // A playlist request is easy to miss (asleep service worker, extension
    // enabled mid-playback, tab state reset), and Twitch will not repeat it.
    // The page's own resource timeline still holds every playlist it loaded.
    async discover(tabId) {
        const last = this.discoveredAt.get(tabId) || 0;
        if (Date.now() - last < DISCOVER_EVERY_MS) return;
        this.discoveredAt.set(tabId, Date.now());
        if ((await chrome.storage.sync.get('enabled')).enabled !== true) return;
        const found = await VODNet.discoverPlaylists(tabId);
        const playlists = [...new Set(found)].filter((url) => VODHelpers.isAllowedMediaURL(url));
        if (!playlists.length) return;
        console.log(`[VOD Unmute] Recovered ${playlists.length} playlist(s) from the page timeline.`);
        for (const url of playlists) {
            this.remember(tabId, url);
            this.enqueue(tabId, url);
        }
    }

    enqueue(tabId, url) {
        if (this.queue.some((item) => item.tabId === tabId && item.url === url)) return;
        this.queue.push({ tabId, url, epoch: this.epoch(tabId) });
        this.sortQueue(tabId);
        if (!this.working) this.drain().catch((error) => console.warn('[VOD Unmute] Queue failed:', error));
    }

    // Twitch juggles renditions while playing (ABR, preloading the next quality),
    // so "active" is a small set with timestamps rather than a single value —
    // otherwise every switch looked like a brand new rendition.
    noteActiveQuality(tabId, quality) {
        if (!this.activeQualities.has(tabId)) this.activeQualities.set(tabId, new Map());
        const seen = this.activeQualities.get(tabId);
        const isNew = !seen.has(quality);
        seen.set(quality, Date.now());
        return isNew;
    }

    activeQualitiesFor(tabId) {
        const seen = this.activeQualities.get(tabId);
        if (!seen) return [];
        const cutoff = Date.now() - ACTIVE_TTL_MS;
        for (const [quality, at] of [...seen]) if (at < cutoff) seen.delete(quality);
        return [...seen.keys()];
    }

    isActiveQuality(tabId, quality) {
        const active = this.activeQualitiesFor(tabId);
        return !active.length || active.includes(quality);
    }

    // The rendition the player is really pulling is the one whose segments are
    // being requested, so segment traffic is watched instead of guessing.
    onSegmentRequest(details) {
        const quality = details.url.split('/').at(-2);
        if (!quality || !QUALITY_DIR_PATTERN.test(quality)) return;
        if (!this.noteActiveQuality(details.tabId, quality)) return;
        console.log(`[VOD Unmute] Player is using ${quality}.`);
        this.sortQueue(details.tabId);
        // A quality that started playing later still needs its check, because
        // its playlist was already fetched and will not be requested again.
        this.requeueActive(details.tabId, quality);
    }

    // Only renditions without a verdict are re-queued; one that was already
    // checked must not be probed again on every quality switch. A rendition we
    // have never seen a playlist for is looked up in the page timeline.
    requeueActive(tabId, quality) {
        const rendition = this.tabs.get(tabId)?.renditions.get(quality);
        if (!rendition || rendition.playlistURL === undefined) {
            this.discover(tabId).catch(() => {});
            return;
        }
        if (rendition.signature !== null) return;
        this.enqueue(tabId, rendition.playlistURL);
    }

    // Check the rendition being watched first: a background rendition must never
    // delay the quality the user actually sees.
    sortQueue(tabId) {
        const active = this.activeQualitiesFor(tabId);
        if (!active.length) return;
        this.queue.sort((a, b) => {
            const score = (item) => (item.tabId === tabId && active.includes(item.url.split('/').at(-2)) ? 0 : 1);
            return score(a) - score(b);
        });
    }

    async reprocessKnown() {
        for (const [tabId, urls] of this.knownPlaylists) {
            const entry = this.tabs.get(tabId);
            if (entry) {
                for (const rendition of entry.renditions.values()) {
                    rendition.signature = null;
                    rendition.checkedAt = 0;
                }
            }
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

    // --- processing ---------------------------------------------------------

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
        const rendition = this.rendition(tabId, vodBase, quality);
        rendition.playlistURL = url;

        // The player asks for the same playlist every few seconds. Once the
        // rendition has a verdict, it is not downloaded again for a while: this
        // is what used to spin the whole check in a loop.
        if (rendition.signature !== null && Date.now() - rendition.checkedAt < RECHECK_AFTER_MS) return;

        // Only spend probes on renditions the player is actually pulling.
        if (!this.isActiveQuality(tabId, quality)) {
            this.setStats(tabId, vodBase, quality, {
                state: 'waiting',
                message: `${quality} сейчас не воспроизводится (играет ${this.activeQualitiesFor(tabId).join(', ')}) — пропущено.`
            });
            return;
        }

        const text = await VODNet.fetchInPage(tabId, url);
        if (text === null) {
            console.warn('[VOD Unmute] Playlist download failed in page context:', url);
            return;
        }
        if (epoch !== this.epoch(tabId)) {
            console.log('[VOD Unmute] Check dropped: the tab state changed while the playlist was loading.');
            return;
        }

        let playlist;
        try {
            // Segment lines can be relative, `../`-relative or absolute, so they
            // are resolved against the playlist URL instead of concatenated.
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

        const signature = `${mutedMedia.length}:${media.length}:${mutedMedia[0]?.url || ''}`;
        // The verdict is stored before probing, so an unchanged playlist is never
        // processed twice — including the "nothing could be restored" verdict.
        if (rendition.signature === signature) {
            rendition.checkedAt = Date.now();
            return;
        }
        rendition.signature = signature;
        rendition.checkedAt = Date.now();
        const giveUp = (reason) => {
            rendition.signature = null;
            rendition.checkedAt = 0;
            if (reason) console.log(`[VOD Unmute] Check dropped: ${reason}`);
        };

        console.log(`[VOD Unmute] ${quality}: ${media.length} segments, ${mutedMedia.length} muted, ${mutedMaps.length} muted init.`);

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
            if (epoch !== this.epoch(tabId)) { giveUp('the tab state changed mid-check.'); return; }
            const batch = mutedMedia.slice(start, start + BATCH_SIZE);
            const attempts = batch.map((entry) => this.candidatesFor(entry, quality, perSegmentLower));
            const responses = await this.probe(tabId, attempts.map((list) => list.map((item) => item.url)));
            if (responses === null) {
                giveUp('the page stopped answering probes.');
                this.setStats(tabId, vodBase, quality, {
                    state: 'unavailable',
                    message: `${quality}: проверка остановлена на ${checked}/${mutedMedia.length}; перезагрузите страницу.`
                });
                return;
            }
            if (epoch !== this.epoch(tabId)) { giveUp('the tab state changed mid-check.'); return; }

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

        const initRedirects = await this.initRedirects(tabId, vodBase, quality, mutedMaps, mutedMedia.length, epoch);
        if (initRedirects === null) return;

        const restored = results.filter((item) => item.url);
        const stats = {
            ...this.emptyStats(),
            candidates: restored.length,
            unmuted: restored.filter((item) => item.quality === quality).length,
            lowerQuality: restored.filter((item) => item.quality !== quality).length,
            muted: results.length - restored.length
        };

        if (!restored.length) {
            await this.reportNothingRestored(tabId, vodBase, quality, results, stats);
            return;
        }

        rendition.checkedAt = Date.now();
        await VODRules.install(this, { tabId, vodBase, quality, signature, initRedirects, restored, epoch, stats });
        if (epoch !== this.epoch(tabId)) return;
        await this.paintSeekbar(tabId, results, quality, playlist.totalDuration);
    }

    // fMP4 playlists carry an init segment in #EXT-X-MAP: it defines the audio
    // track, so mixing a muted init with unmuted media breaks decoding and
    // Twitch reports error #2000.
    async initRedirects(tabId, vodBase, quality, mutedMaps, mutedCount, epoch) {
        if (!mutedMaps.length) return [];
        const groups = mutedMaps.map((entry) => [VODHelpers.unmuteURL(entry.url)]);
        const statuses = await this.probe(tabId, groups);
        if (statuses === null || epoch !== this.epoch(tabId)) return null;

        const redirects = [];
        mutedMaps.forEach((entry, index) => {
            const status = statuses[index]?.[0];
            if (VODHelpers.classifyValidation(status).valid) redirects.push({ source: entry.url, url: groups[index][0], quality });
            else console.warn(`[VOD Unmute] Muted init segment has no original (status=${status}); skipping redirects.`, entry.url);
        });
        if (redirects.length === mutedMaps.length) return redirects;

        this.setStats(tabId, vodBase, quality, {
            ...this.emptyStats(),
            muted: mutedCount,
            state: 'unavailable',
            message: 'Init-сегмент заглушён, а оригинала нет — подмена сломала бы воспроизведение.'
        });
        return null;
    }

    // The muted original is played by Twitch, so it must be reachable. If it is
    // not, the probing method is at fault rather than the CDN.
    async reportNothingRestored(tabId, vodBase, quality, results, stats) {
        const control = await this.probe(tabId, [[results[0].source]]);
        const controlStatus = control?.[0]?.[0];
        const codes = [...new Set(results.flatMap((item) => item.statuses))].join(', ') || 'нет';
        const forbidden = results.every((item) => item.statuses.length && item.statuses.every((status) => status === 401 || status === 403));
        console.warn(`[VOD Unmute] ${quality}: no unmuted files. statuses=${codes}, muted control=${controlStatus}.`);
        this.setStats(tabId, vodBase, quality, {
            ...stats,
            state: 'unavailable',
            message: !HIT_STATUSES.has(controlStatus)
                ? `Проверка сегментов блокируется (контроль=${controlStatus}) — результат ненадёжен.`
                : forbidden
                    ? 'CDN отвечает 403 на файлы без «-muted»: оригиналы этой записи уже удалены — звук вернуть нельзя.'
                    : 'Twitch не хранит оригиналы без «-muted» для этой записи — звук вернуть нельзя.'
        });
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

    // --- probing ------------------------------------------------------------

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
        // Only definitive answers are cached (including 403, which is how the
        // CDN says "no such object"): a throttled or failed request must be
        // retried later instead of poisoning the result.
        const verdict = VODHelpers.classifyValidation(status);
        if (!verdict.valid && !verdict.definitive) return;
        if (this.probeCache.size >= PROBE_CACHE_LIMIT) this.probeCache.clear();
        this.probeCache.set(url, { status, at: Date.now() });
    }

    // Resolves candidate groups, asking the page only about URLs whose status is
    // not already known.
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

        const fresh = await VODNet.probeInPage(tabId, pending);
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

    // --- teardown -----------------------------------------------------------

    async cleanupTab(tabId) {
        this.bump(tabId);
        const epoch = this.epoch(tabId);
        this.queue = this.queue.filter((item) => item.tabId !== tabId);
        // Stale per-tab state used to survive navigation and make the next VOD
        // skip its only rendition.
        this.activeQualities.delete(tabId);
        this.knownPlaylists.delete(tabId);
        this.paintData.delete(tabId);
        // The new page has its own timeline, so it may be scanned right away.
        this.discoveredAt.delete(tabId);
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

    // A closed tab never comes back, so its counter is dropped too.
    async forgetTab(tabId) {
        await this.cleanupTab(tabId);
        this.epochs.delete(tabId);
        this.tabPages.delete(tabId);
    }

    async clearAll() {
        for (const tabId of [...this.tabs.keys(), ...this.epochs.keys()]) this.bump(tabId);
        this.queue = [];
        this.activeQualities.clear();
        this.discoveredAt.clear();
        const painted = [...this.paintData.keys()];
        this.paintData.clear();
        await this.serialize(async () => {
            const live = await chrome.declarativeNetRequest.getSessionRules();
            if (live.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: live.map((rule) => rule.id) });
            this.tabs.clear();
        });
        for (const tabId of painted) await VODSeekbar.inject(tabId, []);
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
        await VODSeekbar.inject(tabId, segments);
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
}

if (typeof module === 'object' && module.exports) module.exports = { VODUnmute, QUALITIES };
else new VODUnmute();
