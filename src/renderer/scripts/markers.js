/**
 * İşaretçi Modülü
 * Video zaman çizelgesinde işaretçi ekleme ve yönetimi
 */

const Markers = {
    markers: [], // [{id, time, label}]
    selectedMarkerIndex: -1,

    // Event callback'leri
    onMarkerAdded: null,
    onMarkerRemoved: null,
    onMarkersChanged: null,

    /**
     * Modülü başlat
     */
    init() {
        this.updateMarkerList();
        this.updateMarkerCount();
    },

    /**
     * İşaretçi ekle
     * @param {number} time - Zaman (saniye)
     * @param {string} label - İsteğe bağlı etiket
     * @returns {Object} Eklenen işaretçi
     */
    add(time, label = null) {
        // Aynı zamanda zaten işaretçi var mı kontrol et
        const existing = this.markers.find(m => Math.abs(m.time - time) < 0.1);
        if (existing) {
            Accessibility.announce('Bu konumda zaten işaretçi var');
            return null;
        }

        const marker = {
            id: Utils.generateId(),
            time: time,
            label: label || `İşaretçi ${this.markers.length + 1}`
        };

        this.markers.push(marker);
        this.sortMarkers();
        this.updateMarkerList();
        this.updateMarkerCount();

        Accessibility.announceMarker('added', time, this.markers.length);

        if (this.onMarkerAdded) {
            this.onMarkerAdded(marker);
        }
        if (this.onMarkersChanged) {
            this.onMarkersChanged(this.markers);
        }

        return marker;
    },

    /**
     * Geçerli konuma işaretçi ekle
     * Timeline zamanını kullanır (silme sonrası doğru konum için)
     */
    addAtCurrentTime() {
        // Timeline zamanını kullan (kaynak video zamanı yerine)
        const time = VideoPlayer.getTimelineTime();
        return this.add(time);
    },

    /**
     * İşaretçi sil
     * @param {string} id - İşaretçi ID
     */
    remove(id) {
        const index = this.markers.findIndex(m => m.id === id);
        if (index === -1) return;

        const marker = this.markers[index];
        this.markers.splice(index, 1);

        this.updateMarkerList();
        this.updateMarkerCount();

        Accessibility.announceMarker('removed', marker.time, this.markers.length);

        if (this.onMarkerRemoved) {
            this.onMarkerRemoved(marker);
        }
        if (this.onMarkersChanged) {
            this.onMarkersChanged(this.markers);
        }
    },

    /**
     * Geçerli konumdaki işaretçiyi sil
     * Timeline zamanını kullanır (silme sonrası doğru konum için)
     */
    removeAtCurrentTime() {
        const time = VideoPlayer.getTimelineTime();
        const marker = this.findClosest(time, 0.5); // 0.5 saniye tolerans

        if (marker) {
            this.remove(marker.id);
        } else {
            Accessibility.announce('Bu konumda işaretçi yok');
        }
    },

    /**
     * Timeline'dan silinen aralığa göre işaretçileri güncelle
     * @param {number} startTime - Silinen aralık başlangıcı
     * @param {number} endTime - Silinen aralık bitişi
     */
    handleTimelineDelete(startTime, endTime) {
        const duration = endTime - startTime;
        const remainingMarkers = [];
        let changed = false;

        this.markers.forEach(m => {
            // Silinen aralık içindeki VE tam bitiş noktasındaki işaretçileri sil
            // (10-20 arası silindiyse, 10'daki ve 20'deki işaretçiler silinmeli)
            if (m.time >= startTime - 0.001 && m.time <= endTime + 0.001) {
                // Silinen aralıktaki işaretçi - silinir
                changed = true;
            } else {
                if (m.time >= endTime) {
                    // Aralıktan sonrakini kaydır
                    m.time -= duration;
                    changed = true;
                }
                remainingMarkers.push(m);
            }
        });

        if (changed) {
            const deletedCount = this.markers.length - remainingMarkers.length;
            this.markers = remainingMarkers;
            this.sortMarkers();
            this.updateMarkerList();
            this.updateMarkerCount();

            console.log(`Markers: Timeline silme işlemi sonrası işaretçiler güncellendi.`);
            if (this.onMarkersChanged) {
                this.onMarkersChanged(this.markers);
            }
        }
    },

    /**
     * Tüm işaretçileri temizle
     */
    clearAll() {
        const count = this.markers.length;
        this.markers = [];
        this.selectedMarkerIndex = -1;

        this.updateMarkerList();
        this.updateMarkerCount();

        Accessibility.announce(`${count} işaretçi silindi`);

        if (this.onMarkersChanged) {
            this.onMarkersChanged(this.markers);
        }
    },

    /**
     * En yakın işaretçiyi bul
     * @param {number} time - Arama zamanı
     * @param {number} tolerance - Tolerans (saniye)
     * @returns {Object|null} İşaretçi veya null
     */
    findClosest(time, tolerance = Infinity) {
        if (this.markers.length === 0) return null;

        let closest = null;
        let minDiff = Infinity;

        for (const marker of this.markers) {
            const diff = Math.abs(marker.time - time);
            if (diff < minDiff && diff <= tolerance) {
                minDiff = diff;
                closest = marker;
            }
        }

        return closest;
    },

    /**
     * Sonraki işaretçiye git
     * seekToTimelineTime ile farklı kaynaklı segmentleri destekler
     */
    goToNext() {
        const currentTimelineTime = VideoPlayer.getTimelineTime();
        const nextMarker = this.markers.find(m => m.time > currentTimelineTime + 0.1);

        if (nextMarker) {
            // seekToTimelineTime doğru kaynağı bulur ve geçiş yapar
            VideoPlayer.seekToTimelineTime(nextMarker.time);
            Accessibility.announce(`Sonraki işaretçi: ${nextMarker.label}, ${Utils.formatTime(nextMarker.time)}`);
        } else {
            Accessibility.announce('Sonraki işaretçi yok');
        }
    },

    /**
     * Önceki işaretçiye git
     * seekToTimelineTime ile farklı kaynaklı segmentleri destekler
     */
    goToPrevious() {
        const currentTimelineTime = VideoPlayer.getTimelineTime();

        // Tersine sıralı olarak ara
        const prevMarkers = this.markers.filter(m => m.time < currentTimelineTime - 0.1);

        if (prevMarkers.length > 0) {
            const prevMarker = prevMarkers[prevMarkers.length - 1];
            // seekToTimelineTime doğru kaynağı bulur ve geçiş yapar
            VideoPlayer.seekToTimelineTime(prevMarker.time);
            Accessibility.announce(`Önceki işaretçi: ${prevMarker.label}, ${Utils.formatTime(prevMarker.time)}`);
        } else {
            Accessibility.announce('Önceki işaretçi yok');
        }
    },

    /**
     * Geçerli konuma göre önceki ve sonraki işaretçileri al
     * @param {number} time - Referans zamanı
     * @returns {Object} {prev: marker|null, next: marker|null}
     */
    getSurrounding(time) {
        let prev = null;
        let next = null;

        for (const marker of this.markers) {
            if (marker.time < time) {
                prev = marker;
            } else if (marker.time > time && !next) {
                next = marker;
                break;
            }
        }

        return { prev, next };
    },

    /**
     * İşaretçileri zamana göre sırala
     */
    sortMarkers() {
        this.markers.sort((a, b) => a.time - b.time);
    },

    /**
     * İşaretçi listesini güncelle
     */
    updateMarkerList() {
        const list = document.getElementById('marker-list');
        if (!list) {
            console.warn('Markers: #marker-list elementi bulunamadı!');
            return;
        }

        console.log(`Markers: Liste güncelleniyor. Mevcut işaretçi sayısı: ${this.markers.length}`);
        list.innerHTML = '';

        if (this.markers.length === 0) {
            console.log('Markers: İşaretçi yok, boş mesajı ekleniyor.');
            const emptyLi = document.createElement('li');
            emptyLi.className = 'empty-message';
            emptyLi.textContent = 'Henüz işaretçi yok';
            list.appendChild(emptyLi);
            return;
        }

        this.markers.forEach((marker, index) => {
            console.log(`Markers: Listeye ekleniyor [${index}]:`, marker);
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('tabindex', '0');
            li.setAttribute('data-marker-id', marker.id);
            li.textContent = `${Utils.formatTime(marker.time)} - ${marker.label}`;

            // Tıklama ile git - seekToTimelineTime farklı kaynakları destekler
            li.addEventListener('click', () => {
                VideoPlayer.seekToTimelineTime(marker.time);
                Accessibility.announce(`${marker.label}: ${Utils.formatTime(marker.time)}`);
            });

            // Klavye ile seçim
            li.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    VideoPlayer.seekToTimelineTime(marker.time);
                    Accessibility.announce(`${marker.label}: ${Utils.formatTime(marker.time)}`);
                } else if (e.key === 'Delete') {
                    e.preventDefault();
                    this.remove(marker.id);
                }
            });

            list.appendChild(li);
        });

        console.log(`Markers: ${list.children.length} adet element listeye eklendi.`);
    },

    /**
     * İşaretçi sayısını güncelle
     */
    updateMarkerCount() {
        const countEl = document.getElementById('marker-count');
        if (countEl) {
            countEl.textContent = `İşaretçi: ${this.markers.length}`;
        }
    },

    /**
     * Tüm işaretçileri al
     * @returns {Array} İşaretçi listesi
     */
    getAll() {
        return [...this.markers];
    },

    /**
     * İşaretçileri geri yükle
     * @param {Array} markersList 
     */
    restore(markersList) {
        if (!Array.isArray(markersList)) return;

        console.log(`Markers: Geri yükleme başladı. ${markersList.length} adet.`);

        // Listeyi sıfırla ve güvenli bir şekilde yeniden oluştur
        this.markers = [];
        markersList.forEach(m => {
            if (m && typeof m.time === 'number') {
                this.markers.push({
                    id: m.id || Utils.generateId(),
                    time: parseFloat(m.time),
                    label: m.label || 'İşaretçi'
                });
            }
        });

        this.sortMarkers();

        // UI güncellemesi
        this.updateMarkerList();
        this.updateMarkerCount();

        // Garanti olsun diye gecikmeli tekrar güncelle
        setTimeout(() => {
            this.updateMarkerList();
            this.updateMarkerCount();
            console.log('Markers: UI güncellendi (gecikmeli).');
        }, 100);

        if (this.onMarkersChanged) {
            this.onMarkersChanged(this.markers);
        }
    },

    /**
     * İşaretçi sayısını al
     * @returns {number} İşaretçi sayısı
     */
    getCount() {
        return this.markers.length;
    }
};

// Global olarak erişilebilir yap
window.Markers = Markers;
