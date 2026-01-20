// Basit ve temiz Electron main process
const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path');

let mainWindow;
let createMenuFn;
let setupIpcHandlersFn;

app.whenReady().then(async () => {
    console.log('Uygulama hazır');

    try {
        createMenuFn = require('./menu').createMenu;
        setupIpcHandlersFn = require('./ipc-handlers').setupIpcHandlers;
        const { setupDialogHandlers } = require('./dialog-windows');
        const { setupGeminiHandlers } = require('./gemini-handler');
        const { setupSlideshowHandlers } = require('./slideshow-handler');
        const { setupObjectAnalysisHandlers } = require('./object-analysis-handler');

        createWindow();
        setupIpcHandlersFn(mainWindow);
        setupDialogHandlers(mainWindow);
        setupGeminiHandlers(mainWindow);
        setupSlideshowHandlers(mainWindow);
        setupObjectAnalysisHandlers(mainWindow);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        console.error('Uygulama başlatma hatası:', error);
        dialog.showErrorBox('Hata', error.message);
    }
});

function createWindow() {
    console.log('Pencere oluşturuluyor...');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Engelsiz Video Düzenleyicisi',
        icon: path.join(__dirname, '../../Start_icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload/index.js')
        },
        titleBarStyle: 'default',
        autoHideMenuBar: false
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    const menu = createMenuFn(mainWindow);
    Menu.setApplicationMenu(menu);

    if (process.argv.includes('--enable-logging')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Sayfa yüklendi');
        mainWindow.webContents.send('app-ready', {
            accessibilityEnabled: app.accessibilitySupportEnabled
        });
    });

    console.log('Pencere oluşturuldu');
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
