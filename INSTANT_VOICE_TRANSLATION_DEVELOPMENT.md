# Anlık Sesli Çeviri Geliştirme Rehberi

Bu dal, Anlık Sesli Çeviri uygulamasının Windows ve macOS kaynaklarını birlikte içerir:

- Ortak Electron ana süreç, erişilebilir arayüz ve çeviri servisleri
- Windows için .NET 8 loopback ses yakalama yardımcısı
- macOS 14.2 ve sonrası için Swift Core Audio Tap yardımcısı
- Windows x64 klasör paketi ve macOS ARM64 DMG yapılandırmaları
- İki platform için GitHub Actions derlemeleri

## Başlangıç

Gereksinimler:

- Node.js 20
- npm
- Windows geliştirmesi için .NET 8 SDK
- macOS geliştirmesi için macOS 14.2 veya sonrası ve Xcode Command Line Tools

```bash
git clone --branch instant-voice-translation-cross-platform https://github.com/yilmaeng/EngelsizVideoDuzenleyici2.git
cd EngelsizVideoDuzenleyici2
npm ci
```

Bağımsız çeviri penceresini geliştirme modunda açmak için:

Windows PowerShell:

```powershell
$env:EVD_INSTANT_TRANSLATOR_ONLY = '1'
npm run dev
```

macOS Terminal:

```bash
EVD_INSTANT_TRANSLATOR_ONLY=1 npm run dev
```

## Paket Oluşturma

Windows x64:

```powershell
npm run build:instant-voice-translation
```

macOS ARM64:

```bash
npm run test:instant-voice-translation:mac
npm run build:instant-voice-translation:mac
```

Yerel macOS paketi imzasız geliştirme paketi olarak üretilebilir. Developer ID ile imzalama ve noter onayı, depo sahibinin GitHub Actions secrets değerlerini kullanan macOS iş akışında yapılır. Sertifika, parola veya API anahtarı repoya eklenmemelidir.

## Kaynak Haritası

- `src/renderer/instant-voice-translation.html`: bağımsız pencerenin erişilebilir HTML yapısı
- `src/renderer/scripts/instant-voice-translation-standalone.js`: arayüz, servis ve canlı çeviri akışı
- `src/renderer/styles/instant-voice-translation.css`: bağımsız pencere stilleri
- `src/main/index.js`: pencere, IPC ve platform başlangıç davranışları
- `src/main/native-audio-platform.js`: Windows ve macOS ses helper soyutlaması
- `tools/EvdProcessLoopbackCapture`: Windows .NET loopback ses yardımcısı
- `tools/EvdMacAudioCapture`: macOS Swift Core Audio Tap yardımcısı
- `build/instant-voice-translation-builder.json`: Windows paket yapılandırması
- `build/instant-voice-translation-mac-builder.js`: macOS paket yapılandırması
- `.github/workflows/build-instant-voice-translation-windows.yml`: Windows artifact derlemesi
- `.github/workflows/build-instant-voice-translation-mac.yml`: imzalı ve noter onaylı macOS DMG derlemesi

## Katkı Kuralları

- Yeni kullanıcı metinleri `src/locales/tr.json`, `en.json`, `de.json`, `es.json` ve `fr.json` dosyalarına eklenmelidir.
- Form alanlarının açık ve bağlama özgü erişilebilir adları olmalıdır.
- API anahtarları, Apple sertifikaları ve diğer gizli bilgiler commit edilmemelidir.
- Platforma özel davranış ortak arayüzden ayrılmalı ve diğer platformun derlemesini bozmamalıdır.
- Değişiklikler mümkün olduğunda hem Windows hem macOS üzerinde klavye ve ekran okuyucuyla sınanmalıdır.

Katkı için bu dal temel alınarak yeni bir dal açılabilir ve `instant-voice-translation-cross-platform` dalına pull request gönderilebilir.
