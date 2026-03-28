'use strict';

// ================================================================
// 設定
// ================================================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwDBWQP5Qqy2hkb2Duvi2YojtBVl_eZtdw_tAWQNzIdolpFaVXevpukoBK83oP7TQeL/exec';

const DEFAULT_BROKERS = [
  'SBI証券', '楽天証券', 'マネックス', '松井証券',
  'SMBC日興', '野村証券', '岡三証券', 'みずほ証券', '大和証券',
];

const STATUS_CYCLE = ['none', 'applied', 'won', 'lost'];
const STATUS_LABEL = { none: '未申込', applied: '申込済', won: '当選', lost: '落選' };
const TAB_TITLE    = { list: 'IPO一覧', apply: '申込管理', pnl: '損益', settings: '設定' };

// ================================================================
// アプリ状態
// ================================================================
const state = {
  tab:        'list',
  ipos:       [],
  appsMap:    {},   // 'ipoId::broker' → Application record
  results:    [],
  listFilter: 'all',
  applyView:  'ipo',
  updatedAt:  null,
};

// ================================================================
// GAS API
// ================================================================

async function apiGet(action) {
  const res = await fetch(GAS_URL + '?action=' + action);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// GAS は OPTIONS（CORS preflight）を処理しないため
// Content-Type: text/plain を使い "simple request" として送信する
async function apiPost(body) {
  const res = await fetch(GAS_URL, {
    method:   'POST',
    body:     JSON.stringify(body),
    headers:  { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ================================================================
// データ読み込み
// ================================================================

async function loadAll() {
  showLoading(true);
  try {
    const [iposRes, appsRes, resultsRes] = await Promise.all([
      apiGet('getIpos'),
      apiGet('getApplications'),
      apiGet('getResults'),
    ]);

    state.ipos      = iposRes.ipos      || [];
    state.updatedAt = iposRes.updatedAt || null;

    // 配列 → マップ変換（O(1) ルックアップのため）
    state.appsMap = {};
    (appsRes.applications || []).forEach(app => {
      if (app.ipoId && app.broker) {
        state.appsMap[app.ipoId + '::' + app.broker] = app;
      }
    });

    state.results = resultsRes.results || [];

    renderCurrent();
  } catch (err) {
    showToast('データの取得に失敗しました', 'error');
    // エラー時も空のUIを表示
    renderCurrent();
  } finally {
    showLoading(false);
  }
}

// ================================================================
// ユーティリティ
// ================================================================

function genId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateFull(dateStr) {
  if (!dateStr) return '未定';
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function getDaysLeft(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr + 'T00:00:00') - today) / 86400000);
}

function getIpoStatusKey(ipo) {
  const days = getDaysLeft(ipo.bbEnd);
  if (days === null) return 'upcoming';
  if (days < 0)      return 'closed';
  if (days <= 3)     return 'open';
  return 'upcoming';
}

function getApp(ipoId, broker) {
  return state.appsMap[ipoId + '::' + broker] || { status: 'none' };
}

function getAppliedCount(ipoId) {
  return DEFAULT_BROKERS.filter(b => getApp(ipoId, b).status !== 'none').length;
}

function daysLeftLabel(days) {
  if (days === null)  return '';
  if (days < 0)       return `（${Math.abs(days)}日前）`;
  if (days === 0)     return '（今日）';
  return `（残${days}日）`;
}

function daysLeftClass(days) {
  if (days === null || days < 0) return 'days-over';
  if (days <= 2)                 return 'days-close';
  return 'days-left';
}

// ================================================================
// トースト通知
// ================================================================

let _toastTimer = null;
function showToast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'show' + (type ? ' toast-' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

// ================================================================
// ローディング
// ================================================================

function showLoading(show) {
  document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
}

// ================================================================
// タブナビゲーション
// ================================================================

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('headerTitle').textContent = TAB_TITLE[tab];
  renderCurrent();
}

function renderCurrent() {
  switch (state.tab) {
    case 'list':     renderList();     break;
    case 'apply':    renderApply();    break;
    case 'pnl':      renderPnl();      break;
    case 'settings': renderSettings(); break;
  }
}

// ================================================================
// 一覧タブ
// ================================================================

function renderList() {
  const el = document.getElementById('tab-list');

  let ipos = state.ipos;
  if (state.listFilter !== 'all') {
    ipos = ipos.filter(ipo => getIpoStatusKey(ipo) === state.listFilter);
  }

  // ヘッダーボタンに最終更新日を表示
  const btn = document.getElementById('headerAction');
  if (state.updatedAt) {
    const d = new Date(state.updatedAt);
    btn.textContent = `↻ ${d.getMonth()+1}/${d.getDate()} 更新`;
  } else {
    btn.textContent = '↻ 更新';
  }

  const filterBar = `
    <div class="filter-bar">
      ${[['all','すべて'],['open','BB受付中'],['upcoming','近日公開'],['closed','締切済']].map(([k,l]) =>
        `<button class="filter-chip${state.listFilter===k?' active':''}" onclick="setListFilter('${k}')">${l}</button>`
      ).join('')}
    </div>`;

  if (ipos.length === 0) {
    el.innerHTML = filterBar + `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">データがありません</div>
        <div class="empty-desc">ヘッダーの「↻ 更新」を押してデータを取得してください</div>
      </div>`;
    return;
  }

  el.innerHTML = filterBar + ipos.map(ipoCard).join('') + '<div class="pb-bottom"></div>';
}

function ipoCard(ipo) {
  const sk    = getIpoStatusKey(ipo);
  const days  = getDaysLeft(ipo.bbEnd);
  const appN  = getAppliedCount(ipo.id);

  const badgeMap = {
    open:     '<span class="badge badge-open">BB受付中</span>',
    upcoming: '<span class="badge badge-upcoming">近日公開</span>',
    closed:   '<span class="badge badge-closed">締切済</span>',
  };

  return `
    <div class="ipo-card ipo-${sk}">
      <div class="ipo-card-header">
        <div>
          <div class="ipo-name">${esc(ipo.name)}</div>
          <div class="ipo-market">${esc(ipo.market || '市場未定')}</div>
        </div>
        ${badgeMap[sk] || ''}
      </div>
      <div class="ipo-card-body">
        <div class="info-row">
          <span class="info-label">BB期限</span>
          <span class="info-value ${daysLeftClass(days)}">${formatDate(ipo.bbEnd)} ${daysLeftLabel(days)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">上場日</span>
          <span class="info-value">${formatDate(ipo.listingDate)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">抽選日</span>
          <span class="info-value">${formatDate(ipo.lotteryDate)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">公募価格</span>
          <span class="info-value">${ipo.ipoPrice ? Number(ipo.ipoPrice).toLocaleString() + '円' : '未定'}</span>
        </div>
      </div>
      <div class="ipo-card-footer">
        <span class="broker-summary">${appN > 0 ? appN + '社 申込済' : '未申込'}</span>
        <button class="btn-link" onclick="openApplyModal('${esc(ipo.id)}', '${esc(ipo.name)}')">申込管理 →</button>
      </div>
    </div>`;
}

function setListFilter(f) {
  state.listFilter = f;
  renderList();
}

// ================================================================
// 申込管理タブ
// ================================================================

function renderApply() {
  const el = document.getElementById('tab-apply');

  const viewToggle = `
    <div class="view-toggle">
      <button class="view-toggle-btn${state.applyView==='ipo'?' active':''}" onclick="setApplyView('ipo')">銘柄別</button>
      <button class="view-toggle-btn${state.applyView==='broker'?' active':''}" onclick="setApplyView('broker')">証券会社別</button>
    </div>`;

  if (state.ipos.length === 0) {
    el.innerHTML = viewToggle + `
      <div class="empty-state">
        <div class="empty-icon">✏️</div>
        <div class="empty-title">IPOデータがありません</div>
        <div class="empty-desc">一覧タブからデータを更新してください</div>
      </div>`;
    return;
  }

  if (state.applyView === 'ipo') {
    el.innerHTML = viewToggle + state.ipos.map(applyCard).join('') + '<div class="pb-bottom"></div>';
  } else {
    el.innerHTML = viewToggle + renderBrokerView() + '<div class="pb-bottom"></div>';
  }
}

function applyCard(ipo) {
  const chips = DEFAULT_BROKERS.map(broker => {
    const app = getApp(ipo.id, broker);
    const sc  = statusClass(app.status);
    const lots = app.lots ? `<div class="broker-chip-lots">${app.lots}口</div>` : '';
    return `<div class="broker-chip ${sc}" onclick="cycleStatus('${esc(ipo.id)}','${esc(ipo.name)}','${esc(broker)}')">
      <div class="broker-chip-name">${esc(broker)}</div>
      <div class="broker-chip-status">${STATUS_LABEL[app.status] || '未申込'}</div>
      ${lots}
    </div>`;
  }).join('');

  return `
    <div class="apply-card">
      <div class="apply-card-name">${esc(ipo.name)}</div>
      <div class="apply-card-meta">BB: ${formatDate(ipo.bbEnd)} ／ 上場: ${formatDate(ipo.listingDate)}</div>
      <div class="broker-grid">${chips}</div>
    </div>`;
}

function renderBrokerView() {
  const sections = DEFAULT_BROKERS.map(broker => {
    const apps = state.ipos
      .map(ipo => ({ ipo, app: getApp(ipo.id, broker) }))
      .filter(({ app }) => app.status !== 'none');

    if (apps.length === 0) return '';

    const rows = apps.map(({ ipo, app }) => `
      <div class="broker-ipo-row">
        <div class="broker-ipo-info">
          <div class="broker-ipo-name">${esc(ipo.name)}</div>
          <div class="broker-ipo-meta">BB: ${formatDate(ipo.bbEnd)} ／ 上場: ${formatDate(ipo.listingDate)}</div>
        </div>
        <div class="broker-ipo-chip-wrap">
          <div class="broker-chip ${statusClass(app.status)} broker-chip-inline"
               onclick="cycleStatus('${esc(ipo.id)}','${esc(ipo.name)}','${esc(broker)}')">
            <span class="broker-chip-status">${STATUS_LABEL[app.status]}</span>
          </div>
          ${app.lots ? `<span class="broker-ipo-lots">${app.lots}口</span>` : ''}
        </div>
      </div>`).join('');

    return `
      <div class="broker-section">
        <div class="broker-section-header">${esc(broker)}</div>
        <div class="broker-section-body">${rows}</div>
      </div>`;
  }).filter(Boolean).join('');

  return sections || `
    <div class="empty-state">
      <div class="empty-icon">✏️</div>
      <div class="empty-title">申込がありません</div>
      <div class="empty-desc">銘柄別ビューから証券会社チップをタップして申込を登録してください</div>
    </div>`;
}

function statusClass(s) {
  return { none: 's-none', applied: 's-applied', won: 's-won', lost: 's-lost' }[s] || 's-none';
}

function setApplyView(v) {
  state.applyView = v;
  renderApply();
}

// ---- ステータス循環（タップで none→applied→won→lost→none） ----

async function cycleStatus(ipoId, ipoName, broker) {
  const app     = getApp(ipoId, broker);
  const curIdx  = STATUS_CYCLE.indexOf(app.status || 'none');
  const nextSt  = STATUS_CYCLE[(curIdx + 1) % STATUS_CYCLE.length];
  const key     = ipoId + '::' + broker;

  if (nextSt === 'none') {
    // 削除
    if (app.id) {
      try {
        await apiPost({ action: 'deleteApplication', id: app.id });
        delete state.appsMap[key];
        renderApply();
        showToast(`${broker}: 申込を削除しました`);
      } catch (e) {
        showToast('削除に失敗しました', 'error');
      }
    }
    return;
  }

  // 初回申込のときは口数を入力させる
  if (nextSt === 'applied' && !app.id) {
    openLotModal(ipoId, ipoName, broker);
    return;
  }

  const data = {
    id:        app.id || genId(),
    ipoId,
    ipoName,
    broker,
    status:    nextSt,
    lots:      app.lots || 1,
    updatedAt: new Date().toISOString(),
  };

  try {
    await apiPost({ action: 'saveApplication', data });
    state.appsMap[key] = data;
    renderApply();
    showToast(`${broker}: ${STATUS_LABEL[nextSt]}`);
  } catch (e) {
    showToast('保存に失敗しました', 'error');
  }
}

// ---- 一覧タブから開く申込モーダル ----

function openApplyModal(ipoId, ipoName) {
  const ipo = state.ipos.find(x => x.id === ipoId);
  if (!ipo) return;

  openModal(buildApplyModalHtml(ipo));
}

function buildApplyModalHtml(ipo) {
  const chips = DEFAULT_BROKERS.map(broker => {
    const app = getApp(ipo.id, broker);
    const sc  = statusClass(app.status);
    const lots = app.lots ? `<div class="broker-chip-lots">${app.lots}口</div>` : '';
    return `<div class="broker-chip ${sc}"
               onclick="cycleStatusInModal('${esc(ipo.id)}','${esc(ipo.name)}','${esc(broker)}')">
      <div class="broker-chip-name">${esc(broker)}</div>
      <div class="broker-chip-status">${STATUS_LABEL[app.status] || '未申込'}</div>
      ${lots}
    </div>`;
  }).join('');

  return `
    <div class="modal-handle"></div>
    <div class="modal-title">${esc(ipo.name)}</div>
    <div class="text-sub text-sm" style="margin-bottom:12px">
      BB期限: ${formatDate(ipo.bbEnd)} ／ 上場: ${formatDate(ipo.listingDate)}
      ${ipo.ipoPrice ? ` ／ 公募: ${Number(ipo.ipoPrice).toLocaleString()}円` : ''}
    </div>
    <div class="broker-grid" id="modal-broker-grid">${chips}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-full" onclick="closeModal()">閉じる</button>
    </div>`;
}

async function cycleStatusInModal(ipoId, ipoName, broker) {
  await cycleStatus(ipoId, ipoName, broker);
  // モーダル内のチップを再描画
  const ipo = state.ipos.find(x => x.id === ipoId);
  if (ipo) {
    const grid = document.getElementById('modal-broker-grid');
    if (grid) grid.outerHTML = buildApplyModalHtml(ipo)
      .match(/<div class="broker-grid"[^>]*>([\s\S]*?)<\/div>/)?.[0] || '';
    // 再描画は openApplyModal を呼び直すほうが確実
    openApplyModal(ipoId, ipoName);
  }
}

// ---- 口数入力モーダル ----

function openLotModal(ipoId, ipoName, broker) {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${esc(broker)} へ申込</div>
    <div class="text-sub text-sm" style="margin-bottom:14px">${esc(ipoName)}</div>
    <div class="form-group">
      <label class="form-label">申込口数</label>
      <input type="number" class="form-input" id="lotsInput" value="1" min="1" max="100"
             style="font-size:16px" inputmode="numeric">
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="confirmLots('${esc(ipoId)}','${esc(ipoName)}','${esc(broker)}')">申込を登録</button>
      <button class="btn btn-ghost btn-full" onclick="closeModal()">キャンセル</button>
    </div>`);
}

async function confirmLots(ipoId, ipoName, broker) {
  const lots = parseInt(document.getElementById('lotsInput').value) || 1;
  const key  = ipoId + '::' + broker;
  const data = {
    id:        genId(),
    ipoId,
    ipoName,
    broker,
    status:    'applied',
    lots,
    updatedAt: new Date().toISOString(),
  };

  try {
    await apiPost({ action: 'saveApplication', data });
    state.appsMap[key] = data;
    closeModal();
    renderApply();
    showToast(`${broker}: 申込登録しました`, 'success');
  } catch (e) {
    showToast('保存に失敗しました', 'error');
  }
}

// ================================================================
// 損益タブ
// ================================================================

function renderPnl() {
  const el = document.getElementById('tab-pnl');

  const results     = state.results;
  const totalProfit = results.reduce((s, r) => s + (Number(r.profit) || 0), 0);
  const wonCount    = results.filter(r => (Number(r.profit) || 0) > 0).length;
  const lostCount   = results.filter(r => (Number(r.profit) || 0) < 0).length;

  const stats = `
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-value ${totalProfit >= 0 ? 'positive' : 'negative'}">
          ${totalProfit >= 0 ? '+' : ''}${totalProfit.toLocaleString()}
        </div>
        <div class="stat-label">累計損益（円）</div>
      </div>
      <div class="stat-card">
        <div class="stat-value positive">+${wonCount}</div>
        <div class="stat-label">プラス件数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value negative">${lostCount}</div>
        <div class="stat-label">マイナス件数</div>
      </div>
    </div>`;

  const addBtn = `
    <div style="padding: 0 0 12px">
      <button class="btn btn-primary btn-full" onclick="openAddResultModal()">＋ 損益を記録</button>
    </div>`;

  if (results.length === 0) {
    el.innerHTML = stats + `
      <div class="empty-state">
        <div class="empty-icon">📈</div>
        <div class="empty-title">損益データがありません</div>
        <div class="empty-desc">下のボタンから記録してください</div>
      </div>` + addBtn;
    return;
  }

  const list = results.slice().reverse().map(r => {
    const profit = Number(r.profit) || 0;
    return `
      <div class="result-item" onclick="openEditResultModal('${esc(r.id)}')">
        <div class="result-left">
          <div class="result-name">${esc(r.ipoName || '（銘柄不明）')}</div>
          <div class="result-meta">${esc(r.broker || '')} ／ ${r.wonLots || 1}口 ／ ${formatDateFull(r.settledAt)}</div>
        </div>
        <div class="result-profit ${profit >= 0 ? 'positive' : 'negative'}">
          ${profit >= 0 ? '+' : ''}${profit.toLocaleString()}円
        </div>
      </div>`;
  }).join('');

  el.innerHTML = stats + list + addBtn + '<div class="pb-bottom"></div>';
}

// ---- 損益登録・編集モーダル ----

function openAddResultModal() {
  const ipoOptions = state.ipos.map(ipo =>
    `<option value="${esc(ipo.id)}" data-price="${ipo.ipoPrice || ''}">${esc(ipo.name)}</option>`
  ).join('');

  const today = new Date().toISOString().slice(0, 10);
  const brokerOpts = [...DEFAULT_BROKERS, 'その他']
    .map(b => `<option>${esc(b)}</option>`).join('');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">損益を記録</div>
    <input type="hidden" id="r-id" value="">

    <div class="form-group">
      <label class="form-label">銘柄</label>
      <select class="form-input" id="r-ipo-id" onchange="onResultIpoChange()" style="font-size:16px">
        <option value="">— 銘柄を選択 —</option>
        ${ipoOptions}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">証券会社</label>
      <select class="form-input" id="r-broker" style="font-size:16px">${brokerOpts}</select>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">当選口数</label>
        <input type="number" class="form-input" id="r-lots" value="1" min="1"
               style="font-size:16px" inputmode="numeric">
      </div>
      <div class="form-group">
        <label class="form-label">公募価格（円）</label>
        <input type="number" class="form-input" id="r-ipo-price" placeholder="例: 1500"
               oninput="calcProfit()" style="font-size:16px" inputmode="numeric">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">売却価格（円）</label>
      <input type="number" class="form-input" id="r-sell-price" placeholder="例: 2000"
             oninput="calcProfit()" style="font-size:16px" inputmode="numeric">
    </div>

    <div id="r-profit-preview" style="display:none;background:#f8fafc;border-radius:8px;padding:10px;text-align:center;margin-bottom:12px">
      <div style="font-size:11px;color:#6b7280;margin-bottom:2px">損益（概算・1口=100株）</div>
      <div id="r-profit-val" style="font-size:20px;font-weight:800"></div>
    </div>

    <div class="form-group">
      <label class="form-label">確定日</label>
      <input type="date" class="form-input" id="r-settled-at" value="${today}" style="font-size:16px">
    </div>

    <div class="modal-actions" id="result-modal-actions">
      <button class="btn btn-primary btn-full" onclick="saveResult()">保存</button>
      <button class="btn btn-ghost btn-full" onclick="closeModal()">キャンセル</button>
    </div>`);
}

function openEditResultModal(id) {
  const r = state.results.find(x => x.id === id);
  if (!r) return;

  openAddResultModal();

  document.getElementById('r-id').value        = r.id;
  document.getElementById('r-ipo-id').value    = r.ipoId || '';
  document.getElementById('r-broker').value    = r.broker || DEFAULT_BROKERS[0];
  document.getElementById('r-lots').value      = r.wonLots || 1;
  document.getElementById('r-ipo-price').value = r.ipoPrice || '';
  document.getElementById('r-sell-price').value= r.sellPrice || '';
  document.getElementById('r-settled-at').value= r.settledAt ? r.settledAt.slice(0, 10) : '';

  document.getElementById('result-modal-actions').insertAdjacentHTML('beforeend',
    `<button class="btn btn-danger btn-full" onclick="deleteResult('${esc(id)}')">削除</button>`
  );

  calcProfit();
}

function onResultIpoChange() {
  const sel   = document.getElementById('r-ipo-id');
  const price = sel.selectedOptions[0]?.dataset.price;
  if (price) {
    document.getElementById('r-ipo-price').value = price;
    calcProfit();
  }
}

function calcProfit() {
  const lots    = parseInt(document.getElementById('r-lots')?.value)      || 1;
  const ipoPrc  = parseFloat(document.getElementById('r-ipo-price')?.value);
  const sellPrc = parseFloat(document.getElementById('r-sell-price')?.value);
  const preview = document.getElementById('r-profit-preview');
  const val     = document.getElementById('r-profit-val');
  if (!preview) return;

  if (isNaN(ipoPrc) || isNaN(sellPrc)) { preview.style.display = 'none'; return; }

  const profit = (sellPrc - ipoPrc) * lots * 100;
  preview.style.display = 'block';
  val.textContent = (profit >= 0 ? '+' : '') + profit.toLocaleString() + '円';
  val.style.color = profit >= 0 ? '#16a34a' : '#dc2626';
}

async function saveResult() {
  const id        = document.getElementById('r-id').value;
  const ipoId     = document.getElementById('r-ipo-id').value;
  const ipoName   = document.getElementById('r-ipo-id').selectedOptions[0]?.text || '';
  const broker    = document.getElementById('r-broker').value;
  const wonLots   = parseInt(document.getElementById('r-lots').value)       || 1;
  const ipoPrice  = parseFloat(document.getElementById('r-ipo-price').value)  || null;
  const sellPrice = parseFloat(document.getElementById('r-sell-price').value) || null;
  const settledAt = document.getElementById('r-settled-at').value || new Date().toISOString().slice(0, 10);

  const profit = (ipoPrice && sellPrice) ? (sellPrice - ipoPrice) * wonLots * 100 : null;

  const data = {
    id:        id || genId(),
    ipoId,
    ipoName:   ipoName.replace('— 銘柄を選択 —', '').trim(),
    broker,
    wonLots,
    ipoPrice,
    sellPrice,
    profit,
    settledAt,
  };

  try {
    await apiPost({ action: 'saveResult', data });
    if (id) {
      const idx = state.results.findIndex(r => r.id === id);
      if (idx >= 0) state.results[idx] = data; else state.results.push(data);
    } else {
      state.results.push(data);
    }
    closeModal();
    renderPnl();
    showToast('損益を保存しました', 'success');
  } catch (e) {
    showToast('保存に失敗しました', 'error');
  }
}

async function deleteResult(id) {
  if (!confirm('この損益データを削除しますか？')) return;
  try {
    await apiPost({ action: 'deleteResult', id });
    state.results = state.results.filter(r => r.id !== id);
    closeModal();
    renderPnl();
    showToast('削除しました');
  } catch (e) {
    showToast('削除に失敗しました', 'error');
  }
}

// ================================================================
// 設定タブ
// ================================================================

function renderSettings() {
  const el      = document.getElementById('tab-settings');
  const updated = state.updatedAt
    ? new Date(state.updatedAt).toLocaleString('ja-JP')
    : '未取得';

  el.innerHTML = `
    <div class="settings-section">
      <div class="settings-title">データ管理</div>
      <div class="settings-card">
        <div class="settings-row" onclick="runScrape()">
          <span class="settings-row-label">📥 IPOデータを今すぐ更新</span>
          <span class="settings-row-value">→</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">🕐 最終更新</span>
          <span class="settings-row-value">${esc(updated)}</span>
        </div>
        <div class="settings-row" onclick="runSyncCalendar()">
          <span class="settings-row-label">📅 Googleカレンダーへ同期</span>
          <span class="settings-row-value">→</span>
        </div>
        <div class="settings-row" onclick="runSyncCalendarAll()">
          <span class="settings-row-label">🔄 カレンダー全件再同期</span>
          <span class="settings-row-value">→</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-title">アプリ情報</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label">バージョン</span>
          <span class="settings-row-value">1.0.0</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">データソース</span>
          <span class="settings-row-value">ipokiso / minkabu</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">バックエンド</span>
          <span class="settings-row-value">Google Apps Script</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-title">PWAインストール</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label" style="font-size:0.82rem;line-height:1.5">
            iPhoneでホーム画面に追加する場合は<br>
            Safari の共有ボタン →「ホーム画面に追加」
          </span>
        </div>
      </div>
    </div>`;
}

// ================================================================
// スクレイピング / カレンダー同期
// ================================================================

async function runScrape() {
  const btn = document.getElementById('headerAction');
  const orig = btn.textContent;
  btn.textContent = '更新中…';
  btn.disabled    = true;
  showLoading(true);

  try {
    await apiGet('scrape');
    await loadAll();
    showToast('データを更新しました', 'success');
  } catch (e) {
    showToast('更新に失敗しました', 'error');
    showLoading(false);
  } finally {
    btn.textContent = orig;
    btn.disabled    = false;
  }
}

async function runSyncCalendar() {
  showToast('カレンダーに同期中…');
  try {
    const res = await apiGet('syncCalendar');
    showToast(`${res.count || 0}件 カレンダーに登録しました`, 'success');
  } catch (e) {
    showToast('同期に失敗しました', 'error');
  }
}

async function runSyncCalendarAll() {
  if (!confirm('同期済みリストをリセットして全件再登録しますか？')) return;
  try {
    const res = await apiGet('syncCalendarAll');
    showToast(`${res.count || 0}件 再登録しました`, 'success');
  } catch (e) {
    showToast('同期に失敗しました', 'error');
  }
}

// ================================================================
// モーダルヘルパー
// ================================================================

function openModal(content) {
  const modal   = document.getElementById('modal');
  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalContent').innerHTML = content;
  modal.classList.remove('hidden');
  overlay.onclick = closeModal;
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ================================================================
// 初期化
// ================================================================

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('headerAction').addEventListener('click', runScrape);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

loadAll();
