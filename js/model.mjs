// 数值与展示逻辑独立于 DOM / Keep data semantics separate from the DOM.
export const YEARS = Array.from({ length: 20 }, (_, i) => 2006 + i).filter(year => year !== 2020);
const PUMAS = Array.from({ length: 10 }, (_, i) => `038${String(i + 1).padStart(2, "0")}`);
// Project-area names used in details and accessible labels.
export const PUMA_NAMES = {
  "03801": "Washington Heights / Inwood",
  "03802": "West Harlem",
  "03803": "Central Harlem",
  "03804": "East Harlem",
  "03805": "Upper East Side",
  "03806": "Upper West Side",
  "03807": "Chelsea / Midtown",
  "03808": "East Midtown",
  "03809": "Chinatown / Lower East Side",
  "03810": "Financial District",
};
// 图①与图③共用的简写 / Short names shared by the map and the slope chart.
const SHORT_NAMES = {
  "03801": "Wash. Hts / Inwood",
  "03809": "Chinatown / LES",
};
export const shortName = puma => SHORT_NAMES[puma] ?? PUMA_NAMES[puma];
// 图②按地理位置分四组着色 / View 2 colors the areas in four north-to-south groups.
const AREA_GROUPS = [
  { id: 1, label: "Upper Manhattan" },
  { id: 2, label: "Upper East & West Sides" },
  { id: 3, label: "Midtown" },
  { id: 4, label: "Lower Manhattan" },
];
export const areaGroup = puma => {
  const area = Number(puma.slice(-2));
  return AREA_GROUPS[area <= 4 ? 0 : area <= 6 ? 1 : area <= 8 ? 2 : 3];
};
export const isNumber = value => typeof value === "number" && Number.isFinite(value);

export function rentGrowth(row) {
  if (row.rent_growth_status === "exact" && isNumber(row.rent_growth_nominal_pct)) {
    return { value: row.rent_growth_nominal_pct, kind: "exact" };
  }
  // 只绘制有明确定义的下限 / Plot a lower bound only when explicitly identified.
  if (row.rent_growth_status === "lower_bound" && isNumber(row.rent_growth_nominal_pct_lower_bound)) {
    return { value: row.rent_growth_nominal_pct_lower_bound, kind: "lower_bound" };
  }
  if (row.rent_growth_status === "upper_bound" && isNumber(row.rent_growth_nominal_pct_upper_bound)) {
    return { value: row.rent_growth_nominal_pct_upper_bound, kind: "upper_bound" };
  }
  const baseThreshold = row.median_gross_rent_lower_bound_base;
  const endThreshold = row.median_gross_rent_lower_bound_end;
  if (row.rent_growth_status === "unavailable"
    && row.median_gross_rent_status_base?.startsWith("top_coded_ge_")
    && row.median_gross_rent_status_end?.startsWith("top_coded_ge_")
    && isNumber(baseThreshold) && baseThreshold > 0 && isNumber(endThreshold) && endThreshold > 0) {
    return { value: 100 * (endThreshold - baseThreshold) / baseThreshold, kind: "threshold_estimate" };
  }
  return { value: null, kind: "unavailable" };
}

// 上限编码租金以已知下限着色，并通过星号及详情说明 / Censored rents use a labeled lower bound.
function medianRent(annual) {
  if (isNumber(annual.median_gross_rent)) return { value: annual.median_gross_rent, kind: "exact" };
  if (annual.median_gross_rent_status?.startsWith("top_coded_ge_") && isNumber(annual.median_gross_rent_lower_bound)) {
    return { value: annual.median_gross_rent_lower_bound, kind: "lower_bound" };
  }
  return { value: null, kind: "unavailable" };
}

export function baselineRent(row) {
  return medianRent({ median_gross_rent: row.median_gross_rent_base, median_gross_rent_status: row.median_gross_rent_status_base, median_gross_rent_lower_bound: row.median_gross_rent_lower_bound_base });
}

export const mapRentDomain = baseYear => [500, baseYear <= 2014 ? 2000 : 3500];

// 图②固定坐标：X 始终 −40%–60%；Y 两档 80% / 160%。默认只有基期 2006–2010 且终点 2021 起才用 160%，开关可改档
// View 2 axes: X is always −40% to 60%. Y has 80% and 160% tiers; 160% is the default only for base years 2006–2010 with end years from 2021, and the switch can override it.
export const defaultYTier = (baseYear, endYear) => baseYear <= 2010 && endYear >= 2021 ? 160 : 80;
// 超过 72% 的点在 80% 档里会顶出图外 / Above 72%, a bubble would spill past an 80% axis.
export const fitsLowTier = rows => rows.every(row => !(rentGrowth(row).value > 72));
export const scatterDomainsFor = (baseYear, endYear, tier = defaultYTier(baseYear, endYear)) => ({
  xGrowth: [-40, 60],
  y: [-20, tier],
});

export function rankBurdenAndGrowth(rows) {
  const areas = rows.map(row => {
    const growth = rentGrowth(row);
    return {
      row,
      burden: isNumber(row.rent_burden_pct_base) ? row.rent_burden_pct_base : null,
      growth,
      growthMin: growth.kind === "exact" || growth.kind === "lower_bound" ? growth.value : -Infinity,
      growthMax: growth.kind === "exact" || growth.kind === "upper_bound" ? growth.value : Infinity,
    };
  });
  const byDescending = (a, b) => (b ?? -Infinity) - (a ?? -Infinity);
  const byPuma = (a, b) => a.row.puma.localeCompare(b.row.puma);
  const growthOrder = [...areas].sort((a, b) => byDescending(a.growth.value, b.growth.value) || byPuma(a, b));
  const growthPositions = new Map(growthOrder.map((area, index) => [area.row.puma, index + 1]));
  return areas.sort((a, b) => byDescending(a.burden, b.burden) || byPuma(a, b)).map((area, index) => ({
    row: area.row,
    burden: area.burden,
    growth: area.growth,
    burdenPosition: index + 1,
    growthPosition: growthPositions.get(area.row.puma),
    // Threshold estimates determine plot order but leave actual growth unconstrained.
    growthRankRange: area.growth.value === null || area.growth.kind === "threshold_estimate" ? null : [
      1 + areas.filter(other => other !== area && other.growthMin > area.growthMax).length,
      1 + areas.filter(other => other !== area && other.growthMax > area.growthMin).length,
    ],
  }));
}

export function buildModel(annual, comparisons, geography) {
  const annualByKey = new Map(annual.map(r => [`${r.year}:${r.puma}`, r]));
  const comparisonsByPair = new Map();
  if (annual.length !== YEARS.length * 10 || annualByKey.size !== annual.length || comparisons.length !== YEARS.length * (YEARS.length - 1) / 2 * 10) throw new Error("Incomplete or duplicate annual/comparison records.");
  for (const row of comparisons) {
    const key = `${row.base_year}:${row.end_year}`;
    if (!comparisonsByPair.has(key)) comparisonsByPair.set(key, []);
    comparisonsByPair.get(key).push(row);
  }
  const mapPumas = new Set(geography.features.map(f => f.properties.PUMA));
  if (mapPumas.size !== 10 || geography.features.length !== 10) throw new Error("Expected ten Manhattan map features.");
  for (const year of YEARS) {
    if (PUMAS.some(puma => !annualByKey.has(`${year}:${puma}`))) throw new Error(`Incomplete annual year: ${year}`);
  }
  for (const baseYear of YEARS.slice(0, -1)) for (const endYear of YEARS.filter(year => year > baseYear)) {
    const rows = comparisonsByPair.get(`${baseYear}:${endYear}`);
    if (!rows || rows.length !== 10 || new Set(rows.map(r => r.puma)).size !== 10) throw new Error(`Incomplete year pair: ${baseYear}:${endYear}`);
    for (const row of rows) {
      if (!PUMAS.includes(row.puma) || !mapPumas.has(row.puma)
        || !annualByKey.has(`${baseYear}:${row.puma}`) || !annualByKey.has(`${endYear}:${row.puma}`)) throw new Error("Invalid year pair or PUMA join.");
    }
  }
  const maxHousing = Math.max(...comparisons.map(r => r.housing_units_end).filter(isNumber));
  return { annualByKey, comparisonsByPair, baseYears: YEARS.slice(0, -1), geography, maxHousing };
}

export const endYearsFor = baseYear => YEARS.filter(year => year > baseYear);
export function resolvePeriod(baseYear, endYear) {
  if (!YEARS.slice(0, -1).includes(baseYear)) throw new Error("Invalid baseline year.");
  const available = endYearsFor(baseYear);
  return { baseYear, endYear: available.includes(endYear) ? endYear : available[0] };
}

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const formatInteger = value => isNumber(value) ? integerFormat.format(value) : "Not available";
export function formatPercent(value, signed = false) {
  if (!isNumber(value)) return "Not available";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
export function formatRent(annual) {
  const { value, kind } = medianRent(annual);
  if (kind === "lower_bound") return `at least $${formatInteger(value)}`;
  if (annual.median_gross_rent_status === "bottom_coded_le_100") return "at most $100";
  if (kind === "exact") return `$${formatInteger(value)}`;
  return "Not available";
}
export function formatRentGrowth(row) {
  const growth = rentGrowth(row);
  const percent = formatPercent(growth.value, true);
  if (growth.kind === "threshold_estimate") return `about ${percent} (ACS thresholds)`;
  return `${growth.kind === "lower_bound" ? "at least " : growth.kind === "upper_bound" ? "at most " : ""}${percent}`;
}
export const formatBaselineRent = row => formatRent({ median_gross_rent: row.median_gross_rent_base, median_gross_rent_status: row.median_gross_rent_status_base, median_gross_rent_lower_bound: row.median_gross_rent_lower_bound_base });
export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
