// nexo — shared feature extraction.
// Both api/score.js (inference) and api/train.js (training) import from here,
// so the feature vector used to LEARN is guaranteed identical to the vector
// used to SCORE. Any drift between the two would silently break the model.

// ─── CONSTANTS ───
export const BDC_MO = {
  Alegria: [39.2, 29.2, 31.2, 22.2, 33.3, 32, 32, 29.4, 29.2, 49, 40.7, 33.3],
  "SB I":  [11.3, 25.3, 18.3, 37.4, 41.5, 47.4, 34.6, 37.6, 45.1, 50, 57.1, 34.5],
  "SB II": [9.7, 26.5, 27.9, 31.9, 33, 30.1, 31.5, 30.8, 38.3, 40.5, 29.2, 46.1]
};

export const NAT_HIGH = ["india", "angola", "mozambique", "united arab emirates", "saudi arabia", "nigeria", "greece", "türkiye", "turkey", "morocco"];
export const NAT_MED  = ["brazil", "serbia", "singapore", "korea", "finland", "israel", "taiwan", "romania"];
export const NAT_LOW  = ["belgium", "switzerland", "latvia", "mexico", "sweden", "netherlands", "ukraine", "france", "czech republic", "norway"];

// Ordered list of feature names. MUST match the order in extractFeatureVector
// and the keys expected by computeRiskFromVector. Never reorder without also
// invalidating all trained models in model_weights.
export const FEATURE_NAMES = [
  "pay", "rate", "lt", "chan", "los", "adr",
  "repeat", "card", "mod", "sea", "persons", "dow",
  "otaEmail", "nat", "natMiss", "agency", "noContact", "solo",
  "bookHour", "modCount", "adrVsAvg", "bookPayGap", "multiBook", "weather",
  "isRelay", "isGenius", "lateArrival"
];

// Leak-safe subset used for TRAINING only. Excludes features whose values are
// set (or drastically shifted) by the very act of cancelling — keeping them in
// the training matrix produced the perfect-AUC false positive we saw in prod:
//
//   pay      — paymentStatus flips to "fail"/"failed" the moment Mews voids
//              the charge after cancellation. Pre-cancel it's "charged".
//   mod      — wasModified. A cancellation IS a modification. Post-hoc true.
//   modCount — modificationCount. Same root cause.
//
// Scoring (api/score.js, lib/gbm.js) still uses the full 27-feature vector so
// the UI keeps showing non-zero values for these signals; the learned model
// simply never sees them, so it cannot cheat with them. If you retrain, both
// api/train.js and scripts/train_gbm.py MUST use this subset.
export const LEAK_SAFE_FEATURE_NAMES = FEATURE_NAMES.filter(
  name => name !== "pay" && name !== "mod" && name !== "modCount"
);

// ─── INDIVIDUAL SCORERS ───
export const isNonRefundable = r => {
  const l = (r || "").toLowerCase();
  return l.includes("nr ") || l.startsWith("nr") || l.includes("non-ref") || l.includes("non-refundable") || l.includes("early bird");
};

export const scoreRate = r => {
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

export const scoreChannel = s => {
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

export const scoreLeadTime = d => {
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

// NOTE: scoreSeason uses the property name from the reservation to pick
// the correct BDC curve. This is the FIX for the audit finding that the
// old client-side version hardcoded "Alegria" for all properties.
export const scoreSeason = (m, propName) => {
  if (!m) return 25;
  const name = (propName || "").toLowerCase();
  let key = "Alegria";
  if (name.includes("santa") && name.includes("ii")) key = "SB II";
  else if (name.includes("santa")) key = "SB I";
  const b = BDC_MO[key] || [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const i = (m - 3 + 12) % 12;
  return Math.round((b[i] || 30) * 0.7);
};

export const scoreLOS = n => {
  if (!n || n <= 0) return 20;
  if (n === 1)  return 30;
  if (n <= 2)   return 25;
  if (n <= 4)   return 20;
  if (n <= 7)   return 28;
  if (n <= 14)  return 55;
  return 70;
};

export const scorePayment = p => {
  const s = (p || "").toLowerCase().trim();
  if (s === "charged" || s === "paid" || s === "success") return 2;
  if (s === "partial") return 15;
  if (s === "fail" || s === "failed") return 50;
  return 45;
};

export const scoreADR = a => {
  if (!a || a <= 0) return 25;
  if (a < 80)    return 10;
  if (a < 120)   return 12;
  if (a < 180)   return 18;
  if (a < 250)   return 30;
  if (a < 400)   return 45;
  if (a < 1000)  return 55;
  return 40;
};

export const scoreNationality = nat => {
  const n = (nat || "").toLowerCase();
  if (NAT_HIGH.some(x => n.includes(x))) return 10;
  if (NAT_MED.some(x => n.includes(x)))  return 4;
  if (NAT_LOW.some(x => n.includes(x)))  return -5;
  return 0;
};

export const nationalityTier = nat => {
  const n = (nat || "").toLowerCase();
  if (NAT_HIGH.some(x => n.includes(x))) return "HIGH";
  if (NAT_LOW.some(x => n.includes(x)))  return "LOW";
  return "";
};

export const scoreRepeat = (ps, pc) => {
  if (ps >= 3) return -25;
  if (ps >= 1) return -15;
  if (pc >= 2) return 20;
  if (pc >= 1) return 10;
  return 0;
};

export const scoreCard       = h => h ? -5 : 8;
export const scoreModified   = w => w ? -5 : 3;
export const scoreAgency     = h => h ? 8 : 0;
export const scoreNatMissing = n => (!n || n === "") ? 5 : 0;

export const scoreDOW = a => {
  if (!a) return 0;
  const d = new Date(a + "T12:00:00").getDay();
  if (d === 5 || d === 6) return 5;
  if (d === 0) return 3;
  return 0;
};

export const scorePersons = (c, ch) => {
  if (ch) return -8;
  if (c >= 3) return -3;
  if (c === 1) return 5;
  return 0;
};

export const scoreOtaEmail = (h, e) => {
  if (h) return 12;
  if (e && (e.includes("@guest.booking.com") || e.includes("@relay."))) return 15;
  return 0;
};

export const scoreBookingHour = h => {
  if (h === null || h === undefined) return 50;
  if (h >= 0 && h <= 5) return 78;
  if (h >= 22)          return 65;
  if (h >= 6 && h <= 9) return 38;
  return 50;
};

export const scoreModCount = c => {
  if (!c || c === 0) return 35;
  if (c === 1) return 55;
  if (c === 2) return 68;
  return Math.min(80, 68 + c * 4);
};

export const scoreADRvsAvg = (a, avg) => {
  if (!avg || !a || avg === 0) return 50;
  const r = a / avg;
  if (r < 0.6) return 75;
  if (r < 0.8) return 62;
  if (r > 1.4) return 30;
  if (r > 1.1) return 40;
  return 50;
};

export const scoreBookPayGap = g => {
  if (g === null || g === undefined) return 50;
  if (g <= 0) return 28;
  if (g <= 1) return 38;
  if (g <= 3) return 50;
  if (g <= 7) return 62;
  return 75;
};

export const scoreMultiBooking = c => {
  if (!c || c <= 1) return 45;
  if (c === 2)      return 65;
  return Math.min(82, 65 + c * 5);
};

export const scoreWeather = code => {
  if (!code) return 50;
  if (code >= 200 && code < 300) return 72;
  if (code >= 500 && code < 600) return 65;
  if (code >= 600 && code < 700) return 68;
  if (code === 800)              return 32;
  if (code >= 801 && code <= 802) return 40;
  return 50;
};

// ─── FEATURE VECTOR ───
// Given a raw reservation (as stored in predictions.features), return the
// numeric feature vector in the order defined by FEATURE_NAMES. Used by both
// scoring and training so the two never disagree.
export function extractFeatureVector(r) {
  const pay = (r.paymentStatus || r.payment || "").toLowerCase().trim();
  return {
    pay:        scorePayment(pay),
    rate:       scoreRate(r.rate || ""),
    lt:         scoreLeadTime(r.daysUntil),
    chan:       scoreChannel(r.source),
    los:        scoreLOS(r.nights),
    adr:        scoreADR(r.adr),
    repeat:     scoreRepeat(r.previousStays || 0, r.previousCancels || 0),
    card:       scoreCard(r.hasCreditCard),
    mod:        scoreModified(r.wasModified),
    sea:        scoreSeason(r.arrMonth, r.prop),
    persons:    scorePersons(r.persons, r.hasChildren),
    dow:        scoreDOW(r.arrival),
    otaEmail:   scoreOtaEmail(r.hasOtaEmail, r.email || ""),
    nat:        scoreNationality(r.nationality),
    natMiss:    scoreNatMissing(r.nationality),
    agency:     scoreAgency(r.hasTravelAgency),
    noContact:  r.hasNoContact ? 55 : 5,
    solo:       r.isSolo ? 35 : 15,
    bookHour:   scoreBookingHour(r.bookingHour),
    modCount:   scoreModCount(r.modificationCount || 0),
    adrVsAvg:   scoreADRvsAvg(r.adr, r.propAvgAdr),
    bookPayGap: scoreBookPayGap(r.bookPayGapDays),
    multiBook:  scoreMultiBooking(r.guestActiveBookings),
    weather:    scoreWeather(r.weatherCode),
    isRelay:    r.isRelay ? 1 : 0,
    isGenius:   r.isGenius ? 1 : 0,
    lateArrival: r.lateArrival ? 1 : 0
  };
}

// Hard overrides that bypass the model entirely. Returns a risk object if
// an override matches, or null if the reservation should flow through the
// normal scoring path.
// KEPT for backward compat. Flagged in the audit as potentially mis-calibrated
// (e.g. hasParking → 3% is a guess). Future PR may remove these once the
// learned model has enough history to handle the same cases naturally.
export function applyHardOverrides(r) {
  const rate = r.rate || "";
  const pay  = (r.paymentStatus || r.payment || "").toLowerCase().trim();

  if (isNonRefundable(rate) && (pay === "charged" || pay === "success" || pay === "paid"))
    return { score: 2, level: "LOW", override: "NR+Paid", prob: 3 };
  if (r.previousStays >= 2 && isNonRefundable(rate))
    return { score: 3, level: "LOW", override: "Repeat+NR", prob: 4 };
  if (r.hasParking)     return { score: 3, level: "LOW", override: "Safe:Parking", prob: 3 };
  if (r.hasVoucher)     return { score: 4, level: "LOW", override: "Safe:Voucher", prob: 5 };
  if (r.guestCheckedIn) return { score: 3, level: "LOW", override: "Safe:GuestCheckedIn", prob: 3 };
  if (r.hasPet)         return { score: 5, level: "LOW", override: "Safe:Pet", prob: 5 };
  if (r.previousStays >= 3) return { score: 5, level: "LOW", override: "Safe:Loyal", prob: 5 };
  return null;
}

// Human-readable risk factors for the UI. Uses the raw reservation, not the
// feature vector, so it can reference the original values.
export function extractRiskFactors(r) {
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
