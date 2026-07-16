const { ipcMain, globalShortcut, BrowserWindow } = require('electron');
const obsController = require('../studio/obs-controller');

function setupObsIpcHandlers(mainWindow) {
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

    ipcMain.handle('unregister-all-global-shortcuts', () => {
        try {
            globalShortcut.unregisterAll();
            return { success: true };
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

    ipcMain.handle('obs-detect', async () => {
        return obsController.detectOBS();
    });

    ipcMain.handle('obs-get-config', async () => {
        return obsController.getConfig();
    });

    ipcMain.handle('obs-save-config', async (event, config) => {
        return obsController.saveConfig(config);
    });

    ipcMain.handle('obs-test-connection', async (event, { host, port, password }) => {
        try {
            const result = await obsController.connect({ host, port, password });
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-ensure-scene', async (event, { sceneName }) => {
        try {
            const result = await obsController.ensureScene(sceneName);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-setup-sources', async (event, params) => {
        try {
            const result = await obsController.setupSources(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-transform', async (event, params) => {
        try {
            const result = await obsController.setSceneItemTransform(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-scene-item-enabled', async (event, params) => {
        try {
            const result = await obsController.setSceneItemEnabled(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-camera-background', async (event, params) => {
        try {
            const result = await obsController.applyCameraBackground(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-camera-panel-fill', async (event, params) => {
        try {
            const result = await obsController.applyCameraPanelFill(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-scene-background', async (event, params) => {
        try {
            const result = await obsController.applySceneBackground(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-ensure-live-room-audio-bridge-source', async (event, params) => {
        try {
            const result = await obsController.ensureLiveRoomAudioBridgeSource(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-input-volume', async (event, params) => {
        try {
            const result = await obsController.setInputVolume(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-input-mute', async (event, params) => {
        try {
            const result = await obsController.setInputMute(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-microphone-device', async (event, params) => {
        try {
            const result = await obsController.setMicrophoneDevice(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-input-monitoring', async (event, params) => {
        try {
            const result = await obsController.setInputMonitoring(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-show-live-effect-video', async (event, params) => {
        try {
            const result = await obsController.showLiveEffectVideo(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-show-live-effect-image', async (event, params) => {
        try {
            const result = await obsController.showLiveEffectImage(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-show-live-effect-audio', async (event, params) => {
        try {
            const result = await obsController.showLiveEffectAudio(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-update-live-caption-overlay', async (event, params) => {
        try {
            const result = await obsController.updateLiveCaptionOverlay(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-release-broadcast-camera-source', async (event, params) => {
        try {
            const result = await obsController.releaseBroadcastCameraSource(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-reset-broadcast-room-audio-sources', async (event, params) => {
        try {
            const result = await obsController.resetBroadcastRoomAudioSources(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-hide-live-effect-video', async (event, params) => {
        try {
            const result = await obsController.hideLiveEffectVideo(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-hide-live-effect-image', async (event, params) => {
        try {
            const result = await obsController.hideLiveEffectImage(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-hide-live-effect-audio', async (event, params) => {
        try {
            const result = await obsController.hideLiveEffectAudio(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-remove-live-effect-video', async (event, params) => {
        try {
            const result = await obsController.removeLiveEffectVideo(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-remove-live-effect-image', async (event, params) => {
        try {
            const result = await obsController.removeLiveEffectImage(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-remove-live-effect-audio', async (event, params) => {
        try {
            const result = await obsController.removeLiveEffectAudio(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-pause-live-effect-video', async (event, params) => {
        try {
            const result = await obsController.pauseLiveEffectVideo(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-resume-live-effect-video', async (event, params) => {
        try {
            const result = await obsController.resumeLiveEffectVideo(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-update-live-chat-overlay', async (event, params) => {
        try {
            const result = await obsController.updateLiveChatOverlay(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-hide-live-chat-overlay', async (event, params) => {
        try {
            const result = await obsController.hideLiveChatOverlay(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-remove-live-chat-overlay', async (event, params) => {
        try {
            const result = await obsController.removeLiveChatOverlay(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-recording-format', async (event, { format }) => {
        try {
            console.log(`[OBS IPC] Recording format request: ${format}`);
            await obsController.setRecordingFormat(format);
            return { success: true };
        } catch (error) {
            console.error('[OBS IPC] Recording format request failed:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-start-recording', async () => {
        try {
            console.log('[OBS IPC] Start recording requested');
            const result = await obsController.startRecording();
            console.log('[OBS IPC] Start recording result:', JSON.stringify(result));
            return { success: true, ...result };
        } catch (error) {
            console.error('[OBS IPC] Start recording failed:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-pause-recording', async () => {
        try {
            const result = await obsController.pauseRecording();
            // Verify if actually paused
            const status = await obsController.getRecordingStatus();
            if (status && !status.outputPaused) {
                return { success: false, error: 'OBS, ayarlarınız sebebiyle (örn. hatalı kodek) duraklatmayı desteklemiyor.' };
            }
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-resume-recording', async () => {
        try {
            const result = await obsController.resumeRecording();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-stop-recording', async () => {
        try {
            const result = await obsController.stopRecording();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-recording-status', async () => {
        try {
            const result = await obsController.getRecordingStatus();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-video-settings', async () => {
        try {
            const result = await obsController.getVideoSettings();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-stream-service-settings', async () => {
        try {
            const result = await obsController.getStreamServiceSettings();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-set-stream-service-settings', async (event, params) => {
        try {
            const result = await obsController.setStreamServiceSettings(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-start-streaming', async () => {
        try {
            const result = await obsController.startStreaming();
            return { success: true, ...result };
        } catch (error) {
            const status = await obsController.getStreamingStatus().catch(() => null);
            const service = await obsController.getStreamServiceSettings().catch(() => null);
            return {
                success: false,
                error: error.message,
                status,
                service
            };
        }
    });

    ipcMain.handle('obs-stop-streaming', async () => {
        try {
            const result = await obsController.stopStreaming();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-streaming-status', async () => {
        try {
            const result = await obsController.getStreamingStatus();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-stats', async () => {
        try {
            const result = await obsController.getStats();
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-apply-video-quality-preset', async (_event, params) => {
        try {
            const result = await obsController.applyVideoQualityPreset(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-get-source-screenshot', async (event, params) => {
        try {
            const result = await obsController.getSourceScreenshot(params);
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('obs-launch', async () => {
        return obsController.launchOBS();
    });

    ipcMain.handle('obs-get-monitors', async () => {
        try {
            const result = await obsController.getMonitorList();
            return { success: true, monitors: result || [] };
        } catch (error) {
            return { success: false, error: error.message, monitors: [] };
        }
    });


    ipcMain.handle('obs-get-windows', async () => {
        try {
            const windows = await obsController.getWindowList();
            return { success: true, windows: windows || [] };
        } catch (error) {
            return { success: false, error: error.message, windows: [] };
        }
    });

    // Debug handler to inspect OBS source states
    ipcMain.handle('obs-debug-sources', async (event, { sceneName }) => {
        try {
            const result = await obsController.debugSceneSources(sceneName || 'KVE Kayıt');
            return { success: true, ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { setupObsIpcHandlers };
