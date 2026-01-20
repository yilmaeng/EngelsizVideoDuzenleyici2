/**
 * Gemini AI Handler
 * Video karesi analizi için Gemini Vision API kullanır
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');

// API anahtarı depolama yolu
const CONFIG_DIR = path.join(require('os').homedir(), '.korcul-video-editor');
const API_KEY_FILE = path.join(CONFIG_DIR, 'gemini-api-key.enc');
const AI_MODEL_FILE = path.join(CONFIG_DIR, 'ai-model.txt');

/**
 * API anahtarını kaydet (basit obfuscation)
 */
function saveApiKey(apiKey) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    // Basit base64 encoding (gerçek şifreleme için electron-store kullanılabilir)
    const encoded = Buffer.from(apiKey).toString('base64');
    fs.writeFileSync(API_KEY_FILE, encoded, 'utf8');
}

/**
 * AI modelini kaydet
 */
function saveAiModel(model) {
    fs.writeFileSync(AI_MODEL_FILE, model || 'gemini-2.5-flash', 'utf8');
}

/**
 * AI modelini oku
 */
function getAiModel() {
    if (!fs.existsSync(AI_MODEL_FILE)) {
        return 'gemini-2.5-flash';
    }
    return fs.readFileSync(AI_MODEL_FILE, 'utf8') || 'gemini-2.5-flash';
}

/**
 * API anahtarını oku
 */
function getApiKey() {
    if (!fs.existsSync(API_KEY_FILE)) {
        return null;
    }
    try {
        const encoded = fs.readFileSync(API_KEY_FILE, 'utf8');
        return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
        console.error('API anahtarı okunamadı:', error);
        return null;
    }
}

/**
 * Gemini File API'ye dosya yükle
 */
async function uploadToGemini(apiKey, filePath, mimeType) {
    const fileSize = fs.statSync(filePath).size;

    // 1. Adım: Resumeable upload başlat
    const initialUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const initialOptions = {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': fileSize,
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
        }
    };

    const uploadUrl = await new Promise((resolve, reject) => {
        const req = https.request(initialUrl, initialOptions, (res) => {
            const uploadUri = res.headers['x-goog-upload-url'];
            if (uploadUri) resolve(uploadUri);
            else reject(new Error('Upload URL alınamadı. HTTP: ' + res.statusCode));
        });
        req.on('error', reject);
        req.write(JSON.stringify({ file: { display_name: path.basename(filePath) } }));
        req.end();
    });

    // 2. Adım: Dosya içeriğini yükle
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const uploadOptions = {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Offset': 0,
                'X-Goog-Upload-Command': 'upload, finalize',
                'Content-Length': fileSize
            }
        };

        const req = https.request(uploadUrl, uploadOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.file && response.file.uri) resolve(response.file);
                    else reject(new Error('Yükleme yanıtı geçersiz: ' + data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        fileStream.pipe(req);
    });
}

/**
 * Dosyanın işlenmesini bekle (ACTIVE olana kadar)
 */
async function waitForFileActive(apiKey, fileUri) {
    const checkUrl = `${fileUri}?key=${apiKey}`;
    let attempts = 0;
    while (attempts < 10) {
        const state = await new Promise((resolve, reject) => {
            https.get(checkUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.state);
                    } catch (e) { resolve('ERROR'); }
                });
            }).on('error', () => resolve('ERROR'));
        });

        if (state === 'ACTIVE') return true;
        if (state === 'FAILED') throw new Error('Dosya işleme başarısız oldu.');

        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }
    throw new Error('Dosya işleme zaman aşımına uğradı.');
}

/**
 * Gemini Vision API isteği gönder
 * @param {string} model - Kullanılacak model (gemini-2.5-flash, gemini-1.5-flash, vs.)
 */
async function sendGeminiRequest(apiKey, model, imageBase64, prompt, history = []) {
    return new Promise((resolve, reject) => {
        // Seçilen modele göre endpoint
        const modelName = model || 'gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        // İstek gövdesi hazırla
        const contents = [];

        // Konuşma geçmişi
        history.forEach(msg => {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        });

        // Mevcut istek (görsel + metin)
        const parts = [];

        // Görsel ekle (varsa)
        // Görsel ekle (varsa)
        if (imageBase64) {
            if (Array.isArray(imageBase64)) {
                // Array of images
                imageBase64.forEach(img => {
                    const mime = img.mimeType || 'image/jpeg';
                    const data = img.data || img; // Handle string or object
                    parts.push({
                        inline_data: {
                            mime_type: mime,
                            data: data
                        }
                    });
                });
            } else {
                // Single image
                parts.push({
                    inline_data: {
                        mime_type: 'image/jpeg',
                        data: imageBase64
                    }
                });
            }
        }

        // Metin ekle
        parts.push({ text: prompt });

        contents.push({
            role: 'user',
            parts: parts
        });

        const requestBody = JSON.stringify({
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192
            }
        });

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
                        reject(new Error(response.error.message || 'API hatası'));
                        return;
                    }

                    if (response.candidates && response.candidates[0] &&
                        response.candidates[0].content &&
                        response.candidates[0].content.parts) {
                        const text = response.candidates[0].content.parts
                            .map(p => p.text)
                            .join('');
                        resolve(text);
                    } else {
                        reject(new Error('Geçersiz API yanıtı'));
                    }
                } catch (error) {
                    reject(new Error('API yanıtı işlenemedi: ' + error.message));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error('Bağlantı hatası: ' + error.message));
        });

        req.write(requestBody);
        req.end();
    });
}

/**
 * IPC handler'larını kur
 */
function setupGeminiHandlers(mainWindow) {
    const ffmpegHandler = require('./ffmpeg-handler');

    // API anahtarını kaydet
    ipcMain.handle('save-gemini-api-key', async (event, { apiKey, model }) => {
        try {
            if (apiKey) saveApiKey(apiKey);
            if (model) saveAiModel(model);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // API verilerini al (Anahtar ve Model)
    ipcMain.handle('get-gemini-api-data', async () => {
        return {
            apiKey: getApiKey(),
            model: getAiModel()
        };
    });

    // Sadece API anahtarını al (frontend tarafından kullanılıyor)
    ipcMain.handle('get-gemini-api-key', async () => {
        return getApiKey();
    });

    // Video karesini base64 olarak çıkar
    ipcMain.handle('extract-frame-base64', async (event, { time, videoPath }) => {
        const os = require('os');
        const tempFile = path.join(os.tmpdir(), `frame_${Date.now()}.jpg`);

        try {
            if (!videoPath) {
                throw new Error('Video yolu parametresi eksik.');
            }

            // Kareyi çıkar
            await ffmpegHandler.extractFrame(videoPath, tempFile, time);

            // Base64'e çevir
            const imageBuffer = fs.readFileSync(tempFile);
            const base64 = imageBuffer.toString('base64');

            // Geçici dosyayı sil
            fs.unlinkSync(tempFile);

            return base64;
        } catch (error) {
            // Geçici dosyayı temizle
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            throw error;
        }
    });

    // Seçimi betimle (Video klip analizi)
    ipcMain.handle('gemini-describe-selection', async (event, { apiKey, model, startTime, endTime, prompt }) => {
        const tempVideoFile = path.join(require('os').tmpdir(), `ai_clip_${Date.now()}.mp4`);
        let fileData = null;

        try {
            // Ana pencereden video yolunu al
            const videoPath = await new Promise((resolve) => {
                mainWindow.webContents.send('get-current-video-path');
                ipcMain.once('current-video-path-response', (event, path) => resolve(path));
            });

            if (!videoPath) throw new Error('Video yolu alınamadı');

            await ffmpegHandler.cutVideoClip(videoPath, tempVideoFile, startTime, endTime - startTime);

            // Dosyanın oluştuğunu kontrol et
            if (!fs.existsSync(tempVideoFile)) {
                throw new Error('Video klibi oluşturulamadı!');
            }

            // Gemini File API'ye yükle
            fileData = await uploadToGemini(apiKey, tempVideoFile, 'video/mp4');

            // Dosya işlemesini bekle
            await waitForFileActive(apiKey, fileData.uri);
            const contents = [{
                role: 'user',
                parts: [
                    { file_data: { mime_type: 'video/mp4', file_uri: fileData.uri } },
                    { text: prompt }
                ]
            }];

            const aiResponse = await sendGeminiRequestBatch(apiKey, model || 'gemini-2.5-flash', contents);

            // Temizlik
            if (fs.existsSync(tempVideoFile)) fs.unlinkSync(tempVideoFile);

            return aiResponse;
        } catch (error) {
            if (fs.existsSync(tempVideoFile)) fs.unlinkSync(tempVideoFile);
            console.error('AI Video Analiz Hatası:', error);
            throw error;
        }
    });

    // Gemini Vision isteği
    ipcMain.handle('gemini-vision-request', async (event, { apiKey, model, imageBase64, prompt, history }) => {
        try {
            const text = await sendGeminiRequest(apiKey, model, imageBase64, prompt, history);
            return { success: true, text: text };
        } catch (error) {
            console.error('Gemini Vision Hatası:', error);
            // Return error object instead of throwing, so renderer can display it nicely
            return { success: false, error: error.message };
        }
    });
}

/**
 * Grup içerikli Gemini isteği gönder
 */
async function sendGeminiRequestBatch(apiKey, model, contents) {
    return new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const requestBody = JSON.stringify({
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 8192
            }
        });

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
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.error) {
                        reject(new Error(response.error.message || 'API hatası'));
                        return;
                    }
                    if (response.candidates && response.candidates[0]?.content?.parts) {
                        resolve(response.candidates[0].content.parts.map(p => p.text).join(''));
                    } else {
                        reject(new Error('Geçersiz API yanıtı'));
                    }
                } catch (error) {
                    reject(new Error('API yanıtı işlenemedi: ' + error.message));
                }
            });
        });

        req.on('error', error => reject(new Error('Bağlantı hatası: ' + error.message)));
        req.write(requestBody);
        req.end();
    });
}

module.exports = {
    setupGeminiHandlers,
    saveApiKey,
    getApiKey
};
