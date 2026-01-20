/**
 * Klavye Modülü
 * Tüm klavye kısayollarının yönetimi (Konfigüre edilebilir)
 */

const Keyboard = {
    isEnabled: true,

    // Varsayılan Kısayol Tanımları
    // Mod: Ctrl (Win) veya Cmd (Mac)
    // Ctrl: Her zaman Ctrl
    // Alt: Alt/Option
    // Shift: Shift
    ACTIONS: {
        // --- Dosya (File) ---
        'newProject': { default: 'Mod+N', category: 'Dosya', label: 'Yeni Proje' },
        'openProject': { default: 'Ctrl+Shift+O', category: 'Dosya', label: 'Proje Aç (.kve)' },
        'saveProject': { default: 'Ctrl+Shift+P', category: 'Dosya', label: 'Projeyi Kaydet (.kve)' },
        'openVideo': { default: 'Mod+O', category: 'Dosya', label: 'Video Aç' },
        'saveVideo': { default: 'Mod+S', category: 'Dosya', label: 'Videoyu Kaydet/Dışa Aktar' },
        'saveAs': { default: 'Mod+Shift+S', category: 'Dosya', label: 'Farklı Kaydet' },
        'closeFile': { default: 'Ctrl+F4', category: 'Dosya', label: 'Dosyayı Kapat' },
        'tabNext': { default: 'Ctrl+Tab', category: 'Dosya', label: 'Sonraki Sekme' },
        'tabPrev': { default: 'Ctrl+Shift+Tab', category: 'Dosya', label: 'Önceki Sekme' },
        'closeTab': { default: 'Mod+W', category: 'Dosya', label: 'Sekmeyi Kapat' },
        'exitApp': { default: 'Alt+F4', category: 'Dosya', label: 'Çıkış' },

        // --- Düzenleme (Edit) ---
        'undo': { default: 'Mod+Z', category: 'Düzenleme', label: 'Geri Al' },
        'redo': { default: ['Mod+Shift+Z', 'Mod+Y'], category: 'Düzenleme', label: 'Yinele' },
        'cut': { default: 'Mod+X', category: 'Düzenleme', label: 'Kes' },
        'copy': { default: 'Mod+C', category: 'Düzenleme', label: 'Kopyala' },
        'paste': { default: 'Mod+V', category: 'Düzenleme', label: 'Yapıştır' },
        'delete': { default: ['Delete', 'Mod+D'], category: 'Düzenleme', label: 'Sil' },
        'selectAll': { default: 'Mod+A', category: 'Düzenleme', label: 'Tümünü Seç' },
        'addMarker': { default: 'M', category: 'İşaretçiler', label: 'İşaretçi Ekle' },
        'applyTransition': { default: ['ş', 'Ş'], category: 'Düzenleme', label: 'Varsayılan Geçiş Ekle' },
        'transitionLib': { default: 'Mod+Shift+T', category: 'Düzenleme', label: 'Geçiş Kütüphanesi' },
        'applyAllTrans': { default: 'Mod+T', category: 'Düzenleme', label: 'Tümüne Geçiş Uygula' },

        // --- Oynatma (Playback) ---
        'togglePlay': { default: 'Space', category: 'Oynatma', label: 'Oynat/Duraklat' },
        'playSelection': { default: 'Shift+Space', category: 'Oynatma', label: 'Seçimi Oynat' },
        'playCutPreview': { default: 'Ctrl+Shift+Space', category: 'Oynatma', label: 'Kesim Önizleme (Seçimsiz)' },
        'pauseAt': { default: 'K', category: 'Oynatma', label: 'Duraklat (İmleçsiz)' },
        'pauseAndSet': { default: 'Enter', category: 'Oynatma', label: 'Duraklat ve Konumla' },
        'skipSilence': { default: 'Mod+Shift+J', category: 'Oynatma', label: 'Sessizliği Atla' },

        // --- Navigasyon (Navigation) ---
        'scrubRight': { default: 'ArrowRight', category: 'Navigasyon', label: 'İleri (İnce)' },
        'scrubLeft': { default: 'ArrowLeft', category: 'Navigasyon', label: 'Geri (İnce)' },
        'scrubRight30': { default: 'Mod+ArrowRight', category: 'Navigasyon', label: '30 Saniye İleri' },
        'scrubLeft30': { default: 'Mod+ArrowLeft', category: 'Navigasyon', label: '30 Saniye Geri' },
        'scrubRight5m': { default: 'Mod+Alt+ArrowRight', category: 'Navigasyon', label: '5 Dakika İleri' },
        'scrubLeft5m': { default: 'Mod+Alt+ArrowLeft', category: 'Navigasyon', label: '5 Dakika Geri' },
        'seekF5': { default: 'PageDown', category: 'Navigasyon', label: '5 Saniye İleri' },
        'seekB5': { default: 'PageUp', category: 'Navigasyon', label: '5 Saniye Geri' },
        'goToStart': { default: ['Mod+ArrowUp', 'Ctrl+Home'], category: 'Navigasyon', label: 'Başa Git' },
        'goToEnd': { default: ['Mod+ArrowDown', 'Ctrl+End'], category: 'Navigasyon', label: 'Sona Git' },
        'goToMiddle': { default: ['Mod+Shift+Delete', 'Ctrl+Shift+Backspace'], category: 'Navigasyon', label: 'Ortaya Git' },
        'goToBeforeEnd': { default: 'Shift+Delete', category: 'Navigasyon', label: 'Sondan 30sn Önce' },
        'goToTime': { default: 'Mod+G', category: 'Navigasyon', label: 'Zaman Koduna Git' },
        'markerNext': { default: 'Alt+ArrowRight', category: 'İşaretçiler', label: 'Sonraki İşaretçi' },
        'markerPrev': { default: 'Alt+ArrowLeft', category: 'İşaretçiler', label: 'Önceki İşaretçi' },
        'changeFineTune': { default: 'Mod+Shift+F', category: 'Navigasyon', label: 'İnce Ayar Değiştir' },
        'sensIncr': { default: 'Alt+ArrowDown', category: 'Navigasyon', label: 'Hassasiyet Artır (-)' },
        'sensDecr': { default: 'Alt+ArrowUp', category: 'Navigasyon', label: 'Hassasiyet Azalt (+)' },

        // --- İşaretçiler (Markers) ---
        'deleteMarker': { default: null, category: 'İşaretçiler', label: 'İşaretçi Sil' },
        'clearAllMarkers': { default: null, category: 'İşaretçiler', label: 'Tüm İşaretçileri Temizle' },
        'markerList': { default: null, category: 'İşaretçiler', label: 'İşaretçi Listesi' },


        // --- Seçim (Selection) ---
        'selectRight': { default: 'Shift+ArrowRight', category: 'Seçim', label: 'Sağa Seçim (1sn)' },
        'selectLeft': { default: 'Shift+ArrowLeft', category: 'Seçim', label: 'Sola Seçim (1sn)' },
        'selectToStart': { default: ['Mod+Shift+ArrowUp', 'Ctrl+Shift+Home'], category: 'Seçim', label: 'Başa Kadar Seç' },
        'selectToEnd': { default: ['Mod+Shift+ArrowDown', 'Ctrl+Shift+End'], category: 'Seçim', label: 'Sona Kadar Seç' },
        'selectRange': { default: 'Mod+R', category: 'Seçim', label: 'Aralık Seç Diyaloğu' },
        'clearSelection': { default: 'Escape', category: 'Seçim', label: 'Seçimi Temizle / İptal' },
        'selectBetweenRight': { default: 'Mod+Shift+ArrowRight', category: 'Seçim', label: 'İşaretçiler Arası Sağa' },
        'selectBetweenLeft': { default: 'Mod+Shift+ArrowLeft', category: 'Seçim', label: 'İşaretçiler Arası Sola' },
        'selectToMarkerRight': { default: 'Ctrl+Shift+ArrowRight', category: 'Seçim', label: 'İşaretçiye Kadar Sağa' },
        'selectToMarkerLeft': { default: 'Ctrl+Shift+ArrowLeft', category: 'Seçim', label: 'İşaretçiye Kadar Sola' },

        // --- Araçlar (Tools) ---
        'insertList': { default: 'Mod+Shift+L', category: 'Araçlar', label: 'Ekleme Listesi / Kuyruk' },
        'objectAnalysis': { default: 'Mod+Shift+A', category: 'Araçlar', label: 'Nesne Analizi' },
        'listSilences': { default: 'Mod+Shift+B', category: 'Araçlar', label: 'Boşlukları Listele' },

        // --- Yapay Zeka (AI) ---
        'describeSelection': { default: 'Mod+Alt+D', category: 'Yapay Zeka', label: 'Seçimi Betimle' },
        'describePosition': { default: 'Mod+Alt+V', category: 'Yapay Zeka', label: 'Konumu Betimle' },
        'smartSelection': { default: 'Mod+I', category: 'Yapay Zeka', label: 'Akıllı Seçim' },

        // --- Yardım (Help) ---
        'shortcuts': { default: 'F1', category: 'Yardım', label: 'Kısayollar Listesi' },
        'help': { default: 'F2', category: 'Yardım', label: 'Kullanım Kılavuzu' },
        'keyboardManager': { default: 'Mod+K', category: 'Yardım', label: 'Klavye Yöneticisi' },

        // --- Genel (General) ---
        'contextMenu': { default: ['ContextMenu', 'Shift+F10'], category: 'Genel', label: 'Bağlam Menüsü' },
        'contextMenuAlt': { default: 'Mod+.', category: 'Genel', label: 'Bağlam Menüsü (Alt)' },
        'announceCurrentTime': { default: 'Mod+B', category: 'Genel', label: 'Mevcut Zamanı Oku' },

        // --- Atanmamış (Unassigned) - Kullanıcının ataması için ---
        'exportVideoOnly': { default: null, category: 'Dosya', label: 'Dışa Aktar: Sadece Video (Sessiz)' },
        'exportAudioOnly': { default: null, category: 'Dosya', label: 'Dışa Aktar: Sadece Ses (.mp3)' },
        'syncAudio': { default: null, category: 'Dosya', label: 'Harici Sesi Senkronla (A)' },
        'recordReference': { default: null, category: 'Dosya', label: 'Referans Sesle Kayıt (B)' },
        'videoProperties': { default: null, category: 'Düzenleme', label: 'Video Özellikleri' },
        'insertVideo': { default: null, category: 'Ekle', label: 'Video Ekle (Birleştir)' },
        'insertAudio': { default: null, category: 'Ekle', label: 'Ses Ekle / Dublaj' },
        'insertImage': { default: null, category: 'Ekle', label: 'Resim / Slayt Ekle' },
        'insertText': { default: null, category: 'Ekle', label: 'Metin / Başlık Ekle' },
        'openCtaLibrary': { default: 'Mod+Shift+K', category: 'Ekle', label: 'CTA / Overlay Kütüphanesi' },
        'insertVideoLayer': { default: 'Ctrl+Shift+V', category: 'Ekle', label: 'Video Katmanı (PiP)' },
        'insertSubtitle': { default: null, category: 'Ekle', label: 'Altyazı Ekle (.srt)' },
        'zoomIn': { default: null, category: 'Görünüm', label: 'Yakınlaştır (Timeline)' },
        'zoomOut': { default: null, category: 'Görünüm', label: 'Uzaklaştır (Timeline)' },
        'resetZoom': { default: null, category: 'Görünüm', label: 'Yakınlaştırmayı Sıfırla' },
        'rotateVideo': { default: null, category: 'Görünüm', label: 'Videoyu Döndür (90°)' },
    },

    /**
     * Modülü başlat
     */
    init() {
        // Capture phase kullan (true)
        document.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
        document.addEventListener('keyup', (e) => this.handleKeyUp(e), true);

        // Kullanıcı ayarlarından keymap yükle, yoksa boş obje
        this.userKeymap = Settings.get('userKeymap') || {};
    },

    setEnabled(enabled) {
        this.isEnabled = enabled;
    },

    // --- Kısayol Kontrol ve Yönetim ---

    /**
     * Bir aksiyon tetiklendi mi kontrol et
     * @param {string} actionId 
     * @param {KeyboardEvent} e 
     * @returns {boolean}
     */
    check(actionId, e) {
        const def = this.ACTIONS[actionId];
        if (!def) return false;

        // Kullanıcı override var mı?
        // userKeymap[actionId] undefined ise default'u kullan
        const bindings = this.userKeymap[actionId] !== undefined ? this.userKeymap[actionId] : def.default;

        // Binding tek string olabilir veya array olabilir
        const bindingList = Array.isArray(bindings) ? bindings : [bindings];

        // Listeden herhangi biri uyuyor mu?
        return bindingList.some(binding => this.matchesBinding(e, binding));
    },

    /**
     * Bir event, spesifik bir binding string ile eşleşiyor mu?
     * @param {KeyboardEvent} e 
     * @param {string} binding 
     */
    matchesBinding(e, binding) {
        if (!binding) return false;

        const parts = binding.split('+').map(p => p.trim().toLowerCase());
        const key = parts[parts.length - 1]; // Son parça asıl tuş

        // Modifiers (beklenen)
        // Mod: Mac ise Meta, Win ise Ctrl
        const isMac = navigator.userAgent.includes('Mac');

        const reqCtrl = parts.includes('ctrl') || (!isMac && parts.includes('mod'));
        const reqMeta = parts.includes('meta') || parts.includes('cmd') || (isMac && parts.includes('mod'));
        const reqAlt = parts.includes('alt') || parts.includes('option');
        const reqShift = parts.includes('shift');

        // Event durumu
        const eventCtrl = e.ctrlKey;
        const eventMeta = e.metaKey;
        const eventAlt = e.altKey;
        const eventShift = e.shiftKey;

        // Eşleşme kontrolü
        if (eventCtrl !== reqCtrl) return false;
        if (eventMeta !== reqMeta) return false;
        if (eventAlt !== reqAlt) return false;
        if (eventShift !== reqShift) return false;

        // Tuş kontrolü
        if (key === 'space') return e.key === ' ';
        if (key === 'plus') return e.key === '+';

        // e.key genellikle case-sensitive (ör. 'a' veya 'A'). 
        // Ancak Shift basılıyken 'A' gelir, shift yokken 'a' gelir.
        // Bizim logic'te shift modifier olarak zaten kontrol ediliyor.
        // Bu yüzden e.key'i lowercase yapıp karşılaştırabiliriz.
        // Not: 'ArrowRight' gibi tuşlar lowercase olunca 'arrowright' olur.
        return e.key.toLowerCase() === key;
    },

    /**
     * Event nesnesini okunabilir string'e çevir (Örn: "Ctrl+Shift+G")
     * Klavye yöneticisinde yeni kısayol kaydederken kullanılır.
     */
    eventToString(e) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.metaKey) parts.push('Meta'); // Kullanıcıya Meta/Cmd gösterebiliriz
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        let key = e.key;
        if (key === ' ') key = 'Space';
        // Modifier tuşlarının kendisi basıldığında işlem yapma
        if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(key)) return null;

        // İlk harfi büyük yap
        if (key.length === 1) key = key.toUpperCase();
        else key = key.charAt(0).toUpperCase() + key.slice(1);

        parts.push(key);

        return parts.join('+');
    },

    // --- Olay İşleyicisi ---

    handleKeyDown(e) {
        if (!this.isEnabled) return;

        const target = e.target;
        const dialogOpen = this.isDialogOpen();
        const inputFocused = this.isInputFocused(target);

        // --- Diyalog/Input Engelleme Kuralları ---
        // Bu kurallar, diyaloğa veya input'a odaklıyken video kontrollerinin çalışmasını engeller
        // ancak Copy/Paste gibi temel kısayollara izin verir.
        if (dialogOpen || inputFocused) {
            // Escape her zaman geçmeli ki diyaloğu kapatabilsin (aşağıda check ediliyor)
            if (e.key === 'Escape') {
                // Fall throw
            }
            // Metin düzenleme kısayolları (izin ver)
            else if (this.check('copy', e) || this.check('paste', e) || this.check('cut', e) || this.check('selectAll', e) || this.check('undo', e) || this.check('redo', e)) {
                return; // Tarayıcı işlesin
            }
            // Alt+P (Önizleme) -> Dialog içinde kullanılıyor, izin ver (return)
            else if (e.altKey && e.key.toLowerCase() === 'p') { return; }

            // Eğer modifier yoksa (sadece harf veya sayı) ve input odaklıysa
            else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                // Space ve Enter özel: VideoPlayer'ı tetikleyebilir, o yüzden durdur.
                // Input içinde space basınca scroll olmasın veya video oynamasın
                if (e.key === ' ' || e.key === 'Enter') {
                    // Eğer odaklanılan eleman butonsa, enter/space işlesin (bırakalım browser click yapsın)
                    if (target.tagName === 'BUTTON' || (target.tagName === 'INPUT' && target.type === 'button') || target.getAttribute('role') === 'button') {
                        return;
                    }
                    e.stopImmediatePropagation();
                    return; // Input işlesin
                }
                return; // Diğer harfleri input işlesin
            }
            else {
                // Diğer tüm kısayolları input içindeyken yutalım mı?
                // Hayır, "Ctrl+S" (Kaydet) gibi genel kısayollar çalışmalı mı? 
                // Diyalog açıkken arka planda işlem yapılması istenmeyebilir.
                // Bu yüzden Escape hariç durduralım.
                if (e.key !== 'Escape') {
                    // Ancak: Navigation gibi bazı tuşlar (Arrow) input içinde gezinti için gerekli.
                    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                        return; // İzin ver
                    }
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
            }
        }

        let handled = false;

        // --- EYLEMLERİN YÜRÜTÜLMESİ ---
        // Sıra önemlidir (öncelik sırası)

        // Yardım / Menü
        if (this.check('keyboardManager', e)) { Dialogs.showKeyboardManagerDialog(); handled = true; } // YENİ
        else if (this.check('shortcuts', e)) { Dialogs.showShortcutsDialog(); handled = true; }
        else if (this.check('help', e)) { Dialogs.showHelpDialog(); handled = true; }
        else if (this.check('contextMenu', e) || this.check('contextMenuAlt', e)) { this.showContextMenu(); handled = true; }
        else if (this.check('announceCurrentTime', e)) {
            const time = VideoPlayer.getTimelineTime();
            Accessibility.announce(`Şu anki konum: ${Utils.formatTimeForSpeech(time)}`);
            handled = true;
        }

        // Dosya
        else if (this.check('newProject', e)) { App.newProject(); handled = true; }
        else if (this.check('tabNext', e)) { TabManager.nextTab(); handled = true; }
        else if (this.check('tabPrev', e)) { TabManager.prevTab(); handled = true; }
        else if (this.check('closeTab', e)) { App.closeTabWithConfirm(TabManager.activeTabIndex); handled = true; }
        else if (this.check('closeFile', e)) { App.handleFileCloseRequest(); handled = true; }
        // Sekme 1-9
        else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key >= '1' && e.key <= '9') {
            TabManager.switchToTabByNumber(parseInt(e.key)); handled = true;
        }

        // Navigasyon (Scrubbing için 'repeat' bilgisi önemli)
        else if (this.check('scrubRight', e)) { VideoPlayer.startScrubbing(1, Settings.getNavigationStep(), e.repeat); handled = true; }
        else if (this.check('scrubLeft', e)) { VideoPlayer.startScrubbing(-1, Settings.getNavigationStep(), e.repeat); handled = true; }
        else if (this.check('scrubRight30', e)) { VideoPlayer.startScrubbing(1, 30, e.repeat); handled = true; }
        else if (this.check('scrubLeft30', e)) { VideoPlayer.startScrubbing(-1, 30, e.repeat); handled = true; }
        else if (this.check('scrubRight5m', e)) { VideoPlayer.startScrubbing(1, 300, e.repeat); handled = true; }
        else if (this.check('scrubLeft5m', e)) { VideoPlayer.startScrubbing(-1, 300, e.repeat); handled = true; }

        else if (this.check('seekF5', e)) { VideoPlayer.seekRelative(5); handled = true; }
        else if (this.check('seekB5', e)) { VideoPlayer.seekRelative(-5); handled = true; }

        else if (this.check('goToStart', e)) { VideoPlayer.goToStart(); handled = true; }
        else if (this.check('goToEnd', e)) { VideoPlayer.goToEnd(); handled = true; }
        else if (this.check('goToTime', e)) { Dialogs.showGotoDialog(); handled = true; }

        else if (this.check('listSilences', e)) { Dialogs.showSilenceParamsDialog(); handled = true; }
        else if (this.check('skipSilence', e)) { VideoPlayer.skipSilence(); handled = true; }

        else if (this.check('goToBeforeEnd', e)) { VideoPlayer.goToBeforeEnd(); handled = true; }
        else if (this.check('goToMiddle', e)) { VideoPlayer.goToMiddle(); handled = true; }
        else if (this.check('changeFineTune', e)) { Dialogs.showFineTuneDialog(); handled = true; }

        else if (this.check('markerNext', e)) { Markers.goToNext(); handled = true; }
        else if (this.check('markerPrev', e)) { Markers.goToPrevious(); handled = true; }
        else if (this.check('sensIncr', e)) {
            const n = Settings.decreaseNavigationStep();
            Accessibility.announce(`Hassasiyet artırıldı: ${Utils.formatTimeForSpeech(n)}`);
            handled = true;
        }
        else if (this.check('sensDecr', e)) {
            const n = Settings.increaseNavigationStep();
            Accessibility.announce(`Hassasiyet azaltıldı: ${Utils.formatTimeForSpeech(n)}`);
            handled = true;
        }

        // Oynatma
        else if (this.check('togglePlay', e)) { VideoPlayer.togglePlay(); handled = true; }
        else if (this.check('pauseAt', e)) { VideoPlayer.pauseAtCurrentPosition(); handled = true; }
        else if (this.check('pauseAndSet', e)) { VideoPlayer.pauseAtCurrentPosition(); handled = true; }
        else if (this.check('playSelection', e)) { VideoPlayer.playSelection(); handled = true; }
        else if (this.check('playCutPreview', e)) { VideoPlayer.playCutPreview(); handled = true; }

        // Düzenleme / İşaretçiler
        else if (this.check('addMarker', e)) { Markers.addAtCurrentTime(); handled = true; }
        else if (this.check('applyTransition', e)) { Transitions.applyAtCurrentTime(); handled = true; }
        else if (this.check('transitionLib', e)) { Dialogs.showTransitionLibraryDialog(); handled = true; }
        else if (this.check('applyAllTrans', e)) { App.applyAllTransitions(); handled = true; }

        else if (this.check('delete', e)) { App.delete(); handled = true; }
        else if (this.check('cut', e)) { App.cut(); handled = true; }
        else if (this.check('copy', e)) { App.copy(); handled = true; }
        else if (this.check('paste', e)) { App.paste(); handled = true; }
        else if (this.check('undo', e)) { App.undo(); handled = true; }
        else if (this.check('redo', e)) { App.redo(); handled = true; }
        else if (this.check('deleteMarker', e)) { Markers.removeAtCurrentTime(); handled = true; }
        else if (this.check('clearAllMarkers', e)) {
            Dialogs.showAccessibleConfirm('Onay', 'Tüm işaretçiler silinsin mi?').then(confirmed => {
                if (confirmed) Markers.clearAll();
            });
            handled = true;
        }
        else if (this.check('markerList', e)) { Dialogs.showMarkerListDialog(); handled = true; }


        // Seçim
        else if (this.check('selectRight', e)) { Selection.extend(Settings.getNavigationStep()); handled = true; }
        else if (this.check('selectLeft', e)) { Selection.extend(-Settings.getNavigationStep()); handled = true; }
        else if (this.check('selectBetweenRight', e)) { Selection.selectBetweenMarkers('expand'); handled = true; }
        else if (this.check('selectBetweenLeft', e)) { Selection.selectBetweenMarkers('shrink'); handled = true; }
        else if (this.check('selectToMarkerRight', e)) { Selection.selectToMarker('next'); handled = true; }
        else if (this.check('selectToMarkerLeft', e)) { Selection.selectToMarker('prev'); handled = true; }
        else if (this.check('selectToStart', e)) { Selection.selectTo('start'); handled = true; }
        else if (this.check('selectToEnd', e)) { Selection.selectTo('end'); handled = true; }
        else if (this.check('selectRange', e)) { Dialogs.showRangeDialog(); handled = true; }
        else if (this.check('selectAll', e)) { Selection.selectAll(); handled = true; }

        else if (this.check('clearSelection', e)) {
            if (this.isDialogOpen()) this.closeOpenDialog();
            else Selection.clear();
            handled = true;
        }

        // Araçlar / Ekle / Dışa Aktar (Yeni eklenenler)
        else if (this.check('insertList', e)) { Dialogs.showInsertionQueueDialog(); handled = true; }
        else if (this.check('objectAnalysis', e)) {
            const d = document.getElementById('object-analysis-dialog');
            if (d) d.showModal();
            handled = true;
        }
        else if (this.check('exportVideoOnly', e)) { App.exportVideoOnly(); handled = true; }
        else if (this.check('exportAudioOnly', e)) { App.exportAudioOnly(); handled = true; }
        else if (this.check('videoProperties', e)) { Dialogs.showVideoPropertiesDialog(); handled = true; }
        else if (this.check('openProject', e)) { App.loadProject(); handled = true; }
        else if (this.check('saveProject', e)) { App.saveProject(); handled = true; }
        else if (this.check('syncAudio', e)) { window.api.openSyncWizard('A'); handled = true; }
        else if (this.check('recordReference', e)) { window.api.openSyncWizard('B'); handled = true; }
        else if (this.check('openVideo', e)) { App.openFile(); handled = true; }
        else if (this.check('saveVideo', e)) { App.saveFile(); handled = true; }
        else if (this.check('saveAs', e)) { App.saveFileAs(); handled = true; }
        else if (this.check('exitApp', e)) { App.handleAppQuitRequest(); handled = true; }

        else if (this.check('insertVideo', e)) { if (VideoPlayer.hasVideo()) App.insertVideo(); else Accessibility.alert('Önce video açın'); handled = true; }
        else if (this.check('insertAudio', e)) { if (VideoPlayer.hasVideo()) Dialogs.showAudioSourceSelectionDialog(); else Accessibility.alert('Önce video açın'); handled = true; }
        else if (this.check('insertImage', e)) { if (VideoPlayer.hasVideo()) Dialogs.showImageWizard(); else Accessibility.alert('Önce video açın'); handled = true; }
        else if (this.check('insertText', e)) {
            if (VideoPlayer.hasVideo()) {
                window.api.openTextOverlayDialog({ startTime: VideoPlayer.getCurrentTime(), videoPath: App.currentFilePath });
            } else Accessibility.alert('Önce video açın');
            handled = true;
        }
        else if (this.check('insertSubtitle', e)) { App.insertSubtitle(); handled = true; }
        else if (this.check('insertVideoLayer', e)) {
            if (VideoPlayer.hasVideo()) {
                // Video seçim dialogunu aç
                window.api.openFileDialog({
                    title: 'Video Katmanı Seç (Picture-in-Picture)',
                    filters: [{ name: 'Video Dosyaları', extensions: ['mp4', 'wmv', 'avi', 'mkv', 'mov', 'webm'] }],
                    properties: ['openFile']
                }).then(result => {
                    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                        Dialogs.showVideoLayerWizard(result.filePaths[0]);
                    }
                });
            } else {
                Accessibility.alert('Önce bir video açmalısınız');
            }
            handled = true;
        }

        else if (this.check('openCtaLibrary', e)) {
            if (VideoPlayer.hasVideo()) {
                Dialogs.showCtaLibraryDialog();
            } else {
                Accessibility.alert('Önce bir video açın.');
            }
            handled = true;
        }

        else if (this.check('zoomIn', e)) { Timeline.zoomIn(); handled = true; }
        else if (this.check('zoomOut', e)) { Timeline.zoomOut(); handled = true; }
        else if (this.check('resetZoom', e)) { Timeline.resetZoom(); handled = true; }
        else if (this.check('rotateVideo', e)) { App.rotateVideo(90); handled = true; }
        // Yapay Zeka
        else if (this.check('describeSelection', e)) { Dialogs.showAIDescriptionDialog(); handled = true; }
        else if (this.check('describePosition', e)) { App.describeCurrentPosition(); handled = true; }
        else if (this.check('smartSelection', e)) { Dialogs.showAIDialog(); handled = true; }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    },

    handleKeyUp(e) {
        if (!this.isEnabled) return;

        // Scrubbing durdurma logic'i
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            if (VideoPlayer.isScrubbing) {
                VideoPlayer.stopScrubbing();
                e.preventDefault();
                e.stopPropagation();
            }
        }
    },

    // --- Helper Functions ---
    isInputFocused(el) {
        const active = el || document.activeElement;
        if (!active) return false;
        if (active.isContentEditable) return true;
        const tag = active.tagName ? active.tagName.toUpperCase() : '';
        return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.getAttribute('role') === 'listbox' || active.getAttribute('role') === 'option' || active.closest('[role="listbox"]'));
    },

    isDialogOpen() {
        const dialogs = document.querySelectorAll('dialog[open]');
        if (dialogs.length > 0) return true;
        const wizard = document.getElementById('image-wizard-dialog');
        if (wizard && (wizard.hasAttribute('open') || wizard.open)) return true;
        const vlWizard = document.getElementById('video-layer-wizard-dialog');
        if (vlWizard && (vlWizard.hasAttribute('open') || vlWizard.open)) return true;
        return false;
    },

    closeOpenDialog() {
        const dialog = document.querySelector('dialog[open]');
        if (dialog) dialog.close();
    },

    showContextMenu() {
        // Aktif element üzerinde contextmenu olayını tetikle
        const active = document.activeElement;
        if (active) {
            const ev = new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                view: window,
                buttons: 2,
                clientX: active.getBoundingClientRect().x + 5,
                clientY: active.getBoundingClientRect().y + 5
            });
            active.dispatchEvent(ev);
        }
    },

    // --- Yapılandırma ---
    getAllActions() {
        return this.ACTIONS;
    },

    getUserKeymap() {
        return this.userKeymap;
    },

    setUserKeymap(keymap) {
        this.userKeymap = keymap;
        Settings.set('userKeymap', keymap);
        Accessibility.announce('Klavye ayarları güncellendi');
    },

    resetUserKeymap() {
        this.userKeymap = {};
        Settings.set('userKeymap', {});
    },

    getActionShortcut(actionId) {
        if (this.userKeymap[actionId]) return this.userKeymap[actionId];
        return this.ACTIONS[actionId]?.default;
    }
};

window.Keyboard = Keyboard;
