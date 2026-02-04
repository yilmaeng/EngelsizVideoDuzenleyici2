const { ipcMain, dialog, Menu, BrowserWindow } = require('electron');
const ffmpegHandler = require('./ffmpeg-handler');
const ttsHandler = require('./tts-handler');
const mediaCompatibility = require('./media-compatibility-service');
const path = require('path');
const fs = require('fs');
const os = require('os');
// const geminiHandler = require('./gemini-handler'); // Removed to prevent duplicate registration


function setupIpcHandlers(mainWindow) {
    // Gemini handlers are already set up in index.js via gemini-handler module

    // Pencere başlığını ayarla
    ipcMain.on('set-window-title', (event, title) => {
        if (mainWindow) {
            mainWindow.setTitle(title);
        }
    });

    // Video metadata al (ve Probe)
    ipcMain.handle('get-video-metadata', async (event, filePath) => {
        try {
            const metadata = await ffmpegHandler.getVideoMetadata(filePath);
            return { success: true, data: metadata };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS Önizleme
    ipcMain.handle('preview-tts', async (event, { text, voice, speed, volume }) => {
        try {
            console.log('TTS Preview (Direct Speak):', { text, voice, speed });
            // Doğrudan hoparlörden oku (dosya oluşturma yok)
            await ttsHandler.speak(text, voice, speed);
            return { success: true, spokeDirect: true };
        } catch (error) {
            console.error('TTS Preview Error:', error);
            return { success: false, error: error.message };
        }
    });



    // Video kes
    ipcMain.handle('cut-video', async (event, { inputPath, outputPath, startTime, endTime }) => {
        try {
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideo(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Hızlı video kes (stream copy - re-encode yok)
    ipcMain.handle('cut-video-fast', async (event, { inputPath, outputPath, startTime, endTime }) => {
        try {
            // Fast cut logic for audio? cutAudio usually is fast enough or use copy codec.
            // For now, delegate to same cutAudio if audio, because cutVideoFast assumes video codec copy which might fail on some containers if stream mismatch.
            // But let's keep cutVideoFast for video. For audio, cutAudio does generic efficient cut.
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideoFast(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-fast', percent });
                });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Akıllı video kes (hızlı dene, olmazsa re-encode)
    ipcMain.handle('cut-video-smart', async (event, { inputPath, outputPath, startTime, endTime, options }) => {
        try {
            const ext = path.extname(inputPath).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.cutAudio) {
                await ffmpegHandler.cutAudio(inputPath, outputPath, startTime, endTime, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-audio', percent });
                });
            } else {
                await ffmpegHandler.cutVideoSmart(inputPath, outputPath, startTime, endTime, options || {}, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'cut-smart', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Timeline'ı tek seferde render et (Filter Complex - Single Pass)
    // Bu yöntem parçalama/birleştirme hatalarını önler
    ipcMain.handle('render-timeline', async (event, { inputPath, segments, outputPath }) => {
        try {
            await ffmpegHandler.renderTimeline(inputPath, segments, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'render-timeline', percent });
            });
            return { success: true };
        } catch (error) {
            console.error('Render timeline hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Videoları birleştir
    ipcMain.handle('concat-videos', async (event, { inputPaths, outputPath }) => {
        try {
            const firstInput = inputPaths[0];
            const ext = path.extname(firstInput).toLowerCase();
            const isAudio = ['.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma'].includes(ext);

            if (isAudio && ffmpegHandler.concatenateAudios) {
                await ffmpegHandler.concatenateAudios(inputPaths, outputPath, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat-audio', percent });
                });
            } else {
                await ffmpegHandler.concatenateVideos(inputPaths, outputPath, (percent) => {
                    mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat', percent });
                }, (log) => {
                    mainWindow.webContents.send('ffmpeg-log', log);
                });
            }
            return { success: true };
        } catch (error) {
            console.error('Concat error:', error);
            return { success: false, error: error.message };
        }
    });

    // Hızlı video birleştir (stream copy - aynı codec gerekli)
    ipcMain.handle('concat-videos-fast', async (event, { inputPaths, outputPath }) => {
        try {
            await ffmpegHandler.concatenateVideosFast(inputPaths, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'concat-fast', percent });
            }, (log) => {
                mainWindow.webContents.send('ffmpeg-log', log);
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video döndür
    ipcMain.handle('rotate-video', async (event, { inputPath, outputPath, degrees }) => {
        try {
            await ffmpegHandler.rotateVideo(inputPath, outputPath, degrees, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'rotate', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Ses çıkar
    ipcMain.handle('extract-audio', async (event, { inputPath, outputPath }) => {
        try {
            await ffmpegHandler.extractAudio(inputPath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'extract-audio', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video çıkar (sessiz)
    ipcMain.handle('extract-video', async (event, { inputPath, outputPath }) => {
        try {
            await ffmpegHandler.extractVideo(inputPath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'extract-video', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Ses karıştır
    // Ses karıştır
    ipcMain.handle('mix-audio', async (event, params) => {
        try {
            // ffmpegHandler.mixAudio artık tek bir obje parametresi + callback bekliyor
            await ffmpegHandler.mixAudio(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'mix-audio', percent });
            });
            return { success: true, outputPath: params.outputPath };
        } catch (error) {
            console.error('mix-audio hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Gelişmiş ses karıştırma
    ipcMain.handle('mix-audio-advanced', async (event, options) => {
        try {
            await ffmpegHandler.mixAudioAdvanced(options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'mix-audio-advanced', percent });
            });
            return { success: true, outputPath: options.outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosyayı Base64 olarak oku
    ipcMain.handle('read-file-base64', async (event, filePath) => {
        try {
            if (!fs.existsSync(filePath)) throw new Error('Dosya bulunamadı.');
            const buffer = fs.readFileSync(filePath);
            return { success: true, base64: buffer.toString('base64') };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });



    // Altyazı yak
    ipcMain.handle('burn-subtitles', async (event, { videoPath, subtitlePath, outputPath }) => {
        try {
            await ffmpegHandler.burnSubtitles(videoPath, subtitlePath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'burn-subtitles', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Metin ekle
    ipcMain.handle('add-text-overlay', async (event, params) => {
        try {
            const {
                videoPath, outputPath, text,
                font, fontSize, fontColor, background, position, transition,
                startTime, endTime, shadow,
                ttsEnabled, ttsVoice, ttsSpeed, ttsVolume, videoVolume
            } = params;
            const options = {
                font,
                fontSize,
                fontColor,
                background,
                position,
                transition,
                startTime,
                endTime,
                shadow,
                ttsEnabled,
                ttsVoice,
                ttsSpeed,
                ttsVolume,
                videoVolume
            };
            await ffmpegHandler.addTextOverlay(videoPath, outputPath, text, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-text', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Görsel overlay ekle
    ipcMain.handle('add-image-overlay', async (event, params) => {
        try {
            const { videoPath, imagePath, outputPath, options } = params;
            await ffmpegHandler.addImageOverlay(videoPath, imagePath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-image', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Geçiş efekti ekle
    ipcMain.handle('add-transition', async (event, params) => {
        try {
            const { videoPath, outputPath, options } = params;
            await ffmpegHandler.addTransition(videoPath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-transition', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            console.error('add-transition hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Akıllı Geçiş Uygulama (Toplu)
    ipcMain.handle('apply-transitions-smart', async (event, params) => {
        try {
            const { videoPath, outputPath, transitions } = params;
            await ffmpegHandler.applyTransitionsSmart(videoPath, outputPath, transitions, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'apply-transitions', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            console.error('Smart transition hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Base64 görüntüyü dosyaya kaydet (Geçici)
    ipcMain.handle('save-base64-image', async (event, { base64Data, filename }) => {
        try {
            const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(data, 'base64');
            const tempPath = path.join(os.tmpdir(), filename || `temp_img_${Date.now()}.png`);
            await fs.promises.writeFile(tempPath, buffer);
            return { success: true, filePath: tempPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Görsellerden video oluştur
    ipcMain.handle('create-video-from-images', async (event, { imagePaths, outputPath, duration }) => {
        try {
            await ffmpegHandler.createVideoFromImages(imagePaths, outputPath, duration, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'images-to-video', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Kare çıkar
    ipcMain.handle('extract-frame', async (event, { videoPath, outputPath, time }) => {
        try {
            await ffmpegHandler.extractFrame(videoPath, outputPath, time);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video dönüştürme
    ipcMain.handle('convert-video', async (event, { inputPath, outputPath, options }) => {
        try {
            await ffmpegHandler.safeConvertVideo(inputPath, outputPath, options, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'convert', percent });
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya varlık kontrolü
    ipcMain.handle('check-file-exists', async (event, filePath) => {
        try {
            return fs.existsSync(filePath);
        } catch (error) {
            console.error('File check error:', error);
            return false;
        }
    });

    // Ses mixleme (ffmpeg)spiti
    ipcMain.handle('detect-silence', async (event, { inputPath, minDuration, threshold }) => {
        try {
            const silences = await ffmpegHandler.detectSilence(inputPath, minDuration, threshold);
            return { success: true, data: silences };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Zaman formatla
    ipcMain.handle('format-time', (event, seconds) => {
        return ffmpegHandler.formatTime(seconds);
    });

    // Zaman parse et
    ipcMain.handle('parse-time', (event, timeString) => {
        return ffmpegHandler.parseTime(timeString);
    });

    // Hata mesajı göster
    ipcMain.handle('show-error', async (event, { title, message }) => {
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: title,
            message: message
        });
    });

    // Bilgi mesajı göster
    ipcMain.handle('show-info', async (event, { title, message }) => {
        await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: title,
            message: message
        });
    });

    // Generic Message Box
    ipcMain.handle('show-message-box', async (event, options) => {
        const result = await dialog.showMessageBox(mainWindow, options);
        return result;
    });

    // Onay diyaloğu
    ipcMain.handle('show-confirm', async (event, { title, message }) => {
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: title,
            message: message,
            buttons: ['Evet', 'Hayır'],
            defaultId: 0,
            cancelId: 1
        });
        return result.response === 0;
    });

    // Pencereyi kapat (dosyayı kapat, uygulama açık kalsın)
    ipcMain.on('close-window', () => {
        // Bu durumda video kapatılır ama pencere açık kalır
        // Renderer tarafında videoyu temizleyecek
        mainWindow.webContents.send('file-closed');
    });

    // Uygulamayı kapat
    ipcMain.on('quit-app', () => {
        mainWindow.close();
    });

    // Dosya açma diyaloğu
    ipcMain.handle('open-file-dialog', async (event, options) => {
        const result = await dialog.showOpenDialog(mainWindow, options);
        return result;
    });

    // Kaydetme onay diyaloğu (3 butonlu)
    ipcMain.handle('show-save-confirm', async (event, { title, message }) => {
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: title,
            message: message,
            buttons: ['Kaydet', 'Kaydetme', 'İptal'],
            defaultId: 0,
            cancelId: 2
        });
        // 0 = Kaydet, 1 = Kaydetme, 2 = İptal
        return result.response;
    });

    // Dosya kaydetme diyaloğu
    ipcMain.handle('show-save-dialog', async (event, options) => {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: options.title || 'Kaydet',
            defaultPath: options.defaultPath || 'video.mp4',
            filters: options.filters || [
                { name: 'Video Dosyaları', extensions: ['mp4'] },
                { name: 'Tüm Dosyalar', extensions: ['*'] }
            ]
        });
        return result;
    });


    // Filgranlı kare çıkar (AI için)
    ipcMain.handle('extract-frame-with-overlay', async (event, { videoPath, time, overlayPath, options }) => {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const tempBaseFrame = path.join(os.tmpdir(), `base_frame_${Date.now()}.jpg`);
        const tempCompositeFrame = path.join(os.tmpdir(), `comp_frame_${Date.now()}.jpg`);

        try {
            // 1. Ham kareyi çıkar
            await ffmpegHandler.extractFrame(videoPath, tempBaseFrame, time);

            // 2. Overlay ile birleştir
            if (overlayPath && fs.existsSync(overlayPath)) {
                await ffmpegHandler.compositeImage(tempBaseFrame, overlayPath, tempCompositeFrame, options);
                // Base64 oku
                const buffer = fs.readFileSync(tempCompositeFrame);

                // Temizlik
                try { fs.unlinkSync(tempBaseFrame); fs.unlinkSync(tempCompositeFrame); } catch (e) { }

                return { success: true, base64: buffer.toString('base64') };
            } else {
                // Overlay yoksa sadece ham kare
                const buffer = fs.readFileSync(tempBaseFrame);
                try { fs.unlinkSync(tempBaseFrame); } catch (e) { }
                return { success: true, base64: buffer.toString('base64') };
            }
        } catch (error) {
            console.error('Frame with overlay error:', error);
            // Cleanup on error
            try {
                if (fs.existsSync(tempBaseFrame)) fs.unlinkSync(tempBaseFrame);
                if (fs.existsSync(tempCompositeFrame)) fs.unlinkSync(tempCompositeFrame);
            } catch (e) { }
            return { success: false, error: error.message };
        }
    });



    // TTS: Yüklü sesleri al
    ipcMain.handle('get-tts-voices', async () => {
        try {
            const voices = await ttsHandler.getVoices();
            return { success: true, voices };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS: Metni WAV dosyasına çevir
    ipcMain.handle('generate-tts', async (event, { text, voice, speed, outputPath, volume }) => {
        try {
            const wavPath = outputPath || ttsHandler.getTempWavPath();
            await ttsHandler.textToWav(text, voice, speed, wavPath, volume);
            return { success: true, wavPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS: Önizleme için seslendir
    ipcMain.handle('tts-speak-preview', async (event, { text, voice, speed }) => {
        try {
            await ttsHandler.speak(text, voice, speed);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // TTS: Seslendirmeyi durdur
    ipcMain.handle('tts-stop', async () => {
        try {
            ttsHandler.stop();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Geçici dosya yolu oluştur
    ipcMain.handle('get-temp-path', async (event, filename) => {
        const os = require('os');
        return path.join(os.tmpdir(), filename);
    });

    // Dosya kopyala
    ipcMain.handle('copy-file', async (event, { src, dest }) => {
        const fs = require('fs');
        try {
            fs.copyFileSync(src, dest);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya sil (Toplu)
    ipcMain.handle('delete-files', async (event, filePaths) => {
        const fs = require('fs');
        try {
            for (const filePath of filePaths) {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
            return { success: true };
        } catch (error) {
            console.error('Dosya silme hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Dosya İçeriği Kaydet (JSON/Text)
    ipcMain.handle('save-file-content', async (event, { filePath, content }) => {
        try {
            const fs = require('fs');
            fs.writeFileSync(filePath, content, 'utf-8');
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Concat Audio
    ipcMain.handle('create-audio-from-concat', async (event, { concatFilePath, outputPath }) => {
        try {
            await ffmpegHandler.createAudioFromConcat(concatFilePath, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-audio-concat', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Generate Silence
    ipcMain.handle('generate-silence', async (event, { duration, outputPath }) => {
        try {
            await ffmpegHandler.generateSilence(duration, outputPath);
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });



    // Create Audio from Mix (Adelay + Amix)
    ipcMain.handle('create-audio-from-mix', async (event, { audioSegments, outputPath }) => {
        try {
            await ffmpegHandler.createAudioFromMix(audioSegments, outputPath, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'create-audio-mix', percent });
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Dosya İçeriği Oku
    ipcMain.handle('read-file-content', async (event, filePath) => {
        try {
            const fs = require('fs');
            if (!fs.existsSync(filePath)) throw new Error('Dosya bulunamadı');
            const content = fs.readFileSync(filePath, 'utf-8');
            return { success: true, content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === MEDIA COMPATIBILITY SERVICE ===

    // Akıllı dosya açma - uyumluluk kontrolü ve gerekirse dönüştürme
    ipcMain.handle('smart-open-video', async (event, filePath) => {
        try {
            const result = await mediaCompatibility.smartOpen(
                filePath,
                // Progress callback
                (progress) => {
                    mainWindow.webContents.send('media-compat-progress', progress);
                },
                // Status change callback
                (status) => {
                    mainWindow.webContents.send('media-compat-status', status);
                }
            );
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Sadece uyumluluk analizi yap (dönüştürme yapmadan)
    ipcMain.handle('analyze-video-compatibility', async (event, filePath) => {
        try {
            const analysis = await mediaCompatibility.analyzeCompatibility(filePath);
            return { success: true, ...analysis };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Video probe (detaylı metadata)
    ipcMain.handle('probe-video', async (event, filePath) => {
        try {
            const probe = await mediaCompatibility.probeVideo(filePath);
            return { success: true, probe };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Hızlı remux (container değiştir)
    ipcMain.handle('quick-remux', async (event, filePath) => {
        try {
            const result = await mediaCompatibility.quickRemux(filePath, (progress) => {
                mainWindow.webContents.send('ffmpeg-progress', {
                    operation: 'remux',
                    percent: progress.percent
                });
            });
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Tam transcode
    ipcMain.handle('smart-transcode', async (event, { filePath, options }) => {
        try {
            const result = await mediaCompatibility.transcode(filePath, options, (progress) => {
                mainWindow.webContents.send('ffmpeg-progress', {
                    operation: 'transcode',
                    percent: progress.percent,
                    stage: progress.stage,
                    speed: progress.speed
                });
            });
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Cache temizle
    ipcMain.handle('clear-media-cache', async (event, olderThanDays) => {
        try {
            const cleared = mediaCompatibility.clearCache(olderThanDays || 7);
            return { success: true, clearedFiles: cleared };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Cache boyutunu al
    ipcMain.handle('get-media-cache-size', async () => {
        try {
            const size = mediaCompatibility.getCacheSize();
            return { success: true, size };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Context Menu Göster
    ipcMain.on('show-context-menu', (event, template) => {
        if (!template || !Array.isArray(template)) return;

        const menuTemplate = template.map(item => ({
            label: item.label,
            click: () => {
                event.sender.send('context-menu-command', { action: item.click, id: item.id, index: item.index });
            }
        }));

        const menu = Menu.buildFromTemplate(menuTemplate);
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            menu.popup({ window: win });
        }
    });

    // --- SYNC WIZARD HANDLERS ---

    // Open Sync Wizard (from Renderer)
    ipcMain.on('open-sync-wizard', (event, mode) => {
        const { openSyncWizard } = require('./dialog-windows');
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            openSyncWizard(win, mode);
        }
    });

    // Render Sync Video
    ipcMain.handle('render-sync-video', async (event, { videoPath, audioPath, offsetMs, muteOriginal, targetOutputPath }) => {
        try {
            const path = require('path');
            // If targetOutputPath is provided, use it. Otherwise default to auto-generated.
            const outputPath = targetOutputPath || path.join(path.dirname(videoPath), `synced_output_${Date.now()}.mp4`);

            await ffmpegHandler.replaceAudio(videoPath, audioPath, offsetMs, muteOriginal, outputPath, (percent) => {
                // Optional: Send progress back?
            });
            return { success: true, outputPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Save Temp Recording
    ipcMain.handle('save-temp-recording', async (event, buffer) => {
        try {
            const path = require('path');
            const os = require('os');
            const fs = require('fs');
            const tempName = `rec_${Date.now()}`;
            const videoPath = path.join(os.tmpdir(), `${tempName}.webm`);
            const audioPath = path.join(os.tmpdir(), `${tempName}.wav`);

            fs.writeFileSync(videoPath, buffer);

            // Extract Audio and Normalize
            await new Promise((resolve, reject) => {
                const ffmpeg = require('fluent-ffmpeg');
                ffmpeg(videoPath)
                    .audioFilters('dynaudnorm=f=150:g=15:m=10.0') // SESİ DENGELER VE GÜÇLENDİRİR
                    .output(audioPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            return { success: true, videoPath, audioPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Helper for Wizard File Selection
    ipcMain.handle('show-open-dialog', async (event, { extensions }) => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
            filters: [
                { name: 'Media Files', extensions: extensions || ['*'] }
            ],
            properties: ['openFile']
        });
        return result;
    });




    // === VIDEO LAYER (Picture-in-Picture) HANDLERS ===

    // CTA Overlay Ekle
    ipcMain.handle('add-cta-overlay', async (event, params) => {
        try {
            await ffmpegHandler.addCtaOverlay(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-cta-overlay', percent });
            });
            return { success: true, outputPath: params.outputPath };
        } catch (error) {
            console.error('CTA Overlay Hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Video katmanı ekle
    ipcMain.handle('add-video-layer', async (event, params) => {
        try {
            const result = await ffmpegHandler.addVideoLayer(params, (percent) => {
                mainWindow.webContents.send('ffmpeg-progress', { operation: 'add-video-layer', percent });
            });
            return { success: true, outputPath: result };
        } catch (error) {
            console.error('Video katmanı ekleme hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // AI ile konum önerisi al
    ipcMain.handle('get-video-layer-ai-suggestion', async (event, params) => {
        try {
            const { mainVideoPath, layerVideoPath, purpose, currentTime } = params;

            // Video metadata'larını al
            const mainMeta = await ffmpegHandler.getVideoMetadata(mainVideoPath);
            const layerMeta = await ffmpegHandler.getVideoMetadata(layerVideoPath);

            const mainWidth = mainMeta.width || 1920;
            const mainHeight = mainMeta.height || 1080;

            // Amaca göre varsayılan öneriler
            let suggestions = [];

            switch (purpose) {
                case 'sign-language':
                    // İşaret dili: Sağ alt, %12.5 (Türkiye standardı: 8'de bir)
                    const slWidth = Math.round(mainWidth * 0.125);
                    const slHeight = Math.round(slWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: mainWidth - slWidth - 20,
                        y: mainHeight - slHeight - 20,
                        width: slWidth,
                        height: slHeight,
                        position: 'Sağ Alt',
                        reason: 'İşaret dili için Türkiye standardı konumu (%12.5, 8\'de bir).'
                    });
                    break;

                case 'split-screen':
                    // Split screen: Sol yarı
                    suggestions.push({
                        x: 0,
                        y: 0,
                        width: Math.round(mainWidth / 2),
                        height: mainHeight,
                        position: 'Sol Yarı',
                        reason: 'Split screen modu için sol yarı.'
                    });
                    break;

                case 'camera-corner':
                    // Kamera köşede: Sağ üst, %15
                    const ccWidth = Math.round(mainWidth * 0.15);
                    const ccHeight = Math.round(ccWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: mainWidth - ccWidth - 10,
                        y: 10,
                        width: ccWidth,
                        height: ccHeight,
                        position: 'Sağ Üst',
                        reason: 'Köşe kamera için ideal konum.'
                    });
                    break;

                default:
                    // Serbest: Merkez-alt öner
                    const defWidth = Math.round(mainWidth * 0.25);
                    const defHeight = Math.round(defWidth * (layerMeta.height / layerMeta.width));
                    suggestions.push({
                        x: Math.round((mainWidth - defWidth) / 2),
                        y: mainHeight - defHeight - 20,
                        width: defWidth,
                        height: defHeight,
                        position: 'Alt Orta',
                        reason: 'İçeriği kapatmayan merkezi konum.'
                    });
            }

            return {
                success: true,
                suggestions,
                mainResolution: { width: mainWidth, height: mainHeight },
                layerResolution: { width: layerMeta.width, height: layerMeta.height }
            };
        } catch (error) {
            console.error('AI öneri hatası:', error);
            return { success: false, error: error.message };
        }
    });

    // Dosya Yeniden Adlandır
    ipcMain.handle('rename-file', async (event, { oldPath, newPath }) => {
        try {
            // Önce hedef dosya varsa sil
            if (fs.existsSync(newPath)) {
                fs.unlinkSync(newPath);
            }
            fs.renameSync(oldPath, newPath);
            return { success: true };
        } catch (error) {
            console.error('Dosya yeniden adlandırma hatası:', error);
            return { success: false, error: error.message };
        }
    });

}

module.exports = { setupIpcHandlers };

