(() => {
  'use strict';

  // ------------------------------------------------------------ 基本部品
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('orders.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('orders.' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動作は続ける */ } }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => dstr(new Date());
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return dstr(new Date(y, m - 1, d + n)); };
  const nowStr = () => { const d = new Date(); return `${dstr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const parseTs = (s) => new Date(String(s).replace(' ', 'T')).getTime();
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const fmtDate = (s) => { const [y, m, d] = s.split('-').map(Number); return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ 状態
  const base = window.APP_CONFIG || {};
  const saved = store.get('cfg', {});
  const cfg = { apiUrl: saved.apiUrl || base.apiUrl || '', key: saved.key || '', user: saved.user || '' };
  let rows = store.get('rows', []);
  let queue = store.get('queue', []);       // まだサーバーに送れていない操作
  let suggest = store.get('suggest', { names: [], brands: [], areas: [] });
  let notes = store.get('notes', {}); // 日ごとのメモ { '2026-11-03': '臨時休業' }
  let masters = store.get('masters', { customers: [], fixes: [] }); // 顧客シートと補正シートの写し
  let mh = store.get('mh', '');
  let backupAt = store.get('backup', '');
  const ui = Object.assign({ open: false, void: false, doneOnly: false }, store.get('ui', {}));
  let tab = 'list';
  let viewDate = today();
  let lastSync = 0;
  let status = 'idle'; // idle | sync | ok | off
  let dragState = null, pendingRender = false;
  let chkMonth = viewDate.slice(0, 7);
  const mondayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return addDays(s, -((new Date(y, m - 1, d).getDay() + 6) % 7)); };
  let weekStart = mondayOf(viewDate);

  const persist = () => {
    store.set('rows', rows); store.set('queue', queue); store.set('suggest', suggest);
    store.set('masters', masters); store.set('mh', mh); store.set('backup', backupAt); store.set('notes', notes);
  };

  // ------------------------------------------------------------ 顧客（ID・いつもの）と補正（誤変換）
  let custMap = new Map(), fixMap = new Map(), fixRe = null;
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function buildMasters() {
    custMap = new Map((masters.customers || []).map((c) => [c[0], { code: c[1] || '', brand: c[2] || '', qty: c[3] || '', area: c[4] || '', kind: c[5] || '', last: c[6] || '' }]));
    fixMap = new Map((masters.fixes || []).filter((f) => f[0] && f[1]).map((f) => [f[0], f[1]]));
    const keys = [...fixMap.keys()].sort((a, b) => b.length - a.length).map(escRe);
    fixRe = keys.length ? new RegExp(keys.join('|'), 'g') : null;
  }
  const fixText = (t) => (fixRe ? t.replace(fixRe, (m) => fixMap.get(m)) : t); // 文章の中の誤変換をまとめて直す
  const canon = (t) => fixMap.get(t) || t;                                      // 欄の値が誤変換そのものなら直す
  const codeOf = (name) => (custMap.get(name) || {}).code || '';
  function applyMasterOp(op) {
    if (op.t === 'cust') {
      const c = masters.customers.find((x) => x[0] === op.name);
      if (c) c[1] = op.changes.code; else masters.customers.push([op.name, op.changes.code, '', '', '', '', '']);
    } else if (op.t === 'fix') {
      const f = masters.fixes.find((x) => x[0] === op.from);
      if (f) f[1] = op.to; else masters.fixes.push([op.from, op.to]);
    } else return;
    buildMasters();
  }
  const isMasterOp = (op) => op.t === 'cust' || op.t === 'fix';
  buildMasters();
  function applyNote(op) { if (op.text) notes[op.date] = op.text; else delete notes[op.date]; }

  // ------------------------------------------------------------ 通信
  async function api(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      // text/plain で送る（Apps Script はプリフライトを受け付けないため）
      const res = await fetch(cfg.apiUrl, { method: 'POST', body: JSON.stringify(Object.assign({ key: cfg.key }, body)), signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  // 未送信の操作を、取得した一覧の上に重ねて表示する
  function overlay(baseRows, ops) {
    const out = baseRows.map((r) => Object.assign({}, r));
    const idx = new Map(out.map((r, i) => [r.id, i]));
    for (const op of ops) {
      if (op.t === 'create') {
        if (!idx.has(op.row.id)) { idx.set(op.row.id, out.length); out.push(Object.assign({}, op.row)); }
      } else if (op.t === 'update') {
        const i = idx.get(op.id);
        if (i != null) { Object.assign(out[i], op.changes); out[i].ver = null; }
      }
    }
    return out;
  }

  function queueOp(op) {
    queue.push(op);
    if (isMasterOp(op)) applyMasterOp(op);
    else if (op.t === 'daynote') applyNote(op);
    else rows = overlay(rows, [op]);
    persist();
  }

  let syncing = false, again = false;
  async function sync(manual) {
    if (!cfg.apiUrl || !cfg.key || !cfg.user) {
      openCfg();
      if (manual) toast('名前・合言葉・サーバーのURLをすべて入れてください');
      return;
    }
    if (syncing) { again = true; return; }
    syncing = true; setStatus('sync');
    const sent = queue.slice();
    let retry = false;
    try {
      // 顧客・補正を送ったときは、サーバーの最新の表を必ず受け取る
      const res = await api({ action: 'sync', ops: sent, mh: sent.some(isMasterOp) ? '' : mh });
      if (!res.ok) {
        if (res.error === 'auth') { toast('合言葉が違います'); setStatus('off'); openCfg(); return; }
        throw new Error(res.error || 'server');
      }
      queue = queue.slice(sent.length);
      const conflicts = (res.results || []).filter((r) => !r.ok && r.error === 'conflict').length;
      if (conflicts) toast('他の人が先に更新していました。内容を確認してください');
      rows = overlay(res.rows || [], queue);
      suggest = res.suggest || suggest;
      if (res.masters) { masters = res.masters; buildMasters(); }
      if (res.mh) mh = res.mh;
      if (res.notes) notes = res.notes;
      queue.filter(isMasterOp).forEach(applyMasterOp); // まだ送れていない分は重ねておく
      queue.filter((o) => o.t === 'daynote').forEach(applyNote);
      backupAt = res.backup || '';
      lastSync = Date.now();
      persist();
      setStatus('ok');
      retry = again;
    } catch (e) {
      setStatus('off');
      if (manual) toast('サーバーにつながりません。URLが「…/exec」で終わっているか、デプロイのアクセス権が「全員」か確認してください');
    } finally {
      syncing = false; again = false;
      render();
      if (retry) sync();
    }
  }

  function setStatus(s) {
    status = s;
    const b = $('#syncBtn');
    b.classList.toggle('off', s === 'off');
    if (s === 'sync') b.textContent = '同期中…';
    else if (s === 'off') b.textContent = `⚠ オフライン${queue.length ? `（未送信${queue.length}）` : ''}`;
    else if (s === 'ok') { const d = new Date(lastSync); b.textContent = `● ${pad(d.getHours())}:${pad(d.getMinutes())} 同期済`; }
    else b.textContent = '同期';
  }

  // ------------------------------------------------------------ 一覧の表示
  const byReceived = (a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)) || String(a.id).localeCompare(String(b.id));
  // 一覧の並び：「並び」の値が小さいほど上。値がない古い行は受付時刻を使う
  const orderOf = (r) => (typeof r.order === 'number' && isFinite(r.order) ? r.order : parseTs(r.receivedAt));
  const byOrder = (a, b) => (orderOf(a) - orderOf(b)) || String(a.id).localeCompare(String(b.id));
  const nextOrder = (date) => Math.max(Date.now(), ...rows.filter((r) => r.date === date).map(orderOf)) + 1;

  function cardHtml(r, withDate, grip) {
    const cls = ['card'];
    if (r.status === '準備済') cls.push('prep');
    if (r.status === '完了') cls.push('done');
    if (r.status === '取消') cls.push('void');
    const place = [r.area, r.time].filter(Boolean).map(esc).join(' ・ ');
    const dateTxt = withDate ? `<b>${esc(fmtDate(r.date))}</b> ` : '';
    const on = (c) => (c ? ' class="on"' : '');
    const acts = r.status === '取消'
      ? `<div class="note">取消：${esc(r.cancelReason || '')}</div>`
      : `<div class="act">
          <button type="button" data-act="inv"${on(r.invoiced)}>伝票</button>
          <button type="button" data-act="prep"${on(r.status === '準備済' || r.status === '完了')}>商品</button>
          <button type="button" data-act="paid"${on(r.paid)}>入金</button>
          <button type="button" data-act="done"${on(r.status === '完了')}>完了</button>
        </div>`;
    return `<article class="${cls.join(' ')}" data-id="${esc(r.id)}">
      <div class="top">${grip ? '<span class="grip" aria-label="ドラッグで並べ替え">≡</span>' : ''}<span class="place">${dateTxt}${place || '—'}</span><span class="kind ${r.kind === '店頭' ? 's' : ''}">${esc(r.kind || '配達')}</span></div>
      <div class="nameline"><span class="name">${esc(r.name)}</span>${codeOf(r.name) ? `<span class="cid">${esc(codeOf(r.name))}</span>` : ''}</div>
      <div class="goods">${esc(r.brand)}${r.qty ? `<b>${esc(r.qty)}</b>` : ''}</div>
      ${r.other ? `<div class="goods">${esc(r.other)}</div>` : ''}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
      ${acts}
    </article>`;
  }

  function render() {
    setStatus(status);
    if (dragState) { pendingRender = true; return; } // ドラッグ中は画面を作り直さない
    // 一覧
    const isToday = viewDate === today();
    $('#dateLabel').innerHTML = esc(fmtDate(viewDate)) + (isToday ? '<span class="today">今日</span>' : '');
    $('#dateInput').value = viewDate;
    const dn = $('#dayNote');
    dn.className = 'daynote' + (notes[viewDate] ? ' has' : '');
    dn.textContent = notes[viewDate] ? `📝 ${notes[viewDate]}` : '＋ この日のメモ（臨時休業・臨時営業など）';
    $('#fltOpen').checked = ui.open;
    $('#fltVoid').checked = ui.void;
    const dayRows = rows.filter((r) => r.date === viewDate).sort(byOrder);
    const shown = dayRows.filter((r) => (ui.void || r.status !== '取消') && (!ui.open || r.status !== '完了'));
    const live = dayRows.filter((r) => r.status !== '取消');
    const done = live.filter((r) => r.status === '完了').length;
    $('#summary').textContent = `全${live.length}件（配達${live.filter((r) => r.kind !== '店頭').length}・店頭${live.filter((r) => r.kind === '店頭').length}）／ 完了${done}・残り${live.length - done}`;
    $('#list').innerHTML = shown.length ? shown.map((r) => cardHtml(r, false, true)).join('') : '<p class="empty">この日の注文はありません</p>';

    // 伝票待ち
    $('#fltDoneOnly').checked = ui.doneOnly;
    const pending = pendingInvoice();
    const pendShown = ui.doneOnly ? pending.filter((r) => r.status === '完了') : pending;
    const badge = $('#invCount');
    badge.hidden = !pending.length;
    badge.textContent = pending.length;
    $('#invSummary').textContent = `伝票がまだの注文：${pending.length}件（入金済みは対象外）`;
    let html = '', lastDate = '';
    for (const r of pendShown) {
      if (r.date !== lastDate) { lastDate = r.date; html += `<div class="dayhead">${esc(fmtDate(r.date))}</div>`; }
      html += cardHtml(r, false);
    }
    $('#invList').innerHTML = html || '<p class="empty">伝票待ちはありません</p>';

    // バックアップの警告（同期できているときだけ）
    const age = backupAt ? (Date.now() - parseTs(backupAt)) / 86400e3 : Infinity;
    const warn = $('#warn');
    warn.hidden = !(lastSync && age > 3);
    warn.textContent = backupAt
      ? `⚠ 台帳のバックアップが${Math.floor(age)}日間とれていません。Apps Script の実行数やトリガーを確認してください`
      : '⚠ 台帳の自動バックアップが未設定です。パソコンで Apps Script の initialize を実行してください';
    if (tab === 'check') renderCheck();
    if (tab === 'week') renderWeek();
  }

  // ------------------------------------------------------------ 週間（先々の注文と混み具合）
  // 数量の「kg」「キロ」だけ合計する（袋・俵などは重さが分からないので合計に入れない）
  function kgOf(q) {
    const s = String(q || '').normalize('NFKC');
    let kg = 0, ok = false;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(?:kg|キロ|ｷﾛ)(?:\s*[x×*]\s*(\d+))?/gi)) {
      kg += Number(m[1]) * (m[2] ? Number(m[2]) : 1);
      ok = true;
    }
    return ok ? kg : null;
  }
  const fmtKg = (k) => `${Number.isInteger(k) ? k : k.toFixed(1)}kg`;
  function statsOf(list) {
    const st = { n: list.length, kg: 0, unknown: 0, brands: new Map() };
    for (const r of list) {
      const k = kgOf(r.qty);
      if (k == null) { st.unknown++; continue; }
      st.kg += k;
      const b = r.brand || '（銘柄なし）';
      st.brands.set(b, (st.brands.get(b) || 0) + k);
    }
    return st;
  }
  const sumText = (st) => `${st.n}件・${fmtKg(st.kg)}${st.unknown ? `（kg不明${st.unknown}件）` : ''}`;
  const weekRows = (start) => { const end = addDays(start, 6); return rows.filter((r) => r.status !== '取消' && r.date >= start && r.date <= end); };

  function renderWeek() {
    const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
    $('#weekLabel').textContent = `${fmtDate(days[0])} 〜 ${fmtDate(days[6])}`;
    $('#weekInput').value = weekStart;

    // これからの6週間の混み具合
    const thisMon = mondayOf(today());
    const weeks = [...Array(6)].map((_, i) => addDays(thisMon, i * 7));
    const stats = weeks.map((w) => statsOf(weekRows(w)));
    const maxKg = Math.max(1, ...stats.map((s) => s.kg));
    $('#wkOverview').innerHTML = weeks.map((w, i) => {
      const lab = i === 0 ? '今週' : i === 1 ? '来週' : fmtDate(w).replace(/\(.\)/, '') + '〜';
      return `<button type="button" class="wk${w === weekStart ? ' on' : ''}" data-week="${w}"><b>${lab}</b><span>${stats[i].n}件</span><span>${fmtKg(stats[i].kg)}</span><i style="width:${Math.round(stats[i].kg / maxKg * 100)}%"></i></button>`;
    }).join('');

    const list = weekRows(weekStart);
    const st = statsOf(list);
    $('#wkSummary').textContent = `この週：${sumText(st)}（配達${list.filter((r) => r.kind !== '店頭').length}・店頭${list.filter((r) => r.kind === '店頭').length}）`;
    $('#wkBrands').innerHTML = st.brands.size
      ? '銘柄別：' + [...st.brands].sort((a, b) => b[1] - a[1]).map(([b, k]) => `<span class="bchip">${esc(b)} <b>${fmtKg(k)}</b></span>`).join('')
      : '';

    const dayStats = days.map((d) => statsOf(list.filter((r) => r.date === d)));
    const dayMax = Math.max(1, ...dayStats.map((s) => s.kg));
    $('#wkGrid').innerHTML = days.map((d, i) => {
      const items = list.filter((r) => r.date === d).sort(byOrder);
      const dt = dayStats[i];
      const cls = ['wday'];
      if (d === today()) cls.push('today');
      if (d < today()) cls.push('past');
      if (i >= 5) cls.push('we');
      const body = items.length ? items.map((r) => `<div class="wrow${r.status === '完了' ? ' done' : ''}" data-id="${esc(r.id)}">
          <span class="wn">${esc(r.name)}${r.kind === '店頭' ? '<em>店頭</em>' : ''}</span>
          <span class="wg">${esc(r.brand)}${r.qty ? ` <b>${esc(r.qty)}</b>` : ''}</span>
          ${r.other ? `<span class="wg">${esc(r.other)}</span>` : ''}
          ${r.time || r.area ? `<span class="wt">${esc([r.area, r.time].filter(Boolean).join(' '))}</span>` : ''}
        </div>`).join('') : '<div class="wnone">—</div>';
      const nt = notes[d] ? `<div class="wnote has" data-note="${d}">📝 ${esc(notes[d])}</div>` : `<div class="wnote" data-note="${d}">＋ メモ</div>`;
      return `<section class="${cls.join(' ')}"><header data-goto="${d}"><b>${esc(fmtDate(d))}</b><span>${items.length ? sumText(dt) : ''}</span><i style="width:${Math.round(dt.kg / dayMax * 100)}%"></i></header>${nt}${body}</section>`;
    }).join('');
  }

  function weekPrintHtml() {
    const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
    const list = weekRows(weekStart);
    const st = statsOf(list);
    const brands = [...st.brands].sort((a, b) => b[1] - a[1]).map(([b, k]) => `${esc(b)} ${fmtKg(k)}`).join('　');
    const cells = days.map((d) => {
      const items = list.filter((r) => r.date === d).sort(byOrder);
      return `<td>${items.map((r) => `<div class="pw">${r.status === '完了' ? '✔ ' : ''}<b>${esc(r.name)}</b>${r.kind === '店頭' ? '（店頭）' : ''}<br>${esc([r.brand, r.qty].filter(Boolean).join(' '))}${r.other ? `<br>${esc(r.other)}` : ''}${r.time ? ` ${esc(r.time)}` : ''}</div>`).join('')}</td>`;
    }).join('');
    const heads = days.map((d) => { const s = statsOf(list.filter((r) => r.date === d)); return `<th>${esc(fmtDate(d))}<br><small>${s.n ? sumText(s) : ''}</small>${notes[d] ? `<br><small>📝 ${esc(notes[d])}</small>` : ''}</th>`; }).join('');
    return `<h1>${esc(fmtDate(days[0]))} 〜 ${esc(fmtDate(days[6]))} 週間予定</h1><p>${sumText(st)}${brands ? `　銘柄別：${brands}` : ''}</p><table class="pweek"><thead><tr>${heads}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
  }

  // ------------------------------------------------------------ 確認（月の一覧。入力ミスのチェック用）
  function renderCheck() {
    $('#monthLabel').textContent = `${chkMonth.slice(0, 4)}年${Number(chkMonth.slice(5))}月`;
    $('#monthInput').value = chkMonth;
    const month = rows.filter((r) => r.status !== '取消' && String(r.date).startsWith(chkMonth));
    const count = new Map();
    month.forEach((r) => { const k = r.name + '|' + r.date; count.set(k, (count.get(k) || 0) + 1); });
    const q = $('#chkName').value.trim();
    const list = month.filter((r) => !q || r.name.includes(q) || codeOf(r.name).includes(q))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || byOrder(a, b));
    const dups = list.filter((r) => count.get(r.name + '|' + r.date) > 1).length;
    $('#chkSummary').textContent = `${list.length}件・${new Set(list.map((r) => r.name)).size}軒` + (dups ? `　⚠ 同じ日に同じお名前：${dups}件` : '');
    let html = '', last = '';
    for (const r of list) {
      if (r.date !== last) {
        last = r.date;
        html += `<div class="dayhead">${esc(fmtDate(r.date))}　${list.filter((x) => x.date === r.date).length}件</div>`;
      }
      const n = count.get(r.name + '|' + r.date);
      html += `<div class="crow${r.status === '完了' ? ' done' : ''}${n > 1 ? ' isdup' : ''}" data-id="${esc(r.id)}">
        <span class="nm">${esc(r.name)}${codeOf(r.name) ? `<span class="cid">${esc(codeOf(r.name))}</span>` : ''}</span>
        <span class="tm">${esc([r.kind === '店頭' ? '店頭' : '', r.time].filter(Boolean).join(' '))}</span>
        <span class="gd">${esc(r.brand)}${r.qty ? ` <b>${esc(r.qty)}</b>` : ''}${r.other ? `　＋${esc(r.other)}` : ''}${r.area ? `　${esc(r.area)}` : ''}${r.note ? `　※${esc(r.note)}` : ''}</span>
        ${n > 1 ? `<span class="dup">⚠ 同じ日に同じお名前が${n}件あります</span>` : ''}
      </div>`;
    }
    $('#chkList').innerHTML = html || '<p class="empty">この条件の注文はありません</p>';
  }

  function pendingInvoice() {
    return rows.filter((r) => r.status !== '取消' && !r.paid && !r.invoiced)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || byOrder(a, b));
  }

  // ------------------------------------------------------------ 操作
  function change(id, changes) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    queueOp({ t: 'update', id, changes, user: cfg.user });
    render();
    sync();
  }

  function act(id, a) {
    const r = rows.find((x) => x.id === id);
    if (!r || r.status === '取消') return;
    if (a === 'prep') {
      if (r.status === '完了') { toast('先に「完了」を外してください'); return; }
      change(id, { status: r.status === '準備済' ? '未対応' : '準備済' });
    } else if (a === 'done') {
      change(id, { status: r.status === '完了' ? '準備済' : '完了' });
    } else if (a === 'paid') {
      change(id, { paid: !r.paid });
    } else if (a === 'inv') {
      change(id, { invoiced: !r.invoiced });
    }
  }

  function onCardClick(e) {
    const card = e.target.closest('.card');
    if (!card || e.target.closest('.grip')) return;
    const id = card.dataset.id;
    const b = e.target.closest('[data-act]');
    if (b) { act(id, b.dataset.act); return; }
    const r = rows.find((x) => x.id === id);
    if (r) openForm(r);
  }

  // ------------------------------------------------------------ 入力フォーム
  const F = {
    dlg: $('#formDlg'), date: $('#fDate'), name: $('#fName'), brand: $('#fBrand'), qty: $('#fQty'), other: $('#fOther'),
    area: $('#fArea'), time: $('#fTime'), paid: $('#fPaid'), note: $('#fNote'), memo: $('#fMemo'), code: $('#fCode')
  };
  let editing = null;
  let memoSnap = null; // まとめ入力が振り分けた直後の値（人が直したら、誤変換として覚える材料にする）
  const auto = { code: '', brand: '', qty: '', area: '' }; // 自動で入れた値（名前を変えたら入れ替えてよい）
  const resetAuto = () => { auto.code = auto.brand = auto.qty = auto.area = ''; };
  const kindValue = () => (document.querySelector('input[name=fKind]:checked') || {}).value || '配達';
  const setKind = (v) => { const el = document.querySelector(`input[name=fKind][value="${v}"]`); (el || document.querySelector('input[name=fKind]')).checked = true; };

  // 入力中の候補（過去の入力から出すだけ。マスタ照合ではない）
  function pendingValues(key) {
    return rows.map((r) => r[key]).filter(Boolean);
  }
  function candidates(key, serverKey) {
    const seen = new Set(), out = [];
    const fromCust = key === 'name' ? [...custMap.keys()] : [];
    for (const v of [...pendingValues(key).reverse(), ...(suggest[serverKey] || []), ...fromCust]) {
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  }
  function chipsFor(boxSel, input, getList, onPick) {
    const box = $(boxSel);
    const draw = () => {
      const q = input.value.trim();
      const list = getList().filter((x) => x !== q && (!q || x.includes(q))).slice(0, 6);
      const html = list.map((x) => `<button type="button">${esc(x)}</button>`).join('');
      if (box.innerHTML !== html) box.innerHTML = html; // 同じなら作り直さない（タップの最中に消えないように）
    };
    input.addEventListener('input', draw);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      input.value = b.textContent;
      draw();
      if (onPick) onPick(b.textContent);
    });
    return draw;
  }

  // 「いつもの」：顧客シートの「いつもの」（なければ前回の注文）から、空欄の項目を埋める
  function lastFromRows(name) {
    const last = rows.filter((r) => r.name === name && r.status !== '取消').sort(byReceived).pop();
    return last ? { brand: last.brand, qty: last.qty, area: last.area, kind: last.kind } : null;
  }
  function setIfFree(el, key, val) {
    if (!val) return;
    if (!el.value || el.value === auto[key]) { el.value = val; auto[key] = val; flash(el); }
  }
  function flash(el) { el.classList.add('filled'); setTimeout(() => el.classList.remove('filled'), 2000); }
  function fillUsual(name, keepKind) {
    if (editing) return;
    const c = custMap.get(name);
    const u = c && (c.brand || c.qty || c.area) ? c : lastFromRows(name);
    if (!u) return;
    setIfFree(F.brand, 'brand', u.brand);
    setIfFree(F.qty, 'qty', u.qty);
    setIfFree(F.area, 'area', u.area);
    if (!keepKind && u.kind) setKind(u.kind);
  }

  // お名前が決まったとき：誤変換を直し、顧客IDと「いつもの」を入れる
  function settleName(opts) {
    if (!F.dlg.open) return;
    opts = opts || {};
    let name = F.name.value.trim();
    const fixed = canon(name);
    if (fixed !== name) {
      if (!opts.silent) toast(`「${name}」を「${fixed}」に直しました`);
      F.name.value = fixed; name = fixed; flash(F.name);
    }
    if (custMap.has(name)) {
      if (!F.code.value || F.code.value === auto.code) { F.code.value = codeOf(name); auto.code = F.code.value; if (F.code.value) flash(F.code); }
      fillUsual(name, opts.keepKind);
    } else if (F.code.value === auto.code) {
      F.code.value = ''; auto.code = '';
      fillUsual(name, opts.keepKind); // 顧客シートになくても、直近の注文があればそれで埋める
    } else {
      fillUsual(name, opts.keepKind);
    }
    drawers.forEach((d) => d());
  }
  let settleTimer;
  F.name.addEventListener('input', () => { clearTimeout(settleTimer); settleTimer = setTimeout(() => settleName(), 400); });
  F.name.addEventListener('change', () => { clearTimeout(settleTimer); settleName(); });
  [F.brand, F.area].forEach((el) => el.addEventListener('change', () => {
    const v = el.value.trim(), f = canon(v);
    if (f !== v) { toast(`「${v}」を「${f}」に直しました`); el.value = f; flash(el); drawers.forEach((d) => d()); }
  }));

  const drawers = [
    chipsFor('#sgName', F.name, () => candidates('name', 'names'), () => settleName()),
    chipsFor('#sgBrand', F.brand, () => candidates('brand', 'brands')),
    chipsFor('#sgArea', F.area, () => candidates('area', 'areas'))
  ];
  chipsFor('#sgTime', F.time, () => []); // 時間の固定ボタンは下で個別に処理
  $('#sgTime').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) F.time.value = b.textContent;
  });

  function openForm(r) {
    editing = r || null;
    $('#formTitle').textContent = r ? '注文を編集' : '新規注文';
    F.date.value = r ? r.date : (viewDate >= today() ? viewDate : today());
    resetAuto();
    memoSnap = null;
    F.name.value = r ? r.name : '';
    F.code.value = r ? codeOf(r.name) : '';
    auto.code = F.code.value;
    F.brand.value = r ? r.brand : '';
    F.qty.value = r ? r.qty : '';
    F.other.value = r ? (r.other || '') : '';
    F.area.value = r ? r.area : '';
    F.time.value = r ? r.time : '';
    F.note.value = r ? r.note : '';
    F.paid.checked = r ? !!r.paid : false;
    setKind(r ? r.kind : '配達');
    $('#editOnly').hidden = !r;
    const voided = !!r && r.status === '取消';
    $('#voidBox').hidden = voided;
    $('#restoreBox').hidden = !voided;
    $('#voidInfo').textContent = voided ? `取消済み（${r.cancelReason || '理由なし'}）` : '';
    $('#fSave').disabled = false;
    F.memo.value = '';
    $('#memoBox').hidden = !!r;
    drawers.forEach((d) => d());
    F.dlg.showModal();
    if (!r) F.memo.focus();
  }
  const closeForm = () => { if (F.dlg.open) F.dlg.close(); editing = null; };

  function saveForm(e) {
    e.preventDefault();
    const v = {
      date: F.date.value || today(),
      name: F.name.value.trim(),
      brand: F.brand.value.trim(),
      qty: F.qty.value.trim(),
      other: F.other.value.trim(),
      area: F.area.value.trim(),
      time: F.time.value.trim(),
      kind: kindValue(),
      note: F.note.value.trim(),
      paid: F.paid.checked
    };
    v.name = canon(v.name); v.brand = canon(v.brand); v.area = canon(v.area);
    if (!v.name) { toast('お名前を入れてください'); F.name.focus(); return; }
    $('#fSave').disabled = true; // 二度押し防止
    const code = F.code.value.trim();
    const pairs = editing ? [] : learnPairs(v);
    if (!editing) {
      const dup = rows.find((r) => r.status !== '取消' && r.name === v.name && r.date === v.date &&
        Date.now() - parseTs(r.receivedAt) < 10 * 60 * 1000);
      if (dup && !confirm('同じお名前の注文が10分以内に登録されています。\n重複していませんか？\nそれでも登録しますか？')) {
        $('#fSave').disabled = false;
        return;
      }
      queueOp({
        t: 'create',
        row: Object.assign({ id: uid(), receivedAt: nowStr(), receiver: cfg.user, status: '未対応', invoiced: false, cancelReason: '', order: nextOrder(v.date) }, v)
      });
      viewDate = v.date;
      setTab('list');
    } else {
      const changes = {};
      for (const k of Object.keys(v)) {
        const cur = editing[k];
        const differs = typeof v[k] === 'boolean' ? v[k] !== !!cur : v[k] !== (cur || '');
        if (differs) changes[k] = v[k];
      }
      if (Object.keys(changes).length) queueOp({ t: 'update', id: editing.id, changes, base: editing.ver || undefined, user: cfg.user });
    }
    if (code !== codeOf(v.name)) queueOp({ t: 'cust', name: v.name, changes: { code } }); // 顧客IDの登録・変更
    closeForm();
    render();
    sync();
    if (pairs.length) setTimeout(() => askLearn(pairs), 0);
  }

  // まとめ入力の結果を人が直したものを、誤変換として覚えるかどうか尋ねる
  function learnPairs(v) {
    const snap = memoSnap;
    memoSnap = null;
    if (!snap) return [];
    const known = { name: (p) => custMap.has(p), brand: (p) => (suggest.brands || []).includes(p), area: (p) => (suggest.areas || []).includes(p) };
    const out = [];
    for (const k of ['name', 'brand', 'area']) {
      const p = snap[k], f = v[k];
      if (p && f && p !== f && !fixMap.has(p) && !known[k](p) && !out.some((x) => x[0] === p)) out.push([p, f]);
    }
    return out;
  }
  function askLearn(pairs) {
    let n = 0;
    for (const [p, f] of pairs) {
      if (confirm(`「${p}」を「${f}」に直しましたね。\n次から、話した「${p}」を自動で「${f}」に直しますか？`)) {
        queueOp({ t: 'fix', from: p, to: f });
        n++;
      }
    }
    if (n) { toast('覚えました'); sync(); }
  }


  // ------------------------------------------------------------ まとめ入力（話した文を各欄に振り分ける）
  function applyParse(manual) {
    const text = fixText(F.memo.value.trim()); // 先に、登録済みの誤変換を直す
    if (!text || editing || !F.dlg.open) return;
    const r = window.OrderParse.parse(text, { names: candidates('name', 'names'), areas: candidates('area', 'areas') });
    resetAuto();
    memoSnap = { name: r.name, brand: r.brand, area: r.area };
    F.name.value = r.name;
    F.brand.value = r.brand;
    F.qty.value = r.qty;
    F.area.value = r.area;
    F.time.value = r.time;
    if (r.dayOffset != null) F.date.value = addDays(today(), r.dayOffset);
    if (r.kind) setKind(r.kind);
    if (r.paid) F.paid.checked = true;
    F.code.value = '';
    if (r.name) settleName({ silent: true, keepKind: !!r.kind }); // 顧客ID・「いつもの」で空欄を埋める
    drawers.forEach((d) => d());
    [F.name, F.brand, F.qty, F.area, F.time].forEach((el) => {
      if (!el.value) return;
      el.classList.add('filled');
      setTimeout(() => el.classList.remove('filled'), 2000);
    });
    if (manual) toast(r.name ? '振り分けました。内容を確認してください' : 'お名前が分かりませんでした。確認してください');
  }
  let parseTimer;
  F.memo.addEventListener('input', () => { clearTimeout(parseTimer); parseTimer = setTimeout(() => applyParse(false), 900); });
  F.memo.addEventListener('blur', () => { clearTimeout(parseTimer); applyParse(false); });
  $('#fParse').addEventListener('click', () => { clearTimeout(parseTimer); applyParse(true); });

  // ------------------------------------------------------------ ドラッグで並べ替え（左端の ≡ をつかんで動かす）
  const listEl = $('#list');
  listEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.grip')) e.preventDefault(); });
  listEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    startDrag(grip.closest('.card'), grip, e);
  });

  function startDrag(card, grip, e) {
    if (dragState) return;
    const rect = card.getBoundingClientRect();
    const ph = document.createElement('div'); // 元の場所に残す空き枠
    ph.className = 'ph';
    ph.style.height = rect.height + 'px';
    card.after(ph);
    Object.assign(card.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', zIndex: 30 });
    card.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 非対応でも動作する */ }
    const st = dragState = { y: e.clientY, raf: 0 };
    const offY = e.clientY - rect.top;

    const place = () => {
      card.style.top = (st.y - offY) + 'px';
      let before = null;
      for (const c of listEl.querySelectorAll('.card:not(.dragging)')) {
        const b = c.getBoundingClientRect();
        if (st.y < b.top + b.height / 2) { before = c; break; }
      }
      if (before) { if (ph.nextElementSibling !== before) listEl.insertBefore(ph, before); }
      else if (ph !== listEl.lastElementChild) listEl.appendChild(ph);
    };
    const loop = () => {
      if (dragState !== st) return;
      if (st.y < 150) window.scrollBy(0, -14);
      else if (st.y > window.innerHeight - 110) window.scrollBy(0, 14);
      place();
      st.raf = requestAnimationFrame(loop);
    };
    const move = (ev) => { st.y = ev.clientY; };
    const finish = (ev) => {
      cancelAnimationFrame(st.raf);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* 何もしない */ }
      card.classList.remove('dragging');
      card.removeAttribute('style');
      const commit = ev.type === 'pointerup';
      if (commit) listEl.insertBefore(card, ph);
      ph.remove();
      const prevEl = commit ? card.previousElementSibling : null;
      const nextEl = commit ? card.nextElementSibling : null;
      dragState = null;
      if (commit) applyMove(card.dataset.id, prevEl && prevEl.dataset.id, nextEl && nextEl.dataset.id);
      pendingRender = false;
      render();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    loop();
  }

  // 動かした行の「並び」の値を、前後の行の間に決める
  function applyMove(id, prevId, nextId) {
    const r = rows.find((x) => x.id === id);
    const p = prevId ? rows.find((x) => x.id === prevId) : null;
    const n = nextId ? rows.find((x) => x.id === nextId) : null;
    if (!r || (!p && !n)) return;
    const ro = orderOf(r), po = p ? orderOf(p) : null, no = n ? orderOf(n) : null;
    if ((po == null || po < ro) && (no == null || ro < no)) return; // 位置は変わっていない
    let v = null;
    if (po == null) v = no - 1000;
    else if (no == null) v = po + 1000;
    else if (no - po >= 4) v = (po + no) / 2;
    if (v != null) {
      queueOp({ t: 'update', id, changes: { order: v }, user: cfg.user });
    } else {
      // 間が詰まりすぎたときは、その日の全件を等間隔に振り直す
      const day = rows.filter((x) => x.date === r.date).sort(byOrder).filter((x) => x.id !== id);
      const at = n ? day.findIndex((x) => x.id === nextId) : day.findIndex((x) => x.id === prevId) + 1;
      day.splice(at < 0 ? day.length : at, 0, r);
      const start = Math.min(...day.map(orderOf));
      day.forEach((x, i) => {
        const o = start + i * 1000;
        if (orderOf(x) !== o) queueOp({ t: 'update', id: x.id, changes: { order: o }, user: cfg.user });
      });
    }
    sync();
  }

  // ------------------------------------------------------------ 設定
  function openCfg() {
    if ($('#cfgDlg').open) return;
    $('#cUser').value = cfg.user;
    $('#cKey').value = cfg.key;
    $('#cUrl').value = cfg.apiUrl;
    $('#backupInfo').textContent = backupAt ? `最終バックアップ：${backupAt}` : '最終バックアップ：まだありません';
    if (F.dlg.open) F.dlg.close();
    $('#cfgDlg').showModal();
  }
  $('#cfgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#cUrl').value.trim() || base.apiUrl || '';
    if (!/^https?:\/\/\S+$/.test(url)) {
      toast('サーバーのURLを入れてください（https://script.google.com/…/exec）');
      $('#cUrl').focus();
      return;
    }
    cfg.user = $('#cUser').value.trim();
    cfg.key = $('#cKey').value.trim();
    cfg.apiUrl = url;
    store.set('cfg', cfg);
    $('#cfgDlg').close();
    sync(true);
  });
  $('#cClose').addEventListener('click', () => $('#cfgDlg').close());
  $('#cfgBtn').addEventListener('click', openCfg);

  // ------------------------------------------------------------ 画面の配線
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#viewList').hidden = t !== 'list';
    $('#viewInvoice').hidden = t !== 'invoice';
    $('#viewCheck').hidden = t !== 'check';
    $('#viewWeek').hidden = t !== 'week';
    document.querySelector('main').classList.toggle('wide', t === 'week'); // 週間はPCで横に広げる
    if (t === 'check') renderCheck();
    if (t === 'week') renderWeek();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // 日ごとのメモ
  let noteDate = '';
  function openNote(date) {
    noteDate = date;
    $('#noteTitle').textContent = `${fmtDate(date)} のメモ`;
    $('#noteText').value = notes[date] || '';
    $('#noteDlg').showModal();
  }
  $('#dayNote').addEventListener('click', () => openNote(viewDate));
  $('#noteChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = $('#noteText');
    t.value = t.value.trim() ? `${t.value.trim()}　${b.textContent}` : b.textContent;
  });
  $('#noteClose').addEventListener('click', () => $('#noteDlg').close());
  function saveNote(text) {
    text = text.trim().slice(0, 200);
    if (text !== (notes[noteDate] || '')) {
      queueOp({ t: 'daynote', date: noteDate, text, user: cfg.user });
      render();
      sync();
    }
    $('#noteDlg').close();
  }
  $('#noteSave').addEventListener('click', () => saveNote($('#noteText').value));
  $('#noteClear').addEventListener('click', () => saveNote(''));

  // 週間
  const shiftWeek = (n) => { weekStart = addDays(weekStart, n * 7); renderWeek(); };
  $('#prevWeek').addEventListener('click', () => shiftWeek(-1));
  $('#nextWeek').addEventListener('click', () => shiftWeek(1));
  $('#thisWeek').addEventListener('click', () => { weekStart = mondayOf(today()); renderWeek(); });
  $('#weekInput').addEventListener('change', (e) => { if (e.target.value) { weekStart = mondayOf(e.target.value); renderWeek(); } });
  $('#wkOverview').addEventListener('click', (e) => { const b = e.target.closest('[data-week]'); if (b) { weekStart = b.dataset.week; renderWeek(); } });
  $('#wkGrid').addEventListener('click', (e) => {
    const nt = e.target.closest('[data-note]');
    if (nt) { openNote(nt.dataset.note); return; }
    const row = e.target.closest('.wrow');
    if (row) { const r = rows.find((x) => x.id === row.dataset.id); if (r) openForm(r); return; }
    const head = e.target.closest('[data-goto]');
    if (head) { viewDate = head.dataset.goto; setTab('list'); render(); }
  });
  $('#wkPrint').addEventListener('click', () => {
    const ps = $('#printSheet');
    ps.classList.add('printweek');
    ps.innerHTML = weekPrintHtml();
    window.print();
  });
  window.addEventListener('afterprint', () => $('#printSheet').classList.remove('printweek'));

  // 確認（月の一覧）
  const shiftMonth = (n) => { const [y, m] = chkMonth.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); chkMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; renderCheck(); };
  $('#prevMonth').addEventListener('click', () => shiftMonth(-1));
  $('#nextMonth').addEventListener('click', () => shiftMonth(1));
  $('#monthInput').addEventListener('change', (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { chkMonth = e.target.value; renderCheck(); } });
  $('#chkName').addEventListener('input', renderCheck);
  $('#chkList').addEventListener('click', (e) => {
    const row = e.target.closest('.crow');
    const r = row && rows.find((x) => x.id === row.dataset.id);
    if (r) openForm(r);
  });

  // 今日の一覧の印刷・共有（障害のときも、紙やLINEで配達を回せるように）
  function dayRows(date) { return rows.filter((r) => r.date === date && r.status !== '取消').sort(byOrder); }
  function outText(date) {
    const day = dayRows(date);
    const head = `${fmtDate(date)}　配達${day.filter((r) => r.kind !== '店頭').length}件・店頭${day.filter((r) => r.kind === '店頭').length}件`;
    const noteLine = notes[date] ? [`📝 ${notes[date]}`] : [];
    const lines = day.map((r, i) => {
      const parts = [`${i + 1}. ${r.name}${codeOf(r.name) ? `[${codeOf(r.name)}]` : ''}${r.kind === '店頭' ? '（店頭）' : ''}`,
        [r.brand, r.qty].filter(Boolean).join(' '), r.other ? `＋${r.other}` : '', [r.area, r.time].filter(Boolean).join(' '), r.paid ? '入金済' : '', r.note ? `※${r.note}` : ''];
      return parts.filter(Boolean).join('　');
    });
    return [head, ...noteLine, ...lines].join('\n');
  }
  function printHtml(date) {
    const day = dayRows(date);
    const tr = day.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.name)}</b>${codeOf(r.name) ? `<br>${esc(codeOf(r.name))}` : ''}</td>
      <td>${esc(r.brand)}${r.qty ? ` <b>${esc(r.qty)}</b>` : ''}${r.other ? `<br>＋${esc(r.other)}` : ''}</td><td>${esc(r.area)}</td><td>${esc(r.time)}</td><td>${esc(r.kind || '配達')}</td>
      <td>${esc(r.note)}</td><td>${r.paid ? '済' : '☐'}</td><td>☐</td></tr>`).join('');
    return `<h1>${esc(fmtDate(date))} 配達・注文一覧</h1>${notes[date] ? `<p>📝 ${esc(notes[date])}</p>` : ''}<table><thead><tr><th>順</th><th>お客様</th><th>銘柄・数量</th><th>地域</th><th>時間</th><th>区分</th><th>備考</th><th>入金</th><th>完了</th></tr></thead><tbody>${tr}</tbody></table>`;
  }
  $('#outBtn').addEventListener('click', () => {
    $('#outTitle').textContent = `${fmtDate(viewDate)} の一覧`;
    $('#outText').value = outText(viewDate);
    $('#outDlg').showModal();
  });
  $('#outClose').addEventListener('click', () => $('#outDlg').close());
  $('#outCopy').addEventListener('click', async () => {
    const t = $('#outText').value;
    try { await navigator.clipboard.writeText(t); }
    catch (e) { $('#outText').select(); try { document.execCommand('copy'); } catch (e2) { /* 手動で選んでコピーしてもらう */ } }
    toast('コピーしました。LINEなどに貼り付けられます');
  });
  $('#outPrint').addEventListener('click', () => {
    $('#printSheet').classList.remove('printweek');
    $('#printSheet').innerHTML = printHtml(viewDate);
    window.print();
  });

  $('#list').addEventListener('click', onCardClick);
  $('#invList').addEventListener('click', onCardClick);
  $('#prevDay').addEventListener('click', () => { viewDate = addDays(viewDate, -1); render(); });
  $('#nextDay').addEventListener('click', () => { viewDate = addDays(viewDate, 1); render(); });
  $('#todayBtn').addEventListener('click', () => { viewDate = today(); render(); });
  $('#dateInput').addEventListener('change', (e) => { if (e.target.value) { viewDate = e.target.value; render(); } });
  const bindFilter = (sel, key) => $(sel).addEventListener('change', (e) => { ui[key] = e.target.checked; store.set('ui', ui); render(); });
  bindFilter('#fltOpen', 'open');
  bindFilter('#fltVoid', 'void');
  bindFilter('#fltDoneOnly', 'doneOnly');

  $('#fab').addEventListener('click', () => openForm(null));
  $('#form').addEventListener('submit', saveForm);
  $('#fClose').addEventListener('click', closeForm);
  F.dlg.addEventListener('cancel', () => { editing = null; });
  document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { F.date.value = addDays(today(), Number(b.dataset.day)); }));
  $('#fVoid').addEventListener('click', () => {
    if (!editing) return;
    if (!confirm('この注文を取消にしますか？（行は消さず、記録に残ります）')) return;
    queueOp({ t: 'update', id: editing.id, changes: { status: '取消', cancelReason: $('#fReason').value }, user: cfg.user });
    closeForm(); render(); sync();
  });
  $('#fRestore').addEventListener('click', () => {
    if (!editing) return;
    queueOp({ t: 'update', id: editing.id, changes: { status: '未対応', cancelReason: '' }, user: cfg.user });
    closeForm(); render(); sync();
  });
  $('#syncBtn').addEventListener('click', () => sync(true));

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    // ダイアログは最前面に出るので、開いているときはその中に表示する
    (document.querySelector('dialog[open]') || document.body).appendChild(el);
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // ------------------------------------------------------------ 起動
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (viewDate < today() && !F.dlg.open) { /* 日付は手動で戻す */ } sync(); } });
  setInterval(() => { if (!document.hidden) sync(); }, 20000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  if (!cfg.user || !cfg.key || !cfg.apiUrl) openCfg(); else sync();
})();
