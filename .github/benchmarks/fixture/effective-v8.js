const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const base = fs.realpathSync(process.env.PERF_EVIDENCE);
const source = fs.realpathSync(process.env.PERF_SOURCE);
const { mergeScriptCovs } = require(path.join(source, 'node_modules/@bcoe/v8-coverage'));
const canonical = value => JSON.stringify(value);
function intervals(fn) {
  const points = [...new Set(fn.ranges.flatMap(r => [r.startOffset, r.endOffset]))].sort((a,b)=>a-b);
  const result = [];
  for (let i=0; i<points.length-1; i++) {
    const start=points[i], end=points[i+1];
    const range=fn.ranges.filter(r=>r.startOffset<=start && r.endOffset>=end)
      .sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0];
    const covered=range.count>0;
    if (result.length && result.at(-1)[2]===covered) result.at(-1)[1]=end;
    else result.push([start,end,covered]);
  }
  return result;
}
function collect(variant) {
  const raw=path.join(base, variant, 'raw');
  const merged=new Map();
  const files=fs.readdirSync(raw).filter(f=>/^coverage-.*\.json$/.test(f)).sort();
  let withProduction=0, bytes=0;
  const started=Date.now();
  for (let index=0; index<files.length; index++) {
    const text=fs.readFileSync(path.join(raw,files[index]),'utf8');
    bytes+=Buffer.byteLength(text);
    const profile=JSON.parse(text);
    let production=false;
    for (const script of profile.result) {
      let file;
      try { file=script.url.startsWith('file:') ? fileURLToPath(script.url) : script.url; } catch { continue; }
      if (!file.startsWith(source+'/')) continue;
      const relative=path.relative(source,file);
      if (!/^(commands|config|analytics-worker)\/.+\.ts$/.test(relative)) continue;
      production=true;
      script.url=relative;
      merged.set(relative, mergeScriptCovs(merged.has(relative) ? [merged.get(relative),script] : [script]));
    }
    if(production) withProduction++;
    if(index%2000===0) process.stdout.write(JSON.stringify({variant,processed:index,total:files.length,elapsedMs:Date.now()-started})+'\n');
  }
  const normalized={};
  for (const [file, script] of [...merged].sort(([a],[b])=>a.localeCompare(b))) {
    normalized[file]=script.functions.map(fn=>({root:[fn.ranges[0].startOffset,fn.ranges[0].endOffset],name:fn.functionName,intervals:intervals(fn)}))
      .sort((a,b)=>a.root[0]-b.root[0] || a.root[1]-b.root[1]);
  }
  fs.writeFileSync(path.join(base,variant,'effective-v8.json'),JSON.stringify(normalized,null,2));
  return {normalized,receipt:{variant,profiles:files.length,withProduction,bytes,elapsedMs:Date.now()-started,files:Object.keys(normalized).length}};
}
const a=collect('control'),b=collect('candidate');
const differences=[];
for(const file of [...new Set([...Object.keys(a.normalized),...Object.keys(b.normalized)])].sort()) {
  if(canonical(a.normalized[file])!==canonical(b.normalized[file])) differences.push({file,control:a.normalized[file],candidate:b.normalized[file]});
}
const result={method:'Merge production raw script coverage using installed @bcoe/v8-coverage, then partition each function at every range boundary, select the innermost count, collapse adjacent equal covered/uncovered outcomes, and compare exact function roots/names/intervals. Counts and redundant positive split boundaries are ignored.',receipts:[a.receipt,b.receipt],effectiveFunctionIntervalParity:differences.length===0,differences};
fs.writeFileSync(path.join(base,'effective-v8-comparison.json'),JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify({receipts:result.receipts,effectiveFunctionIntervalParity:result.effectiveFunctionIntervalParity,differingFiles:differences.map(d=>d.file)},null,2)+'\n');
if (!result.effectiveFunctionIntervalParity) process.exitCode=1;
