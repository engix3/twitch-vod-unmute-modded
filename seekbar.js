// Paints the restored ranges over the player seekbar and keeps them alive when
// Twitch re-renders the player.
(function (root, factory) {
    const seekbar = factory();
    if (typeof module === 'object' && module.exports) module.exports = seekbar;
    root.VODSeekbar = seekbar;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    async function inject(tabId, segments) {
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

                        // Fullscreen, theatre mode and in-app navigation rebuild the
                        // seekbar and throw the overlay away, so it is watched and
                        // repainted instead of painted once.
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
                            // Twitch mutates the DOM constantly, so the fallback
                            // check runs at most twice per second.
                            const now = Date.now();
                            if (now - lastSweep < 500) return;
                            lastSweep = now;
                            const bar = document.querySelector('div.seekbar-bar');
                            if (bar && (state.ranges || []).length && !bar.querySelector('[data-vod-unmute]')) schedule();
                        });
                        state.observer.observe(document.documentElement, { childList: true, subtree: true });
                    }
                    state.paint();
                }
            });
        } catch (error) {
            console.debug('[VOD Unmute] Seekbar paint failed:', error.message);
        }
    }

    return { inject };
});
