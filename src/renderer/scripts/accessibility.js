/**
 * Erişilebilirlik Modülü
 * Ekran okuyucular için duyuru ve bildirim yönetimi
 */

const Accessibility = {
    announcer: null,
    alerter: null,

    /**
     * Modülü başlat
     */
    init() {
        this.announcer = document.getElementById('screen-reader-announcer');
        this.alerter = document.getElementById('screen-reader-alert');
    },

    /**
     * Hedef element bul (Modal durumuna göre)
     * @param {string} type - 'polite' veya 'assertive'
     */
    _getTarget(type) {
        const openDialog = document.querySelector('dialog[open]');

        // Eğer açık bir modal diyalog varsa, mesajı onun içine gömmeliyiz
        // Çünkü showModal() diğer tüm elementleri (global announcer dahil) "inert" yapar.
        if (openDialog) {
            let localId = `local-sr-${type}-${openDialog.id}`;
            let localEl = openDialog.querySelector(`#${localId}`);

            if (!localEl) {
                localEl = document.createElement('div');
                localEl.id = localId;
                localEl.className = 'sr-only';
                localEl.setAttribute('aria-live', type);
                // Assertive ise atomic true olsun
                if (type === 'assertive') localEl.setAttribute('aria-atomic', 'true');
                openDialog.appendChild(localEl);
            }
            return localEl;
        }

        // Dialog yoksa global olanı kullan
        return type === 'assertive' ? this.alerter : this.announcer;
    },

    /**
     * Normal duyuru (polite) - sıradaki duyuruları bekler
     * @param {string} message - Duyurulacak mesaj
     */
    announce(message) {
        const target = this._getTarget('polite');
        if (!target) return;

        // Önceki mesajı temizle
        target.textContent = '';

        // Küçük bir gecikme ile yeni mesajı ekle
        setTimeout(() => {
            target.textContent = message;

            // 5 saniye sonra temizle (görsel kirliliği önlemek için)
            if (this.announceTimeout) clearTimeout(this.announceTimeout);
            this.announceTimeout = setTimeout(() => {
                target.textContent = '';
            }, 5000);
        }, 50);

        console.log('[Erişilebilirlik] Duyuru:', message);
    },

    /**
     * Acil duyuru (assertive) - diğer duyuruları keser
     * @param {string} message - Duyurulacak mesaj
     */
    alert(message) {
        const target = this._getTarget('assertive');
        if (!target) return;

        target.textContent = '';

        setTimeout(() => {
            target.textContent = message;

            // 8 saniye sonra temizle
            if (this.alertTimeout) clearTimeout(this.alertTimeout);
            this.alertTimeout = setTimeout(() => {
                target.textContent = '';
            }, 8000);
        }, 50);

        console.log('[Erişilebilirlik] Uyarı:', message);
    },

    /**
     * Tüm bekleyen duyuruları temizle
     * Bu, yeni önemli bir mesaj gelmeden önce çağrılmalı
     */
    clearPending() {
        // Global temizle
        if (this.announcer) this.announcer.textContent = '';
        if (this.alerter) this.alerter.textContent = '';

        // Açık dialog varsa içindekileri de temizle
        const openDialog = document.querySelector('dialog[open]');
        if (openDialog) {
            const locals = openDialog.querySelectorAll('[id^="local-sr-"]');
            locals.forEach(el => el.textContent = '');
        }
        console.log('[Erişilebilirlik] Bekleyen duyurular temizlendi');
    },

    /**
     * Kesintili duyuru - önceki mesajları temizleyip yenisini okur
     * Önemli durum değişikliklerinde kullanılmalı (video açıldı, işlem tamamlandı vb.)
     * @param {string} message - Duyurulacak mesaj
     */
    announceImmediate(message) {
        // Önce tüm bekleyen mesajları temizle
        this.clearPending();

        // Biraz bekle ve yeni mesajı assertive olarak duyur
        setTimeout(() => {
            if (this.alerter) {
                this.alerter.textContent = message;
            }
        }, 100);

        console.log('[Erişilebilirlik] Acil duyuru:', message);
    },

    /**
     * Zaman bilgisini duyur
     * @param {number} currentTime - Geçerli zaman (saniye)
     * @param {number} duration - Toplam süre (saniye)
     */
    announceTime(currentTime, duration) {
        const current = this.formatTimeForSpeech(currentTime);
        const total = this.formatTimeForSpeech(duration);
        this.announce(`Konum: ${current}, Toplam: ${total}`);
    },

    /**
     * Oynatma durumunu duyur
     * @param {boolean} isPlaying - Oynatılıyor mu?
     */
    announcePlayState(isPlaying) {
        this.announce(isPlaying ? 'Oynatılıyor' : 'Duraklatıldı');
    },

    /**
     * Seçim bilgisini duyur
     * @param {number|null} start - Seçim başlangıcı (saniye)
     * @param {number|null} end - Seçim bitişi (saniye)
     */
    announceSelection(start, end) {
        if (start === null || end === null) {
            this.announce('Seçim temizlendi');
            return;
        }

        const startStr = this.formatTimeForSpeech(start);
        const endStr = this.formatTimeForSpeech(end);
        const duration = this.formatTimeForSpeech(end - start);

        this.announce(`Seçim: ${startStr} ile ${endStr} arası, ${duration} uzunluğunda`);
    },

    /**
     * İşaretçi bilgisini duyur
     * @param {string} action - 'added' veya 'removed'
     * @param {number} time - İşaretçi zamanı
     * @param {number} totalMarkers - Toplam işaretçi sayısı
     */
    announceMarker(action, time, totalMarkers) {
        const timeStr = this.formatTimeForSpeech(time);

        if (action === 'added') {
            this.announce(`İşaretçi eklendi: ${timeStr}. Toplam ${totalMarkers} işaretçi.`);
        } else if (action === 'removed') {
            this.announce(`İşaretçi silindi: ${timeStr}. Toplam ${totalMarkers} işaretçi.`);
        }
    },

    /**
     * Dosya bilgisini duyur
     * @param {string} filename - Dosya adı
     * @param {number} duration - Süre (saniye)
     */
    announceFileLoaded(filename, duration) {
        const durationStr = this.formatTimeForSpeech(duration);
        this.announce(`Dosya yüklendi: ${filename}. Süre: ${durationStr}`);
    },

    /**
     * Hata duyur
     * @param {string} message - Hata mesajı
     */
    announceError(message) {
        this.alert(`Hata: ${message}`);
    },

    /**
     * İşlem durumunu duyur
     * @param {string} operation - İşlem adı
     * @param {number} percent - Yüzde (0-100)
     */
    announceProgress(operation, percent) {
        // Her %25'te bir duyur
        if (percent % 25 === 0) {
            this.announce(`${operation}: Yüzde ${Math.round(percent)} tamamlandı`);
        }
    },

    /**
     * İşlem tamamlandı duyurusu
     * @param {string} operation - Tamamlanan işlem
     */
    announceComplete(operation) {
        this.announce(`${operation} tamamlandı`);
    },

    /**
     * Navigasyon duyurusu
     * @param {string} destination - Hedef (örn: "başlangıç", "son", "orta")
     * @param {number} time - Zaman (saniye)
     */
    announceNavigation(destination, time) {
        const timeStr = this.formatTimeForSpeech(time);
        this.announce(`${destination}: ${timeStr}`);
    },

    /**
     * Zamanı konuşma için formatla
     * @param {number} seconds - Saniye
     * @returns {string} Okunabilir format
     */
    formatTimeForSpeech(seconds) {
        if (isNaN(seconds) || seconds < 0) return '0 saniye';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts = [];

        if (hours > 0) {
            parts.push(`${hours} saat`);
        }
        if (minutes > 0) {
            parts.push(`${minutes} dakika`);
        }
        if (secs > 0 || parts.length === 0) {
            parts.push(`${secs} saniye`);
        }

        return parts.join(' ');
    }
};

// Global olarak erişilebilir yap
window.Accessibility = Accessibility;
