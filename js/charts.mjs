// Website design was developed with assistance from Claude.

import { PUMA_NAMES, isNumber, rentGrowth, baselineRent, mapRentDomain, scatterDomainsFor, areaGroup, shortName, rankBurdenAndGrowth, formatBaselineRent, formatPercent, formatInteger, formatRentGrowth } from "./model.mjs?v=20261125";

const d3 = globalThis.d3;
const CHART_HEIGHT = 580;
const MAP_HEIGHT = 620;
const MAP_ANGLE = 29;

export function sphericalGeometry(geography) {
  // D3 球面多边形使用顺时针外环 / D3 spherical polygons need clockwise exterior rings.
  const polygon = rings => rings.map((ring, i) => (d3.polygonArea(ring) > 0) === (i === 0) ? ring : [...ring].reverse());
  return { ...geography, features: geography.features.map(feature => ({ ...feature, geometry: {
    ...feature.geometry,
    coordinates: feature.geometry.type === "Polygon" ? polygon(feature.geometry.coordinates) : feature.geometry.coordinates.map(polygon),
  } })) };
}

function bindInteractions(marks, view, hooks) {
  const describe = {
    map: ({ row }) => `${row.base_year} median monthly gross rent ${formatBaselineRent(row)}. Rent growth ${formatRentGrowth(row)} from ${row.base_year} to ${row.end_year}.`,
    growth: ({ row }) => `${areaGroup(row.puma).label} group. ${row.base_year} to ${row.end_year}. Housing growth ${formatPercent(row.housing_growth_pct)}. Rent growth ${formatRentGrowth(row)}.`,
    burden: ({ row, burden, growth, burdenPosition, growthPosition }) => `${row.base_year} rent burden ${formatPercent(burden)}, rank ${burden === null ? "unavailable" : burdenPosition}. Rent growth ${formatRentGrowth(row)} from ${row.base_year} to ${row.end_year}, rank ${growth.value === null ? "unavailable" : growthPosition}.`,
  }[view];
  marks.attr("role", "button").attr("tabindex", 0)
    .attr("data-puma", d => d.row.puma)
    .attr("aria-label", d => `${PUMA_NAMES[d.row.puma]}, project area ${d.row.puma_short}. ${describe(d)} Select across all views.`)
    .on("pointerenter", function (event, d) { hooks.hover(event, d, view, this); })
    .on("pointerleave", () => hooks.leave())
    .on("focus", function (event, d) { hooks.focus(d, view, this); })
    .on("blur", () => hooks.blur())
    .on("click", function (event, d) { hooks.select(event, d, view, this); })
    .on("keydown", function (event, d) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        hooks.select(event, d, view, this);
      }
    });
}

const MAP_LINE = 14;

// 地图标签放在岛外两侧，用引线连回区域 / Map callouts sit beside the island, with leader lines back to each area.
let measureContext;
function measure(text, font = `600 12px "Segoe UI", Arial, sans-serif`) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

function mapCallouts(entries, projection, width, height, sides) {
  const outline = entries.flatMap(({ feature: { geometry } }) =>
    (geometry.type === "Polygon" ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2)).map(projection));
  const items = entries.map(({ feature, row }) => {
    const anchor = projection([feature.properties.INTPTLON, feature.properties.INTPTLAT]);
    const name = shortName(row.puma);
    const split = name.indexOf(" / ");
    const lines = split < 0 ? [name] : [`${name.slice(0, split)} /`, name.slice(split + 3)];
    const star = baselineRent(row).kind === "lower_bound" ? "*" : "";
    const w = Math.max(...lines.map((line, i) => measure(i ? line : `${row.puma_short}${star} ${line}`)));
    return { puma: row.puma, anchor, lines, w, h: lines.length * MAP_LINE };
  });
  const edge = (top, bottom, side) => {
    let band = outline.filter(([, y]) => y >= top - 8 && y <= bottom + 8);
    if (!band.length) band = [...outline].sort((a, b) => Math.abs(a[1] - (top + bottom) / 2) - Math.abs(b[1] - (top + bottom) / 2)).slice(0, 20);
    return side < 0 ? d3.min(band, p => p[0]) : d3.max(band, p => p[0]);
  };
  // 岛西侧的区域标签放左，东侧放右；用锚点拟合的岛轴线判断 / West-side areas label on the left, east-side on the right, judged against the island's axis.
  const meanY = d3.mean(items, d => d.anchor[1]), meanX = d3.mean(items, d => d.anchor[0]);
  const slope = d3.sum(items, d => (d.anchor[1] - meanY) * (d.anchor[0] - meanX)) / d3.sum(items, d => (d.anchor[1] - meanY) ** 2);
  for (const item of items) item.side = sides?.get(item.puma) ?? (item.anchor[0] < meanX + slope * (item.anchor[1] - meanY) ? -1 : 1);
  const GAP = 10, OFFSET = 18;
  // 岛由左下斜向右上：左侧标签上移、右侧标签下移可离海岸更远。每个标签只移够用的量，最多 60px，其余由缩放地图解决
  // The island runs bottom-left to top-right, so raising west labels and lowering east ones gains room.
  // Each label shifts only as far as it needs, at most 60px; refitting the map covers the rest.
  const MAX_SHIFT = 60;
  const fits = (item, top, side) => {
    const x = edge(top, top + item.h, side) + side * OFFSET;
    return side < 0 ? x - item.w >= 4 : x + item.w <= width - 4;
  };
  const layout = new Map();
  for (const side of [-1, 1]) {
    const column = items.filter(item => item.side === side).sort((a, b) => a.anchor[1] - b.anchor[1]);
    for (const item of column) {
      // 标签第一行与锚点同高，引线水平 / The first label line sits level with the anchor, so the leader runs flat.
      const base = item.anchor[1] - MAP_LINE / 2;
      let shift = 0;
      while (shift < MAX_SHIFT && !fits(item, base + side * shift, side)) shift += 5;
      item.top = base + side * shift;
    }
    column.forEach((item, i) => { if (i) item.top = Math.max(item.top, column[i - 1].top + column[i - 1].h + GAP); });
    for (let i = column.length - 1; i >= 0; i--) {
      const limit = i === column.length - 1 ? height - 14 : column[i + 1].top - GAP;
      column[i].top = Math.max(6, Math.min(column[i].top, limit - column[i].h));
    }
    for (const item of column) {
      const x = edge(item.top, item.top + item.h, side) + side * OFFSET;
      // 引线只走水平和竖直段 / Leaders use only horizontal and vertical segments.
      const [ax, ay] = item.anchor, ly = item.top + MAP_LINE / 2, end = x - side * 4, bend = end - side * 6;
      const leader = Math.abs(ly - ay) < .5 ? [[ax, ay], [end, ay]] : [[ax, ay], [bend, ay], [bend, ly], [end, ly]];
      layout.set(item.puma, { ...item, x, y: item.top + MAP_LINE - 2, leader });
    }
  }
  return layout;
}

const rentColorScale = baseYear =>
  d3.scaleSequential(d3.interpolateLab("#e3f0ec", "#003b46")).domain(mapRentDomain(baseYear)).clamp(true);

export class HousingMap {
  constructor(host, model, hooks) {
    this.host = host;
    this.geometry = sphericalGeometry(model.geography);
    this.color = rentColorScale(2006);
    this.hooks = hooks;
    this.svg = d3.select(host).append("svg").attr("role", "group");
    this.svg.append("rect").attr("class", "map-water").attr("rx", 3);
    this.layer = this.svg.append("g");
    this.north = this.svg.append("g").attr("aria-hidden", "true");
    this.north.append("path").attr("d", "M0,22V0m-4,6 4,-6 4,6").attr("fill", "none").attr("stroke", "#7a8f92");
    this.north.append("text").attr("class", "map-north").attr("x", 0).attr("y", -7).attr("text-anchor", "middle").text("N");
    this.legend = d3.select("#map-legend").attr("viewBox", "0 0 240 50");
    const gradient = this.legend.append("defs").append("linearGradient").attr("id", "housing-gradient");
    gradient.selectAll("stop").data(d3.range(0, 1.001, .05)).join("stop")
      .attr("offset", t => `${100 * t}%`).attr("stop-color", this.color.interpolator());
    this.legend.append("rect").attr("x", 20).attr("y", 5).attr("width", 200).attr("height", 11).attr("rx", 1).attr("fill", "url(#housing-gradient)");
    this.legendAxis = this.legend.append("g").attr("transform", "translate(0,17)");
  }

  render(rows) {
    const width = this.host.clientWidth;
    const height = matchMedia("(max-width: 1060px)").matches ? 430 : MAP_HEIGHT;
    const { base_year: baseYear } = rows[0];
    const [minRent, maxRent] = mapRentDomain(baseYear);
    this.color.domain([minRent, maxRent]);
    this.legend.attr("aria-label", `${baseYear} median monthly gross rent color legend, ${formatInteger(minRent)} to ${formatInteger(maxRent)} dollars`);
    this.legendAxis.call(d3.axisBottom(d3.scaleLinear([minRent, maxRent], [20, 220]))
      .tickValues([minRent, (minRent + maxRent) / 2, maxRent]).tickFormat(value => `$${formatInteger(value)}`).tickSize(3))
      .call(axis => axis.select(".domain").remove()).call(axis => axis.selectAll("text").attr("fill", "#586c71").attr("font-size", 13));
    this.svg.attr("viewBox", `0 0 ${width} ${height}`)
      .attr("aria-label", `${baseYear} median monthly gross rent map. Ten selectable project areas.`);
    this.svg.select(".map-water").attr("width", width).attr("height", height - 8);
    const byPuma = new Map(rows.map(row => [row.puma, row]));
    const entries = this.geometry.features.map(feature => ({ feature, row: byPuma.get(feature.properties.PUMA) }));
    const marks = this.layer.selectAll("g.map-puma").data(entries, d => d.row.puma).join(enter => {
      const mark = enter.append("g").attr("class", "data-mark map-puma");
      mark.append("path").attr("class", "mark-shape");
      mark.append("polyline").attr("class", "map-leader");
      mark.append("circle").attr("class", "map-anchor").attr("r", 3.2);
      mark.append("text").attr("class", "map-label");
      return mark;
    });
    marks.select("path").style("fill", d => isNumber(baselineRent(d.row).value) ? this.color(baselineRent(d.row).value) : "#d8dedb");
    // 标签超出面板时缩小并平移地图，最多十轮 / Shrink and shift the island until every callout fits, up to ten passes.
    let extent = [[20, 8], [width - 20, height - 15]];
    let sides, projection;
    for (let pass = 0; pass < 10; pass++) {
      // 按曼哈顿街网方向旋转，岛竖直，两侧留出标签空间 / Rotated to the street grid so the island stands upright, leaving room for labels on both sides.
      projection = d3.geoMercator().angle(MAP_ANGLE).fitExtent(extent, this.geometry);
      sides = this.drawCallouts(marks, entries, projection, width, height, sides);
      const boxes = marks.select(".map-label").nodes().map(node => node.getBBox());
      const left = Math.max(0, ...boxes.map(box => 4 - box.x));
      const right = Math.max(0, ...boxes.map(box => box.x + box.width - (width - 4)));
      if (left < .5 && right < .5) break;
      // 以岛的实际外框为基准收窄，竖直的岛也能收敛 / Narrow from the island's own bounds so a tall, height-bound island still converges.
      const [[x0], [x1]] = d3.geoPath(projection).bounds(this.geometry);
      extent = [[x0 + (left && left + 1), extent[0][1]], [x1 - (right && right + 1), extent[1][1]]];
    }
    // 指北针跟随旋转，始终指向真北 / The north arrow follows the rotation and points to true north.
    const [lon, lat] = d3.geoCentroid(this.geometry);
    const [x0, y0] = projection([lon, lat]), [x1, y1] = projection([lon, lat + .01]);
    this.north.attr("transform", `translate(${width - 22},40) rotate(${Math.atan2(x1 - x0, y0 - y1) * 180 / Math.PI})`);
    bindInteractions(marks, "map", this.hooks);
  }

  drawCallouts(marks, entries, projection, width, height, sides) {
    const path = d3.geoPath(projection);
    marks.select("path").attr("d", d => path(d.feature));
    const layout = mapCallouts(entries, projection, width, height, sides);
    marks.select(".map-anchor").attr("cx", d => layout.get(d.row.puma).anchor[0]).attr("cy", d => layout.get(d.row.puma).anchor[1]);
    marks.select(".map-leader").attr("points", d => layout.get(d.row.puma).leader.join(" "));
    marks.select(".map-label").each(function (d) {
      const { x, y, side, lines } = layout.get(d.row.puma);
      const star = baselineRent(d.row).kind === "lower_bound" ? "*" : "";
      const text = d3.select(this).attr("text-anchor", side < 0 ? "end" : "start").attr("x", x).attr("y", y);
      text.selectAll("tspan").remove();
      lines.forEach((line, i) => {
        const tspan = text.append("tspan").attr("x", x).attr("dy", i ? MAP_LINE : 0);
        if (i === 0) tspan.append("tspan").attr("class", "map-code").text(`${d.row.puma_short}${star} `);
        tspan.append("tspan").text(line);
      });
    });
    return new Map([...layout].map(([puma, item]) => [puma, item.side]));
  }
}

function intersects(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function labelPositions(points, width, height) {
  // 只移动标签，保持真实点位 / Reposition labels without moving data points.
  const occupied = [];
  const placements = new Map();
  for (const point of [...points].sort((a, b) => b.suffix.length - a.suffix.length || a.y - b.y)) {
    const w = point.suffix ? 27 : 20;
    const h = 16;
    const gap = point.radius + 5;
    const candidates = [
      { x: point.x + gap, y: point.y - 5 },
      { x: point.x - gap - w, y: point.y - 5 },
      { x: point.x - w / 2, y: point.y + gap + 4 },
      { x: point.x - w / 2, y: point.y - gap - h },
      { x: point.x + gap, y: point.y + gap },
      { x: point.x - gap - w, y: point.y + gap },
    ].map(candidate => ({ x: Math.max(2, Math.min(width - w - 2, candidate.x)), y: Math.max(2, Math.min(height - h - 2, candidate.y)), w, h }));
    const score = rectangle => occupied.reduce((sum, other) => sum + intersects(rectangle, other) * 100, 0)
      + points.reduce((sum, other) => sum + intersects(rectangle, { x: other.x - other.radius - 2, y: other.y - other.radius - 2, w: 2 * other.radius + 4, h: 2 * other.radius + 4 }) * 4, 0)
      + Math.hypot(rectangle.x + w / 2 - point.x, rectangle.y + h / 2 - point.y);
    const best = candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best);
    occupied.push(best);
    placements.set(point.puma, { x: best.x - point.x, y: best.y - point.y + 11 });
  }
  return placements;
}

export class Scatterplot {
  constructor(host, radius, hooks) {
    this.host = host;
    this.radius = radius;
    this.hooks = hooks;
    this.svg = d3.select(host).append("svg").attr("role", "group");
    this.plot = this.svg.append("g");
    this.plot.append("g").attr("class", "grid");
    this.plot.append("line").attr("class", "zero-line");
    this.plot.append("g").attr("class", "axis x-axis");
    this.plot.append("g").attr("class", "axis y-axis");
    this.plot.append("text").attr("class", "axis-title x-title").attr("text-anchor", "middle");
    this.plot.append("text").attr("class", "axis-title y-title").attr("text-anchor", "middle");
    this.marksLayer = this.plot.append("g");
  }

  render(rows, { yTier } = {}) {
    const fullWidth = this.host.clientWidth;
    const domains = scatterDomainsFor(rows[0].base_year, rows[0].end_year, yTier);
    const fullHeight = CHART_HEIGHT;
    const margin = { top: 28, right: 20, bottom: 56, left: 74 };
    const width = Math.max(120, fullWidth - margin.left - margin.right);
    const height = fullHeight - margin.top - margin.bottom;
    const x = d3.scaleLinear(domains.xGrowth, [0, width]);
    const y = d3.scaleLinear(domains.y, [height, 0]);
    const yDomain = y.domain();
    this.svg.attr("viewBox", `0 0 ${fullWidth} ${fullHeight}`)
      .attr("aria-label", `Housing growth versus rent growth, ${rows[0].base_year} to ${rows[0].end_year}. X scale -40 to 60 percent. Y scale ${yDomain.join(" to ")} percent.`);
    this.plot.attr("transform", `translate(${margin.left},${margin.top})`);
    const yTicks = d3.range(yDomain[0], yDomain[1] + 1, 20);
    const xTicks = d3.range(domains.xGrowth[0], domains.xGrowth[1] + 1, 20);
    this.plot.select(".grid").call(d3.axisLeft(y).tickValues(yTicks).tickSize(-width).tickFormat(""));
    this.plot.select(".zero-line")
      .attr("x1", 0).attr("x2", width).attr("y1", y(0)).attr("y2", y(0));
    this.plot.select(".x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickValues(xTicks).tickSizeOuter(0).tickPadding(7).tickFormat(d => `${d}%`));
    this.plot.select(".y-axis").call(d3.axisLeft(y).tickValues(yTicks).tickSizeOuter(0).tickSize(0).tickPadding(8).tickFormat(d => `${d}%`)).select(".domain").remove();
    // Y 轴以琥珀色标出两档上限 / Amber highlights the 80% and 160% tier limits on the Y axis.
    this.plot.select(".y-axis").selectAll(".tick text").classed("axis-max", d => d > 0 && d % 80 === 0);
    this.plot.select(".x-title").attr("x", width / 2).attr("y", height + 43)
      .text("Housing stock growth (%)");
    this.plot.select(".y-title").attr("transform", `translate(-62,${height / 2}) rotate(-90)`).text("Median gross rent growth (%)");
    const points = rows.map(row => ({ row, growth: rentGrowth(row), xValue: row.housing_growth_pct }))
      .filter(d => isNumber(d.growth.value) && isNumber(d.xValue))
      .map(d => ({ ...d, puma: d.row.puma, x: x(d.xValue), y: y(d.growth.value),
        suffix: d.growth.kind === "exact" ? "" : "*",
        radius: this.radius(d.row.housing_units_end) }));
    const labels = labelPositions(points, width, height);
    // 大气泡在底层，小气泡仍可点击 / Draw larger bubbles first to keep small ones reachable.
    points.sort((a, b) => b.radius - a.radius);
    const marks = this.marksLayer.selectAll("g.scatter-mark").data(points, d => d.row.puma).join(enter => {
      const group = enter.append("g").attr("class", "data-mark scatter-mark");
      group.append("circle").attr("class", "hit-area").attr("fill", "transparent");
      group.append("path").attr("class", "mark-shape");
      group.append("text").attr("class", "point-label");
      return group;
    });
    marks.order().attr("transform", d => `translate(${d.x},${d.y})`)
      .attr("data-group", d => areaGroup(d.puma).id)
      .classed("is-threshold-estimate", d => d.growth.kind === "threshold_estimate");
    marks.select(".hit-area").attr("r", d => Math.max(12, d.radius + 3));
    marks.select(".mark-shape").attr("d", d => d3.symbol(d3.symbolCircle, Math.PI * d.radius ** 2)());
    marks.select(".point-label").text(d => `${d.row.puma_short}${d.suffix}`)
      .attr("x", d => labels.get(d.puma).x).attr("y", d => labels.get(d.puma).y);
    bindInteractions(marks, "growth", this.hooks);
  }
}

function growthLabel({ growth }) {
  if (growth.value === null) return "Unavailable";
  const value = formatPercent(growth.value, true);
  if (growth.kind === "lower_bound") return `≥ ${value}*`;
  if (growth.kind === "upper_bound") return `≤ ${value}*`;
  if (growth.kind === "threshold_estimate") return `≈ ${value}`;
  return value;
}

const bothAvailable = d => d.burden !== null && d.growth.value !== null;

function rankChange(entry) {
  if (!bothAvailable(entry)) return "unavailable";
  const difference = entry.burdenPosition - entry.growthPosition;
  if (Math.abs(difference) <= 1) return "close";
  return difference > 0 ? "higher" : "lower";
}

export class RentBurdenSlope {
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.svg = d3.select(host).append("svg").attr("role", "group");
  }

  render(rows) {
    const { base_year: baseYear, end_year: endYear } = rows[0];
    const width = this.host.clientWidth;
    const rowHeight = width < 335 ? 62 : 58;
    const height = rows.length * rowHeight;
    // 标签列只取实际文字所需宽度，圆点紧挨标签，连线占其余宽度
    // Label columns take only the width their text needs, so dots sit next to the labels and links take the rest.
    const font = weight => `${weight} ${parseFloat(getComputedStyle(this.host).getPropertyValue("--slope-font")) || 14}px "Segoe UI", Arial, sans-serif`;
    const entries = rankBurdenAndGrowth(rows);
    const textWidth = entries.flatMap(entry => [
      measure(`${shortName(entry.row.puma)}${entry.growth.kind === "threshold_estimate" ? "*" : ""}`, font(600)),
      measure(formatPercent(entry.burden), font(600)),
      measure(growthLabel(entry), font(600)),
    ]);
    const labelWidth = Math.min(Math.max(...textWidth) + 8, Math.max(0, (width - 110) / 2));
    const linkWidth = width - 2 * labelWidth;
    const left = (width - linkWidth) / 2;
    const right = width - left;
    const yBurden = d => (d.burdenPosition - .5) * rowHeight;
    const yGrowth = d => (d.growthPosition - .5) * rowHeight;
    this.svg.attr("viewBox", `0 0 ${width} ${height}`)
      .attr("aria-label", `Slope chart ranking ${baseYear} rent burden and ${baseYear} to ${endYear} rent growth for ten selectable project areas.`);
    const marks = this.svg.selectAll("g.slope-mark").data(entries, d => d.row.puma).join(enter => {
      const mark = enter.append("g").attr("class", "data-mark slope-mark");
      mark.append("line").attr("class", "slope-hit");
      mark.append("line").attr("class", "slope-line");
      for (const side of ["burden", "growth"]) {
        mark.append("circle").attr("class", `slope-dot ${side}-dot`).attr("r", 4.5);
        const label = mark.append("foreignObject").attr("class", `${side}-label`).attr("aria-hidden", "true")
          .append("xhtml:div").attr("class", "slope-label-content");
        label.append("span").attr("class", "slope-area");
        label.append("span").attr("class", "slope-value");
      }
      return mark;
    });
    marks.attr("data-rank-change", rankChange)
      .classed("is-growth-bound", d => d.growth.kind === "lower_bound" || d.growth.kind === "upper_bound")
      .classed("is-threshold-estimate", d => d.growth.kind === "threshold_estimate");
    for (const line of [".slope-hit", ".slope-line"]) {
      marks.select(line).attr("x1", left).attr("x2", right).attr("y1", yBurden).attr("y2", yGrowth)
        .attr("display", d => bothAvailable(d) ? null : "none");
    }
    marks.select(".burden-dot").attr("cx", left).attr("cy", yBurden).attr("display", d => d.burden === null ? "none" : null);
    marks.select(".growth-dot").attr("cx", right).attr("cy", yGrowth).attr("display", d => d.growth.value === null ? "none" : null);
    marks.select(".burden-label").attr("x", 0).attr("y", d => yBurden(d) - rowHeight / 2);
    marks.select(".growth-label").attr("x", right + 6).attr("y", d => yGrowth(d) - rowHeight / 2);
    for (const side of ["burden", "growth"]) {
      const labels = marks.select(`.${side}-label`).attr("width", Math.max(0, left - 6)).attr("height", rowHeight);
      labels.select(".slope-area").text(({ row, growth }) => {
        const name = shortName(row.puma);
        return growth.kind === "threshold_estimate" ? `${name}*` : name;
      });
    }
    marks.select(".burden-label .slope-value").text(d => formatPercent(d.burden));
    marks.select(".growth-label .slope-value").text(growthLabel);
    bindInteractions(marks, "burden", this.hooks);
  }
}

export function renderSizeLegend(radius) {
  const size = d3.select("#size-legend").attr("viewBox", "0 0 300 55");
  [50000, 100000, 150000].forEach((value, i) => {
    const x = 42 + i * 97;
    size.append("circle").attr("cx", x).attr("cy", 23).attr("r", radius(value)).attr("fill", "none").attr("stroke", "#809fa5");
    size.append("text").attr("x", x + 32).attr("y", 27).attr("fill", "#556a70").attr("font-size", 12).text(`${formatInteger(value / 1000)}k`);
  });
}
