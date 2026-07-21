// ingest-kuran.mjs — Kur'an ayet korpusunu inşa eder (Arapça + Türkçe meal).
// Kaynak: fawazahmed0/quran-api (CDN). Meal = Diyanet İşleri (resmî). Arapça = Uthmani (hafs).
// İLKE: Meal GETİRİLİR, üretilmez — yerleşik resmî çeviri. LLM meal yazmaz.
//
// Çıktı: ayat.json → [{id, sure, sureAd, ayet, ar, tr, kaynak}]  ve  sure.json → [{no, ad, iniş, ayetSayisi}]

import { writeFile } from 'node:fs/promises';

const CDN = 'https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1';

// 114 sûrenin standart Türkçe adları (Diyanet sırası).
const AD = ['Fâtiha','Bakara','Âl-i İmrân','Nisâ','Mâide','En\'âm','A\'râf','Enfâl','Tevbe','Yûnus','Hûd','Yûsuf','Ra\'d','İbrâhîm','Hicr','Nahl','İsrâ','Kehf','Meryem','Tâhâ','Enbiyâ','Hac','Mü\'minûn','Nûr','Furkân','Şuarâ','Neml','Kasas','Ankebût','Rûm','Lokmân','Secde','Ahzâb','Sebe\'','Fâtır','Yâsîn','Sâffât','Sâd','Zümer','Mü\'min','Fussilet','Şûrâ','Zuhruf','Duhân','Câsiye','Ahkâf','Muhammed','Fetih','Hucurât','Kâf','Zâriyât','Tûr','Necm','Kamer','Rahmân','Vâkıa','Hadîd','Mücâdele','Haşr','Mümtehine','Saff','Cum\'a','Münâfikûn','Teğâbün','Talâk','Tahrîm','Mülk','Kalem','Hâkka','Meâric','Nûh','Cin','Müzzemmil','Müddessir','Kıyâme','İnsân','Mürselât','Nebe\'','Nâziât','Abese','Tekvîr','İnfitâr','Mutaffifîn','İnşikâk','Bürûc','Târık','A\'lâ','Gâşiye','Fecr','Beled','Şems','Leyl','Duhâ','İnşirâh','Tîn','Alak','Kadir','Beyyine','Zilzâl','Âdiyât','Kâria','Tekâsür','Asr','Hümeze','Fîl','Kureyş','Mâûn','Kevser','Kâfirûn','Nasr','Tebbet','İhlâs','Felak','Nâs'];

async function getir(ed) {
  const r = await fetch(`${CDN}/editions/${ed}.min.json`);
  if (!r.ok) throw new Error(`${ed} indirilemedi (${r.status})`);
  return (await r.json()).quran;
}

async function main() {
  console.log('Kur\'an indiriliyor (TR meal + EN meal + arapça + okunuş + info)...');
  const [tur, eng, ara, okunusR, infoR] = await Promise.all([
    getir('tur-diyanetisleri'),
    getir('eng-abdelhaleem'),
    getir('ara-quranuthmanihaf'),
    getir('tur-latinalphabet').catch(() => null),
    fetch(`${CDN}/info.json`).then(r => r.json()),
  ]);
  const okunusMap = new Map((okunusR || []).map(a => [`${a.chapter}:${a.verse}`, a.text]));
  const engMap = new Map((eng || []).map(a => [`${a.chapter}:${a.verse}`, a.text]));

  // info.json → sure meta
  const chapters = infoR.chapters || [];
  const sure = chapters.map((c, i) => ({
    no: c.chapter,
    ad: AD[i] || c.name,
    adAr: c.arabicname || '',
    inis: /mec|mek/i.test(c.revelation || '') ? 'Mekke' : 'Medine',
    ayetSayisi: (c.verses || []).length,
  }));

  // Arapçayı chapter:verse ile indeksle
  const araMap = new Map(ara.map(a => [`${a.chapter}:${a.verse}`, a.text]));
  // info.json'dan her ayetin sayfa (Mushaf) ve cüz bilgisi + İngilizce sure adı
  const meta = new Map();
  const adEn = new Map();
  for (const c of chapters) {
    adEn.set(c.chapter, (c.name || '').replace(/^Al-/i, 'Al-'));
    for (const v of (c.verses || [])) meta.set(`${c.chapter}:${v.verse}`, { sayfa: v.page, cuz: v.juz });
  }

  const ayat = tur.map((a, i) => {
    const ad = AD[a.chapter - 1] || `Sure ${a.chapter}`;
    const m = meta.get(`${a.chapter}:${a.verse}`) || {};
    return {
      id: `k${i}`,
      sure: a.chapter,
      sureAd: ad,
      sureAdEn: adEn.get(a.chapter) || `Surah ${a.chapter}`,
      ayet: a.verse,
      sayfa: m.sayfa || null,
      cuz: m.cuz || null,
      ar: araMap.get(`${a.chapter}:${a.verse}`) || '',
      okunus: okunusMap.get(`${a.chapter}:${a.verse}`) || '',
      tr: a.text,
      en: engMap.get(`${a.chapter}:${a.verse}`) || '',
      kaynak: `${ad} ${a.verse}`,
      kaynakEn: `${adEn.get(a.chapter) || 'Surah ' + a.chapter} ${a.verse}`,
    };
  });

  await writeFile(new URL('./ayat.json', import.meta.url), JSON.stringify(ayat));
  await writeFile(new URL('./sure.json', import.meta.url), JSON.stringify(sure));
  const eksikAr = ayat.filter(a => !a.ar).length;
  console.log(`ayat.json: ${ayat.length} ayet (arapçasız: ${eksikAr})`);
  console.log(`sure.json: ${sure.length} sure`);
  console.log(`örnek: ${ayat[254 + 6].kaynak} — ${ayat[254 + 6].tr.slice(0, 60)}...`);
}

main().catch(e => { console.error(e); process.exit(1); });
