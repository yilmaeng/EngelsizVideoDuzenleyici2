# Anlık Sesli Çeviri macOS Build Notları

## Hedef

- Uygulama kimliği: `com.engelsiz.instantvoicetranslation`
- İç bundle ve çalıştırılabilir adı: `Anlik Sesli Ceviri`
- Finder görünen adı: `Anlık Sesli Çeviri`
- Hedef mimari: Apple Silicon (`arm64`)
- Beklenen çıktı: `dist/Anlik-Sesli-Ceviri-3.0.0-arm64.dmg`

İç bundle, çalıştırılabilir ve DMG adları imza sırasında Unicode normalizasyonu sorunu yaşanmaması için ASCII tutulur. Kullanıcıya görünen ad Türkçe karakterleri korur.

## Doğrulama

```bash
npm run test:instant-voice-translation:mac
```

## İmzasız Public Beta

```bash
npm run build:instant-voice-translation:mac
```

## Developer ID ile İmzalı Build

Mac üzerinde Developer ID Application sertifikası Keychain’e yüklenmişken:

```bash
EVD_MAC_SIGNING_ENABLED=1 npm run build:instant-voice-translation:mac
```

Bu mod EVD ile aynı Developer ID Application sertifikasını kullanabilir. Bundle kimliği Anlık Sesli Çeviri’ye özel kalır. Noterleme ayrı bir yayın adımıdır ve Apple noterleme kimlik bilgileri hazır olduğunda eklenmelidir.

## Native Sistem Sesi Desteği

- En düşük işletim sistemi macOS 14.2'dir.
- Mikrofon, bilgisayar sesi ve uygulama sesi kaynakları desteklenir.
- Bilgisayar ve uygulama sesi, Swift ile geliştirilen `EvdMacAudioCapture` Core Audio Tap yardımcısını kullanır.
- İlk yakalamada macOS sistem sesi kaydı izni ister. İzin reddedilirse Sistem Ayarları > Gizlilik ve Güvenlik bölümünden yeniden açılmalıdır.
- EVD ve Anlık Sesli Çeviri aynı yardımcı binary'yi ve aynı Developer ID Application sertifikasını kullanabilir.
- Karşılıklı konuşma modu, Mac sanal ses yönlendirmesi henüz eklenmediği için devre dışıdır.
- Kısayollar: `Command+Option+D` başlat/durdur, `Command+Option+A` pencereyi geri getir.
- Windows native audio helper ve Windows binary dosyaları Mac paketine alınmaz.