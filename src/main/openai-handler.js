const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const nativeAudioPlatform = require('./native-audio-platform');

let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
    try {
        WebSocketImpl = require('ws');
    } catch (_error) {
        WebSocketImpl = null;
    }
}

function createOpenAiRealtimeSocket(url, apiKey) {
    if (!WebSocketImpl) {
        throw new Error('openai_realtime_websocket_unavailable');
    }
    const isNodeWs = typeof WebSocketImpl === 'function' && /ws/i.test(String(WebSocketImpl.name || ''));
    if (isNodeWs) {
        return new WebSocketImpl(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
    }
    return new WebSocketImpl(url, [
        'realtime',
        `openai-insecure-api-key.${apiKey}`
    ]);
}

const CONFIG_DIR = path.join(require('os').homedir(), '.korcul-video-editor');
const API_KEY_FILE = path.join(CONFIG_DIR, 'openai-api-key.enc');
const realtimeTranslationSessions = new Map();
const nativeRealtimeTranslateSessions = new Map();

function saveApiKey(apiKey) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const encoded = Buffer.from(apiKey).toString('base64');
    fs.writeFileSync(API_KEY_FILE, encoded, 'utf8');
}

function getApiKey() {
    if (!fs.existsSync(API_KEY_FILE)) {
        return null;
    }

    try {
        const encoded = fs.readFileSync(API_KEY_FILE, 'utf8');
        return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
        console.error('OpenAI API anahtarı okunamadı:', error);
        return null;
    }
}

async function transcribeAudioChunk({ apiKey, audioBase64, mimeType, language }) {
    if (!apiKey) {
        throw new Error('openai_api_key_missing');
    }
    if (!audioBase64) {
        throw new Error('audio_chunk_missing');
    }

    const buffer = Buffer.from(String(audioBase64), 'base64');
    const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
    const form = new FormData();
    form.append('file', blob, 'live-translation.webm');
    form.append('model', 'gpt-4o-transcribe');
    form.append('response_format', 'json');
    if (language && language !== 'auto') {
        form.append('language', String(language));
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`
        },
        body: form
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || `openai_transcription_http_${response.status}`);
    }

    return String(payload?.text || '').trim();
}

function readResponseOutputText(payload) {
    if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text.trim();
    }
    const outputs = Array.isArray(payload?.output) ? payload.output : [];
    const textParts = [];
    outputs.forEach((item) => {
        const content = Array.isArray(item?.content) ? item.content : [];
        content.forEach((part) => {
            if (typeof part?.text === 'string' && part.text.trim()) {
                textParts.push(part.text.trim());
            }
            if (typeof part?.output_text === 'string' && part.output_text.trim()) {
                textParts.push(part.output_text.trim());
            }
        });
    });
    return textParts.join('\n').trim();
}

async function translateTranscriptText({ apiKey, transcript, sourceLanguage, targetLanguage }) {
    if (!apiKey) {
        throw new Error('openai_api_key_missing');
    }
    if (!transcript) {
        return '';
    }

    const sourceLabel = sourceLanguage && sourceLanguage !== 'auto'
        ? String(sourceLanguage)
        : 'auto-detect';
    const targetLabel = String(targetLanguage || 'tr');

    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-5-mini',
            instructions: `Translate the provided spoken transcript from ${sourceLabel} into ${targetLabel}. Return only the translated text. Keep it concise and preserve meaning without adding commentary.`,
            input: transcript
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || `openai_translation_http_${response.status}`);
    }

    return readResponseOutputText(payload);
}

async function synthesizeTranslatedSpeech({ apiKey, text, targetLanguage, voice = 'alloy' }) {
    if (!apiKey) {
        throw new Error('openai_api_key_missing');
    }
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        throw new Error('translation_speech_text_missing');
    }

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini-tts',
            voice,
            input: normalizedText,
            response_format: 'mp3',
            instructions: `Speak naturally in ${String(targetLanguage || 'tr')} and keep the delivery concise for live translated dubbing.`
        })
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error?.message || `openai_tts_http_${response.status}`);
    }

    const contentType = String(response.headers.get('content-type') || 'audio/mpeg').trim() || 'audio/mpeg';
    const arrayBuffer = await response.arrayBuffer();
    return {
        audioBase64: Buffer.from(arrayBuffer).toString('base64'),
        mimeType: contentType
    };
}

async function describeImageWithOpenAi({ apiKey, imageBase64, prompt, systemInstruction = '', model = 'gpt-4.1-mini' }) {
    if (!apiKey) {
        throw new Error('openai_api_key_missing');
    }
    const normalizedImage = String(imageBase64 || '').trim();
    if (!normalizedImage) {
        throw new Error('openai_image_missing');
    }
    const dataUrl = normalizedImage.startsWith('data:')
        ? normalizedImage
        : `data:image/jpeg;base64,${normalizedImage}`;
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: String(model || 'gpt-4.1-mini'),
            instructions: systemInstruction || undefined,
            input: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: String(prompt || '').trim()
                        },
                        {
                            type: 'input_image',
                            image_url: dataUrl
                        }
                    ]
                }
            ]
        })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error?.message || `openai_vision_http_${response.status}`);
    }
    return readResponseOutputText(payload);
}

function getRealtimeTranslationSession(webContentsId) {
    return realtimeTranslationSessions.get(Number(webContentsId)) || null;
}

function sendRealtimeTranslationEvent(session, payload) {
    if (!session?.webContents || session.webContents.isDestroyed()) {
        return;
    }
    session.webContents.send('openai-realtime-translation-event', payload);
}

function getNativeRealtimeTranslateSessionKey(webContentsId, channel = 'primary') {
    return `${Number(webContentsId)}:${String(channel || 'primary')}`;
}

function getNativeRealtimeTranslateSession(webContentsId, channel = 'primary') {
    return nativeRealtimeTranslateSessions.get(getNativeRealtimeTranslateSessionKey(webContentsId, channel)) || null;
}

function sendNativeRealtimeTranslateEvent(session, payload) {
    if (!session?.webContents || session.webContents.isDestroyed()) {
        return;
    }
    session.webContents.send('openai-live-translate-event', {
        channel: session.channel || 'primary',
        ...payload
    });
}

function resolveNativeAudioHelperPath() {
    return nativeAudioPlatform.resolveNativeAudioHelperPath();
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
        { patterns: ['skype'], names: ['Skype'] },
        { patterns: ['whatsapp'], names: ['WhatsApp'] },
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

function resolveNativeAudioTargetProcessId(targetProcessId = 0, targetWindowTitle = '', targetProcessName = '', targetWindowSourceId = '') {
    const inferredProcessNames = inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName);
    if (inferredProcessNames.includes('msedgewebview2')) {
        const teamsAudioPid = resolveProcessIdFromProcessNames(inferredProcessNames);
        if (teamsAudioPid > 0) {
            return teamsAudioPid;
        }
    }
    const directPid = Number(targetProcessId || 0);
    if (Number.isFinite(directPid) && directPid > 0) {
        return Math.trunc(directPid);
    }
    return resolveProcessIdFromWindowHandle(targetWindowSourceId)
        || resolveProcessIdFromWindowTitle(targetWindowTitle)
        || resolveProcessIdFromProcessNames(inferredProcessNames);
}

function isTeamsAudioWindow(targetWindowTitle = '', targetProcessName = '') {
    return inferProcessNamesFromWindowTitle(targetWindowTitle, targetProcessName).includes('msedgewebview2');
}

function resampleFloatStereoToPcm16MonoBase64(buffer, inputSampleRate = 48000, outputSampleRate = 24000) {
    const inputFrames = Math.floor(buffer.length / 8);
    if (inputFrames <= 0) {
        return '';
    }
    const inRate = Math.max(1, Number(inputSampleRate || 48000));
    const outRate = Math.max(1, Number(outputSampleRate || 24000));
    const outputFrames = Math.max(1, Math.floor(inputFrames * outRate / inRate));
    const out = Buffer.alloc(outputFrames * 2);
    for (let frame = 0; frame < outputFrames; frame += 1) {
        const inputFrame = Math.min(inputFrames - 1, Math.floor(frame * inRate / outRate));
        const offset = inputFrame * 8;
        const left = buffer.readFloatLE(offset);
        const right = buffer.readFloatLE(offset + 4);
        const sample = Math.max(-1, Math.min(1, ((Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0)) / 2));
        const value = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
        out.writeInt16LE(value, frame * 2);
    }
    return out.toString('base64');
}

function stopNativeRealtimeTranslateCapture(session) {
    const capture = session?.nativeAudioCapture;
    if (!capture) {
        return;
    }
    session.nativeAudioCapture = null;
    try {
        capture.child?.kill();
    } catch (_error) {}
}

function appendNativeRealtimeTranslateAudio(session, audioBase64) {
    if (!session || session.socket.readyState !== 1 || !audioBase64) {
        return;
    }
    session.socket.send(JSON.stringify({
        type: 'session.input_audio_buffer.append',
        audio: audioBase64
    }));
}

function startNativeRealtimeTranslateCapture(session, captureMode = 'native-microphone', targetProcessId = 0, targetWindowTitle = '', targetProcessName = '', targetWindowSourceId = '', targetBundleId = '', microphoneDeviceId = '') {
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
        const useOutputLoopbackForTeams = isTeamsAudioWindow(targetWindowTitle, targetProcessName);
        if (useOutputLoopbackForTeams) {
            args = ['--output-loopback'];
        } else {
            const pid = resolveNativeAudioTargetProcessId(targetProcessId, targetWindowTitle, targetProcessName, targetWindowSourceId);
            if (!Number.isFinite(pid) || pid <= 0) {
                throw new Error('target_process_id_required');
            }
            args = ['--pid', String(Math.trunc(pid)), '--include-tree'];
        }
    }
    const capture = {
        child: spawn(helperPath, args, { windowsHide: true }),
        remainder: Buffer.alloc(0),
        sampleRate: 48000,
        sentChunks: 0
    };
    session.nativeAudioCapture = capture;
    capture.child.stdout.on('data', (chunk) => {
        if (!chunk?.length || !getNativeRealtimeTranslateSession(session.webContents.id, session.channel)) {
            return;
        }
        let input = capture.remainder.length ? Buffer.concat([capture.remainder, chunk]) : chunk;
        const alignedLength = input.length - (input.length % 8);
        if (alignedLength <= 0) {
            capture.remainder = input;
            return;
        }
        capture.remainder = alignedLength < input.length ? input.subarray(alignedLength) : Buffer.alloc(0);
        const sourceChunk = input.subarray(0, alignedLength);
        const audioBase64 = resampleFloatStereoToPcm16MonoBase64(sourceChunk, capture.sampleRate, 24000);
        if (!audioBase64) {
            return;
        }
        try {
            appendNativeRealtimeTranslateAudio(session, audioBase64);
            sendNativeRealtimeTranslateEvent(session, {
                type: 'source-audio',
                mimeType: 'audio/pcm;rate=24000',
                audioBase64
            });
            capture.sentChunks += 1;
        } catch (_error) {}
    });
    capture.child.stderr.on('data', (chunk) => {
        String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
            try {
                const payload = JSON.parse(line);
                if (payload?.sampleRate) {
                    capture.sampleRate = Number(payload.sampleRate) || capture.sampleRate;
                }
            } catch (_error) {}
        });
    });
    capture.child.on('exit', (code, signal) => {
        if (session.nativeAudioCapture === capture) {
            session.nativeAudioCapture = null;
            sendNativeRealtimeTranslateEvent(session, {
                type: 'error',
                error: `native_microphone_helper_exited:${code ?? signal ?? 'unknown'}`
            });
        }
    });
    capture.child.on('error', (error) => {
        sendNativeRealtimeTranslateEvent(session, {
            type: 'error',
            error: error?.message || 'native_microphone_helper_error'
        });
    });
}

async function closeNativeRealtimeTranslateSession(webContentsId, { reason = 'client_stop', channel = 'primary' } = {}) {
    const sessionKey = getNativeRealtimeTranslateSessionKey(webContentsId, channel);
    const session = nativeRealtimeTranslateSessions.get(sessionKey);
    if (!session) {
        return;
    }
    nativeRealtimeTranslateSessions.delete(sessionKey);
    session.closedByClient = true;
    stopNativeRealtimeTranslateCapture(session);
    try {
        if (session.socket.readyState === 1) {
            session.socket.send(JSON.stringify({ type: 'session.close' }));
            setTimeout(() => {
                try { session.socket.close(); } catch (_error) {}
            }, 1200);
        } else {
            session.socket.close();
        }
    } catch (_error) {}
    sendNativeRealtimeTranslateEvent(session, {
        type: 'closed',
        reason
    });
}

async function closeNativeRealtimeTranslateSessionsForWebContents(webContentsId, { reason = 'client_stop' } = {}) {
    const prefix = `${Number(webContentsId)}:`;
    const sessions = [...nativeRealtimeTranslateSessions.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, session]) => session);
    await Promise.all(sessions.map((session) => closeNativeRealtimeTranslateSession(webContentsId, {
        reason,
        channel: session.channel || 'primary'
    })));
}

async function createNativeRealtimeTranslateSession({ webContents, apiKey, targetLanguage, channel = 'primary' }) {
    if (!WebSocketImpl) {
        throw new Error('openai_realtime_websocket_unavailable');
    }
    const webContentsId = Number(webContents.id);
    const sessionKey = getNativeRealtimeTranslateSessionKey(webContentsId, channel);
    await closeNativeRealtimeTranslateSession(webContentsId, { reason: 'restart', channel });

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const socket = createOpenAiRealtimeSocket(
            'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate',
            apiKey
        );
        const session = {
            socket,
            webContents,
            webContentsId,
            channel: String(channel || 'primary'),
            targetLanguage: String(targetLanguage || 'tr'),
            closedByClient: false,
            inputTranscript: '',
            outputTranscript: '',
            nativeAudioCapture: null
        };
        nativeRealtimeTranslateSessions.set(sessionKey, session);

        const handleIncomingEvent = async (event) => {
            let payloadText = '';
            if (typeof event.data === 'string') {
                payloadText = event.data;
            } else if (typeof event.data?.text === 'function') {
                payloadText = await event.data.text();
            } else {
                payloadText = String(event.data || '');
            }
            if (!payloadText) {
                return;
            }
            const payload = JSON.parse(payloadText);
            if (payload.type === 'error') {
                const message = payload?.error?.message || 'openai_live_translate_error';
                sendNativeRealtimeTranslateEvent(session, { type: 'error', error: message });
                if (!settled) {
                    nativeRealtimeTranslateSessions.delete(sessionKey);
                    finish({ success: false, error: message });
                }
                return;
            }
            if (payload.type === 'session.input_transcript.delta') {
                const delta = String(payload.delta || '');
                session.inputTranscript += delta;
                sendNativeRealtimeTranslateEvent(session, {
                    type: 'text-delta',
                    transcript: session.inputTranscript,
                    inputDelta: delta,
                    translatedText: session.outputTranscript
                });
                return;
            }
            if (payload.type === 'session.output_transcript.delta') {
                const delta = String(payload.delta || '');
                session.outputTranscript += delta;
                sendNativeRealtimeTranslateEvent(session, {
                    type: 'text-delta',
                    transcript: session.inputTranscript,
                    outputDelta: delta,
                    translatedText: session.outputTranscript
                });
                return;
            }
            if (payload.type === 'session.output_audio.delta') {
                const audioBase64 = String(payload.delta || '').trim();
                if (audioBase64) {
                    sendNativeRealtimeTranslateEvent(session, {
                        type: 'audio',
                        mimeType: 'audio/pcm;rate=24000',
                        audioBase64,
                        transcript: session.inputTranscript,
                        translatedText: session.outputTranscript
                    });
                }
                return;
            }
            if (payload.type === 'session.closed') {
                try { socket.close(); } catch (_error) {}
            }
        };

        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({
                type: 'session.update',
                session: {
                    audio: {
                        output: {
                            language: session.targetLanguage
                        }
                    }
                }
            }));
            finish({ success: true });
        });
        socket.addEventListener('message', (event) => {
            handleIncomingEvent(event).catch((error) => {
                sendNativeRealtimeTranslateEvent(session, {
                    type: 'error',
                    error: error?.message || String(error)
                });
            });
        });
        socket.addEventListener('error', () => {
            if (!settled) {
                nativeRealtimeTranslateSessions.delete(sessionKey);
                finish({ success: false, error: 'openai_live_translate_socket_error' });
            } else {
                sendNativeRealtimeTranslateEvent(session, {
                    type: 'error',
                    error: 'openai_live_translate_socket_error'
                });
            }
        });
        if (typeof socket.on === 'function') {
            socket.on('unexpected-response', (_request, response) => {
                const statusCode = Number(response?.statusCode || 0);
                const statusText = String(response?.statusMessage || '').trim();
                const errorCode = statusCode
                    ? `openai_live_translate_unexpected_response_${statusCode}${statusText ? `_${statusText.replace(/\s+/g, '_')}` : ''}`
                    : 'openai_live_translate_unexpected_response';
                if (!settled) {
                    nativeRealtimeTranslateSessions.delete(sessionKey);
                    finish({ success: false, error: errorCode });
                } else {
                    sendNativeRealtimeTranslateEvent(session, { type: 'error', error: errorCode });
                }
            });
        }
        socket.addEventListener('close', (event) => {
            nativeRealtimeTranslateSessions.delete(sessionKey);
            stopNativeRealtimeTranslateCapture(session);
            if (!session.closedByClient) {
                sendNativeRealtimeTranslateEvent(session, {
                    type: 'error',
                    error: `openai_live_translate_socket_closed${event?.code ? `:${event.code}` : ''}${event?.reason ? `:${event.reason}` : ''}`
                });
            }
        });
        webContents.once('destroyed', () => {
            closeNativeRealtimeTranslateSessionsForWebContents(webContentsId, { reason: 'window_destroyed' }).catch(() => {});
        });
    });
}

async function closeRealtimeTranslationSession(webContentsId, { reason = 'client_stop' } = {}) {
    const session = getRealtimeTranslationSession(webContentsId);
    if (!session) {
        return;
    }
    realtimeTranslationSessions.delete(Number(webContentsId));
    session.closedByClient = true;
    try {
        session.socket.close();
    } catch (_error) {}
    sendRealtimeTranslationEvent(session, {
        type: 'closed',
        reason
    });
}

async function createRealtimeTranslationSession({ webContents, apiKey, sourceLanguage, targetLanguage, doTranslate = true }) {
    if (!WebSocketImpl) {
        throw new Error('openai_realtime_websocket_unavailable');
    }
    const webContentsId = Number(webContents.id);
    await closeRealtimeTranslationSession(webContentsId, { reason: 'restart' });

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const socket = createOpenAiRealtimeSocket(
            'wss://api.openai.com/v1/realtime/transcription_sessions?model=gpt-realtime-whisper',
            apiKey
        );

        const session = {
            socket,
            webContents,
            webContentsId,
            apiKey,
            sourceLanguage: String(sourceLanguage || 'auto'),
            targetLanguage: String(targetLanguage || 'tr'),
            doTranslate: doTranslate !== false,
            closedByClient: false,
            partialTranscriptByItemId: new Map()
        };
        realtimeTranslationSessions.set(webContentsId, session);

        const handleIncomingEvent = async (event) => {
            let payloadText = '';
            if (typeof event.data === 'string') {
                payloadText = event.data;
            } else if (typeof event.data?.text === 'function') {
                payloadText = await event.data.text();
            } else {
                payloadText = String(event.data || '');
            }
            if (!payloadText) {
                return;
            }

            const payload = JSON.parse(payloadText);
            if (payload.type === 'error') {
                const message = payload?.error?.message || 'openai_realtime_error';
                sendRealtimeTranslationEvent(session, {
                    type: 'error',
                    error: message
                });
                if (!settled) {
                    realtimeTranslationSessions.delete(webContentsId);
                    finish({ success: false, error: message });
                }
                return;
            }

            if (payload.type === 'conversation.item.input_audio_transcription.delta') {
                const itemId = String(payload.item_id || '');
                const delta = String(payload.delta || '');
                if (!itemId || !delta) {
                    return;
                }
                const nextTranscript = `${session.partialTranscriptByItemId.get(itemId) || ''}${delta}`;
                session.partialTranscriptByItemId.set(itemId, nextTranscript);
                sendRealtimeTranslationEvent(session, {
                    type: 'delta',
                    itemId,
                    delta,
                    transcript: nextTranscript
                });
                return;
            }

            if (payload.type === 'conversation.item.input_audio_transcription.completed') {
                const itemId = String(payload.item_id || '');
                const transcript = String(payload.transcript || '').trim();
                if (itemId) {
                    session.partialTranscriptByItemId.delete(itemId);
                }
                if (!transcript) {
                    return;
                }
                let translatedText = '';
                if (session.doTranslate) {
                    try {
                        translatedText = await translateTranscriptText({
                            apiKey: session.apiKey,
                            transcript,
                            sourceLanguage: session.sourceLanguage,
                            targetLanguage: session.targetLanguage
                        });
                    } catch (error) {
                        sendRealtimeTranslationEvent(session, {
                            type: 'error',
                            error: error?.message || String(error)
                        });
                    }
                }
                sendRealtimeTranslationEvent(session, {
                    type: 'completed',
                    itemId,
                    transcript,
                    translatedText: String(translatedText || '').trim()
                });
            }
        };

        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({
                type: 'transcription_session.update',
                session: {
                    input_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'gpt-realtime-whisper',
                        ...(session.sourceLanguage !== 'auto'
                            ? { language: session.sourceLanguage }
                            : {}),
                        prompt: session.doTranslate
                            ? `Transcribe spoken audio and preserve meaning accurately for later translation to ${session.targetLanguage}.`
                            : 'Transcribe spoken audio accurately for live captions. Return the spoken language as-is without translating.'
                    }
                }
            }));
            finish({ success: true });
        });

        socket.addEventListener('message', (event) => {
            handleIncomingEvent(event).catch((error) => {
                sendRealtimeTranslationEvent(session, {
                    type: 'error',
                    error: error?.message || String(error)
                });
            });
        });

        socket.addEventListener('error', () => {
            if (!settled) {
                realtimeTranslationSessions.delete(webContentsId);
                finish({ success: false, error: 'openai_realtime_socket_error' });
            } else {
                sendRealtimeTranslationEvent(session, {
                    type: 'error',
                    error: 'openai_realtime_socket_error'
                });
            }
        });

        if (typeof socket.on === 'function') {
            socket.on('unexpected-response', (_request, response) => {
                const statusCode = Number(response?.statusCode || 0);
                const statusText = String(response?.statusMessage || '').trim();
                const errorCode = statusCode
                    ? `openai_realtime_unexpected_response_${statusCode}${statusText ? `_${statusText.replace(/\s+/g, '_')}` : ''}`
                    : 'openai_realtime_unexpected_response';
                if (!settled) {
                    realtimeTranslationSessions.delete(webContentsId);
                    finish({ success: false, error: errorCode });
                } else {
                    sendRealtimeTranslationEvent(session, {
                        type: 'error',
                        error: errorCode
                    });
                }
            });
        }

        socket.addEventListener('close', (event) => {
            realtimeTranslationSessions.delete(webContentsId);
            if (!session.closedByClient) {
                sendRealtimeTranslationEvent(session, {
                    type: 'error',
                    error: `openai_realtime_socket_closed${event?.code ? `:${event.code}` : ''}${event?.reason ? `:${event.reason}` : ''}`
                });
            }
        });

        webContents.once('destroyed', () => {
            closeRealtimeTranslationSession(webContentsId, { reason: 'window_destroyed' }).catch(() => {});
        });
    });
}

function setupOpenAiHandlers() {
    ipcMain.handle('save-openai-api-key', async (_event, { apiKey }) => {
        try {
            saveApiKey(apiKey);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-openai-api-key', async () => {
        return getApiKey();
    });

    ipcMain.handle('get-openai-api-data', async () => {
        return {
            apiKey: getApiKey()
        };
    });

    ipcMain.handle('openai-vision-request', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const text = await describeImageWithOpenAi({
                apiKey,
                imageBase64: payload.imageBase64,
                prompt: payload.prompt,
                systemInstruction: payload.systemInstruction,
                model: payload.model || 'gpt-4.1-mini'
            });
            return {
                success: true,
                text
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-translate-live-audio-chunk', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const transcript = await transcribeAudioChunk({
                apiKey,
                audioBase64: payload.audioBase64,
                mimeType: payload.mimeType,
                language: payload.sourceLanguage
            });
            const translatedText = transcript && payload.doTranslate !== false
                ? await translateTranscriptText({
                    apiKey,
                    transcript,
                    sourceLanguage: payload.sourceLanguage,
                    targetLanguage: payload.targetLanguage
                })
                : '';
            return {
                success: true,
                transcript,
                translatedText
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-translate-transcript-text', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const translatedText = await translateTranscriptText({
                apiKey,
                transcript: payload.transcript,
                sourceLanguage: payload.sourceLanguage,
                targetLanguage: payload.targetLanguage
            });
            return {
                success: true,
                translatedText
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-realtime-translation-start', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            if (!apiKey) {
                return { success: false, error: 'openai_api_key_missing' };
            }
            return await createRealtimeTranslationSession({
                webContents: event.sender,
                apiKey,
                sourceLanguage: payload.sourceLanguage,
                targetLanguage: payload.targetLanguage,
                doTranslate: payload.doTranslate !== false
            });
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-realtime-translation-stop', async (event) => {
        try {
            await closeRealtimeTranslationSession(event.sender.id, { reason: 'client_stop' });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-live-translate-start', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            if (!apiKey) {
                return { success: false, error: 'openai_api_key_missing' };
            }
            const result = await createNativeRealtimeTranslateSession({
                webContents: event.sender,
                apiKey,
                targetLanguage: payload.targetLanguage,
                channel: payload.channel || 'primary'
            });
            if (result?.success && ['native-microphone', 'native-system-audio', 'native-window-audio'].includes(payload.captureMode)) {
                const session = getNativeRealtimeTranslateSession(event.sender.id, payload.channel || 'primary');
                startNativeRealtimeTranslateCapture(
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

    ipcMain.handle('openai-live-translate-stop', async (event) => {
        try {
            await closeNativeRealtimeTranslateSessionsForWebContents(event.sender.id, { reason: 'client_stop' });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('openai-live-translate-stop-channel', async (event, payload = {}) => {
        try {
            await closeNativeRealtimeTranslateSession(event.sender.id, {
                reason: 'client_stop',
                channel: payload.channel || 'primary'
            });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.on('openai-realtime-translation-audio-chunk', (event, payload = {}) => {
        const session = getRealtimeTranslationSession(event.sender.id);
        if (!session || session.socket.readyState !== 1) {
            return;
        }
        const audio = String(payload.audioBase64 || '').trim();
        if (!audio) {
            return;
        }
        try {
            session.socket.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio
            }));
        } catch (_error) {}
    });

    ipcMain.on('openai-realtime-translation-commit', (event) => {
        const session = getRealtimeTranslationSession(event.sender.id);
        if (!session || session.socket.readyState !== 1) {
            return;
        }
        try {
            session.socket.send(JSON.stringify({
                type: 'input_audio_buffer.commit'
            }));
        } catch (_error) {}
    });

    ipcMain.handle('openai-speak-live-translation', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const result = await synthesizeTranslatedSpeech({
                apiKey,
                text: payload.text,
                targetLanguage: payload.targetLanguage,
                voice: payload.voice || 'alloy'
            });
            return {
                success: true,
                ...result
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });
}

module.exports = {
    setupOpenAiHandlers
};
