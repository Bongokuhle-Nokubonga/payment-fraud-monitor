// Generates the synthetic sample data set. Deterministic (seeded random numbers), so the
// dashboard, the tests and data/sample-transactions.csv always contain exactly the same rows.
// All cards, people and amounts are made up. Merchant names are only there to look realistic.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NORMAL = [
  { category: "groceries", channel: "pos", min: 80, max: 1200, merchants: ["Checkers", "Pick n Pay", "Woolworths Food", "Spar"] },
  { category: "fuel", channel: "pos", min: 400, max: 950, merchants: ["Engen", "Shell", "Sasol", "BP"] },
  { category: "restaurants", channel: "pos", min: 90, max: 650, merchants: ["Nando's", "Spur", "Wimpy", "Ocean Basket"] },
  { category: "pharmacy", channel: "pos", min: 60, max: 700, merchants: ["Dis-Chem", "Clicks"] },
  { category: "clothing", channel: "pos", min: 150, max: 1400, merchants: ["Mr Price", "Pep", "Edgars", "Ackermans"] },
  { category: "online_retail", channel: "online", min: 99, max: 1500, merchants: ["Takealot", "Uber Eats", "Checkers Sixty60", "Netflix"] },
];

const HOMES = ["Johannesburg", "Pretoria", "Cape Town", "Durban", "Gqeberha", "Bloemfontein", "Polokwane", "Mbombela"];

/** Cards with a planted scenario: they get exactly 3 normal transactions on each of the first two days. */
export const SCENARIOS = {
  card_1003: { home: "Johannesburg", story: "Online shopping spree: 7 purchases in 46 minutes" },
  card_1007: { home: "Pretoria", story: "Card testing: four tiny gift-card charges at 2am, then a big electronics order" },
  card_1012: { home: "Johannesburg", story: "Cloned card: used in Johannesburg, then in London 75 minutes later" },
  card_1015: { home: "Durban", story: "One small online bet: risky merchant type, but nothing else unusual" },
  card_1018: { home: "Durban", story: "R18 500 TV purchase on a card that usually spends a few hundred rand" },
  card_1021: { home: "Cape Town", story: "Four declined crypto purchases at 1am, then one approved" },
  card_1025: { home: "Cape Town", story: "Used in person in Lagos at 3am" },
  card_1028: { home: "Johannesburg", story: "Genuine business trip: Johannesburg in the morning, Cape Town after the flight" },
};

const pad = (n) => String(n).padStart(2, "0");
const stamp = (day, h, m) => `2026-11-${pad(day)}T${pad(h)}:${pad(m)}:00`;

export function generateSample(seed = 20261118) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (min, max) => Math.round((min + rand() * (max - min)) * 100) / 100;
  const rows = [];
  const push = (r) => rows.push({ status: "approved", country: "ZA", ...r });

  for (let n = 1001; n <= 1030; n++) {
    const card = `card_${n}`;
    const scenario = SCENARIOS[card];
    const home = scenario?.home ?? pick(HOMES);
    const days = scenario ? [15, 16] : [15, 16, 17, 18];
    for (const day of days) {
      const count = scenario ? 3 : 1 + Math.floor(rand() * 3);
      const hours = [...new Set(Array.from({ length: 6 }, () => 7 + Math.floor(rand() * 14)))].slice(0, count).sort((a, b) => a - b);
      for (const h of hours) {
        const type = pick(NORMAL);
        push({
          time: stamp(day, h, Math.floor(rand() * 60)), card, amount: between(type.min, type.max),
          merchant: pick(type.merchants), category: type.category, city: home, channel: type.channel,
          status: !scenario && rand() < 0.02 ? "declined" : "approved",
        });
      }
    }
  }

  // card_1003: online spree
  [["20:05", "Takealot", 899], ["20:12", "Uber Eats", 345.5], ["20:20", "Superbalist", 1199], ["20:31", "Netflix", 199],
    ["20:38", "Bash", 760], ["20:44", "Apple", 1099]].forEach(([t, m, a]) =>
    push({ time: `2026-11-17T${t}:00`, card: "card_1003", amount: a, merchant: m, category: "online_retail", city: "Johannesburg", channel: "online" }));
  push({ time: "2026-11-17T20:51:00", card: "card_1003", amount: 1500, merchant: "Steam Gift Cards", category: "gift_cards", city: "Johannesburg", channel: "online" });

  // card_1007: card testing, then cash-out
  [["02:10", 5], ["02:12", 9.99], ["02:13", 12.5], ["02:15", 7]].forEach(([t, a]) =>
    push({ time: `2026-11-17T${t}:00`, card: "card_1007", amount: a, merchant: "GiftCardHub", category: "gift_cards", city: "Pretoria", channel: "online" }));
  push({ time: "2026-11-17T02:31:00", card: "card_1007", amount: 6499, merchant: "Incredible Connection Online", category: "electronics", city: "Pretoria", channel: "online" });

  // card_1012: impossible travel
  push({ time: "2026-11-17T10:05:00", card: "card_1012", amount: 452.3, merchant: "Woolworths Food", category: "groceries", city: "Johannesburg", channel: "pos" });
  push({ time: "2026-11-17T11:20:00", card: "card_1012", amount: 8900, merchant: "Harrods", category: "clothing", city: "London", country: "GB", channel: "pos" });

  // card_1015: a single small bet
  push({ time: "2026-11-17T19:30:00", card: "card_1015", amount: 200, merchant: "Hollywoodbets", category: "gambling", city: "Durban", channel: "online" });

  // card_1018: amount spike
  push({ time: "2026-11-18T14:40:00", card: "card_1018", amount: 18500, merchant: "Hi-Fi Corporation", category: "electronics", city: "Durban", channel: "pos" });

  // card_1021: declines, then approved
  ["01:02", "01:05", "01:09", "01:12"].forEach((t) =>
    push({ time: `2026-11-18T${t}:00`, card: "card_1021", amount: 7500, merchant: "CryptoSwap ZA", category: "crypto", city: "Cape Town", channel: "online", status: "declined" }));
  push({ time: "2026-11-18T01:16:00", card: "card_1021", amount: 7500, merchant: "CryptoSwap ZA", category: "crypto", city: "Cape Town", channel: "online" });

  // card_1025: new country at night
  push({ time: "2026-11-18T03:15:00", card: "card_1025", amount: 6200, merchant: "Ikeja Electronics", category: "electronics", city: "Lagos", country: "NG", channel: "pos" });

  // card_1028: genuine travel (must NOT be flagged)
  push({ time: "2026-11-17T07:40:00", card: "card_1028", amount: 65, merchant: "Vida e Caffe O.R. Tambo", category: "restaurants", city: "Johannesburg", channel: "pos" });
  push({ time: "2026-11-17T12:30:00", card: "card_1028", amount: 480, merchant: "Den Anker V&A Waterfront", category: "restaurants", city: "Cape Town", channel: "pos" });

  rows.sort((a, b) => a.time.localeCompare(b.time) || a.card.localeCompare(b.card));
  const header = "id,timestamp,card,amount,merchant,category,city,country,channel,status";
  const lines = rows.map((r, i) =>
    [`txn_${String(i + 1).padStart(5, "0")}`, r.time, r.card, r.amount.toFixed(2), r.merchant, r.category, r.city, r.country, r.channel, r.status]
      .map((v) => (/[",]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(","));
  return [header, ...lines].join("\n") + "\n";
}
