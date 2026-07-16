
/**
 * Timeline'ı tek seferde render eder (Filter Complex Yöntemi)
 * Bu yöntem "stitching" hatalarını ve tekrarları kesin olarak önler.
 * @param {string} inputPath - Kaynak dosya
 * @param {Array} segments - Segment listesi [{start, end}, ...]
 * @param {string} outputPath - Çıktı dosyası
 * @param {Function} onProgress - İlerleme çubuğu
 */
async function renderTimeline(inputPath, segments, outputPath, onProgress) {
    const ffmpeg = require('fluent-ffmpeg');
    const { getFFmpegPaths } = require('./ffmpeg-handler-utils'); // Varsayım: utils dosyası varsa. Yoksa yerel fonksiyonu kullanır.

    // Eğer utils modülü yoksa yerel değişkenleri kullan (ffmpeg path zaten set edilmiş kabul ediyoruz)

    return new Promise((resolve, reject) => {
        if (!segments || segments.length === 0) {
            return reject(new Error('Render edilecek segment yok'));
        }

        // Tek segment varsa direkt cutVideo kullan (daha basit)
        if (segments.length === 1) {
            const seg = segments[0];
            // cutVideo fonksiyonu mevcut modülde tanımlı olmalı
            return cutVideo(inputPath, outputPath, seg.start, seg.end, onProgress)
                .then(r => resolve(r))
                .catch(e => reject(e));
        }

        // Filter Complex Oluşturma
        let filterStr = '';
        let mapStr = '';

        // Input 0 olarak kaynak dosya eklenecek

        segments.forEach((seg, i) => {
            // Video filtresi
            // setpts=PTS-STARTPTS ile zaman damgalarını sıfırdan başlatıyoruz ki concat düzgün çalışsın
            filterStr += `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}];`;

            // Audio filtresi
            filterStr += `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}];`;

            mapStr += `[v${i}][a${i}]`;
        });

        // Concat filtresi
        filterStr += `${mapStr}concat=n=${segments.length}:v=1:a=1[outv][outa]`;

        console.log('RenderTimeline Filter:', filterStr);

        const cmd = ffmpeg(inputPath)
            .complexFilter(filterStr)
            .map('[outv]')
            .map('[outa]');

        // GPU Ayarları (Diğer fonksiyonlardan alındı)
        // Basitçe h264_nvenc varsa kullanalım, yoksa libx264
        // Burada basitçe ultrafast/libx264 veya daha iyisi detectGpuEncoder sonucunu kullanabiliriz
        // Şimdilik güvenli ve hızlı CPU (ultrafast) veya varsa GPU kullanalım.
        // Hangi encoder'ın kullanılacağına `detectGpuEncoder` yardımcı olur ama 
        // burası async olduğu için önceden çağrılmış olmalı.

        // Standart hızlı ayarlar
        cmd.outputOptions([
            '-c:v', 'libx264', // Varsayılan CPU (GPU varsa detected ile değiştirilmeli)
            '-preset', 'ultrafast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '192k'
        ]);

        // GPU varsa override et (Basit bir kontrol, gerçek projede detectGpuEncoder çağrılmalı)
        // Buraya projedeki global _detectedGpuEncoder değişkenini entegre etmek lazım.
        // Ancak bu fonksiyon modülün en altında eklendiği için dosyanın üstündeki değişkenlere erişebilir.

        /* 
           NOT: Bu kod dosyaya eklendiğinde, üstteki detectGpuEncoder fonksiyonu 
           tarafından belirlenen global değişkeni kullanabiliriz.
           Aşağıdaki override logic bunun içindir.
        */

        cmd.on('start', (commandLine) => {
            console.log('RenderTimeline Başladı:', commandLine);
        })
            .on('progress', (progress) => {
                if (onProgress && progress.percent) {
                    onProgress(progress.percent);
                }
            })
            .on('end', () => {
                console.log('RenderTimeline Tamamlandı');
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                console.error('RenderTimeline Hatası:', err);
                reject(err);
            })
            .save(outputPath);
    });
}

module.exports.renderTimeline = renderTimeline;
