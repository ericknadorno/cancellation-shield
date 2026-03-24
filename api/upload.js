const { put, list, del } = require('@vercel/blob');
const XLSX = require('xlsx');

// ─── V6 SCORING MODEL ───
function isNR(r) {
  const l = (r || '').toLowerCase();
  return l.includes('nr ') || l.startsWith('nr') || l.includes('non-ref') || l.includes('non-refundable') || l.includes('early bird');
}
function scoreRate(r) {
  const l = (r || '').toLowerCase();
  if (l.includes('flex 3')) return 55;
  if (l.includes('standard') && l.includes('breakfast')) return 48;
  if (l.includes('flex 5')) return 45;
  if (l.includes('semi-flex')) return 35;
  if (l.includes('standard') && l.includes('booking')) return 28;
  if (l.includes('standard')) return 35;
  if (l.includes('flex') && l.includes('ota')) return 28;
  if (l.includes('black friday')) return 35;
  if (l.includes('friends') || l.includes('family')) return 5;
  if (l.includes('welcome')) return 3;
  if (isNR(r)) return 5;
  if (l.includes('long')) return 12;
  return 25;
}
function scoreChannel(s) {
  const l = (s || '').toLowerCase();
  if (l.includes('telephone')) return 85;
  if (l.includes('a-hotels')) return 82;
  if (l.includes('booking engine sbii')) return 42;
  if (l.includes('booking.com')) return 38;
  if (l.includes('booking engine sbi')) return 32;
  if (l.includes('channel')) return 35;
  if (l.includes('in person')) return 30;
  if (l.includes('email')) return 25;
  if (l.includes('hotels.com')) return 18;
  if (l.includes('airbnb')) return 16;
  if (l.includes('expedia')) return 17;
  if (l.includes('booking engine')) return 12;
  if (l.includes('web')) return 10;
  return 20;
}
function scoreLeadTime(d) { if (!d || d < 0) return 20; if (d <= 7) return 8; if (d <= 14) return 25; if (d <= 30) return 40; if (d <= 60) return 42; if (d <= 90) return 52; return 50; }
function scoreLOS(n) { if (!n || n <= 0) return 20; if (n <= 2) return 22; if (n <= 4) return 26; if (n <= 7) return 35; if (n <= 14) return 62; return 80; }
function scorePayment(p) { const s = (p || '').toLowerCase().trim(); if (s === 'success') return 2; if (s === 'fail') return 10; return 38; }
function scoreADR(a) { if (!a || a <= 0) return 25; if (a < 100) return 12; if (a < 150) return 10; if (a < 200) return 18; if (a < 300) return 42; return 65; }
function scoreSeason(m) { if (!m) return 25; if (m === 12) return 42; if ([2, 7, 11].includes(m)) return 36; if ([6, 8].includes(m)) return 30; return 25; }

function computeRisk(res, duveMap) {
  const rate = res.rate || '';
  const pay = (res.payment || '').toLowerCase().trim();
  if (isNR(rate) && pay === 'success') return { score: 3, level: 'LOW', override: 'NR+Paid' };
  const duve = duveMap ? duveMap[res.id] : null;
  if (duve && duve.status === 'preCheckedIn') return { score: 3, level: 'LOW', override: 'Duve:preCheckedIn' };

  let s = 0.22 * scoreRate(rate) + 0.16 * scoreChannel(res.source) + 0.16 * scoreLeadTime(res.leadTimeDays) +
    0.10 * scoreLOS(res.nights) + 0.14 * scorePayment(res.payment) + 0.10 * scoreADR(res.adr) +
    0.05 * (res.hasNoContact ? 58 : 5) + 0.04 * scoreSeason(res.arrMonth) + 0.03 * (res.isSolo ? 38 : 22);

  let override = '';
  if (duve) {
    if (duve.status === 'beforeCheckIn' && duve.terms === "Didn't agree") { s += 5; override = 'Duve:noEngagement'; }
    else if (duve.status === 'beforeCheckIn' && duve.terms === 'Agreed') { s -= 3; override = 'Duve:partial'; }
  }
  s = Math.min(Math.round(s), 100);
  return { score: s, level: s >= 33 ? 'HIGH' : s >= 20 ? 'MEDIUM' : 'LOW', override };
}

// ─── TEMPLATE RECOMMENDATION ───
function getTemplate(level, daysUntil, nights) {
  if (level === 'HIGH') {
    if (nights >= 8) return '7A';
    if (daysUntil > 14) return nights >= 5 ? '1B' : '1A';
    if (daysUntil > 7) return '2A/2B';
    return '3A/3B';
  }
  if (level === 'MEDIUM') return daysUntil > 14 ? '4A' : '5A';
  return '-';
}
function getOffer(level, daysUntil, nights) {
  if (level === 'HIGH') {
    if (nights >= 8) return 'Welcome + mid-stay + late c-out';
    if (daysUntil > 14) return 'Early c-in + late c-out';
    if (daysUntil > 7) return 'Early c-in + upgrade';
    return 'Crédito / datas alt.';
  }
  if (level === 'MEDIUM') return daysUntil > 14 ? 'Guia bairro' : 'Info prática';
  return '-';
}

// ─── PARSE RESERVATION EXCEL ───
function parseReservations(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets['Reservations'];
  if (!ws) return [];
  const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const now = new Date();
  return data.filter(r => r.Identifier && (r.Status === 'Confirmed' || r.Status === 'Checked in')).map(r => {
    const arrival = r.Arrival ? new Date(r.Arrival) : null;
    const departure = r.Departure ? new Date(r.Departure) : null;
    const created = r.Created ? new Date(r.Created) : null;
    const nights = arrival && departure ? Math.round((departure - arrival) / 86400000) : 0;
    const leadTimeDays = arrival && created ? Math.round((arrival - created) / 86400000) : 0;
    const daysUntil = arrival ? Math.round((arrival - now) / 86400000) : 999;
    const adr = r['Average rate (nightly)'] || (r['Cancelled cost'] && nights ? r['Cancelled cost'] / nights : 0);
    const hasNoContact = (!r.Email || r.Email === '') && (!r.Telephone || r.Telephone === '');
    const isSolo = r['Person count'] === 1;
    // Detect property
    let prop = r.Property || '';
    if (!prop) {
      const rc = (r['Requested category'] || '').toLowerCase();
      if (rc.match(/[0-9]+[de]/i) || rc.includes('rcd') || rc.includes('rce')) prop = 'Alegria';
    }
    return {
      id: r.Identifier, guest: `${r['First name'] || ''} ${r['Last name'] || ''}`.trim(),
      prop, room: r['Space number'] || (r['Requested category'] || '').split(' - ')[0],
      roomType: r['Requested category'] || '', arrival: arrival ? arrival.toISOString().split('T')[0] : '',
      departure: departure ? departure.toISOString().split('T')[0] : '', nights, daysUntil, leadTimeDays,
      rate: r.Rate || '', adr: Math.round(adr || 0), total: Math.round(r['Total amount'] || 0),
      source: r['Reservation source'] || '', payment: r['Automatic payment'] || '',
      email: r.Email || '', phone: r.Telephone || '', persons: r['Person count'] || 1,
      nationality: r['Customer nationality'] || '', hasNoContact, isSolo,
      arrMonth: arrival ? arrival.getMonth() + 1 : null,
    };
  });
}

// ─── PARSE AVAILABILITY EXCEL ───
function parseAvailability(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  // Detect property from Parameters sheet
  let propName = 'Unknown';
  const params = wb.Sheets['Parameters'];
  if (params) {
    const pData = XLSX.utils.sheet_to_json(params, { header: 1 });
    const ent = pData.find(r => String(r[0] || '').includes('Enterprise'));
    if (ent) {
      const v = String(ent[1] || '');
      if (v.includes('Alegria')) propName = 'Alegria';
      else if (v.includes('Barbara II')) propName = 'SB II';
      else if (v.includes('Barbara I')) propName = 'SB I';
    }
  }
  const occSheet = wb.Sheets['Occupancy'];
  if (!occSheet) return { prop: propName, data: {} };
  const occData = XLSX.utils.sheet_to_json(occSheet, { header: 1, cellDates: true });
  const availSheet = wb.Sheets['Availability'];
  const rateSheet = wb.Sheets['Rate'];
  const availData = availSheet ? XLSX.utils.sheet_to_json(availSheet, { header: 1, cellDates: true }) : null;
  const rateData = rateSheet ? XLSX.utils.sheet_to_json(rateSheet, { header: 1, cellDates: true }) : null;
  const dates = (occData[0] || []).slice(2).filter(d => d instanceof Date);
  const result = {};
  dates.forEach((date, di) => {
    const key = date.toISOString().split('T')[0];
    let totalOcc = 0, totalSpaces = 0, totalAvail = 0, totalRate = 0, rc = 0;
    const roomTypes = [];
    for (let ri = 1; ri < occData.length; ri++) {
      if (occData[ri][0] !== 'Stay') continue;
      const rt = String(occData[ri][1] || '').trim();
      const o = Number(occData[ri][di + 2]) || 0;
      const a = availData ? (Number(availData[ri]?.[di + 2]) || 0) : 0;
      const rate = rateData ? (Number(rateData[ri]?.[di + 2]) || 0) : 0;
      totalOcc += o; totalSpaces++; totalAvail += a;
      if (rate > 0) { totalRate += rate; rc++; }
      roomTypes.push({ type: rt, occ: o, avail: a, rate: Math.round(rate) });
    }
    result[key] = {
      occ: totalOcc, spaces: totalSpaces, avail: totalAvail,
      avgRate: rc > 0 ? Math.round(totalRate / rc) : 0,
      occPct: totalSpaces > 0 ? Math.round(totalOcc / totalSpaces * 1000) / 10 : 0,
      rooms: roomTypes,
    };
  });
  return { prop: propName, data: result };
}

// ─── PARSE DUVE CSV ───
function parseDuve(text) {
  const lines = text.split('\n');
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const extIdx = header.indexOf('External Id');
  const statusIdx = header.indexOf('Status');
  const termsIdx = header.findIndex(h => h.includes('Terms'));
  const passIdx = header.findIndex(h => h.includes('passport'));
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    if (cols[extIdx]) {
      map[cols[extIdx]] = { status: cols[statusIdx] || '', terms: cols[termsIdx] || '', passport: cols[passIdx] || '' };
    }
  }
  return map;
}

// ─── COMPUTE OVERBOOKING ───
function computeOverbooking(reservations, availability) {
  const ops = [];
  const today = new Date().toISOString().split('T')[0];
  const cutoff = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];
  const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  ['Alegria', 'SB I', 'SB II'].forEach(prop => {
    const propAvail = availability[prop];
    if (!propAvail) return;
    const propRes = reservations.filter(r => r.prop === prop);
    Object.entries(propAvail).forEach(([dateStr, dayData]) => {
      if (dateStr < today || dateStr > cutoff) return;
      const occPct = dayData.occPct;
      const highOnDate = propRes.filter(r => r.level === 'HIGH' && r.arrival <= dateStr && r.departure > dateStr);
      if (occPct >= 70 && highOnDate.length > 0) {
        const ob = Math.min(Math.max(1, Math.floor(highOnDate.length * 0.4)), 3);
        const retActive = highOnDate.some(r => r.daysUntil > 7);
        const adj = Math.max(0, ob - (retActive ? 1 : 0));
        if (adj > 0) {
          const fullRooms = (dayData.rooms || []).filter(rt => rt.avail === 0 && rt.rate > 0);
          const roomLabels = fullRooms.slice(0, adj).map(rt => `${rt.type} (€${rt.rate})`);
          ops.push({
            date: dateStr, prop, occPct, nHigh: highOnDate.length, ob: adj,
            rooms: roomLabels.join(', ') || 'Any available', avgRate: dayData.avgRate,
            dow: dayNames[new Date(dateStr).getDay()],
          });
        }
      }
    });
  });
  return ops.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── API HANDLER ───
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // AUTH — simple token check
  const token = req.headers['authorization'] || req.query.token || '';
  const expectedToken = process.env.SHIELD_API_TOKEN || '';
  if (expectedToken && token.replace('Bearer ', '') !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // GET — return current data
    if (req.method === 'GET') {
      const blobs = await list({ prefix: 'shield-data' });
      if (blobs.blobs.length === 0) return res.status(200).json({ status: 'no_data', message: 'No data uploaded yet. POST files to /api/upload' });
      const latest = blobs.blobs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
      const response = await fetch(latest.url);
      const data = await response.json();
      return res.status(200).json(data);
    }

    // POST — receive files and process
    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';

      // Handle multipart form data (file uploads)
      if (contentType.includes('multipart/form-data') || contentType.includes('application/octet-stream')) {
        // For Zapier/webhook: expect JSON body with base64 files
        return res.status(400).json({ error: 'Use /api/upload for file uploads' });
      }

      // Handle JSON body with base64-encoded files
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !body.files) return res.status(400).json({ error: 'Missing files array in body' });

      let allReservations = [];
      let allAvailability = {};
      let duveMap = {};

      for (const file of body.files) {
        const buffer = Buffer.from(file.content, 'base64');
        if (file.type === 'reservation') {
          const parsed = parseReservations(buffer);
          // Merge, dedup by id
          const existingIds = new Set(allReservations.map(r => r.id));
          parsed.forEach(r => { if (!existingIds.has(r.id)) { allReservations.push(r); existingIds.add(r.id); } });
        } else if (file.type === 'availability') {
          const { prop, data } = parseAvailability(buffer);
          allAvailability[prop] = data;
        } else if (file.type === 'duve') {
          const text = buffer.toString('utf-8');
          duveMap = parseDuve(text);
        }
      }

      // Score all reservations
      allReservations = allReservations.map(r => {
        const { score, level, override } = computeRisk(r, duveMap);
        const factors = [];
        if (scoreRate(r.rate) >= 35) factors.push('Rate');
        if (scoreChannel(r.source) >= 35) factors.push('Canal');
        if (r.leadTimeDays > 30) factors.push(`LT:${r.leadTimeDays}d`);
        if (r.nights > 7) factors.push(`LOS:${r.nights}n`);
        if (scorePayment(r.payment) >= 30) factors.push('NoPay');
        if (scoreADR(r.adr) >= 40) factors.push(`ADR€${r.adr}`);
        if (r.hasNoContact) factors.push('NoContact');
        return { ...r, score, level, override, factors, template: getTemplate(level, r.daysUntil, r.nights), offer: getOffer(level, r.daysUntil, r.nights) };
      });

      // Compute overbooking
      const overbooking = computeOverbooking(allReservations, allAvailability);

      // Build summary
      const high = allReservations.filter(r => r.level === 'HIGH');
      const med = allReservations.filter(r => r.level === 'MEDIUM');
      const low = allReservations.filter(r => r.level === 'LOW');
      const output = {
        reservations: allReservations,
        overbooking,
        availability: Object.fromEntries(Object.entries(allAvailability).map(([prop, days]) =>
          [prop, Object.fromEntries(Object.entries(days).map(([k, v]) => [k, { occ: v.occ, spaces: v.spaces, occPct: v.occPct, avgRate: v.avgRate }]))]
        )),
        summary: {
          total: allReservations.length, high: high.length, medium: med.length, low: low.length,
          highRevenue: high.reduce((s, r) => s + r.total, 0), medRevenue: med.reduce((s, r) => s + r.total, 0),
          lowRevenue: low.reduce((s, r) => s + r.total, 0),
          duveOverrides: allReservations.filter(r => (r.override || '').includes('preCheckedIn')).length,
          nrPaidOverrides: allReservations.filter(r => r.override === 'NR+Paid').length,
          retentionCount: allReservations.filter(r => r.level !== 'LOW' && r.daysUntil > 3).length,
          obDays: overbooking.length, obNights: overbooking.reduce((s, o) => s + o.ob, 0),
        },
        generated: new Date().toISOString(),
      };

      // Store in Vercel Blob
      const blob = await put('shield-data/latest.json', JSON.stringify(output), {
        access: 'public', contentType: 'application/json', addRandomSuffix: false,
      });

      return res.status(200).json({
        status: 'ok', message: `Processed ${allReservations.length} reservations`,
        summary: output.summary, blobUrl: blob.url,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Shield API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
