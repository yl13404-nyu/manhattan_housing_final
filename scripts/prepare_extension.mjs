// Cache official annual layouts, variable definitions, and geography names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../03_Supporting_Not_For_Upload');
const jobs = [];
const add = (relative, url, role, year) => jobs.push({ path: relative, url, role, year });
for (const year of [2012,2013,2014,2015,2016,2017,2018,2019,2021]) {
  const prefix = `https://www2.census.gov/programs-surveys/acs/summary_file/${year}/`;
  const location = year === 2012 ? 'documentation/1_year/user_tools/Sequence_Number_and_Table_Number_Lookup.txt'
    : year === 2021 ? 'sequence-based-SF/documentation/user_tools/ACS_1yr_Seq_Table_Number_Lookup.txt'
    : 'documentation/user_tools/ACS_1yr_Seq_Table_Number_Lookup.txt';
  add(`sources/extension/lookups/${year}.txt`, prefix + location, 'Official ACS 1-year sequence lookup', year);
}
for (const year of [2022,2023,2024,2025]) {
  add(`sources/extension/geography/Geos${year}1YR.txt`, `https://www2.census.gov/programs-surveys/acs/summary_file/${year}/table-based-SF/documentation/Geos${year}1YR.txt`, 'Official table-based geography names', year);
}
for (let year = 2012; year <= 2025; year++) {
  if (year === 2020) continue;
  for (const table of ['B25001','B25063','B25064','B25070']) add(`sources/extension/api_metadata/${year}_${table}.json`, `https://api.census.gov/data/${year}/acs/acs1/groups/${table}.json`, 'Official ACS variable definitions', year);
}
add('sources/extension/2015_table_changes.html', 'https://www.census.gov/programs-surveys/acs/technical-documentation/table-and-geography-changes/2015/1-year.html', '2015 median rent top category change', 2015);
const results = [];
const errors = [];
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    try {
      const dest = path.join(root, job.path);
      if (!fs.existsSync(dest)) {
        const response = await fetch(job.url, { signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (job.path.endsWith('.json') && !JSON.parse(bytes).variables) throw new Error('Missing variables');
        if (job.path.endsWith('.txt') && /^\s*<(?:!doctype|html)/i.test(bytes.toString())) throw new Error('HTML instead of data');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
      }
      const bytes = fs.readFileSync(dest);
      results.push({ ...job, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) { errors.push({ ...job, error: error.message }); }
  }
}
await Promise.all(Array.from({length: 5}, worker));
fs.mkdirSync(path.join(root, 'sources/extension'), {recursive:true});
fs.writeFileSync(path.join(root, 'sources/extension/download_manifest.json'), JSON.stringify({ sources: results.sort((a,b)=>a.path.localeCompare(b.path)), errors }, null, 2)+'\n');
console.log(JSON.stringify({cached: results.length, errors},null,2));
if (errors.length) process.exitCode = 1;
