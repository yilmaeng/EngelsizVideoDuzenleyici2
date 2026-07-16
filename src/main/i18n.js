const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

class I18nManager {
    constructor() {
        this.supportedLocales = ['tr', 'en', 'fr', 'de', 'es'];
        this.fallbackLocale = 'en';
        this.defaultLocale = 'tr';
        this.resources = {};
        this.currentLocale = this.defaultLocale;
        // Don't call app.getLocale() here, it causes errors before app is ready
    }

    async init() {
        // Dynamic import for ESM module
        const { default: Store } = await import('electron-store');
        this.store = new Store();

        // Load initial locale safely
        let savedLocale = this.store.get('app_language');
        if (savedLocale === 'system' || !savedLocale) {
            savedLocale = this.getSystemLocale();
        }
        this.currentLocale = this.supportedLocales.includes(savedLocale) ? savedLocale : this.defaultLocale;

        this.loadLocales();
        this.setupIpc();
    }

    getSystemLocale() {
        const osLocale = app.getLocale().split('-')[0];
        if (this.supportedLocales.includes(osLocale)) {
            return osLocale;
        }
        return this.defaultLocale;
    }

    loadLocales() {
        const localesPath = path.join(__dirname, '..', 'locales');
        if (!fs.existsSync(localesPath)) return;

        for (const loc of this.supportedLocales) {
            const locFile = path.join(localesPath, `${loc}.json`);
            if (fs.existsSync(locFile)) {
                try {
                    this.resources[loc] = JSON.parse(fs.readFileSync(locFile, 'utf8'));
                } catch (err) {
                    console.error(`Error parsing translation array ${loc}:`, err);
                }
            }
        }
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

    deepMerge(target, source) {
        if (!source || typeof source !== 'object') return target;

        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                    target[key] = {};
                }
                this.deepMerge(target[key], value);
            } else {
                target[key] = value;
            }
        }

        return target;
    }

    getMergedResources(locale = this.currentLocale) {
        const merged = {};

        if (this.resources.tr) {
            this.deepMerge(merged, this.resources.tr);
        }
        if (this.resources.en) {
            this.deepMerge(merged, this.resources.en);
        }
        if (this.resources[locale]) {
            this.deepMerge(merged, this.resources[locale]);
        }

        return merged;
    }

    t(key, params = {}) {
        const pathKeys = key.split('.');

        // Try current
        let val = this.getValueFromObj(this.resources[this.currentLocale], pathKeys);

        // Try en
        if (val === null) {
            val = this.getValueFromObj(this.resources['en'], pathKeys);
        }
        // Try tr
        if (val === null) {
            val = this.getValueFromObj(this.resources['tr'], pathKeys);
        }

        if (val === null) return `[${key}]`;

        // apply params
        let result = val;
        for (const [k, v] of Object.entries(params)) {
            result = result.replace(new RegExp(`{${k}}`, 'g'), v);
        }
        return result;
    }

    changeLanguage(lang, mainWindow) {
        if (lang === 'system') {
            this.store.set('app_language', 'system');
            this.currentLocale = this.getSystemLocale();
        } else if (this.supportedLocales.includes(lang)) {
            this.store.set('app_language', lang);
            this.currentLocale = lang;
        }

        if (mainWindow) {
            // Rebuild menu
            const createMenuFn = require('./menu').createMenu;
            const Menu = require('electron').Menu;
            Menu.setApplicationMenu(createMenuFn(mainWindow));

            // Notify renderer
            mainWindow.webContents.send('language-changed', this.currentLocale);
        }
    }

    getCurrentLanguage() {
        return this.currentLocale;
    }

    setupIpc() {
        ipcMain.handle('i18n-t', (event, key, params) => {
            return this.t(key, params);
        });
        ipcMain.handle('i18n-get-language', () => {
            return this.currentLocale;
        });
        ipcMain.handle('i18n-get-saved-language', () => {
            return this.store ? this.store.get('app_language') : null;
        });
        ipcMain.handle('i18n-change-language', (event, lang) => {
            const { BrowserWindow } = require('electron');
            const windows = BrowserWindow.getAllWindows();
            this.changeLanguage(lang, windows[0]);
        });
        ipcMain.handle('i18n-get-all', () => {
            return this.getMergedResources(this.currentLocale);
        });
    }
}

const i18n = new I18nManager();
module.exports = i18n;
