/** Extend the existing ACS extract offline. Node 20+, standard library only.
 * Source PUMAs are paired to project display IDs by district/name only.
 * No boundary interpolation, weighting, spatial crosswalk, or imputation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../03_Supporting_Not_For_Upload');
export const YEARS = Array.from({length:20},(_,i)=>2006+i).filter(y=>y!==2020);
export const PUMAS = Array.from({length:10},(_,i)=>`038${String(i+1).padStart(2,'0')}`);
const VARIABLES = ['B25001_001','B25064_001',...Array.from({length:11},(_,i)=>`B25070_${String(i+1).padStart(3,'0')}`)];
// Explicit display pairing, not a claim that the polygons are equivalent.
const SOURCE_2020_TO_PROJECT = {'04112':'03801','04109':'03802','04110':'03803','04111':'03804','04108':'03805','04107':'03806','04104':'03807','04165':'03808','04103':'03809','04121':'03810'};
const DATA = '../02_Data_and_Code/data';
const LEGACY_DATA = 'legacy_data';
const LEGACY = 'validation/legacy_2006_2011';
const read = p => fs.readFileSync(path.join(ROOT,p));
const json = p => JSON.parse(read(p).toString('utf8').replace(/^\uFEFF/,''));
const writeJSON = (p,v) => {fs.mkdirSync(path.dirname(path.join(ROOT,p)),{recursive:true});fs.writeFileSync(path.join(ROOT,p),JSON.stringify(v,null,2)+'\n');};
export function parseDelimited(text, delimiter=',') {
  text = text.replace(/^\uFEFF/,'');
  const rows=[]; let row=[], cell='', quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===delimiter&&!quoted){row.push(cell);cell='';}
    else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  assert.equal(quoted,false,'Unterminated quoted field');
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows;
}
const objects = (text,delimiter=',') => {const [header,...rows]=parseDelimited(text,delimiter);return rows.map(r=>Object.fromEntries(header.map((h,i)=>[h,r[i]??''])));};
function writeCSV(p,rows) {
  assert.ok(rows.length); const keys=Object.keys(rows[0]);
  const encode=v=>{const s=v===null||v===undefined?'':typeof v==='boolean'?(v?'True':'False'):String(v);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
  fs.mkdirSync(path.dirname(path.join(ROOT,p)),{recursive:true});
  fs.writeFileSync(path.join(ROOT,p),'\uFEFF'+[keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(encode).join(',')).join('\r\n')+'\r\n');
}
export function parseCell(raw,variable,year) {
  const token=String(raw??'').trim();
  if(!token)return {value:null,status:'empty'};
  if(token==='.')return {value:null,status:'not_available_dot'};
  if(!/^[+-]?\d+(?:\.0+)?$/.test(token))return {value:null,status:`special_token:${token}`};
  const value=Number(token);assert.ok(Number.isSafeInteger(value),`Invalid integer ${token}`);
  if(value<0)return {value:null,status:`negative_special_code:${token}`};
  if(variable==='B25064_001E') {
    const upper=year>=2015?3500:2000;
    if(value===upper+1)return {value:null,status:`top_coded_ge_${upper}`};
    if(value===99)return {value:null,status:'bottom_coded_le_100'};
  }
  return {value,status:'ok'};
}
const round=n=>Number(n.toFixed(6));
const pct=(n,d)=>n===null||d===null||d<=0?null:round(100*n/d);
const sum=vs=>vs.some(v=>v===null)?null:vs.reduce((a,b)=>a+b,0);
const region=p=>['03809','03810'].includes(p)?'Downtown':['03807','03808'].includes(p)?'Midtown':'Uptown';
const normalized=s=>s.trim().replace(/:$/,'').toLowerCase();

// Central-directory ZIP reader for the flat Census state archives (stored/deflate).
function zipEntries(buffer) {
  let end=buffer.length-22;while(end>=Math.max(0,buffer.length-65557)&&buffer.readUInt32LE(end)!==0x06054b50)end--;
  assert.ok(end>=0,'Missing ZIP directory');
  const entries=new Map();let pos=buffer.readUInt32LE(end+16);
  for(let i=0;i<buffer.readUInt16LE(end+10);i++){
    assert.equal(buffer.readUInt32LE(pos),0x02014b50);
    const method=buffer.readUInt16LE(pos+10),size=buffer.readUInt32LE(pos+20),offset=buffer.readUInt32LE(pos+42);
    const nl=buffer.readUInt16LE(pos+28),el=buffer.readUInt16LE(pos+30),cl=buffer.readUInt16LE(pos+32);
    const name=buffer.subarray(pos+46,pos+46+nl).toString();
    entries.set(name,{method,size,offset});pos+=46+nl+el+cl;
  }
  return name=>{
    const names=[...entries.keys()].filter(n=>n.split('/').at(-1)===name);assert.equal(names.length,1,`ZIP member ${name}`);
    const e=entries.get(names[0]),p=e.offset;
    assert.equal(buffer.readUInt32LE(p),0x04034b50);
    const start=p+30+buffer.readUInt16LE(p+26)+buffer.readUInt16LE(p+28),data=buffer.subarray(start,start+e.size);
    assert.ok([0,8].includes(e.method));return e.method===8?inflateRawSync(data):data;
  };
}

function annualRow(geo,cells) {
  const get=(v,s='E')=>cells.get(v+s).value;
  const total=get('B25070_001'),excluded=get('B25070_011');
  const numerator=sum([7,8,9,10].map(i=>get(`B25070_${String(i).padStart(3,'0')}`)));
  const denominator=total===null||excluded===null?null:total-excluded;
  assert.ok(denominator===null||denominator>=0);assert.ok(numerator===null||denominator===null||numerator<=denominator);
  const rent=cells.get('B25064_001E');let low=rent.value,high=rent.value,display=rent.value===null?'':String(rent.value);
  if(rent.status.startsWith('top_coded_ge_')){low=Number(rent.status.split('_').at(-1));high=null;display=`>=${low}`;}
  if(rent.status==='bottom_coded_le_100'){low=0;high=100;display='<=100';}
  const status=numerator===null||denominator===null?'missing_inputs':denominator===0?'zero_denominator':'ok';
  const p=geo.puma;
  const row={year:geo.year,puma:p,puma_short:p.slice(-2),state_fips:'36',county_fips:'061',borough:'Manhattan',boundary_vintage:geo.boundary_vintage,map_geoid:'36'+p,acs_geoid:geo.acs_geoid,region:region(p),stusab:'NY',logrecno:geo.logrecno,
    housing_units:get('B25001_001'),housing_units_moe90:get('B25001_001','M'),median_gross_rent:get('B25064_001'),median_gross_rent_moe90:get('B25064_001','M'),median_gross_rent_status:rent.status,median_gross_rent_lower_bound:low,median_gross_rent_upper_bound:high,median_gross_rent_display:display,
    cash_rent_households:total,cash_rent_households_moe90:get('B25070_001','M'),rent_not_computed_households:excluded,rent_not_computed_households_moe90:get('B25070_011','M'),rent_not_computed_pct:pct(excluded,total),rent_computable_households:denominator,rent_burdened_households:numerator,rent_burden_pct:pct(numerator,denominator),rent_burden_status:status};
  const issues=[...cells].filter(([,c])=>c.status!=='ok').map(([v,c])=>`${v}:${c.status}`);
  if(status!=='ok')issues.push(`rent_burden:${status}`);
  row.data_complete=VARIABLES.every(v=>get(v)!==null)&&status==='ok';row.data_flags=issues.join('|');
  const categories=sum(Array.from({length:10},(_,i)=>get(`B25070_${String(i+2).padStart(3,'0')}`)));
  assert.ok(categories===null||total===null||categories===total,`Category accounting ${geo.year} ${p}`);
  assert.ok(row.rent_burden_pct===null||(row.rent_burden_pct>=0&&row.rent_burden_pct<=100));
  return {...row,source_puma:geo.source_puma,source_puma_name:geo.name,source_boundary_vintage:geo.boundary_vintage,map_boundary_vintage:2000,geography_alignment:geo.year>=2022?'name_district_pairing_no_boundary_adjustment':geo.year>=2012?'same_code_no_boundary_adjustment':'original_2000_puma'};
}
function makeComparisons(annual,legacyComparisons) {
  const byKey=new Map(annual.map(r=>[`${r.year}:${r.puma}`,r]));const rows=[];
  const measures=Object.keys(legacyComparisons[0]).filter(k=>k.endsWith('_base')).map(k=>k.slice(0,-5));
  for(const baseYear of YEARS.slice(0,-1))for(const year of YEARS.filter(y=>y>baseYear))for(const puma of PUMAS){
    const base=byKey.get(`${baseYear}:${puma}`),end=byKey.get(`${year}:${puma}`);assert.ok(base&&end);
    const row={base_year:baseYear,end_year:year,years_elapsed:year-baseYear};
    for(const k of ['puma','puma_short','state_fips','county_fips','borough','boundary_vintage','map_geoid','acs_geoid','region'])row[k]=base[k];
    for(const m of measures){row[m+'_base']=base[m];row[m+'_end']=end[m];}
    row.housing_units_change=base.housing_units===null||end.housing_units===null?null:end.housing_units-base.housing_units;
    row.housing_growth_pct=pct(row.housing_units_change,base.housing_units);
    row.median_gross_rent_change_nominal_usd=base.median_gross_rent===null||end.median_gross_rent===null?null:end.median_gross_rent-base.median_gross_rent;
    row.rent_growth_nominal_pct=pct(row.median_gross_rent_change_nominal_usd,base.median_gross_rent);
    const [bl,bh,el,eh]=[base.median_gross_rent_lower_bound,base.median_gross_rent_upper_bound,end.median_gross_rent_lower_bound,end.median_gross_rent_upper_bound];
    const lower=el===null||bh===null||bh<=0?null:round(100*(el/bh-1)),upper=eh===null||bl===null||bl<=0?null:round(100*(eh/bl-1));
    row.rent_growth_nominal_pct_lower_bound=lower;row.rent_growth_nominal_pct_upper_bound=upper;
    row.rent_growth_status=row.rent_growth_nominal_pct!==null?'exact':lower!==null&&upper===null?'lower_bound':upper!==null&&lower===null?'upper_bound':lower!==null&&upper!==null?'interval':'unavailable';
    row.rent_burden_change_pp=base.rent_burden_pct===null||end.rent_burden_pct===null?null:round(end.rent_burden_pct-base.rent_burden_pct);
    const flags=[];for(const [prefix,source]of [['base:',base],['end:',end]])for(const flag of source.data_flags.split('|').filter(Boolean))flags.push(prefix+flag);
    if(row.housing_growth_pct===null)flags.push('housing_growth_pct:unavailable_or_zero_base');
    if(row.rent_growth_nominal_pct===null)flags.push('rent_growth_nominal_pct:'+row.rent_growth_status);
    row.data_complete=base.data_complete&&end.data_complete&&row.housing_growth_pct!==null&&row.rent_growth_nominal_pct!==null;row.data_flags=flags.join('|');
    Object.assign(row,{source_puma_base:base.source_puma,source_puma_end:end.source_puma,source_puma_name_end:end.source_puma_name,source_boundary_vintage_base:base.source_boundary_vintage,source_boundary_vintage_end:end.source_boundary_vintage,map_boundary_vintage:2000,geography_alignment:end.geography_alignment});rows.push(row);
  }
  return rows;
}

function main() {
  // Preserve the original comparison/audit/dictionary as repeatable legacy inputs.
  for(const [src,name]of [[`${LEGACY_DATA}/manhattan_comparisons_from_2006.json`,'comparisons.json'],[`${LEGACY_DATA}/data_dictionary.json`,'data_dictionary.json'],['validation/acs_cell_audit.csv','acs_cell_audit.csv'],['validation/source_manifest.json','source_manifest.json'],['validation/validation_report.json','validation_report.json']]){
    const dest=path.join(ROOT,LEGACY,name);if(!fs.existsSync(dest)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(ROOT,src),dest);}
  }
  const originalAnnual=json(`${LEGACY_DATA}/manhattan_annual_2006_2011.json`),originalComparisons=json(`${LEGACY}/comparisons.json`);
  assert.equal(originalAnnual.length,60);assert.equal(originalComparisons.length,50);
  writeCSV(`${LEGACY}/comparisons.csv`,originalComparisons);
  // Keep the existing 2006-2011 prototype inputs intact; new tables are separate.
  writeJSON(`${LEGACY_DATA}/manhattan_comparisons_from_2006.json`,originalComparisons);
  writeCSV(`${LEGACY_DATA}/manhattan_comparisons_from_2006.csv`,originalComparisons);
  const manifest=new Map(),fileChecks=[],layouts=[],geography=[],audit=[];
  function source(p,role,extra={}){const b=read(p);manifest.set(p,{path:p,role,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),...extra});return b;}
  const official=json('sources/extension/download_manifest.json');assert.equal(official.errors.length,0);
  for(const item of official.sources){source(item.path,item.role,{url:item.url,year:item.year});assert.equal(manifest.get(item.path).sha256,item.sha256);}
  source(`${LEGACY_DATA}/manhattan_annual_2006_2011.json`,'Immutable validated 2006-2011 annual extract');source(`${LEGACY}/comparisons.json`,'Immutable original comparisons');
  const legacyGeos=objects(read('geography_supplement/nyc_puma_geography_2006_2011.csv').toString('utf8'));
  const annual=originalAnnual.map(r=>({...r,source_puma:r.puma,source_puma_name:legacyGeos.find(g=>Number(g.YEAR)===r.year&&g.PUMA===r.puma).NAME,source_boundary_vintage:2000,map_boundary_vintage:2000,geography_alignment:'original_2000_puma'}));
  const oldAudit=objects(source(`${LEGACY}/acs_cell_audit.csv`,'Immutable legacy cell audit').toString('utf8'));
  for(const r of oldAudit)audit.push({...r,year:Number(r.year),value:r.value===''?null:Number(r.value),source_line_1based:Number(r.source_line_1based),source_column_1based:Number(r.source_column_1based),source_puma:r.puma});
  for(const year of YEARS.filter(y=>y>=2012)){
    const metas=Object.fromEntries(['B25001','B25064','B25070'].map(t=>[t,json(`sources/extension/api_metadata/${year}_${t}.json`).variables]));
    const rentMeta=json(`sources/extension/api_metadata/${year}_B25063.json`).variables;
    const highest=Object.values(rentMeta).find(v=>/With cash rent.*\$[\d,]+ or more/.test(v.label));
    assert.ok(highest);assert.ok(highest.label.includes(year>=2015?'$3,500 or more':'$2,000 or more'),`Rent threshold ${year}`);
    const yearGeos=[];const cellsByPuma=new Map(PUMAS.map(p=>[p,new Map()]));
    const record=(geo,variable,raw,loc)=>{
      const table=variable.slice(0,6),entry={year,puma:geo.puma,variable,...parseCell(raw,variable,year),raw_value:raw,...loc,lookup_label:metas[table][variable].label.split('!!').at(-1),api_label:metas[table][variable].label,source_puma:geo.source_puma};
      assert.ok(!cellsByPuma.get(geo.puma).has(variable),`Duplicate ${year} ${geo.puma} ${variable}`);
      cellsByPuma.get(geo.puma).set(variable,entry);audit.push(entry);
    };
    if(year<=2021){
      const dir=`2012_2021_raw_data/${year}`,geoPath=`${dir}/g${year}1ny.txt`,archivePath=`2012_2021_raw_data/${String(year).slice(-2)}.zip`;
      const archived=zipEntries(source(archivePath,'User-supplied original state ZIP',{year}));
      function verified(p,role){const b=source(p,role,{year});assert.ok(b.equals(archived(path.basename(p))),`ZIP mismatch ${p}`);fileChecks.push({file:p,archive:archivePath,bytes_match_archive:true});return b;}
      for(const line of verified(geoPath,'Original ACS geography index').toString('latin1').split(/\r?\n/)){
        const m=line.match(/79500US36(038\d{2})\s+(.+)/);if(!m||!PUMAS.includes(m[1]))continue;
        assert.equal(line.slice(8,13),'79500');
        yearGeos.push({year,puma:m[1],source_puma:m[1],name:m[2].trim(),acs_geoid:'79500US36'+m[1],logrecno:line.slice(13,20),boundary_vintage:2010});
      }
      assert.equal(yearGeos.length,10);const byLog=new Map(yearGeos.map(g=>[g.logrecno,g]));
      const lookup=objects(read(`sources/extension/lookups/${year}.txt`).toString('latin1'));
      const yearLayouts=[];
      for(const v of VARIABLES){
        const table=v.slice(0,6),num=Number(v.slice(-3)),tableRows=lookup.filter(r=>r['Table ID'].trim()===table);
        const header=tableRows.filter(r=>r['Start Position'].trim()&&Number.isFinite(Number(r['Start Position'])));assert.equal(header.length,1,`Lookup header ${year} ${table}`);
        const lines=tableRows.filter(r=>Number(r['Line Number'])===num);assert.equal(lines.length,1,`Lookup line ${year} ${v}`);
        for(const s of 'EM')assert.equal(normalized(lines[0]['Table Title']),normalized(metas[table][v+s].label.split('!!').at(-1)),`Definition ${year} ${v}`);
        const layout={year,table,variable:v,sequence:header[0]['Sequence Number'].trim().padStart(4,'0'),source_column_1based:Number(header[0]['Start Position'])+num-1,lookup_label:lines[0]['Table Title']};
        yearLayouts.push(layout);layouts.push(layout);
      }
      for(const sequence of new Set(yearLayouts.map(l=>l.sequence)))for(const s of 'em'){
        const p=`${dir}/${s}${year}1ny${sequence}000.txt`,rows=parseDelimited(verified(p,`Original ACS ${s==='e'?'estimate':'MOE'} sequence`).toString('latin1'));
        const seen=new Set();for(const [i,r]of rows.entries()){
          assert.equal(r[0],'ACSSF');assert.equal(r[1],`${year}${s}1`);assert.equal(r[2].toUpperCase(),'NY');assert.equal(r[3],'000');assert.equal(r[4].padStart(4,'0'),sequence);
          const log=r[5].padStart(7,'0');assert.ok(!seen.has(log));seen.add(log);const geo=byLog.get(log);if(!geo)continue;
          for(const layout of yearLayouts.filter(l=>l.sequence===sequence)){assert.ok(layout.source_column_1based<=r.length);record(geo,layout.variable+s.toUpperCase(),r[layout.source_column_1based-1],{sequence,logrecno:log,source_file:p,source_line_1based:i+1,source_column_1based:layout.source_column_1based});}
        }
      }
    }else{
      const geos=objects(read(`sources/extension/geography/Geos${year}1YR.txt`).toString('utf8'),'|');
      for(const g of geos.filter(g=>g.STUSAB==='NY'&&g.SUMLEVEL==='795'&&g.COMPONENT==='00'&&g.NAME.startsWith('NYC-Manhattan '))){
        const puma=SOURCE_2020_TO_PROJECT[g.PUMA5];assert.ok(puma,`Unmapped source PUMA ${g.PUMA5}`);
        assert.equal(g.GEO_ID,`795P200US36${g.PUMA5}`);
        yearGeos.push({year,puma,source_puma:g.PUMA5,name:g.NAME,acs_geoid:g.GEO_ID,logrecno:null,boundary_vintage:2020});
      }
      assert.equal(yearGeos.length,10);
      for(const table of ['B25001','B25064','B25070']){
        const p=`2022_2025_raw_data/${year}/acsdt1y${year}-${table.toLowerCase()}.dat`,[head,...rows]=parseDelimited(source(p,'Original ACS table-based estimate/MOE data',{year}).toString('utf8'),'|');
        const map=new Map();for(const [i,r]of rows.entries()){assert.equal(r.length,head.length);assert.ok(!map.has(r[0]));map.set(r[0],{r,line:i+2});}
        for(const geo of yearGeos){const row=map.get(geo.acs_geoid);assert.ok(row,`Missing ${year} ${geo.source_puma} ${table}`);
          for(const v of VARIABLES.filter(v=>v.startsWith(table)))for(const s of 'EM'){
            const column=head.indexOf(`${table}_${s}${v.slice(-3)}`);assert.ok(column>=1,`Missing header ${v}${s}`);
            record(geo,v+s,row.r[column],{sequence:null,logrecno:null,source_file:p,source_line_1based:row.line,source_column_1based:column+1});
          }
        }
      }
    }
    assert.deepEqual(yearGeos.map(g=>g.puma).sort(),PUMAS);
    for(const geo of yearGeos.sort((a,b)=>a.puma.localeCompare(b.puma))){assert.equal(cellsByPuma.get(geo.puma).size,26);annual.push(annualRow(geo,cellsByPuma.get(geo.puma)));geography.push(geo);}
  }
  const comparisons=makeComparisons(annual,originalComparisons);
  const fixed2006=comparisons.filter(r=>r.base_year===2006);
  assert.equal(annual.length,190);assert.equal(comparisons.length,1710);assert.equal(fixed2006.length,180);assert.equal(audit.length,4940);
  assert.equal(new Set(comparisons.map(r=>`${r.base_year}:${r.end_year}:${r.puma}`)).size,1710);
  assert.ok(comparisons.every(r=>r.base_year<r.end_year&&r.base_year!==2020&&r.end_year!==2020&&r.base_year!==2025));
  assert.equal(new Set(annual.map(r=>`${r.year}:${r.puma}`)).size,190);assert.ok(!annual.some(r=>r.year===2020));
  // All original values, including the four old rent lower bounds, must survive.
  for(const r of originalAnnual){const out=annual.find(o=>o.year===r.year&&o.puma===r.puma);for(const [k,v]of Object.entries(r))assert.deepEqual(out[k],v,`Legacy annual changed ${r.year} ${r.puma} ${k}`);}
  for(const r of originalComparisons){const out=fixed2006.find(o=>o.end_year===r.end_year&&o.puma===r.puma);for(const [k,v]of Object.entries(r))assert.deepEqual(out[k],v,`Legacy comparison changed ${r.end_year} ${r.puma} ${k}`);}
  for(const [stem,rows]of [['manhattan_annual_2006_2025',annual],['manhattan_comparisons_all_baselines_2006_2025',comparisons]]){writeJSON(`${DATA}/${stem}.json`,rows);writeCSV(`${DATA}/${stem}.csv`,rows);}
  for(const baseYear of YEARS.slice(0,-1)){
    const rows=comparisons.filter(r=>r.base_year===baseYear);
    writeJSON(`${DATA}/comparisons_by_base_year/${baseYear}.json`,rows);
    writeCSV(`${DATA}/comparisons_by_base_year/${baseYear}.csv`,rows);
  }
  writeJSON(`${DATA}/comparisons_by_base_year/index.json`,{
    skipped_years:[2020],pairing:'end_year > base_year',
    files:YEARS.slice(0,-1).map(base_year=>({base_year,end_years:YEARS.filter(y=>y>base_year),rows:comparisons.filter(r=>r.base_year===base_year).length,csv:`${base_year}.csv`,json:`${base_year}.json`}))
  });
  audit.sort((a,b)=>a.year-b.year||a.puma.localeCompare(b.puma)||a.variable.localeCompare(b.variable));writeCSV('validation/acs_cell_audit.csv',audit);
  writeJSON('validation/special_values.json',audit.filter(r=>r.status!=='ok'));
  writeJSON('sources/extension/selected_variable_layouts.json',layouts);writeJSON(`${DATA}/puma_source_alignment.json`,geography);
  const dictionary=json(`${LEGACY}/data_dictionary.json`);
  const definitions={source_puma:'Five-character official PUMA code in the annual source; retain leading zero.',source_puma_name:'Official annual source geography name.',source_boundary_vintage:'Actual source PUMA vintage: 2000 through 2011, 2010 in 2012-2021, 2020 from 2022.',map_boundary_vintage:'2000; historical map key only.',geography_alignment:'Pairing policy only. No statistical or spatial boundary adjustment is performed.',source_puma_base:'Official base-year PUMA code.',source_puma_end:'Official endpoint-year PUMA code.',source_puma_name_end:'Official endpoint-year PUMA name.',source_boundary_vintage_base:'Actual base-year source vintage.',source_boundary_vintage_end:'Actual endpoint source vintage.'};
  for(const [name,rows]of [['annual',annual],['comparisons',comparisons]]){
    const old=new Map(dictionary[name].fields.map(f=>[f.name,f]));dictionary[name].rows=rows.length;
    dictionary[name].fields=Object.keys(rows[0]).map(k=>old.get(k)??{name:k,type:k.includes('vintage')?'integer':'string',unit:k.includes('vintage')?'year':'identifier/metadata',definition:definitions[k]});
    for(const field of dictionary[name].fields){
      field.definition=field.definition.replaceAll('At 2006 baseline.','At base_year.');
      if(field.name==='year')field.definition='ACS 1-year reference year, 2006-2025 excluding 2020.';
      if(field.name==='base_year')field.definition='Any available year from 2006 through 2024 excluding 2020. Only compare to later available years.';
      if(field.name==='end_year')field.definition='Available endpoint year strictly greater than base_year, through 2025, excluding 2020.';
      if(field.name==='years_elapsed')field.definition='end_year - base_year; calendar-year distance, not number of observations. Growth is cumulative, not annualized.';
      if(field.name==='puma')field.definition='Stable project display ID 03801-03810. From 2022 this is a name/district pairing alias; source_puma retains the official code.';
      if(field.name==='boundary_vintage')field.definition=name==='annual'?'Actual annual source PUMA boundary vintage. No harmonization.':'Base-year source boundary vintage; see source_boundary_vintage_end for endpoint.';
      if(field.name==='acs_geoid')field.definition=name==='annual'?'Exact source ACS GEO_ID; prefix changes with source format/vintage.':'Base-year ACS GEO_ID; endpoint code is in source_puma_end.';
      if(field.name==='logrecno')field.type='string|null';
      if(field.name.startsWith('median_gross_rent_status'))field.definition='ok, top_coded_ge_2000 (through 2014), top_coded_ge_3500 (2015+), bottom_coded_le_100, or original missing/special-code reason.';
      if(field.name.startsWith('median_gross_rent_lower_bound'))field.definition='Exact rent, or 2000/3500 for the applicable annual top code. Not a confidence bound.';
      if(field.name.startsWith('median_gross_rent_display'))field.definition='Exact dollar number, >=2000 (through 2014), >=3500 (2015+), <=100, or empty when unavailable.';
    }
  }
  dictionary.geography_policy='User-requested: ignore boundary changes. Pair source codes/names to ten project IDs; do not interpolate, reweight, or imply equal polygons. In particular pre-2022 CD4&5 pairs to 2022+ CD4; pre-2022 CD6 pairs to CD5&6.';
  dictionary.skipped_years=[2020];dictionary.baseline_years=YEARS.slice(0,-1);
  writeJSON(`${DATA}/data_dictionary_2006_2025.json`,dictionary);
  writeJSON(`${LEGACY_DATA}/data_dictionary.json`,json(`${LEGACY}/data_dictionary.json`));
  const counts=rows=>Object.fromEntries([...new Set(rows.map(r=>r.status))].sort().map(s=>[s,rows.filter(r=>r.status===s).length]));
  const report={
    generated_at_utc:new Date().toISOString(),status:'passed_with_documented_geography_pairing',
    years:YEARS,skipped_years:[2020],baseline_years:YEARS.slice(0,-1),
    annual_rows:annual.length,comparison_rows:comparisons.length,fixed_2006_comparison_rows:fixed2006.length,
    comparison_year_pairs:YEARS.length*(YEARS.length-1)/2,raw_cells_extracted:audit.length,
    pumas_per_year:Object.fromEntries(YEARS.map(y=>[y,annual.filter(r=>r.year===y).length])),
    comparisons_per_base_year:Object.fromEntries(YEARS.slice(0,-1).map(y=>[y,comparisons.filter(r=>r.base_year===y).length])),
    annual_primary_keys_unique:true,comparison_primary_keys_unique:true,all_endpoints_strictly_after_baseline:true,
    legacy_annual_values_unchanged:true,legacy_comparison_values_unchanged:true,cell_status_counts:counts(audit),
    complete_annual_rows:annual.filter(r=>r.data_complete).length,complete_comparison_rows:comparisons.filter(r=>r.data_complete).length,
    rent_growth_status_counts:Object.fromEntries([...new Set(comparisons.map(r=>r.rent_growth_status))].map(s=>[s,comparisons.filter(r=>r.rent_growth_status===s).length])),
    new_sequence_source_files_verified_against_archives:fileChecks.length,source_file_checks:fileChecks,
    annual_rent_thresholds_verified_against_B25063:true,b25070_category_checks_passed:190,
    geography_policy:dictionary.geography_policy,independent_api_value_checks_performed:false,
    independent_api_note:'API group metadata checks definitions, not values. New sequence input bytes equal original ZIP members. Table-based input bytes are hashed. No independent API numeric comparison claimed.',
    numeric_ranges:Object.fromEntries(['housing_units','median_gross_rent','rent_burden_pct'].map(k=>[k,{min:Math.min(...annual.map(r=>r[k]).filter(v=>v!==null)),max:Math.max(...annual.map(r=>r[k]).filter(v=>v!==null))}]))
  };
  writeJSON('validation/validation_report.json',report);
  const legacySources=json(`${LEGACY}/source_manifest.json`).sources;
  writeJSON('validation/source_manifest.json',{generated_at_utc:report.generated_at_utc,sources:[...new Map([...legacySources,...manifest.values()].map(s=>[s.path,s])).values()].sort((a,b)=>a.path.localeCompare(b.path))});
  console.log(JSON.stringify({annual_rows:annual.length,comparison_rows:comparisons.length,raw_cells:audit.length,status_counts:report.cell_status_counts,zip_files_checked:fileChecks.length},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
