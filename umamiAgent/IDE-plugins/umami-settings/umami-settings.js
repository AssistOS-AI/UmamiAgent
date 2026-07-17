const STORAGE_KEY = 'umami-settings:v1';
const DEFAULTS = Object.freeze({
    websiteId: ''
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeUrl(value) {
    const raw = normalizeString(value).replace(/\/+$/, '');
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
        return '';
    }
}

function isValidWebsiteId(value) {
    return UUID_PATTERN.test(normalizeString(value));
}

function escapeAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function extractToolText(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (Array.isArray(result?.content)) {
        return result.content
            .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
            .map((entry) => entry.text)
            .join('\n')
            .trim();
    }
    if (typeof result?.text === 'string') {
        return result.text;
    }
    try {
        return JSON.stringify(result);
    } catch {
        return '';
    }
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function decodeToolPayload(result) {
    const text = extractToolText(result);
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
        if (parsed.ok === false) {
            throw new Error(normalizeString(parsed.error, 'Umami tool failed.'));
        }
        return parsed;
    }

    const normalized = normalizeString(text);
    if (/^(MCP error|Error:|umami-mcp exited|Failed to start umami-mcp)/i.test(normalized)) {
        throw new Error(normalized);
    }

    if (!normalized) {
        throw new Error('Umami tool returned an empty response.');
    }

    throw new Error(`Umami tool returned a non-JSON response: ${normalized}`);
}

function readStoredSettings() {
    try {
        const parsed = tryParseJson(window.localStorage?.getItem(STORAGE_KEY));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeStoredWebsiteId(value) {
    const websiteId = normalizeString(value);
    return isValidWebsiteId(websiteId) ? websiteId : '';
}

function writeStoredSettings(state) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
            websiteId: normalizeStoredWebsiteId(state.websiteId)
        }));
    } catch {
        // Local storage is optional for this modal.
    }
}

function formatWebsiteLabel(website) {
    if (!website) {
        return '';
    }
    return website.domain ? `${website.name} (${website.domain})` : website.name;
}

function normalizeWebsiteList(payload) {
    const rawItems = Array.isArray(payload?.websites)
        ? payload.websites
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.result?.websites)
                ? payload.result.websites
                : Array.isArray(payload?.result?.data)
                    ? payload.result.data
            : Array.isArray(payload)
                ? payload
                : [];

    return rawItems
        .map((item) => {
            if (typeof item === 'string') {
                return { id: item, name: item, domain: '' };
            }
            if (!item || typeof item !== 'object') {
                return null;
            }
            const id = normalizeString(item.website_id || item.websiteId || item.id || item.uuid);
            if (!id) {
                return null;
            }
            return {
                id,
                name: normalizeString(item.name || item.domain || id, id),
                domain: normalizeString(item.domain || item.url || '')
            };
        })
        .filter(Boolean);
}

function formatErrorMessage(error, fallback) {
    const message = normalizeString(error?.message || String(error || ''), fallback);
    return message.length > 260 ? `${message.slice(0, 257)}...` : message;
}

function buildScriptCode({ telemetryUrl, websiteId }) {
    const src = `${normalizeUrl(telemetryUrl)}/script.js`;
    const lines = [
        '<script',
        '  defer',
        `  src="${escapeAttribute(src)}"`,
        `  data-website-id="${escapeAttribute(websiteId)}"`
    ];
    lines.push('></script>');
    return lines.join('\n');
}

function buildDashboardUrl(activeBrowserUrl) {
    const normalized = normalizeUrl(activeBrowserUrl);
    if (!normalized) {
        throw new Error('Umami dashboard topology is not active.');
    }
    return normalized;
}

async function resolveTopologyLocator(slug, fetchImpl = window.fetch.bind(window)) {
    const params = new URLSearchParams({ routeKey: 'umamiAgent', slug });
    const response = await fetchImpl(`/api/edge/topology?${params}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
    });
    if (!response.ok) {
        throw new Error(`Umami ${slug} topology is unavailable (${response.status}).`);
    }
    const payload = await response.json();
    const activeBrowserUrl = normalizeUrl(payload?.browserUrl);
    if (!activeBrowserUrl) {
        throw new Error(`Umami ${slug} topology response has no active browser URL.`);
    }
    return activeBrowserUrl;
}

export class UmamiSettingsSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = element?.props || element?._componentProxy?.props || {};
        const stored = readStoredSettings();
        this.state = {
            dashboardUrl: '',
            telemetryUrl: '',
            websiteId: normalizeStoredWebsiteId(stored.websiteId),
            websites: [],
            status: '',
            statusType: ''
        };
        this.mcpClient = null;
        this.mcpClientPromise = null;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.syncInputsFromState();
        this.renderDerived();
        if (!this.hasAttemptedTopologyLoad) {
            this.hasAttemptedTopologyLoad = true;
            void this.loadTopology();
        }
        if (!this.hasAttemptedInitialWebsiteLoad) {
            this.hasAttemptedInitialWebsiteLoad = true;
            void this.loadWebsites({ quiet: true });
        }
    }

    cacheElements() {
        this.umamiUrlInput = this.element.querySelector('#umamiUrl');
        this.websiteSelect = this.element.querySelector('#umamiWebsiteSelect');
        this.copyButton = this.element.querySelector('#umamiCopyButton');
        this.snippetArea = this.element.querySelector('#umamiScriptSnippet');
        this.statusElement = this.element.querySelector('#umamiSettingsStatus');
    }

    bindEvents() {
        if (this.element.dataset.umamiSettingsBound === 'true') {
            return;
        }
        this.element.dataset.umamiSettingsBound = 'true';

        this.websiteSelect?.addEventListener('change', (event) => {
            this.state.websiteId = String(event.target?.value || '').trim();
            this.clearStatus();
            this.syncInputsFromState();
            this.persistAndRender();
        });

    }

    syncInputsFromState() {
        if (this.umamiUrlInput) {
            this.umamiUrlInput.value = this.state.telemetryUrl;
        }
        this.syncWebsiteSelect();
    }

    async ensureMcpClient() {
        if (this.mcpClient) {
            return this.mcpClient;
        }
        if (this.mcpClientPromise) {
            return this.mcpClientPromise;
        }

        this.mcpClientPromise = (async () => {
            const module = await import('/MCPBrowserClient.js');
            if (!module || typeof module.createAgentClient !== 'function') {
                throw new Error('MCP browser client module is unavailable.');
            }
            this.mcpClient = module.createAgentClient('/umamiAgent/mcp');
            return this.mcpClient;
        })();

        try {
            return await this.mcpClientPromise;
        } finally {
            this.mcpClientPromise = null;
        }
    }

    persistAndRender() {
        writeStoredSettings(this.state);
        this.renderDerived();
    }

    renderDerived() {
        const validWebsiteId = isValidWebsiteId(this.state.websiteId) && Boolean(this.state.telemetryUrl);
        if (this.copyButton) {
            this.copyButton.disabled = !validWebsiteId;
        }

        if (this.snippetArea) {
            this.snippetArea.value = validWebsiteId ? buildScriptCode(this.state) : '';
        }

        this.renderWebsiteList();
        this.renderStatus();
    }

    syncWebsiteSelect() {
        if (!this.websiteSelect) {
            return;
        }

        this.websiteSelect.innerHTML = '';

        const websites = Array.isArray(this.state.websites) ? this.state.websites : [];
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = websites.length ? 'Select a website' : 'Load websites from Umami';
        this.websiteSelect.appendChild(emptyOption);

        websites.forEach((website) => {
            const option = document.createElement('option');
            option.value = website.id;
            option.textContent = formatWebsiteLabel(website);
            this.websiteSelect.appendChild(option);
        });

        this.websiteSelect.value = websites.some((website) => website.id === this.state.websiteId)
            ? this.state.websiteId
            : '';
    }

    renderWebsiteList() {
        this.syncWebsiteSelect();
    }

    renderStatus() {
        if (!this.statusElement) {
            return;
        }
        this.statusElement.textContent = this.state.status || '';
        this.statusElement.classList.toggle('error', this.state.statusType === 'error');
    }

    clearStatus() {
        this.state.status = '';
        this.state.statusType = '';
    }

    openDashboard() {
        try {
            const dashboardUrl = buildDashboardUrl(this.state.dashboardUrl);
            window.open(dashboardUrl, '_blank', 'noopener');
            this.state.status = 'Dashboard opened in a new tab.';
            this.state.statusType = '';
        } catch (error) {
            this.state.status = formatErrorMessage(error, 'Umami dashboard is unavailable.');
            this.state.statusType = 'error';
        }
        this.renderStatus();
    }

    async loadTopology() {
        try {
            const [dashboardUrl, telemetryUrl] = await Promise.all([
                resolveTopologyLocator('umami-dashboard'),
                resolveTopologyLocator('umami-telemetry')
            ]);
            this.state.dashboardUrl = dashboardUrl;
            this.state.telemetryUrl = telemetryUrl;
            this.syncInputsFromState();
            this.renderDerived();
        } catch (error) {
            this.state.dashboardUrl = '';
            this.state.telemetryUrl = '';
            this.state.status = formatErrorMessage(error, 'Umami publication topology is unavailable.');
            this.state.statusType = 'error';
            console.error('[umami-settings] Failed to resolve current topology', error);
            this.renderDerived();
        }
    }

    async loadWebsites(options = {}) {
        if (!options.quiet) {
            this.state.status = 'Loading websites...';
            this.state.statusType = '';
            this.renderStatus();
        }

        try {
            const client = await this.ensureMcpClient();
            const toolResult = await client.callTool('umami_websites_list', {});
            const payload = decodeToolPayload(toolResult);
            const websites = normalizeWebsiteList(payload);
            this.state.websites = websites;
            if (!this.state.websiteId && websites.length === 1) {
                this.state.websiteId = websites[0].id;
                this.syncInputsFromState();
            }
            this.state.status = websites.length
                ? `Loaded ${websites.length} website${websites.length === 1 ? '' : 's'}.`
                : 'No websites returned.';
            this.state.statusType = '';
            writeStoredSettings(this.state);
            this.renderDerived();
        } catch (error) {
            this.state.websites = [];
            this.state.status = formatErrorMessage(error, 'Failed to load websites.');
            this.state.statusType = 'error';
            console.error('[umami-settings] Failed to load websites through MCP', error);
            this.renderDerived();
        }
    }

    async copyScriptCode() {
        try {
            if (!normalizeString(this.state.websiteId)) {
                this.state.status = 'Website UUID is required.';
                this.state.statusType = 'error';
                this.renderStatus();
                return;
            }
            if (!isValidWebsiteId(this.state.websiteId)) {
                this.state.status = 'Website UUID must be the Umami website_id, not the site URL.';
                this.state.statusType = 'error';
                this.renderStatus();
                return;
            }
            if (!this.state.telemetryUrl) {
                this.state.status = 'Umami telemetry topology is not active.';
                this.state.statusType = 'error';
                this.renderStatus();
                return;
            }
            const snippet = buildScriptCode(this.state);
            if (this.snippetArea) {
                this.snippetArea.value = snippet;
            }
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(snippet);
            } else {
                this.snippetArea?.focus();
                this.snippetArea?.select();
                document.execCommand('copy');
            }
            this.state.status = 'Script code copied to clipboard.';
            this.state.statusType = '';
            this.renderStatus();
        } catch {
            this.state.status = 'Failed to copy. Select snippet and copy manually.';
            this.state.statusType = 'error';
            this.renderStatus();
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }
}

export {
    buildDashboardUrl,
    resolveTopologyLocator
};

export class UmamiSettings {
    constructor(...args) {
        return new UmamiSettingsSettings(...args);
    }
}
