(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = (value, digits = 2) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const dateLabel = (value) => {
    if (!value) return '—';
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }).format(new Date(year, month - 1, day));
  };
  const price = (value) => value == null || value === '' ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 5 });
  const safeHttpsUrl = (value) => {
    try { const parsed = new URL(String(value || '')); return parsed.protocol === 'https:' ? parsed.href : ''; }
    catch { return ''; }
  };
  const token = window.location.hash.replace(/^#/, '');
  const FUTURES = { GC: 100, MGC: 10, NQ: 20, MNQ: 2 };
  let trades = [];
  let chartMode = 'pnl';
  let activeView = 'overview';
  let periodLabel = 'ทุกช่วงเวลา';
  let shareBatchSources = [];
  let shareBatchSequence = null;

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
    const multiplier = FUTURES[trade.instrument] || Number(trade.cfd_multiplier) || 0;
    const direction = trade.direction === 'Short' ? -1 : 1;
    const quantity = Number(trade.quantity) || 0;
    const gross = (Number(trade.exit) - Number(trade.entry)) * direction * multiplier * quantity;
    const net = gross - Number(trade.fees || 0);
    const risk = trade.stop == null || trade.stop === '' ? 0 : Math.abs(Number(trade.entry) - Number(trade.stop)) * multiplier * quantity;
    return { gross, net, risk, r: risk > 0 ? net / risk : null, result: net > 0 ? 'WIN' : net < 0 ? 'LOSS' : 'BE' };
  }
  function dateTime(trade) { return `${trade.trade_date || ''}${trade.trade_time || ''}`; }
  function getOverviewResults() {
    const period = $('sharePeriodFilter').value;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'month') start.setDate(1);
    if (period === 'week') start.setDate(start.getDate() - 6);
    return trades.filter((trade) => {
      if (trade.missed_entry) return false;
      if (period === 'all') return true;
      const d = new Date(`${trade.trade_date}T00:00:00`);
      return !Number.isNaN(d.getTime()) && d >= start;
    }).map((trade) => ({ trade, ...compute(trade) })).sort((a, b) => dateTime(a.trade).localeCompare(dateTime(b.trade)));
  }
  function pfFor(items) {
    const wins = items.reduce((sum, item) => sum + Math.max(item.net, 0), 0);
    const losses = items.reduce((sum, item) => sum + Math.abs(Math.min(item.net, 0)), 0);
    return losses ? wins / losses : wins ? Infinity : 0;
  }
  function renderStats(results) {
    const total = results.reduce((sum, item) => sum + item.net, 0);
    const wins = results.filter((item) => item.net > 0).length;
    const losses = results.filter((item) => item.net < 0).length;
    let streak = 0, maxStreak = 0, pnlEquity = 0, pnlPeak = 0, maxDrawdown = 0, rEquity = 0, rPeak = 0, maxDrawdownR = 0;
    results.forEach((item) => {
      streak = item.net < 0 ? streak + 1 : 0;
      maxStreak = Math.max(maxStreak, streak);
      pnlEquity += item.net;
      pnlPeak = Math.max(pnlPeak, pnlEquity);
      maxDrawdown = Math.max(maxDrawdown, pnlPeak - pnlEquity);
      if (item.r != null) { rEquity += item.r; rPeak = Math.max(rPeak, rEquity); maxDrawdownR = Math.max(maxDrawdownR, rPeak - rEquity); }
    });
    const rated = results.filter((item) => item.r != null);
    const totalR = rated.reduce((sum, item) => sum + item.r, 0);
    const avgR = rated.length ? totalR / rated.length : 0;
    const maxRRValues = results.map(({ trade }) => trade.max_rr).filter((value) => value != null && value !== '').map(Number).filter((value) => Number.isFinite(value) && value >= 0);
    const pf = pfFor(results);
    const pfText = Number.isFinite(pf) ? pf.toFixed(2) : (results.some((item) => item.net > 0) ? '∞' : '0.00');
    const stats = [
      ['กำไร / ขาดทุนสุทธิ', money(total), total > 0 ? 'positive' : total < 0 ? 'negative' : ''],
      ['อัตราชนะ', `${results.length ? (wins / results.length * 100).toFixed(1) : '0.0'}%`, ''],
      ['Profit Factor', pfText, ''],
      ['จำนวนเทรด', String(results.length), ''],
      ['แพ้ติดกันสูงสุด', `${maxStreak} ไม้`, ''],
      ['R สะสม', `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R`, totalR > 0 ? 'positive' : totalR < 0 ? 'negative' : ''],
      ['Max Drawdown', results.length ? (maxDrawdown ? `-${money(maxDrawdown)}` : money(0)) : '—', maxDrawdown ? 'negative' : ''],
      ['Expectancy (R)', rated.length ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R` : '—', avgR > 0 ? 'positive' : avgR < 0 ? 'negative' : ''],
      ['Max RR', maxRRValues.length ? `+${Math.max(...maxRRValues).toFixed(2)}R` : '—', maxRRValues.length ? 'positive' : '']
    ];
    $('shareStats').innerHTML = stats.map(([label, value, tone]) => `<article class="share-stat-card"><span>${label}</span><strong class="${tone}">${value}</strong>${label === 'Max Drawdown' ? `<small class="share-stat-detail">Peak-to-trough · ${maxDrawdownR > 0 ? '-' : ''}${maxDrawdownR.toFixed(2)}R</small>` : ''}</article>`).join('');
    $('shareChartTotal').textContent = chartMode === 'r' ? `${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R` : money(total);
    $('shareChartTotal').className = (chartMode === 'r' ? totalR : total) > 0 ? 'positive' : (chartMode === 'r' ? totalR : total) < 0 ? 'negative' : '';
    $('shareChartDelta').textContent = results.length ? `${results.length} รายการปิด · ${wins} รายการกำไร` : 'ยังไม่มีรายการเทรด';
    $('shareChartPeriod').textContent = periodLabel;
    $('shareChartEnd').textContent = results.length ? dateLabel(results[results.length - 1].trade.trade_date) : 'ปัจจุบัน';
    $('shareChart').setAttribute('aria-label', chartMode === 'r' ? 'กราฟ R สะสม' : 'กราฟกำไรขาดทุนสะสม');
    renderChart(results);
    renderMarkets(results);
    renderPerformanceBreakdown(results, 'setup', 'shareSetupPerformance');
    renderPerformanceBreakdown(results, 'session', 'shareSessionPerformance');
  }
  function renderChart(results) {
    const host = $('shareChart');
    if (!results.length) { host.innerHTML = `<div class="share-chart-empty">ยังไม่มีรายการเทรดในช่วงนี้</div>`; return; }
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
    const baseline = y(0), area = `${line} L${coords.at(-1)[0].toFixed(1)},${baseline.toFixed(1)} L${coords[0][0].toFixed(1)},${baseline.toFixed(1)} Z`;
    const stroke = points.at(-1) >= 0 ? '#df515a' : '#ef7379';
    const formatAxis = (value) => chartMode === 'r' ? `${value > 0 ? '+' : ''}${value.toFixed(1)}R` : `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(0)}`;
    const labels = [max, 0, min].filter((value, index, array) => array.indexOf(value) === index).map((value) => `<text x="2" y="${Math.max(9, Math.min(height - 4, y(value) - 3)).toFixed(1)}" fill="#65656b" font-size="8" font-family="DM Mono">${formatAxis(value)}</text>`).join('');
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="shareEquityFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${stroke}" stop-opacity=".22"/><stop offset="100%" stop-color="${stroke}" stop-opacity="0"/></linearGradient></defs><path d="M0 ${baseline.toFixed(1)} H${width}" stroke="#343437" stroke-dasharray="3 5" fill="none"/><path d="${area}" fill="url(#shareEquityFill)"/><path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${coords.map((point, i) => `<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="${i === coords.length - 1 ? 3.2 : 1.8}" fill="${stroke}" stroke="#171718" stroke-width="1.5"/>`).join('')}${labels}</svg>`;
  }
  function renderMarkets(results) {
    const futures = results.filter((item) => item.trade.instrument !== 'XAUUSD');
    const cfd = results.filter((item) => item.trade.instrument === 'XAUUSD');
    const groups = [
      { name: 'Futures', detail: `${futures.length} รายการ · GC, MGC, NQ, MNQ`, items: futures, icon: 'F' },
      { name: 'CFD', detail: `${cfd.length} รายการ · XAUUSD`, items: cfd, icon: 'C' }
    ];
    const totalAbs = groups.reduce((sum, group) => sum + group.items.reduce((n, item) => n + Math.abs(item.net), 0), 0);
    $('shareMarkets').innerHTML = groups.map((group) => {
      const net = group.items.reduce((sum, item) => sum + item.net, 0);
      const weight = totalAbs ? group.items.reduce((n, item) => n + Math.abs(item.net), 0) / totalAbs * 100 : 0;
      return `<div class="market-row"><div class="market-icon">${group.icon}</div><div><div class="market-name">${group.name}</div><div class="market-detail">${group.detail}</div><div class="market-track"><i style="width:${weight}%"></i></div></div><div class="market-value ${net > 0 ? 'positive-text' : net < 0 ? 'negative-text' : 'muted-text'}">${money(net)}</div></div>`;
    }).join('');
    $('shareInstrumentCount').textContent = String(new Set(results.map((item) => item.trade.instrument).filter(Boolean)).size);
  }
  function renderPerformanceBreakdown(results, field, hostId) {
    const groups = new Map();
    results.forEach((item) => { const label = String(item.trade[field] || '').trim() || 'ไม่ระบุ'; if (!groups.has(label)) groups.set(label, []); groups.get(label).push(item); });
    const rows = [...groups].map(([label, items]) => {
      const net = items.reduce((sum, item) => sum + item.net, 0), wins = items.filter((item) => item.net > 0).length;
      return { label, count: items.length, net, wins, rate: items.length ? wins / items.length * 100 : 0, pf: pfFor(items) };
    }).sort((a, b) => (b.count > 0) - (a.count > 0) || (b.count >= 3) - (a.count >= 3) || (a.count >= 3 && b.count >= 3 && b.pf !== a.pf ? b.pf - a.pf : b.net - a.net));
    const host = $(hostId);
    if (!rows.length) { host.innerHTML = '<div class="insight-empty">ยังไม่มีข้อมูลในช่วงนี้</div>'; return; }
    const reliable = rows.some((row) => row.count >= 3);
    host.innerHTML = rows.map((row, index) => {
      const leader = reliable && index === 0 && row.count >= 3;
      const sample = row.count < 3 ? `ข้อมูลยังน้อย · ${row.count} เทรด` : `${row.count} เทรด`;
      const pf = Number.isFinite(row.pf) ? row.pf.toFixed(2) : row.net > 0 ? '∞' : '0.00';
      return `<div class="insight-row${leader ? ' insight-leader' : ''}"><div class="insight-main"><span class="insight-rank">${leader ? '★' : String(index + 1).padStart(2, '0')}</span><div class="insight-label-wrap"><strong class="insight-name">${escapeHtml(row.label)}</strong><small>${sample} · ชนะ ${row.wins}/${row.count} (${row.rate.toFixed(0)}%)</small></div>${leader ? '<span class="best-tag">ดีที่สุด*</span>' : ''}</div><div class="insight-values"><span class="insight-pf">PF <strong>${pf}</strong></span><strong class="${row.net > 0 ? 'positive-text' : row.net < 0 ? 'negative-text' : 'muted-text'}">${money(row.net)}</strong></div></div>`;
    }).join('') + `<div class="insight-note">${reliable ? '* อันดับจากกลุ่มที่มีอย่างน้อย 3 เทรด · ยังไม่ใช่ข้อสรุประยะยาว' : 'ยังไม่มีรายการที่มีข้อมูลครบ 3 เทรด — ดูตัวเลขเป็นข้อมูลเบื้องต้น'}</div>`;
  }
  function getVisibleTrades() {
    const instrument = $('shareInstrumentFilter').value;
    const recordType = $('shareRecordTypeFilter').value;
    const query = $('shareSearch').value.trim().toLowerCase();
    return [...trades].filter((trade) => {
      const matchesInstrument = instrument === 'all' || trade.instrument === instrument;
      const matchesType = recordType === 'all' || (recordType === 'missed' ? trade.missed_entry : !trade.missed_entry);
      const haystack = [trade.missed_entry ? 'miss entry missed entry' : 'trade เทรดจริง', trade.instrument, trade.setup, trade.poi, trade.notes, trade.session, trade.direction, trade.chart_url_htf, trade.chart_url_ltf].join(' ').toLowerCase();
      return matchesInstrument && matchesType && haystack.includes(query);
    }).sort((a, b) => dateTime(b).localeCompare(dateTime(a)));
  }
  function closeShareBatchModal() {
    $('shareBatchModal').classList.remove('open');
    $('shareBatchModal').setAttribute('aria-hidden', 'true');
    shareBatchSequence = null;
    $('shareBatchType').disabled = false;
    $('shareBatchStart').disabled = false;
    $('shareBatchCount').disabled = false;
    $('openAllShareBatch').disabled = false;
    $('openAllShareBatch').textContent = '↗ เปิดทั้งหมด';
    $('stepShareBatch').disabled = false;
    $('stepShareBatch').textContent = 'เปิดทีละแท็บ';
  }
  function getShareBatchSources() {
    const type = $('shareBatchType').value;
    return getVisibleTrades().flatMap((trade, rowIndex) => [
      ['HTF', safeHttpsUrl(trade.chart_url_htf)],
      ['LTF', safeHttpsUrl(trade.chart_url_ltf)]
    ].filter(([label, url]) => url && (type === 'both' || label === type)).map(([label, url]) => ({ label, url, rowNumber: rowIndex + 1, date: trade.trade_date, instrument: trade.instrument })));
  }
  function refreshShareBatchSources() {
    shareBatchSequence = null;
    $('openAllShareBatch').textContent = '↗ เปิดทั้งหมด';
    $('stepShareBatch').textContent = 'เปิดทีละแท็บ';
    $('stepShareBatch').disabled = false;
    shareBatchSources = getShareBatchSources();
    if (!shareBatchSources.length) {
      $('shareBatchStart').innerHTML = '<option value="">ไม่พบกราฟประเภทนี้</option>';
      $('shareBatchCount').value = '1';
      $('shareBatchCount').max = '1';
      $('shareBatchStatus').textContent = 'ไม่มีลิงก์กราฟประเภทนี้ในรายการที่กรองอยู่';
      $('openAllShareBatch').disabled = true;
      $('stepShareBatch').disabled = true;
      return;
    }
    $('openAllShareBatch').disabled = false;
    $('shareBatchStart').innerHTML = shareBatchSources.map((source, index) => `<option value="${index + 1}">${index + 1}. รายการ ${source.rowNumber} · ${dateLabel(source.date)} · ${escapeHtml(source.instrument)} · ${source.label}</option>`).join('');
    $('shareBatchStart').value = '1';
    $('shareBatchCount').value = String(Math.min(Number($('shareBatchCount').value) || 5, shareBatchSources.length));
    updateShareBatchRange();
  }
  function updateShareBatchRange() {
    const start = Math.max(0, Number($('shareBatchStart').value) - 1);
    const available = Math.max(0, shareBatchSources.length - start);
    $('shareBatchCount').max = String(available);
    $('shareBatchCount').value = String(Math.max(1, Math.min(Number($('shareBatchCount').value) || 1, available)));
    $('shareBatchStatus').textContent = `มี ${shareBatchSources.length} กราฟตามประเภทที่เลือก · เริ่มตำแหน่งนี้เปิดต่อได้ ${available} กราฟ`;
  }
  function openShareBatchModal() {
    refreshShareBatchSources();
    const anyLinks = getVisibleTrades().some((trade) => safeHttpsUrl(trade.chart_url_htf) || safeHttpsUrl(trade.chart_url_ltf));
    if (!anyLinks) $('shareBatchStatus').textContent = 'ไม่พบลิงก์ HTF/LTF ในรายการที่กรองอยู่';
    $('shareBatchModal').classList.add('open');
    $('shareBatchModal').setAttribute('aria-hidden', 'false');
    $('shareBatchType').focus();
  }
  function openNextShareChart() {
    if (!shareBatchSequence) {
      const start = Math.max(0, Number($('shareBatchStart').value) - 1);
      const count = Math.max(1, Number($('shareBatchCount').value) || 1);
      shareBatchSequence = { nextIndex: start, startIndex: start, endIndex: Math.min(shareBatchSources.length, start + count) };
    }
    const source = shareBatchSources[shareBatchSequence.nextIndex];
    if (!source) { closeShareBatchModal(); return; }
    const tab = window.open(source.url, '_blank');
    if (!tab) { $('shareBatchStatus').textContent = 'Chrome บล็อกแท็บนี้ อนุญาต Pop-ups แล้วลองอีกครั้ง'; return; }
    tab.opener = null;
    $('shareBatchType').disabled = true;
    $('shareBatchStart').disabled = true;
    $('shareBatchCount').disabled = true;
    $('openAllShareBatch').disabled = true;
    shareBatchSequence.nextIndex += 1;
    const opened = shareBatchSequence.nextIndex - shareBatchSequence.startIndex;
    const total = shareBatchSequence.endIndex - shareBatchSequence.startIndex;
    if (shareBatchSequence.nextIndex >= shareBatchSequence.endIndex) {
      closeShareBatchModal();
      return;
    }
    const next = shareBatchSources[shareBatchSequence.nextIndex];
    $('shareBatchStatus').textContent = `เปิดแล้ว ${opened}/${total} · กราฟถัดไป: รายการ ${next.rowNumber} · ${next.label}`;
    $('stepShareBatch').textContent = `เปิดกราฟถัดไป (${opened + 1}/${total})`;
  }
  function openAllShareCharts() {
    const start = Math.max(0, Number($('shareBatchStart').value) - 1);
    const count = Math.max(1, Number($('shareBatchCount').value) || 1);
    const selected = shareBatchSources.slice(start, start + count);
    const blocked = [];
    let opened = 0;
    selected.forEach((source) => {
      const tab = window.open(source.url, '_blank');
      if (!tab) { blocked.push(source); return; }
      tab.opener = null;
      opened += 1;
    });
    if (!blocked.length) { closeShareBatchModal(); return; }
    shareBatchSources = blocked;
    shareBatchSequence = { nextIndex: 0, startIndex: 0, endIndex: blocked.length };
    $('shareBatchType').disabled = true;
    $('shareBatchStart').disabled = true;
    $('shareBatchCount').disabled = true;
    $('openAllShareBatch').disabled = true;
    $('stepShareBatch').textContent = `เปิดที่เหลือทีละแท็บ (1/${blocked.length})`;
    $('shareBatchStatus').textContent = `เปิดได้ ${opened}/${selected.length} แท็บ · Chrome บล็อกอีก ${blocked.length} แท็บ ใช้ปุ่มเปิดทีละแท็บ หรืออนุญาต Pop-ups แล้วลองใหม่`;
  }
  function renderTradeRows() {
    const rows = getVisibleTrades();
    $('shareTradesCount').textContent = `${rows.length} จาก ${trades.length} รายการ${trades.filter((trade) => trade.missed_entry).length ? ` · Miss Entry ${trades.filter((trade) => trade.missed_entry).length}` : ''}`;
    $('shareTableSummary').textContent = `แสดง ${rows.length} รายการ · อ่านอย่างเดียว`;
    $('shareTradeRows').innerHTML = rows.length ? rows.map((trade, index) => {
      const htf = safeHttpsUrl(trade.chart_url_htf), ltf = safeHttpsUrl(trade.chart_url_ltf);
      const htfCell = htf ? `<a class="share-chart-link" href="${escapeHtml(htf)}" target="_blank" rel="noopener noreferrer">เปิด HTF ↗</a>` : '—';
      const ltfCell = ltf ? `<a class="share-chart-link" href="${escapeHtml(ltf)}" target="_blank" rel="noopener noreferrer">เปิด LTF ↗</a>` : '—';
      const sessionLabel = trade.session ? escapeHtml(trade.session) : 'ไม่ระบุ';
      const noteText = String(trade.notes || '').trim();
      const noteCell = `<td class="share-note-cell" title="${escapeHtml(noteText)}">${escapeHtml(noteText || '—')}</td>`;
      const common = `<td class="share-row-number">${index + 1}</td><td>${dateLabel(trade.trade_date)}<small>${escapeHtml(trade.trade_time || '—')}</small></td><td><span class="share-session-chip${trade.session ? '' : ' is-empty'}">${sessionLabel}</span></td><td><span class="share-instrument-dot"></span>${escapeHtml(trade.instrument || '—')}</td>`;
      if (trade.missed_entry) return `<tr>${common}<td>—</td><td>—</td><td>—</td><td>${escapeHtml(trade.setup || '—')}</td><td>${escapeHtml(trade.poi || '—')}</td>${noteCell}<td>—</td><td>—</td><td><span class="share-outcome">พลาดจังหวะ</span></td><td>—</td><td>—</td><td>—</td></tr>`;
      const result = compute(trade);
      const quantity = trade.quantity == null ? '—' : Number(trade.quantity).toLocaleString('en-US', { maximumFractionDigits: 2 });
      const unit = trade.instrument === 'XAUUSD' ? 'lot' : 'สัญญา';
      const side = trade.direction === 'Short' ? 'SHORT' : 'LONG';
      const maxRR = trade.max_rr == null || trade.max_rr === '' ? '—' : `${Number(trade.max_rr) >= 0 ? '+' : ''}${Number(trade.max_rr).toFixed(2)}R`;
      return `<tr>${common}<td><span class="share-direction ${side.toLowerCase()}">${side}</span></td><td>${quantity} ${unit}</td><td><span class="share-entry-exit">${price(trade.entry)} / ${price(trade.exit)}</span><small class="share-stops">SL ${price(trade.stop)} · TP ${price(trade.target)}</small></td><td>${escapeHtml(trade.setup || '—')}</td><td>${escapeHtml(trade.poi || '—')}</td>${noteCell}<td>${htfCell}</td><td>${ltfCell}</td><td><span class="share-outcome ${result.result.toLowerCase()}">${result.result}</span></td><td>${result.r == null ? '—' : `${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}R`}</td><td class="share-max-rr">${maxRR}</td><td class="${result.net >= 0 ? 'positive' : 'negative'}">${money(result.net)}</td></tr>`;
    }).join('') : '<tr><td colspan="16" class="share-table-empty">ไม่พบรายการเทรด</td></tr>';
  }
  function render(data) {
    $('shareWorkspaceName').textContent = data.workspace.name || 'Trading Journal';
    trades = Array.isArray(data.trades) ? data.trades : [];
    const instruments = [...new Set(trades.map((trade) => trade.instrument).filter(Boolean))].sort();
    $('shareInstrumentFilter').innerHTML = '<option value="all">ทุกสินทรัพย์</option>' + instruments.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    $('shareStatus').hidden = true;
    renderOverview();
    renderTradeRows();
  }
  function renderOverview() {
    periodLabel = $('sharePeriodFilter').selectedOptions[0].textContent;
    renderStats(getOverviewResults());
  }
  document.querySelectorAll('[data-share-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.shareView)));
  $('sharePeriodFilter').addEventListener('change', renderOverview);
  $('shareChartMode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-share-chart]');
    if (!button) return;
    chartMode = button.dataset.shareChart;
    $('shareChartMode').querySelectorAll('[data-share-chart]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderOverview();
  });
  ['shareSearch', 'shareInstrumentFilter', 'shareRecordTypeFilter'].forEach((id) => $(id).addEventListener(id === 'shareSearch' ? 'input' : 'change', renderTradeRows));
  $('openShareBatchCharts').addEventListener('click', openShareBatchModal);
  $('closeShareBatch').addEventListener('click', closeShareBatchModal);
  $('cancelShareBatch').addEventListener('click', closeShareBatchModal);
  $('shareBatchModal').addEventListener('click', (event) => { if (event.target === $('shareBatchModal')) closeShareBatchModal(); });
  $('shareBatchType').addEventListener('change', refreshShareBatchSources);
  $('shareBatchStart').addEventListener('change', updateShareBatchRange);
  $('shareBatchCount').addEventListener('input', () => {
    const available = shareBatchSources.length - Number($('shareBatchStart').value) + 1;
    $('shareBatchCount').value = String(Math.max(1, Math.min(Number($('shareBatchCount').value) || 1, available)));
  });
  $('openAllShareBatch').addEventListener('click', openAllShareCharts);
  $('stepShareBatch').addEventListener('click', openNextShareChart);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('shareBatchModal').classList.contains('open')) closeShareBatchModal();
  });
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
