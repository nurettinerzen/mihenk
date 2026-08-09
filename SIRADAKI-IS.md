# Mihenk — sıradaki iş (9 Ağustos 2026)

## Bugün olan
- 8 Ağustos'taki **10 dosyalık düzeltmenin hiçbiri commit edilmemişti**; `autoDeploy` GitHub `main`'den deploy ettiği için o günkü deploy **5 Ağustos kodunu geri kurdu**. 9 Ağustos'ta commit edilip push edildi (`016b9e2`).
- Doğrulandı: **mevzuat sözlüğü canlıya çıktı** — "Vatan sevgisi imandandır" artık `bulundu: true`, `derece: mevzu`, "Aslı sabit değil". Önceden bulunamıyordu.
- **Render Starter'a alındı** ($7/ay). 7,5 saat kesintisiz uptime ölçüldü, yanıtlar 0,18–0,31 sn. **32,8 saniyelik soğuk açılış bitti.**
- `render.yaml`'a `/veri` mount'lu 1 GB disk tanımı eklendi ve push edildi.

## HEMEN DOĞRULA
```
curl "https://mihenk-api.onrender.com/panel.json?gun=1&k=<OLCUM_ANAHTAR>"
```
→ **`disk.kalici` `true` olmalı.** Push öncesi `false`'tu (`dizin: "./veri/olay"` = konteyner FS, her deploy'da siliniyordu).

`false` görüyorsan Blueprint diski uygulamamış demektir; Render panelinden servise elle disk ekle (mount path `/veri`, 1 GB). Bu olmadan **kota ve analitik her deploy'da sıfırlanır** ve paywall yine hiç tetiklenmez.

Ayrıca `/olcum?k=…` çıktısında `kota.kalici: true` görmelisin.

## Gerçek veri — asıl sorun burada
| | |
|---|---|
| RevenueCat kurulum sayısı | **155** (portföyün en büyüğü) |
| 7,5 saatlik canlı pencerede gerçek istek | **1** |
| Gerçek sorgu (`/api/konu`, `/api/dogrula`) | **0** |
| Paywall / satın alma | **0 / 0** |

**İnsanlar indiriyor, açmıyor.** Bu bir kod sorunu değil; uygulamanın mağazada ne vaat ettiği ve ilk açılışta ne gösterdiğiyle ilgili.

⚠️ Mağazadaki **1.1'de telemetri hiç yok** (`grep -c 'olay(' ` = 0). Huni verisi ancak **1.3 yayına girince** gelmeye başlayacak. 1.3 şu an incelemede.

Tarihsel yedekteki tek huni (`veri-yedek/panel-365gun-20260805.json`, 29 Tem, 12 cihaz — çoğu kendi testin):
açan 12 → sorgu yapan 7 → paywall gören 2 → satın alma başlatan **0**.

## YAPILACAK — sırayla

### 1. Diski doğrula (yukarıda)

### 2. 1.3 yayına girsin, sonra ölç
1.3'te olanlar: paywall hunisi (`paywall {kaynak,sebep,kalan,urunHazir}`, `satinalma {durum:urun-yok|iptal|hata}`), açılış önbelleği (ekran anında çiziliyor, 0,1 ms), `pw_yakinda` yerine "Mağazaya bağlanamadık + Tekrar dene", kâri seçimi ve çevrimdışı indirme premium'a alındı.

### 3. Mağaza sayfası / ilk açılış — asıl iş
155 kurulum, ~0 kullanım. Bakılacaklar:
- Mağaza açıklaması ne vaat ediyor, uygulama ilk açılışta onu gösteriyor mu?
- İlk ekran "Bugün" — kullanıcı ne yapacağını anlıyor mu? Hadis doğrulama ürünün ana vaadi ama ilk ekranda görünüyor mu?
- Ekran görüntüleri: `fr-FR`, `ur-PK`, `ar-SA` için **yok** (en/tr olanlar gösteriliyor).

### 4. Korpus recall açığı — ayrı ve ölçümlü iş
Bazı **sahih** hadisler BM25 ilk 8'e giremediği için doğrulamada bulunamıyor:
- "Komşusu açken tok yatan bizden değildir" → bulunamıyor
- "Temizlik imanın yarısıdır" → yanlış eşleşme (0,92 güvenle "iman altmış küsur şubedir" dönüyor)
- "Müslüman elinden ve dilinden emin olunandır", "Kolaylaştırın zorlaştırmayın" → bulunamıyor

**Dini içerikte emin tonla yanlış cevap en ağır hata türü.** Mevzuat sözlüğünden bağımsız bir aday-getirme sorunu; `degerlendirme-konu.json` + `degerlendirme-calistir.mjs` ile ölçerek çözülmeli.

### 5. RevenueCat
Projede **hiç offering tanımlı değil**. Kod `getProducts` kullandığı için şu an kırmızı değil ama tutarsız — bir `default` offering açıp yıllık/aylık paketleri koy.

## Ölçüm anahtarları
- `OLCUM_ANAHTAR` → Render panelinde (`render.yaml`'da `generateValue: true`)
- Panel: `/panel.json?gun=30&k=…` · özet: `/olcum?k=…`
