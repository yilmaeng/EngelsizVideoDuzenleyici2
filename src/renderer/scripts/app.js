/**
 * Ana Uygulama Modülü
 * Tüm modülleri başlatır ve koordine eder
 */

const App = {
    isReady: false,
    currentFilePath: null,
    originalFilePath: null, // Orijinal dosya (değişiklikler için)
    hasChanges: false, // Kaydedilmemiş değişiklik var mı?
    isOpeningFile: false, // Dosya açma işlemi sürüyor mu?
    clipboard: null, // {type: 'video'|'audio', start, end, data}
    undoStack: [],
    redoStack: [],

    /**
     * Uygulamayı başlat
     */
    init() {
        // Modülleri başlat
        Settings.init(); // Ayarları yükle (ilk)
        Accessibility.init();
        Utils; // Statik modül
        VideoPlayer.init();
        Markers.init();
        Transitions.init();
        Selection.init();
        Dialogs.init();
        Keyboard.init();
        TabManager.init();
        StatusBar.init();

        // VideoPlayer hata callback'lerini ayarla
        // NOT: Artık smartOpenVideo kullanıldığı için, dosya açma aşamasında
        // zaten uyumluluk kontrolü yapılıyor. Bu callback sadece oynatma 
        // sırasındaki beklenmedik hatalar için.
        VideoPlayer.onConversionNeeded = (filePath, errorMessage) => {
            console.warn('VideoPlayer oynatma hatası (smartOpen zaten uygulandı):', errorMessage);
            // Sadece kullanıcıya bilgi ver, dönüştürme önerme
            Accessibility.announceError('Video oynatma hatası: ' + errorMessage);
        };

        // IPC event'lerini dinle
        this.setupIpcListeners();

        // Klavye Kısayolları (Proje Yönetimi)
        window.addEventListener('keydown', (e) => {
            // Ctrl+Shift+P: Projeyi Kaydet (.kve)
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                this.saveProject();
            }
            // Ctrl+Shift+O: Proje Aç (.kve)
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                this.loadProject();
            }
            // Ctrl+S: Güvenli Kaydet (Doğrudan Çağrı)
            if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                console.log('Ctrl+S Manual Trigger');
                this.saveFile();
            }
            // NOT: Ctrl+Shift+S (Videoyu Farklı Kaydet) menü tarafından handle ediliyor
        });

        // Hazır
        this.isReady = true;
        console.log('Engelsiz Video Düzenleyicisi başlatıldı');
        Accessibility.announce('Engelsiz Video Düzenleyicisi hazır. Video açmak için Control artı O tuşlarına basın. Temel klavye kısayollarını öğrenmek için F1\'e basın. Bir video açtığınızda içerisinde yön tuşlarıyla dolaşıp, boşluk, enter gibi tuşlarla duraklama yapmak, dilediğiniz aralıkları seçmek, istediğiniz noktalara M ile yer işareti koymak için, ekran okuyucu kullanıyorsanız, tarama kipini kapatmanız gerekebilir.');
    },

    /**
     * IPC event dinleyicilerini kur
     */
    setupIpcListeners() {
        // Yeni proje
        window.api.onFileNew(() => {
            this.newProject();
        });

        // Proje Kaydet/Aç (.kve)
        window.api.onProjectSave(() => {
            this.saveProject();
        });
        window.api.onProjectOpen(() => {
            this.loadProject();
        });

        // Dosya işlemleri
        window.api.onFileOpen((filePath) => {
            this.openFile(filePath);
        });

        window.api.onFileSave(() => {
            this.saveFile();
        });

        window.api.onFileSaveAs((filePath) => {
            this.saveFileAs(filePath);
        });

        window.api.onFileSaveSelection((filePath) => {
            this.saveSelection(filePath);
        });

        window.api.onExportVideoOnly((filePath) => {
            this.exportVideoOnly(filePath);
        });

        window.api.onExportAudioOnly((filePath) => {
            this.exportAudioOnly(filePath);
        });

        // Düzenleme işlemleri
        window.api.onEditUndo(() => this.undo());
        window.api.onEditRedo(() => this.redo());
        window.api.onEditCut(() => this.cut());
        window.api.onEditCopy(() => this.copy());
        window.api.onEditPaste(() => this.paste());
        window.api.onEditDelete(() => this.delete());

        // Seçim işlemleri
        window.api.onSelectAll(() => Selection.selectAll());
        window.api.onSelectClear(() => Selection.clear());
        window.api.onSelectRangeDialog(() => Dialogs.showRangeDialog());
        window.api.onSelectBetweenMarkers(() => Selection.selectBetweenMarkers());
        window.api.onIntelligentSelection(() => Dialogs.showAIDialog());

        // Ekleme işlemleri
        window.api.onInsertAudio((filePath) => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }
            Dialogs.showAudioAddDialog(filePath);
        });


        window.api.onInsertVideo((filePath) => {
            this.insertVideo(filePath);
        });


        // Ses Ekle (Dosya veya Kayıt Seçimi)
        window.api.onInsertAudioRequest(async () => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }

            // Kullanıcıya seçenek sun: Dosya seç veya Kaydet
            const choice = await window.api.showMessageBox({
                type: 'question',
                title: 'Ses Ekle',
                message: 'Ses nasıl eklenmesini istersiniz?',
                buttons: ['Dosya Seç', 'Kayıt Yap', 'İptal'],
                defaultId: 0,
                cancelId: 2
            });

            if (choice.response === 0) {
                // Dosya seç
                const result = await window.api.openFileDialog({
                    title: 'Ses Dosyası Seç',
                    filters: [
                        { name: 'Ses Dosyaları', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'] },
                        { name: 'Tüm Dosyalar', extensions: ['*'] }
                    ],
                    properties: ['openFile']
                });

                console.log('File dialog result:', result);

                if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
                    const audioPath = result.filePaths[0];
                    console.log('Selected audio path:', audioPath);

                    if (audioPath) {
                        await Dialogs.showAudioAddDialog(audioPath);
                    } else {
                        console.error('Audio path is undefined');
                        Accessibility.alert('Ses dosyası seçilemedi');
                    }
                } else {
                    console.log('No file selected or dialog canceled');
                }
            } else if (choice.response === 1) {
                // Kayıt yap
                Dialogs.showAudioRecorderDialog();
            }
        });


        window.api.onInsertTextDialog(async () => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }
            // Ayrı pencerede dialog aç
            const startTime = VideoPlayer.getCurrentTime();
            await window.api.openTextOverlayDialog({ startTime, videoPath: this.currentFilePath });
            // Dialog artık kendi içinde listeye ekliyor veya doğrudan uyguluyor
        });

        window.api.onInsertImages((filePaths) => {
            Dialogs.showImagesDialog(filePaths);
        });

        window.api.onOpenImageWizard(() => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }
            Dialogs.showImageWizard();
        });

        window.api.onInsertSubtitle((filePath) => {
            this.insertSubtitle(filePath);
        });

        // Görünüm işlemleri
        window.api.onRotateVideo((degrees) => {
            this.rotateVideo(degrees);
        });

        // Helper: Video kontrolü yapılabilir mi? (Diyalog açık değilse VE input/liste odaklı değilse)
        const isDialogOpen = () => document.querySelectorAll('dialog[open]').length > 0;
        const canControlVideo = () => !isDialogOpen() && !Keyboard.isInputFocused();

        // Navigasyon işlemleri
        window.api.onGotoTimeDialog(() => Dialogs.showGotoDialog());
        window.api.onGotoStart(() => { if (!isDialogOpen()) VideoPlayer.goToStart(); });

        // Video Yolu İsteği (Main Process için)
        window.api.onGetCurrentVideoPath(() => {
            window.api.sendCurrentVideoPath(VideoPlayer.currentFilePath);
        });

        window.api.onGotoEnd(() => { if (!isDialogOpen()) VideoPlayer.goToEnd(); });
        window.api.onGotoMiddle(() => { if (!isDialogOpen()) VideoPlayer.goToMiddle(); });
        window.api.onGotoNextMarker(() => { if (!isDialogOpen()) Markers.goToNext(); });
        window.api.onGotoPrevMarker(() => { if (!isDialogOpen()) Markers.goToPrevious(); });
        window.api.onGotoSelectionStart(() => { if (!isDialogOpen()) Selection.jumpToStart(); });
        window.api.onGotoSelectionEnd(() => { if (!isDialogOpen()) Selection.jumpToEnd(); });

        // İşaretçi işlemleri
        window.api.onMarkerAdd(() => { if (!isDialogOpen()) Markers.addAtCurrentTime(); });
        window.api.onMarkerDelete(() => { if (!isDialogOpen()) Markers.removeAtCurrentTime(); });
        window.api.onMarkerClearAll(() => { if (!isDialogOpen()) Markers.clearAll(); });
        window.api.onMarkerListDialog(() => {
            if (isDialogOpen()) return;
            // İşaretçi listesi diyaloğu
            const markerList = document.getElementById('marker-list');
            markerList.focus();
            Accessibility.announce(`${Markers.getCount()} işaretçi mevcut`);
        });

        // Yardım
        window.api.onShowShortcuts(() => Dialogs.showShortcutsDialog());
        window.api.onShowKeyboardManager(() => Dialogs.showKeyboardManagerDialog());

        window.api.onShowHelp(() => {
            Dialogs.showHelpDialog();
        });

        // İnce Ayar diyaloğu
        window.api.onShowFineTuneDialog(() => Dialogs.showFineTuneDialog());

        // FFmpeg ilerleme
        window.api.onFfmpegProgress((data) => {
            this.updateProgress(data.operation, data.percent);
        });

        // FFmpeg Log
        window.api.onFfmpegLog((message) => {
            StatusBar.log(message);
        });

        // Uygulama hazır
        window.api.onAppReady((data) => {
            if (data.accessibilityEnabled) {
                console.log('Erişilebilirlik özellikleri etkin');
            }
        });

        // Dosya kapatma isteği
        window.api.onFileCloseRequest(async () => {
            await this.handleFileCloseRequest();
        });

        // Uygulama kapatma isteği
        window.api.onAppQuitRequest(async () => {
            await this.handleAppQuitRequest();
        });

        // Video özellikleri diyaloğu
        window.api.onEditVideoProperties(() => {
            Dialogs.showVideoPropertiesDialog();
        });

        // Boşlukları listele
        window.api.onEditListSilences(() => {
            Dialogs.showSilenceParamsDialog();
        });

        // Sessizliği atla
        window.api.onPlaybackSkipSilence(() => {
            VideoPlayer.skipSilence();
        });

        // Seçimi AI ile betimle
        window.api.onEditDescribeSelection(() => {
            Dialogs.showAIDescriptionDialog();
        });

        // Akıllı Seçim Kontrolü
        window.api.onIntelligentSelection(() => {
            // Gelecek özellik: Seçimi içeriğe göre (sessizlik, sahne değişimi vb.) optimize et
            Accessibility.announce('Akıllı seçim kontrolü özelliği yakında eklenecek.');
            // Veya basit bir işlem:
            const selection = Selection.getSelection();
            if (selection && selection.start !== selection.end) {
                // Seçimi en yakın 1 saniyeye yuvarla (basit "akıllı" davranış)
                let start = Math.round(selection.start);
                let end = Math.round(selection.end);
                if (start === end) end += 1;
                Selection.setSelection(start, end);
                Accessibility.announce(`Seçim tam saniyelere yuvarlandı: ${Utils.formatTime(start)} - ${Utils.formatTime(end)}`);
            } else {
                Accessibility.announce('Önce bir alan seçmelisiniz.');
            }
        });

        // Gemini API anahtarı
        window.api.onEditGeminiApiKey(() => {
            Dialogs.showGeminiApiKeyDialog();
        });

        // Bulunduğun konumu betimle (Akıllı 5 Saniye)
        window.api.onAiDescribeCurrentPosition((durationArg) => {
            this.describeCurrentPosition(durationArg);
        });

        // FFmpeg ilerleme bildirimi
        window.api.onFfmpegProgress((data) => {
            if (data && data.percent !== undefined) {
                this.updateProgress(data.operation || '', data.percent);
            }
        });

        // Dosya kapatıldı bildirimi
        window.api.onFileClosed(() => {
            this.closeCurrentFile();
        });

        // Oynatma olayları
        window.api.onPlaybackToggle(() => {
            if (canControlVideo()) VideoPlayer.togglePlay();
        });

        window.api.onPlaybackPauseAtPosition(() => {
            if (isDialogOpen()) return; // Dialog varsa enter ile kapatıyor olabilir, karışma
            // Ancak liste odaklıysa enter seçim yapar, playing durmamalı mı?
            // Pause at position genellikle Enter tuşuna bağlı. Listede Enter seçim yapar.
            // Bu yüzden listedeysek video durmasın (zaten duruyorsa durur).
            // Input/List odaklıysa videoya müdahale etme
            if (!Keyboard.isInputFocused()) {
                VideoPlayer.pause();
                VideoPlayer.setCursorToCurrentTime();
                Accessibility.announce(`Pozisyonda duraklatıldı: ${Utils.formatTime(VideoPlayer.getCurrentTime())}`);
            }
        });

        window.api.onPlaybackPlaySelection(() => {
            if (canControlVideo()) VideoPlayer.playSelection();
        });

        window.api.onPlaybackPlayCutPreview(() => {
            if (canControlVideo()) VideoPlayer.playCutPreview();
        });

        window.api.onSeekForward((seconds) => {
            if (canControlVideo()) VideoPlayer.seekRelative(seconds);
        });

        window.api.onSeekBackward((seconds) => {
            if (canControlVideo()) VideoPlayer.seekRelative(-seconds);
        });

        window.api.onGotoStart(() => {
            if (isDialogOpen()) return; // Home tuşu inputlarda başa gider, engelle
            if (Keyboard.isInputFocused()) return;
            VideoPlayer.seekTo(0);
            Accessibility.announceNavigation('Başa gidildi', 0);
        });

        window.api.onGotoEnd(() => {
            if (isDialogOpen()) return;
            if (Keyboard.isInputFocused()) return; // End tuşu inputlarda sona gider
            const duration = VideoPlayer.getDuration();
            VideoPlayer.seekTo(duration);
            Accessibility.announceNavigation('Sona gidildi', duration);
        });

        window.api.onGotoMiddle(() => {
            if (isDialogOpen()) return;
            const middle = VideoPlayer.getDuration() / 2;
            VideoPlayer.seekTo(middle);
            Accessibility.announceNavigation('Ortaya gidildi', middle);
        });

        window.api.onGotoBeforeEnd(() => {
            if (isDialogOpen()) return;
            const time = Math.max(0, VideoPlayer.getDuration() - 30);
            VideoPlayer.seekTo(time);
            Accessibility.announceNavigation('Sondan 30 saniye önce', time);
        });

        window.api.onGotoTimeDialog(() => {
            Dialogs.showGotoDialog();
        });

        // Klavye kontrolü (dialog penceresi açıldığında)
        window.api.onKeyboardDisable(() => {
            console.log('Klavye devre dışı bırakıldı (dialog açık)');
            Keyboard.setEnabled(false);
            VideoPlayer.pause(); // Videoyu da duraklat
        });

        window.api.onKeyboardEnable(() => {
            console.log('Klavye etkinleştirildi (dialog kapalı)');
            Keyboard.setEnabled(true);
        });

        // Ekleme listesi olayları
        window.api.onInsertionQueueAdd((data) => {
            console.log('Ekleme listesine ekleniyor:', data);
            InsertionQueue.addItem(data.type, data.options);
            Accessibility.announce(`${data.type === 'text' ? 'Yazı' : 'Ses'} listeye eklendi. Toplam: ${InsertionQueue.getCount()} öğe`);
        });

        window.api.onInsertionQueueUpdate((data) => {
            console.log('Ekleme listesi güncelleniyor:', data);
            InsertionQueue.updateItem(data.id, data.options);
            Accessibility.announce('Öğe güncellendi');
        });

        window.api.onShowInsertionQueue(() => {
            Dialogs.showInsertionQueueDialog();
        });

        // === GEÇİŞ İŞLEMLERİ ===
        window.api.onShowTransitionLibrary(() => {
            if (!isDialogOpen()) Dialogs.showTransitionLibraryDialog();
        });

        window.api.onApplyActiveTransition(() => {
            if (!isDialogOpen()) Transitions.applyAtCurrentTime();
        });

        window.api.onApplyTransitionToMarkers(() => {
            if (!isDialogOpen()) Transitions.applyToAllMarkers();
        });

        window.api.onShowTransitionList(() => {
            if (!isDialogOpen()) Dialogs.showTransitionListDialog();
        });

        window.api.onApplyAllTransitions(() => {
            if (!isDialogOpen()) this.applyAllTransitions();
        });

        // Yazı doğrudan videoya ekle (liste kullanmadan)
        window.api.onTextOverlayDirectApply(async (options) => {
            console.log('Yazı doğrudan videoya ekleniyor:', options);
            await this.addTextToVideo(options);
        });

        // Video yolu isteği (Gemini için)
        window.api.onGetCurrentVideoPath(() => {
            window.api.sendCurrentVideoPath(this.currentFilePath);
        });

        // === VIDEO KATMANI (Picture-in-Picture) ===
        window.api.onOpenVideoLayerWizard((filePath) => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }
            Dialogs.showVideoLayerWizard(filePath);
        });

        // CTA Library
        window.api.onShowCtaLibrary(() => {
            if (!VideoPlayer.hasVideo()) {
                Accessibility.alert('Önce bir video açmalısınız');
                return;
            }
            Dialogs.showCtaLibraryDialog();
        });
    },

    /**
     * Video oynatıcısından gelen dönüştürme hatası işleyicisi
     * @param {string} filePath - Sorunlu dosya
     * @param {string} errorMessage - Hata mesajı
     */
    async handleVideoConversionNeeded(filePath, errorMessage) {
        console.log('Video oynatma hatası (conversion needed):', errorMessage);

        // Dosya açma işlemi sürüyorsa müdahale etme
        if (this.isOpeningFile) {
            console.log('Dosya açma işlemi sürüyor, hata yutuldu.');
            return;
        }

        // Eğer zaten şu an bir dosya açma/dönüştürme işlemi içindeysek (progress açıksa)
        // müdahale etme.
        if (document.getElementById('progress-overlay') &&
            !document.getElementById('progress-overlay').classList.contains('hidden')) {
            return;
        }

        // Eğer zaten dönüştürülmüş bir dosya kullanıyorsak ve yine hata alıyorsak
        if (this.currentFilePath && this.originalFilePath &&
            this.currentFilePath !== this.originalFilePath) {
            console.warn('Dönüştürülmüş video da hata verdi:', this.currentFilePath);
            Accessibility.announceError('Video oynatma hatası: ' + errorMessage);
            return;
        }

        // Kullanıcıya sor
        const confirmed = await Dialogs.showAccessibleConfirm(
            'Oynatma Hatası',
            `Video oynatılırken bir sorun oluştu (${errorMessage}). Formatı tamir etmek için dönüştürmek ister misiniz?`
        );

        if (confirmed) {
            const inputPath = this.originalFilePath || filePath;
            const tempPath = await window.api.getTempPath(`repair_${Date.now()}.mp4`);

            this.showProgress('Video onarılıyor...');

            const result = await window.api.convertVideo({
                inputPath: inputPath,
                outputPath: tempPath,
                options: { codec: 'h264', fps: 'original' }
            });

            this.hideProgress();

            if (result.success) {
                this.currentFilePath = tempPath;
                if (!this.originalFilePath) this.originalFilePath = filePath;

                await VideoPlayer.loadVideo(tempPath);
                Accessibility.announce('Video onarıldı ve tekrar yüklendi.');
            } else {
                Accessibility.announceError('Onarım başarısız: ' + result.error);
            }
        }
    },

    /**
     * Dosya aç
     * @param {string} filePath
     */
    /**
     * Dosya aç (Wrapper)
     * @param {string} filePath
     * @param {boolean} resetUI - UI ve state sıfırlansın mı? (Proje yüklerken false)
     */
    async openFile(filePath, resetUI = true) {
        if (this.isOpeningFile) {
            console.warn('Dosya açma işlemi zaten sürüyor.');
            return;
        }

        // Eğer dosya yolu yoksa, diyalog aç
        if (!filePath) {
            const result = await window.api.openFileDialog({
                filters: [
                    { name: 'Videolar', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv'] },
                    { name: 'Tüm Dosyalar', extensions: ['*'] }
                ]
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return;
            }
            filePath = result.filePaths[0];
        }

        this.isOpeningFile = true;
        try {
            await this._openFileInternal(filePath, resetUI);
        } catch (error) {
            console.error('Dosya açma hatası:', error);
            Accessibility.announceError('Dosya açılırken hata oluştu.');
        } finally {
            this.isOpeningFile = false;
        }
    },
    /**
     * Dosya aç (Internal) - Akıllı Media Compatibility Sistemi
     * @param {string} filePath
     * @param {boolean} resetUI
     */
    async _openFileInternal(filePath, resetUI = true) {
        // Media compatibility status listener'ı kur
        const statusHandler = (status) => {
            console.log('Media Compat Status:', status);

            switch (status.status) {
                case 'analyzing':
                    Accessibility.announce('Dosya analiz ediliyor...');
                    break;
                case 'remuxing':
                    this.showProgress('Hızlı format dönüşümü yapılıyor (kalite kaybı yok)');
                    Accessibility.announce(status.message || 'Hızlı dönüşüm başladı');
                    break;
                case 'transcoding':
                    this.showProgress('Video dönüştürülüyor...');
                    Accessibility.announce(status.message || 'Dönüştürme başladı');
                    if (status.estimatedTime) {
                        Accessibility.announce(`Tahmini süre: ${Math.ceil(status.estimatedTime)} saniye`);
                    }
                    break;
                case 'ready':
                    this.hideProgress();
                    break;
                case 'error':
                    this.hideProgress();
                    Accessibility.announceError(status.message || 'Bir hata oluştu');
                    break;
            }
        };

        // Progress listener'ı kur
        const progressHandler = (progress) => {
            if (progress && progress.percent !== undefined) {
                let message = '';
                if (progress.stage === 'remux') {
                    message = 'Hızlı dönüşüm';
                } else if (progress.stage === 'transcode') {
                    message = 'Dönüştürme';
                }
                this.updateProgress(message, progress.percent);
            }
        };

        // Event listener'ları kaydet
        window.api.onMediaCompatStatus(statusHandler);
        window.api.onMediaCompatProgress(progressHandler);

        try {
            // Akıllı dosya açma - otomatik olarak en uygun stratejiyi seçer
            const result = await window.api.smartOpenVideo(filePath);

            // Event listener'ları temizle
            window.api.removeAllListeners('media-compat-status');
            window.api.removeAllListeners('media-compat-progress');
            this.hideProgress();

            if (!result.success) {
                Accessibility.announceError(`Video açılamadı: ${result.error}`);
                return;
            }

            // Strateji bilgisini logla
            console.log('Video açıldı:', result.strategy, result.playbackPath);

            // Stratejiye göre kullanıcıya bilgi ver
            let strategyMessage = '';
            switch (result.strategy) {
                case 'DIRECT_PLAY':
                    strategyMessage = 'Doğrudan açıldı';
                    break;
                case 'QUICK_REMUX':
                    strategyMessage = result.cached
                        ? 'Önbellekten hızlı açıldı'
                        : 'Hızlı dönüşüm yapıldı (kalite kaybı yok)';
                    break;
                case 'TRANSCODE':
                    strategyMessage = result.cached
                        ? 'Önbellekten açıldı'
                        : 'Dönüştürme tamamlandı';
                    break;
            }

            const playbackPath = result.playbackPath;
            const probe = result.probe;

            // Video yükle
            try {
                await VideoPlayer.loadVideo(playbackPath);
            } catch (error) {
                console.error('Video yükleme hatası:', error);
                Accessibility.announceError('Video oynatıcıya yüklenemedi');
                return;
            }

            const loadedMetadata = VideoPlayer.metadata;
            const duration = loadedMetadata ? loadedMetadata.duration : 0;

            if (duration <= 0) {
                console.error('Video süresi alınamadı!');
                Accessibility.alert('Video açılamadı');
                return;
            }

            // TabManager ile sekme oluştur
            const convertedPath = playbackPath !== filePath ? playbackPath : null;
            const tab = await TabManager.createTabFromFile(filePath, loadedMetadata, duration, convertedPath);
            if (!tab) return; // Zaten açık veya limit aşıldı

            // Eğer dönüştürme yapıldıysa, TabManager'a kaydet
            if (convertedPath) {
                tab.originalPath = filePath;
            }

            // App state'i güncelle
            this.currentFilePath = playbackPath;
            this.originalFilePath = filePath;
            this.hasChanges = false;

            // Timeline'ı sekmedeki ile senkronize et
            Timeline.segments = tab.timeline.segments.map(s => ({ ...s }));
            Timeline.sourceFile = playbackPath;
            Timeline.hasChanges = false;

            // İşaretçileri ve seçimi temizle (Sadece yeni dosya açarken)
            if (resetUI) {
                Markers.clearAll();
                Selection.clear(true);
            }

            // Dosya bilgilerini hazırla
            const durationStr = Utils.formatTime(loadedMetadata.duration);
            const resolution = loadedMetadata.width && loadedMetadata.height
                ? `${loadedMetadata.width}x${loadedMetadata.height}`
                : '';

            // Video yönünü belirle
            let orientation = '';
            if (loadedMetadata.width && loadedMetadata.height) {
                if (loadedMetadata.width > loadedMetadata.height) {
                    orientation = 'Yatay';
                } else if (loadedMetadata.width < loadedMetadata.height) {
                    orientation = 'Dikey';
                } else {
                    orientation = 'Kare';
                }
            }

            // Dosya adını probe veya path'den al
            const filename = probe?.filePath
                ? probe.filePath.split(/[\\/]/).pop()
                : filePath.split(/[\\/]/).pop();

            const fileInfo = [
                `${filename} açıldı`,
                strategyMessage,
                `Süre: ${durationStr}`,
                resolution ? `Çözünürlük: ${resolution}` : '',
                orientation ? `Yön: ${orientation}` : '',
                loadedMetadata.codec ? `Codec: ${loadedMetadata.codec}` : ''
            ].filter(x => x).join('. ');

            // Önceki tüm mesajları temizleyip dosya bilgisini oku
            Accessibility.announceImmediate(fileInfo);

        } catch (error) {
            console.error('Dosya açma hatası:', error);
            window.api.removeAllListeners('media-compat-status');
            window.api.removeAllListeners('media-compat-progress');
            this.hideProgress();
            Accessibility.announceError('Dosya açılırken bir hata oluştu');
        }
    },

    /**
     * Video oynatma hatası durumunda dönüştürme öner
     * @param {string} filePath - Hata veren video dosyası
     * @param {string} errorMessage - Hata mesajı
     */
    async handleVideoConversionNeeded(filePath, errorMessage) {
        if (!filePath) {
            console.error('Dönüştürme için dosya yolu yok');
            return;
        }

        // Dönüştürme öner (erişilebilir dialog)
        const runtimeErrorMessage = `${errorMessage}. Videoyu MP4 (H.264) formatına dönüştürmek ister misiniz?`;
        const shouldConvert = await Dialogs.showAccessibleConfirm('Video Oynatılamıyor', runtimeErrorMessage);

        if (shouldConvert) {
            const ext = filePath.split('.').pop().toLowerCase();
            const tempPath = await window.api.getTempPath(`converted_${Date.now()}.mp4`);

            this.showProgress('Video dönüştürülüyor');
            Accessibility.announce('Video dönüştürülüyor, lütfen bekleyin');

            const convertResult = await window.api.convertVideo({
                inputPath: filePath,
                outputPath: tempPath,
                options: { codec: 'h264', fps: 'original' }
            });

            this.hideProgress();

            if (convertResult.success) {
                Accessibility.announceImmediate('Dönüştürme tamamlandı, video yeniden açılıyor');

                // Mevcut sekmeyi güncelle (varsa)
                const activeTab = TabManager.getActiveTab();
                if (activeTab) {
                    activeTab.convertedPath = tempPath;
                    activeTab.originalPath = filePath;
                }

                // Dönüştürülmüş videoyu yükle
                await VideoPlayer.loadVideo(tempPath);
                this.currentFilePath = tempPath;
                Timeline.sourceFile = tempPath;

                Accessibility.announce('Video hazır');
            } else {
                Accessibility.announceError(`Dönüştürme hatası: ${convertResult.error}`);
            }
        }
    },

    /**
     * Yeni boş proje oluştur
     */
    newProject() {
        const tab = TabManager.createNewProject();
        if (!tab) return;

        // App state'i temizle
        this.currentFilePath = null;
        this.originalFilePath = null;
        this.hasChanges = false;

        // Timeline'ı temizle
        Timeline.segments = [];
        Timeline.sourceFile = null;
        Timeline.hasChanges = false;

        // Diğer modülleri temizle
        Markers.clearAll();
        Selection.clear(true);
        VideoPlayer.showEmptyState();

        // UI güncelle
        document.getElementById('file-name').textContent = 'Yeni Proje';
        document.getElementById('total-duration').textContent = '00:00:00.000';
    },

    /**
     * Sekmeyi kapatma onayı ile kapat
     * @param {number} index - Sekme indeksi
     */
    async closeTabWithConfirm(index) {
        if (index < 0 || index >= TabManager.tabs.length) return;

        const tab = TabManager.tabs[index];

        if (tab.hasChanges) {
            const result = await window.api.showSaveConfirm(
                'Kaydet?',
                `"${tab.name}" dosyasında kaydedilmemiş değişiklikler var. Kaydetmek istiyor musunuz?`
            );

            if (result === 0) { // Kaydet
                // Önce o sekmeye geç
                TabManager.switchToTab(index);
                await this.saveFile();
                TabManager.forceCloseTab(index);
            } else if (result === 1) { // Kaydetme
                TabManager.forceCloseTab(index);
            }
            // result === 2 ise İptal - hiçbir şey yapma
        } else {
            TabManager.forceCloseTab(index);
        }
    },

    /**
     * Dosya kaydet (Timeline segment'lerini dışa aktar)
     */
    /**
     * Dosya kaydet (Timeline segment'lerini dışa aktar)
     */
    async saveFile() {
        Accessibility.announce('Debug: Kaydetme komutu alındı.'); // DEBUG

        // Yeni proje veya segment varsa kaydet
        if (Timeline.segments.length === 0) {
            Accessibility.alert('Kaydedilecek içerik yok');
            return;
        }

        // Eğer currentFilePath yoksa (yeni proje), farklı kaydet diyaloğu göster
        if (!this.currentFilePath) {
            const result = await window.api.showSaveDialog({
                title: 'Projeyi Kaydet',
                defaultPath: 'yeni_video.mp4',
                filters: [
                    { name: 'Video Dosyaları', extensions: ['mp4'] }
                ]
            });

            if (result && !result.canceled && result.filePath) {
                await this.exportTimeline(result.filePath);
                this.currentFilePath = result.filePath;

                // Tab bilgilerini güncelle
                const activeTab = TabManager.getActiveTab();
                if (activeTab) {
                    activeTab.filePath = result.filePath;
                    activeTab.name = result.filePath.split(/[\\/]/).pop();
                    activeTab.hasChanges = false;
                    TabManager.updateTabBar();
                }
            }
            return;
        }

        // CTA overlay sayısı da değişiklik olarak sayılır
        const ctaCount = typeof CtaOverlayPreview !== 'undefined'
            ? CtaOverlayPreview.getOverlayCount()
            : 0;

        Accessibility.announce(`Debug: Değişiklik kontrolü - Timeline: ${Timeline.hasChanges}, Overlay: ${ctaCount}`); // DEBUG

        if (!Timeline.hasChanges && ctaCount === 0) {
            Accessibility.announce('Değişiklik yok, kaydetme atlandı');
            return;
        }

        // Orijinal dosyanın üzerine yazma - önce farklı bir dosyaya kaydet
        const outputPath = this.originalFilePath.replace(/\.([^.]+)$/, '_saved.$1');
        await this.exportTimeline(outputPath);
    }

    /**
     * Farklı kaydet
     * @param {string} filePath
     */
    async saveFileAs(filePath) {
        if (!VideoPlayer.hasVideo()) return;

        if (!filePath) {
            const result = await window.api.showSaveDialog({
                title: 'Farklı Kaydet',
                defaultPath: this.currentFilePath ? this.currentFilePath.split(/[\\/]/).pop() : 'video.mp4',
                filters: [
                    { name: 'Video Dosyaları', extensions: ['mp4'] }
                ]
            });
            if (result.canceled || !result.filePath) return;
            filePath = result.filePath;
        }

        await this.exportTimeline(filePath);
    }

    /**
     * Timeline segment'lerini video olarak dışa aktar
     * Kesimler kesin (re-encode), birleştirme hızlı (stream copy)
     * @param {string} outputPath - Çıktı dosya yolu
     */
    async exportTimeline(outputPath) {
        await Accessibility.alert("Kritik Kontrol: exportTimeline fonksiyonu çalıştı.");
        const segments = Timeline.getSegments();

        if (segments.length === 0) {
            Accessibility.alert('Dışa aktarılacak içerik yok');
            return;
        }

        this.showProgress('Video dışa aktarılıyor');
        Accessibility.announce('Video dışa aktarılıyor');

        try {
            // CTA overlay sayısı
            const ctaCount = typeof CtaOverlayPreview !== 'undefined'
                ? CtaOverlayPreview.getOverlayCount()
                : 0;

            let safeRenderMode = false;
            const meta = VideoPlayer.metadata || { width: 0, height: 0 };

            // DEBUG: Kritik Bilgiler - ALERT kullanarak kesin bilgi alalım
            await Accessibility.alert(`Debug Bilgisi:\nOverlay Sayısı: ${ctaCount}\nÇözünürlük: ${meta.width}x${meta.height}\nCtaModule Durumu: ${typeof CtaOverlayPreview}`);

            // Osmo/4K 264 Format Uyarısı
            if (ctaCount > 0) {
                // const meta = VideoPlayer.metadata; // Already defined above

                // DEBUG: Kullanıcıya durumu bildir
                // Accessibility.announce(`Safe Render Kontrolü: Çözünürlük ${meta.width}x${meta.height}, Overlay Sayısı: ${ctaCount}`);
                console.log('Safe Render Check - Meta:', meta, 'CTA Count:', ctaCount);

                // Kullanıcının "4k tarzı" dediği ancak testlerde çıkmadığı durumlar için eşiği düşürüyoruz.
                // 1280x720 (HD) ve üzeri tüm videolarda güvenli modu önerelim.
                const isHighRes = meta && (meta.width >= 1200 || meta.height >= 700);

                if (isHighRes) {
                    this.hideProgress(); // Diyalog öncesi progress gizle

                    const confirmed = await Dialogs.showAccessibleConfirm(
                        'Güvenli Render Uyarısı',
                        'Yüksek çözünürlüklü videolarda bindirme (Overlay) işlemi öncesinde, sistem kararlılığı için videonun güvenli formata dönüştürülmesi önerilir. Bu işlem kitlenmeleri önler ancak işlem süresini uzatabilir. Dönüştürme işlemini onaylıyor musunuz?'
                    );

                    if (confirmed) {
                        safeRenderMode = true;
                        Accessibility.announce('Güvenli render modu etkinleştirildi.');
                    } else {
                        Accessibility.announce('Standart render ile devam ediliyor.');
                    }
                    this.showProgress('Video dışa aktarılıyor');
                }
            }

            console.log('Export başlıyor. CTA sayısı:', ctaCount);
            console.log('CtaOverlayPreview tanımlı mı?', typeof CtaOverlayPreview !== 'undefined');
            if (typeof CtaOverlayPreview !== 'undefined') {
                console.log('Timeline overlays:', CtaOverlayPreview.getTimelineOverlays());
            }

            // Eğer tek segment varsa, değişiklik yoksa VE CTA yoksa, sadece kopyala
            if (segments.length === 1 &&
                segments[0].start === 0 &&
                segments[0].end === Timeline.sourceDuration &&
                !segments[0].sourceFile &&
                ctaCount === 0) {
                // Değişiklik yok, dosya kopyala
                const sourceFile = this.originalFilePath || this.currentFilePath;
                await window.api.copyFile(sourceFile, outputPath);
                this.hideProgress();
                Accessibility.announceComplete('Dosya kopyalandı (değişiklik yok)');
                return;
            }

            // === TEK ÇİZGİ (SINGLE PASS) RENDER ===
            // Parçalama/birleştirme yerine tüm timeline'ı tek FFmpeg komutuyla render et
            // Bu yöntem dikiş izleri, tekrarlamalar ve senkron kayması sorunlarını önler

            const inputPath = this.originalFilePath || this.currentFilePath;

            // Segment'leri renderTimeline için hazırla (sadece start/end bilgisi yeterli)
            const renderSegments = segments.map(seg => ({
                start: seg.start,
                end: seg.end
            }));

            Accessibility.announce('Timeline tek seferde render ediliyor (Single Pass)');
            console.log('RenderTimeline başlıyor:', { inputPath, segments: renderSegments, outputPath });

            const renderResult = await window.api.renderTimeline({
                inputPath: inputPath,
                segments: renderSegments,
                outputPath: outputPath
            });

            if (!renderResult.success) {
                throw new Error(`Render hatası: ${renderResult.error}`);
            }

            // CTA Overlay'leri uygula
            // CTA Overlay'leri uygula
            if (ctaCount > 0) {
                Accessibility.announce('CTA overlay\'ler ekleniyor');

                const overlays = CtaOverlayPreview.getTimelineOverlays();
                let currentInputPath = outputPath;

                for (let i = 0; i < overlays.length; i++) {
                    const overlay = overlays[i];
                    const tempOutputPath = outputPath.replace(/\.mp4$/i, `_cta_temp_${i}.mp4`);

                    Accessibility.announce(`CTA ${i + 1}/${overlays.length}: ${overlay.asset.name}`);

                    try {
                        const result = await window.api.addCtaOverlay({
                            mainVideoPath: currentInputPath,
                            ctaPath: overlay.asset.path,
                            outputPath: tempOutputPath,
                            position: overlay.position,
                            scale: overlay.scale,
                            opacity: overlay.opacity,
                            duration: overlay.duration,
                            fade: overlay.fade,
                            sound: overlay.sound,
                            startTime: overlay.startTime
                        });

                        if (result.success) {
                            // Eski dosyayı sil (orijinal değilse)
                            if (currentInputPath !== outputPath) {
                                window.api.deleteFiles([currentInputPath]);
                            }
                            currentInputPath = tempOutputPath;
                        } else {
                            console.error('CTA overlay hatası:', result.error);
                        }
                    } catch (err) {
                        console.error('CTA overlay hatası:', err);
                    }
                }

                // Son dosyayı asıl çıktı olarak yeniden adlandır
                if (currentInputPath !== outputPath) {
                    await window.api.renameFile({
                        oldPath: currentInputPath,
                        newPath: outputPath
                    });
                }
            }

            this.hideProgress();
            this.hasChanges = false;
            Timeline.hasChanges = false;

            // CTA overlay'leri temizle
            if (typeof CtaOverlayPreview !== 'undefined') {
                CtaOverlayPreview.clearAllOverlays();
            }

            const ctaMessage = ctaCount > 0 ? ` (${ctaCount} CTA overlay dahil)` : '';
            Accessibility.announceComplete(`Video dışa aktarma tamamlandı${ctaMessage}`);

        } catch (error) {
            this.hideProgress();
            Accessibility.announceError(error.message);
        }

    },

    /**
     * Seçimi kaydet (kesin kesim - re-encode)
     * @param {string} filePath
     */
    async saveSelection(filePath) {
        if (!Selection.hasSelection()) {
            Accessibility.alert('Önce bir alan seçmelisiniz');
            return;
        }

        const sel = Selection.getSelection();
        this.showProgress('Seçim kaydediliyor');
        Accessibility.announce('Seçim kaydediliyor');

        // Kesin kesim için re-encode kullan (stream copy keyframe sorunlarına yol açar)
        const result = await window.api.cutVideo({
            inputPath: this.currentFilePath,
            outputPath: filePath,
            startTime: sel.start,
            endTime: sel.end
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Seçim kaydetme');
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Sadece video dışa aktar
     * @param {string} filePath
     */
    async exportVideoOnly(filePath) {
        if (!VideoPlayer.hasVideo()) return;

        this.showProgress('Video dışa aktarılıyor');

        const result = await window.api.extractVideo({
            inputPath: this.currentFilePath,
            outputPath: filePath
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Video dışa aktarma');
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Sadece ses dışa aktar
     * @param {string} filePath
     */
    async exportAudioOnly(filePath) {
        if (!VideoPlayer.hasVideo()) return;

        this.showProgress('Ses dışa aktarılıyor');

        const result = await window.api.extractAudio({
            inputPath: this.currentFilePath,
            outputPath: filePath
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Ses dışa aktarma');
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Kes (ANI İŞLEM)
     */
    cut() {
        if (!Selection.hasSelection()) {
            Accessibility.alert('Önce bir alan seçmelisiniz');
            return;
        }

        const sel = Selection.getSelection();

        if (Timeline.cut(sel.start, sel.end)) {
            this.hasChanges = true;
            this.updateAfterEdit();
            Accessibility.announce(`${Utils.formatTime(sel.end - sel.start)} kesildi`);
        } else {
            Accessibility.alert('Kesme işlemi başarısız');
        }

        Selection.clear();
    },

    /**
     * Kopyala (ANI İŞLEM - sekmeler arası çalışır)
     */
    copy() {
        if (!Selection.hasSelection()) {
            Accessibility.alert('Önce bir alan seçmelisiniz');
            return;
        }

        const sel = Selection.getSelection();

        if (Timeline.copy(sel.start, sel.end)) {
            // TabManager'ın global clipboard'ına da kaydet (sekmeler arası için)
            const activeTab = TabManager.getActiveTab();
            const metadata = activeTab ? activeTab.metadata : null;
            TabManager.copyToClipboard(Timeline.clipboard.segments, metadata);

            Accessibility.announce(`${Utils.formatTime(sel.end - sel.start)} kopyalandı`);
        } else {
            Accessibility.alert('Kopyalama işlemi başarısız');
        }
    },

    /**
     * Yapıştır (ANI İŞLEM - sekmeler arası çalışır)
     */
    async paste() {
        // Önce TabManager'ın global clipboard'ını kontrol et
        const globalClipboard = TabManager.getClipboard();

        if (!globalClipboard && !Timeline.clipboard) {
            Accessibility.alert('Panoda içerik yok');
            return;
        }

        const insertTime = VideoPlayer.getCurrentTime();
        const activeTab = TabManager.getActiveTab();

        // Yeni projeye yapıştırma - metadata al
        if (activeTab && activeTab.isNewProject && !activeTab.metadata && globalClipboard && globalClipboard.metadata) {
            activeTab.metadata = { ...globalClipboard.metadata };
            console.log('Yeni projeye metadata miras alındı:', activeTab.metadata);
        }

        // Global clipboard varsa ve Timeline'da yoksa, Timeline'a kopyala
        if (globalClipboard && !Timeline.clipboard) {
            // sourceFile bilgisini de ekle - cross-tab yapıştırma için gerekli
            const sourceFile = globalClipboard.metadata ? globalClipboard.metadata.filePath :
                (globalClipboard.segments[0] ? globalClipboard.segments[0].sourceFile : null);
            Timeline.clipboard = {
                sourceFile: sourceFile,
                segments: globalClipboard.segments,
                duration: globalClipboard.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
            };
        }

        if (Timeline.paste(insertTime)) {
            this.hasChanges = true;
            TabManager.markAsChanged();
            this.updateAfterEdit();

            // Yeni proje için: kaynak videoyu yükle (sadece ilk yapıştırmada)
            if (activeTab && activeTab.isNewProject) {
                // İlk segment'in kaynak videosunu VideoPlayer'a yükle ve hazır olmasını bekle
                const firstSegment = Timeline.segments[0];
                if (firstSegment && firstSegment.sourceFile) {
                    await VideoPlayer.loadVideoSilent(firstSegment.sourceFile);
                    // Video hazır olduğunda ilk segment'in başına git
                    VideoPlayer.video.currentTime = firstSegment.start;
                    console.log('İlk yapıştırma: video yüklendi, konum:', firstSegment.start);
                    // Artık yeni proje değil, içerik var
                    activeTab.isNewProject = false;
                    activeTab.filePath = null; // Hala kayıtlı değil
                }
            }

            // Timeline süresini her zaman güncelle (yeni proje olsun olmasın)
            if (activeTab) {
                activeTab.timeline.totalDuration = Timeline.getTotalDuration();
                activeTab.timeline.segments = Timeline.segments.map(s => ({ ...s }));
            }
            document.getElementById('total-duration').textContent = Utils.formatTime(Timeline.getTotalDuration());

            Accessibility.announce(`${Utils.formatTime(Timeline.clipboard.duration)} yapıştırıldı`);
        } else {
            Accessibility.alert('Yapıştırma işlemi başarısız');
        }
    },

    /**
     * Seçili alanı sil (ANI İŞLEM - FFmpeg kullanmaz!)
     */
    delete() {
        console.log('Delete çağrıldı');

        if (!Selection.hasSelection()) {
            console.log('Seçim yok');
            Accessibility.alert('Önce bir alan seçmelisiniz');
            return;
        }

        if (!VideoPlayer.hasVideo()) {
            console.log('Video yok');
            Accessibility.alert('Açık video yok');
            return;
        }

        const sel = Selection.getSelection();
        console.log('Seçim:', sel);
        console.log('Timeline segments:', Timeline.segments);

        const deletedDuration = sel.end - sel.start;

        // Timeline'ı güncelle (ANI!)
        const success = Timeline.deleteRange(sel.start, sel.end);
        console.log('DeleteRange sonucu:', success);

        if (success) {
            this.hasChanges = true;
            this.updateAfterEdit();
            Selection.clear(); // Sadece başarılı olduğunda temizle
            Accessibility.announce(`${Utils.formatTime(deletedDuration)} silindi`);
        } else {
            Accessibility.alert('Silme işlemi başarısız - Timeline segmentleri kontrol edin');
        }
    },

    /**
     * Düzenleme sonrası UI güncelle
     */
    updateAfterEdit() {
        // Toplam süreyi güncelle
        const newDuration = Timeline.getTotalDuration();
        document.getElementById('total-duration').textContent = Utils.formatTime(newDuration);

        // İşaretleyicileri timeline değişikliklerine göre güncelle
        this.updateMarkersForTimeline();

        // Seçimi güncelle (eğer varsa ve geçerliyse)
        if (Selection.hasSelection()) {
            const sel = Selection.getSelection();
            // Seçim yeni timeline süresinden büyükse temizle
            if (sel.start >= newDuration || sel.end > newDuration) {
                Selection.clear(true); // Sessiz temizle
            }
        }

        // Segment indeksini mevcut konuma göre güncelle
        this.updateSegmentIndex();

        // Debug için
        Timeline.debugPrint();
    },

    /**
     * VideoPlayer'ın segment indeksini mevcut konuma göre güncelle
     * Segment ekleme/silme sonrası çağrılmalı
     */
    updateSegmentIndex() {
        const segments = Timeline.segments;
        if (!segments || segments.length === 0) {
            VideoPlayer._currentTimelineSegmentIndex = undefined;
            return;
        }

        const currentSource = VideoPlayer.currentFilePath;
        const currentTime = VideoPlayer.video ? VideoPlayer.video.currentTime : 0;

        // Mevcut konuma en yakın segmenti bul
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segSource = seg.sourceFile || Timeline.sourceFile;

            if (segSource === currentSource) {
                if (currentTime >= seg.start - 0.5 && currentTime <= seg.end + 0.5) {
                    VideoPlayer._currentTimelineSegmentIndex = i;
                    console.log(`updateSegmentIndex: Segment indeksi güncellendi: ${i} / ${segments.length}`);
                    return;
                }
            }
        }

        // Bulunamadıysa ilk segmente ayarla
        VideoPlayer._currentTimelineSegmentIndex = 0;
        console.log(`updateSegmentIndex: Segment bulunamadı, 0'a ayarlandı`);
    },

    /**
     * İşaretleyicileri timeline değişikliklerine göre güncelle
     * Silinen bölgelerdeki işaretleyicileri kaldırır ve
     * geri kalanları yeni timeline pozisyonlarına kaydırır
     */
    updateMarkersForTimeline() {
        const markers = Markers.getAll();
        if (markers.length === 0) return;

        const newDuration = Timeline.getTotalDuration();
        const updatedMarkers = [];

        for (const marker of markers) {
            // İşaretleyicinin kaynak zamanını timeline zamanına çevir
            // (Eğer işaretleyici kaynak zamanıyla saklanıyorsa)
            const timelineTime = Timeline.sourceToTimeline(marker.time);

            if (timelineTime >= 0 && timelineTime <= newDuration) {
                // İşaretleyici hala geçerli - yeni timeline pozisyonuyla güncelle
                updatedMarkers.push({
                    ...marker,
                    time: timelineTime
                });
            }
            // timelineTime < 0 ise bu işaretleyici silinmiş bir bölgede, atla
        }

        // İşaretleyici sayısı değiştiyse kullanıcıyı bilgilendir
        const removedCount = markers.length - updatedMarkers.length;
        if (removedCount > 0) {
            console.log(`${removedCount} işaretleyici silinen bölgede olduğu için kaldırıldı`);
        }

        // Markers modülünü güncelle
        Markers.markers = updatedMarkers;
        Markers.sortMarkers();
        Markers.updateMarkerList();
        Markers.updateMarkerCount();
    },


    /**
     * Bulunduğun konumu betimle (AI)
     * @param {number} durationArg - İsteğe bağlı pencere süresi (varsayılan 5sn)
     */
    describeCurrentPosition(durationArg) {
        if (!VideoPlayer.hasVideo()) {
            Accessibility.alert('Önce bir video açmalısınız');
            return;
        }
        const currentTime = VideoPlayer.getCurrentTime();
        const videoDuration = VideoPlayer.getDuration();

        // Kullanıcı aksini belirtmedikçe varsayılan 5 saniye
        const windowSize = durationArg || 5;

        // Varsayılan: Bulunduğumuz anın ortasında olduğu 5 saniyelik bir pencere
        let halfWindow = windowSize / 2;
        let start = currentTime - halfWindow;
        let end = currentTime + halfWindow;

        // Başlangıç kontrolü
        if (start < 0) {
            start = 0;
            end = Math.min(videoDuration, windowSize);
        }

        // Bitiş kontrolü
        if (end > videoDuration) {
            end = videoDuration;
            start = Math.max(0, videoDuration - windowSize);
        }

        const finalDuration = end - start;

        if (finalDuration <= 0.5) {
            Accessibility.alert('Betimlenecek alan çok kısa veya video sonunda.');
            return;
        }

        Dialogs.showAIDescriptionForSegment(start, finalDuration);
    },

    /**
     * Geri al (ANI İŞLEM)
     */
    undo() {
        if (Timeline.undo()) {
            this.updateAfterEdit();
            Accessibility.announce('İşlem geri alındı');
        } else {
            Accessibility.announce('Geri alınacak işlem yok');
        }
    },

    /**
     * Yinele (ANI İŞLEM)
     */
    redo() {
        if (Timeline.redo()) {
            this.updateAfterEdit();
            Accessibility.announce('İşlem yinelendi');
        } else {
            Accessibility.announce('Yinelenecek işlem yok');
        }
    },

    /**
     * Videoya ses ekle (gelişmiş)
     * @param {Object} options - Ses ekleme seçenekleri
     */
    async addAudioToVideo(options) {
        if (!VideoPlayer.hasVideo()) return;

        const {
            audioPath,
            targetVolume = 1,
            sourceVolume = 1,
            asBackground = false,
            trimStart = 0,
            trimEnd = 0
        } = options;

        this.showProgress('Ses ekleniyor...');

        try {
            // Çıktı dosya yolunu oluştur - _audio eki ile
            const outputPath = this.currentFilePath.replace(/\.[^.]+$/, '_audio.mp4');
            console.log('Çıktı dosyası:', outputPath);

            // Gelişmiş ses karıştırma API'sini çağır
            const result = await window.api.mixAudioAdvanced({
                videoPath: this.currentFilePath,
                audioPath: audioPath,
                outputPath: outputPath,
                videoVolume: sourceVolume,
                audioVolume: targetVolume,
                insertTime: VideoPlayer.getCurrentTime(),
                audioTrimStart: trimStart,
                audioTrimEnd: trimEnd,
                loopAudio: asBackground
            });

            this.hideProgress();
            console.log('Mix sonucu:', result);

            if (result.success) {
                Accessibility.announceComplete('Ses ekleme');
                console.log('Yeni dosya yükleniyor:', outputPath);

                // Yeni dosyayı aç (openFile metodu sekme ve dosya yüklemeyi düzgün halleder)
                await this.openFile(outputPath);

                Accessibility.announce('Ses eklenmiş video yüklendi: ' + outputPath.split(/[/\\]/).pop());
            } else {
                console.error('Mix hatası:', result.error);
                Accessibility.announceError(result.error);
            }
        } catch (error) {
            this.hideProgress();
            console.error('addAudioToVideo hatası:', error);
            Accessibility.announceError(error.message);
        }
    },

    /**
     * Videoya yazı ekle
     * @param {Object} options - Yazı ekleme seçenekleri
     */
    async addTextToVideo(options) {
        if (!VideoPlayer.hasVideo()) return;

        const {
            text,
            font = 'arial',
            fontSize = 48,
            fontColor = 'white',
            background = 'none',
            position = 'bottom',
            transition = 'none',
            duration = 5,
            startTime = 0,
            shadow = 'none',
            // TTS seçenekleri
            ttsEnabled = false,
            ttsVoice = null,
            ttsSpeed = 1.0,
            ttsVolume = 1.0,
            videoVolume = 1.0
        } = options;

        this.showProgress('Yazı ekleniyor...');

        try {
            // Video süresini al
            const videoDuration = VideoPlayer.getDuration();

            // Süre hesaplama
            let actualDuration;
            let effectiveStartTime = startTime;

            if (duration === 'whole') {
                // Tüm video boyunca (0'dan sona)
                effectiveStartTime = 0;
                actualDuration = videoDuration;

            } else {
                // Manuel süre
                actualDuration = duration;
            }

            // Ara dosya ve son dosya yolları
            const textOutputPath = this.currentFilePath.replace(/\.[^.]+$/, '_text.mp4');
            let finalOutputPath = textOutputPath;

            console.log('Yazı ekleme başlıyor:', options);

            // Adım 1: Yazı ekle
            const textResult = await window.api.addTextOverlay({
                videoPath: this.currentFilePath,
                outputPath: textOutputPath,
                text: text,
                font: font,
                fontSize: fontSize,
                fontColor: fontColor,
                background: background,
                position: position,
                transition: transition,
                shadow: shadow,
                startTime: effectiveStartTime,
                endTime: effectiveStartTime + actualDuration,
                ttsEnabled: ttsEnabled,
                ttsVoice: ttsVoice,
                ttsSpeed: ttsSpeed,
                ttsVolume: ttsVolume,
                videoVolume: videoVolume
            });

            if (!textResult.success) {
                throw new Error(textResult.error);
            }

            // Adım 2: TTS etkinse ses ekle
            if (ttsEnabled) {
                this.showProgress('Seslendiriliyor...');

                // TTS ses dosyası oluştur
                const ttsResult = await window.api.generateTts({
                    text: text,
                    voice: ttsVoice,
                    speed: ttsSpeed
                });

                if (!ttsResult.success) {
                    console.error('TTS hatası:', ttsResult.error);
                    // TTS başarısız olsa bile devam et
                } else {
                    this.showProgress('Ses ekleniyor...');

                    // TTS + Video ses karıştırma
                    finalOutputPath = this.currentFilePath.replace(/\.[^.]+$/, '_text_tts.mp4');

                    const mixResult = await window.api.mixAudioAdvanced({
                        videoPath: textOutputPath,
                        audioPath: ttsResult.wavPath,
                        outputPath: finalOutputPath,
                        videoVolume: videoVolume,
                        audioVolume: ttsVolume,
                        insertTime: startTime,
                        audioTrimStart: 0,
                        audioTrimEnd: 0,
                        loopAudio: false
                    });

                    if (!mixResult.success) {
                        console.error('Ses karıştırma hatası:', mixResult.error);
                        // Hata olsa bile yazılı videoyu kullan
                        finalOutputPath = textOutputPath;
                    }
                }
            }

            this.hideProgress();
            console.log('Yazı ekleme sonucu: başarılı');

            Accessibility.announceComplete('Yazı ekleme');
            console.log('Yeni dosya yükleniyor:', finalOutputPath);
            await this.openFile(finalOutputPath);
            Accessibility.announce('Yazı eklenmiş video yüklendi');

        } catch (error) {
            this.hideProgress();
            console.error('addTextToVideo hatası:', error);
            Accessibility.announceError(error.message);
        }
    },

    /**
     * Ekleme listesindeki tüm öğeleri videoya uygula
     */
    async applyAllInsertions() {
        const items = InsertionQueue.getItems();

        if (items.length === 0) {
            Accessibility.announce('Ekleme listesi boş');
            return;
        }

        if (!VideoPlayer.hasVideo()) {
            Accessibility.alert('Önce bir video açmalısınız');
            return;
        }

        const textItems = items.filter(i => i.type === 'text');
        const audioItems = items.filter(i => i.type === 'audio');
        const imageItems = items.filter(i => i.type === 'image');

        // Debug: Tüm öğeleri ve tiplerini log'la
        console.log('InsertionQueue items:', items);
        console.log('Image items found:', imageItems.length, imageItems);
        items.forEach((item, idx) => {
            console.log(`Item ${idx}: type="${item.type}", options:`, item.options);
        });

        try {
            this.showProgress('Eklemeler uygulanıyor...');

            let currentVideoPath = this.currentFilePath;
            let stepCount = 0;
            const totalSteps = textItems.length + audioItems.length + imageItems.length;

            // Önce yazıları uygula (her biri için drawtext)
            for (const item of textItems) {
                stepCount++;
                this.updateProgress(`Yazı ekleniyor (${stepCount}/${totalSteps})`, (stepCount / totalSteps) * 100);

                const opts = item.options;
                const outputPath = await window.api.getTempPath(`text_${stepCount}_${Date.now()}.mp4`);

                // Video süresini al
                const videoDuration = VideoPlayer.getDuration();
                const endTime = opts.duration === 'whole'
                    ? videoDuration
                    : (opts.startTime || 0) + (opts.duration || 5);

                const result = await window.api.addTextOverlay({
                    videoPath: currentVideoPath,
                    outputPath: outputPath,
                    text: opts.text || '',
                    font: opts.font || 'arial',
                    fontSize: opts.fontSize || 48,
                    fontColor: opts.fontColor || 'white',
                    background: opts.background || 'none',
                    position: opts.position || 'bottom-center',
                    transition: opts.transition || 'none',
                    startTime: opts.startTime || 0,
                    endTime: endTime,
                    // TTS parametreleri - Options içinden al
                    shadow: opts.shadow || 'none',
                    ttsEnabled: opts.ttsEnabled || false,
                    ttsVoice: opts.ttsVoice || null,
                    ttsSpeed: opts.ttsSpeed || 1.0,
                    ttsVolume: opts.ttsVolume || 1.0,
                    videoVolume: opts.videoVolume || 1.0
                });

                if (result.success && result.outputPath) {
                    currentVideoPath = result.outputPath;
                } else {
                    console.error('Yazı ekleme hatası:', result.error);
                }
            }

            // Sonra sesleri uygula
            for (const item of audioItems) {
                stepCount++;
                this.updateProgress(`Ses ekleniyor (${stepCount}/${totalSteps})`, (stepCount / totalSteps) * 100);

                const opts = item.options;
                const outputPath = await window.api.getTempPath(`audio_${stepCount}_${Date.now()}.mp4`);

                const result = await window.api.mixAudio({
                    videoPath: currentVideoPath,
                    audioPath: opts.audioPath,
                    outputPath: outputPath,
                    videoVolume: opts.videoVolume || 1.0,
                    audioVolume: opts.audioVolume || 1.0,
                    insertTime: opts.startTime || 0,
                    audioTrimStart: opts.audioTrimStart || 0,
                    audioTrimEnd: opts.audioTrimEnd || 0,
                    loopAudio: opts.loopAudio || false
                });

                if (result.success && result.outputPath) {
                    currentVideoPath = result.outputPath;
                } else {
                    console.error('Ses ekleme hatası:', result.error);
                }
            }

            // Görselleri uygula
            for (const item of imageItems) {
                stepCount++;
                this.updateProgress(`Görsel ekleniyor (${stepCount}/${totalSteps})`, (stepCount / totalSteps) * 100);

                const opts = item.options;
                const videoDuration = VideoPlayer.getDuration();

                // Zamanlama ayarları
                const startTime = opts.startTime || 0;
                const endTime = opts.endTime === -1 || opts.durationMode === 'whole' ? videoDuration : (opts.endTime || videoDuration);

                const outputPath = await window.api.getTempPath(`image_${stepCount}_${Date.now()}.mp4`);

                const result = await window.api.addImageOverlay({
                    videoPath: currentVideoPath,
                    outputPath: outputPath,
                    imagePath: opts.imagePath,
                    options: {
                        x: opts.x || 0,
                        y: opts.y || 0,
                        width: opts.width || -1,
                        height: opts.height || -1,
                        opacity: opts.opacity || 1,
                        startTime: startTime,
                        endTime: endTime
                    }
                });

                if (result.success && result.outputPath) {
                    currentVideoPath = result.outputPath;
                } else {
                    console.error('Görsel ekleme hatası:', result.error);
                }
            }

            this.hideProgress();

            // Kullanıcıya kaydetme dialogu göster
            const saveResult = await window.api.showSaveDialog({
                title: 'Eklemeli Videoyu Kaydet',
                defaultPath: 'video_eklemeli.mp4',
                filters: [
                    { name: 'Video Dosyaları', extensions: ['mp4'] }
                ]
            });

            if (saveResult && saveResult.filePath) {
                // Geçici dosyayı kullanıcının seçtiği konuma kopyala
                await window.api.copyFile(currentVideoPath, saveResult.filePath);

                // Listeyi temizle
                InsertionQueue.clear();

                // Sonucu yükle
                await this.openFile(saveResult.filePath);
                Accessibility.announce(`${textItems.length} yazı, ${audioItems.length} ses ve ${imageItems.length} görsel eklendi. Dosya kaydedildi: ${saveResult.filePath}`);
            } else {
                // Kullanıcı iptal ettiyse geçici dosyayı yükle
                InsertionQueue.clear();
                await this.openFile(currentVideoPath);
                Accessibility.announce(`${textItems.length} yazı, ${audioItems.length} ses ve ${imageItems.length} görsel eklendi. Video geçici klasöre kaydedildi.`);
            }

        } catch (error) {
            this.hideProgress();
            console.error('applyAllInsertions hatası:', error);
            Accessibility.announceError(error.message);
        }
    },


    /**
     * Video ekle
     * @param {string} videoPath
     */
    async insertVideo(videoPath) {
        // Eğer dosya yolu yoksa, diyalog aç
        if (!videoPath) {
            const result = await window.api.openFileDialog({
                filters: [
                    { name: 'Videolar', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv'] },
                    { name: 'Tüm Dosyalar', extensions: ['*'] }
                ]
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return;
            }
            videoPath = result.filePaths[0];
        }

        if (!VideoPlayer.hasVideo()) {
            // İlk video olarak aç
            await this.openFile(videoPath);
            return;
        }

        Accessibility.announce('Video ekleniyor...');
        // TODO: FFmpeg ile video birleştirme logic'i (concat) buraya gelecek
    },

    /**
     * Metin overlay ekle
     * @param {string} text
     * @param {Object} options
     */
    async addTextOverlay(text, options) {
        if (!VideoPlayer.hasVideo()) return;

        this.showProgress('Metin ekleniyor');

        const outputPath = this.currentFilePath.replace(/\.[^.]+$/, '_text.mp4');

        const sel = Selection.getSelection();
        const startTime = sel ? sel.start : 0;
        const endTime = sel ? sel.end : VideoPlayer.getDuration(); // Seçim yoksa tüm video

        const result = await window.api.addTextOverlay({
            videoPath: this.currentFilePath,
            outputPath: outputPath,
            text: text,
            font: options.font,
            fontSize: options.fontSize,
            fontColor: options.fontColor,
            background: options.background,
            position: options.position,
            transition: options.transition,
            startTime: startTime,
            endTime: endTime,
            ttsEnabled: options.ttsEnabled,
            ttsVoice: options.ttsVoice,
            ttsSpeed: options.ttsSpeed,
            ttsVolume: options.ttsVolume,
            videoVolume: options.videoVolume,
            shadow: options.shadow
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Metin ekleme');
            await this.openFile(outputPath);
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Görseller ekle
     * @param {Array} imagePaths
     * @param {number} duration - Her görsel için süre
     */
    async insertImages(imagePaths, duration) {
        this.showProgress('Görseller ekleniyor');

        const outputPath = this.currentFilePath
            ? this.currentFilePath.replace(/\.[^.]+$/, '_images.mp4')
            : 'output_images.mp4';

        const result = await window.api.createVideoFromImages({
            imagePaths: imagePaths,
            outputPath: outputPath,
            duration: duration
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Görsel ekleme');
            await this.openFile(outputPath);
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Videoya görsel overlay ekle (Wizard üzerinden)
     */
    async addImageOverlay(options) {
        if (!VideoPlayer.hasVideo()) return;

        this.showProgress('Görsel ekleniyor');

        const { imagePath, x, y, width, height, opacity, startTime, endTime } = options;

        const outputPath = this.currentFilePath.replace(/\.[^.]+$/, '_image_overlay.mp4');

        const result = await window.api.addImageOverlay({
            videoPath: this.currentFilePath,
            imagePath: imagePath,
            outputPath: outputPath,
            options: { x, y, width, height, opacity, startTime, endTime }
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Görsel ekleme');
            await this.openFile(outputPath);
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Altyazı ekle
     * @param {string} subtitlePath
     */
    async insertSubtitle(subtitlePath) {
        if (!VideoPlayer.hasVideo()) return;

        // 1. Altyazı dosyasını oku ve parse et (Önizleme metni için)
        const fileResult = await window.api.readFileContent(subtitlePath);
        if (!fileResult.success) {
            Accessibility.announceError('Altyazı dosyası okunamadı');
            return;
        }

        const content = fileResult.content;
        const lines = content.split(/\r?\n/);
        let firstText = "Önizleme metni bulunamadı";
        const subtitles = [];

        // Basit SRT Parser
        let currentSub = {};
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                if (currentSub.text) {
                    subtitles.push(currentSub);
                    currentSub = {};
                }
                continue;
            }
            if (line.includes('-->')) {
                currentSub.timing = line;
            } else if (!currentSub.timing && /^\d+$/.test(line)) {
                currentSub.id = line;
            } else {
                currentSub.text = (currentSub.text ? currentSub.text + ' ' : '') + line;
            }
        }
        if (currentSub.text) subtitles.push(currentSub);
        if (subtitles.length > 0) firstText = subtitles[0].text;

        Accessibility.announce('Altyazı analiz edildi. Seçenekler açılıyor...');

        // 2. İşlem Seçimi Diyaloğu
        const action = await Dialogs.showSubtitleActionDialog();

        if (action === 'cancel' || !action) {
            Accessibility.announce('İşlem iptal edildi.');
            return;
        }

        // --- SEÇENEK A: Sadece Altyazı Göm ---
        if (action === 'burn') {
            await this.performSubtitleBurn(subtitlePath);
            return;
        }

        // --- SEÇENEK B ve C: TTS İşlemleri ---
        const ttsOptions = await Dialogs.showSubtitleTtsOptionsDialog(firstText);

        if (!ttsOptions || !ttsOptions.confirmed) {
            Accessibility.announce('Seslendirme işlemi iptal edildi.');
            return;
        }

        // İşlem Başlıyor
        this.showProgress('Seslendirme işlemi hazırlanıyor...');

        try {
            // master_silence oluştur
            const tempSilencePath = await window.api.getTempPath(`master_silence_${Date.now()}.wav`);
            await window.api.generateSilence({ duration: 3600, outputPath: tempSilencePath });

            const CHUNK_SIZE = 50;
            const chunkFiles = [];
            let currentChunkItems = [];
            let currentChunkStartTime = -1;
            const audioFilesToDelete = [tempSilencePath];

            // Helper: Chunk İşleme
            const processCurrentChunk = async (chunkIndex) => {
                if (currentChunkItems.length === 0) return;
                this.updateProgress(`Parçalar birleştiriliyor... (${chunkIndex})`, (chunkIndex * CHUNK_SIZE / subtitles.length) * 100);

                const chunkPath = await window.api.getTempPath(`chunk_${chunkIndex}_${Date.now()}.wav`);
                audioFilesToDelete.push(chunkPath);

                const mixRes = await window.api.createAudioFromMix({
                    audioSegments: currentChunkItems,
                    outputPath: chunkPath
                });

                if (!mixRes.success) throw new Error(`Chunk error: ${mixRes.error}`);

                chunkFiles.push({ path: chunkPath, offset: currentChunkStartTime });
                currentChunkItems = [];
                currentChunkStartTime = -1;
            };

            // Helper: Zaman Parse
            const parseTimestamp = (ts) => {
                const parts = ts.split(':');
                const sec = parts[2].split(/[,\.]/);
                return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(sec[0]) + parseInt(sec[1]) / 1000;
            };

            // 3. Tüm Altyazıları Dön (TTS Üretimi)
            for (let k = 0; k < subtitles.length; k++) {
                const sub = subtitles[k];
                const times = sub.timing.split('-->').map(t => t.trim());
                const startTime = parseTimestamp(times[0]);

                this.updateProgress(`Seslendiriliyor: ${k + 1}/${subtitles.length}`, (k / subtitles.length) * 90);

                if (currentChunkStartTime === -1) currentChunkStartTime = startTime;

                const ttsRes = await window.api.generateTts({
                    text: sub.text,
                    voice: ttsOptions.voice,
                    speed: ttsOptions.speed,
                    volume: ttsOptions.volume
                }).catch(e => ({ success: false }));

                if (ttsRes.success) {
                    audioFilesToDelete.push(ttsRes.wavPath);
                    const relativeOffset = Math.max(0, startTime - currentChunkStartTime);
                    currentChunkItems.push({ path: ttsRes.wavPath, offset: relativeOffset });
                }

                if (currentChunkItems.length >= CHUNK_SIZE) await processCurrentChunk(chunkFiles.length + 1);
            }
            if (currentChunkItems.length > 0) await processCurrentChunk(chunkFiles.length + 1);

            // 4. Final Ses Mixi
            this.showProgress('Sesler birleştiriliyor...');
            const fullTtsPath = await window.api.getTempPath(`full_tts_${Date.now()}.wav`);
            audioFilesToDelete.push(fullTtsPath);

            const concatRes = await window.api.createAudioFromMix({
                audioSegments: chunkFiles,
                outputPath: fullTtsPath
            });
            if (!concatRes.success) throw new Error(concatRes.error);

            // 5. Videoya Ses Ekleme (Mix)
            this.showProgress('Videoya işleniyor...');
            // Son ek: TTS only ise _tts.mp4, TTS+Burn ise _tts_sub.mp4
            const suffix = (action === 'tts-burn') ? '_tts_sub' : '_tts';
            let finalOutputPath = this.currentFilePath.replace(/\.[^.]+$/, `${suffix}.mp4`);

            // Eğer hem TTS hem Burn ise, burada oluşturacağımız dosya ARA dosyadır.
            // Çünkü henüz altyazıyı gömmedik, sadece sesi ekliyoruz.
            // Ama eğer sadece TTS ise final budur.
            let audioMixOutputPath = finalOutputPath;
            if (action === 'tts-burn') {
                audioMixOutputPath = await window.api.getTempPath(`pre_burn_mix_${Date.now()}.mp4`);
                audioFilesToDelete.push(audioMixOutputPath);
            }

            const mixRes = await window.api.mixAudio({
                videoPath: this.currentFilePath,
                audioPath: fullTtsPath,
                outputPath: audioMixOutputPath,
                videoVolume: ttsOptions.originalVolume, // Dialogdan gelen parametre
                audioVolume: 1.0
            });

            if (!mixRes.success) throw new Error(mixRes.error);

            // 6. Seçenek C ise: Altyazı Göm (Burn)
            if (action === 'tts-burn') {
                this.showProgress('Altyazılar görüntüye işleniyor (Gömülüyor)...');

                // Mixlenmiş video (audioMixOutputPath) üzerine altyazı göm
                const burnRes = await window.api.burnSubtitles({
                    videoPath: audioMixOutputPath,
                    subtitlePath: subtitlePath,
                    outputPath: finalOutputPath
                });

                if (!burnRes.success) throw new Error(`Altyazı gömme hatası: ${burnRes.error}`);
            }

            this.hideProgress();

            // Sonucu Aç
            Accessibility.announceComplete('İşlem');
            console.log('Yeni dosya yükleniyor:', finalOutputPath);
            await this.openFile(finalOutputPath);
            Accessibility.announce(`İşlem tamamlandı. Dosya açıldı: ${finalOutputPath.split(/[\\/]/).pop()}`);

            // Geçici dosyaları sil
            await window.api.invoke('delete-files', audioFilesToDelete);

        } catch (err) {
            this.hideProgress();
            console.error(err);
            Accessibility.announceError('Hata: ' + err.message);
        }
    },

    /**
     * CTA (Overlay) öğesini zaman çizelgesine ekle
     * @param {Object} params
     * @param {Object} params.asset - Seçilen asset
     * @param {Object} params.options - Kullanıcı seçenekleri (pos, scale, fade vb.)
     */
    async addCtaToTimeline(params) {
        if (!VideoPlayer.hasVideo()) {
            Accessibility.alert('Lütfen önce bir video açın.');
            return;
        }

        const { asset, options } = params;
        const currentVideoPath = this.currentFilePath;
        const outputPath = currentVideoPath.replace(/\.[^.]+$/, `_cta_${Date.now()}.mp4`);

        // Timeline cursor position is start time
        const startTime = VideoPlayer.getTimelineTime();

        // 1. İşlem başlıyor
        this.showProgress(`CTA Ekleniyor: ${asset.name}...`);

        try {
            // Eğer import edilen bir dosya ise, asset.path doğrudur.
            // Eğer built-in asset ise, path düzeltilmeli (örn: resources path)
            // CtaLibrary zaten path'i yönetiyor ama IPC'ye gönderirken absolute path olduğundan emin olunmalı.
            // Şimdilik CtaLibrary.assets içindeki pathler relative olduğu için onları fixlememiz gerekebilir.
            // Ama CtaLibrary sadece select yapıyor, path'i düzenleyip yollamıyor.

            // Eğer asset.isUser ise path zaten absolute.
            // Değilse, absolute path'i bulmaya çalışalım.
            // Not: Web ortamında 'assets/...' çalışır ama ffmpeg için full path gerekir.

            let assetPath = asset.path;
            if (!asset.isUser && !assetPath.includes(':')) { // Basit check: Windows path mi?
                // Relative path, absolute'a çevir
                // Renderer process'indeyiz.
                // Ana process'ten yardım alabiliriz veya process.cwd kullanabiliriz ama renderer'da process.cwd güvenilir değil.
                // En iyisi main process'te `findSfxPath` gibi bir mantık kullanmak veya IPC ile path resolve etmek.
                // Basit çözüm: assetPath'i olduğu gibi yolla, ffmpeg-handler (main) bunu çözsün.
                // Ama `addCtaOverlay` fonksiyonu `getVideoMetadata` çağırıyor, o da absolute path bekliyor.

                // Demo için placeholder kullanılıyorsa, gerçek bir dosya oluşturup onu kullanmalıyız.
                // Şimdilik demo dosyaların var olduğunu varsayalım veya kullanıcıyı uyaralım.
                // "assets/cta/like_demo.webm" gibi.

                // İPUCU: `findSfxPath` main process'teydi. Benzer bir `findAssetPath` main process'te olabilir.
                // Şimdilik assetPath'i olduğu gibi gönderiyoruz.
            }

            const result = await window.api.invoke('add-cta-overlay', {
                mainVideoPath: currentVideoPath,
                ctaPath: assetPath,
                outputPath: outputPath,
                position: options.position,
                scale: options.scale,
                opacity: options.opacity,
                duration: options.duration,
                fade: options.fade,
                sound: options.sound,
                startTime: startTime
            });

            this.hideProgress();

            if (result.success) {
                // Başarılı
                Accessibility.announceComplete('CTA ekleme');
                await this.openFile(outputPath);
            } else {
                // Hata
                Accessibility.announceError(`Hata: ${result.error}`);
            }

        } catch (err) {
            this.hideProgress();
            console.error(err);
            Accessibility.announceError('Beklenmeyen hata: ' + err.message);
        }
    },

    /**
     * Sadece altyazı gömme işlemini gerçekleştirir
     */
    async performSubtitleBurn(subtitlePath) {
        this.showProgress('Altyazı gömülüyor...');
        const outputPath = this.currentFilePath.replace(/\.[^.]+$/, '_sub.mp4');

        const result = await window.api.burnSubtitles({
            videoPath: this.currentFilePath,
            subtitlePath: subtitlePath,
            outputPath: outputPath
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Altyazı gömme');
            await this.openFile(outputPath);
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * Video döndür
     * @param {number} degrees
     */
    async rotateVideo(degrees) {
        if (!VideoPlayer.hasVideo()) return;

        this.showProgress('Video döndürülüyor');

        const outputPath = this.currentFilePath.replace(/\.[^.]+$/, `_rotated${degrees}.mp4`);

        const result = await window.api.rotateVideo({
            inputPath: this.currentFilePath,
            outputPath: outputPath,
            degrees: degrees
        });

        this.hideProgress();

        if (result.success) {
            Accessibility.announceComplete('Video döndürme');
            await this.openFile(outputPath);
        } else {
            Accessibility.announceError(result.error);
        }
    },

    /**
     * İlerleme göstergesini göster
     * @param {string} message
     */
    showProgress(message) {
        const overlay = document.getElementById('progress-overlay');
        const messageEl = document.getElementById('progress-message');
        const bar = document.getElementById('progress-bar');
        const percentEl = document.getElementById('progress-percent');

        if (overlay) {
            overlay.classList.remove('hidden');
            messageEl.textContent = message + '...';
            bar.value = 0;
            percentEl.textContent = '%0';
            StatusBar.update(message, 0);
        }

        // Klavye kısayollarını devre dışı bırak
        Keyboard.setEnabled(false);
    },

    /**
     * İlerleme göstergesini gizle
     */
    hideProgress() {
        const overlay = document.getElementById('progress-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }

        // Klavye kısayollarını etkinleştir
        Keyboard.setEnabled(true);
        StatusBar.clear();
    },

    /**
     * İlerlemeyi güncelle
     * @param {string} operation - İşlem kodu (örn: 'cut', 'concat')
     * @param {number} percent - Yüzde (0-100)
     */
    updateProgress(operation, percent) {
        const bar = document.getElementById('progress-bar');
        const percentEl = document.getElementById('progress-percent');
        const roundedPercent = Math.round(percent || 0);

        if (bar && percentEl) {
            bar.value = roundedPercent;
            percentEl.textContent = `%${roundedPercent}`;
        }

        // StatusBar güncelle
        StatusBar.update(operation, roundedPercent);

        // İşlem adını Türkçe'ye çevir
        const operationNames = {
            'cut': 'Video kesme',
            'concat': 'Video birleştirme',
            'rotate': 'Video döndürme',
            'extract-audio': 'Ses çıkarma',
            'extract-video': 'Video çıkarma',
            'mix-audio': 'Ses miksajı',
            'mix-audio-advanced': 'Gelişmiş ses miksajı',
            'burn-subtitles': 'Altyazı gömme',
            'add-text': 'Metin ekleme',
            'images-to-video': 'Video oluşturma',
            'convert': 'Video dönüştürme'
        };
        const operationName = operationNames[operation] || 'İşlem';

        // Erişilebilirlik: Her %10'da bir duyur (milestone yaklaşımı)
        const milestone = Math.floor(roundedPercent / 10) * 10;

        // Son duyurulan milestone'u takip et
        if (this._lastProgressMilestone === undefined) {
            this._lastProgressMilestone = -1;
        }

        // Yeni milestone'a ulaşıldıysa duyur
        if (milestone > this._lastProgressMilestone && milestone > 0) {
            this._lastProgressMilestone = milestone;
            Accessibility.announce(`${operationName}: Yüzde ${milestone}`);
        }

        // İşlem %100'e ulaştığında sıfırla
        if (roundedPercent >= 100) {
            this._lastProgressMilestone = -1;
        }
    },

    /**
     * Dosya kapatma isteğini işle
     */
    async handleFileCloseRequest() {
        if (!VideoPlayer.hasVideo()) {
            Accessibility.announce('Açık dosya yok');
            return;
        }

        if (this.hasChanges) {
            // Kaydetme onayı iste
            const result = await window.api.showSaveConfirm({
                title: 'Değişiklikleri Kaydet',
                message: 'Videoda kaydedilmemiş değişiklikler var. Kaydetmek istiyor musunuz?'
            });

            // 0 = Kaydet, 1 = Kaydetme, 2 = İptal
            if (result === 0) {
                // Kaydet
                await this.saveFile();
                this.closeCurrentFile();
            } else if (result === 1) {
                // Kaydetme - doğrudan kapat
                this.closeCurrentFile();
            }
            // result === 2 ise İptal - hiçbir şey yapma
        } else {
            this.closeCurrentFile();
        }
    },

    /**
     * Uygulama kapatma isteğini işle
     */
    async handleAppQuitRequest() {
        if (this.hasChanges) {
            // Kaydetme onayı iste
            const result = await window.api.showSaveConfirm({
                title: 'Değişiklikleri Kaydet',
                message: 'Videoda kaydedilmemiş değişiklikler var. Kaydetmek istiyor musunuz?'
            });

            // 0 = Kaydet, 1 = Kaydetme, 2 = İptal
            if (result === 0) {
                // Kaydet ve kapat
                await this.saveFile();
                window.api.sendQuitApp();
            } else if (result === 1) {
                // Kaydetme - doğrudan kapat
                window.api.sendQuitApp();
            }
            // result === 2 ise İptal - hiçbir şey yapma
        } else {
            window.api.sendQuitApp();
        }
    },

    /**
     * Mevcut dosyayı kapat (uygulama açık kalır)
     */
    closeCurrentFile() {
        // Video oynatıcıyı temizle
        VideoPlayer.unloadVideo();

        // Durum değişkenlerini sıfırla
        this.currentFilePath = null;
        this.originalFilePath = null;
        this.hasChanges = false;
        this.clipboard = null;
        this.undoStack = [];
        this.redoStack = [];

        // İşaretçileri ve seçimi temizle
        Markers.clearAll();
        Selection.clear();

        // UI'ı güncelle
        document.getElementById('current-time').textContent = '00:00:00';
        document.getElementById('total-time').textContent = '00:00:00';
        document.getElementById('file-name').textContent = 'Dosya açılmadı';

        // Metadata bilgilerini temizle
        document.getElementById('meta-resolution').textContent = '-';
        document.getElementById('meta-framerate').textContent = '-';
        document.getElementById('meta-codec').textContent = '-';
        document.getElementById('meta-size').textContent = '-';

        // Bekleyen duyuruları temizle
        Accessibility.clearPending();

        Accessibility.announceImmediate('Dosya kapatıldı. Yeni dosya açmak için Control artı O tuşlarına basın.');
    },

    /**
     * İlerleme göstergesini göster
     * @param {string} message - Gösterilecek mesaj
     */
    showProgress(message) {
        Accessibility.announce(message);
        // TODO: Görsel ilerleme çubuğu eklenebilir
        console.log('İşlem başladı:', message);
    },

    /**
     * İlerleme göstergesini gizle
     */
    hideProgress() {
        // TODO: Görsel ilerleme çubuğu gizlenebilir
        console.log('İşlem tamamlandı');
    },

    /**
     * Video dosyası ekle
     * @param {string} filePath - Eklenecek video dosyasının yolu
     */
    async insertVideo(filePath) {
        try {
            // Eklenecek videonun metadata'sını al
            const result = await window.api.getVideoMetadata(filePath);

            if (!result || !result.success || !result.data) {
                Accessibility.alert('Video bilgisi alınamadı');
                return;
            }

            const insertMetadata = result.data;

            // Eğer hiç video açık değilse veya boş proje ise - ilk video olarak aç
            if (!VideoPlayer.hasVideo() || Timeline.segments.length === 0) {
                await this.openFile(filePath);
                Accessibility.announce(`Video açıldı: ${insertMetadata.filename}`);
                return;
            }

            // Mevcut videonun özelliklerini al
            const sourceMetadata = VideoPlayer.metadata;

            if (!sourceMetadata) {
                Accessibility.alert('Mevcut video bilgisi alınamadı');
                return;
            }

            // Özellikleri karşılaştır
            const propsMatch = this.compareVideoProperties(sourceMetadata, insertMetadata);

            let videoToInsert = filePath;

            if (!propsMatch) {
                // Diyalog göster
                const choice = await Dialogs.showVideoMismatchDialog(sourceMetadata, insertMetadata);

                if (choice === 'cancel') {
                    Accessibility.announce('Video ekleme iptal edildi');
                    return;
                }

                if (choice === 'convert') {
                    // Video'yu kaynak özelliklere dönüştür
                    this.showProgress('Video dönüştürülüyor...');

                    // Geçici dosya oluştur
                    const tempPath = filePath.replace(/\.[^.]+$/, '_converted.mp4');

                    const convertResult = await window.api.convertVideo({
                        inputPath: filePath,
                        outputPath: tempPath,
                        options: {
                            width: sourceMetadata.width,
                            height: sourceMetadata.height,
                            fps: sourceMetadata.frameRate,
                            codec: 'h264',
                            bitrate: Math.round(sourceMetadata.bitrate / 1000) || 5000
                        }
                    });

                    this.hideProgress();

                    if (!convertResult.success) {
                        Accessibility.alert(`Dönüştürme hatası: ${convertResult.error}`);
                        return;
                    }

                    videoToInsert = tempPath;
                    Accessibility.announce('Video dönüştürüldü');
                }
            }

            // Video zamanını timeline pozisyonuna çevir
            const videoTime = VideoPlayer.getCurrentTime();
            const timelinePosition = this.videoTimeToTimelinePosition(videoTime);

            console.log(`insertVideo: videoTime=${videoTime.toFixed(2)}, timelinePosition=${timelinePosition.toFixed(2)}`);

            // Timeline'a yeni segment ekle
            const insertDuration = insertMetadata.duration;

            // Yeni segment oluştur
            const newSegment = {
                start: 0,
                end: insertDuration,
                sourceFile: videoToInsert
            };

            // Segment'i timeline'a ekle
            Timeline.insertSegmentAtPosition(timelinePosition, newSegment);

            this.hasChanges = true;

            Accessibility.announce(`Video eklendi: ${insertMetadata.filename}, süre: ${Utils.formatTime(insertDuration)}`);

            // Durum güncelle
            this.updateAfterEdit();

        } catch (error) {
            console.error('Video ekleme hatası:', error);
            Accessibility.alert(`Video eklenirken hata: ${error.message}`);
        }
    },

    /**
     * İki videonun özelliklerini karşılaştır
     * @param {Object} source - Kaynak video özellikleri
     * @param {Object} insert - Eklenecek video özellikleri
     * @returns {boolean} Özellikler uyuşuyor mu
     */
    compareVideoProperties(source, insert) {
        // Çözünürlük kontrolü (±%10 tolerans)
        const widthMatch = Math.abs(source.width - insert.width) < source.width * 0.1;
        const heightMatch = Math.abs(source.height - insert.height) < source.height * 0.1;

        // Kare hızı kontrolü (±2 fps tolerans)
        const fpsMatch = Math.abs(source.frameRate - insert.frameRate) < 2;

        return widthMatch && heightMatch && fpsMatch;
    },

    /**
     * Video zamanını timeline pozisyonuna çevir
     * Multi-source timeline'da video player zamanı segment içindeki offset'i verir,
     * bunu gerçek timeline pozisyonuna çevirmek için segment'i bulup timeline başlangıcını eklemeliyiz
     * @param {number} videoTime - Video player'daki mevcut zaman
     * @returns {number} Timeline pozisyonu
     */
    videoTimeToTimelinePosition(videoTime) {
        const segments = Timeline.segments;
        const currentSource = VideoPlayer.currentFilePath;

        if (!segments || segments.length === 0) {
            return videoTime;
        }

        let timelinePosition = 0;

        // Segment'ler arasında ara
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const segSource = seg.sourceFile || Timeline.sourceFile;
            const segDuration = seg.end - seg.start;

            // Bu segment mevcut kaynak dosyasından mı?
            if (segSource === currentSource || !seg.sourceFile) {
                // Video zamanı bu segment içinde mi?
                if (videoTime >= seg.start && videoTime < seg.end) {
                    // Segment içindeki offset'i ekle
                    const offsetInSegment = videoTime - seg.start;
                    return timelinePosition + offsetInSegment;
                }
            }

            timelinePosition += segDuration;
        }

        // Segment bulunamadıysa timeline sonunu döndür
        return Timeline.getTotalDuration();
    },

    /**
     * Tüm geçişleri videoya uygula
     */
    async applyAllTransitions() {
        if (!this.currentFilePath) {
            Accessibility.announce('Önce bir video açmalısınız');
            return;
        }

        const transitions = Transitions.getAll();
        if (transitions.length === 0) {
            Accessibility.announce('Uygulanacak geçiş yok. Ş tuşu ile geçiş ekleyin.');
            return;
        }

        // Onay al
        const confirmed = await Dialogs.showAccessibleConfirm(
            `${transitions.length} geçiş videoya uygulanacak. Bu işlem uzun sürebilir. Devam edilsin mi?`,
            'Geçişleri Uygula'
        );

        if (!confirmed) {
            Accessibility.announce('İşlem iptal edildi');
            return;
        }

        // Kayıt yeri seç
        const saveResult = await window.api.showSaveDialog({
            title: 'Geçişli Videoyu Kaydet',
            defaultPath: this.currentFilePath.replace(/(\.[^.]+)$/, '_transitions$1'),
            filters: [{ name: 'Video Dosyaları', extensions: ['mp4'] }]
        });

        if (!saveResult || saveResult.canceled) {
            Accessibility.announce('Kayıt yeri seçilmedi');
            return;
        }

        const outputPath = saveResult.filePath;

        // İlerleme göster
        const progressOverlay = document.getElementById('progress-overlay');
        const progressMessage = document.getElementById('progress-message');
        const progressPercent = document.getElementById('progress-percent');
        const progressBar = document.getElementById('progress-bar');

        if (progressOverlay) progressOverlay.classList.remove('hidden');
        if (progressMessage) progressMessage.textContent = 'Geçişler uygulanıyor...';
        if (progressPercent) progressPercent.textContent = '0%';
        if (progressBar) progressBar.value = 0;

        Accessibility.announce(`${transitions.length} geçiş uygulanıyor. Lütfen bekleyin.`);

        try {
            // Smart Transition Kullanımı
            const smartTransitions = transitions.map(t => ({
                transitionType: t.ffmpegType,
                time: t.time,
                duration: t.duration,
                useSfx: t.useSfx !== false,
                customSfxPath: t.customSfxPath,
                transitionName: t.transitionName
            }));

            // İlerleme dinleyicisi ekle
            const progressListener = (data) => {
                if (data.operation === 'apply-transitions') {
                    if (progressPercent) progressPercent.textContent = `${Math.round(data.percent)}%`;
                    if (progressBar) progressBar.value = data.percent;
                }
            };

            // Listener'ı kaydet (IPC üzerinden gelecek)
            window.api.onFfmpegProgress(progressListener);

            const result = await window.api.applyTransitionsSmart({
                videoPath: this.currentFilePath,
                outputPath: outputPath,
                transitions: smartTransitions
            });

            // Listener'ı temizle (Gerekirse, ama app.js global olduğu için kalabilir veya 
            // removeAllListeners ile temizlenebilir ama diğer işlemleri etkileyebilir.
            // Şimdilik kalsın, zaten üstüne yazar.)

            if (!result.success) {
                throw new Error(result.error || 'Geçiş uygulanamadı');
            }

            if (progressOverlay) progressOverlay.classList.add('hidden');

            Accessibility.announce(`Tamamlandı. ${transitions.length} geçiş başarıyla uygulandı. Video kaydedildi: ${outputPath}`);

            // Yeni videoyu aç
            const openNew = await Dialogs.showAccessibleConfirm(
                'Geçişler başarıyla uygulandı. Yeni videoyu açmak ister misiniz?',
                'Tamamlandı'
            );

            if (openNew) {
                await this.openFile(outputPath);
            }

        } catch (error) {
            if (progressOverlay) progressOverlay.classList.add('hidden');
            console.error('Geçiş uygulama hatası:', error);
            Accessibility.announce(`Hata: ${error.message}`);
        }
    },
    // ==========================================
    // Proje Yönetimi
    // ==========================================

    /**
     * Projeyi Kaydet
     */
    async saveProject() {
        if (!this.currentFilePath) {
            Accessibility.announce('Kaydedilecek bir proje yok (video yüklenmedi).');
            return;
        }

        try {
            // CTA overlay'leri al
            const ctaOverlays = typeof CtaOverlayPreview !== 'undefined'
                ? CtaOverlayPreview.exportForProject()
                : [];

            const projectData = {
                videoPath: this.currentFilePath,
                timeline: {
                    segments: Timeline.getSegments(),
                    sourceFile: Timeline.sourceFile,
                    sourceDuration: Timeline.sourceDuration
                },
                insertionQueue: InsertionQueue.getItems(),
                transitions: Transitions.getAll(),
                markers: Markers.getAll ? Markers.getAll() : [],
                ctaOverlays: ctaOverlays,
                version: '1.2'
            };

            const result = await window.api.showSaveDialog({
                title: 'Projeyi Kaydet',
                defaultPath: 'proje.kve',
                filters: [{ name: 'Korcul Proje Dosyası', extensions: ['kve'] }]
            });

            if (!result.canceled && result.filePath) {
                const jsonContent = JSON.stringify(projectData, null, 2);
                const saveResult = await window.api.saveFileContent({
                    filePath: result.filePath,
                    content: jsonContent
                });

                if (saveResult.success) {
                    Accessibility.announce('Proje başarıyla kaydedildi.');
                } else {
                    Accessibility.announce('Kaydetme hatası: ' + saveResult.error);
                }
            }
        } catch (error) {
            console.error(error);
            Accessibility.announce('Proje kaydedilemedi: ' + error.message);
        }
    },

    /**
     * Projeyi Yükle
     */
    async loadProject() {
        try {
            const result = await window.api.openFileDialog({
                title: 'Proje Aç',
                filters: [{ name: 'Korcul Proje Dosyası', extensions: ['kve'] }],
                properties: ['openFile']
            });

            if (result.canceled || result.filePaths.length === 0) return;

            const contentResult = await window.api.readFileContent(result.filePaths[0]);
            if (!contentResult.success) {
                Accessibility.announce('Dosya okunamadı: ' + contentResult.error);
                return;
            }

            const projectData = JSON.parse(contentResult.content);

            // Videoyu yükle
            if (projectData.videoPath) {
                let videoToLoad = projectData.videoPath;
                let videoFound = false;

                // 1. Mutlak yolda var mı?
                const checkAbs = await window.api.checkFileExists(videoToLoad);
                if (checkAbs) {
                    videoFound = true;
                } else {
                    // 2. Proje dosyasının yanında mı? (Relative check)
                    const projectDir = result.filePaths[0].replace(/[/\\][^/\\]+$/, ''); // Klasör yolu
                    const fileName = videoToLoad.split(/[/\\]/).pop(); // Dosya adı
                    // Windows/Unix path birleştirme (basit)
                    const relativePath = projectDir + (projectDir.includes('/') ? '/' : '\\') + fileName;

                    const checkRel = await window.api.checkFileExists(relativePath);
                    if (checkRel) {
                        videoToLoad = relativePath;
                        videoFound = true;
                        console.log('Video proje klasöründe bulundu:', videoToLoad);
                    }
                }

                // 3. Hala bulunamadıysa kullanıcıya sor
                if (!videoFound) {
                    const userChoice = await Dialogs.showAccessibleConfirm(
                        `Projedeki video dosyası (${videoToLoad.split(/[/\\]/).pop()}) bulunamadı. Yerini kendiniz göstermek ister misiniz?`,
                        'Gözat',
                        'İptal'
                    );

                    if (userChoice) {
                        const manualSelect = await window.api.openFileDialog({
                            title: 'Video Dosyasını Bul',
                            filters: [{ name: 'Video Dosyaları', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }],
                            properties: ['openFile']
                        });

                        if (!manualSelect.canceled && manualSelect.filePaths.length > 0) {
                            videoToLoad = manualSelect.filePaths[0];
                            videoFound = true;
                        } else {
                            Accessibility.announce('Video seçilmedi. Proje yükleme iptal edildi.');
                            return;
                        }
                    } else {
                        Accessibility.announce('Video bulunamadığı için proje yüklenemedi.');
                        return;
                    }
                }

                // Videoyu aç
                try {
                    await this.openFile(videoToLoad, false);
                } catch (e) {
                    Accessibility.announce('Video dosyası açılamadı.');
                    console.error('Video open error:', e);
                    return;
                }
            }

            // Timeline'ı geri yükle
            if (projectData.timeline) {
                Timeline.restoreState(
                    projectData.timeline.segments,
                    projectData.timeline.sourceFile || projectData.videoPath,
                    projectData.timeline.sourceDuration || VideoPlayer.getDuration()
                );
            }

            // Ekleme listesini geri yükle
            if (projectData.insertionQueue) {
                InsertionQueue.restore(projectData.insertionQueue);
            }

            // CTA Overlay'leri geri yükle
            if (projectData.ctaOverlays && typeof CtaOverlayPreview !== 'undefined') {
                CtaOverlayPreview.importFromProject(projectData.ctaOverlays);
            }

            // Geçişleri yükle
            if (projectData.transitions) {
                Transitions.restore(projectData.transitions);
                Dialogs.updateAppliedTransitionList();
            }

            // İşaretçileri yükle
            // İşaretçileri yükle
            console.log('Restoring markers...', projectData.markers);
            if (projectData.markers && typeof Markers !== 'undefined' && Markers.restore) {
                Markers.restore(projectData.markers);
                console.log('Markers restored successfully.');
            } else {
                console.warn('Markers restoration skipped:', {
                    hasData: !!projectData.markers,
                    markersModule: typeof Markers !== 'undefined',
                    hasRestore: Markers && !!Markers.restore
                });
            }

            Accessibility.announce('Proje başarıyla yüklendi.');

        } catch (error) {
            console.error('Project load error:', error);
            Accessibility.announce('Proje yüklenemedi: ' + error.message);
        }
    }
};

// Sayfa yüklendiğinde başlat
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

// Global olarak erişilebilir yap
window.App = App;
