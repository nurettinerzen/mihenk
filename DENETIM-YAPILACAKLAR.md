# Mihenk — denetim sonrası yapılacaklar (28 Temmuz 2026)

## Durum
İki ajan denetledi ve düzeltti. ⚠️ **Düzeltmeler paralel oturumun `f5c749c` commit'ine dahil olmuş** (o oturum aynı anda ezan bildirimi ve kâri indirme özelliklerini yazıyordu). Yani değişiklikler HEAD'de, ayrı bir commit'te değil.

## Bugünkü IAP düzeltmesi yeterli miydi? — Hayır, dört eksik vardı
`3c0d80f` doğru yöndeydi (`entitlements` VEYA `subscriptions`) ama:
- **İptal/süre dolumu premium'u hiç kapatmıyordu** — `localStorage.premium` bir kez yazılıp asla silinmiyordu → düzeltildi
- **İade edilmiş abone premium'u koruyordu** (`refunded_at` bakılmıyordu) → düzeltildi
- **Ödeme geçtiği hâlde ekranda hiçbir şey olmayabiliyordu** (`satinAl` dönen `customerInfo`'yu kullanmıyordu, `else` dalı yoktu) → düzeltildi
- **Geç gelen sunucu yanıtı doğrulanmış aboneyi ücretsize düşürüyordu** (yarış durumu) → düzeltildi

Not: `unsubscribe_detected_at` ve `billing_issues_detected_at` **kullanılmamalı** — iptal eden kullanıcı ödediği dönemin sonuna kadar hizmeti hak eder. Bu doğru yapılmış.

## Düzeltilenler
- **Premium artık sunucu yeniden başlayınca kaybolmuyor.** Eskiden `premiumCihaz` bir `Map`'ti; Render her deploy/restart'ta sıfırlıyordu → o an uygulamada olan abone 402 → paywall yiyordu. Artık tek doğruluk kaynağı RevenueCat (abone 6 sa, değil 10 dk TTL). `rcPremiumMi` `true/false/**null**` döndürüyor — `null` = doğrulanamadı, RC kesintisinde son bilinen durum korunuyor. **`kill -9` + yeniden başlat testiyle doğrulandı.**
- **Kimlik keychain'e taşındı.** `Purchases.configure()` artık appUserID vermeden çağrılıyor; eski UUID varsa `logIn` ile alias kuruluyor. Eskiden premium localStorage UUID'sine bağlıydı, iOS depolama baskısında silinince ödeyen kullanıcı sessizce ücretsize düşüyordu.
- **Arapça Kur'an araması düzeldi.** `arVaryant` elif düşürünce 2 harflik parça üretiyordu: `الربا` → `رب` (Rab), 1062 ayetle eşleşiyordu; faiz ayetleri yerine Rahmân 17 dönüyordu. 3 harf tabanı kondu: 1062→67.
- **AR/UR/ID kartlarda isnad zinciri sorunu.** İlk denenen "son rivayet fiilinden kes" yöntemi hadisin baş tarafını yiyordu (dinî içerikte parça cümle) — atıldı. Yerine soldan soyma: kalıba uymayan ilk halkada durur, en kötü ihtimalle metin olduğu gibi kalır. Ölçüm: AR %84,6 kırpıldı, ortalama %72'si korundu, 60 harften kısa kalan 0. Arama regresyonu: 7 sorgunun 6'sı bire bir aynı, `الربا`'da alaka 1/10 → 2/10 **yükseldi**.
- **Merkezîlik önbelleği** tek global diziydi — sunucu açıldıktan sonraki ilk sorgu hangi dildeyse ceza o dilin vektöründen hesaplanıp diğer dillere uygulanıyordu. Vektör başına önbelleğe çevrildi.
- **Konu araması hızlandı**: 12 istek dönüşümlü dillerde ort. 835 ms → **162 ms**; alakasız sorgu 657 ms → **9 ms** (73×); 37 sorgu setinde ort. 353 ms → **77 ms**. Sonuç kümesi 37'nin 33'ünde bire bir aynı.
- **Hız sınırı**: IP 120 → **3000/saat**, asıl fren **cihaz başına 300/saat**. Eskiden CGNAT arkasındaki yüzlerce kullanıcı birbirini 429'a düşürüyordu.
- **Test lisansı ucu tamamen silindi** (`/api/lisans` 404, `lisansGecerli`, `body.lisans`, `render.yaml`'daki `TEST_LISANS`, ölü CSS ve i18n anahtarları). Üretimde zaten kapalıydı ama değişken bir gün girilirse 3.1.1 ihlali olurdu.
- **Paywall'daki yanlış vaat**: "Reklamsız/Ad-free" yazıyordu ama uygulamada hiç reklam yok → "tüm cihazlarında geçerli" ile değiştirildi (6 dil). `%58` koddan çıktı, StoreKit fiyatlarından hesaplanıyor, hesaplanamıyorsa gizleniyor. `/app-ads.txt` ucu silindi.
- **Kutup bölgesi**: vakitler hesaplanamıyorsa artık dürüst uyarı gösteriliyor; "bugünün hepsi geçmiş" durumunda yanlışlıkla "İmsak" yazması da düzeldi.
- Ufaklar: `listen` error dinleyicisi, bozuk JSON 500→400, `kuranKonu`'da `qw` artık `nfQ` ile (Arapça harekeler kelimeyi parçalıyordu), `_sonIstek` budanıyor, kaynak etiketleri 6 dilde (`أبو داود 2201`), sûre adları ar/ur'da Arapça, `dilUygula` açık sûre listesini yeniden çiziyor.

i18n 6 dil × 100 anahtar tam. `www/` ve `ios/App/App/public/` senkron.

## 1. Render paneli
| Yapılacak | Neden |
|---|---|
| `RC_SECRET`'in **dolu** olduğunu doğrula | Artık premium'un **tek** doğruluk kaynağı. Boşsa hiçbir cihaz premium olamaz (eskiden bellekteki kayıt kısmen kurtarıyordu) |
| `TEST_LISANS` tanımlıysa **sil** | Kod artık okumuyor, ortalıkta durmasın |
| `RATE_LIMIT` 120 → **3000** | Blueprint'te güncel ama panelde elle girilmişse blueprint'i ezer |
| `CIHAZ_RATE_LIMIT` = **300** ekle | Asıl fren buraya taşındı |
| Deploy sonrası logda RSS satırını kontrol et | **Bellek +370 MB** (RSS ~750 MB → ~1,2 GB / 2 GB). 1,6 GB'ı geçiyorsa `NORM_DILLER=tr,en,ar` ekle |
| AdMob konsolunda bu domain için app-ads.txt beyanı varsa kaldır | Uç artık 404 |

## 2. RevenueCat
- **Entitlement tanımlı mı kontrol et.** Sunucu önce `entitlements`, sonra `subscriptions` bakıyor; entitlement yoksa abonelik kaydından kurtarıyor ama doğrusu tanımlı olması.
- **"Transfer purchases to new App User ID"** davranışının `logIn` aliasing'ini engellemediğini bir kez doğrula — yanlış ayar eski kullanıcıların satın almasını taşıyabilir.
- Yıllık/aylık fiyatlar ASC'de tanımlı olmalı; değilse paywall'da fiyat "—" ve tasarruf rozeti hiç görünmez (artık kasıtlı — uydurma yüzde göstermiyoruz).

## 3. Cihazda test
1. Sandbox'ta yıllık ve aylık **ayrı ayrı** satın alma; sonra **iptal edip** uygulamayı yeniden aç → rozet ücretsize dönmeli
2. **Aylık → yıllık geçiş** (kodda özel akış yok, RC/StoreKit'e bırakılmış)
3. **Geri yükleme** — sil-kur sonrası
4. ⚠️ **Simülatörde localStorage/Website Data temizlenmiş senaryo → premium korunuyor mu.** Ajanın test EDEMEDİĞİ tek parça bu (RC kimlik akışı yalnız gerçek derlemede koşuyor)
5. **Arka planda tilavet** — `UIBackgroundModes: audio` ve `AVAudioSession .playback` doğru kurulmuş; ekranı kilitleyip sesin devam ettiğini ve kilit ekranı kontrollerini doğrula
6. Sessiz moddaki telefonda ses
7. iPhone 8 sınıfı cihazda Oku&Dinle sekmesi (`ayat.json` 6,5 MB → ~11 MB heap; korpus istemciye hiç gelmiyor, risk düşük)

## 4. Build öncesi
Ajan pod yarışını önlemek için `npm run sync-ios` yerine `node yap-www.mjs && npx cap copy ios` kullandı. **Mağazaya göndermeden önce `npm run sync-ios` çalıştır** (pod tarafı için).

## 5. Karar senin / dokunulmayanlar
- **Konu arama sıralaması zayıf**: `tevazu` 0/5, `borç` 2/5, `komşuluk` → şuf'a rivayetleri. Formüle **dokunulmadı** — ölçüm seti olmadan körlemesine oynanmaz. Yerine `degerlendirme-konu.json` (30 sorgu, 6 dil) + `degerlendirme-calistir.mjs` kuruldu. **Temel çizgi: 133/150 (ilk5).** Set bildirilen bozuklukları yakalıyor.
- **`الربا` sıralaması hâlâ zayıf** — `ربا` "العرباض" gibi isimlerin içinde de bulunuyor. Ölçüm setine `redOrnek` olarak yazıldı.
- **CORS `*` + `APP_KEY` istemcide açık metin** (`hadis.html:490`). Anahtar sır değil; kotayı aşmak isteyen `cihaz` alanını değiştirerek yeniden ücretsiz sorgu alabilir. Kalıcı toplam kota maliyeti azaltır ama hesap/güvenilir cihaz doğrulaması olmadan kötüye kullanım tamamen kapanmaz.
- Bildirim/ezan ve kâri indirme kodu paralel oturumun işi — ajanlar dokunmadı. `bildirimAcKapa` yazılmış ama hiçbir yerden çağrılmıyor (ayarlarda açma/kapama yok).
