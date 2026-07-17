(function () {
    const IS_MAC = window.api?.platform === 'darwin';
    const SHORTCUT = IS_MAC ? 'CommandOrControl+Alt+D' : 'Alt+Ctrl+D';
    const SHOW_SHORTCUT = IS_MAC ? 'CommandOrControl+Alt+A' : 'Alt+Ctrl+A';
    const SHORTCUT_LABEL = IS_MAC ? 'Command+Option+D' : 'Alt+Ctrl+D';
    const SHOW_SHORTCUT_LABEL = IS_MAC ? 'Command+Option+A' : 'Alt+Ctrl+A';
    const SERVICE_STORAGE_KEY = 'evd.instantVoiceTranslation.service';
    const TEXT_ONLY_ANNOUNCE_DELAY_MS = 900;
    const TEXT_ONLY_MAX_BUFFER_MS = 2600;
    const VIRTUAL_MIC_DOWNLOAD_URL = 'https://vb-audio.com/Cable/';
    const MEETING_WINDOW_PATTERNS = [
        /teams/i,
        /zoom/i,
        /google meet/i,
        /\bmeet\b/i,
        /microsoft teams/i,
        /webex/i,
        /skype/i,
        /whatsapp/i
    ];
    const state = {
        running: false,
        nativeAudioCapabilities: null,
        outputContext: null,
        outputDestination: null,
        outputElement: null,
        outputSinkId: '',
        outputPlaybackQueue: Promise.resolve(),
        incomingOutputContext: null,
        incomingOutputDestination: null,
        incomingOutputElement: null,
        incomingOutputSinkId: '',
        incomingNextPlayTime: 0,
        incomingOriginalUnderlayNextPlayTime: 0,
        incomingRunning: false,
        fastConversationModeActive: false,
        fastOutgoingTtsActive: false,
        fastConversationVoiceName: '',
        fastConversationVoiceCandidates: [],
        fastConversationTtsQueue: Promise.resolve(),
        lastFastIncomingAnnouncement: '',
        lastFastOutgoingText: '',
        lastTextOnlyAnnouncement: '',
        textOnlyAnnouncementBuffer: '',
        textOnlyAnnouncementTimer: null,
        textOnlyAnnouncementStartedAt: 0,
        textOnlyAnnouncementSpokenText: '',
        textOnlyAnnouncementLastInputText: '',
        nextPlayTime: 0,
        originalUnderlayNextPlayTime: 0,
        shortcutToneContext: null,
        rendererMicrophoneStream: null,
        rendererMicrophoneContext: null,
        rendererMicrophoneSource: null,
        rendererMicrophoneProcessor: null,
        rendererMicrophoneSilentGain: null,
        currentShortcut: SHORTCUT,
        receivedAudioCount: 0,
        transcriptEntries: [],
        audioEntries: [],
        audioCursors: {},
        sourceAudioEntries: [],
        sourceAudioCursors: {},
        sourceAudioSessionRestore: null,
        originalUnderlayPendingNodes: [],
        originalPassthroughUntil: 0,
        suppressNextTranslatedAudio: false,
        virtualCableAutoAnnounced: false,
        meetingWindowAutoAnnounced: false,
        transcriptStartedAt: null,
        transcriptStoppedAt: null,
        latestSourceText: '',
        languages: [
            ['tr', 'language_tr', 'Türkçe'],
            ['en', 'language_en', 'İngilizce'],
            ['de', 'language_de', 'Almanca'],
            ['fr', 'language_fr', 'Fransızca'],
            ['es', 'language_es', 'İspanyolca'],
            ['ar', 'language_ar', 'Arapça'],
            ['bn', 'language_bn', 'Bengalce'],
            ['bg', 'language_bg', 'Bulgarca'],
            ['ca', 'language_ca', 'Katalanca'],
            ['zh-CN', 'language_zh_cn', 'Çince (Basitleştirilmiş)'],
            ['zh-TW', 'language_zh_tw', 'Çince (Geleneksel)'],
            ['hr', 'language_hr', 'Hırvatça'],
            ['cs', 'language_cs', 'Çekçe'],
            ['da', 'language_da', 'Danca'],
            ['nl', 'language_nl', 'Felemenkçe'],
            ['fi', 'language_fi', 'Fince'],
            ['el', 'language_el', 'Yunanca'],
            ['gu', 'language_gu', 'Guceratça'],
            ['he', 'language_he', 'İbranice'],
            ['hi', 'language_hi', 'Hintçe'],
            ['hu', 'language_hu', 'Macarca'],
            ['id', 'language_id', 'Endonezce'],
            ['it', 'language_it', 'İtalyanca'],
            ['ja', 'language_ja', 'Japonca'],
            ['kn', 'language_kn', 'Kannada'],
            ['ko', 'language_ko', 'Korece'],
            ['ml', 'language_ml', 'Malayalam'],
            ['mr', 'language_mr', 'Marathi'],
            ['no', 'language_no', 'Norveççe'],
            ['pl', 'language_pl', 'Lehçe'],
            ['pt', 'language_pt', 'Portekizce'],
            ['ro', 'language_ro', 'Romence'],
            ['ru', 'language_ru', 'Rusça'],
            ['sk', 'language_sk', 'Slovakça'],
            ['sv', 'language_sv', 'İsveççe'],
            ['ta', 'language_ta', 'Tamilce'],
            ['te', 'language_te', 'Telugu'],
            ['th', 'language_th', 'Tayca'],
            ['uk', 'language_uk', 'Ukraynaca'],
            ['ur', 'language_ur', 'Urduca'],
            ['vi', 'language_vi', 'Vietnamca']
        ]
    };

    function t(key, fallback, params = {}) {
        const value = window.i18nHelper?.t?.(key, params);
        return value && !value.startsWith('[') ? value : fallback;
    }

    function el(id) {
        return document.getElementById(id);
    }

    function announce(message, assertive = false) {
        const region = el(assertive ? 'screen-reader-alert' : 'screen-reader-announcer');
        if (!region) return;
        region.textContent = '';
        setTimeout(() => {
            region.textContent = message;
        }, 30);
    }

    function setStatus(message, { announceStatus = true } = {}) {
        const status = el('instant-voice-translation-status');
        if (status) {
            status.value = message;
        }
        if (announceStatus) {
            announce(message);
        }
    }

    function renderState() {
        const startButton = el('instant-voice-translation-start');
        const stopButton = el('instant-voice-translation-stop');
        const languageSelect = el('instant-voice-translation-target-language');
        const serviceSelect = el('instant-voice-translation-service');
        const sourceSelect = el('instant-voice-translation-source');
        const sourceVolumeSelect = el('instant-voice-translation-source-volume');
        const windowSelect = el('instant-voice-translation-window');
        const incomingWindowSelect = el('instant-voice-translation-incoming-window');
        const microphoneSelect = el('instant-voice-translation-microphone-device');
        const outputDeviceSelect = el('instant-voice-translation-output-device');
        const translationVolumeSelect = el('instant-voice-translation-translation-volume');
        const incomingOutputDeviceSelect = el('instant-voice-translation-incoming-output-device');
        const myLanguageSelect = el('instant-voice-translation-my-language');
        const incomingVolumeSelect = el('instant-voice-translation-incoming-volume');
        const incomingOriginalUnderlay = el('instant-voice-translation-incoming-original-underlay');
        const incomingOriginalUnderlayLevel = el('instant-voice-translation-incoming-original-underlay-level');
        const incomingSourceSelect = el('instant-voice-translation-incoming-source');
        const conversationMode = el('instant-voice-translation-conversation-mode');
        const textOnlyMode = el('instant-voice-translation-text-only');
        const conversationVoiceModeSelect = el('instant-voice-translation-conversation-voice-mode');
        const originalUnderlay = el('instant-voice-translation-original-underlay');
        const originalUnderlayLevel = el('instant-voice-translation-original-underlay-level');
        const refreshButton = el('instant-voice-translation-refresh-windows');
        const refreshIncomingButton = el('instant-voice-translation-refresh-incoming-windows');
        const refreshMicrophonesButton = el('instant-voice-translation-refresh-microphones');
        const refreshOutputButton = el('instant-voice-translation-refresh-output-devices');
        const saveTranscriptButton = el('instant-voice-translation-save-transcript');
        const saveAudioButton = el('instant-voice-translation-save-audio');
        if (startButton) startButton.disabled = state.running;
        if (stopButton) stopButton.disabled = !state.running;
        if (languageSelect) languageSelect.disabled = state.running;
        if (serviceSelect) serviceSelect.disabled = state.running;
        if (myLanguageSelect) myLanguageSelect.disabled = state.running;
        if (incomingVolumeSelect) incomingVolumeSelect.disabled = state.running;
        if (incomingOriginalUnderlay) incomingOriginalUnderlay.disabled = state.running;
        if (incomingOriginalUnderlayLevel) incomingOriginalUnderlayLevel.disabled = state.running || !Boolean(incomingOriginalUnderlay?.checked);
        if (incomingSourceSelect) incomingSourceSelect.disabled = state.running;
        if (sourceSelect) sourceSelect.disabled = state.running;
        if (sourceVolumeSelect) sourceVolumeSelect.disabled = false;
        if (conversationMode) conversationMode.disabled = IS_MAC || state.running;
        if (textOnlyMode) textOnlyMode.disabled = state.running;
        if (conversationVoiceModeSelect) conversationVoiceModeSelect.disabled = state.running;
        if (originalUnderlay) originalUnderlay.disabled = state.running;
        if (originalUnderlayLevel) originalUnderlayLevel.disabled = state.running || !Boolean(originalUnderlay?.checked);
        if (windowSelect) windowSelect.disabled = state.running;
        if (incomingWindowSelect) incomingWindowSelect.disabled = state.running;
        if (microphoneSelect) microphoneSelect.disabled = state.running;
        if (outputDeviceSelect) outputDeviceSelect.disabled = state.running;
        if (translationVolumeSelect) translationVolumeSelect.disabled = false;
        if (incomingOutputDeviceSelect) incomingOutputDeviceSelect.disabled = state.running;
        if (refreshButton) refreshButton.disabled = state.running;
        if (refreshIncomingButton) refreshIncomingButton.disabled = state.running;
        if (refreshMicrophonesButton) refreshMicrophonesButton.disabled = state.running;
        if (refreshOutputButton) refreshOutputButton.disabled = state.running;
        if (saveTranscriptButton) saveTranscriptButton.disabled = state.running || state.transcriptEntries.length === 0;
        if (saveAudioButton) saveAudioButton.disabled = state.running || state.audioEntries.length === 0;
    }

    function populateLanguages() {
        const selects = [
            el('instant-voice-translation-target-language'),
            el('instant-voice-translation-my-language')
        ].filter(Boolean);
        if (!selects.length) return;
        selects.forEach((select) => {
            select.innerHTML = '';
        });
        state.languages.forEach(([value, key, fallback]) => {
            selects.forEach((select) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = t(`dialog.instant_voice_translation.${key}`, fallback);
                select.appendChild(option);
            });
        });
        const targetSelect = el('instant-voice-translation-target-language');
        const myLanguageSelect = el('instant-voice-translation-my-language');
        if (targetSelect) targetSelect.value = 'tr';
        if (myLanguageSelect) myLanguageSelect.value = 'tr';
    }

    function extractWindowPid(source = {}) {
        const directPid = Number(source.processId || source.pid || 0);
        if (Number.isFinite(directPid) && directPid > 0) {
            return Math.trunc(directPid);
        }
        const parts = String(source.id || '').split(':');
        const pid = Number(parts[2] || 0);
        return Number.isFinite(pid) && pid > 0 ? pid : 0;
    }

    function isLikelyVirtualCableOutput(option) {
        const text = `${option?.textContent || ''} ${option?.label || ''}`.toLowerCase();
        return text.includes('cable input')
            || text.includes('vb-audio virtual cable')
            || text.includes('vb-cable')
            || text.includes('virtual cable input')
            || text.includes('voicemeeter input')
            || text.includes('voice meeter input')
            || text.includes('virtual input');
    }

    function isLikelyMeetingWindow(source = {}) {
        const text = `${source.name || ''} ${source.processName || ''}`.trim();
        return MEETING_WINDOW_PATTERNS.some((pattern) => pattern.test(text));
    }

    function selectBestIncomingMeetingWindow(select) {
        if (!select) return false;
        const options = [...select.options];
        const best = options.find((option) => isLikelyMeetingWindow({
            name: option.dataset.windowTitle || option.textContent || '',
            processName: option.dataset.processName || ''
        }));
        if (!best) return false;
        select.value = best.value;
        return true;
    }

    function selectVirtualCableOutput({ announceSelection = false } = {}) {
        const select = el('instant-voice-translation-output-device');
        if (!select) return false;
        const option = [...select.options].find(isLikelyVirtualCableOutput);
        const downloadHint = el('instant-voice-translation-virtual-mic-download-hint');
        if (!option) {
            downloadHint?.classList.toggle('hidden', !isConversationModeEnabled());
            return false;
        }
        select.value = option.value;
        downloadHint?.classList.add('hidden');
        if (announceSelection && isConversationModeEnabled() && !state.virtualCableAutoAnnounced) {
            state.virtualCableAutoAnnounced = true;
            setStatus(t('dialog.instant_voice_translation.virtual_microphone_auto_selected', 'Sanal mikrofon çıkışı otomatik seçildi: {device}', {
                device: option.textContent || 'CABLE Input'
            }));
        }
        return true;
    }

    async function refreshWindowSources(selectId = 'instant-voice-translation-window') {
        const select = el(selectId);
        if (!select) return;
        const previousValue = select.value;
        select.innerHTML = '';
        const result = IS_MAC
            ? await window.api.getWindowProcessSources?.()
            : await window.api.getDesktopSources?.({
                types: ['window'],
                fetchWindowIcons: false,
                thumbnailSize: { width: 0, height: 0 }
            });
        if (IS_MAC && result?.success === false) {
            throw new Error(result.error || 'native_audio_source_list_failed');
        }
        const sources = (Array.isArray(result?.sources) ? result.sources : [])
            .map((source) => ({
                id: String(source.id || ''),
                name: String(source.name || '').trim(),
                pid: extractWindowPid(source),
                processName: String(source.processName || '').trim(),
                bundleId: String(source.bundleId || source.bundleID || '').trim()
            }))
            .filter((source) => source.name);

        if (!sources.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = t('dialog.instant_voice_translation.window_none', 'Dinlenebilir pencere bulunamadı');
            select.appendChild(option);
            return;
        }

        sources.forEach((source) => {
            const option = document.createElement('option');
            option.value = String(source.pid || 0);
            option.textContent = source.name;
            option.dataset.sourceId = source.id;
            option.dataset.windowTitle = source.name;
            option.dataset.processName = source.processName || '';
            option.dataset.bundleId = source.bundleId || '';
            select.appendChild(option);
        });
        if (previousValue && [...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
            return;
        }
        if (selectId === 'instant-voice-translation-incoming-window' && selectBestIncomingMeetingWindow(select)) {
            const selected = select.selectedOptions?.[0];
            if (!state.meetingWindowAutoAnnounced) {
                state.meetingWindowAutoAnnounced = true;
                setStatus(t('dialog.instant_voice_translation.meeting_window_auto_selected', 'Toplantı penceresi otomatik seçildi: {window}', {
                    window: selected?.textContent || ''
                }));
            }
        }
    }

    function appendOutputDeviceOptions(select, devices, previousValue) {
        if (!select) return;
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = t('dialog.instant_voice_translation.output_device_default', 'Sistem varsayılanı');
        select.appendChild(defaultOption);
        (Array.isArray(devices) ? devices : [])
            .filter((device) => device.kind === 'audiooutput')
            .forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId || 'default';
                option.textContent = device.label || t('dialog.instant_voice_translation.output_device_named_fallback', 'Ses çıkışı {number}', {
                    number: index + 1
                });
                select.appendChild(option);
            });
        if ([...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
        }
    }

    async function refreshOutputDevices() {
        const select = el('instant-voice-translation-output-device');
        const incomingSelect = el('instant-voice-translation-incoming-output-device');
        if (!select && !incomingSelect) return;
        const previousValue = select?.value || 'default';
        const previousIncomingValue = incomingSelect?.value || 'default';
        let devices = [];
        try {
            devices = await navigator.mediaDevices?.enumerateDevices?.();
        } catch (_error) {}
        appendOutputDeviceOptions(select, devices, previousValue);
        appendOutputDeviceOptions(incomingSelect, devices, previousIncomingValue);
        if (isConversationModeEnabled()) {
            selectVirtualCableOutput({ announceSelection: false });
        }
    }

    async function refreshMicrophoneDevices() {
        const select = el('instant-voice-translation-microphone-device');
        if (!select) return;
        const previousValue = select.value || 'default';
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = t('dialog.instant_voice_translation.microphone_device_default', 'Sistem varsayılanı');
        select.appendChild(defaultOption);
        try {
            const devices = await navigator.mediaDevices?.enumerateDevices?.();
            (Array.isArray(devices) ? devices : [])
                .filter((device) => device.kind === 'audioinput')
                .forEach((device, index) => {
                    const option = document.createElement('option');
                    option.value = device.deviceId || 'default';
                    option.textContent = device.label || t('dialog.instant_voice_translation.microphone_device_named_fallback', 'Mikrofon {number}', {
                        number: index + 1
                    });
                    select.appendChild(option);
                });
        } catch (_error) {}
        if ([...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
        }
    }

    function updateSourceControls() {
        const sourceSelect = el('instant-voice-translation-source');
        const incomingSourceSelect = el('instant-voice-translation-incoming-source');
        const group = el('instant-voice-translation-window-group');
        const sourceVolumeGroup = el('instant-voice-translation-source-volume-group');
        const incomingWindowGroup = el('instant-voice-translation-incoming-window-group');
        const microphoneGroup = el('instant-voice-translation-microphone-group');
        const originalUnderlayGroup = el('instant-voice-translation-original-underlay-group');
        const myLanguageGroup = el('instant-voice-translation-my-language-group');
        const conversationVoiceModeGroup = el('instant-voice-translation-conversation-voice-mode-group');
        const incomingVolumeGroup = el('instant-voice-translation-incoming-volume-group');
        const incomingOriginalUnderlayGroup = el('instant-voice-translation-incoming-original-underlay-group');
        const incomingOutputGroup = el('instant-voice-translation-incoming-output-group');
        const cleanRecordingGroup = el('instant-voice-translation-clean-recording-group');
        const incomingSourceGroup = el('instant-voice-translation-incoming-source-group');
        const textOnlyGroup = el('instant-voice-translation-text-only-group');
        const conversationHint = el('instant-voice-translation-conversation-hint');
        const meetingMicrophoneHint = el('instant-voice-translation-meeting-microphone-hint');
        const routingHint = el('instant-voice-translation-routing-hint');
        const virtualMicHint = el('instant-voice-translation-virtual-mic-hint');
        const virtualMicDownloadHint = el('instant-voice-translation-virtual-mic-download-hint');
        const targetLanguageLabel = document.querySelector('label[for="instant-voice-translation-target-language"]');
        const outputDeviceLabel = document.querySelector('label[for="instant-voice-translation-output-device"]');
        const conversationMode = Boolean(el('instant-voice-translation-conversation-mode')?.checked);
        const showWindowList = sourceSelect?.value === 'native-window-audio';
        const showIncomingWindowList = conversationMode && incomingSourceSelect?.value === 'native-window-audio';
        const showMicrophoneList = conversationMode && (!sourceSelect || sourceSelect.value === 'native-microphone');
        group?.classList.toggle('hidden', !showWindowList);
        sourceVolumeGroup?.classList.toggle('hidden', conversationMode || !showWindowList || state.nativeAudioCapabilities?.sessionVolume === false);
        incomingWindowGroup?.classList.toggle('hidden', !showIncomingWindowList);
        microphoneGroup?.classList.toggle('hidden', !showMicrophoneList);
        originalUnderlayGroup?.classList.toggle('hidden', !conversationMode);
        myLanguageGroup?.classList.toggle('hidden', !conversationMode);
        conversationVoiceModeGroup?.classList.toggle('hidden', !conversationMode);
        incomingVolumeGroup?.classList.toggle('hidden', !conversationMode);
        incomingOriginalUnderlayGroup?.classList.toggle('hidden', !conversationMode);
        incomingOutputGroup?.classList.toggle('hidden', !conversationMode);
        cleanRecordingGroup?.classList.toggle('hidden', !conversationMode);
        incomingSourceGroup?.classList.toggle('hidden', !conversationMode);
        textOnlyGroup?.classList.toggle('hidden', conversationMode);
        conversationHint?.classList.toggle('hidden', !conversationMode);
        meetingMicrophoneHint?.classList.toggle('hidden', !conversationMode);
        routingHint?.classList.toggle('hidden', !conversationMode);
        virtualMicHint?.classList.toggle('hidden', !conversationMode);
        virtualMicDownloadHint?.classList.add('hidden');
        if (targetLanguageLabel) {
            targetLanguageLabel.textContent = conversationMode
                ? t('dialog.instant_voice_translation.outgoing_language', 'Karşı tarafın dili')
                : t('dialog.instant_voice_translation.target_language', 'Hedef dil');
        }
        if (outputDeviceLabel) {
            outputDeviceLabel.textContent = conversationMode
                ? t('dialog.instant_voice_translation.virtual_output_device_label', 'Karşı tarafa gönderilecek ses çıkışı')
                : t('dialog.instant_voice_translation.output_device_label', 'Çeviri sesi çıkışı');
        }
        if (conversationMode) {
            const targetSelect = el('instant-voice-translation-target-language');
            const myLanguageSelect = el('instant-voice-translation-my-language');
            if (targetSelect && myLanguageSelect && targetSelect.value === myLanguageSelect.value) {
                targetSelect.value = myLanguageSelect.value === 'en' ? 'tr' : 'en';
            }
            if (!selectVirtualCableOutput({ announceSelection: true })) {
                virtualMicDownloadHint?.classList.remove('hidden');
                setStatus(t('dialog.instant_voice_translation.virtual_microphone_missing', 'Bilgisayarınızda CABLE Input gibi bir sanal mikrofon çıkışı bulunamadı. Karşılıklı konuşma modu düzgün çalışamaz. Ücretsiz VB-CABLE indirme sayfası: {url}', {
                    url: VIRTUAL_MIC_DOWNLOAD_URL
                }));
            }
        }
        if (showWindowList) {
            refreshWindowSources().catch((error) => {
                setStatus(t('dialog.instant_voice_translation.window_refresh_failed', 'Pencere listesi alınamadı: {error}', {
                    error: error?.message || error
                }));
            });
        }
        if (showIncomingWindowList) {
            refreshWindowSources('instant-voice-translation-incoming-window').catch((error) => {
                setStatus(t('dialog.instant_voice_translation.window_refresh_failed', 'Pencere listesi alınamadı: {error}', {
                    error: error?.message || error
                }));
            });
        }
    }

    function floatSamplesToPcm16Base64(samples, inputSampleRate, outputSampleRate) {
        const inputRate = Math.max(1, Number(inputSampleRate) || 48000);
        const outputRate = Math.max(1, Number(outputSampleRate) || inputRate);
        const outputLength = Math.max(1, Math.round(samples.length * outputRate / inputRate));
        const buffer = new ArrayBuffer(outputLength * 2);
        const view = new DataView(buffer);
        for (let index = 0; index < outputLength; index += 1) {
            const sourceIndex = Math.min(samples.length - 1, Math.floor(index * inputRate / outputRate));
            const sample = Math.max(-1, Math.min(1, Number(samples[sourceIndex]) || 0));
            view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
        }
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]);
        }
        return btoa(binary);
    }

    function stopRendererMicrophoneCapture() {
        if (state.rendererMicrophoneProcessor) {
            state.rendererMicrophoneProcessor.onaudioprocess = null;
            try { state.rendererMicrophoneProcessor.disconnect(); } catch (_error) {}
        }
        try { state.rendererMicrophoneSource?.disconnect(); } catch (_error) {}
        try { state.rendererMicrophoneSilentGain?.disconnect(); } catch (_error) {}
        for (const track of state.rendererMicrophoneStream?.getTracks?.() || []) {
            try { track.stop(); } catch (_error) {}
        }
        if (state.rendererMicrophoneContext && state.rendererMicrophoneContext.state !== 'closed') {
            state.rendererMicrophoneContext.close().catch(() => {});
        }
        state.rendererMicrophoneStream = null;
        state.rendererMicrophoneContext = null;
        state.rendererMicrophoneSource = null;
        state.rendererMicrophoneProcessor = null;
        state.rendererMicrophoneSilentGain = null;
    }

    async function startRendererMicrophoneCapture(service, microphoneDeviceId = 'default') {
        stopRendererMicrophoneCapture();
        const audio = {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };
        if (microphoneDeviceId && microphoneDeviceId !== 'default') {
            audio.deviceId = { exact: microphoneDeviceId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            for (const track of stream.getTracks()) track.stop();
            throw new Error('audio_context_unavailable');
        }

        const context = new AudioContextClass();
        await context.resume();
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(context.destination);

        state.rendererMicrophoneStream = stream;
        state.rendererMicrophoneContext = context;
        state.rendererMicrophoneSource = source;
        state.rendererMicrophoneProcessor = processor;
        state.rendererMicrophoneSilentGain = silentGain;

        processor.onaudioprocess = (event) => {
            if (state.rendererMicrophoneStream !== stream) return;
            const samples = event.inputBuffer.getChannelData(0);
            const outputSampleRate = service === 'openai' ? 24000 : context.sampleRate;
            const payload = {
                channel: 'primary',
                sampleRate: outputSampleRate,
                audioBase64: floatSamplesToPcm16Base64(samples, context.sampleRate, outputSampleRate)
            };
            if (service === 'openai') {
                window.api.sendOpenAiLiveTranslateAudioChunk?.(payload);
            } else {
                window.api.sendGeminiLiveTranslateAudioChunk?.(payload);
            }
        };
    }

    async function applyPlatformCapabilities() {
        const startButton = el('instant-voice-translation-start');
        const hideButton = el('instant-voice-translation-hide-to-tray');
        const intro = el('instant-voice-intro');
        if (startButton) {
            startButton.textContent = t(
                'dialog.instant_voice_translation.start_with_shortcut',
                'Canlı dinlemeyi başlat (' + SHORTCUT_LABEL + ')',
                { shortcut: SHORTCUT_LABEL }
            );
        }
        if (hideButton) {
            hideButton.textContent = IS_MAC
                ? t('dialog.instant_voice_translation.hide_to_menu_bar', 'Menü çubuğuna gizle (' + SHOW_SHORTCUT_LABEL + ' ile geri getir)', { shortcut: SHOW_SHORTCUT_LABEL })
                : t('dialog.instant_voice_translation.hide_to_tray', 'Sistem tepsisine küçült (' + SHOW_SHORTCUT_LABEL + ' ile geri getir)', { shortcut: SHOW_SHORTCUT_LABEL });
        }
        const introKey = IS_MAC
            ? 'dialog.instant_voice_translation.startup_intro_mac'
            : 'dialog.instant_voice_translation.startup_intro';
        if (intro) intro.textContent = t(introKey, intro.textContent, { shortcut: SHORTCUT_LABEL });
        if (!IS_MAC) {
            state.nativeAudioCapabilities = { systemAudio: true, applicationAudio: true, sessionVolume: true };
            return;
        }

        const capabilities = await window.api.getNativeAudioCapabilities?.().catch(() => null);
        state.nativeAudioCapabilities = capabilities || {
            systemAudio: false,
            applicationAudio: false,
            sessionVolume: false,
            helperAvailable: false
        };
        const sourceSelect = el('instant-voice-translation-source');
        if (sourceSelect) {
            for (const option of sourceSelect.options) {
                if (option.value === 'native-system-audio') option.disabled = state.nativeAudioCapabilities.systemAudio !== true;
                if (option.value === 'native-window-audio') option.disabled = state.nativeAudioCapabilities.applicationAudio !== true;
            }
            if (sourceSelect.selectedOptions?.[0]?.disabled) sourceSelect.value = 'native-microphone';
        }
        const conversationMode = el('instant-voice-translation-conversation-mode');
        if (conversationMode) {
            conversationMode.checked = false;
            conversationMode.disabled = true;
            conversationMode.setAttribute('aria-describedby', 'instant-voice-translation-mac-limit-hint');
        }
        const nativeAudioReady = state.nativeAudioCapabilities.systemAudio === true
            && state.nativeAudioCapabilities.applicationAudio === true;
        const probeFailed = state.nativeAudioCapabilities.probeSuccess === false;
        const probeError = String(state.nativeAudioCapabilities.probeError || 'native_audio_helper_failed');
        const hint = el('instant-voice-translation-mac-limit-hint');
        if (hint) {
            hint.textContent = probeFailed
                ? t('dialog.instant_voice_translation.mac_native_audio_probe_failed_hint', 'Mac ses yardımcısı kullanılamıyor: {error}', { error: probeError })
                : nativeAudioReady
                    ? t('dialog.instant_voice_translation.mac_native_audio_ready_hint', 'Mac sürümünde bilgisayar ve uygulama sesi etkin. Karşılıklı konuşma için sanal ses yönlendirme desteği henüz eklenmemiştir.')
                    : t('dialog.instant_voice_translation.mac_native_audio_unavailable_hint', 'Bilgisayar ve uygulama sesi için macOS 14.2 veya üzeri ve imzalı EVD ses yardımcısı gereklidir. Şimdilik mikrofon kullanılabilir.');
            if (probeFailed) {
                announce(hint.textContent);
            }
            hint.classList.remove('hidden');
        }
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(String(base64 || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
    }

    function parseSampleRate(mimeType = '') {
        const match = String(mimeType || '').match(/rate=(\d+)/i);
        return match ? Number(match[1]) || 24000 : 24000;
    }

    function normalizeSpeechText(value = '') {
        return String(value || '')
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanTextOnlyAnnouncement(value = '') {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/\s+([,.;:!?])/g, '$1')
            .replace(/([¿¡])\s+/g, '$1')
            .trim();
    }

    function smoothTextOnlyAnnouncementCasing(value = '') {
        const text = cleanTextOnlyAnnouncement(value);
        const letters = text.match(/\p{L}/gu) || [];
        if (letters.length < 6) return text;
        const uppercaseLetters = letters.filter((letter) => letter === letter.toLocaleUpperCase() && letter !== letter.toLocaleLowerCase());
        if (uppercaseLetters.length / letters.length < 0.85) return text;
        const locale = document.documentElement?.lang || navigator.language || 'tr';
        const lowered = text.toLocaleLowerCase(locale);
        return lowered.replace(/(^|[.!?]\s+)(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase(locale)}`);
    }

    function findTextOnlySentenceBoundary(value = '') {
        const text = String(value || '');
        let boundary = 0;
        const regex = /[.!?。！？]+(?:["'”’)\]]+)?(?=\s|$)/gu;
        let match = regex.exec(text);
        while (match) {
            boundary = match.index + match[0].length;
            match = regex.exec(text);
        }
        return boundary;
    }

    function splitTextOnlyReadableChunk(value = '') {
        const text = cleanTextOnlyAnnouncement(value);
        if (!text) return { readyText: '', remainingText: '' };
        const boundaryIndex = findTextOnlySentenceBoundary(text);
        if (boundaryIndex > 0) {
            return {
                readyText: text.slice(0, boundaryIndex),
                remainingText: cleanTextOnlyAnnouncement(text.slice(boundaryIndex))
            };
        }
        const lastSpaceIndex = text.lastIndexOf(' ');
        if (lastSpaceIndex >= 8 && text.length - lastSpaceIndex <= 18) {
            return {
                readyText: text.slice(0, lastSpaceIndex),
                remainingText: cleanTextOnlyAnnouncement(text.slice(lastSpaceIndex + 1))
            };
        }
        return { readyText: text, remainingText: '' };
    }

    function clearTextOnlyAnnouncementTimer() {
        if (!state.textOnlyAnnouncementTimer) return;
        clearTimeout(state.textOnlyAnnouncementTimer);
        state.textOnlyAnnouncementTimer = null;
    }

    function resetTextOnlyAnnouncementBuffer() {
        clearTextOnlyAnnouncementTimer();
        state.textOnlyAnnouncementBuffer = '';
        state.textOnlyAnnouncementStartedAt = 0;
        state.textOnlyAnnouncementSpokenText = '';
        state.textOnlyAnnouncementLastInputText = '';
    }

    function getTextOnlyAnnouncementDelta(previous = '', current = '') {
        const oldText = cleanTextOnlyAnnouncement(previous);
        const newText = cleanTextOnlyAnnouncement(current);
        if (!newText) return { text: '', lastInputText: oldText };
        if (!oldText) return { text: newText, lastInputText: newText };
        if (newText === oldText || oldText.startsWith(newText)) {
            return { text: '', lastInputText: oldText };
        }
        if (newText.startsWith(oldText)) {
            const suffix = cleanTextOnlyAnnouncement(newText.slice(oldText.length));
            return {
                text: suffix && !normalizeSpeechText(suffix) ? '' : suffix,
                lastInputText: newText
            };
        }
        const minOverlap = Math.min(12, oldText.length, newText.length);
        for (let length = Math.min(oldText.length, newText.length); length >= minOverlap; length -= 1) {
            if (oldText.slice(-length) === newText.slice(0, length)) {
                return {
                    text: cleanTextOnlyAnnouncement(newText.slice(length)),
                    lastInputText: newText
                };
            }
        }
        const normalizedOld = normalizeSpeechText(oldText);
        const normalizedNew = normalizeSpeechText(newText);
        if (normalizedOld && normalizedNew && (normalizedNew === normalizedOld || normalizedOld.startsWith(normalizedNew))) {
            return { text: '', lastInputText: oldText };
        }
        return { text: newText, lastInputText: newText };
    }

    function flushTextOnlyAnnouncement({ force = false } = {}) {
        clearTextOnlyAnnouncementTimer();
        const text = cleanTextOnlyAnnouncement(state.textOnlyAnnouncementBuffer);
        if (!text) {
            state.textOnlyAnnouncementBuffer = '';
            state.textOnlyAnnouncementStartedAt = 0;
            return;
        }
        const { readyText, remainingText } = force
            ? splitTextOnlyReadableChunk(text)
            : { readyText: text, remainingText: '' };
        if (!readyText || !announceTextOnlyChunk(readyText, { force })) {
            return;
        }
        state.textOnlyAnnouncementBuffer = cleanTextOnlyAnnouncement(remainingText);
        state.textOnlyAnnouncementStartedAt = state.textOnlyAnnouncementBuffer ? Date.now() : 0;
        if (state.textOnlyAnnouncementBuffer) {
            state.textOnlyAnnouncementTimer = setTimeout(() => {
                flushTextOnlyAnnouncement({ force: true });
            }, TEXT_ONLY_ANNOUNCE_DELAY_MS);
        }
    }

    function announceTextOnlyChunk(text = '', { force = false } = {}) {
        const cleanText = smoothTextOnlyAnnouncementCasing(text);
        if (!cleanText) return false;
        const normalized = normalizeSpeechText(cleanText);
        if (!force && (!normalized || normalized === state.lastTextOnlyAnnouncement)) {
            return false;
        }
        state.lastTextOnlyAnnouncement = normalized;
        state.textOnlyAnnouncementSpokenText = cleanTextOnlyAnnouncement(state.textOnlyAnnouncementSpokenText
            ? `${state.textOnlyAnnouncementSpokenText} ${cleanText}`
            : cleanText);
        announce(cleanText);
        return true;
    }

    function queueTextOnlyAnnouncement(value = '', { force = false } = {}) {
        if (!isTextOnlyModeEnabled()) return;
        const incomingText = cleanTextOnlyAnnouncement(value);
        const delta = getTextOnlyAnnouncementDelta(state.textOnlyAnnouncementLastInputText, incomingText);
        let text = delta.text;
        state.textOnlyAnnouncementLastInputText = delta.lastInputText;
        if (!text) {
            const pendingText = cleanTextOnlyAnnouncement(state.textOnlyAnnouncementBuffer);
            if (pendingText
                && normalizeSpeechText(pendingText) === normalizeSpeechText(incomingText)
                && findTextOnlySentenceBoundary(incomingText) > 0) {
                clearTextOnlyAnnouncementTimer();
                state.textOnlyAnnouncementBuffer = incomingText;
                const boundaryIndex = findTextOnlySentenceBoundary(state.textOnlyAnnouncementBuffer);
                const readyText = state.textOnlyAnnouncementBuffer.slice(0, boundaryIndex);
                const remainingText = state.textOnlyAnnouncementBuffer.slice(boundaryIndex);
                announceTextOnlyChunk(readyText, { force: true });
                state.textOnlyAnnouncementBuffer = cleanTextOnlyAnnouncement(remainingText);
                state.textOnlyAnnouncementStartedAt = state.textOnlyAnnouncementBuffer ? Date.now() : 0;
            }
            return;
        }
        const spokenText = cleanTextOnlyAnnouncement(state.textOnlyAnnouncementSpokenText);
        if (spokenText && text.startsWith(spokenText)) {
            text = cleanTextOnlyAnnouncement(text.slice(spokenText.length));
            if (!text) return;
        }
        const normalized = normalizeSpeechText(text);
        if (!normalized || normalized === state.lastTextOnlyAnnouncement) return;

        const previous = cleanTextOnlyAnnouncement(state.textOnlyAnnouncementBuffer);
        let nextText = text;
        if (previous) {
            const previousNormalized = normalizeSpeechText(previous);
            if (normalized.startsWith(previousNormalized)) {
                nextText = text;
            } else if (previousNormalized && previousNormalized.startsWith(normalized)) {
                nextText = previous;
            } else {
                nextText = `${previous} ${text}`;
            }
        }
        state.textOnlyAnnouncementBuffer = cleanTextOnlyAnnouncement(nextText);
        if (!state.textOnlyAnnouncementStartedAt) {
            state.textOnlyAnnouncementStartedAt = Date.now();
        }

        if (force) {
            flushTextOnlyAnnouncement({ force: true });
            return;
        }

        const boundaryIndex = findTextOnlySentenceBoundary(state.textOnlyAnnouncementBuffer);
        if (boundaryIndex > 0) {
            clearTextOnlyAnnouncementTimer();
            const readyText = state.textOnlyAnnouncementBuffer.slice(0, boundaryIndex);
            const pendingText = state.textOnlyAnnouncementBuffer.slice(boundaryIndex);
            announceTextOnlyChunk(readyText, { force: true });
            state.textOnlyAnnouncementBuffer = cleanTextOnlyAnnouncement(pendingText);
            state.textOnlyAnnouncementStartedAt = state.textOnlyAnnouncementBuffer ? Date.now() : 0;
            if (state.textOnlyAnnouncementBuffer) {
                state.textOnlyAnnouncementTimer = setTimeout(() => {
                    flushTextOnlyAnnouncement({ force: true });
                }, TEXT_ONLY_ANNOUNCE_DELAY_MS);
            }
            return;
        }

        const waitedTooLong = Date.now() - state.textOnlyAnnouncementStartedAt >= TEXT_ONLY_MAX_BUFFER_MS;
        if (waitedTooLong) {
            flushTextOnlyAnnouncement({ force: true });
            return;
        }

        clearTextOnlyAnnouncementTimer();
        state.textOnlyAnnouncementTimer = setTimeout(() => {
            flushTextOnlyAnnouncement({ force: true });
        }, TEXT_ONLY_ANNOUNCE_DELAY_MS);
    }

    function updateTextOnlyDisplay(textarea, value = '') {
        if (!textarea) return;
        const incomingText = cleanTextOnlyAnnouncement(value);
        if (!incomingText) return;
        const currentText = cleanTextOnlyAnnouncement(textarea.value);
        if (!currentText || incomingText.startsWith(currentText)) {
            textarea.value = incomingText;
            return;
        }
        if (currentText.startsWith(incomingText)) {
            return;
        }
        const delta = getTextOnlyAnnouncementDelta(currentText, incomingText);
        const nextText = delta.text
            ? cleanTextOnlyAnnouncement(`${currentText} ${delta.text}`)
            : currentText;
        textarea.value = nextText || incomingText;
    }

    function shouldSuppressTranslatedAudio(payload = {}) {
        const transcript = normalizeSpeechText(payload.transcript);
        const translatedText = normalizeSpeechText(payload.translatedText);
        if (!transcript || !translatedText) {
            return false;
        }
        return transcript === translatedText || transcript.includes(translatedText) || translatedText.includes(transcript);
    }

    function isConversationModeEnabled() {
        return Boolean(el('instant-voice-translation-conversation-mode')?.checked);
    }

    function isTextOnlyModeEnabled() {
        return !isConversationModeEnabled() && Boolean(el('instant-voice-translation-text-only')?.checked);
    }

    function getConversationVoiceMode() {
        return el('instant-voice-translation-conversation-voice-mode')?.value || 'gemini';
    }

    function getSelectedTranslationService() {
        const raw = String(el('instant-voice-translation-service')?.value || 'gemini').trim().toLowerCase();
        return raw === 'openai' ? 'openai' : 'gemini';
    }

    function getSelectedTranslationServiceLabel() {
        return getSelectedTranslationService() === 'openai'
            ? t('dialog.instant_voice_translation.service_openai', 'OpenAI Realtime Translate')
            : t('dialog.instant_voice_translation.service_gemini', 'Gemini Live Translate');
    }

    function persistSelectedTranslationService() {
        try {
            localStorage.setItem(SERVICE_STORAGE_KEY, getSelectedTranslationService());
        } catch (_error) {}
    }

    function restoreSelectedTranslationService() {
        const select = el('instant-voice-translation-service');
        if (!select) return;
        let saved = 'gemini';
        try {
            saved = String(localStorage.getItem(SERVICE_STORAGE_KEY) || 'gemini');
        } catch (_error) {}
        select.value = saved === 'openai' ? 'openai' : 'gemini';
    }

    async function startProviderTranslation(service, payload) {
        const startMethod = service === 'openai'
            ? window.api.openAiLiveTranslateStart
            : window.api.geminiLiveTranslateStart;
        if (typeof startMethod !== 'function') {
            return {
                success: false,
                error: service === 'openai' ? 'openai_live_translate_unavailable' : 'gemini_live_translate_unavailable'
            };
        }
        return startMethod(payload);
    }

    async function stopProviderTranslationChannel(service, channel) {
        const stopMethod = service === 'openai'
            ? window.api.openAiLiveTranslateStopChannel
            : window.api.geminiLiveTranslateStopChannel;
        if (typeof stopMethod !== 'function') return;
        await stopMethod({ channel }).catch(() => {});
    }

    async function stopAllProviderTranslations() {
        await Promise.all([
            window.api.geminiLiveTranslateStop?.().catch(() => {}),
            window.api.openAiLiveTranslateStop?.().catch(() => {})
        ]);
    }

    function isFastConversationModeActive() {
        return isConversationModeEnabled() && state.fastConversationModeActive;
    }

    function isFastOutgoingTtsActive() {
        return isFastConversationModeActive() && state.fastOutgoingTtsActive;
    }

    function getLanguagePrimaryCode(languageCode = '') {
        return String(languageCode || '').trim().toLowerCase().split('-')[0];
    }

    function getVoiceReliabilityScore(voice = {}) {
        const name = String(voice.name || '').toLowerCase();
        if (name.includes('online')) return 0;
        if (name.includes('desktop') || name.includes('embedded')) return 3;
        return 2;
    }

    function findVoicesForLanguage(voices = [], languageCode = '') {
        const normalizedLanguage = String(languageCode || '').trim().toLowerCase();
        const primary = getLanguagePrimaryCode(normalizedLanguage);
        if (!primary) return [];
        const enabledVoices = (Array.isArray(voices) ? voices : []).filter((voice) => voice?.enabled !== false && voice?.name);
        const matchingVoices = enabledVoices.filter((voice) => {
            const culture = String(voice.culture || '').toLowerCase();
            return culture === normalizedLanguage
                || getLanguagePrimaryCode(culture) === primary
                || String(voice.name || '').toLowerCase().includes(primary);
        });
        return matchingVoices.sort((first, second) => getVoiceReliabilityScore(second) - getVoiceReliabilityScore(first));
    }

    async function prepareFastConversationMode(_targetLanguage) {
        state.fastConversationModeActive = false;
        state.fastOutgoingTtsActive = false;
        state.fastConversationVoiceName = '';
        state.fastConversationVoiceCandidates = [];
        state.lastFastIncomingAnnouncement = '';
        state.lastFastOutgoingText = '';
        state.fastConversationTtsQueue = Promise.resolve();
        if (!isConversationModeEnabled() || getConversationVoiceMode() !== 'screen-reader-tts') {
            return false;
        }
        state.fastConversationModeActive = true;
        state.fastOutgoingTtsActive = false;
        setStatus(t('dialog.instant_voice_translation.screen_reader_translation_mode_ready', 'Hızlı konuşma modu hazır. Size gelen çeviri metin alanında görünecek ve ekran okuyucuyla okunacak; karşı tarafa giden ses seçili servisle gönderilecek.'));
        return true;
    }

    function isOriginalUnderlayEnabled() {
        return isConversationModeEnabled() && Boolean(el('instant-voice-translation-original-underlay')?.checked);
    }

    function getOriginalUnderlayGain() {
        const value = Number(el('instant-voice-translation-original-underlay-level')?.value || 0.2);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.2;
    }

    function isIncomingOriginalUnderlayEnabled() {
        return isConversationModeEnabled() && Boolean(el('instant-voice-translation-incoming-original-underlay')?.checked);
    }

    function getIncomingOriginalUnderlayGain() {
        const value = Number(el('instant-voice-translation-incoming-original-underlay-level')?.value || 0.2);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.2;
    }

    function getSourceAudioSessionVolume() {
        const value = Number(el('instant-voice-translation-source-volume')?.value || 1);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    }

    function getTranslationAudioGain() {
        const value = Number(el('instant-voice-translation-translation-volume')?.value || 1);
        return Number.isFinite(value) ? Math.max(0.2, Math.min(3, value)) : 1;
    }

    async function applySourceAudioSessionVolume(targetProcessId, targetWindowTitle = '', targetProcessName = '', targetWindowSourceId = '') {
        const volume = getSourceAudioSessionVolume();
        const pid = Number(targetProcessId || 0);
        if (volume >= 0.999) {
            return null;
        }
        if (!pid && !targetWindowTitle && !targetProcessName && !targetWindowSourceId) {
            return { success: false, error: 'target_process_id_required' };
        }
        if (typeof window.api?.setInstantVoiceTranslationAudioSessionVolume !== 'function') {
            return { success: false, error: 'audio_session_volume_unavailable' };
        }
        const result = await window.api.setInstantVoiceTranslationAudioSessionVolume({
            targetProcessId: pid,
            targetWindowTitle,
            targetProcessName,
            targetWindowSourceId,
            volume
        });
        if (result?.success && Number.isFinite(Number(result.previousVolume))) {
            if (!state.sourceAudioSessionRestore) {
                state.sourceAudioSessionRestore = {
                    targetProcessId: Number(result.targetProcessId || pid),
                    targetWindowTitle,
                    targetProcessName,
                    targetWindowSourceId,
                    volume: Math.max(0, Math.min(1, Number(result.previousVolume)))
                };
            }
            return result;
        }
        return result || { success: false, error: 'audio_session_volume_failed' };
    }

    async function updateSourceAudioSessionVolumeLive() {
        if (!state.running) {
            if (getSourceAudioSessionVolume() < 0.999) {
                setStatus(t('dialog.instant_voice_translation.source_volume_waiting_for_start', 'Özgün ses düzeyi dinleme başlatıldığında uygulanacak.'), { announceStatus: false });
            }
            return;
        }
        if (isConversationModeEnabled()) {
            setStatus(t('dialog.instant_voice_translation.source_volume_window_only', 'Özgün ses düzeyi yalnızca normal dinleme modunda pencere veya uygulama sesi seçiliyken uygulanır.'), { announceStatus: false });
            return;
        }
        const sourceSelect = el('instant-voice-translation-source');
        const windowSelect = el('instant-voice-translation-window');
        if (sourceSelect?.value !== 'native-window-audio') {
            setStatus(t('dialog.instant_voice_translation.source_volume_window_only', 'Özgün ses düzeyi yalnızca normal dinleme modunda pencere veya uygulama sesi seçiliyken uygulanır.'), { announceStatus: false });
            return;
        }
        const selectedWindowOption = windowSelect?.selectedOptions?.[0] || null;
        const selectedWindowTitle = String(selectedWindowOption?.dataset?.windowTitle || selectedWindowOption?.textContent || state.sourceAudioSessionRestore?.targetWindowTitle || '').trim();
        const selectedWindowProcessName = String(selectedWindowOption?.dataset?.processName || state.sourceAudioSessionRestore?.targetProcessName || '').trim();
        const selectedWindowSourceId = String(selectedWindowOption?.dataset?.sourceId || state.sourceAudioSessionRestore?.targetWindowSourceId || '').trim();
        const pid = Number(windowSelect?.value || state.sourceAudioSessionRestore?.targetProcessId || 0);
        if (!pid && !selectedWindowTitle && !selectedWindowProcessName && !selectedWindowSourceId) {
            setStatus(t('dialog.instant_voice_translation.source_volume_target_missing', 'Özgün ses düzeyi uygulanamadı: Seçili pencerenin ses oturumu hedefi bulunamadı.'), { announceStatus: false });
            return;
        }
        const result = await applySourceAudioSessionVolume(
            pid,
            selectedWindowTitle,
            selectedWindowProcessName,
            selectedWindowSourceId
        ).catch((error) => ({
            success: false,
            error: error?.message || String(error)
        }));
        if (result && !result.success) {
            setStatus(t('dialog.instant_voice_translation.source_volume_failed', 'Dinlenen uygulamanın ses düzeyi değiştirilemedi: {error}', {
                error: result.error || 'audio_session_not_found'
            }));
        } else if (result?.success) {
            setStatus(t('dialog.instant_voice_translation.source_volume_applied', 'Dinlenen uygulamanın ses düzeyi ayarlandı. Değişen oturum: {count}', {
                count: Number(result.changedSessions || result.matchedSessions || 0)
            }), { announceStatus: false });
        }
    }

    async function restoreSourceAudioSessionVolume() {
        const restore = state.sourceAudioSessionRestore;
        state.sourceAudioSessionRestore = null;
        if (!restore || typeof window.api?.setInstantVoiceTranslationAudioSessionVolume !== 'function') {
            return;
        }
        await window.api.setInstantVoiceTranslationAudioSessionVolume({
            targetProcessId: restore.targetProcessId,
            targetWindowTitle: restore.targetWindowTitle,
            targetProcessName: restore.targetProcessName,
            targetWindowSourceId: restore.targetWindowSourceId,
            volume: restore.volume
        }).catch(() => {});
    }

    function getSelectedTargetLanguageLabel() {
        const select = el('instant-voice-translation-target-language');
        return select?.selectedOptions?.[0]?.textContent?.trim() || select?.value || '';
    }

    function getSessionAudioOffsetMs() {
        const startedAt = state.transcriptStartedAt ? new Date(state.transcriptStartedAt).getTime() : 0;
        if (!Number.isFinite(startedAt) || startedAt <= 0) {
            return 0;
        }
        return Math.max(0, Date.now() - startedAt);
    }

    function appendTranscriptEntry(payload = {}) {
        const translatedText = String(payload.translatedText || '').trim();
        if (!translatedText) return;
        const transcript = String(payload.transcript || state.latestSourceText || '').trim();
        const previous = state.transcriptEntries[state.transcriptEntries.length - 1];
        if (
            previous
            && normalizeSpeechText(previous.translatedText) === normalizeSpeechText(translatedText)
            && normalizeSpeechText(previous.transcript) === normalizeSpeechText(transcript)
        ) {
            return;
        }
        state.transcriptEntries.push({
            time: new Date().toISOString(),
            transcript,
            translatedText
        });
        renderState();
    }

    function appendAudioEntry(payload = {}, { sourceRole = 'primary-translation' } = {}) {
        const audioBase64 = String(payload.audioBase64 || '').trim();
        if (!audioBase64 || shouldSuppressTranslatedAudio(payload)) return;
        const previous = state.audioEntries[state.audioEntries.length - 1];
        if (previous?.audioBase64 === audioBase64) return;
        const sampleRate = parseSampleRate(payload.mimeType || 'audio/pcm;rate=24000');
        const sampleCount = Math.floor(base64ToArrayBuffer(audioBase64).byteLength / 2);
        const durationMs = sampleRate > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0;
        const role = String(sourceRole || 'primary-translation');
        const estimatedOffsetMs = getSessionAudioOffsetMs();
        const previousCursorMs = Math.max(0, Number(state.audioCursors[role] || 0));
        const offsetMs = previousCursorMs > 0
            ? (estimatedOffsetMs > previousCursorMs + 500 ? estimatedOffsetMs : previousCursorMs)
            : estimatedOffsetMs;
        state.audioEntries.push({
            time: new Date().toISOString(),
            offsetMs,
            durationMs,
            sourceRole: role,
            mimeType: String(payload.mimeType || 'audio/pcm;rate=24000'),
            audioBase64
        });
        state.audioCursors[role] = Math.max(Number(state.audioCursors[role] || 0), offsetMs + Math.max(1, durationMs));
        renderState();
    }

    function appendSourceAudioEntry(payload = {}, { sourceRole = 'primary' } = {}) {
        const audioBase64 = String(payload.audioBase64 || '').trim();
        if (!audioBase64) return;
        const sampleRate = parseSampleRate(payload.mimeType || 'audio/pcm;rate=48000');
        const sampleCount = Math.floor(base64ToArrayBuffer(audioBase64).byteLength / 2);
        const durationMs = sampleRate > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0;
        const role = String(sourceRole || 'primary');
        const estimatedOffsetMs = Math.max(0, getSessionAudioOffsetMs() - Math.max(0, durationMs));
        const previousCursorMs = Math.max(0, Number(state.sourceAudioCursors[role] || 0));
        const offsetMs = previousCursorMs > 0
            ? (estimatedOffsetMs > previousCursorMs + 120 ? estimatedOffsetMs : previousCursorMs)
            : estimatedOffsetMs;
        state.sourceAudioEntries.push({
            time: new Date().toISOString(),
            offsetMs,
            durationMs,
            sourceRole: role,
            mimeType: String(payload.mimeType || 'audio/pcm;rate=48000'),
            audioBase64
        });
        state.sourceAudioCursors[role] = Math.max(Number(state.sourceAudioCursors[role] || 0), offsetMs + Math.max(1, durationMs));
    }

    function isCleanIncomingRecordingEnabled() {
        return isConversationModeEnabled() && Boolean(el('instant-voice-translation-clean-incoming-recording')?.checked);
    }

    function buildTranscriptText() {
        const lines = state.transcriptEntries
            .map((entry) => String(entry.translatedText || '').trim())
            .filter(Boolean);
        return `${lines.join('\n').trim()}\n`;
    }

    function getTranscriptDefaultFilename() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${t('dialog.instant_voice_translation.transcript_default_filename', 'anlik-ceviri-dokumu')}-${stamp}.txt`;
    }

    async function saveTranscript() {
        if (!state.transcriptEntries.length) {
            setStatus(t('dialog.instant_voice_translation.save_transcript_empty', 'Kaydedilecek çeviri metni yok.'));
            return;
        }
        const saveResult = await window.api.showSaveDialog({
            title: t('dialog.instant_voice_translation.save_transcript_dialog_title', 'Çeviri dökümünü kaydet'),
            defaultPath: getTranscriptDefaultFilename(),
            filters: [
                { name: t('dialog.instant_voice_translation.save_transcript_filter_text', 'Metin dosyası'), extensions: ['txt'] }
            ]
        });
        if (saveResult?.canceled || !saveResult?.filePath) {
            return;
        }
        const result = await window.api.saveFileContent({
            filePath: saveResult.filePath,
            content: buildTranscriptText()
        });
        if (!result?.success) {
            setStatus(t('dialog.instant_voice_translation.save_transcript_failed', 'Çeviri dökümü kaydedilemedi: {error}', {
                error: result?.error || 'unknown_error'
            }));
            return;
        }
        setStatus(t('dialog.instant_voice_translation.save_transcript_success', 'Çeviri dökümü kaydedildi: {path}', {
            path: saveResult.filePath
        }));
    }

    function getAudioDefaultFilename() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${t('dialog.instant_voice_translation.translation_audio_default_filename', 'anlik-ceviri-sesi')}-${stamp}.mp3`;
    }

    async function saveTranslationAudio() {
        if (!state.audioEntries.length) {
            setStatus(t('dialog.instant_voice_translation.save_translation_audio_empty', 'Kaydedilecek çeviri sesi yok.'));
            return;
        }
        const saveResult = await window.api.showSaveDialog({
            title: t('dialog.instant_voice_translation.save_translation_audio_dialog_title', 'Çeviri sesini kaydet'),
            defaultPath: getAudioDefaultFilename(),
            filters: [
                { name: t('dialog.instant_voice_translation.save_translation_audio_filter_mp3', 'MP3 ses dosyası'), extensions: ['mp3'] }
            ]
        });
        if (saveResult?.canceled || !saveResult?.filePath) {
            return;
        }
        const result = await window.api.saveInstantVoiceTranslationAudio?.({
            filePath: saveResult.filePath,
            entries: state.audioEntries,
            sourceEntries: state.sourceAudioEntries,
            mode: el('instant-voice-translation-audio-export-mode')?.value || 'translation-foreground'
        });
        if (!result?.success) {
            setStatus(t('dialog.instant_voice_translation.save_translation_audio_failed', 'Çeviri sesi kaydedilemedi: {error}', {
                error: result?.error || 'unknown_error'
            }));
            return;
        }
        setStatus(t('dialog.instant_voice_translation.save_translation_audio_success', 'Çeviri sesi kaydedildi: {path}', {
            path: result.outputPath || saveResult.filePath
        }));
    }

    async function ensureOutputAudioContext(outputDeviceId = 'default') {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('audio_context_unavailable');
        }
        const requestedSinkId = outputDeviceId && outputDeviceId !== 'default' ? outputDeviceId : 'default';
        if (state.outputContext && state.outputSinkId && state.outputSinkId !== requestedSinkId) {
            try { await state.outputContext.close(); } catch (_error) {}
            if (state.outputElement) {
                state.outputElement.pause();
                state.outputElement.srcObject = null;
            }
            state.outputContext = null;
            state.outputDestination = null;
            state.outputElement = null;
            state.outputSinkId = '';
        }
        if (!state.outputContext || state.outputContext.state === 'closed') {
            state.outputContext = new AudioContextClass();
            state.outputDestination = null;
            state.outputElement = null;
            state.outputSinkId = requestedSinkId;
            state.nextPlayTime = 0;
        }
        const audioContext = state.outputContext;
        await audioContext.resume().catch(() => {});
        if (outputDeviceId && outputDeviceId !== 'default') {
            if (!state.outputDestination) {
                state.outputDestination = audioContext.createMediaStreamDestination();
            }
            if (!state.outputElement || state.outputSinkId !== outputDeviceId) {
                if (state.outputElement) {
                    state.outputElement.pause();
                    state.outputElement.srcObject = null;
                }
                state.outputElement = new Audio();
                state.outputElement.srcObject = state.outputDestination.stream;
                if (typeof state.outputElement.setSinkId === 'function') {
                    await state.outputElement.setSinkId(outputDeviceId);
                }
                await state.outputElement.play().catch(() => {});
                state.outputSinkId = outputDeviceId;
            }
        } else {
            state.outputSinkId = 'default';
        }
        return audioContext;
    }

    async function playPcmAudio(payload = {}, { gainValue = 1, startDelaySeconds = 0, queueName = 'translation', allowSuppressed = false } = {}) {
        const audioBase64 = String(payload.audioBase64 || '').trim();
        if (!audioBase64) return;
        if (!allowSuppressed && shouldSuppressTranslatedAudio(payload)) return;
        const sampleRate = parseSampleRate(payload.mimeType);
        const pcm = new Int16Array(base64ToArrayBuffer(audioBase64));
        if (!pcm.length) return;
        const outputDeviceId = el('instant-voice-translation-output-device')?.value || 'default';
        const audioContext = await ensureOutputAudioContext(outputDeviceId);
        const audioBuffer = audioContext.createBuffer(1, pcm.length, sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let index = 0; index < pcm.length; index += 1) {
            channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
        }
        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = Math.max(0, Math.min(3, Number(gainValue) || 1));
        source.buffer = audioBuffer;
        source.connect(gainNode);
        if (outputDeviceId && outputDeviceId !== 'default' && state.outputDestination) {
            gainNode.connect(state.outputDestination);
        } else {
            gainNode.connect(audioContext.destination);
        }
        const nextField = queueName === 'original-underlay' ? 'originalUnderlayNextPlayTime' : 'nextPlayTime';
        const startAt = Math.max(
            audioContext.currentTime + 0.02 + Math.max(0, Number(startDelaySeconds) || 0),
            Number(state[nextField] || 0)
        );
        state[nextField] = startAt + audioBuffer.duration;
        if (queueName === 'original-underlay') {
            const now = audioContext.currentTime;
            state.originalUnderlayPendingNodes = state.originalUnderlayPendingNodes.filter((item) => item.endAt > now);
            state.originalUnderlayPendingNodes.push({
                gainNode,
                startAt,
                endAt: startAt + audioBuffer.duration
            });
        }
        source.start(startAt);
    }

    async function playTranslatedAudio(payload = {}, options = {}) {
        return playPcmAudio(payload, {
            gainValue: getTranslationAudioGain(),
            ...options
        });
    }

    async function playAudioFileToOutput(audioPath, { gainValue = 1, queueName = 'translation' } = {}) {
        const filePath = String(audioPath || '').trim();
        if (!filePath) return;
        const result = await window.api.readFileBase64?.(filePath);
        const base64 = typeof result === 'string' ? result : result?.base64;
        if (!base64) return;
        const outputDeviceId = el('instant-voice-translation-output-device')?.value || 'default';
        const audioContext = await ensureOutputAudioContext(outputDeviceId);
        const audioBuffer = await audioContext.decodeAudioData(base64ToArrayBuffer(base64).slice(0));
        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = Math.max(0, Math.min(3, Number(gainValue) || 1));
        source.buffer = audioBuffer;
        source.connect(gainNode);
        if (outputDeviceId && outputDeviceId !== 'default' && state.outputDestination) {
            gainNode.connect(state.outputDestination);
        } else {
            gainNode.connect(audioContext.destination);
        }
        const nextField = queueName === 'original-underlay' ? 'originalUnderlayNextPlayTime' : 'nextPlayTime';
        const startAt = Math.max(audioContext.currentTime + 0.02, Number(state[nextField] || 0));
        state[nextField] = startAt + audioBuffer.duration;
        source.start(startAt);
    }

    function enqueueFastOutgoingTts(text) {
        const normalizedText = normalizeSpeechText(text);
        if (!normalizedText || normalizedText === state.lastFastOutgoingText) return;
        state.lastFastOutgoingText = normalizedText;
        state.fastConversationTtsQueue = state.fastConversationTtsQueue.then(async () => {
            if (!isFastOutgoingTtsActive()) return;
            let result = null;
            let selectedVoice = '';
            const candidates = [...new Set([
                state.fastConversationVoiceName,
                ...(Array.isArray(state.fastConversationVoiceCandidates) ? state.fastConversationVoiceCandidates : [])
            ].filter(Boolean))];
            for (const voice of candidates) {
                selectedVoice = voice;
                result = await window.api.generateTts?.({
                    text,
                    voice,
                    speed: 1.05,
                    volume: 100,
                    service: 'system'
                });
                if (result?.success && result?.wavPath) {
                    state.fastConversationVoiceName = voice;
                    break;
                }
            }
            if (!result?.success || !result?.wavPath) {
                state.fastOutgoingTtsActive = false;
                setStatus(t('dialog.instant_voice_translation.windows_tts_failed_fallback', 'Windows TTS sesi üretilemedi. Bu oturum seçili servisle sesli çeviri olarak sürdürülecek: {error}', {
                    error: result?.error || selectedVoice || 'unknown_error'
                }));
                return;
            }
            await playAudioFileToOutput(result.wavPath, { queueName: 'translation' });
        }).catch((error) => {
            state.fastOutgoingTtsActive = false;
            setStatus(t('dialog.instant_voice_translation.windows_tts_failed_fallback', 'Windows TTS sesi üretilemedi. Bu oturum seçili servisle sesli çeviri olarak sürdürülecek: {error}', {
                error: error?.message || error || 'unknown_error'
            }));
        });
    }

    async function ensureIncomingOutputAudioContext(outputDeviceId = 'default') {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('audio_context_unavailable');
        }
        const requestedSinkId = outputDeviceId || 'default';
        if (state.incomingOutputContext && state.incomingOutputSinkId && state.incomingOutputSinkId !== requestedSinkId) {
            try { await state.incomingOutputContext.close(); } catch (_error) {}
            state.incomingOutputContext = null;
            state.incomingOutputDestination = null;
            state.incomingOutputElement = null;
            state.incomingOutputSinkId = '';
        }
        if (!state.incomingOutputContext || state.incomingOutputContext.state === 'closed') {
            state.incomingOutputContext = new AudioContextClass();
            state.incomingOutputDestination = null;
            state.incomingOutputElement = null;
            state.incomingOutputSinkId = requestedSinkId;
            state.incomingNextPlayTime = 0;
        }
        const audioContext = state.incomingOutputContext;
        await audioContext.resume().catch(() => {});
        if (requestedSinkId && requestedSinkId !== 'default') {
            if (!state.incomingOutputDestination) {
                state.incomingOutputDestination = audioContext.createMediaStreamDestination();
            }
            if (!state.incomingOutputElement || state.incomingOutputSinkId !== requestedSinkId) {
                if (state.incomingOutputElement) {
                    state.incomingOutputElement.pause();
                    state.incomingOutputElement.srcObject = null;
                }
                state.incomingOutputElement = new Audio();
                state.incomingOutputElement.srcObject = state.incomingOutputDestination.stream;
                if (typeof state.incomingOutputElement.setSinkId === 'function') {
                    await state.incomingOutputElement.setSinkId(requestedSinkId);
                }
                await state.incomingOutputElement.play().catch(() => {});
                state.incomingOutputSinkId = requestedSinkId;
            }
        } else {
            state.incomingOutputSinkId = 'default';
        }
        return audioContext;
    }

    async function playIncomingTranslatedAudio(payload = {}) {
        const audioBase64 = String(payload.audioBase64 || '').trim();
        if (!audioBase64 || shouldSuppressTranslatedAudio(payload)) return;
        const sampleRate = parseSampleRate(payload.mimeType);
        const pcm = new Int16Array(base64ToArrayBuffer(audioBase64));
        if (!pcm.length) return;
        const outputDeviceId = el('instant-voice-translation-incoming-output-device')?.value || 'default';
        const audioContext = await ensureIncomingOutputAudioContext(outputDeviceId);
        const audioBuffer = audioContext.createBuffer(1, pcm.length, sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let index = 0; index < pcm.length; index += 1) {
            channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
        }
        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        const selectedGain = Number(el('instant-voice-translation-incoming-volume')?.value || 1.35);
        gainNode.gain.value = Math.max(0.5, Math.min(1.8, selectedGain || 1.35));
        source.buffer = audioBuffer;
        source.connect(gainNode);
        if (outputDeviceId && outputDeviceId !== 'default' && state.incomingOutputDestination) {
            gainNode.connect(state.incomingOutputDestination);
        } else {
            gainNode.connect(audioContext.destination);
        }
        const startAt = Math.max(audioContext.currentTime + 0.02, Number(state.incomingNextPlayTime || 0));
        state.incomingNextPlayTime = startAt + audioBuffer.duration;
        source.start(startAt);
    }

    async function playIncomingOriginalUnderlayAudio(payload = {}) {
        if (!isIncomingOriginalUnderlayEnabled()) return;
        const audioBase64 = String(payload.audioBase64 || '').trim();
        if (!audioBase64) return;
        const sampleRate = parseSampleRate(payload.mimeType || 'audio/pcm;rate=48000');
        const pcm = new Int16Array(base64ToArrayBuffer(audioBase64));
        if (!pcm.length) return;
        const outputDeviceId = el('instant-voice-translation-incoming-output-device')?.value || 'default';
        const audioContext = await ensureIncomingOutputAudioContext(outputDeviceId);
        const audioBuffer = audioContext.createBuffer(1, pcm.length, sampleRate);
        const channel = audioBuffer.getChannelData(0);
        for (let index = 0; index < pcm.length; index += 1) {
            channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
        }
        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = getIncomingOriginalUnderlayGain();
        source.buffer = audioBuffer;
        source.connect(gainNode);
        if (outputDeviceId && outputDeviceId !== 'default' && state.incomingOutputDestination) {
            gainNode.connect(state.incomingOutputDestination);
        } else {
            gainNode.connect(audioContext.destination);
        }
        const startAt = Math.max(audioContext.currentTime + 0.02, Number(state.incomingOriginalUnderlayNextPlayTime || 0));
        state.incomingOriginalUnderlayNextPlayTime = startAt + audioBuffer.duration;
        source.start(startAt);
    }

    async function playOriginalUnderlayAudio(payload = {}) {
        if (!isOriginalUnderlayEnabled()) return;
        const passthroughActive = Date.now() < Number(state.originalPassthroughUntil || 0);
        return playPcmAudio(payload, {
            gainValue: passthroughActive ? 1 : getOriginalUnderlayGain(),
            startDelaySeconds: passthroughActive ? 0 : 1.2,
            queueName: 'original-underlay',
            allowSuppressed: true
        });
    }

    function raisePendingOriginalUnderlayToFullVolume() {
        if (!isConversationModeEnabled()) return;
        state.originalPassthroughUntil = Date.now() + 3500;
        const audioContext = state.outputContext;
        if (!audioContext) return;
        const now = audioContext.currentTime;
        state.originalUnderlayPendingNodes = state.originalUnderlayPendingNodes.filter((item) => item.endAt > now);
        state.originalUnderlayPendingNodes.forEach((item) => {
            try {
                item.gainNode.gain.cancelScheduledValues(now);
                item.gainNode.gain.setValueAtTime(1, now);
            } catch (_error) {}
        });
    }

    function playShortcutTone(kind = 'start') {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            if (!state.shortcutToneContext || state.shortcutToneContext.state === 'closed') {
                state.shortcutToneContext = new AudioContextClass();
            }
            const audioContext = state.shortcutToneContext;
            audioContext.resume().catch(() => {});
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            const now = audioContext.currentTime;
            const isStart = kind === 'start';
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(isStart ? 880 : 330, now);
            oscillator.frequency.exponentialRampToValueAtTime(isStart ? 1320 : 220, now + 0.16);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            oscillator.start(now);
            oscillator.stop(now + 0.2);
        } catch (_error) {}
    }

    async function saveApiKey() {
        const geminiInput = el('instant-api-key-input');
        const openAiInput = el('instant-openai-api-key-input');
        const geminiApiKey = String(geminiInput?.value || '').trim();
        const openAiApiKey = String(openAiInput?.value || '').trim();
        if (!geminiApiKey && !openAiApiKey) {
            setStatus(t('dialog.instant_voice_translation.api_key_required_short', 'En az bir çeviri servisi API anahtarı girin.'), { announceStatus: true });
            (getSelectedTranslationService() === 'openai' ? openAiInput : geminiInput)?.focus();
            return false;
        }
        if (geminiApiKey) {
            const result = await window.api.saveGeminiApiKey({ apiKey: geminiApiKey });
            if (!result?.success) {
                setStatus(t('dialog.instant_voice_translation.api_key_save_failed', 'Gemini API anahtarı kaydedilemedi: {error}', {
                    error: result?.error || 'unknown_error'
                }));
                return false;
            }
        }
        if (openAiApiKey) {
            const result = await window.api.saveOpenAiApiKey?.({ apiKey: openAiApiKey });
            if (!result?.success) {
                setStatus(t('dialog.instant_voice_translation.openai_api_key_save_failed', 'OpenAI API anahtarı kaydedilemedi: {error}', {
                    error: result?.error || 'unknown_error'
                }));
                return false;
            }
        }
        setStatus(t('dialog.instant_voice_translation.api_key_saved', 'API anahtarları kaydedildi.'));
        el('instant-api-panel')?.classList.add('hidden');
        return true;
    }

    async function ensureApiKey() {
        const service = getSelectedTranslationService();
        const apiData = service === 'openai'
            ? await window.api.getOpenAiApiData?.()
            : await window.api.getGeminiApiData();
        if (apiData?.apiKey) return true;
        const panel = el('instant-api-panel');
        panel?.classList.remove('hidden');
        const message = service === 'openai'
            ? t('dialog.instant_voice_translation.openai_key_missing', 'OpenAI API anahtarı bulunamadı. Önce API anahtarları bölümünden OpenAI anahtarınızı ekleyin.')
            : t('dialog.instant_voice_translation.key_missing', 'Gemini API anahtarı bulunamadı. Önce API anahtarları bölümünden Gemini anahtarınızı ekleyin.');
        setStatus(message, { announceStatus: true });
        setTimeout(() => el(service === 'openai' ? 'instant-openai-api-key-input' : 'instant-api-key-input')?.focus(), 80);
        return false;
    }

    async function startTranslation({ fromShortcut = false } = {}) {
        if (state.running) return;
        if (!(await ensureApiKey())) return;
        const service = getSelectedTranslationService();
        const serviceLabel = getSelectedTranslationServiceLabel();
        persistSelectedTranslationService();
        const targetLanguage = el('instant-voice-translation-target-language')?.value || 'tr';
        const myLanguage = el('instant-voice-translation-my-language')?.value || 'tr';
        const captureMode = el('instant-voice-translation-source')?.value || 'native-microphone';
        const providerCaptureMode = IS_MAC && captureMode === 'native-microphone'
            ? 'renderer-microphone'
            : captureMode;
        const conversationMode = isConversationModeEnabled();
        const outputDeviceSelect = el('instant-voice-translation-output-device');
        const outputDeviceId = outputDeviceSelect?.value || 'default';
        const outputDeviceName = String(outputDeviceSelect?.selectedOptions?.[0]?.textContent || '').trim();
        const incomingOutputDeviceSelect = el('instant-voice-translation-incoming-output-device');
        const incomingCaptureMode = el('instant-voice-translation-incoming-source')?.value || 'native-window-audio';
        const microphoneDeviceId = el('instant-voice-translation-microphone-device')?.value || 'default';
        const windowSelect = el('instant-voice-translation-window');
        const selectedWindowOption = windowSelect?.selectedOptions?.[0] || null;
        const selectedWindowTitle = String(selectedWindowOption?.dataset?.windowTitle || selectedWindowOption?.textContent || '').trim();
        const selectedWindowProcessName = String(selectedWindowOption?.dataset?.processName || '').trim();
        const selectedWindowSourceId = String(selectedWindowOption?.dataset?.sourceId || '').trim();
        const selectedWindowBundleId = String(selectedWindowOption?.dataset?.bundleId || '').trim();
        const selectedWindowPid = Number(windowSelect?.value || 0);
        const incomingWindowSelect = el('instant-voice-translation-incoming-window');
        const incomingWindowOption = incomingWindowSelect?.selectedOptions?.[0] || null;
        const incomingWindowTitle = String(incomingWindowOption?.dataset?.windowTitle || incomingWindowOption?.textContent || '').trim();
        const incomingWindowProcessName = String(incomingWindowOption?.dataset?.processName || '').trim();
        const incomingWindowSourceId = String(incomingWindowOption?.dataset?.sourceId || '').trim();
        const incomingWindowBundleId = String(incomingWindowOption?.dataset?.bundleId || '').trim();
        const incomingWindowPid = Number(incomingWindowSelect?.value || 0);
        if (captureMode === 'native-window-audio' && !selectedWindowTitle) {
            setStatus(t('dialog.instant_voice_translation.window_required', 'Önce dinlenecek pencere veya uygulamayı seçin.'));
            return;
        }
        if (conversationMode && incomingCaptureMode === 'native-window-audio' && !incomingWindowTitle) {
            setStatus(t('dialog.instant_voice_translation.incoming_window_required', 'Önce karşı tarafın bulunduğu pencere veya uygulamayı seçin.'));
            return;
        }
        if (conversationMode && incomingCaptureMode === 'native-system-audio') {
            setStatus(t('dialog.instant_voice_translation.system_audio_loop_warning', 'Karşı taraf sesi kaynağı bilgisayar sesi olursa çeviri sesi tekrar yakalanabilir. Döngüyü önlemek için mümkünse karşı tarafın bulunduğu pencere veya uygulama sesini seçin.'));
            el('instant-voice-translation-incoming-source')?.focus();
            return;
        }
        if (conversationMode && (!outputDeviceId || outputDeviceId === 'default' || !isLikelyVirtualCableOutput(outputDeviceSelect?.selectedOptions?.[0]))) {
            setStatus(t('dialog.instant_voice_translation.virtual_output_required', 'Karşı tarafa çevrili ses göndermek için çeviri sesi çıkışında CABLE Input veya benzeri sanal mikrofon girişini seçin.'));
            outputDeviceSelect?.focus();
            return;
        }
        if (conversationMode && isLikelyVirtualCableOutput(incomingOutputDeviceSelect?.selectedOptions?.[0])) {
            setStatus(t('dialog.instant_voice_translation.incoming_output_cable_warning', 'Bana gelen çeviri sesi çıkışında CABLE Input seçmeyin. Bu alan kulaklık veya hoparlör olmalı.'));
            incomingOutputDeviceSelect?.focus();
            return;
        }
        await prepareFastConversationMode(targetLanguage);
        state.receivedAudioCount = 0;
        state.transcriptEntries = [];
        state.audioEntries = [];
        state.audioCursors = {};
        state.sourceAudioEntries = [];
        state.sourceAudioCursors = {};
        state.incomingRunning = false;
        state.incomingNextPlayTime = 0;
        state.incomingOriginalUnderlayNextPlayTime = 0;
        state.originalUnderlayPendingNodes = [];
        state.originalPassthroughUntil = 0;
        state.suppressNextTranslatedAudio = false;
        state.lastTextOnlyAnnouncement = '';
        resetTextOnlyAnnouncementBuffer();
        state.transcriptStartedAt = new Date().toISOString();
        state.transcriptStoppedAt = null;
        state.latestSourceText = '';
        setStatus(t('dialog.instant_voice_translation.starting', 'Canlı dinleme başlatılıyor...'));
        if (conversationMode) {
            setStatus(t('dialog.instant_voice_translation.conversation_start_summary', 'Konuşma modu başlıyor. Sizin sesiniz {targetLanguage} olarak {outputDevice} aygıtına gönderilecek; karşı taraf sesi {myLanguage} olarak size duyurulacak.', {
                targetLanguage,
                myLanguage,
                outputDevice: outputDeviceName || outputDeviceId
            }));
        }
        const startResult = await startProviderTranslation(service, {
            channel: 'primary',
            sourceLanguage: 'auto',
            targetLanguage,
            captureMode: providerCaptureMode,
            microphoneDeviceId: captureMode === 'native-microphone' && microphoneDeviceId !== 'default' ? microphoneDeviceId : undefined,
            targetProcessId: captureMode === 'native-window-audio' ? selectedWindowPid : undefined,
            targetWindowTitle: captureMode === 'native-window-audio' ? selectedWindowTitle : undefined,
            targetProcessName: captureMode === 'native-window-audio' ? selectedWindowProcessName : undefined,
            targetWindowSourceId: captureMode === 'native-window-audio' ? selectedWindowSourceId : undefined,
            targetBundleId: captureMode === 'native-window-audio' ? selectedWindowBundleId : undefined
        });
        if (!startResult?.success) {
            throw new Error(startResult?.error || `${service}_live_translate_start_failed`);
        }
        if (providerCaptureMode === 'renderer-microphone') {
            try {
                await startRendererMicrophoneCapture(service, microphoneDeviceId);
            } catch (error) {
                await stopProviderTranslationChannel(service, 'primary');
                throw new Error(t(
                    'dialog.instant_voice_translation.mac_microphone_capture_failed',
                    'Mikrofon başlatılamadı: {error}',
                    { error: error?.message || error || 'microphone_capture_failed' }
                ));
            }
        }
        let sourceVolumeResult = null;
        if (!conversationMode && captureMode === 'native-window-audio' && state.nativeAudioCapabilities?.sessionVolume !== false) {
            sourceVolumeResult = await applySourceAudioSessionVolume(
                selectedWindowPid,
                selectedWindowTitle,
                selectedWindowProcessName,
                selectedWindowSourceId
            ).catch((error) => ({
                success: false,
                error: error?.message || String(error)
            }));
        }
        if (conversationMode) {
            const incomingResult = await startProviderTranslation(service, {
                channel: 'incoming',
                sourceLanguage: 'auto',
                targetLanguage: myLanguage,
                captureMode: incomingCaptureMode,
                targetProcessId: incomingCaptureMode === 'native-window-audio' ? incomingWindowPid : undefined,
                targetWindowTitle: incomingCaptureMode === 'native-window-audio' ? incomingWindowTitle : undefined,
                targetProcessName: incomingCaptureMode === 'native-window-audio' ? incomingWindowProcessName : undefined,
                targetWindowSourceId: incomingCaptureMode === 'native-window-audio' ? incomingWindowSourceId : undefined,
                targetBundleId: incomingCaptureMode === 'native-window-audio' ? incomingWindowBundleId : undefined
            });
            if (!incomingResult?.success) {
                await stopProviderTranslationChannel(service, 'primary');
                throw new Error(incomingResult?.error || `${service}_live_translate_incoming_start_failed`);
            }
            state.incomingRunning = true;
        }
        state.running = true;
        state.nextPlayTime = 0;
        state.originalUnderlayNextPlayTime = 0;
        renderState();
        setStatus(isTextOnlyModeEnabled()
            ? t('dialog.instant_voice_translation.running_text_only_with_service', 'Canlı dinleme {service} ile sürüyor. Çeviri metni hazır oldukça ekran okuyucuya duyurulacak.', {
                service: serviceLabel
            })
            : t('dialog.instant_voice_translation.running_with_service', 'Canlı dinleme {service} ile sürüyor. Çeviri sesi hazır oldukça duyulacak.', {
                service: serviceLabel
            }));
        if (sourceVolumeResult && !sourceVolumeResult.success) {
            setStatus(t('dialog.instant_voice_translation.source_volume_failed', 'Dinlenen uygulamanın ses düzeyi değiştirilemedi: {error}', {
                error: sourceVolumeResult.error || 'audio_session_not_found'
            }));
        } else if (sourceVolumeResult?.success) {
            setStatus(t('dialog.instant_voice_translation.source_volume_applied', 'Dinlenen uygulamanın ses düzeyi ayarlandı. Değişen oturum: {count}', {
                count: Number(sourceVolumeResult.changedSessions || sourceVolumeResult.matchedSessions || 0)
            }), { announceStatus: false });
        }
        if (fromShortcut) playShortcutTone('start');
    }

    async function stopTranslation({ fromShortcut = false } = {}) {
        if (!state.running) {
            renderState();
            return;
        }
        state.running = false;
        state.incomingRunning = false;
        state.transcriptStoppedAt = new Date().toISOString();
        flushTextOnlyAnnouncement({ force: true });
        stopRendererMicrophoneCapture();
        await restoreSourceAudioSessionVolume();
        await stopAllProviderTranslations();
        renderState();
        setStatus(t('dialog.instant_voice_translation.stopped', 'Canlı dinleme durduruldu.'));
        if (fromShortcut) playShortcutTone('stop');
    }

    function handleGeminiEvent(payload = {}) {
        const type = String(payload.type || '');
        const channel = String(payload.channel || 'primary');
        if (type === 'connection-refreshing') {
            setStatus(t('dialog.instant_voice_translation.connection_refreshing', 'Gemini bağlantısı süre sınırı nedeniyle yenileniyor. Çeviri birkaç saniye içinde devam edecek.'), { announceStatus: true });
            return;
        }
        if (type === 'connection-refreshed') {
            setStatus(t('dialog.instant_voice_translation.connection_refreshed', 'Gemini bağlantısı yenilendi. Canlı çeviri devam ediyor.'), { announceStatus: true });
            return;
        }
        if (type === 'connection-refresh-failed') {
            setStatus(t('dialog.instant_voice_translation.connection_refresh_failed', 'Gemini bağlantısı yenilenemedi. Çeviri açık kalacak ve kısa süre sonra yeniden denenecek: {error}', {
                error: payload.error || 'unknown_error'
            }), { announceStatus: true });
            return;
        }
        if (channel === 'incoming') {
            if (type === 'error') {
                const errorText = String(payload.error || 'unknown_error');
                if (!state.running || errorText.includes('gemini_live_translate_socket_closed:1000')) {
                    return;
                }
                setStatus(t('dialog.instant_voice_translation.incoming_error', 'Karşı taraf çevirisi hatası: {error}', {
                    error: errorText
                }));
                return;
            }
            if (payload.transcript) {
                const sourceText = el('instant-voice-translation-source-text');
                const text = t('dialog.instant_voice_translation.incoming_source_prefix', 'Karşı taraf: {text}', {
                    text: payload.transcript
                });
                if (sourceText) sourceText.value = text;
            }
            if (payload.translatedText) {
                const translatedText = el('instant-voice-translation-translated-text');
                const text = t('dialog.instant_voice_translation.incoming_translation_prefix', 'Size çeviri: {text}', {
                    text: payload.translatedText
                });
                if (translatedText) translatedText.value = text;
                const normalizedAnnouncement = normalizeSpeechText(payload.translatedText);
                if (isFastConversationModeActive() && normalizedAnnouncement && normalizedAnnouncement !== state.lastFastIncomingAnnouncement) {
                    state.lastFastIncomingAnnouncement = normalizedAnnouncement;
                    announce(String(payload.translatedText || ''));
                }
                appendTranscriptEntry(payload);
            }
            if (type === 'source-audio' && state.running) {
                if (isCleanIncomingRecordingEnabled()) {
                    appendSourceAudioEntry(payload, { sourceRole: 'incoming' });
                }
                playIncomingOriginalUnderlayAudio(payload).catch(() => {});
                return;
            }
            if (type === 'audio' && state.running) {
                if (isFastConversationModeActive()) {
                    return;
                }
                appendAudioEntry(payload, { sourceRole: 'incoming-translation' });
                playIncomingTranslatedAudio(payload).catch((error) => {
                    setStatus(t('dialog.instant_voice_translation.audio_failed', 'Çeviri sesi çalınamadı: {error}', {
                        error: error?.message || error || 'unknown_error'
                    }));
                });
            }
            return;
        }
        if (type === 'error') {
            const errorText = String(payload.error || 'unknown_error');
            if (!state.running || errorText.includes('gemini_live_translate_socket_closed:1000')) {
                return;
            }
            setStatus(t('dialog.instant_voice_translation.error', 'Canlı çeviri hatası: {error}', {
                error: errorText
            }));
            return;
        }
        if (payload.transcript) {
            const sourceText = el('instant-voice-translation-source-text');
            state.latestSourceText = String(payload.transcript || '');
            if (sourceText) sourceText.value = payload.transcript;
        }
        if (type === 'source-audio' && state.running) {
            appendSourceAudioEntry(payload, { sourceRole: 'primary' });
            playOriginalUnderlayAudio(payload).catch(() => {});
            return;
        }
        if (payload.translatedText) {
            const translatedText = el('instant-voice-translation-translated-text');
            if (isTextOnlyModeEnabled()) {
                updateTextOnlyDisplay(translatedText, payload.translatedText);
            } else if (translatedText) {
                translatedText.value = payload.translatedText;
            }
            queueTextOnlyAnnouncement(payload.translatedText);
            if (isConversationModeEnabled() && shouldSuppressTranslatedAudio(payload)) {
                state.suppressNextTranslatedAudio = true;
                raisePendingOriginalUnderlayToFullVolume();
            } else {
                state.suppressNextTranslatedAudio = false;
            }
            appendTranscriptEntry(payload);
            if (isFastOutgoingTtsActive() && !state.suppressNextTranslatedAudio) {
                enqueueFastOutgoingTts(String(payload.translatedText || ''));
            }
        }
        if (type === 'audio' && state.running) {
            state.receivedAudioCount += 1;
            if (isTextOnlyModeEnabled()) {
                return;
            }
            if (isFastOutgoingTtsActive()) {
                return;
            }
            if (state.suppressNextTranslatedAudio || shouldSuppressTranslatedAudio(payload)) {
                state.suppressNextTranslatedAudio = false;
                return;
            }
            appendAudioEntry(payload, { sourceRole: 'primary-translation' });
            playTranslatedAudio(payload).catch((error) => {
                setStatus(t('dialog.instant_voice_translation.audio_failed', 'Çeviri sesi çalınamadı: {error}', {
                    error: error?.message || error || 'unknown_error'
                }));
            });
        }
    }

    function handleOpenAiEvent(payload = {}) {
        const type = String(payload.type || '');
        const channel = String(payload.channel || 'primary');
        if (type === 'text-delta') {
            const transcript = String(payload.transcript || '');
            const translatedText = String(payload.translatedText || '');
            if (channel === 'incoming') {
                if (transcript) {
                    const sourceText = el('instant-voice-translation-source-text');
                    const text = t('dialog.instant_voice_translation.incoming_source_prefix', 'Karşı taraf: {text}', {
                        text: transcript
                    });
                    if (sourceText) sourceText.value = text;
                }
                if (translatedText) {
                    const translatedTextArea = el('instant-voice-translation-translated-text');
                    const text = t('dialog.instant_voice_translation.incoming_translation_prefix', 'Size çeviri: {text}', {
                        text: translatedText
                    });
                    if (translatedTextArea) translatedTextArea.value = text;
                }
                return;
            }
            if (transcript) {
                const sourceText = el('instant-voice-translation-source-text');
                state.latestSourceText = transcript;
                if (sourceText) sourceText.value = transcript;
            }
            if (translatedText) {
                const translatedTextArea = el('instant-voice-translation-translated-text');
                if (isTextOnlyModeEnabled()) {
                    updateTextOnlyDisplay(translatedTextArea, translatedText);
                } else if (translatedTextArea) {
                    translatedTextArea.value = translatedText;
                }
                queueTextOnlyAnnouncement(translatedText);
            }
            return;
        }
        if (type === 'error') {
            const errorText = String(payload.error || 'unknown_error');
            if (!state.running || errorText.includes('openai_realtime_socket_closed:1000')) {
                return;
            }
        }
        handleGeminiEvent(payload);
    }

    async function registerShortcut() {
        // Standalone helper does not load EVD's shortcut manager, so its global shortcuts are registered here.
        await Promise.all([
            window.api.registerGlobalShortcut?.({
                accelerator: SHORTCUT,
                focusWindowOnTrigger: false
            }).catch(() => {}),
            window.api.registerGlobalShortcut?.({
                accelerator: SHOW_SHORTCUT,
                focusWindowOnTrigger: true
            }).catch(() => {})
        ]);
    }

    function bindEvents() {
        el('instant-api-toggle')?.addEventListener('click', () => {
            const panel = el('instant-api-panel');
            panel?.classList.toggle('hidden');
            if (!panel?.classList.contains('hidden')) {
                setTimeout(() => el('instant-api-key-input')?.focus(), 80);
            }
        });
        el('instant-api-save')?.addEventListener('click', () => {
            saveApiKey().catch((error) => setStatus(error?.message || String(error)));
        });
        el('instant-api-key-show')?.addEventListener('change', (event) => {
            const type = event.target.checked ? 'text' : 'password';
            const geminiInput = el('instant-api-key-input');
            const openAiInput = el('instant-openai-api-key-input');
            if (geminiInput) geminiInput.type = type;
            if (openAiInput) openAiInput.type = type;
        });
        el('instant-voice-translation-service')?.addEventListener('change', () => {
            persistSelectedTranslationService();
            setStatus(t('dialog.instant_voice_translation.service_selected', '{service} seçildi.', {
                service: getSelectedTranslationServiceLabel()
            }));
            renderState();
        });
        el('instant-voice-translation-source')?.addEventListener('change', () => {
            updateSourceControls();
            if (el('instant-voice-translation-source')?.value === 'native-window-audio') {
                refreshWindowSources().catch((error) => {
                    setStatus(t('dialog.instant_voice_translation.window_refresh_failed', 'Pencere listesi alınamadı: {error}', {
                        error: error?.message || error
                    }));
                });
            }
        });
        el('instant-voice-translation-incoming-source')?.addEventListener('change', updateSourceControls);
        el('instant-voice-translation-conversation-mode')?.addEventListener('change', updateSourceControls);
        el('instant-voice-translation-text-only')?.addEventListener('change', renderState);
        el('instant-voice-translation-source-volume')?.addEventListener('change', () => {
            renderState();
            updateSourceAudioSessionVolumeLive().catch(() => {});
        });
        el('instant-voice-translation-conversation-voice-mode')?.addEventListener('change', renderState);
        el('instant-voice-translation-original-underlay')?.addEventListener('change', renderState);
        el('instant-voice-translation-incoming-original-underlay')?.addEventListener('change', renderState);
        el('instant-voice-translation-refresh-windows')?.addEventListener('click', () => {
            Promise.all([
                refreshWindowSources(),
                refreshWindowSources('instant-voice-translation-incoming-window')
            ]).catch((error) => setStatus(t('dialog.instant_voice_translation.window_refresh_failed', 'Pencere listesi alınamadı: {error}', {
                error: error?.message || error
            })));
        });
        el('instant-voice-translation-refresh-incoming-windows')?.addEventListener('click', () => {
            refreshWindowSources('instant-voice-translation-incoming-window').catch((error) => setStatus(t('dialog.instant_voice_translation.window_refresh_failed', 'Pencere listesi alınamadı: {error}', {
                error: error?.message || error
            })));
        });
        el('instant-voice-translation-refresh-microphones')?.addEventListener('click', () => {
            refreshMicrophoneDevices().then(() => {
                setStatus(t('dialog.instant_voice_translation.microphone_device_refreshed', 'Mikrofonlar yenilendi.'));
            }).catch((error) => setStatus(t('dialog.instant_voice_translation.microphone_device_refresh_failed', 'Mikrofonlar yenilenemedi: {error}', {
                error: error?.message || error
            })));
        });
        el('instant-voice-translation-refresh-output-devices')?.addEventListener('click', () => {
            refreshOutputDevices().then(() => {
                setStatus(t('dialog.instant_voice_translation.output_device_refreshed', 'Çıkış aygıtları yenilendi.'));
            }).catch((error) => setStatus(t('dialog.instant_voice_translation.output_device_refresh_failed', 'Çıkış aygıtları yenilenemedi: {error}', {
                error: error?.message || error
            })));
        });
        el('instant-voice-translation-virtual-mic-download-link')?.addEventListener('click', (event) => {
            event.preventDefault();
            window.api.openExternalUrl?.(VIRTUAL_MIC_DOWNLOAD_URL).catch((error) => {
                setStatus(t('dialog.instant_voice_translation.virtual_microphone_download_failed', 'VB-CABLE indirme sayfası açılamadı: {error}', {
                    error: error?.message || error || 'unknown_error'
                }));
            });
        });
        el('instant-voice-translation-start')?.addEventListener('click', () => {
            startTranslation().catch((error) => setStatus(t('dialog.instant_voice_translation.start_failed', 'Canlı çeviri başlatılamadı: {error}', {
                error: error?.message || error || 'unknown_error'
            })));
        });
        el('instant-voice-translation-stop')?.addEventListener('click', () => {
            stopTranslation().catch((error) => setStatus(error?.message || String(error)));
        });
        el('instant-voice-translation-save-transcript')?.addEventListener('click', () => {
            saveTranscript().catch((error) => setStatus(t('dialog.instant_voice_translation.save_transcript_failed', 'Çeviri dökümü kaydedilemedi: {error}', {
                error: error?.message || error || 'unknown_error'
            })));
        });
        el('instant-voice-translation-save-audio')?.addEventListener('click', () => {
            saveTranslationAudio().catch((error) => setStatus(t('dialog.instant_voice_translation.save_translation_audio_failed', 'Çeviri sesi kaydedilemedi: {error}', {
                error: error?.message || error || 'unknown_error'
            })));
        });
        el('instant-voice-translation-hide-to-tray')?.addEventListener('click', async () => {
            const statusKey = IS_MAC
                ? 'dialog.instant_voice_translation.hide_to_menu_bar_status'
                : 'dialog.instant_voice_translation.hide_to_tray_status';
            const statusFallback = IS_MAC
                ? 'Anlık Sesli Çeviri menü çubuğuna gizlendi. ' + SHORTCUT_LABEL + ' ile dinlemeyi başlatıp durdurabilir, ' + SHOW_SHORTCUT_LABEL + ' ile pencereyi geri getirebilirsiniz.'
                : 'Anlık Sesli Çeviri sistem tepsisine küçültüldü. ' + SHORTCUT_LABEL + ' ile dinlemeyi başlatıp durdurabilir, ' + SHOW_SHORTCUT_LABEL + ' ile pencereyi geri getirebilirsiniz.';
            setStatus(t(statusKey, statusFallback, {
                shortcut: SHORTCUT_LABEL,
                showShortcut: SHOW_SHORTCUT_LABEL
            }));
            const result = await window.api.hideInstantVoiceTranslationToTray?.();
            if (!result?.success) {
                const errorKey = IS_MAC
                    ? 'dialog.instant_voice_translation.hide_to_menu_bar_failed'
                    : 'dialog.instant_voice_translation.hide_to_tray_failed';
                setStatus(t(errorKey, 'Uygulama arka plana gizlenemedi: {error}', {
                    error: result?.error || 'unknown_error'
                }));
            }
        });
        window.api.onGeminiLiveTranslateEvent?.(handleGeminiEvent);
        window.api.onOpenAiLiveTranslateEvent?.(handleOpenAiEvent);
        window.api.onGlobalShortcutTriggered?.((accelerator) => {
            const normalizedAccelerator = String(accelerator || '').toLowerCase();
            if (normalizedAccelerator === SHOW_SHORTCUT.toLowerCase()) {
                setStatus(t('dialog.instant_voice_translation.show_shortcut_status', 'Anlık Sesli Çeviri penceresi öne getirildi.'));
                return;
            }
            if (normalizedAccelerator !== SHORTCUT.toLowerCase()) return;
            if (state.running) {
                stopTranslation({ fromShortcut: true }).catch(() => {});
            } else {
                startTranslation({ fromShortcut: true }).catch((error) => {
                    setStatus(t('dialog.instant_voice_translation.start_failed', 'Canlı çeviri başlatılamadı: {error}', {
                        error: error?.message || error || 'unknown_error'
                    }));
                });
            }
        });
        window.addEventListener('beforeunload', () => {
            stopRendererMicrophoneCapture();
            restoreSourceAudioSessionVolume().catch(() => {});
            window.api.unregisterGlobalShortcut?.(SHORTCUT).catch(() => {});
            window.api.unregisterGlobalShortcut?.(SHOW_SHORTCUT).catch(() => {});
            stopAllProviderTranslations().catch(() => {});
        });
    }

    async function init() {
        await window.i18nHelper?.init?.();
        await applyPlatformCapabilities();
        populateLanguages();
        restoreSelectedTranslationService();
        bindEvents();
        updateSourceControls();
        await refreshMicrophoneDevices();
        await refreshOutputDevices();
        await registerShortcut();
        const introKey = IS_MAC
            ? 'dialog.instant_voice_translation.startup_intro_mac'
            : 'dialog.instant_voice_translation.startup_intro';
        announce(t(introKey, el('instant-voice-intro')?.textContent || '', {
            shortcut: SHORTCUT_LABEL
        }));
        await ensureApiKey();
        renderState();
    }

    document.addEventListener('DOMContentLoaded', () => {
        init().catch((error) => {
            setStatus(error?.message || String(error), { announceStatus: true });
        });
    });
})();
