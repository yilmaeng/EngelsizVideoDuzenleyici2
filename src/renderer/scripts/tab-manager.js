/**
 * Sekme Yöneticisi (Tab Manager)
 * Birden fazla video dosyası/proje yönetimi
 */

const TabManager = {
    tabs: [],
    activeTabIndex: -1,
    maxTabs: 10,

    // Global clipboard (sekmeler arası kopyala/yapıştır için)
    clipboard: null,
    clipboardMetadata: null,

    /**
     * Modülü başlat
     */
    init() {
        this.tabs = [];
        this.activeTabIndex = -1;
        this.updateTabBar();
    },

    /**
     * Yeni boş proje oluştur
     * @returns {Object} Oluşturulan sekme
     */
    createNewProject() {
        if (this.tabs.length >= this.maxTabs) {
            Accessibility.alert(`En fazla ${this.maxTabs} sekme açılabilir`);
            return null;
        }

        const tab = {
            id: Utils.generateId(),
            name: 'Yeni Proje',
            filePath: null,
            isNewProject: true,
            timeline: {
                segments: [],
                sourceFile: null,
                totalDuration: 0
            },
            metadata: null, // İlk yapıştırmadan miras alınacak
            hasChanges: false,
            cursorPosition: 0,
            selection: { start: null, end: null },
            markers: []
        };

        this.tabs.push(tab);
        this.switchToTab(this.tabs.length - 1);

        Accessibility.announce('Yeni proje oluşturuldu');
        return tab;
    },

    /**
     * Mevcut dosyadan sekme oluştur
     * @param {string} filePath - Dosya yolu
     * @param {Object} metadata - Video metadata
     * @param {number} duration - Video süresi
     * @returns {Object} Oluşturulan sekme
     */
    async createTabFromFile(filePath, metadata, duration, convertedPath = null) {
        if (this.tabs.length >= this.maxTabs) {
            Accessibility.alert(`En fazla ${this.maxTabs} sekme açılabilir`);
            return null;
        }

        // Aynı dosya zaten açık mı?
        const existingIndex = this.tabs.findIndex(t => t.filePath === filePath);
        if (existingIndex !== -1) {
            await this.switchToTab(existingIndex);
            Accessibility.announce('Bu dosya zaten açık, sekmeye geçildi');
            return this.tabs[existingIndex];
        }

        const tab = {
            id: Utils.generateId(),
            name: metadata.filename || path.basename(filePath),
            filePath: filePath,
            convertedPath: convertedPath,
            isNewProject: false,
            timeline: {
                segments: [{
                    id: Utils.generateId(),
                    start: 0,
                    end: duration,
                    sourceFile: convertedPath || filePath, // Dönüştürülmüş dosya varsa onu kullan
                    sourceStart: 0,
                    sourceEnd: duration
                }],
                sourceFile: convertedPath || filePath, // Dönüştürülmüş dosya varsa onu kullan
                totalDuration: duration
            },
            metadata: metadata,
            hasChanges: false,
            cursorPosition: 0,
            selection: { start: null, end: null },
            markers: []
        };

        this.tabs.push(tab);
        await this.switchToTab(this.tabs.length - 1);

        return tab;
    },

    /**
     * Sekmeye geç
     * @param {number} index - Sekme indeksi
     */
    async switchToTab(index) {
        if (index < 0 || index >= this.tabs.length) {
            return false;
        }

        // Mevcut sekmenin durumunu kaydet
        if (this.activeTabIndex >= 0 && this.activeTabIndex < this.tabs.length) {
            this.saveCurrentTabState();
        }

        this.activeTabIndex = index;
        const tab = this.tabs[index];

        // Yeni sekmenin durumunu yükle
        await this.loadTabState(tab);
        this.updateTabBar();

        const tabNumber = index + 1;
        Accessibility.announce(`Sekme ${tabNumber}: ${tab.name}`);

        return true;
    },

    /**
     * Sonraki sekmeye geç
     */
    async nextTab() {
        if (this.tabs.length <= 1) return;

        const nextIndex = (this.activeTabIndex + 1) % this.tabs.length;
        await this.switchToTab(nextIndex);
    },

    /**
     * Önceki sekmeye geç
     */
    async prevTab() {
        if (this.tabs.length <= 1) return;

        const prevIndex = (this.activeTabIndex - 1 + this.tabs.length) % this.tabs.length;
        await this.switchToTab(prevIndex);
    },

    /**
     * Numaraya göre sekmeye geç (1-10, 0=10)
     * @param {number} num - 1-9 veya 0 (10. sekme için)
     */
    async switchToTabByNumber(num) {
        const index = num === 0 ? 9 : num - 1; // 0 = 10. sekme
        if (index < this.tabs.length) {
            await this.switchToTab(index);
        } else {
            Accessibility.announce(`Sekme ${num} açık değil`);
        }
    },

    /**
     * Aktif sekmeyi kapat
     */
    closeActiveTab() {
        if (this.tabs.length === 0) return;
        this.closeTab(this.activeTabIndex);
    },

    /**
     * Sekmeyi kapat
     * @param {number} index - Sekme indeksi
     */
    closeTab(index) {
        if (index < 0 || index >= this.tabs.length) return;

        const tab = this.tabs[index];

        // Değişiklik varsa uyar
        if (tab.hasChanges) {
            // Bu kısım App.js tarafından handle edilecek
            return { needsSaveConfirm: true, tabIndex: index };
        }

        this.forceCloseTab(index);
        return { needsSaveConfirm: false };
    },

    /**
     * Sekmeyi zorla kapat (kaydetme kontrolü olmadan)
     * @param {number} index - Sekme indeksi
     */
    forceCloseTab(index) {
        const closedTab = this.tabs[index];
        this.tabs.splice(index, 1);

        if (this.tabs.length === 0) {
            this.activeTabIndex = -1;
            // Boş durumu göster
            this.showEmptyState();
        } else if (this.activeTabIndex >= this.tabs.length) {
            this.switchToTab(this.tabs.length - 1);
        } else if (this.activeTabIndex === index) {
            // Aynı indeksteki yeni sekmeyi yükle
            this.switchToTab(this.activeTabIndex);
        }

        this.updateTabBar();
        Accessibility.announce(`${closedTab.name} kapatıldı`);
    },

    /**
     * Mevcut sekmenin durumunu kaydet
     */
    saveCurrentTabState() {
        if (this.activeTabIndex < 0) return;

        const tab = this.tabs[this.activeTabIndex];

        // Timeline durumunu kaydet
        tab.timeline = {
            segments: Timeline.segments.map(s => ({ ...s })),
            sourceFile: Timeline.sourceFile,
            totalDuration: Timeline.getTotalDuration()
        };

        // Cursor ve seçim durumunu kaydet
        tab.cursorPosition = VideoPlayer.getCurrentTime();
        tab.selection = {
            start: Selection.start,
            end: Selection.end
        };

        // İşaretçileri kaydet
        tab.markers = Markers.getAll().map(m => ({ ...m }));

        // Değişiklik durumu
        tab.hasChanges = Timeline.hasChanges;
    },

    /**
     * Sekme durumunu yükle
     * @param {Object} tab - Sekme objesi
     */
    async loadTabState(tab) {
        // Timeline'ı yükle
        Timeline.segments = tab.timeline.segments.map(s => ({ ...s }));
        Timeline.sourceFile = tab.timeline.sourceFile;
        Timeline.hasChanges = tab.hasChanges;

        // Video player'ı güncelle
        if (tab.filePath && !tab.isNewProject) {
            // Mevcut dosya varsa yükle (varsa dönüştürülmüş olanı)
            await VideoPlayer.loadVideoSilent(tab.convertedPath || tab.filePath);
            VideoPlayer.seekTo(tab.cursorPosition);
        } else if (tab.timeline.segments && tab.timeline.segments.length > 0) {
            // Yeni proje ama yapıştırılmış içerik var - ilk segment'in sourceFile'ından yükle
            const firstSegment = tab.timeline.segments[0];
            if (firstSegment && firstSegment.sourceFile) {
                console.log('loadTabState: Yapıştırılmış içerikten video yükleniyor:', firstSegment.sourceFile);
                await VideoPlayer.loadVideoSilent(firstSegment.sourceFile);
                // Kaydedilmiş imleç konumuna git, yoksa ilk segment'in başına
                const targetPosition = tab.cursorPosition || firstSegment.start;
                VideoPlayer.video.currentTime = targetPosition;
                console.log('loadTabState: Video yüklendi, konum:', targetPosition);
            } else {
                // sourceFile yoksa boş göster
                VideoPlayer.showEmptyState();
            }
        } else {
            // Gerçekten boş yeni proje
            VideoPlayer.showEmptyState();
        }

        // Seçimi yükle
        if (tab.selection.start !== null && tab.selection.end !== null) {
            Selection.setSelectionSilent(tab.selection.start, tab.selection.end);
        } else {
            Selection.clear(true);
        }

        // İşaretçileri yükle
        Markers.markers = tab.markers.map(m => ({ ...m }));
        Markers.updateMarkerList();
        Markers.updateMarkerCount();

        // UI'ı güncelle
        this.updateFileInfo(tab);
        App.updateAfterEdit();
    },

    /**
     * Dosya bilgisini güncelle
     * @param {Object} tab - Sekme objesi
     */
    updateFileInfo(tab) {
        const fileNameEl = document.getElementById('file-name');
        if (fileNameEl) {
            fileNameEl.textContent = tab.name + (tab.hasChanges ? ' *' : '');
        }

        const totalDurationEl = document.getElementById('total-duration');
        if (totalDurationEl) {
            const duration = tab.timeline.totalDuration || 0;
            totalDurationEl.textContent = Utils.formatTime(duration);
        }

        // Başlık çubuğunu güncelle
        if (window.api && window.api.setWindowTitle) {
            const title = `${tab.name}${tab.hasChanges ? '*' : ''} - Engelsiz Video Düzenleyicisi`;
            window.api.setWindowTitle(title);
        }
    },

    /**
     * Sekme çubuğunu güncelle
     */
    updateTabBar() {
        const tabBar = document.getElementById('tab-bar');
        if (!tabBar) return;

        tabBar.innerHTML = '';

        if (this.tabs.length === 0) {
            tabBar.style.display = 'none';
            return;
        }

        tabBar.style.display = 'flex';

        this.tabs.forEach((tab, index) => {
            const tabEl = document.createElement('button');
            tabEl.className = 'tab-item' + (index === this.activeTabIndex ? ' active' : '');
            tabEl.setAttribute('role', 'tab');
            tabEl.setAttribute('aria-selected', index === this.activeTabIndex);
            tabEl.setAttribute('tabindex', index === this.activeTabIndex ? '0' : '-1');

            const tabNumber = index + 1;
            const shortcut = tabNumber <= 9 ? `Ctrl+${tabNumber}` : 'Ctrl+0';
            tabEl.setAttribute('aria-label', `Sekme ${tabNumber}: ${tab.name}${tab.hasChanges ? ' (değiştirilmiş)' : ''}, ${shortcut}`);

            // Sekme içeriği
            const nameSpan = document.createElement('span');
            nameSpan.className = 'tab-name';
            nameSpan.textContent = tab.name;
            tabEl.appendChild(nameSpan);

            if (tab.hasChanges) {
                const indicator = document.createElement('span');
                indicator.className = 'tab-modified';
                indicator.textContent = '*';
                indicator.setAttribute('aria-hidden', 'true');
                tabEl.appendChild(indicator);
            }

            // Kapatma butonu
            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close';
            closeBtn.textContent = '×';
            closeBtn.setAttribute('aria-label', 'Sekmeyi kapat');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                App.closeTabWithConfirm(index);
            });
            tabEl.appendChild(closeBtn);

            // Tıklama ile sekme değiştirme
            tabEl.addEventListener('click', () => {
                this.switchToTab(index);
            });

            tabBar.appendChild(tabEl);
        });
    },

    /**
     * Boş durum göster
     */
    showEmptyState() {
        VideoPlayer.unloadVideo();
        Selection.clear(true);
        Markers.clearAll();
        Timeline.segments = [];

        const fileNameEl = document.getElementById('file-name');
        if (fileNameEl) {
            fileNameEl.textContent = 'Dosya açılmadı';
        }

        // Başlığı sıfırla
        if (window.api && window.api.setWindowTitle) {
            window.api.setWindowTitle('Engelsiz Video Düzenleyicisi');
        }

        // Metadata bilgilerini temizle
        const metaRes = document.getElementById('meta-resolution');
        if (metaRes) metaRes.textContent = '-';
        const metaFps = document.getElementById('meta-framerate');
        if (metaFps) metaFps.textContent = '-';
        const metaCodec = document.getElementById('meta-codec');
        if (metaCodec) metaCodec.textContent = '-';
        const metaSize = document.getElementById('meta-size');
        if (metaSize) metaSize.textContent = '-';

        Accessibility.announce('Tüm sekmeler kapatıldı. Yeni dosya açmak için Ctrl+O veya yeni proje için Ctrl+N');
    },

    /**
     * Aktif sekmeyi al
     * @returns {Object|null} Aktif sekme
     */
    getActiveTab() {
        if (this.activeTabIndex < 0 || this.activeTabIndex >= this.tabs.length) {
            return null;
        }
        return this.tabs[this.activeTabIndex];
    },

    /**
     * Global clipboard'a kopyala (sekmeler arası için)
     * @param {Array} segments - Kopyalanacak segmentler
     * @param {Object} metadata - Kaynak video metadata'sı
     */
    copyToClipboard(segments, metadata) {
        this.clipboard = segments.map(s => ({ ...s }));
        this.clipboardMetadata = metadata ? { ...metadata } : null;
    },

    /**
     * Global clipboard'dan yapıştır
     * @returns {Object|null} {segments, metadata}
     */
    getClipboard() {
        if (!this.clipboard || this.clipboard.length === 0) {
            return null;
        }
        return {
            segments: this.clipboard.map(s => ({ ...s })),
            metadata: this.clipboardMetadata ? { ...this.clipboardMetadata } : null
        };
    },

    /**
     * Aktif sekmeyi değiştirilmiş olarak işaretle
     */
    markAsChanged() {
        const tab = this.getActiveTab();
        if (tab) {
            tab.hasChanges = true;
            this.updateTabBar();
            this.updateFileInfo(tab);
        }
    },

    /**
     * Sekme sayısını al
     * @returns {number}
     */
    getTabCount() {
        return this.tabs.length;
    },

    /**
     * Herhangi bir sekme açık mı?
     * @returns {boolean}
     */
    hasOpenTabs() {
        return this.tabs.length > 0;
    }
};

// Global olarak erişilebilir yap
window.TabManager = TabManager;
