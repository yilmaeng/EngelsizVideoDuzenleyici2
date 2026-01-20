/**
 * Video Oynatıcı Modülü
 * Video oynatma ve kontrol işlemleri
 */

const VideoPlayer = {
    video: null,
    // Alias for external access
    get videoElement() { return this.video; },
    isPlaying: false,
    currentFilePath: null,
    metadata: null,
    cursorPosition: 0, // İmleç pozisyonu (Enter ile belirlenen)
    playbackStartPosition: null, // Oynatma başladığındaki pozisyon (boşluk tuşu için)

    isRangePlaying: false,
    rangeEnd: null,
    ignoreTimeline: false, // Sessizlik önizleme vb. durumlar için timeline'ı görmezden gel
    _isLoadingSource: false, // Kaynak değiştirme işlemi devam ediyor mu?

    // Kesim Önizleme değişkenleri
    isPreviewingCut: false,
    cutPreviewSkipStart: null,
    cutPreviewSkipEnd: null,
    cutPreviewEnd: null,

    // Scrubbing (ses kaydırma) için değişkenler
    isScrubbing: false,
    scrubDirection: 0, // 1: ileri, -1: geri
    scrubInterval: null,
    scrubPlayDuration: 300, // Her adımda kaç ms ses çalınsın

    // Event callback'leri
    onTimeUpdate: null,
    onPlayStateChange: null,
    onVideoLoaded: null,
    onError: null,

    /**
     * Modülü başlat
     */
    init() {
        this.video = document.getElementById('video-player');

        if (!this.video) {
            console.error('Video elementi bulunamadı!');
            return;
        }

        this.setupEventListeners();
        this.updateUI();
    },

    /**
     * Video yüklü ve hazır mı kontrol et
     * @returns {boolean}
     */
    hasVideo() {
        return this.video && this.video.src && this.video.readyState >= 1;
    },

    /**
     * Event dinleyicilerini kur
     */
    setupEventListeners() {
        // Zaman güncelleme - silinen kısımları atla
        this.video.addEventListener('timeupdate', () => {
            // Aralık oynatılıyorsa kontrol et
            if (this.isRangePlaying && this.rangeEnd !== null) {
                if (this.video.currentTime >= this.rangeEnd) {
                    this.pause();
                    this.isRangePlaying = false;
                    this.rangeEnd = null;
                    this.ignoreTimeline = false; // Reset ignore mode
                    Accessibility.announce('Seçili alan oynatımı tamamlandı');
                    return;
                }
            }

            // Timeline varsa ve oynatma yapılıyorsa, silinen kısımları atla
            if (this.isPlaying && typeof Timeline !== 'undefined' && Timeline.segments.length > 0) {
                this.skipDeletedSegments();
            }

            // Kesim önizleme modu (Shift+Ctrl+Space)
            if (this.isPreviewingCut) {
                const currentTime = this.getTimelineTime();

                // Sync Wait: Henüz seek işleminin gerçekleşip gerçekleşmediğini kontrol et
                // Eğer currentTime, öngörülen startPoint'ten çok uzaktaysa (veya endPoint'ten sonraysa),
                // muhtemelen seek henüz video elementine yansımamıştır.
                if (!this.cutPreviewSynced) {
                    if (this.cutPreviewStart !== undefined) {
                        // Eğer startPoint'e yakınsak (veya atlama öncesindeysek) sync oldu kabul et
                        const dist = Math.abs(currentTime - this.cutPreviewStart);
                        // Veya sadece atlama başlangıcından önceysek ve cutPreviewEnd'den önceysek
                        if (dist < 0.5 || (currentTime < this.cutPreviewSkipStart && currentTime < this.cutPreviewEnd)) {
                            this.cutPreviewSynced = true;
                            // console.log('Kesim Önizleme: Sync sağlandı, playback başlıyor.');
                        } else {
                            // console.log(`Kesim Önizleme: Sync bekleniyor... Cur: ${currentTime}, Target: ${this.cutPreviewStart}`);
                            return;
                        }
                    } else {
                        // startPoint tanımlı değilse sync varsay
                        this.cutPreviewSynced = true;
                    }
                }

                // Atlama noktasına geldik mi? (Start <= current < End)
                if (currentTime >= this.cutPreviewSkipStart - 0.1 && currentTime < this.cutPreviewSkipEnd) {
                    // Atlama işlemini yap
                    // console.log('Önizleme: Seçili alan atlanıyor...');
                    this.seekToTimelineTime(this.cutPreviewSkipEnd);
                    return;
                }

                // Bitiş noktasına geldik mi?
                if (currentTime >= this.cutPreviewEnd) {
                    this.pause();
                    this.isPreviewingCut = false;
                    Accessibility.announce('Önizleme tamamlandı');
                    // İmleci seçimin başına döndür (kullanım kolaylığı için)
                    this.seekToTimelineTime(this.cutPreviewSkipStart);
                    return;
                }
            }

            this.updateTimeDisplay();
            if (this.onTimeUpdate) {
                this.onTimeUpdate(this.video.currentTime, this.video.duration);
            }
        });

        // Oynatma durumu
        this.video.addEventListener('play', () => {
            // Önizleme modunda dialog kontrolünü atla
            // Dialogs.isPreviewPlaying: Slayt/resim önizleme
            // this.isPreviewingCut: Kesim/sessizlik önizleme
            const isPreviewMode = (typeof Dialogs !== 'undefined' && Dialogs.isPreviewPlaying) || this.isPreviewingCut;

            if (!isPreviewMode) {
                // Dialog açıkken veya input odaklıyken oynatmayı engelle
                const dialogOpen = document.querySelectorAll('dialog[open]').length > 0;
                const active = document.activeElement;
                const inputFocused = active && (
                    active.tagName === 'INPUT' ||
                    active.tagName === 'TEXTAREA' ||
                    active.tagName === 'SELECT'
                );

                // Klavye devre dışıysa da engelle
                const keyboardDisabled = typeof Keyboard !== 'undefined' && !Keyboard.isEnabled;

                if (dialogOpen || inputFocused || keyboardDisabled) {
                    console.log('Video oynatma engellendi: dialog/input aktif veya klavye devre dışı');
                    this.video.pause();
                    return;
                }
            }

            this.isPlaying = true;
            this.updatePlayState();
        });

        this.video.addEventListener('pause', () => {
            this.isPlaying = false;
            this.updatePlayState();
        });

        this.video.addEventListener('ended', () => {
            this.isPlaying = false;
            this.updatePlayState();
            Accessibility.announce('Video sona erdi');
        });

        // Video yüklendiğinde
        this.video.addEventListener('loadedmetadata', () => {
            this.updateUI();
            this.hideVideoPlaceholder();

            if (this.onVideoLoaded) {
                this.onVideoLoaded(this.metadata);
            }
        });

        // Hata durumu
        this.video.addEventListener('error', (e) => {
            // Eğer video kapatılmışsa (src boşsa) hata verme
            if (!this.video.src || this.video.src === window.location.href) {
                return;
            }

            const error = this.video.error;
            let message = 'Bilinmeyen hata';
            let needsConversion = false;

            if (error) {
                switch (error.code) {
                    case MediaError.MEDIA_ERR_ABORTED:
                        message = 'Video yüklemesi iptal edildi';
                        break;
                    case MediaError.MEDIA_ERR_NETWORK:
                        message = 'Ağ hatası';
                        break;
                    case MediaError.MEDIA_ERR_DECODE:
                        message = 'Video çözümleme hatası - format dönüştürme gerekebilir';
                        needsConversion = true;
                        break;
                    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                        message = 'Video formatı desteklenmiyor - dönüştürme gerekiyor';
                        needsConversion = true;
                        break;
                }
            }

            // Sadece gerçek hatalarda duyuru yap
            Accessibility.announceError(message);

            // Dönüştürme gerekiyorsa özel callback çağır
            if (needsConversion && this.onConversionNeeded) {
                // Zaten dönüştürülmüş dosya için tekrar dönüştürme önerme
                const fileName = this.currentFilePath ? this.currentFilePath.split(/[\\/]/).pop() : '';
                if (fileName.startsWith('converted_') || fileName.startsWith('repair_')) {
                    console.warn('Zaten dönüştürülmüş dosya oynatılamadı:', this.currentFilePath);
                    // Sadece hata bildir, dönüştürme önerme
                    if (this.onError) {
                        this.onError('Dönüştürülmüş video oynatılamadı: ' + message);
                    }
                } else {
                    this.onConversionNeeded(this.currentFilePath, message);
                }
            } else if (this.onError) {
                this.onError(message);
            }
        });

        // Video elementinin varsayılan klavye davranışını engelle (dialog açıkken)
        this.video.addEventListener('keydown', (e) => {
            // Dialog açıksa veya input odaklıysa varsayılan davranışı engelle
            const dialogOpen = document.querySelectorAll('dialog[open]').length > 0;
            const active = document.activeElement;
            const inputFocused = active && (
                active.tagName === 'INPUT' ||
                active.tagName === 'TEXTAREA' ||
                active.tagName === 'SELECT'
            );

            if (dialogOpen || inputFocused) {
                // Space ve Enter tuşlarını engelle
                if (e.key === ' ' || e.key === 'Enter') {
                    console.log('Video element: Dialog/Input aktif, varsayılan davranış engellendi');
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });
    },

    /**
     * Video dosyası yükle
     * @param {string} filePath - Dosya yolu
     */
    async loadVideo(filePath) {
        try {
            // Metadata al
            const result = await window.api.getVideoMetadata(filePath);

            if (!result.success) {
                throw new Error(result.error);
            }

            this.metadata = result.data;
            this.currentFilePath = filePath;

            // Video kaynağını ayarla
            // Türkçe ve özel karakterler için dosya yolunu düzgün encode et
            // Windows yolları için önce forward slash'a çevir, sonra encode et
            const normalizedPath = filePath.replace(/\\/g, '/');
            // Sadece path kısmını encode et (sürücü harfi hariç)
            let encodedPath;
            if (/^[A-Za-z]:/.test(normalizedPath)) {
                // Windows yolu: C:/path/to/file
                const drive = normalizedPath.substring(0, 2);
                const rest = normalizedPath.substring(2);
                // Her path segmentini ayrı ayrı encode et
                encodedPath = drive + rest.split('/').map(segment => encodeURIComponent(segment)).join('/');
            } else {
                // Unix yolu veya relative path
                encodedPath = normalizedPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
            }

            this.video.src = `file:///${encodedPath}`;
            console.log('Video src:', this.video.src);
            this.video.load();


            // UI güncelle
            this.updateMetadataDisplay();
            document.getElementById('file-name').textContent = this.metadata.filename;

            // Erişilebilirlik duyurusu app.js tarafından yapılıyor (daha kapsamlı)

            // Cursor'u başa al
            this.cursorPosition = 0;

        } catch (error) {
            console.error('Video yükleme hatası:', error);
            Accessibility.announceError(`Video yüklenemedi: ${error.message}`);
            if (this.onError) {
                this.onError(error.message);
            }
        }
    },

    /**
     * Oynat/Duraklat toggle (Boşluk tuşu davranışı)
     * Oynatma başladığında pozisyonu hafızaya alır,
     * Durduğunda başlangıç pozisyonuna döner
     */
    togglePlay() {
        if (this.isPlaying) {
            // Oynatılıyorken boşluk: Başlangıç pozisyonuna dön ve duraklat
            this.pause();
            if (this.playbackStartPosition !== null) {
                // Timeline zamanına git
                this.seekToTimelineTime(this.playbackStartPosition);
                Accessibility.announce(`Başlangıç pozisyonuna dönüldü: ${Utils.formatTime(this.playbackStartPosition)}`);
            }
            this.playbackStartPosition = null;
        } else {
            // Duraklatılmışken boşluk: Pozisyonu hafızaya al ve oynat
            this.playbackStartPosition = this.getTimelineTime();
            this.play();
        }
    },

    /**
     * Mevcut pozisyonda duraklat (Ctrl+Boşluk veya Enter davranışı)
     * İmleç o anki pozisyonda kalır, başlangıç pozisyonuna dönmez
     */
    pauseAtCurrentPosition() {
        if (this.isPlaying) {
            this.pause();
            this.playbackStartPosition = null; // Başlangıç pozisyonunu temizle
        }
        // Oynatılıyor olsun veya olmasın, imleci mevcut konuma ayarla
        this.setCursorToCurrentTime();
        const timelineTime = this.getTimelineTime();
        Accessibility.announce(`İmleç konumu: ${Utils.formatTime(timelineTime)}`);
    },

    /**
     * Oynat
     * Farklı kaynaklı segmentleri destekler
     */
    play() {
        if (!this.hasVideo()) return;

        const segments = Timeline.segments;

        // Eğer segment'lerde değilsek, uygun segmente git (ignoreTimeline kapalıyken)
        if (!this.ignoreTimeline && segments && segments.length > 0) {
            const currentTime = this.video.currentTime;
            const currentSource = this.currentFilePath;
            let inValidSegment = false;
            let currentSegIndex = -1;

            // Mevcut kaynaktan ve zamandan bir segment içinde miyiz?
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const segSource = seg.sourceFile || Timeline.sourceFile;

                if (segSource === currentSource) {
                    if (currentTime >= seg.start - 0.5 && currentTime <= seg.end + 0.5) {
                        inValidSegment = true;
                        currentSegIndex = i;
                        break;
                    }
                }
            }

            if (!inValidSegment) {
                // Geçersiz konumdayız - timeline segment indeksimizi kontrol et
                if (this._currentTimelineSegmentIndex !== undefined &&
                    this._currentTimelineSegmentIndex < segments.length) {
                    // Son bilinen segment'e git
                    const targetSeg = segments[this._currentTimelineSegmentIndex];
                    const targetSource = targetSeg.sourceFile || Timeline.sourceFile;

                    if (targetSource !== currentSource) {
                        // Farklı kaynağa geçiş gerekiyor
                        console.log(`Oynatma: Farklı kaynağa geçiliyor: ${targetSource}`);
                        this.switchToSource(targetSource, targetSeg.start);
                        return; // switchToSource zaten oynatmayı başlatacak
                    } else {
                        this.video.currentTime = targetSeg.start;
                    }
                } else {
                    // İlk segment'e git
                    const firstSeg = segments[0];
                    const firstSource = firstSeg.sourceFile || Timeline.sourceFile;

                    if (firstSource !== currentSource) {
                        console.log(`Oynatma: İlk segment farklı kaynakta: ${firstSource}`);
                        this.switchToSource(firstSource, firstSeg.start);
                        return;
                    } else {
                        this.video.currentTime = firstSeg.start;
                    }
                }
                console.log('Oynatma: geçersiz konum, segment başına gidildi');
            } else {
                // Segment indeksini kaydet
                this._currentTimelineSegmentIndex = currentSegIndex;
            }
        }

        this.video.play();

        // Eğer kesim önizleme modundaysak duyuruyu gizle
        if (this.isPreviewingCut) {
            // Sessizce devam et
        } else {
            Accessibility.announcePlayState(true);
        }
    },

    /**
     * Duraklat
     */
    pause() {
        this.video.pause();
        this.isRangePlaying = false; // Her duraklatmada aralık oynatmayı sıfırla
        this.isPreviewingCut = false; // Kesim önizlemeyi sıfırla
        Accessibility.announcePlayState(false);
    },

    /**
     * Seçili alanı oynat
     * Timeline zamanlarını kaynak zamanlarına çevirir
     */
    playSelection() {
        if (!this.hasVideo()) return;

        const selection = Selection.getSelection();
        if (!selection) {
            Accessibility.announce('Seçili alan yok');
            return;
        }

        // Timeline zamanlarını kaynak zamanlarına çevir
        const sourceStart = Timeline.timelineToSource(selection.start);
        const sourceEnd = Timeline.timelineToSource(selection.end);

        this.video.currentTime = sourceStart;
        this.rangeEnd = sourceEnd;
        this.isRangePlaying = true;

        this.video.play()
            .catch(err => {
                console.error('Play selection error:', err);
                Accessibility.announceError('Seçim oynatılamadı');
            });
    },

    /**
     * Seçili alan silinmiş gibi önizleme yap (Ctrl+Shift+Space)
     * Seçimden önceki 3 sn, seçim atlanır, seçimden sonraki 3 sn oynatılır.
     */
    playCutPreview(customStart = null, customEnd = null) {
        if (!this.hasVideo()) return;

        let selStart, selEnd;

        if (customStart !== null && customEnd !== null) {
            selStart = customStart;
            selEnd = customEnd;
        } else {
            const selection = Selection.getSelection();
            if (!selection) {
                Accessibility.announce('Seçili alan yok. Kesim önizleme yapmak için bir alan seçin.');
                return;
            }
            selStart = selection.start;
            selEnd = selection.end;
        }

        const PREVIEW_DURATION = 3; // saniye (önce ve sonra)
        const duration = this.getDuration(); // Toplam süre

        const startPoint = Math.max(0, selStart - PREVIEW_DURATION);
        const endPoint = Math.min(duration, selEnd + PREVIEW_DURATION);

        // State ayarla
        this.isPreviewingCut = true;
        this.cutPreviewSkipStart = selStart;
        this.cutPreviewSkipEnd = selEnd;
        this.cutPreviewEnd = endPoint;
        this.cutPreviewStart = startPoint;
        this.cutPreviewSynced = false; // Sync bekle

        console.log(`Kesim Önizleme: ${startPoint}-${selStart} ...ATLA... ${selEnd}-${endPoint}`);
        // Accessibility.announce('Kesim önizleme başlatılıyor');

        // Başlangıç noktasına git ve oynat
        this.seekToTimelineTime(startPoint);
        this.play();
    },

    /**
     * Duraklat ve imleci konumla (Enter tuşu davranışı)
     * Timeline zamanını kullanır
     */
    pauseAndSetCursor() {
        this.pause();
        this.setCursorToCurrentTime();
        // Timeline zamanını duyur
        const timelineTime = this.getTimelineTime();
        Accessibility.announce(`İmleç konumu: ${Utils.formatTime(timelineTime)}`);
    },

    /**
     * Mevcut zamanı imleç konumu olarak ayarla
     * Timeline zamanını kullanır
     */
    setCursorToCurrentTime() {
        // Timeline zamanını kullan
        this.cursorPosition = this.getTimelineTime();
        this.updateCursorDisplay();
    },

    /**
     * Belirli zamana git
     * @param {number} time - Hedef zaman (saniye)
     * @param {boolean} announce - Duyuru yapılsın mı?
     */
    seekTo(time, announce = true) {
        if (!this.hasVideo()) return;

        const clampedTime = Utils.clamp(time, 0, this.video.duration || 0);
        this.video.currentTime = clampedTime;

        if (announce) {
            this.updateTimeDisplay();
        }
    },

    /**
     * Timeline zamanına git (farklı kaynaklı segmentleri destekler)
     * @param {number} timelineTime - Timeline üzerindeki hedef zaman
     */
    seekToTimelineTime(timelineTime) {
        const segments = Timeline.segments;
        if (!segments || segments.length === 0) {
            this.seekTo(timelineTime);
            return;
        }

        // Bu timeline zamanına karşılık gelen segment'i bul
        let elapsed = 0;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segDuration = seg.end - seg.start;

            if (elapsed + segDuration > timelineTime) {
                // Bu segment içinde
                const offsetInSegment = timelineTime - elapsed;
                const sourceTime = seg.start + offsetInSegment;
                const segSource = seg.sourceFile || Timeline.sourceFile;

                // Segment indeksini kaydet
                this._currentTimelineSegmentIndex = i;

                // Farklı kaynaktaysa geçiş yap
                if (segSource && segSource !== this.currentFilePath) {
                    console.log(`seekToTimelineTime: Farklı kaynağa geçiliyor: ${segSource}`);
                    this.switchToSource(segSource, sourceTime);
                } else {
                    this.video.currentTime = sourceTime;
                }
                return;
            }

            elapsed += segDuration;
        }

        // Sonun ötesinde ise son segment'in sonuna git
        const lastSeg = segments[segments.length - 1];
        const lastSource = lastSeg.sourceFile || Timeline.sourceFile;
        this._currentTimelineSegmentIndex = segments.length - 1;

        if (lastSource && lastSource !== this.currentFilePath) {
            this.switchToSource(lastSource, lastSeg.end - 0.1);
        } else {
            this.video.currentTime = lastSeg.end - 0.1;
        }
    },

    /**
     * Göreceli olarak atla (Timeline zamanı bazlı)
     * Farklı kaynaklı segmentleri destekler
     * @param {number} seconds - Atlama miktarı (pozitif veya negatif)
     */
    seekRelative(seconds) {
        if (!this.hasVideo()) return;

        const segments = Timeline.segments;
        const totalDuration = Timeline.getTotalDuration();

        if (!segments || segments.length === 0 || totalDuration <= 0) {
            // Segment yoksa normal seek
            const currentTime = this.video.currentTime;
            const newTime = Utils.clamp(currentTime + seconds, 0, this.video.duration || 0);
            this.video.currentTime = newTime;
            return;
        }

        // Mevcut timeline zamanını al
        const currentTimelineTime = this.getTimelineTime();

        // Yeni timeline zamanını hesapla
        let newTimelineTime = Utils.clamp(currentTimelineTime + seconds, 0, totalDuration);

        // Timeline zamanına git (bu fonksiyon doğru kaynağa geçişi de yapar)
        this.seekToTimelineTime(newTimelineTime);
    },

    // ==========================================
    // NAVİGASYON FONKSİYONLARI
    // ==========================================

    /**
     * Ok tuşu navigasyonu - akıllı davranış
     * Video çalıyorken: sadece konum değişir, oynatma devam eder
     * Video duraklatılmışken: konum değişir, kısa ses çalar, otomatik durur
     * @param {number} direction - 1: ileri, -1: geri
     * @param {number} stepSeconds - Kaç saniye atlanacak
     */
    /**
     * Ok tuşu navigasyonu - akıllı davranış
     * Video çalıyorken: sadece konum değişir, oynatma devam eder
     * Video duraklatılmışken: konum değişir, kısa ses çalar, otomatik durur
     * @param {number} direction - 1: ileri, -1: geri
     * @param {number} stepSeconds - Kaç saniye atlanacak
     * @param {boolean} isRepeating - Tuş basılı tutuluyor mu (seri tetikleme)
     */
    startScrubbing(direction, stepSeconds = 1, isRepeating = false) {
        if (!this.hasVideo()) return;

        // Video çalıyorsa sadece konum değiştir
        if (!this.video.paused) {
            this.seekRelative(direction * stepSeconds);
            return;
        }

        // Önceki timeout'u temizle
        if (this._audioScrubTimeout) {
            clearTimeout(this._audioScrubTimeout);
            this._audioScrubTimeout = null;
        }

        // Eğer tuş basılı tutuluyorsa (isRepeating): Eski davranış (Hızlı atla + kısa ses)
        if (isRepeating) {
            this.seekRelative(direction * stepSeconds);
            this.video.play().then(() => {
                this._audioScrubTimeout = setTimeout(() => {
                    this.video.pause();
                    this._audioScrubTimeout = null;
                }, 300); // Kısa ses (300ms)
            }).catch(err => console.log('Scrubbing play error:', err));
            return;
        }

        // isRepeating = false (Tek basım): Hassas Dinleme Modu
        const playDuration = stepSeconds * 1000; // ms cinsinden

        if (direction === 1) {
            // İLERİ: Oynatarak ilerle (Play Through)
            // Konumu değiştirmeden oynat, süre sonunda dur
            // Böylece hem içerik "tamamen" duyulur hem de imleç olması gereken yere (start + step) gelir.
            this.video.play().then(() => {
                this._audioScrubTimeout = setTimeout(() => {
                    this.video.pause();
                    this._audioScrubTimeout = null;
                    // Oynatma süresi sonunda imleç doğal olarak ileri gitmiş olacak
                }, playDuration);
            }).catch(err => console.log('Scrubbing play error:', err));

        } else {
            // GERİ: Atla ve Dinle (Move & Preview)
            // Kullanıcı geri gidip "neredeyim" diye duymak istiyor olabilir.
            // Önce geri git, sonra o kadar süreyi oynat.
            // Ama oynatınca imleç tekrar ileri (eski yerine) döner.
            // Bu yüzden oynatma bitince tekrar "yeni" konuma (geri gidilen yere) dönmeliyiz.

            const timelineTime = this.getTimelineTime();
            const targetTime = timelineTime - stepSeconds;

            // Hedefe git
            this.seekToTimelineTime(targetTime); // seekRelative yerine kesin hedef

            // Oynat (Preview)
            this.video.play().then(() => {
                this._audioScrubTimeout = setTimeout(() => {
                    this.video.pause();
                    this._audioScrubTimeout = null;
                    // ÖNEMLİ: Oynatma bitince kullanıcının gittiği yerde (geride) kalmasını sağla
                    this.seekToTimelineTime(targetTime);
                }, playDuration);
            }).catch(err => console.log('Scrubbing play error:', err));
        }
    },

    /**
     * Ok tuşu bırakıldığında - şimdilik bir şey yapma
     */
    stopScrubbing() {
        // Otomatik durma kullanıldığı için burada bir şey yapmaya gerek yok
    },

    // ==========================================
    // AUDIO SCRUBBING (Page Up/Down)
    // ==========================================

    /**
     * Audio scrubbing - Page Up/Down ile ses ile navigasyon
     * Basıldığında konum değişir, kısa süre ses çalar, otomatik durur
     * @param {number} direction - 1: ileri, -1: geri
     * @param {number} stepSeconds - Kaç saniye atlanacak
     */
    startAudioScrubbing(direction, stepSeconds = 1) {
        if (!this.hasVideo()) return;

        // Önceki timeout'u temizle (hızlı basımlar için)
        if (this._audioScrubTimeout) {
            clearTimeout(this._audioScrubTimeout);
            this._audioScrubTimeout = null;
        }

        // Konumu değiştir
        this.seekRelative(direction * stepSeconds);

        // Video'yu oynat (ses için)
        this.video.play().then(() => {
            // 500ms sonra otomatik duraklat
            this._audioScrubTimeout = setTimeout(() => {
                this.video.pause();
                this._audioScrubTimeout = null;
            }, 500);
        }).catch(err => {
            console.log('Audio scrubbing play error:', err);
        });
    },

    /**
     * Audio scrubbing durdur - artık kullanılmıyor (otomatik duruyor)
     */
    stopAudioScrubbing() {
        // Otomatik durma kullanıldığı için burada bir şey yapmaya gerek yok
    },

    /**
     * Başa git (İlk segment'in başına)
     * Farklı kaynaklı segmentleri destekler
     */
    goToStart() {
        const segments = Timeline.segments;

        if (segments && segments.length > 0) {
            // İlk segment'in başına git
            const firstSegment = segments[0];
            const firstSource = firstSegment.sourceFile || Timeline.sourceFile;

            // Segment indeksini sıfırla
            this._currentTimelineSegmentIndex = 0;

            // Farklı kaynaktaysa geçiş yap
            if (firstSource && firstSource !== this.currentFilePath) {
                console.log(`goToStart: Farklı kaynağa geçiliyor: ${firstSource}`);
                this.switchToSource(firstSource, firstSegment.start);
            } else {
                this.video.currentTime = firstSegment.start;
            }
            console.log(`goToStart: ${firstSegment.start.toFixed(2)}s`);
            Accessibility.announceNavigation('Başlangıç', 0);
        } else {
            // Segment yoksa video başına git
            this.seekTo(0);
            Accessibility.announceNavigation('Başlangıç', 0);
        }
    },

    /**
     * Sona git (Son segment'in sonuna)
     * Farklı kaynaklı segmentleri destekler
     */
    goToEnd() {
        const segments = Timeline.segments;

        if (segments && segments.length > 0) {
            // Son segment'in sonuna git (biraz önce, sonunda takılmasın)
            const lastSegment = segments[segments.length - 1];
            const lastSource = lastSegment.sourceFile || Timeline.sourceFile;

            // Segment indeksini son segmente ayarla
            this._currentTimelineSegmentIndex = segments.length - 1;

            // Farklı kaynaktaysa geçiş yap
            if (lastSource && lastSource !== this.currentFilePath) {
                console.log(`goToEnd: Farklı kaynağa geçiliyor: ${lastSource}`);
                this.switchToSource(lastSource, lastSegment.end - 0.2);
            } else {
                this.video.currentTime = lastSegment.end - 0.2;
            }
            console.log(`goToEnd: ${(lastSegment.end - 0.2).toFixed(2)}s`);
            Accessibility.announceNavigation('Son', Timeline.getTotalDuration());
        } else {
            // Segment yoksa video sonuna git
            if (this.video.duration) {
                this.seekTo(this.video.duration);
            }
            Accessibility.announceNavigation('Son', this.video.duration || 0);
        }
    },

    /**
     * Ortaya git (Timeline süresini kullan)
     * Farklı kaynaklı segmentleri destekler
     */
    goToMiddle() {
        const totalDuration = Timeline.getTotalDuration();
        if (totalDuration <= 0) return;

        const middleTime = totalDuration / 2;
        this.seekToTimelineTime(middleTime);
        Accessibility.announceNavigation('Orta nokta', middleTime);
    },

    /**
     * Sondan 30 saniye önceye git (Timeline süresini kullan)
     * Farklı kaynaklı segmentleri destekler
     */
    goToBeforeEnd() {
        const totalDuration = Timeline.getTotalDuration();
        if (totalDuration <= 0) return;

        const targetTimelineTime = Math.max(0, totalDuration - 30);
        this.seekToTimelineTime(targetTimelineTime);
        Accessibility.announceNavigation('Sondan 30 saniye önce', targetTimelineTime);
    },

    /**
     * Geçerli zamanı al
     * @returns {number} Geçerli zaman (saniye)
     */
    getCurrentTime() {
        return this.video ? this.video.currentTime : 0;
    },

    /**
     * Geçerli timeline zamanını al
     * Kaynak video zamanını timeline zamanına çevirir
     * Farklı kaynaklı segmentleri destekler - kümülatif süreyi hesaplar
     * @returns {number} Timeline zamanı (saniye)
     */
    getTimelineTime() {
        if (!this.video) return 0;

        const segments = Timeline.segments;
        if (!segments || segments.length === 0) {
            return this.video.currentTime;
        }

        const sourceTime = this.video.currentTime;
        const currentSource = this.currentFilePath;

        // Debug log - COMMENTED OUT TO REDUCE SPAM
        // console.log(`getTimelineTime: sourceTime=${sourceTime.toFixed(2)}, currentSource=${currentSource}`);
        // console.log(`getTimelineTime: segments=${segments.length}, segmentIndex=${this._currentTimelineSegmentIndex}`);

        // Öncelikle segment indeksine güven (daha güvenilir)
        if (this._currentTimelineSegmentIndex !== undefined &&
            this._currentTimelineSegmentIndex < segments.length) {
            const currentSeg = segments[this._currentTimelineSegmentIndex];
            const segSource = currentSeg.sourceFile || Timeline.sourceFile;

            // Mevcut segment doğru segment mi kontrol et
            if (segSource === currentSource &&
                sourceTime >= currentSeg.start - 0.5 &&
                sourceTime <= currentSeg.end + 0.5) {
                // Bu segment içindeyiz - kümülatif süreyi hesapla
                let elapsed = 0;
                for (let i = 0; i < this._currentTimelineSegmentIndex; i++) {
                    const seg = segments[i];
                    elapsed += (seg.end - seg.start);
                }
                const result = elapsed + Math.max(0, Math.min(sourceTime - currentSeg.start, currentSeg.end - currentSeg.start));
                // console.log(`getTimelineTime (by index ${this._currentTimelineSegmentIndex}): ${result.toFixed(2)}`);
                return result;
            }
        }

        // Segment indeksi yoksa veya uyuşmuyorsa, tam tarama yap
        let elapsed = 0;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segSource = seg.sourceFile || Timeline.sourceFile;
            const segDuration = seg.end - seg.start;

            if (segSource === currentSource &&
                sourceTime >= seg.start - 0.1 &&
                sourceTime <= seg.end + 0.1) {
                const result = elapsed + Math.max(0, Math.min(sourceTime - seg.start, segDuration));
                console.log(`getTimelineTime (by scan, seg ${i}): ${result.toFixed(2)}`);
                // Segment indeksini de güncelle
                this._currentTimelineSegmentIndex = i;
                return result;
            }
            elapsed += segDuration;
        }

        console.log(`getTimelineTime (fallback): ${elapsed.toFixed(2)}`);
        return elapsed; // Son segmentin sonundayız
    },

    /**
     * Toplam süreyi al (Timeline süresini kullan)
     * @returns {number} Toplam süre (saniye)
     */
    getDuration() {
        // Timeline varsa düzenlenmiş süreyi kullan
        const timelineDuration = Timeline.getTotalDuration();
        if (timelineDuration > 0) {
            return timelineDuration;
        }
        return this.video ? (this.video.duration || 0) : 0;
    },

    /**
     * İmleç pozisyonunu al
     * @returns {number} İmleç pozisyonu (saniye)
     */
    getCursorPosition() {
        return this.cursorPosition;
    },

    /**
     * Video yüklü mü?
     * @returns {boolean}
     */
    hasVideo() {
        return !!this.video.src && !isNaN(this.video.duration);
    },

    /**
     * Zaman göstergesini güncelle
     * Timeline zamanını gösterir (farklı kaynaklı segmentlerin kümülatif süresi)
     */
    updateTimeDisplay() {
        const currentTimeEl = document.getElementById('current-time');
        const totalDurationEl = document.getElementById('total-duration');
        const cursorPositionEl = document.getElementById('cursor-position');

        if (currentTimeEl) {
            // Timeline zamanını göster (kümülatif süre)
            const timelineTime = this.getTimelineTime();
            currentTimeEl.textContent = Utils.formatTime(timelineTime);
        }

        if (totalDurationEl) {
            // Timeline toplam süresini göster
            const totalDuration = Timeline.getTotalDuration();
            if (totalDuration > 0) {
                totalDurationEl.textContent = Utils.formatTime(totalDuration);
            } else if (this.video.duration) {
                totalDurationEl.textContent = Utils.formatTime(this.video.duration);
            }
        }

        // Timeline cursor güncelle
        this.updateTimelineCursor();
    },

    /**
     * İmleç göstergesini güncelle
     */
    updateCursorDisplay() {
        const cursorPositionEl = document.getElementById('cursor-position');
        if (cursorPositionEl) {
            cursorPositionEl.textContent = `İmleç: ${Utils.formatTime(this.cursorPosition)}`;
        }
    },

    /**
     * Oynatma durumu UI güncelle
     */
    updatePlayState() {
        const playStateEl = document.getElementById('play-state');
        if (playStateEl) {
            playStateEl.textContent = this.isPlaying ? 'Oynatılıyor' : 'Duraklatıldı';
        }

        if (this.onPlayStateChange) {
            this.onPlayStateChange(this.isPlaying);
        }
    },

    /**
     * Metadata göstergesini güncelle
     */
    updateMetadataDisplay() {
        if (!this.metadata) return;

        const resolutionEl = document.getElementById('meta-resolution');
        const framerateEl = document.getElementById('meta-framerate');
        const codecEl = document.getElementById('meta-codec');
        const sizeEl = document.getElementById('meta-size');

        if (resolutionEl) {
            resolutionEl.textContent = Utils.formatResolution(this.metadata.width, this.metadata.height);
        }
        if (framerateEl) {
            framerateEl.textContent = Utils.formatFrameRate(this.metadata.frameRate);
        }
        if (codecEl) {
            codecEl.textContent = this.metadata.codec || '-';
        }
        if (sizeEl) {
            sizeEl.textContent = Utils.formatFileSize(this.metadata.size);
        }
    },

    /**
     * Timeline cursor pozisyonunu güncelle
     */
    updateTimelineCursor() {
        const cursor = document.getElementById('timeline-cursor');
        const timeline = document.getElementById('timeline-visual');

        if (!cursor || !timeline || !this.video.duration) return;

        const percent = (this.video.currentTime / this.video.duration) * 100;
        cursor.style.left = `${percent}%`;
    },

    /**
     * Video placeholder'ı gizle
     */
    hideVideoPlaceholder() {
        const placeholder = document.getElementById('video-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
    },

    /**
     * UI güncelle
     */
    updateUI() {
        this.updateTimeDisplay();
        this.updatePlayState();
        this.updateCursorDisplay();
    },

    /**
     * Videoyu kaldır (dosya kapatıldığında)
     */
    unloadVideo() {
        if (this.video) {
            this.video.pause();
            this.video.src = '';
            this.video.load();
        }

        this.isPlaying = false;
        this.currentFilePath = null;
        this.metadata = null;
        this.cursorPosition = 0;

        // Placeholder'ı göster
        const placeholder = document.getElementById('video-placeholder');
        if (placeholder) {
            placeholder.style.display = 'flex';
        }

        // UI güncelle
        const totalDurationEl = document.getElementById('total-duration');
        if (totalDurationEl) {
            totalDurationEl.textContent = '00:00:00';
        }

        this.updateUI();
    },

    /**
     * Silinen kısımları atla ve farklı kaynaklı segmentler arası geçiş yap
     * Her seferinde mevcut konumu tüm segmentlerde arar
     */
    skipDeletedSegments() {
        // Kaynak değiştirme devam ediyorsa bekle
        if (this.ignoreTimeline || this._isLoadingSource) return;
        if (!this.isPlaying) return; // Sadece oynatma sırasında

        const currentTime = this.video.currentTime;
        const segments = Timeline.segments;
        const currentSource = this.currentFilePath;

        if (!segments || segments.length === 0) return;

        // Debounce - son geçişten bu yana 250ms geçmemişse atla
        const now = Date.now();
        if (this._lastTransitionTime && (now - this._lastTransitionTime) < 250) {
            return;
        }

        // Mevcut kaynaktan ve zamandan hangi segment içindeyiz?
        let foundSegmentIndex = -1;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segSource = seg.sourceFile || Timeline.sourceFile;

            // Bu segment mevcut kaynaktan mı?
            if (segSource === currentSource) {
                // Mevcut zaman bu segment içinde mi?
                if (currentTime >= seg.start - 0.1 && currentTime < seg.end) {
                    foundSegmentIndex = i;
                    break;
                }
            }
        }

        // Segment bulunamadıysa, belki segment sonundayız?
        if (foundSegmentIndex === -1) {
            // Segment sonuna vardık mı kontrol et
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                const segSource = seg.sourceFile || Timeline.sourceFile;

                if (segSource === currentSource) {
                    // Segment'in tam sonunda mıyız? (küçük toleransla)
                    if (currentTime >= seg.end - 0.2 && currentTime <= seg.end + 0.5) {
                        foundSegmentIndex = i;
                        break;
                    }
                }
            }
        }

        // Hala bulunamadıysa, kaynak uyuşmazlığı olabilir
        if (foundSegmentIndex === -1) {
            // Son bilinen segment'e dön
            if (this._currentTimelineSegmentIndex !== undefined &&
                this._currentTimelineSegmentIndex < segments.length) {
                const seg = segments[this._currentTimelineSegmentIndex];
                const segSource = seg.sourceFile || Timeline.sourceFile;
                console.log(`skipDeletedSegments: Segment bulunamadı, son bilinen: ${this._currentTimelineSegmentIndex}`);
                this.switchToSource(segSource, seg.start);
                this._lastTransitionTime = now;
            }
            return;
        }

        // Segment indeksini güncelle
        this._currentTimelineSegmentIndex = foundSegmentIndex;

        const currentSeg = segments[foundSegmentIndex];
        const isLastSegment = foundSegmentIndex === segments.length - 1;

        // Segment'in sonuna yaklaştık mı?
        if (currentTime >= currentSeg.end - 0.2) {
            if (isLastSegment) {
                // Son segment - proje sonu
                if (currentTime >= currentSeg.end - 0.1) {
                    this.pause();
                    Accessibility.announce('Proje sona erdi');
                    console.log('skipDeletedSegments: Proje sona erdi');
                }
                return;
            }

            // Sonraki segment'e geç
            const nextSegIndex = foundSegmentIndex + 1;
            const nextSeg = segments[nextSegIndex];
            const nextSource = nextSeg.sourceFile || Timeline.sourceFile;

            console.log(`skipDeletedSegments: Segment geçişi ${foundSegmentIndex} -> ${nextSegIndex} / ${segments.length}`);

            // Segment indeksini güncelle
            this._currentTimelineSegmentIndex = nextSegIndex;
            this._lastTransitionTime = now;

            // Kaynak farklıysa video'yu değiştir
            if (nextSource !== currentSource) {
                console.log(`  Farklı kaynağa geçiliyor: ${nextSource}`);
                this.switchToSource(nextSource, nextSeg.start);
            } else {
                // Aynı kaynak - sadece zaman atlat
                this.video.currentTime = nextSeg.start;
            }

            // Accessibility.announce(`Bölüm ${nextSegIndex + 1}`);
        }
    },

    /**
     * Farklı bir video kaynağına geç ve belirtilen zamana atla
     * @param {string} sourcePath - Yeni video dosyası yolu
     * @param {number} startTime - Başlangıç zamanı
     */
    async switchToSource(sourcePath, startTime) {
        const wasPlaying = this.isPlaying;

        // Kaynak değiştirme başladı - skipDeletedSegments'ı durdur
        this._isLoadingSource = true;

        try {
            // Video'yu duraklat
            this.video.pause();

            console.log(`switchToSource: ${sourcePath} -> ${startTime.toFixed(2)}s`);

            // Yeni kaynağı yükle
            await this.loadVideoSilent(sourcePath);

            // Belirtilen zamana atla
            this.video.currentTime = startTime;

            console.log(`switchToSource: Yükleme tamamlandı, currentTime=${this.video.currentTime.toFixed(2)}`);

            // Oynatmaya devam et
            if (wasPlaying) {
                this.video.play();
            }
        } catch (error) {
            console.error('switchToSource hatası:', error);
        } finally {
            // Kaynak değiştirme tamamlandı
            this._isLoadingSource = false;
        }
    },

    /**
     * Boş durum göster (yeni proje için)
     */
    showEmptyState() {
        // Video kaynağını temizle (hata tetiklemeden)
        if (this.video) {
            this.video.pause();
            // src'yi tamamen kaldır - boş string hata verir
            this.video.removeAttribute('src');
            // Kaynak olmadan load çağırmadan önce sourceları temizle
            while (this.video.firstChild) {
                this.video.removeChild(this.video.firstChild);
            }
        }

        this.isPlaying = false;
        this.metadata = null;
        this.currentFilePath = null;

        // Placeholder göster
        const placeholder = document.getElementById('video-placeholder');
        if (placeholder) {
            placeholder.style.display = 'flex';
            const pElement = placeholder.querySelector('p');
            if (pElement) {
                pElement.textContent = 'Yeni Proje - Video yapıştırın veya dosya açın';
            }
        }

        // UI güncelle
        this.updateUI();
    },

    /**
     * Video yükle (sessiz - duyuru yapmadan)
     * Sekme değiştirme ve yapıştırma sonrası kullanılır
     * @param {string} filePath - Dosya yolu
     * @returns {Promise} Video hazır olduğunda resolve olur
     */
    async loadVideoSilent(filePath) {
        return new Promise((resolve, reject) => {
            try {
                // Zaten aynı dosya yüklüyse/yükleniyorsa bekle veya atla
                if (this.currentFilePath === filePath && this.video.src) {
                    if (!isNaN(this.video.duration)) {
                        // Video zaten hazır
                        console.log('loadVideoSilent: Aynı video zaten yüklü');
                        resolve();
                        return;
                    } else {
                        // Video yükleniyor ama henüz hazır değil, metadata'yı bekle
                        console.log('loadVideoSilent: Aynı video yükleniyor, metadata bekleniyor...');
                        const waitForMetadata = () => {
                            this.video.removeEventListener('loadedmetadata', waitForMetadata);
                            this.video.removeEventListener('error', waitForError);
                            console.log('loadVideoSilent: Metadata hazır (bekleme sonucu)');
                            resolve();
                        };
                        const waitForError = (e) => {
                            this.video.removeEventListener('loadedmetadata', waitForMetadata);
                            this.video.removeEventListener('error', waitForError);
                            console.error('loadVideoSilent: Bekleme sırasında hata', e);
                            reject(e);
                        };
                        this.video.addEventListener('loadedmetadata', waitForMetadata);
                        this.video.addEventListener('error', waitForError);
                        return;
                    }
                }

                console.log('loadVideoSilent: Video yükleniyor:', filePath);

                // Video hazır olduğunda çağrılacak handler
                const onLoadedMetadata = () => {
                    console.log('loadVideoSilent: Video hazır, duration:', this.video.duration);
                    this.video.removeEventListener('loadedmetadata', onLoadedMetadata);
                    this.video.removeEventListener('error', onError);

                    // Placeholder gizle
                    const placeholder = document.getElementById('video-placeholder');
                    if (placeholder) {
                        placeholder.style.display = 'none';
                    }

                    resolve();
                };

                // Hata durumunda
                const onError = (e) => {
                    console.error('loadVideoSilent: Video yükleme hatası', e);
                    this.video.removeEventListener('loadedmetadata', onLoadedMetadata);
                    this.video.removeEventListener('error', onError);
                    reject(e);
                };

                this.video.addEventListener('loadedmetadata', onLoadedMetadata);
                this.video.addEventListener('error', onError);

                // Video kaynağını ayarla
                this.video.src = `file://${filePath}`;
                this.video.load();
                this.currentFilePath = filePath;

            } catch (error) {
                console.error('Sessiz video yükleme hatası:', error);
                reject(error);
            }
        });
    },

    /**
     * Video ses seviyesini ayarla
     * @param {number} volume - Ses seviyesi (0-1 arası)
     */
    setVolume(volume) {
        if (this.video) {
            this.video.volume = Math.min(1, Math.max(0, volume));
        }
    },

    /**
     * Mevcut sessizliği atla
     */
    async skipSilence() {
        if (!this.hasVideo()) return;

        const currentTime = this.video.currentTime;

        // Önce Dialogs'daki mevcut listeyi kontrol et
        let silences = (typeof Dialogs !== 'undefined') ? Dialogs.detectedSilences : [];
        let currentSilence = silences.find(s => currentTime >= s.start - 0.1 && currentTime < s.end);

        if (currentSilence) {
            this.video.currentTime = currentSilence.end;
            Accessibility.announce(`Sessizlik atlandı: ${Utils.formatTime(currentSilence.end)}`);
            if (!this.isPlaying) this.play();
            return;
        }

        // Liste yoksa veya içinde değilsek analiz yap
        Accessibility.announce('Sessizlik analiz ediliyor...');

        try {
            const result = await window.api.detectSilence({
                inputPath: this.currentFilePath,
                minDuration: 0.4,
                threshold: -30
            });

            if (result.success && result.data && result.data.length > 0) {
                const nowSilence = result.data.find(s => currentTime >= s.start - 0.2 && currentTime < s.end);
                if (nowSilence) {
                    this.video.currentTime = nowSilence.end;
                    Accessibility.announce(`Sessizlik atlandı: ${Utils.formatTime(nowSilence.end)}`);
                    if (!this.isPlaying) this.play();

                    // Bulunanları Dialogs'a da aktaralım ki bir sonrakinde hızlı olsun
                    if (typeof Dialogs !== 'undefined') Dialogs.detectedSilences = result.data;
                } else {
                    Accessibility.announce('Şu an sessiz bir alanda değilsiniz');
                }
            } else {
                Accessibility.announce('Sessizlik tespit edilemedi');
            }
        } catch (error) {
            console.error('skipSilence hatası:', error);
        }
    }
};

// Global olarak erişilebilir yap
window.VideoPlayer = VideoPlayer;
