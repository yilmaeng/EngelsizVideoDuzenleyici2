/**
 * Durum Çubuğu Modülü
 * İşlem durumu ve logları gösterir
 */
const StatusBar = {
    bar: null,
    statusText: null,
    percentText: null,
    logText: null,

    init() {
        this.bar = document.getElementById('app-status-bar');
        this.statusText = document.getElementById('status-bar-text');
        this.percentText = document.getElementById('status-bar-percent');
        this.logText = document.getElementById('status-bar-log');

        console.log('StatusBar başlatıldı');
    },

    /**
     * Durumu güncelle
     * @param {string} operation - İşlem adı
     * @param {number} percent - Yüzde (opsiyonel)
     */
    update(operation, percent) {
        if (this.statusText) {
            this.statusText.textContent = operation || 'Hazır';
        }

        if (this.percentText) {
            if (percent !== undefined && percent !== null) {
                this.percentText.textContent = `%${Math.round(percent)}`;
                // Erişilebilirlik için progress rolü
                this.bar.setAttribute('aria-valuenow', Math.round(percent));
            } else {
                this.percentText.textContent = '';
                this.bar.removeAttribute('aria-valuenow');
            }
        }
    },

    /**
     * Log mesajı göster
     * @param {string} message 
     */
    log(message) {
        if (this.logText && message) {
            // Çok uzun mesajları kırp
            const displayMsg = message.length > 80 ? message.substring(0, 80) + '...' : message;
            this.logText.textContent = displayMsg;
            this.logText.title = message; // Tooltip olarak tam halini göster
        }
    },

    /**
     * Durumu temizle
     */
    clear() {
        this.update('Hazır');
        if (this.logText) this.logText.textContent = '';
    }
};
