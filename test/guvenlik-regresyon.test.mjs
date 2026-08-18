import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isabet } from '../degerlendirme-calistir.mjs';

const oku = (ad) => readFile(new URL(`../${ad}`, import.meta.url), 'utf8');
const [html, api, depo, dbYap, gradle, pbx, olay] = await Promise.all([
  oku('hadis.html'), oku('hadis-api.mjs'), oku('depo.mjs'), oku('db-yap.mjs'),
  oku('android/app/build.gradle'), oku('ios/App/App.xcodeproj/project.pbxproj'), oku('olay.mjs'),
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
});

test('sürüm numaraları mağaza hedefleri ve istemcide tutarlıdır', () => {
  assert.match(html, /surum:'1\.5'/); assert.match(html, /Mihenk 1\.5/);
  assert.match(gradle, /versionCode 10/); assert.match(gradle, /versionName "1\.5"/);
  assert.equal((pbx.match(/CURRENT_PROJECT_VERSION = 36;/g) || []).length, 2);
  assert.equal((pbx.match(/MARKETING_VERSION = 1\.5;/g) || []).length, 2);
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
