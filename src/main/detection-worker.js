const { pipeline, env, RawImage } = require('@xenova/transformers');
const Jimp = require('jimp');
const fs = require('fs');

// Sharp kullanımını devre dışı bırakmayı dene
env.useBrowserCache = false;
env.allowLocalModels = true;

let detector = null;
let modelName = 'Xenova/owlvit-base-patch32';

async function loadModel() {
    if (!detector) {
        process.send({ type: 'status', message: 'Model yükleniyor (OwlViT)...' });
        try {
            detector = await pipeline('zero-shot-object-detection', modelName, {
                quantized: true, // Hız için
                progress_callback: (data) => {
                    if (data.status === 'progress') {
                        process.send({ type: 'status', message: `Yapay Zeka Modeli İndiriliyor: %${Math.round(data.progress)}` });
                    } else if (data.status === 'download') {
                        process.send({ type: 'status', message: 'Model dosyası indiriliyor...' });
                    }
                }
            });
            process.send({ type: 'status', message: 'Model hazır.' });
        } catch (err) {
            process.send({ type: 'error', message: 'Model yükleme hatası: ' + err.message });
        }
    }
}

// Jimp ile resmi RawImage formatına çevir
async function readImage(imagePath) {
    const image = await Jimp.read(imagePath);
    return new RawImage(image.bitmap.data, image.bitmap.width, image.bitmap.height, image.bitmap.data.length / (image.bitmap.width * image.bitmap.height));
}

process.on('message', async (msg) => {
    if (msg.command === 'load') {
        await loadModel();
    } else if (msg.command === 'detect') {
        const { imagePath, candidateLabels, threshold } = msg;

        if (!detector) {
            await loadModel();
        }

        try {
            // Jimp kullanarak resmi oku (saf JS, çökmeyi önler)
            // Transformers.js normalde sharp kullanır ama biz RawImage vereceğiz.
            const rawImage = await readImage(imagePath);

            const results = await detector(rawImage, candidateLabels, {
                threshold: threshold || 0.1
            });

            process.send({ type: 'result', data: results, frameTime: msg.frameTime });
        } catch (err) {
            process.send({ type: 'error', message: 'Tespit hatası: ' + err.message });
        }
    }
});

// Notify ready
process.send({ type: 'ready' });
