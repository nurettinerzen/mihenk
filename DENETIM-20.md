# Mihenk — 20 maddelik cihaz/UX denetimi (3 Eylül 2026)

Kapsam: `hadis.html` (tek kaynak istemci; `www/`, `ios/App/App/public/`,
`android/app/src/main/assets/public/` bundan üretiliyor), `hadis-api.mjs`,
`ios/App/App/Info.plist` + `*.lproj/InfoPlist.strings`,
`android/app/src/main/AndroidManifest.xml`, `test/`.

Doğrulama: `hadis.html` yerel sunucuda (`www/`) tarayıcıda açıldı; dil algılama,
geri tuşu yığını, RTL kapatma düğmesi, Enter tuşu ve hata kartı **çalışırken**
gözlendi. `npm test` → **17/17 geçti** (denetim öncesi 16/17'ydi, bkz. madde 11).

Satır numaraları düzeltmeler UYGULANDIKTAN SONRAKİ `hadis.html`'e aittir.

---

## 1. Uçak modu — **KISMİ → düzeltildi**

**Bulgu.** `fetch`'lerin hiçbirinde zaman aşımı yoktu (`hadis.html:1087`,
`2074`, `2115`, `1904`, `1116`). Uçak modunda / kaptif Wi-Fi arkasında söz hiç
çözülmeyebiliyor → **spinner sonsuza kadar dönüyordu**. Ayrıca ağın kapalı
olduğu durum ile sunucunun ulaşılamaz olduğu durum aynı metni gösteriyordu
("Sunucuya şu an ulaşılamıyor"), ve hata kartında kullanıcının basabileceği
**hiçbir düğme yoktu** — sekme değiştirip geri gelmesi gerekiyordu.

İyi olan: `catch` her sorgu yolunda vardı (`1247`, `1273`, `1301`), 4 sn'yi
aşan istekte "sunucu uyanıyor" şeridi çıkıyor (`2054`), `/api/gunun` 3 kez
yeniden deniyor (`2127`), açılışta önbellekten çiziliyor.

**Uygulanan düzeltme.**
- `fetchZamanli()` eklendi (`hadis.html:1064-1077`): `AbortController` + 25 sn
  üst sınır; `navigator.onLine === false` ise beklemeden `cevrimdisi` hatası.
  Tüm API çağrıları buna alındı (`1087`, `1116`, `1904`, `2074`, `2115`).
- `hataKodu()`'na `cevrimdisi` kodu (`1168`) → panelde "ağ yok" ile "sunucu
  düştü" ayrışıyor.
- `hata()` yeniden yazıldı (`1182-1197`): çevrimdışıysa **"İnternet bağlantısı
  yok"** başlığı + çevrilmiş açıklama, ve **"Tekrar dene" düğmesi**
  (`TEKRAR_ISLEV`, `1252-1254`). Bugün ekranındaki hata kartına da tekrar
  düğmesi eklendi (`2139-2145`).
- `gununIste()` ağ kapalıyken 3 kez denemeyi bırakıyor (`2110`).
- Yeni i18n anahtarları `cevrimdisi_baslik` + `cevrimdisi` **6 dilde** eklendi.

**Kalan.** `sesCal` (tilavet akışı) ve `kuranVeriYukle` zaman aşımsız; ikisinin
de `onerror`/`catch` yolu var, sonsuz spinner üretmiyorlar.

---

## 2. Soğuk açılış — **VAR (iyi), ölçüm eksik**

İlk boyamayı bloklayan iş yok: `ayat.json` (8,1 MB) **yalnız Kur'an → Oku &
Dinle açılınca** çekiliyor (`hadis.html:2320`), korpus istemciye hiç gelmiyor.
Head'de senkron iki betik var ama küçük: `adhan.min.js` 15 KB, `tz.js` 73 KB
(`hadis.html:13-14`). Ekran **önce localStorage önbelleğinden** çiziliyor,
sunucu yanıtı sonra güncelliyor (`2077-2080`, `2140`).

**Eksik:** `olay('acilis',…)` sürüm/dil/TZ yazıyor ama **açılış SÜRESİ
ölçülmüyor** (`hadis.html:2935`). ÖNERİ: `performance.now()` ile ilk boyamaya
kadar geçen ms'yi `acilis` olayına ekle.

---

## 3. Karanlık mod — **VAR (tek tema) → düzeltildi**

Uygulama tek temalı: koyu palet `:root`'ta sabit (`hadis.html:17-24`).
`prefers-color-scheme` desteği yok — bu **kasıtlı ve tutarlı**, okunmaz yer
üretmiyor (açık tema için sabit beyaz/siyah kaçağı yok).

**Bulgu.** `color-scheme` beyanı yoktu: `<select id="kariSec">` açılır listesi,
kaydırma çubuğu ve metin imleci sistemden **açık** geliyordu; koyu kartın
üstünde beyaz açılır liste çıkıyordu.

**Uygulanan düzeltme.** `<meta name="color-scheme" content="dark">` +
`<meta name="theme-color" content="#0d1512">` (`hadis.html:10-11`) ve
`:root{color-scheme:dark}` (`hadis.html:18`). Safe-area zaten `body`'de
uygulanmış (`hadis.html:33`).

---

## 4. Büyük yazı — **YOK → düzeltildi**

**Bulgu (ciddi).** `hadis.html:5` şuydu:
`maximum-scale=1, user-scalable=no` → **kullanıcı yakınlaştıramıyordu.** Arapça
`.arapca` bloğu 22 px sabit; gözü iyi görmeyen kullanıcı dinî metni büyütemiyor.

**Uygulanan düzeltme.** `maximum-scale` ve `user-scalable` kaldırıldı
(`hadis.html:5-7`). `html{-webkit-text-size-adjust:100%}` (`hadis.html:26`)
duruyor; WKWebView'da Dynamic Type'ı doğrudan uygulamıyor ama artık kıstırarak
yakınlaştırma serbest.

`overflow:hidden` + sabit yükseklikle kırpılan metin: yalnız `.mini-bilgi`
(çalar başlığı) ve `.cip` (örnek çipleri) `text-overflow:ellipsis` kullanıyor;
ikisi de tek satırlık etiket, içerik metni değil. Sorun değil.

---

## 5. Klavye — **YOK → düzeltildi**

**Bulgu.** Hiçbir girişte `enterkeyhint`/`inputmode` yoktu ve **Enter tuşu
hiçbir şey yapmıyordu**: kullanıcı "sabır" yazıp Enter'a basıyor, klavye
kapanmıyor, sonuç gelmiyordu. Boşluğa dokununca da klavye kapanmıyordu.

**Uygulanan düzeltme.**
- `#konu`, `#kkonu`, `#sureAra`'ya `enterkeyhint="search"`, `autocomplete/
  autocorrect="off"` (`hadis.html:470`, `489`, `505`).
- Enter → aramayı çalıştır + `blur()` (`hadis.html:2758-2770`). Tarayıcıda
  doğrulandı: Enter sonucu tetikledi, odak düştü.
- Kart boşluğuna dokununca `blur()` (`hadis.html:2771-2778`).
- `#metin` çok satırlı olduğu için Enter'a bağlanmadı (doğrusu bu).

**Kalan (ÖNERİ).** KeyboardAvoiding yok; giriş kutuları sayfanın üstünde olduğu
için pratikte klavyenin altında kalmıyorlar, ama iPhone SE sınıfı cihazda
`#konu`+çipler+düğme yığını kontrol edilmeli.

---

## 6. İlk açılış — **VAR**

Sıfır veriyle açılışta kırılan yol yok: `kuranYer` (`2396`), `konum` (`2837`),
`inikSureler` (`2239`), `ob_*` (`2062`) hepsi `try/catch` + varsayılanla
okunuyor. Boş durumlar var: Ezan sekmesi konum açıklaması + düğme
(`hadis.html:527-529`), Bugün önbellek yoksa hata/tekrar kartı, sûre araması
boşsa "Sûre bulunamadı" (`2358`), sonuç boşsa "farklı bir kelime dene" +
"ücretsiz hakkın harcanmadı" notu (`1267`, `1256-1260`).

İzin sıralaması makul: **açılışta hiçbir izin istenmiyor**. Konum yalnız Ezan
sekmesine girilince, bildirim izni ancak konum başarıyla alındıktan sonra
teklif ediliyor (`hadis.html:1582`, `1521`).

---

## 7. Geri tuşu — **YOK → düzeltildi**

**Bulgu (ciddi, Android).** Dosyada `backButton` / `App.addListener` **hiç
yoktu** ve `@capacitor/app` **kurulu değil** (`package.json`,
`android/capacitor.settings.gradle`). Capacitor'ın varsayılanı "WebView geri
gidebiliyorsa git, yoksa Activity'yi bitir" olduğu ve uygulama hiç `pushState`
kullanmadığı için: **paywall ya da Ayarlar AÇIKKEN geri tuşu uygulamayı
kapatıyordu.** Sûrenin içindeyken de listeye değil doğrudan dışarı çıkıyordu.

**Uygulanan düzeltme (plugin'siz).** History API tabanlı geri yığını
(`hadis.html:2858-2911`): modal/ekran açılırken bir geçmiş katmanı itiliyor,
donanım geri tuşu `popstate` olarak gelip katmanı kapatıyor. `paywallGoster/
paywallGizle`, Ayarlar aç/kapat/arka plan, `sureAc`/`sureGeri` sarmalandı.

Tarayıcıda doğrulandı: paywall açıkken geri → paywall kapandı, sayfadan
çıkılmadı; × ile kapatınca `history.length` **artmıyor** (yığın sızıntısı yok).

**Kalan (ÖNERİ).** Kök ekranda **çift-bas-çık yok** — `exitApp` için
`@capacitor/app` kurulup `npx cap sync` gerekiyor; bu oturumda bilerek
yapılmadı (bağımlılık + native sync). Puanlama kapısı açıkken geri tuşu da hâlâ
uygulamayı kapatır (ayrı IIFE, `hadis.html:315-398`).

---

## 8. Yatay mod — **VAR (kilit yok, bilinçli)**

`ios/App/App/Info.plist`: iPhone'da Portrait + LandscapeLeft/Right, iPad'de dört
yön. Android'de `screenOrientation` yok, `configChanges` içinde `orientation`
var → Activity yeniden yaratılmıyor.

Yatayda düzen bozulmuyor: tek sütun, `.wrap{max-width:640px;margin:0 auto}`
(`hadis.html:37`), sabit öğeler (`.mini-calar`, `.geri-yuzen`) safe-area
kullanıyor. **Değişiklik yapılmadı** — kilit eklemek sûre okumayı yatayda
kullananları cezalandırırdı.

---

## 9. Silme onayı — **VAR (kısmen)**

Yıkıcı iki eylem de onay istiyor: kârinin tamamını kaldırma
(`hadis.html:2692` → `confirm(T.indir_kaldir_onay)`) ve tek sûrenin sesini
silme (`T.indir_sil`, 6 dilde çevrili). **Geri alma yok** ama silinen şey
yeniden indirilebilir içerik.

Hesap/kayıt silme diye bir eylem yok (madde 13). ÖNERİ: `confirm()` yerine
uygulamanın kendi diyaloğu — RTL dillerde sistem `confirm`'ü LTR çiziyor.

---

## 10. Çevrimdışı kayıt — **VAR**

Kullanıcının ürettiği kalıcı veri yalnız cihazda: `kuranYer` (okuma yeri),
`kari`, `dil`, `bildirim`, `konum`, `inikSureler` + indirilen ses dosyaları
(Capacitor Filesystem `DATA`). Hiçbiri sunucuya yazılmıyor → ağ yokken kayıp
yok. Sûre indirmesi iptal edilirse **kaldığı yerden devam** ediyor
(`T.indir_iptal_oldu`, `hadis.html:2702`).

Telemetri kuyruğu ağ yokken **bilerek düşürülüyor** (`hadis.html:1119-1122`,
yorumda gerekçesi yazılı: çevrimdışı cihazda kuyruk sonsuz büyür). Kabul.

---

## 11. Hata metinleri — **KISMİ → düzeltildi**

Kullanıcıya gösterilen hata metinlerinin tamamı (hepsi 6 dilde çevrili):

| Yer | Metin anahtarı |
|---|---|
| Sunucuya ulaşılamıyor | `err_title` + `err_body` |
| **İnternet yok (YENİ)** | `cevrimdisi_baslik` + `cevrimdisi` |
| 429 / yoğunluk | `yogun_baslik` + `yogun` |
| Metin çok kısa / konu boş | `girdi_kisa`, `girdi_bos` |
| Sonuç yok | `konu_bos`, `kuran_bos`, `nf_title`, `nf_body`, `bos_hak` |
| Kutup bölgesi vakit | `ezan_kutup_baslik`, `ezan_kutup` |
| Konum alınamadı | `ezan_konum_hata` |
| Bildirim izni / kesin alarm | `bildirim_izin`, `bildirim_kesin` |
| Ses/indirme | `ses_hata`, `indir_hata`, `sure_bulunamadi` |
| Satın alma | `pw_hata`, `pw_urun_yok`, `pw_restore_yok`, `pw_gecersiz` |

**Bulgu.** Tek ham sızıntı: `hadis.html`'de ezan sesi denemesinde
`alert('Deneme kurulamadı: '+(e.message||e))` — sabit Türkçe + **çevrilmemiş
ham hata mesajı** (çoğu zaman İngilizce `Error: …`).
**Düzeltildi** (`hadis.html:2676-2681`): kullanıcıya `T.pw_hata` (6 dil),
sebep `olay('hata',{kod:'deneme_kurulamadi'})` ile panele.

**Telemetri.** "Bu app hatayı hiç yazmıyordu" notu **artık geçersiz**:
`window.error` + `unhandledrejection` yakalanıyor (cihaz başına 5 kayıtla
sınırlı, `hadis.html:977-991`), `hataKodu()` sebebi makine-okur koda çeviriyor
(`1165-1177`) ve her sorgu hatası `{yer,kod,kaynak,detay}` ile gidiyor.

**Ayrıca bulundu — sürüm etiketi sapması (ölçümü bozuyordu).**
`SURUM_ETIKET` (`hadis.html:656`) Ayarlar'daki etiketten okunuyor; etiket
**"Mihenk 1.6"** yazıyordu ama derlemeler **iOS `MARKETING_VERSION = 1.7`,
Android `versionName "1.7.1"`**. Yani panele düşen her hata/olay **yanlış
sürüme** kaydediliyordu. `test/guvenlik-regresyon.test.mjs`'teki sürüm testi
1.5'te kalmış ve **iki sürümdür kırık koşuyordu** (denetim başında 16/17), o
yüzden yakalayamadı.
**Düzeltildi:** etiket ve puanlama kapısı `surum` → **1.7**
(`hadis.html:395`, `626`); test gerçek değerlere güncellendi ve tekrar bir
koruma hâline getirildi (`test/guvenlik-regresyon.test.mjs:72-80`). **17/17.**
⚠️ iOS 1.7 ile Android 1.7.1 hâlâ farklı — bilinçliyse sorun değil, değilse
sonraki sürümde eşitle.

---

## 12. İzin gerekçesi — **VAR (iyi) → küçük temizlik**

iOS: `NSLocationWhenInUseUsageDescription` **altı dilde yerelleştirilmiş**
(`ios/App/App/{tr,en,fr,id,ar,ur}.lproj/InfoPlist.strings`) ve dosyalar
`project.pbxproj`'de kayıtlı (24-29. satırlar) — yani gerçekten paketleniyor.
Metin anlamlı: "Namaz vakitleri ve kıble yönünü hesaplamak için konumun
kullanılır."

**Bulgu.** `NSLocationAlwaysAndWhenInUseUsageDescription` ve
`NSLocationAlwaysUsageDescription` tanımlıydı ama kod **hiçbir yerde "always"
konum istemiyor** (Capacitor Geolocation yalnız `getCurrentPosition` /
`checkPermissions` kullanıyor, `hadis.html:1291`, `1304`).
**Düzeltildi:** iki anahtar `Info.plist`'ten ve altı `.strings` dosyasından
kaldırıldı — App Review'da "istemediğin izni beyan etmişsin" sorusunu kapatır.

Android: `INTERNET`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`,
`RECEIVE_BOOT_COMPLETED`, `ACCESS_COARSE/FINE_LOCATION` — hepsinin kullanımı
var. Çalışma anı gerekçesi izin reddedilince gösteriliyor (`bildirim_izin`,
`bildirim_kesin`; `hadis.html:1521`, `2654`, `2667`) ve `manifest`'te
`supportsRtl="true"`. `USE_EXACT_ALARM` bilinçli istenmemiş (yorumda gerekçe).

---

## 13. Hesap silme — **GEREKMİYOR (N/A)**

Uygulama **hesap oluşturmuyor**: giriş, e-posta, şifre, üçüncü taraf SDK yok.
Kimlik = RevenueCat'in anonim kurulum kimliği (`hadis.html:1761-1781`).
`hadis-api.mjs`'de kayıt/oturum ucu yok. Apple 5.1.1(v) **kapsam dışı**.

ÖNERİ (zorunlu değil): Ayarlar'da "Kurulum kimliği" gösteriliyor
(`hadis.html:616`); bunun yanına "verilerimi sil" (`/api/veri-sil` ile o
kimliğe ait olay + kota kayıtlarını sil) koymak gizlilik açısından iyi olur.

---

## 14. Paywall metni — **VAR (tam)**

`hadis.html:535-577`'da hepsi mevcut ve **6 dilde çevrili**:
- **Fiyat**: StoreKit'ten okunuyor, gelmezse "—" gösteriliyor (koda sabit ₺
  yazılmıyor — yorumda gerekçesi var, `hadis.html:550-552`).
- **Süre**: "Yıllık" / "Aylık" (`pw_yillik`, `pw_aylik`).
- **Deneme**: `introPrice`'tan, teklif yoksa satır gizli (`planDeneme`).
- **Otomatik yenileme ifadesi**: `pw_yenileme` (`hadis.html:570`), Android'de
  "App Store" → "Google Play" olarak değiştiriliyor (`hadis.html:2803`).
- **Satın Alımları Geri Yükle**: `restoreBtn` (`hadis.html:568`).
- **Kullanım Koşulları + Gizlilik bağlantıları**: `hadis.html:571-574`.
- Ürünler yüklenemezse "Mağazaya bağlanamadık" + **Tekrar dene** (`pw_tekrar`).
- Tasarruf yüzdesi uydurulmuyor, hesaplanamıyorsa gizleniyor.

Değişiklik gerekmedi. (`%58` ve "Reklamsız" gibi yanlış vaatler önceki
denetimde temizlenmiş.)

---

## 15. Çarpı/kapatma — **VAR → RTL düzeltildi**

Paywall ve Ayarlar'da görünür `×` var, **44×44 px** (`hadis.html:63-64`;
tarayıcıda ölçüldü: 44×44), ayrıca arka plana dokununca da kapanıyorlar
(`hadis.html:2804`, `2817`). Mini çalar durdurma düğmesi de 44 px
(`hadis.html:257`). Safe-area'nın altında kalmıyorlar (kart ortalı, `padding:20px`).

**Bulgu.** RTL'de (`ar`, `ur`) kapatma `×` ve ayar dişlisi **sağda kalıyordu** —
metnin başladığı köşeye biniyordu.
**Düzeltildi** (`hadis.html:66-69`): `html[dir="rtl"]` altında ikisi de sola
alındı. Arapça arayüzde doğrulandı (× kartın sol kenarından 9 px).

**Kalan.** Puanlama kapısında `×` yok — yalnız arka plana dokunarak veya iki
düğmeden biriyle kapanıyor (`hadis.html:386`). İki düğme de görünür olduğu için
çıkmaz değil.

---

## 16. Isınma — **KISMİ → düzeltildi**

`requestAnimationFrame` döngüsü yok, yoklama (polling) yok, arka planda video
yok, wake lock yok. Ekran süresi sayacı `visibilitychange`'de duruyor
(`hadis.html:1165`). Tilavet arka planda **kasıtlı** çalıyor
(`UIBackgroundModes: audio` + kilit ekranı kontrolleri).

**Bulgu.** Ezan geri sayımı `setInterval(tik,1000)` (`hadis.html:1664`)
uygulama arka plandayken de saniyede bir DOM yazmaya devam ediyordu.
**Düzeltildi** (`hadis.html:1139-1150`): ekran gizlenince `clearInterval`,
geri gelince `ezanCiz()` ile yeniden çiziliyor (yan fayda: arka planda vakit
girdiyse ekran doğru vakti gösteriyor).

**Kalan (küçük).** `deviceorientation` dinleyicileri bir kez eklenip
kaldırılmıyor (`hadis.html:1601-1602`); yalnız Ezan sekmesinde ve kullanıcı
dokunuşuyla başlıyor, `pusulaHandler` tek `setAttribute` yapıyor.

---

## 17. Kapladığı yer — **VAR (kabul edilebilir)**

Uygulama paketi (`www/`) **8,8 MB**: `ayat.json` 8,1 MB (Kur'an metni bilerek
gömülü — offline okuma), fontlar 732 KB (26 woff2, yerel; CDN yok), `tz.js`
73 KB. **Korpus paketin İÇİNDE DEĞİL**: `corpus.json` (141 MB), `mihenk.db`
(355 MB), `vektor-*.f32` (~130 MB) sunucu tarafında; `yap-www.mjs` yalnız
`ayat.json`, `sure.json`, `adhan.min.js`, `tz.js`, fontları kopyalıyor.
`node_modules` pakete sızmıyor.

Sınırsız büyüyen depolama yok: istek önbelleği 6 sn dışındakileri buduyor
(`hadis.html:1056-1062`), olay kuyruğu 20'de boşalıyor, hata kaydı cihaz başına
5 ile sınırlı, `yerelSes` haritası kâri değişince temizleniyor.
**En büyük kalem kullanıcı isteğiyle**: kâri indirmesi ≈800 MB — ekranda boyutu
yazılı ve tek düğmeyle silinebiliyor.

---

## 18. Dil değiştir — **BÜYÜK BULGU → düzeltildi**

**Bulgu (bu denetimin en ağır maddesi).** `hadis.html`'de dil şuydu:
`let dil = localStorage.getItem('dil') || 'tr';`
Yani **cihaz dili hiç sorulmuyordu**. Uygulama altı dilli, mağazada `fr/ar/ur/id`
ekran görüntüleriyle duruyor, ama Türkçe bilmeyen **her yeni kullanıcı
uygulamayı Türkçe açıyordu** ve dil düğmeleri Ayarlar diyaloğunun içinde gizli.
"155 kurulum, ~0 kullanım" tablosunun (`SIRADAKI-IS.md`) en olası
açıklamalarından biri budur.

**Uygulanan düzeltme** (`hadis.html:657-678`): `cihazDili()` —
`navigator.languages` sırayla taranıyor, desteklenen ilk dil seçiliyor
(Android'in eski `in` kodu → `id`), desteklenmeyen dilde **`en`**'e düşülüyor
(Türkçe'ye değil). Kullanıcının kendi seçimi (`localStorage.dil`) her zaman
öncelikli. Tarayıcıda doğrulandı: uygulama İngilizce açıldı.

**Eksik çeviri sayımı.** `L` nesnesi programatik olarak çıkarılıp karşılaştırıldı:
**6 dil × 120 anahtar, eksik 0.** İç içe nesnelerde (`vakit`, `inis`, `yon`) de
eksik yok. HTML'deki 52 `data-i18n*` anahtarının tamamı karşılanıyor
(`aria` anahtarları ayrı `ARIA_LABEL` tablosundan, `hadis.html:1007-1014` —
o da 6 dil tam). Fonksiyon değerli anahtarlar `innerHTML`'e basılmıyor
(`hadis.html:2812`), yani ekrana kaynak kodu yazılmıyor.

**RTL.** `dilUygula` `documentElement.dir`'i ayarlıyor (`hadis.html:2796`),
`.arapca` bloğu `direction:rtl`, `.ar-iz` `unicode-bidi:isolate`, yüzen geri
düğmesi RTL'de aynalanıyor, Android `supportsRtl="true"`. Bu denetimde
kapatma `×` ve ayar dişlisi de aynalandı (madde 15).

**Kalan.** Cihaz dili uygulama açıkken değişirse (nadir) yeniden başlatma
gerekir; kullanıcı bir kez dil seçtiyse cihaz dili artık dikkate alınmaz —
doğrusu bu.

---

## 19. Birine ver — **KISMİ**

Anlaşılır: etiketsiz salt-ikon düğme yok — dişli, durdur, geri, dinle ve kimlik
kopyalama düğmelerinin hepsinde `aria-label` var ve **6 dile çevriliyor**
(`hadis.html:1007-1014`, `2814`). Sekme adları kelime ("Bugün / Hadis / Kur'an
/ Ezan"). Giriş kutularının üstünde ne yapılacağını söyleyen etiket var ("Bir
hadis yapıştır — kaynağını ve derecesini göster") ve hazır örnek çipleri var.
"Mihenk … getirir — üretmez" sorumluluk metni her ekranın altında.

**Bulgu (ürün, kod değil).** İlk ekran **"Bugün"** (günün ayeti + hadisi).
Ürünün mağazadaki ana vaadi olan **hadis doğrulama ilk ekranda görünmüyor** —
bir sekme arkasında. Yeni kullanıcı "bu ne işe yarıyor" sorusunun cevabını ilk
bakışta almıyor. Bu, madde 18'deki dil sorunuyla birlikte
`SIRADAKI-IS.md`'deki "indiriyor, açmıyor" tablosunun kod tarafındaki iki
adayı. **ÖNERİ** (mimari/ürün kararı, uygulanmadı): Bugün ekranının en üstüne
tek satırlık "Bir hadis duydun mu? Doğrula →" kartı koy ve `paywall`/`sorgu`
hunisiyle ölç.

---

## 20. Sil ve kur — **VAR**

- **Abonelik**: kimlik `Purchases.configure()` ile RevenueCat'ten geliyor ve
  **keychain'de** duruyor (WebView localStorage'ında değil) — silip kurunca
  aynı kimlik dönüyor (`hadis.html:1761-1793`, gerekçesi yorumda).
- **Geri yükleme yolu görünür**: paywall'da "Satın almaları geri yükle"
  (`hadis.html:568`), ayrıca açılışta `iapPremiumKontrol()` sessizce doğruluyor.
- **Premium asla önbellekten verilmiyor**; `localStorage.premium` açılışta
  siliniyor (`hadis.html:2843`) — yani localStorage kurcalayarak premium
  açılamıyor, ama silinmesi de premium'u kaybettirmiyor.
- **Kaybolan**: okuma yeri (`kuranYer`), dil/kâri tercihi, indirilmiş tilavet
  (≈800 MB, yeniden indirilebilir), ezan konumu. Hesap olmadığı için sunucuda
  saklanacak kullanıcı verisi yok.
- **Ücretsiz kota** cihaz kimliğine bağlı ve Supabase'de kalıcı → silip kuran
  kullanıcı kotayı sıfırlayamaz (kimlik keychain'den döndüğü sürece).

---

# Uygulanan düzeltmelerin listesi

| # | Dosya | Değişiklik |
|---|---|---|
| 4 | `hadis.html:5-8` | viewport'tan `maximum-scale=1, user-scalable=no` kaldırıldı |
| 3 | `hadis.html:10-11, 18` | `color-scheme: dark` meta + CSS, `theme-color` |
| 15 | `hadis.html:66-69` | RTL'de kapatma `×` ve ayar dişlisi sola alındı |
| 18 | `hadis.html:657-678` | **İlk açılışta cihaz dili** (`cihazDili()`), fallback `en` |
| 1 | `hadis.html:1064-1077` + 5 çağrı | `fetchZamanli()`: 25 sn zaman aşımı + çevrimdışı kısa devre |
| 1 | `hadis.html:1178, 1182-1197, 1252-1254, 2139-2145` | "İnternet yok" mesajı + **Tekrar dene** düğmeleri |
| 1 | `hadis.html` (L × 6 dil) | Yeni `cevrimdisi_baslik`, `cevrimdisi` anahtarları |
| 1 | `hadis.html:2110` | Ağ kapalıyken `/api/gunun` 3 kez denemiyor |
| 16 | `hadis.html:1139-1150` | Ezan geri sayımı arka planda duruyor, dönünce yeniden çiziliyor |
| 5 | `hadis.html:470, 489, 505, 2758-2778` | `enterkeyhint`, Enter → ara + klavye kapat, boşluğa dokun → kapat |
| 7 | `hadis.html:2858-2911` | **Donanım geri tuşu**: History tabanlı geri yığını (paywall / Ayarlar / sûre) |
| 11 | `hadis.html:2676-2681` | Ham hata mesajı `alert`'i çevrilmiş metinle değiştirildi + telemetri |
| 11 | `hadis.html:395, 626` | Sürüm etiketi 1.6 → **1.7** (telemetri yanlış sürüme yazıyordu) |
| 11 | `test/guvenlik-regresyon.test.mjs:72-80` | İki sürümdür kırık olan sürüm testi gerçek değerlerle onarıldı |
| 12 | `Info.plist` + 6 × `InfoPlist.strings` | Kullanılmayan `NSLocationAlways*` anahtarları silindi |

`node yap-www.mjs && npx cap copy` çalıştırıldı → `www/`, `ios/App/App/public/`,
`android/app/src/main/assets/public/` güncel. **Sürüm artırılmadı, derleme
alınmadı, commit/push yapılmadı.**

`npm test` → **17/17 geçti.**

---

# Kalan riskler ve ÖNERİLER (uygulanmadı)

1. **Kök ekranda çift-bas-çık yok** (madde 7). `@capacitor/app` kurulup
   `npx cap sync` gerekiyor — bağımlılık + native değişiklik olduğu için bu
   oturumda yapılmadı. Puanlama kapısı açıkken geri tuşu da hâlâ çıkarır.
2. **İlk ekran ürünün vaadini göstermiyor** (madde 19) — ürün kararı.
   Dil düzeltmesiyle birlikte huniden ölçülmeli.
3. **Açılış süresi ölçülmüyor** (madde 2).
4. **`confirm()` RTL dillerde LTR çiziliyor** (madde 9).
5. **iOS 1.7 / Android 1.7.1 sürüm farkı** (madde 11) — bilinçli değilse eşitle.
6. **Cihazda doğrulanmamış**: geri tuşu yığını gerçek Android donanım
   düğmesiyle, Enter tuşu gerçek yumuşak klavyeyle, `color-scheme:dark`'ın
   WKWebView'daki etkisi ve zaman aşımının uçak modundaki davranışı **yalnız
   masaüstü tarayıcıda** test edildi. Mağazaya göndermeden önce
   `npm run sync-ios` + gerçek cihazda bir tur şart.
7. **Dil düzeltmesinin yan etkisi**: bugüne kadar Türkçe açılan mevcut
   kullanıcıların `localStorage.dil`'i zaten yazılı olduğu için onlar
   etkilenmez; yalnız yeni kurulumlar cihaz dilinde açılır. Türkçe kullanıcı
   sayısında değil, TR dışı dillerin kullanım oranında artış beklenmeli.
