import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isabet } from '../degerlendirme-calistir.mjs';

const oku = (ad) => readFile(new URL(`../${ad}`, import.meta.url), 'utf8');
const [html, api, depo, dbYap, gradle, pbx, olay, androidManifest, paket, podLock] = await Promise.all([
  oku('hadis.html'), oku('hadis-api.mjs'), oku('depo.mjs'), oku('db-yap.mjs'),
  oku('android/app/build.gradle'), oku('ios/App/App.xcodeproj/project.pbxproj'), oku('olay.mjs'),
  oku('android/app/src/main/AndroidManifest.xml'), oku('package.json'), oku('ios/App/Podfile.lock'),
]);

test('web Kur’an ve hesaplama varlıkları statik sunucuda açık ve istemci HTTP hatasını denetliyor', () => {
  for (const ad of ['adhan.min.js', 'tz.js', 'ayat.json', 'sure.json']) assert.match(api, new RegExp(`'/${ad.replace('.', '\\.')}'`));
  assert.match(html, /if\(!r\.ok\) throw new Error/);
});

test('Plus yalnız Mihenk ürünlerinden biri aktifse açılır', () => {
  for (const id of ['mihenk_plus_aylik', 'mihenk_plus_yillik']) {
    assert.match(html, new RegExp(id)); assert.match(api, new RegExp(id));
  }
  assert.doesNotMatch(html, /else\s*\{\s*await premiumYap\(\)/);
  assert.ok(html.indexOf("olay('satinalma',{durum:'tamam'") > html.indexOf("if(!aktif) throw"));
  assert.match(api, /PLUS_URUNLER\.has\(urun\)/);
});

test('kalite ölçüm kimlikleri RevenueCat müşteri kaydı oluşturmaz', () => {
  assert.match(api, /\^\(test-\|degerlendirme-\|ekran-goruntusu-\|teshis-\)/);
});

test('LLM tarafından yazılmış fark cümlesi kullanıcıya taşınmaz', () => {
  assert.doesNotMatch(api, /farkNotu/);
  assert.doesNotMatch(html, /j\.farkNotu/);
});

test('ezan planı uygulama başlangıcında yenilenir ve Android kesin alarmı denetlenir', () => {
  assert.match(html, /checkExactNotificationSetting/);
  assert.match(html, /changeExactNotificationSetting/);
  assert.match(html, /ANDROID\(\)\?30:12/);
  assert.match(html, /bildirimleriPlanla\(k\.lat,k\.lng,true\)/);
  assert.equal((html.match(/sound:\s*'ezan\.caf'/g) || []).length, 2);
  assert.match(pbx, /ezan\.caf in Resources/);
});

test('konum tekrar izin istemeden yenilenir ve iOS pusulası kullanıcı dokunuşunda başlar', () => {
  assert.match(html, /async function konumIzniVarMi\(\)/);
  assert.match(html, /geo\.checkPermissions\(\)/);
  assert.match(html, /if\(!\(await konumIzniVarMi\(\)\)\) return false/);
  assert.match(html, /const yenilendi=await konumSessizYenile\(\)/);
  assert.match(html, /if\(b\.dataset\.bol==='ezan'\)\{[\s\S]*?if\(ezanVeri\)\{[\s\S]*?pusulaBaslat\(\)/);
  const ezanBaslatGovde=html.slice(html.indexOf('async function ezanBaslat()'),html.indexOf('// Canlı kıble pusulası'));
  assert.ok(ezanBaslatGovde.indexOf('pusulaBaslat()') < ezanBaslatGovde.indexOf('await konumAl()'));
  const geriYukleGovde=html.slice(html.indexOf('(async function konumuGeriYukle()'),html.indexOf('dilUygula(dil)'));
  assert.doesNotMatch(geriYukleGovde,/pusulaBaslat\(\)/);
});

test('Ezan sekmesi konumu önce, bildirimi yalnız başarılı konumdan sonra teklif eder', () => {
  for (const dil of ['tr','en','fr','id','ar','ur']) assert.match(html, new RegExp(`\\n  ${dil}:\\{kb:`));
  assert.match(html, /dir=\"'\+\(RTL\(dil\)\?'rtl':'ltr'\)\+'\"/);
  assert.match(html, /if\(b\.dataset\.bol==='ezan'\)\{[\s\S]*?ezanIzinAkisiBaslat\(\)/);
  const akis=html.slice(html.indexOf('async function ezanIzinAkisiBaslat()'),html.indexOf('async function ezanBaslat()'));
  assert.ok(akis.indexOf('k=await konumAl()') < akis.indexOf('await ezanBildirimTeklifEt(k)'));
  assert.match(akis, /catch\(e\)\{[\s\S]*?return; \/\/ Konum olmadan boş bir bildirim aboneliği açmayız\./);
  assert.match(html, /localStorage\.getItem\('bildirim'\)!==null/);
  assert.match(html, /let ezanIzinAkisiAcik=false, ezanIzinAkisiBuOturum=false/);
  assert.doesNotMatch(html, /localStorage\.setItem\('karsilama'/);
  const teklif=html.slice(html.indexOf('async function ezanBildirimTeklifEt(k)'),html.indexOf('async function ezanIzinAkisiBaslat()'));
  assert.match(teklif, /bildirimAcKapa\(true\)/);
  assert.match(teklif, /bildirimleriPlanla\(k\.lat,k\.lng,true\)/);
});

test('sürüm numaraları mağaza hedefleri ve istemcide tutarlıdır', () => {
  // Bu test 1.5'te kalmıştı ve iki sürümdür KIRIK koşuyordu; kırık olduğu için
  // istemcideki "Mihenk 1.6" etiketinin 1.7 derlemesiyle birlikte gitmesini
  // yakalayamadı. SURUM_ETIKET doğrudan telemetriye yazıldığı için hatalar yanlış
  // sürüme kaydediliyordu. Sürüm artırırken bu dört satır birlikte güncellenmeli.
  assert.match(html, /surum:'1\.7'/); assert.match(html, /Mihenk 1\.7/);
  assert.match(gradle, /versionCode 17/); assert.match(gradle, /versionName "1\.7"/);
  assert.equal((pbx.match(/CURRENT_PROJECT_VERSION = 42;/g) || []).length, 2);
  assert.equal((pbx.match(/MARKETING_VERSION = 1\.7;/g) || []).length, 2);
});

test('Mobil ödeme kitaplıkları güncel, ilan edilen foreground service gerçekten yoksa izin de yoktur', () => {
  assert.match(paket, /"@revenuecat\/purchases-capacitor": "\^11\.3\.2"/);
  assert.match(podLock, /RevenuecatPurchasesCapacitor \(11\.3\.2\)/);
  assert.match(podLock, /PurchasesHybridCommon \(17\.25\.0\)/);
  assert.doesNotMatch(androidManifest, /android\.permission\.FOREGROUND_SERVICE/);
});

test('arama token ortasını Arapça konu isabeti saymaz', () => {
  assert.equal(isabet('سَمِعَ الْعِرْبَاضَ بْنَ سَارِيَةَ', ['ربا']), false);
  assert.equal(isabet('حَرَّمَ الرِّبَا', ['ربا']), true);
  assert.equal(isabet('Sabrah adlı râvi', ['sabr'], ['sabrah']), false);
});

test('günün havuzu önceki hadise gönderme yapan içerikleri eler', () => {
  assert.match(dbYap, /hadisin \(\?:bir \)\?benzeri/);
});

test('analitik cihaz kimliğini özetler, saklama ve disk tavanı uygular', () => {
  assert.match(olay, /createHash\('sha256'\)/);
  assert.match(olay, /OLAY_SAKLAMA_GUN \|\| 90/);
  assert.match(olay, /OLAY_GUNLUK_MAX_MB \|\| 20/);
  assert.match(api, /OLAY_IP_RATE_LIMIT/);
  assert.match(api, /createHash\('sha256'\).*uzunluk/s);
});

test('Arapça hadis eşleşmesi token ortası substring kullanmaz', () => {
  assert.doesNotMatch(depo, /arMi \? `%\$\{v\}%`/);
  assert.match(depo, /arOnEk/);
});
