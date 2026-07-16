const { BrowserWindow, ipcMain } = require('electron');
const obsController = require('../studio/obs-controller');
const {
    completeActiveYouTubeBroadcast
} = require('./youtube-handler');

function notifyRendererWindows(channel, payload = {}) {
    BrowserWindow.getAllWindows().forEach((win) => {
        try {
            if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send(channel, payload);
            }
        } catch (error) {
            if (/Render frame was disposed|WebFrameMain/i.test(error?.message || '')) {
                return;
            }
            console.warn(`Could not notify renderer for ${channel}:`, error.message);
        }
    });
}

async function stopObsStreamingForEmergency() {
    let status = null;
    let statusError = '';
    let shouldStop = true;

    try {
        status = await obsController.getStreamingStatus();
        shouldStop = !!(status?.outputActive || status?.outputReconnecting);
    } catch (error) {
        statusError = error.message || String(error);
        // If status cannot be read, still try StopStream; this is an emergency path.
        shouldStop = true;
    }

    if (!shouldStop) {
        return {
            success: true,
            stopped: false,
            status,
            statusError
        };
    }

    try {
        const result = await obsController.stopStreaming();
        return {
            success: true,
            stopped: true,
            status,
            statusError,
            result
        };
    } catch (error) {
        return {
            success: false,
            stopped: false,
            status,
            statusError,
            error: error.message || String(error)
        };
    }
}

async function emergencyStopLiveBroadcast() {
    const obs = await stopObsStreamingForEmergency();
    let youtube = null;

    try {
        youtube = await completeActiveYouTubeBroadcast();
    } catch (error) {
        youtube = {
            success: false,
            completed: false,
            error: error.message || String(error),
            code: error.code || '',
            reason: error.reason || '',
            statusCode: error.statusCode || 0,
            apiStatus: error.apiStatus || ''
        };
    }

    const result = {
        success: obs.success !== false && youtube?.success !== false,
        obs,
        youtube
    };

    notifyRendererWindows('live-broadcast-emergency-stopped', result);
    return result;
}

function setupEmergencyBroadcastHandlers() {
    ipcMain.handle('emergency-stop-live-broadcast', async () => emergencyStopLiveBroadcast());
}

module.exports = {
    setupEmergencyBroadcastHandlers,
    emergencyStopLiveBroadcast
};
