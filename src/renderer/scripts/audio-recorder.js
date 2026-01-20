/**
 * Audio Recorder Module
 * Handles recording, previewing, and basic editing of audio
 */

const AudioRecorder = {
    dialog: null,
    mediaRecorder: null,
    audioChunks: [],
    currentBlob: null,
    tempFilePath: null,
    stream: null,

    // UI Elements
    recordBtn: null,
    stopBtn: null,
    resetBtn: null,
    previewBtn: null,
    nextBtn: null,

    // Player
    player: null,

    // State
    isRecording: false,
    isPaused: false,
    markers: [],

    init() {
        this.dialog = document.getElementById('audio-recorder-dialog');
        this.player = document.getElementById('recorder-preview-player');
        this.setupEventListeners();
    },

    resetState() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.currentBlob = null;
        this.tempFilePath = null;
        this.isRecording = false;
        this.isPaused = false;
        this.markers = [];

        if (this.player) {
            this.player.pause();
            this.player.src = '';
            this.player.removeAttribute('src'); // Clean up
        }

        this.updateUI('initial');
        this.updateTimer('00:00');

        document.getElementById('recorder-status').textContent = 'Kayıt Bekleniyor';
        document.getElementById('recorder-markers-info').textContent = '0 İşaretçi';
    },

    async initDevices() {
        try {
            // İzin iste (cihazları listelemek için gerekebilir)
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(device => device.kind === 'audioinput');
            const select = document.getElementById('rec-mic-select');

            // Mevcut seçimi koru
            const currentVal = select.value;
            select.innerHTML = '';

            audioInputs.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Mikrofon ${index + 1}`;
                select.appendChild(option);
            });

            // Smarter default selection
            let bestDeviceId = 'default';

            // 1. Önce 'default' cihazı bul
            const defaultDevice = audioInputs.find(d => d.deviceId === 'default');

            // 2. Eğer default cihaz Stereo Mix/Karıştırıcı ise ve başka seçenek varsa, değiştirmeyi dene
            if (defaultDevice && (defaultDevice.label.toLowerCase().includes('mix') || defaultDevice.label.toLowerCase().includes('karıştırıcı'))) {
                const micDevice = audioInputs.find(d =>
                    d.deviceId !== 'default' &&
                    (d.label.toLowerCase().includes('microphone') || d.label.toLowerCase().includes('mikrofon'))
                );
                if (micDevice) {
                    bestDeviceId = micDevice.deviceId;
                }
            }

            // 3. Hiçbiri yoksa ilk cihaz
            if (!audioInputs.some(d => d.deviceId === bestDeviceId) && audioInputs.length > 0) {
                bestDeviceId = audioInputs[0].deviceId;
            }

            if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
                select.value = currentVal;
            } else {
                select.value = bestDeviceId;
            }

            return true;
        } catch (err) {
            console.error('Microphone init error:', err);
            return false;
        }
    },

    async showDialog() {
        if (!this.dialog) this.init(); // Initialize if not already done

        const permitted = await this.initDevices();
        if (!permitted) {
            Accessibility.alert('Mikrofon erişim izni verilemedi veya mikrofon bulunamadı.');
            return;
        }

        this.resetState();
        this.dialog.showModal();

        // Odaklanma: Mikrofon seçimine odaklan
        const select = document.getElementById('rec-mic-select');
        if (select) {
            select.focus();
        } else {
            this.dialog.focus();
        }

        // Mikrofon seçildiyse onu duyur
        const micName = select.options[select.selectedIndex]?.text || 'Varsayılan';
        Accessibility.announce(`Ses kayıt penceresi açıldı. Aktif mikrofon: ${micName}. Kayıt için R, durdurmak için S tuşuna basın.`);
    },

    /**
     * Start or Resume Recording
     */
    async toggleRecording() {
        if (!this.isRecording) {
            // Start new recording
            try {
                // Kayıt öncesi BİP sesi (İnce)
                await this.playBeep(880, 0.3);

                const select = document.getElementById('rec-mic-select');
                const deviceId = select.value;
                const constraints = {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true // SES GÜRLÜĞÜ İÇİN TEKRAR AÇILDI
                    }
                };

                if (deviceId) {
                    constraints.audio.deviceId = { exact: deviceId };
                }

                this.stream = await navigator.mediaDevices.getUserMedia(constraints);
                // MimeType kontrolü
                let options = { mimeType: 'audio/webm' };
                if (!MediaRecorder.isTypeSupported('audio/webm')) {
                    console.warn('audio/webm desteklenmiyor, varsayılan format kullanılacak.');
                    options = {}; // Browser default
                }

                this.mediaRecorder = new MediaRecorder(this.stream, options);

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        this.audioChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = async () => {
                    // Check if valid data
                    if (this.audioChunks.length === 0) {
                        console.error('Kayıt verisi boş!');
                        Accessibility.alert('Kayıt yapılamadı: Veri boş.');
                        return;
                    }

                    // Blob oluştur
                    // mime type recorder'dan al
                    const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
                    const blob = new Blob(this.audioChunks, { type: mimeType });
                    this.currentBlob = blob;
                    this.audioChunks = []; // Clear for next time

                    // Temp dosyaya kaydet (Main process üzerinden)
                    await this.saveBlobToTemp();

                    // Player'a yükle
                    if (this.tempFilePath) {
                        this.player.src = this.tempFilePath;
                        this.updateUI('recorded');
                        Accessibility.announce('Kayıt tamamlandı. Dinlemek için K tuşuna basın.');
                    }

                    // Stream'i kapat
                    if (this.stream) {
                        this.stream.getTracks().forEach(track => track.stop());
                        this.stream = null;
                    }
                };

                this.mediaRecorder.start(100); // 100ms chunks
                this.isRecording = true;
                this.isPaused = false;
                this.startTime = Date.now();
                this.timerInterval = setInterval(() => this.updateRecordingTimer(), 100);

                this.updateUI('recording');
                // Accessibility.announce('Kayıt başladı.'); // Kaldırıldı: Kayda ses karışmaması için

            } catch (err) {
                console.error('Recording start error:', err);
                Accessibility.alert('Kayıt başlatılamadı: ' + err.message);
            }
        } else {
            // Pause / Resume
            if (this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.pause();
                this.isPaused = true;
                clearInterval(this.timerInterval);
                document.getElementById('recorder-status').textContent = 'Duraklatıldı (Devam için R)';
                Accessibility.announce('Kayıt duraklatıldı.');
            } else if (this.mediaRecorder.state === 'paused') {
                this.mediaRecorder.resume();
                this.isPaused = false;
                this.startTime = Date.now() - (this.elapsedTime || 0); // Adjust time
                this.timerInterval = setInterval(() => this.updateRecordingTimer(), 100);
                document.getElementById('recorder-status').textContent = 'Kaydediliyor...';
                Accessibility.announce('Kayıt devam ediyor.');
            }
        }
    },

    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            clearInterval(this.timerInterval);
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.isPaused = false;
            document.getElementById('recorder-status').textContent = 'İşleniyor...';

            // Kayıt bitiş BİP sesi (Kalın)
            this.playBeep(440, 0.4);
        }
    },

    async saveBlobToTemp() {
        if (!this.currentBlob) return;

        try {
            const arrayBuffer = await this.currentBlob.arrayBuffer();
            const buffer = new Uint8Array(arrayBuffer); // Convert to TypedArray for IPC

            // IPC ile main process'e gönderip dosyaya yazdır
            const result = await window.api.saveTempRecording(buffer);
            if (result.success) {
                this.tempFilePath = result.audioPath; // .wav olarak dönüyor (ffmpeg convert sonrası)
                console.log('Temp recording saved:', this.tempFilePath);
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            console.error('Save temp error:', err);
            Accessibility.alert('Kayıt dosyası oluşturulamadı: ' + err.message);
            // UI'ı resetle ki kullanıcı tekrar deneyebilsin
            this.updateUI('initial');
            document.getElementById('recorder-status').textContent = 'Hata Oluştu';
        }
    },

    updateRecordingTimer() {
        if (!this.isRecording || this.isPaused) return;
        const now = Date.now();
        this.elapsedTime = now - this.startTime;
        const secs = Math.floor(this.elapsedTime / 1000);
        this.updateTimer(Utils.formatTime(secs)); // Utils.formatTime needs seconds
    },

    updateTimer(timeStr) {
        document.getElementById('recorder-timer').textContent = timeStr;
    },

    updateUI(state) {
        const recBtn = document.getElementById('rec-record-btn');
        const stopBtn = document.getElementById('rec-stop-btn');
        const playBtn = document.getElementById('rec-play-btn'); // Preview btn
        const editBtn = document.getElementById('rec-edit-btn');
        const resetBtn = document.getElementById('rec-reset-btn');
        const nextBtn = document.getElementById('rec-next-btn');

        switch (state) {
            case 'initial': // Boş
                recBtn.disabled = false;
                recBtn.textContent = 'Kaydet (R)';
                recBtn.classList.remove('recording', 'paused');
                stopBtn.disabled = true;
                playBtn.disabled = true;
                editBtn.disabled = true;
                resetBtn.disabled = true;
                nextBtn.disabled = true;
                break;
            case 'recording': // Kayıt sürüyor
                recBtn.textContent = 'Duraklat (R)';
                recBtn.classList.add('recording');
                recBtn.classList.remove('paused');
                stopBtn.disabled = false;
                playBtn.disabled = true;
                editBtn.disabled = true;
                resetBtn.disabled = true; // Kayıt sırasında reset disable
                nextBtn.disabled = true;
                break;
            case 'recorded': // Kayıt bitti, dosya var
                recBtn.textContent = 'Yeniden Kaydet (R)'; // Overwrite logic handles "New Record"
                recBtn.classList.remove('recording', 'paused');
                stopBtn.disabled = true;
                playBtn.disabled = false;
                editBtn.disabled = false;
                resetBtn.disabled = false;
                nextBtn.disabled = false;
                document.getElementById('recorder-status').textContent = 'Kayıt Hazır';
                break;
        }
    },

    // --- Player Logic ---
    togglePreview() {
        if (!this.tempFilePath) return;

        if (this.player.paused) {
            this.player.play();
            Accessibility.announce('Oynatılıyor');
        } else {
            this.player.pause();
            Accessibility.announce('Duraklatıldı');
        }
    },

    seekPreview(seconds) {
        if (!this.player || !this.player.duration) return;
        this.player.currentTime = Math.min(Math.max(0, this.player.currentTime + seconds), this.player.duration);
        Accessibility.announce(`Konum: ${Utils.formatTime(this.player.currentTime)}`);
    },

    stopPreview() {
        if (!this.player) return;
        this.player.pause();
        this.player.currentTime = 0;
        Accessibility.announce('Durduruldu, başa dönüldü.');
    },

    addMarker() {
        if (!this.tempFilePath) return;

        const time = this.player.currentTime;
        this.markers.push(time);
        // Sadece son 2 markeri tut (Aralık seçimi için)
        if (this.markers.length > 2) {
            this.markers.shift(); // En eskiy sil
        }

        this.updateMarkerInfo();
        Accessibility.announce(`İşaretçi eklendi: ${Utils.formatTime(time)}`);
    },

    updateMarkerInfo() {
        const count = this.markers.length;
        let text = `${count} İşaretçi`;
        if (count === 2) {
            const start = Math.min(this.markers[0], this.markers[1]);
            const end = Math.max(this.markers[0], this.markers[1]);
            const dur = end - start;
            text += ` (Seçili Alan: ${dur.toFixed(1)} sn)`;
        }
        document.getElementById('recorder-markers-info').textContent = text;
    },

    // --- Editing Logic ---
    showContextMenu() {
        // Basit bir custom menu veya Electron context menu
        // Renderer'dan main'e "show-context-menu" gönderilir
        const menuTemplate = [
            { label: 'Seçili Bölgeyi Sil (İki işaretçi arası)', click: 'rec-delete-selected', id: 'del-sel' },
            { label: 'Konumdan Başa Kadar Sil', click: 'rec-delete-start', id: 'del-start' },
            { label: 'Konumdan Sona Kadar Sil', click: 'rec-delete-end', id: 'del-end' }
        ];

        window.api.send('show-context-menu', menuTemplate);
    },

    async handleEditCommand(command) {
        if (!this.tempFilePath) {
            Accessibility.alert('Düzenlenecek kayıt yok.');
            return;
        }

        const duration = this.player.duration;
        const current = this.player.currentTime;

        let regionsToRemove = []; // [{start, end}]

        if (command === 'rec-delete-selected') {
            if (this.markers.length < 2) {
                Accessibility.alert('Seçili bölge yok. Lütfen M harfi ile oynarken iki işaretçi koyun.');
                return;
            }
            const m1 = this.markers[0];
            const m2 = this.markers[1];
            regionsToRemove.push({ start: Math.min(m1, m2), end: Math.max(m1, m2) });
        }
        else if (command === 'rec-delete-start') {
            regionsToRemove.push({ start: 0, end: current });
        }
        else if (command === 'rec-delete-end') {
            regionsToRemove.push({ start: current, end: duration });
        }

        if (regionsToRemove.length === 0) return;

        // İşleme başlıyor
        document.getElementById('recorder-status').textContent = 'Düzenleniyor...';

        try {
            // Main process'e ffmpeg ile kesme işlemini yolla
            // cut-video-complex gibi bir handler gerekebilir veya mevcut handler'ları kombine edebiliriz.
            // Aslında "Remove Region" işlemi biraz tricky. 
            // Şöyle yapabiliriz: Kalan parçaları belirleyip concat et.

            const removeStart = regionsToRemove[0].start;
            const removeEnd = regionsToRemove[0].end;

            // Eğer "Seçimi Sil" ise -> [0...removeStart] + [removeEnd...duration]
            // Eğer "Başı sil" ise -> [removeEnd...duration] (removeStart=0)
            // Eğer "Sonu sil" ise -> [0...removeStart] (removeEnd=duration)

            const parts = [];

            // Parça 1 (Silinenin öncesi)
            if (removeStart > 0.1) {
                parts.push({ start: 0, end: removeStart });
            }

            // Parça 2 (Silinenin sonrası)
            if (removeEnd < duration - 0.1) {
                parts.push({ start: removeEnd, end: duration });
            }

            if (parts.length === 0) {
                Accessibility.alert('Tüm ses silinemez. Sıfırlamayı kullanın.');
                return;
            }

            // 1. Geçici dosyaları oluştur (cut)
            const tempFiles = [];
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                console.log(`Cutting part ${i}: ${p.start} -> ${p.end}`);

                const out = await window.api.getTempPath(`rec_part_${i}_${Date.now()}.wav`);

                // cut-video handler'ı ses dosyaları için de (ffmpeg) çalışır
                // Ancak duration kontrolü yapalım
                if (p.end <= p.start) continue;

                // WAV için cutVideo bazen sorun çıkarabilir, extractAudio daha mantıklı olabilir ama parametreleri farklı.
                // cutVideo parametreleri: input, output, start, end.
                const result = await window.api.cutVideo({
                    inputPath: this.tempFilePath,
                    outputPath: out,
                    startTime: p.start,
                    endTime: p.end
                });

                if (!result.success) {
                    throw new Error(`Cut failed for part ${i}: ${result.error}`);
                }

                tempFiles.push(out);
            }

            // 2. Birleştir (concat)
            let newFilePath = this.tempFilePath; // Fallback
            if (tempFiles.length === 1) {
                newFilePath = tempFiles[0];
            } else if (tempFiles.length > 1) {
                const concatOut = await window.api.getTempPath(`rec_edited_${Date.now()}.wav`);
                // concatVideos parametresi { inputPaths, outputPath }
                const concatResult = await window.api.concatVideos({
                    inputPaths: tempFiles,
                    outputPath: concatOut
                });
                if (!concatResult.success) {
                    throw new Error(`Concat failed: ${concatResult.error}`);
                }
                newFilePath = concatOut;
            } else {
                throw new Error("No parts to keep!");
            }

            // UI Güncelle
            this.tempFilePath = newFilePath;
            this.player.src = this.tempFilePath;
            this.player.load(); // Explicit load
            this.markers = []; // Markerları sıfırla
            this.updateMarkerInfo();
            Accessibility.announce('Düzenleme tamamlandı.');
            document.getElementById('recorder-status').textContent = 'Düzenlendi';

        } catch (err) {
            console.error('Edit error:', err);
            Accessibility.alert('Düzenleme hatası: ' + err.message);
        }
    },

    // --- Finalize ---
    onNext() {
        if (!this.tempFilePath) return;

        // Önce dinlemeyi durdur
        this.stopPreview();

        // 1. Dialogu kapat
        this.dialog.close();

        // 2. Mevcut "Ses Ekle" akışına yönlendir
        // Diyalogu kapatıp diğerini açmak için timeout
        setTimeout(() => {
            Dialogs.showAudioAddDialog(this.tempFilePath);
        }, 100);
    },

    // --- Events ---
    setupEventListeners() {
        // Buttons
        document.getElementById('rec-record-btn').addEventListener('click', () => this.toggleRecording());
        document.getElementById('rec-stop-btn').addEventListener('click', () => this.stopRecording());
        document.getElementById('rec-play-btn').addEventListener('click', () => this.togglePreview());
        // Edit Button Listener
        const editBtn = document.getElementById('rec-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => this.showContextMenu());
        }

        document.getElementById('rec-reset-btn').addEventListener('click', () => {
            this.stopRecording();
            this.resetState();
            Accessibility.announce('Kayıt silindi.');
            document.getElementById('rec-record-btn').focus();
        });
        document.getElementById('rec-cancel-btn').addEventListener('click', () => {
            this.stopRecording();
            this.dialog.close();
        });
        document.getElementById('rec-next-btn').addEventListener('click', () => this.onNext());

        // Context Menu Listener from Main
        window.api.onContextMenuCommand((data) => {
            if (['rec-delete-selected', 'rec-delete-start', 'rec-delete-end'].includes(data.action)) {
                this.handleEditCommand(data.action);
            }
        });

        // Keyboard Shortcuts (Dialog Specific)
        this.dialog.addEventListener('keydown', (e) => {
            // R: Record/Pause
            if (e.key.toLowerCase() === 'r') {
                e.preventDefault();
                this.toggleRecording();
            }

            // S: Stop (if recording) or Stop Playback (if playing)
            if (e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (this.isRecording) {
                    this.stopRecording();
                } else {
                    this.stopPreview(); // Player stop
                }
            }

            // Alt+P: KALDIRILDI - Audio Add Dialog ile çakışıyor
            // Bunun yerine K tuşunu kullanın (aşağıda)

            // J: Rewind
            if (e.key.toLowerCase() === 'j') {
                e.preventDefault();
                this.seekPreview(-5);
            }

            // K: Pause/Play (Toggle) - BU TUŞU KULLANIN
            if (e.key.toLowerCase() === 'k') {
                e.preventDefault();
                this.togglePreview();
            }

            // L: Forward
            if (e.key.toLowerCase() === 'l') {
                e.preventDefault();
                this.seekPreview(5);
            }

            // M: Marker
            if (e.key.toLowerCase() === 'm') {
                e.preventDefault();
                this.addMarker();
            }

            // Context Menu (Right Arrow or App Key)
            if (e.key === 'ArrowRight' || e.key === 'ContextMenu') {
                // Sadece player odaklı değilken veya genel navigasyon dışında 
                // Kullanıcı isteği: "sağ oka veya uygulama tuşuna basarsa"
                // Sağ ok normalde navigasyon için kullanılır (butonlar arası).
                // Bunu sadece oynatma durumunda mı yoksa her zaman mı yapalım?
                // Kullanıcı isteğine sadık kalalım ama buton navigasyonunu bozmamaya dikkat.
                // Eğer odak bir input/buton üzerindeyse ArrowRight'ı engellemek sorun olabilir.
                // Ancak bu dialogda slider yok, sadece butonlar var.
                // "Uygulama Tuşu" (ContextMenu) en güvenlisi.
                // Sağ Ok için Shift+Right diyelim mi? Yoksa direkt Right mı?
                // Kullanıcı "sağ oka basarsa" dedi.

                if (e.key === 'ContextMenu' || (e.key === 'ArrowRight' && !document.activeElement.matches('button'))) {
                    e.preventDefault();
                    this.showContextMenu();
                }
            }
        });
    },

    /**
     * Bip sesi çal
     * @param {number} frequency - Frekans (Hz)
     * @param {number} duration - Süre (saniye)
     */
    playBeep(frequency, duration) {
        return new Promise(resolve => {
            try {
                const context = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = context.createOscillator();
                const gain = context.createGain();

                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(frequency, context.currentTime);

                gain.gain.setValueAtTime(0.2, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + duration);

                oscillator.connect(gain);
                gain.connect(context.destination);

                oscillator.start();
                oscillator.stop(context.currentTime + duration);

                oscillator.onended = () => {
                    context.close();
                    resolve();
                };
            } catch (e) {
                console.error('Beep error:', e);
                resolve();
            }
        });
    }
};

window.AudioRecorder = AudioRecorder;
