(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = (value) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dateLabel = (value) => {
    if (!value) return '—';
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }).format(new Date(year, month - 1, day));
  };
  const price = (value) => value == null || value === '' ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 5 });
  const safeHttpsUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''));
      return parsed.protocol === 'https:' ? parsed.href : '';
    } catch { return ''; }
  };
  const token = window.location.hash.replace(/^#/, '');
  let activeView = 'overview';
  function setView(view) {
    activeView = view === 'trades' ? 'trades' : 'overview';
    $('shareOverview').hidden = activeView !== 'overview';
    $('shareTrades').hidden = activeView !== 'trades';
    document.querySelectorAll('[data-share-view]').forEach((button) => {
      const active = button.dataset.shareView === activeView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  function compute(trade) {
    const multiplier = ({ GC: 100, MGC: 10, NQ: 20, MNQ: 2 })[trade.instrument] || Number(trade.cfd_multiplier) || 0;
    const direction = trade.direction === 'Short' ? -1 : 1;
    const quantity = Number(trade.quantity) || 0;
    const gross = (Number(trade.exit) - Number(trade.entry)) * direction * multiplier * quantity;
    const net = gross - Number(trade.fees || 0);
    const risk = Math.abs(Number(trade.entry) - Number(trade.stop)) * multiplier * quantity;
    return { net, r: risk > 0 ? net / risk : null, result: net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'BE' };
  }
  function render(data) {
    const workspace = data.workspace;
    const trades = Array.isArray(data.trades) ? data.trades : [];
    const executed = trades.filter((trade) => !trade.missed_entry);
    const calculated = executed.map((trade) => ({ trade, ...compute(trade) }));
    const net = calculated.reduce((sum, item) => sum + item.net, 0);
    const grossWins = calculated.filter((item) => item.net > 0).reduce((sum, item) => sum + item.net, 0);
    const grossLosses = Math.abs(calculated.filter((item) => item.net < 0).reduce((sum, item) => sum + item.net, 0));
    const wins = calculated.filter((item) => item.net > 0).length;
    const rated = calculated.filter((item) => item.r != null);
    const totalR = rated.reduce((sum, item) => sum + item.r, 0);
    const avgR = rated.length ? totalR / rated.length : 0;
    let streak = 0, maxStreak = 0, equity = 0, peak = 0, maxDrawdown = 0;
    const chronological = [...calculated].sort((a, b) => `${a.trade.trade_date}${a.trade.trade_time || ''}`.localeCompare(`${b.trade.trade_date}${b.trade.trade_time || ''}`));
    chronological.forEach((item) => {
      streak = item.net < 0 ? streak + 1 : 0;
      maxStreak = Math.max(maxStreak, streak);
      equity += item.net;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    });
    const pf = grossLosses ? grossWins / grossLosses : grossWins ? Infinity : 0;
    $('shareWorkspaceName').textContent = workspace.name || 'Trading Journal';
    $('shareStatus').hidden = true;
    $('shareStats').innerHTML = [
      ['กำไร / ขาดทุนสุทธิ', money(net), net >= 0 ? 'positive' : 'negative'],
      ['อัตราชนะ', `${calculated.length ? (wins / calculated.length * 100).toFixed(1) : '0.0'}%`, ''],
      ['Profit Factor', Number.isFinite(pf) ? pf.toFixed(2) : (grossWins ? '∞' : '0.00'), ''],
      ['จำนวนเทรด', `${calculated.length}`, ''],
      ['แพ้ติดกันสูงสุด', `${maxStreak} ไม้`, ''],
      ['R สะสม', `${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`, totalR >= 0 ? 'positive' : 'negative'],
      ['Max Drawdown', money(maxDrawdown), 'negative'],
      ['Expectancy (R)', `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`, avgR >= 0 ? 'positive' : 'negative'],
    ].map(([label, value, tone]) => `<article class="share-stat-card"><span>${label}</span><strong class="${tone}">${value}</strong></article>`).join('');
    $('shareChartTotal').textContent = money(net);
    const points = chronological.reduce((arr, item) => [...arr, (arr.at(-1) || 0) + item.net], []);
    if (!points.length) {
      $('shareChart').innerHTML = '<div class="share-chart-empty">ยังไม่มีรายการเทรด</div>';
    } else {
      const min = Math.min(0, ...points), max = Math.max(0, ...points), range = max - min || 1;
      const coords = points.map((point, i) => `${points.length === 1 ? 50 : i / (points.length - 1) * 100},${92 - (point - min) / range * 82}`).join(' ');
      $('shareChart').innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="กราฟผลกำไรขาดทุนสะสม"><line x1="0" y1="${92 - (0 - min) / range * 82}" x2="100" y2="${92 - (0 - min) / range * 82}" class="share-chart-zero"/><polyline points="${coords}" class="share-chart-line"/></svg>`;
    }
    const groups = new Map();
    calculated.forEach((item) => {
      const key = item.trade.instrument || 'อื่น ๆ';
      const group = groups.get(key) || { count: 0, net: 0 };
      group.count += 1; group.net += item.net; groups.set(key, group);
    });
    $('shareInstruments').innerHTML = groups.size ? [...groups.entries()].map(([name, group]) => `<div class="share-instrument-row"><strong>${escapeHtml(name)}</strong><span>${group.count} เทรด</span><b class="${group.net >= 0 ? 'positive' : 'negative'}">${money(group.net)}</b></div>`).join('') : '<div class="share-chart-empty">ยังไม่มีรายการเทรด</div>';
    $('shareTradesCount').textContent = `${trades.length} รายการ${trades.filter((trade) => trade.missed_entry).length ? ` · Miss Entry ${trades.filter((trade) => trade.missed_entry).length}` : ''}`;
    $('shareTradeRows').innerHTML = trades.length ? trades.map((trade) => {
      const htf = safeHttpsUrl(trade.chart_url_htf);
      const ltf = safeHttpsUrl(trade.chart_url_ltf);
      const chartCell = [
        htf ? `<a class="share-chart-link" href="${escapeHtml(htf)}" target="_blank" rel="noopener noreferrer">HTF ↗</a>` : '',
        ltf ? `<a class="share-chart-link" href="${escapeHtml(ltf)}" target="_blank" rel="noopener noreferrer">LTF ↗</a>` : ''
      ].filter(Boolean).join(' ') || '—';
      if (trade.missed_entry) return `<tr><td>${dateLabel(trade.trade_date)}<small>${escapeHtml(trade.trade_time || '—')}</small></td><td><span class="share-session-chip">${escapeHtml(trade.session || '—')}</span></td><td><span class="share-instrument-dot"></span>${escapeHtml(trade.instrument || '—')}</td><td>—</td><td>—</td><td>—</td><td>${escapeHtml(trade.setup || '—')}</td><td>${escapeHtml(trade.poi || '—')}</td><td>${chartCell}</td><td><span class="share-outcome">พลาดจังหวะ</span></td><td>—</td><td>—</td></tr>`;
      const result = compute(trade);
      const quantity = trade.quantity == null ? '—' : Number(trade.quantity).toLocaleString('en-US', { maximumFractionDigits: 2 });
      const unit = trade.instrument === 'XAUUSD' ? 'lot' : 'สัญญา';
      const side = trade.direction === 'Short' ? 'SHORT' : 'LONG';
      return `<tr><td>${dateLabel(trade.trade_date)}<small>${escapeHtml(trade.trade_time || '—')}</small></td><td><span class="share-session-chip">${escapeHtml(trade.session || '—')}</span></td><td><span class="share-instrument-dot"></span>${escapeHtml(trade.instrument || '—')}</td><td><span class="share-direction ${side.toLowerCase()}">${side}</span></td><td>${quantity} ${unit}</td><td><span class="share-entry-exit">${price(trade.entry)} / ${price(trade.exit)}</span><small class="share-stops">SL ${price(trade.stop)} · TP ${price(trade.target)}</small></td><td>${escapeHtml(trade.setup || '—')}</td><td>${escapeHtml(trade.poi || '—')}</td><td>${chartCell}</td><td><span class="share-outcome ${result.result.toLowerCase()}">${result.result}</span></td><td>${result.r == null ? '—' : `${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}R`}</td><td class="${result.net >= 0 ? 'positive' : 'negative'}">${money(result.net)}</td></tr>`;
    }).join('') : '<tr><td colspan="12" class="share-table-empty">ยังไม่มีรายการเทรด</td></tr>';
  }
  document.querySelectorAll('[data-share-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.shareView)));
  setView('overview');
  const config = window.REDLINE_SUPABASE_CONFIG;
  if (!token || !config || !window.supabase?.createClient) {
    $('shareStatus').textContent = token ? 'ตั้งค่า Supabase ไม่ครบ' : 'ลิงก์แชร์ไม่ถูกต้อง';
  } else {
    const client = window.supabase.createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    client.functions.invoke('workspace-share', { body: { action: 'read', token } }).then(({ data, error }) => {
      if (error || !data?.workspace) throw error || new Error('ไม่พบข้อมูลที่แชร์');
      render(data);
    }).catch(() => {
      $('shareStatus').textContent = 'ลิงก์นี้ใช้ไม่ได้ ถูกปิดแล้ว หรือยังไม่ได้ตั้งค่า share function';
      $('shareWorkspaceName').textContent = 'เปิดข้อมูลที่แชร์ไม่ได้';
    });
  }
})();
