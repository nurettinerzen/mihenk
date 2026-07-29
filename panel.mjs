// /panel?k=… — analitik özetinin tek dosyalık gösterimi.
// Dış bağımlılık yok; veriyi sunucu doğrudan sayfaya gömer (ikinci istek, CORS,
// anahtarın tarayıcı geçmişinde ikinci kez dolaşması derdi olmasın).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const kutu = (baslik, icerik) => `<section><h2>${esc(baslik)}</h2>${icerik}</section>`;

function tablo(basliklar, satirlar) {
  if (!satirlar.length) return '<p class="bos">veri yok</p>';
  return `<table><thead><tr>${basliklar.map(b => `<th>${esc(b)}</th>`).join('')}</tr></thead><tbody>${
    satirlar.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="s"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

// Nesneyi çoktan aza sıralı tabloya çevirir.
const dagilim = (o, ad) => tablo([ad, 'adet'], Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]));

function huniCiz(h) {
  const en = h.acan || 1;
  const adim = [
    ['Uygulamayı açtı', h.acan],
    ['Sorgu yaptı', h.sorguYapan],
    ['Paywall gördü', h.paywallGoren],
    ['Satın almayı başlattı', h.satinAlmaBaslatan],
    ['Abone oldu', h.abone],
  ];
  return `<div class="huni">${adim.map(([ad, n], i) => {
    const yuzde = Math.round(n / en * 100);
    const onceki = i ? adim[i - 1][1] : n;
    const gecis = onceki ? Math.round(n / onceki * 100) : 0;
    return `<div class="h-satir"><div class="h-ad">${esc(ad)}</div>
      <div class="h-bar"><div style="width:${Math.max(yuzde, 1)}%"></div></div>
      <div class="h-sayi">${n} <span>· %${yuzde}${i ? ` · bir öncekinden %${gecis}` : ''}</span></div></div>`;
  }).join('')}</div>`;
}

export function panelHtml(o) {
  const g = o.gunluk || [];
  const enYuksek = Math.max(1, ...g.map(x => x.cihaz));
  const cizgi = g.map(x =>
    `<div class="c" title="${esc(x.gun)}: ${x.cihaz} cihaz, ${x.sorgu} sorgu">
       <div class="c-bar" style="height:${Math.round(x.cihaz / enYuksek * 100)}%"></div>
       <div class="c-et">${esc(x.gun.slice(5))}</div></div>`).join('');

  const et = o.eldeTutma || {};
  const tutmaSatir = (ad, r) => r ? [ad, `${r.donen}/${r.kohort}`, `%${r.oran}`] : [ad, '—', '—'];

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Mihenk — kullanım paneli</title><style>
:root{color-scheme:dark;--bg:#0b100e;--yuzey:#121a16;--cizgi:#1f2c25;--metin:#e8efe9;--soluk:#8fa398;--zumrut:#4dd6a0;--pirinc:#e4c98a}
*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--bg);color:var(--metin);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:900px;margin-inline:auto}
h1{font-size:22px;margin:0 0 2px}.alt{color:var(--soluk);font-size:13px;margin:0 0 22px}
section{background:var(--yuzey);border:1px solid var(--cizgi);border-radius:14px;padding:14px 16px;margin-bottom:14px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--zumrut);margin:0 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--soluk);font-weight:500;font-size:12px;padding:4px 6px;border-bottom:1px solid var(--cizgi)}
td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.04)}td.s{text-align:right;color:var(--pirinc);font-variant-numeric:tabular-nums}
.bos{color:var(--soluk);font-size:13px;margin:2px 0}
.ozet{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.ozet div{background:#0e1613;border:1px solid var(--cizgi);border-radius:10px;padding:10px 12px}
.ozet b{display:block;font-size:22px;color:var(--pirinc);font-variant-numeric:tabular-nums}
.ozet span{font-size:12px;color:var(--soluk)}
.huni{display:flex;flex-direction:column;gap:8px}
.h-satir{display:grid;grid-template-columns:150px 1fr 190px;gap:10px;align-items:center;font-size:13px}
.h-bar{height:20px;background:#0e1613;border-radius:6px;overflow:hidden}
.h-bar div{height:100%;background:linear-gradient(90deg,var(--zumrut),#2f8f6b)}
.h-sayi{text-align:right;color:var(--pirinc);font-variant-numeric:tabular-nums}
.h-sayi span{color:var(--soluk);font-size:11.5px}
.grafik{display:flex;align-items:flex-end;gap:3px;height:120px}
.c{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.c-bar{background:var(--zumrut);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.c-et{font-size:9px;color:var(--soluk);text-align:center;margin-top:3px;white-space:nowrap;overflow:hidden}
.ikili{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){.ikili{grid-template-columns:1fr}.h-satir{grid-template-columns:110px 1fr;grid-template-areas:"ad bar" "sayi sayi"}
  .h-ad{grid-area:ad}.h-bar{grid-area:bar}.h-sayi{grid-area:sayi;text-align:left}}
</style></head><body>
<h1>Mihenk — kullanım paneli</h1>
<p class="alt">${esc(o.aralik)} · ${o.toplamOlay} olay · veri ${o.disk?.kalici ? 'kalıcı diskte' : '<b style="color:#e88">GEÇİCİ — disk bağlı değil, yeniden başlatınca silinir</b>'}</p>

${kutu('Özet', `<div class="ozet">
  <div><b>${o.toplamCihaz}</b><span>cihaz</span></div>
  <div><b>${g.at(-1)?.cihaz ?? 0}</b><span>bugün aktif</span></div>
  <div><b>${g.reduce((a, x) => a + x.yeni, 0)}</b><span>yeni cihaz</span></div>
  <div><b>${g.reduce((a, x) => a + x.sorgu, 0)}</b><span>sorgu</span></div>
  <div><b>${o.huni?.abone ?? 0}</b><span>abone</span></div>
</div>`)}

${kutu('Günlük aktif cihaz', `<div class="grafik">${cizgi || '<p class="bos">veri yok</p>'}</div>`)}

${kutu('Huni — kaç kişi nereye kadar geldi', huniCiz(o.huni || {}))}

<div class="ikili">
${kutu('Ekranlar — kaç kez, ne kadar kalındı', tablo(['ekran', 'kez', 'ort. sn', 'toplam dk'],
    Object.entries(o.ekran || {}).sort((a, b) => b[1].kez - a[1].kez).map(([k, v]) => [k, v.kez, v.ortSn, v.toplamDk])))}
${kutu('Elde tutma', tablo(['gün', 'dönen/kohort', 'oran'], [tutmaSatir('Ertesi gün (D1)', et.d1), tutmaSatir('7. gün (D7)', et.d7)]))}
</div>

<div class="ikili">
${kutu('Sorgu türü', dagilim(o.sorguTur, 'tür'))}
${kutu('Sonuç', dagilim(o.sonucTur, 'tür/durum'))}
</div>

<div class="ikili">
${kutu('Paywall nereden açıldı', dagilim(o.paywallKaynak, 'kaynak'))}
${kutu('Satın alma akışı', dagilim(o.satinalma, 'durum'))}
</div>

<div class="ikili">
${kutu('Plan', dagilim(o.plan, 'plan'))}
${kutu('Paylaşım', dagilim(o.paylas, 'tür'))}
</div>

<div class="ikili">
${kutu('Dil', dagilim(o.dil, 'dil'))}
${kutu('Saat dilimi (ülke yerine)', dagilim(o.tz, 'tz'))}
</div>

<div class="ikili">
${kutu('Tilavet indirme', dagilim(o.kariIndir, 'durum'))}
${kutu('En çok çalınan sûre', dagilim(o.oynat, 'sûre'))}
</div>

<div class="ikili">
${kutu('Ezan bildirimi', tablo(['durum', 'adet'], [['Açan', o.bildirim?.acan ?? 0], ['Kapatan', o.bildirim?.kapatan ?? 0]]))}
${kutu('İstemci hataları', dagilim(o.hata, 'yer'))}
</div>

${kutu('Sürüm', dagilim(o.surum, 'sürüm'))}

${kutu('Günlük döküm', tablo(['gün', 'cihaz', 'yeni', 'sorgu', 'paywall', 'satış', 'olay'],
    g.slice().reverse().map(x => [x.gun, x.cihaz, x.yeni, x.sorgu, x.paywall, x.satis, x.olay])))}

<p class="alt">Uygulama silme, App Store gösterim/tıklama ve kurulum sayıları burada değil —
onlar yalnızca Apple'da var (App Store Connect → Analytics). Bu panel uygulamanın içini gösterir.</p>
</body></html>`;
}
