const { put, list } = require('@vercel/blob');
const XLSX = require('xlsx');

// CANCELLATION SHIELD v7 — Booking.com-calibrated model

// Booking.com benchmarks (real data, 2657 reservations)
const BDC_LT = {
  Alegria:{1:6.6,3:0,7:1.9,14:26.9,30:38.6,60:42.5,90:69.1,999:67.7},
  "SB I":{1:8.4,3:2.6,7:9.5,14:31.7,30:46.7,60:51,90:54.5,999:51},
  "SB II":{1:1.2,3:0,7:10.1,14:20.5,30:40.3,60:46.8,90:64.6,999:55.6}
};
const BDC_MONTH = {
  Alegria:[39.2,29.2,31.2,22.2,33.3,32,32,29.4,29.2,49,40.7,33.3],
  "SB I":[11.3,25.3,18.3,37.4,41.5,47.4,34.6,37.6,45.1,50,57.1,34.5],
  "SB II":[9.7,26.5,27.9,31.9,33,30.1,31.5,30.8,38.3,40.5,29.2,46.1]
};
const BDC_OVERALL = {Alegria:33,"SB I":37.1,"SB II":32.1};

function isNR(r){const l=(r||'').toLowerCase();return l.includes('nr ')||l.startsWith('nr')||l.includes('non-ref')||l.includes('non-refundable')||l.includes('early bird')}

function scoreRate(r){
  const l=(r||'').toLowerCase();
  if(l.includes('flex 3'))return 58;if(l.includes('standard')&&l.includes('breakfast'))return 50;
  if(l.includes('flex 5'))return 48;if(l.includes('semi-flex'))return 35;
  if(l.includes('standard')&&l.includes('booking'))return 30;if(l.includes('standard'))return 35;
  if(l.includes('flex')&&l.includes('ota'))return 30;if(l.includes('black friday'))return 35;
  if(l.includes('friends')||l.includes('family'))return 5;if(l.includes('welcome'))return 3;
  if(isNR(r))return 3;if(l.includes('long'))return 10;return 25;
}
function scoreChannel(s){
  const l=(s||'').toLowerCase();
  if(l.includes('telephone'))return 85;if(l.includes('a-hotels')||l.includes('american express'))return 82;
  if(l.includes('booking engine sbii'))return 42;if(l.includes('booking.com'))return 38;
  if(l.includes('booking engine sbi'))return 32;if(l.includes('booking engine alegria'))return 30;
  if(l.includes('channel'))return 35;if(l.includes('in person'))return 30;
  if(l.includes('message')||l.includes('email'))return 25;if(l.includes('hotels.com'))return 18;
  if(l.includes('airbnb'))return 14;if(l.includes('expedia'))return 17;
  if(l.includes('booking engine'))return 12;if(l.includes('web'))return 10;return 20;
}
function scoreLeadTime(days,prop){
  if(!days||days<0)return 15;
  const b=BDC_LT[prop]||BDC_LT["SB II"];
  if(days<=1)return Math.round(b[1]*0.8);if(days<=3)return Math.round((b[3]||5)*0.8+5);
  if(days<=7)return Math.round(b[7]*0.9);if(days<=14)return Math.round(b[14]*0.85);
  if(days<=30)return Math.round(b[30]*0.85);if(days<=60)return Math.round(b[60]*0.85);
  if(days<=90)return Math.round(b[90]*0.8);return Math.round(b[999]*0.8);
}
function scoreSeason(month,prop){
  if(!month)return 25;const b=BDC_MONTH[prop]||BDC_MONTH["SB II"];
  const idx=(month-3+12)%12;return Math.round((b[idx]||30)*0.7);
}
function scoreLOS(n){if(!n||n<=0)return 20;if(n<=2)return 20;if(n<=4)return 25;if(n<=7)return 35;if(n<=14)return 60;return 78}
function scorePayment(p){const s=(p||'').toLowerCase().trim();if(s==='success')return 2;if(s==='fail')return 10;return 40}
function scoreADR(a){if(!a||a<=0)return 25;if(a<100)return 12;if(a<150)return 10;if(a<200)return 20;if(a<300)return 45;return 65}

function computeRisk(r,duveMap){
  const rate=r.rate||'',pay=(r.payment||'').toLowerCase().trim();
  if(isNR(rate)&&pay==='success')return{score:3,level:'LOW',override:'NR+Paid'};
  const duve=duveMap?duveMap[r.id]:null;
  if(duve&&duve.status==='preCheckedIn')return{score:3,level:'LOW',override:'Duve:preCheckedIn'};
  let s=0.20*scoreRate(rate)+0.18*scoreLeadTime(r.leadTimeDays,r.prop)+0.16*scoreChannel(r.source)+
    0.14*scorePayment(r.payment)+0.10*scoreLOS(r.nights)+0.08*scoreADR(r.adr)+
    0.06*scoreSeason(r.arrMonth,r.prop)+0.04*(r.hasNoContact?60:5)+0.04*(r.isSolo?40:20);
  let override='';
  if(duve){
    if(duve.status==='beforeCheckIn'&&duve.terms==="Didn't agree"){s+=5;override='Duve:noEngagement'}
    else if(duve.status==='beforeCheckIn'&&duve.terms==='Agreed'){s-=3;override='Duve:partial'}
  }
  if(isNR(rate)&&pay!=='success'){s+=8;override=override||'NR:noPay'}
  s=Math.max(0,Math.min(Math.round(s),100));
  return{score:s,level:s>=33?'HIGH':s>=18?'MEDIUM':'LOW',override};
}

function getTemplate(level,d,n){
  if(level==='HIGH'){if(n>=8)return'7A';if(d>14)return n>=5?'1B':'1A';if(d>7)return'2A/2B';if(d>3)return'3A/3B';return'3A'}
  if(level==='MEDIUM')return d>14?'4A':'5A';return'-';
}
function getOffer(level,d,n){
  if(level==='HIGH'){if(n>=8)return'Welcome+mid-stay+late c-out';if(d>14)return'Early c-in+late c-out';if(d>7)return'Early c-in+upgrade';if(d>3)return'Crédito/datas alt.';return'Contacto urgente'}
  if(level==='MEDIUM')return d>14?'Guia bairro+dicas':'Info prática check-in';return'-';
}
function getChannel(src,level){
  const s=(src||'').toLowerCase();
  if(s.includes('booking.com'))return'BDC Extranet';if(s.includes('airbnb'))return'Airbnb App';
  if(s.includes('expedia')||s.includes('hotels.com'))return'Expedia';return level==='HIGH'?'WhatsApp':'Email';
}

function parseReservations(buffer){
  const wb=XLSX.read(buffer,{type:'buffer',cellDates:true});
  const ws=wb.Sheets['Reservations'];
  if(!ws)return{prop:'Unknown',reservations:[]};
  let detectedProp='';
  const params=wb.Sheets['Parameters'];
  if(params){
    const pData=XLSX.utils.sheet_to_json(params,{header:1});
    for(const row of pData){
      const k=String(row[0]||''),v=String(row[1]||'');
      if(k.includes('Enterprise')){
        if(v.includes('Alegria'))detectedProp='Alegria';
        else if(v.includes('Barbara II'))detectedProp='SB II';
        else if(v.includes('Barbara I'))detectedProp='SB I';
        break;
      }
    }
  }
  const data=XLSX.utils.sheet_to_json(ws,{defval:''});
  const now=new Date();
  const reservations=data.filter(r=>r.Identifier&&(r.Status==='Confirmed'||r.Status==='Checked in')).map(r=>{
    const arrival=r.Arrival?new Date(r.Arrival):null;
    const departure=r.Departure?new Date(r.Departure):null;
    const created=r.Created?new Date(r.Created):null;
    const nights=arrival&&departure?Math.round((departure-arrival)/86400000):0;
    const leadTimeDays=arrival&&created?Math.round((arrival-created)/86400000):0;
    const daysUntil=arrival?Math.round((arrival-now)/86400000):999;
    const adr=r['Average rate (nightly)']||(r['Cancelled cost']&&nights?r['Cancelled cost']/nights:0);
    const hasNoContact=(!r.Email||r.Email==='')&&(!r.Telephone||r.Telephone==='');
    const isSolo=r['Person count']===1;
    let room=String(r['Space number']||(r['Requested category']||'').split(' - ')[0]);
    room=room.replace(/^SBII\s*/i,'').replace(/^SBI\s*/i,'').replace(/^ALE\s*/i,'').trim();
    return{id:r.Identifier,guest:`${r['First name']||''} ${r['Last name']||''}`.trim(),
      prop:detectedProp,room,roomType:r['Requested category']||'',
      arrival:arrival?arrival.toISOString().split('T')[0]:'',
      departure:departure?departure.toISOString().split('T')[0]:'',
      nights,daysUntil,leadTimeDays,rate:r.Rate||'',adr:Math.round(adr||0),
      total:Math.round(r['Total amount']||0),source:r['Reservation source']||'',
      payment:r['Automatic payment']||'',email:r.Email||'',phone:r.Telephone||'',
      persons:r['Person count']||1,nationality:r['Customer nationality']||'',
      hasNoContact,isSolo,arrMonth:arrival?arrival.getMonth()+1:null};
  });
  return{prop:detectedProp,reservations};
}

function parseAvailability(buffer){
  const wb=XLSX.read(buffer,{type:'buffer',cellDates:true});
  let propName='Unknown';
  const params=wb.Sheets['Parameters'];
  if(params){
    const pData=XLSX.utils.sheet_to_json(params,{header:1});
    for(const row of pData){
      const k=String(row[0]||''),v=String(row[1]||'');
      if(k.includes('Enterprise')){
        if(v.includes('Alegria'))propName='Alegria';
        else if(v.includes('Barbara II'))propName='SB II';
        else if(v.includes('Barbara I'))propName='SB I';break;
      }
    }
  }
  const occSheet=wb.Sheets['Occupancy'];
  if(!occSheet)return{prop:propName,data:{}};
  const occData=XLSX.utils.sheet_to_json(occSheet,{header:1,cellDates:true});
  const availSheet=wb.Sheets['Availability'];
  const rateSheet=wb.Sheets['Rate'];
  const availData=availSheet?XLSX.utils.sheet_to_json(availSheet,{header:1,cellDates:true}):null;
  const rateData=rateSheet?XLSX.utils.sheet_to_json(rateSheet,{header:1,cellDates:true}):null;
  const dates=(occData[0]||[]).slice(2).filter(d=>d instanceof Date);
  const result={};
  dates.forEach((date,di)=>{
    const key=date.toISOString().split('T')[0];
    let tOcc=0,tSp=0,tAv=0,tRt=0,rc=0;const rts=[];
    for(let ri=1;ri<occData.length;ri++){
      if(occData[ri][0]!=='Stay')continue;
      const rt=String(occData[ri][1]||'').trim();
      const o=Number(occData[ri][di+2])||0;
      const a=availData?(Number(availData[ri]?.[di+2])||0):0;
      const rate=rateData?(Number(rateData[ri]?.[di+2])||0):0;
      tOcc+=o;tSp++;tAv+=a;if(rate>0){tRt+=rate;rc++}
      rts.push({type:rt,occ:o,avail:a,rate:Math.round(rate)});
    }
    result[key]={occ:tOcc,spaces:tSp,avail:tAv,avgRate:rc>0?Math.round(tRt/rc):0,
      occPct:tSp>0?Math.round(tOcc/tSp*1000)/10:0,rooms:rts};
  });
  return{prop:propName,data:result};
}

function parseDuve(text){
  const lines=text.split('\n');if(lines.length<2)return{};
  const hdr=lines[0].split(',').map(h=>h.trim().replace(/"/g,''));
  const eIdx=hdr.indexOf('External Id'),sIdx=hdr.indexOf('Status');
  const tIdx=hdr.findIndex(h=>h.includes('Terms')),pIdx=hdr.findIndex(h=>h.includes('passport'));
  if(eIdx<0)return{};const map={};
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(',').map(x=>x.trim().replace(/"/g,''));
    if(c[eIdx])map[c[eIdx]]={status:c[sIdx]||'',terms:tIdx>=0?c[tIdx]||'':'',passport:pIdx>=0?c[pIdx]||'':''};
  }
  return map;
}

function computeOverbooking(reservations,availability){
  const ops=[],today=new Date().toISOString().split('T')[0];
  const cutoff=new Date(Date.now()+90*86400000).toISOString().split('T')[0];
  const dn=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  ['Alegria','SB I','SB II'].forEach(prop=>{
    const pa=availability[prop];if(!pa)return;
    const pr=reservations.filter(r=>r.prop===prop);
    Object.entries(pa).forEach(([ds,dd])=>{
      if(ds<today||ds>cutoff)return;
      const hi=pr.filter(r=>r.level==='HIGH'&&r.arrival<=ds&&r.departure>ds);
      if((dd.occPct||0)>=70&&hi.length>0){
        const ob=Math.min(Math.max(1,Math.floor(hi.length*0.4)),3);
        const adj=Math.max(0,ob-(hi.some(r=>r.daysUntil>7)?1:0));
        if(adj>0){
          const fr=(dd.rooms||[]).filter(rt=>rt.avail===0&&rt.rate>0);
          ops.push({date:ds,prop,occPct:dd.occPct,nHigh:hi.length,ob:adj,
            rooms:fr.slice(0,adj).map(rt=>`${rt.type} (€${rt.rate})`).join(', ')||'Any available',
            avgRate:dd.avgRate,dow:dn[new Date(ds).getDay()]});
        }
      }
    });
  });
  return ops.sort((a,b)=>a.date.localeCompare(b.date));
}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();
  try{
    if(req.method==='GET'){
      try{
        const blobs=await list({prefix:'shield-data'});
        if(!blobs.blobs||blobs.blobs.length===0)return res.status(200).json({status:'no_data'});
        const latest=blobs.blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
        const r=await fetch(latest.url);return res.status(200).json(await r.json());
      }catch(e){return res.status(200).json({status:'no_data'})}
    }
    if(req.method==='POST'){
      const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
      if(!body||!body.files||!Array.isArray(body.files))return res.status(400).json({status:'error',error:'Missing files'});

      let exRes=[],exAvail={},exDuve={};
      try{
        const blobs=await list({prefix:'shield-data'});
        if(blobs.blobs&&blobs.blobs.length>0){
          const latest=blobs.blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt))[0];
          const r=await fetch(latest.url);const ex=await r.json();
          if(ex._raw){exRes=ex._raw.reservations||[];exAvail=ex._raw.availability||{};exDuve=ex._raw.duveMap||{}}
        }
      }catch(e){}
console.log('FILES:', body.files.map(f => f.type + ':' + (f.name||'?')));
      for(const file of body.files){
        try{
          const buf=Buffer.from(file.content,'base64');
          if(file.type==='reservation'){
            const{reservations}=parseReservations(buf);
            console.log('PARSED:', file.name, reservations.length, 'reservations');
            const ids=new Map(exRes.map((r,i)=>[r.id,i]));
            for(const r of reservations){const idx=ids.get(r.id);if(idx!==undefined)exRes[idx]=r;else{exRes.push(r);ids.set(r.id,exRes.length-1)}}
          }else if(file.type==='availability'){
            const{prop,data}=parseAvailability(buf);exAvail[prop]=data;
          }else if(file.type==='duve'){
            Object.assign(exDuve,parseDuve(buf.toString('utf-8')));
          }
        }catch(e){console.error('File error:',file.name,e.message,e.stack)}
      }

      const scored=exRes.map(r=>{
        const{score,level,override}=computeRisk(r,exDuve);
        const factors=[];
        if(scoreRate(r.rate)>=35)factors.push('Rate');
        if(scoreChannel(r.source)>=35)factors.push('Canal');
        if(r.leadTimeDays>30)factors.push(`LT:${r.leadTimeDays}d`);
        if(r.nights>7)factors.push(`LOS:${r.nights}n`);
        if(scorePayment(r.payment)>=30)factors.push('NoPay');
        if(scoreADR(r.adr)>=40)factors.push(`ADR€${r.adr}`);
        if(r.hasNoContact)factors.push('NoContact');
        return{...r,score,level,override,factors,
          template:getTemplate(level,r.daysUntil,r.nights),
          offer:getOffer(level,r.daysUntil,r.nights),
          channel:getChannel(r.source,level)};
      });

      const ob=computeOverbooking(scored,exAvail);
      const hi=scored.filter(r=>r.level==='HIGH'),me=scored.filter(r=>r.level==='MEDIUM'),lo=scored.filter(r=>r.level==='LOW');

      const output={
        reservations:scored,overbooking:ob,
        availability:Object.fromEntries(Object.entries(exAvail).map(([p,d])=>[p,Object.fromEntries(Object.entries(d).map(([k,v])=>[k,{occ:v.occ,spaces:v.spaces,occPct:v.occPct,avgRate:v.avgRate}]))])),
        summary:{total:scored.length,high:hi.length,medium:me.length,low:lo.length,
          highRevenue:hi.reduce((s,r)=>s+r.total,0),medRevenue:me.reduce((s,r)=>s+r.total,0),lowRevenue:lo.reduce((s,r)=>s+r.total,0),
          retentionCount:scored.filter(r=>r.level!=='LOW'&&r.daysUntil>0).length,
          obDays:ob.length,obNights:ob.reduce((s,o)=>s+o.ob,0),
          byProp:{Alegria:scored.filter(r=>r.prop==='Alegria').length,"SB I":scored.filter(r=>r.prop==='SB I').length,"SB II":scored.filter(r=>r.prop==='SB II').length},
          bdcBenchmarks:BDC_OVERALL},
        _raw:{reservations:exRes,availability:exAvail,duveMap:exDuve},
        modelVersion:'v7',generated:new Date().toISOString()
      };

      await put('shield-data/latest.json',JSON.stringify(output),{access:'public',contentType:'application/json',addRandomSuffix:false});
      return res.status(200).json({status:'ok',summary:output.summary});
    }
    return res.status(405).json({status:'error',error:'Method not allowed'});
  }catch(err){
    console.error('Shield error:',err);
    return res.status(500).json({status:'error',error:err.message||'Server error'});
  }
};
