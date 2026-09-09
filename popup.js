const DEFAULTS = {
    enabled: true,
    seekbar: true,
    quality: true,
    unmutedColour: '#00FF00',
    qualityColour: '#FFFF00',
    opacity: 0.5
};

const STATE_LABELS = {
    waiting: 'Ожидание',
    queued: 'В очереди',
    loading: 'Загрузка',
    processing: 'Проверка',
    candidate: 'Подбор',
    ready: 'Готово',
    unavailable: 'Недоступно'
};

const $ = (id) => document.getElementById(id);
let statsTimer = null;
let closed = false;

const schedule = (delay) => {
    if (closed) return;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(refreshStats, delay);
};

async function refreshStats() {
    if (closed) return;
    let stats;
    try {
        stats = await chrome.runtime.sendMessage({ action: 'getStats' });
    } catch {
        stats = null;
    }
    if (closed) return;

    if (!stats) {
        $('vodStatus').textContent = 'Служебный процесс не отвечает — перезагрузите страницу.';
        $('vodStatus').dataset.state = 'unavailable';
        schedule(5000);
        return;
    }

    const state = STATE_LABELS[stats.state] ? stats.state : 'waiting';
    $('vodStatus').dataset.state = state;
    $('vodStatus').textContent = `${STATE_LABELS[state]}: ${stats.message || ''}`.trim();
    $('statUnmuted').textContent = stats.unmuted ?? 0;
    $('statLower').textContent = stats.lowerQuality ?? 0;
    $('statMuted').textContent = stats.muted ?? 0;
    $('statQuality').textContent = stats.quality ? `Качество: ${stats.quality}` : 'Качество: не определено';
    $('statsGrid').hidden = false;

    // Poll fast only while work is in progress; a finished VOD does not need a
    // message every second.
    const busy = state === 'processing' || state === 'loading' || state === 'queued' || state === 'candidate';
    schedule(busy ? 1000 : 5000);
}

async function loadSettings() {
    const values = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
    $('extensionToggle').checked = values.enabled === true;
    $('seekbarToggle').checked = values.seekbar === true;
    $('qualityToggle').checked = values.quality === true;
    $('unmutedColour').value = values.unmutedColour;
    $('qualityColour').value = values.qualityColour;
    $('opacity').value = values.opacity;
    $('opacityValue').textContent = `${Math.round(values.opacity * 100)}%`;
    $('colorSettings').hidden = values.seekbar !== true;
}

function bindToggle(id, key, after) {
    $(id).addEventListener('change', async (event) => {
        await chrome.storage.sync.set({ [key]: event.target.checked });
        after?.(event.target.checked);
    });
}

async function exportSettings() {
    const values = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
    const blob = new Blob([JSON.stringify(values, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'twitch-vod-unmute-settings.json';
    link.click();
    // Revoking straight away can cancel the download in Chrome, so the URL is
    // released on the next tick.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function reloadVod() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
    window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();

    bindToggle('extensionToggle', 'enabled');
    bindToggle('seekbarToggle', 'seekbar', (checked) => { $('colorSettings').hidden = !checked; });
    bindToggle('qualityToggle', 'quality');

    for (const [id, key] of [['unmutedColour', 'unmutedColour'], ['qualityColour', 'qualityColour']]) {
        $(id).addEventListener('change', (event) => chrome.storage.sync.set({ [key]: event.target.value }));
    }

    $('opacity').addEventListener('input', (event) => {
        $('opacityValue').textContent = `${Math.round(event.target.value * 100)}%`;
    });
    $('opacity').addEventListener('change', (event) => chrome.storage.sync.set({ opacity: Number(event.target.value) }));

    $('exportBtn').addEventListener('click', () => exportSettings());
    $('refreshBtn').addEventListener('click', () => reloadVod());

    refreshStats();
});

// `unload` is unreliable for extension popups; `pagehide` always fires.
window.addEventListener('pagehide', () => {
    closed = true;
    clearTimeout(statsTimer);
});
