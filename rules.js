// declarativeNetRequest bookkeeping: id allocation, session rule budget and the
// per-rendition install/remove cycle.
(function (root, factory) {
    const rules = factory();
    if (typeof module === 'object' && module.exports) module.exports = rules;
    root.VODRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MAX_RULES_PER_RENDITION = 4500;
    const RULE_RESERVE = 100;          // keep room for other tabs and extensions
    const DEFAULT_RULE_LIMIT = 5000;
    const MAX_RULE_ID = 2147480000;

    function limit() {
        const value = chrome.declarativeNetRequest?.MAX_NUMBER_OF_SESSION_RULES;
        return (Number.isInteger(value) ? value : DEFAULT_RULE_LIMIT) - RULE_RESERVE;
    }

    // After a wrap-around the counter can land on an id another tab is already
    // using, so taken ids are skipped instead of being overwritten.
    function allocate(cursor, used) {
        for (let guard = 0; guard < 1e7; guard++) {
            if (cursor.nextRuleId > MAX_RULE_ID) cursor.nextRuleId = 1;
            const id = cursor.nextRuleId++;
            if (!used.has(id)) {
                used.add(id);
                return id;
            }
        }
        throw new Error('No free declarativeNetRequest rule id');
    }

    function spec(id, item, tabId) {
        return {
            id,
            priority: 1,
            action: { type: 'redirect', redirect: { url: item.url } },
            condition: {
                // `|` anchors the filter to the start of the URL, so the rule
                // matches this exact segment and nothing else.
                urlFilter: `|${item.source.split('?')[0]}`,
                tabIds: [tabId],
                resourceTypes: ['xmlhttprequest', 'media', 'other']
            }
        };
    }

    async function install(unmute, { tabId, vodBase, quality, signature, initRedirects, restored, epoch, stats }) {
        await unmute.serialize(async () => {
            if (epoch !== unmute.epoch(tabId)) return;
            const entry = unmute.tabs.get(tabId);
            if (!entry || entry.vodBase !== vodBase) return;
            const rendition = entry.renditions.get(quality);
            if (!rendition) return;

            let live;
            try {
                live = await chrome.declarativeNetRequest.getSessionRules();
            } catch (error) {
                unmute.setStats(tabId, vodBase, quality, { ...stats, state: 'unavailable', message: `Не удалось прочитать правила: ${error.message}` });
                return;
            }

            // Only this rendition's rules are replaced: other qualities of the
            // same VOD keep working.
            const ownIds = new Set(rendition.ruleIds);
            // Session rules outlive the service worker, so a previous generation
            // of it can leave rules for this very rendition behind. They are
            // replaced instead of being duplicated.
            const prefix = `|${vodBase}/${quality}/`;
            const staleIds = new Set(live
                .filter((rule) => !ownIds.has(rule.id) &&
                    rule.condition?.tabIds?.includes(tabId) &&
                    typeof rule.condition?.urlFilter === 'string' &&
                    rule.condition.urlFilter.startsWith(prefix))
                .map((rule) => rule.id));
            const removeRuleIds = [
                ...live.filter((rule) => ownIds.has(rule.id)).map((rule) => rule.id),
                ...staleIds
            ];
            const foreign = live.filter((rule) => !ownIds.has(rule.id) && !staleIds.has(rule.id));
            const used = new Set(live.map((rule) => rule.id));
            const budget = Math.max(0, Math.min(MAX_RULES_PER_RENDITION, limit() - foreign.length));

            if (budget <= initRedirects.length) {
                unmute.setStats(tabId, vodBase, quality, {
                    ...stats,
                    state: 'unavailable',
                    message: 'Лимит правил Chrome исчерпан другими вкладками — закройте лишние записи и обновите страницу.'
                });
                return;
            }

            // The init segment must always fit: without it the redirects would
            // break playback instead of restoring audio.
            const planned = [...initRedirects, ...restored].slice(0, budget);
            const truncated = initRedirects.length + restored.length - planned.length;
            const addRules = planned.map((item) => spec(allocate(unmute, used), item, tabId));

            try {
                await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
            } catch (error) {
                console.warn('[VOD Unmute] Installing rules failed:', error);
                rendition.ruleIds = [];
                rendition.signature = null;
                rendition.checkedAt = 0;
                unmute.setStats(tabId, vodBase, quality, { ...stats, state: 'unavailable', message: `Не удалось установить правила: ${error.message}` });
                return;
            }

            if (epoch !== unmute.epoch(tabId)) {
                try {
                    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map((rule) => rule.id) });
                } catch {}
                return;
            }

            rendition.ruleIds = addRules.map((rule) => rule.id);
            rendition.signature = signature;
            rendition.checkedAt = Date.now();
            rendition.updatedAt = Date.now();
            const installed = Math.max(0, addRules.length - initRedirects.length);
            const tail = truncated ? ` Лимит правил Chrome: ${truncated} сегментов пропущено.` : '';
            rendition.stats = {
                ...stats,
                truncated,
                quality,
                state: 'ready',
                message: (stats.muted
                    ? `Подменяю ${installed} сегментов в ${quality}; ${stats.muted} недоступны.`
                    : `Подменяю все ${installed} заглушённых сегментов в ${quality}.`) + tail
            };
            console.log(`[VOD Unmute] Installed ${addRules.length} rules for ${quality}${truncated ? ` (${truncated} skipped, rule limit)` : ''}.`);
        });
    }

    return { MAX_RULES_PER_RENDITION, MAX_RULE_ID, RULE_RESERVE, allocate, install, limit, spec };
});
