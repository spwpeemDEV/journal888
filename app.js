(() => {
  'use strict';

  const LEGACY_SETUP_STORAGE_KEY = 'redline-trading-journal:setups:v1';
  const LEGACY_POI_STORAGE_KEY = 'redline-trading-journal:pois:v1';
  const SETTINGS_STORAGE_KEY = 'redline-trading-journal:settings:v1';
  const WORKSPACES_STORAGE_KEY = 'redline-trading-journal:workspaces:v1';
  const ACTIVE_WORKSPACE_KEY = 'redline-trading-journal:active-workspace:v1';
  const PROJECT_DATA_PREFIX = 'redline-trading-journal:project:v1:';
  const supabaseClient = window.supabase?.createClient && window.REDLINE_SUPABASE_CONFIG
    ? window.supabase.createClient(window.REDLINE_SUPABASE_CONFIG.url, window.REDLINE_SUPABASE_CONFIG.publishableKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    })
    : null;
  const FUTURES = { GC: 100, MGC: 10, NQ: 20, MNQ: 2 };
  const DEFAULT_SETUPS = ['Breakout', 'Pullback', 'Reversal', 'Trend following', 'Range', 'อื่น ๆ'];
  const DEFAULT_POIS = ['PDH / PDL', 'FVG', 'Order Block', 'Liquidity sweep', 'Support / Resistance', 'VWAP', 'Opening range', 'อื่น ๆ'];
  const $ = (id) => document.getElementById(id);
  let workspaces = loadWorkspaces();
  if (!workspaces.length) workspaces = [{ id: 'journal-default', name: 'My Journal', tradeCount: 0 }];
  let activeWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || workspaces[0].id;
  if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id;
  let trades = loadWorkspaceTrades(activeWorkspaceId);
  let setups = [...DEFAULT_SETUPS];
  let pois = [...DEFAULT_POIS];
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
  let activeWorkspaceUserId = null;
  let isAdminUser = false;
  let authMode = 'login';
  let accountUsersPage = 1;
  let accountUsersLoading = false;
  const ACCOUNT_USERS_PER_PAGE = 50;
  let workspaceLoadGeneration = 0;
  let tradeFetchGeneration = 0;
  const loadingOperations = new Set();
  const tradeFetchesInFlight = new Set();

  function syncLoadingOverlay() {
    const isLoading = loadingOperations.size > 0;
    $('tradesLoading').hidden = !isLoading;
    document.body.classList.toggle('app-busy', isLoading);
    $('journal').setAttribute('aria-busy', String(isLoading));
  }
  function beginLoadingOperation() {
    const token = Symbol('loading-operation');
    loadingOperations.add(token);
    syncLoadingOverlay();
    return token;
  }
  function endLoadingOperation(token) {
    loadingOperations.delete(token);
    syncLoadingOverlay();
  }
  let startupLoadingToken = beginLoadingOperation();
  function setAuthMode(mode) {
    authMode = mode === 'signup' ? 'signup' : 'login';
    $('loginForm').hidden = authMode !== 'login';
    $('signupForm').hidden = authMode !== 'signup';
    $('loginTitle').textContent = authMode === 'signup' ? 'สร้างบัญชีใหม่' : 'ยินดีต้อนรับกลับ';
    $('loginDescription').textContent = authMode === 'signup' ? 'สมัครสมาชิกเพื่อเริ่มใช้ Trading Journal' : 'เข้าสู่ระบบเพื่อไปยัง Trading Journal ของคุณ';
    $('loginStatus').textContent = authMode === 'signup' ? 'กรอกข้อมูลเพื่อสมัครสมาชิก' : 'เข้าสู่ระบบด้วย Email และ Password';
    $('loginStatus').classList.remove('login-status-ready');
  }

  function accessTokenClaims(token) {
    try {
      const payload = String(token || '').split('.')[1];
      if (!payload) return {};
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return {}; }
  }
  function sessionHasAdminRole(session) {
    const claims = accessTokenClaims(session?.access_token);
    const metadata = session?.user?.app_metadata || {};
    const roles = [claims.user_role, claims.app_metadata?.user_role, claims.app_metadata?.role, metadata.user_role, metadata.role, ...(Array.isArray(claims.app_metadata?.roles) ? claims.app_metadata.roles : []), ...(Array.isArray(metadata.roles) ? metadata.roles : [])];
    return roles.some((role) => String(role || '').toLowerCase() === 'admin');
  }
  function updateAdminNavigation(session) {
    isAdminUser = sessionHasAdminRole(session);
    $('accountsNav').hidden = !isAdminUser;
    if (!isAdminUser && viewFromHash() === 'accounts') switchView('overview');
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
    if (id === 'journal-default' && kind === 'settings') return SETTINGS_STORAGE_KEY;
    return `${PROJECT_DATA_PREFIX}${encodeURIComponent(id)}:${kind}`;
  }
  function legacyWorkspaceOptionKey(id, kind) {
    if (id === 'journal-default') return kind === 'setup' ? LEGACY_SETUP_STORAGE_KEY : LEGACY_POI_STORAGE_KEY;
    return `${PROJECT_DATA_PREFIX}${encodeURIComponent(id)}:${kind === 'setup' ? 'setups' : 'pois'}`;
  }
  function readLegacyOptionKey(key) {
    try {
      const raw = localStorage.getItem(key);
      const values = JSON.parse(raw || 'null');
      return Array.isArray(values) ? [...new Set(values.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))] : null;
    } catch { return null; }
  }
  function readLegacyWorkspaceOptions(id, kind) {
    return readLegacyOptionKey(legacyWorkspaceOptionKey(id, kind));
  }
  function loadWorkspaceTrades(id) {
    return workspaces.find((workspace) => workspace.id === id)?.tradeRecords || [];
  }
  function loadWorkspaceSetups(id) {
    const workspace = workspaces.find((item) => item.id === id);
    return workspaceData(workspace)?.setups || workspace?.setups || [...DEFAULT_SETUPS];
  }
  function loadWorkspacePois(id) {
    const workspace = workspaces.find((item) => item.id === id);
    return workspaceData(workspace)?.pois || workspace?.pois || [...DEFAULT_POIS];
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
  function workspaceFromRow(row) {
    return {
      id: row.id,
      name: row.name,
      tradeCount: null,
      tradeRecords: [],
      defaultRisk: row.default_risk == null ? '' : String(row.default_risk),
      defaultSetup: row.default_setup || '',
      defaultPoi: row.default_poi || ''
    };
  }
  function tradeFromRow(row) {
    return {
      id: row.id,
      missedEntry: row.missed_entry,
      instrument: row.instrument,
      date: row.trade_date,
      time: row.trade_time || '',
      session: row.session || '',
      direction: row.direction,
      quantity: row.quantity == null ? null : Number(row.quantity),
      entry: Number(row.entry),
      exit: row.exit == null ? null : Number(row.exit),
      stop: Number(row.stop),
      target: Number(row.target),
      riskBudget: row.risk_budget == null ? null : Number(row.risk_budget),
      maxRR: row.max_rr == null ? null : Number(row.max_rr),
      fees: row.fees == null ? 0 : Number(row.fees),
      cfdMultiplier: row.cfd_multiplier == null ? '' : Number(row.cfd_multiplier),
      setup: row.setup || '',
      poi: row.poi || '',
      followedPlan: row.followed_plan || 'yes',
      notes: row.notes || '',
      chartUrlHtf: row.chart_url_htf || '',
      chartUrlLtf: row.chart_url_ltf || '',
      chartUrl: row.chart_url_ltf || row.chart_url_htf || '',
      images: []
    };
  }
  function tradeToRow(trade, workspaceId = activeWorkspaceId) {
    return {
      id: trade.id,
      user_id: activeWorkspaceUserId,
      workspace_id: workspaceId,
      missed_entry: Boolean(trade.missedEntry),
      instrument: trade.instrument,
      trade_date: trade.date,
      trade_time: trade.time || null,
      session: trade.session || null,
      direction: trade.direction,
      quantity: trade.quantity == null ? null : trade.quantity,
      entry: trade.entry,
      exit: trade.exit == null ? null : trade.exit,
      stop: trade.stop,
      target: trade.target,
      risk_budget: trade.riskBudget == null ? null : trade.riskBudget,
      max_rr: trade.maxRR == null ? null : trade.maxRR,
      fees: trade.missedEntry ? null : trade.fees,
      cfd_multiplier: trade.cfdMultiplier === '' ? null : trade.cfdMultiplier,
      setup: trade.setup || null,
      poi: trade.poi || null,
      followed_plan: trade.followedPlan || 'yes',
      notes: trade.notes || null,
      chart_url_htf: trade.chartUrlHtf || null,
      chart_url_ltf: trade.chartUrlLtf || null
    };
  }
  function settingsForWorkspace(workspace) {
    if (!workspace) return normalizeSettings();
    return normalizeSettings({
      defaultRisk: workspace.defaultRisk,
      defaultSetup: workspace.defaultSetup,
      defaultPoi: workspace.defaultPoi
    });
  }
  function workspaceSettingsPayload(value = settings) {
    return {
      default_risk: value.defaultRisk === '' ? null : Number(value.defaultRisk),
      default_setup: value.defaultSetup || null,
      default_poi: value.defaultPoi || null
    };
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
    return workspaceData(workspace)?.trades || workspace?.tradeRecords || [];
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
    const maxRRValues = results.filter(({ trade }) => trade.maxRR != null && trade.maxRR !== '').map(({ trade }) => Number(trade.maxRR)).filter((value) => Number.isFinite(value) && value >= 0);
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
      localStorage.setItem(projectDataKey(activeWorkspaceId, 'settings'), JSON.stringify(settings));
      active.tradeRecords = trades;
      active.tradeCount = trades.length;
    }
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces.map(({ id, name }) => ({ id, name }))));
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
  }
  function setActiveTrades(nextTrades) {
    tradeFetchGeneration += 1;
    trades = nextTrades;
    const active = activeWorkspace();
    if (active) {
      active.tradeRecords = trades;
      active.tradeCount = trades.length;
    }
  }
  async function saveTradeRows(rows) {
    if (!supabaseClient || !activeWorkspaceUserId || !activeWorkspaceId) throw new Error('ไม่พบ session หรือ workspace ที่กำลังใช้งาน');
    if (!rows.length) return [];
    tradeFetchGeneration += 1;
    const { data, error } = await supabaseClient.from('trades')
      .upsert(rows.map((trade) => tradeToRow(trade)), { onConflict: 'id' })
      .select('*');
    if (error) throw error;
    return (data || []).map(tradeFromRow);
  }
  async function refreshActiveTrades(workspaceId) {
    if (!supabaseClient || !activeWorkspaceUserId || !workspaceId) return;
    if (tradeFetchesInFlight.has(workspaceId)) return;
    tradeFetchesInFlight.add(workspaceId);
    const generation = ++tradeFetchGeneration;
    const userId = activeWorkspaceUserId;
    const loadingToken = beginLoadingOperation();
    try {
      const { data, error } = await supabaseClient.from('trades')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('trade_date', { ascending: false })
        .order('trade_time', { ascending: false });
      if (generation !== tradeFetchGeneration || workspaceId !== activeWorkspaceId || userId !== activeWorkspaceUserId) return;
      if (error) { toast(`โหลดรายการเทรดไม่สำเร็จ: ${error.message}`); return; }
      const records = (data || []).map(tradeFromRow);
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      workspace.tradeRecords = records;
      workspace.tradeCount = records.length;
      trades = records;
      render();
    } catch (error) {
      if (generation === tradeFetchGeneration) toast(`โหลดรายการเทรดไม่สำเร็จ: ${error.message || 'ตรวจสอบการเชื่อมต่อ'}`);
    } finally {
      tradeFetchesInFlight.delete(workspaceId);
      endLoadingOperation(loadingToken);
    }
  }
  async function syncWorkspaceOptions(targetWorkspaces, generation = workspaceLoadGeneration, userId = activeWorkspaceUserId) {
    if (!supabaseClient || !targetWorkspaces.length) return;
    const ids = targetWorkspaces.map((workspace) => workspace.id);
    const { data, error } = await supabaseClient.from('workspace_options')
      .select('id, workspace_id, kind, name, sort_order')
      .in('workspace_id', ids)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (generation !== workspaceLoadGeneration || userId !== activeWorkspaceUserId) return;
    const rowsByWorkspace = new Map(ids.map((id) => [id, { setup: [], poi: [] }]));
    (data || []).forEach((row) => {
      const options = rowsByWorkspace.get(row.workspace_id);
      if (options && (row.kind === 'setup' || row.kind === 'poi')) options[row.kind].push(row);
    });
    const rowsToInsert = [];
    const legacyKeysToRemove = [];
    const savedWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    const globalLegacyTargetId = targetWorkspaces.some((workspace) => workspace.id === savedWorkspaceId)
      ? savedWorkspaceId
      : targetWorkspaces[0].id;
    targetWorkspaces.forEach((workspace) => {
      const grouped = rowsByWorkspace.get(workspace.id);
      for (const [kind, defaults] of [['setup', DEFAULT_SETUPS], ['poi', DEFAULT_POIS]]) {
        let legacy = readLegacyWorkspaceOptions(workspace.id, kind) || [];
        if (!legacy.length && workspace.id === globalLegacyTargetId) {
          legacy = readLegacyOptionKey(kind === 'setup' ? LEGACY_SETUP_STORAGE_KEY : LEGACY_POI_STORAGE_KEY) || [];
          legacyKeysToRemove.push(kind === 'setup' ? LEGACY_SETUP_STORAGE_KEY : LEGACY_POI_STORAGE_KEY);
        }
        const existingNames = new Set(grouped[kind].map((row) => row.name.toLocaleLowerCase()));
        const optionsToAdd = grouped[kind].length ? legacy.filter((name) => !existingNames.has(name.toLocaleLowerCase())) : (legacy.length ? legacy : defaults);
        optionsToAdd.forEach((name, index) => rowsToInsert.push({
          workspace_id: workspace.id,
          kind,
          name,
          sort_order: grouped[kind].length + index
        }));
        legacyKeysToRemove.push(legacyWorkspaceOptionKey(workspace.id, kind));
      }
    });
    if (rowsToInsert.length) {
      const { error: insertError } = await supabaseClient.from('workspace_options')
        .upsert(rowsToInsert, { onConflict: 'workspace_id,kind,name', ignoreDuplicates: true });
      if (insertError) throw insertError;
      if (generation !== workspaceLoadGeneration || userId !== activeWorkspaceUserId) return;
    }
    const { data: finalRows, error: finalError } = await supabaseClient.from('workspace_options')
      .select('workspace_id, kind, name, sort_order')
      .in('workspace_id', ids)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (finalError) throw finalError;
    if (generation !== workspaceLoadGeneration || userId !== activeWorkspaceUserId) return;
    const finalByWorkspace = new Map(ids.map((id) => [id, { setup: [], poi: [] }]));
    (finalRows || []).forEach((row) => {
      const options = finalByWorkspace.get(row.workspace_id);
      if (options && options[row.kind] && !options[row.kind].includes(row.name)) options[row.kind].push(row.name);
    });
    targetWorkspaces.forEach((workspace) => {
      const options = finalByWorkspace.get(workspace.id);
      workspace.setups = options.setup;
      workspace.pois = options.poi;
    });
    legacyKeysToRemove.forEach((key) => { try { localStorage.removeItem(key); } catch { /* Supabase is the source of truth. */ } });
  }
  async function saveWorkspaceOption(kind, name, previousName = '') {
    const names = kind === 'setup' ? setups : pois;
    const payload = {
      workspace_id: activeWorkspaceId,
      kind,
      name,
      sort_order: previousName ? Math.max(0, names.indexOf(previousName)) : names.length
    };
    const query = previousName
      ? supabaseClient.from('workspace_options').update({ name }).eq('workspace_id', activeWorkspaceId).eq('kind', kind).eq('name', previousName)
      : supabaseClient.from('workspace_options').insert(payload);
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ไม่พบตัวเลือก หรือไม่มีสิทธิ์แก้ไข');
  }
  async function deleteWorkspaceOption(kind, name) {
    const { data, error } = await supabaseClient.from('workspace_options').delete()
      .eq('workspace_id', activeWorkspaceId).eq('kind', kind).eq('name', name)
      .select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ไม่พบตัวเลือก หรือไม่มีสิทธิ์ลบ');
  }
  async function saveActiveWorkspaceSettings() {
    const active = activeWorkspace();
    if (!supabaseClient || !active) throw new Error('ไม่พบโปรเจกต์ที่กำลังใช้งาน');
    const { data, error } = await supabaseClient.from('workspaces')
      .update(workspaceSettingsPayload())
      .eq('id', active.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ไม่พบ workspace หรือไม่มีสิทธิ์แก้ไข');
    active.defaultRisk = settings.defaultRisk;
    active.defaultSetup = settings.defaultSetup;
    active.defaultPoi = settings.defaultPoi;
  }
  async function loadUserWorkspaces(user, generation) {
    let { data: rows, error } = await supabaseClient.from('workspaces').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    if (generation !== workspaceLoadGeneration || activeWorkspaceUserId !== user.id) return;
    workspaces = rows.map(workspaceFromRow);
    await syncWorkspaceOptions(workspaces, generation, user.id);
    if (generation !== workspaceLoadGeneration || activeWorkspaceUserId !== user.id) return;
    const { data: tradeRows, error: tradeError } = await supabaseClient.from('trades')
      .select('*')
      .order('trade_date', { ascending: false })
      .order('trade_time', { ascending: false });
    if (tradeError) throw tradeError;
    if (generation !== workspaceLoadGeneration || activeWorkspaceUserId !== user.id) return;
    const tradesByWorkspace = new Map(workspaces.map((workspace) => [workspace.id, []]));
    (tradeRows || []).forEach((row) => {
      const records = tradesByWorkspace.get(row.workspace_id);
      if (records) records.push(tradeFromRow(row));
    });
    workspaces.forEach((workspace) => {
      workspace.tradeRecords = tradesByWorkspace.get(workspace.id) || [];
      workspace.tradeCount = workspace.tradeRecords.length;
    });
    const previousId = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    activeWorkspaceId = workspaces.some((workspace) => workspace.id === previousId)
      ? previousId
      : workspaces[0]?.id || '';
    if (activeWorkspaceId) {
      trades = loadWorkspaceTrades(activeWorkspaceId);
      setups = loadWorkspaceSetups(activeWorkspaceId);
      pois = loadWorkspacePois(activeWorkspaceId);
      settings = settingsForWorkspace(activeWorkspace());
    } else {
      trades = [];
      setups = [...DEFAULT_SETUPS];
      pois = [...DEFAULT_POIS];
      settings = normalizeSettings();
    }
    if (activeWorkspace()) persistWorkspaceState();
    renderSetupOptions();
    renderPoiOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
    return workspaces.length === 0;
  }
  async function handleAuthSession(session) {
    updateAdminNavigation(session);
    const user = session?.user;
    if (!user) {
      workspaceLoadGeneration += 1;
      tradeFetchGeneration += 1;
      activeWorkspaceUserId = null;
      document.body.classList.add('auth-locked');
      if (startupLoadingToken) { endLoadingOperation(startupLoadingToken); startupLoadingToken = null; }
      $('loginBackdrop').hidden = false;
      setAuthMode('login');
      return;
    }
    if (activeWorkspaceUserId === user.id) return;
    activeWorkspaceUserId = user.id;
    const generation = ++workspaceLoadGeneration;
    const loadingToken = beginLoadingOperation();
    document.body.classList.add('auth-locked');
    $('loginBackdrop').hidden = true;
    $('loginForm').hidden = true;
    $('signupForm').hidden = true;
    $('loginStatus').textContent = 'กำลังโหลดโปรเจกต์จาก Supabase…';
    $('loginStatus').classList.remove('login-status-ready');
    try {
      const needsWorkspace = await loadUserWorkspaces(user, generation);
      if (generation !== workspaceLoadGeneration || activeWorkspaceUserId !== user.id) return;
      $('signedInEmail').textContent = user.email || 'ผู้ใช้งาน';
      document.body.classList.remove('auth-locked');
      $('loginBackdrop').hidden = true;
      if (needsWorkspace) {
        switchView('projects');
        openWorkspaceManager();
      }
    } catch (error) {
      if (generation !== workspaceLoadGeneration) return;
      activeWorkspaceUserId = null;
      $('loginBackdrop').hidden = false;
      setAuthMode('login');
      $('loginStatus').textContent = `โหลดโปรเจกต์ไม่สำเร็จ: ${error.message || 'ตรวจสอบตาราง workspaces และ RLS policy'}`;
      $('loginStatus').classList.add('login-status-ready');
    } finally {
      endLoadingOperation(loadingToken);
      if (startupLoadingToken) { endLoadingOperation(startupLoadingToken); startupLoadingToken = null; }
    }
  }
  if (!localStorage.getItem(WORKSPACES_STORAGE_KEY)) {
    try {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces.map(({ id, name }) => ({ id, name }))));
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    } catch { /* Keep legacy records readable even if the browser cannot add workspace metadata yet. */ }
  }
  function activeWorkspace() { return workspaces.find((workspace) => workspace.id === activeWorkspaceId); }
  function renderWorkspaceControls() {
    const active = activeWorkspace();
    const fallbackName = workspaces.length ? 'My Journal' : 'ยังไม่มีโปรเจกต์';
    $('workspaceSelect').innerHTML = workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.name)}</option>`).join('');
    $('workspaceSelect').value = activeWorkspaceId;
    $('sidebarProjectName').textContent = active?.name || fallbackName;
    $('activeWorkspaceLabel').textContent = active?.name || fallbackName;
    $('workspaceCount').textContent = `${workspaces.length} โปรเจกต์`;
    $('workspaceRows').innerHTML = workspaces.map((workspace) => `<div class="workspace-row${workspace.id === activeWorkspaceId ? ' active' : ''}"><button type="button" class="workspace-row-select" data-select-workspace="${escapeHtml(workspace.id)}"><strong>${escapeHtml(workspace.name)}</strong><small>${workspaceTradeCount(workspace)} รายการเทรด${workspace.id === activeWorkspaceId ? ' · กำลังใช้งาน' : ''}</small></button><div class="workspace-row-actions"><button type="button" data-rename-workspace="${escapeHtml(workspace.id)}">เปลี่ยนชื่อ</button>${workspaces.length > 1 ? `<button type="button" class="delete-setup" data-delete-workspace="${escapeHtml(workspace.id)}">ลบ</button>` : ''}</div></div>`).join('');
    renderProjectsView();
  }
  function renderProjectsView() {
    $('projectsCount').textContent = `${workspaces.length} โปรเจกต์`;
    if (!workspaces.length) {
      $('projectsGrid').innerHTML = '<div class="empty-state project-empty-state"><div class="empty-icon">▦</div><strong>ยังไม่มีโปรเจกต์</strong><p>สร้างโปรเจกต์แรกเพื่อเริ่มบันทึกเทรดและตั้งค่าพื้นที่ทำงานของคุณ</p><button type="button" class="primary-button" data-open-project-form><span>＋</span> สร้างโปรเจกต์แรก</button></div>';
      return;
    }
    $('projectsGrid').innerHTML = workspaces.map((workspace) => {
      const stats = workspaceStats(workspace);
      const setupCount = workspaceData(workspace)?.setups.length ?? loadWorkspaceSetups(workspace.id).length;
      const activeClass = workspace.id === activeWorkspaceId ? ' active' : '';
      const netClass = stats.net > 0 ? 'positive-text' : stats.net < 0 ? 'negative-text' : 'muted-text';
      return `<article class="project-card${activeClass}"><div class="project-card-top"><span class="project-card-icon">▦</span><span class="project-status">${workspace.id === activeWorkspaceId ? 'กำลังใช้งาน' : 'พร้อมใช้งาน'}</span></div><h3>${escapeHtml(workspace.name)}</h3><div class="project-card-stats"><span><small>เทรด</small><strong>${stats.count}</strong></span><span><small>Setup</small><strong>${setupCount}</strong></span></div><div class="project-card-metrics"><span><small>Win rate</small><strong>${stats.count ? `${stats.winRate.toFixed(0)}%` : '—'}</strong></span><span><small>กำไร / ขาดทุน</small><strong class="${netClass}">${money(stats.net, 0)}</strong></span><span><small>แพ้ติดกัน</small><strong>${stats.maxLossStreak} ไม้</strong></span><span><small>Avg R</small><strong>${stats.avgR == null ? '—' : `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`}</strong></span><span><small>Max RR</small><strong>${stats.maxRR == null ? '—' : `+${stats.maxRR.toFixed(2)}R`}</strong></span></div><div class="project-card-actions"><button type="button" class="primary-button" data-select-project="${escapeHtml(workspace.id)}">${workspace.id === activeWorkspaceId ? 'เปิดภาพรวม' : 'ใช้โปรเจกต์นี้'}</button><button type="button" class="secondary-button project-share-button" data-share-workspace="${escapeHtml(workspace.id)}">↗ แชร์ภาพรวมและรายการ</button><button type="button" class="project-action-button" data-revoke-share="${escapeHtml(workspace.id)}">ปิดลิงก์แชร์</button>${workspaces.length > 1 ? `<button type="button" class="project-action-button danger" data-delete-workspace="${escapeHtml(workspace.id)}">ลบ</button>` : ''}</div></article>`;
    }).join('');
  }
  function formatAccountTimestamp(value) {
    if (!value) return 'ยังไม่เคย Login';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  async function loadAccountUsers(page = accountUsersPage) {
    if (!isAdminUser || !supabaseClient || accountUsersLoading) return;
    accountUsersLoading = true;
    const loadingToken = beginLoadingOperation();
    accountUsersPage = Math.max(1, page);
    $('accountsStatus').textContent = 'กำลังโหลดรายชื่อบัญชี…';
    $('refreshAccounts').disabled = true;
    $('previousAccountsPage').disabled = true;
    $('nextAccountsPage').disabled = true;
    try {
      const { data, error } = await supabaseClient.functions.invoke('list-users', {
        body: { page: accountUsersPage, perPage: ACCOUNT_USERS_PER_PAGE }
      });
      if (error) throw error;
      const users = Array.isArray(data?.users) ? data.users : [];
      $('accountsRows').innerHTML = users.length ? users.map((user) => `<tr><td><span class="account-email">${escapeHtml(user.email || 'ไม่มี Email')}</span><small class="account-user-id">${escapeHtml(user.id)}</small></td><td>${escapeHtml(formatAccountTimestamp(user.createdAt))}</td><td>${escapeHtml(formatAccountTimestamp(user.lastSignInAt))}</td></tr>`).join('') : '<tr><td colspan="3" class="account-empty-cell">ไม่พบบัญชีในหน้านี้</td></tr>';
      $('accountsStatus').textContent = `${Number(data?.count ?? users.length)} บัญชีในหน้านี้`;
      $('accountsPageLabel').textContent = `หน้า ${accountUsersPage}`;
      $('previousAccountsPage').disabled = accountUsersPage <= 1;
      $('nextAccountsPage').disabled = !data?.hasMore;
    } catch (error) {
      $('accountsRows').innerHTML = '<tr><td colspan="3" class="account-empty-cell">โหลดรายชื่อบัญชีไม่สำเร็จ</td></tr>';
      $('accountsStatus').textContent = `โหลดรายชื่อบัญชีไม่สำเร็จ: ${error.message || 'ตรวจสอบการ Deploy Edge Function list-users'}`;
    } finally {
      accountUsersLoading = false;
      $('refreshAccounts').disabled = false;
      endLoadingOperation(loadingToken);
    }
  }
  async function manageWorkspaceShare(action, workspaceId) {
    if (!supabaseClient || !activeWorkspaceUserId) { toast('กรุณาเข้าสู่ระบบก่อนจัดการลิงก์แชร์'); return; }
    if (action === 'revoke' && !window.confirm('ปิดลิงก์แชร์ของโปรเจกต์นี้หรือไม่? ผู้ที่มีลิงก์จะเปิดดูข้อมูลไม่ได้อีก')) return;
    const loadingToken = beginLoadingOperation();
    try {
      const { data, error } = await supabaseClient.functions.invoke('workspace-share', {
        body: { action, workspaceId }
      });
      if (error) throw error;
      if (action === 'revoke') {
        toast(data?.revoked ? 'ปิดลิงก์แชร์แล้ว' : 'โปรเจกต์นี้ยังไม่มีลิงก์แชร์');
        return;
      }
      if (!data?.token) throw new Error('ไม่ได้รับลิงก์แชร์จาก Supabase');
      const shareUrl = new URL('share.html', window.location.href);
      shareUrl.hash = data.token;
      try {
        await navigator.clipboard.writeText(shareUrl.toString());
        toast('คัดลอกลิงก์แชร์แล้ว · เปิดดูได้ทั้งภาพรวมและรายการเทรด');
      } catch {
        window.prompt('คัดลอกลิงก์แชร์นี้', shareUrl.toString());
      }
    } catch (error) {
      toast(`จัดการลิงก์แชร์ไม่สำเร็จ: ${error.message || 'ตรวจสอบการ Deploy workspace-share'}`);
    } finally { endLoadingOperation(loadingToken); }
  }
  function switchWorkspace(id) {
    if (demoMode && demoPortfolioMode) { switchDemoWorkspace(id); return; }
    if (!workspaces.some((workspace) => workspace.id === id)) return;
    if (id === activeWorkspaceId) return;
    resetSetupEditor();
    pendingDeleteIds.clear();
    if (demoMode) {
      demoMode = false;
      $('demoBanner').hidden = true;
      $('demoButtonLabel').textContent = 'ข้อมูลตัวอย่าง';
      $('demoButton').classList.remove('demo-active');
    }
    tradeFetchGeneration += 1;
    activeWorkspaceId = id;
    const active = activeWorkspace();
    trades = loadWorkspaceTrades(activeWorkspaceId);
    setups = loadWorkspaceSetups(activeWorkspaceId);
    pois = loadWorkspacePois(activeWorkspaceId);
    settings = settingsForWorkspace(active);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
    $('searchTrades').value = '';
    $('periodFilter').value = 'all';
    $('instrumentFilter').value = 'all';
    renderSetupOptions();
    renderPoiOptions();
    renderSetupManager();
    renderWorkspaceControls();
    render();
    void refreshActiveTrades(activeWorkspaceId);
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
  async function createWorkspace(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงสร้างโปรเจกต์ได้'); return; }
    const name = $('workspaceName').value.trim();
    if (!name) return;
    if (workspaces.some((workspace) => workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { toast('มีชื่อโปรเจกต์นี้แล้ว'); return; }
    const submitButton = $('workspaceForm').querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const loadingToken = beginLoadingOperation();
    try {
      const { data, error } = await supabaseClient.from('workspaces').insert({ name }).select('*').single();
      if (error) throw error;
      const workspace = workspaceFromRow(data);
      try {
        await syncWorkspaceOptions([workspace]);
        workspaces.push(workspace);
        persistWorkspaceState();
      } catch (setupError) {
        workspaces = workspaces.filter((item) => item.id !== workspace.id);
        await supabaseClient.from('workspaces').delete().eq('id', workspace.id);
        throw new Error(`สร้างตัวเลือก Setup/POI ใน Supabase ไม่สำเร็จ: ${setupError.message}`);
      }
      $('workspaceName').value = '';
      switchWorkspace(workspace.id);
      renderWorkspaceControls();
      toast(`สร้างโปรเจกต์ “${name}” แล้ว`);
    } catch (error) {
      toast(`สร้างโปรเจกต์ไม่สำเร็จ: ${error.message || 'ตรวจสอบการเชื่อมต่อและสิทธิ์'}`);
    } finally {
      submitButton.disabled = false;
      endLoadingOperation(loadingToken);
    }
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
      const loadingToken = beginLoadingOperation();
      try {
        const { data, error } = await supabaseClient.from('workspaces').update({ name: nextName }).eq('id', renameId).select('*').maybeSingle();
        if (error || !data) { toast(`เปลี่ยนชื่อไม่สำเร็จ: ${error?.message || 'ไม่พบ workspace หรือไม่มีสิทธิ์'}`); return; }
        workspace.name = data.name;
        try { persistWorkspaceState(); }
        catch { toast('เปลี่ยนชื่อใน Supabase แล้ว แต่บันทึกแคชในเบราว์เซอร์ไม่สำเร็จ'); }
        renderWorkspaceControls();
        toast('เปลี่ยนชื่อโปรเจกต์แล้ว');
      } finally { endLoadingOperation(loadingToken); }
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
        detail: 'รายการเทรด Setup และ POI ทั้งหมดจะถูกลบ และการลบนี้ย้อนกลับไม่ได้',
        confirmLabel: 'ลบโปรเจกต์'
      });
      if (!confirmed) return;
      const loadingToken = beginLoadingOperation();
      try {
        const { data: deleted, error: deleteError } = await supabaseClient.from('workspaces').delete().eq('id', deleteId).select('id').maybeSingle();
        if (deleteError || !deleted) throw new Error(deleteError?.message || 'ไม่พบ workspace หรือไม่มีสิทธิ์');
        workspaces = workspaces.filter((item) => item.id !== deleteId);
        if (activeWorkspaceId === deleteId) {
          activeWorkspaceId = workspaces[0].id;
          trades = loadWorkspaceTrades(activeWorkspaceId);
          setups = loadWorkspaceSetups(activeWorkspaceId);
          pois = loadWorkspacePois(activeWorkspaceId);
          settings = settingsForWorkspace(activeWorkspace());
        }
        try { persistWorkspaceState(); }
        catch { toast('ลบโปรเจกต์จาก Supabase แล้ว แต่แคชการตั้งค่าในเบราว์เซอร์บันทึกไม่สำเร็จ'); }
        localStorage.removeItem(projectDataKey(deleteId, 'settings'));
        renderSetupOptions();
        renderPoiOptions();
        renderWorkspaceControls();
        render();
        toast('ลบโปรเจกต์แล้ว');
      } catch (error) {
        toast(`ลบโปรเจกต์ไม่สำเร็จ: ${error.message || 'ตรวจสอบการเชื่อมต่อและสิทธิ์'}`);
      } finally {
        endLoadingOperation(loadingToken);
      }
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
  async function saveSetup(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไข Setup ได้'); return; }
    const nextName = $('setupName').value.trim();
    if (!nextName) return;
    const duplicate = setups.some((name) => name.toLocaleLowerCase() === nextName.toLocaleLowerCase() && name !== editingSetupName);
    if (duplicate) { toast('มีชื่อ Setup นี้อยู่แล้ว'); return; }
    const oldName = editingSetupName;
    const loadingToken = beginLoadingOperation();
    try {
      await saveWorkspaceOption('setup', nextName, oldName || '');
      setups = oldName ? setups.map((name) => name === oldName ? nextName : name) : [...setups, nextName];
      activeWorkspace().setups = setups;
      if (oldName) {
        const { error } = await supabaseClient.from('trades').update({ setup: nextName })
          .eq('workspace_id', activeWorkspaceId).eq('setup', oldName);
        if (error) toast(`เปลี่ยนชื่อ Setup แล้ว แต่ชื่อในรายการเทรดบางรายการอาจยังไม่เปลี่ยน: ${error.message}`);
        else setActiveTrades(trades.map((trade) => trade.setup === oldName ? { ...trade, setup: nextName } : trade));
        if (settings.defaultSetup === oldName) {
          const oldDefault = settings.defaultSetup;
          settings.defaultSetup = nextName;
          try { await saveActiveWorkspaceSettings(); }
          catch (error) { settings.defaultSetup = oldDefault; toast(`เปลี่ยนชื่อ Setup แล้ว แต่บันทึกค่า default ไม่สำเร็จ: ${error.message}`); }
        }
      }
      renderSetupManager();
      renderSetupOptions(nextName);
      render();
      resetSetupEditor();
      $('setupName').focus();
      toast(oldName ? 'เปลี่ยนชื่อ Setup แล้ว' : 'เพิ่ม Setup แล้ว');
    } catch (error) {
      toast(`บันทึก Setup ใน Supabase ไม่สำเร็จ: ${error.message}`);
    } finally { endLoadingOperation(loadingToken); }
  }
  function resetPoiEditor() {
    editingPoiName = null;
    $('poiName').value = '';
    $('savePoiButton').textContent = '＋ เพิ่ม POI';
    $('savePoiButton').setAttribute('aria-label', 'เพิ่ม POI');
    $('cancelPoiEdit').hidden = true;
  }
  async function savePoi(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไข POI ได้'); return; }
    const nextName = $('poiName').value.trim();
    if (!nextName) return;
    const duplicate = pois.some((name) => name.toLocaleLowerCase() === nextName.toLocaleLowerCase() && name !== editingPoiName);
    if (duplicate) { toast('มีชื่อ POI นี้อยู่แล้ว'); return; }
    const oldName = editingPoiName;
    const loadingToken = beginLoadingOperation();
    try {
      await saveWorkspaceOption('poi', nextName, oldName || '');
      pois = oldName ? pois.map((name) => name === oldName ? nextName : name) : [...pois, nextName];
      activeWorkspace().pois = pois;
      if (oldName) {
        const { error } = await supabaseClient.from('trades').update({ poi: nextName })
          .eq('workspace_id', activeWorkspaceId).eq('poi', oldName);
        if (error) toast(`เปลี่ยนชื่อ POI แล้ว แต่ชื่อในรายการเทรดบางรายการอาจยังไม่เปลี่ยน: ${error.message}`);
        else setActiveTrades(trades.map((trade) => trade.poi === oldName ? { ...trade, poi: nextName } : trade));
        if (settings.defaultPoi === oldName) {
          const oldDefault = settings.defaultPoi;
          settings.defaultPoi = nextName;
          try { await saveActiveWorkspaceSettings(); }
          catch (error) { settings.defaultPoi = oldDefault; toast(`เปลี่ยนชื่อ POI แล้ว แต่บันทึกค่า default ไม่สำเร็จ: ${error.message}`); }
        }
      }
      renderSetupManager();
      renderPoiOptions(nextName);
      render();
      resetPoiEditor();
      $('poiName').focus();
      toast(oldName ? 'เปลี่ยนชื่อ POI แล้ว' : 'เพิ่ม POI แล้ว');
    } catch (error) {
      toast(`บันทึก POI ใน Supabase ไม่สำเร็จ: ${error.message}`);
    } finally { endLoadingOperation(loadingToken); }
  }
  async function saveSettings(event) {
    event.preventDefault();
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงแก้ไขค่าเริ่มต้นได้'); return; }
    const defaultRisk = $('defaultRisk').value.trim();
    if (defaultRisk !== '' && (!Number.isFinite(Number(defaultRisk)) || Number(defaultRisk) <= 0)) {
      toast('Risk ต้องเป็นจำนวนเงินมากกว่า 0 หรือเว้นว่างไว้');
      $('defaultRisk').focus();
      return;
    }
    const nextSettings = {
      defaultRisk,
      defaultSetup: $('defaultSetup').value,
      defaultPoi: $('defaultPoi').value
    };
    const previousSettings = settings;
    settings = nextSettings;
    const loadingToken = beginLoadingOperation();
    try { await saveActiveWorkspaceSettings(); }
    catch (error) { settings = previousSettings; toast(`บันทึกค่าเริ่มต้นใน Supabase ไม่สำเร็จ: ${error.message}`); return; }
    finally { endLoadingOperation(loadingToken); }
    persistWorkspaceState();
    renderDefaultSettings();
    toast('บันทึกค่าเริ่มต้นแล้ว');
  }
  async function clearDefaultSettings() {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงล้างค่าเริ่มต้นได้'); return; }
    const previousSettings = settings;
    settings = normalizeSettings();
    const loadingToken = beginLoadingOperation();
    try { await saveActiveWorkspaceSettings(); }
    catch (error) { settings = previousSettings; toast(`ล้างค่าเริ่มต้นใน Supabase ไม่สำเร็จ: ${error.message}`); return; }
    finally { endLoadingOperation(loadingToken); }
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
    const maxRRValues = results.filter(({ trade }) => trade.maxRR != null && trade.maxRR !== '').map(({ trade }) => Number(trade.maxRR)).filter((value) => Number.isFinite(value) && value >= 0);
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
    $('maxRRStat').textContent = maxRR == null ? '—' : `+${maxRR.toFixed(2)}R`;
    $('maxRRStat').className = `stat-value ${maxRR != null ? 'positive' : ''}`;
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
    $('tradeRows').innerHTML = rows.map((trade, index) => {
      const isMissed = Boolean(trade.missedEntry);
      const isPendingDelete = pendingDeleteIds.has(trade.id);
      const result = isMissed ? null : metrics(trade);
      const isFutures = trade.instrument !== 'XAUUSD';
      const rText = !result || result.r == null ? '—' : `${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}R`;
      const maxRRText = isMissed || trade.maxRR == null || trade.maxRR === '' ? '—' : `${Number(trade.maxRR) >= 0 ? '+' : ''}${Number(trade.maxRR).toFixed(2)}R`;
      const noteText = String(trade.notes || '').trim();
      const outcomeClass = isMissed ? 'missed' : result.outcome === 'WIN' ? 'win' : result.outcome === 'LOSS' ? 'loss' : 'flat';
      const images = Array.isArray(trade.images) ? trade.images : [];
      const chartCell = `${images.length ? `<button class="chart-count-button" type="button" data-view-images="${escapeHtml(trade.id)}" aria-label="ดูรูปทั้งหมด ${images.length} รูป">ดูรูป</button>` : ''}${chartLinksFor(trade).map(([label, url]) => renderChartLink(label, url)).join('')}`;
      const rowActions = demoMode ? '' : `<button class="row-action" data-edit="${escapeHtml(trade.id)}" title="แก้ไข" aria-label="แก้ไขรายการ">✎</button><button class="row-action${isPendingDelete ? ' pending-delete' : ''}" data-delete="${escapeHtml(trade.id)}" title="${isPendingDelete ? 'ยกเลิกการเลือก' : 'เลือกเพื่อลบ'}" aria-label="${isPendingDelete ? 'ยกเลิกการเลือกลบ' : 'เลือกเพื่อลบ'}">${isPendingDelete ? '↶' : '×'}</button>`;
      const priceText = `${Number(trade.entry).toLocaleString('en-US')} <span style="color:#707076">/</span> ${isMissed || trade.exit == null || trade.exit === '' ? '—' : Number(trade.exit).toLocaleString('en-US')}`;
      const rowClasses = [isMissed ? 'missed-entry-row' : '', isPendingDelete ? 'pending-delete-row' : ''].filter(Boolean).join(' ');
      return `<tr class="${rowClasses}"><td class="row-number">${index + 1}</td><td><span class="date-cell">${dateLabel(trade.date)}<small>${escapeHtml(trade.time || '—')}</small></span></td><td><span class="session-chip">${escapeHtml(trade.session || '—')}</span></td><td><span class="instrument-pill ${isFutures ? 'futures' : ''}"><i></i>${escapeHtml(trade.instrument)}</span></td><td><span class="dir-tag ${trade.direction === 'Short' ? 'short' : 'long'}">${trade.direction === 'Short' ? 'SHORT' : 'LONG'}</span></td><td>${isMissed ? '—' : escapeHtml(quantityWithUnit(trade))}</td><td><span class="date-cell">${priceText}<small>SL ${trade.stop === '' ? '—' : Number(trade.stop).toLocaleString('en-US')} · TP ${trade.target == null || trade.target === '' ? '—' : Number(trade.target).toLocaleString('en-US')}</small></span></td><td><span class="setup-chip">${escapeHtml(trade.setup || '—')}</span></td><td><span class="poi-chip" title="${escapeHtml(trade.poi || '')}">${escapeHtml(trade.poi || '—')}</span></td><td class="trade-note-cell" title="${escapeHtml(noteText)}">${escapeHtml(noteText || '—')}</td><td><div class="chart-cell">${chartCell || '<span class="muted-text">—</span>'}</div></td><td><span class="outcome-chip ${outcomeClass}">${isMissed ? 'MISSED' : result.outcome}</span></td><td class="${!result || result.r == null ? 'muted-text' : result.r >= 0 ? 'positive-text' : 'negative-text'}">${rText}</td><td class="${maxRRText === '—' ? 'muted-text' : 'positive-text'}">${maxRRText}</td><td class="${!result || result.net === 0 ? 'muted-text' : result.net > 0 ? 'positive-text' : 'negative-text'}">${result ? money(result.net) : '—'}</td><td><div class="row-actions">${rowActions}</div></td></tr>`;
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
    $('riskSizingFeedback').textContent = 'ใส่ Risk, Entry และ SL แล้วกดคำนวณหรือออกจากช่อง Risk · ค่าธรรมเนียมและ slippage ยังไม่รวม';
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
    $('instrument').focus();
  }
  function closeModal() {
    $('tradeModal').classList.remove('open');
    $('tradeModal').setAttribute('aria-hidden', 'true');
    setupReturnToTrade = false;
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
      feedback.textContent = 'ค่า Entry, SL, Risk หรือสินทรัพย์เปลี่ยนแล้ว — กดคำนวณหรือออกจากช่อง Risk อีกครั้ง';
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
    const backupWorkspaces = workspaces.map(({ id, name }) => ({ id, name, trades: loadWorkspaceTrades(id), setups: loadWorkspaceSetups(id), pois: loadWorkspacePois(id) }));
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
    const loadingToken = beginLoadingOperation();
    try {
      const { error } = await supabaseClient.from('trades').delete().eq('workspace_id', activeWorkspaceId);
      if (error) throw error;
      setActiveTrades([]);
      pendingDeleteIds.clear();
      render();
      toast('ล้างรายการเทรดทั้งหมดแล้ว');
    } catch (error) {
      toast(`ล้างข้อมูลไม่สำเร็จ: ${error.message || 'ตรวจสอบ RLS policy'}`);
    } finally {
      endLoadingOperation(loadingToken);
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
    const loadingToken = beginLoadingOperation();
    try {
      const { data: deleted, error } = await supabaseClient.from('trades').delete()
        .eq('workspace_id', activeWorkspaceId).in('id', selectedIds).select('id');
      if (error) throw error;
      if ((deleted || []).length !== selectedIds.length) throw new Error('ลบบางรายการไม่สำเร็จหรือไม่มีสิทธิ์');
      const selected = new Set(selectedIds);
      setActiveTrades(trades.filter((trade) => !selected.has(trade.id)));
      pendingDeleteIds.clear();
      render();
      toast(`ลบ ${selectedIds.length} รายการแล้ว`);
    } catch (error) {
      toast(`ลบรายการไม่สำเร็จ: ${error.message || 'ตรวจสอบ RLS policy'}`);
    } finally {
      endLoadingOperation(loadingToken);
    }
  }
  function clearTradeFieldErrors() {
    document.querySelectorAll('#tradeForm .field-error').forEach((error) => error.remove());
    document.querySelectorAll('#tradeForm .field.invalid').forEach((field) => field.classList.remove('invalid'));
  }
  function clearTradeFieldError(input) {
    const field = input.closest('.field');
    if (!field) return;
    field.classList.remove('invalid');
    field.querySelector('.field-error')?.remove();
  }
  function validateRequiredTradeFields() {
    const messages = {
      tradeDate: 'กรุณาเลือกวันเทรด',
      quantity: 'กรุณากรอกจำนวน lot หรือสัญญา',
      cfdMultiplier: 'กรุณากรอกมูลค่าต่อจุดตาม broker',
      entryPrice: 'กรุณากรอกราคา Entry',
      stopPrice: 'กรุณากรอกราคา Stop Loss',
      targetPrice: 'กรุณากรอกราคา Take Profit',
      exitPrice: 'กรุณากรอกราคาออกจริง'
    };
    const invalidInputs = [...$('tradeForm').querySelectorAll('[required]')]
      .filter((input) => input.required && !input.value.trim());
    invalidInputs.forEach((input) => {
      const field = input.closest('.field');
      if (!field) return;
      field.classList.add('invalid');
      const message = document.createElement('small');
      message.className = 'field-error';
      message.setAttribute('role', 'alert');
      message.textContent = messages[input.id] || 'กรุณากรอกข้อมูลนี้';
      input.insertAdjacentElement('afterend', message);
    });
    invalidInputs[0]?.focus();
    return invalidInputs.length === 0;
  }
  async function onSubmit(event) {
    event.preventDefault();
    clearTradeFieldErrors();
    $('formError').textContent = '';
    const missedEntry = $('recordType').value === 'missed';
    if (!validateRequiredTradeFields()) return;
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
      setup: $('setup').value, poi: $('poi').value.trim(), followedPlan: trades.find((item) => item.id === $('tradeId').value)?.followedPlan || 'yes', notes: $('notes').value.trim(),
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
    const submitButton = $('saveTradeButton');
    submitButton.disabled = true;
    const originalLabel = submitButton.innerHTML;
    submitButton.textContent = 'กำลังบันทึก…';
    const loadingToken = beginLoadingOperation();
    try {
      const [savedTrade] = await saveTradeRows([trade]);
      if (!savedTrade) throw new Error('Supabase ไม่ส่งข้อมูลรายการที่บันทึกกลับมา');
      const updatedTrades = [...trades];
      if (existingIndex >= 0) updatedTrades[existingIndex] = savedTrade;
      else updatedTrades.push(savedTrade);
      setActiveTrades(updatedTrades);
    } catch (error) {
      $('formError').textContent = `บันทึกรายการไม่สำเร็จ: ${error.message || 'ตรวจสอบตาราง trades และ RLS policy'}`;
      return;
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = originalLabel;
      endLoadingOperation(loadingToken);
    }
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
    const shareWorkspaceId = event.target.closest('[data-share-workspace]')?.dataset.shareWorkspace;
    if (shareWorkspaceId) { await manageWorkspaceShare('create', shareWorkspaceId); return; }
    const revokeWorkspaceId = event.target.closest('[data-revoke-share]')?.dataset.revokeShare;
    if (revokeWorkspaceId) { await manageWorkspaceShare('revoke', revokeWorkspaceId); return; }
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
  $('refreshAccounts').addEventListener('click', () => { void loadAccountUsers(accountUsersPage); });
  $('previousAccountsPage').addEventListener('click', () => { if (accountUsersPage > 1) void loadAccountUsers(accountUsersPage - 1); });
  $('nextAccountsPage').addEventListener('click', () => { void loadAccountUsers(accountUsersPage + 1); });
  $('refreshOverview').addEventListener('click', () => {
    if (demoMode) { toast('ออกจากโหมดสาธิตก่อนจึงรีเฟรชข้อมูลจริงได้'); return; }
    void refreshActiveTrades(activeWorkspaceId);
  });
  $('periodFilter').addEventListener('change', render);
  $('instrumentFilter').addEventListener('change', render);
  $('recordTypeFilter').addEventListener('change', render);
  $('searchTrades').addEventListener('input', render);
  $('addTradeList').addEventListener('click', () => openModal());
  ['closeModal', 'cancelModal'].forEach((id) => $(id).addEventListener('click', closeModal));
  $('tradeForm').addEventListener('submit', onSubmit);
  ['input', 'change'].forEach((eventName) => $('tradeForm').addEventListener(eventName, (event) => {
    if (event.target.matches('input, select, textarea') && event.target.value.trim()) clearTradeFieldError(event.target);
  }));
  $('instrument').addEventListener('change', () => { updateInstrumentField(); markRiskSizingStale(); });
  $('calculateRiskButton').addEventListener('mousedown', (event) => event.preventDefault());
  $('calculateRiskButton').addEventListener('click', calculateContractsFromRisk);
  $('riskBudget').addEventListener('blur', () => {
    if ($('riskBudget').value.trim()) calculateContractsFromRisk();
  });
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
    if (deleteName && setups.length <= 1) { toast('ต้องเหลือ Setup อย่างน้อย 1 รายการ'); return; }
    if (deleteName && await openConfirmModal({
      title: 'ลบ Setup นี้หรือไม่?',
      message: `ลบ “${deleteName}” ออกจากตัวเลือกใช่หรือไม่?`,
      detail: 'รายการเทรดเดิมจะยังคงเก็บชื่อ Setup นี้ไว้',
      confirmLabel: 'ลบ Setup'
    })) {
      if (editingSetupName === deleteName) resetSetupEditor();
      const loadingToken = beginLoadingOperation();
      try {
        await deleteWorkspaceOption('setup', deleteName);
        setups = setups.filter((name) => name !== deleteName);
        activeWorkspace().setups = setups;
        const changedDefault = settings.defaultSetup === deleteName;
        if (changedDefault) {
          settings.defaultSetup = '';
          try { await saveActiveWorkspaceSettings(); }
          catch (error) { toast(`ลบ Setup แล้ว แต่ล้างค่า default ไม่สำเร็จ: ${error.message}`); }
        }
        renderSetupManager();
        renderSetupOptions($('setup').value === deleteName ? '' : $('setup').value);
        render();
        toast('ลบ Setup จากตัวเลือกแล้ว');
      } catch (error) { toast(`ลบ Setup จาก Supabase ไม่สำเร็จ: ${error.message}`); }
      finally { endLoadingOperation(loadingToken); }
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
    if (deleteName && pois.length <= 1) { toast('ต้องเหลือ POI อย่างน้อย 1 รายการ'); return; }
    if (deleteName && await openConfirmModal({
      title: 'ลบ POI นี้หรือไม่?',
      message: `ลบ “${deleteName}” ออกจากตัวเลือกใช่หรือไม่?`,
      detail: 'รายการเทรดเดิมจะยังคงเก็บชื่อ POI นี้ไว้',
      confirmLabel: 'ลบ POI'
    })) {
      if (editingPoiName === deleteName) resetPoiEditor();
      const loadingToken = beginLoadingOperation();
      try {
        await deleteWorkspaceOption('poi', deleteName);
        pois = pois.filter((name) => name !== deleteName);
        activeWorkspace().pois = pois;
        const changedDefault = settings.defaultPoi === deleteName;
        if (changedDefault) {
          settings.defaultPoi = '';
          try { await saveActiveWorkspaceSettings(); }
          catch (error) { toast(`ลบ POI แล้ว แต่ล้างค่า default ไม่สำเร็จ: ${error.message}`); }
        }
        renderSetupManager();
        renderPoiOptions($('poi').value === deleteName ? '' : $('poi').value);
        render();
        toast('ลบ POI จากตัวเลือกแล้ว');
      } catch (error) { toast(`ลบ POI จาก Supabase ไม่สำเร็จ: ${error.message}`); }
      finally { endLoadingOperation(loadingToken); }
    }
  });
  $('pnlPreview').addEventListener('click', (event) => {
    const targetKind = event.target.closest('[data-exit-price]')?.dataset.exitPrice;
    if (!targetKind) return;
    const value = targetKind === 'target' ? $('targetPrice').value : $('stopPrice').value;
    if (value !== '') { $('exitPrice').value = value; updatePreview(); }
  });
  $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('toggleLoginPassword').addEventListener('click', () => {
    const passwordInput = $('loginPassword');
    const showPassword = passwordInput.type === 'password';
    passwordInput.type = showPassword ? 'text' : 'password';
    $('toggleLoginPassword').setAttribute('aria-pressed', String(showPassword));
    $('toggleLoginPassword').setAttribute('aria-label', showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
    passwordInput.focus();
  });
  $('showSignup').addEventListener('click', () => setAuthMode('signup'));
  $('showLogin').addEventListener('click', () => setAuthMode('login'));
  $('loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!supabaseClient) {
      $('loginStatus').textContent = 'โหลด Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      $('loginStatus').classList.add('login-status-ready');
      return;
    }
    const submitButton = $('loginForm').querySelector('button[type="submit"]');
    submitButton.disabled = true;
    $('loginStatus').textContent = 'กำลังเข้าสู่ระบบ…';
    $('loginStatus').classList.remove('login-status-ready');
    const loadingToken = beginLoadingOperation();
    supabaseClient.auth.signInWithPassword({
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value
    }).then(({ error }) => {
      submitButton.disabled = false;
      endLoadingOperation(loadingToken);
      if (!error) return;
      $('loginStatus').textContent = error.message === 'Invalid login credentials'
        ? 'Email หรือ Password ไม่ถูกต้อง'
        : error.message === 'Email not confirmed'
          ? 'กรุณายืนยัน Email ก่อนเข้าสู่ระบบ'
          : `เข้าสู่ระบบไม่สำเร็จ: ${error.message}`;
      $('loginStatus').classList.add('login-status-ready');
    }).catch(() => {
      submitButton.disabled = false;
      endLoadingOperation(loadingToken);
      $('loginStatus').textContent = 'เชื่อมต่อ Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      $('loginStatus').classList.add('login-status-ready');
    });
  });
  $('signupForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!supabaseClient) {
      $('loginStatus').textContent = 'โหลด Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      $('loginStatus').classList.add('login-status-ready');
      return;
    }
    const email = $('signupEmail').value.trim();
    const password = $('signupPassword').value;
    const confirmPassword = $('signupConfirmPassword').value;
    if (password !== confirmPassword) {
      $('loginStatus').textContent = 'Password และยืนยัน Password ไม่ตรงกัน';
      $('loginStatus').classList.add('login-status-ready');
      $('signupConfirmPassword').focus();
      return;
    }
    const submitButton = $('signupForm').querySelector('button[type="submit"]');
    submitButton.disabled = true;
    $('loginStatus').textContent = 'กำลังสร้างบัญชี…';
    $('loginStatus').classList.remove('login-status-ready');
    const loadingToken = beginLoadingOperation();
    supabaseClient.auth.signUp({ email, password }).then(({ data, error }) => {
      if (error) {
        $('loginStatus').textContent = error.message === 'User already registered'
          ? 'Email นี้มีบัญชีอยู่แล้ว ลองเข้าสู่ระบบ'
          : `สมัครสมาชิกไม่สำเร็จ: ${error.message}`;
        $('loginStatus').classList.add('login-status-ready');
        return;
      }
      if (data?.session) {
        $('loginStatus').textContent = 'สมัครสำเร็จ กำลังเข้าสู่ระบบ…';
      } else {
        $('loginStatus').textContent = 'สมัครบัญชีแล้ว กรุณาตรวจสอบ Email เพื่อยืนยันก่อนเข้าสู่ระบบ';
        $('loginStatus').classList.add('login-status-ready');
      }
    }).catch(() => {
      $('loginStatus').textContent = 'เชื่อมต่อ Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      $('loginStatus').classList.add('login-status-ready');
    }).finally(() => {
      submitButton.disabled = false;
      endLoadingOperation(loadingToken);
    });
  });
  $('signOutButton').addEventListener('click', () => {
    if (supabaseClient) {
      const loadingToken = beginLoadingOperation();
      supabaseClient.auth.signOut().then(({ error }) => {
        if (error) toast(`ออกจากระบบไม่สำเร็จ: ${error.message}`);
      }).finally(() => endLoadingOperation(loadingToken));
    }
  });
  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((_event, session) => { void handleAuthSession(session); });
    supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) {
        if (startupLoadingToken) { endLoadingOperation(startupLoadingToken); startupLoadingToken = null; }
        $('loginBackdrop').hidden = false;
        setAuthMode('login');
        $('loginStatus').textContent = `ตรวจสอบ session ไม่สำเร็จ: ${error.message}`;
        $('loginStatus').classList.add('login-status-ready');
        return;
      }
      void handleAuthSession(data.session);
    }).catch(() => {
      if (startupLoadingToken) { endLoadingOperation(startupLoadingToken); startupLoadingToken = null; }
      $('loginBackdrop').hidden = false;
      setAuthMode('login');
      $('loginStatus').textContent = 'เชื่อมต่อ Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      $('loginStatus').classList.add('login-status-ready');
    });
  } else {
    if (startupLoadingToken) { endLoadingOperation(startupLoadingToken); startupLoadingToken = null; }
    $('loginBackdrop').hidden = false;
    setAuthMode('login');
    $('loginStatus').textContent = 'โหลด Supabase ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
    $('loginStatus').classList.add('login-status-ready');
  }
  function viewFromHash() {
    const view = location.hash.replace(/^#/, '');
    return view || 'overview';
  }
  function switchView(view, { updateHash = true } = {}) {
    const wasTradesView = !$('tradesView').hidden;
    if (view === 'accounts' && !isAdminUser) view = 'overview';
    if (!workspaces.length && view !== 'projects') view = 'projects';
    const views = { overview: 'overviewView', projects: 'projectsView', trades: 'tradesView', setups: 'setupsView', accounts: 'accountsView' };
    const labels = { overview: 'ภาพรวม', projects: 'โปรเจกต์', trades: 'รายการเทรด', setups: 'ตั้งค่า', accounts: 'Account' };
    if (!views[view]) view = 'overview';
    Object.entries(views).forEach(([key, id]) => { $(id).hidden = key !== view; });
    document.querySelectorAll('.nav-item[data-view]').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
    $('viewCrumb').textContent = labels[view];
    if (updateHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
    updateDeleteSelectedButton();
    if (view === 'projects') renderProjectsView();
    if (view === 'setups') renderSetupManager();
    if (view === 'accounts') void loadAccountUsers(accountUsersPage);
    if (view === 'trades' && !wasTradesView && !demoMode) void refreshActiveTrades(activeWorkspaceId);
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
