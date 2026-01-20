const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'Test'
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/test.html'));
});

app.on('window-all-closed', () => {
    app.quit();
});
