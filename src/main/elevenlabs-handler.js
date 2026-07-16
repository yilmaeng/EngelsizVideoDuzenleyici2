const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
    try {
        WebSocketImpl = require('ws');
    } catch (_error) {
        WebSocketImpl = null;
    }
}

const CONFIG_DIR = path.join(os.homedir(), '.korcul-video-editor');
const API_KEY_FILE = path.join(CONFIG_DIR, 'elevenlabs-api-key.enc');
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const realtimeSttSessions = new Map();

function createMultipartBody(fields = {}, files = {}) {
    const boundary = `----evd-elevenlabs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunks = [];
    const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));

    Object.entries(fields).forEach(([name, value]) => {
        if (value === undefined || value === null || value === '') {
            return;
        }
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
        push(String(value));
        push('\r\n');
    });

    Object.entries(files).forEach(([name, file]) => {
        if (!file?.path) {
            return;
        }
        const filename = path.basename(file.path);
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`);
        push(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
        push(fs.readFileSync(file.path));
        push('\r\n');
    });

    push(`--${boundary}--\r\n`);
    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

function getMediaContentType(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.m4a') return 'audio/mp4';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.mkv') return 'video/x-matroska';
    return 'video/mp4';
}

function normalizeDubbingLanguage(languageCode) {
    const normalized = String(languageCode || '').trim().toLowerCase();
    if (!normalized || normalized === 'auto') {
        return '';
    }
    return normalized.split('-')[0];
}

function sendDubbingProgress(webContents, payload) {
    if (!webContents || webContents.isDestroyed()) {
        return;
    }
    webContents.send('elevenlabs-dubbing-progress', payload);
}

function createElevenLabsRealtimeSocket({ apiKey, languageCode = 'auto' }) {
    if (!WebSocketImpl) {
        throw new Error('elevenlabs_realtime_websocket_unavailable');
    }
    const query = new URLSearchParams({
        model_id: 'scribe_v2_realtime',
        audio_format: 'pcm_16000',
        commit_strategy: 'vad'
    });
    const normalizedLanguage = String(languageCode || '').trim().toLowerCase();
    if (normalizedLanguage && normalizedLanguage !== 'auto') {
        query.set('language_code', normalizedLanguage);
    }
    const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query.toString()}`;
    const isNodeWs = typeof WebSocketImpl === 'function' && /ws/i.test(String(WebSocketImpl.name || ''));
    if (isNodeWs) {
        return new WebSocketImpl(url, {
            headers: {
                'xi-api-key': apiKey
            }
        });
    }
    return new WebSocketImpl(url, {
        headers: {
            'xi-api-key': apiKey
        }
    });
}

function saveApiKey(apiKey) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const encoded = Buffer.from(String(apiKey || '')).toString('base64');
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
        console.error('ElevenLabs API anahtarı okunamadı:', error);
        return null;
    }
}

function getRealtimeSttSession(webContentsId) {
    return realtimeSttSessions.get(Number(webContentsId)) || null;
}

function sendRealtimeSttEvent(session, payload) {
    if (!session?.webContents || session.webContents.isDestroyed()) {
        return;
    }
    session.webContents.send('elevenlabs-realtime-stt-event', payload);
}

async function closeRealtimeSttSession(webContentsId, { reason = 'client_stop' } = {}) {
    const session = getRealtimeSttSession(webContentsId);
    if (!session) {
        return;
    }
    realtimeSttSessions.delete(Number(webContentsId));
    session.closedByClient = true;
    try {
        session.socket.close();
    } catch (_error) {}
    sendRealtimeSttEvent(session, {
        type: 'closed',
        reason
    });
}

async function createRealtimeSttSession({ webContents, apiKey, sourceLanguage }) {
    const webContentsId = Number(webContents.id);
    await closeRealtimeSttSession(webContentsId, { reason: 'restart' });

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const socket = createElevenLabsRealtimeSocket({
            apiKey,
            languageCode: sourceLanguage
        });
        const session = {
            socket,
            webContents,
            webContentsId,
            closedByClient: false
        };
        realtimeSttSessions.set(webContentsId, session);

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
            const messageType = String(payload.message_type || '').trim();
            if (messageType === 'session_started') {
                if (!settled) {
                    finish({ success: true });
                }
                return;
            }
            if (messageType === 'partial_transcript') {
                sendRealtimeSttEvent(session, {
                    type: 'delta',
                    transcript: String(payload.text || '').trim()
                });
                return;
            }
            if (messageType === 'committed_transcript' || messageType === 'committed_transcript_with_timestamps') {
                sendRealtimeSttEvent(session, {
                    type: 'completed',
                    transcript: String(payload.text || '').trim()
                });
                return;
            }
            if (messageType === 'error') {
                const errorText = payload?.error || payload?.message || 'elevenlabs_realtime_error';
                sendRealtimeSttEvent(session, {
                    type: 'error',
                    error: String(errorText)
                });
                if (!settled) {
                    realtimeSttSessions.delete(webContentsId);
                    finish({ success: false, error: String(errorText) });
                }
            }
        };

        socket.addEventListener('open', () => {
            if (!settled) {
                finish({ success: true });
            }
        });

        socket.addEventListener('message', (event) => {
            handleIncomingEvent(event).catch((error) => {
                sendRealtimeSttEvent(session, {
                    type: 'error',
                    error: error?.message || String(error)
                });
            });
        });

        socket.addEventListener('error', () => {
            if (!settled) {
                realtimeSttSessions.delete(webContentsId);
                finish({ success: false, error: 'elevenlabs_realtime_socket_error' });
            } else {
                sendRealtimeSttEvent(session, {
                    type: 'error',
                    error: 'elevenlabs_realtime_socket_error'
                });
            }
        });

        if (typeof socket.on === 'function') {
            socket.on('unexpected-response', (_request, response) => {
                const statusCode = Number(response?.statusCode || 0);
                const statusText = String(response?.statusMessage || '').trim();
                const errorCode = statusCode
                    ? `elevenlabs_realtime_unexpected_response_${statusCode}${statusText ? `_${statusText.replace(/\s+/g, '_')}` : ''}`
                    : 'elevenlabs_realtime_unexpected_response';
                if (!settled) {
                    realtimeSttSessions.delete(webContentsId);
                    finish({ success: false, error: errorCode });
                } else {
                    sendRealtimeSttEvent(session, {
                        type: 'error',
                        error: errorCode
                    });
                }
            });
        }

        socket.addEventListener('close', (closeEvent) => {
            realtimeSttSessions.delete(webContentsId);
            if (!session.closedByClient) {
                sendRealtimeSttEvent(session, {
                    type: 'error',
                    error: `elevenlabs_realtime_socket_closed${closeEvent?.code ? `:${closeEvent.code}` : ''}${closeEvent?.reason ? `:${closeEvent.reason}` : ''}`
                });
            }
        });

        webContents.once('destroyed', () => {
            closeRealtimeSttSession(webContentsId, { reason: 'window_destroyed' }).catch(() => {});
        });
    });
}

async function synthesizeTranslatedSpeech({
    apiKey,
    text,
    targetLanguage,
    voiceId = DEFAULT_VOICE_ID,
    modelId = DEFAULT_MODEL_ID
}) {
    if (!apiKey) {
        throw new Error('elevenlabs_api_key_missing');
    }
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        throw new Error('translation_speech_text_missing');
    }

    const query = new URLSearchParams({
        output_format: 'mp3_44100_128'
    });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(String(voiceId || DEFAULT_VOICE_ID))}?${query.toString()}`, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg'
        },
        body: JSON.stringify({
            text: normalizedText,
            model_id: String(modelId || DEFAULT_MODEL_ID)
        })
    });

    if (!response.ok) {
        let errorMessage = `elevenlabs_tts_http_${response.status}`;
        const requestId = String(response.headers.get('request-id') || '').trim();
        try {
            const payload = await response.json();
            errorMessage = payload?.detail?.message
                || payload?.detail
                || payload?.message
                || errorMessage;
        } catch (_error) {
            // ignore non-json errors
        }
        const pieces = [
            String(errorMessage),
            `status=${response.status}`,
            `voice=${String(voiceId || DEFAULT_VOICE_ID)}`,
            `model=${String(modelId || DEFAULT_MODEL_ID)}`,
            `target=${String(targetLanguage || '').trim() || 'auto'}`
        ];
        if (requestId) {
            pieces.push(`request_id=${requestId}`);
        }
        throw new Error(pieces.join(' | '));
    }

    const contentType = String(response.headers.get('content-type') || 'audio/mpeg').trim() || 'audio/mpeg';
    const arrayBuffer = await response.arrayBuffer();
    return {
        audioBase64: Buffer.from(arrayBuffer).toString('base64'),
        mimeType: contentType
    };
}

async function fetchElevenLabsJson(url, { apiKey, method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(url, {
        method,
        headers: {
            'xi-api-key': apiKey,
            ...headers
        },
        body
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch (_error) {
        payload = null;
    }
    if (!response.ok) {
        const message = payload?.detail?.message
            || payload?.detail
            || payload?.message
            || `elevenlabs_http_${response.status}`;
        throw new Error(String(message));
    }
    return payload || {};
}

async function getSubscriptionInfo(apiKey) {
    if (!apiKey) {
        throw new Error('elevenlabs_api_key_missing');
    }
    return fetchElevenLabsJson('https://api.elevenlabs.io/v1/user/subscription', {
        apiKey,
        headers: { Accept: 'application/json' }
    });
}

async function createDubbingJob({ apiKey, filePath, sourceLanguage, targetLanguage, projectName, dropBackgroundAudio = true, dubbingStudio = false }) {
    if (!apiKey) {
        throw new Error('elevenlabs_api_key_missing');
    }
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('dubbing_source_file_missing');
    }
    const targetLang = normalizeDubbingLanguage(targetLanguage);
    if (!targetLang) {
        throw new Error('dubbing_target_language_missing');
    }
    const fields = {
        target_lang: targetLang,
        source_lang: normalizeDubbingLanguage(sourceLanguage) || 'auto',
        name: projectName || path.parse(filePath).name,
        num_speakers: '0',
        watermark: 'false',
        drop_background_audio: dropBackgroundAudio ? 'true' : 'false',
        dubbing_studio: dubbingStudio ? 'true' : 'false'
    };
    const multipart = createMultipartBody(fields, {
        file: {
            path: filePath,
            contentType: getMediaContentType(filePath)
        }
    });
    const payload = await fetchElevenLabsJson('https://api.elevenlabs.io/v1/dubbing', {
        apiKey,
        method: 'POST',
        headers: {
            'Content-Type': multipart.contentType,
            Accept: 'application/json'
        },
        body: multipart.body
    });
    if (!payload?.dubbing_id) {
        throw new Error('elevenlabs_dubbing_id_missing');
    }
    return payload;
}

function isDubbingResourceAccessError(error) {
    const message = String(error?.message || error || '');
    return /403|404|422|closed.?beta|enterprise|permission|forbidden|not.?found|unprocessable|resource/i.test(message);
}

function formatDubbingResourceAccessError(error) {
    const message = String(error?.message || error || 'elevenlabs_dubbing_resource_unavailable');
    if (isDubbingResourceAccessError(message)) {
        return `elevenlabs_dubbing_studio_unavailable: ${message}`;
    }
    return message;
}

async function getDubbingResource(apiKey, dubbingId) {
    return fetchElevenLabsJson(`https://api.elevenlabs.io/v1/dubbing/resource/${encodeURIComponent(dubbingId)}`, {
        apiKey,
        headers: { Accept: 'application/json' }
    });
}

function pickSegmentText(segment, languageCode) {
    const language = normalizeDubbingLanguage(languageCode);
    const candidates = [
        segment?.languages?.[language]?.text,
        segment?.language_tracks?.[language]?.text,
        segment?.translations?.[language]?.text,
        segment?.translation?.[language]?.text,
        segment?.translated_text,
        segment?.text,
        segment?.transcription?.text,
        segment?.source_text
    ];
    return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim();
}

function pickSegmentTime(segment, key) {
    const candidates = key === 'start'
        ? [segment?.start_time, segment?.start, segment?.start_s, segment?.start_ms]
        : [segment?.end_time, segment?.end, segment?.end_s, segment?.end_ms];
    const value = candidates.find((item) => Number.isFinite(Number(item)));
    if (value === undefined || value === null) return 0;
    const numeric = Number(value);
    return numeric > 1000 ? numeric / 1000 : numeric;
}

function extractEditableSegments(resource, languageCode) {
    const seen = new Set();
    const segments = [];
    const visit = (node, keyPath = []) => {
        if (!node || typeof node !== 'object') return;
        const keys = Object.keys(node);
        const hasSegmentShape = keys.some((key) => /text|start|end|speaker/i.test(key))
            && (keys.some((key) => /text/i.test(key)) || keys.some((key) => /language|translation|transcription/i.test(key)));
        if (hasSegmentShape) {
            const segmentId = String(node.id || node.segment_id || node.segmentId || keyPath[keyPath.length - 1] || '').trim();
            const text = pickSegmentText(node, languageCode);
            if (segmentId && text && !seen.has(segmentId)) {
                seen.add(segmentId);
                segments.push({
                    id: segmentId,
                    speakerId: String(node.speaker_id || node.speakerId || node.speaker || keyPath.find((part) => /^speaker/i.test(String(part))) || '').trim(),
                    startTime: pickSegmentTime(node, 'start'),
                    endTime: pickSegmentTime(node, 'end'),
                    text
                });
            }
        }
        Object.entries(node).forEach(([key, value]) => {
            if (value && typeof value === 'object') {
                visit(value, [...keyPath, key]);
            }
        });
    };
    visit(resource?.speaker_segments || resource?.segments || resource, []);
    return segments.sort((a, b) => a.startTime - b.startTime);
}

async function createDubbingStudioProjectFromFile({ apiKey, filePath, sourceLanguage, targetLanguage, dropBackgroundAudio = true, webContents }) {
    const job = await createDubbingJob({
        apiKey,
        filePath,
        sourceLanguage,
        targetLanguage,
        projectName: path.parse(filePath).name,
        dropBackgroundAudio,
        dubbingStudio: true
    });
    sendDubbingProgress(webContents, {
        type: 'created',
        dubbingId: job.dubbing_id,
        percent: 10
    });
    await waitForDubbingCompletion({
        apiKey,
        dubbingId: job.dubbing_id,
        webContents
    }).catch(() => null);
    let resource = await getDubbingResource(apiKey, job.dubbing_id);
    let segments = extractEditableSegments(resource, targetLanguage);
    for (let attempt = 0; attempt < 8 && !segments.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        resource = await getDubbingResource(apiKey, job.dubbing_id);
        segments = extractEditableSegments(resource, targetLanguage);
    }
    if (!segments.length) {
        throw new Error('elevenlabs_dubbing_segments_missing');
    }
    return {
        dubbingId: job.dubbing_id,
        expectedDurationSec: job.expected_duration_sec,
        targetLanguage: normalizeDubbingLanguage(targetLanguage),
        segments
    };
}

async function updateDubbingStudioSegment({ apiKey, dubbingId, segmentId, language, text }) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
        throw new Error('elevenlabs_dubbing_segment_text_missing');
    }
    return fetchElevenLabsJson(
        `https://api.elevenlabs.io/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/segment/${encodeURIComponent(segmentId)}/${encodeURIComponent(normalizeDubbingLanguage(language))}`,
        {
            apiKey,
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ text: cleanText })
        }
    );
}

async function runDubbingResourceAction({ apiKey, dubbingId, action, segments = [], languages = [] }) {
    return fetchElevenLabsJson(`https://api.elevenlabs.io/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/${action}`, {
        apiKey,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            segments,
            languages
        })
    });
}

async function requestDubbingResourceRender({ apiKey, dubbingId, language, renderType = 'mp4' }) {
    return fetchElevenLabsJson(
        `https://api.elevenlabs.io/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/render/${encodeURIComponent(normalizeDubbingLanguage(language))}`,
        {
            apiKey,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                render_type: renderType,
                normalize_volume: true
            })
        }
    );
}

function findDubbingRender(resource, renderId, language) {
    const renders = resource?.renders || {};
    const languageCode = normalizeDubbingLanguage(language);
    const stack = [renders?.[languageCode], renders];
    while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== 'object') continue;
        if (String(item.id || item.render_id || '') === String(renderId || '') || !renderId) {
            const url = String(item.url || item.src || item.download_url || item.signed_url || '').trim();
            if (url) return { ...item, url };
        }
        Object.values(item).forEach((value) => {
            if (value && typeof value === 'object') stack.push(value);
        });
    }
    return null;
}

async function downloadDubbingRender({ apiKey, url, outputPath }) {
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'xi-api-key': apiKey,
            Accept: 'video/mp4,audio/mpeg,application/octet-stream'
        }
    });
    if (!response.ok) {
        throw new Error(`elevenlabs_dubbing_render_download_http_${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || 'video/mp4').trim();
    const finalOutputPath = /mp4|video/i.test(contentType)
        ? outputPath.replace(/\.[^.]+$/, '.mp4')
        : outputPath.replace(/\.[^.]+$/, '.mp3');
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(finalOutputPath, Buffer.from(arrayBuffer));
    return {
        outputPath: finalOutputPath,
        contentType
    };
}

async function renderDubbingStudioProject({ apiKey, dubbingId, targetLanguage, outputPath, webContents }) {
    const language = normalizeDubbingLanguage(targetLanguage);
    const resource = await getDubbingResource(apiKey, dubbingId);
    const segments = extractEditableSegments(resource, language).map((segment) => segment.id);
    if (segments.length) {
        sendDubbingProgress(webContents, { type: 'status', dubbingId, status: 'dubbing_segments', percent: 60 });
        await runDubbingResourceAction({ apiKey, dubbingId, action: 'dub', segments, languages: [language] });
    }
    sendDubbingProgress(webContents, { type: 'status', dubbingId, status: 'rendering', percent: 75 });
    const render = await requestDubbingResourceRender({ apiKey, dubbingId, language, renderType: 'mp4' });
    const renderId = render?.render_id;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const latest = await getDubbingResource(apiKey, dubbingId);
        const readyRender = findDubbingRender(latest, renderId, language);
        if (readyRender?.url) {
            sendDubbingProgress(webContents, { type: 'status', dubbingId, status: 'downloading_render', percent: 95 });
            return downloadDubbingRender({ apiKey, url: readyRender.url, outputPath });
        }
    }
    throw new Error('elevenlabs_dubbing_render_timeout');
}

function isDubbingComplete(statusPayload = {}) {
    const status = String(statusPayload.status || statusPayload.state || statusPayload.dubbing_status || '').toLowerCase();
    return ['dubbed', 'done', 'complete', 'completed', 'succeeded', 'success', 'ready'].includes(status);
}

function isDubbingFailed(statusPayload = {}) {
    const status = String(statusPayload.status || statusPayload.state || statusPayload.dubbing_status || '').toLowerCase();
    return ['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status);
}

async function waitForDubbingCompletion({ apiKey, dubbingId, webContents, timeoutMs = 20 * 60 * 1000 }) {
    const startedAt = Date.now();
    let attempt = 0;
    let lastPayload = null;
    while (Date.now() - startedAt < timeoutMs) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, attempt <= 2 ? 3000 : 7000));
        try {
            lastPayload = await fetchElevenLabsJson(`https://api.elevenlabs.io/v1/dubbing/${encodeURIComponent(dubbingId)}`, {
                apiKey,
                headers: { Accept: 'application/json' }
            });
            sendDubbingProgress(webContents, {
                type: 'status',
                dubbingId,
                status: lastPayload.status || lastPayload.state || '',
                percent: Math.min(95, 15 + attempt * 5)
            });
            if (isDubbingComplete(lastPayload)) {
                return lastPayload;
            }
            if (isDubbingFailed(lastPayload)) {
                throw new Error(lastPayload?.error || lastPayload?.message || 'elevenlabs_dubbing_failed');
            }
        } catch (error) {
            if (attempt > 2 && /404|not.?found|422/i.test(String(error?.message || ''))) {
                throw error;
            }
            sendDubbingProgress(webContents, {
                type: 'status',
                dubbingId,
                status: 'processing',
                percent: Math.min(90, 10 + attempt * 4)
            });
        }
    }
    throw new Error('elevenlabs_dubbing_timeout');
}

async function downloadDubbedAudio({ apiKey, dubbingId, targetLanguage, outputPath }) {
    const languageCode = normalizeDubbingLanguage(targetLanguage);
    const response = await fetch(`https://api.elevenlabs.io/v1/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(languageCode)}`, {
        method: 'GET',
        headers: {
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg,video/mp4,application/octet-stream'
        }
    });
    if (!response.ok) {
        let message = `elevenlabs_dubbing_audio_http_${response.status}`;
        try {
            const payload = await response.json();
            message = payload?.detail?.message || payload?.detail || payload?.message || message;
        } catch (_error) {}
        throw new Error(String(message));
    }
    const contentType = String(response.headers.get('content-type') || 'audio/mpeg').trim();
    const arrayBuffer = await response.arrayBuffer();
    const finalOutputPath = /mp4|video/i.test(contentType)
        ? outputPath.replace(/\.[^.]+$/, '.mp4')
        : outputPath;
    fs.writeFileSync(finalOutputPath, Buffer.from(arrayBuffer));
    return {
        outputPath: finalOutputPath,
        contentType
    };
}

async function createDubbingAudioFromFile({ apiKey, filePath, sourceLanguage, targetLanguage, dropBackgroundAudio = true, webContents }) {
    const job = await createDubbingJob({
        apiKey,
        filePath,
        sourceLanguage,
        targetLanguage,
        projectName: path.parse(filePath).name,
        dropBackgroundAudio
    });
    sendDubbingProgress(webContents, {
        type: 'created',
        dubbingId: job.dubbing_id,
        percent: 10
    });
    await waitForDubbingCompletion({
        apiKey,
        dubbingId: job.dubbing_id,
        webContents
    });
    const outputPath = path.join(os.tmpdir(), `evd_elevenlabs_dubbing_${job.dubbing_id}_${Date.now()}.mp3`);
    const audio = await downloadDubbedAudio({
        apiKey,
        dubbingId: job.dubbing_id,
        targetLanguage,
        outputPath
    });
    sendDubbingProgress(webContents, {
        type: 'downloaded',
        dubbingId: job.dubbing_id,
        percent: 100
    });
    return {
        dubbingId: job.dubbing_id,
        expectedDurationSec: job.expected_duration_sec,
        ...audio
    };
}

function setupElevenLabsHandlers() {
    ipcMain.handle('save-elevenlabs-api-key', async (_event, { apiKey }) => {
        try {
            saveApiKey(apiKey);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-elevenlabs-api-key', async () => {
        return getApiKey();
    });

    ipcMain.handle('get-elevenlabs-api-data', async () => {
        return {
            apiKey: getApiKey()
        };
    });

    ipcMain.handle('elevenlabs-realtime-stt-start', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            if (!apiKey) {
                return { success: false, error: 'elevenlabs_api_key_missing' };
            }
            return await createRealtimeSttSession({
                webContents: event.sender,
                apiKey,
                sourceLanguage: payload.sourceLanguage
            });
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.handle('elevenlabs-realtime-stt-stop', async (event) => {
        try {
            await closeRealtimeSttSession(event.sender.id, { reason: 'client_stop' });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error)
            };
        }
    });

    ipcMain.on('elevenlabs-realtime-stt-audio-chunk', (event, payload = {}) => {
        const session = getRealtimeSttSession(event.sender.id);
        if (!session || session.socket.readyState !== 1) {
            return;
        }
        const audio = String(payload.audioBase64 || '').trim();
        if (!audio) {
            return;
        }
        try {
            session.socket.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: audio,
                sample_rate: Number(payload.sampleRate || 16000)
            }));
        } catch (_error) {}
    });

    ipcMain.handle('elevenlabs-speak-live-translation', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const synthesis = await synthesizeTranslatedSpeech({
                apiKey,
                text: payload.text,
                targetLanguage: payload.targetLanguage,
                voiceId: payload.voiceId,
                modelId: payload.modelId
            });
            return {
                success: true,
                ...synthesis
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || 'elevenlabs_tts_failed'
            };
        }
    });

    ipcMain.handle('elevenlabs-create-dubbing-audio-from-file', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const result = await createDubbingAudioFromFile({
                apiKey,
                filePath: payload.filePath,
                sourceLanguage: payload.sourceLanguage,
                targetLanguage: payload.targetLanguage,
                dropBackgroundAudio: payload.dropBackgroundAudio !== false,
                webContents: event.sender
            });
            return {
                success: true,
                ...result
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || 'elevenlabs_dubbing_failed'
            };
        }
    });

    ipcMain.handle('elevenlabs-prepare-dubbing-studio-from-file', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const result = await createDubbingStudioProjectFromFile({
                apiKey,
                filePath: payload.filePath,
                sourceLanguage: payload.sourceLanguage,
                targetLanguage: payload.targetLanguage,
                dropBackgroundAudio: payload.dropBackgroundAudio !== false,
                webContents: event.sender
            });
            return {
                success: true,
                ...result
            };
        } catch (error) {
            return {
                success: false,
                error: formatDubbingResourceAccessError(error)
            };
        }
    });

    ipcMain.handle('elevenlabs-update-dubbing-studio-segment', async (_event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            await updateDubbingStudioSegment({
                apiKey,
                dubbingId: payload.dubbingId,
                segmentId: payload.segmentId,
                language: payload.language,
                text: payload.text
            });
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: formatDubbingResourceAccessError(error)
            };
        }
    });

    ipcMain.handle('elevenlabs-render-dubbing-studio-project', async (event, payload = {}) => {
        try {
            const apiKey = getApiKey();
            const result = await renderDubbingStudioProject({
                apiKey,
                dubbingId: payload.dubbingId,
                targetLanguage: payload.targetLanguage,
                outputPath: payload.outputPath,
                webContents: event.sender
            });
            return {
                success: true,
                ...result
            };
        } catch (error) {
            return {
                success: false,
                error: formatDubbingResourceAccessError(error)
            };
        }
    });

    ipcMain.handle('elevenlabs-get-subscription-info', async () => {
        try {
            const apiKey = getApiKey();
            const subscription = await getSubscriptionInfo(apiKey);
            return {
                success: true,
                subscription
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || 'elevenlabs_subscription_failed'
            };
        }
    });
}

module.exports = {
    setupElevenLabsHandlers,
    hasElevenLabsApiKey: () => Boolean(String(getApiKey() || '').trim())
};
