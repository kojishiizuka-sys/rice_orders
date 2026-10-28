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
  const ui = Object.assign({ open: false, void: false, doneOnly: false }, store.get('ui', {}));
  let tab = 'list';
  let viewDate = today();
  let lastSync = 0;
  let status = 'idle'; // idle | sync | ok | off

  const persist = () => { store.set('rows', rows); store.set('queue', queue); store.set('suggest', suggest); };

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
    rows = overlay(rows, [op]);
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
      const res = await api({ action: 'sync', ops: sent });
      if (!res.ok) {
        if (res.error === 'auth') { toast('合言葉が違います'); setStatus('off'); openCfg(); return; }
        throw new Error(res.error || 'server');
      }
      queue = queue.slice(sent.length);
      const conflicts = (res.results || []).filter((r) => !r.ok && r.error === 'conflict').length;
      if (conflicts) toast('他の人が先に更新していました。内容を確認してください');
      rows = overlay(res.rows || [], queue);
      suggest = res.suggest || suggest;
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

  function cardHtml(r, withDate) {
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
          <button type="button" data-act="prep"${on(r.status === '準備済' || r.status === '完了')}>準備</button>
          <button type="button" data-act="done"${on(r.status === '完了')}>完了</button>
          <button type="button" data-act="paid"${on(r.paid)}>入金</button>
          <button type="button" data-act="inv"${on(r.invoiced)}>伝票</button>
        </div>`;
    return `<article class="${cls.join(' ')}" data-id="${esc(r.id)}">
      <div class="top"><span class="place">${dateTxt}${place || '—'}</span><span class="kind ${r.kind === '店頭' ? 's' : ''}">${esc(r.kind || '配達')}</span></div>
      <div class="name">${esc(r.name)}</div>
      <div class="goods">${esc(r.brand)}${r.qty ? `<b>${esc(r.qty)}</b>` : ''}</div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
      ${acts}
    </article>`;
  }

  function render() {
    setStatus(status);
    // 一覧
    const isToday = viewDate === today();
    $('#dateLabel').innerHTML = esc(fmtDate(viewDate)) + (isToday ? '<span class="today">今日</span>' : '');
    $('#dateInput').value = viewDate;
    $('#fltOpen').checked = ui.open;
    $('#fltVoid').checked = ui.void;
    const dayRows = rows.filter((r) => r.date === viewDate).sort(byReceived);
    const shown = dayRows.filter((r) => (ui.void || r.status !== '取消') && (!ui.open || r.status !== '完了'));
    const live = dayRows.filter((r) => r.status !== '取消');
    const done = live.filter((r) => r.status === '完了').length;
    $('#summary').textContent = `全${live.length}件（配達${live.filter((r) => r.kind !== '店頭').length}・店頭${live.filter((r) => r.kind === '店頭').length}）／ 完了${done}・残り${live.length - done}`;
    $('#list').innerHTML = shown.length ? shown.map((r) => cardHtml(r, false)).join('') : '<p class="empty">この日の注文はありません</p>';

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
  }

  function pendingInvoice() {
    return rows.filter((r) => r.status !== '取消' && !r.paid && !r.invoiced)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || byReceived(a, b));
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
    if (!card) return;
    const id = card.dataset.id;
    const b = e.target.closest('[data-act]');
    if (b) { act(id, b.dataset.act); return; }
    const r = rows.find((x) => x.id === id);
    if (r) openForm(r);
  }

  // ------------------------------------------------------------ 入力フォーム
  const F = {
    dlg: $('#formDlg'), date: $('#fDate'), name: $('#fName'), brand: $('#fBrand'), qty: $('#fQty'),
    area: $('#fArea'), time: $('#fTime'), paid: $('#fPaid'), note: $('#fNote')
  };
  let editing = null;
  const kindValue = () => (document.querySelector('input[name=fKind]:checked') || {}).value || '配達';
  const setKind = (v) => { const el = document.querySelector(`input[name=fKind][value="${v}"]`); (el || document.querySelector('input[name=fKind]')).checked = true; };

  // 入力中の候補（過去の入力から出すだけ。マスタ照合ではない）
  function pendingValues(key) {
    return rows.map((r) => r[key]).filter(Boolean);
  }
  function candidates(key, serverKey) {
    const seen = new Set(), out = [];
    for (const v of [...pendingValues(key).reverse(), ...(suggest[serverKey] || [])]) {
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  }
  function chipsFor(boxSel, input, getList, onPick) {
    const box = $(boxSel);
    const draw = () => {
      const q = input.value.trim();
      const list = getList().filter((x) => x !== q && (!q || x.includes(q))).slice(0, 6);
      box.innerHTML = list.map((x) => `<button type="button">${esc(x)}</button>`).join('');
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

  // 「いつもの」：同じお名前の前回の注文から、空欄の項目を埋める
  function fillFromLast(name) {
    if (editing) return;
    const last = rows.filter((r) => r.name === name && r.status !== '取消').sort(byReceived).pop();
    if (!last) return;
    if (!F.brand.value) F.brand.value = last.brand || '';
    if (!F.qty.value) F.qty.value = last.qty || '';
    if (!F.area.value) F.area.value = last.area || '';
    setKind(last.kind || '配達');
    drawers.forEach((d) => d());
  }

  const drawers = [
    chipsFor('#sgName', F.name, () => candidates('name', 'names'), fillFromLast),
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
    F.name.value = r ? r.name : '';
    F.brand.value = r ? r.brand : '';
    F.qty.value = r ? r.qty : '';
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
    drawers.forEach((d) => d());
    F.dlg.showModal();
    if (!r) F.name.focus();
  }
  const closeForm = () => { if (F.dlg.open) F.dlg.close(); editing = null; };

  function saveForm(e) {
    e.preventDefault();
    const v = {
      date: F.date.value || today(),
      name: F.name.value.trim(),
      brand: F.brand.value.trim(),
      qty: F.qty.value.trim(),
      area: F.area.value.trim(),
      time: F.time.value.trim(),
      kind: kindValue(),
      note: F.note.value.trim(),
      paid: F.paid.checked
    };
    if (!v.name) { toast('お名前を入れてください'); F.name.focus(); return; }
    $('#fSave').disabled = true; // 二度押し防止
    if (!editing) {
      const dup = rows.find((r) => r.status !== '取消' && r.name === v.name && r.date === v.date &&
        Date.now() - parseTs(r.receivedAt) < 10 * 60 * 1000);
      if (dup && !confirm('同じお名前の注文が10分以内に登録されています。\n重複していませんか？\nそれでも登録しますか？')) {
        $('#fSave').disabled = false;
        return;
      }
      queueOp({
        t: 'create',
        row: Object.assign({ id: uid(), receivedAt: nowStr(), receiver: cfg.user, status: '未対応', invoiced: false, cancelReason: '' }, v)
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
    closeForm();
    render();
    sync();
  }

  // ------------------------------------------------------------ 設定
  function openCfg() {
    if ($('#cfgDlg').open) return;
    $('#cUser').value = cfg.user;
    $('#cKey').value = cfg.key;
    $('#cUrl').value = cfg.apiUrl;
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
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

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
