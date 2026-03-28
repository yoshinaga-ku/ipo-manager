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

// 長押し検出用（iPhoneのタッチイベントで使用）
let _longPressTimer     = null;
let _longPressTriggered = false;

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

/**
 * GAS の getValues() はスプレッドシートの日付セルを Date オブジェクトとして返す。
 * JSON.stringify() すると "2026-03-27T15:00:00.000Z" のような UTC ISO 文字列になり、
 * 末尾に 'T00:00:00' を付けると不正な文字列になって NaN になる。
 *
 * "YYYY-MM-DD" (スクレイパーが直接返す文字列) と
 * "YYYY-MM-DDThh:mm:ss.sssZ" (GAS が Date 型で返した場合) の両方に対応するため、
 * 10文字より長い場合はそのまま new Date() へ渡し、ブラウザのローカル時刻で解釈させる。
 * （日本語環境のブラウザは JST なので UTC+9 が正しく補正される）
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s || s === 'null') return null;
  const d = s.length > 10
    ? new Date(s)                    // ISO タイムスタンプ → ブラウザがローカル時刻に変換
    : new Date(s + 'T00:00:00');     // YYYY-MM-DD → ローカル時刻の 0 時として解釈
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateFull(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '未定';
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function getDaysLeft(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
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

  // BB終了後7日以内まで表示（public/app.js と同じ基準）
  const activeIpos = state.ipos.filter(ipo => {
    const days = getDaysLeft(ipo.bbEnd);
    return days === null || days >= -7;
  });
  activeIpos.sort((a, b) => {
    if (!a.bbEnd && !b.bbEnd) return 0;
    if (!a.bbEnd) return 1;
    if (!b.bbEnd) return -1;
    return a.bbEnd.localeCompare(b.bbEnd);
  });

  if (activeIpos.length === 0) {
    el.innerHTML = viewToggle + `
      <div class="empty-state">
        <div class="empty-icon">✏️</div>
        <div class="empty-title">管理対象のIPOがありません</div>
        <div class="empty-desc">一覧タブからデータを更新してください</div>
      </div>`;
    return;
  }

  if (state.applyView === 'ipo') {
    el.innerHTML = viewToggle + activeIpos.map(applyCard).join('') + '<div class="pb-bottom"></div>';
  } else {
    el.innerHTML = viewToggle + renderBrokerView(activeIpos) + '<div class="pb-bottom"></div>';
  }
}

function applyCard(ipo) {
  const chips = DEFAULT_BROKERS.map(broker => {
    const app = getApp(ipo.id, broker);
    const sc  = statusClass(app.status);
    const lots = app.lots ? `<div class="broker-chip-lots">${app.lots}口</div>` : '';
    return `<div class="broker-chip ${sc}"
             onclick="handleChipTap('${esc(ipo.id)}','${esc(broker)}')"
             oncontextmenu="handleChipLongPress('${esc(ipo.id)}','${esc(broker)}',event)"
             ontouchstart="startLongPress('${esc(ipo.id)}','${esc(broker)}')"
             ontouchend="cancelLongPress()"
             ontouchmove="cancelLongPress()">
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

// activeIpos: renderApply から渡される、BB終了後7日以内のIPO一覧
function renderBrokerView(activeIpos) {
  // 全ブローカー × 全アクティブIPO を表示（public/app.js と同じ）
  return DEFAULT_BROKERS.map(broker => {
    const rows = activeIpos.map(ipo => {
      const app   = getApp(ipo.id, broker);
      const days  = getDaysLeft(ipo.bbEnd);
      const lots  = app.lots ? `<span class="broker-ipo-lots">${app.lots}口</span>` : '';
      return `
        <div class="broker-ipo-row">
          <div class="broker-ipo-info">
            <div class="broker-ipo-name">${esc(ipo.name)}</div>
            <div class="broker-ipo-meta">BB: ${formatDate(ipo.bbEnd)}${daysLeftLabel(days)}</div>
          </div>
          <div class="broker-ipo-chip-wrap">
            ${lots}
            <div class="broker-chip ${statusClass(app.status)} broker-chip-inline"
                 onclick="handleChipTap('${esc(ipo.id)}','${esc(broker)}')"
                 oncontextmenu="handleChipLongPress('${esc(ipo.id)}','${esc(broker)}',event)"
                 ontouchstart="startLongPress('${esc(ipo.id)}','${esc(broker)}')"
                 ontouchend="cancelLongPress()"
                 ontouchmove="cancelLongPress()">
              <div class="broker-chip-status">${STATUS_LABEL[app.status]}</div>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="broker-section">
        <div class="broker-section-header">${esc(broker)}</div>
        <div class="broker-section-body">${rows}</div>
      </div>`;
  }).join('');
}

function statusClass(s) {
  return { none: 's-none', applied: 's-applied', won: 's-won', lost: 's-lost' }[s] || 's-none';
}

function setApplyView(v) {
  state.applyView = v;
  renderApply();
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
               onclick="handleChipTapInModal('${esc(ipo.id)}','${esc(broker)}')"
               oncontextmenu="handleChipLongPress('${esc(ipo.id)}','${esc(broker)}',event)"
               ontouchstart="startLongPress('${esc(ipo.id)}','${esc(broker)}')"
               ontouchend="cancelLongPress()"
               ontouchmove="cancelLongPress()">
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

// モーダル内チップのタップ：ステータス循環後にモーダルを再描画
async function handleChipTapInModal(ipoId, broker) {
  await handleChipTap(ipoId, broker);
  // lot モーダルが開いていない場合（modal-broker-grid が残っている）だけ再描画
  if (document.getElementById('modal-broker-grid')) {
    const ipo = state.ipos.find(x => x.id === ipoId);
    if (ipo) openApplyModal(ipo.id, ipo.name);
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
      <button class="btn btn-primary btn-full" onclick="confirmLots('${esc(ipoId)}','${esc(broker)}')">申込を登録</button>
      <button class="btn btn-ghost btn-full" onclick="closeModal()">キャンセル</button>
    </div>`);
}

async function confirmLots(ipoId, broker) {
  const lots = parseInt(document.getElementById('lotsInput').value) || 1;
  closeModal();
  await saveApp(ipoId, broker, 'applied', lots);
}

// ================================================================
// チップ操作（タップ・長押し）
// ================================================================

// タップ：none→applied→won→lost→none とステータスを循環
async function handleChipTap(ipoId, broker) {
  if (_longPressTriggered) return;
  const app    = getApp(ipoId, broker);
  const curIdx = STATUS_CYCLE.indexOf(app.status || 'none');
  const nextSt = STATUS_CYCLE[(curIdx + 1) % STATUS_CYCLE.length];

  if (nextSt === 'none') {
    await deleteAppEntry(ipoId, broker);
    return;
  }
  if (nextSt === 'applied' && !app.id) {
    // 初回申込：口数入力モーダルを開く
    const ipo = state.ipos.find(x => x.id === ipoId);
    openLotModal(ipoId, ipo?.name || ipoId, broker);
    return;
  }
  await saveApp(ipoId, broker, nextSt, app.lots || 1);
}

// 申込データの保存（共通ヘルパー）
async function saveApp(ipoId, broker, status, lots) {
  const ipo     = state.ipos.find(x => x.id === ipoId);
  const ipoName = ipo?.name || ipoId;
  const key     = ipoId + '::' + broker;
  const app     = getApp(ipoId, broker);
  const data    = {
    id:        app.id || genId(),
    ipoId,
    ipoName,
    broker,
    status,
    lots:      lots || 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    await apiPost({ action: 'saveApplication', data });
    state.appsMap[key] = data;
    renderApply();
    showToast(`${broker}: ${STATUS_LABEL[status]}`);
  } catch (e) {
    showToast('保存に失敗しました', 'error');
  }
}

// 申込データの削除（共通ヘルパー）
async function deleteAppEntry(ipoId, broker) {
  const app = getApp(ipoId, broker);
  const key = ipoId + '::' + broker;
  if (!app.id) {
    delete state.appsMap[key];
    renderApply();
    return;
  }
  try {
    await apiPost({ action: 'deleteApplication', id: app.id });
    delete state.appsMap[key];
    renderApply();
    showToast(`${broker}: 申込を削除しました`);
  } catch (e) {
    showToast('削除に失敗しました', 'error');
  }
}

// 長押し開始（iPhone タッチ用）
function startLongPress(ipoId, broker) {
  _longPressTriggered = false;
  clearTimeout(_longPressTimer);
  _longPressTimer = setTimeout(() => {
    _longPressTriggered = true;
    if (navigator.vibrate) navigator.vibrate(40);
    showStatusPickerModal(ipoId, broker);
  }, 600);
}

// 長押しキャンセル（touchend / touchmove）
function cancelLongPress() {
  clearTimeout(_longPressTimer);
  _longPressTimer = null;
  // click は touchend の直後に来るため 1 フレーム待ってリセット
  requestAnimationFrame(() => { _longPressTriggered = false; });
}

// デスクトップ右クリック（contextmenu）
function handleChipLongPress(ipoId, broker, event) {
  event.preventDefault();
  showStatusPickerModal(ipoId, broker);
}

// ステータス直接選択モーダル（長押し時）
function showStatusPickerModal(ipoId, broker) {
  const ipo     = state.ipos.find(x => x.id === ipoId);
  const ipoName = ipo?.name || ipoId;
  const app     = getApp(ipoId, broker);
  const curSt   = app.status || 'none';

  const statusBtns = ['applied', 'won', 'lost'].map(s => `
    <button class="btn btn-full${curSt === s ? ' btn-primary' : ' btn-ghost'}"
            style="margin-bottom:6px"
            onclick="setStatusDirectly('${esc(ipoId)}','${esc(broker)}','${s}')">
      ${STATUS_LABEL[s]}${curSt === s ? ' ✓' : ''}
    </button>`).join('');

  const deleteBtn = app.id ? `
    <button class="btn btn-danger btn-full" style="margin-top:4px"
            onclick="closeModal();deleteAppEntry('${esc(ipoId)}','${esc(broker)}')">
      申込を削除
    </button>` : '';

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${esc(broker)}</div>
    <div class="text-sub text-sm" style="margin-bottom:14px">${esc(ipoName)}</div>
    <div class="form-group">
      <label class="form-label">ステータスを選択</label>
      ${statusBtns}
    </div>
    <div class="form-group">
      <label class="form-label">申込口数</label>
      <input type="number" class="form-input" id="editLotsInput"
             value="${app.lots || 1}" min="1" style="font-size:16px" inputmode="numeric">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-full" onclick="closeModal()">閉じる</button>
      ${deleteBtn}
    </div>`);
}

// ステータスを直接設定して保存（長押しモーダルのボタンから）
async function setStatusDirectly(ipoId, broker, status) {
  const lots = parseInt(document.getElementById('editLotsInput')?.value) || 1;
  closeModal();
  await saveApp(ipoId, broker, status, lots);
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
