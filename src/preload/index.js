const { contextBridge, ipcRenderer, shell } = require('electron');

const ffmpegProgressCallbacks = new Set();
let ffmpegProgressBridgeRegistered = false;

function ensureFfmpegProgressBridge() {
    if (ffmpegProgressBridgeRegistered) return;
    ffmpegProgressBridgeRegistered = true;
    ipcRenderer.on('ffmpeg-progress', (_event, data) => {
        for (const callback of Array.from(ffmpegProgressCallbacks)) {
            try {
                callback(data);
            } catch (error) {
                console.error('ffmpeg-progress callback error:', error);
            }
        }
    });
}

ipcRenderer.on('accessibility-dialog-announce', (_event, payload) => {
    try {
        window.dispatchEvent(new CustomEvent('evd-accessibility-dialog-announce', {
            detail: payload || {}
        }));
    } catch (error) {
        console.warn('Failed to dispatch accessibility dialog announcement:', error);
    }
});

// Güvenli API'yi renderer'a aç
contextBridge.exposeInMainWorld('api', {
    platform: process.platform,

    // Video işlemleri
    getVideoMetadata: (filePath) => ipcRenderer.invoke('get-video-metadata', filePath),
    cutVideo: (params) => ipcRenderer.invoke('cut-video', params),
    cutVideoFast: (params) => ipcRenderer.invoke('cut-video-fast', params),
    getCutVideoFastBounds: (params) => ipcRenderer.invoke('get-cut-video-fast-bounds', params),
    cutVideoSmart: (params) => ipcRenderer.invoke('cut-video-smart', params),
    renderTimeline: (params) => ipcRenderer.invoke('render-timeline', params),
    concatVideos: (params) => ipcRenderer.invoke('concat-videos', params),
    concatVideosFast: (params) => ipcRenderer.invoke('concat-videos-fast', params),

    rotateVideo: (params) => ipcRenderer.invoke('rotate-video', params),
    extractAudio: (params) => ipcRenderer.invoke('extract-audio', params),
    extractVideo: (params) => ipcRenderer.invoke('extract-video', params),
    mixAudio: (params) => ipcRenderer.invoke('mix-audio', params),
    mixAudioAdvanced: (params) => ipcRenderer.invoke('mix-audio-advanced', params),
    burnSubtitles: (params) => ipcRenderer.invoke('burn-subtitles', params),
    addTextOverlay: (params) => ipcRenderer.invoke('add-text-overlay', params),
    addImageOverlay: (params) => ipcRenderer.invoke('add-image-overlay', params),
    addTransition: (params) => ipcRenderer.invoke('add-transition', params),
    applyTransitionsSmart: (params) => ipcRenderer.invoke('apply-transitions-smart', params),
    createVideoFromImages: (params) => ipcRenderer.invoke('create-video-from-images', params),
    extractFrame: (params) => ipcRenderer.invoke('extract-frame', params),
    extractFrameBase64: (params) => ipcRenderer.invoke('extract-frame-base64', params),
    extractFrameWithOverlay: (params) => ipcRenderer.invoke('extract-frame-with-overlay', params),
    detectSilence: (params) => ipcRenderer.invoke('detect-silence', params),
    saveBase64Image: (params) => ipcRenderer.invoke('save-base64-image', params),
    readFileBase64: (filePath) => ipcRenderer.invoke('read-file-base64', filePath),

    // TTS (Text-to-Speech) işlemleri
    getTtsVoices: (params) => ipcRenderer.invoke('get-tts-voices', params),
    getSystemTtsVoicesDetailed: () => ipcRenderer.invoke('get-system-tts-voices-detailed'),
    generateTts: (params) => ipcRenderer.invoke('generate-tts', params),
    previewTts: (params) => ipcRenderer.invoke('preview-tts', params),
    ttsSpeakPreview: (params) => ipcRenderer.invoke('tts-speak-preview', params),
    ttsStop: () => ipcRenderer.invoke('tts-stop'),

    // Ses (Audio) Yardımcıları
    generateSilence: (params) => ipcRenderer.invoke('generate-silence', params),
    createAudioFromListContent: (params) => ipcRenderer.invoke('create-audio-from-list-content', params),
    createAudioFromMix: (params) => ipcRenderer.invoke('create-audio-from-mix', params),
    previewAudioSegment: (params) => ipcRenderer.invoke('preview-audio-segment', params),

    // Geçici dosya yolu oluştur
    getTempPath: (filename) => ipcRenderer.invoke('get-temp-path', filename),

    // Yardımcı fonksiyonlar
    formatTime: (seconds) => ipcRenderer.invoke('format-time', seconds),
    parseTime: (timeString) => ipcRenderer.invoke('parse-time', timeString),

    // Diyaloglar
    showError: (params) => ipcRenderer.invoke('show-error', params),
    showInfo: (params) => ipcRenderer.invoke('show-info', params),
    showConfirm: (params) => ipcRenderer.invoke('show-confirm', params),
    showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
    showSaveConfirm: (params) => ipcRenderer.invoke('show-save-confirm', params),
    showSaveDialog: (params) => ipcRenderer.invoke('show-save-dialog', params),
    openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
    openTextOverlayDialog: (params) => ipcRenderer.invoke('open-text-overlay-dialog', params),

    saveFileContent: (params) => ipcRenderer.invoke('save-file-content', params),
    readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),

    // Dosya işlemleri
    copyFile: (src, dest) => ipcRenderer.invoke('copy-file', { src, dest }),
    checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
    addRecentFile: (filePath) => ipcRenderer.invoke('add-recent-file', filePath),

    // Video yolu istekleri (Gemini için)
    onGetCurrentVideoPath: (callback) => ipcRenderer.on('get-current-video-path', () => callback()),
    sendCurrentVideoPath: (path) => ipcRenderer.send('current-video-path-response', path),

    // Event dinleyicileri
    onFileOpen: (callback) => ipcRenderer.on('file-open', (event, filePath) => callback(filePath)),
    onFileSave: (callback) => ipcRenderer.on('file-save', () => callback()),
    onFileSaveAs: (callback) => ipcRenderer.on('file-save-as', (event, filePath) => callback(filePath)),
    onFileSaveSelection: (callback) => ipcRenderer.on('file-save-selection', (event, filePath) => callback(filePath)),
    onFileSaveSelectionRequest: (callback) => ipcRenderer.on('file-save-selection-request', () => callback()),
    onFileSaveSelectionFastRequest: (callback) => ipcRenderer.on('file-save-selection-fast-request', () => callback()),
    onFileSaveFast: (callback) => ipcRenderer.on('file-save-fast', (event, filePath) => callback(filePath)),
    onExportVideoOnly: (callback) => ipcRenderer.on('export-video-only', (event, filePath) => callback(filePath)),
    onExportAudioOnly: (callback) => ipcRenderer.on('export-audio-only', (event, filePath) => callback(filePath)),

    // Yeni proje
    onFileNew: (callback) => ipcRenderer.on('file-new', () => callback()),

    // Proje Yönetimi (.kve)
    onProjectSave: (callback) => ipcRenderer.on('project-save', () => callback()),
    onProjectOpen: (callback) => ipcRenderer.on('project-open', () => callback()),
    onProjectFileOpen: (callback) => ipcRenderer.on('project-open-file', (event, filePath) => callback(filePath)),

    // Düzenleme olayları
    onEditUndo: (callback) => ipcRenderer.on('edit-undo', () => callback()),
    onEditRedo: (callback) => ipcRenderer.on('edit-redo', () => callback()),
    onEditCut: (callback) => ipcRenderer.on('edit-cut', () => callback()),
    onEditCopy: (callback) => ipcRenderer.on('edit-copy', () => callback()),
    onEditPaste: (callback) => ipcRenderer.on('edit-paste', () => callback()),
    onEditDelete: (callback) => ipcRenderer.on('edit-delete', () => callback()),
    onEditSplit: (callback) => ipcRenderer.on('edit-split', () => callback()),

    // Seçim olayları
    onSelectAll: (callback) => ipcRenderer.on('select-all', () => callback()),
    onSelectClear: (callback) => ipcRenderer.on('select-clear', () => callback()),
    onSelectRangeDialog: (callback) => ipcRenderer.on('select-range-dialog', () => callback()),
    onSelectBetweenMarkers: (callback) => ipcRenderer.on('select-between-markers', () => callback()),
    onShowSpeedDialog: (callback) => ipcRenderer.on('show-speed-dialog', () => callback()),
    onIntelligentSelection: (callback) => ipcRenderer.on('intelligent-selection', () => callback()),

    // Ekleme olayları
    onInsertAudio: (callback) => ipcRenderer.on('insert-audio', (event, filePath) => callback(filePath)),
    onInsertAudioRequest: (callback) => ipcRenderer.on('insert-audio-request', () => callback()),
    onInsertVideo: (callback) => ipcRenderer.on('insert-video', (event, filePath) => callback(filePath)),
    onVerticalVideoFromSelection: (callback) => ipcRenderer.on('vertical-video-from-selection', () => callback()),
    onVerticalVideoQueueAddSelection: (callback) => ipcRenderer.on('vertical-video-queue-add-selection', () => callback()),
    onVerticalVideoQueueAddMarkerPairs: (callback) => ipcRenderer.on('vertical-video-queue-add-marker-pairs', () => callback()),
    onVerticalVideoQueueOpen: (callback) => ipcRenderer.on('vertical-video-queue-open', () => callback()),
    onVerticalVideoQueueClear: (callback) => ipcRenderer.on('vertical-video-queue-clear', () => callback()),
    onSelectionQueueOpen: (callback) => ipcRenderer.on('selection-queue-open', () => callback()),

    // Kayıt tamamlandıktan sonra
    onAddToTimeline: (callback) => ipcRenderer.on('add-to-timeline', (event, filePath) => callback(filePath)),

    onInsertTextDialog: (callback) => ipcRenderer.on('insert-text-dialog', () => callback()),
    onInsertImages: (callback) => ipcRenderer.on('insert-images', (event, filePaths) => callback(filePaths)),
    onOpenImageWizard: (callback) => ipcRenderer.on('open-image-wizard', () => callback()),
    onOpenVideoLayerWizard: (callback) => ipcRenderer.on('open-video-layer-wizard', (event, filePath) => callback(filePath)),
    addVideoLayer: (params) => ipcRenderer.invoke('add-video-layer', params),
    getVideoLayerAiSuggestion: (params) => ipcRenderer.invoke('get-video-layer-ai-suggestion', params),
    onInsertSubtitle: (callback) => ipcRenderer.on('insert-subtitle', (event, filePath) => callback(filePath)),

    // Görünüm olayları
    onRotateVideo: (callback) => ipcRenderer.on('rotate-video', (event, degrees) => callback(degrees)),

    // Klavye kontrolü (dialog penceresi açıldığında)
    onKeyboardDisable: (callback) => ipcRenderer.on('keyboard-disable', () => callback()),
    onKeyboardEnable: (callback) => ipcRenderer.on('keyboard-enable', () => callback()),

    // Ekleme listesi olayları
    onInsertionQueueAdd: (callback) => ipcRenderer.on('insertion-queue-add', (event, data) => callback(data)),
    onInsertionQueueUpdate: (callback) => ipcRenderer.on('insertion-queue-update', (event, data) => callback(data)),
    onShowInsertionQueue: (callback) => ipcRenderer.on('show-insertion-queue', () => callback()),
    onTextOverlayDirectApply: (callback) => ipcRenderer.on('text-overlay-direct-apply', (event, options) => callback(options)),

    // Geçiş olayları
    onShowCtaLibrary: (callback) => ipcRenderer.on('show-cta-library', () => callback()),
    onShowTransitionLibrary: (callback) => ipcRenderer.on('show-transition-library', () => callback()),
    onApplyActiveTransition: (callback) => ipcRenderer.on('apply-active-transition', () => callback()),
    onApplyTransitionToMarkers: (callback) => ipcRenderer.on('apply-transition-to-markers', () => callback()),
    onShowTransitionList: (callback) => ipcRenderer.on('show-transition-list', () => callback()),
    onApplyAllTransitions: (callback) => ipcRenderer.on('apply-all-transitions', () => callback()),

    // Navigasyon olayları
    onGotoTimeDialog: (callback) => ipcRenderer.on('goto-time-dialog', () => callback()),
    onGotoStart: (callback) => ipcRenderer.on('goto-start', () => callback()),
    onGotoEnd: (callback) => ipcRenderer.on('goto-end', () => callback()),
    onGotoMiddle: (callback) => ipcRenderer.on('goto-middle', () => callback()),
    onGotoNextMarker: (callback) => ipcRenderer.on('goto-next-marker', () => callback()),
    onGotoPrevMarker: (callback) => ipcRenderer.on('goto-prev-marker', () => callback()),
    onGotoSelectionStart: (callback) => ipcRenderer.on('goto-selection-start', () => callback()),
    onGotoSelectionEnd: (callback) => ipcRenderer.on('goto-selection-end', () => callback()),

    // İşaretçi olayları
    onMarkerAdd: (callback) => ipcRenderer.on('marker-add', () => callback()),
    onMarkerDelete: (callback) => ipcRenderer.on('marker-delete', () => callback()),
    onMarkerClearAll: (callback) => ipcRenderer.on('marker-clear-all', () => callback()),
    onMarkerListDialog: (callback) => ipcRenderer.on('marker-list-dialog', () => callback()),

    // Yardım olayları
    onShowShortcuts: (callback) => ipcRenderer.on('show-shortcuts', () => callback()),
    onShowKeyboardManager: (callback) => ipcRenderer.on('show-keyboard-manager', () => callback()),
    onShowHelp: (callback) => ipcRenderer.on('show-help', () => callback()),
    onShowFeedback: (callback) => ipcRenderer.on('show-feedback', () => callback()),
    onShowStartupWelcome: (callback) => ipcRenderer.on('show-startup-welcome', () => callback()),
    onShowFineTuneDialog: (callback) => ipcRenderer.on('show-fine-tune-dialog', () => callback()),
    onShowAudioSettingsDialog: (callback) => ipcRenderer.on('show-audio-settings-dialog', () => callback()),
    createFeedbackDraft: (params) => ipcRenderer.invoke('create-feedback-draft', params),

    // Uygulama olayları
    setWindowTitle: (title) => ipcRenderer.send('set-window-title', title),
    onAppReady: (callback) => ipcRenderer.on('app-ready', (event, data) => callback(data)),
    onNativeMenuState: (callback) => ipcRenderer.on('native-menu-state', (event, active) => callback(active)),
    onAccessibilityChanged: (callback) => ipcRenderer.on('accessibility-changed', (event, enabled) => callback(enabled)),
    onFfmpegProgress: (callback) => {
        ensureFfmpegProgressBridge();
        ffmpegProgressCallbacks.add(callback);
        return () => ffmpegProgressCallbacks.delete(callback);
    },
    offFfmpegProgress: (callback) => {
        ffmpegProgressCallbacks.delete(callback);
    },
    onFileCloseRequest: (callback) => ipcRenderer.on('file-close-request', () => callback()),
    onAppQuitRequest: (callback) => ipcRenderer.on('app-quit-request', () => callback()),
    onFileClosed: (callback) => ipcRenderer.on('file-closed', () => callback()),

    // Oynatma olayları
    onPlaybackToggle: (callback) => ipcRenderer.on('playback-toggle', () => callback()),
    onPlaybackPauseAtPosition: (callback) => ipcRenderer.on('playback-pause-at-position', () => callback()),
    onPlaybackPlaySelection: (callback) => ipcRenderer.on('playback-play-selection', () => callback()),
    onPlaybackPlayCutPreview: (callback) => ipcRenderer.on('playback-play-cut-preview', () => callback()),
    onSeekForward: (callback) => ipcRenderer.on('seek-forward', (event, seconds) => callback(seconds)),
    onSeekBackward: (callback) => ipcRenderer.on('seek-backward', (event, seconds) => callback(seconds)),
    onGotoStart: (callback) => ipcRenderer.on('goto-start', () => callback()),
    onGotoEnd: (callback) => ipcRenderer.on('goto-end', () => callback()),
    onGotoMiddle: (callback) => ipcRenderer.on('goto-middle', () => callback()),
    onGotoBeforeEnd: (callback) => ipcRenderer.on('goto-before-end', () => callback()),
    onGotoTimeDialog: (callback) => ipcRenderer.on('goto-time-dialog', () => callback()),

    // Wizard/Dialog Açma
    openSyncWizard: (mode) => ipcRenderer.send('open-sync-wizard', mode),
    openVerticalWizard: (data) => ipcRenderer.send('open-vertical-wizard', data),
    openRecordingWizard: (options) => ipcRenderer.send('open-recording-wizard', options),
    openBroadcastRoom: (options) => ipcRenderer.send('open-broadcast-room', options),
    resumeActiveRecordingWizard: () => ipcRenderer.invoke('recording-wizard-resume-active-session'),
    openLiveEffectsPanel: () => ipcRenderer.send('open-live-effects-panel'),
    openExternal: (url) => shell.openExternal(url),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    isPortableMode: () => ipcRenderer.invoke('app-is-portable'),

    // Main process'e mesaj gönder
    sendCloseWindow: () => ipcRenderer.send('close-window'),
    sendQuitApp: () => ipcRenderer.send('quit-app'),

    // Video dönüştürme
    convertVideo: (params) => ipcRenderer.invoke('convert-video', params),

    // Düzen olayları
    onEditVideoProperties: (callback) => ipcRenderer.on('edit-video-properties', () => callback()),
    onEditListSilences: (callback) => ipcRenderer.on('edit-list-silences', () => callback()),

    // Oynatma olayları
    onPlaybackSkipSilence: (callback) => ipcRenderer.on('playback-skip-silence', () => callback()),

    // Gemini
    saveGeminiApiKey: (params) => ipcRenderer.invoke('save-gemini-api-key', params),
    getGeminiApiKey: () => ipcRenderer.invoke('get-gemini-api-key'),
    getGeminiApiData: () => ipcRenderer.invoke('get-gemini-api-data'),
    geminiVisionRequest: (params) => ipcRenderer.invoke('gemini-vision-request', params),
    geminiDescribeSelection: (params) => ipcRenderer.invoke('gemini-describe-selection', params),
    geminiLiveTranslateStart: (params) => ipcRenderer.invoke('gemini-live-translate-start', params),
    geminiLiveTranslateStop: () => ipcRenderer.invoke('gemini-live-translate-stop'),
    geminiLiveTranslateStopChannel: (params) => ipcRenderer.invoke('gemini-live-translate-stop-channel', params),
    setInstantVoiceTranslationAudioSessionVolume: (params) => ipcRenderer.invoke('instant-voice-translation-audio-session-volume', params),
    sendGeminiLiveTranslateAudioChunk: (params) => ipcRenderer.send('gemini-live-translate-audio-chunk', params),
    onGeminiLiveTranslateEvent: (callback) => ipcRenderer.on('gemini-live-translate-event', (event, payload) => callback(payload)),
    saveInstantVoiceTranslationAudio: (params) => ipcRenderer.invoke('save-instant-voice-translation-audio', params),
    getDesktopSources: (options) => ipcRenderer.invoke('get-desktop-sources', options),
    getWindowProcessSources: () => ipcRenderer.invoke('get-window-process-sources'),
    getNativeAudioCapabilities: () => ipcRenderer.invoke('get-native-audio-capabilities'),
    hideInstantVoiceTranslationToTray: () => ipcRenderer.invoke('instant-voice-translation-hide-to-tray'),
    registerGlobalShortcut: (registration) => ipcRenderer.invoke('register-global-shortcut', registration),
    unregisterGlobalShortcut: (accelerator) => ipcRenderer.invoke('unregister-global-shortcut', accelerator),
    onGlobalShortcutTriggered: (callback) => ipcRenderer.on('global-shortcut-triggered', (event, accelerator) => callback(accelerator)),
    onEditDescribeSelection: (callback) => ipcRenderer.on('edit-describe-selection', () => callback()),
    onEditGeminiApiKey: (callback) => ipcRenderer.on('edit-gemini-api-key', () => callback()),
    onShowInstantVoiceTranslation: (callback) => ipcRenderer.on('show-instant-voice-translation', () => callback()),
    saveOpenAiApiKey: (params) => ipcRenderer.invoke('save-openai-api-key', params),
    getOpenAiApiKey: () => ipcRenderer.invoke('get-openai-api-key'),
    getOpenAiApiData: () => ipcRenderer.invoke('get-openai-api-data'),
    openAiLiveTranslateStart: (params) => ipcRenderer.invoke('openai-live-translate-start', params),
    openAiLiveTranslateStop: () => ipcRenderer.invoke('openai-live-translate-stop'),
    openAiLiveTranslateStopChannel: (params) => ipcRenderer.invoke('openai-live-translate-stop-channel', params),
    sendOpenAiLiveTranslateAudioChunk: (params) => ipcRenderer.send('openai-live-translate-audio-chunk', params),
    onOpenAiLiveTranslateEvent: (callback) => ipcRenderer.on('openai-live-translate-event', (event, payload) => callback(payload)),
    onEditOpenAiApiKey: (callback) => ipcRenderer.on('edit-openai-api-key', () => callback()),
    saveElevenLabsApiKey: (params) => ipcRenderer.invoke('save-elevenlabs-api-key', params),
    getElevenLabsApiKey: () => ipcRenderer.invoke('get-elevenlabs-api-key'),
    getElevenLabsApiData: () => ipcRenderer.invoke('get-elevenlabs-api-data'),
    onEditElevenLabsApiKey: (callback) => ipcRenderer.on('edit-elevenlabs-api-key', () => callback()),
    onAiDescribeCurrentPosition: (callback) => ipcRenderer.on('ai-describe-current-position', (event, duration) => callback(duration)),

    // Nesne Analizi
    checkAiModelStatus: () => ipcRenderer.invoke('check-ai-model-status'),
    analyzeSceneObjects: (params) => ipcRenderer.invoke('analyze-scene-objects', params),
    applyObjectEffect: (params) => ipcRenderer.invoke('apply-object-effect', params),
    onShowObjectAnalysisDialog: (callback) => ipcRenderer.on('show-object-analysis-dialog', () => callback()),
    onAnalysisProgress: (callback) => ipcRenderer.on('analysis-progress', (event, data) => callback(data)),
    onAnalysisStatus: (callback) => ipcRenderer.on('analysis-status', (event, msg) => callback(msg)),
    onAnalysisError: (callback) => ipcRenderer.on('analysis-error', (event, msg) => callback(msg)),

    // Dosya yönetimi
    deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),
    renameFile: (params) => ipcRenderer.invoke('rename-file', params),

    // CTA Overlay
    addCtaOverlay: (params) => ipcRenderer.invoke('add-cta-overlay', params),
    applyCtaOverlaysSmart: (params) => ipcRenderer.invoke('apply-cta-overlays-smart', params),

    // === MEDIA COMPATIBILITY SERVICE ===
    // Akıllı dosya açma (uyumluluk kontrolü + gerekirse dönüştürme)
    smartOpenVideo: (filePath) => ipcRenderer.invoke('smart-open-video', filePath),
    // Sadece uyumluluk analizi (dönüştürme yapmadan)
    analyzeVideoCompatibility: (filePath) => ipcRenderer.invoke('analyze-video-compatibility', filePath),
    // Detaylı video probe
    probeVideo: (filePath) => ipcRenderer.invoke('probe-video', filePath),
    // Hızlı remux (container değiştir, codec kopyala)
    quickRemux: (filePath) => ipcRenderer.invoke('quick-remux', filePath),
    // Akıllı transcode
    smartTranscode: (params) => ipcRenderer.invoke('smart-transcode', params),
    // Cache yönetimi
    clearMediaCache: (olderThanDays) => ipcRenderer.invoke('clear-media-cache', olderThanDays),
    getMediaCacheSize: () => ipcRenderer.invoke('get-media-cache-size'),
    // Media compatibility event'leri
    onMediaCompatProgress: (callback) => ipcRenderer.on('media-compat-progress', (event, data) => callback(data)),
    onMediaCompatStatus: (callback) => ipcRenderer.on('media-compat-status', (event, data) => callback(data)),

    // Context Menu
    showContextMenu: (template) => ipcRenderer.send('show-context-menu', template),
    onContextMenuCommand: (callback) => ipcRenderer.on('context-menu-command', (event, data) => callback(data)),

    // Ses Kaydı
    saveTempRecording: (buffer) => ipcRenderer.invoke('save-temp-recording', buffer),
    onInsertAudioRequest: (callback) => ipcRenderer.on('insert-audio-request', () => callback()),

    // Global Kısayollar
    registerGlobalShortcut: (registration) => ipcRenderer.invoke('register-global-shortcut', registration),
    unregisterAllGlobalShortcuts: () => ipcRenderer.invoke('unregister-all-global-shortcuts'),
    onGlobalShortcutTriggered: (callback) => ipcRenderer.on('global-shortcut-triggered', (event, accelerator) => callback(accelerator)),

    // Genel Send
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),

    // I18n
    i18n: {
        t: (key, params) => ipcRenderer.invoke('i18n-t', key, params),
        getLanguage: () => ipcRenderer.invoke('i18n-get-language'),
        getSavedLanguage: () => ipcRenderer.invoke('i18n-get-saved-language'),
        changeLanguage: (lang) => ipcRenderer.invoke('i18n-change-language', lang),
        getAll: () => ipcRenderer.invoke('i18n-get-all'),
        onLanguageChanged: (callback) => ipcRenderer.on('language-changed', (event, lang) => callback(lang))
    },

    // Event dinleyicisini kaldır
    removeAllListeners: (channel) => {
        if (channel === 'ffmpeg-progress') {
            ffmpegProgressCallbacks.clear();
            return;
        }
        ipcRenderer.removeAllListeners(channel);
    }
});
