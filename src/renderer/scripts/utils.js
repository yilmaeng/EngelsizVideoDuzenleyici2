/**
 * Yardımcı Fonksiyonlar Modülü
 */

const Utils = {
    /**
     * Zamanı formatla (saniye -> HH:MM:SS.mmm)
     * @param {number} seconds - Saniye
     * @returns {string} Formatlanmış zaman
     */
    formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) seconds = 0;

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);

        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    },

    /**
     * Zaman dizesini saniyeye çevir
     * @param {string} timeString - Zaman dizesi (HH:MM:SS veya SS:DD:SN veya sadece saniye)
     * @returns {number} Saniye
     */
    parseTime(timeString) {
        if (!timeString) return 0;

        // Sadece sayı ise direkt döndür
        if (!isNaN(timeString)) {
            return parseFloat(timeString);
        }

        const parts = timeString.trim().split(':');
        let seconds = 0;

        if (parts.length === 3) {
            seconds += parseFloat(parts[0]) * 3600; // saat
            seconds += parseFloat(parts[1]) * 60;   // dakika
            seconds += parseFloat(parts[2]);         // saniye
        } else if (parts.length === 2) {
            seconds += parseFloat(parts[0]) * 60;   // dakika
            seconds += parseFloat(parts[1]);         // saniye
        } else {
            seconds = parseFloat(parts[0]) || 0;    // sadece saniye
        }

        return isNaN(seconds) ? 0 : seconds;
    },

    /**
     * Zamanı sesli okunabilir formata çevir
     * @param {number} seconds - Saniye
     * @returns {string} Okunabilir zaman metni
     */
    formatTimeForSpeech(seconds) {
        if (isNaN(seconds) || seconds < 0) seconds = 0;

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);

        let parts = [];
        if (hours > 0) parts.push(`${hours} saat`);
        if (minutes > 0) parts.push(`${minutes} dakika`);
        if (secs > 0) parts.push(`${secs} saniye`);
        if (ms > 0) parts.push(`${ms} milisaniye`);

        if (parts.length === 0) return "0 saniye";
        return parts.join(' ');
    },

    /**
     * Dosya boyutunu okunabilir formata çevir
     * @param {number} bytes - Byte
     * @returns {string} Okunabilir boyut
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Byte';

        const k = 1024;
        const sizes = ['Byte', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    /**
     * Kare hızını okunabilir formata çevir
     * @param {number} fps - Kare/saniye
     * @returns {string} Okunabilir format
     */
    formatFrameRate(fps) {
        if (!fps || isNaN(fps)) return '-';
        return `${fps.toFixed(2)} fps`;
    },

    /**
     * Çözünürlüğü okunabilir formata çevir
     * @param {number} width - Genişlik
     * @param {number} height - Yükseklik
     * @returns {string} Okunabilir format
     */
    formatResolution(width, height) {
        if (!width || !height) return '-';
        return `${width} x ${height}`;
    },

    /**
     * Değeri belirli aralıkta tut
     * @param {number} value - Değer
     * @param {number} min - Minimum
     * @param {number} max - Maximum
     * @returns {number} Sınırlandırılmış değer
     */
    clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    },

    /**
     * Debounce fonksiyonu
     * @param {Function} func - Çağrılacak fonksiyon
     * @param {number} wait - Bekleme süresi (ms)
     * @returns {Function} Debounce edilmiş fonksiyon
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Throttle fonksiyonu
     * @param {Function} func - Çağrılacak fonksiyon
     * @param {number} limit - Minimum aralık (ms)
     * @returns {Function} Throttle edilmiş fonksiyon
     */
    throttle(func, limit) {
        let inThrottle;
        return function executedFunction(...args) {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },

    /**
     * Element oluştur
     * @param {string} tag - HTML etiketi
     * @param {Object} attrs - Özellikler
     * @param {string|Element|Array} children - Alt elemanlar
     * @returns {Element} Oluşturulan element
     */
    createElement(tag, attrs = {}, children = null) {
        const el = document.createElement(tag);

        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'className') {
                el.className = value;
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(el.style, value);
            } else if (key.startsWith('on') && typeof value === 'function') {
                el.addEventListener(key.slice(2).toLowerCase(), value);
            } else {
                el.setAttribute(key, value);
            }
        }

        if (children) {
            if (typeof children === 'string') {
                el.textContent = children;
            } else if (children instanceof Element) {
                el.appendChild(children);
            } else if (Array.isArray(children)) {
                children.forEach(child => {
                    if (typeof child === 'string') {
                        el.appendChild(document.createTextNode(child));
                    } else if (child instanceof Element) {
                        el.appendChild(child);
                    }
                });
            }
        }

        return el;
    },

    /**
     * Dosya uzantısını al
     * @param {string} filename - Dosya adı
     * @returns {string} Uzantı
     */
    getFileExtension(filename) {
        const parts = filename.split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    },

    /**
     * Dosya adını al (uzantısız)
     * @param {string} filepath - Dosya yolu
     * @returns {string} Dosya adı
     */
    getFileName(filepath) {
        const parts = filepath.replace(/\\/g, '/').split('/');
        const filename = parts.pop();
        const dotIndex = filename.lastIndexOf('.');
        return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
    },

    /**
     * Benzersiz ID oluştur
     * @returns {string} Benzersiz ID
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Basit markdown dizesini HTML'e çevir (AI yanıtları için)
     * @param {string} md - Markdown dizesi
     * @returns {string} HTML dizesi
     */
    markdownToHtml(md) {
        if (!md) return '';
        if (typeof md !== 'string') md = String(md);
        return md
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
    }
};

// Global olarak erişilebilir yap
window.Utils = Utils;
