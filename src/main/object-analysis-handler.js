const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const ffmpegHandler = require('./ffmpeg-handler');

const CONFIG_DIR = path.join(require('os').homedir(), '.korcul-video-editor');
const MODEL_STATUS_FILE = path.join(CONFIG_DIR, 'ai-model-status.json');

function isModelDownloaded() {
    try {
        if (fs.existsSync(MODEL_STATUS_FILE)) {
            const status = JSON.parse(fs.readFileSync(MODEL_STATUS_FILE, 'utf8'));
            return status.downloaded === true;
        }
    } catch (e) { }
    return false;
}

function setModelDownloaded(downloaded) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(MODEL_STATUS_FILE, JSON.stringify({ downloaded }), 'utf8');
    } catch (e) {
        console.error('Model status save error:', e);
    }
}

let worker = null;
let mainWindowRef = null;

// Worker Management
function getWorker() {
    if (!worker) {
        worker = fork(path.join(__dirname, 'detection-worker.js'));

        worker.on('message', (msg) => {
            if (msg.type === 'status' && mainWindowRef) {
                mainWindowRef.webContents.send('analysis-status', msg.message);
            } else if (msg.type === 'error' && mainWindowRef) {
                mainWindowRef.webContents.send('analysis-error', msg.message);
            } else if (msg.type === 'ready') {
                // Worker notified it's ready (model loaded), so we can assume it's downloaded
                setModelDownloaded(true);
            }
            // Result handling is done via request callbacks map or similar if needed, 
            // but for simplicity we'll handle per-job in the analyze function logic
        });
    }
    return worker;
}

// Simple Tracker Logic
function trackObjects(detections, frameTimeDiff = 0.2) {
    // detections: [ { frameTime: 0.0, data: [ { label, box: {xmin,ymin,xmax,ymax}, score } ] }, ... ]
    // Output: List of Unique Objects with trajectory

    let nextId = 1;
    let tracks = []; // { id, label, boxes: [ {time, box} ], score }

    detections.sort((a, b) => a.frameTime - b.frameTime);

    detections.forEach((frame) => {
        const time = frame.frameTime;
        const boxes = frame.data;

        boxes.forEach(det => {
            // Find component in existing tracks
            let bestMatch = null;
            let bestIou = 0.0;

            tracks.filter(t => t.endTime >= time - frameTimeDiff * 1.5).forEach(track => {
                // Check IOU with last position
                const lastPos = track.boxes[track.boxes.length - 1].box;
                const iou = calculateIoU(det.box, lastPos);
                if (iou > 0.3 && (track.label === det.label || iou > 0.7)) { // looser label match if high overlap
                    if (iou > bestIou) {
                        bestIou = iou;
                        bestMatch = track;
                    }
                }
            });

            if (bestMatch) {
                bestMatch.boxes.push({ time, box: det.box });
                bestMatch.endTime = time;
                bestMatch.score = Math.max(bestMatch.score, det.score); // keep max confidence
            } else {
                // New track
                tracks.push({
                    id: nextId++,
                    label: det.label,
                    startTime: time,
                    endTime: time,
                    boxes: [{ time, box: det.box }],
                    score: det.score
                });
            }
        });
    });

    // Filter short tracks (flicker)
    return tracks.filter(t => t.boxes.length > 1 || t.score > 0.5);
}

function calculateIoU(boxA, boxB) {
    const xA = Math.max(boxA.xmin, boxB.xmin);
    const yA = Math.max(boxA.ymin, boxB.ymin);
    const xB = Math.min(boxA.xmax, boxB.xmax);
    const yB = Math.min(boxA.ymax, boxB.ymax);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const boxAArea = (boxA.xmax - boxA.xmin) * (boxA.ymax - boxA.ymin);
    const boxBArea = (boxB.xmax - boxB.xmin) * (boxB.ymax - boxB.ymin);

    return interArea / (boxAArea + boxBArea - interArea);
}

// Gemini entegrasyonu
const geminiHandler = require('./gemini-handler');
// Worker referansları kaldırıldı

async function analyzeScene(videoPath, startTime, duration, customLabels) {
    // 1. Check API Key
    const apiKey = geminiHandler.getApiKey();
    if (!apiKey) {
        throw new Error("Yapay Zeka analizi için Gemini API anahtarı gereklidir. Lütfen 'Yapay Zeka -> Gemini API Anahtarı' menüsünden anahtarınızı girin.");
    }

    // 2. Extract Keyframes (e.g. 3 frames: start, middle, end)
    const frames = [];
    const timestamps = [startTime, startTime + (duration / 2), startTime + duration - 0.1];
    const frameBase64s = [];

    if (mainWindowRef) mainWindowRef.webContents.send('analysis-status', 'Kareler hazırlanıyor...');

    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    try {
        for (let i = 0; i < timestamps.length; i++) {
            const time = Math.max(0, timestamps[i]);
            const tempFile = path.join(os.tmpdir(), `analy_frame_${Date.now()}_${i}.jpg`);

            await ffmpegHandler.extractFrame(videoPath, tempFile, time);

            if (fs.existsSync(tempFile)) {
                const buffer = fs.readFileSync(tempFile);
                frameBase64s.push(buffer.toString('base64'));
                fs.unlinkSync(tempFile);
            }
        }

        if (frameBase64s.length === 0) throw new Error("Görüntü alınamadı.");

        if (mainWindowRef) mainWindowRef.webContents.send('analysis-status', 'Yapay zeka sahneyi inceliyor...');

        // 3. Ask Gemini
        // Tutarlılık için sıcaklık 0.0, bounding box koordinatları iste
        const prompt = `
        Video zaman çizelgesinden 3 kare görüyorsun (Başlangıç, Orta, Bitiş).
        
        GÖREV: Bu sahnede görünen TÜM nesneleri, kişileri, logoları ve dikkat çeken öğeleri listele.
        Her nesne için yaklaşık BOUNDING BOX koordinatlarını ver (0-1000 ölçeğinde).
        
        ÖNEMLİ - ETIKET KURALLARI:
        - İnsan için: "Yüz" veya "Tam Vücut" olarak belirt (Örn: "Adamın Yüzü", "Kadının Tam Vücudu")
        - Küçük nesneler için boyut belirt (Örn: "Küçük Telefon", "Büyük Masa")
        - Türkçe etiket kullan
        
        BOUNDING BOX:
        - [ymin, xmin, ymax, xmax] formatında (0=üst/sol köşe, 1000=alt/sağ köşe)
        - Nesnenin gerçek sınırlarını kapsamalı
        
        Yanıtı SADECE geçerli bir JSON formatında ver.
        
        JSON Formatı:
        [
          { 
            "label": "Adamın Yüzü", 
            "type": "face", 
            "boundingBox": [100, 200, 300, 400],
            "presentInFrames": [0, 1, 2], 
            "confidence": 0.95 
          },
          { 
            "label": "Masadaki Telefon", 
            "type": "object", 
            "boundingBox": [600, 700, 650, 780],
            "presentInFrames": [0, 1], 
            "confidence": 0.80 
          }
        ]
        `;

        // Use vision request
        // geminiHandler fonksiyonları export edilmeli veya ipc üzerinden çağrılmalı. 
        // gemini-handler module.exports içinde 'saveApiKey', 'getApiKey' var ama 'sendGeminiRequest' yok (internal).
        // Ancak setupGeminiHandlers içinde ipcMain.handle var.
        // Biz burada internal fonksiyon yazmalıyız veya gemini-handler'ı açmalıyız. 
        // gemini-handler.js'ye bakarsak sendGeminiRequest internal.
        // Çözüm: gemini-handler.js'den sendGeminiRequest'i export etmeye gerek yok, 
        // buraya kopyalayabiliriz veya gemini-handler'ı güncelleyebiliriz.
        // En temizi: gemini-handler dosyasını güncellemek ama şu an buradayız.
        // IPC üzerinden kendi kendimize çağıramayız (Main->Main IPC yoktur).
        // En iyisi: gemini anahtarını aldık, basit bir https request wrapper yazalım (zaten detection-worker'da denedik).
        // VEYA: detection-worker.js yerine 'gemini-handler.js' exportlarını kullanabiliriz.

        // Hızlı çözüm için HTTP isteğini burada yapıyoruz (Gemini Handler'dan kopyalama mantığı ile)
        // Ancak kod tekrarından kaçınmak için gemini-handler.js'deki sendGeminiRequestBatch benzeri bir mantık kuralım.

        // Basit request (Vision)
        const contents = [{
            role: 'user',
            parts: [
                ...frameBase64s.map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } })),
                { text: prompt }
            ]
        }];

        // URL construct
        const model = 'gemini-2.5-flash'; // Hızlı ve iyi
        const https = require('https');

        const responseText = await new Promise((resolve, reject) => {
            const reqData = JSON.stringify({
                contents,
                generationConfig: { temperature: 0.0, response_mime_type: "application/json" } // Tutarlılık için 0.0
            });

            const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);
            req.write(reqData);
            req.end();
        });

        const jsonResp = JSON.parse(responseText);
        if (jsonResp.error) throw new Error(jsonResp.error.message);

        const text = jsonResp.candidates[0].content.parts[0].text;
        // Clean markdown code blocks if any
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const objects = JSON.parse(cleanText);

        // 4. Convert to "Tracks" format expected by UI
        // [{ id, label, boxes: [{time, box}], startTime, endTime, score }]
        // Since we don't have boxes, we'll fake a full-screen box or rough position?
        // UI uses tracks for listing. Box drawing needs box.
        // Gemini doesn't return bounding boxes easily without complex setup.
        // For "Analysis" listing, this is fine. For "Blur", we might need full screen or simple mask.
        // We will return a "Generic" track.

        const videoMeta = await ffmpegHandler.getVideoMetadata(videoPath);
        const vw = videoMeta.width || 1920;
        const vh = videoMeta.height || 1080;

        return objects.map((obj, idx) => {
            let xmin, ymin, xmax, ymax;

            // Gemini'den bounding box geldiyse kullan (0-1000 ölçeğinde)
            if (obj.boundingBox && obj.boundingBox.length === 4) {
                // [ymin, xmin, ymax, xmax] formatı
                const [bymin, bxmin, bymax, bxmax] = obj.boundingBox;

                // 0-1000 ölçeğinden piksel koordinatlarına çevir
                xmin = Math.round((bxmin / 1000) * vw);
                ymin = Math.round((bymin / 1000) * vh);
                xmax = Math.round((bxmax / 1000) * vw);
                ymax = Math.round((bymax / 1000) * vh);

                console.log(`Bounding Box: ${obj.label} -> [${xmin}, ${ymin}, ${xmax}, ${ymax}]`);
            } else {
                // Fallback: Sabit %30 kutu (eski mantık)
                const boxW = vw * 0.30;
                const boxH = vh * 0.30;
                xmin = (vw - boxW) / 2;
                ymin = (vh - boxH) / 2;
                xmax = xmin + boxW;
                ymax = ymin + boxH;

                console.log(`No bounding box for ${obj.label}, using fallback`);
            }

            return {
                id: idx + 1,
                label: obj.label,
                type: obj.type,
                position: obj.position || 'Belirsiz',
                startTime: startTime + (obj.presentInFrames && obj.presentInFrames.includes(0) ? 0 : (duration / 2)),
                endTime: startTime + (duration),
                score: obj.confidence || 0.9,
                // Gerçek bounding box koordinatları
                boxes: [{
                    time: startTime,
                    box: { xmin, ymin, xmax, ymax }
                }]
            };
        });

    } catch (err) {
        console.error("Gemini analiz hatası:", err);
        throw err;
    }
}

async function applyEffect(videoPath, outputPath, objectTrack, effectType, scope, customStart, customEnd) {
    // scope: 'track', 'full', 'custom'
    console.log('=== applyEffect çağrıldı ===');
    console.log('Scope:', scope, 'Custom:', customStart, '-', customEnd);

    // Video metadata al
    const videoMeta = await ffmpegHandler.getVideoMetadata(videoPath);
    const width = videoMeta.width || 1920;
    const height = videoMeta.height || 1080;
    const videoDuration = videoMeta.duration || 3600; // Varsayılan 1 saat

    console.log('Video Süresi:', videoDuration, 'saniye');

    // Sort boxes by time
    const boxes = objectTrack.boxes.sort((a, b) => a.time - b.time);

    // Box koordinatları (ilk box'u kullan)
    const box = boxes.length > 0 ? boxes[0].box : { xmin: width * 0.25, ymin: height * 0.25, xmax: width * 0.75, ymax: height * 0.75 };

    const x = Math.round(box.xmin);
    const y = Math.round(box.ymin);
    const w = Math.round(box.xmax - box.xmin);
    const h = Math.round(box.ymax - box.ymin);

    // Zaman aralığını scope'a göre belirle
    let tStart, tEnd;

    if (scope === 'full') {
        // Tüm video boyunca
        tStart = 0;
        tEnd = videoDuration;
        console.log('SCOPE=FULL: tStart=0, tEnd=', videoDuration);
    } else if (scope === 'custom' && customStart !== null && customEnd !== null) {
        // Manuel zaman aralığı
        tStart = customStart;
        tEnd = customEnd;
        console.log('SCOPE=CUSTOM: tStart=', tStart, ', tEnd=', tEnd);
    } else {
        // Varsayılan: nesnenin görünür olduğu süre (track)
        tStart = objectTrack.startTime;
        tEnd = objectTrack.endTime;
        console.log('SCOPE=TRACK: tStart=', tStart, ', tEnd=', tEnd);
    }

    let filterStr = '';

    if (effectType === 'hide') {
        // Siyah kutu (dolu)
        filterStr = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill:enable='between(t,${tStart},${tEnd})'`;
    } else if (effectType === 'box') {
        // Kırmızı çerçeve (sadece kenar)
        filterStr = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@1:t=5:enable='between(t,${tStart},${tEnd})'`;
    } else if (effectType === 'mosaic') {
        // Mozaik simülasyonu - gri kutu
        filterStr = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=gray@0.8:t=fill:enable='between(t,${tStart},${tEnd})'`;
    } else if (effectType === 'blur') {
        // Blur simülasyonu - beyaz yarı şeffaf
        filterStr = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white@0.5:t=fill:enable='between(t,${tStart},${tEnd})'`;
    } else if (effectType === 'greenscreen') {
        // Yeşil perde (Chroma Key için) - parlak yeşil
        filterStr = `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0x00FF00@1:t=fill:enable='between(t,${tStart},${tEnd})'`;
    }

    console.log('=== EFEKT BİLGİLERİ ===');
    console.log('Efekt Türü:', effectType);
    console.log('Konum:', x, y, 'Boyut:', w, 'x', h);
    console.log('Zaman Aralığı:', tStart, '-', tEnd);
    console.log('FFmpeg Filter:', filterStr);

    return new Promise((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');

        console.log('=== FFmpeg Başlıyor ===');
        console.log('Input:', videoPath);
        console.log('Output:', outputPath);

        const cmd = ffmpeg(videoPath)
            .output(outputPath)
            .outputOptions('-vf', filterStr)
            .on('start', (commandLine) => {
                console.log('FFmpeg komutu:', commandLine);
            })
            .on('stderr', (stderrLine) => {
                // Sadece önemli satırları logla
                if (stderrLine.includes('Error') || stderrLine.includes('error')) {
                    console.log('FFmpeg stderr:', stderrLine);
                }
            })
            .on('end', () => {
                console.log('FFmpeg tamamlandı! Çıktı:', outputPath);
                resolve();
            })
            .on('error', (err) => {
                console.error("FFmpeg Error:", err.message);
                reject(err);
            });

        cmd.run();
    });
}

// Çoklu nesne desteği için yeni fonksiyon
async function applyEffectMultiple(videoPath, outputPath, objectTracks, effectType, scope, customStart, customEnd) {
    if (!objectTracks || objectTracks.length === 0) {
        throw new Error('Hiç nesne seçilmedi');
    }

    // Tek nesne ise eski fonksiyonu kullan
    if (objectTracks.length === 1) {
        return applyEffect(videoPath, outputPath, objectTracks[0], effectType, scope, customStart, customEnd);
    }

    // Video metadata al
    const videoMeta = await ffmpegHandler.getVideoMetadata(videoPath);
    const width = videoMeta.width || 1920;
    const height = videoMeta.height || 1080;
    const videoDuration = videoMeta.duration || 3600;

    // Her nesne için filter string oluştur
    const filters = objectTracks.map((track, index) => {
        const boxes = track.boxes.sort((a, b) => a.time - b.time);
        const box = boxes.length > 0 ? boxes[0].box : { xmin: width * 0.25, ymin: height * 0.25, xmax: width * 0.75, ymax: height * 0.75 };

        const x = Math.round(box.xmin);
        const y = Math.round(box.ymin);
        const w = Math.round(box.xmax - box.xmin);
        const h = Math.round(box.ymax - box.ymin);

        let tStart, tEnd;
        if (scope === 'full') {
            tStart = 0;
            tEnd = videoDuration;
        } else if (scope === 'custom' && customStart !== null && customEnd !== null) {
            tStart = customStart;
            tEnd = customEnd;
        } else {
            tStart = track.startTime;
            tEnd = track.endTime;
        }

        let color;
        if (effectType === 'hide') color = 'black@1';
        else if (effectType === 'box') return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@1:t=5:enable='between(t,${tStart},${tEnd})'`;
        else if (effectType === 'mosaic') color = 'gray@0.8';
        else if (effectType === 'blur') color = 'white@0.5';
        else if (effectType === 'greenscreen') color = '0x00FF00@1';
        else color = 'black@1';

        return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='between(t,${tStart},${tEnd})'`;
    });

    // Tüm filtreleri birleştir
    const filterStr = filters.join(',');

    console.log('=== ÇOKLU EFEKT BİLGİLERİ ===');
    console.log('Nesne Sayısı:', objectTracks.length);
    console.log('Filter String:', filterStr);

    return new Promise((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');

        console.log('=== FFmpeg Başlıyor (Çoklu) ===');
        console.log('Input:', videoPath);
        console.log('Output:', outputPath);

        const cmd = ffmpeg(videoPath)
            .output(outputPath)
            .outputOptions('-vf', filterStr)
            .on('start', (commandLine) => {
                console.log('FFmpeg komutu:', commandLine);
            })
            .on('stderr', (stderrLine) => {
                if (stderrLine.includes('Error') || stderrLine.includes('error')) {
                    console.log('FFmpeg stderr:', stderrLine);
                }
            })
            .on('end', () => {
                console.log('FFmpeg tamamlandı! Çıktı:', outputPath);
                resolve();
            })
            .on('error', (err) => {
                console.error("FFmpeg Error:", err.message);
                reject(err);
            });

        cmd.run();
    });
}


function setupObjectAnalysisHandlers(window) {
    mainWindowRef = window;

    ipcMain.handle('check-ai-model-status', async () => {
        return { downloaded: isModelDownloaded() };
    });

    ipcMain.handle('analyze-scene-objects', async (event, { videoPath, startTime, duration, customLabels }) => {
        try {
            const tracks = await analyzeScene(videoPath, startTime, duration, customLabels);
            return { success: true, tracks };
        } catch (error) {
            console.error(error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('apply-object-effect', async (event, { videoPath, objectTrack, objectTracks, effectType, scope, customStart, customEnd }) => {
        try {
            // Çoklu nesne desteği: objectTracks varsa kullan, yoksa tek objectTrack kullan
            const tracks = objectTracks || [objectTrack];

            const tempOut = path.join(require('os').tmpdir(), `effect_${Date.now()}.mp4`);
            await applyEffectMultiple(videoPath, tempOut, tracks, effectType, scope, customStart, customEnd);
            return { success: true, outputPath: tempOut };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { setupObjectAnalysisHandlers };
