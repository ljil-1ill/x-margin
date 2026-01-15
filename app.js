/* X-Margin Calculator - app.js
   - No build tools. Works on GitHub Pages.
   - Stores settings/inputs/quotes in localStorage.
*/

(function () {
  'use strict';

  const STORAGE_KEYS = {
    settings: 'xm_settings_v1',
    inputs: 'xm_inputs_v1',
    quotes: 'xm_quotes_v1'
  };

  /** Defaults are intentionally conservative; 감독님이 필요에 맞게 바꾸고 저장하면 됩니다. */
  const DEFAULTS = {
    fxKrw: 1400.0,

    cardFeeRate: 0.02,
    platformFeeRate: 0.06,

    profitMode: 'PERCENT_OF_SALE', // PERCENT_OF_SALE | MARKUP_ON_COST | FIXED_KRW
    profitPercent: 0.20,
    profitFixedKrw: 30000,

    taxThresholdUsd: 150,
    us200Toggle: false,
    dutyRate: 0.08,
    vatRate: 0.10,
    taxIncludeShipping: true,

    roundStep: 1000,        // 0 = none
    endAdjustEnabled: true,
    endAdjustAmount: 100
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  const el = {
    inProductUsd: $('inProductUsd'),
    inShippingUsd: $('inShippingUsd'),
    btnRecalc: $('btnRecalc'),
    btnResetInputs: $('btnResetInputs'),

    outSalePriceKrw: $('outSalePriceKrw'),
    outSalePriceMeta: $('outSalePriceMeta'),
    outNetProfit: $('outNetProfit'),
    outNetMargin: $('outNetMargin'),
    outTotalCost: $('outTotalCost'),
    outTotalCostUsd: $('outTotalCostUsd'),

    breakdown: $('breakdown'),
    warnBox: $('warnBox'),

    taxPill: $('taxPill'),

    // settings
    inFxKrw: $('inFxKrw'),
    btnFetchFx: $('btnFetchFx'),
    fxLiveBox: $('fxLiveBox'),

    inCardFee: $('inCardFee'),
    inPlatformFee: $('inPlatformFee'),

    selProfitMode: $('selProfitMode'),
    inProfitPercent: $('inProfitPercent'),
    inProfitFixed: $('inProfitFixed'),

    inTaxThreshold: $('inTaxThreshold'),
    chkUs200: $('chkUs200'),
    inDutyRate: $('inDutyRate'),
    inVatRate: $('inVatRate'),
    chkTaxIncludeShipping: $('chkTaxIncludeShipping'),

    selRoundStep: $('selRoundStep'),
    chkEndAdjust: $('chkEndAdjust'),
    inEndAdjustAmount: $('inEndAdjustAmount'),

    btnSaveSettings: $('btnSaveSettings'),
    btnResetSettings: $('btnResetSettings'),
    settingsStatus: $('settingsStatus'),

    // quotes
    btnSaveQuote: $('btnSaveQuote'),
    btnClearQuotes: $('btnClearQuotes'),
    quotesList: $('quotesList'),

    // header quick actions
    btnCopyPrice: $('btnCopyPrice'),

    toast: $('toast')
  };

  // ---------- State ----------
  let settings = loadSettings();
  let inputs = loadInputs();
  let quotes = loadQuotes();
  let lastCalc = null;

  // ---------- Init ----------
  hydrateForm();
  renderQuotes();
  recalcAndRender();

  wireEvents();

  // ---------- Core Calculations ----------
  function calculate({ productUsd, shippingUsd }, s) {
    const warn = [];

    // Basic validation
    if (!isFiniteNumber(productUsd) || productUsd < 0) productUsd = 0;
    if (!isFiniteNumber(shippingUsd) || shippingUsd < 0) shippingUsd = 0;

    const fx = clampNumber(s.fxKrw, 0, 1e9, 0);
    if (fx <= 0) warn.push('환율(KRW/USD)이 0입니다. 환율을 입력하세요.');

    const costUsdTotal = productUsd + shippingUsd;

    // Base cost in KRW (converted at pricing FX)
    const baseCostKrw = costUsdTotal * fx;

    // Card fee on payment amount (simplified model)
    const cardFeeKrw = baseCostKrw * clampNumber(s.cardFeeRate, 0, 0.5, 0);

    // Import tax (estimated)
    let importTaxKrw = 0;
    let dutyKrw = 0;
    let vatKrw = 0;
    let taxableBaseKrw = 0;

    const thresholdUsd = clampNumber(s.taxThresholdUsd, 0, 1e9, 150);

    const taxBasisUsd = s.taxIncludeShipping ? costUsdTotal : productUsd;
    const isTaxable = taxBasisUsd > thresholdUsd;

    if (isTaxable) {
      taxableBaseKrw = taxBasisUsd * fx;
      const dutyRate = clampNumber(s.dutyRate, 0, 1, 0);
      const vatRate = clampNumber(s.vatRate, 0, 1, 0);

      dutyKrw = taxableBaseKrw * dutyRate;
      vatKrw = (taxableBaseKrw + dutyKrw) * vatRate;
      importTaxKrw = dutyKrw + vatKrw;
    }

    const totalCostKrw = baseCostKrw + cardFeeKrw + importTaxKrw;

    // Sale price solving
    const platformFeeRate = clampNumber(s.platformFeeRate, 0, 0.5, 0);
    if (platformFeeRate >= 1) warn.push('플랫폼 수수료율이 100% 이상입니다.');

    let saleBeforeRound = 0;
    let profitTargetKrw = 0;

    if (s.profitMode === 'FIXED_KRW') {
      profitTargetKrw = clampNumber(s.profitFixedKrw, 0, 1e12, 0);
      const denom = 1 - platformFeeRate;
      if (denom <= 0) {
        warn.push('플랫폼 수수료율이 너무 커서 판매가를 계산할 수 없습니다.');
        saleBeforeRound = 0;
      } else {
        saleBeforeRound = (totalCostKrw + profitTargetKrw) / denom;
      }
    } else if (s.profitMode === 'MARKUP_ON_COST') {
      const pct = clampNumber(s.profitPercent, 0, 10, 0);
      profitTargetKrw = totalCostKrw * pct;
      const denom = 1 - platformFeeRate;
      if (denom <= 0) {
        warn.push('플랫폼 수수료율이 너무 커서 판매가를 계산할 수 없습니다.');
        saleBeforeRound = 0;
      } else {
        saleBeforeRound = totalCostKrw * (1 + pct) / denom;
      }
    } else { // PERCENT_OF_SALE
      const pct = clampNumber(s.profitPercent, 0, 0.95, 0); // keep within sensible
      // netProfit = sale * pct
      const denom = 1 - platformFeeRate - pct;
      if (denom <= 0) {
        warn.push('플랫폼 수수료 + 순수익률의 합이 100% 이상입니다. 비율을 낮추세요.');
        saleBeforeRound = 0;
      } else {
        saleBeforeRound = totalCostKrw / denom;
      }
      profitTargetKrw = saleBeforeRound * pct;
    }

    // Rounding
    const roundStep = clampNumber(parseInt(String(s.roundStep), 10), 0, 1e9, 0);
    let saleAfterRound = saleBeforeRound;

    if (roundStep > 0) {
      saleAfterRound = Math.ceil(saleAfterRound / roundStep) * roundStep;
    }

    if (s.endAdjustEnabled) {
      const adj = clampNumber(s.endAdjustAmount, 0, 1e9, 0);
      if (adj > 0) saleAfterRound = Math.max(0, saleAfterRound - adj);
    }

    // Realized profit with rounded sale
    const platformFeeKrw = saleAfterRound * platformFeeRate;
    const realizedNetProfit = saleAfterRound - platformFeeKrw - totalCostKrw;
    const realizedNetMargin = saleAfterRound > 0 ? (realizedNetProfit / saleAfterRound) : 0;

    // extra warnings
    if (saleAfterRound === 0 && costUsdTotal > 0) warn.push('판매가 계산 결과가 0입니다. 설정을 확인하세요.');
    if (saleAfterRound > 0 && realizedNetProfit < 0) warn.push('현재 설정/반올림 옵션에서 역마진이 발생합니다. 환율/수수료/끝자리 옵션을 조정하세요.');
    if (fx > 0 && costUsdTotal > 0 && saleAfterRound < totalCostKrw) warn.push('판매가가 총원가보다 낮습니다.');

    return {
      productUsd,
      shippingUsd,
      costUsdTotal,

      fx,
      baseCostKrw,
      cardFeeKrw,

      thresholdUsd,
      taxBasisUsd,
      isTaxable,
      taxableBaseKrw,
      dutyKrw,
      vatKrw,
      importTaxKrw,

      totalCostKrw,

      saleBeforeRound,
      saleAfterRound,

      platformFeeRate,
      platformFeeKrw,

      profitTargetKrw,
      realizedNetProfit,
      realizedNetMargin,

      warn
    };
  }

  // ---------- Rendering ----------
  function recalcAndRender() {
    const productUsd = parseFloatOrZero(el.inProductUsd.value);
    const shippingUsd = parseFloatOrZero(el.inShippingUsd.value);

    lastCalc = calculate({ productUsd, shippingUsd }, settings);

    // Save inputs snapshot quietly so user doesn't lose work.
    inputs = { productUsd, shippingUsd };
    saveInputs(inputs);

    // Pill
    if (lastCalc.costUsdTotal <= 0) {
      setPill('관부가세: 판단 중', 'warn');
    } else if (lastCalc.isTaxable) {
      setPill(`관부가세: 적용(>${formatUsd(lastCalc.thresholdUsd)})`, 'bad');
    } else {
      setPill(`관부가세: 면세(≤${formatUsd(lastCalc.thresholdUsd)})`, 'ok');
    }

    // Main outputs
    el.outSalePriceKrw.textContent = formatKrw(lastCalc.saleAfterRound);
    el.outTotalCost.textContent = formatKrw(lastCalc.totalCostKrw);
    el.outTotalCostUsd.textContent = `USD ${formatNumber(lastCalc.costUsdTotal, 2)} 기준`;

    el.outNetProfit.textContent = formatKrw(lastCalc.realizedNetProfit);
    el.outNetMargin.textContent = `${(lastCalc.realizedNetMargin * 100).toFixed(1)}%`;

    // Meta line
    el.outSalePriceMeta.textContent = buildMetaLine(lastCalc);

    // Breakdown
    renderBreakdown(lastCalc);

    // Warnings
    if (lastCalc.warn.length) {
      el.warnBox.hidden = false;
      el.warnBox.textContent = '주의: ' + lastCalc.warn.join(' ');
    } else {
      el.warnBox.hidden = true;
      el.warnBox.textContent = '';
    }
  }

  function buildMetaLine(c) {
    const parts = [];
    parts.push(`환율 ${formatNumber(c.fx, 1)}원/달러`);
    parts.push(`플랫폼 ${formatPct(c.platformFeeRate)}`);
    parts.push(`카드 ${formatPct(settings.cardFeeRate)}`);
    if (settings.profitMode === 'FIXED_KRW') {
      parts.push(`순수익 고정 ${formatKrw(settings.profitFixedKrw)}`);
    } else if (settings.profitMode === 'MARKUP_ON_COST') {
      parts.push(`마진율 ${formatPct(settings.profitPercent)}`);
    } else {
      parts.push(`순수익률 ${formatPct(settings.profitPercent)}`);
    }
    if (c.isTaxable) parts.push('관부가세 포함(추정)');
    if (settings.roundStep && parseInt(settings.roundStep, 10) > 0) parts.push(`올림 ${formatNumber(parseInt(settings.roundStep,10),0)}원`);
    if (settings.endAdjustEnabled) parts.push(`끝자리 -${formatNumber(settings.endAdjustAmount,0)}원`);
    return parts.join(' · ');
  }

  function renderBreakdown(c) {
    const rows = [];

    rows.push(row('① 달러 합계', `USD ${formatNumber(c.costUsdTotal, 2)}`));
    rows.push(row('② 원가 환산', formatKrw(c.baseCostKrw)));

    rows.push(row('③ 카드 수수료', `${formatKrw(c.cardFeeKrw)} (${formatPct(settings.cardFeeRate)})`));

    if (c.isTaxable) {
      rows.push(row('④ 과세 기준(환산)', formatKrw(c.taxableBaseKrw)));
      rows.push(row('⑤ 관세(추정)', `${formatKrw(c.dutyKrw)} (${formatPct(settings.dutyRate)})`));
      rows.push(row('⑥ 부가세(추정)', `${formatKrw(c.vatKrw)} (${formatPct(settings.vatRate)})`));
      rows.push(row('⑦ 관부가세 합계', formatKrw(c.importTaxKrw)));
    } else {
      rows.push(row('④ 관부가세', '0원 (면세)'));
    }

    rows.push(rowTotal('총 원가(세금/수수료 포함)', formatKrw(c.totalCostKrw)));

    rows.push(row('권장 판매가(반올림 전)', formatKrw(c.saleBeforeRound)));
    rows.push(rowTotal('권장 판매가(최종)', formatKrw(c.saleAfterRound)));

    rows.push(row('플랫폼 수수료(예상)', `${formatKrw(c.platformFeeKrw)} (${formatPct(c.platformFeeRate)})`));

    const profitClass = c.realizedNetProfit >= 0 ? 'good' : 'bad';
    rows.push(rowClass(`예상 순수익(최종 기준)`, formatKrw(c.realizedNetProfit), profitClass));
    rows.push(row(`예상 순수익률`, `${(c.realizedNetMargin*100).toFixed(1)}%`));

    el.breakdown.innerHTML = rows.join('');
  }

  function row(label, value) {
    return `<div class="break-row"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
  }
  function rowTotal(label, value) {
    return `<div class="break-row total"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
  }
  function rowClass(label, value, cls) {
    return `<div class="break-row ${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
  }

  function setPill(text, cls) {
    el.taxPill.textContent = text;
    el.taxPill.classList.remove('ok','bad','warn');
    el.taxPill.classList.add(cls);
  }

  // ---------- Settings / Form ----------
  function hydrateForm() {
    // inputs
    el.inProductUsd.value = isFiniteNumber(inputs.productUsd) ? String(inputs.productUsd) : '';
    el.inShippingUsd.value = isFiniteNumber(inputs.shippingUsd) ? String(inputs.shippingUsd) : '';

    // settings
    el.inFxKrw.value = String(settings.fxKrw ?? DEFAULTS.fxKrw);

    el.inCardFee.value = String((settings.cardFeeRate ?? DEFAULTS.cardFeeRate) * 100);
    el.inPlatformFee.value = String((settings.platformFeeRate ?? DEFAULTS.platformFeeRate) * 100);

    el.selProfitMode.value = settings.profitMode ?? DEFAULTS.profitMode;
    el.inProfitPercent.value = String((settings.profitPercent ?? DEFAULTS.profitPercent) * 100);
    el.inProfitFixed.value = String(settings.profitFixedKrw ?? DEFAULTS.profitFixedKrw);

    el.inTaxThreshold.value = String(settings.taxThresholdUsd ?? DEFAULTS.taxThresholdUsd);
    el.chkUs200.checked = !!settings.us200Toggle;

    el.inDutyRate.value = String((settings.dutyRate ?? DEFAULTS.dutyRate) * 100);
    el.inVatRate.value = String((settings.vatRate ?? DEFAULTS.vatRate) * 100);
    el.chkTaxIncludeShipping.checked = !!settings.taxIncludeShipping;

    el.selRoundStep.value = String(settings.roundStep ?? DEFAULTS.roundStep);
    el.chkEndAdjust.checked = !!settings.endAdjustEnabled;
    el.inEndAdjustAmount.value = String(settings.endAdjustAmount ?? DEFAULTS.endAdjustAmount);

    updateProfitInputsEnabled();
  }

  function readSettingsFromForm() {
    const s = { ...settings };

    s.fxKrw = parseFloatOrZero(el.inFxKrw.value);

    s.cardFeeRate = percentToRate(el.inCardFee.value);
    s.platformFeeRate = percentToRate(el.inPlatformFee.value);

    s.profitMode = el.selProfitMode.value;
    s.profitPercent = percentToRate(el.inProfitPercent.value);
    s.profitFixedKrw = parseIntOrZero(el.inProfitFixed.value);

    s.us200Toggle = !!el.chkUs200.checked;
    s.taxThresholdUsd = parseFloatOrZero(el.inTaxThreshold.value);
    if (s.us200Toggle) s.taxThresholdUsd = 200;

    s.dutyRate = percentToRate(el.inDutyRate.value);
    s.vatRate = percentToRate(el.inVatRate.value);
    s.taxIncludeShipping = !!el.chkTaxIncludeShipping.checked;

    s.roundStep = parseIntOrZero(el.selRoundStep.value);
    s.endAdjustEnabled = !!el.chkEndAdjust.checked;
    s.endAdjustAmount = parseIntOrZero(el.inEndAdjustAmount.value);

    return sanitizeSettings(s);
  }

  function sanitizeSettings(s) {
    const out = { ...s };

    // clamp key numbers
    out.fxKrw = clampNumber(out.fxKrw, 0, 1e9, DEFAULTS.fxKrw);

    out.cardFeeRate = clampNumber(out.cardFeeRate, 0, 0.5, DEFAULTS.cardFeeRate);
    out.platformFeeRate = clampNumber(out.platformFeeRate, 0, 0.5, DEFAULTS.platformFeeRate);

    out.profitPercent = clampNumber(out.profitPercent, 0, 10, DEFAULTS.profitPercent);
    out.profitFixedKrw = clampNumber(out.profitFixedKrw, 0, 1e12, DEFAULTS.profitFixedKrw);

    out.taxThresholdUsd = clampNumber(out.taxThresholdUsd, 0, 1e9, DEFAULTS.taxThresholdUsd);
    out.dutyRate = clampNumber(out.dutyRate, 0, 1, DEFAULTS.dutyRate);
    out.vatRate = clampNumber(out.vatRate, 0, 1, DEFAULTS.vatRate);

    out.roundStep = clampNumber(out.roundStep, 0, 1e9, DEFAULTS.roundStep);
    out.endAdjustAmount = clampNumber(out.endAdjustAmount, 0, 1e9, DEFAULTS.endAdjustAmount);

    return out;
  }

  function updateProfitInputsEnabled() {
    const mode = el.selProfitMode.value;
    const pctDisabled = (mode === 'FIXED_KRW');
    const fixedDisabled = (mode !== 'FIXED_KRW');

    el.inProfitPercent.disabled = pctDisabled;
    el.inProfitFixed.disabled = fixedDisabled;
  }

  // ---------- Quotes ----------
  function renderQuotes() {
    if (!quotes.length) {
      el.quotesList.innerHTML = `<div class="muted small">저장된 견적이 없습니다.</div>`;
      return;
    }

    const html = quotes
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(q => {
        const date = new Date(q.createdAt);
        const when = isFiniteNumber(q.createdAt) ? date.toLocaleString('ko-KR') : '';
        return `
          <div class="quote" data-id="${escapeHtml(q.id)}">
            <div class="quote-top">
              <div>
                <div class="quote-name">${escapeHtml(q.name)}</div>
                <div class="quote-meta">${escapeHtml(when)} · USD ${escapeHtml(formatNumber(q.productUsd + q.shippingUsd, 2))}</div>
              </div>
              <div class="pill">${escapeHtml(q.profitModeLabel)}</div>
            </div>
            <div class="quote-price">권장 판매가: <b>${escapeHtml(formatKrw(q.salePriceKrw))}</b></div>
            <div class="quote-actions">
              <button class="btn" type="button" data-action="load">불러오기</button>
              <button class="btn" type="button" data-action="delete">삭제</button>
            </div>
          </div>
        `;
      })
      .join('');

    el.quotesList.innerHTML = html;
  }

  function saveCurrentQuote() {
    if (!lastCalc) return;

    const name = prompt('견적 이름(예: SN0107-G4 / 피젯슬라이더 / 임시 등)을 입력하세요:');
    if (!name) return;

    const q = {
      id: cryptoRandomId(),
      name: String(name).trim().slice(0, 60),
      createdAt: Date.now(),

      productUsd: lastCalc.productUsd,
      shippingUsd: lastCalc.shippingUsd,

      salePriceKrw: roundToInt(lastCalc.saleAfterRound),

      // snapshot minimal settings for reproducibility
      settings: { ...settings },
      profitModeLabel: profitModeLabel(settings)
    };

    quotes.push(q);
    saveQuotes(quotes);
    renderQuotes();
    toast('견적이 저장되었습니다.');
  }

  function loadQuoteById(id) {
    const q = quotes.find(x => x.id === id);
    if (!q) return;

    // restore settings + inputs (snapshot)
    settings = sanitizeSettings(q.settings || settings);
    inputs = { productUsd: q.productUsd, shippingUsd: q.shippingUsd };

    saveSettings(settings);
    saveInputs(inputs);

    hydrateForm();
    recalcAndRender();
    el.settingsStatus.textContent = '저장됨';
    toast('견적을 불러왔습니다.');
  }

  function deleteQuoteById(id) {
    const next = quotes.filter(q => q.id !== id);
    if (next.length === quotes.length) return;

    quotes = next;
    saveQuotes(quotes);
    renderQuotes();
    toast('견적을 삭제했습니다.');
  }

  function clearAllQuotes() {
    if (!quotes.length) return;
    const ok = confirm('저장된 견적을 전부 삭제할까요?');
    if (!ok) return;
    quotes = [];
    saveQuotes(quotes);
    renderQuotes();
    toast('모든 견적을 삭제했습니다.');
  }

  // ---------- FX Fetch ----------
  async function fetchLiveFx() {
    el.fxLiveBox.hidden = false;
    el.fxLiveBox.textContent = '실시간 환율을 가져오는 중...';

    try {
      // exchangerate.host is commonly used and does not require an API key.
      const res = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=KRW', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rate = data && data.rates && data.rates.KRW;

      if (!isFiniteNumber(rate)) throw new Error('Unexpected response');
      const ts = data.date ? String(data.date) : '';

      el.fxLiveBox.textContent = `USD→KRW 참고 환율: ${formatNumber(rate, 2)} (date: ${ts || '—'})`;
      toast('실시간 환율(참고용)을 표시했습니다.');
    } catch (e) {
      el.fxLiveBox.textContent = '실시간 환율을 가져오지 못했습니다. 네트워크/서비스 상태를 확인하거나 직접 환율을 입력하세요.';
      toast('실시간 환율 조회 실패');
    }
  }

  // ---------- Events ----------
  function wireEvents() {
    // Live recalc on input changes
    ['input', 'change'].forEach(evt => {
      el.inProductUsd.addEventListener(evt, recalcAndRender);
      el.inShippingUsd.addEventListener(evt, recalcAndRender);
    });

    el.btnRecalc.addEventListener('click', recalcAndRender);

    el.btnResetInputs.addEventListener('click', () => {
      el.inProductUsd.value = '';
      el.inShippingUsd.value = '';
      inputs = { productUsd: 0, shippingUsd: 0 };
      saveInputs(inputs);
      recalcAndRender();
      toast('입력을 초기화했습니다.');
    });

    // settings changes (do not auto-save; just mark dirty & recalc with current typed values)
    const markDirtyAndRecalc = () => {
      el.settingsStatus.textContent = '저장되지 않음';
      settings = readSettingsFromForm(); // temporary apply for preview
      recalcAndRender();
    };

    [
      el.inFxKrw,
      el.inCardFee,
      el.inPlatformFee,
      el.selProfitMode,
      el.inProfitPercent,
      el.inProfitFixed,
      el.inTaxThreshold,
      el.chkUs200,
      el.inDutyRate,
      el.inVatRate,
      el.chkTaxIncludeShipping,
      el.selRoundStep,
      el.chkEndAdjust,
      el.inEndAdjustAmount
    ].forEach(node => {
      if (!node) return;
      node.addEventListener('input', () => {
        if (node === el.selProfitMode) updateProfitInputsEnabled();
        if (node === el.chkUs200 && node.checked) {
          el.inTaxThreshold.value = '200';
        }
        markDirtyAndRecalc();
      });
      node.addEventListener('change', () => {
        if (node === el.selProfitMode) updateProfitInputsEnabled();
        if (node === el.chkUs200 && node.checked) {
          el.inTaxThreshold.value = '200';
        }
        markDirtyAndRecalc();
      });
    });

    el.btnSaveSettings.addEventListener('click', () => {
      settings = readSettingsFromForm();
      saveSettings(settings);
      el.settingsStatus.textContent = '저장됨';
      toast('설정을 저장했습니다.');
      recalcAndRender();
    });

    el.btnResetSettings.addEventListener('click', () => {
      const ok = confirm('설정을 기본값으로 초기화할까요?');
      if (!ok) return;
      settings = { ...DEFAULTS };
      saveSettings(settings);
      hydrateForm();
      el.settingsStatus.textContent = '저장됨';
      toast('설정을 초기화했습니다.');
      recalcAndRender();
    });

    el.btnFetchFx.addEventListener('click', fetchLiveFx);

    el.btnSaveQuote.addEventListener('click', saveCurrentQuote);
    el.btnClearQuotes.addEventListener('click', clearAllQuotes);

    // quotes list delegation
    el.quotesList.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      const action = target.getAttribute('data-action');
      if (!action) return;

      const quoteEl = target.closest('.quote');
      if (!quoteEl) return;

      const id = quoteEl.getAttribute('data-id');
      if (!id) return;

      if (action === 'load') loadQuoteById(id);
      if (action === 'delete') deleteQuoteById(id);
    });

    // copy price
    el.btnCopyPrice.addEventListener('click', async () => {
      const text = el.outSalePriceKrw.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('권장 판매가를 복사했습니다.');
      } catch {
        toast('복사에 실패했습니다. 브라우저 권한을 확인하세요.');
      }
    });
  }

  // ---------- Persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.settings);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return sanitizeSettings({ ...DEFAULTS, ...parsed });
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(s));
    } catch {
      // ignore
    }
  }

  function loadInputs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.inputs);
      if (!raw) return { productUsd: 0, shippingUsd: 0 };
      const parsed = JSON.parse(raw);
      return {
        productUsd: clampNumber(parsed.productUsd, 0, 1e9, 0),
        shippingUsd: clampNumber(parsed.shippingUsd, 0, 1e9, 0)
      };
    } catch {
      return { productUsd: 0, shippingUsd: 0 };
    }
  }

  function saveInputs(i) {
    try {
      localStorage.setItem(STORAGE_KEYS.inputs, JSON.stringify(i));
    } catch {
      // ignore
    }
  }

  function loadQuotes() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.quotes);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // basic sanitize
      return parsed
        .filter(x => x && typeof x === 'object')
        .map(x => ({
          id: String(x.id || cryptoRandomId()),
          name: String(x.name || '견적').slice(0, 60),
          createdAt: clampNumber(x.createdAt, 0, 1e15, Date.now()),
          productUsd: clampNumber(x.productUsd, 0, 1e9, 0),
          shippingUsd: clampNumber(x.shippingUsd, 0, 1e9, 0),
          salePriceKrw: clampNumber(x.salePriceKrw, -1e12, 1e12, 0),
          settings: x.settings || null,
          profitModeLabel: String(x.profitModeLabel || '—')
        }));
    } catch {
      return [];
    }
  }

  function saveQuotes(q) {
    try {
      localStorage.setItem(STORAGE_KEYS.quotes, JSON.stringify(q));
    } catch {
      // ignore
    }
  }

  // ---------- Helpers ----------
  function toast(msg) {
    el.toast.hidden = false;
    el.toast.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.hidden = true;
      el.toast.textContent = '';
    }, 2200);
  }

  function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function parseFloatOrZero(v) {
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  function parseIntOrZero(v) {
    const n = parseInt(String(v).replace(/,/g, '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function clampNumber(n, min, max, fallback) {
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function percentToRate(percentStr) {
    const p = parseFloatOrZero(percentStr);
    return p / 100;
  }

  function roundToInt(n) {
    return Math.round(n);
  }

  function formatNumber(n, digits) {
    const d = Number.isFinite(digits) ? digits : 0;
    if (!Number.isFinite(n)) n = 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function formatKrw(n) {
    if (!Number.isFinite(n)) n = 0;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    return `${sign}₩${Math.round(abs).toLocaleString('ko-KR')}`;
  }

  function formatUsd(n) {
    if (!Number.isFinite(n)) n = 0;
    return `USD ${formatNumber(n, 0)}`;
  }

  function formatPct(rate) {
    const r = Number.isFinite(rate) ? rate : 0;
    return `${(r * 100).toFixed(2)}%`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function cryptoRandomId() {
    // Prefer crypto.randomUUID when available
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* ignore */ }
    return 'id_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);
  }

  function profitModeLabel(s) {
    if (!s) return '—';
    if (s.profitMode === 'FIXED_KRW') return `고정 ${formatKrw(s.profitFixedKrw)}`;
    if (s.profitMode === 'MARKUP_ON_COST') return `마진율 ${(s.profitPercent*100).toFixed(0)}%`;
    return `순수익률 ${(s.profitPercent*100).toFixed(0)}%`;
  }

})();
