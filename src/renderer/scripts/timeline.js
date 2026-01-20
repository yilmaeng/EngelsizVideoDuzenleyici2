/**
 * Timeline Modülü
 * Non-destructive editing için Edit Decision List (EDL) yönetimi
 * Tüm düzenleme işlemleri bellekte tutulur, sadece dışa aktarırken FFmpeg çalışır
 */

const Timeline = {
    // Kaynak dosya
    sourceFile: null,
    sourceDuration: 0,

    // Segment listesi - video'nun hangi kısımlarının gösterileceği
    // Her segment: { start: number, end: number }
    // Örnek: [{start: 0, end: 10}, {start: 25, end: 60}] → 10-25 arası silinmiş
    segments: [],

    // Pano (clipboard)
    clipboard: null, // { segments: [], duration: number }

    // Geri alma / yineleme
    undoStack: [],
    redoStack: [],
    maxUndoSteps: 50,

    // Değişiklik durumu
    hasChanges: false,

    /**
     * Modülü başlat
     */
    init() {
        this.reset();
    },

    /**
     * Sıfırla
     */
    reset() {
        this.sourceFile = null;
        this.sourceDuration = 0;
        this.segments = [];
        this.clipboard = null;
        this.undoStack = [];
        this.redoStack = [];
        this.hasChanges = false;
    },

    /**
     * Video yükle - tüm video tek segment olarak başlar
     * @param {string} filePath - Dosya yolu
     * @param {number} duration - Video süresi (saniye)
     */
    loadVideo(filePath, duration) {
        this.reset();
        this.sourceFile = filePath;
        this.sourceDuration = duration;
        // Başlangıçta tüm video tek bir segment
        this.segments = [{ start: 0, end: duration }];
        console.log(`Timeline: Video yüklendi, süre: ${duration}s`);
    },

    /**
     * Mevcut durumu kaydet (undo için)
     */
    saveState() {
        this.undoStack.push(JSON.stringify(this.segments));
        if (this.undoStack.length > this.maxUndoSteps) {
            this.undoStack.shift();
        }
        this.redoStack = []; // Yeni işlem yapıldığında redo temizlenir
        this.hasChanges = true;
    },
    /**
     * Durumu geri yükle (Proje yükleme)
     * @param {Array} segments 
     * @param {string} sourceFile 
     * @param {number} duration 
     */
    restoreState(segments, sourceFile, duration) {
        this.reset();
        this.sourceFile = sourceFile;
        this.sourceDuration = duration;
        this.segments = segments;
        this.hasChanges = false;
        console.log(`Timeline: Durum yüklendi. ${segments.length} segment, kaynak: ${sourceFile}, süre: ${duration}s`);
    },

    /**
     * Geri al
     * @returns {boolean} Başarılı mı
     */
    undo() {
        if (this.undoStack.length === 0) return false;

        this.redoStack.push(JSON.stringify(this.segments));
        this.segments = JSON.parse(this.undoStack.pop());
        return true;
    },

    /**
     * Yinele
     * @returns {boolean} Başarılı mı
     */
    redo() {
        if (this.redoStack.length === 0) return false;

        this.undoStack.push(JSON.stringify(this.segments));
        this.segments = JSON.parse(this.redoStack.pop());
        return true;
    },

    /**
     * Timeline zamanını kaynak video zamanına çevir
     * @param {number} timelineTime - Timeline üzerindeki zaman
     * @returns {number} Kaynak videodaki gerçek zaman
     */
    timelineToSource(timelineTime) {
        let elapsed = 0;

        for (const seg of this.segments) {
            const segDuration = seg.end - seg.start;

            if (elapsed + segDuration > timelineTime) {
                // Bu segment içinde
                return seg.start + (timelineTime - elapsed);
            }

            elapsed += segDuration;
        }

        // Sonun ötesinde ise son noktayı döndür
        if (this.segments.length > 0) {
            const lastSeg = this.segments[this.segments.length - 1];
            return lastSeg.end;
        }

        return 0;
    },

    /**
     * Kaynak video zamanını timeline zamanına çevir
     * Farklı kaynaklı segmentleri destekler
     * @param {number} sourceTime - Kaynak videodaki zaman
     * @param {string} sourceFile - Hangi kaynak dosyadan (opsiyonel, verilmezse mevcut sourceFile kullanılır)
     * @returns {number} Timeline üzerindeki zaman (-1 eğer silinmiş bölgedeyse)
     */
    sourceToTimeline(sourceTime, sourceFile = null) {
        const targetSource = sourceFile || this.sourceFile;
        let timelineTime = 0;

        for (const seg of this.segments) {
            const segSource = seg.sourceFile || this.sourceFile;
            const segDuration = seg.end - seg.start;

            // Bu segment aynı kaynaktan mı?
            if (segSource === targetSource) {
                if (sourceTime >= seg.start && sourceTime <= seg.end) {
                    // Bu segment içinde
                    return timelineTime + (sourceTime - seg.start);
                }
            }
            timelineTime += segDuration;
        }

        return -1; // Silinmiş bölgede veya bulunamadı
    },

    /**
     * Toplam timeline süresini al
     * @returns {number} Toplam süre (saniye)
     */
    getTotalDuration() {
        return this.segments.reduce((total, seg) => total + (seg.end - seg.start), 0);
    },

    /**
     * Seçili alanı sil (ANI işlem)
     * @param {number} startTime - Başlangıç (timeline zamanı)
     * @param {number} endTime - Bitiş (timeline zamanı)
     * @returns {boolean} Başarılı mı
     */
    deleteRange(startTime, endTime) {
        if (startTime >= endTime) return false;
        if (this.segments.length === 0) return false;

        this.saveState();

        const newSegments = [];
        let elapsed = 0;

        for (const seg of this.segments) {
            const segDuration = seg.end - seg.start;
            const segStart = elapsed;
            const segEnd = elapsed + segDuration;

            // Bu segment seçimle kesişiyor mu?
            if (segEnd <= startTime || segStart >= endTime) {
                // Kesişmiyor - olduğu gibi ekle
                newSegments.push({ ...seg });
            } else {
                // Kesişiyor - parçala

                // Seçimden önceki kısım
                if (segStart < startTime) {
                    const beforeDuration = startTime - segStart;
                    newSegments.push({
                        start: seg.start,
                        end: seg.start + beforeDuration
                    });
                }

                // Seçimden sonraki kısım
                if (segEnd > endTime) {
                    const afterOffset = endTime - segStart;
                    newSegments.push({
                        start: seg.start + afterOffset,
                        end: seg.end
                    });
                }
            }

            elapsed += segDuration;
        }

        this.segments = newSegments;

        // İşaretçileri güncelle
        if (typeof Markers !== 'undefined') {
            Markers.handleTimelineDelete(startTime, endTime);
        }

        this.mergeSegments(); // Segmentleri birleştir (pürüzsüz oynatma için)
        console.log(`Timeline: Silindi ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s`);
        return true;
    },

    /**
     * Ardışık ve aynı kaynaktan olan segmentleri birleştir
     */
    mergeSegments() {
        if (this.segments.length <= 1) return;

        const merged = [];
        let current = { ...this.segments[0] };

        for (let i = 1; i < this.segments.length; i++) {
            const next = this.segments[i];

            // Eğer aynı kaynaktanlarsa ve biri bitince diğeri (neredeyse) başlıyorsa birleştir
            const sameSource = (current.sourceFile || this.sourceFile) === (next.sourceFile || this.sourceFile);
            const isContiguous = Math.abs(current.end - next.start) < 0.05;

            if (sameSource && isContiguous) {
                current.end = next.end;
            } else {
                merged.push(current);
                current = { ...next };
            }
        }
        merged.push(current);
        this.segments = merged;
    },

    /**
     * Seçili alanı kes (ANI işlem)
     * @param {number} startTime - Başlangıç (timeline zamanı)
     * @param {number} endTime - Bitiş (timeline zamanı)
     * @returns {boolean} Başarılı mı
     */
    cut(startTime, endTime) {
        // Önce kopyala
        if (!this.copy(startTime, endTime)) return false;
        // Sonra sil
        return this.deleteRange(startTime, endTime);
    },

    /**
     * Seçili alanı kopyala (ANI işlem)
     * @param {number} startTime - Başlangıç (timeline zamanı)
     * @param {number} endTime - Bitiş (timeline zamanı)
     * @returns {boolean} Başarılı mı
     */
    copy(startTime, endTime) {
        if (startTime >= endTime) return false;
        if (this.segments.length === 0) return false;

        const copiedSegments = [];
        let elapsed = 0;

        for (const seg of this.segments) {
            const segDuration = seg.end - seg.start;
            const segStart = elapsed;
            const segEnd = elapsed + segDuration;

            // Bu segment seçimle kesişiyor mu?
            if (segEnd > startTime && segStart < endTime) {
                // Kesişen kısmı al
                const copyStart = Math.max(seg.start, seg.start + (startTime - segStart));
                const copyEnd = Math.min(seg.end, seg.start + (endTime - segStart));

                if (copyEnd > copyStart) {
                    copiedSegments.push({
                        start: copyStart,
                        end: copyEnd,
                        sourceFile: seg.sourceFile || this.sourceFile
                    });
                }
            }

            elapsed += segDuration;
        }

        if (copiedSegments.length === 0) return false;

        this.clipboard = {
            sourceFile: this.sourceFile,
            segments: copiedSegments,
            duration: endTime - startTime
        };

        console.log(`Timeline: Kopyalandı ${this.clipboard.duration.toFixed(2)}s`);
        return true;
    },

    /**
     * Yapıştır (ANI işlem)
     * @param {number} insertTime - Ekleme noktası (timeline zamanı)
     * @returns {boolean} Başarılı mı
     */
    paste(insertTime) {
        if (!this.clipboard) return false;

        this.saveState();

        // Clipboard'daki segment'leri sourceFile bilgisiyle birlikte kopyala
        const clipboardSegments = this.clipboard.segments.map(seg => ({
            ...seg,
            sourceFile: this.clipboard.sourceFile || seg.sourceFile
        }));

        // Boş proje mi? (segment yok veya sourceFile yok)
        if (this.segments.length === 0 || !this.sourceFile) {
            // Doğrudan ekle
            this.segments = clipboardSegments;

            // Eğer sourceFile yoksa, clipboard'dan al
            if (!this.sourceFile && this.clipboard.sourceFile) {
                this.sourceFile = this.clipboard.sourceFile;
            }

            console.log(`Timeline: Boş projeye yapıştırıldı ${this.clipboard.duration.toFixed(2)}s`);
            return true;
        }

        const newSegments = [];
        let elapsed = 0;
        let inserted = false;

        for (const seg of this.segments) {
            const segDuration = seg.end - seg.start;
            const segEnd = elapsed + segDuration;

            // Ekleme noktasına geldik mi?
            if (!inserted && insertTime <= elapsed) {
                // Clipboard segment'lerini ekle
                for (const clipSeg of clipboardSegments) {
                    newSegments.push({ ...clipSeg });
                }
                inserted = true;
            }

            // Ekleme noktası bu segment'in içinde mi?
            if (!inserted && insertTime > elapsed && insertTime < segEnd) {
                // Segment'i ikiye böl
                const splitPoint = seg.start + (insertTime - elapsed);

                // İlk parça
                newSegments.push({
                    start: seg.start,
                    end: splitPoint,
                    sourceFile: seg.sourceFile || this.sourceFile
                });

                // Clipboard'ı ekle
                for (const clipSeg of clipboardSegments) {
                    newSegments.push({ ...clipSeg });
                }
                inserted = true;

                // İkinci parça
                newSegments.push({
                    start: splitPoint,
                    end: seg.end,
                    sourceFile: seg.sourceFile || this.sourceFile
                });
            } else {
                newSegments.push({
                    ...seg,
                    sourceFile: seg.sourceFile || this.sourceFile
                });
            }

            elapsed += segDuration;
        }

        // Eğer sona ekleme ise
        if (!inserted) {
            for (const clipSeg of clipboardSegments) {
                newSegments.push({ ...clipSeg });
            }
        }

        this.segments = newSegments;
        console.log(`Timeline: Yapıştırıldı ${this.clipboard.duration.toFixed(2)}s`);
        return true;
    },

    /**
     * Segment listesini al (dışa aktarma için)
     * @returns {Array} Segment listesi
     */
    getSegments() {
        return [...this.segments];
    },

    /**
     * Belirli timeline zamanındaki segment'i bul
     * @param {number} timelineTime 
     * @returns {object|null} { segmentIndex, segment, offsetInSegment }
     */
    getSegmentAt(timelineTime) {
        let elapsed = 0;

        for (let i = 0; i < this.segments.length; i++) {
            const seg = this.segments[i];
            const segDuration = seg.end - seg.start;

            if (elapsed + segDuration > timelineTime) {
                return {
                    segmentIndex: i,
                    segment: seg,
                    offsetInSegment: timelineTime - elapsed
                };
            }

            elapsed += segDuration;
        }

        return null;
    },

    /**
     * Belirtilen pozisyona segment ekle
     * @param {number} position - Ekleme pozisyonu (timeline time)
     * @param {Object} newSegment - Eklenecek segment {start, end, sourceFile}
     */
    insertSegmentAtPosition(position, newSegment) {
        this.saveState();

        // Eğer timeline boşsa veya position 0 ise, başa ekle
        if (this.segments.length === 0 || position <= 0) {
            this.segments.unshift(newSegment);
            console.log('Segment başa eklendi:', newSegment);
            return;
        }

        // Pozisyon timeline sonunda veya ötesinde ise, sona ekle
        const totalDuration = this.getTotalDuration();
        if (position >= totalDuration) {
            this.segments.push(newSegment);
            console.log('Segment sona eklendi:', newSegment);
            return;
        }

        // Pozisyonun hangi segment içinde olduğunu bul
        let elapsed = 0;
        let insertIndex = this.segments.length;

        for (let i = 0; i < this.segments.length; i++) {
            const seg = this.segments[i];
            const segDuration = seg.end - seg.start;

            if (elapsed + segDuration > position) {
                // Bu segment içinde bir pozisyon
                const offsetInSegment = position - elapsed;

                // Segment'i böl
                if (offsetInSegment > 0.1) {
                    // Segment'in ilk kısmı
                    const firstPart = {
                        start: seg.start,
                        end: seg.start + offsetInSegment,
                        sourceFile: seg.sourceFile
                    };

                    // Segment'in ikinci kısmı
                    const secondPart = {
                        start: seg.start + offsetInSegment,
                        end: seg.end,
                        sourceFile: seg.sourceFile
                    };

                    // Mevcut segment'i ilk kısım ile değiştir, yeni segment'i ve ikinci kısmı ekle
                    this.segments.splice(i, 1, firstPart, newSegment, secondPart);
                    console.log('Segment bölündü ve araya eklendi:', newSegment);
                } else {
                    // Segment başındayız, öncesine ekle
                    this.segments.splice(i, 0, newSegment);
                    console.log('Segment başına eklendi:', newSegment);
                }
                return;
            }

            elapsed += segDuration;
        }

        // Herhangi bir segment'e denk gelmediyse sona ekle
        this.segments.push(newSegment);
        console.log('Segment fallback olarak sona eklendi:', newSegment);
    },

    /**
     * Debug: Segment listesini yazdır
     */
    debugPrint() {
        console.log('Timeline segments:');
        this.segments.forEach((seg, i) => {
            const source = seg.sourceFile ? ` [${seg.sourceFile.split(/[/\\]/).pop()}]` : '';
            console.log(`  [${i}] ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s (${(seg.end - seg.start).toFixed(2)}s)${source}`);
        });
        console.log(`  Total: ${this.getTotalDuration().toFixed(2)}s`);
    }
};

// Global olarak erişilebilir yap
window.Timeline = Timeline;

