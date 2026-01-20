#!/bin/bash
# Engelsiz Video Düzenleyicisi - Mac/Linux İlk Kurulum Scripti

echo ""
echo "🎬 =================================================="
echo "   Engelsiz Video Düzenleyicisi - Mac/Linux Kurulum"
echo "   Görme Engelli Kullanıcılar İçin Video Düzenleme"
echo "=================================================="
echo ""

cd "$(dirname "$0")"

# Node.js kontrolü
if ! command -v node &> /dev/null; then
    echo "❌ HATA: Node.js bulunamadı!"
    echo ""
    echo "📥 Lütfen aşağıdaki adımları izleyin:"
    echo "   1. https://nodejs.org adresine gidin"
    echo "   2. LTS (Uzun Süreli Destek) sürümünü indirin"
    echo "   3. Kurulumu tamamlayın"
    echo "   4. Bu scripti tekrar çalıştırın"
    echo ""
    exit 1
fi

NODE_VERSION=$(node --version)
echo "✅ Node.js bulundu: $NODE_VERSION"

# npm kontrolü
if ! command -v npm &> /dev/null; then
    echo "❌ HATA: npm bulunamadı!"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "✅ npm bulundu: v$NPM_VERSION"

echo ""
echo "📦 Bağımlılıklar yükleniyor..."
echo "   Bu işlem birkaç dakika sürebilir..."
echo ""

# npm install
npm install

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ =================================================="
    echo "   KURULUM BAŞARIYLA TAMAMLANDI!"
    echo "=================================================="
    echo ""
    echo "🚀 Uygulamayı başlatmak için:"
    echo "   ./start.sh"
    echo ""
    echo "🔧 Debug modunda başlatmak için:"
    echo "   ./start-debug.sh"
    echo ""
    echo "📝 İlk çalıştırmada 'Bilinmeyen Geliştirici' uyarısı"
    echo "   alabilirsiniz. Bu normaldir - uygulama henüz"
    echo "   Apple tarafından imzalanmamıştır."
    echo ""
    echo "♿ VoiceOver ile kullanım için Cmd+F5 tuşlarına basın."
    echo ""
else
    echo ""
    echo "❌ HATA: Kurulum başarısız oldu!"
    echo ""
    echo "Olası çözümler:"
    echo "1. Node.js sürümünüzü kontrol edin (v18+ önerilir)"
    echo "2. İnternet bağlantınızı kontrol edin"
    echo "3. Aşağıdaki komutu deneyin:"
    echo "   npm cache clean --force && npm install"
    echo ""
    exit 1
fi
