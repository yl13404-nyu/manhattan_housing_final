// Website design was developed with assistance from Claude.

import { buildModel, endYearsFor, resolvePeriod, defaultYTier, fitsLowTier, PUMA_NAMES, formatInteger, formatPercent, formatRent, formatRentGrowth, escapeHTML } from "./model.mjs?v=20261125";

const d3 = globalThis.d3;
const $ = selector => document.querySelector(selector);
// yTier 为 null 时按默认规则；点过开关后保留所选档 / yTier null follows the default rule; a clicked switch keeps its choice.
const state = { baseYear: 2006, endYear: 2025, selected: new Set(), hovered: null, yTier: null };
const tooltip = $("#detail-tooltip");
let model;
let charts;
let activeTooltip = null;

// 租金用琥珀色文字突出 / Rents stand out in amber text.
const rentChip = annual => `<span class="rent-value">${escapeHTML(formatRent(annual))}</span>`;

function tooltipHTML({ row, burden, burdenPosition, growth, growthPosition, growthRankRange }, view, pinned) {
  const current = model.annualByKey.get(`${state.endYear}:${row.puma}`);
  const base = model.annualByKey.get(`${state.baseYear}:${row.puma}`);
  const field = (label, value) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`;
  let html = `<div class="tooltip-kicker">${escapeHTML(row.region)} · Project area ${escapeHTML(row.puma_short)}</div>
    <div class="tooltip-heading"><h3>${escapeHTML(PUMA_NAMES[row.puma])}</h3><span>${state.baseYear} → ${state.endYear}</span></div>
    <dl class="tooltip-metrics">
    <div><dt>${state.baseYear} median monthly gross rent</dt><dd>${rentChip(base)}</dd></div>
    <div><dt>${state.endYear} median monthly gross rent</dt><dd>${rentChip(current)}</dd></div>
    ${field(`${state.endYear} total housing units`, formatInteger(current.housing_units))}
    ${field(`Housing growth from ${state.baseYear}`, formatPercent(row.housing_growth_pct, true))}
    ${field(`Nominal rent growth from ${state.baseYear}`, formatRentGrowth(row))}`;
  const showRanks = view === "burden";
  if (showRanks) {
    const growthRank = growthRankRange ? [...new Set(growthRankRange)].join("–") : "Unavailable";
    html += field("Baseline rent burden rank", burden === null ? "Unavailable" : burdenPosition);
    html += growth.kind === "threshold_estimate" ? field("Rent growth rank using thresholds", growthPosition) : field("Possible rent growth rank", growthRank);
  }
  html += `</dl>`;
  if (showRanks) {
    const burdenRow = (label, key, format) => `<tr><th scope="row">${label}</th><td>${format(base[key])}</td><td>${format(current[key])}</td></tr>`;
    html += `<table class="tooltip-burden"><caption>Rent burden · gross rent ≥30% of income</caption><thead><tr><th scope="col">Measure</th><th scope="col">${state.baseYear}</th><th scope="col">${state.endYear}</th></tr></thead><tbody>
      ${burdenRow("Burdened household share", "rent_burden_pct", formatPercent)}
      ${burdenRow("Burdened households", "rent_burdened_households", formatInteger)}
      ${burdenRow("Computable households", "rent_computable_households", formatInteger)}
      </tbody></table><p class="tooltip-note">Share = burdened ÷ computable households. Not-computed cases are excluded from the denominator.</p>`;
  }
  html += `<p class="tooltip-note">Source PUMA: ${state.baseYear} ${escapeHTML(base.source_puma)} · ${state.endYear} ${escapeHTML(current.source_puma)}.</p>`;
  html += `<p class="tooltip-note">${pinned ? "Click outside or press Escape to close details." : "Click, or press Enter or Space, to select and pin details."}</p>`;
  return html;
}

function positionTooltip({ position, element }) {
  const rect = element.getBoundingClientRect();
  const x = position?.clientX ?? rect.left + rect.width / 2;
  const y = position?.clientY ?? rect.top + rect.height / 2;
  const box = tooltip.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  let left = x + 22;
  if (left + box.width > viewportWidth - 12) left = x - box.width - 22;
  tooltip.style.left = `${Math.max(12, Math.min(viewportWidth - box.width - 12, left))}px`;
  tooltip.style.top = `${Math.max(12, Math.min(innerHeight - box.height - 12, y - box.height * .35))}px`;
}

function applyHighlights() {
  const previewed = activeTooltip && !activeTooltip.pinned ? activeTooltip.element.dataset.puma : state.hovered;
  const hasHighlight = Boolean(state.selected.size || previewed);
  document.querySelectorAll(".data-mark").forEach(mark => {
    const puma = mark.dataset.puma;
    const selected = state.selected.has(puma);
    const highlighted = previewed === puma;
    mark.classList.toggle("is-selected", selected);
    mark.classList.toggle("is-highlighted", highlighted);
    mark.classList.toggle("is-dimmed", hasHighlight && !selected && !highlighted);
    mark.setAttribute("aria-pressed", String(selected));
  });
  $("#clear-selection").disabled = state.selected.size === 0;
  $("#selection-status").textContent = state.selected.size ? `${state.selected.size} selected · ${[...state.selected].sort().map(puma => puma.slice(-2)).join(", ")}` : "All 10 areas";
}

function hideTooltip() {
  tooltip.hidden = true;
  activeTooltip?.element.removeAttribute("aria-describedby");
  activeTooltip = null;
}

function showTooltip(position, datum, view, element, pinned) {
  hideTooltip();
  activeTooltip = { element, pinned, position };
  tooltip.classList.toggle("is-pinned", pinned);
  tooltip.innerHTML = tooltipHTML(datum, view, pinned);
  tooltip.hidden = false;
  tooltip.scrollTop = 0;
  element.setAttribute("aria-describedby", "detail-tooltip");
  positionTooltip(activeTooltip);
  applyHighlights();
}

// 悬停 1 秒后预览详情 / Details preview after a one-second hover.
const HOVER_DELAY = 1000;
let hoverTimer;

const hooks = {
  hover(event, datum, view, element) {
    if (activeTooltip?.pinned || event.pointerType === "touch") return;
    state.hovered = datum.row.puma;
    applyHighlights();
    clearTimeout(hoverTimer);
    const position = { clientX: event.clientX, clientY: event.clientY };
    hoverTimer = setTimeout(() => {
      if (!activeTooltip?.pinned && state.hovered === datum.row.puma) showTooltip(position, datum, view, element, false);
    }, HOVER_DELAY);
  },
  leave() {
    clearTimeout(hoverTimer);
    state.hovered = null;
    if (activeTooltip && !activeTooltip.pinned) hideTooltip();
    applyHighlights();
  },
  focus(datum, view, element) {
    if (!activeTooltip?.pinned && element.matches(":focus-visible")) showTooltip(null, datum, view, element, false);
  },
  blur() {
    if (!activeTooltip || activeTooltip.pinned) return;
    hideTooltip();
    applyHighlights();
  },
  select(event, datum, view, element) {
    const { puma } = datum.row;
    clearTimeout(hoverTimer);
    state.hovered = null;
    // Ctrl 多选只改选中状态，不弹详情 / Ctrl multi-select only changes the selection; no details open.
    if (event.ctrlKey || event.metaKey) {
      state.selected.has(puma) ? state.selected.delete(puma) : state.selected.add(puma);
      hideTooltip();
      applyHighlights();
      return;
    }
    state.selected = new Set([puma]);
    const position = event.type === "click" ? { clientX: event.clientX, clientY: event.clientY } : null;
    showTooltip(position, datum, view, element, true);
  },
};

function render() {
  const rows = model.comparisonsByPair.get(`${state.baseYear}:${state.endYear}`);
  $("#base-year").textContent = state.baseYear;
  $("#end-year").textContent = state.endYear;
  document.querySelectorAll(".baseline-year").forEach(label => { label.textContent = state.baseYear; });
  document.querySelectorAll(".period-label").forEach(label => { label.textContent = `${state.baseYear} → ${state.endYear}`; });
  document.querySelectorAll(".endpoint-year").forEach(label => { label.textContent = state.endYear; });
  const lowFits = fitsLowTier(rows);
  const yTier = lowFits ? state.yTier ?? defaultYTier(state.baseYear, state.endYear) : 160;
  document.querySelectorAll(".tier-buttons button").forEach(button => {
    const tier = Number(button.dataset.tier);
    button.setAttribute("aria-checked", String(tier === yTier));
    button.disabled = tier === 80 && !lowFits;
    button.title = button.disabled ? "Some values in this period exceed 72%" : "";
  });
  charts.forEach(chart => chart.render(rows, { yTier }));
  applyHighlights();
}

function updatePeriod(baseYear, endYear) {
  hideTooltip();
  state.hovered = null;
  Object.assign(state, resolvePeriod(baseYear, endYear));
  const options = endYearsFor(state.baseYear);
  d3.select("#end-year-select").selectAll("option").data(options, year => year).join("option")
    .attr("value", year => year).text(year => year);
  $("#base-year-select").value = String(state.baseYear);
  $("#end-year-select").value = String(state.endYear);
  render();
}

async function start() {
  try {
    if (!d3) throw new Error("The local D3 library did not load.");
    const { HousingMap, Scatterplot, RentBurdenSlope, renderSizeLegend } = await import("./charts.mjs?v=20261125");
    const [annual, comparisons, geography] = await Promise.all([
      d3.json("./data/manhattan_annual_2006_2025.json"),
      d3.json("./data/manhattan_comparisons_all_baselines_2006_2025.json"),
      d3.json("./data/manhattan_puma_2000_land.geojson?v=mainland-20261112"),
    ]);
    model = buildModel(annual, comparisons, geography);    // 半径取平方根，面积与房量成正比 / Square-root radii keep circle areas proportional to housing units.
    const radius = d3.scaleSqrt([0, model.maxHousing], [0, 23]);
    d3.select("#base-year-select").selectAll("option").data(model.baseYears).join("option")
      .attr("value", year => year).text(year => year);
    $("#base-year-select").addEventListener("change", event => updatePeriod(Number(event.target.value), state.endYear));
    $("#end-year-select").addEventListener("change", event => updatePeriod(state.baseYear, Number(event.target.value)));
    document.querySelectorAll(".tier-buttons button").forEach(button => button.addEventListener("click", () => {
      state.yTier = Number(button.dataset.tier);
      render();
    }));
    $("#clear-selection").addEventListener("click", () => {
      state.selected.clear();
      state.hovered = null;
      hideTooltip();
      applyHighlights();
    });
    document.addEventListener("click", event => {
      if (activeTooltip && !event.target.closest?.(".data-mark, #detail-tooltip")) {
        hideTooltip();
        applyHighlights();
      }
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (!activeTooltip?.pinned) state.selected.clear();
      state.hovered = null;
      hideTooltip();
      applyHighlights();
    });
    // 同一状态驱动全部视图 / One shared state drives all views.
    charts = [new HousingMap($("#map-chart"), model, hooks),
      new Scatterplot($("#growth-chart"), radius, hooks),
      new RentBurdenSlope($("#burden-chart"), hooks)];
    renderSizeLegend(radius);
    $("#load-status").hidden = true;
    $("#dashboard").hidden = false;
    updatePeriod(state.baseYear, state.endYear);
    let frame;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        render();
        if (activeTooltip) positionTooltip(activeTooltip);
      });
    }).observe($(".dashboard-grid"));
  } catch (error) {
    const status = $("#load-status");
    status.hidden = false;
    status.classList.add("is-error");
    status.innerHTML = `<strong>The dashboard could not load.</strong><br>${escapeHTML(error.message)}<br>Run <code>node serve.mjs --port 8766</code> from the 02_Data_and_Code folder, then open <a href="http://127.0.0.1:8766/">the dashboard</a>.`;
    console.error(error);
  }
}

start();
