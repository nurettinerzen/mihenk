// motor.mjs — Korpus üzerinde anahtarsız lexical retrieval (BM25).
// LLM'e gitmeden önce adayları daraltır. Derece/hüküm ÜRETMEZ — sadece metin bulur.

import { readFileSync } from 'node:fs';

// --- Türkçe normalizasyon: küçült + aksan-katla, böylece yazım farkına dayanıklı eşleşme
const HARITA = { 'ı':'i','İ':'i','I':'i','ş':'s','Ş':'s','ç':'c','Ç':'c','ğ':'g','Ğ':'g','ü':'u','Ü':'u','ö':'o','Ö':'o','â':'a','î':'i','û':'u','é':'e' };
export function normalize(s) {
  return (s || '')
    .replace(/[ıİIşŞçÇğĞüÜöÖâîûé]/g, c => HARITA[c] || c)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(('ve bir bu da de o ki ile için gibi ama fakat çok daha en her hiç ne ya mi mı mu mü ise diye olan olarak sonra göre kadar ancak yani şu şey ben sen biz siz onlar dedi buyurdu resulullah peygamber sallallahu aleyhi vesellem allah anlatiyor rivayet nakleder bize haber verdi').split(' ').map(normalize));

function tokenize(s) {
  return normalize(s).split(' ').filter(t => t.length > 2 && !STOPWORDS.has(t));
}

export class Motor {
  // kaynak: dosya yolu (string) VEYA korpus dizisi. alan: hangi dil alanı indekslensin (tr/en).
  constructor(kaynak, alan = 'tr') {
    this.corpus = typeof kaynak === 'string' ? JSON.parse(readFileSync(kaynak, 'utf8')) : kaynak;
    this.alan = alan;
    this.N = this.corpus.length;
    this.df = new Map();          // token -> kaç dokümanda geçiyor
    this.docs = [];               // {tf: Map, len}
    this.avgLen = 0;
    let toplamLen = 0;

    for (const h of this.corpus) {
      const toks = tokenize(h[alan] || '');
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      this.docs.push({ tf, len: toks.length });
      toplamLen += toks.length;
    }
    this.avgLen = toplamLen / this.N;
  }

  idf(t) {
    const n = this.df.get(t) || 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }

  // BM25 ile top-k aday döndür. filtre: (h)=>bool ile derece süzülebilir.
  ara(sorgu, k = 8, filtre = null) {
    const qToks = tokenize(sorgu);
    if (!qToks.length) return [];
    const K1 = 1.5, B = 0.75;
    const puanlar = [];
    for (let i = 0; i < this.N; i++) {
      if (filtre && !filtre(this.corpus[i])) continue;
      const doc = this.docs[i];
      let s = 0;
      for (const t of qToks) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const idf = this.idf(t);
        s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * doc.len / this.avgLen));
      }
      // Hafif tie-break: derecesi belirsiz kayıt, dereceli paralelinin gerisinde kalsın.
      if (this.corpus[i].derece === 'bilinmiyor') s *= 0.92;
      if (s > 0) puanlar.push([i, s]);
    }
    puanlar.sort((a, b) => b[1] - a[1]);
    return puanlar.slice(0, k).map(([i, s]) => ({ ...this.corpus[i], _skor: +s.toFixed(2) }));
  }
}
