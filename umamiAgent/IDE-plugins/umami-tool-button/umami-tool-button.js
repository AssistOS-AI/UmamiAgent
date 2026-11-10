const UMAMI_AGENT_ROUTE = 'umamiAgent';
const UMAMI_SETTINGS_COMPONENT = 'umami-settings';
const UMAMI_DASHBOARD_PATH = '/base-agent-additional-server/umamiAgent/3000/websites';
// The Explorer loader that the Settings modal itself uses to register agent settings components.
const SETTINGS_LOADER_PATH = '/explorer/web-components/modals/settings-modal/settings-component-loader.js';

export class UmamiToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector('#umamiToolButton');
        this.iconImageEl = this.element.querySelector('.umami-tool-button-icon-image');
        this.labelEl = this.element.querySelector('.umami-tool-button-label');
        this.syncButtonMetadata();
        this.button?.addEventListener('click', this.openUmami);
    }

    afterUnload() {
        this.button?.removeEventListener('click', this.openUmami);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === 'string' && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute('data-plugin-label') || 'Umami';
        const tooltip = typeof this.hostContext?.pluginTooltip === 'string' && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute('data-plugin-tooltip') || label;
        const icon = typeof this.hostContext?.pluginIcon === 'string' && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute('data-plugin-icon') || '';
        if (this.labelEl) {
            this.labelEl.textContent = label;
        }
        if (this.iconImageEl && icon) {
            this.iconImageEl.src = icon;
        }
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute('aria-label', tooltip);
        }
    }

    openUmami = async (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        try {
            const { ensureSettingsComponentRegistered } = await import(SETTINGS_LOADER_PATH);
            await ensureSettingsComponentRegistered({
                agent: UMAMI_AGENT_ROUTE,
                component: UMAMI_SETTINGS_COMPONENT,
                settingsComponent: UMAMI_SETTINGS_COMPONENT
            });
            const openExpandedModal = globalThis.assistOS?.UI?.openExpandedModal;
            if (typeof openExpandedModal === 'function') {
                // Same fullscreen panel the other toolbar plugins open.
                await openExpandedModal({
                    mode: 'component',
                    component: UMAMI_SETTINGS_COMPONENT,
                    title: this.hostContext?.pluginLabel || 'Umami',
                    fullscreen: true
                });
                return;
            }
            await globalThis.assistOS.UI.createReactiveModal(UMAMI_SETTINGS_COMPONENT, {}, true);
        } catch (error) {
            console.error('[umami-tool-button] Failed to open Umami settings:', error);
            window.open(UMAMI_DASHBOARD_PATH, '_blank', 'noopener,noreferrer');
        }
    };
}
