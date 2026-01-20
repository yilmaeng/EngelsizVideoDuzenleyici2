const { ipcRenderer, remote } = require('electron');
const path = require('path');

// State
let currentMode = 'A'; // 'A' (Replace) or 'B' (Playback)
let state = {
    stepIndex: 0,
    videoPath: null,
    cleanAudioPath: null,
    refAudioPath: null, // Mode B reference
    recordVideoPath: null, // Mode B recorded video
    recordAudioPath: null, // Mode B recorded mic
    offsetMs: 0,
    loopEnabled: false,
    loopStart: 0,
    loopDuration: 2, // seconds
    listenMode: 'mix', // mix, ref, clean
    isRecording: false,
    isPaused: false,
    videoDuration: 0
};

// Steps Configuration
const STEPS_A = ['step-A1', 'step-A2', 'step-SyncEngine', 'step-Render'];
const STEPS_B = ['step-B1', 'step-B2', 'step-B3', 'step-B4', 'step-SyncEngine', 'step-Render'];
let currentSteps = [];

// DOM Elements
const els = {
    wizardContainer: document.getElementById('wizard-container'),
    btnNext: document.getElementById('btn-next'),
    btnBack: document.getElementById('btn-back'),
    btnCancel: document.getElementById('btn-cancel'),
    btnFinish: document.getElementById('btn-finish'),
    liveRegion: document.getElementById('live-region'),

    // Players
    refVideo: document.getElementById('ref-video-player'),
    cleanAudio: document.getElementById('clean-audio-player'),
    videoAudio: document.getElementById('video-audio-player'),
    refPlaybackAudio: document.getElementById('ref-playback-audio'),

    // Displays
    displayVideoPath: document.getElementById('display-video-path'),
    displayAudioPath: document.getElementById('display-audio-path'),
    displayRefAudioPath: document.getElementById('display-ref-audio-path'),

    // Sync UI
    offsetDisplay: document.getElementById('offset-display'),

    // Recording
    cameraPreview: document.getElementById('camera-preview'),
    countdownDisplay: document.getElementById('countdown-display'),
    recordingIndicator: document.getElementById('recording-indicator')
};

// Media Recorder variables
let mediaRecorder;
let recordedChunks = [];
let audioContext; // For beeps
let recordingStream;

// Sync Engine Audio Context
let syncCtx;
let refSource, cleanSource, videoAudioSource;
let refGain, cleanGain, videoAudioGain;
let refPanner, cleanPanner, videoAudioPanner;
let syncNodesInitialized = false;
let videoAudioInitialized = false;
let extractedVideoAudioPath = null;

// Audio Helper for Beeps
function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

function playBeep(freq = 440, duration = 0.1, type = 'sine') {
    initAudioContext();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioContext.currentTime);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + duration);
}

// --- INITIALIZATION ---
ipcRenderer.on('init-wizard', (event, mode) => {
    currentMode = mode;
    currentSteps = (mode === 'A') ? STEPS_A : STEPS_B;
    state.stepIndex = 0;

    // Title Update
    document.getElementById('wizard-title').innerText =
        (mode === 'A') ? 'Harici Sesi Videoyla Senkronla' : 'Referans Sesle Video Kaydet';

    updateUI();
    announce('Sihirbaz açıldı. Başlamak için dosyaları seçin.');
});

// --- NAVIGATION ---
function updateUI() {
    // Hide all steps
    document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));

    // Show current step
    const currentStepId = currentSteps[state.stepIndex];
    document.getElementById(currentStepId).classList.add('active');

    // Button States
    els.btnBack.disabled = (state.stepIndex === 0);

    // Last step check
    if (state.stepIndex === currentSteps.length - 1) {
        els.btnNext.style.display = 'none';
        els.btnFinish.style.display = 'inline-block';
    } else {
        els.btnNext.style.display = 'inline-block';
        els.btnFinish.style.display = 'none';
    }

    // Step specific init
    if (currentStepId === 'step-SyncEngine') initSyncEngine();
    if (currentStepId === 'step-B2') initCameraSetup();
    if (currentStepId === 'step-B3') {
        announce('Kayıt Stüdyosu. Kaydı başlatmak için R tuşuna veya ekrandaki düğmeye basın.');
    }

    // Step Announcement
    const stepNumber = state.stepIndex + 1;
    const totalSteps = currentSteps.length;
    const stepTitle = document.querySelector(`#${currentStepId} h3`)?.innerText || '';
    announce(`Adım ${stepNumber} / ${totalSteps}: ${stepTitle}`);
}

els.btnNext.addEventListener('click', async () => {
    try {
        if (!validateCurrentStep()) return;

        // Pre-transition logic
        const currentStepId = currentSteps[state.stepIndex];

        if (currentStepId === 'step-A2') {
            const choice = document.querySelector('input[name="sync-choice"]:checked').value;
            if (choice === 'zero') state.offsetMs = 0;
            // if choice is 'apply', offsetMs is already set by analysis
        }

        if (currentStepId === 'step-B4') {
            const source = document.querySelector('input[name="main-audio-source"]:checked').value;
            if (source === 'mic') {
                state.cleanAudioPath = state.recordAudioPath; // Use recorded mic
                // Also set video path to recorded video
                state.videoPath = state.recordVideoPath;
            } else if (source === 'external') {
                // Already set via file picker
                state.videoPath = state.recordVideoPath;
            } else if (source === 'reference') {
                state.cleanAudioPath = state.refAudioPath; // Use the reference music as clean audio
                state.videoPath = state.recordVideoPath;
            } else {
                // "Later"
                state.videoPath = state.recordVideoPath;
            }

            // Load media for sync
            if (state.videoPath) els.refVideo.src = state.videoPath;
            if (state.cleanAudioPath) els.cleanAudio.src = state.cleanAudioPath;
        }

        state.stepIndex++;
        updateUI();
    } catch (error) {
        console.error('Next Button Error:', error);
        alert('İleri giderken bir hata oluştu: ' + error.message);
    }
});

els.btnBack.addEventListener('click', () => {
    if (state.stepIndex > 0) {
        state.stepIndex--;
        updateUI();
    }
});

els.btnFinish.addEventListener('click', () => {
    startRender();
});

els.btnCancel.addEventListener('click', () => {
    window.close();
});

function validateCurrentStep() {
    const step = currentSteps[state.stepIndex];

    if (step === 'step-A1') {
        if (!state.videoPath || !state.cleanAudioPath) {
            alert('Lütfen her iki dosyayı da seçin.');
            return false;
        }
        // Load for analysis - ensure clean state
        els.refVideo.pause();
        els.cleanAudio.pause();
        els.refVideo.src = state.videoPath;
        els.cleanAudio.src = state.cleanAudioPath;
        els.refVideo.currentTime = 0;
        els.cleanAudio.currentTime = 0;
        // Trigger auto-sync analysis (Simulation)
        simulateAutoSync();
    }

    if (step === 'step-B1') {
        if (!state.refAudioPath) {
            alert('Referans ses dosyası seçilmedi.');
            return false;
        }
        els.refPlaybackAudio.src = state.refAudioPath;
    }

    if (step === 'step-B3') {
        if (!state.recordVideoPath) {
            alert('Henüz kayıt yapmadınız.');
            return false;
        }
    }

    return true;
}


// --- FILE HANDLING ---
async function selectFile(type, extensions, displayEl, stateKey) {
    const result = await ipcRenderer.invoke('show-open-dialog', { extensions });
    if (!result.canceled && result.filePaths.length > 0) {
        const p = result.filePaths[0];
        state[stateKey] = p;
        displayEl.innerText = path.basename(p);
        announce(`${type} seçildi: ${path.basename(p)}`);

        if (type === 'WAV/MP3') {
            document.querySelector('#post-record-external-file').style.display = 'block';
        }
    }
}

document.getElementById('btn-select-video').onclick = () => selectFile('Video', ['mp4', 'mov', 'avi', 'mkv'], els.displayVideoPath, 'videoPath');
document.getElementById('btn-select-audio').onclick = () => selectFile('Ses', ['wav', 'mp3', 'aac'], els.displayAudioPath, 'cleanAudioPath');
document.getElementById('btn-select-ref-audio').onclick = () => selectFile('Ref Ses', ['wav', 'mp3'], els.displayRefAudioPath, 'refAudioPath');

// B4 External File Selection
document.getElementById('source-external').addEventListener('change', () => {
    document.getElementById('post-record-external-file').style.display = 'block';
});
document.getElementById('source-mic').addEventListener('change', () => {
    document.getElementById('post-record-external-file').style.display = 'none';
});
document.getElementById('btn-select-main-wav').onclick = () => selectFile('Ana Ses', ['wav', 'mp3'], document.getElementById('display-main-wav-path'), 'cleanAudioPath');


// --- AUTO SYNC (SIMULATION) ---
function simulateAutoSync() {
    // In a real app, we would analyze waveforms here.
    // simulation:
    setTimeout(() => {
        document.getElementById('analysis-status').style.display = 'none';
        document.getElementById('analysis-result').style.display = 'block';

        // Random suggestion
        const suggested = 0; // default
        document.getElementById('suggested-offset').innerText = `+${suggested} ms`;
        document.getElementById('confidence-level').innerText = 'Orta (Simülasyon)';
        state.offsetMs = suggested;

        // Auto announce and focus
        const msg = `Otomatik Senkron Analizi Tamamlandı. Önerilen Offset: ${suggested} milisaniye. Güven Seviyesi: Orta. Nasıl devam etmek istersiniz?`;
        announce(msg);
        // Focus first option
        const firstOption = document.querySelector('input[name="sync-choice"]');
        if (firstOption) firstOption.focus();

    }, 1500);
}


// --- SYNC ENGINE LOGIC ---
function initSyncEngine() {
    announce('Senkron ekranı yükleniyor...');
    els.offsetDisplay.value = `${state.offsetMs} ms`;

    // DEBUG: Verify video element and source
    console.log('initSyncEngine - Video element:', els.refVideo);
    console.log('initSyncEngine - Video src:', els.refVideo.src);
    console.log('initSyncEngine - Video path from state:', state.videoPath);

    // Ensure video has the correct source
    if (!els.refVideo.src || els.refVideo.src === '') {
        if (state.videoPath) {
            els.refVideo.src = state.videoPath;
            console.log('Video src was empty, set to:', state.videoPath);
        }
    }

    // CRITICAL: Reset video and audio positions to the beginning
    els.refVideo.currentTime = 0;
    els.cleanAudio.currentTime = 0;

    // Pause both to ensure clean state
    els.refVideo.pause();
    els.cleanAudio.pause();

    // Wait for video to be ready before allowing playback
    const waitForVideoReady = () => {
        return new Promise((resolve) => {
            // readyState 3 = HAVE_FUTURE_DATA, 4 = HAVE_ENOUGH_DATA
            if (els.refVideo.readyState >= 3) {
                resolve();
            } else {
                els.refVideo.addEventListener('canplay', () => resolve(), { once: true });
                // Force load if needed
                els.refVideo.load();
            }
        });
    };

    waitForVideoReady().then(() => {
        // Initialize Web Audio API for Panning AFTER video is ready
        initSyncAudioNodes();

        // Set initial volumes based on listening mode
        updateListeningMode();
        updateChannelRouting(); // Apply default (center)

        announce('Senkron ekranı. Oynatmak için Space, Senkron için Alt+Yön tuşlarını kullanın.');

        // Focus play button for accessibility
        document.getElementById('btn-sync-play').focus();
    });

    // Error handler for unsupported video formats
    els.refVideo.addEventListener('error', (e) => {
        console.error('Video Error:', e);
        const errorMsg = els.refVideo.error ? els.refVideo.error.message : 'Bilinmeyen hata';
        announce(`Video yüklenemedi: ${errorMsg}. MOV veya desteklenmeyen format olabilir. MP4 formatı önerilir.`);
    });

    // Accessibility Hint on Focus
    document.getElementById('btn-sync-play').onfocus = () => {
        announce('Oynat. İpucu: İnce ayar için: 10ms Alt+Ok, 100ms Alt+Shift+Ok, 1ms Win+Ctrl+Ok.');
    };
}

function updateListeningMode() {
    const mode = document.getElementById('listen-mode').value;
    const channelMode = document.getElementById('channel-mode').value;
    state.listenMode = mode;

    let refVol = 0;
    let cleanVol = 0;
    let cleanMute = false;

    if (mode === 'mix') {
        refVol = 0.5;
        cleanVol = 0.5;
    } else if (mode === 'ref') {
        refVol = 1.0;
        cleanVol = 0;
        cleanMute = true;
        // CRITICAL: Stop cleanAudio completely when in video-only mode
        els.cleanAudio.pause();
    } else if (mode === 'clean') {
        refVol = 0;
        cleanVol = 1.0;
    }

    // Resume AudioContext if needed
    if (syncNodesInitialized && syncCtx.state === 'suspended') {
        syncCtx.resume();
    }

    // VIDEO/VIDEO AUDIO volume control
    if (channelMode === 'split-extract' && videoAudioInitialized) {
        // In split-extract mode, video is muted, audio comes from videoAudio element
        els.refVideo.muted = true;
        if (videoAudioGain) {
            els.videoAudio.muted = false;
            videoAudioGain.gain.value = refVol;
        }
    } else {
        // Use native video audio
        els.refVideo.muted = (refVol === 0);
        els.refVideo.volume = refVol;
    }

    // CLEAN AUDIO: Use Web Audio
    if (syncNodesInitialized && cleanGain) {
        els.cleanAudio.muted = false;
        cleanGain.gain.value = cleanMute ? 0 : cleanVol;
    } else {
        els.cleanAudio.muted = cleanMute;
        els.cleanAudio.volume = cleanVol;
    }
}

function updateChannelRouting() {
    const mode = document.getElementById('channel-mode').value;

    if (!syncNodesInitialized || !cleanPanner) return;

    // Show/hide warning
    const warning = document.getElementById('extract-warning');
    if (warning) {
        warning.style.display = (mode === 'split-extract') ? 'block' : 'none';
    }

    if (mode === 'split') {
        // Simple split: Clean audio to left, Video uses native (center)
        if (cleanPanner) cleanPanner.pan.value = -1; // Left

        // Make sure video uses native audio, not extracted
        els.refVideo.muted = false;
        if (els.videoAudio) els.videoAudio.pause();

        announce('Ayrık - Basit: Temiz ses solda, Video sesi merkezde.');

    } else if (mode === 'split-extract') {
        // Full split: Extract video audio, pan left and right
        extractAndSetupVideoAudio().then(() => {
            if (cleanPanner) cleanPanner.pan.value = -1; // Left
            if (videoAudioPanner) videoAudioPanner.pan.value = 1; // Right

            // Mute video element, audio comes from extracted file
            els.refVideo.muted = true;

            announce('Ayrık - Tam: Temiz ses solda, Video sesi sağda.');
        }).catch(err => {
            console.error('Video audio extraction failed:', err);
            announce('Video sesi çıkarılamadı. Basit moda dönülüyor.');
            document.getElementById('channel-mode').value = 'split';
            updateChannelRouting();
        });

    } else {
        // Center mode
        if (cleanPanner) cleanPanner.pan.value = 0;
        if (videoAudioPanner) videoAudioPanner.pan.value = 0;

        // Use native video audio
        els.refVideo.muted = false;
        if (els.videoAudio) els.videoAudio.pause();

        announce('Merkezi mod: Her iki ses de merkezde.');
    }
}

// Extract video audio and setup Web Audio for it
async function extractAndSetupVideoAudio() {
    // Check if already extracted
    if (extractedVideoAudioPath && videoAudioInitialized) {
        console.log('Using already extracted video audio');
        return;
    }

    if (!state.videoPath) {
        throw new Error('No video path');
    }

    announce('Video sesi çıkarılıyor, lütfen bekleyin...');

    // Extract audio using existing IPC handler
    const tempPath = await ipcRenderer.invoke('get-temp-path', 'sync_video_audio.wav');
    const result = await ipcRenderer.invoke('extract-audio', {
        inputPath: state.videoPath,
        outputPath: tempPath
    });

    if (!result.success) {
        throw new Error(result.error || 'Extraction failed');
    }

    extractedVideoAudioPath = tempPath;

    // Load into audio element
    els.videoAudio.src = extractedVideoAudioPath;
    els.videoAudio.load();

    // Wait for audio to be ready
    await new Promise((resolve, reject) => {
        els.videoAudio.addEventListener('canplay', () => resolve(), { once: true });
        els.videoAudio.addEventListener('error', (e) => reject(e), { once: true });
        setTimeout(() => reject(new Error('Timeout')), 10000);
    });

    // Setup Web Audio for videoAudio if not already done
    if (!videoAudioInitialized && syncCtx) {
        try {
            videoAudioSource = syncCtx.createMediaElementSource(els.videoAudio);
            videoAudioGain = syncCtx.createGain();
            videoAudioPanner = syncCtx.createStereoPanner();

            videoAudioSource.connect(videoAudioGain).connect(videoAudioPanner).connect(syncCtx.destination);
            videoAudioInitialized = true;
            console.log('Video audio Web Audio nodes initialized');
        } catch (e) {
            console.error('Failed to setup Web Audio for video audio:', e);
            throw e;
        }
    }

    announce('Video sesi hazır.');
}

function initSyncAudioNodes() {
    if (syncNodesInitialized) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        syncCtx = new AudioContext();

        // Only connect cleanAudio to Web Audio API
        // Video will use native HTML5 audio (no panning for video)
        cleanSource = syncCtx.createMediaElementSource(els.cleanAudio);
        cleanGain = syncCtx.createGain();

        // Create Panner for cleanAudio
        if (syncCtx.createStereoPanner) {
            cleanPanner = syncCtx.createStereoPanner();
        } else {
            console.warn('StereoPannerNode not supported');
            return;
        }

        // Connect Chain for cleanAudio: Source -> Gain -> Panner -> Destination
        cleanSource.connect(cleanGain).connect(cleanPanner).connect(syncCtx.destination);

        syncNodesInitialized = true;
        console.log('Sync Audio Nodes Initialized (cleanAudio only)');

    } catch (e) {
        console.error('Web Audio Init Error:', e);
    }
}

document.getElementById('listen-mode').addEventListener('change', updateListeningMode);
document.getElementById('channel-mode').addEventListener('change', updateChannelRouting);

// Playback Control
async function togglePlay() {
    // Ensure Context is running
    if (syncNodesInitialized && syncCtx.state === 'suspended') {
        try { await syncCtx.resume(); } catch (e) { console.error(e); }
    }

    try {
        if (els.refVideo.paused) {
            // CRITICAL: If video has ended or is near the end, perform full reset
            if (els.refVideo.ended || (els.refVideo.duration > 0 && els.refVideo.currentTime >= els.refVideo.duration - 0.5)) {
                console.log('Video ended state detected, performing full reload');
                const currentSrc = els.refVideo.src;
                els.refVideo.src = currentSrc;
                els.refVideo.load();
                els.cleanAudio.currentTime = 0;
                if (els.videoAudio) els.videoAudio.currentTime = 0;
                announce('Video başa alındı.');
                // Wait for video to be ready after reload
                await new Promise((resolve) => {
                    els.refVideo.addEventListener('canplay', () => resolve(), { once: true });
                });
            }

            // Check if video is ready to play
            if (els.refVideo.readyState < 3) {
                announce('Video yükleniyor, lütfen bekleyin...');
                // Wait for video to be ready
                await new Promise((resolve) => {
                    els.refVideo.addEventListener('canplay', () => resolve(), { once: true });
                });
            }

            // Start playback
            await els.refVideo.play();
            announce('Oynatılıyor');
        } else {
            els.refVideo.pause();
            // Pause audio immediately when video pauses
            els.cleanAudio.pause();
            if (els.videoAudio) els.videoAudio.pause();
            announce('Duraklatıldı');
        }
    } catch (e) {
        console.error('Playback Error:', e);
        announce('Oynatma hatası.');
    }
}

function syncAudio(force = false) {
    const channelMode = document.getElementById('channel-mode').value;

    // CRITICAL: If in "Sadece Video (ref)" mode, don't touch cleanAudio at all
    if (state.listenMode === 'ref') {
        // Ensure cleanAudio is paused and silent
        if (!els.cleanAudio.paused) {
            els.cleanAudio.pause();
        }
        // But still sync videoAudio if in split-extract mode
        if (channelMode === 'split-extract' && videoAudioInitialized) {
            syncVideoAudio();
        }
        return;
    }

    const vidTime = els.refVideo.currentTime;
    // Calculate expected audio time
    const audTime = vidTime - (state.offsetMs / 1000);

    // 1. Check if audio should even be playing
    if (audTime < 0) {
        if (!els.cleanAudio.paused) els.cleanAudio.pause();
        els.cleanAudio.currentTime = 0;
        return;
    }

    // 2. If video is paused, audio must be paused
    if (els.refVideo.paused) {
        if (!els.cleanAudio.paused) els.cleanAudio.pause();
        if (channelMode === 'split-extract' && videoAudioInitialized && !els.videoAudio.paused) {
            els.videoAudio.pause();
        }
        return;
    }

    // 3. Audio Start / Sync Logic (only for 'mix' or 'clean' modes)
    // If audio is paused but should be playing (and video is playing)
    if (els.cleanAudio.paused) {
        els.cleanAudio.currentTime = audTime;
        els.cleanAudio.play().catch(e => console.warn('Audio auto-play blocked?', e));
    }

    // 4. Drift Correction (While playing)
    const drift = Math.abs(els.cleanAudio.currentTime - audTime);
    // Tolerance: 30ms (approx 1 frame @ 30fps)
    // If drift is too high, hard sync.
    if (force || drift > 0.03) {
        console.log(`Sync correcting drift: ${drift.toFixed(3)}s`);
        els.cleanAudio.currentTime = audTime;
    }

    // 5. Sync videoAudio if in split-extract mode
    if (channelMode === 'split-extract' && videoAudioInitialized) {
        syncVideoAudio();
    }
}

// Sync extracted video audio with video (no offset - they should match perfectly)
function syncVideoAudio() {
    if (!els.videoAudio || !videoAudioInitialized) return;

    const vidTime = els.refVideo.currentTime;

    // If video is paused, pause videoAudio
    if (els.refVideo.paused) {
        if (!els.videoAudio.paused) els.videoAudio.pause();
        return;
    }

    // If videoAudio is paused but should be playing
    if (els.videoAudio.paused) {
        els.videoAudio.currentTime = vidTime;
        els.videoAudio.play().catch(e => console.warn('VideoAudio play error:', e));
        return;
    }

    // Drift correction - very tight tolerance since they should be exact
    const drift = Math.abs(els.videoAudio.currentTime - vidTime);
    if (drift > 0.02) {
        els.videoAudio.currentTime = vidTime;
    }
}

// Event Listeners for Sync
els.refVideo.addEventListener('timeupdate', () => {
    // Loop Logic
    if (state.loopEnabled) {
        if (els.refVideo.currentTime >= state.loopStart + state.loopDuration) {
            els.refVideo.currentTime = state.loopStart;
            syncAudio(); // Force sync
        }
    }
    syncAudio();
});

els.refVideo.addEventListener('playing', () => {
    document.getElementById('btn-sync-play').innerText = 'Duraklat (Space)';
    if (syncNodesInitialized && syncCtx.state === 'suspended') syncCtx.resume();
    // Force immediate sync when video actually starts playing frames
    syncAudio(true);
});

els.refVideo.addEventListener('waiting', () => {
    // If video buffers, pause audio
    if (!els.cleanAudio.paused) els.cleanAudio.pause();
});

els.refVideo.addEventListener('pause', () => {
    document.getElementById('btn-sync-play').innerText = 'Oynat (Space)';
    els.cleanAudio.pause();
});

els.refVideo.addEventListener('seeking', syncAudio);
els.refVideo.addEventListener('seeked', syncAudio);

// CRITICAL: Reset positions when video ends
els.refVideo.addEventListener('ended', () => {
    console.log('Video ended, performing full reset');
    // Store current src
    const currentSrc = els.refVideo.src;

    // Full reset - reload the video
    els.refVideo.src = currentSrc;
    els.refVideo.load();

    els.cleanAudio.currentTime = 0;
    els.cleanAudio.pause();
    document.getElementById('btn-sync-play').innerText = 'Oynat (Space)';
    announce('Video bitti. Tekrar oynatmak için Space tuşuna basın.');
});

// Loop Button
document.getElementById('btn-toggle-loop').onclick = () => {
    state.loopEnabled = !state.loopEnabled;
    const btn = document.getElementById('btn-toggle-loop');

    if (state.loopEnabled) {
        state.loopStart = els.refVideo.currentTime;
        btn.innerText = 'Loop: AÇIK (2sn)';
        btn.style.background = '#0078d4';
        announce('Loop aktif. Şu anki konumdan itibaren 2 saniye dönecek.');
    } else {
        btn.innerText = 'Loop: Kapalı (O)';
        btn.style.background = '#444';
        announce('Loop kapatıldı.');
    }
};

// Play/Pause Button
document.getElementById('btn-sync-play').onclick = () => {
    togglePlay();
};

// Offset Control
function adjustOffset(deltaMs) {
    state.offsetMs += deltaMs;
    els.offsetDisplay.value = `${state.offsetMs} ms`;
    announce(`Offset ${state.offsetMs} milisaniye`);

    // If playing, adjust on the fly
    if (!els.refVideo.paused) {
        syncAudio(true); // Force sync update
    }
}

document.getElementById('btn-offset-inc').onclick = () => adjustOffset(10);
document.getElementById('btn-offset-dec').onclick = () => adjustOffset(-10);


// --- RECORDING LOGIC (Mode B) ---
async function initCameraSetup() {
    // Get Devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoSelect = document.getElementById('camera-select');
    const audioSelect = document.getElementById('mic-select');

    videoSelect.innerHTML = '';
    audioSelect.innerHTML = '';

    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `${device.kind} ${videoSelect.length + 1}`;
        if (device.kind === 'videoinput') videoSelect.appendChild(option);
        if (device.kind === 'audioinput') audioSelect.appendChild(option);
    });

    startCameraPreview();
}

// Test Recording Logic
document.getElementById('btn-test-devices').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-devices');
    const msg = document.getElementById('test-result-msg');

    if (state.isRecording) {
        alert('Zaten bir kayıt yapılıyor.');
        return;
    }

    btn.disabled = true;
    msg.innerText = 'Test kaydı yapılıyor (5 sn)... Konuşun!';
    msg.style.color = 'yellow';
    announce('Test kaydı başladı.');

    const videoSource = document.getElementById('camera-select').value;
    const audioSource = document.getElementById('mic-select').value;

    const constraints = {
        video: { deviceId: videoSource ? { exact: videoSource } : undefined },
        audio: {
            deviceId: audioSource ? { exact: audioSource } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        }
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const recorder = new MediaRecorder(stream);
        const chunks = [];

        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);

            // Create a temp video to play
            const testVideo = document.createElement('video');
            testVideo.src = url;
            testVideo.volume = 1.0;
            testVideo.style.position = 'fixed';
            testVideo.style.top = '50%';
            testVideo.style.left = '50%';
            testVideo.style.transform = 'translate(-50%, -50%)';
            testVideo.style.width = '400px';
            testVideo.style.border = '2px solid cyan';
            testVideo.style.zIndex = '9999';
            testVideo.controls = true;

            document.body.appendChild(testVideo);
            await testVideo.play();

            msg.innerText = 'Test kaydı oynatılıyor. Dinleyin... (Video dışına tıklayarak kapatın)';
            msg.style.color = 'lime';
            announce('Test kaydı tamamlandı, oynatılıyor.');

            // Cleanup on click
            const closeHandler = () => {
                testVideo.pause();
                testVideo.remove();
                URL.revokeObjectURL(url);
                btn.disabled = false;
                msg.innerText = 'Test tamamlandı.';
                document.removeEventListener('click', closeHandler);
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 1000);
        };

        recorder.start();
        setTimeout(() => recorder.stop(), 5000); // 5 sec test

    } catch (e) {
        alert('Test hatası: ' + e.message);
        btn.disabled = false;
        msg.innerText = 'Hata oluştu.';
    }
});

async function startCameraPreview() {
    const videoSource = document.getElementById('camera-select').value;
    const constraints = {
        video: { deviceId: videoSource ? { exact: videoSource } : undefined },
        audio: false // Preview muted
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        els.cameraPreview.srcObject = stream;
    } catch (e) {
        console.error('Camera error', e);
    }
}

// Variables are already declared at the top of the file
// let recordingStream;
// let mediaRecorder;
// let recordedChunks = [];

// This function handles the actual recording flow
async function toggleRecording() {
    if (state.isRecording) {
        stopRecording();
    } else {
        startRecordingCountIn();
    }
}

function startRecordingCountIn() {
    const countTime = parseInt(document.getElementById('count-in-select').value);

    if (countTime > 0) {
        announce(`Geri sayım başlıyor: ${countTime} saniye`);
        let count = countTime;
        els.countdownDisplay.style.display = 'block';
        els.countdownDisplay.innerText = count;

        const timer = setInterval(() => {
            count--;
            if (count > 0) {
                els.countdownDisplay.innerText = count;
                playBeep(600, 0.1); // Beep on count
            } else {
                clearInterval(timer);
                els.countdownDisplay.style.display = 'none';
                playBeep(880, 0.3); // Higher pitch on start
                startRecordingImmediate();
            }
        }, 1000);
    } else {
        playBeep(880, 0.3);
        startRecordingImmediate();
    }
}

async function startRecordingImmediate() {
    state.isRecording = true;
    els.recordingIndicator.style.display = 'block';
    document.getElementById('record-status-text').innerText = 'KAYIT YAPILIYOR (Durdurmak için R)';
    document.getElementById('record-status-text').style.color = 'red';
    announce('Kayıt başladı!');

    // Start playback of ref audio
    els.refPlaybackAudio.currentTime = 0;
    els.refPlaybackAudio.play();

    // Start capturing stream
    const videoSource = document.getElementById('camera-select').value;
    const audioSource = document.getElementById('mic-select').value;
    const recordMic = document.getElementById('record-mic-check').checked;

    const constraints = {
        video: { deviceId: videoSource ? { exact: videoSource } : undefined },
        audio: recordMic ? {
            deviceId: audioSource ? { exact: audioSource } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        } : false
    };

    try {
        recordingStream = await navigator.mediaDevices.getUserMedia(constraints);
        mediaRecorder = new MediaRecorder(recordingStream);
        recordedChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = saveRecording;
        mediaRecorder.start();

        // Update Button UI
        document.getElementById('btn-toggle-record').innerText = '⏹ KAYDI BİTİR (R)';
        document.getElementById('btn-toggle-record').style.background = 'darkred';

    } catch (e) {
        console.error('Recording error', e);
        alert('Kayıt başlatılamadı: ' + e.message);
        state.isRecording = false;
        els.recordingIndicator.style.display = 'none';
        document.getElementById('record-status-text').innerText = 'Kayıt Başlatılamadı.';
        document.getElementById('record-status-text').style.color = 'red';
    }
}

function stopRecording() {
    if (!state.isRecording) return;

    state.isRecording = false;
    els.recordingIndicator.style.display = 'none';
    document.getElementById('record-status-text').innerText = 'Kayıt Bitti. İleri diyerek devam edin.';
    document.getElementById('record-status-text').style.color = 'lime';
    announce('Kayıt durduruldu.');
    playBeep(440, 0.3); // Off beep

    // Update Button UI
    document.getElementById('btn-toggle-record').innerText = '⚫ YENİ KAYIT (R)';
    document.getElementById('btn-toggle-record').style.background = 'red';

    els.refPlaybackAudio.pause();

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        recordingStream.getTracks().forEach(track => track.stop());
    }
}

async function saveRecording() {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const buffer = Buffer.from(await blob.arrayBuffer());

    document.getElementById('record-status-text').innerText = 'Dosya kaydediliyor...';

    // Request Main to save temp file
    try {
        const result = await ipcRenderer.invoke('save-temp-recording', buffer);
        if (result.success) {
            state.recordVideoPath = result.videoPath;
            state.recordAudioPath = result.audioPath; // Extracted audio if needed
            announce('Geçici kayıt dosyası oluşturuldu.');
            document.getElementById('record-status-text').innerText = 'Kayıt Başarıyla Kaydedildi. (✔)';
        } else {
            alert('Kayıt kaydedilemedi.');
            document.getElementById('record-status-text').innerText = 'Kayıt Hatası!';
        }
    } catch (e) {
        alert('Kaydetme hatası: ' + e.message);
    }
}


// --- GLOBAL SHORTCUTS ---
// We attach to window keydown
// --- GLOBAL SHORTCUTS ---
// We attach to window keydown
window.addEventListener('keydown', (e) => {

    // Prevent default handling if necessary

    // Global Wizard Navigation (Alt+L = Next, Alt+G = Back)
    if (e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (!els.btnNext.disabled && els.btnNext.style.display !== 'none') {
            els.btnNext.click();
        } else if (!els.btnFinish.disabled && els.btnFinish.style.display !== 'none') {
            els.btnFinish.click();
        }
        return;
    }
    if (e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        if (!els.btnBack.disabled) {
            els.btnBack.click();
        }
        return;
    }

    // Sync Engine Shortcuts
    const isSyncActive = document.getElementById('step-SyncEngine').classList.contains('active');

    if (isSyncActive) {
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlay();
        }
        else if (e.code === 'ArrowRight') {
            e.preventDefault();
            if (e.altKey) {
                // Windows Key (Meta) + Ctrl + Alt + Arrow is tricky.
                // User asked for Win+Ctrl+Arrow for 1ms.
                const isWinCtrl = e.metaKey && e.ctrlKey;
                const isAltShift = e.altKey && e.shiftKey;

                let multi = 10; // Default Alt
                if (isWinCtrl) multi = 1;
                else if (isAltShift) multi = 100;

                adjustOffset(multi);
            } else {
                els.refVideo.currentTime += 5;
                syncAudio(true);
            }
        }
        else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            if (e.altKey) {
                const isWinCtrl = e.metaKey && e.ctrlKey;
                const isAltShift = e.altKey && e.shiftKey;

                let multi = 10;
                if (isWinCtrl) multi = 1;
                else if (isAltShift) multi = 100;

                adjustOffset(-multi);
            } else {
                els.refVideo.currentTime -= 5;
                syncAudio(true);
            }
        }
        else if (e.key === 'L' || e.key === 'l') {
            // Loop toggle logic is now handled in the click handler logic replication
            document.getElementById('btn-toggle-loop').click();
            e.preventDefault();
        }
        else if (e.key === '1') { document.getElementById('listen-mode').value = 'ref'; updateListeningMode(); announce('Mod: Sadece Video'); }
        else if (e.key === '2') { document.getElementById('listen-mode').value = 'clean'; updateListeningMode(); announce('Mod: Sadece Temiz Ses'); }
        else if (e.key === '3') { document.getElementById('listen-mode').value = 'mix'; updateListeningMode(); announce('Mod: Karışık'); }
    }

    // Recording Shortcuts
    const isRecActive = document.getElementById('step-B3').classList.contains('active');

    if (isRecActive) {
        if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            toggleRecording();
        }
        else if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            if (mediaRecorder && state.isRecording) {
                if (mediaRecorder.state === 'recording') {
                    mediaRecorder.pause();
                    announce('Kayıt Duraklatıldı');
                } else if (mediaRecorder.state === 'paused') {
                    mediaRecorder.resume();
                    announce('Kayıt Devam Ediyor');
                }
            }
        }
        else if (e.code === 'Space' || e.code === 'Enter') {
            // Allow if focus is on a button or link
            if (document.activeElement && (document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'A')) {
                return;
            }
            e.preventDefault();
            // Block other usages to prevent unintended form submission
        }
    }

    if (e.key === 'Escape') {
        window.close(); // Careful, might need confirmation if recording
    }
});

// Setup Record Button Click
if (document.getElementById('btn-toggle-record')) {
    document.getElementById('btn-toggle-record').onclick = toggleRecording;
}


// --- RENDER ---
// --- RENDER ---
async function startRender() {
    // 1. Ask where to save
    const saveResult = await ipcRenderer.invoke('show-save-dialog', {
        defaultPath: 'senkron_video.mp4'
    });

    if (saveResult.canceled) {
        return; // User cancelled
    }

    const targetOutputPath = saveResult.filePath;

    document.getElementById('render-progress-area').style.display = 'block';
    els.btnFinish.disabled = true;
    els.btnFinish.innerText = 'İşleniyor...';
    announce('Video oluşturuluyor, lütfen bekleyin.');

    // Gather logic
    const payload = {
        videoPath: state.videoPath,
        audioPath: state.cleanAudioPath,
        offsetMs: state.offsetMs,
        muteOriginal: document.getElementById('mute-original').checked,
        targetOutputPath: targetOutputPath // Send the chosen path
    };

    try {
        const result = await ipcRenderer.invoke('render-sync-video', payload);
        if (result.success) {
            announce('Video başarıyla oluşturuldu.');
            alert('Video başarıyla oluşturuldu!\nDosya: ' + result.outputPath);
            // Open folder?
            // remote.shell.showItemInFolder(result.outputPath);
            window.close();
        } else {
            announce('Video oluşturulurken hata oluştu.');
            alert('Hata: ' + result.error);
            els.btnFinish.disabled = false;
            els.btnFinish.innerText = 'Oluştur (Render)';
        }
    } catch (e) {
        announce('İletişim hatası.');
        alert('İletişim hatası: ' + e.message);
        els.btnFinish.disabled = false;
        els.btnFinish.innerText = 'Oluştur (Render)';
    }
}

// Accessibility Helper
function announce(msg) {
    els.liveRegion.innerText = msg;
}

// --- KEYBOARD SHORTCUTS (Sync Engine Step) ---

/**
 * Video'yu durdur ve başa al (S tuşu)
 */
function stopAndReset() {
    els.refVideo.pause();
    els.refVideo.currentTime = 0;
    els.cleanAudio.pause();
    els.cleanAudio.currentTime = 0;

    // Video Audio da varsa
    if (els.videoAudio) {
        els.videoAudio.pause();
        els.videoAudio.currentTime = 0;
    }

    // Loop'u kapat
    state.loopEnabled = false;
    const loopBtn = document.getElementById('btn-toggle-loop');
    if (loopBtn) {
        loopBtn.innerText = 'Loop: Kapalı (O)';
        loopBtn.style.background = '#444';
    }

    document.getElementById('btn-sync-play').innerText = 'Oynat (Space)';
    announce('Durduruldu ve başa alındı.');
}

/**
 * Video'yu ileri/geri sar (J/L tuşları)
 * @param {number} seconds - Saniye cinsinden (+ileri, -geri)
 */
function seekSync(seconds) {
    const newTime = Math.max(0, Math.min(els.refVideo.duration || 0, els.refVideo.currentTime + seconds));
    els.refVideo.currentTime = newTime;

    // Ses de senkronize et
    syncAudio(true);

    const direction = seconds > 0 ? 'İleri' : 'Geri';
    announce(`${direction} ${Math.abs(seconds)} saniye.`);
}

/**
 * Sync Engine adımında mıyız kontrol et
 */
function isOnSyncEngineStep() {
    return currentSteps[state.stepIndex] === 'step-SyncEngine';
}

// Global kısayol dinleyicisi
document.addEventListener('keydown', (e) => {
    // Sadece Sync Engine adımında çalış
    if (!isOnSyncEngineStep()) return;

    const key = e.key.toLowerCase();

    // K - Duraklat/Oynat (her zaman çalışır)
    if (key === 'k' && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        togglePlay();
    }
    // Space - Duraklat/Oynat (input/button dışında)
    else if (e.key === ' ' && !['INPUT', 'BUTTON', 'TEXTAREA'].includes(e.target.tagName) && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        togglePlay();
    }
    // S - Durdur ve başa al
    else if (key === 's' && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        stopAndReset();
    }
    // J - Geri sar (5 saniye)
    else if (key === 'j' && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        seekSync(-5);
    }
    // L - İleri sar (5 saniye)
    else if (key === 'l' && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        seekSync(5);
    }
    // O - Loop toggle (L'den değiştirildi)
    else if (key === 'o' && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('btn-toggle-loop')?.click();
    }
    // Alt+Arrow - offset ±10ms
    else if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            adjustOffset(10);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            adjustOffset(-10);
        }
    }
    // Alt+Shift+Arrow - offset ±100ms
    else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            adjustOffset(100);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            adjustOffset(-100);
        }
    }
    // Win+Ctrl+Arrow veya Ctrl+Alt+Arrow - offset ±1ms
    else if ((e.ctrlKey && e.altKey) || (e.metaKey && e.ctrlKey)) {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            adjustOffset(1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            adjustOffset(-1);
        }
    }
    // 1/2/3 - Dinleme modu
    else if ((key === '1' || key === '2' || key === '3') && !e.altKey && !e.ctrlKey) {
        const listenModeSelect = document.getElementById('listen-mode');
        if (listenModeSelect) {
            if (key === '1') listenModeSelect.value = 'mix';
            else if (key === '2') listenModeSelect.value = 'ref';
            else if (key === '3') listenModeSelect.value = 'clean';
            updateListeningMode();
        }
    }
});
