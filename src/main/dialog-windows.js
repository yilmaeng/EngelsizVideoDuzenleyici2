/**
 * Dialog Window Manager
 * Diyalogları ayrı pencerede açar
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let activeDialogWindow = null;
let mainWindowRef = null;

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
        title: data.editItem ? 'Yazı Düzenle' : 'Yazı Ekle',
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
}


/**
 * Ses Senkron / Playback Kayıt Sihirbazı Aç
 * @param {BrowserWindow} parentWindow
 * @param {string} mode - 'A' (Replace) or 'B' (Playback)
 */
function openSyncWizard(parentWindow, mode) {
    const { BrowserWindow } = require('electron');
    const path = require('path');

    // Parent'ın klavyesini devre dışı bırakmak iyi olabilir ama 
    // global shortcut guard zaten dialog açıkken işliyor.
    // Ancak bu ayrı bir pencere olduğu için focus değişince parent event almaz zaten.

    const wizardWin = new BrowserWindow({
        width: 1000,
        height: 800,
        parent: parentWindow,
        modal: true, // Kullanıcı isteği: wizard modunda çalışmalı
        show: false,
        title: mode === 'A' ? 'Ses Senkronizasyon' : 'Playback Kayıt',
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
}

module.exports = {
    openTextOverlayDialog,
    openSyncWizard,
    setupDialogHandlers
};
