# This file was developed with assistance from Codex.

"""Build Manhattan annual and fixed-2006 comparison data from local ACS files.

Python 3.10+ standard library only; no network calls, no raw-input modifications.
All year-specific variable positions come from cached official Census lookups.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import shutil
import subprocess
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "03_Supporting_Not_For_Upload"
DATA_DIR = ROOT / "legacy_data"
CURRENT_DATA_DIR = ROOT.parent / "02_Data_and_Code" / "data"
YEARS = tuple(range(2006, 2012))
PUMAS = tuple(f"038{i:02d}" for i in range(1, 11))
VARIABLES = ("B25001_001", "B25064_001", *(f"B25070_{i:03d}" for i in range(1, 12)))
ARCHIVES = {2006: "ny_all_2006.zip", 2007: "all_ny (1).zip", 2008: "all_ny (2).zip",
            2009: "NewYork.zip", 2010: "NewYork_All_Geographies.zip", 2011: "NewYork_All_Geographies (1).zip"}
EXPECTED_LABELS = {
    "B25001_001": "Total", "B25064_001": "Median gross rent", "B25070_001": "Total",
    "B25070_002": "Less than 10.0 percent", "B25070_003": "10.0 to 14.9 percent",
    "B25070_004": "15.0 to 19.9 percent", "B25070_005": "20.0 to 24.9 percent",
    "B25070_006": "25.0 to 29.9 percent", "B25070_007": "30.0 to 34.9 percent",
    "B25070_008": "35.0 to 39.9 percent", "B25070_009": "40.0 to 49.9 percent",
    "B25070_010": "50.0 percent or more", "B25070_011": "Not computed",
}


def require(condition, message):
    """Keep validation active even when Python runs with -O."""
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def write_csv(path, rows):
    require(bool(rows), f"No rows for {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def region_for(puma):
    require(puma in PUMAS, f"Unexpected Manhattan PUMA: {puma}")
    return "Downtown" if puma in {"03809", "03810"} else "Midtown" if puma in {"03807", "03808"} else "Uptown"


def parse_cell(raw, variable=None):
    """These tables contain only nonnegative counts/dollars, never negative data.

    Keep the original token in the audit ledger. Special/empty/non-numeric tokens
    become null, never zero. No imputation, outlier deletion, or clamping occurs.
    """
    text = raw.strip()
    if not text:
        return None, "empty"
    if text == ".":
        return None, "not_available_dot"
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None, f"special_token:{text}"
    if not number.is_finite():
        return None, f"non_finite:{text}"
    if number < 0:
        return None, f"negative_special_code:{text}"
    require(number == number.to_integral_value(), f"Unexpected fractional count/dollar/MOE: {raw}")
    value = int(number)
    # Positive jam codes are variable-specific: 2001 is a real count elsewhere.
    # Census 2007 Appendix J and 2010/2011 Appendix C.3 document these codes.
    if variable == "B25064_001E":
        if value == 2001:
            return None, "top_coded_ge_2000"
        if value == 99:
            return None, "bottom_coded_le_100"
    return value, "ok"


def rent_limits(cell):
    if cell["status"] == "top_coded_ge_2000":
        return 2000, None, ">=2000"
    if cell["status"] == "bottom_coded_le_100":
        return 0, 100, "<=100"
    value = cell["value"]
    return value, value, "" if value is None else str(value)


def complete_sum(values):
    return None if any(v is None for v in values) else sum(values)


def percentage(numerator, denominator):
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return round(100 * numerator / denominator, 6)


def make_annual_row(geo, cells):
    year, puma = int(geo["YEAR"]), geo["PUMA"]
    get = lambda variable, suffix="E": cells[(year, puma, variable + suffix)]["value"]
    total, excluded = get("B25070_001"), get("B25070_011")
    numerator = complete_sum([get(f"B25070_{i:03d}") for i in range(7, 11)])
    denominator = None if total is None or excluded is None else total - excluded
    require(denominator is None or denominator >= 0, f"Negative burden denominator: {year} {puma}")
    require(numerator is None or denominator is None or numerator <= denominator,
            f"Burden numerator exceeds denominator: {year} {puma}")
    status = "missing_inputs" if numerator is None or denominator is None else "zero_denominator" if denominator == 0 else "ok"
    rent_cell = cells[(year, puma, "B25064_001E")]
    rent_lower, rent_upper, rent_display = rent_limits(rent_cell)
    row = {
        "year": year, "puma": puma, "puma_short": puma[-2:],
        "state_fips": geo["STATE"], "county_fips": geo["COUNTY"], "borough": geo["borough"],
        "boundary_vintage": 2000, "map_geoid": geo["map_geoid"], "acs_geoid": geo["GEOID"],
        "region": region_for(puma), "stusab": geo["STUSAB"].upper(), "logrecno": geo["LOGRECNO"],
        "housing_units": get("B25001_001"), "housing_units_moe90": get("B25001_001", "M"),
        "median_gross_rent": get("B25064_001"), "median_gross_rent_moe90": get("B25064_001", "M"),
        "median_gross_rent_status": rent_cell["status"],
        "median_gross_rent_lower_bound": rent_lower, "median_gross_rent_upper_bound": rent_upper,
        "median_gross_rent_display": rent_display,
        "cash_rent_households": total, "cash_rent_households_moe90": get("B25070_001", "M"),
        "rent_not_computed_households": excluded, "rent_not_computed_households_moe90": get("B25070_011", "M"),
        "rent_not_computed_pct": percentage(excluded, total),
        "rent_computable_households": denominator, "rent_burdened_households": numerator,
        "rent_burden_pct": percentage(numerator, denominator), "rent_burden_status": status,
    }
    issues = [f"{variable}{suffix}:{cells[(year, puma, variable + suffix)]['status']}"
              for variable in VARIABLES for suffix in "EM"
              if cells[(year, puma, variable + suffix)]["status"] != "ok"]
    if status != "ok":
        issues.append(f"rent_burden:{status}")
    row["data_complete"] = all(get(variable) is not None for variable in VARIABLES) and status == "ok"
    row["data_flags"] = "|".join(issues)
    # Category accounting is a separate check on correct table extraction.
    categories = complete_sum([get(f"B25070_{i:03d}") for i in range(2, 12)])
    require(categories is None or total is None or categories == total,
            f"B25070 categories do not sum to total: {year} {puma}: {categories} != {total}")
    return row


def make_comparisons(annual):
    by_key = {(r["year"], r["puma"]): r for r in annual}
    require(len(by_key) == len(annual), "Duplicate annual primary keys")
    result = []
    for end_year in YEARS[1:]:
        for puma in PUMAS:
            base, end = by_key[(2006, puma)], by_key[(end_year, puma)]
            row = {"base_year": 2006, "end_year": end_year, "years_elapsed": end_year - 2006,
                   **{k: base[k] for k in ("puma", "puma_short", "state_fips", "county_fips", "borough", "boundary_vintage", "map_geoid", "acs_geoid", "region")}}
            measures = ("housing_units", "housing_units_moe90", "median_gross_rent", "median_gross_rent_moe90",
                        "median_gross_rent_status", "median_gross_rent_lower_bound", "median_gross_rent_upper_bound", "median_gross_rent_display",
                        "cash_rent_households", "rent_not_computed_households", "rent_not_computed_pct",
                        "rent_computable_households", "rent_burdened_households", "rent_burden_pct")
            for measure in measures:
                row[measure + "_base"] = base[measure]
                row[measure + "_end"] = end[measure]
            housing_delta = None if base["housing_units"] is None or end["housing_units"] is None else end["housing_units"] - base["housing_units"]
            rent_delta = None if base["median_gross_rent"] is None or end["median_gross_rent"] is None else end["median_gross_rent"] - base["median_gross_rent"]
            row["housing_units_change"] = housing_delta
            row["housing_growth_pct"] = percentage(housing_delta, base["housing_units"])
            row["median_gross_rent_change_nominal_usd"] = rent_delta
            row["rent_growth_nominal_pct"] = percentage(rent_delta, base["median_gross_rent"])
            base_low, base_high = base["median_gross_rent_lower_bound"], base["median_gross_rent_upper_bound"]
            end_low, end_high = end["median_gross_rent_lower_bound"], end["median_gross_rent_upper_bound"]
            lower = None if end_low is None or base_high is None or base_high <= 0 else round(100 * (end_low / base_high - 1), 6)
            upper = None if end_high is None or base_low is None or base_low <= 0 else round(100 * (end_high / base_low - 1), 6)
            row["rent_growth_nominal_pct_lower_bound"] = lower
            row["rent_growth_nominal_pct_upper_bound"] = upper
            growth_status = "exact" if row["rent_growth_nominal_pct"] is not None else "lower_bound" if lower is not None and upper is None else "upper_bound" if upper is not None and lower is None else "interval" if lower is not None and upper is not None else "unavailable"
            row["rent_growth_status"] = growth_status
            # Difference of percentages is in percentage points, not percent growth.
            burden_delta = None if base["rent_burden_pct"] is None or end["rent_burden_pct"] is None else end["rent_burden_pct"] - base["rent_burden_pct"]
            row["rent_burden_change_pp"] = None if burden_delta is None else round(burden_delta, 6)
            flags = [prefix + flag for prefix, source in (("base:", base), ("end:", end)) for flag in source["data_flags"].split("|") if flag]
            if row["housing_growth_pct"] is None:
                flags.append("housing_growth_pct:unavailable_or_zero_base")
            if row["rent_growth_nominal_pct"] is None:
                flags.append("rent_growth_nominal_pct:" + growth_status)
            row["data_complete"] = base["data_complete"] and end["data_complete"] and all(row[name] is not None for name in ("housing_growth_pct", "rent_growth_nominal_pct"))
            row["data_flags"] = "|".join(flags)
            result.append(row)
    return result


class SourceRegistry:
    def __init__(self, project):
        self.project = project
        self.entries = {}

    def add(self, path, role, **extra):
        data = path.read_bytes()
        key = path.resolve().relative_to(self.project.resolve()).as_posix()
        self.entries[key] = {"path": key, "role": role, "bytes": len(data),
                             "sha256": hashlib.sha256(data).hexdigest(), **extra}
        return data


def load_geography(project, registry):
    path = project / "geography_supplement/nyc_puma_geography_2006_2011.csv"
    registry.add(path, "Existing annual geography join table")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        geography = [r for r in csv.DictReader(handle) if r["PUMA"] in PUMAS and int(r["YEAR"]) in YEARS]
    require(len(geography) == 60, "Expected 60 Manhattan geography rows")
    require(len({(r["YEAR"], r["PUMA"]) for r in geography}) == 60, "Duplicate geography keys")
    for year in YEARS:
        raw_path = project / "2005_2011_raw_data" / str(year) / f"g{year}1ny.txt"
        raw = registry.add(raw_path, "Original annual ACS geography index", year=year)
        indexed = {}
        for line in raw.decode("ascii").splitlines():
            if line[8:11] == "795" and line[11:13] == "00":
                match = re.search(r"79500US36(\d{5})", line)
                require(match is not None, f"Malformed PUMA geography: {raw_path}")
                puma = match.group(1)
                require(puma not in indexed, f"Duplicate raw PUMA geography: {year} {puma}")
                indexed[puma] = line[13:20]
        selected = [r for r in geography if int(r["YEAR"]) == year]
        require({r["PUMA"] for r in selected} == set(PUMAS), f"Incomplete geography: {year}")
        for row in selected:
            require(row["LOGRECNO"] == indexed[row["PUMA"]], f"Geography index mismatch: {year} {row['PUMA']}")
            require(row["STATE"] == "36" and row["COUNTY"] == "061" and row["borough"] == "Manhattan" and row["STUSAB"].upper() == "NY", "Unexpected geography")
            require(row["map_geoid"] == "36" + row["PUMA"] and row["GEOID"] == "79500US36" + row["PUMA"] and row["boundary_vintage"] == "2000", "Unexpected map identifiers or boundary vintage")
    return sorted(geography, key=lambda r: (int(r["YEAR"]), r["PUMA"]))


def normalized_label(text):
    return text.strip().rstrip(":").lower()


def validate_layouts(root, registry):
    registry.add(root / "sources/download_manifest.json", "Official metadata download manifest")
    manifest = read_json(root / "sources/download_manifest.json")
    for source in manifest["sources"]:
        data = registry.add(root / source["path"], source["role"], source_url=source["url"], year=source["year"])
        require(hashlib.sha256(data).hexdigest() == source["sha256"], f"Official metadata changed: {source['path']}")
    layout_path = root / "sources/selected_variable_layouts.json"
    registry.add(layout_path, "Normalized year-variable positions from official sequence lookups")
    layouts = read_json(layout_path)
    expected = {(year, variable) for year in YEARS for variable in VARIABLES}
    require(len(layouts) == 78 and {(x["year"], x["variable"]) for x in layouts} == expected, "Incomplete/duplicate variable layouts")
    metadata = {(year, table): read_json(root / f"sources/api_metadata/{year}_{table}.json")["variables"]
                for year in YEARS for table in ("B25001", "B25064", "B25070")}
    for layout in layouts:
        variable, year = layout["variable"], layout["year"]
        expected_label = EXPECTED_LABELS[variable]
        require(normalized_label(layout["lookup_label"]) == normalized_label(expected_label), f"Lookup category changed: {year} {variable}")
        for suffix in "EM":
            entry = metadata[(year, layout["table"])][variable + suffix]
            require(normalized_label(entry["label"].split("!!")[-1]) == normalized_label(expected_label), f"API definition differs: {year} {variable}{suffix}")
            require(entry.get("group") == layout["table"], f"Wrong API table: {year} {variable}")
    return layouts, metadata


def archive_member(archive, year, seq, filename):
    """Read both flat archives and the nested per-sequence ZIPs used in 2007/08."""
    direct = [name for name in archive.namelist() if name.rsplit("/", 1)[-1] == filename]
    if direct:
        require(len(direct) == 1, f"Ambiguous archive member: {filename}")
        return archive.read(direct[0]), direct[0]
    nested_name = f"{year}1ny{seq}000.zip"
    members = [name for name in archive.namelist() if name.rsplit("/", 1)[-1] == nested_name]
    require(len(members) == 1, f"Missing/ambiguous nested archive: {nested_name}")
    with zipfile.ZipFile(io.BytesIO(archive.read(members[0]))) as nested:
        candidates = [name for name in nested.namelist() if name.rsplit("/", 1)[-1] == filename]
        require(len(candidates) == 1, f"Missing/ambiguous nested source: {filename}")
        return nested.read(candidates[0]), members[0] + "!" + candidates[0]


def extract_cells(project, geography, layouts, metadata, registry):
    targets = {(int(r["YEAR"]), r["STUSAB"].upper(), r["LOGRECNO"]): r["PUMA"] for r in geography}
    grouped = defaultdict(list)
    for layout in layouts:
        grouped[(layout["year"], layout["sequence"])].append(layout)
    cells, audit, file_checks = {}, [], []
    for year in YEARS:
        archive_path = project / "2005_2011_raw_data" / ARCHIVES[year]
        registry.add(archive_path, "User-supplied original archive for byte-level input verification", year=year)
        with zipfile.ZipFile(archive_path) as archive:
            for (group_year, sequence), columns in sorted(grouped.items()):
                if group_year != year:
                    continue
                for kind in "em":
                    filename = f"{kind}{year}1ny{sequence}000.txt"
                    path = project / "2005_2011_raw_data" / str(year) / filename
                    data = registry.add(path, "Original ACS estimate file" if kind == "e" else "Original ACS margin-of-error file", year=year, sequence=sequence)
                    archived_data, member = archive_member(archive, year, sequence, filename)
                    require(data == archived_data, f"Raw file differs from original archive: {filename}")
                    seen, selected = set(), set()
                    for line_number, row in enumerate(csv.reader(io.StringIO(data.decode("ascii"))), 1):
                        require(len(row) >= 7, f"Short source row: {filename}:{line_number}")
                        require(row[0] == "ACSSF" and row[1] == f"{year}{kind}1" and row[2].upper() == "NY" and row[3] == "000" and row[4].zfill(4) == sequence, f"Wrong source header: {filename}:{line_number}")
                        logrecno = row[5].zfill(7)
                        require(logrecno not in seen, f"Duplicate LOGRECNO: {filename}:{line_number}")
                        seen.add(logrecno)
                        puma = targets.get((year, row[2].upper(), logrecno))
                        if puma is None:
                            continue
                        selected.add(puma)
                        for layout in columns:
                            column = layout["source_column_1based"]
                            require(column <= len(row), f"Column out of range: {filename}:{column}")
                            variable = layout["variable"] + kind.upper()
                            value, status = parse_cell(row[column - 1], variable)
                            key = (year, puma, variable)
                            require(key not in cells, f"Duplicate extracted cell: {key}")
                            entry = {"year": year, "puma": puma, "variable": variable, "value": value,
                                     "raw_value": row[column - 1], "status": status, "sequence": sequence,
                                     "logrecno": logrecno, "source_file": path.relative_to(project).as_posix(),
                                     "source_line_1based": line_number, "source_column_1based": column,
                                     "lookup_label": layout["lookup_label"],
                                     "api_label": metadata[(year, layout["table"])][variable]["label"]}
                            cells[key] = entry
                            audit.append(entry)
                    require(selected == set(PUMAS), f"Missing Manhattan PUMAs in {filename}: {set(PUMAS) - selected}")
                    file_checks.append({"file": path.relative_to(project).as_posix(), "source_rows": len(seen),
                                        "selected_pumas": len(selected), "archive": archive_path.relative_to(project).as_posix(),
                                        "archive_member": member, "bytes_match_archive": True})
    require(len(cells) == 1560, f"Expected 60 x 13 x 2 = 1560 extracted cells, got {len(cells)}")
    return cells, sorted(audit, key=lambda r: (r["year"], r["puma"], r["variable"])), file_checks


def build_map(project, registry):
    path = project / "geography_supplement/nyc_puma_2000.geojson"
    registry.add(path, "Existing Census 2000 PUMA geometry; subset only, no simplification")
    source = read_json(path)
    features = [f for f in source["features"] if f["properties"]["PUMA"] in PUMAS]
    require(len(features) == 10 and {f["properties"]["PUMA"] for f in features} == set(PUMAS), "Map join incomplete")
    for feature in features:
        props = feature["properties"]
        require(props["GEOID"] == "36" + props["PUMA"] and props["boundary_vintage"] == 2000, "Wrong map boundary vintage/key")
        props["region"] = region_for(props["PUMA"])
    return {"type": "FeatureCollection", "name": "Manhattan Census 2000 PUMAs for ACS 2006-2011",
            "source": source.get("source"), "features": sorted(features, key=lambda f: f["properties"]["PUMA"])}


def data_dictionary(annual, comparisons):
    definitions = {
        "year": ("integer", "year", "ACS 1-year estimate reference year, 2006-2011"),
        "base_year": ("integer", "year", "Always 2006; never the preceding year"),
        "end_year": ("integer", "year", "Selected comparison endpoint: 2007, 2008, 2009, 2010 or 2011"),
        "years_elapsed": ("integer", "years", "end_year - 2006; growth is cumulative, not annualized"),
        "puma": ("string", "identifier", "Five-character Census 2000 PUMA code; preserve leading zero"),
        "puma_short": ("string", "label", "Two-character shorthand 01-10; use puma for joins"),
        "state_fips": ("string", "identifier", "36 = New York"),
        "county_fips": ("string", "identifier", "061 = New York County (Manhattan)"),
        "borough": ("string", "category", "Manhattan"),
        "boundary_vintage": ("integer", "year", "2000 for all years; no 2010/2020 PUMA boundaries"),
        "map_geoid": ("string", "identifier", "36 + puma; join GeoJSON properties.GEOID or feature.id"),
        "acs_geoid": ("string", "identifier", "79500US36 + puma; ACS geography identifier"),
        "region": ("string", "category", "Project groups: Uptown 03801-03806; Midtown 03807-03808; Downtown 03809-03810"),
        "stusab": ("string", "identifier", "NY; normalized to upper case"),
        "logrecno": ("string", "identifier", "Seven-character annual geography record number; only join within its own year"),
        "housing_units": ("integer|null", "housing units", "B25001_001E; occupied plus vacant housing stock, not new construction"),
        "median_gross_rent": ("integer|null", "nominal USD per month", "B25064_001E; annual current-dollar median gross rent, including applicable utilities"),
        "median_gross_rent_status": ("string", "status", "ok, top_coded_ge_2000, bottom_coded_le_100, or unavailable-cell reason. Positive median jam codes are not exact dollar values"),
        "median_gross_rent_lower_bound": ("integer|null", "nominal USD per month", "Exact rent when available; 2000 for a 2001 top-code. Not a confidence bound"),
        "median_gross_rent_upper_bound": ("integer|null", "nominal USD per month", "Exact rent when available; null means no finite published upper bound for a top-coded median. Not a confidence bound"),
        "median_gross_rent_display": ("string", "display", "Exact dollar number, >=2000, <=100, or empty when unavailable"),
        "cash_rent_households": ("integer|null", "renter households", "B25070_001E; cash-rent renter-occupied housing units, including Not computed"),
        "rent_not_computed_households": ("integer|null", "renter households", "B25070_011E; retained, never treated as unburdened"),
        "rent_not_computed_pct": ("number|null", "percent", "100 * B25070_011E / B25070_001E"),
        "rent_computable_households": ("integer|null", "renter households", "B25070_001E - B25070_011E; rent-burden denominator"),
        "rent_burdened_households": ("integer|null", "renter households", "Sum B25070_007E through B25070_010E; gross rent at least 30% of income"),
        "rent_burden_pct": ("number|null", "percent", "100 * rent_burdened_households / rent_computable_households"),
        "rent_burden_status": ("string", "status", "ok, missing_inputs or zero_denominator"),
        "housing_units_change": ("integer|null", "housing units", "housing_units_end - housing_units_base; net stock estimate difference"),
        "housing_growth_pct": ("number|null", "percent", "100 * (housing_units_end - housing_units_base) / housing_units_base"),
        "median_gross_rent_change_nominal_usd": ("integer|null", "nominal USD per month", "median_gross_rent_end - median_gross_rent_base"),
        "rent_growth_nominal_pct": ("number|null", "percent", "100 * (median_gross_rent_end - median_gross_rent_base) / median_gross_rent_base"),
        "rent_growth_nominal_pct_lower_bound": ("number|null", "percent", "100 * (rent_end_lower_bound / rent_base_upper_bound - 1); equals exact growth when both rents are exact. Bound from top/bottom coding, not a confidence limit"),
        "rent_growth_nominal_pct_upper_bound": ("number|null", "percent", "100 * (rent_end_upper_bound / rent_base_lower_bound - 1); null means no finite computable bound. Not a confidence limit"),
        "rent_growth_status": ("string", "status", "exact, lower_bound, upper_bound, interval, unavailable; never draw a lower bound as an unqualified exact point"),
        "rent_burden_change_pp": ("number|null", "percentage points", "rent_burden_pct_end - rent_burden_pct_base; not a percentage growth rate"),
        "data_complete": ("boolean", "status", "All 13 estimates are exact numeric values and burden ratio available; comparison also requires nonzero growth bases. Censored rent rows remain in both tables with bounds. MOE availability is recorded separately in data_flags"),
        "data_flags": ("string", "status", "Pipe-separated unavailable-cell/derived-value reasons; empty string means no flags"),
    }
    result = {}
    for table_name, rows in (("annual", annual), ("comparisons", comparisons)):
        fields = []
        for name in rows[0]:
            stem, suffix = name, ""
            for ending in ("_base", "_end"):
                if stem.endswith(ending):
                    stem, suffix = stem[:-len(ending)], " At " + ("2006 baseline." if ending == "_base" else "end_year.")
                    break
            if stem.endswith("_moe90"):
                base_stem = stem[:-6]
                dtype, unit, definition = definitions[base_stem]
                definition = "Published 90% ACS margin of error for " + base_stem + "; not a confidence interval for a derived growth/ratio."
            else:
                dtype, unit, definition = definitions[stem]
            fields.append({"name": name, "type": dtype, "unit": unit, "definition": definition + suffix})
        result[table_name] = {"rows": len(rows), "primary_key": ["year", "puma"] if table_name == "annual" else ["base_year", "end_year", "puma"], "fields": fields}
    result["storage"] = {"csv": "UTF-8 with BOM; unavailable numeric values are empty fields; import identifiers as text in Excel",
                         "json": "UTF-8 without BOM; identifiers are strings, numeric missing values are null",
                         "percentage_precision": "Percentages are stored on a 0-100 scale, rounded to 6 decimal places. Do not multiply by 100 again.",
                         "uncertainty": "Published input MOEs are retained. Derived burden/growth MOEs are not calculated; do not reuse input MOEs as derived uncertainty."}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=ROOT)
    args = parser.parse_args()
    # Rebuilding legacy inputs must not leave an already extended dashboard
    # with only 2006-2011 comparison rows. Reapply the offline extension below.
    extend_after_build = (CURRENT_DATA_DIR / "manhattan_annual_2006_2025.json").exists()
    if extend_after_build:
        require(shutil.which("node") is not None, "Node.js is required to rebuild the extended 2006-2025 data")
    project = args.project_root.resolve()
    registry = SourceRegistry(project)
    layouts, metadata = validate_layouts(ROOT, registry)
    geography = load_geography(project, registry)
    cells, audit, file_checks = extract_cells(project, geography, layouts, metadata, registry)
    annual = [make_annual_row(geo, cells) for geo in geography]
    comparisons = make_comparisons(annual)
    require(len(annual) == 60 and len(comparisons) == 50, "Unexpected output row counts")
    for row in annual:
        require(row["rent_burden_pct"] is None or 0 <= row["rent_burden_pct"] <= 100, "Burden outside 0-100")
    for row in comparisons:
        require(row["base_year"] == 2006 and row["end_year"] in YEARS[1:], "Wrong comparison endpoints")
    require(len({(r["base_year"], r["end_year"], r["puma"]) for r in comparisons}) == 50, "Duplicate comparison keys")
    map_data = build_map(project, registry)
    data_dir, validation_dir = DATA_DIR, ROOT / "validation"
    for stem, rows in (("manhattan_annual_2006_2011", annual), ("manhattan_comparisons_from_2006", comparisons)):
        write_csv(data_dir / (stem + ".csv"), rows)
        write_json(data_dir / (stem + ".json"), rows)
    write_json(CURRENT_DATA_DIR / "manhattan_puma_2000.geojson", map_data)
    write_json(data_dir / "data_dictionary.json", data_dictionary(annual, comparisons))
    write_csv(validation_dir / "acs_cell_audit.csv", audit)
    special = [r for r in audit if r["status"] != "ok"]
    write_json(validation_dir / "special_values.json", special)
    available_api_files = list((ROOT / "sources/api_checks").glob("*_ny_pumas.json"))
    api_checked = 0
    for path in available_api_files:
        registry.add(path, "Optional independent Census API value check")
        matrix = read_json(path)
        year = int(path.name[:4])
        for raw in matrix[1:]:
            row = dict(zip(matrix[0], raw))
            puma = row["public use microdata area"]
            if puma not in PUMAS:
                continue
            for variable in VARIABLES:
                for suffix in "EM":
                    value, _ = parse_cell(row[variable + suffix] or "", variable + suffix)
                    require(value == cells[(year, puma, variable + suffix)]["value"], f"API value mismatch: {year} {puma} {variable}{suffix}")
                    api_checked += 1
    created = datetime.now(timezone.utc).isoformat()
    report = {
        "generated_at_utc": created, "status": "passed_with_censored_rents_and_unavailable_moes" if special else "passed",
        "annual_rows": len(annual), "comparison_rows": len(comparisons),
        "annual_primary_keys_unique": True, "comparison_primary_keys_unique": True,
        "pumas_per_year": dict(sorted(Counter(r["year"] for r in annual).items())),
        "pumas_per_endpoint": dict(sorted(Counter(r["end_year"] for r in comparisons).items())),
        "all_comparisons_use_2006_baseline": True, "map_features": len(map_data["features"]),
        "all_annual_and_comparison_map_joins_match": True,
        "raw_cells_extracted": len(audit), "cell_status_counts": dict(Counter(r["status"] for r in audit)),
        "unavailable_estimates": sum(r["status"] != "ok" and r["variable"].endswith("E") for r in audit),
        "unavailable_moes": sum(r["status"] != "ok" and r["variable"].endswith("M") for r in audit),
        "censored_median_rents": sum(r["status"] in {"top_coded_ge_2000", "bottom_coded_le_100"} for r in audit),
        "rent_growth_status_counts": dict(Counter(r["rent_growth_status"] for r in comparisons)),
        "complete_annual_rows": sum(r["data_complete"] for r in annual),
        "complete_comparison_rows": sum(r["data_complete"] for r in comparisons),
        "b25070_category_sum_checks_passed": sum(all(cells[(r["year"], r["puma"], f"B25070_{i:03d}E")]["value"] is not None for i in range(1, 12)) for r in annual),
        "annual_geography_crosschecked_against_raw_indexes": True,
        "year_variable_layouts_verified_against_api_definitions": len(layouts),
        "source_files_verified_against_original_archives": len(file_checks), "source_file_checks": file_checks,
        "independent_api_values_checked": api_checked,
        "independent_api_note": "No independent API value verification performed: unauthenticated requests redirected to Census missing_key.html. Local source bytes were verified against original user-supplied ZIPs; layouts and category meanings were checked against official annual metadata." if not api_checked else "See cached API data responses and per-cell equality checks.",
        "numeric_ranges": {name: {"min": min(r[name] for r in annual if r[name] is not None), "max": max(r[name] for r in annual if r[name] is not None)} for name in ("housing_units", "median_gross_rent", "rent_burden_pct")},
        "interpretation_notes": ["B25064_001E=2001 is a jam code meaning at least $2000, not an exact $2001 rent. Exact rent and exact rent growth are null; lower bounds and raw codes are retained.", "Nominal rents, not inflation-adjusted across years.", "Housing growth is cumulative net stock change from 2006, not construction or year-on-year growth.", "2009-2010 population-control changes require caution; boundaries stay Census 2000.", "ACS samples and changing area composition do not identify causal effects or same-unit rent increases.", "Derived percentage/change MOEs are not calculated; input MOEs are retained."],
    }
    write_json(validation_dir / "validation_report.json", report)
    write_json(validation_dir / "source_manifest.json", {"generated_at_utc": created, "sources": sorted(registry.entries.values(), key=lambda r: r["path"])})
    print(json.dumps({k: report[k] for k in ("status", "annual_rows", "comparison_rows", "raw_cells_extracted", "unavailable_estimates", "unavailable_moes", "complete_annual_rows", "complete_comparison_rows", "source_files_verified_against_original_archives")}, indent=2))
    if extend_after_build:
        subprocess.run([shutil.which("node"), str(Path(__file__).with_name("extend_data.mjs"))], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
