/**
 * 「山田さん、石川コシヒカリ20kg、15時まで」のような話し言葉を、入力欄に振り分ける（AIなし・ルール式）。
 * 通信はしません。端末の中だけで動きます。
 *
 * parse(text, ctx) → { name, brand, qty, area, time, kind, paid, usual, dayOffset }
 *   ctx.names  … 過去に入力したお名前（先頭一致で優先して使う）
 *   ctx.areas  … 過去に入力した地域（文中にあれば地域欄へ）
 *   kind: '店頭' | '配達' | null（言及なし）  dayOffset: 0=今日 / 1=明日 / 2=明後日 / null
 *   usual: 「いつもの」と言われたか（前回の注文から埋める合図）
 */
(function (root) {
  'use strict';

  const KANJI = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  function kanjiToNumber(s) {
    // 十五 → 15、二十 → 20、二十五 → 25、百 → 100 など（999まで）
    if (/^[〇一二三四五六七八九]+$/.test(s)) return Number([...s].map((c) => KANJI[c]).join(''));
    let total = 0, cur = 0;
    for (const c of s) {
      if (c === '百') { total += (cur || 1) * 100; cur = 0; }
      else if (c === '十') { total += (cur || 1) * 10; cur = 0; }
      else cur = cur * 10 + KANJI[c];
    }
    return total + cur;
  }

  function normalize(text) {
    let s = String(text || '').normalize('NFKC');
    s = s.replace(/キログラム|キロ/g, 'kg');
    s = s.replace(/[〇一二三四五六七八九十百]+(?=\s*(?:kg|袋|個|本|俵|時|分|丁目|番))/g, (m) => String(kanjiToNumber(m)));
    return s;
  }

  const TIME_PATTERNS = [
    // 1時〜3時半不在 / 13時から15時まで
    /(?:午前|午後)?\d{1,2}時(?:半|\d{1,2}分)?\s*(?:[~〜\-ー]|から)\s*(?:午前|午後)?\d{1,2}時(?:半|\d{1,2}分)?(?:\s*(?:まで(?:いません|いない|不在|留守)?|不在|いません|いない|留守|の間|ごろ|頃|ぐらい))?/,
    // 15時まで / 午後3時 / 3時半ごろ
    /(?:午前|午後|夕方|朝|昼|夜)?\d{1,2}時(?:半|\d{1,2}分)?(?:まで(?:に)?|ごろ|頃|ぐらい|以降|過ぎ|から|不在)?/,
    // 夕方まで / 午前中 / 朝イチ / 急ぎ
    /(?:午前中|午前|午後|夕方|朝イチ|朝一|朝|昼過ぎ|昼|夜|至急|急ぎ|指定なし)(?:まで(?:に)?|ごろ|頃|から)?/
  ];

  const QTY_PATTERNS = [
    /\d+(?:\.\d+)?\s*kg(?:\s*[x×*]\s*\d+|\s*\d+\s*(?:袋|個|本))?(?:\s*\d分(?:づき|つき|搗き)?)?/g,
    /\d+\s*(?:袋|個|本|俵|合|升)/g
  ];

  function cutFirst(text, re) {
    const m = re.exec(text);
    if (!m) return { text, hit: '' };
    return { text: text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length), hit: m[0] };
  }

  function stripEdges(s) {
    let prev;
    do {
      prev = s;
      s = s
        .replace(/^[\s、,，。・]+|[\s、,，。・]+$/g, '')
        .replace(/^(?:の|は|を|で|に)+/, '')
        .replace(/(?:を|で|です|ください|お願い(?:します|いします)?|ね|よ|が|と|の)+$/, '');
    } while (s !== prev);
    return s;
  }

  function parse(input, ctx) {
    ctx = ctx || {};
    const out = { name: '', brand: '', qty: '', area: '', time: '', kind: null, paid: false, usual: false, dayOffset: null };
    let t = normalize(input).trim();
    if (!t) return out;

    // 日付のことば
    let r;
    if ((r = cutFirst(t, /(?:明後日|あさって)の?/)).hit) { out.dayOffset = 2; t = r.text; }
    else if ((r = cutFirst(t, /(?:明日|あした|あす)の?/)).hit) { out.dayOffset = 1; t = r.text; }
    else if ((r = cutFirst(t, /(?:今日|本日)の?/)).hit) { out.dayOffset = 0; t = r.text; }

    // 「〜の注文です」などの前置き
    t = t.replace(/の?ご?注文(?:です|で|を)?/g, ' ');

    // 区分・入金
    if ((r = cutFirst(t, /店頭|取りに来(?:る|られる|ます|てもらう)?|引き取り|引取り|持ち帰り|来店/)).hit) { out.kind = '店頭'; t = r.text; }
    else if ((r = cutFirst(t, /配達|お届け|届け(?:る|て)?/)).hit) { out.kind = '配達'; t = r.text; }
    if ((r = cutFirst(t, /入金済み?|代済み?|支払い?済み?|払い?済み?/)).hit) { out.paid = true; t = r.text; }

    // 時間
    for (const re of TIME_PATTERNS) {
      r = cutFirst(t, re);
      if (r.hit) { out.time = r.hit.replace(/\s+/g, ''); t = r.text; break; }
    }

    // 数量（1つだけなら数量欄へ。複数あるときは銘柄欄にそのまま残す）
    const found = [];
    let scan = t;
    for (const re of QTY_PATTERNS) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(scan))) found.push(m[0]);
      scan = scan.replace(re, ' '); // 同じ場所を2回数えない（20kg10袋 → 1つ）
    }
    if (found.length === 1) {
      const q = found[0];
      t = t.replace(q, ' ');
      out.qty = q.replace(/\s+/g, '').replace(/[x*]/g, '×');
    }

    // 「いつもの」
    if ((r = cutFirst(t, /いつもの|いつも/)).hit) { out.usual = true; t = r.text; }

    // 地域（過去に入力した地域が文中にあれば）
    const areas = (ctx.areas || []).filter((a) => a && a.length >= 2).sort((a, b) => b.length - a.length);
    // お名前：過去のお名前と先頭一致（最長）を優先
    const names = (ctx.names || []).filter(Boolean).sort((a, b) => b.length - a.length);
    const body = t.trim();
    const known = names.find((n) => body.startsWith(normalize(n)));
    let rest;
    if (known) {
      out.name = known;
      rest = body.slice(normalize(known).length);
    } else {
      const chunks = body.split(/[、,，。\n]+|\s+/).filter(Boolean);
      if (!chunks.length) return out;
      const isNameLike = (c) => /(?:さん|様|ちゃん|くん|君|商店|食堂)$/.test(c);
      let idx = chunks.findIndex(isNameLike);
      if (idx < 0) idx = 0;
      if (chunks.length === 1) {
        const m = /^(.*?(?:さん|様))(.+)$/.exec(chunks[0]);
        if (m) { out.name = m[1]; rest = m[2]; }
        else { out.name = chunks[0]; rest = ''; }
      } else {
        out.name = chunks[idx];
        rest = chunks.filter((_, i) => i !== idx).join(' ');
      }
    }

    // 残りから地域と銘柄を分ける
    let leftover = rest;
    const hitArea = areas.find((a) => leftover.includes(normalize(a)));
    if (hitArea) {
      // 「白山」に続く「2丁目」なども地域に含める
      const esc = normalize(hitArea).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(esc + '(?:\\d+丁目|\\d+番地?)?').exec(leftover);
      out.area = m[0]; leftover = leftover.replace(m[0], ' ');
    }
    else if ((r = cutFirst(leftover, /\S*?(?:\d+丁目|\d+番地?|[^\s\d]{1,6}(?:町|区|市|村))\S*/)).hit && !/(?:米|kg|袋)/.test(r.hit)) {
      out.area = r.hit; leftover = r.text;
    }
    out.brand = stripEdges(leftover.replace(/\s+/g, ' '));
    out.name = stripEdges(out.name);
    return out;
  }

  const api = { parse, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OrderParse = api;
})(typeof window !== 'undefined' ? window : this);
