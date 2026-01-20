# 🍎 Engelsiz Video Düzenleyicisi - Mac Kurulum Rehberi

Merhaba! Bu rehber, Engelsiz Video Düzenleyicisi'ni Mac bilgisayarınızda nasıl kuracağınızı ve çalıştıracağınızı adım adım açıklar.

---

## 📋 Gereksinimler

| Gereksinim | Minimum | Önerilen |
|------------|---------|----------|
| **macOS** | 10.15 (Catalina) | 12.0 (Monterey) veya üzeri |
| **Node.js** | 18.x | 20.x LTS |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | 2 GB boş alan | 5 GB+ |

---

## 🚀 Kurulum Adımları

### Adım 1: Node.js Yükleyin

Eğer Node.js yüklü değilse:

1. **Safari veya tarayıcınızla** [https://nodejs.org](https://nodejs.org) adresine gidin
2. **"LTS"** (Uzun Süreli Destek) düğmesine tıklayın
3. İndirilen `.pkg` dosyasını açın ve kurulumu tamamlayın
4. Kurulum tamamlandığında Terminal'i açıp kontrol edin:
   ```bash
   node --version
   ```
   `v20.x.x` gibi bir çıktı görmelisiniz.

---

### Adım 2: Proje Dosyalarını İndirin

Size gönderilen **ZIP dosyasını** indirin ve bir klasöre çıkarın.

**Önerilen konum:** `~/Documents/KorculVideoEditor`

---

### Adım 3: Terminal'i Açın

**Yöntem A - Kolay yol:**
1. Finder'da proje klasörünü açın
2. Klasöre **sağ tıklayın** (veya Control + tıklama)
3. **"Hizmetler"** → **"Klasörde Yeni Terminal"** seçin

**Yöntem B - Manuel:**
1. Spotlight'ı açın (Cmd + Space)
2. "Terminal" yazın ve Enter'a basın
3. Şu komutu yazın (yolu kendi konumunuza göre değiştirin):
   ```bash
   cd ~/Documents/KorculVideoEditor
   ```

---

### Adım 4: Kurulum Scriptini Çalıştırın

Terminal'de şu komutları sırayla yazın:

```bash
# Script'lere çalıştırma izni ver
chmod +x setup-mac.sh start.sh start-debug.sh

# Kurulumu başlat
./setup-mac.sh
```

Bu işlem 2-5 dakika sürebilir. Tamamlandığında başarı mesajı göreceksiniz.

---

### Adım 5: Uygulamayı Başlatın

```bash
./start.sh
```

**İlk çalıştırmada "Bilinmeyen Geliştirici" uyarısı alabilirsiniz:**

1. **Sistem Tercihleri** → **Güvenlik ve Gizlilik** → **Genel** sekmesine gidin
2. Altta "... engellenmiş" mesajını göreceksiniz
3. **"Yine de Aç"** düğmesine tıklayın

---

## ♿ VoiceOver ile Kullanım

### VoiceOver'ı Açma/Kapama
- **Cmd + F5** tuşlarına basın

### Temel Navigasyon
- VoiceOver, uygulama içindeki etkileşimli öğeleri sesli okuyacaktır
- Tab tuşu ile öğeler arasında hareket edin
- Space veya Enter ile seçim yapın

### Önemli Kısayollar
| Kısayol | İşlev |
|---------|-------|
| Space | Oynat/Duraklat |
| Sol/Sağ Ok | 5 saniye geri/ileri |
| Cmd+O | Dosya Aç |
| Cmd+S | Kaydet |
| Escape | İptal/Kapat |

---

## 🔧 Sorun Giderme

### "command not found: node" hatası
Node.js kurulu değil veya PATH'e eklenmemiş.
```bash
# Homebrew ile kurulum (alternatif):
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
```

### npm install başarısız oluyor
```bash
# Cache'i temizle ve tekrar dene
npm cache clean --force
rm -rf node_modules
npm install
```

### sharp veya FFmpeg hataları
```bash
# Native modülleri yeniden derle
npm rebuild
```

### Uygulama açılmıyor / hemen kapanıyor
Debug modunda çalıştırarak hatayı görün:
```bash
./start-debug.sh
```

### "... is damaged" hatası
Gatekeeper bazen indirilen dosyaları engeller:
```bash
xattr -cr ~/Documents/KorculVideoEditor
```

---

## 📝 Geri Bildirim

Lütfen test sırasında karşılaştığınız sorunları not edin:

1. **Ne yapmaya çalışıyordunuz?**
2. **Ne olmasını bekliyordunuz?**
3. **Gerçekte ne oldu?**
4. **Hata mesajı var mıydı?** (varsa kopyalayın)
5. **macOS sürümünüz nedir?** (Apple menüsü → Bu Mac Hakkında)

Geri bildirimleriniz için teşekkürler! 🙏

---

## 📞 İletişim

Sorularınız için: [iletişim bilgilerinizi ekleyin]

---

*Son güncelleme: Ocak 2026*
