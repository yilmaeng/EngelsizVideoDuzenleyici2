/**
 * Gemini AI Handler
 * Video karesi analizi için Gemini Vision API kullanır
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFile, execFileSync } = require('child_process');
const nativeAudioPlatform = require('./native-audio-platform');
let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
    try {
        WebSocketImpl = require('ws');
    } catch (_error) {
        WebSocketImpl = null;
    }
}

// API anahtarı depolama yolu
const CONFIG_DIR = path.join(require('os').homedir(), '.korcul-video-editor');
const API_KEY_FILE = path.join(CONFIG_DIR, 'gemini-api-key.enc');
const AI_MODEL_FILE = path.join(CONFIG_DIR, 'ai-model.txt');
const liveTranslateSessions = new Map();

const GEMINI_LIVE_TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';
const GEMINI_LIVE_API_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEMINI_LIVE_CONNECTION_REFRESH_MS = 9.5 * 60 * 1000;
const GEMINI_LIVE_CONNECTION_REFRESH_RETRY_MS = 30 * 1000;

function normalizeGeminiLiveChannel(channel = '') {
    const normalized = String(channel || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return normalized || 'primary';
}

function getGeminiLiveTranslateSessionKey(webContentsId, channel = 'primary') {
    return `${Number(webContentsId)}:${normalizeGeminiLiveChannel(channel)}`;
}

const GEMINI_LIVE_LANGUAGE_MAP = {
    tr: 'tr',
    en: 'en',
    de: 'de',
    fr: 'fr',
    es: 'es',
    ar: 'ar',
    bn: 'bn',
    bg: 'bg',
    ca: 'ca',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    zh: 'zh-CN',
    hr: 'hr',
    cs: 'cs',
    da: 'da',
    nl: 'nl',
    fi: 'fi',
    el: 'el',
    gu: 'gu',
    he: 'he',
    hi: 'hi',
    hu: 'hu',
    id: 'id',
    it: 'it',
    ja: 'ja',
    kn: 'kn',
    ko: 'ko',
    ml: 'ml',
    mr: 'mr',
    no: 'no',
    pl: 'pl',
    pt: 'pt',
    ro: 'ro',
    ru: 'ru',
    sk: 'sk',
    sv: 'sv',
    ta: 'ta',
    te: 'te',
    th: 'th',
    uk: 'uk',
    ur: 'ur',
    vi: 'vi'
};

function normalizeAiModel(model) {
    const trimmedModel = typeof model === 'string' ? model.trim() : '';

    if (!trimmedModel) {
        return 'gemini-2.5-flash';
    }

    // Gemini 2.0 Flash free-tier requests now fail for some users with zero quota.
    // Upgrade stale saved preferences transparently to the recommended model.
    if (trimmedModel === 'gemini-2.0-flash') {
        return 'gemini-2.5-flash';
    }

    return trimmedModel;
}

function normalizeGeminiLiveLanguage(languageCode, fallback = 'tr') {
    const normalized = String(languageCode || '').trim().toLowerCase();
    if (!normalized || normalized === 'auto') {
        return GEMINI_LIVE_LANGUAGE_MAP[fallback] || GEMINI_LIVE_LANGUAGE_MAP.tr;
    }
    return GEMINI_LIVE_LANGUAGE_MAP[normalized] || GEMINI_LIVE_LANGUAGE_MAP[normalized.split(/[-_]/)[0]] || normalized;
}

function createGeminiLiveTranslateSocket(apiKey) {
    if (!WebSocketImpl) {
        throw new Error('gemini_live_translate_websocket_unavailable');
    }
    const url = `${GEMINI_LIVE_API_URL}?key=${encodeURIComponent(apiKey)}`;
    return new WebSocketImpl(url);
}

function getGeminiLiveTranslateSession(webContentsId, channel = 'primary') {
    return liveTranslateSessions.get(getGeminiLiveTranslateSessionKey(webContentsId, channel)) || null;
}

function isGeminiLiveTranslateSessionActive(session) {
    if (!session?.webContents || session.webContents.isDestroyed()) {
        return false;
    }
    return getGeminiLiveTranslateSession(session.webContents.id, session.channel) === session;
}

function getGeminiLiveTranslateSessionsForWebContents(webContentsId) {
    const prefix = `${Number(webContentsId)}:`;
    return Array.from(liveTranslateSessions.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, session]) => ({ key, session }));
}

function sendGeminiLiveTranslateEvent(session, payload) {
    if (!isGeminiLiveTranslateSessionActive(session)) {
        return false;
    }
    try {
        session.webContents.send('gemini-live-translate-event', {
            channel: session.channel || 'primary',
            ...payload
        });
        return true;
    } catch (error) {
        console.warn('Gemini live translate event could not be delivered; closing session:', error?.message || error);
        const webContentsId = Number(session.webContents?.id || 0);
        if (webContentsId > 0) {
            closeGeminiLiveTranslateSession(webContentsId, {
                reason: 'renderer_unavailable',
                channel: session.channel || 'primary'
            }).catch(() => {});
        }
        return false;
    }
}

function getFfmpegBinaryPath() {
    let ffmpegPath = null;
    try {
        ffmpegPath = require('ffmpeg-static');
    } catch (_error) {}
    if (!ffmpegPath) {
        try {
            ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
        } catch (_error) {}
    }
    if (ffmpegPath && ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    return ffmpegPath;
}

function parseGeminiAudioSampleRate(mimeType = '') {
    const match = String(mimeType || '').match(/rate=(\d+)/i);
    return match ? Number(match[1]) || 24000 : 24000;
}

function runFfmpegProcess(args) {
    return new Promise((resolve, reject) => {
        const ffmpegPath = getFfmpegBinaryPath();
        if (!ffmpegPath) {
            reject(new Error('ffmpeg_not_found'));
            return;
        }
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`ffmpeg_exit_${code}: ${stderr.trim().slice(-600)}`));
        });
    });
}

async function createInstantVoiceTranslationMp3({ filePath, entries }) {
    const outputPath = typeof filePath === 'string' ? filePath.trim() : '';
    const audioEntries = Array.isArray(entries) ? entries : [];
    if (!outputPath) {
        throw new Error('output_path_missing');
    }
    if (!audioEntries.length) {
        throw new Error('translation_audio_empty');
    }

    const rawBuffers = audioEntries
        .map((entry) => {
            const audioBase64 = String(entry?.audioBase64 || '').trim();
            if (!audioBase64) return null;
            return Buffer.from(audioBase64, 'base64');
        })
        .filter((buffer) => buffer?.length);
    if (!rawBuffers.length) {
        throw new Error('translation_audio_empty');
    }

    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evd-instant-translation-audio-'));
    const rawPath = path.join(tempDir, 'translation.pcm');
    try {
        fs.writeFileSync(rawPath, Buffer.concat(rawBuffers));
        await runFfmpegProcess([
            '-y',
            '-f', 's16le',
            '-ar', String(parseGeminiAudioSampleRate(audioEntries[0]?.mimeType)),
            '-ac', '1',
            '-i', rawPath,
            '-vn',
            '-codec:a', 'libmp3lame',
            '-b:a', '192k',
            outputPath
        ]);
        return { success: true, outputPath };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_error) {}
    }
}

function buildTimedPcmBuffer(entries = [], sampleRate = 24000, { fadeMs = 0 } = {}) {
    const bytesPerSample = 2;
    const fadeSamples = Math.max(0, Math.round(sampleRate * Math.max(0, Number(fadeMs || 0)) / 1000));
    const sortedEntries = [...entries]
        .map((entry) => ({
            offsetMs: Math.max(0, Number(entry?.offsetMs || 0)),
            buffer: Buffer.from(String(entry?.audioBase64 || '').trim(), 'base64')
        }))
        .filter((entry) => entry.buffer.length)
        .sort((a, b) => a.offsetMs - b.offsetMs);

    if (!sortedEntries.length) {
        return Buffer.alloc(0);
    }

    const totalSamples = sortedEntries.reduce((maxSamples, entry) => {
        const startSample = Math.max(0, Math.round((entry.offsetMs / 1000) * sampleRate));
        const sampleCount = Math.floor(entry.buffer.length / bytesPerSample);
        return Math.max(maxSamples, startSample + sampleCount);
    }, 0);
    if (totalSamples <= 0) {
        return Buffer.alloc(0);
    }

    const mixedSamples = new Int32Array(totalSamples);
    sortedEntries.forEach((entry) => {
        const startSample = Math.max(0, Math.round((entry.offsetMs / 1000) * sampleRate));
        const sampleCount = Math.floor(entry.buffer.length / bytesPerSample);
        const effectiveFadeSamples = fadeSamples > 0
            ? Math.max(1, Math.min(fadeSamples, Math.floor(sampleCount / 2) || 1))
            : 0;
        for (let index = 0; index < sampleCount; index += 1) {
            const fadeInGain = effectiveFadeSamples > 0 ? Math.min(1, (index + 1) / effectiveFadeSamples) : 1;
            const fadeOutGain = effectiveFadeSamples > 0 ? Math.min(1, (sampleCount - index) / effectiveFadeSamples) : 1;
            const gain = effectiveFadeSamples > 0 ? Math.min(fadeInGain, fadeOutGain) : 1;
            mixedSamples[startSample + index] += Math.round(entry.buffer.readInt16LE(index * bytesPerSample) * gain);
        }
    });

    const output = Buffer.alloc(totalSamples * bytesPerSample);
    for (let index = 0; index < totalSamples; index += 1) {
        const sample = Math.max(-32768, Math.min(32767, mixedSamples[index]));
        output.writeInt16LE(sample, index * bytesPerSample);
    }
    return output;
}

async function createInstantVoiceTranslationSessionMp3({ filePath, entries, sourceEntries, mode = 'translation-only' }) {
    const outputPath = typeof filePath === 'string' ? filePath.trim() : '';
    const translationEntries = Array.isArray(entries) ? entries : [];
    const originalEntries = Array.isArray(sourceEntries) ? sourceEntries : [];
    const normalizedMode = ['translation-only', 'translation-foreground', 'original-foreground'].includes(mode)
        ? mode
        : 'translation-only';

    if (!outputPath) {
        throw new Error('output_path_missing');
    }
    if (!translationEntries.length) {
        throw new Error('translation_audio_empty');
    }

    const translationSampleRate = parseGeminiAudioSampleRate(translationEntries[0]?.mimeType);
    const translationBuffer = buildTimedPcmBuffer(translationEntries, translationSampleRate, { fadeMs: 0 });
    if (!translationBuffer.length) {
        throw new Error('translation_audio_empty');
    }

    const os = require('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evd-instant-translation-session-'));
    const translationPath = path.join(tempDir, 'translation.pcm');
    const originalPath = path.join(tempDir, 'original.pcm');
    try {
        fs.writeFileSync(translationPath, translationBuffer);

        if (normalizedMode === 'translation-only') {
            await runFfmpegProcess([
                '-y',
                '-f', 's16le',
                '-ar', String(translationSampleRate),
                '-ac', '1',
                '-i', translationPath,
                '-vn',
                '-codec:a', 'libmp3lame',
                '-b:a', '192k',
                outputPath
            ]);
            return { success: true, outputPath };
        }

        const validOriginalEntries = originalEntries
            .filter((entry) => String(entry?.audioBase64 || '').trim());
        if (!validOriginalEntries.length) {
            throw new Error('original_audio_empty');
        }

        const originalSampleRate = parseGeminiAudioSampleRate(validOriginalEntries[0]?.mimeType);
        const originalBuffer = buildTimedPcmBuffer(validOriginalEntries, originalSampleRate, { fadeMs: 0 });
        if (!originalBuffer.length) {
            throw new Error('original_audio_empty');
        }
        fs.writeFileSync(originalPath, originalBuffer);
        const translationVolume = normalizedMode === 'translation-foreground' ? '1.35' : '0.45';
        const originalVolume = normalizedMode === 'translation-foreground' ? '0.28' : '1.0';
        await runFfmpegProcess([
            '-y',
            '-f', 's16le',
            '-ar', String(originalSampleRate),
            '-ac', '1',
            '-i', originalPath,
            '-f', 's16le',
            '-ar', String(translationSampleRate),
            '-ac', '1',
            '-i', translationPath,
            '-filter_complex', `[0:a]volume=${originalVolume}[orig];[1:a]volume=${translationVolume}[trans];[orig][trans]amix=inputs=2:duration=longest[aout]`,
            '-map', '[aout]',
            '-vn',
            '-codec:a', 'libmp3lame',
            '-b:a', '192k',
            outputPath
        ]);
        return { success: true, outputPath };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_error) {}
    }
}

async function closeGeminiLiveTranslateSession(webContentsId, { reason = 'stop', channel = 'primary' } = {}) {
    const session = getGeminiLiveTranslateSession(webContentsId, channel);
    if (!session) {
        return;
    }
    liveTranslateSessions.delete(getGeminiLiveTranslateSessionKey(webContentsId, channel));
    clearGeminiLiveConnectionRefreshTimer(session);
    stopGeminiLiveNativeAudioCapture(session);
    try {
        session.socket.close(1000, reason);
    } catch (_error) {}
}

async function closeGeminiLiveTranslateSessionsForWebContents(webContentsId, { reason = 'stop' } = {}) {
    const sessions = getGeminiLiveTranslateSessionsForWebContents(webContentsId);
    await Promise.all(sessions.map(({ session }) => closeGeminiLiveTranslateSession(webContentsId, {
        reason,
        channel: session.channel || 'primary'
    })));
}

function resolveNativeAudioHelperPath() {
    return nativeAudioPlatform.resolveNativeAudioHelperPath();
}

function runNativeAudioSessionVolumeCommand({
    targetProcessId = 0,
    targetWindowTitle = '',
    targetProcessName = '',
    targetWindowSourceId = '',
    volume = null
} = {}) {
    return new Promise((resolve) => {
        const helperPath = resolveNativeAudioHelperPath();
        const pid = resolveNativeAudioTargetProcessId(
            targetProcessId,
            targetWindowTitle,
            targetProcessName,
            targetWindowSourceId
        );
        console.log('[InstantVoiceTranslation][SourceVolume] request', JSON.stringify({
            requestedProcessId: Number(targetProcessId || 0),
            resolvedProcessId: pid,
            targetWindowTitle: String(targetWindowTitle || ''),
            targetProcessName: String(targetProcessName || ''),
            targetWindowSourceId: String(targetWindowSourceId || ''),
            volume: Number.isFinite(Number(volume)) ? Number(volume) : null
        }));
        if (!helperPath) {
            console.log('[InstantVoiceTranslation][SourceVolume] result', JSON.stringify({
                success: false,
                error: 'native_audio_helper_missing',
                resolvedProcessId: pid
            }));
            resolve({ success: false, error: 'native_audio_helper_missing' });
            return;
        }
        if (!pid || pid <= 0) {
            console.log('[InstantVoiceTranslation][SourceVolume] result', JSON.stringify({
                success: false,
                error: 'target_process_id_required',
                resolvedProcessId: pid
            }));
            resolve({ success: false, error: 'target_process_id_required' });
            return;
        }
        const args = ['--pid', String(Math.trunc(pid))];
        if (Number.isFinite(Number(volume))) {
            args.push('--session-volume-set', String(Math.max(0, Math.min(1, Number(volume)))));
        } else {
            args.push('--session-volume-get');
        }
        execFile(helperPath, args, { windowsHide: true, timeout: 8000 }, (error, stdout, stderr) => {
            const raw = String(stdout || stderr || '').trim();
            let parsed = null;
            if (raw) {
                try {
                    parsed = JSON.parse(raw.split(/\r?\n/).find((line) => line.trim().startsWith('{')) || raw);
                } catch (_parseError) {}
            }
            if (parsed && typeof parsed === 'object') {
                const result = {
                    targetProcessId: pid,
                    ...parsed
                };
                console.log('[InstantVoiceTranslation][SourceVolume] result', JSON.stringify(result));
                resolve(result);
                return;
            }
            const fallbackResult = {
                success: false,
                targetProcessId: pid,
                error: error?.message || raw || 'audio_session_volume_failed'
            };
            console.log('[InstantVoiceTranslation][SourceVolume] result', JSON.stringify(fallbackResult));
            resolve(fallbackResult);
        });
    });
}

function sendGeminiLivePcmChunk(session, audioBase64, sampleRate) {
    if (!session || session.socket.readyState !== 1 || !audioBase64) {
        return;
    }
    session.socket.send(JSON.stringify({
        realtimeInput: {
            mediaChunks: [{
                mimeType: `audio/pcm;rate=${Number(sampleRate || 48000)}`,
                data: audioBase64
            }]
        }
    }));
}

function clearGeminiLiveConnectionRefreshTimer(session) {
    if (session?.connectionRefreshTimer) {
        clearTimeout(session.connectionRefreshTimer);
        session.connectionRefreshTimer = null;
    }
}

function buildGeminiLiveTranslateSetup(session) {
    const targetCode = normalizeGeminiLiveLanguage(session?.targetLanguage, 'tr');
    return {
        setup: {
            model: GEMINI_LIVE_TRANSLATE_MODEL,
            generationConfig: {
                responseModalities: ['AUDIO'],
                translationConfig: {
                    targetLanguageCode: targetCode,
                    echoTargetLanguage: false
                }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
        }
    };
}

function scheduleGeminiLiveConnectionRefresh(session, delayMs = GEMINI_LIVE_CONNECTION_REFRESH_MS) {
    clearGeminiLiveConnectionRefreshTimer(session);
    if (!isGeminiLiveTranslateSessionActive(session)) {
        return;
    }
    session.connectionRefreshTimer = setTimeout(() => {
        refreshGeminiLiveTranslateConnection(session).catch((error) => {
            sendGeminiLiveTranslateEvent(session, {
                type: 'connection-refresh-failed',
                error: error?.message || String(error)
            });
            scheduleGeminiLiveConnectionRefresh(session, GEMINI_LIVE_CONNECTION_REFRESH_RETRY_MS);
        });
    }, delayMs);
}

function attachGeminiLiveTranslateSocket(session, socket, {
    sessionKey,
    initial = false,
    timeout = null,
    finish = null
} = {}) {
    let settled = false;
    const settle = (result) => {
        if (settled) {
            return;
        }
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
        }
        if (typeof finish === 'function') {
            finish(result);
        }
    };

    socket.addEventListener('open', () => {
        const previousSocket = session.socket;
        session.socket = socket;
        liveTranslateSessions.set(sessionKey, session);
        try {
            socket.send(JSON.stringify(buildGeminiLiveTranslateSetup(session)));
            scheduleGeminiLiveConnectionRefresh(session);
            settle({ success: true });
            if (!initial) {
                sendGeminiLiveTranslateEvent(session, { type: 'connection-refreshed' });
            }
            if (!initial && previousSocket && previousSocket !== socket) {
                try { previousSocket.close(1000, 'scheduled_refresh'); } catch (_error) {}
            }
        } catch (error) {
            if (initial) {
                liveTranslateSessions.delete(sessionKey);
            }
            settle({ success: false, error: error?.message || 'gemini_live_translate_setup_failed' });
            if (!initial) {
                sendGeminiLiveTranslateEvent(session, {
                    type: 'connection-refresh-failed',
                    error: error?.message || 'gemini_live_translate_setup_failed'
                });
            }
        }
    });
    socket.addEventListener('message', (event) => {
        handleGeminiLiveTranslateMessage(session, event.data);
    });
    socket.addEventListener('error', () => {
        if (initial && !settled) {
            liveTranslateSessions.delete(sessionKey);
            settle({ success: false, error: 'gemini_live_translate_socket_error' });
            return;
        }
        if (!initial && !settled) {
            settle({ success: false, error: 'gemini_live_translate_socket_error' });
            sendGeminiLiveTranslateEvent(session, {
                type: 'connection-refresh-failed',
                error: 'gemini_live_translate_socket_error'
            });
            scheduleGeminiLiveConnectionRefresh(session, GEMINI_LIVE_CONNECTION_REFRESH_RETRY_MS);
            return;
        }
        if (session.socket !== socket) {
            return;
        }
        sendGeminiLiveTranslateEvent(session, {
            type: 'error',
            error: 'gemini_live_translate_socket_error'
        });
    });
    socket.addEventListener('close', (event) => {
        const closeCode = Number(event?.code || 0);
        if (initial && !settled) {
            liveTranslateSessions.delete(sessionKey);
            if (closeCode === 1000) {
                settle({ success: true });
                return;
            }
            settle({
                success: false,
                error: `gemini_live_translate_socket_closed${event?.code ? `:${event.code}` : ''}`
            });
            return;
        }
        if (!initial && !settled) {
            settle({
                success: false,
                error: `gemini_live_translate_socket_closed${event?.code ? `:${event.code}` : ''}`
            });
            sendGeminiLiveTranslateEvent(session, {
                type: 'connection-refresh-failed',
                error: `gemini_live_translate_socket_closed${event?.code ? `:${event.code}` : ''}`
            });
            scheduleGeminiLiveConnectionRefresh(session, GEMINI_LIVE_CONNECTION_REFRESH_RETRY_MS);
            return;
        }
        if (session.socket !== socket) {
            return;
        }
        liveTranslateSessions.delete(sessionKey);
        clearGeminiLiveConnectionRefreshTimer(session);
        if (closeCode === 1000) {
            return;
        }
        sendGeminiLiveTranslateEvent(session, {
            type: 'error',
            error: `gemini_live_translate_socket_closed${event?.code ? `:${event.code}` : ''}`
        });
    });
}

async function refreshGeminiLiveTranslateConnection(session) {
    if (!isGeminiLiveTranslateSessionActive(session)) {
        return;
    }
    sendGeminiLiveTranslateEvent(session, { type: 'connection-refreshing' });
    const socket = createGeminiLiveTranslateSocket(session.apiKey);
    const sessionKey = getGeminiLiveTranslateSessionKey(session.webContents.id, session.channel);
    attachGeminiLiveTranslateSocket(session, socket, { sessionKey, initial: false });
}

function floatStereoBufferToPcm16MonoBase64(buffer) {
    const frameCount = Math.floor(buffer.length / 8);
    if (frameCount <= 0) {
        return '';
    }
    const out = Buffer.alloc(frameCount * 2);
    for (let frame = 0; frame < frameCount; frame += 1) {
        const offset = frame * 8;
        const left = buffer.readFloatLE(offset);
        const right = buffer.readFloatLE(offset + 4);
        const sample = Math.max(-1, Math.min(1, ((Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0)) / 2));
        const value = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
        out.writeInt16LE(value, frame * 2);
    }
    return out.toString('base64');
}

function stopGeminiLiveNativeAudioCapture(session) {
    const capture = session?.nativeAudioCapture || session?.nativeMicrophoneCapture;
    if (!capture) {
        return;
    }
    session.nativeAudioCapture = null;
    session.nativeMicrophoneCapture = null;
    try {
        capture.child?.kill();
    } catch (_error) {}
}

function inferProcessNamesFromWindowTitle(title = '', explicitProcessName = '') {
    const normalizedTitle = String(title || '').toLowerCase();
    const explicit = String(explicitProcessName || '').trim();
    if (explicit) {
        return [explicit];
    }
    const mappings = [
        { patterns: ['google chrome', ' - chrome'], names: ['chrome'] },
        { patterns: ['microsoft edge', ' - edge'], names: ['msedge'] },
        { patterns: ['firefox'], names: ['firefox'] },
        { patterns: ['outlook'], names: ['OUTLOOK'] },
        { patterns: ['zoom'], names: ['Zoom', 'CptHost'] },
        { patterns: ['microsoft teams', 'teams'], names: ['msedgewebview2', 'ms-teams', 'Teams'] },
        { patterns: ['cmd.exe', 'command prompt'], names: ['cmd'] },
        { patterns: ['powershell'], names: ['powershell', 'pwsh'] },
        { patterns: ['dosya gezgini', 'file explorer', 'explorer'], names: ['explorer'] },
        { patterns: ['codex'], names: ['Codex'] },
        { patterns: ['potplayer', 'pot player', 'pod player', 'daum'], names: ['PotPlayerMini64', 'PotPlayerMini', 'PotPlayer', 'PotPlayer64'] },
        { patterns: ['vlc'], names: ['vlc'] },
        { patterns: ['media player'], names: ['wmplayer', 'Microsoft.Media.Player'] }
    ];
    const match = mappings.find((entry) => entry.patterns.some((pattern) => normalizedTitle.includes(pattern)));
    return match?.names || [];
}

function parseDesktopSourceWindowHandle(sourceId = '') {
    const match = String(sourceId || '').match(/^window:(\d+):/i);
    const handle = Number(match?.[1] || 0);
    return Number.isFinite(handle) && handle > 0 ? Math.trunc(handle) : 0;
}

function runPowerShellJson(command, timeout = 8000) {
    const stdout = execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout
    });
    return stdout?.trim() ? JSON.parse(stdout.trim()) : null;
}

function resolveProcessIdFromWindowHandle(sourceId = '') {
    const handle = parseDesktopSourceWindowHandle(sourceId);
    if (!handle) {
        return 0;
    }
    try {
        const command = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindowPid {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
'@;
$pidValue = 0;
[void][NativeWindowPid]::GetWindowThreadProcessId([IntPtr]${handle}, [ref]$pidValue);
@{ Id = $pidValue } | ConvertTo-Json -Compress`;
        const parsed = runPowerShellJson(command, 8000);
        const pid = Number(parsed?.Id || 0);
        return Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : 0;
    } catch (_error) {
        return 0;
    }
}

function resolveProcessIdFromWindowTitle(targetWindowTitle = '') {
    const title = String(targetWindowTitle || '').trim();
    if (!title) {
        return 0;
    }
    try {
        const quotedTitle = `'${title.replace(/'/g, "''")}'`;
        const command = `$target=${quotedTitle}; $normalized=$target.Trim().ToLowerInvariant(); Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and (($normalized -eq $_.MainWindowTitle.Trim().ToLowerInvariant()) -or ($normalized.Contains($_.MainWindowTitle.Trim().ToLowerInvariant())) -or ($_.MainWindowTitle.Trim().ToLowerInvariant().Contains($normalized))) } | Sort-Object StartTime | Select-Object -First 1 Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress`;
        const parsed = runPowerShellJson(command, 8000);
        const pid = Number(parsed?.Id || 0);
        return Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : 0;
    } catch (_error) {
        return 0;
    }
}

function resolveProcessIdFromProcessNames(processNames = []) {
    if (!processNames.length) {
        return 0;
    }
    try {
        const quotedNames = processNames.map((name) => `'${String(name).replace(/'/g, "''")}'`).join(',');
        const command = `$names=@(${quotedNames}); $items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName }; foreach ($name in $names) { $match = $items | Where-Object { $_.ProcessName -eq $name } | Sort-Object StartTime -Descending | Select-Object -First 1 Id,ProcessName; if ($match) { $match | ConvertTo-Json -Compress; break; } }`;
        const parsed = runPowerShellJson(command, 8000);
        const pid = Number(parsed?.Id || 0);
        return Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : 0;
    } catch (_error) {
        return 0;
    }
}

function describeProcessId(pid = 0) {
    const processId = Number(pid || 0);
    if (!Number.isFinite(processId) || processId <= 0) {
        return null;
    }
    try {
        const command = `Get-Process -Id ${Math.trunc(processId)} -ErrorAction SilentlyContinue | Select-Object -First 1 Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress`;
        return runPowerShellJson(command, 5000);
    } catch (_error) {
        return null;
    }
}

function resolveNativeAudioTargetProcessId(targetProcessId = 0, targetWindowTitle = '', targetProcessName = '', targetWindowSourceId = '') {
    const inferredProcessNames = inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName);
    const isTeamsWindow = inferredProcessNames.includes('msedgewebview2');
    if (isTeamsWindow) {
        const teamsAudioPid = resolveProcessIdFromProcessNames(inferredProcessNames);
        if (teamsAudioPid > 0) {
            return teamsAudioPid;
        }
    }
    const directPid = Number(targetProcessId || 0);
    if (Number.isFinite(directPid) && directPid > 0) {
        return Math.trunc(directPid);
    }
    const handlePid = resolveProcessIdFromWindowHandle(targetWindowSourceId);
    if (handlePid > 0) {
        return handlePid;
    }
    const titlePid = resolveProcessIdFromWindowTitle(targetWindowTitle);
    if (titlePid > 0) {
        return titlePid;
    }
    return resolveProcessIdFromProcessNames(inferredProcessNames);
}

function isTeamsAudioWindow(targetWindowTitle = '', targetProcessName = '') {
    return inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName).includes('msedgewebview2');
}

function startGeminiLiveNativeAudioCapture(session, captureMode = 'native-microphone', targetProcessId = 0, targetWindowTitle = '', targetProcessName = '', targetWindowSourceId = '', targetBundleId = '', microphoneDeviceId = '') {
    const helperPath = resolveNativeAudioHelperPath();
    if (!helperPath) {
        throw new Error('native_microphone_helper_missing');
    }
    let args = ['--microphone'];
    if (captureMode === 'native-microphone' && microphoneDeviceId) {
        args.push('--microphone-device-id', String(microphoneDeviceId));
    }
    if (process.platform === 'darwin') {
        args = nativeAudioPlatform.buildCaptureArgs({
            captureMode,
            targetProcessId,
            targetBundleId,
            includeSelfExclusion: captureMode === 'native-system-audio'
        });
    } else if (captureMode === 'native-system-audio') {
        args = ['--output-loopback'];
    } else if (captureMode === 'native-window-audio') {
        const pid = resolveNativeAudioTargetProcessId(targetProcessId, targetWindowTitle, targetProcessName, targetWindowSourceId);
        const useOutputLoopbackForTeams = isTeamsAudioWindow(targetWindowTitle, targetProcessName);
        const resolvedProcess = describeProcessId(pid);
        console.info('[GeminiLiveTranslate] native window audio target', {
            requestedProcessId: Number(targetProcessId || 0),
            resolvedProcessId: pid,
            targetWindowTitle: String(targetWindowTitle || ''),
            targetProcessName: String(targetProcessName || ''),
            targetWindowSourceId: String(targetWindowSourceId || ''),
            inferredProcessNames: inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName),
            resolvedProcess,
            useOutputLoopbackForTeams
        });
        sendGeminiLiveTranslateEvent(session, {
            type: 'diagnostic',
            message: 'native_window_audio_target_resolved',
            targetProcessId: Number(targetProcessId || 0),
            resolvedProcessId: pid,
            targetWindowTitle: String(targetWindowTitle || ''),
            targetProcessName: String(targetProcessName || ''),
            targetWindowSourceId: String(targetWindowSourceId || ''),
            inferredProcessNames: inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName),
            useOutputLoopbackForTeams
        });
        if (useOutputLoopbackForTeams) {
            args = ['--output-loopback'];
        } else {
        if (!Number.isFinite(pid) || pid <= 0) {
            throw new Error('target_process_id_required');
        }
        args = ['--pid', String(Math.trunc(pid)), '--include-tree'];
        }
    }
    console.info('[GeminiLiveTranslate] native audio capture start', {
        captureMode,
        args
    });
    const capture = {
        child: spawn(helperPath, args, { windowsHide: true }),
        remainder: Buffer.alloc(0),
        sampleRate: 48000,
        sentChunks: 0,
        captureMode
    };
    session.nativeAudioCapture = capture;
    session.nativeMicrophoneCapture = capture;
    capture.child.stdout.on('data', (chunk) => {
        if (!chunk?.length || !getGeminiLiveTranslateSession(session.webContents.id, session.channel)) {
            return;
        }
        let input = capture.remainder.length ? Buffer.concat([capture.remainder, chunk]) : chunk;
        const alignedLength = input.length - (input.length % 8);
        if (alignedLength <= 0) {
            capture.remainder = input;
            return;
        }
        capture.remainder = alignedLength < input.length ? input.subarray(alignedLength) : Buffer.alloc(0);
        const audioBase64 = floatStereoBufferToPcm16MonoBase64(input.subarray(0, alignedLength));
        if (!audioBase64) {
            return;
        }
        try {
            sendGeminiLivePcmChunk(session, audioBase64, capture.sampleRate);
            sendGeminiLiveTranslateEvent(session, {
                type: 'source-audio',
                mimeType: `audio/pcm;rate=${capture.sampleRate}`,
                audioBase64
            });
            capture.sentChunks += 1;
            if (capture.sentChunks <= 5 || capture.sentChunks % 25 === 0) {
                sendGeminiLiveTranslateEvent(session, {
                    type: 'diagnostic',
                    message: `${capture.captureMode}_chunk_sent:${capture.sentChunks}`
                });
            }
        } catch (_error) {}
    });
    capture.child.stderr.on('data', (chunk) => {
        String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
            try {
                const payload = JSON.parse(line);
                if (payload?.sampleRate) {
                    capture.sampleRate = Number(payload.sampleRate) || capture.sampleRate;
                }
                console.info('[GeminiLiveTranslate] native audio helper', payload);
                sendGeminiLiveTranslateEvent(session, {
                    type: 'diagnostic',
                    message: payload?.diagnostic || 'native_microphone_helper',
                    ...payload
                });
            } catch (_error) {
                sendGeminiLiveTranslateEvent(session, {
                    type: 'diagnostic',
                    message: line
                });
            }
        });
    });
    capture.child.on('exit', (code, signal) => {
        if (session.nativeAudioCapture === capture || session.nativeMicrophoneCapture === capture) {
            session.nativeAudioCapture = null;
            session.nativeMicrophoneCapture = null;
            sendGeminiLiveTranslateEvent(session, {
                type: 'error',
                error: `native_microphone_helper_exited:${code ?? signal ?? 'unknown'}`
            });
        }
    });
    capture.child.on('error', (error) => {
        sendGeminiLiveTranslateEvent(session, {
            type: 'error',
            error: error?.message || 'native_microphone_helper_error'
        });
    });
}

function extractGeminiLiveText(value) {
    if (!value) {
        return '';
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        return value.map(extractGeminiLiveText).filter(Boolean).join(' ').trim();
    }
    if (typeof value === 'object') {
        if (typeof value.text === 'string') {
            return value.text.trim();
        }
        if (Array.isArray(value.parts)) {
            return value.parts.map(extractGeminiLiveText).filter(Boolean).join(' ').trim();
        }
    }
    return '';
}

function extractGeminiLiveAudioChunks(serverContent = {}) {
    const modelTurn = serverContent.modelTurn || serverContent.model_turn || null;
    const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
    return parts
        .map((part) => part?.inlineData || part?.inline_data || null)
        .filter((inlineData) => inlineData && String(inlineData.data || '').trim())
        .map((inlineData) => ({
            mimeType: String(inlineData.mimeType || inlineData.mime_type || 'audio/pcm;rate=24000'),
            audioBase64: String(inlineData.data || '').trim()
        }));
}

function emitGeminiLivePartial(session) {
    const transcript = String(session.currentInputTranscript || '').trim();
    const translatedText = String(session.currentOutputTranscript || '').trim();
    if (!transcript && !translatedText) {
        return;
    }
    sendGeminiLiveTranslateEvent(session, {
        type: 'delta',
        transcript,
        translatedText
    });
}

function emitGeminiLiveCompleted(session) {
    const transcript = String(session.currentInputTranscript || '').trim();
    const translatedText = String(session.currentOutputTranscript || '').trim();
    if (!transcript && !translatedText) {
        return;
    }
    sendGeminiLiveTranslateEvent(session, {
        type: 'completed',
        transcript,
        translatedText
    });
    session.currentInputTranscript = '';
    session.currentOutputTranscript = '';
}

function handleGeminiLiveTranslateMessage(session, rawData) {
    if (!isGeminiLiveTranslateSessionActive(session)) {
        return;
    }
    let payload = null;
    try {
        payload = JSON.parse(String(rawData || ''));
    } catch (_error) {
        return;
    }
    if (payload.setupComplete) {
        sendGeminiLiveTranslateEvent(session, { type: 'ready' });
        return;
    }
    if (payload.error) {
        const message = payload.error?.message || payload.error || 'gemini_live_translate_error';
        sendGeminiLiveTranslateEvent(session, { type: 'error', error: message });
        return;
    }
    const serverContent = payload.serverContent || payload.server_content || null;
    if (!serverContent) {
        return;
    }
    const inputTranscript = extractGeminiLiveText(serverContent.inputTranscription || serverContent.input_transcription);
    const outputTranscript = extractGeminiLiveText(serverContent.outputTranscription || serverContent.output_transcription);
    if (inputTranscript) {
        session.currentInputTranscript = inputTranscript;
    }
    if (outputTranscript) {
        session.currentOutputTranscript = outputTranscript;
    }
    const audioChunks = extractGeminiLiveAudioChunks(serverContent);
    audioChunks.forEach((chunk) => {
        sendGeminiLiveTranslateEvent(session, {
            type: 'audio',
            ...chunk,
            transcript: String(session.currentInputTranscript || '').trim(),
            translatedText: String(session.currentOutputTranscript || '').trim(),
            sourceLanguage: String(session.sourceLanguage || '').trim(),
            targetLanguage: String(session.targetLanguage || '').trim()
        });
    });
    if (inputTranscript || outputTranscript) {
        emitGeminiLivePartial(session);
    }
    if (serverContent.turnComplete || serverContent.turn_complete) {
        emitGeminiLiveCompleted(session);
    }
}

async function createGeminiLiveTranslateSession({ webContents, apiKey, sourceLanguage = 'auto', targetLanguage = 'tr', captureMode = '', channel = 'primary' }) {
    if (!apiKey) {
        throw new Error('gemini_api_key_missing');
    }
    const webContentsId = Number(webContents.id);
    const normalizedChannel = normalizeGeminiLiveChannel(channel);
    const sessionKey = getGeminiLiveTranslateSessionKey(webContentsId, normalizedChannel);
    await closeGeminiLiveTranslateSession(webContentsId, { reason: 'replace', channel: normalizedChannel });
    const socket = createGeminiLiveTranslateSocket(apiKey);
    const session = {
        webContents,
        apiKey,
        socket,
        channel: normalizedChannel,
        sourceLanguage,
        targetLanguage,
        captureMode,
        nativeAudioCapture: null,
        nativeMicrophoneCapture: null,
        connectionRefreshTimer: null,
        currentInputTranscript: '',
        currentOutputTranscript: ''
    };
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };
        const timeout = setTimeout(() => {
            liveTranslateSessions.delete(sessionKey);
            try { socket.close(); } catch (_error) {}
            finish({ success: false, error: 'gemini_live_translate_start_timeout' });
        }, 12000);
        attachGeminiLiveTranslateSocket(session, socket, {
            sessionKey,
            initial: true,
            timeout,
            finish
        });
        webContents.once('destroyed', () => {
            closeGeminiLiveTranslateSessionsForWebContents(webContentsId, { reason: 'window_destroyed' }).catch(() => {});
        });
    });
}

/**
 * API anahtarını kaydet (basit obfuscation)
 */
function saveApiKey(apiKey) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    // Basit base64 encoding (gerçek şifreleme için electron-store kullanılabilir)
    const encoded = Buffer.from(apiKey).toString('base64');
    fs.writeFileSync(API_KEY_FILE, encoded, 'utf8');
}

/**
 * AI modelini kaydet
 */
function saveAiModel(model) {
    const normalizedModel = normalizeAiModel(model);
    fs.writeFileSync(AI_MODEL_FILE, normalizedModel, 'utf8');
}

/**
 * AI modelini oku
 */
function getAiModel() {
    if (!fs.existsSync(AI_MODEL_FILE)) {
        return 'gemini-2.5-flash';
    }

    const savedModel = fs.readFileSync(AI_MODEL_FILE, 'utf8');
    const normalizedModel = normalizeAiModel(savedModel);

    if (normalizedModel !== savedModel) {
        saveAiModel(normalizedModel);
    }

    return normalizedModel;
}

/**
 * API anahtarını oku
 */
function getApiKey() {
    if (!fs.existsSync(API_KEY_FILE)) {
        return null;
    }
    try {
        const encoded = fs.readFileSync(API_KEY_FILE, 'utf8');
        return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
        console.error('API anahtarı okunamadı:', error);
        return null;
    }
}

/**
 * Gemini File API'ye dosya yükle
 */
async function uploadToGemini(apiKey, filePath, mimeType) {
    const fileSize = fs.statSync(filePath).size;

    // 1. Adım: Resumeable upload başlat
    const initialUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const initialOptions = {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': fileSize,
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        }
    };

    const uploadUrl = await new Promise((resolve, reject) => {
        const req = https.request(initialUrl, initialOptions, (res) => {
            const uploadUri = res.headers['x-goog-upload-url'];
            if (uploadUri) resolve(uploadUri);
            else reject(new Error('Upload URL alınamadı. HTTP: ' + res.statusCode));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ file: { display_name: path.basename(filePath) } }));
        req.end();
    });

    // 2. Adım: Dosya içeriğini yükle
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const uploadOptions = {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Offset': 0,
                'X-Goog-Upload-Command': 'upload, finalize',
                'Content-Length': fileSize
            }
        };

        const req = https.request(uploadUrl, uploadOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.file && response.file.uri) resolve(response.file);
                    else reject(new Error('Yükleme yanıtı geçersiz: ' + data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        fileStream.pipe(req);
    });
}

/**
 * Dosyanın işlenmesini bekle (ACTIVE olana kadar)
 */
async function waitForFileActive(apiKey, fileUri) {
    const checkUrl = `${fileUri}?key=${apiKey}`;
    let attempts = 0;
    while (attempts < 10) {
        const state = await new Promise((resolve, reject) => {
            https.get(checkUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.state);
                    } catch (e) { resolve('ERROR'); }
                });
            }).on('error', () => resolve('ERROR'));
        });

        if (state === 'ACTIVE') return true;
        if (state === 'FAILED') throw new Error('Dosya işleme başarısız oldu.');

        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error('Dosya işleme zaman aşımına uğradı.');
}

/**
 * Gemini Vision API isteği gönder
 * @param {string} model - Kullanılacak model (gemini-2.5-flash, gemini-1.5-flash, vs.)
 */
async function sendGeminiRequest(apiKey, model, imageBase64, prompt, history = [], systemInstruction = '') {
    return new Promise((resolve, reject) => {
        const modelName = normalizeAiModel(model);

        console.log(`Gemini İsteği Başlıyor - Kullanılan Model: ${modelName}`);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        // İstek gövdesi hazırla
        const contents = [];

        // Konuşma geçmişi
        history.forEach(msg => {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        });

        // Mevcut istek (görsel + metin)
        const parts = [];

        // Görsel ekle (varsa)
        // Görsel ekle (varsa)
        if (imageBase64) {
            if (Array.isArray(imageBase64)) {
                // Array of images
                imageBase64.forEach(img => {
                    const mime = img.mimeType || 'image/jpeg';
                    const data = img.data || img; // Handle string or object
                    parts.push({
                        inline_data: {
                            mime_type: mime,
                            data: data
                        }
                    });
                });
            } else {
                // Single image
                parts.push({
                    inline_data: {
                        mime_type: 'image/jpeg',
                        data: imageBase64
                    }
                });
            }
        }

        // Metin ekle
        parts.push({ text: prompt });

        contents.push({
            role: 'user',
            parts: parts
        });

        const requestPayload = {
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192
            }
        };

        if (systemInstruction) {
            requestPayload.systemInstruction = {
                parts: [{ text: systemInstruction }]
            };
        }

        const requestBody = JSON.stringify(requestPayload);

        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);

                    if (response.error) {
                        reject(new Error(response.error.message || 'API hatası'));
                        return;
                    }

                    if (response.candidates && response.candidates[0] &&
                        response.candidates[0].content &&
                        response.candidates[0].content.parts) {
                        const text = response.candidates[0].content.parts
                            .map(p => p.text)
                            .join('');
                        resolve(text);
                    } else {
                        reject(new Error('Geçersiz API yanıtı'));
                    }
                } catch (error) {
                    reject(new Error('API yanıtı işlenemedi: ' + error.message));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error('Bağlantı hatası: ' + error.message));
        });

        req.write(requestBody);
        req.end();
    });
}

function isRetryableGeminiError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('high demand')
        || message.includes('try again later')
        || message.includes('rate limit')
        || message.includes('resource exhausted')
        || message.includes('temporarily unavailable')
        || message.includes('unavailable')
        || message.includes('429')
        || message.includes('503');
}

async function sendGeminiRequestWithRetry(apiKey, model, imageBase64, prompt, history = [], systemInstruction = '', maxRetries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await sendGeminiRequest(apiKey, model, imageBase64, prompt, history, systemInstruction);
        } catch (error) {
            lastError = error;

            if (attempt === maxRetries || !isRetryableGeminiError(error)) {
                throw error;
            }

            const waitMs = 1200 * (attempt + 1);
            console.warn(`Gemini geçici hata nedeniyle tekrar deneniyor (${attempt + 1}/${maxRetries}):`, error.message);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }

    throw lastError || new Error('Gemini isteği tamamlanamadı.');
}

/**
 * IPC handler'larını kur
 */
function setupGeminiHandlers(mainWindow) {
    const ffmpegHandler = require('./ffmpeg-handler');

    // API anahtarını kaydet
    ipcMain.handle('save-gemini-api-key', async (event, { apiKey, model }) => {
        try {
            if (apiKey) saveApiKey(apiKey);
            if (model) saveAiModel(model);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // API verilerini al (Anahtar ve Model)
    ipcMain.handle('get-gemini-api-data', async () => {
        return {
            apiKey: getApiKey(),
            model: getAiModel()
        };
    });

    // Sadece API anahtarını al (frontend tarafından kullanılıyor)
    ipcMain.handle('get-gemini-api-key', async () => {
        return getApiKey();
    });

    ipcMain.handle('gemini-live-translate-start', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            if (!apiKey) {
                return { success: false, error: 'gemini_api_key_missing' };
            }
            const result = await createGeminiLiveTranslateSession({
                webContents: event.sender,
                apiKey,
                sourceLanguage: payload.sourceLanguage,
                targetLanguage: payload.targetLanguage,
                captureMode: payload.captureMode,
                channel: payload.channel
            });
            if (result?.success && ['native-microphone', 'native-system-audio', 'native-window-audio'].includes(payload.captureMode)) {
                const session = getGeminiLiveTranslateSession(event.sender.id, payload.channel);
                startGeminiLiveNativeAudioCapture(
                    session,
                    payload.captureMode,
                    payload.targetProcessId,
                    payload.targetWindowTitle,
                    payload.targetProcessName,
                    payload.targetWindowSourceId,
                    payload.targetBundleId,
                    payload.microphoneDeviceId
                );
            }
            return result;
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('gemini-live-translate-stop', async (event) => {
        try {
            await closeGeminiLiveTranslateSessionsForWebContents(event.sender.id, { reason: 'client_stop' });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('gemini-live-translate-stop-channel', async (event, payload = {}) => {
        try {
            await closeGeminiLiveTranslateSession(event.sender.id, {
                reason: 'client_stop',
                channel: payload.channel
            });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('instant-voice-translation-audio-session-volume', async (_event, payload = {}) => {
        try {
            return await runNativeAudioSessionVolumeCommand({
                targetProcessId: payload.targetProcessId,
                targetWindowTitle: payload.targetWindowTitle,
                targetProcessName: payload.targetProcessName,
                targetWindowSourceId: payload.targetWindowSourceId,
                volume: payload.volume
            });
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.on('gemini-live-translate-audio-chunk', (event, payload = {}) => {
        const session = getGeminiLiveTranslateSession(event.sender.id, payload.channel);
        if (!session || session.socket.readyState !== 1) {
            return;
        }
        const audio = String(payload.audioBase64 || '').trim();
        if (!audio) {
            return;
        }
        try {
            sendGeminiLivePcmChunk(session, audio, payload.sampleRate || 16000);
        } catch (_error) {}
    });

    ipcMain.handle('save-instant-voice-translation-audio', async (_event, payload = {}) => {
        try {
            return await createInstantVoiceTranslationSessionMp3(payload);
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    // Video karesini base64 olarak çıkar
    ipcMain.handle('extract-frame-base64', async (event, { time, videoPath }) => {
        const os = require('os');
        const tempFile = path.join(os.tmpdir(), `frame_${Date.now()}.jpg`);

        try {
            if (!videoPath) {
                throw new Error('Video yolu parametresi eksik.');
            }

            // Kareyi çıkar (Resize to 800px width to reduce payload and avoid quota issues)
            // Note: We use a custom ffmpeg command here to ensure resizing without affecting shared extractFrame
            await new Promise((resolve, reject) => {
                const ffmpeg = require('fluent-ffmpeg');
                ffmpeg(videoPath)
                    .seekInput(time)
                    .outputOptions(['-vframes 1', '-vf scale=800:-1']) // Resize to 800w
                    .output(tempFile)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            // Base64'e çevir
            const imageBuffer = fs.readFileSync(tempFile);
            const base64 = imageBuffer.toString('base64');

            // Geçici dosyayı sil
            fs.unlinkSync(tempFile);

            return base64;
        } catch (error) {
            // Geçici dosyayı temizle
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            throw error;
        }
    });

    // Seçimi betimle (Video klip analizi)
    ipcMain.handle('gemini-describe-selection', async (event, { apiKey, model, startTime, endTime, prompt, systemInstruction }) => {
        const tempVideoFile = path.join(require('os').tmpdir(), `ai_clip_${Date.now()}.mp4`);
        let fileData = null;

        try {
            // Ana pencereden video yolunu al
            const videoPath = await new Promise((resolve) => {
                mainWindow.webContents.send('get-current-video-path');
                ipcMain.once('current-video-path-response', (event, path) => resolve(path));
            });

            if (!videoPath) throw new Error('Video yolu alınamadı');

            await ffmpegHandler.cutVideoClip(videoPath, tempVideoFile, startTime, endTime);

            // Dosyanın oluştuğunu kontrol et
            if (!fs.existsSync(tempVideoFile)) {
                throw new Error('Video klibi oluşturulamadı!');
            }

            // Gemini File API'ye yükle
            fileData = await uploadToGemini(apiKey, tempVideoFile, 'video/mp4');

            // Dosya işlemesini bekle
            await waitForFileActive(apiKey, fileData.uri);
            const contents = [{
                role: 'user',
                parts: [
                    { file_data: { mime_type: 'video/mp4', file_uri: fileData.uri } },
                    { text: prompt }
                ]
            }];

            const aiResponse = await sendGeminiRequestBatchWithRetry(apiKey, model || 'gemini-2.5-flash', contents, systemInstruction);

            // Temizlik
            if (fs.existsSync(tempVideoFile)) fs.unlinkSync(tempVideoFile);

            return aiResponse;
        } catch (error) {
            if (fs.existsSync(tempVideoFile)) fs.unlinkSync(tempVideoFile);
            console.error('AI Video Analiz Hatası:', error);
            throw error;
        }
    });

    // Gemini Vision isteği
    ipcMain.handle('gemini-vision-request', async (event, { apiKey, model, imageBase64, prompt, history, systemInstruction }) => {
        try {
            const text = await sendGeminiRequestWithRetry(apiKey, model, imageBase64, prompt, history, systemInstruction);
            return { success: true, text: text };
        } catch (error) {
            console.error('Gemini Vision Hatası:', error);
            // Return error object instead of throwing, so renderer can display it nicely
            return { success: false, error: error.message };
        }
    });
}

/**
 * Grup içerikli Gemini isteği gönder
 */
async function sendGeminiRequestBatch(apiKey, model, contents, systemInstruction = '') {
    return new Promise((resolve, reject) => {
        const modelName = normalizeAiModel(model);
        console.log(`Gemini Batch İsteği Başlıyor - Kullanılan Model: ${modelName}`);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const requestPayload = {
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192
            }
        };

        if (systemInstruction) {
            requestPayload.systemInstruction = {
                parts: [{ text: systemInstruction }]
            };
        }

        const requestBody = JSON.stringify(requestPayload);

        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.error) {
                        reject(new Error(response.error.message || 'API hatası'));
                        return;
                    }
                    if (response.candidates && response.candidates[0]?.content?.parts) {
                        resolve(response.candidates[0].content.parts.map(p => p.text).join(''));
                    } else {
                        reject(new Error('Geçersiz API yanıtı'));
                    }
                } catch (error) {
                    reject(new Error('API yanıtı işlenemedi: ' + error.message));
                }
            });
        });

        req.on('error', error => reject(new Error('Bağlantı hatası: ' + error.message)));
        req.write(requestBody);
        req.end();
    });
}

async function sendGeminiRequestBatchWithRetry(apiKey, model, contents, systemInstruction = '', maxRetries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await sendGeminiRequestBatch(apiKey, model, contents, systemInstruction);
        } catch (error) {
            lastError = error;

            if (attempt === maxRetries || !isRetryableGeminiError(error)) {
                throw error;
            }

            const waitMs = 1200 * (attempt + 1);
            console.warn(`Gemini batch isteği tekrar deneniyor (${attempt + 1}/${maxRetries}):`, error.message);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }

    throw lastError || new Error('Gemini batch isteği tamamlanamadı.');
}

module.exports = {
    setupGeminiHandlers,
    saveApiKey,
    getApiKey,
    getAiModel
};
