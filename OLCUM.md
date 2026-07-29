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

## ⚠️ Senin yapman gerekenler
1. **Render → mihenk-api → Disks**: `veri` adında 1 GB disk `/veri` yolunda bağlı mı?
   `render.yaml`'a yazıldı ama Render disk eklemeyi bazen elle onaylatıyor.
   **Bağlı değilse panel en üstte kırmızıyla söyler** ve her deploy ölçümü sıfırlar.
   (Not: disk bağlı bir serviste Render sıfır kesintili deploy yapamaz; deploy
   sırasında ~30 sn kesinti olur. Kabul edilebilir.)
2. Paneli bir kez aç, kırmızı uyarı var mı bak.

## Henüz ölçülemeyen
- **Paylaşım**: uygulamada paylaş butonu YOK. Olay tanımlı, buton eklenince dolar.
- **Abonelik iptali / yenileme / iade**: RevenueCat'te var, panele bağlanmadı.
  Bağlamak için RC webhook'u `/api/rc-webhook` ucuna düşürmek gerekiyor.
- **Uygulama silme**: yalnız Apple raporunda (yukarıda).
