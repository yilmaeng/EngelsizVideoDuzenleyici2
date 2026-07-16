class I18nFrontend {
    constructor() {
        this.cache = {};
        this.currentLang = 'tr';
    }

    async init() {
        if (!window.api || !window.api.i18n) return;
        this.currentLang = await window.api.i18n.getLanguage();
        this.cache = await window.api.i18n.getAll();
        document.documentElement.lang = this.currentLang;

        window.api.i18n.onLanguageChanged(async (lang) => {
            if (this.currentLang !== lang) {
                this.currentLang = lang;
                this.cache = await window.api.i18n.getAll();
                document.documentElement.lang = this.currentLang;
                this.translateDOM();
            }
        });

        this.translateDOM();
    }

    t(key, params = {}) {
        const pathKeys = key.split('.');
        let val = this.getValueFromObj(this.cache, pathKeys);
        if (val === null) return `[${key}]`;

        let result = val;
        for (const [k, v] of Object.entries(params)) {
            result = result.replace(new RegExp(`{${k}}`, 'g'), v);
        }
        return result;
    }

    getValueFromObj(obj, pathKeys) {
        if (!obj) return null;
        let current = obj;
        for (const key of pathKeys) {
            if (current[key] === undefined) return null;
            current = current[key];
        }
        return current;
    }

    translateDOM(root = document) {
        const scope = root && root.querySelectorAll ? root : document;
        const includeRoot = root && root !== document && root.getAttribute;

        const elements = [];
        if (includeRoot && root.hasAttribute('data-i18n')) {
            elements.push(root);
        }
        elements.push(...scope.querySelectorAll('[data-i18n]'));
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) {
                const translation = this.t(key);
                if (translation && !translation.startsWith('[')) {
                    el.textContent = translation;
                }
            }
        });
        const titleEl = document.querySelector('title[data-i18n]');
        if (titleEl) {
            const translation = this.t(titleEl.getAttribute('data-i18n'));
            if (translation && !translation.startsWith('[')) {
                document.title = translation;
            }
        }

        const titleElements = [];
        if (includeRoot && root.hasAttribute('data-i18n-title')) {
            titleElements.push(root);
        }
        titleElements.push(...scope.querySelectorAll('[data-i18n-title]'));
        titleElements.forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) {
                const translation = this.t(key);
                if (translation && !translation.startsWith('[')) {
                    el.title = translation;
                }
            }
        });
        const htmlElements = [];
        if (includeRoot && root.hasAttribute('data-i18n-html')) {
            htmlElements.push(root);
        }
        htmlElements.push(...scope.querySelectorAll('[data-i18n-html]'));
        htmlElements.forEach(el => {
            const key = el.getAttribute('data-i18n-html');
            if (key) {
                const translation = this.t(key);
                if (translation && !translation.startsWith('[')) {
                    el.innerHTML = translation;
                }
            }
        });

        const placeholderElements = [];
        if (includeRoot && root.hasAttribute('data-i18n-placeholder')) {
            placeholderElements.push(root);
        }
        placeholderElements.push(...scope.querySelectorAll('[data-i18n-placeholder]'));
        placeholderElements.forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) {
                const translation = this.t(key);
                if (translation && !translation.startsWith('[')) {
                    el.setAttribute('placeholder', translation);
                }
            }
        });

        const ariaElements = [];
        if (includeRoot && root.hasAttribute('data-i18n-aria')) {
            ariaElements.push(root);
        }
        ariaElements.push(...scope.querySelectorAll('[data-i18n-aria]'));
        ariaElements.forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            if (key) {
                const translation = this.t(key);
                if (translation && !translation.startsWith('[')) {
                    el.setAttribute('aria-label', translation);
                }
            }
        });
    }

    announce(key, params = {}) {
        const msg = this.t(key, params);
        if (window.utils && window.utils.announceToScreenReader) {
            window.utils.announceToScreenReader(msg);
        } else {
            console.log("Announce:", msg);
        }
    }
}

window.i18nHelper = new I18nFrontend();
document.addEventListener('DOMContentLoaded', () => {
    window.i18nHelper.init();
});
