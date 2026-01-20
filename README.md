# 🎬 Engelsiz Video Düzenleyicisi

Görme engelli kullanıcılar için tasarlanmış, tamamen klavye ile kontrol edilebilen erişilebilir video düzenleme programı.

![Sürüm](https://img.shields.io/badge/sürüm-2.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-lightgrey)
![Lisans](https://img.shields.io/badge/lisans-MIT-green)

## ✨ Özellikler

- 🎹 **Tam Klavye Kontrolü** - Fare gerektirmez
- 🔊 **Ekran Okuyucu Uyumlu** - NVDA, JAWS, VoiceOver desteği
- ✂️ **Video Düzenleme** - Kesme, kopyalama, yapıştırma
- 🎨 **Geçiş Efektleri** - Fade, dissolve, wipe ve daha fazlası
- 🎤 **TTS Entegrasyonu** - Metni sese çevirme
- 🤖 **AI Destekli** - Gemini API ile video betimleme
- 📍 **İşaretçi Sistemi** - Önemli noktaları işaretleme
- 🖼️ **Slayt Gösterisi** - Resimlerden video oluşturma

## 🚀 Kurulum

### Windows
[Releases](../../releases) sayfasından Windows build'ini indirin.

### Mac / Linux
```bash
# Node.js 20+ gerekli
npm install
npm start
```

## ⌨️ Temel Kısayollar

| Kısayol | İşlev |
|---------|-------|
| `Space` | Oynat/Duraklat |
| `←` `→` | Geri/İleri |
| `Ctrl+O` | Dosya Aç |
| `Ctrl+S` | Kaydet |
| `M` | İşaretçi Ekle |
| `F1` | Kısayol Listesi |

> Mac'te `Ctrl` yerine `Cmd (⌘)` kullanın.

## 🏗️ Geliştirme

```bash
# Bağımlılıkları yükle
npm install

# Geliştirme modunda çalıştır
npm run dev

# Build oluştur
npm run build:win   # Windows
npm run build:mac   # Mac
npm run build:linux # Linux
```

## 📄 Lisans

MIT © 2025-2026 Engin Yılmaz
