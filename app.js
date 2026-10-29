(() => {
  'use strict';

  const STORAGE_KEY = 'redline-trading-journal:v1';
  const SETUP_STORAGE_KEY = 'redline-trading-journal:setups:v1';
  const POI_STORAGE_KEY = 'redline-trading-journal:pois:v1';
  const SETTINGS_STORAGE_KEY = 'redline-trading-journal:settings:v1';
  const WORKSPACES_STORAGE_KEY = 'redline-trading-journal:workspaces:v1';
  const ACTIVE_WORKSPACE_KEY = 'redline-trading-journal:active-workspace:v1';
  const PROJECT_DATA_PREFIX = 'redline-trading-journal:project:v1:';
  const FUTURES = { GC: 100, MGC: 10, NQ: 20, MNQ: 2 };
  const DEFAULT_SETUPS = ['Breakout', 'Pullback', 'Reversal', 'Trend following', 'Range', 'อื่น ๆ'];
  const DEFAULT_POIS = ['PDH / PDL', 'FVG', 'Order Block', 'Liquidity sweep', 'Support / Resistance', 'VWAP', 'Opening range', 'อื่น ๆ'];
  const $ = (id) => document.getElementById(id);
  let workspaces = loadWorkspaces();
  if (!workspaces.length) workspaces = [{ id: 'journal-default', name: 'My Journal', tradeCount: loadTrades().length }];
  let activeWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || workspaces[0].id;
  if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id;
  let trades = loadWorkspaceTrades(activeWorkspaceId);
  let setups = loadWorkspaceSetups(activeWorkspaceId);
  let pois = loadWorkspacePois(activeWorkspaceId);
  let settings = loadWorkspaceSettings(activeWorkspaceId);
  let demoMode = false;
  let demoPortfolioMode = false;
  let demoSnapshot = null;
  let editingSetupName = null;
  let editingPoiName = null;
  let optionManagerMode = 'setup';
  let setupReturnToTrade = false;
  let pendingImages = [];
  let pendingDeleteIds = new Set();
  let confirmResolver = null;
  let toastTimer;
  let chartMode = 'pnl';

  function loadTrades() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  }
  function loadSetups() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETUP_STORAGE_KEY) || 'null');
      return Array.isArray(saved) && saved.length ? [...new Set(saved.filter((item) => typeof item === 'string' && item.trim()))] : [...DEFAULT_SETUPS];
    } catch { return [...DEFAULT_SETUPS]; }
  }
  function loadWorkspaces() {
    try {
      const saved = JSON.parse(localStorage.getItem(WORKSPACES_STORAGE_KEY) || 'null');
      if (!Array.isArray(saved)) return [];
      return saved.filter((workspace) => workspace && typeof workspace.id === 'string' && typeof workspace.name === 'string').map((workspace) => ({
        id: workspace.id,
        name: workspace.name.trim() || 'Untitled Project',
        tradeCount: Number.isInteger(workspace.tradeCount) ? workspace.tradeCount : null
      }));
    } catch { return []; }
  }
  function projectDataKey(id, kind) {
    if (id === 'journal-default') {
      if (kind === 'trades') return STORAGE_KEY;
      if (kind === 'setups') return SETUP_STORAGE_KEY;
      if (kind === 'pois') return POI_STORAGE_KEY;
      if (kind === 'settings') return SETTINGS_STORAGE_KEY;
    }
    return `${PROJECT_DATA_PREFIX}${encodeURIComponent(id)}:${kind}`;
  }
  function loadWorkspaceTrades(id) {
    if (id === 'journal-default') return loadTrades();
    try {
      const saved = JSON.parse(localStorage.getItem(projectDataKey(id, 'trades')) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  }
  function loadWorkspaceSetups(id) {
    if (id === 'journal-default') return loadSetups();
    try {
      const saved = JSON.parse(localStorage.getItem(projectDataKey(id, 'setups')) || 'null');
      return Array.isArray(saved) && saved.length ? [...new Set(saved.filter((item) => typeof item === 'string' && item.trim()))] : [...DEFAULT_SETUPS];
    } catch { return [...DEFAULT_SETUPS]; }
  }
  function loadWorkspacePois(id) {
    try {
      const saved = JSON.parse(localStorage.getItem(projectDataKey(id, 'pois')) || 'null');
      return Array.isArray(saved) && saved.length ? [...new Set(saved.filter((item) => typeof item === 'string' && item.trim()))] : [...DEFAULT_POIS];
    } catch { return [...DEFAULT_POIS]; }
  }
  function normalizeSettings(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const risk = String(data.defaultRisk ?? '').trim();
    return {
      defaultRisk: risk && Number.isFinite(Number(risk)) && Number(risk) > 0 ? risk : '',
      defaultSetup: typeof data.defaultSetup === 'string' ? data.defaultSetup : '',
      defaultPoi: typeof data.defaultPoi === 'string' ? data.defaultPoi : ''
    };
  }
  function loadWorkspaceSettings(id) {
    try {
      return normalizeSettings(JSON.parse(localStorage.getItem(projectDataKey(id, 'settings')) || 'null'));
    } catch { return normalizeSettings(); }
  }
  function buildDemoTrade({ projectId, index, style, setups: demoSetups, pois: demoPois }) {
    const instruments = ['XAUUSD', 'GC', 'NQ', 'MGC'];
    const sessions = ['Asia', 'London', 'New York', 'Overlap'];
    const instrument = instruments[(index * 3 + projectId.length) % instruments.length];
    const isCfd = instrument === 'XAUUSD';
    const direction = index % 2 ? 'Short' : 'Long';
    const quantity = isCfd ? (index % 4 + 1) / 100 : instrument === 'MGC' ? 2 : 1;
    const entry = isCfd ? 2300 + index * 1.8 : instrument === 'GC' || instrument === 'MGC' ? 2350 + index * 3 : 18000 + index * 19;
    const distance = isCfd ? 2 : instrument === 'MGC' ? 3 : instrument === 'GC' ? 4 : 14;
    const stop = entry + (direction === 'Long' ? -distance : distance);
    const target = entry + (direction === 'Long' ? distance * 1.8 : -distance * 1.8);
    const winRate = style === 'elite' ? 0.8 : style === 'stable' ? 0.6 : 0.3;
    const won = ((index * 17 + projectId.length) % 100) / 100 < winRate;
    const lossStretch = style === 'chaos' && index % 4 === 0 ? 1.4 : 1;
    const rewardMultiple = style === 'elite' ? 1.65 : style === 'stable' ? 1.25 : 0.8;
    const exitDistance = won ? distance * rewardMultiple : distance * lossStretch;
    const exit = entry + (won === (direction === 'Long') ? exitDistance : -exitDistance);
    const incomplete = style === 'chaos' && index % 7 === 0;
    const missedEntry = style === 'chaos' && index % 13 === 0;
    return {
      id: `${projectId}-trade-${index + 1}`, instrument, date: dateOffset(index - 120), time: `${String(7 + (index * 5) % 15).padStart(2, '0')}:${String([5, 18, 32, 47][index % 4]).padStart(2, '0')}`,
      session: sessions[(index + projectId.length) % sessions.length], direction, missedEntry,
      quantity: missedEntry ? null : quantity, entry, exit: missedEntry ? null : exit,
      stop: incomplete ? '' : stop, target: incomplete ? '' : target,
      riskBudget: incomplete || missedEntry ? null : style === 'elite' ? '250' : style === 'stable' ? '180' : '120',
      fees: missedEntry ? 0 : isCfd ? 1 : instrument === 'MGC' ? 2 : 4,
      cfdMultiplier: isCfd ? 100 : '', setup: demoSetups[index % demoSetups.length],
      poi: demoPois[index % demoPois.length], maxRR: style === 'chaos' && index % 5 === 0 ? null : Number((1.4 + (index % 4) * 0.35).toFixed(2)),
      followedPlan: style === 'elite' ? 'yes' : style === 'stable' ? (index % 5 === 0 ? 'no' : 'yes') : (index % 3 === 0 ? 'no' : ''),
      notes: missedEntry ? 'ตัวอย่าง: เห็นแผนแต่ไม่ได้เข้า' : incomplete ? 'ตัวอย่าง: ข้อมูลไม่ครบ' : won ? 'ตัวอย่าง: ทำตามแผน' : 'ตัวอย่าง: โดน Stop Loss',
      images: [], chartUrl: '', chartUrlHtf: '', chartUrlLtf: ''
    };
  }
  function buildDemoWorkspace({ id, name, style, count, setups: demoSetups, pois: demoPois, defaultRisk }) {
    const trades = Array.from({ length: count }, (_, index) => buildDemoTrade({ projectId: id, index, style, setups: demoSetups, pois: demoPois }));
    return {
      id, name, tradeCount: trades.length,
      demoData: {
        trades, setups: demoSetups, pois: demoPois,
        settings: { defaultRisk, defaultSetup: demoSetups[0], defaultPoi: demoPois[0] }
      }
    };
  }
  function buildDemoPortfolio() {
    return [
      buildDemoWorkspace({ id: 'demo-atlas-edge', name: 'Atlas Edge · เทพ', style: 'elite', count: 36, setups: ['Breakout', 'Trend following', 'Pullback'], pois: ['FVG', 'Liquidity sweep', 'PDH / PDL'], defaultRisk: '250' }),
      buildDemoWorkspace({ id: 'demo-northstar', name: 'Northstar · Stable', style: 'stable', count: 30, setups: ['Range', 'Reversal', 'Pullback'], pois: ['Support / Resistance', 'VWAP', 'Opening range'], defaultRisk: '180' }),
      buildDemoWorkspace({ id: 'demo-chaos-lab', name: 'Chaos Lab · Data เละ', style: 'chaos', count: 44, setups: ['FOMO', 'Reversal', 'อื่น ๆ'], pois: ['ไม่ชัดเจน', 'FVG', 'อื่น ๆ'], defaultRisk: '' })
    ];
  }
  function workspaceData(workspace) {
    return demoPortfolioMode && workspace?.demoData ? workspace.demoData : null;
  }
  function workspaceTradeRecords(workspace) {
    if (workspace?.id === activeWorkspaceId) return trades;
    return workspaceData(workspace)?.trades || loadWorkspaceTrades(workspace?.id);
  }
  function workspaceTradeCount(workspace) {
    return workspace?.id === activeWorkspaceId ? trades.length : (workspace?.tradeCount ?? workspaceTradeRecords(workspace).length);
  }
  function workspaceStats(workspace) {
    const records = workspaceTradeRecords(workspace);
    const ordered = records.filter((trade) => !trade.missedEntry).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const results = ordered.map((trade) => ({ trade, ...metrics(trade) }));
    const wins = results.filter((item) => item.net > 0).length;
    const net = results.reduce((sum, item) => sum + item.net, 0);
    let lossStreak = 0, maxLossStreak = 0;
    results.forEach((item) => {
      if (item.net < 0) { lossStreak += 1; maxLossStreak = Math.max(maxLossStreak, lossStreak); } else lossStreak = 0;
    });
    const rated = results.filter((item) => item.r != null);
    const maxRRValues = results.map(({ trade }) => Number(trade.maxRR)).filter((value) => Number.isFinite(value) && value >= 0);
    return {
      count: results.length,
      winRate: results.length ? wins / results.length * 100 : 0,
      net,
      maxLossStreak,
      avgR: rated.length ? rated.reduce((sum, item) => sum + item.r, 0) / rated.length : null,
      maxRR: maxRRValues.length ? Math.max(...maxRRValues) : null
    };
  }
  function loadDemoWorkspaceState(workspace) {
    const data = workspaceData(workspace);
    trades = data?.trades || [];
    setups = data?.setups || [...DEFAULT_SETUPS];
    pois = data?.pois || [...DEFAULT_POIS];
    settings = data?.settings || normalizeSettings();
  }
  function enterDemoPortfolio() {
    demoSnapshot = { workspaces, activeWorkspaceId, trades, setups, pois, settings };
    demoPortfolioMode = true;
    demoMode = true;
    workspaces = buildDemoPortfolio();
    activeWorkspaceId = workspaces[0].id;
    loadDemoWorkspaceState(workspaces[0]);
    renderSetupOptions();
    renderPoiOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
  }
  function exitDemoPortfolio() {
    if (!demoSnapshot) return;
    ({ workspaces, activeWorkspaceId, trades, setups, pois, settings } = demoSnapshot);
    demoSnapshot = null;
    demoPortfolioMode = false;
    demoMode = false;
    renderSetupOptions();
    renderPoiOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
  }
  function switchDemoWorkspace(id) {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || workspace.id === activeWorkspaceId) return;
    resetSetupEditor();
    pendingDeleteIds.clear();
    activeWorkspaceId = workspace.id;
    loadDemoWorkspaceState(workspace);
    $('searchTrades').value = '';
    $('periodFilter').value = 'all';
    $('instrumentFilter').value = 'all';
    renderSetupOptions();
    renderPoiOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
    toast(`เปิดโปรเจกต์ตัวอย่าง “${workspace.name}” แล้ว`);
  }
  function persistWorkspaceState() {
    const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    if (active) {
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'trades'), JSON.stringify(trades));
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'setups'), JSON.stringify(setups));
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'pois'), JSON.stringify(pois));
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'settings'), JSON.stringify(settings));
      active.tradeCount = trades.length;
    }
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces.map(({ id, name, tradeCount }) => ({ id, name, tradeCount }))));
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
  }
  function persist() { persistWorkspaceState(); }
  function persistSetups() { persistWorkspaceState(); }
  if (!localStorage.getItem(WORKSPACES_STORAGE_KEY)) {
    try {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces.map(({ id, name, tradeCount }) => ({ id, name, tradeCount }))));
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    } catch { /* Keep legacy records readable even if the browser cannot add workspace metadata yet. */ }
  }
  function activeWorkspace() { return workspaces.find((workspace) => workspace.id === activeWorkspaceId); }
  function renderWorkspaceControls() {
    const active = activeWorkspace();
    $('workspaceSelect').innerHTML = workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.name)}</option>`).join('');
    $('workspaceSelect').value = activeWorkspaceId;
    $('sidebarProjectName').textContent = active?.name || 'My Journal';
    $('activeWorkspaceLabel').textContent = active?.name || 'My Journal';
    $('workspaceCount').textContent = `${workspaces.length} โปรเจกต์`;
    $('workspaceRows').innerHTML = workspaces.map((workspace) => `<div class="workspace-row${workspace.id === activeWorkspaceId ? ' active' : ''}"><button type="button" class="workspace-row-select" data-select-workspace="${escapeHtml(workspace.id)}"><strong>${escapeHtml(workspace.name)}</strong><small>${workspaceTradeCount(workspace)} รายการเทรด${workspace.id === activeWorkspaceId ? ' · กำลังใช้งาน' : ''}</small></button><div class="workspace-row-actions"><button type="button" data-rename-workspace="${escapeHtml(workspace.id)}">เปลี่ยนชื่อ</button>${workspaces.length > 1 ? `<button type="button" class="delete-setup" data-delete-workspace="${escapeHtml(workspace.id)}">ลบ</button>` : ''}</div></div>`).join('');
    renderProjectsView();
  }
  function renderProjectsView() {
    $('projectsCount').textContent = `${workspaces.length} โปรเจกต์`;
    $('projectsGrid').innerHTML = workspaces.map((workspace) => {
      const stats = workspaceStats(workspace);
      const setupCount = workspaceData(workspace)?.setups.length ?? loadWorkspaceSetups(workspace.id).length;
      const activeClass = workspace.id === activeWorkspaceId ? ' active' : '';
      const netClass = stats.net > 0 ? 'positive-text' : stats.net < 0 ? 'negative-text' : 'muted-text';
      return `<article class="project-card${activeClass}"><div class="project-card-top"><span class="project-card-icon">▦</span><span class="project-status">${workspace.id === activeWorkspaceId ? 'กำลังใช้งาน' : 'พร้อมใช้งาน'}</span></div><h3>${escapeHtml(workspace.name)}</h3><div class="project-card-stats"><span><small>เทรด</small><strong>${stats.count}</strong></span><span><small>Setup</small><strong>${setupCount}</strong></span></div><div class="project-card-metrics"><span><small>Win rate</small><strong>${stats.count ? `${stats.winRate.toFixed(0)}%` : '—'}</strong></span><span><small>กำไร / ขาดทุน</small><strong class="${netClass}">${money(stats.net, 0)}</strong></span><span><small>แพ้ติดกัน</small><strong>${stats.maxLossStreak} ไม้</strong></span><span><small>Avg R</small><strong>${stats.avgR == null ? '—' : `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`}</strong></span><span><small>Max RR</small><strong>${stats.maxRR == null ? '—' : `+${stats.maxRR.toFixed(2)}R`}</strong></span></div><div class="project-card-actions"><button type="button" class="primary-button" data-select-project="${escapeHtml(workspace.id)}">${workspace.id === activeWorkspaceId ? 'เปิดภาพรวม' : 'ใช้โปรเจกต์นี้'}</button>${workspaces.length > 1 ? `<button type="button" class="project-action-button danger" data-delete-workspace="${escapeHtml(workspace.id)}">ลบ</button>` : ''}</div></article>`;
    }).join('');
  }
  function switchWorkspace(id) {
    if (demoMode && demoPortfolioMode) { switchDemoWorkspace(id); return; }
    if (!workspaces.some((workspace) => workspace.id === id) || id === activeWorkspaceId) return;
    resetSetupEditor();
    pendingDeleteIds.clear();
    if (demoMode) {
      demoMode = false;
      $('demoBanner').hidden = true;
      $('demoButtonLabel').textContent = 'ข้อมูลตัวอย่าง';
      $('demoButton').classList.remove('demo-active');
    }
    activeWorkspaceId = id;
    const active = activeWorkspace();
    trades = loadWorkspaceTrades(activeWorkspaceId);
    setups = loadWorkspaceSetups(activeWorkspaceId);
    pois = loadWorkspacePois(activeWorkspaceId);
    settings = loadWorkspaceSettings(activeWorkspaceId);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    $('searchTrades').value = '';
    $('periodFilter').value = 'all';
    $('instrumentFilter').value = 'all';
    renderSetupOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
    toast(`เปิดโปรเจกต์ “${active.name}” แล้ว`);
  }
  function closeWorkspaceManager() {
    $('workspaceManager').classList.remove('open');
    $('workspaceManager').setAttribute('aria-hidden', 'true');
    $('workspaceName').value = '';
  }
  function openWorkspaceManager() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงจัดการโปรเจกต์ได้'); return; }
    renderWorkspaceControls();
    $('workspaceManager').classList.add('open');
    $('workspaceManager').setAttribute('aria-hidden', 'false');
    $('workspaceName').focus();
  }
  function createWorkspace(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงสร้างโปรเจกต์ได้'); return; }
    const name = $('workspaceName').value.trim();
    if (!name) return;
    if (workspaces.some((workspace) => workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { toast('มีชื่อโปรเจกต์นี้แล้ว'); return; }
    const workspace = { id: crypto.randomUUID?.() || `journal-${Date.now()}-${Math.random().toString(16).slice(2)}`, name, tradeCount: 0 };
    workspaces.push(workspace);
    try { persistWorkspaceState(); }
    catch { workspaces.pop(); toast('สร้างโปรเจกต์ไม่สำเร็จ พื้นที่จัดเก็บอาจเต็ม'); return; }
    $('workspaceName').value = '';
    switchWorkspace(workspace.id);
    renderWorkspaceControls();
    toast(`สร้างโปรเจกต์ “${name}” แล้ว`);
  }
  async function manageWorkspaceAction(event) {
    const selectId = event.target.closest('[data-select-workspace]')?.dataset.selectWorkspace;
    const renameId = event.target.closest('[data-rename-workspace]')?.dataset.renameWorkspace;
    const deleteId = event.target.closest('[data-delete-workspace]')?.dataset.deleteWorkspace;
    if (selectId) { closeWorkspaceManager(); switchWorkspace(selectId); return; }
    if (demoMode && (renameId || deleteId)) { toast('ออกจากโหมดสาธิตก่อนจึงจัดการโปรเจกต์ได้'); return; }
    if (renameId) {
      const workspace = workspaces.find((item) => item.id === renameId);
      if (!workspace) return;
      const nextName = window.prompt('ตั้งชื่อโปรเจกต์', workspace.name)?.trim();
      if (!nextName || nextName === workspace.name) return;
      if (workspaces.some((item) => item.id !== renameId && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) { toast('มีชื่อโปรเจกต์นี้แล้ว'); return; }
      const previousName = workspace.name;
      workspace.name = nextName;
      try { persistWorkspaceState(); }
      catch { workspace.name = previousName; toast('เปลี่ยนชื่อไม่สำเร็จ พื้นที่จัดเก็บอาจเต็ม'); return; }
      renderWorkspaceControls();
      toast('เปลี่ยนชื่อโปรเจกต์แล้ว');
      return;
    }
    if (deleteId) {
      if (workspaces.length <= 1) { toast('ต้องมีอย่างน้อย 1 โปรเจกต์'); return; }
      const workspace = workspaces.find((item) => item.id === deleteId);
      const workspaceTradeCount = workspace?.id === activeWorkspaceId ? trades.length : (workspace?.tradeCount ?? loadWorkspaceTrades(workspace?.id).length);
      if (!workspace) return;
      const confirmed = await openConfirmModal({
        title: 'ลบโปรเจกต์นี้หรือไม่?',
        message: `โปรเจกต์ “${workspace.name}” มีรายการเทรด ${workspaceTradeCount} รายการ`,
        detail: 'รายการเทรดและ Setup ทั้งหมดจะถูกลบ และการลบนี้ย้อนกลับไม่ได้',
        confirmLabel: 'ลบโปรเจกต์'
      });
      if (!confirmed) return;
      const previousWorkspaces = workspaces;
      const previousActiveId = activeWorkspaceId;
      const previousTrades = trades;
      const previousSetups = setups;
      const previousPois = pois;
      const previousSettings = settings;
      workspaces = workspaces.filter((item) => item.id !== deleteId);
      if (activeWorkspaceId === deleteId) {
        activeWorkspaceId = workspaces[0].id;
        trades = loadWorkspaceTrades(activeWorkspaceId);
        setups = loadWorkspaceSetups(activeWorkspaceId);
        pois = loadWorkspacePois(activeWorkspaceId);
        settings = loadWorkspaceSettings(activeWorkspaceId);
      }
      try { persistWorkspaceState(); }
      catch {
        workspaces = previousWorkspaces;
        activeWorkspaceId = previousActiveId;
        trades = previousTrades;
        setups = previousSetups;
        pois = previousPois;
        settings = previousSettings;
        toast('ลบโปรเจกต์ไม่สำเร็จ พื้นที่จัดเก็บอาจเต็ม');
        return;
      }
      localStorage.removeItem(projectDataKey(deleteId, 'trades'));
      localStorage.removeItem(projectDataKey(deleteId, 'setups'));
      localStorage.removeItem(projectDataKey(deleteId, 'pois'));
      localStorage.removeItem(projectDataKey(deleteId, 'settings'));
      renderSetupOptions();
      renderWorkspaceControls();
      render();
      toast('ลบโปรเจกต์แล้ว');
    }
  }
  function dateOffset(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function getActiveTrades() {
    return trades;
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function multiplierFor(trade) {
    return FUTURES[trade.instrument] || Number(trade.cfdMultiplier) || 0;
  }
  function metrics(trade) {
    const multiplier = multiplierFor(trade);
    const direction = trade.direction === 'Short' ? -1 : 1;
    const gross = (Number(trade.exit) - Number(trade.entry)) * direction * multiplier * Number(trade.quantity);
    const net = gross - Number(trade.fees || 0);
    const risk = trade.stop === '' || trade.stop == null ? 0 : Math.abs(Number(trade.entry) - Number(trade.stop)) * multiplier * Number(trade.quantity);
    const target = trade.target === '' || trade.target == null ? 0 : Math.abs(Number(trade.target) - Number(trade.entry)) * multiplier * Number(trade.quantity);
    return { gross, net, risk, target, r: risk > 0 ? net / risk : null, outcome: net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'BE' };
  }
  function money(value, digits = 2) {
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
  function quantityWithUnit(trade) {
    const quantity = Number(trade.quantity);
    if (trade.instrument === 'XAUUSD') return `${quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} lot`;
    return Number.isInteger(quantity) ? `${quantity.toLocaleString('en-US')} สัญญา` : `${quantity.toLocaleString('en-US', { maximumFractionDigits: 2 })} สัญญา ⚠`;
  }
  function dateLabel(date) {
    if (!date) return '—';
    const parts = date.split('-').map(Number);
    return new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }).format(new Date(parts[0], parts[1] - 1, parts[2]));
  }
  function renderSetupOptions(selected = '') {
    const options = [...setups];
    const isHistorical = selected && !options.includes(selected);
    if (isHistorical) options.push(selected);
    $('setup').innerHTML = `<option value="">เลือก Setup</option>${options.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}${item === selected && isHistorical ? ' (รายการเดิม)' : ''}</option>`).join('')}`;
    $('setup').value = selected;
  }
  function renderPoiOptions(selected = '') {
    const options = [...pois];
    const isHistorical = selected && !options.includes(selected);
    if (isHistorical) options.push(selected);
    $('poi').innerHTML = `<option value="">เลือก POI</option>${options.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}${item === selected && isHistorical ? ' (รายการเดิม)' : ''}</option>`).join('')}`;
    $('poi').value = selected;
  }
  function safeHttpsUrl(raw) {
    try {
      const url = new URL(String(raw || '').trim());
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }
  function isDirectImageUrl(raw) {
    try { return /\.(png|jpe?g|webp|gif|avif)$/i.test(new URL(raw).pathname); }
    catch { return false; }
  }
  function chartLinksFor(trade) {
    const links = [
      ['HTF', safeHttpsUrl(trade.chartUrlHtf)],
      ['LTF', safeHttpsUrl(trade.chartUrlLtf)]
    ].filter(([, url]) => url);
    if (!links.length) {
      const legacyUrl = safeHttpsUrl(trade.chartUrl);
      if (legacyUrl) links.push(['TV', legacyUrl]);
    }
    return links;
  }
  function renderChartLink(label, url) {
    return isDirectImageUrl(url)
      ? `<a class="chart-thumb-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="เปิดกราฟ ${label}"><img src="${escapeHtml(url)}" alt="กราฟ ${label}"></a>`
      : `<a class="chart-url-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
  }
  function renderSetupManager() {
    $('navSetupCount').textContent = String(setups.length);
    $('setupRows').innerHTML = setups.length ? setups.map((name) => {
      const tradeCount = trades.filter((trade) => trade.setup === name && !trade.missedEntry).length;
      return `<div class="setup-row"><div class="setup-row-info"><span class="setup-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><small>${tradeCount} เทรด</small></div><div class="setup-row-actions"><button type="button" data-edit-setup="${escapeHtml(name)}" aria-label="เปลี่ยนชื่อ ${escapeHtml(name)}" title="เปลี่ยนชื่อ">✎</button><button type="button" class="delete-setup" data-delete-setup="${escapeHtml(name)}" aria-label="ลบ ${escapeHtml(name)}" title="ลบ">×</button></div></div>`;
    }).join('') : '<div class="setup-empty">ยังไม่มี Setup — เพิ่มรายการแรกได้จากช่องด้านบน</div>';
    renderPoiManager();
    renderOptionManagerMode();
    renderDefaultSettings();
    $('returnToTrade').hidden = !setupReturnToTrade;
  }
  function renderPoiManager() {
    $('poiRows').innerHTML = pois.length ? pois.map((name) => {
      const tradeCount = trades.filter((trade) => trade.poi === name && !trade.missedEntry).length;
      return `<div class="setup-row"><div class="setup-row-info"><span class="setup-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><small>${tradeCount} เทรด</small></div><div class="setup-row-actions"><button type="button" data-edit-poi="${escapeHtml(name)}" aria-label="เปลี่ยนชื่อ ${escapeHtml(name)}" title="เปลี่ยนชื่อ">✎</button><button type="button" class="delete-setup" data-delete-poi="${escapeHtml(name)}" aria-label="ลบ ${escapeHtml(name)}" title="ลบ">×</button></div></div>`;
    }).join('') : '<div class="setup-empty">ยังไม่มี POI — เพิ่มรายการแรกได้จากช่องด้านบน</div>';
  }
  function renderOptionManagerMode() {
    const isPoi = optionManagerMode === 'poi';
    document.querySelectorAll('[data-option-kind]').forEach((button) => {
      const active = button.dataset.optionKind === optionManagerMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('optionManagerCount').textContent = `${isPoi ? pois.length : setups.length} รายการ`;
    $('optionListLabel').textContent = `รายการ ${isPoi ? 'POI' : 'Setup'}`;
    $('setupForm').hidden = isPoi;
    $('poiForm').hidden = !isPoi;
    $('setupRows').hidden = isPoi;
    $('poiRows').hidden = !isPoi;
    $('setupFootnote').hidden = isPoi;
    $('poiFootnote').hidden = !isPoi;
  }
  function renderDefaultSettings() {
    const setupOptions = [...setups];
    const poiOptions = [...pois];
    if (settings.defaultSetup && !setupOptions.includes(settings.defaultSetup)) setupOptions.push(settings.defaultSetup);
    if (settings.defaultPoi && !poiOptions.includes(settings.defaultPoi)) poiOptions.push(settings.defaultPoi);
    $('defaultRisk').value = settings.defaultRisk;
    $('defaultSetup').innerHTML = `<option value="">ไม่กำหนด</option>${setupOptions.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}`;
    $('defaultPoi').innerHTML = `<option value="">ไม่กำหนด</option>${poiOptions.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')}`;
    $('defaultSetup').value = settings.defaultSetup;
    $('defaultPoi').value = settings.defaultPoi;
    updateSettingsButtons();
  }
  function currentDefaultSettings() {
    return {
      defaultRisk: $('defaultRisk').value.trim(),
      defaultSetup: $('defaultSetup').value,
      defaultPoi: $('defaultPoi').value
    };
  }
  function updateSettingsButtons() {
    const current = currentDefaultSettings();
    const changed = current.defaultRisk !== settings.defaultRisk || current.defaultSetup !== settings.defaultSetup || current.defaultPoi !== settings.defaultPoi;
    const hasValues = [current.defaultRisk, current.defaultSetup, current.defaultPoi, settings.defaultRisk, settings.defaultSetup, settings.defaultPoi].some(Boolean);
    $('saveSettingsButton').disabled = !changed;
    $('clearSettingsButton').disabled = !hasValues;
  }
  function resetSetupEditor() {
    editingSetupName = null;
    $('setupName').value = '';
    $('saveSetupButton').textContent = '＋ เพิ่ม Setup';
    $('saveSetupButton').setAttribute('aria-label', 'เพิ่ม Setup');
    $('cancelSetupEdit').hidden = true;
  }
  function saveSetup(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไข Setup ได้'); return; }
    const nextName = $('setupName').value.trim();
    if (!nextName) return;
    const duplicate = setups.some((name) => name.toLocaleLowerCase() === nextName.toLocaleLowerCase() && name !== editingSetupName);
    if (duplicate) { toast('มีชื่อ Setup นี้อยู่แล้ว'); return; }
    if (editingSetupName) {
      const oldName = editingSetupName;
      setups = setups.map((name) => name === oldName ? nextName : name);
      trades = trades.map((trade) => trade.setup === oldName ? { ...trade, setup: nextName } : trade);
      if (settings.defaultSetup === oldName) settings.defaultSetup = nextName;
      persist();
      toast('เปลี่ยนชื่อ Setup แล้ว');
    } else {
      setups.push(nextName);
      toast('เพิ่ม Setup แล้ว');
    }
    persistSetups();
    renderSetupManager();
    renderSetupOptions(nextName);
    render();
    resetSetupEditor();
    $('setupName').focus();
  }
  function resetPoiEditor() {
    editingPoiName = null;
    $('poiName').value = '';
    $('savePoiButton').textContent = '＋ เพิ่ม POI';
    $('savePoiButton').setAttribute('aria-label', 'เพิ่ม POI');
    $('cancelPoiEdit').hidden = true;
  }
  function savePoi(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไข POI ได้'); return; }
    const nextName = $('poiName').value.trim();
    if (!nextName) return;
    const duplicate = pois.some((name) => name.toLocaleLowerCase() === nextName.toLocaleLowerCase() && name !== editingPoiName);
    if (duplicate) { toast('มีชื่อ POI นี้อยู่แล้ว'); return; }
    if (editingPoiName) {
      const oldName = editingPoiName;
      pois = pois.map((name) => name === oldName ? nextName : name);
      trades = trades.map((trade) => trade.poi === oldName ? { ...trade, poi: nextName } : trade);
      if (settings.defaultPoi === oldName) settings.defaultPoi = nextName;
      toast('เปลี่ยนชื่อ POI แล้ว');
    } else {
      pois.push(nextName);
      toast('เพิ่ม POI แล้ว');
    }
    persistWorkspaceState();
    renderSetupManager();
    renderPoiOptions(nextName);
    render();
    resetPoiEditor();
    $('poiName').focus();
  }
  function saveSettings(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไขค่าเริ่มต้นได้'); return; }
    const defaultRisk = $('defaultRisk').value.trim();
    if (defaultRisk !== '' && (!Number.isFinite(Number(defaultRisk)) || Number(defaultRisk) <= 0)) {
      toast('Risk ต้องเป็นจำนวนเงินมากกว่า 0 หรือเว้นว่างไว้');
      $('defaultRisk').focus();
      return;
    }
    settings = {
      defaultRisk,
      defaultSetup: $('defaultSetup').value,
      defaultPoi: $('defaultPoi').value
    };
    persistWorkspaceState();
    renderDefaultSettings();
    toast('บันทึกค่าเริ่มต้นแล้ว');
  }
  function clearDefaultSettings() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงล้างค่าเริ่มต้นได้'); return; }
    settings = normalizeSettings();
    persistWorkspaceState();
    renderDefaultSettings();
    toast('ล้างค่าเริ่มต้นแล้ว');
  }
  function getVisibleTrades() {
    const period = $('periodFilter').value;
    const instrument = $('instrumentFilter').value;
    const recordType = $('recordTypeFilter').value;
    const query = $('searchTrades').value.trim().toLowerCase();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'month') start.setDate(1);
    if (period === 'week') start.setDate(start.getDate() - 6);
    return getActiveTrades().filter((trade) => {
      const tradeDate = new Date(`${trade.date}T00:00:00`);
      const inPeriod = period === 'all' || (!Number.isNaN(tradeDate.getTime()) && tradeDate >= start);
      const inInstrument = instrument === 'all' || trade.instrument === instrument;
      const haystack = [trade.missedEntry ? 'miss entry missed entry' : 'trade เทรดจริง', trade.instrument, trade.setup, trade.poi, trade.notes, trade.session, trade.direction, trade.chartUrlHtf, trade.chartUrlLtf, trade.chartUrl].join(' ').toLowerCase();
      const matchesType = recordType === 'all' || (recordType === 'missed' ? trade.missedEntry : !trade.missedEntry);
      return inPeriod && inInstrument && matchesType && haystack.includes(query);
    });
  }
  function renderStats(filtered) {
    const ordered = filtered.filter((trade) => !trade.missedEntry).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const results = ordered.map((trade) => ({ trade, ...metrics(trade) }));
    const total = results.reduce((sum, item) => sum + item.net, 0);
    const wins = results.filter((item) => item.net > 0).length;
    const losses = results.filter((item) => item.net < 0).length;
    let currentLossStreak = 0, maxLossStreak = 0;
    results.forEach((item) => {
      if (item.net < 0) {
        currentLossStreak += 1;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      } else currentLossStreak = 0;
    });
    const grossWins = results.reduce((sum, item) => sum + Math.max(item.net, 0), 0);
    const grossLosses = results.reduce((sum, item) => sum + Math.abs(Math.min(item.net, 0)), 0);
    const pf = grossLosses ? grossWins / grossLosses : grossWins ? Infinity : 0;
    const rated = results.filter((item) => item.r != null);
    const avgR = rated.length ? rated.reduce((sum, item) => sum + item.r, 0) / rated.length : 0;
    const totalR = rated.reduce((sum, item) => sum + item.r, 0);
    const maxRRValues = results.map(({ trade }) => Number(trade.maxRR)).filter((value) => Number.isFinite(value) && value >= 0);
    const maxRR = maxRRValues.length ? Math.max(...maxRRValues) : null;
    let pnlEquity = 0, pnlPeak = 0, maxDrawdown = 0;
    let rEquity = 0, rPeak = 0, maxDrawdownR = 0;
    results.forEach((item) => {
      pnlEquity += item.net;
      pnlPeak = Math.max(pnlPeak, pnlEquity);
      maxDrawdown = Math.max(maxDrawdown, pnlPeak - pnlEquity);
      if (item.r != null) {
        rEquity += item.r;
        rPeak = Math.max(rPeak, rEquity);
        maxDrawdownR = Math.max(maxDrawdownR, rPeak - rEquity);
      }
    });
    const rate = results.length ? (wins / results.length) * 100 : 0;
    const pnlNode = $('netPnl');
    pnlNode.textContent = money(total);
    pnlNode.className = `stat-value ${total > 0 ? 'positive' : total < 0 ? 'negative' : ''}`;
    $('pnlBadge').textContent = results.length ? (total > 0 ? 'กำไรสุทธิ' : total < 0 ? 'ขาดทุนสุทธิ' : 'เสมอตัว') : '—';
    $('pnlBadge').className = `stat-change ${total < 0 ? 'negative' : total === 0 ? 'neutral' : ''}`;
    $('winRate').innerHTML = `${rate.toFixed(1)}<span class="value-unit">%</span>`;
    $('winCount').textContent = `${wins} ชนะ · ${losses} แพ้${results.length - wins - losses ? ` · ${results.length - wins - losses} เสมอ` : ''}`;
    $('winMeter').style.width = `${Math.min(rate, 100)}%`;
    $('profitFactor').textContent = Number.isFinite(pf) ? pf.toFixed(2) : (grossWins ? '∞' : '0.00');
    $('pfBadge').textContent = grossWins || grossLosses ? (pf >= 1 ? 'เหนือจุดคุ้มทุน' : 'ต่ำกว่าจุดคุ้มทุน') : '—';
    $('pfBadge').className = `stat-change ${grossLosses && pf < 1 ? 'negative' : grossWins ? '' : 'neutral'}`;
    $('tradeCount').textContent = String(results.length);
    $('maxLossStreak').innerHTML = `${maxLossStreak}<span class="value-unit"> ไม้</span>`;
    $('totalR').innerHTML = `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}<span class="value-unit">R</span>`;
    $('avgR').textContent = rated.length ? `มี Risk ${rated.length} เทรด` : 'ยังไม่มี Risk ที่คำนวณได้';
    $('maxDrawdown').textContent = results.length ? (maxDrawdown > 0 ? `-${money(maxDrawdown)}` : money(0)) : '—';
    $('maxDrawdown').className = `stat-value ${maxDrawdown > 0 ? 'negative' : ''}`;
    $('maxDrawdownR').textContent = results.length ? `Peak-to-trough · ${maxDrawdownR > 0 ? '-' : ''}${maxDrawdownR.toFixed(2)}R` : 'Peak-to-trough · —';
    $('drawdownPeriod').textContent = $('periodFilter').selectedOptions[0].textContent;
    $('expectancyR').textContent = rated.length ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R` : '—';
    $('expectancyR').className = `stat-value ${avgR > 0 ? 'positive' : avgR < 0 ? 'negative' : ''}`;
    $('expectancySample').textContent = rated.length ? `${rated.length} เทรดที่มี Risk` : 'ยังไม่มีเทรดที่มี Risk';
    $('maxRR').textContent = maxRR == null ? '—' : `+${maxRR.toFixed(2)}R`;
    $('maxRR').className = `stat-value ${maxRR != null ? 'positive' : ''}`;
    $('maxRRSample').textContent = maxRR == null ? 'ยังไม่มี Max RR' : `${maxRRValues.length} เทรดที่กรอก Max RR`;
    $('tradePeriod').textContent = $('periodFilter').selectedOptions[0].textContent;
    $('navTradeCount').textContent = String(getActiveTrades().length);
    $('chartTotal').textContent = chartMode === 'r' ? `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R` : money(total);
    $('chartTotal').className = (chartMode === 'r' ? totalR : total) > 0 ? 'positive' : (chartMode === 'r' ? totalR : total) < 0 ? 'negative' : '';
    $('chartDelta').textContent = results.length ? `${results.length} รายการปิด · ${wins} รายการกำไร` : 'ยังไม่มีรายการเทรด';
    $('chartPeriodLabel').textContent = $('periodFilter').selectedOptions[0].textContent;
    $('chartEndLabel').textContent = results.length ? dateLabel(ordered[ordered.length - 1].date) : 'ปัจจุบัน';
    renderChart(results);
    renderMarkets(results);
    renderPerformanceBreakdown(results, 'setup', 'setupPerformance', 'ยังไม่มีข้อมูล Setup — เพิ่ม Setup ในรายการเทรดเพื่อเริ่มวิเคราะห์');
    renderPerformanceBreakdown(results, 'session', 'sessionPerformance', 'ยังไม่มีข้อมูล Session — เลือก Session ตอนบันทึกเทรดเพื่อเริ่มวิเคราะห์');
  }
  function renderChart(results) {
    const host = $('equityChart');
    host.setAttribute('aria-label', chartMode === 'r' ? 'กราฟ R สะสม' : 'กราฟกำไรขาดทุนสะสม');
    if (!results.length) {
      const emptyLabel = chartMode === 'r' ? '0.0R' : '$0';
      host.innerHTML = `<svg viewBox="0 0 700 135" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="emptyArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#df4450" stop-opacity=".12"/><stop offset="100%" stop-color="#df4450" stop-opacity="0"/></linearGradient></defs><path d="M0 105 H700" stroke="#333336" stroke-dasharray="3 5" fill="none"/><text x="8" y="99" fill="#65656b" font-size="9" font-family="DM Mono">${emptyLabel}</text></svg>`;
      return;
    }
    let running = 0;
    const points = results.map((item) => (running += chartMode === 'r' ? (item.r ?? 0) : item.net));
    const width = 700, height = 135, pad = { top: 10, right: 5, bottom: 12, left: 8 };
    let min = Math.min(0, ...points), max = Math.max(0, ...points);
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const x = (index) => pad.left + (results.length === 1 ? (width - pad.left - pad.right) / 2 : index * (width - pad.left - pad.right) / (results.length - 1));
    const y = (value) => pad.top + (max - value) / span * (height - pad.top - pad.bottom);
    const coords = points.map((value, index) => [x(index), y(value)]);
    const line = coords.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
    const baseline = y(0);
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${baseline.toFixed(1)} L${coords[0][0].toFixed(1)},${baseline.toFixed(1)} Z`;
    const positive = points[points.length - 1] >= 0;
    const stroke = positive ? '#df515a' : '#ef7379';
    const formatAxis = (value) => chartMode === 'r' ? `${value > 0 ? '+' : ''}${value.toFixed(1)}R` : `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(0)}`;
    const labels = [max, 0, min].filter((value, index, array) => array.indexOf(value) === index).map((value) => `<text x="2" y="${Math.max(9, Math.min(height - 4, y(value) - 3)).toFixed(1)}" fill="#65656b" font-size="8" font-family="DM Mono">${formatAxis(value)}</text>`).join('');
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${stroke}" stop-opacity=".22"/><stop offset="100%" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs><path d="M0 ${baseline.toFixed(1)} H${width}" stroke="#343437" stroke-dasharray="3 5" fill="none"/><path d="${area}" fill="url(#equityFill)"/><path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${coords.map((point, i) => `<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="${i === coords.length - 1 ? 3.2 : 1.8}" fill="${stroke}" stroke="#171718" stroke-width="1.5"/>`).join('')}${labels}</svg>`;
  }
  function renderMarkets(results) {
    const futures = results.filter((item) => item.trade.instrument !== 'XAUUSD');
    const cfd = results.filter((item) => item.trade.instrument === 'XAUUSD');
    const groups = [
      { name: 'Futures', detail: `${futures.length} รายการ · GC, MGC, NQ, MNQ`, items: futures, icon: 'F' },
      { name: 'CFD', detail: `${cfd.length} รายการ · XAUUSD`, items: cfd, icon: 'C' }
    ];
    const totalAbs = groups.reduce((sum, group) => sum + group.items.reduce((n, item) => n + Math.abs(item.net), 0), 0);
    $('marketBreakdown').innerHTML = groups.map((group) => {
      const net = group.items.reduce((sum, item) => sum + item.net, 0);
      const weight = totalAbs ? group.items.reduce((n, item) => n + Math.abs(item.net), 0) / totalAbs * 100 : 0;
      return `<div class="market-row"><div class="market-icon">${group.icon}</div><div><div class="market-name">${group.name}</div><div class="market-detail">${group.detail}</div><div class="market-track"><i style="width:${weight}%"></i></div></div><div class="market-value ${net > 0 ? 'positive-text' : net < 0 ? 'negative-text' : 'muted-text'}">${money(net)}</div></div>`;
    }).join('');
    $('instrumentCount').textContent = String(new Set(results.map((item) => item.trade.instrument)).size);
  }
  function renderPerformanceBreakdown(results, field, hostId, emptyMessage) {
    const groups = new Map();
    if (field === 'setup') setups.forEach((setup) => groups.set(setup, []));
    results.forEach((item) => {
      const label = String(item.trade[field] || '').trim() || 'ไม่ระบุ';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    });
    const rows = [...groups].map(([label, items]) => {
      const net = items.reduce((sum, item) => sum + item.net, 0);
      const wins = items.filter((item) => item.net > 0).length;
      const losses = items.filter((item) => item.net < 0).length;
      const grossWins = items.reduce((sum, item) => sum + Math.max(item.net, 0), 0);
      const grossLosses = items.reduce((sum, item) => sum + Math.abs(Math.min(item.net, 0)), 0);
      const pf = grossLosses ? grossWins / grossLosses : grossWins ? Infinity : 0;
      return { label, count: items.length, net, wins, losses, rate: items.length ? wins / items.length * 100 : 0, pf };
    });
    rows.sort((a, b) => {
      if ((a.count > 0) !== (b.count > 0)) return a.count > 0 ? -1 : 1;
      const aReady = a.count >= 3, bReady = b.count >= 3;
      if (aReady !== bReady) return aReady ? -1 : 1;
      if (aReady && bReady && a.pf !== b.pf) return b.pf - a.pf;
      return b.net - a.net;
    });
    const host = $(hostId);
    if (!rows.length) {
      host.innerHTML = `<div class="insight-empty">${escapeHtml(emptyMessage)}</div>`;
      return;
    }
    const hasReliableGroup = rows.some((row) => row.count >= 3);
    host.innerHTML = rows.map((row, index) => {
      const leader = hasReliableGroup && index === 0 && row.count >= 3;
      const sample = row.count === 0 ? 'ยังไม่มีเทรด' : row.count < 3 ? `ข้อมูลยังน้อย · ${row.count} เทรด` : `${row.count} เทรด`;
      const pfText = row.count === 0 ? '—' : Number.isFinite(row.pf) ? row.pf.toFixed(2) : row.net > 0 ? '∞' : '0.00';
      return `<div class="insight-row${leader ? ' insight-leader' : ''}"><div class="insight-main"><span class="insight-rank">${leader ? '★' : String(index + 1).padStart(2, '0')}</span><div class="insight-label-wrap"><strong class="insight-name">${escapeHtml(row.label)}</strong><small>${sample} · ชนะ ${row.wins}/${row.count} (${row.rate.toFixed(0)}%)</small></div>${leader ? '<span class="best-tag">ดีที่สุด*</span>' : ''}</div><div class="insight-values"><span class="insight-pf">PF <strong>${pfText}</strong></span><strong class="${row.net > 0 ? 'positive-text' : row.net < 0 ? 'negative-text' : 'muted-text'}">${money(row.net)}</strong></div></div>`;
    }).join('') + (hasReliableGroup ? '<div class="insight-note">* อันดับจากกลุ่มที่มีอย่างน้อย 3 เทรด · ยังไม่ใช่ข้อสรุประยะยาว</div>' : '<div class="insight-note">ยังไม่มี Setup/Session ที่มีข้อมูลครบ 3 เทรด — ดูตัวเลขเป็นข้อมูลเบื้องต้น</div>');
  }
  function renderRows(filtered) {
    const rows = [...filtered].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    $('tradeRows').innerHTML = rows.map((trade) => {
      const isMissed = Boolean(trade.missedEntry);
      const isPendingDelete = pendingDeleteIds.has(trade.id);
      const result = isMissed ? null : metrics(trade);
      const isFutures = trade.instrument !== 'XAUUSD';
      const rText = !result || result.r == null ? '—' : `${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}R`;
      const outcomeClass = isMissed ? 'missed' : result.outcome === 'WIN' ? 'win' : result.outcome === 'LOSS' ? 'loss' : 'flat';
      const images = Array.isArray(trade.images) ? trade.images : [];
      const chartCell = `${images.length ? `<button class="chart-count-button" type="button" data-view-images="${escapeHtml(trade.id)}" aria-label="ดูรูปทั้งหมด ${images.length} รูป">ดูรูป</button>` : ''}${chartLinksFor(trade).map(([label, url]) => renderChartLink(label, url)).join('')}`;
      const rowActions = demoMode ? '' : `<button class="row-action" data-edit="${escapeHtml(trade.id)}" title="แก้ไข" aria-label="แก้ไขรายการ">✎</button><button class="row-action${isPendingDelete ? ' pending-delete' : ''}" data-delete="${escapeHtml(trade.id)}" title="${isPendingDelete ? 'ยกเลิกการเลือก' : 'เลือกเพื่อลบ'}" aria-label="${isPendingDelete ? 'ยกเลิกการเลือกลบ' : 'เลือกเพื่อลบ'}">${isPendingDelete ? '↶' : '×'}</button>`;
      const priceText = `${Number(trade.entry).toLocaleString('en-US')} <span style="color:#707076">/</span> ${isMissed || trade.exit == null || trade.exit === '' ? '—' : Number(trade.exit).toLocaleString('en-US')}`;
      const rowClasses = [isMissed ? 'missed-entry-row' : '', isPendingDelete ? 'pending-delete-row' : ''].filter(Boolean).join(' ');
      return `<tr class="${rowClasses}"><td><span class="date-cell">${dateLabel(trade.date)}<small>${escapeHtml(trade.time || '—')}</small></span></td><td><span class="instrument-pill ${isFutures ? 'futures' : ''}"><i></i>${escapeHtml(trade.instrument)}</span></td><td><span class="dir-tag ${trade.direction === 'Short' ? 'short' : 'long'}">${trade.direction === 'Short' ? 'SHORT' : 'LONG'}</span></td><td>${isMissed ? '—' : escapeHtml(quantityWithUnit(trade))}</td><td><span class="date-cell">${priceText}<small>SL ${trade.stop === '' ? '—' : Number(trade.stop).toLocaleString('en-US')} · TP ${trade.target == null || trade.target === '' ? '—' : Number(trade.target).toLocaleString('en-US')}</small></span></td><td><span class="setup-chip">${escapeHtml(trade.setup || '—')}</span></td><td><span class="poi-chip" title="${escapeHtml(trade.poi || '')}">${escapeHtml(trade.poi || '—')}</span></td><td><div class="chart-cell">${chartCell || '<span class="muted-text">—</span>'}</div></td><td><span class="outcome-chip ${outcomeClass}">${isMissed ? 'MISSED' : result.outcome}</span></td><td class="${!result || result.r == null ? 'muted-text' : result.r >= 0 ? 'positive-text' : 'negative-text'}">${rText}</td><td class="${!result || result.net === 0 ? 'muted-text' : result.net > 0 ? 'positive-text' : 'negative-text'}">${result ? money(result.net) : '—'}</td><td><div class="row-actions">${rowActions}</div></td></tr>`;
    }).join('');
    const hasTrades = rows.length > 0;
    $('emptyState').classList.toggle('show', !hasTrades);
    $('emptyState').style.display = hasTrades ? 'none' : 'block';
    const missedCount = rows.filter((trade) => trade.missedEntry).length;
    $('tableSummary').textContent = `แสดง ${rows.length} รายการ${missedCount ? ` · Miss Entry ${missedCount}` : ''} จาก ${getActiveTrades().length}${demoMode ? ' · ข้อมูลตัวอย่าง' : ''}`;
    updateDeleteSelectedButton();
    $('clearAllTrades').hidden = demoMode || trades.length === 0;
    $('clearFilters').style.visibility = ($('periodFilter').value !== 'all' || $('instrumentFilter').value !== 'all' || $('recordTypeFilter').value !== 'all' || $('searchTrades').value) ? 'visible' : 'hidden';
  }
  function updateDeleteSelectedButton() {
    const selectedCount = [...pendingDeleteIds].filter((id) => trades.some((trade) => trade.id === id)).length;
    const button = $('deleteSelectedTrades');
    button.hidden = demoMode || $('tradesView').hidden || selectedCount === 0;
    button.textContent = `⌫ ลบรายการที่เลือก (${selectedCount})`;
  }
  function render() {
    const filtered = getVisibleTrades();
    renderStats(filtered);
    renderRows(filtered);
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2400);
  }
  function openConfirmModal({ title, message, detail, confirmLabel }) {
    if (confirmResolver) closeConfirmModal(false);
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    $('confirmDetail').textContent = detail;
    $('confirmAcceptLabel').textContent = confirmLabel;
    $('confirmModal').classList.add('open');
    $('confirmModal').setAttribute('aria-hidden', 'false');
    $('confirmCancel').focus();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function closeConfirmModal(result = false) {
    $('confirmModal').classList.remove('open');
    $('confirmModal').setAttribute('aria-hidden', 'true');
    const resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(result);
  }
  function localDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function openModal(trade = null, recordType = trade?.missedEntry ? 'missed' : 'trade') {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงบันทึกหรือแก้ไขรายการจริงได้'); return; }
    $('tradeForm').reset();
    $('tradeId').value = trade?.id || '';
    $('recordType').value = recordType;
    $('modalTitle').textContent = trade ? (trade.missedEntry ? 'แก้ไข Miss Entry' : 'แก้ไขรายการเทรด') : (recordType === 'missed' ? 'บันทึก Miss Entry' : 'บันทึกรายการเทรด');
    $('instrument').value = trade?.instrument || 'XAUUSD';
    $('tradeDate').value = trade?.date || localDate();
    $('tradeTime').value = trade?.time || '';
    $('session').value = trade?.session || '';
    $('quantity').value = trade?.quantity ?? (trade?.instrument === 'XAUUSD' || !trade ? 0.01 : 1);
    $('riskBudget').value = trade?.riskBudget ?? (recordType === 'missed' ? '' : settings.defaultRisk);
    $('riskSizingFeedback').textContent = 'ใส่ Risk, Entry และ SL ก่อนคำนวณ · ค่าธรรมเนียมและ slippage ยังไม่รวม';
    $('riskSizingFeedback').classList.remove('error', 'calculated');
    $('entryPrice').value = trade?.entry ?? '';
    $('exitPrice').value = trade?.exit ?? '';
    $('stopPrice').value = trade?.stop ?? '';
    $('targetPrice').value = trade?.target ?? '';
    $('maxRR').value = trade?.maxRR ?? '';
    $('fees').value = trade?.fees ?? 0;
    $('cfdMultiplier').value = trade?.cfdMultiplier ?? '';
    renderSetupOptions(trade?.setup || settings.defaultSetup || '');
    renderPoiOptions(trade?.poi || settings.defaultPoi || '');
    $('followedPlan').value = trade?.followedPlan || 'yes';
    $('notes').value = trade?.notes || '';
    $('chartUrlHtf').value = trade?.chartUrlHtf || '';
    $('chartUrlLtf').value = trade?.chartUrlLtf || (!trade?.chartUrlHtf ? trade?.chartUrl || '' : '');
    pendingImages = Array.isArray(trade?.images) ? [...trade.images] : [];
    document.querySelector(`input[name="direction"][value="${trade?.direction || 'Long'}"]`).checked = true;
    $('formError').textContent = '';
    $('tradeModal').classList.add('open');
    $('tradeModal').setAttribute('aria-hidden', 'false');
    updateRecordMode();
    updateInstrumentField();
    updatePreview();
    updateChartUrlPreview();
    $('instrument').focus();
  }
  function closeModal() {
    $('tradeModal').classList.remove('open');
    $('tradeModal').setAttribute('aria-hidden', 'true');
    setupReturnToTrade = false;
  }
  function updateChartUrlPreview() {
    const host = $('chartUrlPreview');
    const links = [
      ['HTF', safeHttpsUrl($('chartUrlHtf').value)],
      ['LTF', safeHttpsUrl($('chartUrlLtf').value)]
    ].filter(([, url]) => url);
    if (!links.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = links.map(([label, url]) => isDirectImageUrl(url)
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${label}</strong><img src="${escapeHtml(url)}" alt="ตัวอย่างภาพ ${label}"><span>เปิดภาพต้นฉบับ ↗</span></a>`
      : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${label}</strong><span>เปิดลิงก์ TradingView ↗</span></a>`).join('');
  }
  function showTradeImages(trade) {
    const images = (Array.isArray(trade.images) ? trade.images : []).filter((src) => typeof src === 'string' && src.startsWith('data:image/'));
    if (!images.length) { toast('รายการนี้ไม่มีภาพที่แนบไว้'); return; }
    $('imageViewerGrid').innerHTML = images.map((src, index) => `<a href="${src}" target="_blank" rel="noopener noreferrer"><img src="${src}" alt="ภาพประกอบ ${index + 1}"></a>`).join('');
    $('imageViewer').classList.add('open');
    $('imageViewer').setAttribute('aria-hidden', 'false');
  }
  function closeImageViewer() {
    $('imageViewer').classList.remove('open');
    $('imageViewer').setAttribute('aria-hidden', 'true');
  }
  function updateInstrumentField() {
    const cfd = $('instrument').value === 'XAUUSD';
    const missed = $('recordType').value === 'missed';
    $('cfdMultiplierField').hidden = missed || !cfd;
    $('cfdMultiplierField').style.display = cfd && !missed ? 'flex' : 'none';
    $('cfdMultiplier').required = cfd && !missed;
    $('quantityLabel').innerHTML = cfd ? 'จำนวน lot <b>*</b>' : 'จำนวนสัญญา <b>*</b>';
    $('quantity').min = cfd ? '0.01' : '1';
    $('quantity').step = cfd ? '0.01' : '1';
    const currentQuantity = Number($('quantity').value);
    if (!cfd && (!Number.isInteger(currentQuantity) || currentQuantity < 1)) $('quantity').value = '1';
    if (cfd && (!Number.isFinite(currentQuantity) || currentQuantity <= 0)) $('quantity').value = '0.01';
    $('quantityHelp').textContent = cfd ? 'CFD สูงสุด 2 ตำแหน่ง เช่น 0.01, 0.10, 1.25' : 'Futures ใช้จำนวนเต็มเท่านั้น เช่น 1, 2, 3 สัญญา';
    updatePreview();
  }
  function updateRecordMode() {
    const missed = $('recordType').value === 'missed';
    ['quantityField', 'riskSizingField', 'feesField', 'exitPriceField'].forEach((id) => { $(id).hidden = missed; });
    $('quantity').required = !missed;
    $('exitPrice').required = !missed;
    $('cfdMultiplier').required = !missed && $('instrument').value === 'XAUUSD';
    $('missedEntryNote').hidden = !missed;
    $('toggleMissedEntry').textContent = missed ? 'กลับเป็นเทรดจริง' : 'บันทึกเป็น Miss Entry';
    $('toggleMissedEntry').setAttribute('aria-pressed', String(missed));
    $('toggleMissedEntry').classList.toggle('active', missed);
    $('saveTradeButton').innerHTML = missed ? '＋ บันทึก Miss Entry' : '<span>＋</span> บันทึกเทรด';
    $('modalTitle').textContent = $('tradeId').value ? (missed ? 'แก้ไข Miss Entry' : 'แก้ไขรายการเทรด') : (missed ? 'บันทึก Miss Entry' : 'บันทึกรายการเทรด');
  }
  function guardQuantityKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || ['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const cfd = $('instrument').value === 'XAUUSD';
    const input = $('quantity');
    const hasSelection = input.selectionStart !== input.selectionEnd;
    if (cfd) {
      if (!/^\d$/.test(event.key) && event.key !== '.') { event.preventDefault(); return; }
      if (event.key === '.' && input.value.includes('.')) { event.preventDefault(); return; }
      const dotIndex = input.value.indexOf('.');
      if (/^\d$/.test(event.key) && dotIndex >= 0 && input.selectionStart > dotIndex && !hasSelection && input.value.slice(dotIndex + 1).length >= 2) event.preventDefault();
    } else if (!/^\d$/.test(event.key)) {
      event.preventDefault();
    }
  }
  function guardQuantityBeforeInput(event) {
    if (!event.data) return;
    const input = $('quantity');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const projected = input.value.slice(0, start) + event.data + input.value.slice(end);
    const cfd = $('instrument').value === 'XAUUSD';
    const allowed = cfd ? /^\d*(?:\.\d{0,2})?$/.test(projected) : /^\d*$/.test(projected);
    if (!allowed) event.preventDefault();
  }
  function normalizeQuantityInput() {
    const input = $('quantity');
    const cfd = $('instrument').value === 'XAUUSD';
    const raw = input.value;
    if (cfd) {
      const clean = raw.replace(/[^\d.]/g, '');
      const dotIndex = clean.indexOf('.');
      if (dotIndex >= 0) {
        const integer = clean.slice(0, dotIndex);
        const decimals = clean.slice(dotIndex + 1).replace(/\./g, '').slice(0, 2);
        input.value = `${integer || '0'}.${decimals}`;
      } else input.value = clean;
    } else {
      input.value = raw.split('.')[0].replace(/\D/g, '');
    }
    updatePreview();
    markRiskSizingStale();
  }
  function guardDecimalKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || ['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const input = event.currentTarget;
    if (!/^\d$/.test(event.key) && event.key !== '.') { event.preventDefault(); return; }
    if (event.key === '.' && input.value.includes('.')) event.preventDefault();
  }
  function guardDecimalBeforeInput(event) {
    if (!event.data) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const projected = input.value.slice(0, start) + event.data + input.value.slice(end);
    if (!/^\d*(?:\.\d*)?$/.test(projected)) event.preventDefault();
  }
  function normalizeDecimalInput(event) {
    const input = event.currentTarget;
    const clean = input.value.replace(/[^\d.]/g, '');
    const dotIndex = clean.indexOf('.');
    input.value = dotIndex >= 0
      ? `${clean.slice(0, dotIndex) || '0'}.${clean.slice(dotIndex + 1).replace(/\./g, '')}`
      : clean;
    updatePreview();
    if (['cfdMultiplier', 'entryPrice', 'stopPrice'].includes(input.id)) markRiskSizingStale();
  }
  function calculateContractsFromRisk() {
    const feedback = $('riskSizingFeedback');
    const riskBudget = Number($('riskBudget').value);
    const entry = Number($('entryPrice').value), stop = Number($('stopPrice').value);
    const direction = document.querySelector('input[name="direction"]:checked')?.value === 'Short' ? -1 : 1;
    const stopDistance = (entry - stop) * direction;
    const multiplier = multiplierFor({ instrument: $('instrument').value, cfdMultiplier: $('cfdMultiplier').value });
    if (!Number.isFinite(riskBudget) || riskBudget <= 0) { feedback.textContent = 'กรอกงบ Risk เป็นจำนวนเงินมากกว่า 0'; feedback.classList.add('error'); return; }
    if ($('entryPrice').value === '' || $('stopPrice').value === '' || stopDistance <= 0) { feedback.textContent = 'กรอก Entry และ SL ให้ถูกฝั่งกับ Long/Short ก่อน'; feedback.classList.add('error'); return; }
    if (!multiplier || multiplier <= 0) { feedback.textContent = 'กรอกมูลค่าต่อจุดของ CFD ตาม broker ก่อนคำนวณ'; feedback.classList.add('error'); return; }
    const riskPerUnit = stopDistance * multiplier;
    const isCfd = $('instrument').value === 'XAUUSD';
    const step = isCfd ? 0.01 : 1;
    const quantity = Math.floor((riskBudget / riskPerUnit + 1e-10) / step) * step;
    if (quantity < step) { feedback.textContent = `Risk $${riskBudget.toFixed(2)} ต่ำกว่าความเสี่ยงขั้นต่ำต่อ ${isCfd ? '0.01 lot' : '1 สัญญา'} ($${(riskPerUnit * step).toFixed(2)})`; feedback.classList.add('error'); return; }
    $('quantity').value = isCfd ? quantity.toFixed(2) : String(quantity);
    const estimatedRisk = riskPerUnit * quantity;
    feedback.textContent = `คำนวณได้ ${$('quantity').value} ${isCfd ? 'lot' : 'สัญญา'} · เสี่ยงจาก SL ประมาณ $${estimatedRisk.toFixed(2)} (ไม่รวม fee/slippage)`;
    feedback.classList.remove('error');
    feedback.classList.add('calculated');
    updatePreview();
  }
  function markRiskSizingStale() {
    const feedback = $('riskSizingFeedback');
    if (feedback.classList.contains('calculated')) {
      feedback.textContent = 'ค่า Entry, SL, Risk หรือสินทรัพย์เปลี่ยนแล้ว — กดคำนวณจำนวนอีกครั้ง';
      feedback.classList.remove('calculated');
    }
    feedback.classList.remove('error');
  }
  function updatePreview() {
    const instrument = $('instrument').value;
    const multiplier = FUTURES[instrument] || Number($('cfdMultiplier').value) || 0;
    const entry = Number($('entryPrice').value);
    const entryRaw = $('entryPrice').value;
    const exitRaw = $('exitPrice').value;
    const exit = Number(exitRaw);
    const stopRaw = $('stopPrice').value;
    const targetRaw = $('targetPrice').value;
    const stop = Number(stopRaw), target = Number(targetRaw);
    const qty = Number($('quantity').value);
    const direction = document.querySelector('input[name="direction"]:checked')?.value === 'Short' ? -1 : 1;
    const fees = Number($('fees').value) || 0;
    const validBase = multiplier > 0 && qty > 0 && Number.isFinite(entry);
    const stopDistance = stopRaw !== '' ? (entry - stop) * direction : 0;
    const targetDistance = targetRaw !== '' ? (target - entry) * direction : 0;
    const risk = validBase && stopDistance > 0 ? stopDistance * multiplier * qty : 0;
    const reward = validBase && targetDistance > 0 ? targetDistance * multiplier * qty : 0;
    const rr = risk > 0 && reward > 0 ? reward / risk : null;
    if ($('recordType').value === 'missed') {
      const riskPoints = entryRaw !== '' && stopRaw !== '' && stopDistance > 0 ? Math.abs(entry - stop) : 0;
      const rewardPoints = entryRaw !== '' && targetRaw !== '' && targetDistance > 0 ? Math.abs(target - entry) : 0;
      $('outcomeLabel').textContent = 'Miss Entry · แผนที่พลาด';
      $('previewPnl').textContent = 'ยังไม่ได้เข้าออเดอร์';
      $('previewPnl').className = '';
      $('previewRisk').textContent = riskPoints ? `${riskPoints.toLocaleString('en-US', { maximumFractionDigits: 4 })} จุด` : '—';
      $('previewTarget').textContent = rewardPoints ? `${rewardPoints.toLocaleString('en-US', { maximumFractionDigits: 4 })} จุด` : '—';
      $('previewRR').textContent = riskPoints > 0 && rewardPoints > 0 ? `${(rewardPoints / riskPoints).toFixed(2)} : 1` : '—';
      $('previewDetails').textContent = 'บันทึกจุด Entry, SL และ TP ของโอกาสที่ไม่ได้เข้า · ไม่คำนวณเป็นกำไร/ขาดทุนจริง';
      return;
    }
    $('previewRisk').textContent = risk > 0 ? money(risk) : '—';
    $('previewTarget').textContent = reward > 0 ? money(Math.max(0, reward - fees)) : '—';
    $('previewRR').textContent = rr == null ? '—' : `${rr.toFixed(2)} : 1`;
    $('previewDetails').textContent = stopRaw && stopDistance <= 0 ? 'SL อยู่ผิดฝั่งของ Entry สำหรับทิศทางที่เลือก' : targetRaw && targetDistance <= 0 ? 'TP อยู่ผิดฝั่งของ Entry สำหรับทิศทางที่เลือก' : 'คำนวณความเสี่ยงจาก Entry ถึง SL และกำไรเป้าหมายจาก Entry ถึง TP';
    const preview = $('previewPnl');
    if (exitRaw === '' || !validBase) {
      $('outcomeLabel').textContent = 'ผลจากราคาออกจริง';
      preview.textContent = 'กรอกราคาออกเพื่อสรุป';
      preview.className = '';
      return;
    }
    const net = (exit - entry) * direction * multiplier * qty - fees;
    const hitStop = stopRaw !== '' && (exit - stop) * direction <= 0;
    const hitTarget = targetRaw !== '' && (exit - target) * direction >= 0;
    $('outcomeLabel').textContent = net > 0 ? 'ชนะ' : net < 0 ? 'แพ้' : 'เสมอตัว';
    preview.textContent = `${net > 0 ? '+' : ''}${money(net)}`;
    preview.className = net > 0 ? 'positive' : net < 0 ? 'negative' : '';
    $('previewDetails').textContent = `${hitTarget ? 'ราคาออกถึง TP' : hitStop ? 'ราคาออกถึง SL' : 'คำนวณจากราคาออกจริง'} · หักค่าธรรมเนียม ${money(fees)}`;
  }
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 500);
  }
  function exportCsv() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนส่งออกข้อมูลจริง'); return; }
    const header = ['Record Type', 'Date', 'Time', 'Instrument', 'Market', 'Direction', 'Quantity', 'Planned Risk USD', 'Entry', 'Exit', 'Stop', 'Target', 'Max RR', 'Gross PnL USD', 'Fees USD', 'Net PnL USD', 'Risk USD', 'Target USD', 'R Multiple', 'Outcome', 'Session', 'Setup', 'POI', 'TradingView HTF URL', 'TradingView LTF URL', 'Followed Plan', 'Notes'];
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = trades.map((trade) => {
      const value = trade.missedEntry ? null : metrics(trade);
      return [trade.missedEntry ? 'Miss Entry' : 'Trade', trade.date, trade.time, trade.instrument, trade.instrument === 'XAUUSD' ? 'CFD' : 'Futures', trade.direction, trade.quantity, trade.riskBudget, trade.entry, trade.exit, trade.stop, trade.target, trade.maxRR == null ? '' : Number(trade.maxRR).toFixed(2), value ? value.gross.toFixed(2) : '', Number(trade.fees || 0).toFixed(2), value ? value.net.toFixed(2) : '', value ? value.risk.toFixed(2) : '', value ? value.target.toFixed(2) : '', value?.r == null ? '' : value.r.toFixed(3), value?.outcome || 'MISSED', trade.session, trade.setup, trade.poi, trade.chartUrlHtf || '', trade.chartUrlLtf || trade.chartUrl || '', trade.followedPlan, trade.notes].map(quote).join(',');
    });
    download(`redline-trades-${localDate()}.csv`, `\ufeff${[header.map(quote).join(','), ...lines].join('\r\n')}`, 'text/csv;charset=utf-8');
    toast('ส่งออก CSV แล้ว');
  }
  function backupJson() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนสำรองข้อมูลจริง'); return; }
    const backupWorkspaces = workspaces.map(({ id, name }) => ({ id, name, trades: loadWorkspaceTrades(id), setups: loadWorkspaceSetups(id) }));
    download(`redline-backup-${localDate()}.json`, JSON.stringify({ app: 'Redline Trading Journal', version: 2, exportedAt: new Date().toISOString(), activeWorkspaceId, workspaces: backupWorkspaces }, null, 2), 'application/json');
    toast('ดาวน์โหลดไฟล์สำรองแล้ว');
  }
  async function clearAllTrades() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงล้างรายการจริงได้'); return; }
    if (!trades.length) return;
    const confirmed = await openConfirmModal({
      title: 'ลบรายการเทรดทั้งหมดหรือไม่?',
      message: `ลบรายการเทรดทั้งหมด ${trades.length} รายการใช่หรือไม่?`,
      detail: 'รวมรูปและลิงก์กราฟ · การลบนี้ย้อนกลับไม่ได้ แนะนำสำรองข้อมูลก่อน',
      confirmLabel: 'ลบทั้งหมด'
    });
    if (!confirmed) return;
    try {
      trades = [];
      pendingDeleteIds.clear();
      persist();
      render();
      toast('ล้างรายการเทรดทั้งหมดแล้ว');
    } catch {
      toast('ล้างข้อมูลไม่สำเร็จ ลองอีกครั้ง');
    }
  }
  async function deleteSelectedTrades() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงลบรายการได้'); return; }
    const selectedIds = [...pendingDeleteIds].filter((id) => trades.some((trade) => trade.id === id));
    if (!selectedIds.length) return;
    const confirmed = await openConfirmModal({
      title: 'ลบรายการที่เลือกหรือไม่?',
      message: `ลบรายการที่เลือก ${selectedIds.length} รายการใช่หรือไม่?`,
      detail: 'รวมรูปและลิงก์กราฟ · การลบนี้ย้อนกลับไม่ได้ แนะนำสำรองข้อมูลก่อน',
      confirmLabel: 'ลบรายการ'
    });
    if (!confirmed) return;
    try {
      const selected = new Set(selectedIds);
      trades = trades.filter((trade) => !selected.has(trade.id));
      pendingDeleteIds.clear();
      persist();
      render();
      toast(`ลบ ${selectedIds.length} รายการแล้ว`);
    } catch {
      toast('ลบรายการไม่สำเร็จ ลองอีกครั้ง');
    }
  }
  function onSubmit(event) {
    event.preventDefault();
    const missedEntry = $('recordType').value === 'missed';
    const riskBudgetRaw = $('riskBudget').value;
    const maxRRRaw = $('maxRR').value.trim();
    if (!missedEntry && riskBudgetRaw !== '' && (!Number.isFinite(Number(riskBudgetRaw)) || Number(riskBudgetRaw) <= 0)) { $('formError').textContent = 'Risk ต้องเป็นจำนวนเงินมากกว่า 0 หรือเว้นว่างไว้'; return; }
    if (!missedEntry && maxRRRaw !== '' && (!Number.isFinite(Number(maxRRRaw)) || Number(maxRRRaw) < 0)) { $('formError').textContent = 'Max RR ต้องเป็น 0 หรือจำนวนบวก หรือเว้นว่างไว้'; return; }
    const instrument = $('instrument').value;
    const multiplier = FUTURES[instrument] || Number($('cfdMultiplier').value);
    if (!missedEntry && (!multiplier || multiplier <= 0)) { $('formError').textContent = 'กรุณาระบุมูลค่าต่อจุดตาม contract specification ของ broker'; return; }
    const entry = Number($('entryPrice').value), exit = missedEntry ? null : Number($('exitPrice').value);
    const stop = Number($('stopPrice').value), target = Number($('targetPrice').value);
    const direction = document.querySelector('input[name="direction"]:checked').value;
    const side = direction === 'Short' ? -1 : 1;
    if (!Number.isFinite(entry) || (!missedEntry && !Number.isFinite(exit)) || !Number.isFinite(stop) || !Number.isFinite(target)) { $('formError').textContent = 'กรุณากรอกราคา Entry, SL และ TP ให้ครบ'; return; }
    if ((entry - stop) * side <= 0) { $('formError').textContent = direction === 'Long' ? 'Long ต้องวาง SL ต่ำกว่า Entry' : 'Short ต้องวาง SL สูงกว่า Entry'; return; }
    if ((target - entry) * side <= 0) { $('formError').textContent = direction === 'Long' ? 'Long ต้องวาง TP สูงกว่า Entry' : 'Short ต้องวาง TP ต่ำกว่า Entry'; return; }
    const chartUrlHtfRaw = $('chartUrlHtf').value.trim();
    const chartUrlLtfRaw = $('chartUrlLtf').value.trim();
    const chartUrlHtf = safeHttpsUrl(chartUrlHtfRaw);
    const chartUrlLtf = safeHttpsUrl(chartUrlLtfRaw);
    if ((chartUrlHtfRaw && !chartUrlHtf) || (chartUrlLtfRaw && !chartUrlLtf)) { $('formError').textContent = 'ลิงก์กราฟ HTF/LTF ต้องเป็น URL ที่ขึ้นต้นด้วย https://'; return; }
    const trade = {
      id: $('tradeId').value || (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      instrument, date: $('tradeDate').value, time: $('tradeTime').value,
      session: $('session').value, direction,
      missedEntry, quantity: missedEntry ? null : Number($('quantity').value), entry, exit, stop, target,
      riskBudget: missedEntry ? null : (Number($('riskBudget').value) || 0), maxRR: missedEntry ? null : (maxRRRaw === '' ? null : Number(maxRRRaw)),
      fees: missedEntry ? 0 : (Number($('fees').value) || 0), cfdMultiplier: !missedEntry && instrument === 'XAUUSD' ? multiplier : '',
      setup: $('setup').value, poi: $('poi').value.trim(), followedPlan: $('followedPlan').value, notes: $('notes').value.trim(),
      chartUrl: chartUrlLtf || chartUrlHtf || '', chartUrlHtf, chartUrlLtf, images: [...pendingImages]
    };
    if (!trade.date || (!missedEntry && (trade.quantity <= 0 || trade.fees < 0))) { $('formError').textContent = 'กรุณาตรวจสอบวันที่ จำนวน และค่าธรรมเนียม'; return; }
    if (!missedEntry) {
      const quantityStep = instrument === 'XAUUSD' ? 0.01 : 1;
      const isValidStep = Math.abs(trade.quantity / quantityStep - Math.round(trade.quantity / quantityStep)) < 1e-8;
      const quantityRaw = $('quantity').value.trim();
      const decimalPlaces = quantityRaw.includes('.') ? quantityRaw.split('.')[1].length : 0;
      const precisionValid = instrument === 'XAUUSD' ? decimalPlaces <= 2 : Number.isInteger(trade.quantity);
      if (!precisionValid || !isValidStep) {
        $('formError').textContent = instrument === 'XAUUSD' ? 'XAUUSD CFD ใช้ lot ได้สูงสุด 2 ตำแหน่งและเพิ่มทีละ 0.01 เช่น 0.01, 0.10 หรือ 1.25' : 'Futures ต้องกรอกจำนวนสัญญาเป็นจำนวนเต็ม ไม่มีทศนิยม เช่น 1 หรือ 2';
        return;
      }
    }
    const existingIndex = trades.findIndex((item) => item.id === trade.id);
    const updatedTrades = [...trades];
    if (existingIndex >= 0) updatedTrades[existingIndex] = trade; else updatedTrades.push(trade);
    try {
      const updatedWorkspaces = workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, tradeCount: updatedTrades.length } : workspace);
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'trades'), JSON.stringify(updatedTrades));
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(updatedWorkspaces.map(({ id, name, tradeCount }) => ({ id, name, tradeCount }))));
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
      workspaces = updatedWorkspaces;
    }
    catch { $('formError').textContent = 'พื้นที่จัดเก็บในเบราว์เซอร์เต็ม ลองลบภาพบางส่วนแล้วบันทึกอีกครั้ง'; return; }
    trades = updatedTrades;
    render();
    closeModal();
    toast(existingIndex >= 0 ? 'อัปเดตรายการแล้ว' : 'บันทึกเทรดแล้ว');
  }

  $('todayLabel').textContent = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  renderWorkspaceControls();
  $('workspaceSelect').addEventListener('change', (event) => switchWorkspace(event.target.value));
  $('manageWorkspaces').addEventListener('click', openWorkspaceManager);
  $('projectsShortcut').addEventListener('click', () => { switchView('projects'); $('sidebar').classList.remove('open'); });
  $('createProjectButton').addEventListener('click', openWorkspaceManager);
  $('workspaceForm').addEventListener('submit', createWorkspace);
  $('closeWorkspaceManager').addEventListener('click', closeWorkspaceManager);
  $('workspaceRows').addEventListener('click', manageWorkspaceAction);
  $('projectsGrid').addEventListener('click', async (event) => {
    const projectId = event.target.closest('[data-select-project]')?.dataset.selectProject;
    if (projectId) {
      switchWorkspace(projectId);
      switchView('overview');
      return;
    }
    if (event.target.closest('[data-open-project-form]')) {
      openWorkspaceManager();
      return;
    }
    if (event.target.closest('[data-rename-workspace], [data-delete-workspace]')) await manageWorkspaceAction(event);
  });
  $('workspaceManager').addEventListener('click', (event) => { if (event.target === $('workspaceManager')) closeWorkspaceManager(); });
  $('periodFilter').addEventListener('change', render);
  $('instrumentFilter').addEventListener('change', render);
  $('recordTypeFilter').addEventListener('change', render);
  $('searchTrades').addEventListener('input', render);
  $('addTradeList').addEventListener('click', () => openModal());
  ['closeModal', 'cancelModal'].forEach((id) => $(id).addEventListener('click', closeModal));
  $('tradeModal').addEventListener('click', (event) => { if (event.target === $('tradeModal')) closeModal(); });
  $('tradeForm').addEventListener('submit', onSubmit);
  $('instrument').addEventListener('change', () => { updateInstrumentField(); markRiskSizingStale(); });
  $('calculateContracts').addEventListener('click', calculateContractsFromRisk);
  $('toggleMissedEntry').addEventListener('click', () => {
    $('recordType').value = $('recordType').value === 'missed' ? 'trade' : 'missed';
    updateRecordMode();
    updateInstrumentField();
  });
  ['cfdMultiplier', 'entryPrice', 'exitPrice', 'stopPrice', 'targetPrice', 'fees'].forEach((id) => $(id).addEventListener('input', () => { updatePreview(); if (['cfdMultiplier', 'entryPrice', 'stopPrice'].includes(id)) markRiskSizingStale(); }));
  $('quantity').addEventListener('keydown', guardQuantityKeydown);
  $('quantity').addEventListener('beforeinput', guardQuantityBeforeInput);
  $('quantity').addEventListener('input', normalizeQuantityInput);
  ['cfdMultiplier', 'entryPrice', 'stopPrice', 'riskBudget', 'defaultRisk', 'targetPrice', 'maxRR', 'fees', 'exitPrice'].forEach((id) => {
    $(id).addEventListener('keydown', guardDecimalKeydown);
    $(id).addEventListener('beforeinput', guardDecimalBeforeInput);
    $(id).addEventListener('input', normalizeDecimalInput);
  });
  $('riskBudget').addEventListener('input', markRiskSizingStale);
  document.querySelectorAll('input[name="direction"]').forEach((input) => input.addEventListener('change', () => { updatePreview(); markRiskSizingStale(); }));
  $('tradeRows').addEventListener('click', (event) => {
    const editId = event.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    const viewImagesId = event.target.closest('[data-view-images]')?.dataset.viewImages;
    if (viewImagesId) { const trade = getActiveTrades().find((item) => item.id === viewImagesId); if (trade) showTradeImages(trade); }
    if (editId) { const trade = trades.find((item) => item.id === editId); if (trade) openModal(trade); }
    if (deleteId) {
      if (pendingDeleteIds.has(deleteId)) pendingDeleteIds.delete(deleteId);
      else pendingDeleteIds.add(deleteId);
      render();
    }
  });
  $('clearFilters').addEventListener('click', () => { $('periodFilter').value = 'all'; $('instrumentFilter').value = 'all'; $('recordTypeFilter').value = 'all'; $('searchTrades').value = ''; render(); });
  $('chartModeToggle').addEventListener('click', (event) => {
    const button = event.target.closest('[data-chart-mode]');
    if (!button) return;
    chartMode = button.dataset.chartMode;
    $('chartModeToggle').querySelectorAll('[data-chart-mode]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    render();
  });
  $('clearAllTrades').addEventListener('click', clearAllTrades);
  $('deleteSelectedTrades').addEventListener('click', deleteSelectedTrades);
  $('confirmCancel').addEventListener('click', () => closeConfirmModal(false));
  $('confirmAccept').addEventListener('click', () => closeConfirmModal(true));
  $('confirmModal').addEventListener('click', (event) => { if (event.target === $('confirmModal')) closeConfirmModal(false); });
  $('exportButton').addEventListener('click', exportCsv);
  $('backupButton').addEventListener('click', backupJson);
  $('chartUrlHtf').addEventListener('input', updateChartUrlPreview);
  $('chartUrlLtf').addEventListener('input', updateChartUrlPreview);
  $('closeImageViewer').addEventListener('click', closeImageViewer);
  $('imageViewer').addEventListener('click', (event) => { if (event.target === $('imageViewer')) closeImageViewer(); });
  $('returnToTrade').addEventListener('click', () => {
    setupReturnToTrade = false;
    renderSetupOptions($('setup').value);
    switchView('trades');
    $('tradeModal').classList.add('open');
    $('tradeModal').setAttribute('aria-hidden', 'false');
  });
  $('cancelSetupEdit').addEventListener('click', resetSetupEditor);
  $('setupForm').addEventListener('submit', saveSetup);
  $('cancelPoiEdit').addEventListener('click', resetPoiEditor);
  $('poiForm').addEventListener('submit', savePoi);
  $('settingsForm').addEventListener('submit', saveSettings);
  $('defaultRisk').addEventListener('input', updateSettingsButtons);
  $('defaultSetup').addEventListener('change', updateSettingsButtons);
  $('defaultPoi').addEventListener('change', updateSettingsButtons);
  $('clearSettingsButton').addEventListener('click', clearDefaultSettings);
  $('optionManagerChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-option-kind]');
    if (!button || button.dataset.optionKind === optionManagerMode) return;
    resetSetupEditor();
    resetPoiEditor();
    optionManagerMode = button.dataset.optionKind;
    renderOptionManagerMode();
  });
  $('setupRows').addEventListener('click', async (event) => {
    const editName = event.target.closest('[data-edit-setup]')?.dataset.editSetup;
    const deleteName = event.target.closest('[data-delete-setup]')?.dataset.deleteSetup;
    if (editName) {
      editingSetupName = editName;
      $('setupName').value = editName;
      $('saveSetupButton').textContent = '✓ บันทึกชื่อ';
      $('saveSetupButton').setAttribute('aria-label', 'บันทึกชื่อ Setup');
      $('cancelSetupEdit').hidden = false;
      $('setupName').focus();
    }
    if (deleteName && await openConfirmModal({
      title: 'ลบ Setup นี้หรือไม่?',
      message: `ลบ “${deleteName}” ออกจากตัวเลือกใช่หรือไม่?`,
      detail: 'รายการเทรดเดิมจะยังคงเก็บชื่อ Setup นี้ไว้',
      confirmLabel: 'ลบ Setup'
    })) {
      if (editingSetupName === deleteName) resetSetupEditor();
      setups = setups.filter((name) => name !== deleteName);
      if (settings.defaultSetup === deleteName) settings.defaultSetup = '';
      persistSetups();
      renderSetupManager();
      renderSetupOptions($('setup').value === deleteName ? '' : $('setup').value);
      toast('ลบ Setup จากตัวเลือกแล้ว');
    }
  });
  $('poiRows').addEventListener('click', async (event) => {
    const editName = event.target.closest('[data-edit-poi]')?.dataset.editPoi;
    const deleteName = event.target.closest('[data-delete-poi]')?.dataset.deletePoi;
    if (editName) {
      editingPoiName = editName;
      $('poiName').value = editName;
      $('savePoiButton').textContent = '✓ บันทึกชื่อ';
      $('savePoiButton').setAttribute('aria-label', 'บันทึกชื่อ POI');
      $('cancelPoiEdit').hidden = false;
      $('poiName').focus();
    }
    if (deleteName && await openConfirmModal({
      title: 'ลบ POI นี้หรือไม่?',
      message: `ลบ “${deleteName}” ออกจากตัวเลือกใช่หรือไม่?`,
      detail: 'รายการเทรดเดิมจะยังคงเก็บชื่อ POI นี้ไว้',
      confirmLabel: 'ลบ POI'
    })) {
      if (editingPoiName === deleteName) resetPoiEditor();
      pois = pois.filter((name) => name !== deleteName);
      if (settings.defaultPoi === deleteName) settings.defaultPoi = '';
      persistWorkspaceState();
      renderSetupManager();
      renderPoiOptions($('poi').value === deleteName ? '' : $('poi').value);
      toast('ลบ POI จากตัวเลือกแล้ว');
    }
  });
  $('pnlPreview').addEventListener('click', (event) => {
    const targetKind = event.target.closest('[data-exit-price]')?.dataset.exitPrice;
    if (!targetKind) return;
    const value = targetKind === 'target' ? $('targetPrice').value : $('stopPrice').value;
    if (value !== '') { $('exitPrice').value = value; updatePreview(); }
  });
  $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  function viewFromHash() {
    const view = location.hash.replace(/^#/, '');
    return view || 'overview';
  }
  function switchView(view, { updateHash = true } = {}) {
    const views = { overview: 'overviewView', projects: 'projectsView', trades: 'tradesView', setups: 'setupsView' };
    const labels = { overview: 'ภาพรวม', projects: 'โปรเจกต์', trades: 'รายการเทรด', setups: 'ตั้งค่า' };
    if (!views[view]) view = 'overview';
    Object.entries(views).forEach(([key, id]) => { $(id).hidden = key !== view; });
    document.querySelectorAll('.nav-item[data-view]').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
    $('viewCrumb').textContent = labels[view];
    if (updateHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
    updateDeleteSelectedButton();
    if (view === 'projects') renderProjectsView();
    if (view === 'setups') renderSetupManager();
  }
  function navigateFromHash() {
    switchView(viewFromHash(), { updateHash: false });
  }
  window.addEventListener('hashchange', navigateFromHash);
  window.addEventListener('popstate', navigateFromHash);
  $('sidebar').addEventListener('click', (event) => {
    const nav = event.target.closest('.nav-item[data-view]');
    if (nav) { event.preventDefault(); switchView(nav.dataset.view); }
    $('sidebar').classList.remove('open');
  });
  $('demoButton').addEventListener('click', () => {
    pendingDeleteIds.clear();
    if (demoMode) {
      exitDemoPortfolio();
      $('demoBanner').hidden = true;
      $('demoButtonLabel').textContent = 'ข้อมูลตัวอย่าง';
      $('demoButton').classList.remove('demo-active');
      toast('กลับสู่ข้อมูลจริงแล้ว');
      return;
    }
    enterDemoPortfolio();
    $('demoBanner').hidden = false;
    $('demoButtonLabel').textContent = 'ออกจากสาธิต';
    $('demoButton').classList.add('demo-active');
    $('searchTrades').value = '';
    $('periodFilter').value = 'all';
    toast('กำลังแสดงข้อมูลตัวอย่าง 3 โปรเจกต์ — ข้อมูลจริงไม่เปลี่ยน');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('imageViewer').classList.contains('open')) closeImageViewer();
      else if ($('workspaceManager').classList.contains('open')) closeWorkspaceManager();
      else if ($('confirmModal').classList.contains('open')) closeConfirmModal(false);
      else if (editingSetupName) resetSetupEditor();
      else if (editingPoiName) resetPoiEditor();
      else if ($('tradeModal').classList.contains('open')) closeModal();
    }
  });
  navigateFromHash();
  renderSetupOptions();
  renderPoiOptions();
  renderSetupManager();
  render();
})();
