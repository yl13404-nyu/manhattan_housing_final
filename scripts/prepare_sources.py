# This file was developed with assistance from Codex.

"""Cache official ACS metadata and independent API checks for data preparation.

Run once with network access. Ordinary rebuilds use build_data.py offline.
Only pandas (for the two legacy SAS lookup files) is a non-stdlib dependency.
Original files in 2005_2011_raw_data and geography_supplement are read-only inputs.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2] / "03_Supporting_Not_For_Upload"
SOURCES = ROOT / "sources"
TABLES = {"B25001": [1], "B25064": [1], "B25070": list(range(1, 12))}
LOOKUP_URLS = {
    2006: "https://www2.census.gov/acs2006/merge_5_6_final.txt",
    2007: "https://www2.census.gov/acs2007_1yr/summaryfile/merge_5_6_final.sas7bdat",
    2008: "https://www2.census.gov/programs-surveys/acs/summary_file/2008/documentation/1_year/user_tools/merge_5_6.sas7bdat",
    2009: "https://www2.census.gov/acs2009_1yr/summaryfile/UserTools/merge_5_6.txt",
    2010: "https://www2.census.gov/acs2010_1yr/summaryfile/Sequence_Number_and_Table_Number_Lookup.txt",
    2011: "https://www2.census.gov/programs-surveys/acs/summary_file/2011/documentation/1_year/user_tools/Sequence_Number_and_Table_Number_Lookup.txt",
}
TECH_DOCS = {
    2007: "https://www2.census.gov/acs2007_1yr/summaryfile/ACS_2007_SF_Tech_Doc.pdf",
    2009: "https://www2.census.gov/acs2009_5yr/summaryfile/ACS_2005-2009_SF_Tech_Doc.pdf",
    2010: "https://www2.census.gov/acs2010_1yr/summaryfile/ACS_2010_SF_Tech_Doc.pdf",
    2011: "https://www2.census.gov/acs2011_1yr/summaryfile/ACS_2011_SF_Tech_Doc.pdf",
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def download(path, url, role, year, refresh):
    if refresh or not path.exists():
        for attempt in range(3):
            try:
                with urlopen(Request(url, headers={"User-Agent": "ManhattanHousingCourseProject/1.0"}), timeout=45) as response:
                    data = response.read()
                    resolved_url = response.url
                if not data or data.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                    raise ValueError(f"Expected data, received HTML or empty response: {url}")
                if path.suffix == ".json":
                    parsed = json.loads(data)
                    if role == "ACS API group metadata":
                        if "variables" not in parsed:
                            raise ValueError(f"Unexpected metadata response: {url}")
                    elif not isinstance(parsed, list) or len(parsed) < 2:
                        raise ValueError(f"Unexpected API data response: {url}")
                if path.suffix == ".pdf" and not data.startswith(b"%PDF"):
                    raise ValueError(f"Expected PDF documentation: {url}")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    else:
        data = path.read_bytes()
        resolved_url = None
    return {
        "path": path.relative_to(ROOT).as_posix(), "url": url,
        "resolved_url": resolved_url, "year": year, "role": role,
        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
    }


def lookup_records(path):
    if path.suffix == ".sas7bdat":
        import pandas as pd

        frame = pd.read_sas(path, format="sas7bdat", encoding="latin-1")
        return [{str(k).strip().lower(): v for k, v in row.items()} for row in frame.to_dict("records")]
    try:
        content = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        content = path.read_text(encoding="cp1252")
    reader = csv.DictReader(io.StringIO(content), delimiter="\t" if "\t" in content.splitlines()[0] else ",")
    aliases = {"table id": "tblid", "sequence number": "seq", "line number": "order",
               "line number decimal m lines": "order", "start position": "position",
               "table title": "title", "long table title": "title"}
    return [{aliases.get(str(k).strip().lower(), str(k).strip().lower()): v for k, v in row.items()} for row in reader]


def number(value):
    text = str(value).strip()
    if text in {"", ".", "nan", "None"}:
        return None
    return float(text)


def normalize_layouts():
    layouts = []
    for year, url in LOOKUP_URLS.items():
        path = SOURCES / "lookups" / f"{year}_{url.rsplit('/', 1)[-1]}"
        records = lookup_records(path)
        for table, line_numbers in TABLES.items():
            rows = [r for r in records if str(r.get("tblid", r.get("table id", ""))).strip() == table]
            if not rows:
                raise ValueError(f"Cannot locate {table} in {path}; columns: {list(records[0])}")
            starts = [r for r in rows if (number(r.get("position")) or 0) > 0]
            if len(starts) != 1:
                raise ValueError(f"Expected one table start for {year} {table}: {starts}")
            start_row = starts[0]
            seq = int(number(start_row.get("seq", start_row.get("sequence number"))))
            position = int(number(start_row.get("position", start_row.get("start position"))))
            for line in line_numbers:
                candidates = [r for r in rows if number(r.get("order", r.get("line number"))) == line]
                if len(candidates) != 1:
                    raise ValueError(f"Expected one label for {year} {table} line {line}: {candidates}")
                label = str(candidates[0].get("title", candidates[0].get("table title", ""))).strip()
                layouts.append({
                    "year": year, "table": table, "line": line,
                    "variable": f"{table}_{line:03d}", "sequence": f"{seq:04d}",
                    "table_start_column_1based": position,
                    "source_column_1based": position + line - 1,
                    "lookup_label": label,
                    "lookup_file": path.relative_to(ROOT).as_posix(),
                })
    write_json(SOURCES / "selected_variable_layouts.json", layouts)
    with (SOURCES / "selected_variable_layouts.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(layouts[0]))
        writer.writeheader()
        writer.writerows(layouts)
    return layouts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Re-download cached official sources")
    parser.add_argument("--normalize-only", action="store_true", help="Rebuild selected layouts without downloading")
    parser.add_argument("--api-checks", action="store_true", help="Try optional API data cross-checks (Census may require an API key)")
    args = parser.parse_args()
    if not args.normalize_only:
        jobs = []
        for year, url in TECH_DOCS.items():
            jobs.append((SOURCES / "technical_docs" / url.rsplit('/', 1)[-1], url, "Official median jam-value documentation (2009 document is the 5-year technical guide, used only for code meanings)", year))
        for year, url in LOOKUP_URLS.items():
            jobs.append((SOURCES / "lookups" / f"{year}_{url.rsplit('/', 1)[-1]}", url, "ACS 1-year sequence/table lookup", year))
            for table in TABLES:
                jobs.append((SOURCES / "api_metadata" / f"{year}_{table}.json", f"https://api.census.gov/data/{year}/acs/acs1/groups/{table}.json", "ACS API group metadata", year))
            variables = [f"{table}_{line:03d}{suffix}" for table, lines in TABLES.items() for line in lines for suffix in "EM"]
            query = urlencode({"get": ",".join(["NAME", *variables]), "for": "public use microdata area:*", "in": "state:36"})
            if args.api_checks:
                jobs.append((SOURCES / "api_checks" / f"{year}_ny_pumas.json", f"https://api.census.gov/data/{year}/acs/acs1?{query}", "Independent ACS API values for extraction verification", year))
        manifest = []
        optional_failures = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(download, *job, args.refresh): job for job in jobs}
            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as exc:
                    job = futures[future]
                    if job[2] != "Independent ACS API values for extraction verification":
                        raise
                    optional_failures.append({"year": job[3], "url": job[1], "error": str(exc)})
                    continue
                manifest.append(result)
                print(f"Cached {result['path']} ({result['bytes']} bytes)", flush=True)
        write_json(SOURCES / "download_manifest.json", {
            "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
            "sources": sorted(manifest, key=lambda x: x["path"]),
            "optional_api_check_failures": optional_failures,
            "api_value_check_note": "API values are optional. On 2026-11-11 unauthenticated data requests redirected to missing_key.html; metadata remained accessible. No API value verification is claimed unless cached data responses exist.",
        })
    layouts = normalize_layouts()
    print(f"Normalized {len(layouts)} year-variable layouts.")


if __name__ == "__main__":
    main()
