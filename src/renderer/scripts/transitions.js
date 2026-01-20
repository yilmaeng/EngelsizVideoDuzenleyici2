/**
 * Geçiş (Transition) Modülü
 * Video geçişleri ekleme ve yönetimi
 * 
 * Kör ve az gören kullanıcılar için tamamen klavye ile kullanılabilen,
 * güvenli ve tekrar edilebilir geçiş sistemi.
 */

const Transitions = {
    // ==========================================
    // Geçiş Türleri Kütüphanesi
    // ==========================================

    transitionTypes: {
        // Temel Geçişler
        'cut': {
            id: 'cut',
            name: 'Kesme (Cut)',
            category: 'temel',
            description: 'Geçiş yok, doğrudan kesme',
            defaultDuration: 0,
            ffmpegType: 'cut',
            extendsDuration: false,
            defaultSfx: null
        },
        'crossDissolve': {
            id: 'crossDissolve',
            name: 'Çapraz Geçiş (Cross Dissolve)',
            category: 'temel',
            description: 'İki klip arasında yumuşak geçiş',
            defaultDuration: 0.5,
            ffmpegType: 'fade',
            extendsDuration: false,
            defaultSfx: 'whoosh_soft.mp3'
        },
        /* GEÇİCİ OLARAK DEVRE DIŞI
        'fadeIn': {
            id: 'fadeIn',
            name: 'Açılma (Fade In)',
            category: 'temel',
            description: 'Siyahtan görüntüye geçiş',
            defaultDuration: 0.5,
            ffmpegType: 'fade_in',
            extendsDuration: false,
            defaultSfx: 'fade_in.mp3'
        },
        'fadeOut': {
            id: 'fadeOut',
            name: 'Kapanma (Fade Out)',
            category: 'temel',
            description: 'Görüntüden siyaha geçiş',
            defaultDuration: 0.5,
            ffmpegType: 'fade_out',
            extendsDuration: false,
            defaultSfx: 'fade_out.mp3'
        },
        */

        // Dip-to Geçişler
        'dipToBlack': {
            id: 'dipToBlack',
            name: 'Siyaha Düşüş (Dip to Black)',
            category: 'dip',
            description: 'Siyaha geçiş ve geri dönüş',
            defaultDuration: 0.6,
            ffmpegType: 'dip_black',
            extendsDuration: false,
            defaultSfx: 'dip.mp3'
        },
        'dipToWhite': {
            id: 'dipToWhite',
            name: 'Beyaza Düşüş (Dip to White)',
            category: 'dip',
            description: 'Beyaza geçiş ve geri dönüş',
            defaultDuration: 0.6,
            ffmpegType: 'dip_white',
            extendsDuration: false,
            defaultSfx: 'dip.mp3'
        },

        // Wipe Geçişler
        'wipeLeft': {
            id: 'wipeLeft',
            name: 'Sola Kaydırma (Wipe Left)',
            category: 'wipe',
            description: 'Görüntü sola kayarak değişir',
            defaultDuration: 0.5,
            ffmpegType: 'wipeleft',
            extendsDuration: false,
            defaultSfx: 'whoosh.mp3'
        },
        'wipeRight': {
            id: 'wipeRight',
            name: 'Sağa Kaydırma (Wipe Right)',
            category: 'wipe',
            description: 'Görüntü sağa kayarak değişir',
            defaultDuration: 0.5,
            ffmpegType: 'wiperight',
            extendsDuration: false,
            defaultSfx: 'whoosh.mp3'
        },

        // Bölüm Ayırıcılar
        'chapterBreak': {
            id: 'chapterBreak',
            name: 'Bölüm Ayırıcı',
            category: 'separator',
            description: 'Siyah ekran ile bölüm ayırma (süre ekler)',
            defaultDuration: 1.0,
            ffmpegType: 'chapter_break',
            extendsDuration: true, // DİKKAT: Video süresini uzatır!
            defaultSfx: 'chapter_break.mp3'
        }
    },

    // Kategori isimleri
    categories: {
        'temel': 'Temel Geçişler',
        'dip': 'Dip-to (Düşüş)',
        'wipe': 'Wipe / Kaydırma',
        'separator': 'Bölüm Ayırıcılar'
    },

    // ==========================================
    // Aktif Geçiş State
    // ==========================================

    activeTransition: null, // Şu an seçili geçiş

    // Aktif geçiş ayarları
    activeSettings: {
        transitionId: 'crossDissolve', // Varsayılan
        duration: 0.5,
        useSfx: true,
        customSfxPath: null
    },

    // ==========================================
    // Uygulanmış Geçişler Listesi
    // ==========================================

    appliedTransitions: [], // [{id, time, transitionId, duration, sfx}]

    // ==========================================
    // Event Callback'leri
    // ==========================================

    onTransitionApplied: null,
    onTransitionRemoved: null,
    onActiveTransitionChanged: null,
    onTransitionsListChanged: null,

    // ==========================================
    // Modül Başlatma
    // ==========================================

    init() {
        // Varsayılan aktif geçişi ayarla
        this.setActiveTransition('crossDissolve');
        console.log('Transitions modülü başlatıldı');
    },

    // ==========================================
    // Aktif Geçiş Yönetimi
    // ==========================================

    /**
     * Aktif geçişi ayarla
     * @param {string} transitionId - Geçiş türü ID'si
     * @param {Object} options - Opsiyonel ayarlar
     */
    setActiveTransition(transitionId, options = {}) {
        const transitionType = this.transitionTypes[transitionId];
        if (!transitionType) {
            console.error(`Geçersiz geçiş türü: ${transitionId}`);
            return false;
        }

        this.activeTransition = transitionType;
        this.activeSettings = {
            transitionId: transitionId,
            duration: options.duration || transitionType.defaultDuration,
            useSfx: options.useSfx !== undefined ? options.useSfx : true,
            customSfxPath: options.customSfxPath || null
        };

        // Erişilebilirlik duyurusu
        // this.announceActiveTransition();

        if (this.onActiveTransitionChanged) {
            this.onActiveTransitionChanged(this.activeTransition, this.activeSettings);
        }

        return true;
    },

    /**
     * Aktif geçişi duyur
     */
    announceActiveTransition() {
        if (!this.activeTransition) {
            Accessibility.announce('Aktif geçiş yok');
            return;
        }

        const trans = this.activeTransition;
        const settings = this.activeSettings;

        let message = `Aktif geçiş: ${trans.name}. `;
        message += `Süre ${settings.duration} saniye. `;
        message += settings.useSfx ? 'Ses açık. ' : 'Ses kapalı. ';
        message += trans.extendsDuration ? 'Video süresi uzar.' : 'Video süresi değişmez.';

        Accessibility.announce(message);
    },

    /**
     * Aktif geçişi al
     * @returns {Object|null}
     */
    getActiveTransition() {
        return this.activeTransition;
    },

    /**
     * Aktif geçiş ayarlarını al
     * @returns {Object}
     */
    getActiveSettings() {
        return { ...this.activeSettings };
    },

    // ==========================================
    // Geçiş Uygulama
    // ==========================================

    /**
     * Aktif geçişi belirtilen zamana uygula
     * @param {number} time - Zaman (saniye)
     * @returns {Object|null} Eklenen geçiş
     */
    async applyAtTime(time) {
        if (!this.activeTransition) {
            Accessibility.announce('Aktif geçiş yok. Önce bir geçiş seçin.');
            return null;
        }

        // Video yüklü mü kontrol et
        if (!VideoPlayer.hasVideo()) {
            Accessibility.announce('Önce bir video açmalısınız');
            return null;
        }

        // Süre uzatan geçişler için uyarı
        if (this.activeTransition.extendsDuration) {
            const confirmed = await this.confirmExtendDuration();
            if (!confirmed) {
                Accessibility.announce('Geçiş iptal edildi');
                return null;
            }
        }

        const transition = {
            id: Utils.generateId(),
            time: time,
            transitionId: this.activeSettings.transitionId,
            transitionName: this.activeTransition.name,
            duration: this.activeSettings.duration,
            useSfx: this.activeSettings.useSfx,
            customSfxPath: this.activeSettings.customSfxPath,
            ffmpegType: this.activeTransition.ffmpegType,
            extendsDuration: this.activeTransition.extendsDuration
        };

        this.appliedTransitions.push(transition);
        this.sortTransitions();

        // Erişilebilirlik duyurusu
        Accessibility.announce(
            `${Utils.formatTime(time)} noktasına '${this.activeTransition.name}' geçişi eklendi.`
        );

        if (this.onTransitionApplied) {
            this.onTransitionApplied(transition);
        }
        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }

        return transition;
    },

    /**
     * Aktif geçişi mevcut imleç konumuna uygula
     */
    async applyAtCurrentTime() {
        const time = VideoPlayer.getTimelineTime();
        return await this.applyAtTime(time);
    },

    /**
     * Süre uzatan geçiş için onay al
     * @returns {Promise<boolean>}
     */
    async confirmExtendDuration() {
        const duration = this.activeSettings.duration;
        const message = `Bu geçiş video süresini ${duration} saniye uzatacaktır. Devam edilsin mi?`;

        // Erişilebilir onay diyaloğu kullan
        if (window.Dialogs && Dialogs.showAccessibleConfirm) {
            return await Dialogs.showAccessibleConfirm(message, 'Uyarı');
        }

        // Fallback
        return confirm(message);
    },

    // ==========================================
    // İşaretçi Entegrasyonu
    // ==========================================

    /**
     * Aktif geçişi tüm işaretçilere uygula
     * @returns {number} Uygulanan geçiş sayısı
     */
    async applyToAllMarkers() {
        if (!this.activeTransition) {
            Accessibility.announce('Aktif geçiş yok. Önce bir geçiş seçin.');
            return 0;
        }

        const markers = Markers.getAll();
        if (markers.length === 0) {
            Accessibility.announce('İşaretçi yok');
            return 0;
        }

        // Süre uzatan geçişler için uyarı
        if (this.activeTransition.extendsDuration) {
            const totalExtend = this.activeSettings.duration * markers.length;
            const confirmed = await Dialogs.showAccessibleConfirm(
                `Bu işlem video süresini toplam ${totalExtend.toFixed(1)} saniye uzatacaktır. ` +
                `${markers.length} işaretçiye geçiş uygulanacak. Devam edilsin mi?`,
                'Uyarı'
            );
            if (!confirmed) {
                Accessibility.announce('İşlem iptal edildi');
                return 0;
            }
        }

        let appliedCount = 0;

        for (const marker of markers) {
            const transition = {
                id: Utils.generateId(),
                time: marker.time,
                transitionId: this.activeSettings.transitionId,
                transitionName: this.activeTransition.name,
                duration: this.activeSettings.duration,
                useSfx: this.activeSettings.useSfx,
                customSfxPath: this.activeSettings.customSfxPath,
                ffmpegType: this.activeTransition.ffmpegType,
                extendsDuration: this.activeTransition.extendsDuration
            };

            // Aynı zamanda zaten geçiş var mı kontrol et
            const existing = this.appliedTransitions.find(t => Math.abs(t.time - marker.time) < 0.1);
            if (!existing) {
                this.appliedTransitions.push(transition);
                appliedCount++;
            }
        }

        this.sortTransitions();

        Accessibility.announce(`Aktif geçiş ${appliedCount} işaretçiye uygulandı.`);

        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }

        return appliedCount;
    },

    // ==========================================
    // Geçiş Listesi Yönetimi
    // ==========================================

    /**
     * Geçişi kaldır
     * @param {string} id - Geçiş ID'si
     */
    remove(id) {
        const index = this.appliedTransitions.findIndex(t => t.id === id);
        if (index === -1) return false;

        const transition = this.appliedTransitions[index];
        this.appliedTransitions.splice(index, 1);

        Accessibility.announce(`${Utils.formatTime(transition.time)} konumundaki geçiş silindi`);

        if (this.onTransitionRemoved) {
            this.onTransitionRemoved(transition);
        }
        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }

        return true;
    },

    /**
     * Tüm geçişleri temizle
     */
    clearAll() {
        const count = this.appliedTransitions.length;
        this.appliedTransitions = [];

        Accessibility.announce(`${count} geçiş silindi`);

        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }
    },

    /**
     * Geçiş listesini geri yükle (Load Project)
     * @param {Array} list
     */
    restore(list) {
        if (!Array.isArray(list)) return;
        this.appliedTransitions = list;
        this.sortTransitions();
        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }
    },

    /**
     * Geçişi güncelle
     * @param {string} id - Geçiş ID'si
     * @param {Object} updates - Güncellemeler
     */
    update(id, updates) {
        const transition = this.appliedTransitions.find(t => t.id === id);
        if (!transition) return false;

        Object.assign(transition, updates);
        this.sortTransitions();

        Accessibility.announce(`Geçiş güncellendi`);

        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }

        return true;
    },

    /**
     * Geçişleri zamana göre sırala
     */
    sortTransitions() {
        this.appliedTransitions.sort((a, b) => a.time - b.time);
    },

    /**
     * Tüm geçişleri al
     * @returns {Array}
     */
    getAll() {
        return [...this.appliedTransitions];
    },

    /**
     * Geçiş sayısını al
     * @returns {number}
     */
    getCount() {
        return this.appliedTransitions.length;
    },

    /**
     * Belirli bir geçişi al
     * @param {string} id
     * @returns {Object|null}
     */
    getById(id) {
        return this.appliedTransitions.find(t => t.id === id) || null;
    },

    /**
     * Belirli bir zamandaki geçişi bul
     * @param {number} time
     * @param {number} tolerance
     * @returns {Object|null}
     */
    findAtTime(time, tolerance = 0.5) {
        return this.appliedTransitions.find(t => Math.abs(t.time - time) <= tolerance) || null;
    },

    // ==========================================
    // Geçiş Türleri Yardımcıları
    // ==========================================

    /**
     * Tüm geçiş türlerini al
     * @returns {Array}
     */
    getAllTransitionTypes() {
        return Object.values(this.transitionTypes);
    },

    /**
     * Kategoriye göre geçiş türlerini al
     * @param {string} category
     * @returns {Array}
     */
    getTransitionsByCategory(category) {
        return Object.values(this.transitionTypes).filter(t => t.category === category);
    },

    /**
     * Tüm kategorileri al
     * @returns {Object}
     */
    getAllCategories() {
        return { ...this.categories };
    },

    /**
     * Geçiş türünü al
     * @param {string} id
     * @returns {Object|null}
     */
    getTransitionType(id) {
        return this.transitionTypes[id] || null;
    },

    // ==========================================
    // Önizleme
    // ==========================================

    /**
     * Aktif geçişi önizle (ses dahil)
     */
    async previewActiveTransition() {
        if (!this.activeTransition) {
            Accessibility.announce('Aktif geçiş yok');
            return;
        }

        const settings = this.activeSettings;
        const sfxLabel = settings.customSfxPath
            ? 'Özel ses efekti kullanılıyor'
            : (settings.useSfx ? 'Varsayılan ses efekti' : 'Ses kapalı');

        Accessibility.announce(
            `Önizleme: ${this.activeTransition.name}. ` +
            `Süre ${settings.duration} saniye. ${sfxLabel}.`
        );

        // TODO: Gerçek video önizleme implementasyonu
        // Şimdilik sadece ses çalabiliriz
        if (settings.useSfx) {
            await this.playSfxPreview();
        }
    },

    /**
     * Ses efekti önizlemesi çal
     */
    async playSfxPreview() {
        const settings = this.activeSettings;

        // Özel ses dosyası varsa onu çal
        if (settings.customSfxPath) {
            try {
                const audio = new Audio(settings.customSfxPath);
                audio.volume = 0.5;
                await audio.play();
                return;
            } catch (error) {
                console.warn('Özel ses efekti çalınamadı:', error);
            }
        }

        // Varsayılan ses dosyalarını dene
        if (settings.useSfx && this.activeTransition) {
            const sfxFile = this.getSfxFileForTransition(this.activeTransition.id);
            if (sfxFile) {
                try {
                    const audio = new Audio(`assets/sfx/${sfxFile}`);
                    audio.volume = 0.7;
                    await audio.play();
                    return;
                } catch (error) {
                    console.warn('Varsayılan ses dosyası çalınamadı, yapay ses kullanılıyor:', error);
                    // Fallback: Web Audio API
                    this.playGeneratedSfx(this.activeTransition.id, settings.duration);
                }
            } else {
                // Ses dosyası yoksa yapay ses kullan
                this.playGeneratedSfx(this.activeTransition.id, settings.duration);
            }
        }
    },

    /**
     * Geçiş türüne göre ses dosyası adını döndür
     * @param {string} transitionId - Geçiş ID'si
     * @returns {string|null} Ses dosyası adı
     */
    getSfxFileForTransition(transitionId) {
        const sfxMap = {
            'crossDissolve': 'cross_dissolve.wav',
            'fadeIn': 'fade.wav',
            'fadeOut': 'fade.wav',
            'dipToBlack': 'dip_to_black.wav',
            'dipToWhite': 'dip_to_black.wav',
            'wipeLeft': 'cross_dissolve.wav',
            'wipeRight': 'cross_dissolve.wav',
            'chapterBreak': 'chapter_break.wav',
            'cut': null // Kesme için ses yok
        };
        return sfxMap[transitionId] || 'cross_dissolve.wav';
    },

    /**
     * Web Audio API ile geçiş sesi oluştur ve çal
     * @param {string} transitionId - Geçiş türü
     * @param {number} duration - Süre (saniye)
     */
    playGeneratedSfx(transitionId, duration) {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const masterGain = audioContext.createGain();
            masterGain.connect(audioContext.destination);
            masterGain.gain.value = 0.3;

            const now = audioContext.currentTime;
            const sfxDuration = Math.min(duration, 1); // Max 1 saniye

            switch (transitionId) {
                case 'cut':
                    // Kesme: Kısa tık sesi
                    this.playClickSound(audioContext, masterGain, now);
                    break;

                case 'crossDissolve':
                    // Çapraz geçiş: Yumuşak whoosh
                    this.playWhooshSound(audioContext, masterGain, now, sfxDuration, 'soft');
                    break;

                case 'fadeIn':
                    // Fade in: Yükselen ton
                    this.playFadeInSound(audioContext, masterGain, now, sfxDuration);
                    break;

                case 'fadeOut':
                    // Fade out: Düşen ton
                    this.playFadeOutSound(audioContext, masterGain, now, sfxDuration);
                    break;

                case 'dipToBlack':
                case 'dipToWhite':
                    // Dip: Düşüş ve yükseliş
                    this.playDipSound(audioContext, masterGain, now, sfxDuration);
                    break;

                case 'wipeLeft':
                case 'wipeRight':
                    // Wipe: Hızlı whoosh
                    this.playWhooshSound(audioContext, masterGain, now, sfxDuration, 'fast');
                    break;

                case 'chapterBreak':
                    // Bölüm ayırıcı: Gong benzeri
                    this.playChapterSound(audioContext, masterGain, now, sfxDuration);
                    break;

                default:
                    // Varsayılan: Basit bip
                    this.playBeepSound(audioContext, masterGain, now, sfxDuration);
            }

            // AudioContext'i otomatik kapat
            setTimeout(() => {
                audioContext.close();
            }, (sfxDuration + 0.5) * 1000);

        } catch (error) {
            console.warn('Ses efekti oluşturulamadı:', error);
        }
    },

    /**
     * Tık sesi (Cut için)
     */
    playClickSound(ctx, gain, startTime) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        osc.type = 'square';
        osc.frequency.value = 1000;

        oscGain.gain.setValueAtTime(0.5, startTime);
        oscGain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.05);

        osc.connect(oscGain);
        oscGain.connect(gain);

        osc.start(startTime);
        osc.stop(startTime + 0.05);
    },

    /**
     * Whoosh sesi (Dissolve, Wipe için)
     */
    playWhooshSound(ctx, gain, startTime, duration, type = 'soft') {
        // Gürültü oluştur
        const bufferSize = ctx.sampleRate * duration;
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }

        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        // Filtre
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(type === 'fast' ? 2000 : 800, startTime);
        filter.frequency.exponentialRampToValueAtTime(type === 'fast' ? 4000 : 1500, startTime + duration / 2);
        filter.frequency.exponentialRampToValueAtTime(type === 'fast' ? 1000 : 500, startTime + duration);
        filter.Q.value = 1;

        // Zarf
        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(0, startTime);
        envelope.gain.linearRampToValueAtTime(type === 'fast' ? 0.4 : 0.2, startTime + duration * 0.3);
        envelope.gain.linearRampToValueAtTime(0, startTime + duration);

        noise.connect(filter);
        filter.connect(envelope);
        envelope.connect(gain);

        noise.start(startTime);
        noise.stop(startTime + duration);
    },

    /**
     * Fade In sesi
     */
    playFadeInSound(ctx, gain, startTime, duration) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, startTime);
        osc.frequency.exponentialRampToValueAtTime(600, startTime + duration);

        oscGain.gain.setValueAtTime(0, startTime);
        oscGain.gain.linearRampToValueAtTime(0.3, startTime + duration * 0.7);
        oscGain.gain.linearRampToValueAtTime(0, startTime + duration);

        osc.connect(oscGain);
        oscGain.connect(gain);

        osc.start(startTime);
        osc.stop(startTime + duration);
    },

    /**
     * Fade Out sesi
     */
    playFadeOutSound(ctx, gain, startTime, duration) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, startTime);
        osc.frequency.exponentialRampToValueAtTime(200, startTime + duration);

        oscGain.gain.setValueAtTime(0.3, startTime);
        oscGain.gain.linearRampToValueAtTime(0, startTime + duration);

        osc.connect(oscGain);
        oscGain.connect(gain);

        osc.start(startTime);
        osc.stop(startTime + duration);
    },

    /**
     * Dip sesi (düşüş ve yükseliş)
     */
    playDipSound(ctx, gain, startTime, duration) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        osc.type = 'sine';
        const halfDur = duration / 2;

        osc.frequency.setValueAtTime(400, startTime);
        osc.frequency.exponentialRampToValueAtTime(150, startTime + halfDur);
        osc.frequency.exponentialRampToValueAtTime(400, startTime + duration);

        oscGain.gain.setValueAtTime(0.2, startTime);
        oscGain.gain.linearRampToValueAtTime(0.4, startTime + halfDur);
        oscGain.gain.linearRampToValueAtTime(0, startTime + duration);

        osc.connect(oscGain);
        oscGain.connect(gain);

        osc.start(startTime);
        osc.stop(startTime + duration);
    },

    /**
     * Bölüm ayırıcı sesi (gong benzeri)
     */
    playChapterSound(ctx, gain, startTime, duration) {
        // Ana ton
        const osc1 = ctx.createOscillator();
        const osc1Gain = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.value = 220; // A3

        osc1Gain.gain.setValueAtTime(0.4, startTime);
        osc1Gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

        osc1.connect(osc1Gain);
        osc1Gain.connect(gain);

        // Harmonik
        const osc2 = ctx.createOscillator();
        const osc2Gain = ctx.createGain();

        osc2.type = 'sine';
        osc2.frequency.value = 440; // A4

        osc2Gain.gain.setValueAtTime(0.2, startTime);
        osc2Gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration * 0.7);

        osc2.connect(osc2Gain);
        osc2Gain.connect(gain);

        osc1.start(startTime);
        osc1.stop(startTime + duration);
        osc2.start(startTime);
        osc2.stop(startTime + duration);
    },

    /**
     * Basit bip sesi
     */
    playBeepSound(ctx, gain, startTime, duration) {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = 440;

        oscGain.gain.setValueAtTime(0.3, startTime);
        oscGain.gain.linearRampToValueAtTime(0, startTime + duration);

        osc.connect(oscGain);
        oscGain.connect(gain);

        osc.start(startTime);
        osc.stop(startTime + duration);
    },

    // ==========================================
    // Durum Kaydetme/Yükleme
    // ==========================================

    /**
     * Durumu dışa aktar (proje kaydetme için)
     * @returns {Object}
     */
    exportState() {
        return {
            activeSettings: { ...this.activeSettings },
            appliedTransitions: this.appliedTransitions.map(t => ({ ...t }))
        };
    },

    /**
     * Durumu içe aktar (proje yükleme için)
     * @param {Object} state
     */
    importState(state) {
        if (state.activeSettings) {
            this.activeSettings = { ...state.activeSettings };
            this.activeTransition = this.transitionTypes[this.activeSettings.transitionId] || null;
        }

        if (state.appliedTransitions) {
            this.appliedTransitions = state.appliedTransitions.map(t => ({ ...t }));
        }

        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }
    },

    /**
     * Durumu sıfırla
     */
    reset() {
        this.appliedTransitions = [];
        this.setActiveTransition('crossDissolve');

        if (this.onTransitionsListChanged) {
            this.onTransitionsListChanged(this.appliedTransitions);
        }
    }
};

// Global olarak erişilebilir yap
window.Transitions = Transitions;
