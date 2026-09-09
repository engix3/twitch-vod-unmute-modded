// Networking that has to happen inside the Twitch page: the CDN answers 403 to
// the same requests made from the extension origin.
(function (root, factory) {
    const net = factory();
    if (typeof module === 'object' && module.exports) module.exports = net;
    root.VODNet = net;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    async function fetchInPage(tabId, url) {
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

    // Each group is a candidate list for one muted segment: the first reachable
    // candidate wins, the rest are not requested at all.
    async function probeInPage(tabId, urlGroups) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                args: [urlGroups],
                func: async (groups) => {
                    // A two-byte range request tells us whether the file exists
                    // without ever downloading the segment.
                    const hit = (status) => status === 200 || status === 206;
                    // 404/410 mean the file is gone, 401/403 mean the CDN will
                    // not serve it at all: both are final answers. Only
                    // throttling and server errors deserve a retry.
                    const definitive = (status) => hit(status) ||
                        status === 401 || status === 403 || status === 404 || status === 410;
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

    return { fetchInPage, probeInPage };
});
