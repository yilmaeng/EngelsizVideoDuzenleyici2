/**
 * CTA Overlay Preview Manager
 * Ana video üzerinde CTA animasyonlarını gerçek zamanlı önizleme
 * Non-destructive editing - Render yapmadan overlay gösterimi
 */
const CtaOverlayPreview = {
    overlayContainer: null,
    overlayVideo: null,
    mainVideo: null,
    overlayAudio: null,

    // Zaman çizelgesine eklenen overlay'ler (non-destructive)
    timelineOverlays: [],

    // Şu an aktif olan overlay index'i
    activeIndex: -1,

    init() {
        this.overlayContainer = document.getElementById('cta-overlay-preview');
        this.overlayVideo = document.getElementById('cta-overlay-video');
        this.mainVideo = document.getElementById('video-player');
        this.overlayAudio = new Audio();

        if (!this.overlayContainer || !this.overlayVideo || !this.mainVideo) {
            console.warn('CTA Overlay Preview: Required elements not found');
            return;
        }

        this.setupEventListeners();
    },

    setupEventListeners() {
        // Ana video zaman güncellemesi
        this.mainVideo.addEventListener('timeupdate', () => {
            this.checkOverlayTiming();
        });

        // Ana video durdurulduğunda overlay'i de durdur
        this.mainVideo.addEventListener('pause', () => {
            this.pauseOverlay();
        });

        // Ana video oynatıldığında overlay zamanlamasını kontrol et
        this.mainVideo.addEventListener('play', () => {
            this.checkOverlayTiming();
        });

        // Ana video seek edildiğinde
        this.mainVideo.addEventListener('seeked', () => {
            this.checkOverlayTiming();
        });
    },

    /**
     * Overlay'i zaman çizelgesine ekle (non-destructive)
     * @param {Object} params
     * @param {Object} params.asset - Seçilen CTA asset
     * @param {Object} params.options - Ayarlar
     */
    addOverlayToTimeline(params) {
        const { asset, options } = params;

        const overlayData = {
            id: 'cta_' + Date.now(),
            asset,
            startTime: options.startTime || 0,
            endTime: (options.startTime || 0) + (options.duration || asset.duration || 5),
            duration: options.duration || asset.duration || 5,
            position: options.position || 'bottom-right',
            scale: options.scale || 0.3,
            opacity: options.opacity || 1,
            sound: options.sound || 'embedded',
            fade: options.fade || false,
            description: options.description || asset.name
        };

        this.timelineOverlays.push(overlayData);

        console.log('CTA added to timeline:', overlayData);

        return overlayData;
    },

    /**
     * Overlay zamanlamasını kontrol et
     */
    checkOverlayTiming() {
        if (this.timelineOverlays.length === 0) {
            this.hideOverlay();
            return;
        }

        const currentTime = this.mainVideo.currentTime;

        // Aktif overlay'i bul
        let foundOverlay = null;
        let foundIndex = -1;

        for (let i = 0; i < this.timelineOverlays.length; i++) {
            const overlay = this.timelineOverlays[i];
            if (currentTime >= overlay.startTime && currentTime <= overlay.endTime) {
                foundOverlay = overlay;
                foundIndex = i;
                break;
            }
        }

        if (foundOverlay) {
            // Bu overlay zaten aktif mi?
            if (this.activeIndex !== foundIndex) {
                // Yeni overlay'i yükle
                this.loadOverlay(foundOverlay, foundIndex);
            }

            // Overlay görünmeli
            if (!this.isVisible()) {
                this.showOverlay();
            }

            // Ana video oynatılıyorsa overlay'i de oynat
            if (!this.mainVideo.paused && this.overlayVideo.paused) {
                const overlayTime = currentTime - foundOverlay.startTime;
                if (Math.abs(this.overlayVideo.currentTime - overlayTime) > 0.5) {
                    this.overlayVideo.currentTime = overlayTime;
                }
                this.overlayVideo.play().catch(console.error);

                // Ses efektini çal
                if (foundOverlay.sound !== 'none' && foundOverlay.sound !== 'embedded') {
                    if (this.overlayAudio.paused) {
                        this.overlayAudio.currentTime = 0;
                        this.overlayAudio.play().catch(console.error);
                    }
                }
            }
        } else {
            // Overlay gizlenmeli
            if (this.isVisible()) {
                this.hideOverlay();
            }
            this.activeIndex = -1;
        }
    },

    loadOverlay(overlayData, index) {
        this.activeIndex = index;

        const asset = overlayData.asset;
        const isAbsolute = asset.path.includes(':') || asset.path.startsWith('/') || asset.path.startsWith('\\');
        const assetSrc = isAbsolute ? `file:///${asset.path.replace(/\\/g, '/')}` : asset.path;

        this.overlayVideo.src = assetSrc;
        this.overlayVideo.load();

        // Ses ayarla
        if (overlayData.sound === 'embedded') {
            this.overlayVideo.muted = false;
        } else if (overlayData.sound !== 'none') {
            this.overlayVideo.muted = true;
            this.overlayAudio.src = overlayData.sound;
            this.overlayAudio.load();
        } else {
            this.overlayVideo.muted = true;
        }

        // Pozisyon ve boyut ayarla
        this.applyPosition(overlayData.position);
        this.applyScale(overlayData.scale);
        this.overlayContainer.style.opacity = overlayData.opacity;
    },

    showOverlay() {
        this.overlayContainer.classList.remove('cta-overlay-hidden');
        this.overlayContainer.classList.add('cta-overlay-visible');
    },

    hideOverlay() {
        this.overlayContainer.classList.remove('cta-overlay-visible');
        this.overlayContainer.classList.add('cta-overlay-hidden');
        this.pauseOverlay();
    },

    pauseOverlay() {
        if (this.overlayVideo) {
            this.overlayVideo.pause();
        }
        if (this.overlayAudio) {
            this.overlayAudio.pause();
        }
    },

    isVisible() {
        return this.overlayContainer.classList.contains('cta-overlay-visible');
    },

    applyPosition(position) {
        const positionClasses = [
            'position-bottom-left', 'position-bottom-center', 'position-bottom-right',
            'position-top-left', 'position-top-right', 'position-center'
        ];
        positionClasses.forEach(cls => this.overlayContainer.classList.remove(cls));
        this.overlayContainer.classList.add(`position-${position}`);
    },

    applyScale(scale) {
        const percentage = scale * 100;
        this.overlayVideo.style.width = `${percentage}%`;
        this.overlayVideo.style.height = 'auto';
    },

    /**
     * Belirli bir overlay'i kaldır
     */
    removeOverlay(id) {
        const index = this.timelineOverlays.findIndex(o => o.id === id);
        if (index !== -1) {
            this.timelineOverlays.splice(index, 1);
            if (this.activeIndex === index) {
                this.hideOverlay();
                this.activeIndex = -1;
            }
        }
    },

    /**
     * Tüm overlay'leri kaldır
     */
    clearAllOverlays() {
        this.timelineOverlays = [];
        this.hideOverlay();
        this.activeIndex = -1;
    },

    /**
     * Zaman çizelgesindeki overlay'leri döndür
     */
    getTimelineOverlays() {
        return this.timelineOverlays;
    },

    /**
     * Overlay sayısını döndür
     */
    getOverlayCount() {
        return this.timelineOverlays.length;
    },

    /**
     * Proje verisi için export
     */
    exportForProject() {
        return this.timelineOverlays.map(overlay => ({
            id: overlay.id,
            assetId: overlay.asset.id,
            assetPath: overlay.asset.path,
            assetName: overlay.asset.name,
            assetType: overlay.asset.type,
            startTime: overlay.startTime,
            endTime: overlay.endTime,
            duration: overlay.duration,
            position: overlay.position,
            scale: overlay.scale,
            opacity: overlay.opacity,
            sound: overlay.sound,
            fade: overlay.fade,
            description: overlay.description
        }));
    },

    /**
     * Proje verisinden import
     */
    importFromProject(overlaysData) {
        this.clearAllOverlays();
        if (!overlaysData || !Array.isArray(overlaysData)) return;

        overlaysData.forEach(data => {
            const overlay = {
                id: data.id || 'cta_' + Date.now(),
                asset: {
                    id: data.assetId,
                    path: data.assetPath,
                    name: data.assetName,
                    type: data.assetType || 'video'
                },
                startTime: data.startTime,
                endTime: data.endTime,
                duration: data.duration,
                position: data.position,
                scale: data.scale,
                opacity: data.opacity,
                sound: data.sound,
                fade: data.fade,
                description: data.description
            };
            this.timelineOverlays.push(overlay);
        });
    }
};

// Sayfa yüklendiğinde başlat
document.addEventListener('DOMContentLoaded', () => {
    CtaOverlayPreview.init();
});
