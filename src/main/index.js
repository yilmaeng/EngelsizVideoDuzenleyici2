// Basit ve temiz Electron main process
process.on('uncaughtException', err => { require('fs').writeFileSync('fatal.log', err.stack); console.error(err); });
process.on('unhandledRejection', err => { require('fs').writeFileSync('fatal-reject.log', err ? (err.stack || err.toString()) : 'Unknown rejection'); console.error('Promise Rejection:', err); });
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, globalShortcut, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
require('./logger'); // Initialize logging system
const i18n = require('./i18n'); // Initialize i18n

if (process.platform === 'win32') {
    app.setAppUserModelId('com.engelsiz.videoeditor');
}

let mainWindow;
let createMenuFn;
let setupIpcHandlersFn;
let pendingLaunchPath = null;
let instantTranslationTray = null;
const allowMultiInstance = process.argv.includes('--multi-instance') || process.env.EVD_ALLOW_MULTI_INSTANCE === '1';

function isInstantVoiceTranslationOnlyMode() {
    const appName = String(app.getName?.() || '').toLowerCase();
    return process.argv.includes('--instant-voice-translation')
        || process.env.EVD_INSTANT_TRANSLATOR_ONLY === '1'
        || appName.includes('anlık sesli çeviri')
        || appName.includes('anlik-sesli-ceviri')
        || appName.includes('anlik sesli ceviri')
        || appName.includes('instantvoicetranslation');
}

if (isInstantVoiceTranslationOnlyMode()) {
    Menu.setApplicationMenu(null);
}

function isPortableMode() {
    return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function translateOrFallback(key, fallback) {
    const value = i18n.t(key);
    return value && !value.startsWith('[') ? value : fallback;
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
    '.mp4', '.wmv', '.avi', '.mkv', '.mov', '.webm', '.flv', '.3gp',
    '.mpg', '.mpeg', '.vob', '.m4v', '.ts', '.mts'
]);
const SUPPORTED_PROJECT_EXTENSIONS = new Set(['.kve', '.eng']);

function normalizeArgPath(arg) {
    if (!arg || typeof arg !== 'string') {
        return null;
    }

    if (arg.startsWith('--') || arg.startsWith('/')) {
        return null;
    }

    const resolvedPath = path.resolve(arg);
    if (!fs.existsSync(resolvedPath)) {
        return null;
    }

    return resolvedPath;
}

function isSupportedOpenPath(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    return SUPPORTED_VIDEO_EXTENSIONS.has(ext) || SUPPORTED_PROJECT_EXTENSIONS.has(ext);
}

function extractLaunchPath(argv = []) {
    for (const arg of argv) {
        const normalizedPath = normalizeArgPath(arg);
        if (normalizedPath && isSupportedOpenPath(normalizedPath)) {
            return normalizedPath;
        }
    }

    return null;
}

function sendOpenPathToRenderer(filePath) {
    if (!mainWindow || !mainWindow.webContents || !filePath) {
        return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (SUPPORTED_PROJECT_EXTENSIONS.has(ext)) {
        mainWindow.webContents.send('project-open-file', filePath);
    } else {
        mainWindow.webContents.send('file-open', filePath);
    }

    return true;
}

function queueOrOpenPath(filePath) {
    if (!filePath) {
        return;
    }

    pendingLaunchPath = filePath;
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
        sendOpenPathToRenderer(filePath);
        pendingLaunchPath = null;
    }
}

function showInstantVoiceTranslationWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
}

function ensureInstantVoiceTranslationTray() {
    if (!isInstantVoiceTranslationOnlyMode()) {
        return null;
    }

    if (instantTranslationTray) {
        return instantTranslationTray;
    }

    instantTranslationTray = new Tray(path.join(__dirname, '../../Start_icon.png'));
    instantTranslationTray.setToolTip(translateOrFallback(
        'dialog.instant_voice_translation.tray_tooltip',
        'Anlık Sesli Çeviri arka planda çalışıyor.'
    ));
    instantTranslationTray.setContextMenu(Menu.buildFromTemplate([
        {
            label: translateOrFallback('dialog.instant_voice_translation.tray_show', 'Pencereyi göster'),
            click: showInstantVoiceTranslationWindow
        },
        {
            label: translateOrFallback('dialog.instant_voice_translation.tray_quit', 'Çıkış'),
            click: () => {
                if (instantTranslationTray) {
                    instantTranslationTray.destroy();
                    instantTranslationTray = null;
                }
                app.quit();
            }
        }
    ]));
    instantTranslationTray.on('click', showInstantVoiceTranslationWindow);
    instantTranslationTray.on('double-click', showInstantVoiceTranslationWindow);
    return instantTranslationTray;
}

if (!allowMultiInstance) {
    const singleInstanceLock = app.requestSingleInstanceLock();
    if (!singleInstanceLock) {
        app.quit();
    }

    pendingLaunchPath = extractLaunchPath(process.argv.slice(1));

    app.on('second-instance', (event, argv) => {
        const nextPath = extractLaunchPath(argv.slice(1));

        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }

        if (nextPath) {
            queueOrOpenPath(nextPath);
        }
    });
} else {
    pendingLaunchPath = extractLaunchPath(process.argv.slice(1));
}

app.whenReady().then(async () => {
    try {
        setupIpcHandlersFn = require('./ipc-handlers').setupIpcHandlers;
        const { setupGeminiHandlers } = require('./gemini-handler');
        const { setupOpenAiHandlers } = require('./openai-handler');
        if (!isInstantVoiceTranslationOnlyMode()) {
            createMenuFn = require('./menu').createMenu;
        }

        await i18n.init(); // Initialize i18n and wait for it now that app is ready

        createWindow();
        setupIpcHandlersFn(mainWindow);
        setupGeminiHandlers(mainWindow);
        setupOpenAiHandlers(mainWindow);
        if (isInstantVoiceTranslationOnlyMode()) {
            setupInstantVoiceTranslationShortcutHandlers();
        }
        if (!isInstantVoiceTranslationOnlyMode()) {
            const { setupDialogHandlers } = require('./dialog-windows');
            const { setupObsIpcHandlers } = require('./obs-ipc');
            const { setupElevenLabsHandlers } = require('./elevenlabs-handler');
            const { setupYouTubeHandlers } = require('./youtube-handler');
            const { setupEmergencyBroadcastHandlers } = require('./emergency-broadcast-handler');
            const { setupSlideshowHandlers } = require('./slideshow-handler');
            const { setupObjectAnalysisHandlers } = require('./object-analysis-handler');
            setupDialogHandlers(mainWindow);
            setupObsIpcHandlers(mainWindow);
            setupElevenLabsHandlers(mainWindow);
            setupYouTubeHandlers(mainWindow);
            setupEmergencyBroadcastHandlers(mainWindow);
            setupSlideshowHandlers(mainWindow);
            setupObjectAnalysisHandlers(mainWindow);
        }

        app.on('activate', () => {
            if (isInstantVoiceTranslationOnlyMode() && mainWindow && !mainWindow.isDestroyed()) {
                showInstantVoiceTranslationWindow();
                return;
            }
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        console.error('Uygulama başlatma hatası:', error);
        const errorTitle = i18n.t('messages.error_title');
        dialog.showErrorBox(errorTitle.startsWith('[') ? 'Error' : errorTitle, error.message);
    }
});

function setupInstantVoiceTranslationShortcutHandlers() {
    ipcMain.handle('instant-voice-translation-hide-to-tray', () => {
        try {
            if (!isInstantVoiceTranslationOnlyMode()) {
                return { success: false, error: 'instant_translation_only_required' };
            }
            ensureInstantVoiceTranslationTray();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.hide();
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('register-global-shortcut', (event, registration) => {
        try {
            const accelerator = typeof registration === 'string'
                ? registration
                : registration?.accelerator;
            const focusWindowOnTrigger = !!(registration && typeof registration === 'object' && registration.focusWindowOnTrigger);

            if (!accelerator) {
                return { success: false, error: 'accelerator_missing' };
            }

            if (globalShortcut.isRegistered(accelerator)) {
                globalShortcut.unregister(accelerator);
            }

            const success = globalShortcut.register(accelerator, () => {
                if (event.sender && !event.sender.isDestroyed()) {
                    if (focusWindowOnTrigger) {
                        const targetWindow = BrowserWindow.fromWebContents(event.sender);
                        if (targetWindow && !targetWindow.isDestroyed()) {
                            if (targetWindow.isMinimized()) {
                                targetWindow.restore();
                            }
                            targetWindow.show();
                            targetWindow.focus();
                        }
                    }
                    event.sender.send('global-shortcut-triggered', accelerator);
                }
            });
            return { success };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('unregister-global-shortcut', (_event, accelerator) => {
        try {
            if (!accelerator) {
                return { success: false, error: 'accelerator_missing' };
            }
            if (globalShortcut.isRegistered(accelerator)) {
                globalShortcut.unregister(accelerator);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('unregister-all-global-shortcuts', () => {
        try {
            globalShortcut.unregisterAll();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

ipcMain.handle('open-external-url', async (_event, url) => {
    if (!url || typeof url !== 'string') {
        return { success: false, error: 'invalid_url' };
    }

    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error && error.message ? error.message : String(error)
        };
    }
});

ipcMain.handle('app-is-portable', () => isPortableMode());

function createWindow() {
    const launchedWithExternalFile = Boolean(pendingLaunchPath);
    const instantTranslationOnly = isInstantVoiceTranslationOnlyMode();

    mainWindow = new BrowserWindow({
        width: instantTranslationOnly ? 920 : 1200,
        height: instantTranslationOnly ? 820 : 800,
        show: false,
        title: instantTranslationOnly
            ? i18n.t('dialog.instant_voice_translation.standalone_title') || 'Anlık Sesli Çeviri'
            : i18n.t('messages.app_window_title') || 'EVD',
        icon: path.join(__dirname, '../../Start_icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload/index.js')
        },
        titleBarStyle: 'default',
        autoHideMenuBar: false
    });

    mainWindow.loadFile(path.join(__dirname, instantTranslationOnly
        ? '../renderer/instant-voice-translation.html'
        : '../renderer/index.html'), {
        query: launchedWithExternalFile && !instantTranslationOnly ? { externalLaunch: '1' } : {}
    });

    if (instantTranslationOnly) {
        mainWindow.setMenuBarVisibility(false);
        Menu.setApplicationMenu(null);
    } else {
        const menu = createMenuFn(mainWindow);
        Menu.setApplicationMenu(menu);
    }

    if (process.platform === 'win32' && typeof mainWindow.hookWindowMessage === 'function') {
        const WM_ENTERMENULOOP = 0x0211;
        const WM_EXITMENULOOP = 0x0212;

        mainWindow.hookWindowMessage(WM_ENTERMENULOOP, () => {
            mainWindow?.webContents?.send('native-menu-state', true);
        });

        mainWindow.hookWindowMessage(WM_EXITMENULOOP, () => {
            mainWindow?.webContents?.send('native-menu-state', false);
        });
    }

    mainWindow.on('blur', () => {
        mainWindow?.webContents?.send('native-menu-state', true);
    });

    mainWindow.on('focus', () => {
        mainWindow?.webContents?.send('native-menu-state', false);
    });

    if (process.argv.includes('--enable-logging')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.once('ready-to-show', () => {
        if (!mainWindow) return;
        mainWindow.maximize();
        mainWindow.show();
    });

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('app-ready', {
            accessibilityEnabled: app.accessibilitySupportEnabled,
            appVersion: app.getVersion(),
            isPortable: isPortableMode(),
            platform: process.platform,
            launchedWithExternalFile,
            instantTranslationOnly
        });

        if (pendingLaunchPath) {
            sendOpenPathToRenderer(pendingLaunchPath);
            pendingLaunchPath = null;
        }
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    if (instantTranslationTray) {
        instantTranslationTray.destroy();
        instantTranslationTray = null;
    }
});
