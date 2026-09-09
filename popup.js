class PopupController {
    constructor() {
        this.settings = {};
        this.statsTimer = null;
        this.init();
    }

    async init() {
        await this.loadSettings();
        this.setupEventListeners();
        this.updateUI();
        await this.loadStats();
        this.statsTimer = window.setInterval(() => this.loadStats(), 1000);
        window.addEventListener('unload', () => {
            if (this.statsTimer) window.clearInterval(this.statsTimer);
        }, { once: true });
    }

    async loadSettings() {
        const defaults = {
            enabled: true,
            seekbar: true,
            unmutedColour: '#00FF00',
            qualityColour: '#FFFF00',
            opacity: 0.5,
            quality: true
        };

        const items = await chrome.storage.sync.get(Object.keys(defaults));
        this.settings = { ...defaults, ...items };
        this.settings.enabled = typeof this.settings.enabled === 'boolean' ? this.settings.enabled : defaults.enabled;
        this.settings.seekbar = typeof this.settings.seekbar === 'boolean' ? this.settings.seekbar : defaults.seekbar;
        this.settings.quality = typeof this.settings.quality === 'boolean' ? this.settings.quality : defaults.quality;
        this.settings.unmutedColour = /^#[0-9a-f]{6}$/i.test(this.settings.unmutedColour)
            ? this.settings.unmutedColour : defaults.unmutedColour;
        this.settings.qualityColour = /^#[0-9a-f]{6}$/i.test(this.settings.qualityColour)
            ? this.settings.qualityColour : defaults.qualityColour;
        this.settings.opacity = Number.isFinite(this.settings.opacity)
            ? Math.min(1, Math.max(0, this.settings.opacity)) : defaults.opacity;

        const normalizedSettings = {};
        for (const [key, value] of Object.entries(this.settings)) {
            if (items[key] !== value) normalizedSettings[key] = value;
        }
        if (Object.keys(normalizedSettings).length > 0) {
            await chrome.storage.sync.set(normalizedSettings);
        }
    }

    setupEventListeners() {
        this.bindToggle('extensionToggle', 'enabled');
        this.bindToggle('seekbarToggle', 'seekbar', () => this.updateSeekbarSettingsState());
        this.bindToggle('qualityToggle', 'quality');

        ['unmutedColour', 'qualityColour'].forEach((id) => {
            document.getElementById(id).addEventListener('change', (event) => {
                this.saveSetting(id, event.target.value);
            });
        });

        const opacitySlider = document.getElementById('opacity');
        opacitySlider.addEventListener('input', (event) => {
            const value = parseFloat(event.target.value);
            document.getElementById('opacityValue').textContent = Math.round(value * 100) + '%';
        });
        opacitySlider.addEventListener('change', (event) => {
            this.saveSetting('opacity', parseFloat(event.target.value));
        });

        document.getElementById('exportBtn').addEventListener('click', () => this.exportSettings());
        document.getElementById('refreshBtn').addEventListener('click', () => this.refreshCurrentTab());
    }

    bindToggle(elementId, settingKey, callback) {
        const element = document.getElementById(elementId);
        element.addEventListener('click', async () => {
            this.settings[settingKey] = !this.settings[settingKey];
            await this.saveSetting(settingKey, this.settings[settingKey]);
            this.updateToggleUI(elementId, this.settings[settingKey]);
            if (callback) callback();
        });
    }

    updateUI() {
        this.updateToggleUI('extensionToggle', this.settings.enabled);
        this.updateToggleUI('seekbarToggle', this.settings.seekbar);
        this.updateToggleUI('qualityToggle', this.settings.quality);

        document.getElementById('unmutedColour').value = this.settings.unmutedColour;
        document.getElementById('qualityColour').value = this.settings.qualityColour;
        document.getElementById('opacity').value = this.settings.opacity;
        document.getElementById('opacityValue').textContent = Math.round(this.settings.opacity * 100) + '%';
        this.updateSeekbarSettingsState();
    }

    updateSeekbarSettingsState() {
        const colorSettings = document.getElementById('colorSettings');
        colorSettings.setAttribute('aria-disabled', String(!this.settings.seekbar));
        document.getElementById('unmutedColour').disabled = !this.settings.seekbar;
        document.getElementById('qualityColour').disabled = !this.settings.seekbar;
        document.getElementById('opacity').disabled = !this.settings.seekbar;
    }

    updateToggleUI(elementId, isActive) {
        const toggle = document.getElementById(elementId + 'Switch') ||
            document.getElementById(elementId).querySelector('.toggle');
        if (toggle) toggle.classList.toggle('active', isActive);
        document.getElementById(elementId).setAttribute('aria-checked', String(Boolean(isActive)));
    }

    async saveSetting(key, value) {
        await chrome.storage.sync.set({ [key]: value });
        this.settings[key] = value;
    }

    updateStatsUI(response) {
        const state = response.state || 'waiting';
        const message = response.message || 'Waiting for a Twitch VOD playlist…';
        const status = document.getElementById('vodStatus');
        const statsGrid = document.getElementById('statsGrid');
        const isPending = ['waiting', 'queued', 'loading', 'processing', 'candidate'].includes(state);

        status.className = `vod-status ${state}`;
        status.textContent = message;
        statsGrid.hidden = isPending;

        if (!isPending) {
            document.getElementById('statUnmuted').textContent = response.unmuted || 0;
            document.getElementById('statLower').textContent = response.lowerQuality || 0;
            document.getElementById('statMuted').textContent = response.muted || 0;
        }
    }

    async loadStats() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getStats' });
            if (response) this.updateStatsUI(response);
        } catch {
            this.updateStatsUI({
                state: 'waiting',
                message: 'Connecting to the extension…'
            });
        }
    }

    exportSettings() {
        const data = {
            ...this.settings,
            exportDate: new Date().toISOString(),
            version: chrome.runtime.getManifest().version
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'twitch-vod-unmute-settings.json';
        link.click();
        URL.revokeObjectURL(url);
    }

    async refreshCurrentTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && VODHelpers.isTwitchVodURL(tab.url)) {
            chrome.tabs.reload(tab.id);
            window.close();
        } else {
            const status = document.getElementById('vodStatus');
            status.className = 'vod-status unavailable';
            status.textContent = 'Please navigate to a Twitch VOD page first';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});
