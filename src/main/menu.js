const { Menu, dialog, shell } = require('electron');
const path = require('path');

// Son açılan dosyalar listesi
let recentFiles = [];
const MAX_RECENT_FILES = 10;

function addToRecentFiles(filePath) {
    recentFiles = recentFiles.filter(f => f !== filePath);
    recentFiles.unshift(filePath);
    if (recentFiles.length > MAX_RECENT_FILES) {
        recentFiles = recentFiles.slice(0, MAX_RECENT_FILES);
    }
}

function createMenu(mainWindow) {
    const template = [
        // DOSYA MENÜSÜ
        {
            label: '&Dosya (Alt+D)',
            submenu: [
                {
                    label: 'Yeni Slayt Projesi... (Ctrl+Shift+N)',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => {
                        const { openNewProjectDialog } = require('./slideshow-handler');
                        openNewProjectDialog(mainWindow);
                    }
                },
                {
                    label: 'Proje Aç... (Ctrl+Shift+O)',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            title: 'Proje Aç',
                            filters: [
                                { name: 'Tüm Projeler', extensions: ['kve', 'eng'] },
                                { name: 'Video Projesi', extensions: ['kve'] },
                                { name: 'Slayt Projesi', extensions: ['eng'] }
                            ],
                            properties: ['openFile']
                        });

                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            const ext = path.extname(filePath).toLowerCase();

                            if (ext === '.eng') {
                                const { openProjectFile } = require('./slideshow-handler');
                                // openProjectFile might expect to open dialog itself if no arg. 
                                // We will modify it or call a specific loader if available.
                                // For now, let's pass the path and ensure handler supports it.
                                openProjectFile(mainWindow, filePath);
                            } else {
                                // .kve dosyasını renderer'a gönder
                                mainWindow.webContents.send('project-open-file', filePath);
                            }
                        }
                    }
                },
                {
                    label: 'Projeyi Kaydet (.kve)... (Ctrl+Shift+P)',
                    accelerator: 'CmdOrCtrl+Shift+P',
                    click: () => {
                        mainWindow.webContents.send('project-save');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Yeni',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => {
                        mainWindow.webContents.send('file-new');
                    }
                },
                {
                    label: 'Aç...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            title: 'Video Dosyası Aç',
                            filters: [
                                { name: 'Video Dosyaları', extensions: ['mp4', 'wmv', 'avi', 'mkv', 'mov', 'webm', 'flv', '3gp', 'mpg', 'mpeg', 'vob', 'm4v', 'ts', 'mts'] },
                                { name: 'Tüm Dosyalar', extensions: ['*'] }
                            ],
                            properties: ['openFile']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            addToRecentFiles(filePath);
                            mainWindow.webContents.send('file-open', filePath);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Kaydet',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => {
                        mainWindow.webContents.send('file-save');
                    }
                },
                {
                    label: 'Videoyu Farklı Kaydet... (Ctrl+Shift+S)',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: async () => {
                        const result = await dialog.showSaveDialog(mainWindow, {
                            title: 'Videoyu Farklı Kaydet',
                            filters: [
                                { name: 'MP4 Video', extensions: ['mp4'] },
                                { name: 'AVI Video', extensions: ['avi'] },
                                { name: 'WMV Video', extensions: ['wmv'] }
                            ]
                        });
                        if (!result.canceled) {
                            mainWindow.webContents.send('file-save-as', result.filePath);
                        }
                    }
                },
                {
                    label: 'Seçimi Kaydet...',
                    accelerator: 'CmdOrCtrl+Alt+S',
                    click: async () => {
                        const result = await dialog.showSaveDialog(mainWindow, {
                            title: 'Seçili Alanı Kaydet',
                            filters: [
                                { name: 'MP4 Video', extensions: ['mp4'] },
                                { name: 'AVI Video', extensions: ['avi'] }
                            ]
                        });
                        if (!result.canceled) {
                            mainWindow.webContents.send('file-save-selection', result.filePath);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Sadece Video Dışa Aktar...',
                    click: async () => {
                        const result = await dialog.showSaveDialog(mainWindow, {
                            title: 'Sadece Video Dışa Aktar (Sessiz)',
                            filters: [
                                { name: 'MP4 Video', extensions: ['mp4'] }
                            ]
                        });
                        if (!result.canceled) {
                            mainWindow.webContents.send('export-video-only', result.filePath);
                        }
                    }
                },
                {
                    label: 'Sadece Ses Dışa Aktar...',
                    click: async () => {
                        const result = await dialog.showSaveDialog(mainWindow, {
                            title: 'Sadece Ses Dışa Aktar',
                            filters: [
                                { name: 'MP3 Ses', extensions: ['mp3'] },
                                { name: 'WAV Ses', extensions: ['wav'] },
                                { name: 'AAC Ses', extensions: ['aac'] }
                            ]
                        });
                        if (!result.canceled) {
                            mainWindow.webContents.send('export-audio-only', result.filePath);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Harici Sesi Videoyla Senkronla... (A)',
                    click: () => {
                        const { openSyncWizard } = require('./dialog-windows');
                        openSyncWizard(mainWindow, 'A');
                    }
                },
                {
                    label: 'Referans Sesle Video Kaydet... (B)',
                    click: () => {
                        const { openSyncWizard } = require('./dialog-windows');
                        openSyncWizard(mainWindow, 'B');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Son Açılan Dosyalar',
                    submenu: [] // Dinamik olarak doldurulacak
                },
                { type: 'separator' },
                {
                    label: 'Dosyayı Kapat',
                    accelerator: 'CmdOrCtrl+W',
                    click: async () => {
                        // Renderer'a dosya kapatma isteği gönder
                        // hasChanges kontrolü renderer tarafında yapılacak
                        mainWindow.webContents.send('file-close-request');
                    }
                },
                // Gemini API Anahtarı taşındı
                { type: 'separator' },
                { type: 'separator' },
                {
                    label: 'Çıkış',
                    accelerator: 'Alt+F4',
                    click: () => {
                        mainWindow.webContents.send('app-quit-request');
                    }
                }
            ]
        },

        // DÜZENLE MENÜSÜ
        {
            label: 'Dü&zenle (Alt+Z)',
            submenu: [
                {
                    label: 'Geri Al',
                    accelerator: 'CmdOrCtrl+Z',
                    click: () => {
                        mainWindow.webContents.send('edit-undo');
                    }
                },
                {
                    label: 'Yinele',
                    accelerator: 'CmdOrCtrl+Y',
                    click: () => {
                        mainWindow.webContents.send('edit-redo');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Kes',
                    accelerator: 'CmdOrCtrl+X',
                    click: () => {
                        mainWindow.webContents.send('edit-cut');
                    }
                },
                {
                    label: 'Kopyala',
                    accelerator: 'CmdOrCtrl+C',
                    click: () => {
                        mainWindow.webContents.send('edit-copy');
                    }
                },
                {
                    label: 'Yapıştır',
                    accelerator: 'CmdOrCtrl+V',
                    click: () => {
                        mainWindow.webContents.send('edit-paste');
                    }
                },
                {
                    label: 'Sil',
                    accelerator: 'Delete',
                    click: () => {
                        mainWindow.webContents.send('edit-delete');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Seçim',
                    submenu: [
                        {
                            label: 'Tümünü Seç',
                            accelerator: 'CmdOrCtrl+A',
                            click: () => {
                                mainWindow.webContents.send('select-all');
                            }
                        },
                        {
                            label: 'Seçimi Temizle',
                            accelerator: 'Escape',
                            click: () => {
                                mainWindow.webContents.send('select-clear');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Aralık Seç...',
                            accelerator: 'CmdOrCtrl+R',
                            click: () => {
                                mainWindow.webContents.send('select-range-dialog');
                            }
                        },
                        {
                            label: 'İşaretçiler Arası Seç',
                            click: () => {
                                mainWindow.webContents.send('select-between-markers');
                            }
                        }
                    ]
                },
                // Akıllı Seçim taşındı
                { type: 'separator' },
                {
                    label: 'Video Özellikleri...',
                    click: () => {
                        mainWindow.webContents.send('edit-video-properties');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Boşlukları Listele...',
                    accelerator: 'CmdOrCtrl+Shift+B',
                    click: () => {
                        mainWindow.webContents.send('edit-list-silences');
                    }
                },
                // Seçimi Betimle taşındı
            ]
        },

        // OYNAT MENÜSÜ
        {
            label: '&Oynat (Alt+O)',
            submenu: [
                {
                    label: 'Oynat / Duraklat',
                    accelerator: 'Space',
                    click: () => {
                        mainWindow.webContents.send('playback-toggle');
                    }
                },
                {
                    label: 'Pozisyonda Duraklat',
                    accelerator: 'Enter',
                    click: () => {
                        mainWindow.webContents.send('playback-pause-at-position');
                    }
                },
                {
                    label: 'Seçili Alanı Oynat',
                    accelerator: 'Shift+Space',
                    click: () => {
                        mainWindow.webContents.send('playback-play-selection');
                    }
                },
                {
                    label: 'Kesim Önizleme (Seçimsiz)',
                    accelerator: 'CmdOrCtrl+Shift+Space',
                    click: () => {
                        mainWindow.webContents.send('playback-play-cut-preview');
                    }
                },
                {
                    label: 'Sessizliği Atla',
                    accelerator: 'CmdOrCtrl+Shift+J',
                    click: () => {
                        mainWindow.webContents.send('playback-skip-silence');
                    }
                },
                {
                    label: '1 Saniye İleri',
                    accelerator: 'Right',
                    click: () => {
                        mainWindow.webContents.send('seek-forward', 1);
                    }
                },
                {
                    label: '1 Saniye Geri',
                    accelerator: 'Left',
                    click: () => {
                        mainWindow.webContents.send('seek-backward', 1);
                    }
                },
                { type: 'separator' },
                {
                    label: '30 Saniye İleri',
                    accelerator: 'CmdOrCtrl+Right',
                    click: () => {
                        mainWindow.webContents.send('seek-forward', 30);
                    }
                },
                {
                    label: '30 Saniye Geri',
                    accelerator: 'CmdOrCtrl+Left',
                    click: () => {
                        mainWindow.webContents.send('seek-backward', 30);
                    }
                },
                { type: 'separator' },
                {
                    label: '5 Dakika İleri',
                    accelerator: 'CmdOrCtrl+Alt+Right',
                    click: () => {
                        mainWindow.webContents.send('seek-forward', 300);
                    }
                },
                {
                    label: '5 Dakika Geri',
                    accelerator: 'CmdOrCtrl+Alt+Left',
                    click: () => {
                        mainWindow.webContents.send('seek-backward', 300);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Başa Git',
                    accelerator: 'CmdOrCtrl+Home',
                    click: () => {
                        mainWindow.webContents.send('goto-start');
                    }
                },
                {
                    label: 'Sona Git',
                    accelerator: 'CmdOrCtrl+End',
                    click: () => {
                        mainWindow.webContents.send('goto-end');
                    }
                },
                {
                    label: 'Ortaya Git',
                    accelerator: 'CmdOrCtrl+Shift+Backspace',
                    click: () => {
                        mainWindow.webContents.send('goto-middle');
                    }
                },
                {
                    label: 'Sondan 30 Saniye Önce',
                    accelerator: 'Shift+Backspace',
                    click: () => {
                        mainWindow.webContents.send('goto-before-end');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Zaman Koduna Git...',
                    accelerator: 'CmdOrCtrl+G',
                    click: () => {
                        mainWindow.webContents.send('goto-time-dialog');
                    }
                },
                { type: 'separator' },
                {
                    label: 'İnce Ayar...',
                    accelerator: 'CmdOrCtrl+Shift+F',
                    click: () => {
                        mainWindow.webContents.send('show-fine-tune-dialog');
                    }
                }
            ]
        },

        // EKLE MENÜSÜ
        {
            label: '&Ekle (Alt+E)',
            submenu: [
                {
                    label: 'Ses Ekle...',
                    click: async () => {
                        // Eski: Doğrudan dosya seçimi açılıyordu
                        // Yeni: Renderer tarafına istek gönderilir, orada seçim yapılır (Dosya/Kayıt)
                        mainWindow.webContents.send('insert-audio-request');
                    }
                },
                {
                    label: 'Video Ekle...',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            title: 'Video Dosyası Seç',
                            filters: [
                                { name: 'Video Dosyaları', extensions: ['mp4', 'wmv', 'avi', 'mkv', 'mov'] }
                            ],
                            properties: ['openFile']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('insert-video', result.filePaths[0]);
                        }
                    }
                },
                {
                    label: 'Video Katmanı Ekle... (Ctrl+Shift+V)',
                    accelerator: 'CmdOrCtrl+Shift+V',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            title: 'Video Katmanı Seç (Picture-in-Picture)',
                            filters: [
                                { name: 'Video Dosyaları', extensions: ['mp4', 'wmv', 'avi', 'mkv', 'mov', 'webm', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'vob', 'm4v', 'flv', '3gp'] },
                                { name: 'Tüm Dosyalar', extensions: ['*'] }
                            ],
                            properties: ['openFile']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('open-video-layer-wizard', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'CTA / Overlay Kütüphanesi... (Ctrl+Shift+K)',
                    accelerator: 'CmdOrCtrl+Shift+K',
                    click: () => {
                        mainWindow.webContents.send('show-cta-library');
                    }
                },
                {
                    label: 'Metin Ekle...',
                    click: () => {
                        mainWindow.webContents.send('insert-text-dialog');
                    }
                },
                {
                    label: 'Görsel(ler) Ekle...',
                    click: () => {
                        mainWindow.webContents.send('open-image-wizard');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Altyazı Dosyası Ekle...',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            title: 'Altyazı Dosyası Seç',
                            filters: [
                                { name: 'Altyazı Dosyaları', extensions: ['srt', 'vtt', 'ass', 'ssa'] }
                            ],
                            properties: ['openFile']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('insert-subtitle', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Geçiş',
                    submenu: [
                        {
                            label: 'Geçiş Kütüphanesi...',
                            accelerator: 'CmdOrCtrl+Shift+T',
                            click: () => {
                                mainWindow.webContents.send('show-transition-library');
                            }
                        },
                        {
                            label: 'Aktif Geçişi Uygula',
                            click: () => {
                                mainWindow.webContents.send('apply-active-transition');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Aktif Geçişi Tüm İşaretçilere Uygula',
                            click: () => {
                                mainWindow.webContents.send('apply-transition-to-markers');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Geçiş Listesi...',
                            click: () => {
                                mainWindow.webContents.send('show-transition-list');
                            }
                        },
                        { type: 'separator' },
                        {
                            label: 'Tüm Geçişleri Videoya Uygula',
                            accelerator: 'CmdOrCtrl+T',
                            click: () => {
                                mainWindow.webContents.send('apply-all-transitions');
                            }
                        }
                    ]
                },
                { type: 'separator' },
                {
                    label: 'Nesneye Uygula (Analiz)...',
                    accelerator: 'CmdOrCtrl+Shift+A',
                    click: () => {
                        mainWindow.webContents.send('show-object-analysis-dialog');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Ekleme Listesi...',
                    accelerator: 'CmdOrCtrl+Shift+L',
                    click: () => {
                        mainWindow.webContents.send('show-insertion-queue');
                    }
                }
            ]
        },

        // GÖRÜNÜM MENÜSÜ
        {
            label: 'Gö&rünüm (Alt+R)',
            submenu: [
                {
                    label: '90° Döndür (Saat Yönünde)',
                    click: () => {
                        mainWindow.webContents.send('rotate-video', 90);
                    }
                },
                {
                    label: '90° Döndür (Saat Yönü Tersine)',
                    click: () => {
                        mainWindow.webContents.send('rotate-video', -90);
                    }
                },
                {
                    label: '180° Döndür',
                    click: () => {
                        mainWindow.webContents.send('rotate-video', 180);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Tam Ekran',
                    accelerator: 'F11',
                    click: () => {
                        mainWindow.setFullScreen(!mainWindow.isFullScreen());
                    }
                },
                { type: 'separator' },
                {
                    label: 'Geliştirici Araçları',
                    accelerator: 'F12',
                    click: () => {
                        mainWindow.webContents.toggleDevTools();
                    }
                }
            ]
        },

        // GİT MENÜSÜ
        {
            label: '&Git (Alt+G)',
            submenu: [
                {
                    label: 'Zaman Koduna Git...',
                    accelerator: 'CmdOrCtrl+G',
                    click: () => {
                        mainWindow.webContents.send('goto-time-dialog');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Başa Git',
                    accelerator: 'CmdOrCtrl+Home',
                    click: () => {
                        mainWindow.webContents.send('goto-start');
                    }
                },
                {
                    label: 'Sona Git',
                    accelerator: 'CmdOrCtrl+End',
                    click: () => {
                        mainWindow.webContents.send('goto-end');
                    }
                },
                {
                    label: 'Ortaya Git',
                    accelerator: 'CmdOrCtrl+Shift+Backspace',
                    click: () => {
                        mainWindow.webContents.send('goto-middle');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Sonraki İşaretçi',
                    accelerator: 'Alt+Right',
                    click: () => {
                        mainWindow.webContents.send('goto-next-marker');
                    }
                },
                {
                    label: 'Önceki İşaretçi',
                    accelerator: 'Alt+Left',
                    click: () => {
                        mainWindow.webContents.send('goto-prev-marker');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Seçimin Başına Git',
                    accelerator: 'CmdOrCtrl+J',
                    click: () => {
                        mainWindow.webContents.send('goto-selection-start');
                    }
                },
                {
                    label: 'Seçimin Sonuna Git',
                    accelerator: 'CmdOrCtrl+L',
                    click: () => {
                        mainWindow.webContents.send('goto-selection-end');
                    }
                }
            ]
        },

        // İŞARETÇİLER MENÜSÜ
        {
            label: 'İşaretçiler (Alt+&C)',
            submenu: [
                {
                    label: 'İşaretçi Ekle',
                    accelerator: 'M',
                    click: () => {
                        mainWindow.webContents.send('marker-add');
                    }
                },
                {
                    label: 'İşaretçi Sil',
                    click: () => {
                        mainWindow.webContents.send('marker-delete');
                    }
                },
                {
                    label: 'Tüm İşaretçileri Temizle',
                    click: () => {
                        mainWindow.webContents.send('marker-clear-all');
                    }
                },
                { type: 'separator' },
                {
                    label: 'İşaretçi Listesi...',
                    click: () => {
                        mainWindow.webContents.send('marker-list-dialog');
                    }
                }
            ]
        },

        // YAPAY ZEKA MENÜSÜ
        {
            label: '&Yapay Zeka (Alt+Y)',
            submenu: [
                {
                    label: 'Bulunduğun Konumu Betimle (5sn)...',
                    accelerator: 'CmdOrCtrl+Alt+V',
                    click: () => {
                        mainWindow.webContents.send('ai-describe-current-position', 5);
                    }
                },
                {
                    label: 'Seçimi Betimle...',
                    accelerator: 'CmdOrCtrl+Alt+D',
                    click: () => {
                        mainWindow.webContents.send('edit-describe-selection');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Akıllı Seçim Kontrolü...',
                    accelerator: 'CmdOrCtrl+I',
                    click: () => {
                        mainWindow.webContents.send('intelligent-selection');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Gemini API Anahtarı...',
                    click: () => {
                        mainWindow.webContents.send('edit-gemini-api-key');
                    }
                }
            ]
        },

        // YARDIM MENÜSÜ
        {
            label: 'Yardı&m (Alt+M)',
            submenu: [
                {
                    label: 'Klavye Kısayolları...',
                    accelerator: 'F1',
                    click: () => {
                        mainWindow.webContents.send('show-shortcuts');
                    }
                },
                {
                    label: 'Klavye Yöneticisi...',
                    accelerator: 'CmdOrCtrl+K',
                    click: () => {
                        mainWindow.webContents.send('show-keyboard-manager');
                    }
                },
                {
                    label: 'Kullanım Kılavuzu...',
                    accelerator: 'F2',
                    click: () => {
                        mainWindow.webContents.send('show-help');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Hakkında',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'Engelsiz Video Düzenleyicisi Hakkında',
                            message: 'Engelsiz Video Düzenleyicisi',
                            detail: 'Sürüm 3.0 RC\n\nGörme engelli kullanıcılar için tasarlanmış,\nklavye odaklı video düzenleme programı.\n\nProgram İkonu: Video düzenleyen eller ve kulak\n\n© 2025-2026 Engin Yılmaz\nTüm hakları saklıdır.'
                        });
                    }
                }
            ]
        }
    ];

    return Menu.buildFromTemplate(template);
}

module.exports = { createMenu, addToRecentFiles };
