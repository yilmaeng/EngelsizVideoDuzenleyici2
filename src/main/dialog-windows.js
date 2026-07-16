/**
 * Dialog Window Manager
 * Diyalogları ayrı pencerede açar
 */

const { BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const i18n = require('./i18n');

let activeDialogWindow = null;
let mainWindowRef = null;
let liveEffectsPanelWindow = null;
let recordingWizardWindow = null;
let broadcastRoomWindow = null;
let elevenLabsDubbingToolWindow = null;
const broadcastRoomGuestWindows = new Set();
let activeRecordingWizardSession = null;

function cloneSessionData(data) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    try {
        return JSON.parse(JSON.stringify(data));
    } catch (error) {
        console.warn('recording session clone failed:', error.message);
        return null;
    }
}

function hasActiveRecordingWizardSession() {
    return !!(activeRecordingWizardSession && activeRecordingWizardSession.active);
}

function getRecordingWizardSession() {
    return cloneSessionData(activeRecordingWizardSession);
}

function refreshApplicationMenu() {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) {
        return;
    }

    try {
        const { createMenu } = require('./menu');
        Menu.setApplicationMenu(createMenu(mainWindowRef));
    } catch (error) {
        console.warn('menu refresh failed:', error.message);
    }
}

function setRecordingWizardSession(session = null) {
    const normalized = cloneSessionData(session);
    activeRecordingWizardSession = normalized && normalized.active ? normalized : null;
    refreshApplicationMenu();
    return getRecordingWizardSession();
}

/**
 * Yazı ekleme diyaloğunu aç
 * @param {BrowserWindow} parentWindow - Ana pencere
 * @param {object} data - Başlangıç verileri (startTime, editItem vb.)
 */
function openTextOverlayDialog(parentWindow, data = {}) {
    // Zaten açık bir dialog varsa öne getir
    if (activeDialogWindow && !activeDialogWindow.isDestroyed()) {
        activeDialogWindow.focus();
        return;
    }

    // Ana pencerede klavyeyi devre dışı bırak
    parentWindow.webContents.send('keyboard-disable');

    activeDialogWindow = new BrowserWindow({
        width: 500,
        height: 750,
        parent: parentWindow,
        modal: false, // Modal değil, böylece ana pencereye dönülebilir
        show: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        title: data.editItem ? (i18n.t('dialog.text.edit') || 'Yazı Düzenle') : (i18n.t('dialog.text.add') || 'Yazı Ekle'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Dialog HTML'ini yükle
    const dialogPath = path.join(__dirname, '../renderer/dialogs/text-overlay.html');
    activeDialogWindow.loadFile(dialogPath);

    // Pencere hazır olduğunda göster
    activeDialogWindow.once('ready-to-show', () => {
        activeDialogWindow.show();
        // init-data'yı 'text-overlay-ready' mesajı gelince göndereceğiz
    });

    // Datayı sakla
    activeDialogWindow.initData = data;

    // Pencere kapatıldığında
    activeDialogWindow.once('closed', () => {
        // Ana pencerede klavyeyi tekrar etkinleştir
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.webContents.send('keyboard-enable');
            parentWindow.focus();
        }
        activeDialogWindow = null;
    });
}

/**
 * IPC handler'ları kur
 */
function setupDialogHandlers(mainWindow) {
    mainWindowRef = mainWindow;

    // Yazı ekleme diyaloğu aç
    ipcMain.handle('open-text-overlay-dialog', async (event, data) => {
        openTextOverlayDialog(mainWindow, data);
        return { opened: true };
    });

    // Listeye ekle
    ipcMain.on('text-overlay-add-to-list', (event, options) => {
        console.log('Listeye ekleniyor:', options);
        mainWindow.webContents.send('insertion-queue-add', { type: 'text', options });
    });

    // Güncelle
    ipcMain.on('text-overlay-update', (event, { id, options }) => {
        console.log('Güncelleniyor:', id, options);
        mainWindow.webContents.send('insertion-queue-update', { id, options });
    });

    // Kapat
    ipcMain.on('text-overlay-close', () => {
        console.log('Dialog kapatılıyor');
        // Pencere zaten kapatılıyor, handlers otomatik temizlenecek
    });

    // Doğrudan videoya ekle
    ipcMain.on('text-overlay-apply', (event, options) => {
        console.log('Doğrudan videoya ekleniyor:', options);
        mainWindow.webContents.send('text-overlay-direct-apply', options);
    });

    // Eski uyumluluk için (eğer bir yerde kullanılıyorsa)
    ipcMain.on('text-overlay-confirm', (event, options) => {
        mainWindow.webContents.send('insertion-queue-add', { type: 'text', options });
    });

    ipcMain.on('text-overlay-cancel', () => {
        // Hiçbir şey yapma
    });

    // Renderer hazır olduğunda veriyi gönder
    ipcMain.on('text-overlay-ready', (event) => {
        if (activeDialogWindow && !activeDialogWindow.isDestroyed() && activeDialogWindow.initData) {
            console.log('Dialog hazır, veriler gönderiliyor:', activeDialogWindow.initData);
            activeDialogWindow.webContents.send('init-data', activeDialogWindow.initData);
        }
    });

    ipcMain.handle('recording-wizard-set-active-session', async (_event, session) => {
        return {
            success: true,
            session: setRecordingWizardSession(session),
            hasActiveSession: hasActiveRecordingWizardSession()
        };
    });

    ipcMain.handle('recording-wizard-get-active-session', async () => {
        return {
            success: true,
            session: getRecordingWizardSession(),
            hasActiveSession: hasActiveRecordingWizardSession()
        };
    });

    ipcMain.handle('recording-wizard-resume-active-session', async () => {
        return resumeActiveRecordingWizard(mainWindow);
    });
}


/**
 * Ses Senkron / Playback Kayıt Sihirbazı Aç
 * @param {BrowserWindow} parentWindow
 * @param {string} mode - 'A' (Replace) or 'B' (Playback)
 */
function openSyncWizard(parentWindow, mode) {
    const wizardWin = new BrowserWindow({
        width: 1000,
        height: 800,
        parent: parentWindow,
        modal: true,
        show: false,
        title: mode === 'A' ? (i18n.t('dialog.sync.title_a') || 'Ses Senkronizasyon') : (i18n.t('dialog.sync.title_b') || 'Playback Kayıt'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    wizardWin.loadFile(path.join(__dirname, '../renderer/dialogs/sync-wizard.html'));

    wizardWin.once('ready-to-show', () => {
        wizardWin.show();
        wizardWin.webContents.send('init-wizard', mode);
    });

    // Pencere kapatıldığında ana pencereye focus ver
    wizardWin.once('closed', () => {
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });
}

/**
 * Dikey Video Sihirbazı (Shorts/Reels)
 */
function openVerticalWizard(parentWindow, data = null) {
    const wizardWin = new BrowserWindow({
        width: 900,
        height: 750,
        parent: parentWindow,
        show: false,
        title: i18n.t('dialog.vertical.title') || 'Dikey Video Oluşturucu (Shorts/Reels)',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    wizardWin.loadFile(path.join(__dirname, '../renderer/dialogs/vertical-wizard.html'));

    wizardWin.once('ready-to-show', () => {
        wizardWin.show();
        if (data) {
            wizardWin.webContents.send('init-data', data);
        }
    });

    // Pencere kapatıldığında ana pencereye focus ver
    wizardWin.once('closed', () => {
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });
}

/**
 * Erişilebilir Kayıt Sihirbazı
 */
function openRecordingWizard(parentWindow, options = {}) {
    if (recordingWizardWindow && !recordingWizardWindow.isDestroyed()) {
        if (parentWindow && !parentWindow.isDestroyed() && parentWindow.isMinimized()) {
            parentWindow.restore();
            parentWindow.show();
        }
        if (recordingWizardWindow.isMinimized()) {
            recordingWizardWindow.restore();
        }
        recordingWizardWindow.show();
        recordingWizardWindow.focus();
        if (options && Object.keys(options).length > 0) {
            recordingWizardWindow.webContents.send('recording-wizard-init', options);
        }
        return recordingWizardWindow;
    }

    const wizardWin = new BrowserWindow({
        width: 1000,
        height: 800,
        parent: parentWindow,
        modal: true,
        show: false,
        title: i18n.t('dialog.recording.title') || 'Erişilebilir Video Kayıt Sihirbazı',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    wizardWin.loadFile(path.join(__dirname, '../renderer/dialogs/accessible-recording.html'));

    wizardWin.webContents.once('did-finish-load', () => {
        wizardWin.webContents.send('recording-wizard-init', options);
    });

    wizardWin.once('ready-to-show', () => {
        wizardWin.show();
    });

    wizardWin.on('minimize', () => {
        if (parentWindow && !parentWindow.isDestroyed() && !parentWindow.isMinimized()) {
            parentWindow.minimize();
        }
    });

    wizardWin.on('restore', () => {
        if (parentWindow && !parentWindow.isDestroyed()) {
            if (parentWindow.isMinimized()) {
                parentWindow.restore();
            }
            parentWindow.show();
        }
    });

    wizardWin.once('closed', () => {
        recordingWizardWindow = null;
        refreshApplicationMenu();
        if (parentWindow && !parentWindow.isDestroyed()) {
            if (parentWindow.isMinimized()) {
                parentWindow.restore();
            }
            parentWindow.show();
            parentWindow.focus();
        }
    });

    recordingWizardWindow = wizardWin;
    refreshApplicationMenu();
    return wizardWin;
}

function resumeActiveRecordingWizard(parentWindow) {
    if (recordingWizardWindow && !recordingWizardWindow.isDestroyed()) {
        if (parentWindow && !parentWindow.isDestroyed() && parentWindow.isMinimized()) {
            parentWindow.restore();
            parentWindow.show();
        }
        if (recordingWizardWindow.isMinimized()) {
            recordingWizardWindow.restore();
        }
        recordingWizardWindow.show();
        recordingWizardWindow.focus();
        return { success: true, reusedWindow: true };
    }

    if (!hasActiveRecordingWizardSession()) {
        return { success: false, error: 'no_active_session' };
    }

    const session = getRecordingWizardSession();
    openRecordingWizard(parentWindow, {
        launchProfile: session.launchProfile || 'broadcast',
        restoreSession: session
    });
    return { success: true, reusedWindow: false };
}

/**
 * Canli Efekt Paneli
 */
function openLiveEffectsPanel(parentWindow) {
    if (liveEffectsPanelWindow && !liveEffectsPanelWindow.isDestroyed()) {
        if (liveEffectsPanelWindow.isMinimized()) {
            liveEffectsPanelWindow.restore();
        }
        liveEffectsPanelWindow.show();
        liveEffectsPanelWindow.focus();
        return liveEffectsPanelWindow;
    }

    liveEffectsPanelWindow = new BrowserWindow({
        width: 980,
        height: 760,
        show: false,
        title: i18n.t('live_effects_panel.window_title') || 'Canli Efekt Paneli',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    liveEffectsPanelWindow.loadFile(path.join(__dirname, '../renderer/dialogs/live-effects-panel.html'));

    liveEffectsPanelWindow.once('ready-to-show', () => {
        liveEffectsPanelWindow.show();
        liveEffectsPanelWindow.focus();
    });

    liveEffectsPanelWindow.once('closed', () => {
        liveEffectsPanelWindow = null;
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });

    return liveEffectsPanelWindow;
}

/**
 * Yayın Odası
 */
function openBroadcastRoom(parentWindow, options = {}) {
    if (broadcastRoomWindow && !broadcastRoomWindow.isDestroyed()) {
        if (broadcastRoomWindow.isMinimized()) {
            broadcastRoomWindow.restore();
        }
        broadcastRoomWindow.show();
        broadcastRoomWindow.focus();
        if (options && Object.keys(options).length > 0) {
            broadcastRoomWindow.webContents.send('broadcast-room-init', options);
        }
        return broadcastRoomWindow;
    }

    broadcastRoomWindow = new BrowserWindow({
        width: 1180,
        height: 860,
        show: false,
        title: i18n.t('broadcast_room.window_title') || 'EVD Yayın Odası',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    broadcastRoomWindow.loadFile(path.join(__dirname, '../renderer/dialogs/broadcast-room.html'));

    broadcastRoomWindow.webContents.once('did-finish-load', () => {
        broadcastRoomWindow.webContents.send('broadcast-room-init', options || {});
    });

    broadcastRoomWindow.once('ready-to-show', () => {
        broadcastRoomWindow.show();
        broadcastRoomWindow.focus();
    });

    broadcastRoomWindow.once('closed', () => {
        broadcastRoomWindow = null;
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });

    return broadcastRoomWindow;
}

function openBroadcastRoomGuestWindow(parentWindow, options = {}) {
    const guestWindow = new BrowserWindow({
        width: 560,
        height: 680,
        show: false,
        minimizable: true,
        maximizable: false,
        title: i18n.t('broadcast_room.guest_window_title') || 'Yayın Odası Konuk Katılımı',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    broadcastRoomGuestWindows.add(guestWindow);
    guestWindow.loadFile(path.join(__dirname, '../renderer/dialogs/broadcast-room-guest.html'));

    guestWindow.webContents.once('did-finish-load', () => {
        guestWindow.webContents.send('broadcast-room-guest-init', options || {});
    });

    guestWindow.once('ready-to-show', () => {
        guestWindow.show();
        guestWindow.focus();
    });

    guestWindow.once('closed', () => {
        broadcastRoomGuestWindows.delete(guestWindow);
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });

    return guestWindow;
}

function openBroadcastRoomJoinWindow(parentWindow, options = {}) {
    const joinUrl = String(options?.joinUrl || '').trim();
    if (!/^https?:\/\//i.test(joinUrl)) {
        throw new Error('join_url_required');
    }
    const partition = `broadcast-room-join-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const joinWindow = new BrowserWindow({
        width: 760,
        height: 820,
        show: false,
        minimizable: true,
        maximizable: true,
        title: i18n.t('broadcast_room.join_room_window_title') || 'Toplantıya Katıl',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            partition
        }
    });

    broadcastRoomGuestWindows.add(joinWindow);
    const joinSession = joinWindow.webContents.session;
    try {
        joinSession.setPermissionRequestHandler((webContents, permission, callback) => {
            const sameWindow = webContents && webContents.id === joinWindow.webContents.id;
            callback(sameWindow && ['media', 'display-capture', 'fullscreen'].includes(String(permission || '')));
        });
    } catch (error) {
        console.warn('broadcast room join permission handler failed:', error.message);
    }
    joinWindow.loadURL(joinUrl);

    joinWindow.once('ready-to-show', () => {
        joinWindow.show();
        joinWindow.focus();
    });

    joinWindow.once('closed', () => {
        try { joinSession.setPermissionRequestHandler(null); } catch (_error) {}
        broadcastRoomGuestWindows.delete(joinWindow);
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });

    return joinWindow;
}

function openElevenLabsDubbingTool(parentWindow, options = {}) {
    if (elevenLabsDubbingToolWindow && !elevenLabsDubbingToolWindow.isDestroyed()) {
        if (elevenLabsDubbingToolWindow.isMinimized()) {
            elevenLabsDubbingToolWindow.restore();
        }
        elevenLabsDubbingToolWindow.show();
        elevenLabsDubbingToolWindow.focus();
        elevenLabsDubbingToolWindow.webContents.send('elevenlabs-dubbing-tool-init', options || {});
        return elevenLabsDubbingToolWindow;
    }

    elevenLabsDubbingToolWindow = new BrowserWindow({
        width: 780,
        height: 700,
        show: false,
        title: i18n.t('elevenlabs_dubbing_tool.window_title') || 'ElevenLabs ile Dosya Dublajı',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    elevenLabsDubbingToolWindow.loadFile(path.join(__dirname, '../renderer/dialogs/elevenlabs-dubbing-tool.html'));

    elevenLabsDubbingToolWindow.webContents.once('did-finish-load', () => {
        elevenLabsDubbingToolWindow.webContents.send('elevenlabs-dubbing-tool-init', options || {});
    });

    elevenLabsDubbingToolWindow.once('ready-to-show', () => {
        elevenLabsDubbingToolWindow.show();
        elevenLabsDubbingToolWindow.focus();
    });

    elevenLabsDubbingToolWindow.once('closed', () => {
        elevenLabsDubbingToolWindow = null;
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.focus();
        }
    });

    return elevenLabsDubbingToolWindow;
}

module.exports = {
    openTextOverlayDialog,
    openSyncWizard,
    openVerticalWizard,
    openRecordingWizard,
    resumeActiveRecordingWizard,
    openLiveEffectsPanel,
    openBroadcastRoom,
    openBroadcastRoomGuestWindow,
    openBroadcastRoomJoinWindow,
    openElevenLabsDubbingTool,
    setupDialogHandlers,
    setRecordingWizardSession,
    getRecordingWizardSession,
    hasActiveRecordingWizardSession
};
