export class UmamiToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (!this.element.isConnected) return;
        this.button?.removeEventListener('click', this.openUmami);
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

    openUmami = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        try {
            return globalThis.assistOS.UI.openPluginPanel('umamiAgent/umami');
        } catch (error) {
            globalThis.assistOS?.showToast?.(error.message, 'error', 6000);
        }
    };
}
