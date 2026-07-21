# Mihenk — Kaynağıyla din rehberi

Hadis doğrulama + Kur'an (meal, semantik arama) + ezan vakti. **TR + EN.**

## Temel ilke
> AI **üretmez, getirir.** Derece (sahih/hasen/zayıf), kaynak ve meal her zaman
> doğrulanmış veritabanından gelir. LLM yalnızca *anlamsal eşleştirme* ve *sorgu*
> için kullanılır — asla hadis/derece/meal/hüküm üretmez.

## Özellikler
- **Hadis Doğrula** — bir hadis yapıştır → Kütüb-i Sitte'de eşleşen metin + âlim derecesi + kaynak. Yoksa dürüst "kanonik kaynaklarda geçmiyor".
- **Konuya Göre (hadis)** — konu/anlam yaz → sahih/hasen hadisler (semantik).
- **Kur'an** — konu ya da *anlamını* yaz → ilgili ayetler (Arapça + okunuş + Diyanet meali + sayfa/cüz), semantik arama.
- **Ezan** — konuma göre namaz vakitleri (Diyanet yöntemi) + geri sayım + kıble.
- **Mevzuat** — halk arasında yaygın, aslı zayıf/olmayan sözler için atıflı, yumuşak uyarı.

## Kurulum & çalıştırma
```bash
npm install
# .env oluştur: ANTHROPIC_API_KEY=... (PORT, MODEL, APP_KEY opsiyonel)
npm run build          # veri + vektörleri üretir (ilk sefer ~30 dk; embedding modeli ~100MB iner)
npm start              # backend :8788
# hadis.html'i tarayıcıda aç
```

`npm run build` iki adım: `build-data` (CDN→corpus.json, ayat.json, sure.json) ve
`build-vectors` (yerel embedding → vektor-*.f32). Bu üretilen dosyalar git'te yok
(bkz .gitignore), tek komutla yeniden üretilir.

## Veri kaynakları
- Hadis/Kur'an metni + derece: **fawazahmed0/hadith-api & quran-api** (jsDelivr CDN, açık).
- Meal: **Diyanet İşleri** (TR) · **Abdel Haleem** (EN). Namaz: **adhan** (Türkiye yöntemi) + **tz-lookup**.
- Embedding: **Xenova/paraphrase-multilingual-MiniLM-L12-v2** (yerel, anahtarsız).

## Dosyalar
| Dosya | Görev |
|---|---|
| `ingest.mjs`, `ingest-kuran.mjs` | CDN → corpus.json / ayat.json (TR+EN+Arapça) |
| `embed.mjs`, `embed-kuran.mjs`, `embed-hadis.mjs` | yerel embedding → vektörler |
| `motor.mjs` | BM25 lexical retrieval (alan-seçilebilir) |
| `mevzuat.json` | atıflı uydurma/zayıf söz tohumu |
| `hadis-api.mjs` | backend :8788 (dogrula, konu, kuran-konu, namaz) |
| `hadis.html` | tek dosya UI (TR/EN, 3 sekme) |

## Bilinen sınırlar / sonraki adımlar
- Fontlar Google Fonts CDN'den (paketleme öncesi yerel bundle şart — offline).
- Nesâî Türkçe edisyonu seyrek. Mevzuat tohumu küçük (âlim incelemesi gerekir).
- **Dağıtım kararı:** backend 100MB embedding modeli yüklüyor → Render free tier zorlanır.
  Seçenekler: (a) paralı tier, (b) vektörleri önceden üret + sorgu embed'ini hosted API'ye
  taşı (Voyage), (c) mobilde client-side embedding. Paketleme (Capacitor) tasarım
  donduktan sonra — bkz Kahve Falı deseni.
