/**
 * Settings Modülü
 * Uygulama ayarlarını yönetir (localStorage ile kalıcı)
 */

const Settings = {
    // Varsayılan ayarlar
    defaults: {
        // İnce ayar - navigasyon atlama süresi (saniye cinsinden)
        navigationStepSeconds: 1,
        // Ses çalma süresi (ms) - audio scrubbing için
        audioScrubDuration: 500
    },

    /**
     * Modülü başlat - kayıtlı ayarları yükle
     */
    init() {
        // localStorage'dan ayarları yükle
        this.load();
        console.log('Settings initialized:', this.getAll());
    },

    /**
     * Tüm ayarları localStorage'dan yükle
     */
    load() {
        try {
            const saved = localStorage.getItem('korculVideoEditorSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                // Varsayılanlarla birleştir (yeni ayarlar için)
                this._settings = { ...this.defaults, ...parsed };
            } else {
                this._settings = { ...this.defaults };
            }
        } catch (e) {
            console.error('Settings load error:', e);
            this._settings = { ...this.defaults };
        }
    },

    /**
     * Tüm ayarları localStorage'a kaydet
     */
    save() {
        try {
            localStorage.setItem('korculVideoEditorSettings', JSON.stringify(this._settings));
        } catch (e) {
            console.error('Settings save error:', e);
        }
    },

    /**
     * Bir ayarı al
     * @param {string} key - Ayar anahtarı
     * @returns {any} Ayar değeri
     */
    get(key) {
        if (!this._settings) {
            this.load();
        }
        return this._settings[key] !== undefined ? this._settings[key] : this.defaults[key];
    },

    /**
     * Bir ayarı değiştir ve kaydet
     * @param {string} key - Ayar anahtarı
     * @param {any} value - Yeni değer
     */
    set(key, value) {
        if (!this._settings) {
            this.load();
        }
        this._settings[key] = value;
        this.save();
    },

    /**
     * Tüm ayarları al
     * @returns {object} Tüm ayarlar
     */
    getAll() {
        if (!this._settings) {
            this.load();
        }
        return { ...this._settings };
    },

    /**
     * Navigasyon atlama süresini al (saniye)
     * @returns {number} Atlama süresi (saniye)
     */
    getNavigationStep() {
        return this.get('navigationStepSeconds');
    },

    /**
     * Navigasyon atlama süresini ayarla (saniye)
     * @param {number} seconds - Atlama süresi (saniye)
     */
    setNavigationStep(seconds) {
        // Minimum 0.01 saniye (10ms), maksimum 10 saniye
        const clamped = Math.max(0.01, Math.min(10, seconds));
        this.set('navigationStepSeconds', clamped);
    },

    /**
     * Navigasyon adımını bir kademe azalt (daha hassas)
     * 2 -> 1 -> 0.5 -> 0.25 -> 0.1 -> 0.05 -> 0.01
     * @returns {number} Yeni değer
     */
    decreaseNavigationStep() {
        const steps = [2, 1, 0.5, 0.25, 0.1, 0.05, 0.01];
        const current = this.getNavigationStep();

        // Mevcut değerden küçük olan ilk değeri bul
        // (Floating point karşılaştırması için küçük bir tolerans)
        const next = steps.find(s => s < current - 0.0001);

        if (next !== undefined) {
            this.setNavigationStep(next);
            return next;
        }
        return current; // Zaten en küçükte
    },

    /**
     * Navigasyon adımını bir kademe artır (daha kaba)
     * 0.01 -> 0.05 -> 0.1 -> 0.25 -> 0.5 -> 1 -> 2
     * @returns {number} Yeni değer
     */
    increaseNavigationStep() {
        const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2];
        const current = this.getNavigationStep();

        // Mevcut değerden büyük olan ilk değeri bul
        const next = steps.find(s => s > current + 0.0001);

        if (next !== undefined) {
            this.setNavigationStep(next);
            return next;
        }
        return current; // Zaten en büyükte
    },

    /**
     * Gemini API anahtarını al
     * @returns {string} API anahtarı
     */
    getGeminiKey() {
        return this.get('geminiApiKey');
    },

    /**
     * Gemini API anahtarını kaydet
     * @param {string} key - API anahtarı
     */
    setGeminiKey(key) {
        this.set('geminiApiKey', key);
    },

    /**
     * Ayarları varsayılana sıfırla
     * @returns {void}
     */
    reset() {
        this._settings = { ...this.defaults };
        this.save();
    }
};

// Global olarak erişilebilir yap
window.Settings = Settings;
