# Mihenk — üyelik ve ücretlendirme modeli: şu an / nasıl olmalı

## ŞU AN

**Üyelik: yok, direkt açılıp kullanılıyor. Bu doğru.** Bir hadis arama uygulamasına giriş duvarı koymak kullanıcıyı ilk 10 saniyede kaybetmek demek ve karşılığında hiçbir şey kazanmıyorsun — sunucuda tutulacak kişisel bir durum yok. Değiştirme.

**Ücretsiz kota: cihaz başına toplam 5 AI sorgusu.** Dini arama düşük sıklıklı bir ihtiyaç; günlük 5 sorgu paywall'ı çoğu kullanıcı için görünmez yapıyordu. Sayaç `kota.mjs` ile Render kalıcı diskinde tutulur, deploy/restart kotayı sıfırlamaz.

**Ücretsiz deneme: yok.**

**Premium paketi:** yedi kârinin tamamı, çevrimdışı tilavet indirme ve sınırsız hadis/Kur'an araması. Kur'an'ın tamamını okuma, Mishary Alafasy ile çevrimiçi dinleme, namaz vakitleri ve kıble ücretsizdir. Reklam yoktur; bu nedenle "reklamsız" Premium faydası olarak yazılmaz.

**Telemetri: yarım.** `hadis-api.mjs:876` `olcum` nesnesi ve `/olcum` ucu (`OLCUM_ANAHTAR` ile) var — istek sayıları, diller, hatalar, bulunamayan sorgular ölçülüyor. Bu arama kalitesi için değerli. **Ama paywall hunisi hiç yok:** kaç kişi paywall gördü, kaçı satın almayı başlattı, kaçı tamamladı — bilmiyorsun. Yani kotayı ve fiyatı körlemesine ayarlıyorsun.

## NASIL OLMALI

### 1. Paywall hunisi ekle — bu ilk iş
Ember'de kurulu desen (`App.js:552`, `components/Paywall.js:74`) buraya taşınmalı:
- `paywall_view {sebep}` — kota dolduğu için mi, premium bir özelliğe dokunduğu için mi
- `purchase_start {plan}`, `purchase_done {plan}`, `purchase_fail {plan, neden}`
- Her AI sorgusunda `kalan` alanı — kaç kullanıcı 5'i gerçekten tüketiyor

Bu veri olmadan aşağıdaki hiçbir maddenin etkisini göremezsin. `/olcum` altyapısı zaten var, olayları oraya eklemek küçük iş. Hedef oran: `paywall_view` → `purchase_done` **%1-3**.

### 2. Yıllık plana 3 gün deneme
Portföyde en yüksek getirili tek değişiklik burada olabilir. ₺249/yıl tek seferde büyük bir karar; ₺49,99/ay ile arasındaki %58 fark doğru kurgulanmış ama kullanıcı yıllığa atlamak için bir sebep istiyor. Deneme o direnci kırar. **Yalnız yıllıkta** tanımla, metni StoreKit `introPrice`'tan oku (Safi'deki `pay_deneme_*` desenini kopyala), koda gömme.

Toplam kota ile deneme çelişmiyor: ilk 5 arama ürünü ispatlar, deneme yıllık plana geçiş direncini azaltır.

### 3. Premium'a birikimli değer ekle — "sınırsız" tek başına abonelik tutmaz
"Sınırsız kullanım" üzerine kurulu abonelik, kullanıcıyı yoğun kullandığı ay ödeyip sonra iptal etmeye iter. Kalıcı abonelik, iptal ettiğinde **kaybedeceği bir şey** ister. Bu uygulamada doğal adaylar:

- **Kâri çeşitliliği** — Alafasy ücretsiz; diğer altı kâri Premium.
- **Çevrimdışı tilavet** — tüm kâri indirmeleri Premium.
- **Koleksiyon / favoriler** — kullanıcının kaydettiği hadisler, kendi notlarıyla
- **Okuma planı / seri** — günlük hadis veya sûre takibi; ezan bildirimleri zaten alışkanlık kancası kuruyor, üstüne bir ilerleme katmanı iyi oturur
- Arama geçmişi ve kaydedilen sorgular

### 4. Opsiyonel Apple girişi — zorunlu değil, premium faydası olarak
Üyelik zorunluluğu **eklemek yanlış**. Ama madde 3'teki koleksiyon/notlar birikince kullanıcı telefon değiştirdiğinde hepsini kaybediyor — bu iade ve churn üretir. Çözüm: giriş bir kapı değil bir fayda olsun — *"koleksiyonun ve notların tüm cihazlarında"*. Kahve Falı bu deseni doğru kurmuş (girişte hediye + cihazlar arası taşıma vaadi), aynısını buraya uyarla.

Not: premium'un kendisi artık RevenueCat'in keychain kimliğine bağlı (denetimde düzeltildi), yani **satın alma** için giriş gerekmiyor — bu doğru. Giriş yalnızca kullanıcının ürettiği veriyi taşımak için.

### 5. Reklam: ilk sürümlerde yok
Hadis/ayet kartının yanında banner veya kendiliğinden açılan geçiş reklamı kullanma. AdMob kategori filtresi istenmeyen reklamı yüzde yüz garantiyle engellemiyor. İlk gelir modeli yalnız Premium aboneliktir; yeterli aktif kullanıcı ve ölçüm oluşmadan reklam SDK'sı eklenmez.

## SIRA

1. **Paywall hunisi** — ölçmeden ayarlama yapılmaz
2. **Yıllığa 3 gün deneme** (metin StoreKit'ten)
3. **Kâri seçimi + çevrimdışı indirmeyi Premium yap**
4. Paywall'ı ses deneyimi merkezli anlat; sınırsız aramayı destekleyici fayda yap
5. Koleksiyon + notlar + okuma planı, ardından opsiyonel giriş
6. Aktif kullanıcı ve dönüşüm verisi oluşursa tek seferlik arama paketini ayrıca değerlendir

## DOKUNMA
- Üyelik yokluğu ve temel ibadet araçlarının ücretsiz kalması doğru.
- Fiyat aralığı (₺249/yıl vs ₺49,99/ay, %58) doğru bantta.
