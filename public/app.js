'use strict';

/* ============================ 基础工具 ============================ */
// Codex 解读暂时下线（后端接口保留，改成 true 即可恢复）
const CODEX_ENABLED = true;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  roots: [],
  pins: [],
  repos: [],
  repo: null,          // { path, name }
  base: null,
  current: null,
  branches: [],
  remoteBranches: [],
  stats: null,
  status: null,
  tab: 'branches',
  filter: 'all',
  q: '',
  selected: new Set(),
  cmp: { base: null, head: null, data: null, file: null },
  hist: { ref: null, mode: 'message', q: '', author: '', path: '', data: null, commit: null },
  diffMode: (() => { try { return localStorage.getItem('gitdeck.diffMode') || 'unified'; } catch (_) { return 'unified'; } })(),
  codex: { running: false, text: '', title: '', abort: null, startedAt: 0, timer: null },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = Date.now() - t;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  if (d < 365 * 86400e3) return Math.floor(d / (30 * 86400e3)) + ' 个月前';
  const dt = new Date(t);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, 3200);
}

async function api(pathname, params = {}) {
  const u = new URL(pathname, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  const r = await fetch(u);
  const data = await r.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!r.ok || data.ok === false) throw new Error(data.error || `请求失败 (${r.status})`);
  return data;
}

async function apiPost(pathname, body) {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!r.ok || data.ok === false) throw new Error(data.error || `请求失败 (${r.status})`);
  return data;
}

/* ============================ 启动 ============================ */
async function boot() {
  try {
    const cfg = await api('/api/config');
    S.roots = cfg.roots || [];
    renderRoots();
    await loadRepos();
    if (cfg.lastRepo && S.repos.some((r) => r.path === cfg.lastRepo)) {
      await openRepo(cfg.lastRepo);
    } else if (S.repos.length) {
      await openRepo(S.repos[0].path);
    } else {
      renderEmpty();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function loadRepos() {
  const data = await api('/api/repos');
  S.repos = data.repos || [];
  S.roots = data.roots || S.roots;
  S.pins = data.pins || S.pins;
  renderRepoList();
  renderRoots();
}

function renderRoots() {
  $('#roots').innerHTML = S.roots.map((r) => `<span title="${esc(r)}">${esc(r.replace(/^\/Users\/[^/]+/, '~'))}</span>`).join('');
}

function renderRepoList() {
  const q = $('#repo-filter').value.trim().toLowerCase();
  const list = S.repos.filter((r) => !q || r.path.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  if (!list.length) {
    $('#repo-list').innerHTML = `<div class="loading">没有找到仓库<br><span class="dim">点下方「添加目录」</span></div>`;
    return;
  }
  const pinnedSet = new Set(S.pins || []);
  const hasPinned = list.some((r) => pinnedSet.has(r.path));
  let sepShown = false;

  $('#repo-list').innerHTML = list.map((r) => {
    const isPin = pinnedSet.has(r.path);
    let sep = '';
    if (hasPinned && !isPin && !sepShown) {
      sep = '<div class="repo-sep" title="以下为其它仓库"></div>';
      sepShown = true;
    }
    return sep + `
    <div class="repo-item ${S.repo && S.repo.path === r.path ? 'active' : ''} ${isPin ? 'pinned' : ''}" data-path="${esc(r.path)}">
      <div class="rbody">
        <div class="rname">${esc(r.name)}</div>
        <div class="rmeta">${esc(r.subject || '（空仓库）')}</div>
      </div>
      <div class="rbranch" title="${esc(r.branch)}">${esc(r.branch)}</div>
      <button class="repo-pin" data-pin="${esc(r.path)}" title="${isPin ? '取消置顶' : '置顶到最前'}">${isPin ? '★' : '☆'}</button>
    </div>`;
  }).join('');
}

async function togglePin(path) {
  const isPinned = (S.pins || []).includes(path);
  try {
    const res = await apiPost('/api/repos/pin', { path, pinned: !isPinned });
    S.pins = res.pins || S.pins;
    await loadRepos();
    renderRepoList();
    if (res.pinned) toast('已置顶', 'ok');
    else if (res.removedFromList) toast('已取消置顶；该仓库不在扫描目录内，已从列表移除', '');
    else toast('已取消置顶', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderEmpty() {
  $('#repo-name').textContent = '未选择仓库';
  $('#repo-path').textContent = '从左侧选择一个 Git 仓库';
  $('#view-branches').innerHTML = `<div class="empty-state"><div class="big">还没有打开仓库</div><div>在左侧列表点一个仓库，或「添加目录」把代码根目录加进来</div></div>`;
}

/* ============================ 打开仓库 ============================ */
async function openRepo(path) {
  const view = $('#view-branches');
  $('#repo-path').textContent = path + ' · 读取中…';
  $('#repo-name').textContent = path.split('/').pop() || path;
  view.innerHTML = `<div class="loading"><span class="spinner"></span> 正在读取 ${esc(path)}…</div>`;
  try {
    const data = await api('/api/repo', { path });
    S.repo = { path: data.repo, name: data.repo.split('/').pop() };
    S.base = data.base;
    S.current = data.current;
    S.branches = data.branches || [];
    S.remoteBranches = data.remotes_branches || [];
    S.stats = data.stats;
    S.status = data.status;
    S.selected.clear();
    S.cmp = { base: data.base, head: null, data: null, file: null };
    S.hist = { ref: data.current || data.base, mode: 'message', q: '', author: '', path: '', data: null, commit: null };
    const h = location.hash.replace('#', '');
    if (['branches', 'compare', 'history'].includes(h)) S.tab = h;
    renderHead();
    renderRepoList();
    renderBaseSelect();
    renderActiveTab();
  } catch (e) {
    view.innerHTML = `<div class="empty-state"><div class="big">打开失败</div><div>${esc(e.message)}</div></div>`;
    toast(e.message, 'err');
  }
}

function renderHead() {
  $('#repo-name').textContent = S.repo.name;
  $('#repo-path').textContent = S.repo.path;
  const chip = $('#head-chip');
  chip.classList.remove('hidden');
  chip.textContent = S.current || 'detached';
  const dirtyCount = S.status && S.status.files ? S.status.files.length : 0;
  const db = $('#repo-dirty');
  if (dirtyCount) { db.classList.remove('hidden'); db.textContent = `${dirtyCount} 个未提交`; }
  else db.classList.add('hidden');
}

function renderBaseSelect() {
  const names = S.branches.map((b) => b.name).concat(S.remoteBranches.map((b) => b.name));
  const sel = $('#base-select');
  sel.innerHTML = names.map((n) => `<option value="${esc(n)}" ${n === S.base ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

/* ============================ 分支视图 ============================ */
function visibleRemotes() {
  const q = S.q.trim().toLowerCase();
  return S.remoteBranches.filter((b) =>
    !q ||
    b.name.toLowerCase().includes(q) ||
    (b.subject || '').toLowerCase().includes(q) ||
    (b.author || '').toLowerCase().includes(q));
}

function remoteRow(b) {
  const sel = S.selected.has(b.name);
  const localTwin = S.branches.find((x) => x.name === b.shortName);
  const tags = ['<span class="tag remote">远端</span>'];
  if (localTwin) tags.push('<span class="tag plain">本地已有</span>');
  if (b.ahead && b.behind) tags.push(`<span class="tag plain">↑${b.ahead} ↓${b.behind}</span>`);
  else if (b.ahead) tags.push(`<span class="tag plain">领先 ${b.ahead}</span>`);
  else if (b.behind) tags.push(`<span class="tag plain">落后 ${b.behind}</span>`);
  return `<tr class="${sel ? 'sel' : ''} remote-row" data-name="${esc(b.name)}" data-remote="1">
    <td class="c-chk"><input type="checkbox" class="row-check" ${sel ? 'checked' : ''} /></td>
    <td class="c-name">
      <div class="row"><span class="bname">${esc(b.name)}</span></div>
      <div class="mono-sm">${esc(b.sha)} · ${esc(b.remote || '')}</div>
    </td>
    <td><div class="row">${tags.join('')}</div></td>
    <td class="c-subject"><span class="subj" title="${esc(b.subject)}">${esc(b.subject)}</span></td>
    <td class="c-author" title="${esc(b.email)}">${esc(b.author)}</td>
    <td class="c-date" title="${esc(b.date)}">${relTime(b.date)}</td>
    <td class="c-ops">
      <button class="row-btn" data-act="compare">对比</button>
      <button class="row-btn danger" data-act="del">删除</button>
    </td>
  </tr>`;
}

function selectedItems() {
  const out = [];
  for (const name of S.selected) {
    const local = S.branches.find((b) => b.name === name);
    if (local) { out.push(local); continue; }
    const remote = S.remoteBranches.find((b) => b.name === name);
    if (remote) out.push(remote);
  }
  return out;
}

function visibleBranches() {
  const q = S.q.trim().toLowerCase();
  let list = S.branches.slice();
  if (S.filter === 'merged') list = list.filter((b) => b.merged);
  else if (S.filter === 'gone') list = list.filter((b) => b.upstreamGone);
  else if (S.filter === 'unmerged') list = list.filter((b) => !b.merged && !b.isCurrent);
  else if (S.filter === 'stale') list = list.filter((b) => b.date && Date.now() - Date.parse(b.date) > 30 * 864e5);
  else if (S.filter === 'remote') return [];
  if (q) {
    list = list.filter((b) =>
      b.name.toLowerCase().includes(q) ||
      (b.subject || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q));
  }
  return list;
}

function renderBranches() {
  if (!S.repo) return renderEmpty();
  if (S.filter === 'remote') return renderRemoteBranches();

  const rows = visibleBranches();
  const remoteRows = S.filter === 'all' ? visibleRemotes() : [];
  const st = S.stats || { total: 0, merged: 0, gone: 0, unmerged: 0 };
  const allChecked = rows.length > 0 && rows.every((b) => S.selected.has(b.name));

  const html = `
    <div class="toolbar">
      <div class="seg" id="branch-filters">
        <button data-f="all" class="${S.filter === 'all' ? 'on' : ''}">全部<span class="cnt">${S.branches.length}</span></button>
        <button data-f="merged" class="${S.filter === 'merged' ? 'on' : ''}">已合并<span class="cnt">${st.merged}</span></button>
        <button data-f="gone" class="${S.filter === 'gone' ? 'on' : ''}">上游已删<span class="cnt">${st.gone}</span></button>
        <button data-f="unmerged" class="${S.filter === 'unmerged' ? 'on' : ''}">未合并<span class="cnt">${st.unmerged}</span></button>
        <button data-f="stale" class="${S.filter === 'stale' ? 'on' : ''}">30 天未动</button>
        <button data-f="remote" class="${S.filter === 'remote' ? 'on' : ''}">远端<span class="cnt">${S.remoteBranches.length}</span></button>
      </div>
      <input id="branch-q" class="search-box" placeholder="过滤分支 / 提交信息 / 作者…" value="${esc(S.q)}" />
      <div class="spacer"></div>
      <button class="btn-ghost" id="select-safe" title="选中所有已合并或上游已删除的分支">⚡ 选中可安全删除</button>
      <button class="btn-ghost" id="clear-sel">清空</button>
    </div>
    <table class="btable">
      <thead>
        <tr>
          <th class="c-chk"><input type="checkbox" id="check-all" ${allChecked ? 'checked' : ''} /></th>
          <th class="c-name">分支</th>
          <th>状态</th>
          <th class="c-subject">最新提交</th>
          <th class="c-author">作者</th>
          <th class="c-date">时间</th>
          <th class="c-ops"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(branchRow).join('')}
        ${remoteRows.length ? `<tr class="group-row"><td colspan="7">
          <span class="g-title">远端分支</span>
          <span class="cnt">${remoteRows.length}</span>
          <span class="g-hint">勾选后删除会执行 git push --delete</span>
        </td></tr>
        ${remoteRows.map(remoteRow).join('')}` : ''}
        ${!rows.length && !remoteRows.length ? `<tr><td colspan="7"><div class="empty-state">没有匹配的分支</div></td></tr>` : ''}
      </tbody>
    </table>
    ${S.selected.size ? bulkBarHTML() : '<div style="height:12px"></div>'}
  `;
  $('#view-branches').innerHTML = html;
}

function branchRow(b) {
  const tags = [];
  if (b.isCurrent) tags.push('<span class="tag current">当前</span>');
  if (b.isBase) tags.push('<span class="tag base">基准</span>');
  if (b.merged && !b.isCurrent) tags.push('<span class="tag merged">已合并</span>');
  if (!b.merged && !b.isCurrent && b.ahead > 0) tags.push(`<span class="tag unmerged">未合并 ${b.ahead}</span>`);
  if (b.upstreamGone) tags.push('<span class="tag gone">上游已删</span>');
  if (b.worktreePath) {
    const dirty = b.worktreeDirty ? ` · ${b.worktreeDirty} 处改动` : '';
    tags.push(`<span class="tag worktree" title="${esc(b.worktreePath)}">worktree${dirty}</span>`);
  }
  if (b.ahead && b.behind) tags.push(`<span class="tag plain">↑${b.ahead} ↓${b.behind}</span>`);
  else if (b.ahead && !b.merged) tags.push(`<span class="tag plain">领先 ${b.ahead}</span>`);
  else if (b.behind) tags.push(`<span class="tag plain">落后 ${b.behind}</span>`);
  const sel = S.selected.has(b.name);

  return `<tr class="${sel ? 'sel' : ''} ${b.isCurrent ? 'is-current' : ''}" data-name="${esc(b.name)}">
    <td class="c-chk"><input type="checkbox" class="row-check" ${sel ? 'checked' : ''} ${b.isCurrent ? 'disabled' : ''} /></td>
    <td class="c-name">
      <div class="row">
        <span class="bname">${esc(b.name)}</span>
      </div>
      <div class="mono-sm">${esc(b.sha)}${b.upstream ? ' · ' + esc(b.upstream) : ' · 无上游'}</div>
    </td>
    <td><div class="row">${tags.join('')}</div></td>
    <td class="c-subject"><span class="subj" title="${esc(b.subject)}">${esc(b.subject)}</span></td>
    <td class="c-author" title="${esc(b.email)}">${esc(b.author)}</td>
    <td class="c-date" title="${esc(b.date)}">${relTime(b.date)}</td>
    <td class="c-ops">
      <button class="row-btn" data-act="compare">对比</button>
      <button class="row-btn danger" data-act="del">删除</button>
    </td>
  </tr>`;
}

function bulkBarHTML() {
  const sel = selectedItems();
  const unmerged = sel.filter((b) => !b.isRemote && !b.merged && !b.isCurrent);
  const remoteCount = sel.filter((b) => b.isRemote).length;
  return `<div class="bulkbar">
    <span class="count">已选 <b>${sel.length}</b> 个分支${remoteCount ? ` · <span style="color:var(--amber)">${remoteCount} 个远端</span>` : ''}${unmerged.length ? ` · <span style="color:var(--amber)">${unmerged.length} 个未合并</span>` : ''}</span>
    <span class="spacer"></span>
    <button class="btn-ghost" id="bulk-clear">取消选择</button>
    <button class="btn-danger" id="bulk-del">删除 ${sel.length} 个分支</button>
  </div>`;
}

function renderRemoteBranches() {
  const q = S.q.trim().toLowerCase();
  const rows = S.remoteBranches.filter((b) => !q || b.name.toLowerCase().includes(q));
  $('#view-branches').innerHTML = `
    <div class="toolbar">
      <div class="seg" id="branch-filters">
        <button data-f="all">全部</button>
        <button data-f="merged">已合并</button>
        <button data-f="gone">上游已删</button>
        <button data-f="unmerged">未合并</button>
        <button data-f="stale">30 天未动</button>
        <button data-f="remote" class="on">远端<span class="cnt">${S.remoteBranches.length}</span></button>
      </div>
      <input id="branch-q" class="search-box" placeholder="过滤远端分支…" value="${esc(S.q)}" />
      <div class="spacer"></div>
      <span class="mono-sm">远端分支删除会执行 git push --delete</span>
    </div>
    <table class="btable">
      <thead><tr><th class="c-name">远端分支</th><th>提交</th><th class="c-author">作者</th><th class="c-date">时间</th><th class="c-ops"></th></tr></thead>
      <tbody>
        ${rows.map((b) => `<tr data-name="${esc(b.name)}" data-remote="1">
          <td class="c-name"><span class="bname">${esc(b.name)}</span> <span class="tag remote">remote</span></td>
          <td class="c-subject"><span class="subj" title="${esc(b.subject)}">${esc(b.subject)}</span></td>
          <td class="c-author">${esc(b.author)}</td>
          <td class="c-date">${relTime(b.date)}</td>
          <td class="c-ops">
            <button class="row-btn" data-act="compare">对比</button>
            <button class="row-btn danger" data-act="del">删除</button>
          </td>
        </tr>`).join('') || `<tr><td colspan="5"><div class="empty-state">没有远端分支</div></td></tr>`}
      </tbody>
    </table>`;
}

/* ============================ 删除流程 ============================ */
function openDeleteModal(names, opts = {}) {
  const items = names
    .map((n) => S.branches.find((b) => b.name === n) || S.remoteBranches.find((b) => b.name === n))
    .filter(Boolean);
  if (!items.length) return;
  const hasRemoteItems = items.some((b) => b.isRemote);

  const remoteCounterparts = items
    .map((b) => {
      if (b.isRemote) return null;
      if (b.upstreamGone) return null;         // 远端已经没了，不用再删一次
      if (b.upstream) return b.upstream;
      const guess = S.remoteBranches.find((r) => r.shortName === b.name);
      return guess ? guess.name : null;
    })
    .filter(Boolean);

  // 远端分支没有「是否已合并」的概念，不参与强制删除判断
  const unmerged = items.filter((b) => !b.isRemote && !b.merged && !b.isCurrent);
  const needForce = unmerged.length > 0;
  const wtItems = items.filter((b) => b.worktreePath);
  const dirtyWt = wtItems.filter((b) => b.worktreeDirty > 0);

  const rowsHtml = items.map((b) => {
    const bits = [];
    if (b.isCurrent) bits.push('<span class="tag current">当前分支</span>');
    if (b.merged) bits.push('<span class="tag merged">已合并</span>');
    if (!b.isRemote && !b.merged && !b.isCurrent) bits.push(`<span class="tag unmerged">未合并 ${b.ahead}</span>`);
    if (b.upstreamGone) bits.push('<span class="tag gone">上游已删</span>');
    if (b.isRemote) bits.push('<span class="tag remote">远端</span>');
    if (b.worktreePath) bits.push(`<span class="tag worktree">worktree${b.worktreeDirty ? ' · ' + b.worktreeDirty : ''}</span>`);
    return `<div class="del-row"><span class="n">${esc(b.name)}</span>${bits.join('')}</div>`;
  }).join('');

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        删除 ${items.length} 个分支
        <div class="sub">${esc(S.repo.path)}</div>
      </div>
      <div class="modal-body">
        <div class="del-list">${rowsHtml}</div>
        ${needForce ? `<div class="warn-box">
          <b>${unmerged.length} 个分支含有未合并的提交</b>，删除后这些提交会从分支指针上丢失（reflog 里还能找回约 90 天）。
        </div>` : ''}
        ${wtItems.length ? `<div class="warn-box">
          <b>${wtItems.length} 个分支正被 worktree 检出</b>，git 不允许直接删除。勾选下方选项会先移除这些 worktree（目录会被删掉）。
          <div class="wt-list">${wtItems.map((b) => `<div>${esc(b.worktreePath)}${b.worktreeDirty ? ` <span style="color:#ff8fa0">· ${b.worktreeDirty} 处未提交改动</span>` : ''}</div>`).join('')}</div>
        </div>
        <label class="opt-row"><input type="checkbox" id="opt-wt" /> 同时移除这些 worktree 再删除分支</label>
        ${dirtyWt.length ? `<label class="opt-row"><input type="checkbox" id="opt-wt-discard" /> 我知道 worktree 里有 <b style="color:#ff8fa0">${dirtyWt.reduce((n, b) => n + b.worktreeDirty, 0)} 处未提交改动</b>，仍要丢弃（不可恢复）</label>` : ''}` : ''}
        ${remoteCounterparts.length ? `<label class="opt-row"><input type="checkbox" id="opt-remote" ${opts.remote ? 'checked' : ''} />
          同时删除远端分支（${remoteCounterparts.length} 个：${esc(remoteCounterparts.slice(0, 3).join(', '))}${remoteCounterparts.length > 3 ? ' 等' : ''}）</label>` : ''}
        ${needForce ? `<label class="opt-row"><input type="checkbox" id="opt-force" />
          我知道有未合并的提交，仍然强制删除（git branch -D）</label>` : ''}
      </div>
      <div class="modal-foot">
        <span class="mono-sm">删除后可用 reflog 恢复已提交内容</span>
        <span class="spacer"></span>
        <button class="btn-ghost" id="m-cancel">取消</button>
        <button class="btn-danger" id="m-ok" ${needForce ? 'disabled' : ''}>确认删除</button>
      </div>
    </div>`;
  $('#modal-root').appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  $('#m-cancel', mask).addEventListener('click', close);

  const okBtn = $('#m-ok', mask);
  const refreshOk = () => {
    const forceOk = !needForce || !!($('#opt-force', mask) && $('#opt-force', mask).checked);
    const wtBox = $('#opt-wt', mask);
    const discBox = $('#opt-wt-discard', mask);
    const wtOk = !wtItems.length
      || (!!wtBox && wtBox.checked && (!dirtyWt.length || (!!discBox && discBox.checked)));
    okBtn.disabled = !(forceOk && wtOk);
  };
  ['#opt-force', '#opt-wt', '#opt-wt-discard'].forEach((sel) => {
    const box = $(sel, mask);
    if (box) box.addEventListener('change', refreshOk);
  });
  refreshOk();
  $('#m-ok', mask).addEventListener('click', async () => {
    const btn = $('#m-ok', mask);
    btn.disabled = true;
    btn.textContent = '删除中…';
    const deleteRemote = hasRemoteItems || !!($('#opt-remote', mask) && $('#opt-remote', mask).checked);
    const removeWorktrees = !!($('#opt-wt', mask) && $('#opt-wt', mask).checked);
    const force = needForce;
    const branches = items.map((b) => ({ name: b.name, remote: !!b.isRemote }));
    if (deleteRemote && !items.some((b) => b.isRemote)) {
      for (const r of remoteCounterparts) branches.push({ name: r, remote: true });
    }
    try {
      const res = await apiPost('/api/branch/delete', { path: S.repo.path, branches, force, deleteRemote, removeWorktrees });
      const ok = res.results.filter((r) => r.ok).length;
      const bad = res.results.filter((r) => !r.ok);
      close();
      toast(bad.length ? `已删除 ${ok} 个，${bad.length} 个失败：${bad[0].error}` : `已删除 ${ok} 个分支`, bad.length ? 'err' : 'ok');
      await refreshRepo(true);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '确认删除';
      toast(e.message, 'err');
    }
  });
}

/* ============================ 刷新 ============================ */
async function syncRepo() {
  if (!S.repo) return;
  const btn = $('#sync-btn');
  if (btn) btn.classList.add('busy');
  try {
    const r = await apiPost('/api/sync', { path: S.repo.path, pull: true });
    if (r.error) toast(`已获取远端更新，但拉取未完成：${r.error}`, 'err');
    else toast(r.message || '已同步', 'ok');
    await loadRepos();
    await refreshRepo(true);
    renderRepoList();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}

async function refreshRepo(keepView = false) {
  if (!S.repo) return;
  const data = await api('/api/branches', { path: S.repo.path, base: S.base });
  S.branches = data.branches;
  S.remoteBranches = data.remotes_branches;
  S.stats = data.stats;
  S.current = data.current;
  for (const n of Array.from(S.selected)) {
    if (!S.branches.some((b) => b.name === n)) S.selected.delete(n);
  }
  const st = await api('/api/status', { path: S.repo.path }).catch(() => null);
  if (st) S.status = st;
  renderHead();
  renderBaseSelect();
  if (!keepView) renderActiveTab();
  else renderBranches();
}

/* ============================ 对比视图 ============================ */
function renderCompare() {
  if (!S.repo) return renderEmpty();
  const names = S.branches.map((b) => b.name).concat(S.remoteBranches.map((b) => b.name));
  const base = S.cmp.base || S.base;
  const candidates = S.branches.filter((b) => !b.isCurrent && !b.isBase)
    .sort((a, b) => (b.ahead - a.ahead) || String(b.date || '').localeCompare(String(a.date || '')));
  const head = S.cmp.head || (S.current !== base ? S.current : (candidates[0] || {}).name);

  // 只有一个分支（或基准即当前且没有其它分支）时，没有可对比的目标
  if (!head) {
    $('#view-compare').innerHTML = `<div class="empty-state">
      <div class="big">这个仓库没有可对比的其它分支</div>
      <div>当前基准是 <code>${esc(base || '—')}</code>，切到「分支」页勾选一个分支点「对比」即可</div>
    </div>`;
    return;
  }

  const d = S.cmp.data;
  $('#view-compare').innerHTML = `
    <div class="fill">
      <div class="pane-head">
        <div class="cmp-form">
          <span class="dim" style="font-size:11.5px">基准</span>
          <select id="cmp-base">${names.map((n) => `<option ${n === base ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <span class="cmp-arrow">→</span>
          <select id="cmp-head">${names.map((n) => `<option ${n === head ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <button class="btn-ghost" id="cmp-swap" title="对调">⇄</button>
          <button class="btn-ghost" id="cmp-run">比较</button>
        </div>
        <div class="spacer" style="flex:1"></div>
        ${d ? `<div class="stat-chips">
          <span class="stat-chip">领先 <b>${d.ahead}</b></span>
          <span class="stat-chip">落后 <b>${d.behind}</b></span>
          <span class="stat-chip">文件 <b>${d.totals.files}</b></span>
          <span class="stat-chip add">+<b>${d.totals.adds}</b></span>
          <span class="stat-chip del">-<b>${d.totals.dels}</b></span>
        </div>` : ''}
        ${CODEX_ENABLED ? `<button class="btn-accent" id="cmp-codex" ${d ? '' : 'disabled'}>✦ Codex 解读差异</button>` : ''}
      </div>
      <div class="fill-row">
        <div class="split-left">
          ${d ? `
            <div class="section-label"><span>提交 ${d.commits.length}</span><span>${esc(base)}..${esc(head)}</span></div>
            <div class="clist" style="max-height:42%;overflow:auto">${d.commits.map((c) => commitItemHTML(c, null)).join('') || '<div class="loading">没有独有提交</div>'}</div>
            <div class="section-label"><span>文件 ${d.files.length}</span><span>+${d.totals.adds} -${d.totals.dels}</span></div>
            <div class="scroll" id="cmp-files">${filesListHTML(d.files)}</div>
          ` : `<div class="loading"><span class="spinner"></span> 加载中…</div>`}
        </div>
        <div class="split-right">
          <div class="pane-head">
            <span class="title" id="cmp-diff-title">${d ? '全部差异' : ''}</span>
            <span class="sub" id="cmp-diff-sub"></span>
            <div class="spacer" style="flex:1"></div>
            ${diffModeToggleHTML()}
            <button class="btn-ghost" id="cmp-all-diff">全部差异</button>
            <button class="btn-ghost" id="cmp-copy">复制 patch</button>
          </div>
          <div class="diff-pane" id="cmp-diff"></div>
        </div>
      </div>
    </div>`;

  if (!d) { loadCompare(base, head); return; }
  if (!S.cmp.file) loadWholeDiff();
  else loadFileDiff(S.cmp.file, 'cmp-diff');
}

function commitItemHTML(c, active) {
  const refs = c.refs.filter((r) => !/^HEAD$/.test(r)).slice(0, 3)
    .map((r) => `<span class="ref-badge">${esc(r)}</span>`).join(' ');
  return `<div class="citem ${active === c.sha ? 'active' : ''}" data-sha="${esc(c.sha)}">
    <div class="csha">${esc(c.short)}</div>
    <div class="cbody">
      <div class="cmsg" title="${esc(c.subject)}">${esc(c.subject)}</div>
      <div class="cmeta">${esc(c.author)} · ${relTime(c.date)} ${refs}</div>
    </div>
  </div>`;
}

function filesListHTML(files) {
  if (!files.length) return '<div class="loading">没有文件差异</div>';
  return files.map((f) => `
    <div class="fitem" data-path="${esc(f.path)}">
      <span class="fstat-badge ${esc(f.status)}">${esc(f.status)}</span>
      <span class="fpath" title="${esc(f.path)}">${esc(f.path)}</span>
      <span class="fstat">${f.adds == null ? 'bin' : `<span class="a">+${f.adds}</span> <span class="d">-${f.dels}</span>`}</span>
    </div>`).join('');
}

async function loadCompare(base, head) {
  S.cmp.base = base;
  S.cmp.head = head;
  S.cmp.file = null;
  const pane = $('#cmp-diff');
  if (pane) pane.innerHTML = `<div class="loading"><span class="spinner"></span> 对比中…</div>`;
  try {
    const d = await api('/api/compare', { path: S.repo.path, base, head });
    S.cmp.data = d;
    renderCompare();
  } catch (e) {
    toast(e.message, 'err');
    if (pane) pane.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

async function loadWholeDiff() {
  const pane = $('#cmp-diff');
  if (!pane) return;
  pane.innerHTML = `<div class="loading"><span class="spinner"></span> 读取 diff…</div>`;
  try {
    const r = await api('/api/diff', { path: S.repo.path, base: S.cmp.base, head: S.cmp.head });
    S.cmp.file = null;
    $('#cmp-diff-title').textContent = '全部差异';
    $('#cmp-diff-sub').textContent = `${S.cmp.base}...${S.cmp.head}${r.truncated ? ' · 已截断' : ''}`;
    paintDiff(pane, r.patch);
    $$('#cmp-files .fitem').forEach((el) => el.classList.remove('active'));
  } catch (e) {
    pane.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

async function loadFileDiff(file, target = 'cmp-diff') {
  const pane = $('#' + target);
  if (!pane) return;
  pane.innerHTML = `<div class="loading"><span class="spinner"></span> 读取 diff…</div>`;
  try {
    const params = { path: S.repo.path, file };
    if (S.tab === 'history' && S.hist.commit) {
      params.sha = S.hist.commit.sha;
      params.mode = 'commit';
    } else {
      params.base = S.cmp.base;
      params.head = S.cmp.head;
    }
    const r = await api('/api/diff', params);
    const title = target === 'cmp-diff' ? $('#cmp-diff-title') : $('#commit-diff-title');
    if (title) title.textContent = file;
    const sub = target === 'cmp-diff' ? $('#cmp-diff-sub') : null;
    if (sub) sub.textContent = r.truncated ? '已截断' : '';
    paintDiff(pane, r.patch);
  } catch (e) {
    pane.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

/* ============================ 历史视图 ============================ */
function renderHistory() {
  if (!S.repo) return renderEmpty();
  const rawRefs = [
    { v: S.current || 'HEAD', l: `当前分支 (${S.current || 'HEAD'})` },
    { v: S.base, l: `基准分支 (${S.base})` },
    { v: '--all', l: '所有分支' },
    { v: '--branches', l: '所有本地分支' },
  ].concat(S.branches.filter((b) => b.name !== S.current && b.name !== S.base).map((b) => ({ v: b.name, l: b.name })));
  const seenRef = new Set();
  const refs = rawRefs.filter((r) => r.v && !seenRef.has(r.v) && seenRef.add(r.v));

  const d = S.hist.data;
  $('#view-history').innerHTML = `
    <div class="fill">
      <div class="pane-head">
        <select id="h-ref" class="hsel">${refs.map((r) => `<option value="${esc(r.v)}" ${r.v === S.hist.ref ? 'selected' : ''}>${esc(r.l)}</option>`).join('')}</select>
        <select id="h-mode" class="hsel">
          <option value="message" ${S.hist.mode === 'message' ? 'selected' : ''}>提交信息</option>
          <option value="code" ${S.hist.mode === 'code' ? 'selected' : ''}>代码改动 (-S)</option>
          <option value="content" ${S.hist.mode === 'content' ? 'selected' : ''}>当前代码内容</option>
        </select>
        <input id="h-q" class="search-box" style="min-width:220px" placeholder="关键词…" value="${esc(S.hist.q)}" />
        <input id="h-author" class="search-box" style="min-width:120px" placeholder="作者" value="${esc(S.hist.author)}" list="author-list" />
        <datalist id="author-list"></datalist>
        <input id="h-path" class="search-box" style="min-width:150px" placeholder="文件/目录路径" value="${esc(S.hist.path)}" />
        <button class="btn-primary sm" id="h-run">搜索</button>
        <button class="btn-ghost" id="h-reset">重置</button>
      </div>
      <div class="fill-row">
        <div class="split-left">
          <div class="section-label"><span>${d ? (d.mode === 'content' ? `匹配 ${d.count}` : `提交 ${d.count}`) : '结果'}</span><span>${d ? esc(d.ref) : ''}</span></div>
          <div class="scroll" id="h-results">${d ? histResultsHTML(d) : '<div class="loading">设置条件后搜索</div>'}</div>
        </div>
        <div class="split-right" id="h-detail">
          ${S.hist.commit ? '' : `<div class="empty-state"><div class="big">选一个提交看实际文件变化</div><div>支持按关键词、作者、文件路径组合筛选</div></div>`}
        </div>
      </div>
    </div>`;

  if (S.hist.commit) renderCommitDetail(S.hist.commit);
  loadAuthors();
  if (!S.hist.data) runSearch(true);
}

function histResultsHTML(d) {
  if (d.mode === 'content') {
    if (!d.matches.length) return '<div class="loading">没有匹配</div>';
    return d.matches.map((m) => `<div class="citem" data-file="${esc(m.file)}" data-line="${esc(m.line)}">
      <div class="csha">${esc(m.line)}</div>
      <div class="cbody">
        <div class="cmsg mono-sm" style="font-family:var(--mono);font-size:11px">${esc(m.file)}</div>
        <div class="cmeta" style="font-family:var(--mono);font-size:10.5px">${esc(m.text)}</div>
      </div>
    </div>`).join('');
  }
  if (!d.commits.length) return '<div class="loading">没有匹配的提交</div>';
  return d.commits.map((c) => {
    const extra = c.files ? `<div class="cmeta" style="font-family:var(--mono);font-size:10px;color:var(--dim2)">${esc(c.files.slice(0, 3).join(', '))}</div>` : '';
    return commitItemHTML(c, S.hist.commit ? S.hist.commit.sha : null) + extra;
  }).join('');
}

async function loadAuthors() {
  try {
    const r = await api('/api/authors', { path: S.repo.path, ref: S.hist.ref || S.current });
    const dl = $('#author-list');
    if (dl) dl.innerHTML = (r.authors || []).map((a) => `<option value="${esc(a.name)}">${a.count} 提交</option>`).join('');
  } catch (_) {}
}

async function runSearch(silent) {
  const d = S.hist;
  const res = $('#h-results');
  if (res) res.innerHTML = `<div class="loading"><span class="spinner"></span> 搜索中…</div>`;
  try {
    const data = await api('/api/log', {
      path: S.repo.path, ref: d.ref, mode: d.mode, keyword: d.q,
      author: d.author, pathFilter: d.path, limit: 300,
    });
    d.data = data;
    const pane = $('#h-results');
    if (pane) pane.innerHTML = histResultsHTML(data);
    const label = pane && pane.parentElement.querySelector('.section-label');
    if (label) label.innerHTML = `<span>${data.mode === 'content' ? `匹配 ${data.count}` : `提交 ${data.count}`}</span><span>${esc(data.ref)}</span>`;
    if (!data.count && !silent) toast('没有匹配结果');
  } catch (e) {
    if (res) res.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    toast(e.message, 'err');
  }
}

async function openCommit(sha) {
  const pane = $('#h-detail');
  if (pane) pane.innerHTML = `<div class="loading"><span class="spinner"></span> 读取提交…</div>`;
  try {
    const c = await api('/api/commit', { path: S.repo.path, sha });
    S.hist.commit = c;
    $$('#h-results .citem').forEach((el) => el.classList.toggle('active', el.dataset.sha === sha));
    renderCommitDetail(c);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderCommitDetail(c) {
  const pane = $('#h-detail');
  if (!pane) return;
  pane.innerHTML = `
    <div class="commit-head">
      <div class="commit-subject">${esc(c.subject)}</div>
      <div class="commit-meta">
        <span class="mono-sm">${esc(c.short)}</span>
        <span>${esc(c.author)}</span>
        <span>${esc(c.date)}</span>
        ${c.parents.length > 1 ? '<span class="tag plain">merge</span>' : ''}
        ${c.refs.map((r) => `<span class="ref-badge">${esc(r)}</span>`).join(' ')}
        <span class="spacer" style="flex:1"></span>
        ${CODEX_ENABLED ? '<button class="btn-accent sm" id="commit-codex">✦ Codex 解读</button>' : ''}
        <button class="btn-ghost" id="commit-copy">复制 patch</button>
      </div>
      ${c.body && c.body.trim() ? `<div class="commit-body">${esc(c.body.trim())}</div>` : ''}
    </div>
    <div class="difftotal">${c.files.length} 个文件 · ${c.args || ''}</div>
    <div class="scroll" style="max-height:150px;flex:0 0 auto;border-bottom:1px solid var(--line)">${filesListHTML(c.files)}</div>
    <div class="pane-head">
      <span class="title" id="commit-diff-title">全部差异</span>
      <div class="spacer" style="flex:1"></div>
      ${diffModeToggleHTML()}
    </div>
    <div class="diff-pane" id="commit-diff"></div>`;

  paintDiff($('#commit-diff'), c.patch);

  $$('#h-detail .fitem').forEach((el) => {
    el.addEventListener('click', () => {
      $$('#h-detail .fitem').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      loadCommitFileDiff(el.dataset.path);
    });
  });
}

async function loadCommitFileDiff(file) {
  const pane = $('#commit-diff');
  if (!pane || !S.hist.commit) return;
  pane.innerHTML = `<div class="loading"><span class="spinner"></span> 读取 diff…</div>`;
  try {
    const r = await api('/api/diff', { path: S.repo.path, sha: S.hist.commit.sha, mode: 'commit', file });
    $('#commit-diff-title').textContent = file;
    paintDiff(pane, r.patch);
  } catch (e) {
    pane.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

/* ============================ diff 渲染 ============================ */
const DIFF_MAX_LINES = 9000;

/** 把 unified patch 解析成结构，供统一/并排两种视图复用 */
function parsePatch(patch) {
  const files = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { header: line, pathA: '', pathB: '', status: 'M', adds: 0, dels: 0, hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('--- ')) { cur.pathA = line.slice(4).replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) { cur.pathB = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('new file')) { cur.status = 'A'; continue; }
    if (line.startsWith('deleted file')) { cur.status = 'D'; continue; }
    if (line.startsWith('rename from')) { cur.status = 'R'; continue; }
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      cur.hunks.push({ header: line, lines: [], cur: m ? { o: Number(m[1]), n: Number(m[2]) } : null });
      continue;
    }
    const h = cur.hunks[cur.hunks.length - 1];
    if (!h || !h.cur) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('diff ')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-' && sign !== ' ') continue;
    const text = line.slice(1);
    if (sign === '+') {
      h.lines.push({ type: 'add', text, oldNo: null, newNo: h.cur.n++ });
      cur.adds++;
    } else if (sign === '-') {
      h.lines.push({ type: 'del', text, oldNo: h.cur.o++, newNo: null });
      cur.dels++;
    } else {
      h.lines.push({ type: 'ctx', text, oldNo: h.cur.o++, newNo: h.cur.n++ });
    }
  }
  return files;
}

function renderUnifiedFile(f) {
  let rows = '';
  let budget = DIFF_MAX_LINES;
  for (const h of f.hunks) {
    rows += `<div class="hunk-head">${esc(h.header)}</div>`;
    for (const l of h.lines) {
      if (budget-- <= 0) {
        return `<div class="dlines">${rows}<div class="dline meta"><span class="ln"></span><span class="sign"></span><span class="txt">…（截断）</span></div></div>`;
      }
      if (l.type === 'add') rows += `<div class="dline add"><span class="ln">${l.newNo}</span><span class="sign">+</span><span class="txt">${esc(l.text)}</span></div>`;
      else if (l.type === 'del') rows += `<div class="dline del"><span class="ln">${l.oldNo}</span><span class="sign">-</span><span class="txt">${esc(l.text)}</span></div>`;
      else rows += `<div class="dline"><span class="ln">${l.oldNo}</span><span class="sign"></span><span class="txt">${esc(l.text)}</span></div>`;
    }
  }
  return `<div class="dlines">${rows}</div>`;
}

function splitRow(left, right) {
  const cls = (x) => (!x ? 'empty' : x.type === 'del' ? 'del' : x.type === 'add' ? 'add' : '');
  const no = (x) => (x ? (x.type === 'add' ? x.newNo : x.oldNo) : '');
  return `<tr>
    <td class="ln">${no(left)}</td>
    <td class="code left ${cls(left)}">${left ? esc(left.text) : ''}</td>
    <td class="ln">${no(right)}</td>
    <td class="code ${cls(right)}">${right ? esc(right.text) : ''}</td>
  </tr>`;
}

function renderSplitFile(f) {
  let rows = '';
  let budget = DIFF_MAX_LINES;
  let truncated = false;

  outer: for (const h of f.hunks) {
    rows += `<tr><td class="hunk-row" colspan="4">${esc(h.header)}</td></tr>`;
    let i = 0;
    while (i < h.lines.length) {
      if (budget-- <= 0) { truncated = true; break outer; }
      const l = h.lines[i];
      if (l.type === 'ctx') {
        rows += splitRow(l, l);
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < h.lines.length && h.lines[i].type !== 'ctx') {
        (h.lines[i].type === 'del' ? dels : adds).push(h.lines[i]);
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        if (budget-- <= 0) { truncated = true; break outer; }
        rows += splitRow(dels[k] || null, adds[k] || null);
      }
    }
  }
  if (truncated) rows += `<tr><td colspan="4" class="hunk-row">…（截断）</td></tr>`;
  return `<table class="dtable"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup><tbody>${rows}</tbody></table>`;
}

function renderFiles(files, mode) {
  if (!files.length) return `<div class="empty-state">没有文本差异（可能是二进制或空提交）</div>`;
  let out = '';
  for (const f of files) {
    const shown = f.pathB || f.pathA || f.header.split(' b/').pop();
    out += `<div class="diff-file">
      <div class="diff-file-head">
        <span class="fstat-badge ${f.status}">${f.status}</span>
        <span class="p">${esc(shown)}</span>
        <span class="s"><span class="a" style="color:var(--green)">+${f.adds}</span> <span class="d" style="color:var(--red)">-${f.dels}</span></span>
      </div>
      ${mode === 'split' ? renderSplitFile(f) : renderUnifiedFile(f)}
    </div>`;
  }
  return out;
}

/** 渲染到容器并缓存解析结果，便于切换视图 */
function paintDiff(el, patch) {
  if (!el) return;
  const text = patch || '';
  el.__patch = text;
  el.__files = text.trim() ? parsePatch(text) : [];
  el.innerHTML = renderFiles(el.__files, S.diffMode);
}

function diffModeToggleHTML() {
  return `<div class="seg seg-xs">
    <button data-dm="unified" class="${S.diffMode === 'unified' ? 'on' : ''}">统一</button>
    <button data-dm="split" class="${S.diffMode === 'split' ? 'on' : ''}">并排</button>
  </div>`;
}

function setDiffMode(mode) {
  if (mode !== 'split' && mode !== 'unified') return;
  S.diffMode = mode;
  try { localStorage.setItem('gitdeck.diffMode', mode); } catch (_) {}
  $$('[data-dm]').forEach((b) => b.classList.toggle('on', b.dataset.dm === mode));
  $$('.diff-pane').forEach((el) => {
    if (el.__files) el.innerHTML = renderFiles(el.__files, mode);
  });
}

/* ============================ Codex 抽屉 ============================ */
function openDrawer(title) {
  if (!CODEX_ENABLED) return;
  const d = $('#drawer');
  d.classList.add('open');
  $('#drawer-title').textContent = title || 'Codex 解读';
  $('#drawer-model').textContent = 'codex · read-only';
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  if (S.codex.abort) {
    try { S.codex.abort(); } catch (_) {}
    S.codex.abort = null;
  }
  S.codex.running = false;
  stopTimer();
  const stopBtn = $('#drawer-stop');
  if (stopBtn) stopBtn.classList.add('hidden');
  const dot = $('.dot-live');
  if (dot) dot.classList.remove('running');
  setDrawerStatus('已停止', false);
}

function setDrawerStatus(text, running) {
  $('#drawer-status').innerHTML = running
    ? `<span class="spinner"></span><span>${esc(text)}</span>`
    : esc(text);
  $('.dot-live').classList.toggle('running', !!running);
  const stop = $('#drawer-stop');
  if (stop) stop.classList.toggle('hidden', !running);
}

function stopTimer() {
  if (S.codex.timer) { clearInterval(S.codex.timer); S.codex.timer = null; }
}

async function runCodex(payload, title) {
  if (!CODEX_ENABLED) return;
  if (S.codex.running && S.codex.abort) { try { S.codex.abort(); } catch (_) {} }
  openDrawer(title);
  const body = $('#drawer-body');
  body.className = 'drawer-body streaming blink';
  body.textContent = '';
  S.codex.text = '';
  S.codex.running = true;
  S.codex.startedAt = Date.now();
  setDrawerStatus('启动 codex…', true);
  stopTimer();
  S.codex.timer = setInterval(() => {
    if (!S.codex.running) return;
    const s = Math.floor((Date.now() - S.codex.startedAt) / 1000);
    const el = $('#drawer-status span:last-child');
    if (el) el.textContent = el.textContent.replace(/ · \d+s$/, '') + ` · ${s}s`;
  }, 1000);

  const ac = new AbortController();
  S.codex.abort = ac;

  // 流式输出按 80ms 批量刷一次，避免每行都触发布局导致界面卡顿
  let pending = '';
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    body.appendChild(document.createTextNode(pending));
    pending = '';
    body.scrollTop = body.scrollHeight;
  };
  const pushDelta = (text) => {
    pending += text + '\n';
    if (!flushTimer) flushTimer = setTimeout(flush, 80);
  };

  try {
    const res = await fetch('/api/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error('codex 调用失败 (' + res.status + ')');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let obj = {};
        try { obj = JSON.parse(data); } catch (_) {}
        if (ev === 'delta') {
          S.codex.text += obj.text + '\n';
          pushDelta(obj.text);
        } else if (ev === 'status') {
          setDrawerStatus(obj.text || '处理中…', true);
        } else if (ev === 'log') {
          const st = $('#drawer-status');
          st.innerHTML = `<span class="spinner"></span><span>${esc((obj.text || '').slice(0, 90))}</span>`;
        } else if (ev === 'final') {
          finalText = obj.text || S.codex.text;
        } else if (ev === 'error') {
          body.className = 'drawer-body';
          body.innerHTML = `<div class="warn-box">${esc(obj.text)}</div>`;
        }
      }
    }

    S.codex.running = false;
    stopTimer();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
    body.classList.remove('blink', 'streaming');
    if (finalText.trim()) {
      S.codex.text = finalText;
      body.className = 'drawer-body md';
      body.innerHTML = md(finalText);
    } else if (!body.innerHTML.trim() || body.classList.contains('streaming')) {
      body.className = 'drawer-body md';
      body.innerHTML = md(S.codex.text || '（没有输出）');
    }
    const secs = Math.round((Date.now() - S.codex.startedAt) / 1000);
    setDrawerStatus(`完成 · ${secs}s · 只读沙箱，未改动工作区`, false);
  } catch (e) {
    if (e.name === 'AbortError') {
      setDrawerStatus('已停止', false);
      stopTimer();
      S.codex.running = false;
      return;
    }
    S.codex.running = false;
    stopTimer();
    body.className = 'drawer-body';
    body.innerHTML = `<div class="warn-box">${esc(e.message)}</div>`;
    setDrawerStatus('出错', false);
  }
}

function codexForCompare() {
  const d = S.cmp.data;
  if (!d) return;
  runCodex({
    mode: 'branch',
    repo: S.repo.path,
    base: d.base,
    head: d.head,
    stats: { files: d.totals.files, adds: d.totals.adds, dels: d.totals.dels },
    files: d.files,
    commits: d.commits,
  }, `解读 ${d.base} → ${d.head}`);
}

function codexForCommit() {
  const c = S.hist.commit;
  if (!c) return;
  runCodex({
    mode: 'commit',
    repo: S.repo.path,
    sha: c.sha,
    commits: [{ short: c.short, author: c.author, subject: c.subject }],
    files: c.files,
    stats: { files: c.files.length, adds: c.files.reduce((s, f) => s + (f.adds || 0), 0), dels: c.files.reduce((s, f) => s + (f.dels || 0), 0) },
  }, `解读提交 ${c.short}`);
}

/* ============================ markdown ============================ */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      closeList();
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lv = m[1].length <= 2 ? 2 : 3;
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      i++;
      continue;
    }
    if ((m = l.match(/^\s*[-*+]\s+(.*)$/))) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      i++;
      continue;
    }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      i++;
      continue;
    }
    if (!l.trim()) { closeList(); i++; continue; }
    closeList();
    const buf = [l];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*```)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}

/* ============================ 添加目录弹窗 ============================ */
function openRootModal() {
  $('.modal-mask') && $('.modal-mask').remove();

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        添加目录
        <div class="sub">可以填代码根目录（自动扫描其中所有仓库），也可以直接填某个仓库路径</div>
      </div>
      <div class="modal-body">
        <div class="root-input-row">
          <input id="root-input" class="search-box" placeholder="~/code    或    /Users/you/code/my-project" spellcheck="false" />
          <button class="btn-ghost" id="root-browse">选择目录…</button>
        </div>
        <div class="hint">点「选择目录…」从访达里挑，或直接粘贴路径（多个用换行/逗号分隔）；单个仓库会自动固定在列表顶部</div>
        <div class="roots-editor" id="roots-editor"></div>
      </div>
      <div class="modal-foot">
        <span class="mono-sm" id="root-msg"></span>
        <span class="spacer"></span>
        <button class="btn-ghost" id="root-cancel">关闭</button>
        <button class="btn-primary" id="root-ok">添加</button>
      </div>
    </div>`;
  $('#modal-root').appendChild(mask);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });

  renderRootsEditor(mask);

  const input = $('#root-input', mask);
  setTimeout(() => input.focus(), 30);
  $('#root-cancel', mask).addEventListener('click', () => mask.remove());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRoot(mask); });
  $('#root-ok', mask).addEventListener('click', () => submitRoot(mask));

  const browse = $('#root-browse', mask);
  browse.addEventListener('click', async () => {
    const msg = $('#root-msg', mask);
    browse.disabled = true;
    const old = browse.textContent;
    browse.textContent = '选择中…';
    try {
      const res = await Promise.race([
        apiPost('/api/pick-dir', {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('选择框没有响应，请手动输入路径')), 120000)),
      ]);
      if (res.canceled) return;
      if (res.path) {
        input.value = res.path;
        await submitRoot(mask);
      }
    } catch (e) {
      msg.textContent = e.message;
      msg.style.color = 'var(--red)';
    } finally {
      browse.disabled = false;
      browse.textContent = old;
      if (!mask.isConnected) return;
    }
  });
}

function renderRootsEditor(mask) {
  const box = $('#roots-editor', mask);
  if (!box) return;
  const rows = S.roots.map((r) => ({ path: r, kind: '根目录' }))
    .concat(S.pins.map((r) => ({ path: r, kind: '置顶' })));
  box.innerHTML = rows.length
    ? rows.map((r) => `<div class="root-row">
        <span class="tag ${r.kind === '置顶' ? 'current' : 'plain'}">${r.kind}</span>
        <span class="p">${esc(r.path.replace(/^\/Users\/[^/]+/, '~'))}</span>
        <button class="row-btn" data-remove="${esc(r.path)}">移除</button>
      </div>`).join('')
    : '<div class="hint">还没有添加任何目录</div>';
  box.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiPost('/api/config/roots/remove', { root: btn.dataset.remove });
        S.roots = res.roots;
        await loadRepos();
        renderRootsEditor(mask);
        toast('已移除', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

async function submitRoot(mask) {
  const input = $('#root-input', mask);
  const msg = $('#root-msg', mask);
  const parts = input.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) { input.focus(); return; }
  let last = null;
  for (const part of parts) {
    try {
      const res = await apiPost('/api/config/roots', { root: part });
      last = res.added;
      msg.textContent = `已添加 ${parts.length} 个`;
    } catch (e) {
      msg.textContent = e.message;
      msg.style.color = 'var(--red)';
      return;
    }
  }
  await loadRepos();
  renderRootsEditor(mask);
  input.value = '';
  if (last && last.type === 'repo') {
    mask.remove();
    await openRepo(last.path);
  }
  toast('已添加', 'ok');
}

/* ============================ 事件绑定 ============================ */
function bind() {
  // 仓库列表
  $('#repo-list').addEventListener('click', (e) => {
    const pinBtn = e.target.closest('.repo-pin');
    if (pinBtn) {
      e.stopPropagation();
      togglePin(pinBtn.dataset.pin);
      return;
    }
    const item = e.target.closest('.repo-item');
    if (item) openRepo(item.dataset.path);
  });
  $('#repo-filter').addEventListener('input', renderRepoList);

  $('#add-root').addEventListener('click', openRootModal);

  // tabs
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    S.tab = t.dataset.tab;
    location.hash = S.tab;
    renderActiveTab();
  });

  $('#base-select').addEventListener('change', async (e) => {
    S.base = e.target.value;
    S.cmp.base = S.base;
    await refreshRepo(false);
  });

  $('#refresh').addEventListener('click', async () => {
    try { await refreshRepo(); toast('已刷新（本地状态）', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });

  $('#sync-btn').addEventListener('click', () => {
    syncRepo().catch((e) => toast(e.message, 'err'));
  });

  // 分支视图（事件委托）
  $('#view-branches').addEventListener('click', async (e) => {
    const f = e.target.closest('#branch-filters button');
    if (f) { S.filter = f.dataset.f; renderBranches(); return; }

    if (e.target.id === 'select-safe') {
      for (const b of visibleBranches()) {
        if (!b.isCurrent && !b.worktreePath && (b.merged || b.upstreamGone)) S.selected.add(b.name);
      }
      if (!S.selected.size) toast('没有可安全删除的分支');
      renderBranches();
      return;
    }
    if (e.target.id === 'clear-sel' || e.target.id === 'bulk-clear') { S.selected.clear(); renderBranches(); return; }
    if (e.target.id === 'bulk-del') { openDeleteModal(Array.from(S.selected)); return; }

    const row = e.target.closest('tr[data-name]');
    if (!row) return;
    const name = row.dataset.name;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'compare') {
      S.tab = 'compare';
      S.cmp = { base: S.base, head: name, data: null, file: null };
      $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'compare'));
      renderActiveTab();
      return;
    }
    if (act && act.dataset.act === 'del') {
      if (row.dataset.remote) openDeleteModal([name], { remote: true });
      else openDeleteModal([name]);
      return;
    }
    // 点击行切换选中（当前分支不可选）
    if (e.target.tagName !== 'INPUT') {
      if (row.classList.contains('is-current')) return;
      if (S.selected.has(name)) S.selected.delete(name); else S.selected.add(name);
      renderBranches();
    }
  });

  $('#view-branches').addEventListener('change', (e) => {
    if (e.target.id === 'check-all') {
      const rows = visibleBranches();
      if (e.target.checked) rows.forEach((b) => { if (!b.isCurrent) S.selected.add(b.name); });
      else rows.forEach((b) => S.selected.delete(b.name));
      renderBranches();
    }
    if (e.target.classList.contains('row-check')) {
      const tr = e.target.closest('tr[data-name]');
      if (!tr) return;
      if (e.target.checked) S.selected.add(tr.dataset.name);
      else S.selected.delete(tr.dataset.name);
      renderBranches();
    }
  });

  $('#view-branches').addEventListener('input', (e) => {
    if (e.target.id !== 'branch-q') return;
    S.q = e.target.value;
    const pos = e.target.selectionStart;
    renderBranches();
    const box = $('#branch-q');
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  });

  // 对比视图
  $('#view-compare').addEventListener('click', async (e) => {
    if (e.target.id === 'cmp-run') {
      return loadCompare($('#cmp-base').value, $('#cmp-head').value);
    }
    if (e.target.id === 'cmp-swap') {
      const a = $('#cmp-base').value, b = $('#cmp-head').value;
      $('#cmp-base').value = b; $('#cmp-head').value = a;
      return loadCompare(b, a);
    }
    if (e.target.id === 'cmp-all-diff') return loadWholeDiff();
    if (e.target.id === 'cmp-codex') return codexForCompare();
    if (e.target.id === 'cmp-copy') {
      try {
        const r = await api('/api/diff', { path: S.repo.path, base: S.cmp.base, head: S.cmp.head, file: S.cmp.file });
        await navigator.clipboard.writeText(r.patch);
        toast('patch 已复制', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const fi = e.target.closest('.fitem');
    if (fi) {
      $$('#cmp-files .fitem').forEach((x) => x.classList.remove('active'));
      fi.classList.add('active');
      S.cmp.file = fi.dataset.path;
      return loadFileDiff(fi.dataset.path, 'cmp-diff');
    }
    const ci = e.target.closest('.citem');
    if (ci && ci.dataset.sha) {
      // 把「分支对比」的提交带到历史视图，保持上下文
      S.hist.commit = null;
      S.hist.data = {
        mode: 'message',
        ref: `${S.cmp.base}..${S.cmp.head}`,
        keyword: '',
        commits: S.cmp.data ? S.cmp.data.commits : [],
        count: S.cmp.data ? S.cmp.data.commits.length : 0,
      };
      S.tab = 'history';
      renderActiveTab();
      return openCommit(ci.dataset.sha);
    }
  });
  $('#view-compare').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-base' || e.target.id === 'cmp-head') {
      loadCompare($('#cmp-base').value, $('#cmp-head').value);
    }
  });

  // 历史视图
  $('#view-history').addEventListener('click', (e) => {
    if (e.target.id === 'h-run') return runSearch();
    if (e.target.id === 'h-reset') {
      S.hist = { ref: S.current || 'HEAD', mode: 'message', q: '', author: '', path: '', data: null, commit: null };
      return renderHistory();
    }
    if (e.target.id === 'commit-codex') return codexForCommit();
    if (e.target.id === 'commit-copy') {
      navigator.clipboard.writeText(S.hist.commit ? S.hist.commit.patch : '').then(() => toast('patch 已复制', 'ok'));
      return;
    }
    const ci = e.target.closest('.citem');
    if (ci && ci.dataset.sha) return openCommit(ci.dataset.sha);
  });
  $('#view-history').addEventListener('change', (e) => {
    if (e.target.id === 'h-ref') { S.hist.ref = e.target.value; runSearch(); }
    if (e.target.id === 'h-mode') { S.hist.mode = e.target.value; }
  });
  $('#view-history').addEventListener('input', (e) => {
    if (e.target.id === 'h-q') S.hist.q = e.target.value;
    if (e.target.id === 'h-author') S.hist.author = e.target.value;
    if (e.target.id === 'h-path') S.hist.path = e.target.value;
  });
  $('#view-history').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && ['h-q', 'h-author', 'h-path'].includes(e.target.id)) runSearch();
  });

  // 统一 / 并排 切换
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dm]');
    if (btn) setDiffMode(btn.dataset.dm);
  });

  // 抽屉（codex 关闭时元素不存在，逐个判空）
  const dClose = $('#drawer-close');
  const dSend = $('#drawer-send');
  const dInput = $('#drawer-input');
  if (dClose) dClose.addEventListener('click', closeDrawer);
  const dStop = $('#drawer-stop');
  if (dStop) dStop.addEventListener('click', closeDrawer);
  if (dSend) dSend.addEventListener('click', sendFollowUp);
  if (dInput) dInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendFollowUp(); });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const mask = $('.modal-mask');
      if (mask) return mask.remove();
      const dr = $('#drawer');
      if (dr && dr.classList.contains('open')) return closeDrawer();
    }
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      refreshRepo().catch((err) => toast(err.message, 'err'));
    }
    if (e.key === 's' && !e.metaKey && !e.ctrlKey && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      syncRepo().catch((err) => toast(err.message, 'err'));
    }
  });
}

function sendFollowUp() {
  if (!CODEX_ENABLED) return;
  const input = $('#drawer-input');
  if (!input) return;
  const q = input.value.trim();
  if (!q || !S.repo) return;
  input.value = '';
  const ctx = S.tab === 'history' && S.hist.commit
    ? { mode: 'commit', repo: S.repo.path, sha: S.hist.commit.sha, files: S.hist.commit.files }
    : (S.cmp.data
      ? { mode: 'branch', repo: S.repo.path, base: S.cmp.data.base, head: S.cmp.data.head, files: S.cmp.data.files, commits: S.cmp.data.commits }
      : { mode: 'custom', repo: S.repo.path });
  runCodex(Object.assign({}, ctx, { question: q }), q.length > 26 ? q.slice(0, 26) + '…' : q);
}

function showTab(tab) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'view-' + tab));
}

function renderActiveTab() {
  if (!S.repo) return renderEmpty();
  showTab(S.tab);
  if (S.tab === 'branches') renderBranches();
  else if (S.tab === 'compare') renderCompare();
  else renderHistory();
}

if (!CODEX_ENABLED) {
  const drawer = $('#drawer');
  if (drawer) drawer.remove();
}
bind();
boot();
