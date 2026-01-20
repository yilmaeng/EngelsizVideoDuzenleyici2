/**
 * Seçim Modülü
 * Video seçim alanı yönetimi
 */

const Selection = {
    start: null,      // Seçim başlangıcı (saniye)
    end: null,        // Seçim bitişi (saniye)
    isSelecting: false,

    // Event callback'leri
    onSelectionChanged: null,

    /**
     * Modülü başlat
     */
    init() {
        this.updateUI();
    },

    /**
     * Seçim var mı?
     * @returns {boolean}
     */
    hasSelection() {
        return this.start !== null && this.end !== null;
    },

    /**
     * Seçimi al
     * @returns {Object|null} {start, end, duration} veya null
     */
    getSelection() {
        if (!this.hasSelection()) return null;

        return {
            start: Math.min(this.start, this.end),
            end: Math.max(this.start, this.end),
            duration: Math.abs(this.end - this.start)
        };
    },

    /**
     * Seçimi ayarla
     * @param {number} start - Başlangıç (saniye)
     * @param {number} end - Bitiş (saniye)
     */
    setSelection(start, end) {
        this.start = start;
        this.end = end;

        this.updateUI();
        this.announceSelection();

        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelection());
        }
    },

    /**
     * Seçimi temizle
     * @param {boolean} silent - true ise duyuru yapma (dosya açarken kullanılır)
     */
    clear(silent = false) {
        this.start = null;
        this.end = null;
        this.isSelecting = false;

        this.updateUI();

        // Sessiz mod değilse duyur
        if (!silent) {
            Accessibility.announceSelection(null, null);
        }

        if (this.onSelectionChanged) {
            this.onSelectionChanged(null);
        }
    },

    /**
     * Tümünü seç
     */
    selectAll() {
        if (!VideoPlayer.hasVideo()) return;

        this.setSelection(0, VideoPlayer.getDuration());
    },

    /**
     * Geçerli konumdan ileri/geri seçimi genişlet/daralt
     * İmlecin seçimin başında mı sonunda mı olduğuna göre doğru ucu hareket ettirir
     * Timeline zamanını kullanır
     * @param {number} seconds - Hareket miktarı (pozitif: ileri/sağ, negatif: geri/sol)
     */
    extend(seconds) {
        const currentTimelineTime = VideoPlayer.getTimelineTime();
        const duration = VideoPlayer.getDuration();

        if (!this.hasSelection()) {
            // Seçim yoksa geçerli konumdan başla
            if (seconds > 0) {
                // İleri seçim: mevcut konum başlangıç, ilerisi bitiş
                this.start = currentTimelineTime;
                this.end = Utils.clamp(currentTimelineTime + seconds, 0, duration);
                // İmleci seçimin SONUNA taşı (ardışık Shift+Sağ için)
                VideoPlayer.seekToTimelineTime(this.end);
            } else {
                // Geri seçim: gerisi başlangıç, mevcut konum bitiş
                this.start = Utils.clamp(currentTimelineTime + seconds, 0, duration);
                this.end = currentTimelineTime;
                // İmleci seçimin BAŞINA taşı (ardışık Shift+Sol için)
                VideoPlayer.seekToTimelineTime(this.start);
            }
        } else {
            // Seçim var - imleç hangi uca yakın?
            const sel = this.getSelection();
            const distToStart = Math.abs(currentTimelineTime - sel.start);
            const distToEnd = Math.abs(currentTimelineTime - sel.end);

            // İmleç seçimin başına yakınsa (veya başındaysa)
            if (distToStart <= distToEnd) {
                // Başlangıç ucunu hareket ettir
                const newStart = Utils.clamp(this.start + seconds, 0, duration);
                // Başlangıç bitişin ötesine geçemez
                if (newStart < this.end) {
                    this.start = newStart;
                    // İmleci de taşı
                    VideoPlayer.seekToTimelineTime(newStart);
                }
            } else {
                // İmleç seçimin sonuna yakınsa (veya sonundaysa)
                // Bitiş ucunu hareket ettir
                const newEnd = Utils.clamp(this.end + seconds, 0, duration);
                // Bitiş başlangıcın gerisine geçemez
                if (newEnd > this.start) {
                    this.end = newEnd;
                    // İmleci de taşı
                    VideoPlayer.seekToTimelineTime(newEnd);
                }
            }
        }

        this.updateUI();
        this.announceSelection();

        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelection());
        }
    },

    /**
     * Geçerli konumdan işaretçiye seç/genişlet
     * Mevcut seçim varsa bir sonraki/önceki işaretleyiciye genişletir
     * Timeline zamanlarını kullanır
     * @param {string} direction - 'prev' veya 'next'
     */
    selectToMarker(direction) {
        const currentTimelineTime = VideoPlayer.getTimelineTime();
        const duration = VideoPlayer.getDuration();
        const markers = Markers.getAll();

        if (markers.length === 0) {
            Accessibility.announce('İşaretleyici yok');
            return;
        }

        if (direction === 'next') {
            if (this.hasSelection()) {
                // Mevcut seçimin sonundan sonraki işaretleyiciyi bul
                const sel = this.getSelection();
                const nextMarker = markers.find(m => m.time > sel.end + 0.1);

                if (nextMarker) {
                    this.end = nextMarker.time;
                    VideoPlayer.seekToTimelineTime(this.end);
                    Accessibility.announce(`Seçim genişletildi: ${Utils.formatTime(nextMarker.time)}`);
                } else {
                    // Son işaretleyiciden sonrası yok, sona kadar genişlet
                    this.end = duration;
                    VideoPlayer.seekToTimelineTime(this.end);
                    Accessibility.announce('Seçim sona kadar genişletildi');
                }
            } else {
                // Seçim yok, mevcut konumdan sonraki işaretleyiciye seç
                const nextMarker = markers.find(m => m.time > currentTimelineTime + 0.1);
                if (nextMarker) {
                    this.start = currentTimelineTime;
                    this.end = nextMarker.time;
                    VideoPlayer.seekToTimelineTime(this.end);
                } else {
                    this.start = currentTimelineTime;
                    this.end = duration;
                    VideoPlayer.seekToTimelineTime(this.end);
                }
            }
        } else {
            // direction === 'prev'
            if (this.hasSelection()) {
                // Mevcut seçimin başından önceki işaretleyiciyi bul
                const sel = this.getSelection();
                let prevMarker = null;
                for (let i = markers.length - 1; i >= 0; i--) {
                    if (markers[i].time < sel.start - 0.1) {
                        prevMarker = markers[i];
                        break;
                    }
                }

                if (prevMarker) {
                    this.start = prevMarker.time;
                    VideoPlayer.seekToTimelineTime(this.start);
                    Accessibility.announce(`Seçim genişletildi: ${Utils.formatTime(prevMarker.time)}`);
                } else {
                    // İlk işaretleyiciden öncesi yok, başa kadar genişlet
                    this.start = 0;
                    VideoPlayer.seekToTimelineTime(this.start);
                    Accessibility.announce('Seçim başa kadar genişletildi');
                }
            } else {
                // Seçim yok, önceki işaretleyiciden mevcut konuma seç
                let prevMarker = null;
                for (let i = markers.length - 1; i >= 0; i--) {
                    if (markers[i].time < currentTimelineTime - 0.1) {
                        prevMarker = markers[i];
                        break;
                    }
                }

                if (prevMarker) {
                    this.start = prevMarker.time;
                    this.end = currentTimelineTime;
                    VideoPlayer.seekToTimelineTime(this.start);
                } else {
                    this.start = 0;
                    this.end = currentTimelineTime;
                    VideoPlayer.seekToTimelineTime(this.start);
                }
            }
        }

        this.updateUI();
        this.announceSelection();

        if (this.onSelectionChanged) {
            this.onSelectionChanged(this.getSelection());
        }
    },

    /**
     * Geçerli konumdan başa/sona seç
     * Timeline zamanlarını kullanır
     * @param {string} direction - 'start' veya 'end'
     */
    selectTo(direction) {
        const currentTimelineTime = VideoPlayer.getTimelineTime();
        const duration = VideoPlayer.getDuration();

        if (direction === 'start') {
            this.setSelection(0, currentTimelineTime);
        } else {
            this.setSelection(currentTimelineTime, duration);
        }
    },

    /**
     * İşaretçiler arası seçim
     * @param {string} direction - 'expand' genişlet, 'shrink' daralt
     */
    selectBetweenMarkers(direction = 'expand') {
        const currentTimelineTime = VideoPlayer.getTimelineTime();
        const markers = Markers.getAll();

        if (markers.length < 2) {
            Accessibility.announce('En az 2 işaretçi gerekli');
            return;
        }

        // Geçerli konumu içeren iki işaretçiyi bul
        // İşaretleyiciler artık timeline zamanıyla saklanıyor
        let startMarker = null;
        let endMarker = null;

        for (let i = 0; i < markers.length - 1; i++) {
            if (markers[i].time <= currentTimelineTime && markers[i + 1].time >= currentTimelineTime) {
                startMarker = markers[i];
                endMarker = markers[i + 1];
                break;
            }
        }

        if (startMarker && endMarker) {
            this.setSelection(startMarker.time, endMarker.time);
            Accessibility.announce(
                `İşaretçiler arası seçildi: ${Utils.formatTime(startMarker.time)} - ${Utils.formatTime(endMarker.time)}`
            );
        } else {
            // En yakın iki işaretçiyi seç
            if (markers.length >= 2) {
                const closest = Markers.findClosest(currentTimelineTime);
                if (closest) {
                    const closestIndex = markers.findIndex(m => m.id === closest.id);
                    if (closestIndex > 0) {
                        this.setSelection(markers[closestIndex - 1].time, closest.time);
                    } else if (closestIndex < markers.length - 1) {
                        this.setSelection(closest.time, markers[closestIndex + 1].time);
                    }
                }
            }
        }
    },

    /**
     * UI güncelle
     */
    updateUI() {
        const statusEl = document.getElementById('selection-status');
        const selectionVisual = document.getElementById('timeline-selection');

        if (statusEl) {
            if (this.hasSelection()) {
                const sel = this.getSelection();
                statusEl.textContent = `Seçim: ${Utils.formatTime(sel.start)} - ${Utils.formatTime(sel.end)} (${Utils.formatTime(sel.duration)})`;
            } else {
                statusEl.textContent = 'Seçim yok';
            }
        }

        // Görsel seçim göstergesi
        if (selectionVisual) {
            if (this.hasSelection() && VideoPlayer.hasVideo()) {
                const duration = VideoPlayer.getDuration();
                const sel = this.getSelection();
                const startPercent = (sel.start / duration) * 100;
                const widthPercent = (sel.duration / duration) * 100;

                selectionVisual.style.left = `${startPercent}%`;
                selectionVisual.style.width = `${widthPercent}%`;
                selectionVisual.style.display = 'block';
            } else {
                selectionVisual.style.display = 'none';
            }
        }
    },

    /**
     * Seçimin başına (soluna) git
     * seekToTimelineTime ile farklı kaynaklı segmentleri destekler
     */
    jumpToStart() {
        const selection = this.getSelection();
        if (selection) {
            const currentTimelineTime = VideoPlayer.getTimelineTime();
            const alreadyAtStart = Math.abs(currentTimelineTime - selection.start) < 0.1;
            if (alreadyAtStart) {
                Accessibility.announce('İmleç zaten seçimin solunda');
            } else {
                // seekToTimelineTime doğru kaynağı bulur ve geçiş yapar
                VideoPlayer.seekToTimelineTime(selection.start);
                Accessibility.announce(`İmleç seçimin soluna taşındı: ${Utils.formatTime(selection.start)}`);
            }
        } else {
            Accessibility.announce('Seçili alan yok');
        }
    },

    /**
     * Seçimin sonuna (sağına) git
     * seekToTimelineTime ile farklı kaynaklı segmentleri destekler
     */
    jumpToEnd() {
        const selection = this.getSelection();
        if (selection) {
            const currentTimelineTime = VideoPlayer.getTimelineTime();
            const alreadyAtEnd = Math.abs(currentTimelineTime - selection.end) < 0.1;
            if (alreadyAtEnd) {
                Accessibility.announce('İmleç zaten seçimin sağında');
            } else {
                // seekToTimelineTime doğru kaynağı bulur ve geçiş yapar
                VideoPlayer.seekToTimelineTime(selection.end);
                Accessibility.announce(`İmleç seçimin sağına taşındı: ${Utils.formatTime(selection.end)}`);
            }
        } else {
            Accessibility.announce('Seçili alan yok');
        }
    },

    /**
     * Seçimi duyur (DETAYLI OKUMA)
     */
    announceSelection() {
        if (this.hasSelection()) {
            const sel = this.getSelection();
            const startText = Utils.formatTimeForSpeech(sel.start);
            const endText = Utils.formatTimeForSpeech(sel.end);
            const durText = Utils.formatTimeForSpeech(sel.end - sel.start);

            // "1.5" saniye yerine "1 saniye 500 milisaniye" gibi oku
            // Ayrıca süreyi de ekle, kullanıcı aralığı bilsin
            Accessibility.announce(`Seçim: ${startText} ile ${endText} arası. Süre: ${durText}`);
        } else {
            Accessibility.announce('Seçim yok');
        }
    }
};

// Global olarak erişilebilir yap
window.Selection = Selection;
