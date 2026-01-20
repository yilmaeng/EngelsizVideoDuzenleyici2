document.addEventListener('DOMContentLoaded', () => {
    const dialog = document.getElementById('object-analysis-dialog');
    const startAnalysisBtn = document.getElementById('start-analysis-btn');
    const objectList = document.getElementById('object-list');
    const closeBtn = document.getElementById('object-close-btn');
    const applyBtn = document.getElementById('object-apply-btn');
    const previewBtn = document.getElementById('object-preview-btn');
    const aiLabelBtn = document.getElementById('ai-label-btn');

    const durationSelect = document.getElementById('analysis-duration');
    const actionTypeSelect = document.getElementById('object-action-type');
    const actionScopeSelect = document.getElementById('object-action-scope');
    const customTimeRangeDiv = document.getElementById('custom-time-range');
    const customStartTime = document.getElementById('custom-start-time');
    const customEndTime = document.getElementById('custom-end-time');

    // Display elements
    const detailLabel = document.getElementById('obj-detail-label');
    const detailPos = document.getElementById('obj-detail-pos');
    const detailTime = document.getElementById('obj-detail-time');
    const analysisStatus = document.getElementById('analysis-status-text');

    let currentVideoPath = null;
    let currentCursor = 0.0;

    let analysisResults = []; // [{ id, label, boxes... }]
    let selectedObject = null;
    let selectedObjects = []; // Çoklu seçim için

    // Scope değiştiğinde custom alanı göster/gizle
    if (actionScopeSelect) {
        actionScopeSelect.addEventListener('change', () => {
            if (customTimeRangeDiv) {
                customTimeRangeDiv.style.display = actionScopeSelect.value === 'custom' ? 'block' : 'none';
            }
        });
    }

    // IPC Listeners
    if (window.api) {
        window.api.onShowObjectAnalysisDialog(async () => {
            // Get current state
            // We need video path and cursor position. 
            // We can ask main process or use global variables if available immediately.
            // Better to request fresh data.
            try {
                // Assuming app.js exposes some state or we ask main
                // We'll ask main for current video info via IPC if possible, 
                // but usually renderer has the state in 'video-player'.
                const videoPlayer = document.getElementById('video-player');
                if (videoPlayer && videoPlayer.src) {
                    currentVideoPath = decodeURIComponent(videoPlayer.src.replace('file:///', '').replace('file://', ''));
                    // Fix path on windows
                    if (navigator.userAgent.indexOf("Windows") !== -1 && currentVideoPath.indexOf(':') === 1) {
                        // e.g. C:/...
                        // already correct format usually? 
                        // file:///C:/Users... -> C:/Users...
                    }
                    currentCursor = videoPlayer.currentTime;
                } else {
                    alert('Lütfen önce bir video açın.');
                    return;
                }

                resetDialog();
                dialog.showModal();
                startAnalysisBtn.focus();
            } catch (e) {
                console.error(e);
            }
        });

        window.api.onAnalysisProgress(({ stage, current, total }) => {
            analysisStatus.textContent = `İşleniyor: ${stage} (${current}/${total})`;
        });

        window.api.onAnalysisStatus((msg) => {
            analysisStatus.textContent = msg;
        });

        window.api.onAnalysisError((msg) => {
            analysisStatus.textContent = 'Hata: ' + msg;
            alert('Hata: ' + msg);
        });
    }

    // Handlers
    closeBtn.addEventListener('click', () => dialog.close());

    startAnalysisBtn.addEventListener('click', async () => {
        if (!currentVideoPath) return;

        const duration = parseInt(durationSelect.value);
        let startTime = Math.max(0, currentCursor - (duration / 2));

        // Model indirme kontrolü kaldırıldı (Gemini API kullanılıyor)

        analysisStatus.textContent = 'Analiz başlatılıyor (Gemini)...';
        startAnalysisBtn.disabled = true;

        try {
            const result = await window.api.analyzeSceneObjects({
                videoPath: currentVideoPath,
                startTime: startTime,
                duration: duration
            });

            startAnalysisBtn.disabled = false;

            if (result.success) {
                analysisResults = result.tracks;
                renderObjectList();
                analysisStatus.textContent = `Analiz tamamlandı. ${analysisResults.length} nesne bulundu.`;
                announce(`Analiz tamamlandı. ${analysisResults.length} nesne bulundu. Listede gezinmek için TAB tuşuna basın.`);

                // İlk öğeye odaklanma şansı ver
                setTimeout(() => {
                    const firstItem = objectList.querySelector('li');
                    if (firstItem) firstItem.focus();
                }, 100);
            } else {
                analysisStatus.textContent = 'Hata: ' + result.error;
            }
        } catch (err) {
            startAnalysisBtn.disabled = false;
            analysisStatus.textContent = 'Beklenmeyen hata.';
            console.error(err);
        }
    });

    function renderObjectList() {
        objectList.innerHTML = '';
        if (analysisResults.length === 0) {
            objectList.innerHTML = '<li class="empty-message">Nesne bulunamadı.</li>';
            return;
        }

        analysisResults.forEach((obj, index) => {
            const li = document.createElement('li');
            li.tabIndex = 0; // Focusable
            li.className = 'object-item';
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', 'false');
            li.dataset.index = index;

            // Nice labeling
            const duration = (obj.endTime - obj.startTime).toFixed(1);
            const label = obj.label || 'Bilinmeyen Nesne';
            // Konumu varsa ekle, yoksa 'Belirsiz'
            const position = obj.position || 'Konum Belirsiz';

            // Bounding box boyutunu hesapla (görece boyut)
            let sizeInfo = '';
            if (obj.boxes && obj.boxes[0] && obj.boxes[0].box) {
                const box = obj.boxes[0].box;
                const boxWidth = box.xmax - box.xmin;
                const boxHeight = box.ymax - box.ymin;
                // Yaklaşık alan yüzdesi (1920x1080 varsayımı)
                const areaPercent = ((boxWidth * boxHeight) / (1920 * 1080) * 100).toFixed(1);
                sizeInfo = `, Boyut: %${areaPercent}`;
            }

            const text = `${label}${sizeInfo} (${duration}sn) - Tespit Doğruluğu: %${Math.round(obj.score * 100)}`;

            li.textContent = text;

            // Tıklama ile seçim (Ctrl = çoklu seçim)
            li.addEventListener('click', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    toggleSelectObject(obj);
                } else {
                    selectObject(obj);
                }
                li.focus();
            });

            // Klavye Yönetimi (Erişilebilirlik)
            // S = Seçimi aç/kapa (toggle), A = Tümünü seç
            li.addEventListener('keydown', (e) => {
                if (e.key === 's' || e.key === 'S') {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelectObject(obj);
                } else if (e.key === 'a' || e.key === 'A') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Tümünü seç
                    selectedObjects = [...analysisResults];
                    selectedObject = selectedObjects[selectedObjects.length - 1];
                    updateSelectionVisuals();
                    announce(`Tümü seçildi: ${selectedObjects.length} nesne`);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = li.nextElementSibling;
                    if (next) {
                        next.focus();
                        const idx = parseInt(next.dataset.index);
                        const nextObj = analysisResults[idx];
                        if (nextObj) announce(nextObj.label);
                    }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = li.previousElementSibling;
                    if (prev) {
                        prev.focus();
                        const idx = parseInt(prev.dataset.index);
                        const prevObj = analysisResults[idx];
                        if (prevObj) announce(prevObj.label);
                    }
                }
            });

            // NOT: Odaklanınca otomatik seçim kaldırıldı - kullanıcı oklarla gezebilmeli

            objectList.appendChild(li);
        });

        // İlk elemanı seç ve Tab sırasına sadece onu al
        if (analysisResults.length > 0) {
            selectObject(analysisResults[0]);

            // İlk öğeye odaklanma şansı ver
            setTimeout(() => {
                const first = objectList.querySelector('li');
                if (first) first.focus();
            }, 100);
        }

        // İlk öğeye odaklandığında kullanım talimatı duyur
        const firstItem = objectList.querySelector('li');
        if (firstItem) {
            firstItem.addEventListener('focus', () => {
                announce('Seçmek veya seçimi kaldırmak için S harfine basın.');
            }, { once: true }); // Sadece ilk odaklanmada duyur
        }
    }

    function selectObject(obj) {
        selectedObject = obj;
        selectedObjects = [obj]; // Tek seçim - çoklu seçimi temizle

        // Görsel güncelleme ve TabIndex yönetimi (Roving TabIndex)
        const items = objectList.querySelectorAll('li');
        items.forEach(i => {
            i.classList.remove('selected');
            i.setAttribute('aria-selected', 'false');
            i.tabIndex = -1;
        });

        const index = analysisResults.indexOf(obj);
        const active = objectList.querySelector(`li[data-index="${index}"]`);
        if (active) {
            active.classList.add('selected');
            active.setAttribute('aria-selected', 'true');
            active.tabIndex = 0;
        }

        // Detayları güncelle
        detailLabel.textContent = obj.label || 'Bilinmeyen';
        detailPos.textContent = obj.position || 'Otomatik Takip';
        detailTime.textContent = obj.startTime.toFixed(2) + ' - ' + obj.endTime.toFixed(2);

        applyBtn.disabled = false;
        previewBtn.disabled = false;
        aiLabelBtn.disabled = false;
    }

    function toggleSelectObject(obj) {
        const objIndex = selectedObjects.indexOf(obj);

        if (objIndex === -1) {
            // Ekle
            selectedObjects.push(obj);
        } else {
            // Çıkar
            selectedObjects.splice(objIndex, 1);
        }

        // Son seçilen nesneyi ana seçim olarak ayarla
        selectedObject = selectedObjects.length > 0 ? selectedObjects[selectedObjects.length - 1] : null;

        // Görsel güncelleme
        const items = objectList.querySelectorAll('li');
        items.forEach(i => {
            const idx = parseInt(i.dataset.index);
            const isSelected = selectedObjects.some(o => analysisResults.indexOf(o) === idx);

            if (isSelected) {
                i.classList.add('selected');
                i.setAttribute('aria-selected', 'true');
            } else {
                i.classList.remove('selected');
                i.setAttribute('aria-selected', 'false');
            }
        });

        // Detayları güncelle
        if (selectedObjects.length === 0) {
            detailLabel.textContent = '-';
            detailPos.textContent = '-';
            detailTime.textContent = '-';
            applyBtn.disabled = true;
            previewBtn.disabled = true;
            aiLabelBtn.disabled = true;
        } else if (selectedObjects.length === 1) {
            const obj = selectedObjects[0];
            detailLabel.textContent = obj.label || 'Bilinmeyen';
            detailPos.textContent = obj.position || 'Otomatik Takip';
            detailTime.textContent = obj.startTime.toFixed(2) + ' - ' + obj.endTime.toFixed(2);
            applyBtn.disabled = false;
            previewBtn.disabled = false;
            aiLabelBtn.disabled = false;
        } else {
            // Çoklu seçim
            detailLabel.textContent = `${selectedObjects.length} nesne seçili`;
            detailPos.textContent = 'Çoklu';
            detailTime.textContent = 'Çoklu';
            applyBtn.disabled = false;
            previewBtn.disabled = true; // Önizleme tek nesne için
            aiLabelBtn.disabled = true;
        }

        announce(`${selectedObjects.length} nesne seçili`);
    }

    // Görsel güncelleme yardımcı fonksiyonu (Tümünü Seç için)
    function updateSelectionVisuals() {
        const items = objectList.querySelectorAll('li');
        items.forEach(i => {
            const idx = parseInt(i.dataset.index);
            const isSelected = selectedObjects.some(o => analysisResults.indexOf(o) === idx);

            if (isSelected) {
                i.classList.add('selected');
                i.setAttribute('aria-selected', 'true');
            } else {
                i.classList.remove('selected');
                i.setAttribute('aria-selected', 'false');
            }
        });

        // Detayları güncelle
        if (selectedObjects.length > 0) {
            detailLabel.textContent = `${selectedObjects.length} nesne seçili`;
            detailPos.textContent = 'Çoklu';
            detailTime.textContent = 'Çoklu';
            applyBtn.disabled = false;
            previewBtn.disabled = selectedObjects.length > 1;
            aiLabelBtn.disabled = selectedObjects.length > 1;
        }
    }

    aiLabelBtn.addEventListener('click', async () => {
        if (!selectedObject) return;

        aiLabelBtn.disabled = true;
        aiLabelBtn.textContent = 'Etiketleniyor...';

        try {
            // Get middle frame
            const midTime = (selectedObject.startTime + selectedObject.endTime) / 2;

            // Extract frame and send to Gemini
            const base64 = await window.api.extractFrameBase64({
                videoPath: currentVideoPath,
                time: midTime
            });

            // Ask Gemini
            const apiKey = await window.api.getGeminiApiKey();
            if (!apiKey) {
                alert('Gemini API anahtarı bulunamadı.');
                aiLabelBtn.disabled = false;
                aiLabelBtn.textContent = 'Yapay Zeka ile Etiketle';
                return;
            }

            const prompt = `Bu görseldeki ${selectedObject.label} nesnesini (muhtemelen bounding box içindeki) kısaca tanımla (max 5 kelime, Türkçe). Örnek: 'Sarı ceketli adam', 'Coca-Cola logosu'.`;

            const response = await window.api.geminiVisionRequest({
                apiKey,
                model: 'gemini-2.5-flash',
                imageBase64: base64,
                prompt
            });

            if (response.success) {
                const newLabel = response.text.trim();
                selectedObject.label = newLabel;
                renderObjectList(); // Refresh list to show new label
                detailLabel.textContent = newLabel;
                announce(`Nesne etiketlendi: ${newLabel}`);
            } else {
                alert('Etiketleme başarısız: ' + response.error);
            }
        } catch (err) {
            console.error(err);
            alert('Hata oluştu.');
        } finally {
            aiLabelBtn.disabled = false;
            aiLabelBtn.textContent = 'Yapay Zeka ile Etiketle (Gemini)';
        }
    });

    applyBtn.addEventListener('click', async () => {
        if (selectedObjects.length === 0) return;

        applyBtn.disabled = true;
        applyBtn.textContent = `Uygulanıyor (${selectedObjects.length} nesne)...`;

        try {
            const effectType = actionTypeSelect.value;
            const scope = actionScopeSelect.value; // 'track', 'full', 'custom'

            // Custom zaman aralığı için değerleri al
            let customStart = null;
            let customEnd = null;
            if (scope === 'custom' && customStartTime && customEndTime) {
                customStart = parseFloat(customStartTime.value) || 0;
                customEnd = parseFloat(customEndTime.value) || 10;
            }

            const result = await window.api.applyObjectEffect({
                videoPath: currentVideoPath,
                objectTracks: selectedObjects, // Çoklu nesne desteği
                objectTrack: selectedObjects[0], // Geriye dönük uyumluluk
                effectType: effectType,
                scope: scope,
                customStart: customStart,
                customEnd: customEnd
            });

            if (result.success) {
                // alert('Efekt başarıyla uygulandı! Dosya: ' + result.outputPath + '\n(Not: Asıl projeye eklemek için bu dosyayı içe aktarmalısınız.)');

                // Otomatik olarak projeye ekle
                if (window.App && window.App.openFile) {
                    announce("Efekt uygulandı. İşlenmiş video yeni sekmede açılıyor...");

                    // Biraz gecikmeli çağır ki dialog kapansın/kullanıcı anlasın
                    dialog.close();

                    // Open file in new tab
                    window.App.openFile(result.outputPath);

                    // Kullanıcıya bilgi ver
                    setTimeout(() => {
                        announce(`İşlenmiş video yeni sekmede açıldı. Bu dosya geçicidir, saklamak için 'Farklı Kaydet' yapın.`);
                    }, 1000);

                } else {
                    alert('Efekt uygulandı ancak otomatik eklenemedi.\nDosya: ' + result.outputPath);
                }
            } else {
                alert('Hata: ' + result.error);
            }
        } catch (err) {
            console.error(err);
            alert('Genel Hata');
        } finally {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Videoya Uygula';
        }
    });

    previewBtn.addEventListener('click', async () => {
        if (!selectedObject) return;

        const videoPlayer = document.getElementById('video-player');
        if (!videoPlayer) return;

        // Efekt adını al
        const effectSelect = document.getElementById('object-action-type');
        const effectType = effectSelect.value;
        const effectName = effectSelect.options[effectSelect.selectedIndex].text;

        previewBtn.disabled = true;
        previewBtn.textContent = 'Kontrol ediliyor...';

        announce(`'${selectedObject.label}' nesnesi için '${effectName}' efekti kontrol ediliyor. Lütfen bekleyin...`);

        try {
            // Nesnenin orta zamanına git
            const midTime = (selectedObject.startTime + selectedObject.endTime) / 2;

            // Kareyi çıkar
            const base64 = await window.api.extractFrameBase64({
                videoPath: currentVideoPath,
                time: midTime
            });

            // Gemini API anahtarını al
            const apiKey = await window.api.getGeminiApiKey();
            if (!apiKey) {
                announce('Gemini API anahtarı bulunamadı. Önizleme yapılamıyor.');
                return;
            }

            // Konum bilgisini al
            const position = selectedObject.position || 'Merkez';

            // Gemini'ye sor
            const prompt = `Bu video karesini analiz et ve şu soruyu cevapla:

1. "${selectedObject.label}" adlı nesne bu karede görünüyor mu?
2. Bu nesne "${position}" konumunda mı?
3. Eğer bu nesnenin üzerine (nesnenin gerçek boyutuna ve konumuna göre) bir ${effectName} efekti (örn: siyah kutu, bulanıklık) uygulansaydı, nesneyi tamamen veya büyük ölçüde kapsar mıydı?

SADECE şu formatta yanıt ver (Türkçe):
Nesne Görünür: [Evet/Hayır]
Konum Doğru: [Evet/Hayır/Kısmen]
Efekt Kapsama: [Tam/Büyük Ölçüde/Kısmen/Kapsamaz]
Özet: [1 cümlelik açıklama]`;

            const response = await window.api.geminiVisionRequest({
                apiKey,
                model: 'gemini-2.5-flash',
                imageBase64: base64,
                prompt
            });

            if (response.success) {
                const result = response.text.trim();

                // Önce ekran okuyucuya duyur
                announce(`Önizleme Sonucu: ${result}`);

                // Sonra alert göster (200ms gecikmeyle ekran okuyucu okusun)
                setTimeout(() => {
                    if (window.Accessibility && window.Accessibility.alert) {
                        window.Accessibility.alert(`Önizleme Sonucu:\n\n${result}`);
                    } else {
                        alert(`Önizleme Sonucu:\n\n${result}`);
                    }
                }, 200);
            } else {
                const errorMsg = 'Önizleme hatası: ' + response.error;
                announce(errorMsg);
                setTimeout(() => {
                    if (window.Accessibility && window.Accessibility.alert) {
                        window.Accessibility.alert(errorMsg);
                    } else {
                        alert(errorMsg);
                    }
                }, 200);
            }
        } catch (err) {
            console.error(err);
            const errorMsg = 'Önizleme sırasında hata: ' + (err.message || 'Bilinmeyen hata');
            announce(errorMsg);
            setTimeout(() => {
                if (window.Accessibility && window.Accessibility.alert) {
                    window.Accessibility.alert(errorMsg);
                } else {
                    alert(errorMsg);
                }
            }, 200);
        } finally {
            previewBtn.disabled = false;
            previewBtn.textContent = 'Önizle (AI Kontrol)';
        }
    });

    function resetDialog() {
        analysisResults = [];
        selectedObject = null;
        objectList.innerHTML = '<li class="empty-message">Henüz analiz yapılmadı.</li>';
        startAnalysisBtn.disabled = false;
        applyBtn.disabled = true;
        previewBtn.disabled = true;
        aiLabelBtn.disabled = true;
        detailLabel.textContent = '-';
        analysisStatus.textContent = 'Hazır';
    }

    function announce(msg) {
        const announcer = document.getElementById('screen-reader-announcer');
        if (announcer) {
            announcer.textContent = '';
            // Force redraw/re-announce
            requestAnimationFrame(() => {
                announcer.textContent = msg;
            });
        }
    }

    function resetAnnouncer() {
        const announcer = document.getElementById('screen-reader-announcer');
        if (announcer) announcer.textContent = '';
    }
});
