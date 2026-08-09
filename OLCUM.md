# Mihenk — ölçüm sistemi (28 Temmuz 2026)

Veri iki ayrı yerde; hiçbiri diğerinin yerini tutmuyor.

## 1. Apple tarafı — mağaza hunisi (senin göremediğin her şey burada)
Gösterim, ürün sayfası görüntüleme, tıklama, **kurulum**, **silme**, yeniden kurulum,
oturum sayısı, çökme, ülke kırılımı. Bunları uygulama içinden ölçmek mümkün değil
(silmeyi silinen uygulama bildiremez), yalnızca Apple veriyor.

- App Store Connect → **Analytics** ekranı (hazır).
- Ayrıca API üzerinden ham rapor akışı **açıldı** (28 Tem 2026):
  `ONE_TIME_SNAPSHOT` = a45efd9e-cd59-4729-ad20-8db847de835b (geçmiş veri, birkaç gün sürer)
  `ONGOING`           = ae2c54cb-6de7-40b7-919b-9ab9c318953e (her gün otomatik)
  Apple raporları üretmeye başlayınca CSV olarak çekip panele katabiliriz.

## 2. Bizim taraf — uygulamanın içi
`/panel?k=OLCUM_ANAHTAR` → https://mihenk-api.onrender.com/panel?k=…
Anahtar: Render → mihenk-api → Environment → `OLCUM_ANAHTAR`.

Gösterdikleri: günlük aktif cihaz, yeni cihaz, **huni** (açtı → sorgu yaptı →
paywall gördü → satın almayı başlattı → abone oldu), ekran başına kaç kez / ortalama
kaç saniye, D1 ve D7 elde tutma, paywall'ın nereden açıldığı, satın almanın nerede
düştüğü (iptal / hata), dil ve saat dilimi dağılımı, tilavet indirme, en çok çalınan
sûre, ezan bildirimini açan/kapatan, istemci hataları, sürüm dağılımı.

JSON hâli: `/panel.json?k=…&gun=30`

### Toplanan olaylar
`acilis · ekran · sorgu · sonuc · paywall · satinalma · geri_yukle · paylas ·
ezan_bildirim · kari_indir · oynat · dil_degis · hata`

Kimlik: cihazın zaten kullandığı rastgele UUID. İsim, e-posta, IDFA, konum, IP yok.
Üçüncü taraf SDK yok — bu yüzden App Store'da "Tracking" beyanı gerekmiyor.

### Paywall hunisi (8 Ağu 2026'da tamamlandı)
`paywall` olayı artık `sebep` (kota-bitti / kari-dinle / kari-sec / kari-indir /
buton / sayac), `kalan` (o andaki ücretsiz hak) ve **`urunHazir`** taşıyor.
`satinalma` olayına `urun-yok` durumu eklendi: StoreKit ürünleri yüklenmediği
için kullanıcı satın **alamadığında** yazılır, `sebep` alanı nedenini söyler
(`tarayici` / `rc-anahtar-yok` / `urun-yuklenmedi` / `urun-listede-yok` /
`baslangic-bos` / `baslangic-hata` / `tekrar-basarisiz`). Panelde ayrı bir kutu
ve huninin altında kırmızı uyarı olarak görünür.

⚠️ `kalan` alanı 28 Tem'de istemcide gönderilmeye başlanmıştı ama `olay.mjs`
beyaz listesinde olmadığı için **diske hiç inmiyordu** — 8 Ağu'da düzeltildi.

## ⚠️ Senin yapman gerekenler
1. **Supabase → SQL Editor → `supabase-kota.sql`'i çalıştır**, sonra Render'a
   `SUPABASE_URL` ve `SUPABASE_SERVICE_KEY` gir. Ücretsiz kota sayacı artık orada
   duruyor; girilmezse sunucu açılışta uyarı basar ve kota her uyanışta sıfırlanır
   (yani paywall hiç tetiklenmez — 7 Ağu'da ölçülen hata buydu).
2. `/olcum?k=…` çıktısındaki `kota.kalici` alanı **true** olmalı.
3. **Analitik (olay) hâlâ kalıcı DEĞİL**: Render free planında disk yok, olaylar
   konteyner FS'ine yazılıyor ve sunucu uyuyunca siliniyor. Panel bunu en üstte
   kırmızıyla söyler. Kalıcı olması için ya Starter'a dönüp `/veri` diski takılmalı
   ya da olaylar da Supabase'e taşınmalı.

## Henüz ölçülemeyen
- **Paylaşım**: uygulamada paylaş butonu YOK. Olay tanımlı, buton eklenince dolar.
- **Abonelik iptali / yenileme / iade**: RevenueCat'te var, panele bağlanmadı.
  Bağlamak için RC webhook'u `/api/rc-webhook` ucuna düşürmek gerekiyor.
- **Uygulama silme**: yalnız Apple raporunda (yukarıda).
