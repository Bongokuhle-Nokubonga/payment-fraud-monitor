// Payment fraud rules engine. Pure functions, no DOM: used by the dashboard and the tests.
// Money is always handled as whole cents (integers) so there are no floating-point rounding errors.

/** Known cities: [latitude, longitude]. Used for the impossible-travel rule. */
export const CITIES = {
  "Johannesburg": [-26.2041, 28.0473], "Pretoria": [-25.7479, 28.2293], "Cape Town": [-33.9249, 18.4241],
  "Durban": [-29.8587, 31.0218], "Gqeberha": [-33.9608, 25.6022], "Bloemfontein": [-29.0852, 26.1596],
  "Polokwane": [-23.9045, 29.4689], "Mbombela": [-25.4658, 30.9853], "East London": [-33.0153, 27.9116],
  "Kimberley": [-28.7282, 24.7499], "Gaborone": [-24.6282, 25.9231], "Windhoek": [-22.5609, 17.0658],
  "Maputo": [-25.9692, 32.5732], "Harare": [-17.8292, 31.0522], "Lagos": [6.5244, 3.3792],
  "Nairobi": [-1.2921, 36.8219], "London": [51.5072, -0.1276], "Dubai": [25.2048, 55.2708],
  "New York": [40.7128, -74.006], "Singapore": [1.3521, 103.8198],
};

export const HIGH_RISK_CATEGORIES = {
  gambling: "Gambling", crypto: "Crypto exchange", gift_cards: "Gift cards", money_transfer: "Money transfer",
};

/** Thresholds for every rule, in one place so they are easy to tune. */
export const RULES = {
  cardTesting: { smallCents: 2000, count: 3, windowMin: 10, points: 30 },
  testThenLarge: { largeCents: 100000, windowMin: 60, points: 35 },
  velocity: { count: 5, windowMin: 60, points: 20 },
  impossibleTravel: { maxKmh: 900, minKm: 100, points: 40 },
  amountSpike: { multiple: 5, minHistory: 5, minCents: 200000, points: 30 },
  declinesThenApproved: { declines: 3, windowMin: 30, points: 30 },
  newCountry: { minHistory: 3, points: 20 },
  nightHighValue: { fromHour: 0, toHour: 5, minCents: 500000, points: 10 },
  highRiskMerchant: { points: 15 },
};

export const LEVELS = { high: 60, review: 30 };

const REQUIRED = ["id", "timestamp", "card", "amount", "merchant", "category", "city", "country", "channel", "status"];
const MAX_ROWS = 20000;
const MIN = 60 * 1000;

// ---------- Money ----------

/** "1234.5" -> 123450 cents. Returns null for anything that isn't a positive amount with up to 2 decimals. */
export function toCents(text) {
  const t = String(text ?? "").trim().replace(/^R\s?/i, "").replace(/[\s,](?=\d{3}\b)/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 123450 -> "R 1 234.50" (South African style: space as thousands separator). */
export function formatZar(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const rands = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R ${rands}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------- CSV ----------

/** Parses CSV text into rows of fields. Handles quoted fields, "" escapes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** One CSV field, quoted when needed, and neutralised so Excel won't run it as a formula. */
export function csvField(value) {
  let v = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Turns CSV text into validated transactions.
 * @returns {{ ok: true, transactions: object[], errors: string[] } | { ok: false, error: string }}
 */
export function parseTransactions(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, error: "The file has no transactions. It needs a header row and at least one data row." };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, error: `Missing column(s): ${missing.join(", ")}. Expected: ${REQUIRED.join(", ")}.` };
  if (rows.length - 1 > MAX_ROWS) return { ok: false, error: `Too many rows (${rows.length - 1}). The limit is ${MAX_ROWS}.` };

  const col = Object.fromEntries(REQUIRED.map((c) => [c, header.indexOf(c)]));
  const transactions = [];
  const errors = [];
  const seenIds = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (c) => (r[col[c]] ?? "").trim();
    const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(get("timestamp")) ? get("timestamp") : get("timestamp") + "Z");
    const cents = toCents(get("amount"));
    const status = get("status").toLowerCase();
    const channel = get("channel").toLowerCase();
    const problem =
      !get("id") ? "missing id" :
      seenIds.has(get("id")) ? `duplicate id ${get("id")}` :
      !get("card") ? "missing card" :
      Number.isNaN(time) ? `invalid timestamp "${get("timestamp")}"` :
      cents === null ? `invalid amount "${get("amount")}"` :
      !["approved", "declined"].includes(status) ? `status must be approved or declined, got "${get("status")}"` :
      !["pos", "online"].includes(channel) ? `channel must be pos or online, got "${get("channel")}"` : null;
    if (problem) { errors.push(`Line ${line}: ${problem}`); return; }
    seenIds.add(get("id"));
    transactions.push({
      id: get("id"), time, timestamp: new Date(time).toISOString(), card: get("card"), cents,
      merchant: get("merchant"), category: get("category").toLowerCase(), city: get("city"),
      country: get("country").toUpperCase(), channel, status,
    });
  });
  if (!transactions.length) return { ok: false, error: `No valid transactions. ${errors.slice(0, 3).join("; ")}` };
  return { ok: true, transactions, errors };
}

// ---------- Geography ----------

/** Great-circle distance in km between two [lat, lon] points (haversine formula). */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const minutes = (ms) => Math.round(ms / MIN);
function duration(ms) {
  const m = minutes(ms);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- Analysis ----------

/**
 * Scores every transaction. Each rule that fires adds points and an explanation.
 * @returns {{ results: object[], summary: object }}
 */
export function analyze(transactions) {
  const sorted = [...transactions].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const findings = new Map(sorted.map((t) => [t.id, []]));
  const add = (t, id, points, title, detail) => {
    const list = findings.get(t.id);
    if (!list.some((f) => f.id === id)) list.push({ id, points, title, detail });
  };

  const byCard = new Map();
  for (const t of sorted) {
    if (!byCard.has(t.card)) byCard.set(t.card, []);
    byCard.get(t.card).push(t);
  }

  for (const txns of byCard.values()) {
    txns.forEach((t, i) => {
      const before = txns.slice(0, i);
      const approvedBefore = before.filter((p) => p.status === "approved");

      // Card testing: several tiny charges in a few minutes (checking a stolen card works).
      const ct = RULES.cardTesting;
      if (t.cents < ct.smallCents) {
        const burst = txns.filter((o) => o.cents < ct.smallCents && Math.abs(o.time - t.time) <= ct.windowMin * MIN);
        if (burst.length >= ct.count) {
          add(t, "card-testing", ct.points, "Card testing pattern",
            `${burst.length} charges under ${formatZar(ct.smallCents)} within ${ct.windowMin} minutes. Fraudsters make tiny charges to check a stolen card works.`);
        }
      }

      // A large purchase shortly after a burst of tiny ones.
      const tl = RULES.testThenLarge;
      if (t.cents >= tl.largeCents && t.status === "approved") {
        const smallBefore = before.filter((p) => p.cents < ct.smallCents && t.time - p.time <= tl.windowMin * MIN);
        if (smallBefore.length >= ct.count) {
          add(t, "test-then-large", tl.points, "Large purchase right after test charges",
            `${formatZar(t.cents)} came ${duration(t.time - smallBefore[smallBefore.length - 1].time)} after ${smallBefore.length} tiny charges. This is how card testing usually ends.`);
        }
      }

      // Velocity: too many transactions in a short time.
      const v = RULES.velocity;
      const recent = txns.filter((o) => o.time <= t.time && t.time - o.time <= v.windowMin * MIN);
      if (recent.length >= v.count) {
        add(t, "velocity", v.points, "Unusually many transactions",
          `${recent.length} transactions on this card in ${duration(t.time - recent[0].time)}. Normal customers rarely do more than ${v.count - 1} an hour.`);
      }

      // Impossible travel: two in-person payments too far apart for the time between them.
      const it = RULES.impossibleTravel;
      if (t.channel === "pos" && t.status === "approved" && CITIES[t.city]) {
        const prev = [...approvedBefore].reverse().find((p) => p.channel === "pos" && CITIES[p.city]);
        if (prev && prev.city !== t.city) {
          const km = distanceKm(CITIES[prev.city], CITIES[t.city]);
          const hours = Math.max((t.time - prev.time) / 3600000, 1 / 60);
          if (km >= it.minKm && km / hours > it.maxKmh) {
            add(t, "impossible-travel", it.points, "Impossible travel",
              `Card used in person in ${prev.city} and then ${t.city}, ${Math.round(km).toLocaleString("en-US").replace(/,/g, " ")} km apart, only ${duration(t.time - prev.time)} later. That would need ${Math.round(km / hours).toLocaleString("en-US").replace(/,/g, " ")} km/h. The card has probably been cloned.`);
          }
        }
      }

      // Amount spike: far above what this card normally spends.
      const as = RULES.amountSpike;
      if (t.cents >= as.minCents && approvedBefore.length >= as.minHistory) {
        const usual = median(approvedBefore.map((p) => p.cents));
        if (usual > 0 && t.cents >= usual * as.multiple) {
          add(t, "amount-spike", as.points, "Much bigger than usual",
            `${formatZar(t.cents)} is ${Math.round(t.cents / usual)}× this card's typical spend of ${formatZar(usual)}.`);
        }
      }

      // Approved after several declines: guessing the CVV or expiry date until one works.
      const dt = RULES.declinesThenApproved;
      if (t.status === "approved") {
        const declines = before.filter((p) => p.status === "declined" && t.time - p.time <= dt.windowMin * MIN);
        if (declines.length >= dt.declines) {
          add(t, "declines-then-approved", dt.points, "Approved after repeated declines",
            `${declines.length} declined attempts in the ${duration(t.time - declines[0].time)} before this approval. Someone may have been guessing the CVV or expiry date.`);
        }
      }

      // New country: first time this card has been used in this country.
      const nc = RULES.newCountry;
      if (before.length >= nc.minHistory && t.country && !before.some((p) => p.country === t.country)) {
        const home = before[0].country;
        add(t, "new-country", nc.points, "First use in a new country",
          `This card has only been used in ${[...new Set(before.map((p) => p.country))].join(", ")} before. Now ${t.city || "unknown city"}, ${t.country}${t.country !== home ? " (not the home country)" : ""}.`);
      }

      // Night-time high value.
      const nh = RULES.nightHighValue;
      const hour = new Date(t.time).getUTCHours();
      if (t.cents >= nh.minCents && hour >= nh.fromHour && hour < nh.toHour) {
        add(t, "night-high-value", nh.points, "High value in the middle of the night",
          `${formatZar(t.cents)} at ${String(hour).padStart(2, "0")}:${String(new Date(t.time).getUTCMinutes()).padStart(2, "0")}. Large payments between midnight and 05:00 are unusual for most customers.`);
      }

      // High-risk merchant category.
      if (HIGH_RISK_CATEGORIES[t.category]) {
        add(t, "high-risk-merchant", RULES.highRiskMerchant.points, "High-risk merchant type",
          `${HIGH_RISK_CATEGORIES[t.category]} merchants are popular for cashing out stolen cards because the money is hard to recover.`);
      }
    });
  }

  const results = sorted.map((t) => {
    const f = findings.get(t.id).sort((a, b) => b.points - a.points);
    const score = Math.min(100, f.reduce((s, x) => s + x.points, 0));
    const level = score >= LEVELS.high ? "high" : score >= LEVELS.review ? "review" : "low";
    return { ...t, score, level, findings: f };
  });

  return { results, summary: summarize(results) };
}

export function summarize(results) {
  const flagged = results.filter((r) => r.level !== "low");
  const ruleCounts = {};
  for (const r of results) for (const f of r.findings) ruleCounts[f.title] = (ruleCounts[f.title] ?? 0) + 1;
  return {
    total: results.length,
    flagged: flagged.length,
    high: results.filter((r) => r.level === "high").length,
    review: results.filter((r) => r.level === "review").length,
    valueAtRiskCents: flagged.filter((r) => r.status === "approved").reduce((s, r) => s + r.cents, 0),
    totalValueCents: results.filter((r) => r.status === "approved").reduce((s, r) => s + r.cents, 0),
    cardsAffected: new Set(flagged.map((r) => r.card)).size,
    cards: new Set(results.map((r) => r.card)).size,
    ruleCounts,
  };
}

/** What an analyst should do, by risk level. */
export const ACTIONS = {
  high: "Block the card, contact the customer on their registered number, and reverse or dispute the fraudulent transactions.",
  review: "Send to an analyst. Check with the customer (app notification or SMS) before taking action.",
  low: "No action needed.",
};

/** Flagged transactions as CSV for a case-management system. */
export function flaggedToCsv(results) {
  const head = ["id", "timestamp", "card", "amount", "merchant", "city", "country", "status", "score", "level", "signals"];
  const rows = results.filter((r) => r.level !== "low").map((r) =>
    [r.id, r.timestamp, r.card, (r.cents / 100).toFixed(2), r.merchant, r.city, r.country, r.status, r.score, r.level,
      r.findings.map((f) => f.title).join("; ")].map(csvField).join(","));
  return [head.join(","), ...rows].join("\n");
}
