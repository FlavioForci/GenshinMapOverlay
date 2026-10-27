#!/usr/bin/env node
'use strict';
// Offline evidence generator. Inputs are public snapshots, never progress files.
// Run: node tools/transfer/kongying-pairs.js NATIVE ITEMS CANONICAL OUTPUT
const fs = require('fs');
const crypto = require('crypto');
const { normalizeCatalog } = require('../../src/transfer/providers/kongying/normalize');
const geo = require('../../src/shared/geo');
const LABELS = Object.freeze({ '散失的风神瞳': 'o5', '散失的岩神瞳': 'o6', '散失的雷神瞳': 'o194', '散失的草神瞳': 'o403', '散失的水神瞳': 'o508', '散失的火神瞳': 'o626' });
const CHEST_LABELS = Object.freeze({ '华丽的宝箱':'o46', '珍贵的宝箱':'o45', '精致的宝箱':'o44', '普通的宝箱':'o17', '奇馈宝箱':'o269' });
const CHEST_PROPERTIES = Object.freeze(['直接开启','击败魔物']);
const LIMITS = Object.freeze({ initialRadius: 20, trainingResidual: 4, residual: 2.5, secondDistance: 12, margin: 8, ratio: 4, minimumTraining: 8, minimumHeldout: 8, heldoutP90: 6, heldoutWithin8Rate: 0.8 });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function quantile(a, p) { const b = a.slice().sort((a,b)=>a-b); return b.length ? b[Math.floor((b.length-1)*p)] : null; }
function solve(matrix, values) {
 const a = matrix.map((row,i)=>[...row,values[i]]);
 for(let j=0;j<3;j++) { let pivot=j;for(let i=j+1;i<3;i++)if(Math.abs(a[i][j])>Math.abs(a[pivot][j]))pivot=i;
  [a[j],a[pivot]]=[a[pivot],a[j]];if(Math.abs(a[j][j])<1e-12)throw Error('singular calibration');
  const d=a[j][j];for(let k=j;k<4;k++)a[j][k]/=d;
  for(let i=0;i<3;i++)if(i!==j){const f=a[i][j];for(let k=j;k<4;k++)a[i][k]-=f*a[j][k];}
 } return a.map(r=>r[3]);
}
function fit(pairs) {
 // Source native position is [lng,lat]; model uses [lat,lng,1].
 const m=Array.from({length:3},()=>[0,0,0]),x=[0,0,0],y=[0,0,0];
 for(const p of pairs){const v=[p.source.position.y,p.source.position.x,1];for(let i=0;i<3;i++){x[i]+=v[i]*p.target.x;y[i]+=v[i]*p.target.y;for(let j=0;j<3;j++)m[i][j]+=v[i]*v[j];}}
 return { x:solve(m,x), y:solve(m,y) };
}
function project(source,model){const v=[source.position.y,source.position.x,1];return {x:v.reduce((s,k,i)=>s+k*model.x[i],0),y:v.reduce((s,k,i)=>s+k*model.y[i],0)};}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function nearest(point,rows){let first=null,second=null,d1=Infinity,d2=Infinity;for(const row of rows){const d=distance(point,row);if(d<d1){second=first;d2=d1;first=row;d1=d;}else if(d<d2){second=row;d2=d;}}return {first,second,d1,d2};}
function canonicalFacts(catalog) {
 const d=catalog.data,delta=catalog.encoding?.delta||[];let running=0;const rows=[];
 for(let i=0;i<d.id.length;i++){running=delta.includes('id')?running+d.id[i]:d.id[i];if(Number(d.mid[i])!==2)continue;
 rows.push({id:String(running),category:d.type[i],level:null,x:geo.lngToMapX(Number(d.lng[i])),y:geo.latToMapY(Number(d.lat[i]))});}
 return rows;
}
function generate(native, items, canonical) {
 const normalized=normalizeCatalog(native), labels=new Map();
 for(const item of items){const id=String(item.id),old=labels.get(id);if(old&&(old.name!==item.name||old.areaId!==item.areaId))throw Error('conflicting item metadata');labels.set(id,item);}
 const byType=new Map(),groups=new Map();for(const t of canonicalFacts(canonical)){if(!byType.has(t.category))byType.set(t.category,[]);byType.get(t.category).push(t);}
 for(const source of normalized){const parts=source.category.split('+').map(id=>labels.get(id));
 // All associations must have explicit, identical permanent meaning AND area.
 if(parts.some(p=>!p||!LABELS[p.name]))continue;const types=new Set(parts.map(p=>LABELS[p.name])),areas=new Set(parts.map(p=>p.areaId));if(types.size!==1||areas.size!==1)continue;
 const type=[...types][0],area=[...areas][0],key=`${area}:${type}`;if(!groups.has(key))groups.set(key,{area,type,rows:[]});groups.get(key).rows.push(source);
 }
 const diagnostics=[],pairs=[];
 for(const [scope,g] of groups){const target=byType.get(g.type)||[];
 const sameMeaning=normalized.filter(r=>r.category.split('+').some(id=>LABELS[labels.get(id)?.name]===g.type));
 // Documented bootstrap only. Every area gets an independent fitted model;
 // shifted realms/regions fail validation and yield no pairs.
 let model={x:[.375,0,[12,13,14].includes(g.area)?1049949:1051048],y:[0,.375,1048885]};
 const training=g.rows.filter(r=>Number(r.id)%5<3),heldout=g.rows.filter(r=>Number(r.id)%5>=3);
 const make = (rows,radius) => rows.map(source=>{const n=nearest(project(source,model),target);return {source,target:n.first,residual:n.d1,second:n.d2};}).filter(p=>p.target&&p.residual<=radius&&p.second>=LIMITS.secondDistance&&p.second-p.residual>=LIMITS.margin);
 let anchors=make(training,LIMITS.initialRadius);
 if(anchors.length>=LIMITS.minimumTraining)for(let i=0;i<4;i++){model=fit(anchors);anchors=make(training,LIMITS.trainingResidual);if(anchors.length<LIMITS.minimumTraining)break;}
 const checks=make(heldout,LIMITS.initialRadius),residuals=checks.map(p=>p.residual);
 const valid=anchors.length>=LIMITS.minimumTraining&&checks.length>=LIMITS.minimumHeldout&&checks.length/heldout.length>=LIMITS.heldoutWithin8Rate&&quantile(residuals,.9)<=LIMITS.heldoutP90&&checks.filter(p=>p.residual<=8).length/heldout.length>=LIMITS.heldoutWithin8Rate&&Math.abs(model.x[0]-.375)<.002&&Math.abs(model.y[1]-.375)<.002&&Math.abs(model.x[1])<.002&&Math.abs(model.y[0])<.002;
 const report={scope,area:g.area,type:g.type,sourceCount:g.rows.length,trainingCount:training.length,trainingAnchors:anchors.length,heldoutCount:heldout.length,heldoutMatched:checks.length,heldoutP50:quantile(residuals,.5),heldoutP90:quantile(residuals,.9),heldoutMaximum:quantile(residuals,1),model,valid,accepted:0,trainingIds:anchors.map(p=>[p.source.id,p.target.id]),heldoutIds:checks.map(p=>[p.source.id,p.target.id,p.residual])};diagnostics.push(report);if(!valid)continue;
 const projected=g.rows.map(source=>({...project(source,model),source}));
 for(const p of make(g.rows,LIMITS.residual)){
  // Unknown floors cannot be separated by native XY: reject close same-class
  // source observations across area boundaries as well as within this group.
  if(sameMeaning.some(r=>r.id!==p.source.id&&distance(r.position,p.source.position)*.375<LIMITS.secondDistance))continue;
  const reciprocal=nearest(p.target,projected);if(reciprocal.first?.source.id!==p.source.id||reciprocal.d2<LIMITS.secondDistance||reciprocal.d2-reciprocal.d1<LIMITS.margin||p.second/Math.max(p.residual,1e-9)<LIMITS.ratio||reciprocal.d2/Math.max(reciprocal.d1,1e-9)<LIMITS.ratio)continue;
 pairs.push({source:p.source,target:p.target,reason:`explicit-oculus-label:${scope};independent-area-affine;reciprocal-unique`,residual:p.residual});report.accepted++;}
 }
 // IDs of different providers are unrelated. Reject any collision in selected
 // destination facts rather than choose an arbitrary source observation.
 const seen=new Map();for(const p of pairs){const k=p.target.id;seen.set(k,(seen.get(k)||0)+1);}let unique=pairs.filter(p=>seen.get(p.target.id)===1);
 const rawById=new Map(native.markers.map(r=>[String(r.id),r]));
 const chestAudit={ labels:CHEST_LABELS, propertyWhitelist:CHEST_PROPERTIES, requiredClassType:10, requiredPropertyType:11, rowsContainingChest:0, permanentRows:0, chestOnlyEligible:0, eligibleCompounds:0, accepted:0, areas:[] }, chestAreas=new Map(), chestGroups=new Map();
 for(const source of normalized){const parts=source.category.split('+').map(id=>labels.get(id)),chests=parts.filter(p=>p&&CHEST_LABELS[p.name]);if(!chests.length)continue;chestAudit.rowsContainingChest++;
  const permanent=rawById.get(source.id).refreshTime===0&&chests.every(p=>p.defaultRefreshTime===0);if(permanent)chestAudit.permanentRows++;
  const types=new Set(chests.map(p=>CHEST_LABELS[p.name])),areas=new Set(chests.map(p=>p.areaId));
  const strict=permanent&&parts.every(p=>p&&CHEST_LABELS[p.name])&&types.size===1&&areas.size===1;if(strict)chestAudit.chestOnlyEligible++;
  const sameArea=new Set(parts.filter(Boolean).map(p=>p.areaId)).size===1;
  const eligible=permanent&&parts.every(p=>p&&p.defaultRefreshTime===0&&Array.isArray(p.typeIdList)&&p.typeIdList.length===1&&((CHEST_LABELS[p.name]&&p.typeIdList[0]===10)||(CHEST_PROPERTIES.includes(p.name)&&p.typeIdList[0]===11)))&&types.size===1&&sameArea&&rawById.get(source.id).itemList.every(p=>p.count===1);
  if(eligible){chestAudit.eligibleCompounds++;const area=parts[0].areaId,type=[...types][0],key=area+':'+type;if(!chestGroups.has(key))chestGroups.set(key,{area,type,rows:[]});chestGroups.get(key).rows.push(source);}
  if(types.size!==1||areas.size!==1)continue;const area=[...areas][0],type=[...types][0],calibration=diagnostics.find(d=>d.valid&&d.area===area);if(!calibration)continue;
  if(!chestAreas.has(area))chestAreas.set(area,{area,observations:0,strictEligible:0,residuals:[]});const a=chestAreas.get(area);a.observations++;if(strict)a.strictEligible++;
  const n=nearest(project(source,calibration.model),byType.get(type)||[]);if(n.first)a.residuals.push(n.d1);
 }
 for(const [scope,g] of chestGroups){const calibration=diagnostics.find(d=>d.valid&&d.area===g.area);if(!calibration)continue;const target=byType.get(g.type)||[];
  // Include every chest-bearing source observation as a reciprocal competitor,
  // even if its associations are not eligible for transfer.
  const potential=normalized.filter(r=>r.category.split('+').some(id=>{const p=labels.get(id);return p&&p.areaId===g.area&&CHEST_LABELS[p.name]===g.type;}));
  const projected=potential.map(source=>({...project(source,calibration.model),source}));
  const allPotential=normalized.filter(r=>r.category.split('+').some(id=>CHEST_LABELS[labels.get(id)?.name]===g.type));
  for(const source of g.rows){const n=nearest(project(source,calibration.model),target);if(!n.first||n.d1>LIMITS.residual||n.d2<LIMITS.secondDistance||n.d2-n.d1<LIMITS.margin||n.d2/Math.max(n.d1,1e-9)<LIMITS.ratio)continue;
   const reverse=nearest(n.first,projected);if(reverse.first?.source.id!==source.id||reverse.d2<LIMITS.secondDistance||reverse.d2-reverse.d1<LIMITS.margin||reverse.d2/Math.max(reverse.d1,1e-9)<LIMITS.ratio)continue;
   if(allPotential.some(r=>r.id!==source.id&&distance(r.position,source.position)*.375<LIMITS.secondDistance))continue;
   unique.push({source,target:n.first,reason:`explicit-chest-quality-and-type11-property:${scope};single-marker-completion;independent-oculus-area-affine;reciprocal-unique`,residual:n.d1});chestAudit.accepted++;
  }
 }
 // One-to-one across all supported classes and scopes; no arbitrary winner.
 const targetCounts=new Map();for(const p of unique)targetCounts.set(p.target.id,(targetCounts.get(p.target.id)||0)+1);unique=unique.filter(p=>targetCounts.get(p.target.id)===1);
 chestAudit.accepted=unique.filter(p=>p.reason.startsWith('explicit-chest')).length;
 chestAudit.areas=[...chestAreas.values()].map(({residuals,...a})=>({...a,p50:quantile(residuals,.5),p90:quantile(residuals,.9),maximum:quantile(residuals,1),within2_5:residuals.filter(d=>d<=LIMITS.residual).length}));
 return {version:1,limits:LIMITS,labels:LABELS,sourceCount:normalized.length,pairs:unique,diagnostics,chestAudit};
}
if(require.main===module){const [nativePath,itemsPath,canonicalPath,outputPath]=process.argv.slice(2);if(!outputPath)throw Error('Usage: kongying-pairs.js NATIVE ITEMS CANONICAL OUTPUT');const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));const result=generate(read(nativePath),read(itemsPath),read(canonicalPath));result.inputs=[nativePath,itemsPath,canonicalPath].map(path=>({path,sha256:hash(fs.readFileSync(path))}));fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pairs:result.pairs.length,diagnostics:result.diagnostics.map(({scope,sourceCount,trainingAnchors,heldoutCount,heldoutP90,valid,accepted})=>({scope,sourceCount,trainingAnchors,heldoutCount,heldoutP90,valid,accepted}))},null,2));}
module.exports={generate,canonicalFacts,LABELS,LIMITS};
