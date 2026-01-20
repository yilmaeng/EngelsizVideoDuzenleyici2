/**
 * Ekleme Listesi (Insertion Queue) Modülü
 * Metin ve ses eklemelerini bir listede toplar
 */

const InsertionQueue = {
    items: [],
    nextId: 1,

    /**
     * Modülü başlat
     */
    init() {
        this.items = [];
        this.nextId = 1;
        console.log('InsertionQueue başlatıldı');
    },

    /**
     * Listeye öğe ekle
     * @param {string} type - 'text' veya 'audio'
     * @param {Object} options - Öğe seçenekleri
     * @returns {number} Eklenen öğenin ID'si
     */
    addItem(type, options) {
        const item = {
            id: this.nextId++,
            type: type,
            options: { ...options },
            createdAt: Date.now()
        };
        this.items.push(item);
        console.log('Listeye eklendi:', item);
        this.notifyChange();
        return item.id;
    },

    /**
     * Öğeyi güncelle
     * @param {number} id - Öğe ID
     * @param {Object} newOptions - Yeni seçenekler
     * @returns {boolean} Başarılı mı
     */
    updateItem(id, newOptions) {
        const item = this.items.find(i => i.id === id);
        if (item) {
            item.options = { ...item.options, ...newOptions };
            item.updatedAt = Date.now();
            console.log('Öğe güncellendi:', item);
            this.notifyChange();
            return true;
        }
        return false;
    },

    /**
     * Öğeyi sil
     * @param {number} id - Öğe ID
     * @returns {boolean} Başarılı mı
     */
    removeItem(id) {
        const index = this.items.findIndex(i => i.id === id);
        if (index > -1) {
            const removed = this.items.splice(index, 1)[0];
            console.log('Öğe silindi:', removed);
            this.notifyChange();
            return true;
        }
        return false;
    },

    /**
     * ID ile öğe getir
     * @param {number} id - Öğe ID
     * @returns {Object|null}
     */
    getItem(id) {
        return this.items.find(i => i.id === id) || null;
    },

    /**
     * Tüm öğeleri getir
     * @returns {Array}
     */
    getItems() {
        return [...this.items];
    },

    /**
     * Belirli tipteki öğeleri getir
     * @param {string} type - 'text' veya 'audio'
     * @returns {Array}
     */
    getItemsByType(type) {
        return this.items.filter(i => i.type === type);
    },

    /**
     * Listeyi geri yükle
     * @param {Array} items 
     */
    restore(items) {
        this.items = items || [];
        // ID sayacını güncelle (en son ID'den devam etsin)
        const maxId = this.items.reduce((max, item) => Math.max(max, item.id), 0);
        this.nextId = maxId + 1;
        console.log('InsertionQueue: Liste geri yüklendi', this.items);
        this.notifyChange();
    },

    /**
     * Listeyi temizle
     */
    clear() {
        this.items = [];
        console.log('Liste temizlendi');
        this.notifyChange();
    },

    /**
     * Liste boş mu?
     * @returns {boolean}
     */
    isEmpty() {
        return this.items.length === 0;
    },

    /**
     * Öğe sayısını getir
     * @returns {number}
     */
    getCount() {
        return this.items.length;
    },

    /**
     * Değişiklik bildirimi (event dispatch)
     */
    notifyChange() {
        const event = new CustomEvent('insertion-queue-change', {
            detail: {
                count: this.items.length,
                items: this.getItems()
            }
        });
        document.dispatchEvent(event);
    },

    /**
     * Listeyi özet olarak al (erişilebilirlik için)
     * @returns {string}
     */
    getSummary() {
        if (this.items.length === 0) {
            return 'Ekleme listesi boş';
        }

        const textCount = this.items.filter(i => i.type === 'text').length;
        const audioCount = this.items.filter(i => i.type === 'audio').length;
        const imageCount = this.items.filter(i => i.type === 'image').length;

        const parts = [];
        if (textCount > 0) parts.push(`${textCount} yazı`);
        if (audioCount > 0) parts.push(`${audioCount} ses`);
        if (imageCount > 0) parts.push(`${imageCount} görsel`);

        return `Ekleme listesi: ${parts.join(', ')}`;
    }
};

// Global olarak erişilebilir yap
window.InsertionQueue = InsertionQueue;
