// nexo — cancellation risk scoring (backend)
// Moved from public/index.html as part of PR 1: backend-scoring.
// This is a pure refactoring — the algorithm is byte-identical to the
// previous client-side version. Future PRs will replace hand-tuned weights
// with model coefficients trained from Mews cancellation history.

// ─── CONSTANTS ───
const BDC_MO = {
  Alegria: [39.2, 29.2, 31.2, 22.2, 33.3, 32, 32, 29.4, 29.2, 49, 40.7, 33.3],
  "SB I":  [11.3, 25.3, 18.3, 37.4, 41.5, 47.4, 34.6, 37.6, 45.1, 50, 57.1, 34.5],
  "SB II": [9.7, 26.5, 27.9, 31.9, 33, 30.1, 31.5, 30.8, 38.3, 40.5, 29.2, 46.1]
};

const NAT_HIGH = ["india", "angola", "mozambique", "united arab emirates", "saudi arabia", "nigeria", "greece", "türkiye", "turkey", "morocco"];
const NAT_MED  = ["brazil", "serbia", "singapore", "korea", "finland", "israel", "taiwan", "romania"];
const NAT_LOW  = ["belgium", "switzerland", "latvia", "mexico", "sweden", "netherlands", "ukraine", "france", "czech republic", "norway"];

const CANCEL_PROB_SCALE    = 0.08;
const CANCEL_PROB_MIDPOINT = 35;
const SIGMOID_MAX          = 95;
const SIGMOID_MIN          = 3;

// Hand-tuned weights (v1). Replaced with learned coefs in PR 3.
const DEFAULT_WEIGHTS = {
  pay: 0.15, rate: 0.14, lt: 0.13, chan: 0.12, los: 0.06, adr: 0.05,
  repeat: 0.08, card: 0.06, mod: 0.06, sea: 0.04, persons: 0.03, dow: 0.04,
  otaEmail: 0.03, nat: 0.04, natMiss: 0.03, agency: 0.03, noContact: 0.03,
  solo: 0.02, bookHour: 0.03, modCount: 0.04, adrVsAvg: 0.03, bookPayGap: 0.04,
  multiBook: 0.03, weather: 0.02
};

// ─── FEATURE SCORERS (27 signals) ───
const isNonRefundable = r => {
  const l = (r || "").toLowerCase();
  return l.includes("nr ") || l.startsWith("nr") || l.includes("non-ref") || l.includes("non-refundable") || l.includes("early bird");
};

const scoreRate = r => {
  const l = (r || "").toLowerCase();
  if (l.includes("flex 3") || l.includes("fully flexible")) return 62;
  if (l.includes("standard") && l.includes("breakfast"))    return 50;
  if (l.includes("flex 5"))                                  return 48;
  if (l.includes("semi-flex"))                               return 38;
  if (l.includes("standard") && l.includes("booking"))       return 32;
  if (l.includes("standard"))                                return 35;
  if (l.includes("flex") && (l.includes("ota") || l.includes("pku"))) return 55;
  if (l.includes("best flex") || l.includes("best rate"))    return 45;
  if (l.includes("half board"))                              return 30;
  if (l.includes("bed and breakfast") || l.includes("b&b"))  return 28;
  if (l.includes("black friday"))                            return 35;
  if (l.includes("friends") || l.includes("family"))         return 5;
  if (l.includes("welcome"))                                 return 3;
  if (isNonRefundable(r))                                    return 3;
  if (l.includes("long"))                                    return 10;
  if (l.includes("superior"))                                return 20;
  if (l.includes("test") || l.includes("aut ") || l.includes("solution")) return 30;
  return 28;
};

const scoreChannel = s => {
  const l = (s || "").toLowerCase();
  if (l.includes("telephone"))                              return 85;
  if (l.includes("a-hotels") || l.includes("american express")) return 82;
  if (l.includes("booking.com"))                            return 38;
  if (l.includes("booking engine"))                         return 32;
  if (l.includes("channel"))                                return 35;
  if (l.includes("in person"))                              return 30;
  if (l.includes("message") || l.includes("email"))         return 25;
  if (l.includes("hotels.com"))                             return 18;
  if (l.includes("airbnb"))                                 return 14;
  if (l.includes("expedia"))                                return 17;
  if (l === "connector" || l.includes("connector"))         return 55;
  if (l === "distributor" || l.includes("distributor"))     return 50;
  if (l === "commander" || l.includes("commander"))         return 20;
  return 25;
};

const scoreLeadTime = d => {
  if (!d && d !== 0) return 20;
  if (d < 0)  return 5;
  if (d <= 1) return 15;
  if (d <= 3) return 30;
  if (d <= 7) return 40;
  if (d <= 14) return 48;
  if (d <= 30) return 55;
  if (d <= 60) return 65;
  if (d <= 90) return 72;
  return 80;
};

// NOTE: hardcoded to "Alegria" seasonal curve for all properties.
// This is a known bug flagged in the model audit — fixed in PR 3 by
// looking up BDC_MO[prop] from the reservation's property name.
const scoreSeason = m => {
  if (!m) return 25;
  const b = BDC_MO["Alegria"] || [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const i = (m - 3 + 12) % 12;
  return Math.round((b[i] || 30) * 0.7);
};

const scoreLOS = n => {
  if (!n || n <= 0) return 20;
  if (n === 1)  return 30;
  if (n <= 2)   return 25;
  if (n <= 4)   return 20;
  if (n <= 7)   return 28;
  if (n <= 14)  return 55;
  return 70;
};

const scorePayment = p => {
  const s = (p || "").toLowerCase().trim();
  if (s === "charged" || s === "paid" || s === "success") return 2;
  if (s === "partial") return 15;
  if (s === "fail" || s === "failed") return 50;
  return 45;
};

const scoreADR = a => {
  if (!a || a <= 0) return 25;
  if (a < 80)    return 10;
  if (a < 120)   return 12;
  if (a < 180)   return 18;
  if (a < 250)   return 30;
  if (a < 400)   return 45;
  if (a < 1000)  return 55;
  return 40;
};

const scoreNationality = nat => {
  const n = (nat || "").toLowerCase();
  if (NAT_HIGH.some(x => n.includes(x))) return 10;
  if (NAT_MED.some(x => n.includes(x)))  return 4;
  if (NAT_LOW.some(x => n.includes(x)))  return -5;
  return 0;
};

const scoreRepeat = (ps, pc) => {
  if (ps >= 3) return -25;
  if (ps >= 1) return -15;
  if (pc >= 2) return 20;
  if (pc >= 1) return 10;
  return 0;
};

const scoreCard       = h => h ? -5 : 8;
const scoreModified   = w => w ? -5 : 3;
const scoreAgency     = h => h ? 8 : 0;
const scoreNatMissing = n => (!n || n === "") ? 5 : 0;

const scoreDOW = a => {
  if (!a) return 0;
  const d = new Date(a + "T12:00:00").getDay();
  if (d === 5 || d === 6) return 5;
  if (d === 0) return 3;
  return 0;
};

const scorePersons = (c, ch) => {
  if (ch) return -8;
  if (c >= 3) return -3;
  if (c === 1) return 5;
  return 0;
};

const scoreOtaEmail = (h, e) => {
  if (h) return 12;
  if (e && (e.includes("@guest.booking.com") || e.includes("@relay."))) return 15;
  return 0;
};

const scoreBookingHour = h => {
  if (h === null || h === undefined) return 50;
  if (h >= 0 && h <= 5) return 78;
  if (h >= 22)          return 65;
  if (h >= 6 && h <= 9) return 38;
  return 50;
};

const scoreModCount = c => {
  if (!c || c === 0) return 35;
  if (c === 1) return 55;
  if (c === 2) return 68;
  return Math.min(80, 68 + c * 4);
};

const scoreADRvsAvg = (a, avg) => {
  if (!avg || !a || avg === 0) return 50;
  const r = a / avg;
  if (r < 0.6) return 75;
  if (r < 0.8) return 62;
  if (r > 1.4) return 30;
  if (r > 1.1) return 40;
  return 50;
};

const scoreBookPayGap = g => {
  if (g === null || g === undefined) return 50;
  if (g <= 0) return 28;
  if (g <= 1) return 38;
  if (g <= 3) return 50;
  if (g <= 7) return 62;
  return 75;
};

const scoreMultiBooking = c => {
  if (!c || c <= 1) return 45;
  if (c === 2)      return 65;
  return Math.min(82, 65 + c * 5);
};

const scoreWeather = code => {
  if (!code) return 50;
  if (code >= 200 && code < 300) return 72;
  if (code >= 500 && code < 600) return 65;
  if (code >= 600 && code < 700) return 68;
  if (code === 800)              return 32;
  if (code >= 801 && code <= 802) return 40;
  return 50;
};

// ─── CORE ───
function cancelProbability(score) {
  if (score <= 0)  return SIGMOID_MIN;
  if (score >= 80) return SIGMOID_MAX;
  const p = SIGMOID_MAX / (1 + Math.exp(-CANCEL_PROB_SCALE * (score - CANCEL_PROB_MIDPOINT)));
  return Math.max(SIGMOID_MIN, Math.min(SIGMOID_MAX, Math.round(p)));
}

function extractRiskFactors(r) {
  const factors = [];
  if (r.previousCancels > 0) factors.push("Cancelou antes");
  if (r.previousStays > 0)   factors.push("Repetente");
  if (!r.hasCreditCard && r.paymentStatus !== "charged") factors.push("Sem cartão");
  if (r.hasOtaEmail)      factors.push("Email OTA");
  if (r.hasTravelAgency)  factors.push("Agência");
  if (r.hasChildren)      factors.push("Família");
  if (r.wasModified)      factors.push("Modificada");
  if (scoreRate(r.rate) >= 35)       factors.push("Rate flexível");
  if (scoreChannel(r.source) >= 35)  factors.push("Canal arriscado");
  if (r.leadTimeDays > 30) factors.push("Antecedência " + r.leadTimeDays + "d");
  if (r.nights > 7)        factors.push("Estadia longa");
  if (scorePayment(r.payment) >= 30) factors.push("Sem pagamento");
  if (r.bookingHour !== null && (r.bookingHour >= 22 || r.bookingHour <= 5)) factors.push("Reserva noturna");
  if (r.guestActiveBookings >= 2) factors.push("Multi-reserva");
  if (r.weatherCode && r.weatherCode >= 500) factors.push("Mau tempo");
  return factors;
}

export function computeRisk(r, calW) {
  const rate = r.rate || "";
  const pay = (r.paymentStatus || r.payment || "").toLowerCase().trim();
  const w = calW || null;

  // Hard overrides — bypass model entirely.
  // Flagged in audit as potentially miscalibrated; kept for parity in PR 1.
  if (isNonRefundable(rate) && (pay === "charged" || pay === "success" || pay === "paid"))
    return { score: 2, level: "LOW", override: "NR+Paid", prob: 3, factors: [] };
  if (r.previousStays >= 2 && isNonRefundable(rate))
    return { score: 3, level: "LOW", override: "Repeat+NR", prob: 4, factors: [] };
  if (r.hasParking)     return { score: 3, level: "LOW", override: "Safe:Parking", prob: 3, factors: [] };
  if (r.hasVoucher)     return { score: 4, level: "LOW", override: "Safe:Voucher", prob: 5, factors: [] };
  if (r.guestCheckedIn) return { score: 3, level: "LOW", override: "Safe:GuestCheckedIn", prob: 3, factors: [] };
  if (r.hasPet)         return { score: 5, level: "LOW", override: "Safe:Pet", prob: 5, factors: [] };
  if (r.previousStays >= 3) return { score: 5, level: "LOW", override: "Safe:Loyal", prob: 5, factors: [] };

  const dw = DEFAULT_WEIGHTS;
  const W  = w || dw;
  let s = 0;
  s += (W.pay       || dw.pay)       * scorePayment(pay);
  s += (W.rate      || dw.rate)      * scoreRate(rate);
  s += (W.lt        || dw.lt)        * scoreLeadTime(r.daysUntil);
  s += (W.chan      || dw.chan)      * scoreChannel(r.source);
  s += (W.los       || dw.los)       * scoreLOS(r.nights);
  s += (W.adr       || dw.adr)       * scoreADR(r.adr);
  s += (W.repeat    || dw.repeat)    * scoreRepeat(r.previousStays || 0, r.previousCancels || 0);
  s += (W.card      || dw.card)      * scoreCard(r.hasCreditCard);
  s += (W.mod       || dw.mod)       * scoreModified(r.wasModified);
  s += (W.sea       || dw.sea)       * scoreSeason(r.arrMonth);
  s += (W.persons   || dw.persons)   * scorePersons(r.persons, r.hasChildren);
  s += (W.dow       || dw.dow)       * scoreDOW(r.arrival);
  s += (W.otaEmail  || dw.otaEmail)  * scoreOtaEmail(r.hasOtaEmail, r.email);
  s += (W.nat       || dw.nat)       * scoreNationality(r.nationality);
  s += (W.natMiss   || dw.natMiss)   * scoreNatMissing(r.nationality);
  s += (W.agency    || dw.agency)    * scoreAgency(r.hasTravelAgency);
  s += (W.noContact || dw.noContact) * (r.hasNoContact ? 55 : 5);
  s += (W.solo      || dw.solo)      * (r.isSolo ? 35 : 15);
  s += (W.bookHour  || dw.bookHour)  * scoreBookingHour(r.bookingHour);
  s += (W.modCount  || dw.modCount)  * scoreModCount(r.modificationCount || 0);
  s += (W.adrVsAvg  || dw.adrVsAvg)  * scoreADRvsAvg(r.adr, r.propAvgAdr);
  s += (W.bookPayGap|| dw.bookPayGap)* scoreBookPayGap(r.bookPayGapDays);
  s += (W.multiBook || dw.multiBook) * scoreMultiBooking(r.guestActiveBookings);
  s += (W.weather   || dw.weather)   * scoreWeather(r.weatherCode);

  // Bonus signals
  if (r.isRelay)     s += 15;
  if (r.isGenius)    s -= 3;
  if (r.lateArrival) s += 3;

  let ov = "";
  if (isNonRefundable(rate) && pay !== "charged" && pay !== "success" && pay !== "paid") {
    s += 10;
    ov = "NR:noPay";
  }

  s = Math.max(0, Math.min(Math.round(s), 100));
  const prob = cancelProbability(s);
  const level = s >= 38 ? "HIGH" : s >= 18 ? "MEDIUM" : "LOW";
  const factors = extractRiskFactors(r);
  return { score: s, level, override: ov, prob, factors };
}

// ─── HTTP HANDLER ───
// POST /api/score
// Body: { reservations: [ { ...features }, ... ], weights?: {...} }
// Response: { results: [ { id, score, level, prob, override, factors }, ... ], model_version: "hand-tuned-v1" }
export default async function handler(req, res) {
  // CORS — mirror the mews proxy pattern
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const isProd = process.env.VERCEL_ENV === "production";
  if (isProd && ALLOWED_ORIGINS.length === 0) {
    console.error("[score] FATAL: ALLOWED_ORIGINS not configured in production");
    return res.status(500).json({ error: "Server misconfiguration: CORS unset" });
  }
  if (ALLOWED_ORIGINS.length > 0) {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { reservations, weights } = req.body || {};
  if (!Array.isArray(reservations)) {
    return res.status(400).json({ error: "Missing or invalid reservations array" });
  }
  if (reservations.length > 5000) {
    return res.status(413).json({ error: "Too many reservations in one call (max 5000)" });
  }

  try {
    const results = reservations.map(r => {
      const risk = computeRisk(r, weights);
      return { id: r.id, ...risk };
    });
    return res.status(200).json({
      results,
      model_version: "hand-tuned-v1",
      scored_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[score] error:", err.message);
    return res.status(500).json({ error: "Scoring failed", message: err.message });
  }
}
