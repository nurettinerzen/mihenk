// Mağaza ekran görüntülerini üretir — altı dil × beş ekran, elle dolaşmadan.
//
// Neden böyle: uygulama bir webview, yani mağaza görüntüsü için simülatörü altı
// kez elle gezmeye gerek yok. www/index.html başsız Chrome'da 1080×1920'de açılıp
// sürülüyor. Tek fark iOS durum çubuğunun olmaması — zaten onu kırpıyorduk.
//
// Kullanım: node ekran-goruntusu.mjs [dil ...]      (varsayılan: altı dilin hepsi)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CIKTI = 'play-gorseller';
const GECICI = '/tmp/mihenk-ekran';

// Ekran görüntüsündeki vakitler bir yere ait olmak zorunda. İstanbul: hem hedef
// pazar hem de vakitler tanıdık gelsin diye.
const KONUM = { lat: 41.0082, lng: 28.9784 };

// Her dil için sorgu ve ekranda görünecek konu. Sorgu ücretsiz kotadan yiyor;
// bu yüzden dil başına TEK sorgu var ve cihaz kimliği dile göre ayrı (günlük
// 5'lik kotaya tek tek takılmasın).
const DILLER = {
  tr: { konu: 'sabır' },
  en: { konu: 'patience' },
  fr: { konu: 'patience' },
  id: { konu: 'sabar' },
  ar: { konu: 'الصبر' },
  ur: { konu: 'صبر' },
};

// Beş ekran: kaydırma ve tıklama adımları sayfanın kendi seçicileriyle.
const EKRANLAR = [
  { ad: '01', adim: `nav('bugun'); await bekle(2500);` },
  { ad: '02', adim: `nav('hadis'); alt('.sekme','mod','konu'); await bekle(400);` },
  { ad: '03', adim: `nav('hadis'); alt('.sekme','mod','konu');
                     document.getElementById('konu').value = KONU;
                     document.getElementById('btnKonu').click();
                     await sonucBekle('sonucKonu');
                     document.getElementById('sonucKonu').scrollIntoView({block:'start'});
                     await bekle(300);` },
  { ad: '04', adim: `nav('kuran'); alt('.ksekme','kmod','oku'); await bekle(900);` },
  { ad: '05', adim: `nav('ezan'); await bekle(1800);` },
];

// index.html'e SADECE ekran görüntüsü için ön yükleme betiği enjekte edilir.
// Gönderilen pakete dokunulmaz: kopya /tmp'de üretilir.
function hazirla(dil, cihaz) {
  rmSync(GECICI, { recursive: true, force: true });
  mkdirSync(GECICI, { recursive: true });
  for (const f of ['adhan.min.js', 'tz.js', 'ayat.json', 'sure.json', 'fonts.css'])
    writeFileSync(join(GECICI, f), readFileSync(join('www', f)));
  mkdirSync(join(GECICI, 'fonts'), { recursive: true });
  for (const f of readdirSafe('www/fonts'))
    writeFileSync(join(GECICI, 'fonts', f), readFileSync(join('www/fonts', f)));

  const html = readFileSync('www/index.html', 'utf8');
  // zoom, yerleşim genişliğini 1080/2,5 = 432 CSS px'e indiriyor.
  const on = `<style>html{zoom:2.5}</style><script>
    localStorage.setItem('dil', ${JSON.stringify(dil)});
    localStorage.setItem('konum', ${JSON.stringify(JSON.stringify(KONUM))});
    localStorage.setItem('cihaz', ${JSON.stringify(cihaz)});
    localStorage.setItem('acildi', '1');
  </script>`;
  // İlk <script>'ten ÖNCE: uygulama başlarken dil ve konum yerinde olmalı.
  writeFileSync(join(GECICI, 'index.html'), html.replace('<script>', on + '<script>'));
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

function cek(dil, ekran, konu, hedef) {
  const surucu = `
    const bekle = (ms) => new Promise(r => setTimeout(r, ms));
    const KONU = ${JSON.stringify(konu)};
    const nav = (b) => document.querySelector('.unav[data-bol="'+b+'"]').click();
    const alt = (sinif, veri, deger) =>
      document.querySelector(sinif+'[data-'+veri+'="'+deger+'"]').click();
    const sonucBekle = async (id) => {
      for (let i = 0; i < 60; i++) {
        const el = document.getElementById(id);
        if (el && el.classList.contains('gorunur') && !el.querySelector('.yukleniyor')) return;
        await bekle(500);
      }
    };
    (async () => { ${ekran.adim} })();
  `;
  writeFileSync(join(GECICI, 'surucu.js'), surucu);
  const html = readFileSync(join(GECICI, 'index.html'), 'utf8');
  writeFileSync(join(GECICI, 'kare.html'),
    html.replace('</body>', '<script src="surucu.js"></script></body>'));

  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    // Telefon görünümü: 360×640 mantıksal piksel (yaygın Android boyutu) × 3 =
    // 1080×1920. 1080 genişlikte açmak sayfayı masaüstü sayıp içeriği ortada dar
    // bir sütuna sıkıştırıyordu.
    // Başsız Chrome'da --force-device-scale-factor ile yerleşim genişliği
    // öngörülemez oluyordu (içerik sağdan kesiliyordu). Onun yerine pencere
    // 1080x1920 ve sayfaya CSS zoom 2,5 uygulanıyor: yerleşim 432 CSS px
    // (telefon) olarak akıyor, çıktı tam 1080x1920.
    '--window-size=1080,1920', '--force-device-scale-factor=1',
    // Sorgu ve tilavet listesi ağdan geliyor; ekran hazır olana kadar sanal zaman.
    '--virtual-time-budget=45000',
    `--screenshot=${hedef}`,
    `file://${GECICI}/kare.html`,
  ], { stdio: 'pipe' });
}

const istenen = process.argv.slice(2).filter(d => DILLER[d]);
const liste = istenen.length ? istenen : Object.keys(DILLER);
mkdirSync(CIKTI, { recursive: true });

for (const dil of liste) {
  const { konu } = DILLER[dil];
  // Dil başına ayrı cihaz: günlük 5 ücretsiz sorgu kotası tek kimlikte tükenmesin.
  hazirla(dil, `ekran-goruntusu-${dil}`);
  const klasor = join(CIKTI, dil);
  mkdirSync(klasor, { recursive: true });
  for (const e of EKRANLAR) {
    const hedef = join(process.cwd(), klasor, `${e.ad}.png`);
    cek(dil, e, konu, hedef);
    console.log(existsSync(hedef) ? `✅ ${dil}/${e.ad}.png` : `❌ ${dil}/${e.ad}.png`);
  }
}
