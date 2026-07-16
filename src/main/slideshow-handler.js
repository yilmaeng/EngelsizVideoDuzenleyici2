/**
 * Slideshow Proje Handler
 * Slideshow (Resim + Ses) projesi için IPC handler'ları
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');
const heicConvert = require('heic-convert');
const sharp = require('sharp');
const i18n = require('./i18n');
const { getVisualOrientation, buildSmartStillImagePlacementFilter, buildFitPadFilter, buildCropFillFilter, buildBlurFillFilter } = require('./media-placement');

let newProjectWindow = null;
let slideshowEditorWindow = null;
let currentProjectSettings = null;
let storedMainWindow = null; // Ana pencere referansını sakla

function t(key, fallback, params) {
    const value = i18n.t(key, params);
    return value.startsWith('[') ? fallback : value;
}

function formatDurationClock(totalSeconds) {
    const safeSeconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function announceDialogForAccessibility(targetWindow, options = {}) {
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.webContents) {
        return;
    }

    const payload = {
        title: String(options.title || '').trim(),
        message: String(options.message || '').trim(),
        detail: String(options.detail || '').trim()
    };

    if (!payload.title && !payload.message && !payload.detail) {
        return;
    }

    try {
        targetWindow.webContents.send('accessibility-dialog-announce', payload);
        await new Promise((resolve) => setTimeout(resolve, 420));
    } catch (error) {
        console.warn('Slideshow dialog accessibility announcement failed:', error.message);
    }
}

async function getImageInfo(imagePath) {
    const metadata = await sharp(imagePath).metadata();
    const orientation = Number(metadata.orientation || 1);
    const rawWidth = Number(metadata.width || 1920);
    const rawHeight = Number(metadata.height || 1080);
    const rotatesDimensions = [5, 6, 7, 8].includes(orientation);

    return {
        width: rotatesDimensions ? rawHeight : rawWidth,
        height: rotatesDimensions ? rawWidth : rawHeight,
        orientation,
        format: String(metadata.format || '').toLowerCase()
    };
}

function isFfmpegFriendlyStillImage(info, imagePath) {
    const ext = String(path.extname(imagePath) || '').toLowerCase();
    const format = String(info?.format || '').toLowerCase();
    const safeExtensions = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
    const safeFormats = new Set(['jpeg', 'png', 'bmp', 'gif', 'webp']);

    return safeExtensions.has(ext) && safeFormats.has(format);
}

function canAutoConvertImportImage(item) {
    const format = String(item?.format || '').toLowerCase();
    return item?.reason === 'unsupported_format' && format === 'heif';
}

function buildConvertedImportImagePath(imagePath) {
    const directory = path.dirname(imagePath);
    const baseName = path.parse(imagePath).name.replace(/\.+$/, '');
    return path.join(directory, `${baseName}_EVD-converted.jpg`);
}

async function validateConvertedImportImage(imagePath, options = {}) {
    const info = await getImageInfo(imagePath);
    const skipExtensionCheck = Boolean(options.skipExtensionCheck);
    if (!skipExtensionCheck && !isFfmpegFriendlyStillImage(info, imagePath)) {
        throw new Error('Converted image is not ffmpeg-friendly.');
    }
    if (skipExtensionCheck) {
        const safeFormats = new Set(['jpeg', 'png', 'bmp', 'gif', 'webp']);
        if (!safeFormats.has(String(info?.format || '').toLowerCase())) {
            throw new Error('Converted image format is invalid.');
        }
    }
    if (!info.width || !info.height) {
        throw new Error('Converted image dimensions are invalid.');
    }
    return info;
}

async function convertImportImageToJpeg(imagePath) {
    const targetPath = buildConvertedImportImagePath(imagePath);
    const sourceStat = await fs.promises.stat(imagePath);

    if (fs.existsSync(targetPath)) {
        try {
            const targetStat = await fs.promises.stat(targetPath);
            if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
                await validateConvertedImportImage(targetPath);
                return targetPath;
            }
        } catch (error) {
            try {
                await fs.promises.unlink(targetPath);
            } catch (unlinkError) {
                console.warn('[Slideshow] Stale converted import image cleanup failed:', unlinkError.message);
            }
        }
    }

    const inputBuffer = await fs.promises.readFile(imagePath);
    const outputBuffer = await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 1
    });

    const tempPath = `${targetPath}.partial.jpg`;
    await fs.promises.writeFile(tempPath, outputBuffer);

    try {
        await validateConvertedImportImage(tempPath, { skipExtensionCheck: true });
        await fs.promises.rm(targetPath, { force: true });
        await fs.promises.rename(tempPath, targetPath);
    } catch (error) {
        try {
            await fs.promises.unlink(tempPath);
        } catch (unlinkError) {
            console.warn('[Slideshow] Failed to remove invalid temp converted image:', unlinkError.message);
        }
        throw error;
    }

    return targetPath;
}

async function inspectSlideshowImportImage(imagePath) {
    try {
        const info = await getImageInfo(imagePath);
        if (isFfmpegFriendlyStillImage(info, imagePath)) {
            return {
                ok: true,
                path: imagePath,
                info
            };
        }

        return {
            ok: false,
            path: imagePath,
            reason: 'unsupported_format',
            format: String(info?.format || '').toUpperCase() || t('runtime.slideshow_editor.unknown', 'Unknown'),
            canAutoConvert: String(info?.format || '').toLowerCase() === 'heif'
        };
    } catch (error) {
        return {
            ok: false,
            path: imagePath,
            reason: 'read_error',
            error: error.message,
            canAutoConvert: false
        };
    }
}

async function prepareSlideshowImages(images) {
    const preparedImages = [];
    const cleanupPaths = [];

    for (const image of images) {
        try {
            const info = await getImageInfo(image.path);
            const manualRotation = ((Number(image.rotation || 0) % 360) + 360) % 360;
            const needsFormatNormalization = !isFfmpegFriendlyStillImage(info, image.path);
            const needsNormalization = info.orientation !== 1 || manualRotation !== 0 || needsFormatNormalization;

            if (!needsNormalization) {
                preparedImages.push({
                    ...image,
                    width: info.width,
                    height: info.height
                });
                continue;
            }

            const ext = needsFormatNormalization ? '.jpg' : (path.extname(image.path) || '.jpg');
            const normalizedPath = path.join(os.tmpdir(), `slideshow_norm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`);

            let pipeline = sharp(image.path).rotate();
            if (manualRotation !== 0) {
                pipeline = pipeline.rotate(manualRotation);
            }

            if (needsFormatNormalization) {
                pipeline = pipeline.jpeg({ quality: 95 });
            }

            await pipeline.toFile(normalizedPath);

            const normalizedInfo = await getImageInfo(normalizedPath);

            cleanupPaths.push(normalizedPath);
            preparedImages.push({
                ...image,
                path: normalizedPath,
                width: normalizedInfo.width,
                height: normalizedInfo.height
            });
        } catch (error) {
            console.warn('[Slideshow] Image normalization skipped:', image.path, error.message);
            const fileName = path.basename(image.path || '');
            const formatMatch = String(error.message || '').match(/heif|heic|avif/i);
            const detectedFormat = formatMatch ? formatMatch[0].toUpperCase() : null;

            if (detectedFormat) {
                throw new Error(t(
                    'runtime.slideshow_editor.unsupported_image_format',
                    'The image file "{name}" uses the {format} format. This format could not be prepared for slideshow export on this system. Please convert the file to JPG or PNG and try again.',
                    {
                        name: fileName,
                        format: detectedFormat
                    }
                ));
            }

            throw new Error(t(
                'runtime.slideshow_editor.image_prepare_failed',
                'The image file "{name}" could not be prepared for slideshow export: {error}',
                {
                    name: fileName,
                    error: error.message
                }
            ));
        }
    }

    return {
        images: preparedImages,
        cleanup: () => {
            cleanupPaths.forEach(filePath => {
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (cleanupError) {
                    console.warn('[Slideshow] Normalized temp cleanup failed:', cleanupError.message);
                }
            });
        }
    };
}

async function prepareImageForAnalysis(imageInput) {
    const image = typeof imageInput === 'string'
        ? { path: imageInput, rotation: 0 }
        : imageInput;

    if (!image?.path) {
        throw new Error('Image path is required for analysis.');
    }

    const prepared = await prepareSlideshowImages([image]);
    const preparedImage = prepared.images[0];

    if (!preparedImage?.path) {
        prepared.cleanup();
        throw new Error('Prepared image could not be created for analysis.');
    }

    return {
        image: preparedImage,
        cleanup: prepared.cleanup
    };
}

function getAiLanguage() {
    const langMap = { tr: 'Turkish', en: 'English', de: 'German', es: 'Spanish', fr: 'French' };
    const currentLang = i18n.getCurrentLanguage ? i18n.getCurrentLanguage() : 'tr';
    return langMap[currentLang] || 'English';
}

function requestGeminiVisualAnalysis(apiKey, visualInput, prompt, aiLang) {
    return new Promise((resolve, reject) => {
        let requestBody = null;
        try {
            let mimeType = 'image/jpeg';
            let base64 = '';

            if (typeof visualInput === 'string') {
                const imageBuffer = fs.readFileSync(visualInput);
                base64 = imageBuffer.toString('base64');
            } else if (visualInput?.data) {
                mimeType = visualInput.mimeType || mimeType;
                base64 = visualInput.data;
            } else {
                throw new Error('Visual input is required.');
            }

            requestBody = JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64
                            }
                        },
                        { text: prompt }
                    ]
                }],
                systemInstruction: {
                    parts: [{ text: `Reply only in ${aiLang}.` }]
                },
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096
                }
            });
        } catch (error) {
            reject(error);
            return;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.error) {
                        reject(new Error(response.error.message));
                        return;
                    }

                    if (response.candidates && response.candidates[0] &&
                        response.candidates[0].content &&
                        response.candidates[0].content.parts) {
                        const text = response.candidates[0].content.parts
                            .map(p => p.text)
                            .join('');
                        resolve(text);
                        return;
                    }

                    reject(new Error(t('runtime.slideshow_editor.invalid_api_response', 'Invalid API response.')));
                } catch (error) {
                    reject(new Error(t('runtime.slideshow_editor.api_response_parse_error', 'API response could not be processed: {error}', {
                        error: error.message
                    })));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error(t('runtime.slideshow_editor.connection_error', 'Connection error: {error}', {
                error: error.message
            })));
        });

        req.write(requestBody);
        req.end();
    });
}

/**
 * Slideshow handler'larını kur
 */
function setupSlideshowHandlers(mainWindow) {
    // Belirli resimlere yazı ekleme diyaloğu
    ipcMain.on('slideshow-add-text-to-image', async (event, data) => {
        console.log('slideshow-add-text-to-image alındı:', data);
        if (slideshowEditorWindow) {
            slideshowEditorWindow.webContents.send('request-image-list');

            ipcMain.once('image-list-response', (evt, imageList) => {
                openTextOverlayForSlideshow(storedMainWindow, {
                    images: imageList || [],
                    imageIds: data.imageIds || []
                });
            });
        }
    });

    storedMainWindow = mainWindow; // Ana pencereyi sakla

    // Yeni proje diyaloğunu aç
    ipcMain.on('slideshow-new-project', () => {
        openNewProjectDialog(storedMainWindow);
    });

    // Yeni proje oluştur
    ipcMain.on('slideshow-project-create', (event, settings) => {
        console.log('slideshow-project-create alındı:', settings);
        currentProjectSettings = settings;

        // Yeni proje diyaloğunu kapat
        if (newProjectWindow) {
            newProjectWindow.close();
            newProjectWindow = null;
        }

        // Slideshow düzenleyiciyi aç
        openSlideshowEditor(storedMainWindow, settings);
    });

    // Yeni proje iptal
    ipcMain.on('slideshow-project-cancel', () => {
        if (newProjectWindow) {
            newProjectWindow.close();
            newProjectWindow = null;
        }
    });

    ipcMain.on('slideshow-open-project-file', (_event, filePath) => {
        if (!filePath) return;
        openProjectFile(storedMainWindow, filePath);
    });

    // Slideshow'u kapat
    ipcMain.on('slideshow-close', () => {
        if (slideshowEditorWindow) {
            slideshowEditorWindow.close();
            slideshowEditorWindow = null;
        }
    });

    // Resim ekleme diyaloğu
    ipcMain.on('slideshow-add-images', async () => {
        const result = await dialog.showOpenDialog(slideshowEditorWindow, {
            title: t('dialog.slideshow_editor.select_images_title', 'Select Image Files'),
            filters: [
                { name: t('dialog.slideshow_editor.image_files_filter', 'Image Files'), extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'] }
            ],
            properties: ['openFile', 'multiSelections']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            const inspected = await Promise.all(result.filePaths.map(inspectSlideshowImportImage));
            const supportedPaths = inspected.filter(item => item.ok).map(item => item.path);
            const unsupportedItems = inspected.filter(item => !item.ok);

            if (unsupportedItems.length > 0) {
                slideshowEditorWindow.webContents.send('slideshow-import-warning', {
                    supportedPaths,
                    unsupportedItems
                });
                return;
            }

            slideshowEditorWindow.webContents.send('slideshow-images-selected', supportedPaths);
        }
    });

    ipcMain.on('slideshow-add-videos', async () => {
        const result = await dialog.showOpenDialog(slideshowEditorWindow, {
            title: t('dialog.slideshow_editor.select_videos_title', 'Select Video Files'),
            filters: [
                { name: t('dialog.slideshow_editor.video_files_filter', 'Video Files'), extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }
            ],
            properties: ['openFile', 'multiSelections']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            slideshowEditorWindow.webContents.send('slideshow-videos-selected', result.filePaths);
        }
    });

    ipcMain.handle('slideshow-convert-import-images', async (_event, unsupportedItems) => {
        const items = Array.isArray(unsupportedItems) ? unsupportedItems.filter(canAutoConvertImportImage) : [];
        const convertedPaths = [];
        const failedItems = [];

        for (const item of items) {
            try {
                const convertedPath = await convertImportImageToJpeg(item.path);
                convertedPaths.push(convertedPath);
            } catch (error) {
                failedItems.push({
                    path: item.path,
                    format: item.format,
                    error: error.message
                });
            }
        }

        return { convertedPaths, failedItems };
    });

    // Ses ekleme diyaloğu
    ipcMain.on('slideshow-add-audio', async () => {
        const result = await dialog.showOpenDialog(slideshowEditorWindow, {
            title: t('dialog.slideshow_editor.select_audio_title', 'Select Audio File'),
            filters: [
                { name: t('dialog.slideshow_editor.audio_files_filter', 'Audio Files'), extensions: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'] }
            ],
            properties: ['openFile', 'multiSelections']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            slideshowEditorWindow.webContents.send('slideshow-audio-selected', result.filePaths);
        }
    });

    // Yazı ekleme diyaloğu aç - resim listesini slideshow editorden iste
    ipcMain.on('slideshow-add-text', async (event, data) => {
        console.log('slideshow-add-text alındı');

        // Eğer data.images gelmediyse, slideshow editordan isteyelim
        if (!data || !data.images || data.images.length === 0) {
            console.log('Resim listesi boş, slideshow editorden isteniyor...');

            if (slideshowEditorWindow) {
                // Slideshow editordan resim listesini iste
                slideshowEditorWindow.webContents.send('request-image-list');

                // Yanıtı bekle
                ipcMain.once('image-list-response', (evt, imageList) => {
                    console.log('Resim listesi alındı:', imageList ? imageList.length : 0);
                    openTextOverlayForSlideshow(storedMainWindow, { images: imageList || [] });
                });
            } else {
                openTextOverlayForSlideshow(storedMainWindow, { images: [] });
            }
        } else {
            openTextOverlayForSlideshow(storedMainWindow, data);
        }
    });

    // Yazı ekleme diyaloğundan gelen sonuç
    ipcMain.on('slideshow-text-added', (event, textData) => {
        if (slideshowEditorWindow) {
            slideshowEditorWindow.webContents.send('slideshow-text-result', textData);
        }
    });

    // Yazı düzenleme diyaloğu aç 
    ipcMain.on('slideshow-edit-text', async (event, data) => {
        console.log('slideshow-edit-text alındı:', JSON.stringify(data, null, 2));

        // Eğer resim listesi yoksa veya boşsa, slideshow editorden isteyelim
        if (!data.images || data.images.length === 0) {
            console.log('Resim listesi boş, slideshow editor\'dan isteniyor...');
            if (slideshowEditorWindow) {
                slideshowEditorWindow.webContents.send('request-image-list');

                ipcMain.once('image-list-response', (evt, imageList) => {
                    console.log('Resim listesi alındı:', imageList ? imageList.length : 0);
                    data.images = imageList || [];
                    openTextOverlayForSlideshow(storedMainWindow, data);
                });
            } else {
                console.log('slideshowEditorWindow yok, direkt açılıyor');
                openTextOverlayForSlideshow(storedMainWindow, data);
            }
        } else {
            console.log('Resim listesi mevcut, pencere açılıyor. Resim sayısı:', data.images.length);
            openTextOverlayForSlideshow(storedMainWindow, data);
        }
    });

    // Yazı güncelleme
    ipcMain.on('slideshow-text-updated', (event, { editIndex, textData }) => {
        if (slideshowEditorWindow) {
            slideshowEditorWindow.webContents.send('slideshow-text-update-result', { editIndex, textData });
        }
    });

    ipcMain.on('slideshow-preview', (event, { projectData, options }) => {
        const normalizedProjectData = normalizeSlideshowProjectData(projectData);
        const previewWindow = new BrowserWindow({
            width: 1000,
            height: 700,
            parent: slideshowEditorWindow,
            modal: true,
            backgroundColor: '#000000',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });
        previewWindow.setMenu(null);
        previewWindow.loadFile(path.join(__dirname, '../renderer/dialogs/slideshow-preview.html'));
        previewWindow.once('ready-to-show', () => {
            previewWindow.webContents.send('preview-init', { projectData: normalizedProjectData, options });
            previewWindow.show();
        });
    });

    // Resim bilgisi al
    ipcMain.handle('get-image-info', async (event, imagePath) => {
        try {
            const info = await getImageInfo(imagePath);
            return {
                width: info.width,
                height: info.height,
                orientation: info.orientation
            };
        } catch (error) {
            console.warn('[Slideshow] get-image-info fallback used:', error.message);
            return { width: 1920, height: 1080, orientation: 1 };
        }
    });

    // Ses bilgisi al
    ipcMain.handle('get-audio-info', async (event, audioPath) => {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
            // Portable/asar için yol düzeltmesi
            if (ffmpegPath.includes('app.asar')) {
                ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
            }

            exec(`"${ffmpegPath}" -i "${audioPath}" 2>&1`, (error, stdout, stderr) => {
                const output = stdout + stderr;

                // Süre bilgisini al
                const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (durationMatch) {
                    const hours = parseInt(durationMatch[1]);
                    const minutes = parseInt(durationMatch[2]);
                    const seconds = parseInt(durationMatch[3]);
                    const ms = parseInt(durationMatch[4]) / 100;
                    const totalSeconds = hours * 3600 + minutes * 60 + seconds + ms;
                    resolve({ duration: totalSeconds });
                } else {
                    resolve({ duration: 0 });
                }
            });
        });
    });

    ipcMain.handle('get-video-info', async (_event, videoPath) => {
        const ffprobePath = getFFprobePath();
        return new Promise((resolve) => {
            exec(`"${ffprobePath}" -v quiet -print_format json -show_streams -show_format "${videoPath}"`, (error, stdout) => {
                if (error || !stdout) {
                    resolve({ duration: 0, width: 1920, height: 1080 });
                    return;
                }

                try {
                    const parsed = JSON.parse(stdout);
                    const videoStream = Array.isArray(parsed.streams)
                        ? parsed.streams.find(stream => stream.codec_type === 'video')
                        : null;
                    const duration = Number(parsed?.format?.duration || videoStream?.duration || 0);
                    const width = Number(videoStream?.width || 1920);
                    const height = Number(videoStream?.height || 1080);
                    resolve({
                        duration: Number.isFinite(duration) ? duration : 0,
                        width,
                        height
                    });
                } catch (parseError) {
                    resolve({ duration: 0, width: 1920, height: 1080 });
                }
            });
        });
    });

    // Resmi base64'e çevir (AI için)
    ipcMain.handle('get-image-base64', async (event, imagePath) => {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            return imageBuffer.toString('base64');
        } catch (error) {
            console.error('Image read error:', error);
            throw new Error(t('runtime.slideshow_editor.image_read_error', 'Image could not be read: {error}', {
                error: error.message
            }));
        }
    });

    // Input diyaloğu
    ipcMain.handle('show-input-dialog', async (event, options) => {
        // Basit bir prompt için küçük bir pencere oluşturabiliriz
        // Şimdilik dialog.showMessageBox kullanıyoruz
        const dialogOptions = {
            type: 'question',
            title: options.title,
            message: options.message,
            buttons: [t('dialog.common.ok', 'OK'), t('dialog.cancel', 'Cancel')],
            defaultId: 0,
            cancelId: 1
        };
        await announceDialogForAccessibility(slideshowEditorWindow, dialogOptions);
        const { response } = await dialog.showMessageBox(slideshowEditorWindow, dialogOptions);

        if (response === 0) {
            return options.defaultValue; // Şimdilik varsayılan değeri döndür
        }
        return null;
    });

    // Mesaj diyaloğu
    ipcMain.handle('show-message-dialog', async (event, options) => {
        const dialogOptions = {
            type: 'info',
            title: options.title,
            message: options.message,
            buttons: [t('dialog.common.ok', 'OK')]
        };
        await announceDialogForAccessibility(slideshowEditorWindow, dialogOptions);
        await dialog.showMessageBox(slideshowEditorWindow, dialogOptions);
    });

    // AI ile resim betimleme
    ipcMain.handle('describe-image-ai', async (event, imageInput) => {
        const geminiHandler = require('./gemini-handler');
        const apiKey = geminiHandler.getApiKey();

        if (!apiKey) {
            throw new Error(t('runtime.slideshow_editor.api_key_missing', 'API key was not found. Please enter the API key in AI settings first.'));
        }

        const preparedAnalysis = await prepareImageForAnalysis(imageInput);

        // Gemini'ye istek gönder
        const aiLang = getAiLanguage();
        const prompt = `Describe this image in two ways and assess whether the photo orientation looks correct. Respond only in ${aiLang}.
1. SHORT (maximum 100 characters): a very brief summary of the image
2. DETAILED: a detailed description of the image
3. ORIENTATION: choose exactly one of these values:
- CORRECT
- ROTATE_LEFT
- ROTATE_RIGHT
- UNCERTAIN
4. ORIENTATION_NOTE: one short sentence for the user. If the orientation looks correct, clearly say there is no orientation problem. If the photo looks sideways, say whether they should rotate left or right. If unsure, say you are not sure.

Important orientation rule:
- ROTATE_LEFT means the app should rotate the image 90 degrees counterclockwise on screen.
- ROTATE_RIGHT means the app should rotate the image 90 degrees clockwise on screen.
- Choose the direction that makes people and objects appear upright in the final result.
- If a person would become upside down after that rotation, then that direction is wrong.
- Be conservative. If you are not confident, return UNCERTAIN instead of guessing.

Return your answer in exactly this format:
SHORT: [short description]
DETAILED: [detailed description]
ORIENTATION: [CORRECT/ROTATE_LEFT/ROTATE_RIGHT/UNCERTAIN]
ORIENTATION_NOTE: [short user-facing note]`;
        try {
            const text = await requestGeminiVisualAnalysis(apiKey, preparedAnalysis.image.path, prompt, aiLang);

            const shortMatch = text.match(/(?:SHORT|KISA):\s*(.+?)(?=(?:DETAILED|DETAYLI):|$)/is);
            const longMatch = text.match(/(?:DETAILED|DETAYLI):\s*(.+?)(?=(?:ORIENTATION|YON|YÖN):|(?:ORIENTATION_NOTE|YON_NOTU|YÖN_NOTU):|$)/is);
            const orientationMatch = text.match(/(?:ORIENTATION|YON|YÖN):\s*(CORRECT|ROTATE_LEFT|ROTATE_RIGHT|UNCERTAIN)/i);
            const orientationNoteMatch = text.match(/(?:ORIENTATION_NOTE|YON_NOTU|YÖN_NOTU):\s*(.+)/is);
            const orientationStatus = orientationMatch ? orientationMatch[1].toUpperCase() : 'UNCERTAIN';

            let orientationMessage = orientationNoteMatch ? orientationNoteMatch[1].trim() : '';
            if (!orientationMessage) {
                const orientationMessageMap = {
                    CORRECT: t('runtime.slideshow_editor.orientation_ai_correct', 'The photo direction looks correct. There does not appear to be an orientation problem.'),
                    ROTATE_LEFT: t('runtime.slideshow_editor.orientation_ai_rotate_left', 'The photo looks sideways. Try rotating it left.'),
                    ROTATE_RIGHT: t('runtime.slideshow_editor.orientation_ai_rotate_right', 'The photo looks sideways. Try rotating it right.'),
                    UNCERTAIN: t('runtime.slideshow_editor.orientation_ai_uncertain', 'The photo direction is unclear. Please check it visually.')
                };
                orientationMessage = orientationMessageMap[orientationStatus] || orientationMessageMap.UNCERTAIN;
            }

            return {
                short: shortMatch ? shortMatch[1].trim().substring(0, 100) : t('runtime.slideshow_editor.description_unavailable', 'Description unavailable'),
                long: longMatch ? longMatch[1].trim() : text,
                orientationStatus,
                orientationMessage
            };
        } finally {
            preparedAnalysis.cleanup();
        }
    });

    ipcMain.handle('describe-slideshow-preview-scene-ai', async (event, sceneInput) => {
        const geminiHandler = require('./gemini-handler');
        const apiKey = geminiHandler.getApiKey();

        if (!apiKey) {
            throw new Error(t('runtime.slideshow_editor.api_key_missing', 'API key was not found. Please enter the API key in AI settings first.'));
        }

        const preparedAnalysis = await prepareImageForAnalysis({
            path: sceneInput?.imagePath,
            rotation: Number(sceneInput?.rotation || 0)
        });

        const aiLang = getAiLanguage();
        const visibleTexts = Array.isArray(sceneInput?.visibleTexts) ? sceneInput.visibleTexts.filter(Boolean) : [];
        const previewFillFrameApplied = !!sceneInput?.previewFillFrameApplied;
        const targetAspectRatio = sceneInput?.targetAspectRatio || '16:9';
        const cropModeText = previewFillFrameApplied
            ? 'The image is filling the frame, so cropping may happen.'
            : 'The image is fit inside the frame with padding, so cropping should not happen.';

        const prompt = `Analyze this slideshow preview scene. Respond only in ${aiLang}, but keep the field names exactly in English as shown below.

The target video aspect ratio is ${targetAspectRatio}.
${cropModeText}
Visible on-screen text: ${visibleTexts.length > 0 ? visibleTexts.join(' | ') : 'No visible overlay text.'}

Tasks:
1. SHORT: Give a very short description of the currently visible scene.
2. DETAILED: Describe the visible scene naturally, including important visual details and any visible overlay text.
3. VISIBLE_TEXT: Briefly summarize the text that is visible on screen. If there is none, clearly say there is no visible text.
4. ORIENTATION: choose exactly one of these values:
- CORRECT
- ROTATE_LEFT
- ROTATE_RIGHT
- UNCERTAIN
5. ORIENTATION_NOTE: one short user-facing sentence about whether the image looks sideways or correct.
6. CROP_RISK: choose exactly one of these values:
- SAFE
- POSSIBLE
- UNCERTAIN
7. CROP_NOTE: one short user-facing sentence explaining whether the current slideshow framing may crop important content such as the top of the head, face, hands, or the main subject. If the image is fit with padding and no cropping should happen, clearly say there is no cropping problem expected.

Return your answer in exactly this format:
SHORT: [short description]
DETAILED: [detailed description]
VISIBLE_TEXT: [text summary]
ORIENTATION: [CORRECT/ROTATE_LEFT/ROTATE_RIGHT/UNCERTAIN]
ORIENTATION_NOTE: [orientation note]
CROP_RISK: [SAFE/POSSIBLE/UNCERTAIN]
CROP_NOTE: [crop note]`;

        try {
            const text = await requestGeminiVisualAnalysis(apiKey, preparedAnalysis.image.path, prompt, aiLang);

            const shortMatch = text.match(/SHORT:\s*(.+?)(?=DETAILED:|$)/is);
            const detailedMatch = text.match(/DETAILED:\s*(.+?)(?=VISIBLE_TEXT:|ORIENTATION:|$)/is);
            const visibleTextMatch = text.match(/VISIBLE_TEXT:\s*(.+?)(?=ORIENTATION:|$)/is);
            const orientationMatch = text.match(/ORIENTATION:\s*(CORRECT|ROTATE_LEFT|ROTATE_RIGHT|UNCERTAIN)/i);
            const orientationNoteMatch = text.match(/ORIENTATION_NOTE:\s*(.+?)(?=CROP_RISK:|CROP_NOTE:|$)/is);
            const cropRiskMatch = text.match(/CROP_RISK:\s*(SAFE|POSSIBLE|UNCERTAIN)/i);
            const cropNoteMatch = text.match(/CROP_NOTE:\s*(.+)$/is);

            const orientationStatus = orientationMatch ? orientationMatch[1].toUpperCase() : 'UNCERTAIN';
            const cropRisk = cropRiskMatch ? cropRiskMatch[1].toUpperCase() : 'UNCERTAIN';

            let orientationMessage = orientationNoteMatch ? orientationNoteMatch[1].trim() : '';
            if (!orientationMessage) {
                const orientationMessageMap = {
                    CORRECT: t('runtime.slideshow_editor.orientation_ai_correct', 'The photo direction looks correct. There does not appear to be an orientation problem.'),
                    ROTATE_LEFT: t('runtime.slideshow_editor.orientation_ai_rotate_left', 'The photo looks sideways. Try rotating it left.'),
                    ROTATE_RIGHT: t('runtime.slideshow_editor.orientation_ai_rotate_right', 'The photo looks sideways. Try rotating it right.'),
                    UNCERTAIN: t('runtime.slideshow_editor.orientation_ai_uncertain', 'The photo direction is unclear. Please check it visually.')
                };
                orientationMessage = orientationMessageMap[orientationStatus] || orientationMessageMap.UNCERTAIN;
            }

            let cropMessage = cropNoteMatch ? cropNoteMatch[1].trim() : '';
            if (!cropMessage) {
                const cropMessageMap = {
                    SAFE: t('runtime.slideshow_preview.crop_ai_safe', 'No cropping problem is expected in this framing.'),
                    POSSIBLE: t('runtime.slideshow_preview.crop_ai_possible', 'Important parts of the image may be cropped in this framing.'),
                    UNCERTAIN: t('runtime.slideshow_preview.crop_ai_uncertain', 'Cropping risk is unclear. Please check the framing visually.')
                };
                cropMessage = cropMessageMap[cropRisk] || cropMessageMap.UNCERTAIN;
            }

            return {
                short: shortMatch ? shortMatch[1].trim().substring(0, 120) : t('runtime.slideshow_editor.description_unavailable', 'Description unavailable'),
                detailed: detailedMatch ? detailedMatch[1].trim() : text,
                visibleText: visibleTextMatch ? visibleTextMatch[1].trim() : (visibleTexts.length > 0 ? visibleTexts.join(' | ') : t('runtime.slideshow_preview.visible_text_none', 'No visible text.')),
                orientationStatus,
                orientationMessage,
                cropRisk,
                cropMessage
            };
        } finally {
            preparedAnalysis.cleanup();
        }
    });

    ipcMain.handle('describe-slideshow-preview-frame-ai', async (event, sceneInput) => {
        const geminiHandler = require('./gemini-handler');
        const apiKey = geminiHandler.getApiKey();

        if (!apiKey) {
            throw new Error(t('runtime.slideshow_editor.api_key_missing', 'API key was not found. Please enter the API key in AI settings first.'));
        }

        const aiLang = getAiLanguage();
        const visibleTexts = Array.isArray(sceneInput?.visibleTexts) ? sceneInput.visibleTexts.filter(Boolean) : [];
        const dataUrl = String(sceneInput?.frameDataUrl || '');
        const dataMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

        if (!dataMatch) {
            throw new Error('Preview frame data is missing or invalid.');
        }

        const prompt = `Analyze this slideshow preview frame exactly as the user sees it. Respond only in ${aiLang}, but keep the field names exactly in English as shown below.

Visible on-screen text according to the app state: ${visibleTexts.length > 0 ? visibleTexts.join(' | ') : 'No visible overlay text.'}

Tasks:
1. SHORT: Give a very short description of the visible frame.
2. DETAILED: Describe the visible frame naturally, including the framing and any visible overlay text.
3. VISIBLE_TEXT: Briefly summarize the text that is visible on screen. If there is none, clearly say there is no visible text.
4. ORIENTATION: choose exactly one of these values:
- CORRECT
- ROTATE_LEFT
- ROTATE_RIGHT
- UNCERTAIN
5. ORIENTATION_NOTE: one short user-facing sentence about whether the frame looks sideways or correct.
6. CROP_RISK: choose exactly one of these values:
- SAFE
- POSSIBLE
- UNCERTAIN
7. CROP_NOTE: one short user-facing sentence explaining whether important content in the visible frame appears cut off, cropped too tightly, or framed incorrectly. Mention issues such as the top of the head being cut off if you notice them. If the framing looks fine, clearly say there is no cropping problem visible.

Return your answer in exactly this format:
SHORT: [short description]
DETAILED: [detailed description]
VISIBLE_TEXT: [text summary]
ORIENTATION: [CORRECT/ROTATE_LEFT/ROTATE_RIGHT/UNCERTAIN]
ORIENTATION_NOTE: [orientation note]
CROP_RISK: [SAFE/POSSIBLE/UNCERTAIN]
CROP_NOTE: [crop note]`;

        const text = await requestGeminiVisualAnalysis(apiKey, {
            mimeType: dataMatch[1],
            data: dataMatch[2]
        }, prompt, aiLang);

        const shortMatch = text.match(/SHORT:\s*(.+?)(?=DETAILED:|$)/is);
        const detailedMatch = text.match(/DETAILED:\s*(.+?)(?=VISIBLE_TEXT:|ORIENTATION:|$)/is);
        const visibleTextMatch = text.match(/VISIBLE_TEXT:\s*(.+?)(?=ORIENTATION:|$)/is);
        const orientationMatch = text.match(/ORIENTATION:\s*(CORRECT|ROTATE_LEFT|ROTATE_RIGHT|UNCERTAIN)/i);
        const orientationNoteMatch = text.match(/ORIENTATION_NOTE:\s*(.+?)(?=CROP_RISK:|CROP_NOTE:|$)/is);
        const cropRiskMatch = text.match(/CROP_RISK:\s*(SAFE|POSSIBLE|UNCERTAIN)/i);
        const cropNoteMatch = text.match(/CROP_NOTE:\s*(.+)$/is);

        const orientationStatus = orientationMatch ? orientationMatch[1].toUpperCase() : 'UNCERTAIN';
        const cropRisk = cropRiskMatch ? cropRiskMatch[1].toUpperCase() : 'UNCERTAIN';

        let orientationMessage = orientationNoteMatch ? orientationNoteMatch[1].trim() : '';
        if (!orientationMessage) {
            const orientationMessageMap = {
                CORRECT: t('runtime.slideshow_editor.orientation_ai_correct', 'The photo direction looks correct. There does not appear to be an orientation problem.'),
                ROTATE_LEFT: t('runtime.slideshow_editor.orientation_ai_rotate_left', 'The photo looks sideways. Try rotating it left.'),
                ROTATE_RIGHT: t('runtime.slideshow_editor.orientation_ai_rotate_right', 'The photo looks sideways. Try rotating it right.'),
                UNCERTAIN: t('runtime.slideshow_editor.orientation_ai_uncertain', 'The photo direction is unclear. Please check it visually.')
            };
            orientationMessage = orientationMessageMap[orientationStatus] || orientationMessageMap.UNCERTAIN;
        }

        let cropMessage = cropNoteMatch ? cropNoteMatch[1].trim() : '';
        if (!cropMessage) {
            const cropMessageMap = {
                SAFE: t('runtime.slideshow_preview.crop_ai_safe', 'No cropping problem is expected in this framing.'),
                POSSIBLE: t('runtime.slideshow_preview.crop_ai_possible', 'Important parts of the image may be cropped in this framing.'),
                UNCERTAIN: t('runtime.slideshow_preview.crop_ai_uncertain', 'Cropping risk is unclear. Please check the framing visually.')
            };
            cropMessage = cropMessageMap[cropRisk] || cropMessageMap.UNCERTAIN;
        }

        return {
            short: shortMatch ? shortMatch[1].trim().substring(0, 120) : t('runtime.slideshow_editor.description_unavailable', 'Description unavailable'),
            detailed: detailedMatch ? detailedMatch[1].trim() : text,
            visibleText: visibleTextMatch ? visibleTextMatch[1].trim() : (visibleTexts.length > 0 ? visibleTexts.join(' | ') : t('runtime.slideshow_preview.visible_text_none', 'No visible text.')),
            orientationStatus,
            orientationMessage,
            cropRisk,
            cropMessage
        };
    });

    // Slideshow video oluştur
    ipcMain.on('slideshow-export', async (event, projectData) => {
        projectData = normalizeSlideshowProjectData(projectData);
        // Proje klasörü (eğer proje kaydedildiyse)
        const projectDir = projectData.projectPath ? path.dirname(projectData.projectPath) : null;

        // Dosya yolunu düzelt - orijinal yol yoksa proje klasöründe ara
        function resolveFilePath(originalPath, filename) {
            // Önce orijinal yolu dene
            if (fs.existsSync(originalPath)) {
                return originalPath;
            }

            // Proje klasöründe ara
            if (projectDir) {
                const filenameOnly = filename || path.basename(originalPath);
                const projectFolderPath = path.join(projectDir, filenameOnly);
                if (fs.existsSync(projectFolderPath)) {
                    console.log(`Dosya proje klasöründe bulundu: ${projectFolderPath}`);
                    return projectFolderPath;
                }
            }

            // Bulunamadı
            return null;
        }

        // Dosyaları kontrol et ve yolları düzelt
        const missingFiles = [];
        let filesUpdated = false;

        // Resimleri kontrol et
        for (const img of projectData.images) {
            const resolvedPath = resolveFilePath(img.path, img.filename);
            if (resolvedPath) {
                if (resolvedPath !== img.path) {
                    img.path = resolvedPath;
                    filesUpdated = true;
                }
            } else {
                missingFiles.push(`Resim: ${img.filename || img.path}`);
            }
        }

        // Sesleri kontrol et
        for (const audio of projectData.audioTracks) {
            const resolvedPath = resolveFilePath(audio.path, audio.filename);
            if (resolvedPath) {
                if (resolvedPath !== audio.path) {
                    audio.path = resolvedPath;
                    filesUpdated = true;
                }
            } else {
                missingFiles.push(`Ses: ${audio.filename || audio.path}`);
            }
        }

        const mediaItems = getOrderedSlideshowMediaItems(projectData);
        for (const mediaItem of mediaItems) {
            if (mediaItem?.type !== 'video') continue;
            const resolvedPath = resolveFilePath(mediaItem.path, mediaItem.filename);
            if (resolvedPath) {
                if (resolvedPath !== mediaItem.path) {
                    mediaItem.path = resolvedPath;
                    filesUpdated = true;
                }
            } else {
                missingFiles.push(mediaItem.filename || mediaItem.path);
            }
        }

        if (filesUpdated) {
            syncMediaItemsWithImages(projectData);
        }

        // Dosya yolları güncellendiyse bilgilendir
        if (filesUpdated && missingFiles.length === 0) {
            console.log('Bazı dosya yolları proje klasöründen çözümlendi');
        }

        // Eksik dosya varsa kullanıcıyı bilgilendir
        if (missingFiles.length > 0) {
            const missingList = missingFiles.slice(0, 5).join('\n');
            const moreCount = missingFiles.length > 5 ? `\n...ve ${missingFiles.length - 5} dosya daha` : '';

            const dialogOptions = {
                type: 'error',
                title: t('dialog.slideshow_editor.missing_files_title', 'Missing Files'),
                message: t('dialog.slideshow_editor.missing_files_message', 'The following files could not be found:\n\n{files}{more}\n\nCopy the files into the project folder (next to the .eng file) and try again.', {
                    files: missingList,
                    more: moreCount
                }),
                buttons: [t('dialog.common.ok', 'OK')]
            };
            announceDialogForAccessibility(slideshowEditorWindow, dialogOptions).then(() => {
                dialog.showMessageBox(slideshowEditorWindow, dialogOptions);
            });
            return;
        }

        const result = await dialog.showSaveDialog(slideshowEditorWindow, {
            title: t('dialog.slideshow_editor.save_video_title', 'Save Slideshow Video'),
            filters: [
                { name: 'MP4 Video', extensions: ['mp4'] }
            ]
        });

        if (!result.canceled) {
            // İlerleme bildirimini başlat
            if (slideshowEditorWindow) {
                slideshowEditorWindow.webContents.send('export-progress', {
                    status: 'started',
                    message: t('runtime.slideshow_editor.export_started', 'Creating video... This may take a few minutes.')
                });
            }

            try {
                const startTime = Date.now();
                // ** DEĞİŞİKLİK **
                // 30'dan fazla resim varsa Batch Modunu kullan, yoksa Single Pass kullan
                const MAX_SINGLE_PASS_IMAGES = 30;
                const hasVideoItems = mediaItems.some(item => item?.type === 'video');
                const hasPinnedItems = mediaItems.some(item => item?.placementMode === 'pinned');
                const hasBlurFitMode = projectData.visualFitMode === 'blur';

                if (hasVideoItems || hasPinnedItems || hasBlurFitMode) {
                    console.log('Karma medya veya zaman sabitlemeli proje, mixed export hattı kullanılıyor.');
                    await createMixedMediaSlideshowVideo(projectData, result.filePath, slideshowEditorWindow);
                } else if (projectData.images.length > MAX_SINGLE_PASS_IMAGES) {
                    console.log(`Büyük proje tespit edildi (${projectData.images.length} resim). Batch işleme moduna geçiliyor.`);
                    await createSlideshowVideoBatched(projectData, result.filePath, slideshowEditorWindow);
                } else {
                    console.log('Küçük proje, tek seferde işleniyor.');
                    await createSlideshowVideo(projectData, result.filePath, slideshowEditorWindow);
                }

                const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                const outputDuration = formatDurationClock(projectData.totalDuration || 0);

                // İlerleme bildirimini kapat
                if (slideshowEditorWindow) {
                    slideshowEditorWindow.webContents.send('export-progress', {
                        status: 'completed',
                        message: t('runtime.slideshow_editor.export_completed', 'Video created ({duration})', {
                            duration: outputDuration
                        })
                    });
                    slideshowEditorWindow.webContents.send('slideshow-export-result', {
                        message: t('runtime.slideshow_editor.export_result_announce', 'The slideshow video was created successfully. Duration: {duration}.', {
                            duration: outputDuration
                        })
                    });
                }

                // Let the renderer announce the result before the native dialog steals focus.
                await new Promise((resolve) => setTimeout(resolve, 900));

                const dialogOptions = {
                    type: 'info',
                    title: t('dialog.slideshow_editor.success_title', 'Success'),
                    message: t('dialog.slideshow_editor.video_created_message', 'The slideshow video was created successfully.\n\nDuration: {duration}', {
                        duration: outputDuration
                    }),
                    buttons: [t('dialog.common.ok', 'OK')]
                };
                announceDialogForAccessibility(slideshowEditorWindow, dialogOptions).then(() => {
                    dialog.showMessageBox(slideshowEditorWindow, dialogOptions);
                });
            } catch (error) {
                // İlerleme bildirimini kapat (hata ile)
                if (slideshowEditorWindow) {
                    slideshowEditorWindow.webContents.send('export-progress', {
                        status: 'error',
                        message: t('runtime.slideshow_editor.export_error_status', 'Video creation error')
                    });
                }
                const errorMsg = error.message.length > 500 ? error.message.substring(0, 500) + '...' : error.message;
                dialog.showErrorBox(t('messages.error_title', 'Error'), t('runtime.slideshow_editor.video_create_error', 'An error occurred while creating the video: {error}', {
                    error: errorMsg
                }));
            }
        }
    });

    // Proje kaydet
    ipcMain.on('slideshow-save-project', async (event, projectData) => {
        projectData = normalizeSlideshowProjectData(projectData);
        let filePath = projectData.projectPath;

        // Eğer proje daha önce kaydedilmişse (projectPath var), direkt üzerine kaydet
        if (filePath && fs.existsSync(filePath)) {
            try {
                const projectJSON = JSON.stringify(projectData, null, 2);
                fs.writeFileSync(filePath, projectJSON, 'utf8');
                slideshowEditorWindow.webContents.send('slideshow-project-saved', filePath);
                console.log('Project saved:', filePath);
            } catch (error) {
                dialog.showErrorBox(t('messages.error_title', 'Error'), t('runtime.slideshow_editor.project_save_error', 'An error occurred while saving the project: {error}', {
                    error: error.message
                }));
            }
        } else {
            // Yeni proje - dosya seçtir
            const result = await dialog.showSaveDialog(slideshowEditorWindow, {
                title: t('dialog.slideshow_editor.save_project_title', 'Save Project'),
                filters: [
                    { name: t('dialog.slideshow_editor.project_file_filter', 'Barrier-Free Video Project'), extensions: ['eng'] }
                ]
            });

            if (!result.canceled) {
                try {
                    // projectPath'i güncelle
                    projectData.projectPath = result.filePath;
                    const projectJSON = JSON.stringify(projectData, null, 2);
                    fs.writeFileSync(result.filePath, projectJSON, 'utf8');
                    slideshowEditorWindow.webContents.send('slideshow-project-saved', result.filePath);
                    console.log('New project saved:', result.filePath);
                } catch (error) {
                    dialog.showErrorBox(t('messages.error_title', 'Error'), t('runtime.slideshow_editor.project_save_error', 'An error occurred while saving the project: {error}', {
                        error: error.message
                    }));
                }
            }
        }
    });
}

let textOverlayWindow = null;

/**
 * Slideshow için yazı ekleme diyaloğunu aç
 */
function openTextOverlayForSlideshow(mainWindow, data = {}) {
    console.log('openTextOverlayForSlideshow çağrıldı, data:', JSON.stringify(data, null, 2));

    // Eğer pencere zaten varsa kapat ve yeniden aç
    // (Düzenleme modu için farklı veri göndermemiz gerekiyor)
    if (textOverlayWindow && !textOverlayWindow.isDestroyed()) {
        console.log('Mevcut pencere kapatılıyor...');
        textOverlayWindow.destroy(); // close() yerine destroy() kullan - daha güvenilir
        textOverlayWindow = null;
    }

    const parentWindow = slideshowEditorWindow || mainWindow;
    console.log('Parent pencere:', parentWindow ? 'var' : 'yok');

    textOverlayWindow = new BrowserWindow({
        width: 550,
        height: 700,
        parent: parentWindow,
        modal: true, // Modal yap - öne çıkmasını sağlar
        show: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        title: data.editText
            ? t('dialog.slideshow_editor.text_edit_window_title', 'Edit Text - Slideshow')
            : t('dialog.slideshow_editor.text_add_window_title', 'Add Text - Slideshow'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    textOverlayWindow.setMenu(null);
    textOverlayWindow.loadFile(path.join(__dirname, '../renderer/dialogs/slideshow-text-overlay.html'));

    // Pencere hazır olduğunda göster
    textOverlayWindow.once('ready-to-show', () => {
        console.log('Yazı penceresi ready-to-show');

        // Windows'ta pencereyi kesinlikle öne getirmek için
        textOverlayWindow.setAlwaysOnTop(true);
        textOverlayWindow.show();
        textOverlayWindow.focus();
        textOverlayWindow.moveTop();

        // Kısa bir gecikme sonra alwaysOnTop'u kapat ama odağı koru
        setTimeout(() => {
            if (textOverlayWindow && !textOverlayWindow.isDestroyed()) {
                textOverlayWindow.setAlwaysOnTop(false);
                textOverlayWindow.focus();
            }
        }, 200);
    });

    // Sayfa yüklendikten sonra verileri gönder
    textOverlayWindow.webContents.on('did-finish-load', () => {
        console.log('Yazı diyaloğu yüklendi, veri gönderiliyor:', data);
        textOverlayWindow.webContents.send('slideshow-text-init', data);

        // Ekran okuyucu için pencere içindeki ilk input'a odaklan
        setTimeout(() => {
            if (textOverlayWindow && !textOverlayWindow.isDestroyed()) {
                textOverlayWindow.webContents.executeJavaScript(`
                    const textInput = document.getElementById('text-content');
                    if (textInput) {
                        textInput.focus();
                        // Ekran okuyucu duyurusu
                        const liveRegion = document.getElementById('live-region');
                        if (liveRegion) {
                            liveRegion.textContent = 'Yazı düzenleme penceresi açıldı. Yazı içeriği alanındasınız.';
                        }
                    }
                `);
            }
        }, 300);
    });

    textOverlayWindow.on('closed', () => {
        console.log('Yazı penceresi kapatıldı');
        textOverlayWindow = null;
    });
}

/**
 * Yeni proje diyaloğunu aç
 */
function openNewProjectDialog(mainWindow) {
    if (newProjectWindow) {
        newProjectWindow.focus();
        return;
    }

    newProjectWindow = new BrowserWindow({
        width: 500,
        height: 680,
        parent: mainWindow,
        modal: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        show: false,  // Başlangıçta gizli
        title: t('dialog.new_project.window_title', 'Create New Project'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    newProjectWindow.setMenu(null);
    newProjectWindow.loadFile(path.join(__dirname, '../renderer/dialogs/new-project.html'));

    // Pencere hazır olduğunda göster
    newProjectWindow.once('ready-to-show', () => {
        newProjectWindow.show();
        newProjectWindow.focus();
    });

    newProjectWindow.on('closed', () => {
        newProjectWindow = null;
    });
}

/**
 * Slideshow düzenleyiciyi aç
 */
function openSlideshowEditor(mainWindow, settings) {
    console.log('openSlideshowEditor çağrıldı, settings:', settings);

    if (slideshowEditorWindow) {
        slideshowEditorWindow.focus();
        return;
    }

    console.log('Slideshow düzenleyici penceresi oluşturuluyor...');

    slideshowEditorWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        skipTaskbar: false,
        title: t('dialog.slideshow_editor.window_title', 'Slideshow Editor'),
        show: false,  // Başlangıçta gizli, yüklendikten sonra göster
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    slideshowEditorWindow.setMenu(null);
    slideshowEditorWindow.loadFile(path.join(__dirname, '../renderer/dialogs/slideshow-editor.html'));

    // Pencere hazır olduğunda göster ve öne getir
    slideshowEditorWindow.once('ready-to-show', () => {
        slideshowEditorWindow.setSkipTaskbar(false);
        slideshowEditorWindow.show();
        slideshowEditorWindow.focus();
        slideshowEditorWindow.moveTop();
    });

    slideshowEditorWindow.webContents.on('did-finish-load', () => {
        console.log('Slideshow düzenleyici yüklendi, init gönderiliyor');
        slideshowEditorWindow.webContents.send('slideshow-init', settings);
    });

    slideshowEditorWindow.on('closed', () => {
        slideshowEditorWindow = null;
    });
}

/**
 * FFmpeg yolunu bul ve hazırla
 */
function getFFmpegPath() {
    let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    // Portable/asar için yol düzeltmesi
    if (ffmpegPath.includes('app.asar')) {
        ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    return ffmpegPath;
}

function buildSlideshowScaleFilter(projectData, image, targetWidth, targetHeight) {
    return buildSmartStillImagePlacementFilter({
        fillFrame: projectData?.fillFrame,
        visualFitMode: projectData?.visualFitMode,
        sourceWidth: Number(image?.width || 0),
        sourceHeight: Number(image?.height || 0),
        targetWidth,
        targetHeight,
        padColor: 'black'
    });
}

function buildImageMediaItem(image, index, existingItem = null, fallbackOrder = null) {
    const preservedOrder = Number(existingItem?.order);
    const resolvedOrder = Number.isFinite(preservedOrder)
        ? preservedOrder
        : (Number.isFinite(Number(fallbackOrder)) ? Number(fallbackOrder) : index + 1);
    const placementMode = existingItem?.placementMode === 'pinned' && Number.isFinite(Number(existingItem?.manualStart)) && Number.isFinite(Number(existingItem?.manualEnd))
        ? 'pinned'
        : 'auto';
    const manualStart = placementMode === 'pinned' ? Math.max(0, Number(existingItem?.manualStart || 0)) : null;
    const manualEnd = placementMode === 'pinned' ? Math.max(manualStart, Number(existingItem?.manualEnd || manualStart || 0)) : null;
    const pinnedDuration = placementMode === 'pinned'
        ? Math.max(0.1, Number(existingItem?.pinnedDuration || (manualEnd - manualStart) || image.duration || 5))
        : null;

    return {
        ...(existingItem && typeof existingItem === 'object' ? existingItem : {}),
        id: image.id,
        sourceImageId: image.id,
        type: 'image',
        path: image.path,
        filename: image.filename,
        duration: Number(image.duration || 5),
        order: resolvedOrder,
        rotation: Number(image.rotation || 0),
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        orientation: image.orientation,
        shortDescription: image.shortDescription || null,
        longDescription: image.longDescription || null,
        pairedAudioId: image.pairedAudioId || null,
        manualDuration: Boolean(image.manualDuration),
        placementMode,
        manualStart,
        manualEnd,
        pinnedDuration,
        pinnedAudioId: placementMode === 'pinned' ? (existingItem?.pinnedAudioId || null) : null
    };
}

function normalizeMediaItem(item, index = 0) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const preservedOrder = Number(item.order);
    const resolvedOrder = Number.isFinite(preservedOrder) ? preservedOrder : index + 1;
    const itemType = item.type === 'video' ? 'video' : 'image';
    const placementMode = item.placementMode === 'pinned' && Number.isFinite(Number(item.manualStart)) && Number.isFinite(Number(item.manualEnd))
        ? 'pinned'
        : 'auto';
    const manualStart = placementMode === 'pinned' ? Math.max(0, Number(item.manualStart || 0)) : null;
    const manualEnd = placementMode === 'pinned' ? Math.max(manualStart, Number(item.manualEnd || manualStart || 0)) : null;
    const pinnedDuration = placementMode === 'pinned'
        ? Math.max(0.1, Number(item.pinnedDuration || (manualEnd - manualStart) || item.duration || item.originalDuration || 5))
        : null;

    if (itemType === 'video') {
        const backgroundMode = String(item.backgroundAudioMode || (item.duckBackgroundAudio ? 'duck' : 'continue')).toLowerCase();
        const normalizedBackgroundMode = ['duck', 'stop', 'continue'].includes(backgroundMode) ? backgroundMode : 'duck';
        const level = Number(item.backgroundAudioLevelDuringVideo);

        return {
            ...item,
            id: item.id || `video_${index}_${Date.now()}`,
            type: 'video',
            path: item.path || '',
            filename: item.filename || path.basename(item.path || ''),
            duration: Math.max(0.1, Number(item.duration || item.originalDuration || 5)),
            originalDuration: Math.max(0.1, Number(item.originalDuration || item.duration || 5)),
            order: resolvedOrder,
            width: Number(item.width || 0),
            height: Number(item.height || 0),
            orientation: item.orientation || getVisualOrientation(Number(item.width || 0), Number(item.height || 0)),
            fitMode: ['blur', 'crop', 'fit'].includes(item.fitMode) ? item.fitMode : 'fit',
            muteVideoAudio: Boolean(item.muteVideoAudio),
            backgroundAudioMode: normalizedBackgroundMode,
            duckBackgroundAudio: normalizedBackgroundMode === 'duck',
            backgroundAudioLevelDuringVideo: Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 35,
            trimStart: Math.max(0, Number(item.trimStart || 0)),
            trimEnd: Math.max(0, Number(item.trimEnd || 0)),
            placementMode,
            manualStart,
            manualEnd,
            pinnedDuration,
            pinnedAudioId: placementMode === 'pinned' ? (item.pinnedAudioId || null) : null
        };
    }

    const resolvedImageId = item.sourceImageId || item.id || `img_${index}_${Date.now()}`;

    return {
        ...item,
        id: resolvedImageId,
        sourceImageId: resolvedImageId,
        type: 'image',
        path: item.path || '',
        filename: item.filename || path.basename(item.path || ''),
        duration: Math.max(0.1, Number(item.duration || 5)),
        order: resolvedOrder,
        rotation: Number(item.rotation || 0),
        width: Number(item.width || 0),
        height: Number(item.height || 0),
        orientation: item.orientation,
        shortDescription: item.shortDescription || null,
        longDescription: item.longDescription || null,
        pairedAudioId: item.pairedAudioId || null,
        manualDuration: Boolean(item.manualDuration),
        placementMode,
        manualStart,
        manualEnd,
        pinnedDuration,
        pinnedAudioId: placementMode === 'pinned' ? (item.pinnedAudioId || null) : null
    };
}

function deriveImagesFromMediaItems(mediaItems) {
    return (Array.isArray(mediaItems) ? mediaItems : [])
        .filter(item => item && item.type === 'image')
        .sort((a, b) => {
            const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
            const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
            return orderA - orderB;
        })
        .map((item, index) => ({
            id: item.sourceImageId || item.id || `img_${index}_${Date.now()}`,
            path: item.path,
            filename: item.filename || path.basename(item.path || ''),
            duration: Number(item.duration || 5),
            rotation: Number(item.rotation || 0),
            width: Number(item.width || 0),
            height: Number(item.height || 0),
            orientation: item.orientation,
            shortDescription: item.shortDescription || null,
            longDescription: item.longDescription || null,
            pairedAudioId: item.pairedAudioId || null,
            manualDuration: Boolean(item.manualDuration),
            placementMode: item.placementMode === 'pinned' ? 'pinned' : 'auto',
            manualStart: item.placementMode === 'pinned' ? Number(item.manualStart || 0) : null,
            manualEnd: item.placementMode === 'pinned' ? Number(item.manualEnd || 0) : null,
            pinnedDuration: item.placementMode === 'pinned' ? Number(item.pinnedDuration || item.duration || 5) : null,
            pinnedAudioId: item.placementMode === 'pinned' ? (item.pinnedAudioId || null) : null,
            order: index + 1
        }));
}

function syncMediaItemsWithImages(projectData) {
    const existingItems = Array.isArray(projectData?.mediaItems) ? projectData.mediaItems : [];
    const existingImageMap = new Map(
        existingItems
            .filter(item => item && item.type === 'image')
            .map(item => [item.sourceImageId || item.id, item])
    );
    const nonImageItems = existingItems
        .filter(item => item && item.type !== 'image')
        .map((item, index) => normalizeMediaItem(item, index))
        .filter(Boolean);
    let nextOrder = existingItems.reduce((maxOrder, item) => {
        const order = Number(item?.order);
        return Number.isFinite(order) ? Math.max(maxOrder, order) : maxOrder;
    }, 0) + 1;
    const imageItems = (Array.isArray(projectData?.images) ? projectData.images : []).map((image, index) => {
        const existingItem = existingImageMap.get(image.id);
        const fallbackOrder = existingItem ? existingItem.order : nextOrder++;
        return buildImageMediaItem(image, index, existingItem, fallbackOrder);
    });

    projectData.mediaItems = [...imageItems, ...nonImageItems]
        .sort((a, b) => {
            const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
            const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        });

    return projectData;
}

function normalizeSlideshowProjectData(rawProjectData) {
    const projectData = {
        type: 'slideshow',
        aspectRatio: '16:9',
        fillFrame: true,
        visualFitMode: 'blur',
        transition: 'none',
        images: [],
        mediaItems: [],
        audioTracks: [],
        textOverlays: [],
        totalDuration: 0,
        ...(rawProjectData || {})
    };

    projectData.images = Array.isArray(rawProjectData?.images) ? rawProjectData.images : [];
    projectData.mediaItems = Array.isArray(rawProjectData?.mediaItems)
        ? rawProjectData.mediaItems.map((item, index) => normalizeMediaItem(item, index)).filter(Boolean)
        : [];
    projectData.audioTracks = Array.isArray(rawProjectData?.audioTracks) ? rawProjectData.audioTracks : [];
    projectData.textOverlays = Array.isArray(rawProjectData?.textOverlays) ? rawProjectData.textOverlays : [];
    projectData.visualFitMode = ['blur', 'crop', 'fit'].includes(rawProjectData?.visualFitMode)
        ? rawProjectData.visualFitMode
        : (rawProjectData?.fillFrame === false ? 'fit' : 'blur');
    projectData.fillFrame = projectData.visualFitMode !== 'fit';

    if (projectData.images.length === 0 && projectData.mediaItems.length > 0) {
        projectData.images = deriveImagesFromMediaItems(projectData.mediaItems);
    }

    return syncMediaItemsWithImages(projectData);
}

function getOrderedSlideshowMediaItems(projectData) {
    const mediaItems = Array.isArray(projectData?.mediaItems) && projectData.mediaItems.length > 0
        ? projectData.mediaItems
        : (projectData?.images || []).map((image, index) => buildImageMediaItem(image, index, null, index + 1));

    return [...mediaItems].sort((a, b) => {
        const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
        const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
}

function isPinnedSlideshowMediaItem(item) {
    return item?.placementMode === 'pinned'
        && Number.isFinite(Number(item?.manualStart))
        && Number.isFinite(Number(item?.manualEnd))
        && Number(item.manualEnd) > Number(item.manualStart);
}

function getSlideshowMediaDuration(item) {
    return Math.max(0.1, Number(item?.duration || item?.originalDuration || 5));
}

function buildMediaTimings(mediaItems, targetDuration = 0) {
    const orderedItems = Array.isArray(mediaItems) ? mediaItems : [];
    const safeTargetDuration = Math.max(0, Number(targetDuration || 0));

    const results = [];
    let cursor = 0;
    let currentSegment = [];

    const isFlexibleAutoItem = (item) => (
        item?.type !== 'video'
        && !item?.manualDuration
        && !item?.pairedAudioId
    );

    const placeSegment = (segmentItems, segmentEnd = null) => {
        if (!Array.isArray(segmentItems) || segmentItems.length === 0) return [];

        const boundedEnd = Number.isFinite(Number(segmentEnd)) ? Math.max(cursor, Number(segmentEnd)) : null;
        const availableDuration = boundedEnd !== null ? Math.max(0, boundedEnd - cursor) : 0;
        const fixedDuration = segmentItems.reduce((sum, item) => (
            isFlexibleAutoItem(item) ? sum : sum + getSlideshowMediaDuration(item)
        ), 0);
        const canPlaceFlexibleItems = boundedEnd === null || fixedDuration < availableDuration - 0.05;
        const itemsToPlace = canPlaceFlexibleItems
            ? segmentItems
            : segmentItems.filter(item => !isFlexibleAutoItem(item));
        const deferredItems = canPlaceFlexibleItems
            ? []
            : segmentItems.filter(isFlexibleAutoItem);
        const flexibleItems = itemsToPlace.filter(isFlexibleAutoItem);
        const flexibleDuration = boundedEnd !== null && flexibleItems.length > 0
            ? Math.max(0.1 * flexibleItems.length, availableDuration - fixedDuration)
            : 0;
        const flexibleDurationPerItem = flexibleItems.length > 0 && flexibleDuration > 0
            ? flexibleDuration / flexibleItems.length
            : 0;

        itemsToPlace.forEach((item) => {
            const itemDuration = isFlexibleAutoItem(item) && flexibleDurationPerItem > 0
                ? flexibleDurationPerItem
                : getSlideshowMediaDuration(item);
            const start = cursor;
            const end = start + itemDuration;
            results.push({
                ...item,
                duration: itemDuration,
                start,
                end
            });
            cursor = end;
        });

        return deferredItems;
    };

    orderedItems.forEach((item) => {
        if (!isPinnedSlideshowMediaItem(item)) {
            currentSegment.push(item);
            return;
        }

        const pinnedStart = Number(item.manualStart);
        const pinnedEnd = Number(item.manualEnd);
        currentSegment = placeSegment(currentSegment, pinnedStart);

        if (cursor < pinnedStart) {
            cursor = pinnedStart;
        }
        const pinnedDuration = Math.max(0.1, Number(item.pinnedDuration || (pinnedEnd - pinnedStart) || item.duration || item.originalDuration || 5));
        results.push({
            ...item,
            duration: pinnedDuration,
            start: pinnedStart,
            end: pinnedEnd
        });
        cursor = Math.max(cursor, pinnedEnd);
    });

    placeSegment(currentSegment, safeTargetDuration > cursor ? safeTargetDuration : null);

    return results.sort((a, b) => {
        if (Number(a.start) !== Number(b.start)) return Number(a.start) - Number(b.start);
        const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
        const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
}

function escapeDrawtextFilePath(filePath) {
    return String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");
}

function createSlideshowDrawtextFile(content, tempPaths) {
    const textFilePath = path.join(os.tmpdir(), `slideshow_text_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(textFilePath, String(content || ''), 'utf8');
    if (Array.isArray(tempPaths)) {
        tempPaths.push(textFilePath);
    }
    return textFilePath;
}

function buildSlideshowDrawtextFilter(overlay, startT, endT, tempPaths) {
    const fontFile = escapeDrawtextFilePath('C:/Windows/Fonts/segoeui.ttf');
    const textFile = escapeDrawtextFilePath(createSlideshowDrawtextFile(overlay.content, tempPaths));
    const y = overlay.position === 'top' ? '30' : (overlay.position === 'center' ? '(h-th)/2' : 'h-th-30');
    return `drawtext=textfile='${textFile}':fontfile='${fontFile}':fontsize=${overlay.fontSize || 48}:fontcolor=${overlay.fontColor || 'white'}:x=(w-tw)/2:y=${y}${overlay.background && overlay.background !== 'none' ? `:box=1:boxcolor=${overlay.background === 'black' ? 'black@0.5' : 'white@0.5'}:boxborderw=10` : ''}:enable='between(t,${startT},${endT})'`;
}

function buildSlideshowTextOverlayFilters(baseLabel, textOverlays, imageTimings, tempPaths = []) {
    if (!Array.isArray(textOverlays) || textOverlays.length === 0) {
        return { filterComplex: '', outputLabel: baseLabel };
    }

    let lastOutput = baseLabel;
    let filterComplex = '';

    textOverlays.forEach((overlay, index) => {
        const overlayTargets = Array.isArray(overlay?.targetImages) ? overlay.targetImages : [];
        overlayTargets.forEach((imgId, targetIdx) => {
            const timing = imageTimings.find(t => t.id === imgId);
            if (!timing) return;

            const startT = timing.start.toFixed(3);
            const isVeryLast = !imageTimings.find(t => t.start > timing.start);
            const endT = isVeryLast ? (timing.end + 1.0).toFixed(3) : (timing.end - 0.02).toFixed(3);
            const drawtext = buildSlideshowDrawtextFilter(overlay, startT, endT, tempPaths);
            const currentOut = `txt${index}_${targetIdx}`;
            filterComplex += `[${lastOutput}]${drawtext}[${currentOut}]; `;
            lastOutput = currentOut;
        });
    });

    return {
        filterComplex,
        outputLabel: lastOutput
    };
}

function buildMixedMediaPlacementFilter(mediaItem, targetWidth, targetHeight, projectData) {
    if (mediaItem?.type === 'video') {
        if (mediaItem.fitMode === 'crop') {
            return buildCropFillFilter(targetWidth, targetHeight);
        }
        if (mediaItem.fitMode === 'blur') {
            return buildBlurFillFilter(targetWidth, targetHeight, 'black');
        }
        return buildFitPadFilter(targetWidth, targetHeight, 'black');
    }

    return buildSlideshowScaleFilter(projectData, mediaItem, targetWidth, targetHeight);
}

function getMixedMediaVisualFitMode(mediaItem, projectData) {
    if (mediaItem?.type === 'video') {
        return ['blur', 'crop', 'fit'].includes(mediaItem.fitMode) ? mediaItem.fitMode : 'fit';
    }
    return ['blur', 'crop', 'fit'].includes(projectData?.visualFitMode)
        ? projectData.visualFitMode
        : (projectData?.fillFrame === false ? 'fit' : 'blur');
}

function buildBackgroundAudioDuckingFilters(baseLabel, mediaTimings) {
    const relevantTimings = mediaTimings.filter((item) => {
        if (item?.type !== 'video') return false;
        if (item.muteVideoAudio) return false;
        const mode = item.backgroundAudioMode || (item.duckBackgroundAudio ? 'duck' : 'continue');
        return mode === 'duck' || mode === 'stop';
    });

    if (relevantTimings.length === 0) {
        return {
            filterComplex: `[${baseLabel}]anull[bgaud]`,
            outputLabel: 'bgaud'
        };
    }

    let lastLabel = baseLabel;
    let filterComplex = '';
    relevantTimings.forEach((item, index) => {
        const mode = item.backgroundAudioMode || (item.duckBackgroundAudio ? 'duck' : 'continue');
        const level = mode === 'stop'
            ? '0'
            : `${Math.max(0, Math.min(100, Number(item.backgroundAudioLevelDuringVideo || 35))) / 100}`;
        const currentLabel = index === relevantTimings.length - 1 ? 'bgaud' : `bgaud_step_${index}`;
        filterComplex += `[${lastLabel}]volume=${level}:enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'[${currentLabel}]; `;
        lastLabel = currentLabel;
    });

    return {
        filterComplex: filterComplex.trim(),
        outputLabel: lastLabel
    };
}

function runExecCommandPromise(cmd, outputPath, options = {}) {
    return new Promise((resolve, reject) => {
        execCommand(cmd, outputPath, resolve, reject, options);
    });
}

function getFFprobePath() {
    let ffprobePath = require('@ffprobe-installer/ffprobe').path;
    if (ffprobePath.includes('app.asar')) {
        ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
    }
    return ffprobePath;
}

async function getPrimaryAudioStreamInfo(audioPath) {
    const ffprobePath = getFFprobePath();
    return new Promise((resolve) => {
        exec(`"${ffprobePath}" -v quiet -print_format json -show_streams "${audioPath}"`, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }

            try {
                const parsed = JSON.parse(stdout);
                const audioStream = Array.isArray(parsed.streams)
                    ? parsed.streams.find(stream => stream.codec_type === 'audio')
                    : null;
                resolve(audioStream || null);
            } catch (parseError) {
                resolve(null);
            }
        });
    });
}

async function getPrimaryVideoAudioStreamInfo(videoPath) {
    const ffprobePath = getFFprobePath();
    return new Promise((resolve) => {
        exec(`"${ffprobePath}" -v quiet -print_format json -show_streams "${videoPath}"`, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }

            try {
                const parsed = JSON.parse(stdout);
                const audioStream = Array.isArray(parsed.streams)
                    ? parsed.streams.find(stream => stream.codec_type === 'audio')
                    : null;
                resolve(audioStream || null);
            } catch (parseError) {
                resolve(null);
            }
        });
    });
}

function isKnownColorValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return Boolean(normalized) && normalized !== 'unknown' && normalized !== 'unspecified' && normalized !== 'n/a';
}

async function getPrimaryVideoColorMetadata(videoPath) {
    const ffprobePath = getFFprobePath();
    return new Promise((resolve) => {
        exec(`"${ffprobePath}" -v quiet -print_format json -show_streams "${videoPath}"`, (error, stdout) => {
            if (error || !stdout) {
                resolve({});
                return;
            }

            try {
                const parsed = JSON.parse(stdout);
                const videoStream = Array.isArray(parsed.streams)
                    ? parsed.streams.find(stream => stream.codec_type === 'video')
                    : null;
                resolve({
                    colorRange: isKnownColorValue(videoStream?.color_range) ? String(videoStream.color_range).trim() : '',
                    colorSpace: isKnownColorValue(videoStream?.color_space) ? String(videoStream.color_space).trim() : '',
                    colorPrimaries: isKnownColorValue(videoStream?.color_primaries) ? String(videoStream.color_primaries).trim() : '',
                    colorTransfer: isKnownColorValue(videoStream?.color_transfer) ? String(videoStream.color_transfer).trim() : ''
                });
            } catch (parseError) {
                resolve({});
            }
        });
    });
}

function isHdrVideoColorMetadata(metadata = {}) {
    const transfer = String(metadata.colorTransfer || '').toLowerCase();
    const primaries = String(metadata.colorPrimaries || '').toLowerCase();
    const space = String(metadata.colorSpace || '').toLowerCase();
    return transfer.includes('smpte2084')
        || transfer.includes('arib-std-b67')
        || transfer.includes('hlg')
        || primaries.includes('bt2020')
        || space.includes('bt2020');
}

function buildSlideshowHdrToSdrFilter(metadata = {}) {
    if (!isHdrVideoColorMetadata(metadata)) {
        return '';
    }
    return 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p';
}

function joinSlideshowVideoFilters(...filters) {
    return filters
        .flat()
        .map(filter => String(filter || '').trim())
        .filter(Boolean)
        .join(',');
}

function buildSlideshowColorOutputOptions(metadata = {}, defaultToBt709 = true, forceBt709 = false) {
    const colorRange = forceBt709 ? 'tv' : (isKnownColorValue(metadata.colorRange) ? metadata.colorRange : '');
    const colorSpace = forceBt709 ? 'bt709' : (isKnownColorValue(metadata.colorSpace) ? metadata.colorSpace : (defaultToBt709 ? 'bt709' : ''));
    const colorPrimaries = forceBt709 ? 'bt709' : (isKnownColorValue(metadata.colorPrimaries) ? metadata.colorPrimaries : (defaultToBt709 ? 'bt709' : ''));
    const colorTransfer = forceBt709 ? 'bt709' : (isKnownColorValue(metadata.colorTransfer) ? metadata.colorTransfer : (defaultToBt709 ? 'bt709' : ''));
    const options = [];
    if (isKnownColorValue(colorRange)) {
        options.push('-color_range', colorRange);
    }
    if (isKnownColorValue(colorSpace)) {
        options.push('-colorspace', colorSpace);
    }
    if (isKnownColorValue(colorPrimaries)) {
        options.push('-color_primaries', colorPrimaries);
    }
    if (isKnownColorValue(colorTransfer)) {
        options.push('-color_trc', colorTransfer);
    }
    return options.join(' ');
}

const DEFAULT_SLIDESHOW_COLOR_OPTIONS = buildSlideshowColorOutputOptions({}, true);

function buildSingleAudioMap(inputIdx, audioStreamInfo, durationSeconds) {
    const codec = String(audioStreamInfo?.codec_name || '').trim().toLowerCase();
    const safeDuration = Number(durationSeconds || 0).toFixed(3);

    if (codec === 'aac') {
        console.log('[Slideshow] Single audio track is already AAC. Copying audio stream.');
        return `-map ${inputIdx}:a -c:a copy -t ${safeDuration}`;
    }

    console.log('[Slideshow] Single audio track is not AAC. Re-encoding for iOS compatibility.', {
        codec: codec || 'unknown'
    });
    return `-map ${inputIdx}:a -c:a aac -b:a 192k -ar 48000 -ac 2 -t ${safeDuration}`;
}

/**
 * Tek bir komutla video oluştur (Orijinal Fonksiyon)
 * Küçük projeler için ideal (<30 resim).
 * Eşlenmiş ses modunu destekler (resim-ses eşleştirmesi).
 */
async function createSlideshowVideo(projectData, outputPath, parentWindow) {
    const ffmpegPath = getFFmpegPath();

    if (!fs.existsSync(ffmpegPath)) {
        throw new Error(`FFmpeg bulunamadı: ${ffmpegPath}`);
    }

    const prepared = await prepareSlideshowImages(projectData.images);
    const slideshowImages = prepared.images;
    const audioTracks = projectData.audioTracks || [];
    const singleAudioStreamInfo = audioTracks.length === 1
        ? await getPrimaryAudioStreamInfo(audioTracks[0].path)
        : null;

    return new Promise((resolve, reject) => {
        const [width, height] = projectData.aspectRatio === '16:9' ? [1920, 1080] : [1080, 1920];
        const resolution = `${width}:${height}`;

        let currentTime = 0;
        const imageTimings = slideshowImages.map(img => {
            const timing = { id: img.id, start: currentTime, end: currentTime + img.duration };
            currentTime += img.duration;
            return timing;
        });

        const tempFilterFiles = []; // Temizlenecek geçici dosyalar
        let cmd = `"${ffmpegPath}" -y `;

        // Inputları ekle
        slideshowImages.forEach(img => {
            cmd += `-loop 1 -t ${img.duration.toFixed(3)} -i "${img.path}" `;
        });

        const imageCount = slideshowImages.length;
        const hasAudio = audioTracks.length > 0;

        // Eşlenmiş ses modu kontrolü
        const hasPairedAudio = slideshowImages.some(img => img.pairedAudioId);

        if (hasPairedAudio) {
            // === EŞLENMIŞ SES MODU ===
            // Her benzersiz eşlenmiş ses dosyasını input olarak ekle
            const uniquePairedAudioIds = [...new Set(
                slideshowImages
                    .filter(img => img.pairedAudioId)
                    .map(img => img.pairedAudioId)
            )];

            const audioInputMap = {}; // audioId -> inputIndex
            uniquePairedAudioIds.forEach(audioId => {
                const audio = audioTracks.find(a => a.id === audioId);
                if (audio && fs.existsSync(audio.path)) {
                    const inputIdx = imageCount + Object.keys(audioInputMap).length;
                    audioInputMap[audioId] = inputIdx;
                    cmd += `-i "${audio.path}" `;
                }
            });

            // Eşlenmemiş global sesleri de ekle
            const pairedAudioIds = new Set(uniquePairedAudioIds);
            const globalAudioTracks = audioTracks.filter(a => !pairedAudioIds.has(a.id));
            const globalAudioInputStart = imageCount + Object.keys(audioInputMap).length;
            globalAudioTracks.forEach(track => {
                cmd += `-i "${track.path}" `;
            });

            // Video filter complex
            let filterComplex = '';
            slideshowImages.forEach((img, i) => {
                const scaleFilter = buildSlideshowScaleFilter(projectData, img, width, height);
                filterComplex += `[${i}:v]${scaleFilter}[v${i}]; `;
            });

            slideshowImages.forEach((img, i) => {
                filterComplex += `[v${i}]`;
            });
            filterComplex += `concat=n=${slideshowImages.length}:v=1:a=0[vcoll]; `;

            let lastOutput = 'vcoll';

            // Text Overlays
            if (projectData.textOverlays && projectData.textOverlays.length > 0) {
                projectData.textOverlays.forEach((overlay, index) => {
                    overlay.targetImages.forEach((imgId, targetIdx) => {
                        const timing = imageTimings.find(t => t.id === imgId);
                        if (!timing) return;

                        const startT = timing.start.toFixed(3);
                        const isVeryLast = !imageTimings.find(t => t.start > timing.start);
                        const endT = isVeryLast ? (timing.end + 1.0).toFixed(3) : (timing.end - 0.02).toFixed(3);

                        const drawtext = buildSlideshowDrawtextFilter(overlay, startT, endT, tempFilterFiles);

                        const currentOut = `txt${index}_${targetIdx}`;
                        filterComplex += `[${lastOutput}]${drawtext}[${currentOut}]; `;
                        lastOutput = currentOut;
                    });
                });
            }

            // Eşlenmiş ses filter complex:
            // Her ses için: eşli resimlerin zamanlamalarına göre trim + delay
            const audioSegments = [];
            let segIdx = 0;

            uniquePairedAudioIds.forEach(audioId => {
                const inputIdx = audioInputMap[audioId];
                if (inputIdx === undefined) return;

                const pairedImgs = slideshowImages.filter(img => img.pairedAudioId === audioId);
                const audio = audioTracks.find(a => a.id === audioId);
                if (!audio) return;

                let audioOffset = 0;

                pairedImgs.forEach(img => {
                    const timing = imageTimings.find(t => t.id === img.id);
                    if (!timing) return;

                    const segDuration = img.duration;
                    const segLabel = `aseg${segIdx}`;
                    const delayMs = Math.round(timing.start * 1000);

                    filterComplex += `[${inputIdx}:a]atrim=${audioOffset.toFixed(3)}:${(audioOffset + segDuration).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo`;

                    if (delayMs > 0) {
                        filterComplex += `,adelay=${delayMs}|${delayMs}`;
                    }

                    filterComplex += `[${segLabel}]; `;
                    audioSegments.push(segLabel);
                    audioOffset += segDuration;
                    segIdx++;
                });
            });

            // Global ses parçaları
            globalAudioTracks.forEach((_, i) => {
                const gInputIdx = globalAudioInputStart + i;
                const gLabel = `gaudio${i}`;
                filterComplex += `[${gInputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[${gLabel}]; `;
                audioSegments.push(gLabel);
            });

            // Ses segmentlerini birleştir
            let audioMap = '';
            if (audioSegments.length > 0) {
                if (audioSegments.length === 1) {
                    filterComplex += `[${audioSegments[0]}]atrim=0:${currentTime.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
                } else {
                    audioSegments.forEach(seg => {
                        filterComplex += `[${seg}]`;
                    });
                    // amix varsayılan olarak sesi giriş sayısına böler,
                    // volume filtresiyle telafi ediyoruz
                    const volBoost = audioSegments.length;
                    filterComplex += `amix=inputs=${audioSegments.length}:duration=longest[amixed]; `;
                    filterComplex += `[amixed]volume=${volBoost}[outa_pre]; `;
                    filterComplex += `[outa_pre]atrim=0:${currentTime.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
                }
                audioMap = '-map "[outa]" -c:a aac -b:a 192k -ar 48000 -ac 2';
            }

            filterComplex = filterComplex.trim();
            if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);

            // Windows komut satırı uzunluk sınırı sorunu: filter_complex'i dosyaya yaz
            const fcScriptPath = path.join(os.tmpdir(), `fc_paired_${Date.now()}.txt`);
            fs.writeFileSync(fcScriptPath, filterComplex, 'utf-8');
            tempFilterFiles.push(fcScriptPath);

            cmd += `-filter_complex_script "${fcScriptPath}" -map "[${lastOutput}]" ${audioMap} -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 "${outputPath}"`;

        } else {
            // === KLASİK MOD (eşleme yok) ===
            audioTracks.forEach(track => {
                cmd += `-i "${track.path}" `;
            });

            let filterComplex = '';
            slideshowImages.forEach((img, i) => {
                const scaleFilter = buildSlideshowScaleFilter(projectData, img, width, height);
                filterComplex += `[${i}:v]${scaleFilter}[v${i}]; `;
            });

            slideshowImages.forEach((img, i) => {
                filterComplex += `[v${i}]`;
            });
            filterComplex += `concat=n=${slideshowImages.length}:v=1:a=0[vcoll]; `;

            let lastOutput = 'vcoll';

            // Text Overlays
            if (projectData.textOverlays && projectData.textOverlays.length > 0) {
                projectData.textOverlays.forEach((overlay, index) => {
                    overlay.targetImages.forEach((imgId, targetIdx) => {
                        const timing = imageTimings.find(t => t.id === imgId);
                        if (!timing) return;

                        const startT = timing.start.toFixed(3);
                        const isVeryLast = !imageTimings.find(t => t.start > timing.start);
                        const endT = isVeryLast ? (timing.end + 1.0).toFixed(3) : (timing.end - 0.02).toFixed(3);

                        const drawtext = buildSlideshowDrawtextFilter(overlay, startT, endT, tempFilterFiles);

                        const currentOut = `txt${index}_${targetIdx}`;
                        filterComplex += `[${lastOutput}]${drawtext}[${currentOut}]; `;
                        lastOutput = currentOut;
                    });
                });
            }

            filterComplex = filterComplex.trim();
            if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);

            // Ses İşleme
            let audioMap = '';

            if (hasAudio) {
                if (audioTracks.length === 1) {
                    const inputIdx = imageCount;
                    audioMap = buildSingleAudioMap(inputIdx, singleAudioStreamInfo, currentTime);
                } else {
                    let audioConcats = '';
                    audioTracks.forEach((_, i) => {
                        const inputIdx = imageCount + i;
                        filterComplex += `; [${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[aud${i}]`;
                        audioConcats += `[aud${i}]`;
                    });
                    filterComplex += `; ${audioConcats}concat=n=${audioTracks.length}:v=0:a=1[outa_pre]; [outa_pre]atrim=0:${currentTime.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
                    audioMap = '-map "[outa]" -c:a aac -b:a 192k -ar 48000 -ac 2';
                }
            }

            // Windows komut satırı uzunluk sınırı sorunu: filter_complex'i dosyaya yaz
            const fcScriptPath = path.join(os.tmpdir(), `fc_classic_${Date.now()}.txt`);
            fs.writeFileSync(fcScriptPath, filterComplex, 'utf-8');
            tempFilterFiles.push(fcScriptPath);

            cmd += `-filter_complex_script "${fcScriptPath}" -map "[${lastOutput}]" ${audioMap} -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 "${outputPath}"`;
        }

        console.log('--- Slideshow FFmpeg Cmd ---');
        console.log(cmd.substring(0, 500) + '...');

        // onProgress callback
        const onProgress = parentWindow ? (percent) => {
            parentWindow.webContents.send('export-progress', {
                status: 'progress',
                message: t('runtime.slideshow_editor.processing_video', 'Your video is being processed...'),
                percent: percent
            });
        } : null;

        execCommand(cmd, outputPath,
            (result) => {
                // Geçici filter dosyalarını temizle
                tempFilterFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
                prepared.cleanup();
                resolve(result);
            },
            (err) => {
                tempFilterFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) { } });
                prepared.cleanup();
                reject(err);
            },
            { totalDuration: currentTime, onProgress }
        );
    });
}

async function createMixedMediaSlideshowVideo(projectData, outputPath, parentWindow) {
    const ffmpegPath = getFFmpegPath();
    if (!fs.existsSync(ffmpegPath)) {
        throw new Error(`FFmpeg bulunamadı: ${ffmpegPath}`);
    }

    const [width, height] = projectData.aspectRatio === '16:9' ? [1920, 1080] : [1080, 1920];
    const mediaItems = getOrderedSlideshowMediaItems(projectData);
    const imageItems = mediaItems.filter(item => item?.type !== 'video');
    const prepared = await prepareSlideshowImages(imageItems);
    const preparedImageMap = new Map(prepared.images.map(image => [image.id, image]));
    const normalizedMediaItems = mediaItems.map((item) => (
        item?.type === 'video' ? item : { ...item, ...(preparedImageMap.get(item.id) || {}) }
    ));
    const audioTracks = Array.isArray(projectData.audioTracks) ? projectData.audioTracks : [];
    const targetAudioDuration = audioTracks.reduce((sum, track) => sum + Math.max(0, Number(track?.duration || 0)), 0);
    const mediaTimings = buildMediaTimings(normalizedMediaItems, targetAudioDuration);
    const imageTimings = mediaTimings.filter(item => item?.type !== 'video');
    const mediaDuration = mediaTimings.reduce((maxEnd, item) => Math.max(maxEnd, Number(item.end || 0)), 0);
    const totalDuration = targetAudioDuration > 0 ? Math.max(targetAudioDuration, mediaDuration) : mediaDuration;
    projectData.totalDuration = totalDuration;
    const tempPaths = [];

    try {
        const segmentPaths = [];
        let timelineCursor = 0;
        for (let index = 0; index < mediaTimings.length; index++) {
            const item = mediaTimings[index];
            const itemStart = Math.max(0, Number(item.start || 0));
            const gapDuration = itemStart - timelineCursor;
            if (gapDuration > 0.05) {
                const gapSegmentPath = path.join(os.tmpdir(), `slideshow_media_gap_${Date.now()}_${index}.mp4`);
                tempPaths.push(gapSegmentPath);
                const gapCmd = `"${ffmpegPath}" -y -f lavfi -i color=c=black:s=${width}x${height}:d=${gapDuration.toFixed(3)} -f lavfi -t ${gapDuration.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=48000 -map 0:v -map 1:a -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest "${gapSegmentPath}"`;
                await runExecCommandPromise(gapCmd, gapSegmentPath);
                segmentPaths.push(gapSegmentPath);
                timelineCursor += gapDuration;
            }

            const segmentPath = path.join(os.tmpdir(), `slideshow_media_segment_${Date.now()}_${index}.mp4`);
            tempPaths.push(segmentPath);

            if (parentWindow) {
                const percent = Math.min(70, Math.round(((index + 1) / Math.max(1, mediaTimings.length)) * 70));
                parentWindow.webContents.send('export-progress', {
                    status: 'progress',
                    message: t('runtime.slideshow_editor.batch_progress', 'Processing part {current} of {total}...', {
                        current: index + 1,
                        total: mediaTimings.length
                    }),
                    percent
                });
            }

            const placementFilter = buildMixedMediaPlacementFilter(item, width, height, projectData);
            let cmd = `"${ffmpegPath}" -y `;

            if (item.type === 'video') {
                const targetSegmentDuration = Math.max(0.1, Number(item.duration || item.originalDuration || 5));
                const sourceVideoDuration = Math.max(0.1, Number(item.originalDuration || item.duration || 5));
                const freezeTailDuration = Math.max(0, targetSegmentDuration - sourceVideoDuration);
                const sourceAudioStream = item.muteVideoAudio ? null : await getPrimaryVideoAudioStreamInfo(item.path);
                const sourceColorMetadata = await getPrimaryVideoColorMetadata(item.path);
                const hdrToSdrFilter = buildSlideshowHdrToSdrFilter(sourceColorMetadata);
                const videoFilter = joinSlideshowVideoFilters(
                    hdrToSdrFilter,
                    placementFilter,
                    freezeTailDuration > 0 ? `tpad=stop_mode=clone:stop_duration=${freezeTailDuration.toFixed(3)}` : ''
                );
                const sourceColorOptions = buildSlideshowColorOutputOptions(sourceColorMetadata, true, Boolean(hdrToSdrFilter));
                const hasVideoAudio = Boolean(sourceAudioStream);

                if (hasVideoAudio) {
                    const audioFilter = `aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000${freezeTailDuration > 0 ? ',apad' : ''},atrim=0:${targetSegmentDuration.toFixed(3)},asetpts=PTS-STARTPTS`;
                    cmd += `-i "${item.path}" `;
                    cmd += `-vf "${videoFilter}" -af "${audioFilter}" -t ${targetSegmentDuration.toFixed(3)} -map 0:v -map 0:a? -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${sourceColorOptions} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 "${segmentPath}"`;
                } else {
                    cmd += `-i "${item.path}" -f lavfi -t ${targetSegmentDuration.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=48000 `;
                    cmd += `-vf "${videoFilter}" -t ${targetSegmentDuration.toFixed(3)} -map 0:v -map 1:a -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${sourceColorOptions} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 "${segmentPath}"`;
                }
            } else {
                const imageDuration = Math.max(0.1, Number(item.duration || 5));
                if (getMixedMediaVisualFitMode(item, projectData) === 'blur') {
                    const renderedStillPath = path.join(os.tmpdir(), `slideshow_blur_still_${Date.now()}_${index}.png`);
                    tempPaths.push(renderedStillPath);
                    await runExecCommandPromise(
                        `"${ffmpegPath}" -y -i "${item.path}" -frames:v 1 -vf "${placementFilter}" "${renderedStillPath}"`,
                        renderedStillPath
                    );
                    cmd += `-loop 1 -t ${imageDuration.toFixed(3)} -i "${renderedStillPath}" -f lavfi -t ${imageDuration.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=48000 `;
                    cmd += `-map 0:v -map 1:a -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest "${segmentPath}"`;
                } else {
                    cmd += `-loop 1 -t ${imageDuration.toFixed(3)} -i "${item.path}" -f lavfi -t ${imageDuration.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=48000 `;
                    cmd += `-vf "${placementFilter}" -map 0:v -map 1:a -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 -shortest "${segmentPath}"`;
                }
            }

            await runExecCommandPromise(cmd, segmentPath);
            segmentPaths.push(segmentPath);
            timelineCursor = Math.max(timelineCursor, Number(item.end || (itemStart + getSlideshowMediaDuration(item))));
        }

        const concatListPath = path.join(os.tmpdir(), `slideshow_media_concat_${Date.now()}.txt`);
        tempPaths.push(concatListPath);
        fs.writeFileSync(concatListPath, segmentPaths.map(filePath => `file '${filePath.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

        const baseConcatPath = path.join(os.tmpdir(), `slideshow_media_base_${Date.now()}.mp4`);
        tempPaths.push(baseConcatPath);

        if (parentWindow) {
            parentWindow.webContents.send('export-progress', {
                status: 'progress',
                message: t('runtime.slideshow_editor.merging_parts_80', 'Merging parts (80%)...'),
                percent: 75
            });
        }

        await runExecCommandPromise(
            `"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${baseConcatPath}"`,
            baseConcatPath
        );

        const pairedAudioIds = new Set(imageTimings.filter(item => item.pairedAudioId).map(item => item.pairedAudioId));
        const globalAudioTracks = audioTracks.filter(track => !pairedAudioIds.has(track.id));
        const audioInputMap = new Map();
        let nextAudioInputIdx = 1;
        audioTracks.forEach((track) => {
            audioInputMap.set(track.id, nextAudioInputIdx++);
        });

        let finalCmd = `"${ffmpegPath}" -y -i "${baseConcatPath}" `;
        audioTracks.forEach((track) => {
            finalCmd += `-i "${track.path}" `;
        });

        let filterComplex = '';
        const textFilter = buildSlideshowTextOverlayFilters('basev', projectData.textOverlays || [], mediaTimings, tempPaths);
        filterComplex += `[0:v]null[basev]; `;
        filterComplex += textFilter.filterComplex;
        let videoOutputLabel = textFilter.outputLabel;

        filterComplex += `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[baseaud]; `;

        const backgroundSegments = [];
        let pairedSegIndex = 0;
        pairedAudioIds.forEach((audioId) => {
            const inputIdx = audioInputMap.get(audioId);
            if (inputIdx === undefined) return;
            const pairedImages = imageTimings.filter(item => item.pairedAudioId === audioId);
            let audioOffset = 0;
            pairedImages.forEach((item) => {
                const segLabel = `pbg${pairedSegIndex++}`;
                const delayMs = Math.round(item.start * 1000);
                filterComplex += `[${inputIdx}:a]atrim=${audioOffset.toFixed(3)}:${(audioOffset + item.duration).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo`;
                if (delayMs > 0) {
                    filterComplex += `,adelay=${delayMs}|${delayMs}`;
                }
                filterComplex += `[${segLabel}]; `;
                backgroundSegments.push(segLabel);
                audioOffset += item.duration;
            });
        });

        if (globalAudioTracks.length === 1) {
            const inputIdx = audioInputMap.get(globalAudioTracks[0].id);
            filterComplex += `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000,atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[gaud0]; `;
            backgroundSegments.push('gaud0');
        } else if (globalAudioTracks.length > 1) {
            let concatInputs = '';
            globalAudioTracks.forEach((track, index) => {
                const inputIdx = audioInputMap.get(track.id);
                filterComplex += `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[gaudsrc${index}]; `;
                concatInputs += `[gaudsrc${index}]`;
            });
            filterComplex += `${concatInputs}concat=n=${globalAudioTracks.length}:v=0:a=1[gaud_concat_pre]; `;
            filterComplex += `[gaud_concat_pre]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[gaud_concat]; `;
            backgroundSegments.push('gaud_concat');
        }

        let audioOutputLabel = 'baseaud';
        if (backgroundSegments.length > 0) {
            if (backgroundSegments.length === 1) {
                filterComplex += `[${backgroundSegments[0]}]anull[bgaud_pre]; `;
            } else {
                const backgroundMixInputs = backgroundSegments.map(label => `[${label}]`).join('');
                filterComplex += `${backgroundMixInputs}amix=inputs=${backgroundSegments.length}:duration=longest:dropout_transition=0[bgaud_pre]; `;
            }

            const duckingFilters = buildBackgroundAudioDuckingFilters('bgaud_pre', mediaTimings);
            filterComplex += `${duckingFilters.filterComplex}; `;

            filterComplex += `[baseaud][${duckingFilters.outputLabel}]amix=inputs=2:duration=longest:dropout_transition=0[aout_pre]; `;
            filterComplex += `[aout_pre]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]; `;
            audioOutputLabel = 'aout';
        } else {
            filterComplex += `[baseaud]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]; `;
            audioOutputLabel = 'aout';
        }

        const mixedFilterPath = path.join(os.tmpdir(), `slideshow_media_fc_${Date.now()}.txt`);
        tempPaths.push(mixedFilterPath);
        const normalizedMixedFilter = filterComplex
            .split(';')
            .map(part => part.trim())
            .filter(Boolean)
            .join('; ');
        fs.writeFileSync(mixedFilterPath, normalizedMixedFilter, 'utf8');
        try {
            fs.appendFileSync(path.join(os.tmpdir(), 'engelsiz-ffmpeg-log-exec.txt'), `\nMIXED_FILTER_SCRIPT:\n${normalizedMixedFilter}\n`);
        } catch (error) {
            console.warn('[Slideshow] Failed to append mixed filter script to log:', error.message);
        }

        finalCmd += `-filter_complex_script "${mixedFilterPath}" -map "[${videoOutputLabel}]" -map "[${audioOutputLabel}]" -c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p ${DEFAULT_SLIDESHOW_COLOR_OPTIONS} -r 25 -c:a aac -b:a 192k -ar 48000 -ac 2 "${outputPath}"`;

        const onProgress = parentWindow ? (percent) => {
            const globalPercent = 80 + Math.round(percent * 0.19);
            parentWindow.webContents.send('export-progress', {
                status: 'progress',
                message: t('runtime.slideshow_editor.merging_parts', 'Merging parts...'),
                percent: Math.min(99, globalPercent)
            });
        } : null;

        await runExecCommandPromise(finalCmd, outputPath, {
            totalDuration,
            onProgress
        });

        return outputPath;
    } finally {
        prepared.cleanup();
        tempPaths.forEach((filePath) => {
            try {
                if (filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (cleanupError) {
                console.warn('[Slideshow] Temp cleanup failed:', cleanupError.message);
            }
        });
    }
}

/**
 * Büyük projeler için Batch İşleme Yöntemi
 * Projeyi parçalara (batch) ayırır, her parçayı ayrı işler ve sonunda birleştirir.
 */
async function createSlideshowVideoBatched(projectData, outputPath, parentWindow) {
    const ffmpegPath = getFFmpegPath();
    const BATCH_SIZE = 20; // Her partide işlenecek resim sayısı
    const tempDir = os.tmpdir();
    const batchFiles = [];
    const totalImages = projectData.images.length;
    const [width, height] = projectData.aspectRatio === '16:9' ? [1920, 1080] : [1080, 1920];
    const allAudioTracks = projectData.audioTracks || [];
    const singleGlobalAudioInfo = allAudioTracks.length === 1
        ? await getPrimaryAudioStreamInfo(allAudioTracks[0].path)
        : null;

    console.log(`Batch işleme başladı. Toplam ${totalImages} resim.`);

    try {
        // 1. Resimleri partilere ayır ve her birini video (sessiz) olarak render et
        for (let i = 0; i < totalImages; i += BATCH_SIZE) {
            const batchImages = projectData.images.slice(i, i + BATCH_SIZE);
            const batchIndex = Math.floor(i / BATCH_SIZE);
            const batchPath = path.join(tempDir, `batch_${Date.now()}_${batchIndex}.mp4`);

            console.log(`Batch ${batchIndex + 1} işleniyor (${batchImages.length} resim)...`);

            if (parentWindow) {
                const percent = Math.round((i / totalImages) * 80); // %0 - %80 arası
                parentWindow.webContents.send('export-progress', {
                    status: 'progress',
                    message: t('runtime.slideshow_editor.batch_progress', 'Processing part {current} of {total}...', {
                        current: batchIndex + 1,
                        total: Math.ceil(totalImages / BATCH_SIZE)
                    }),
                    percent
                });
            }

            // Batch için geçici proje verisi (Sadece Video, Ses Yok, Text Yok)
            // Text final montajda değil de burada işlenirse daha iyi olabilir ama global timestamp sorunu var.
            // En kolayı Text'leri final montajda değil, batch montajda işlemek.
            // Bunun için batch içindeki resimlerin textlerini filtrelemeliyiz.

            // Batch Zamanlaması:
            // Bu batch'in başlangıç zamanı (global timeline'da)
            let batchStartTime = 0;
            for (let k = 0; k < i; k++) {
                batchStartTime += projectData.images[k].duration;
            }

            // Batch içindeki textleri bul
            const batchTextOverlays = [];
            if (projectData.textOverlays) {
                projectData.textOverlays.forEach(overlay => {
                    // Bu overlay'in hedeflediği resimlerden herhangi biri bu batch içinde mi?
                    const relevantTargets = overlay.targetImages.filter(imgId =>
                        batchImages.some(img => img.id === imgId)
                    );

                    if (relevantTargets.length > 0) {
                        // Kopyasını oluştur ve sadece bu batch'teki hedefleri bırak
                        const overlayCopy = { ...overlay, targetImages: relevantTargets };
                        batchTextOverlays.push(overlayCopy);
                    }
                });
            }

            // Batch Konfigürasyonu
            // Eşlenmiş ses varsa, batch'e sadece ilgili ses parçalarını dahil et
            const hasPairedAudio = batchImages.some(img => img.pairedAudioId);
            let batchAudioTracks = [];
            if (hasPairedAudio) {
                const pairedAudioIds = [...new Set(
                    batchImages.filter(img => img.pairedAudioId).map(img => img.pairedAudioId)
                )];
                batchAudioTracks = (projectData.audioTracks || []).filter(
                    a => pairedAudioIds.includes(a.id)
                );
            }
            // Global (eşlenmemiş) sesler batch'e dahil DEĞİL, final merge'de işlenecek

            const batchConfig = {
                ...projectData,
                images: batchImages,
                audioTracks: batchAudioTracks,
                textOverlays: batchTextOverlays
            };

            // Batch Render komutunu oluştur (createSlideshowVideo'nun biraz modifiyesi lazım ama
            // createSlideshowVideo zaten promise dönüyor, onu REUSE edebiliriz ama text overlay zamanlaması GLOBAL
            // zamanlamaya göre olabilir mi? createSlideshowVideo fonksiyonu, verilen image listesine göre
            // start time 0'dan başlatıyor. Bu harika! Çünkü lokal mp4 üretiyoruz.
            // SORUN: createSlideshowVideo fonksiyonu localMP4 ürettiğinde zaman 0'dan başlar.
            // Ama biz text overlay'in "enable between" parametresini global zamana göre değil,
            // batch-içindeki zamana göre ayarlamalıyız. createSlideshowVideo zaten "imageTimings"i
            // loop içinde "currentTime=0"dan başlatarak kuruyor.
            // Dolayısıyla Text Overlay bu batch'e ait resime bağlıysa, sorunsuz çalışır!

            await createSlideshowVideo(batchConfig, batchPath, null);
            batchFiles.push(batchPath);
        }

        // 2. Parçaları Birleştir (Concat Demuxer)
        if (parentWindow) {
            parentWindow.webContents.send('export-progress', {
                status: 'progress',
                message: t('runtime.slideshow_editor.merging_parts_80', 'Merging parts (80%)...'),
                percent: 80
            });
        }

        const concatListPath = path.join(tempDir, `concat_list_${Date.now()}.txt`);
        const fileContent = batchFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatListPath, fileContent);

        // Final montaj: Concat Video + Global Audio
        let cmd = `"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" `;

        // Sesleri ekle — eşlenmiş sesler batch'lerde zaten işlendi,
        // sadece global (eşlenmemiş) sesleri final merge'e dahil et
        const hasPairedAudio = projectData.images.some(img => img.pairedAudioId);
        const pairedAudioIds = hasPairedAudio
            ? new Set(projectData.images.filter(img => img.pairedAudioId).map(img => img.pairedAudioId))
            : new Set();
        const audioTracks = allAudioTracks.filter(a => !pairedAudioIds.has(a.id));
        const hasAudio = audioTracks.length > 0;
        audioTracks.forEach(track => {
            cmd += `-i "${track.path}" `;
        });

        // Toplam süre
        let totalDuration = 0;
        projectData.images.forEach(img => totalDuration += img.duration);

        // Filter Complex (Sadece Ses için, Video concat demuxer ile geliyor)
        let filterComplex = '';
        let audioMap = '';

        if (hasPairedAudio && !hasAudio) {
            // Eşlenmiş sesler batch'lerde zaten işlendi, global ses yok
            // Video'nun sesini koru (batch'lerden gelen)
            audioMap = '-map 0:a? -c:a aac -b:a 192k -ar 48000 -ac 2';
        } else if (hasAudio) {
            if (hasPairedAudio) {
                // Batch'lerdeki ses var + global ses var: mix lazım
                let audioConcats = '';
                audioTracks.forEach((_, i) => {
                    const inputIdx = i + 1; // 0 video (concat), 1+ audio
                    filterComplex += `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[gaud${i}]; `;
                    audioConcats += `[gaud${i}]`;
                });
                if (audioTracks.length === 1) {
                    filterComplex += `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[batchaud]; `;
                    filterComplex += `[batchaud]${audioConcats}amix=inputs=2:duration=longest[amixed]; `;
                    filterComplex += `[amixed]volume=2[outa_pre]; `;
                } else {
                    filterComplex += `${audioConcats}concat=n=${audioTracks.length}:v=0:a=1[gaud_concat]; `;
                    filterComplex += `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[batchaud]; `;
                    filterComplex += `[batchaud][gaud_concat]amix=inputs=2:duration=longest[amixed]; `;
                    filterComplex += `[amixed]volume=2[outa_pre]; `;
                }
                filterComplex += `[outa_pre]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
                audioMap = '-map "[outa]" -c:a aac -b:a 192k -ar 48000 -ac 2';
            } else if (audioTracks.length === 1) {
                audioMap = buildSingleAudioMap(1, singleGlobalAudioInfo, totalDuration);
            } else {
                // Concat mode
                let audioConcats = '';
                audioTracks.forEach((_, i) => {
                    const inputIdx = i + 1; // 0 video, 1+ audio
                    filterComplex += `[${inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=48000[aud${i}]; `;
                    audioConcats += `[aud${i}]`;
                });
                filterComplex += `${audioConcats}concat=n=${audioTracks.length}:v=0:a=1[outa_pre]; [outa_pre]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`;
                audioMap = '-map "[outa]" -c:a aac -b:a 192k -ar 48000 -ac 2';
            }
        }

        // Video direkt kopyala (re-encode yok çünkü batchler zaten encode edildi)
        // ANCAK: Eğer ses eklenecekse ve map kullanıyorsak, video map de lazım.
        // concat demuxer video stream'i default haritası 0:v

        // ÖNEMLİ: Eğer filter_complex kullanıyorsak "-c:v copy" kullanamayız, complex filter output bekler.
        // Ama burada filter_complex SADECE ses için kullanılıyor.
        // Video için "-map 0:v -c:v copy" diyebiliriz! Bu ÇOK hızlı olur.

        let videoMap = '-map 0:v -c:v copy';

        if (filterComplex) {
            // Windows komut satırı uzunluk sınırı sorunu: filter_complex'i dosyaya yaz
            const fcMergePath = path.join(tempDir, `fc_merge_${Date.now()}.txt`);
            fs.writeFileSync(fcMergePath, filterComplex, 'utf-8');
            cmd += `-filter_complex_script "${fcMergePath}" ${videoMap} ${audioMap} "${outputPath}"`;
        } else {
            // filterComplex yok (ya ses yok, ya da passthrough audio)
            if (hasAudio && audioMap) {
                // Passthrough Audio + Video Copy
                cmd += `${videoMap} ${audioMap} "${outputPath}"`;
            } else {
                // Sadece video
                cmd += `-c:v copy "${outputPath}"`;
            }
        }

        console.log('--- Final Batch Merge Cmd ---');
        console.log(cmd);

        // Final Progress
        const onFinalProgress = parentWindow ? (percent) => {
            // Batch sonrası merge işlemi (Genel sürecin %80-%100 arası)
            const globalPercent = 80 + (percent * 0.2);
            parentWindow.webContents.send('export-progress', {
                status: 'progress',
                message: t('runtime.slideshow_editor.merging_parts', 'Merging parts...'),
                percent: Math.min(99, globalPercent) // Asla 100 deme, işlem bitince diyelim
            });
        } : null;

        await new Promise((resolve, reject) => {
            execCommand(cmd, outputPath, resolve, reject, { totalDuration: totalDuration, onProgress: onFinalProgress });
        });

        // Temizlik
        try {
            batchFiles.forEach(f => fs.unlinkSync(f));
            fs.unlinkSync(concatListPath);
        } catch (e) { console.error('Temizlik hatası:', e); }

        return outputPath;

    } catch (error) {
        // Hata durumunda da temizlik dene
        try {
            batchFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        } catch (e) { }
        throw error;
    }
}

/**
 * Komut çalıştırıcı yardımcı fonksiyon
 */
/**
 * Komut çalıştırıcı yardımcı fonksiyon (Spawn ile Progress Destekli)
 */
function execCommand(cmd, outputPath, resolve, reject, options = {}) {
    const { spawn } = require('child_process');
    const { totalDuration, onProgress } = options;

    const logPath = path.join(os.tmpdir(), 'engelsiz-ffmpeg-log-exec.txt');
    try {
        fs.writeFileSync(logPath, `CMD:\n${cmd}\n\n`);
    } catch (e) { }

    const isWindows = process.platform === 'win32';
    const scriptPath = path.join(os.tmpdir(), `ffmpeg_exec_${Date.now()}${isWindows ? '.bat' : '.sh'}`);
    const scriptContent = isWindows
        ? `@echo off\r\nchcp 65001 >nul 2>&1\r\n${cmd}\r\n`
        : `#!/bin/sh\n${cmd}\n`;
    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
    if (!isWindows) {
        try {
            fs.chmodSync(scriptPath, 0o700);
        } catch (_error) { }
    }

    const child = isWindows
        ? spawn('cmd.exe', ['/c', scriptPath], { windowsHide: true })
        : spawn('/bin/sh', [scriptPath], { windowsHide: true });

    let stderrBuffer = '';

    child.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderrBuffer += dataStr; // Hata logu için biriktir

        // Progress Parse
        if (onProgress && totalDuration > 0) {
            // time=00:00:05.20 formatını yakala
            const timeMatch = dataStr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
            if (timeMatch) {
                const hours = parseInt(timeMatch[1]);
                const minutes = parseInt(timeMatch[2]);
                const seconds = parseInt(timeMatch[3]);
                const ms = parseInt(timeMatch[4]);

                const currentSeconds = (hours * 3600) + (minutes * 60) + seconds + (ms / 100);
                const percent = Math.min(99, Math.round((currentSeconds / totalDuration) * 100));

                onProgress(percent);
            }
        }
    });

    child.stdout.on('data', (data) => {
        // stdout genellikle boştur (ffmpeg logları stderr'e yazar)
    });

    child.on('error', (error) => {
        console.error('Spawn error:', error);
        try { fs.unlinkSync(scriptPath); } catch (e) { }
        reject(error);
    });

    child.on('close', (code) => {
        try { fs.unlinkSync(scriptPath); } catch (e) { }

        if (code === 0) {
            if (fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject(new Error(t('runtime.slideshow_editor.output_file_missing', 'The output file was not created.')));
            }
        } else {
            // Hata mesajında son 2000 karakteri göster (daha fazla bağlam)
            let details = t('runtime.slideshow_editor.process_failed_with_code', 'The process ended with error code {code}\nFFmpeg STDERR:\n{stderr}', {
                code,
                stderr: stderrBuffer ? stderrBuffer.slice(-2000) : t('runtime.slideshow_editor.none', 'None')
            });
            try { fs.appendFileSync(logPath, `\nERROR:\n${stderrBuffer}`); } catch (e) { }
            console.error('Exec error:', details);
            reject(new Error(details));
        }
    });
}

/**
 * Proje dosyası aç
 */
async function openProjectFile(mainWindow, directFilePath = null) {
    let filePath = directFilePath;

    if (!filePath) {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: t('messages.open_project_title', 'Open Project'),
            filters: [
                { name: t('dialog.slideshow_editor.project_file_filter_all', 'Barrier-Free Video Project Files'), extensions: ['kve', 'eng'] },
                { name: t('dialog.slideshow_editor.project_file_filter_kve', 'Korcul Project File'), extensions: ['kve'] },
                { name: t('dialog.slideshow_editor.project_file_filter_eng', 'Barrier-Free Video Project'), extensions: ['eng'] }
            ],
            properties: ['openFile']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            filePath = result.filePaths[0];
        } else {
            return; // İptal edildi
        }
    }

    try {
        const projectJSON = fs.readFileSync(filePath, 'utf8');
        const projectData = normalizeSlideshowProjectData(JSON.parse(projectJSON));
        projectData.projectPath = filePath;
        try {
            const { addToRecentFiles } = require('./menu');
            addToRecentFiles(filePath, mainWindow);
        } catch (_error) { }

        // Slideshow düzenleyiciyi aç ve projeyi yükle
        openSlideshowEditor(mainWindow, projectData);

        // Proje yüklendiğinde düzenleyiciye bildir
        if (slideshowEditorWindow) {
            slideshowEditorWindow.webContents.on('did-finish-load', () => {
                slideshowEditorWindow.webContents.send('slideshow-project-loaded', projectData);
            });
        }
    } catch (error) {
        dialog.showErrorBox(t('messages.error_title', 'Error'), t('runtime.slideshow_editor.project_open_error', 'An error occurred while opening the project: {error}', {
            error: error.message
        }));
    }
}

module.exports = { setupSlideshowHandlers, openNewProjectDialog, openProjectFile };
