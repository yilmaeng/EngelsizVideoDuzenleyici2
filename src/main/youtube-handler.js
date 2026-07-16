const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const CONFIG_DIR = path.join(os.homedir(), '.korcul-video-editor');
const CLIENT_FILE = path.join(CONFIG_DIR, 'youtube-oauth-client.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'youtube-oauth-token.json');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'youtube-oauth-accounts.json');
const ACTIVE_LIVE_BROADCAST_FILE = path.join(CONFIG_DIR, 'youtube-active-live-broadcast.json');

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const YOUTUBE_WATCH_BASE = 'https://www.youtube.com/watch';
const YOUTUBE_LIVE_CHAT_BASE = 'https://www.youtube.com/live_chat';
const YOUTUBE_INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat';
const YOUTUBE_STREAM_PROTO = path.join(__dirname, 'protos', 'youtube-live-chat-stream.proto');
const YOUTUBE_DESKTOP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Accept-Language': 'tr,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-CH-UA': '"Chromium";v="135", "Google Chrome";v="135", "Not:A-Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1'
};

function loadBundledYoutubeClient() {
    let generatedClient = {};
    try {
        generatedClient = require('./youtube-oauth-bundled.generated');
    } catch (_error) {
        generatedClient = {};
    }

    return {
        clientId: String(process.env.EVD_YOUTUBE_OAUTH_CLIENT_ID || generatedClient.clientId || '').trim(),
        clientSecret: String(process.env.EVD_YOUTUBE_OAUTH_CLIENT_SECRET || generatedClient.clientSecret || '').trim()
    };
}

const BUNDLED_CLIENT = loadBundledYoutubeClient();
const PUBLIC_CHAT_SESSION_CACHE = new Map();
const LIVE_CHAT_STREAM_SESSION_CACHE = new Map();
const LIVE_CHAT_STREAM_IDLE_MS = 2 * 60 * 1000;
const LIVE_CHAT_STREAM_RETRY_MS = 1500;
const LIVE_CHAT_STREAM_LOCAL_POLL_MS = 1500;
const LIVE_CHAT_STREAM_MAX_BUFFER = 400;

let youtubeLiveChatStreamStubFactory = null;

function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}

function createYoutubeHandlerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function createDetailedYoutubeApiError(message, details = {}) {
    const error = new Error(message);
    if (details.code) error.code = details.code;
    if (details.reason) error.reason = details.reason;
    if (details.statusCode) error.statusCode = details.statusCode;
    if (details.apiStatus) error.apiStatus = details.apiStatus;
    if (details.responseBody) error.responseBody = details.responseBody;
    return error;
}

function saveJson(filePath, value) {
    ensureConfigDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Could not read JSON file ${filePath}:`, error);
        return fallback;
    }
}

function saveYoutubeClientConfig({ clientId, clientSecret }) {
    const normalized = {
        clientId: String(clientId || '').trim(),
        clientSecret: String(clientSecret || '').trim()
    };
    saveJson(CLIENT_FILE, normalized);
    return normalized;
}

function getYoutubeClientConfig() {
    const saved = readJson(CLIENT_FILE, null);
    if (saved && (saved.clientId || saved.clientSecret)) {
        return {
            clientId: String(saved.clientId || '').trim() || BUNDLED_CLIENT.clientId,
            clientSecret: String(saved.clientSecret || '').trim() || BUNDLED_CLIENT.clientSecret
        };
    }
    return { ...BUNDLED_CLIENT };
}

function saveActiveYouTubeBroadcastSession(session = {}) {
    const broadcastId = String(session.broadcastId || '').trim();
    if (!broadcastId) {
        return clearActiveYouTubeBroadcastSession();
    }

    const normalized = {
        broadcastId,
        title: String(session.title || '').trim(),
        watchUrl: String(session.watchUrl || '').trim(),
        source: String(session.source || '').trim(),
        startedAt: session.startedAt || new Date().toISOString()
    };
    saveJson(ACTIVE_LIVE_BROADCAST_FILE, normalized);
    return normalized;
}

function getActiveYouTubeBroadcastSession() {
    const session = readJson(ACTIVE_LIVE_BROADCAST_FILE, null);
    if (!session || !String(session.broadcastId || '').trim()) {
        return null;
    }
    return {
        broadcastId: String(session.broadcastId || '').trim(),
        title: String(session.title || '').trim(),
        watchUrl: String(session.watchUrl || '').trim(),
        source: String(session.source || '').trim(),
        startedAt: String(session.startedAt || '').trim()
    };
}

function clearActiveYouTubeBroadcastSession() {
    try {
        if (fs.existsSync(ACTIVE_LIVE_BROADCAST_FILE)) {
            fs.unlinkSync(ACTIVE_LIVE_BROADCAST_FILE);
        }
    } catch (error) {
        console.warn('Could not clear active YouTube broadcast session:', error.message);
    }
    return null;
}

function normalizeYoutubeAccountsStore(store) {
    return {
        activeAccountId: typeof store?.activeAccountId === 'string' ? store.activeAccountId : '',
        accounts: Array.isArray(store?.accounts) ? store.accounts : []
    };
}

function migrateLegacyYoutubeTokenStore() {
    const existingStore = readJson(ACCOUNTS_FILE, null);
    if (existingStore) {
        return normalizeYoutubeAccountsStore(existingStore);
    }

    const legacyToken = readJson(TOKEN_FILE, null);
    if (!legacyToken) {
        return normalizeYoutubeAccountsStore(null);
    }

    const migrated = {
        activeAccountId: 'legacy-account',
        accounts: [
            {
                id: 'legacy-account',
                token: legacyToken,
                channel: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ]
    };
    saveJson(ACCOUNTS_FILE, migrated);
    return migrated;
}

function getYoutubeAccountsStore() {
    return normalizeYoutubeAccountsStore(migrateLegacyYoutubeTokenStore());
}

function saveYoutubeAccountsStore(store) {
    const normalized = normalizeYoutubeAccountsStore(store);
    saveJson(ACCOUNTS_FILE, normalized);
    return normalized;
}

function getYoutubeAccounts() {
    return getYoutubeAccountsStore().accounts;
}

function getActiveYoutubeAccountId() {
    const store = getYoutubeAccountsStore();
    if (store.activeAccountId && store.accounts.some((account) => account.id === store.activeAccountId)) {
        return store.activeAccountId;
    }
    return store.accounts[0]?.id || '';
}

function setActiveYoutubeAccount(accountId) {
    const store = getYoutubeAccountsStore();
    if (!accountId || !store.accounts.some((account) => account.id === accountId)) {
        throw new Error('Secilen YouTube hesabi bulunamadi.');
    }
    store.activeAccountId = accountId;
    saveYoutubeAccountsStore(store);
    return accountId;
}

function buildYoutubeAccountSummary(account) {
    return {
        id: account.id,
        channelId: account.channel?.id || '',
        title: account.channel?.title || '',
        connectedAt: account.createdAt || '',
        updatedAt: account.updatedAt || ''
    };
}

function getYoutubeToken(accountId = '') {
    const resolvedAccountId = accountId || getActiveYoutubeAccountId();
    if (!resolvedAccountId) return null;
    const account = getYoutubeAccounts().find((item) => item.id === resolvedAccountId);
    return account?.token || null;
}

function saveYoutubeAccount({ tokenData, channel, accountId = '' }) {
    const store = getYoutubeAccountsStore();
    const normalizedChannel = channel ? {
        id: channel.id || '',
        title: channel.title || ''
    } : null;
    const resolvedAccountId = accountId || normalizedChannel?.id || `youtube-account-${Date.now()}`;
    const duplicateIndex = normalizedChannel?.id
        ? store.accounts.findIndex((account) => account.channel?.id === normalizedChannel.id)
        : -1;
    const existingIndex = store.accounts.findIndex((account) => account.id === resolvedAccountId);
    const targetIndex = existingIndex >= 0 ? existingIndex : duplicateIndex;
    const now = new Date().toISOString();

    const nextAccount = {
        id: targetIndex >= 0 ? store.accounts[targetIndex].id : resolvedAccountId,
        token: tokenData,
        channel: normalizedChannel,
        createdAt: targetIndex >= 0 ? (store.accounts[targetIndex].createdAt || now) : now,
        updatedAt: now
    };

    if (targetIndex >= 0) {
        store.accounts[targetIndex] = {
            ...store.accounts[targetIndex],
            ...nextAccount
        };
    } else {
        store.accounts.push(nextAccount);
    }

    store.activeAccountId = nextAccount.id;
    saveYoutubeAccountsStore(store);
    return nextAccount;
}

function updateYoutubeAccountChannel(accountId, channel) {
    if (!accountId || !channel) return;
    const store = getYoutubeAccountsStore();
    const accountIndex = store.accounts.findIndex((account) => account.id === accountId);
    if (accountIndex < 0) return;
    store.accounts[accountIndex] = {
        ...store.accounts[accountIndex],
        channel: {
            id: channel.id || '',
            title: channel.title || ''
        },
        updatedAt: new Date().toISOString()
    };
    saveYoutubeAccountsStore(store);
}

function clearYoutubeToken(accountId = '') {
    const store = getYoutubeAccountsStore();
    const resolvedAccountId = accountId || getActiveYoutubeAccountId();
    if (!resolvedAccountId) return;

    const nextAccounts = store.accounts.filter((account) => account.id !== resolvedAccountId);
    const nextActiveAccountId = store.activeAccountId === resolvedAccountId
        ? (nextAccounts[0]?.id || '')
        : store.activeAccountId;

    saveYoutubeAccountsStore({
        activeAccountId: nextActiveAccountId,
        accounts: nextAccounts
    });
}

function toBase64Url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createPkcePair() {
    const verifier = toBase64Url(crypto.randomBytes(48));
    const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function requestRaw(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const requestOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = https.request(requestOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers || {},
                    body: data
                });
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

async function requestJson(url, options = {}, body = null) {
    const response = await requestRaw(url, options, body);
    let parsed = {};

    if (response.body) {
        try {
            parsed = JSON.parse(response.body);
        } catch (error) {
            throw new Error(`YouTube API yaniti ayrıştırılamadı: ${response.body}`);
        }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
        const apiError = parsed?.error;
        const primaryReason = apiError?.errors?.[0]?.reason || '';
        const message = apiError?.message
            || apiError?.errors?.[0]?.message
            || response.body
            || `HTTP ${response.statusCode}`;
        throw createDetailedYoutubeApiError(message, {
            code: primaryReason || `youtube_http_${response.statusCode}`,
            reason: primaryReason,
            statusCode: response.statusCode,
            apiStatus: apiError?.status || '',
            responseBody: response.body || ''
        });
    }

    return parsed;
}

function getLoopbackRedirectUri(port) {
    return `http://127.0.0.1:${port}/oauth2callback`;
}

async function getChannelInfo(accessToken) {
    const url = `${YOUTUBE_API_BASE}/channels?part=snippet&mine=true`;
    const response = await requestJson(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    const channel = response.items?.[0] || null;
    return channel ? {
        id: channel.id,
        title: channel.snippet?.title || ''
    } : null;
}

async function exchangeAuthCode({ code, redirectUri, codeVerifier, clientId, clientSecret }) {
    const params = new URLSearchParams({
        code,
        client_id: clientId,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    });

    if (clientSecret) {
        params.set('client_secret', clientSecret);
    }

    const tokenResponse = await requestJson(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(params.toString())
        }
    }, params.toString());

    const expiresAt = Date.now() + ((tokenResponse.expires_in || 3600) * 1000);
    const storedToken = {
        ...tokenResponse,
        expires_at: expiresAt
    };
    return storedToken;
}

async function refreshAccessToken(accountId = '') {
    const client = getYoutubeClientConfig();
    const resolvedAccountId = accountId || getActiveYoutubeAccountId();
    const token = getYoutubeToken(resolvedAccountId);

    if (!client.clientId) {
        throw new Error('YouTube OAuth istemci kimligi eksik.');
    }
    if (!token?.refresh_token) {
        throw new Error('YouTube yeniden yenileme anahtari bulunamadi. Hesabi yeniden baglayin.');
    }

    const params = new URLSearchParams({
        client_id: client.clientId,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token
    });

    if (client.clientSecret) {
        params.set('client_secret', client.clientSecret);
    }

    const refreshed = await requestJson(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(params.toString())
        }
    }, params.toString());

    const mergedToken = {
        ...token,
        ...refreshed,
        refresh_token: refreshed.refresh_token || token.refresh_token,
        expires_at: Date.now() + ((refreshed.expires_in || 3600) * 1000)
    };
    saveYoutubeAccount({
        tokenData: mergedToken,
        channel: getYoutubeAccounts().find((account) => account.id === resolvedAccountId)?.channel || null,
        accountId: resolvedAccountId
    });
    return mergedToken.access_token;
}

async function getValidAccessToken(accountId = '') {
    const resolvedAccountId = accountId || getActiveYoutubeAccountId();
    const token = getYoutubeToken(resolvedAccountId);
    if (!token) {
        throw new Error('YouTube hesabi bagli degil.');
    }

    if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60000) {
        return token.access_token;
    }

    return refreshAccessToken(resolvedAccountId);
}

async function youtubeApiRequest({ accessToken, path: apiPath, method = 'GET', query = {}, body = null }) {
    const url = new URL(`${YOUTUBE_API_BASE}${apiPath}`);
    Object.entries(query || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });

    const requestBody = body ? JSON.stringify(body) : null;
    const headers = {
        Authorization: `Bearer ${accessToken}`
    };

    if (requestBody) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(requestBody);
    }

    return requestJson(url.toString(), { method, headers }, requestBody);
}

async function pollBroadcastLive(accessToken, broadcastId, maxAttempts = 12) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const response = await youtubeApiRequest({
            accessToken,
            path: '/liveBroadcasts',
            query: {
                part: 'id,snippet,status,contentDetails',
                id: broadcastId
            }
        });

        const item = response.items?.[0] || null;
        const lifeCycleStatus = item?.status?.lifeCycleStatus || '';
        if (lifeCycleStatus === 'live') {
            return item;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    return null;
}

async function transitionBroadcastIfNeeded(accessToken, broadcastId) {
    const details = await youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts',
        query: {
            part: 'id,snippet,status,contentDetails',
            id: broadcastId
        }
    });

    const item = details.items?.[0] || null;
    if (!item) {
        throw new Error('Secilen YouTube yayini bulunamadi.');
    }

    const status = item.status?.lifeCycleStatus || '';
    if (status === 'live' || status === 'complete') {
        return item;
    }

    if (item.contentDetails?.enableAutoStart) {
        const liveItem = await pollBroadcastLive(accessToken, broadcastId, 8);
        if (liveItem?.status?.lifeCycleStatus === 'live') {
            return liveItem;
        }
        throw new Error('YouTube yayini henuz canli duruma gecmedi. YouTube Studio akisini ve yayin durumunu kontrol edin.');
    }

    const canTest = item.contentDetails?.monitorStream?.enableMonitorStream === true;
    if (canTest && status === 'ready') {
        await youtubeApiRequest({
            accessToken,
            path: '/liveBroadcasts/transition',
            method: 'POST',
            query: {
                part: 'id,snippet,status,contentDetails',
                broadcastStatus: 'testing',
                id: broadcastId
            }
        });
    }

    const transitioned = await youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts/transition',
        method: 'POST',
        query: {
            part: 'id,snippet,status,contentDetails',
            broadcastStatus: 'live',
            id: broadcastId
        }
    });

    if (transitioned?.status?.lifeCycleStatus !== 'live') {
        throw new Error(`YouTube yayin gecisi tamamlanamadi. Durum: ${transitioned?.status?.lifeCycleStatus || 'bilinmiyor'}`);
    }

    return transitioned;
}

async function completeYouTubeBroadcastById(broadcastId) {
    const normalizedBroadcastId = String(broadcastId || '').trim();
    if (!normalizedBroadcastId) {
        return null;
    }

    const accessToken = await getValidAccessToken();
    return youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts/transition',
        method: 'POST',
        query: {
            part: 'id,snippet,status,contentDetails',
            broadcastStatus: 'complete',
            id: normalizedBroadcastId
        }
    });
}

async function completeActiveYouTubeBroadcast() {
    const session = getActiveYouTubeBroadcastSession();
    if (!session?.broadcastId) {
        return {
            success: true,
            completed: false,
            broadcast: null,
            session: null
        };
    }

    const result = await completeYouTubeBroadcastById(session.broadcastId);
    clearActiveYouTubeBroadcastSession();
    return {
        success: true,
        completed: !!result,
        broadcast: result ? formatBroadcastSummary(result) : null,
        session
    };
}

function formatBroadcastSummary(item) {
    const id = item.id;
    return {
        id,
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        scheduledStartTime: item.snippet?.scheduledStartTime || '',
        actualStartTime: item.snippet?.actualStartTime || '',
        privacyStatus: item.status?.privacyStatus || '',
        selfDeclaredMadeForKids: item.status?.selfDeclaredMadeForKids === true,
        lifeCycleStatus: item.status?.lifeCycleStatus || '',
        streamId: item.contentDetails?.boundStreamId || '',
        autoStart: !!item.contentDetails?.enableAutoStart,
        autoStop: !!item.contentDetails?.enableAutoStop,
        watchUrl: id ? `https://www.youtube.com/watch?v=${id}` : '',
        studioUrl: id ? `https://studio.youtube.com/video/${id}/livestreaming` : ''
    };
}

function formatPlaylistSummary(item) {
    return {
        id: item.id,
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        privacyStatus: item.status?.privacyStatus || '',
        itemCount: Number(item.contentDetails?.itemCount || 0)
    };
}

function formatLiveChatMessage(item) {
    const snippet = item?.snippet || {};
    const author = item?.authorDetails || {};
    const text = snippet?.displayMessage || '';
    return {
        id: item?.id || '',
        type: snippet?.type || 'textMessageEvent',
        text,
        publishedAt: snippet?.publishedAt || '',
        authorChannelId: author?.channelId || '',
        authorDisplayName: author?.displayName || '',
        authorProfileImageUrl: author?.profileImageUrl || '',
        isChatModerator: author?.isChatModerator === true,
        isChatOwner: author?.isChatOwner === true,
        isChatSponsor: author?.isChatSponsor === true,
        isVerified: author?.isVerified === true,
        canDelete: snippet?.type === 'textMessageEvent'
    };
}

function getYoutubeLiveChatStreamFactory() {
    if (youtubeLiveChatStreamStubFactory) {
        return youtubeLiveChatStreamStubFactory;
    }

    const packageDefinition = protoLoader.loadSync(YOUTUBE_STREAM_PROTO, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true
    });
    const proto = grpc.loadPackageDefinition(packageDefinition);
    const ServiceCtor = proto?.youtube?.api?.v3?.V3DataLiveChatMessageService;
    if (!ServiceCtor) {
        throw new Error('YouTube live chat stream istemcisi yüklenemedi.');
    }

    youtubeLiveChatStreamStubFactory = () => new ServiceCtor(
        'youtube.googleapis.com:443',
        grpc.credentials.createSsl()
    );
    return youtubeLiveChatStreamStubFactory;
}

function mapStreamSnippetTypeToRestType(typeValue) {
    const normalized = String(typeValue || '').trim().toUpperCase();
    const mapping = {
        TEXT_MESSAGE_EVENT: 'textMessageEvent',
        TOMBSTONE: 'tombstone',
        FAN_FUNDING_EVENT: 'fanFundingEvent',
        CHAT_ENDED_EVENT: 'chatEndedEvent',
        SPONSOR_ONLY_MODE_STARTED_EVENT: 'sponsorOnlyModeStartedEvent',
        SPONSOR_ONLY_MODE_ENDED_EVENT: 'sponsorOnlyModeEndedEvent',
        NEW_SPONSOR_EVENT: 'newSponsorEvent',
        MEMBER_MILESTONE_CHAT_EVENT: 'memberMilestoneChatEvent',
        MEMBERSHIP_GIFTING_EVENT: 'membershipGiftingEvent',
        GIFT_MEMBERSHIP_RECEIVED_EVENT: 'giftMembershipReceivedEvent',
        MESSAGE_DELETED_EVENT: 'messageDeletedEvent',
        MESSAGE_RETRACTED_EVENT: 'messageRetractedEvent',
        USER_BANNED_EVENT: 'userBannedEvent',
        SUPER_CHAT_EVENT: 'superChatEvent',
        SUPER_STICKER_EVENT: 'superStickerEvent',
        POLL_EVENT: 'pollEvent',
        GIFT_EVENT: 'giftEvent'
    };
    return mapping[normalized] || 'textMessageEvent';
}

function formatLiveChatMessageFromStream(item) {
    const snippet = item?.snippet || {};
    const author = item?.authorDetails || item?.author_details || {};
    const restType = mapStreamSnippetTypeToRestType(snippet?.type);
    const text = snippet?.displayMessage || snippet?.textMessageDetails?.messageText || snippet?.text_message_details?.message_text || '';
    return {
        id: item?.id || '',
        type: restType,
        text,
        publishedAt: snippet?.publishedAt || snippet?.published_at || '',
        authorChannelId: author?.channelId || author?.channel_id || snippet?.authorChannelId || snippet?.author_channel_id || '',
        authorDisplayName: author?.displayName || author?.display_name || '',
        authorProfileImageUrl: author?.profileImageUrl || author?.profile_image_url || '',
        isChatModerator: author?.isChatModerator === true || author?.is_chat_moderator === true,
        isChatOwner: author?.isChatOwner === true || author?.is_chat_owner === true,
        isChatSponsor: author?.isChatSponsor === true || author?.is_chat_sponsor === true,
        isVerified: author?.isVerified === true || author?.is_verified === true,
        canDelete: restType === 'textMessageEvent'
    };
}

function createLocalLiveChatStreamPageToken(sequence) {
    return `stream:${Math.max(0, Number(sequence) || 0)}`;
}

function parseLocalLiveChatStreamPageToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized.startsWith('stream:')) {
        return 0;
    }
    const value = Number.parseInt(normalized.slice(7), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function createYoutubeStreamSessionError(message, code = 'youtube_chat_stream_failed', details = {}) {
    return createDetailedYoutubeApiError(message, { code, ...details });
}

function cleanupInactiveLiveChatStreamSessions() {
    const now = Date.now();
    for (const [liveChatId, session] of LIVE_CHAT_STREAM_SESSION_CACHE.entries()) {
        if (!session) continue;
        if (session.stopped) {
            LIVE_CHAT_STREAM_SESSION_CACHE.delete(liveChatId);
            continue;
        }
        if ((now - (session.lastAccessAt || 0)) < LIVE_CHAT_STREAM_IDLE_MS) {
            continue;
        }
        try {
            session.stopped = true;
            if (session.restartTimer) {
                clearTimeout(session.restartTimer);
            }
            session.call?.cancel?.();
            session.client?.close?.();
        } catch (error) {
            // Ignore cleanup errors.
        }
        LIVE_CHAT_STREAM_SESSION_CACHE.delete(liveChatId);
    }
}

function notifyLiveChatStreamWaiters(session) {
    const waiters = Array.isArray(session.waiters) ? session.waiters.splice(0) : [];
    waiters.forEach((resolve) => {
        try {
            resolve();
        } catch (error) {
            // Ignore waiter resolution errors.
        }
    });
}

async function waitForLiveChatStreamWarmup(session, timeoutMs = 1200) {
    if (!session || session.initialized || session.error) {
        return;
    }
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        session.waiters = Array.isArray(session.waiters) ? session.waiters : [];
        session.waiters.push(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function openYouTubeLiveChatStream(session) {
    if (!session || session.stopped) {
        return;
    }

    const createStub = getYoutubeLiveChatStreamFactory();
    const accessToken = await getValidAccessToken(session.accountId || '');
    session.client = createStub();
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${accessToken}`);

    const request = {
        liveChatId: session.liveChatId,
        part: ['id', 'snippet', 'authorDetails'],
        pageToken: session.remoteNextPageToken || '',
        maxResults: 200
    };

    session.call = session.client.StreamList(request, metadata);
    session.call.on('data', (response) => {
        session.lastAccessAt = Date.now();
        session.initialized = true;
        session.error = null;
        if (response?.nextPageToken) {
            session.remoteNextPageToken = response.nextPageToken;
        }
        if (response?.offlineAt) {
            session.ended = true;
        }

        const incoming = Array.isArray(response?.items) ? response.items : [];
        for (const item of incoming) {
            const formatted = formatLiveChatMessageFromStream(item);
            if (!formatted.id || session.messageIds.has(formatted.id)) {
                continue;
            }
            session.messageIds.add(formatted.id);
            session.sequence += 1;
            session.messages.push({
                ...formatted,
                _streamSequence: session.sequence
            });
        }

        if (session.messages.length > LIVE_CHAT_STREAM_MAX_BUFFER) {
            const overflow = session.messages.splice(0, session.messages.length - LIVE_CHAT_STREAM_MAX_BUFFER);
            overflow.forEach((item) => {
                if (item?.id) {
                    session.messageIds.delete(item.id);
                }
            });
        }

        notifyLiveChatStreamWaiters(session);
    });

    session.call.on('error', (error) => {
        if (session.stopped) {
            return;
        }
        const details = typeof error?.details === 'string' ? error.details : (error?.message || 'Bilinmeyen stream hatası');
        session.error = createYoutubeStreamSessionError(details, 'youtube_chat_stream_failed', {
            statusCode: Number(error?.code || 0) || 0,
            responseBody: details
        });
        notifyLiveChatStreamWaiters(session);
    });

    session.call.on('end', () => {
        if (session.stopped) {
            notifyLiveChatStreamWaiters(session);
            return;
        }
        notifyLiveChatStreamWaiters(session);
        if (session.ended || !session.remoteNextPageToken) {
            return;
        }
        if (session.restartTimer) {
            clearTimeout(session.restartTimer);
        }
        session.restartTimer = setTimeout(() => {
            openYouTubeLiveChatStream(session).catch((error) => {
                session.error = createYoutubeStreamSessionError(
                    error?.message || 'YouTube chat stream yeniden bağlanamadı.',
                    error?.code || 'youtube_chat_stream_failed',
                    {
                        statusCode: error?.statusCode || 0,
                        reason: error?.reason || '',
                        responseBody: error?.responseBody || ''
                    }
                );
                notifyLiveChatStreamWaiters(session);
            });
        }, LIVE_CHAT_STREAM_RETRY_MS);
    });
}

async function getOrCreateLiveChatStreamSession(liveChatId, accountId = '') {
    cleanupInactiveLiveChatStreamSessions();
    const normalizedLiveChatId = String(liveChatId || '').trim();
    if (!normalizedLiveChatId) {
        throw new Error('Canli sohbet kimligi eksik.');
    }

    let session = LIVE_CHAT_STREAM_SESSION_CACHE.get(normalizedLiveChatId);
    if (!session) {
        session = {
            liveChatId: normalizedLiveChatId,
            accountId: accountId || getActiveYoutubeAccountId() || '',
            client: null,
            call: null,
            restartTimer: null,
            remoteNextPageToken: '',
            messages: [],
            messageIds: new Set(),
            sequence: 0,
            lastAccessAt: Date.now(),
            waiters: [],
            initialized: false,
            ended: false,
            stopped: false,
            error: null
        };
        LIVE_CHAT_STREAM_SESSION_CACHE.set(normalizedLiveChatId, session);
        openYouTubeLiveChatStream(session).catch((error) => {
            session.error = createYoutubeStreamSessionError(
                error?.message || 'YouTube chat stream başlatılamadı.',
                error?.code || 'youtube_chat_stream_failed',
                {
                    statusCode: error?.statusCode || 0,
                    reason: error?.reason || '',
                    responseBody: error?.responseBody || ''
                }
            );
            notifyLiveChatStreamWaiters(session);
        });
    }

    session.lastAccessAt = Date.now();
    await waitForLiveChatStreamWarmup(session);
    return session;
}

async function listLiveChatMessagesViaStream(liveChatId, pageToken = '', accountId = '') {
    const session = await getOrCreateLiveChatStreamSession(liveChatId, accountId);
    if (session.error && session.messages.length === 0) {
        throw session.error;
    }

    const afterSequence = parseLocalLiveChatStreamPageToken(pageToken);
    const messages = session.messages
        .filter((item) => Number(item?._streamSequence || 0) > afterSequence)
        .map(({ _streamSequence, ...rest }) => rest);

    return {
        nextPageToken: createLocalLiveChatStreamPageToken(session.sequence),
        pollingIntervalMillis: LIVE_CHAT_STREAM_LOCAL_POLL_MS,
        messages
    };
}

function extractJsonValueFromHtml(html, marker) {
    const source = String(html || '');
    const index = source.indexOf(marker);
    if (index < 0) return null;

    let start = index + marker.length;
    while (start < source.length && /\s/.test(source[start])) {
        start += 1;
    }
    if (source[start] !== '{' && source[start] !== '[') {
        return null;
    }

    const openChar = source[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === openChar) {
            depth += 1;
        } else if (ch === closeChar) {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, i + 1);
            }
        }
    }

    return null;
}

function extractJsonValueFromMarkers(html, markers = []) {
    for (const marker of Array.isArray(markers) ? markers : []) {
        const value = extractJsonValueFromHtml(html, marker);
        if (value) {
            return value;
        }
    }
    return null;
}

function extractPlayerResponseFromHtml(html) {
    const playerResponseJson = extractJsonValueFromMarkers(html, [
        'var ytInitialPlayerResponse = ',
        'window["ytInitialPlayerResponse"] = ',
        "window['ytInitialPlayerResponse'] = ",
        'ytInitialPlayerResponse = '
    ]);

    if (!playerResponseJson) {
        return null;
    }

    try {
        return JSON.parse(playerResponseJson);
    } catch (error) {
        return null;
    }
}

function findLiveChatContinuationRoot(node, seen = new Set()) {
    if (!node || typeof node !== 'object') {
        return null;
    }
    if (seen.has(node)) {
        return null;
    }
    seen.add(node);

    if (node.liveChatContinuation && typeof node.liveChatContinuation === 'object') {
        return node.liveChatContinuation;
    }
    if (node.continuationContents?.liveChatContinuation && typeof node.continuationContents.liveChatContinuation === 'object') {
        return node.continuationContents.liveChatContinuation;
    }
    if (node.liveChatRenderer && typeof node.liveChatRenderer === 'object') {
        return node.liveChatRenderer;
    }
    if (node.conversationBar?.liveChatRenderer && typeof node.conversationBar.liveChatRenderer === 'object') {
        return node.conversationBar.liveChatRenderer;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findLiveChatContinuationRoot(item, seen);
            if (found) {
                return found;
            }
        }
        return null;
    }

    for (const value of Object.values(node)) {
        const found = findLiveChatContinuationRoot(value, seen);
        if (found) {
            return found;
        }
    }

    return null;
}

function extractInnertubeBootstrapFromHtml(html) {
    const source = String(html || '');
    const apiKeyMatch = source.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const clientVersionMatch = source.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
    const playerResponse = extractPlayerResponseFromHtml(source);
    const initialDataJson = extractJsonValueFromMarkers(source, [
        'var ytInitialData = ',
        'window["ytInitialData"] = ',
        "window['ytInitialData'] = ",
        'ytInitialData = '
    ]);

    if (!initialDataJson) {
        return {
            ok: false,
            stage: 'initial_data_missing',
            apiKey: apiKeyMatch ? apiKeyMatch[1] : '',
            clientVersion: clientVersionMatch ? clientVersionMatch[1] : '',
            playerResponse
        };
    }

    const initialData = JSON.parse(initialDataJson);
    const continuationRoot = findLiveChatContinuationRoot(initialData);
    const continuation = extractPublicChatContinuation(continuationRoot?.continuations || []);

    return {
        ok: Boolean(continuationRoot && continuation),
        stage: continuationRoot ? 'continuation_missing' : 'continuation_root_missing',
        apiKey: apiKeyMatch ? apiKeyMatch[1] : '',
        clientVersion: clientVersionMatch ? clientVersionMatch[1] : '',
        title: (source.match(/<title>([^<]+)<\/title>/i)?.[1] || '').replace(/\s*-\s*YouTube\s*$/i, '').trim(),
        playerResponse,
        continuationRoot,
        continuation
    };
}

function classifyPublicLiveChatFailure(bootstrapData = null) {
    const playerResponse = bootstrapData?.playerResponse || null;
    const videoDetails = playerResponse?.videoDetails || {};
    const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};
    const liveDetails = microformat?.liveBroadcastDetails || {};
    const isLiveNow = liveDetails?.isLiveNow === true;
    const hasEnded = Boolean(liveDetails?.endTimestamp);
    const isLiveContent = videoDetails?.isLiveContent === true || videoDetails?.isLive === true;

    if (hasEnded) {
        return {
            code: 'youtube_live_chat_broadcast_ended',
            message: 'Bu YouTube yayını sona ermiş görünüyor.'
        };
    }

    if (!isLiveNow && !isLiveContent) {
        return {
            code: 'youtube_video_not_live',
            message: 'Bu YouTube bağlantısı şu anda canlı yayında görünmüyor.'
        };
    }

    if (isLiveNow || isLiveContent) {
        return {
            code: 'youtube_live_chat_disabled',
            message: 'Bu canlı yayında sohbet kapalı veya herkese açık değil.'
        };
    }

    return {
        code: 'youtube_live_chat_not_found',
        message: 'YouTube canlı sohbet verileri alınamadı.'
    };
}

function parsePublicChatText(value) {
    if (!value) return '';
    if (typeof value.simpleText === 'string') {
        return value.simpleText;
    }
    if (Array.isArray(value.runs)) {
        return value.runs.map((item) => item.text || '').join('');
    }
    return '';
}

function extractPublicChatContinuation(continuations = []) {
    for (const item of Array.isArray(continuations) ? continuations : []) {
        const candidate = item?.timedContinuationData?.continuation
            || item?.invalidationContinuationData?.continuation
            || item?.reloadContinuationData?.continuation
            || item?.liveChatReplayContinuationData?.continuation
            || '';
        if (candidate) {
            return candidate;
        }
    }
    return '';
}

function parsePublicLiveChatActions(actions = []) {
    const messages = [];

    (Array.isArray(actions) ? actions : []).forEach((action) => {
        const item = action?.addChatItemAction?.item
            || action?.addLiveChatTickerItemAction?.item
            || null;
        if (!item) {
            return;
        }

        const renderer = item.liveChatTextMessageRenderer
            || item.liveChatPaidMessageRenderer
            || item.liveChatPaidStickerRenderer
            || item.liveChatMembershipItemRenderer
            || item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
            || item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
            || null;

        if (!renderer) {
            return;
        }

        const badges = Array.isArray(renderer.authorBadges) ? renderer.authorBadges : [];
        const badgeLabels = badges
            .map((badge) => parsePublicChatText(badge?.liveChatAuthorBadgeRenderer?.customThumbnail?.accessibility?.accessibilityData?.label)
                || parsePublicChatText(badge?.liveChatAuthorBadgeRenderer?.tooltip)
                || '')
            .join(' ')
            .toLowerCase();

        messages.push({
            id: renderer.id || '',
            type: 'textMessageEvent',
            text: parsePublicChatText(renderer.message) || parsePublicChatText(renderer.purchaseAmountText) || '',
            publishedAt: String(renderer.timestampUsec || ''),
            authorChannelId: renderer.authorExternalChannelId || '',
            authorDisplayName: parsePublicChatText(renderer.authorName) || '',
            authorProfileImageUrl: renderer.authorPhoto?.thumbnails?.[0]?.url || '',
            isChatModerator: badgeLabels.includes('moderator'),
            isChatOwner: badgeLabels.includes('owner'),
            isChatSponsor: badgeLabels.includes('member') || badgeLabels.includes('sponsor'),
            isVerified: badgeLabels.includes('verified'),
            canDelete: false
        });
    });

    return messages;
}

async function fetchPublicLiveChatBootstrap(videoId) {
    const candidateUrls = [
        {
            label: 'live_chat',
            url: `${YOUTUBE_LIVE_CHAT_BASE}?is_popout=1&v=${encodeURIComponent(videoId)}`
        },
        {
            label: 'watch',
            url: `${YOUTUBE_WATCH_BASE}?v=${encodeURIComponent(videoId)}`
        }
    ];

    let lastFailureStage = 'unknown';
    let lastFailureStatusCode = 0;
    let bootstrapData = null;
    let lastParsedFailure = null;

    for (const candidate of candidateUrls) {
        const response = await requestRaw(candidate.url, {
            headers: {
                ...YOUTUBE_DESKTOP_HEADERS
            }
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            lastFailureStage = `${candidate.label}_http_${response.statusCode}`;
            lastFailureStatusCode = response.statusCode || 0;
            continue;
        }

        const parsed = extractInnertubeBootstrapFromHtml(String(response.body || ''));
        if (!parsed.ok) {
            lastFailureStage = `${candidate.label}_${parsed.stage || 'parse_failed'}`;
            lastParsedFailure = parsed;
            continue;
        }

        bootstrapData = parsed;
        break;
    }

    if (!bootstrapData) {
        const classifiedFailure = classifyPublicLiveChatFailure(lastParsedFailure);
        console.warn('[YouTube] Public live chat bootstrap failed.', {
            videoId,
            lastFailureStage,
            lastFailureStatusCode,
            classifiedErrorCode: classifiedFailure.code
        });
        throw createYoutubeHandlerError(classifiedFailure.message, classifiedFailure.code);
    }

    const {
        apiKey = '',
        clientVersion = '',
        title = '',
        continuationRoot = null,
        continuation = ''
    } = bootstrapData;

    if (!apiKey || !clientVersion) {
        console.warn('[YouTube] Public live chat bootstrap missing innertube client info.', {
            videoId,
            hasApiKey: Boolean(apiKey),
            hasClientVersion: Boolean(clientVersion)
        });
        throw createYoutubeHandlerError('YouTube canlı sohbet istemci bilgileri alınamadı.', 'youtube_live_chat_not_found');
    }

    const payload = {
        videoId,
        apiKey,
        clientVersion,
        continuation
    };
    PUBLIC_CHAT_SESSION_CACHE.set(videoId, payload);

    return {
        payload,
        title,
        messages: parsePublicLiveChatActions(continuationRoot?.actions || []),
        pollingIntervalMillis: Number(continuationRoot?.pollingIntervalMillis || 5000)
    };
}

async function getPublicLiveChatSessionFromVideoUrl(inputUrl) {
    const videoId = extractYouTubeVideoId(inputUrl);
    if (!videoId) {
        throw createYoutubeHandlerError('YouTube bağlantısından geçerli bir video kimliği alınamadı.', 'invalid_youtube_url');
    }

    const bootstrap = await fetchPublicLiveChatBootstrap(videoId);
    return {
        broadcast: {
            id: videoId,
            title: bootstrap.title || '',
            description: '',
            watchUrl: `${YOUTUBE_WATCH_BASE}?v=${videoId}`,
            lifeCycleStatus: 'live'
        },
        liveChatId: `public:${videoId}`
    };
}

async function listPublicLiveChatMessages(videoId, pageToken = '') {
    const cached = PUBLIC_CHAT_SESSION_CACHE.get(videoId) || null;
    const bootstrap = (!cached || !pageToken)
        ? await fetchPublicLiveChatBootstrap(videoId)
        : null;
    const session = bootstrap?.payload || cached;

    if (!session?.apiKey || !session?.clientVersion) {
        throw createYoutubeHandlerError('YouTube sohbet oturumu hazırlanamadı.', 'youtube_live_chat_not_found');
    }

    if (!pageToken) {
        return {
            nextPageToken: session.continuation || '',
            pollingIntervalMillis: bootstrap?.pollingIntervalMillis || 5000,
            messages: bootstrap?.messages || []
        };
    }

    const requestBody = JSON.stringify({
        context: {
            client: {
                clientName: 'WEB',
                clientVersion: session.clientVersion
            }
        },
        continuation: pageToken
    });

    const response = await requestJson(`${YOUTUBE_INNERTUBE_BASE}?key=${encodeURIComponent(session.apiKey)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
            ...YOUTUBE_DESKTOP_HEADERS,
            'Origin': 'https://www.youtube.com',
            'Referer': `${YOUTUBE_WATCH_BASE}?v=${encodeURIComponent(videoId)}`
        }
    }, requestBody);

    const liveChatContinuation = response?.continuationContents?.liveChatContinuation || {};
    const continuation = extractPublicChatContinuation(liveChatContinuation?.continuations || []);
    PUBLIC_CHAT_SESSION_CACHE.set(videoId, {
        ...session,
        continuation: continuation || session.continuation
    });

    return {
        nextPageToken: continuation || '',
        pollingIntervalMillis: Number(liveChatContinuation?.pollingIntervalMillis || 5000),
        messages: parsePublicLiveChatActions(liveChatContinuation?.actions || [])
    };
}

async function getBroadcastDetails(accessToken, broadcastId) {
    if (!broadcastId) {
        throw new Error('YouTube yayin kimligi eksik.');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts',
        query: {
            part: 'id,snippet,status,contentDetails',
            id: broadcastId
        }
    });

    return response.items?.[0] || null;
}

async function getLiveChatSession(accessToken, broadcastId) {
    const broadcast = await getBroadcastDetails(accessToken, broadcastId);
    if (!broadcast) {
        throw new Error('Secilen YouTube yayini bulunamadi.');
    }

    const liveChatId = broadcast?.snippet?.liveChatId || '';
    if (!liveChatId) {
        throw new Error('Bu YouTube yayini icin canli sohbet kimligi bulunamadi.');
    }

    return {
        broadcast: formatBroadcastSummary(broadcast),
        liveChatId
    };
}

function extractYouTubeVideoId(input = '') {
    const raw = String(input || '').trim();
    if (!raw) {
        return '';
    }

    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
        return raw;
    }

    try {
        const parsed = new URL(raw);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === 'youtu.be') {
            const parts = parsed.pathname.split('/').filter(Boolean);
            return parts[0] || '';
        }
        const watchId = parsed.searchParams.get('v');
        if (watchId) {
            return watchId;
        }
        const parts = parsed.pathname.split('/').filter(Boolean);
        const liveIndex = parts.findIndex((part) => part === 'live');
        if (liveIndex >= 0 && parts[liveIndex + 1]) {
            return parts[liveIndex + 1];
        }
        if (parts[0] === 'watch' && parts[1]) {
            return parts[1];
        }
    } catch (error) {
        return '';
    }

    return '';
}

function extractYouTubeChannelReference(input = '') {
    const raw = String(input || '').trim();
    if (!raw) {
        return { type: '', value: '' };
    }

    if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) {
        return { type: 'channelId', value: raw };
    }

    if (raw.startsWith('@')) {
        return { type: 'handle', value: raw.slice(1) };
    }

    try {
        const parsed = new URL(raw);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) {
            return { type: 'channelId', value: parts[1] };
        }
        if (parts[0] === 'user' && parts[1]) {
            return { type: 'username', value: parts[1] };
        }
        if (parts[0] && parts[0].startsWith('@')) {
            return { type: 'handle', value: parts[0].slice(1) };
        }
        if (parts[0] === 'c' && parts[1]) {
            return { type: 'search', value: parts[1] };
        }
    } catch (error) {
        return { type: '', value: '' };
    }

    return { type: 'search', value: raw };
}

async function resolveYouTubeChannelId(accessToken, input) {
    const normalizedInput = String(input || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedInput)) {
        throw createYoutubeHandlerError('Yalnızca kanal bağlantısı, @kullanıcı adı veya kanal kimliği kullanılabilir.', 'youtube_channel_email_not_supported');
    }

    const ref = extractYouTubeChannelReference(input);
    if (!ref.type || !ref.value) {
        throw createYoutubeHandlerError('Geçerli bir kanal bağlantısı veya kanal kimliği bulunamadı.', 'youtube_channel_not_found');
    }

    if (ref.type === 'channelId') {
        return ref.value;
    }

    if (ref.type === 'username') {
        const response = await youtubeApiRequest({
            accessToken,
            path: '/channels',
            query: {
                part: 'id',
                forUsername: ref.value
            }
        });
        const channelId = response.items?.[0]?.id || '';
        if (channelId) {
            return channelId;
        }
    }

    if (ref.type === 'handle') {
        try {
            const response = await youtubeApiRequest({
                accessToken,
                path: '/channels',
                query: {
                    part: 'id',
                    forHandle: ref.value
                }
            });
            const channelId = response.items?.[0]?.id || '';
            if (channelId) {
                return channelId;
            }
        } catch (error) {
            // Fallback to search below if the API version/account does not support forHandle.
        }
    }

    const query = ref.type === 'handle' ? `@${ref.value}` : ref.value;
    const searchResponse = await youtubeApiRequest({
        accessToken,
        path: '/search',
        query: {
            part: 'snippet',
            type: 'channel',
            q: query,
            maxResults: '5'
        }
    });

    const items = searchResponse.items || [];
    const exactMatch = items.find((item) => {
        const title = String(item?.snippet?.title || '').trim().toLowerCase();
        return title === String(ref.value || '').trim().toLowerCase() || title === `@${String(ref.value || '').trim().toLowerCase()}`;
    });
    const channelId = exactMatch?.snippet?.channelId || items[0]?.snippet?.channelId || '';
    if (!channelId) {
        throw createYoutubeHandlerError('Belirtilen moderatör kanalı bulunamadı.', 'youtube_channel_not_found');
    }
    return channelId;
}

function formatLiveChatModerator(item = {}) {
    const details = item?.snippet?.moderatorDetails || {};
    return {
        id: item.id || details.channelId || '',
        channelId: details.channelId || '',
        displayName: details.displayName || '',
        channelUrl: details.channelUrl || ''
    };
}

async function getLiveChatSessionFromVideoUrl(accessToken, inputUrl) {
    const videoId = extractYouTubeVideoId(inputUrl);
    if (!videoId) {
        throw createYoutubeHandlerError('YouTube bağlantısından geçerli bir video kimliği alınamadı.', 'invalid_youtube_url');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/videos',
        query: {
            part: 'id,snippet,liveStreamingDetails,status',
            id: videoId
        }
    });

    const item = response.items?.[0] || null;
    if (!item) {
        throw createYoutubeHandlerError('Belirtilen YouTube videosu bulunamadı.', 'youtube_video_not_found');
    }

    const liveChatId = item?.liveStreamingDetails?.activeLiveChatId || '';
    if (!liveChatId) {
        throw createYoutubeHandlerError('Bu YouTube bağlantısında etkin canlı sohbet bulunamadı.', 'youtube_live_chat_not_found');
    }

    return {
        broadcast: {
            id: item.id || videoId,
            title: item.snippet?.title || '',
            description: item.snippet?.description || '',
            watchUrl: item.id ? `https://www.youtube.com/watch?v=${item.id}` : String(inputUrl || '').trim(),
            lifeCycleStatus: item.snippet?.liveBroadcastContent || ''
        },
        liveChatId
    };
}

async function getLiveBroadcastVideoStats(accessToken, { broadcastId = '', videoId = '', watchUrl = '' } = {}) {
    const normalizedVideoId = String(videoId || broadcastId || extractYouTubeVideoId(watchUrl) || '').trim();
    if (!normalizedVideoId) {
        throw createYoutubeHandlerError('YouTube yayin video kimligi eksik.', 'youtube_video_id_missing');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/videos',
        query: {
            part: 'id,snippet,statistics,liveStreamingDetails,status',
            id: normalizedVideoId
        }
    });

    const item = response.items?.[0] || null;
    if (!item) {
        throw createYoutubeHandlerError('Belirtilen YouTube videosu bulunamadı.', 'youtube_video_not_found');
    }

    const statistics = item.statistics || {};
    const liveDetails = item.liveStreamingDetails || {};

    return {
        videoId: item.id || normalizedVideoId,
        title: item.snippet?.title || '',
        watchUrl: item.id ? `https://www.youtube.com/watch?v=${item.id}` : '',
        liveBroadcastContent: item.snippet?.liveBroadcastContent || '',
        lifeCycleStatus: item.status?.uploadStatus || '',
        concurrentViewers: liveDetails.concurrentViewers ?? '',
        actualStartTime: liveDetails.actualStartTime || '',
        actualEndTime: liveDetails.actualEndTime || '',
        scheduledStartTime: liveDetails.scheduledStartTime || '',
        viewCount: statistics.viewCount ?? '',
        likeCount: statistics.likeCount ?? '',
        commentCount: statistics.commentCount ?? '',
        updatedAt: new Date().toISOString()
    };
}

async function listLiveChatMessages(accessToken, liveChatId, pageToken = '') {
    if (!liveChatId) {
        throw new Error('Canli sohbet kimligi eksik.');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveChat/messages',
        query: {
            part: 'id,snippet,authorDetails',
            liveChatId,
            maxResults: '50',
            ...(pageToken ? { pageToken } : {})
        }
    });

    return {
        nextPageToken: response?.nextPageToken || '',
        pollingIntervalMillis: Number(response?.pollingIntervalMillis || 5000),
        messages: (response?.items || []).map(formatLiveChatMessage)
    };
}

async function insertLiveChatMessage(accessToken, liveChatId, text) {
    if (!liveChatId) {
        throw new Error('Canli sohbet kimligi eksik.');
    }

    const messageText = String(text || '').trim();
    if (!messageText) {
        throw new Error('Gonderilecek mesaj bos olamaz.');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveChat/messages',
        method: 'POST',
        query: {
            part: 'id,snippet,authorDetails'
        },
        body: {
            snippet: {
                liveChatId,
                type: 'textMessageEvent',
                textMessageDetails: {
                    messageText
                }
            }
        }
    });

    return formatLiveChatMessage(response);
}

async function deleteLiveChatMessage(accessToken, messageId) {
    if (!messageId) {
        throw new Error('Silinecek sohbet mesaji kimligi eksik.');
    }

    await youtubeApiRequest({
        accessToken,
        path: '/liveChat/messages',
        method: 'DELETE',
        query: {
            id: messageId
        }
    });

    return { success: true };
}

async function insertLiveChatBan(accessToken, liveChatId, channelId, durationSeconds = null) {
    const trimmedLiveChatId = String(liveChatId || '').trim();
    const trimmedChannelId = String(channelId || '').trim();
    if (!trimmedLiveChatId) {
        throw new Error('Canli sohbet kimligi eksik.');
    }
    if (!trimmedChannelId) {
        throw new Error('Yasaklanacak kanal kimligi eksik.');
    }

    const isTemporary = Number.isFinite(durationSeconds) && durationSeconds > 0;
    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveChat/bans',
        method: 'POST',
        query: {
            part: 'id,snippet'
        },
        body: {
            snippet: {
                liveChatId: trimmedLiveChatId,
                type: isTemporary ? 'temporary' : 'permanent',
                bannedUserDetails: {
                    channelId: trimmedChannelId
                },
                ...(isTemporary
                    ? {
                        banDurationSeconds: Math.max(1, Math.floor(durationSeconds))
                    }
                    : {})
            }
        }
    });

    return {
        id: response?.id || '',
        channelId: response?.snippet?.bannedUserDetails?.channelId || trimmedChannelId,
        type: response?.snippet?.type || (isTemporary ? 'temporary' : 'permanent'),
        banDurationSeconds: Number(response?.snippet?.banDurationSeconds || durationSeconds || 0)
    };
}

async function deleteLiveChatBan(accessToken, banId) {
    const trimmedBanId = String(banId || '').trim();
    if (!trimmedBanId) {
        throw new Error('Kaldirilacak yasak kimligi eksik.');
    }

    await youtubeApiRequest({
        accessToken,
        path: '/liveChat/bans',
        method: 'DELETE',
        query: {
            id: trimmedBanId
        }
    });

    return { success: true };
}

async function listLiveChatModerators(accessToken, liveChatId) {
    const trimmedLiveChatId = String(liveChatId || '').trim();
    if (!trimmedLiveChatId) {
        throw new Error('Canlı sohbet kimliği eksik.');
    }

    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveChat/moderators',
        query: {
            part: 'id,snippet',
            liveChatId: trimmedLiveChatId,
            maxResults: '50'
        }
    });

    return (response.items || []).map(formatLiveChatModerator);
}

async function insertLiveChatModerator(accessToken, liveChatId, moderatorInput) {
    const trimmedLiveChatId = String(liveChatId || '').trim();
    if (!trimmedLiveChatId) {
        throw new Error('Canlı sohbet kimliği eksik.');
    }

    const channelId = await resolveYouTubeChannelId(accessToken, moderatorInput);
    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveChat/moderators',
        method: 'POST',
        query: {
            part: 'id,snippet'
        },
        body: {
            snippet: {
                liveChatId: trimmedLiveChatId,
                moderatorDetails: {
                    channelId
                }
            }
        }
    });

    return formatLiveChatModerator(response);
}

async function deleteLiveChatModerator(accessToken, moderatorId) {
    const trimmedModeratorId = String(moderatorId || '').trim();
    if (!trimmedModeratorId) {
        throw new Error('Kaldırılacak moderatör kimliği eksik.');
    }

    await youtubeApiRequest({
        accessToken,
        path: '/liveChat/moderators',
        method: 'DELETE',
        query: {
            id: trimmedModeratorId
        }
    });

    return { success: true };
}

async function listPlannedBroadcasts(accessToken) {
    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts',
        query: {
            part: 'id,snippet,status,contentDetails',
            mine: 'true',
            maxResults: '50'
        }
    });

    return (response.items || [])
        .filter((item) => {
            const lifeCycleStatus = item.status?.lifeCycleStatus || '';
            const scheduledStartTime = item.snippet?.scheduledStartTime || '';
            const hasSchedule = !!scheduledStartTime;
            const hasActualStart = !!item.snippet?.actualStartTime;
            return hasSchedule
                && !hasActualStart
                && lifeCycleStatus !== 'live'
                && lifeCycleStatus !== 'complete'
                && lifeCycleStatus !== 'revoked';
        })
        .map(formatBroadcastSummary)
        .sort((a, b) => String(a.scheduledStartTime || '').localeCompare(String(b.scheduledStartTime || '')));
}

async function listPlaylists(accessToken) {
    const response = await youtubeApiRequest({
        accessToken,
        path: '/playlists',
        query: {
            part: 'id,snippet,status,contentDetails',
            mine: 'true',
            maxResults: '50'
        }
    });

    return (response.items || [])
        .map(formatPlaylistSummary)
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}

async function createLiveStream(accessToken, title, isReusable = false) {
    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveStreams',
        method: 'POST',
        query: {
            part: 'snippet,cdn,contentDetails,status'
        },
        body: {
            snippet: {
                title
            },
            cdn: {
                ingestionType: 'rtmp',
                frameRate: 'variable',
                resolution: 'variable'
            },
            contentDetails: {
                isReusable
            }
        }
    });

    return response;
}

async function createLiveBroadcast(accessToken, {
    title,
    description,
    privacyStatus,
    scheduledStartTime,
    enableAutoStart = true,
    enableAutoStop = true,
    madeForKids = false
}) {
    return youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts',
        method: 'POST',
        query: {
            part: 'snippet,status,contentDetails'
        },
        body: {
            snippet: {
                title,
                description,
                scheduledStartTime
            },
            status: {
                privacyStatus,
                selfDeclaredMadeForKids: madeForKids === true
            },
            contentDetails: {
                enableAutoStart,
                enableAutoStop,
                monitorStream: {
                    enableMonitorStream: false
                },
                recordFromStart: true,
                startWithSlate: false
            }
        }
    });
}

async function addBroadcastToPlaylist(accessToken, { broadcastId, playlistId }) {
    if (!broadcastId || !playlistId) {
        return { skipped: true };
    }

    try {
        const response = await youtubeApiRequest({
            accessToken,
            path: '/playlistItems',
            method: 'POST',
            query: {
                part: 'snippet'
            },
            body: {
                snippet: {
                    playlistId,
                    resourceId: {
                        kind: 'youtube#video',
                        videoId: broadcastId
                    }
                }
            }
        });
        return {
            success: true,
            itemId: response.id || ''
        };
    } catch (error) {
        const message = error.message || '';
        const normalized = message.toLowerCase();
        if (normalized.includes('already') || normalized.includes('duplicate')) {
            return {
                success: true,
                alreadyExists: true
            };
        }
        throw error;
    }
}

async function bindBroadcastToStream(accessToken, broadcastId, streamId) {
    return youtubeApiRequest({
        accessToken,
        path: '/liveBroadcasts/bind',
        method: 'POST',
        query: {
            id: broadcastId,
            part: 'id,snippet,status,contentDetails',
            streamId
        }
    });
}

async function getLiveStream(accessToken, streamId) {
    const response = await youtubeApiRequest({
        accessToken,
        path: '/liveStreams',
        query: {
            part: 'id,snippet,cdn,contentDetails,status',
            id: streamId
        }
    });

    const stream = response.items?.[0] || null;
    if (!stream) {
        throw new Error('YouTube yayin akisi bulunamadi.');
    }
    return stream;
}

function extractIngestion(stream) {
    const ingestion = stream.cdn?.ingestionInfo || {};
    const server = ingestion.rtmpsIngestionAddress || ingestion.ingestionAddress || '';
    const streamKey = ingestion.streamName || '';

    return {
        streamId: stream.id,
        server,
        streamKey,
        backupServer: ingestion.rtmpsBackupIngestionAddress || ingestion.backupIngestionAddress || '',
        streamStatus: stream.status?.streamStatus || '',
        title: stream.snippet?.title || ''
    };
}

async function ensureBroadcastHasStream(accessToken, broadcastSummary) {
    let streamId = broadcastSummary.streamId;
    if (!streamId) {
        const stream = await createLiveStream(accessToken, broadcastSummary.title || `EVD Stream ${new Date().toISOString()}`);
        streamId = stream.id;
        await bindBroadcastToStream(accessToken, broadcastSummary.id, streamId);
    }

    const stream = await getLiveStream(accessToken, streamId);
    return {
        broadcast: broadcastSummary,
        ingestion: extractIngestion(stream)
    };
}

async function getYoutubeAuthState() {
    const client = getYoutubeClientConfig();
    const store = getYoutubeAccountsStore();
    const accounts = [];
    let activeAccountId = getActiveYoutubeAccountId();
    let channel = null;
    let connected = false;

    for (const account of store.accounts) {
        let resolvedChannel = account.channel || null;
        const needsRefresh = !resolvedChannel?.id || !resolvedChannel?.title;
        if (needsRefresh) {
            try {
                const accessToken = await getValidAccessToken(account.id);
                const freshChannel = await getChannelInfo(accessToken);
                if (freshChannel) {
                    resolvedChannel = freshChannel;
                    updateYoutubeAccountChannel(account.id, freshChannel);
                }
            } catch (error) {
                console.warn(`YouTube auth state refresh failed for ${account.id}:`, error.message);
            }
        }

        const summary = buildYoutubeAccountSummary({
            ...account,
            channel: resolvedChannel
        });
        accounts.push(summary);

        if (account.id === activeAccountId) {
            if (resolvedChannel) {
                channel = resolvedChannel;
            }
            connected = !!account.token?.refresh_token || !!account.token?.access_token;
        }
    }

    if (!activeAccountId && accounts[0]) {
        activeAccountId = accounts[0].id;
    }

    return {
        clientId: client.clientId || '',
        clientSecret: '',
        hasClientSecret: !!client.clientSecret,
        connected,
        channel,
        accounts,
        activeAccountId
    };
}

async function startYouTubeOAuthFlow() {
    const client = getYoutubeClientConfig();
    if (!client.clientId) {
        throw new Error('YouTube OAuth istemci kimligi gerekli.');
    }

    const pkce = createPkcePair();

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
                const code = requestUrl.searchParams.get('code');
                const error = requestUrl.searchParams.get('error');

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                if (error) {
                    res.end('<html><body><h2>Kimlik doğrulama iptal edildi.</h2><p>Bu sekmeyi kapatıp uygulamaya dönebilirsiniz.</p></body></html>');
                    server.close();
                    reject(new Error(error));
                    return;
                }

                if (!code) {
                    res.end('<html><body><h2>Yetkilendirme kodu alınamadı.</h2><p>Bu sekmeyi kapatıp uygulamaya dönebilirsiniz.</p></body></html>');
                    server.close();
                    reject(new Error('Yetkilendirme kodu alınamadı.'));
                    return;
                }

                const redirectUri = getLoopbackRedirectUri(server.address().port);
                const token = await exchangeAuthCode({
                    code,
                    redirectUri,
                    codeVerifier: pkce.verifier,
                    clientId: client.clientId,
                    clientSecret: client.clientSecret
                });
                const channel = await getChannelInfo(token.access_token);
                saveYoutubeAccount({ tokenData: token, channel });

                res.end('<html><body><h2>YouTube hesabı bağlandı.</h2><p>Bu sekmeyi kapatıp uygulamaya dönebilirsiniz.</p></body></html>');
                server.close();
                resolve({ token, channel });
            } catch (error) {
                try {
                    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body><h2>Kimlik doğrulama başarısız oldu.</h2><p>Bu sekmeyi kapatıp uygulamaya dönebilirsiniz.</p></body></html>');
                } catch (_) {
                    // Ignore response errors after disconnect.
                }
                server.close();
                reject(error);
            }
        });

        server.listen(0, '127.0.0.1', async () => {
            const port = server.address().port;
            const redirectUri = getLoopbackRedirectUri(port);
            const authUrl = new URL(GOOGLE_AUTH_BASE);
            authUrl.searchParams.set('client_id', client.clientId);
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('scope', YOUTUBE_SCOPE);
            authUrl.searchParams.set('access_type', 'offline');
            authUrl.searchParams.set('prompt', 'consent');
            authUrl.searchParams.set('code_challenge', pkce.challenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');

            try {
                await shell.openExternal(authUrl.toString());
            } catch (error) {
                server.close();
                reject(error);
            }
        });

        server.on('error', (error) => {
            reject(error);
        });
    });
}

function setupYouTubeHandlers() {
    ipcMain.handle('youtube-save-client-config', async (_event, config) => {
        try {
            const saved = saveYoutubeClientConfig(config || {});
            return { success: true, ...saved };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-get-auth-state', async () => {
        try {
            return { success: true, ...(await getYoutubeAuthState()) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-connect-account', async () => {
        try {
            const result = await startYouTubeOAuthFlow();
            return {
                success: true,
                channel: result.channel
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-set-active-account', async (_event, { accountId } = {}) => {
        try {
            const activeAccountId = setActiveYoutubeAccount(String(accountId || '').trim());
            const account = getYoutubeAccounts().find((item) => item.id === activeAccountId) || null;
            return {
                success: true,
                activeAccountId,
                account: account ? buildYoutubeAccountSummary(account) : null
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-disconnect-account', async (_event, { accountId } = {}) => {
        const targetAccountId = String(accountId || '').trim() || getActiveYoutubeAccountId();
        try {
            const token = getYoutubeToken(targetAccountId);
            if (token?.refresh_token) {
                const revokeParams = new URLSearchParams({ token: token.refresh_token });
                await requestRaw(GOOGLE_OAUTH_REVOKE_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(revokeParams.toString())
                    }
                }, revokeParams.toString());
            }
        } catch (error) {
            console.warn('YouTube token revoke failed:', error.message);
        } finally {
            clearYoutubeToken(targetAccountId);
        }
        return { success: true };
    });

    ipcMain.handle('youtube-list-planned-broadcasts', async () => {
        try {
            const accessToken = await getValidAccessToken();
            const broadcasts = await listPlannedBroadcasts(accessToken);
            return { success: true, broadcasts };
        } catch (error) {
            return { success: false, error: error.message, broadcasts: [] };
        }
    });

    ipcMain.handle('youtube-list-playlists', async () => {
        try {
            const accessToken = await getValidAccessToken();
            const playlists = await listPlaylists(accessToken);
            return { success: true, playlists };
        } catch (error) {
            return { success: false, error: error.message, playlists: [] };
        }
    });

    ipcMain.handle('youtube-create-broadcast', async (_event, params) => {
        try {
            const accessToken = await getValidAccessToken();
            const title = String(params?.title || '').trim();
            if (!title) {
                throw new Error('YouTube yayin basligi gerekli.');
            }

            const scheduledStartTime = params?.scheduledStartTime || new Date(Date.now() + 2 * 60 * 1000).toISOString();
            const broadcast = await createLiveBroadcast(accessToken, {
                title,
                description: String(params?.description || '').trim(),
                privacyStatus: params?.privacyStatus || 'private',
                scheduledStartTime,
                madeForKids: params?.madeForKids === true,
                enableAutoStart: params?.enableAutoStart !== false,
                enableAutoStop: params?.enableAutoStop !== false
            });

            const stream = await createLiveStream(accessToken, `${title} Stream`, false);
            await bindBroadcastToStream(accessToken, broadcast.id, stream.id);
            const playlistResult = await addBroadcastToPlaylist(accessToken, {
                broadcastId: broadcast.id,
                playlistId: String(params?.playlistId || '').trim()
            });

            return {
                success: true,
                broadcast: formatBroadcastSummary(broadcast),
                ingestion: extractIngestion(stream),
                playlistResult
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                code: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                apiStatus: error.apiStatus || ''
            };
        }
    });

    ipcMain.handle('youtube-prepare-existing-broadcast', async (_event, { broadcastId, playlistId } = {}) => {
        try {
            if (!broadcastId) {
                throw new Error('Hazirlanacak YouTube yayini secilmedi.');
            }

            const accessToken = await getValidAccessToken();
            const response = await youtubeApiRequest({
                accessToken,
                path: '/liveBroadcasts',
                query: {
                    part: 'id,snippet,status,contentDetails',
                    id: broadcastId
                }
            });

            const item = response.items?.[0];
            if (!item) {
                throw new Error('Secilen planli YouTube yayini bulunamadi.');
            }

            const prepared = await ensureBroadcastHasStream(accessToken, formatBroadcastSummary(item));
            const playlistResult = await addBroadcastToPlaylist(accessToken, {
                broadcastId,
                playlistId: String(playlistId || '').trim()
            });
            return { success: true, ...prepared, playlistResult };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                code: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                apiStatus: error.apiStatus || ''
            };
        }
    });

    ipcMain.handle('youtube-transition-broadcast-live', async (_event, { broadcastId }) => {
        try {
            if (!broadcastId) {
                throw new Error('YouTube yayin kimligi eksik.');
            }
            const accessToken = await getValidAccessToken();
            const result = await transitionBroadcastIfNeeded(accessToken, broadcastId);
            return {
                success: true,
                broadcast: formatBroadcastSummary(result)
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                code: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                apiStatus: error.apiStatus || ''
            };
        }
    });

    ipcMain.handle('youtube-save-active-live-broadcast', async (_event, session = {}) => {
        try {
            const savedSession = saveActiveYouTubeBroadcastSession(session);
            return { success: true, session: savedSession };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-clear-active-live-broadcast', async () => {
        try {
            clearActiveYouTubeBroadcastSession();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-complete-broadcast', async (_event, { broadcastId }) => {
        try {
            if (!broadcastId) {
                return { success: true };
            }
            const result = await completeYouTubeBroadcastById(broadcastId);
            const activeSession = getActiveYouTubeBroadcastSession();
            if (activeSession?.broadcastId === String(broadcastId || '').trim()) {
                clearActiveYouTubeBroadcastSession();
            }
            return {
                success: true,
                broadcast: formatBroadcastSummary(result)
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                code: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                apiStatus: error.apiStatus || ''
            };
        }
    });

    ipcMain.handle('youtube-complete-active-live-broadcast', async () => {
        try {
            return await completeActiveYouTubeBroadcast();
        } catch (error) {
            return {
                success: false,
                error: error.message,
                code: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                apiStatus: error.apiStatus || ''
            };
        }
    });

    ipcMain.handle('youtube-get-live-chat-session', async (_event, { broadcastId } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const session = await getLiveChatSession(accessToken, String(broadcastId || '').trim());
            return { success: true, ...session };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                errorCode: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0
            };
        }
    });

    ipcMain.handle('youtube-get-live-broadcast-stats', async (_event, params = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const stats = await getLiveBroadcastVideoStats(accessToken, params);
            return { success: true, stats };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                errorCode: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0
            };
        }
    });

    ipcMain.handle('youtube-get-live-chat-session-from-url', async (_event, { url } = {}) => {
        try {
            let session = null;
            try {
                const accessToken = await getValidAccessToken();
                session = await getLiveChatSessionFromVideoUrl(accessToken, String(url || '').trim());
            } catch (authError) {
                const authMessage = String(authError?.message || '');
                const authCode = String(authError?.code || '').toLowerCase();
                const shouldFallbackToPublic = authMessage.toLowerCase().includes('youtube hesabi bagli degil')
                    || authMessage.toLowerCase().includes('exceeded your')
                    || authMessage.toLowerCase().includes('quota')
                    || authCode === 'quotaexceeded'
                    || authCode === 'dailylimitexceeded'
                    || authCode === 'dailylimitexceeded402'
                    || authCode === 'ratelimitexceeded'
                    || authCode === 'userratelimitexceeded';
                if (!shouldFallbackToPublic) {
                    throw authError;
                }
                session = await getPublicLiveChatSessionFromVideoUrl(String(url || '').trim());
            }
            return { success: true, ...session };
        } catch (error) {
            return { success: false, error: error.message, errorCode: error.code || '' };
        }
    });

    ipcMain.handle('youtube-list-live-chat-messages', async (_event, { liveChatId, pageToken } = {}) => {
        try {
            const normalizedLiveChatId = String(liveChatId || '').trim();
            let result = null;
            if (normalizedLiveChatId.startsWith('public:')) {
                result = await listPublicLiveChatMessages(
                    normalizedLiveChatId.replace(/^public:/, ''),
                    String(pageToken || '').trim()
                );
            } else {
                try {
                    result = await listLiveChatMessagesViaStream(
                        normalizedLiveChatId,
                        String(pageToken || '').trim(),
                        getActiveYoutubeAccountId()
                    );
                } catch (streamError) {
                    const accessToken = await getValidAccessToken();
                    result = await listLiveChatMessages(accessToken, normalizedLiveChatId, String(pageToken || '').trim());
                }
            }
            return { success: true, ...result };
        } catch (error) {
            console.error('[YouTubeChat] list-live-chat-messages failed', JSON.stringify({
                liveChatId: String(liveChatId || '').trim() || null,
                pageToken: String(pageToken || '').trim() || null,
                error: error.message || null,
                errorCode: error.code || null,
                reason: error.reason || null,
                statusCode: error.statusCode || null
            }));
            return {
                success: false,
                error: error.message,
                errorCode: error.code || '',
                reason: error.reason || '',
                statusCode: error.statusCode || 0,
                nextPageToken: '',
                pollingIntervalMillis: 5000,
                messages: []
            };
        }
    });

    ipcMain.handle('youtube-send-live-chat-message', async (_event, { liveChatId, text } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const message = await insertLiveChatMessage(accessToken, String(liveChatId || '').trim(), text);
            return { success: true, message };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-delete-live-chat-message', async (_event, { messageId } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            await deleteLiveChatMessage(accessToken, String(messageId || '').trim());
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-list-live-chat-moderators', async (_event, { liveChatId } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const moderators = await listLiveChatModerators(accessToken, String(liveChatId || '').trim());
            return { success: true, moderators };
        } catch (error) {
            return { success: false, error: error.message, moderators: [] };
        }
    });

    ipcMain.handle('youtube-add-live-chat-moderator', async (_event, { liveChatId, moderator } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const addedModerator = await insertLiveChatModerator(accessToken, String(liveChatId || '').trim(), String(moderator || '').trim());
            return { success: true, moderator: addedModerator };
        } catch (error) {
            return { success: false, error: error.message, errorCode: error.code || '' };
        }
    });

    ipcMain.handle('youtube-remove-live-chat-moderator', async (_event, { moderatorId } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            await deleteLiveChatModerator(accessToken, String(moderatorId || '').trim());
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message, errorCode: error.code || '' };
        }
    });

    ipcMain.handle('youtube-ban-live-chat-user', async (_event, { liveChatId, channelId, durationSeconds } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            const ban = await insertLiveChatBan(
                accessToken,
                String(liveChatId || '').trim(),
                String(channelId || '').trim(),
                Number.isFinite(durationSeconds) ? durationSeconds : null
            );
            return { success: true, ban };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('youtube-unban-live-chat-user', async (_event, { banId } = {}) => {
        try {
            const accessToken = await getValidAccessToken();
            await deleteLiveChatBan(accessToken, String(banId || '').trim());
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setupYouTubeHandlers,
    saveActiveYouTubeBroadcastSession,
    getActiveYouTubeBroadcastSession,
    clearActiveYouTubeBroadcastSession,
    completeYouTubeBroadcastById,
    completeActiveYouTubeBroadcast
};
