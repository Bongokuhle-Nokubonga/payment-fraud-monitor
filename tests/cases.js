import { toCents, formatZar, parseCsv, csvField, parseTransactions, distanceKm, CITIES, analyze, flaggedToCsv } from "../fraud.js";
import { generateSample, SCENARIOS } from "../sample.js";

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const HEADER = "id,timestamp,card,amount,merchant,category,city,country,channel,status";
/** Builds CSV from short rows: [time, card, amount, extra fields...] */
function csv(rows) {
  return [HEADER, ...rows.map((r, i) => {
    const [time, card, amount, o = {}] = r;
    return [`t${i + 1}`, time, card, amount, o.merchant ?? "Shop", o.category ?? "groceries", o.city ?? "Johannesburg",
      o.country ?? "ZA", o.channel ?? "pos", o.status ?? "approved"].join(",");
  })].join("\n");
}
function run(rows) {
  const p = parseTransactions(csv(rows));
  if (!p.ok) throw new Error(p.error);
  return analyze(p.transactions).results;
}
const ids = (r) => r.findings.map((f) => f.id);
const history = (card, n = 5, day = 10, opts = {}) =>
  Array.from({ length: n }, (_, i) => [`2026-11-${day}T${String(8 + i * 2).padStart(2, "0")}:00:00`, card, "300.00", opts]);

export const cases = [
  ["Money is handled in whole cents", () => {
    eq(toCents("1234.5"), 123450, "one decimal");
    eq(toCents("0.07"), 7, "small");
    eq(toCents("R 1 299.99"), 129999, "rand sign and space separator");
    eq(toCents("1,299.99"), 129999, "comma separator");
    eq(toCents("12.345"), null, "3 decimals rejected");
    eq(toCents("-50"), null, "negative rejected");
    eq(toCents("abc"), null, "text rejected");
    eq(formatZar(123450), "R 1 234.50", "format");
    eq(formatZar(1849999999), "R 18 499 999.99", "large");
    eq(0.1 + 0.2 === 0.3, false, "why we avoid floats");
  }],

  ["CSV parsing handles quotes, commas and line endings", () => {
    eq(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']], "quoted fields");
    eq(parseCsv("a,b\n\n1,2"), [["a", "b"], ["1", "2"]], "blank lines skipped");
    eq(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)", "formula neutralised");
    eq(csvField('a,"b"'), '"a,""b"""', "quoted output");
  }],

  ["Validates the file and reports bad rows", () => {
    ok(!parseTransactions("").ok, "empty");
    ok(/Missing column/.test(parseTransactions("id,amount\n1,2").error), "missing columns");
    const p = parseTransactions([HEADER,
      "a,2026-11-10T10:00:00,c1,100.00,S,groceries,Durban,ZA,pos,approved",
      "b,not-a-date,c1,100.00,S,groceries,Durban,ZA,pos,approved",
      "c,2026-11-10T10:00:00,c1,ten,S,groceries,Durban,ZA,pos,approved",
      "a,2026-11-10T11:00:00,c1,100.00,S,groceries,Durban,ZA,pos,approved",
      "d,2026-11-10T11:00:00,c1,100.00,S,groceries,Durban,ZA,atm,approved",
      "e,2026-11-10T11:00:00,c1,100.00,S,groceries,Durban,ZA,pos,pending"].join("\n"));
    ok(p.ok, "valid rows kept");
    eq(p.transactions.length, 1, "one valid row");
    eq(p.errors.length, 5, "five errors");
    ok(p.errors[0].startsWith("Line 3:"), `line numbers: ${p.errors[0]}`);
    ok(p.errors.some((e) => /duplicate id/.test(e)), "duplicate id");
  }],

  ["Distances between cities", () => {
    const jhbCpt = distanceKm(CITIES["Johannesburg"], CITIES["Cape Town"]);
    ok(jhbCpt > 1240 && jhbCpt < 1290, `JHB-CPT ~1265 km, got ${jhbCpt}`);
    eq(Math.round(distanceKm(CITIES["Durban"], CITIES["Durban"])), 0, "same city");
  }],

  ["Card testing: tiny charges, then a large purchase", () => {
    const r = run([
      ...history("c1"),
      ["2026-11-11T14:00:00", "c1", "5.00", { channel: "online" }],
      ["2026-11-11T14:03:00", "c1", "8.50", { channel: "online" }],
      ["2026-11-11T14:06:00", "c1", "3.00", { channel: "online" }],
      ["2026-11-11T14:40:00", "c1", "2999.00", { channel: "online" }],
    ]);
    ok(r.slice(5, 8).every((t) => ids(t).includes("card-testing")), "small charges flagged");
    ok(ids(r[8]).includes("test-then-large"), "large purchase flagged");
    const two = run([["2026-11-11T14:00:00", "c2", "5.00"], ["2026-11-11T14:03:00", "c2", "8.50"]]);
    ok(two.every((t) => !ids(t).includes("card-testing")), "two small charges are not enough");
  }],

  ["Impossible travel, but genuine flights are fine", () => {
    const r = run([
      ["2026-11-11T09:00:00", "c1", "120.00", { city: "Johannesburg" }],
      ["2026-11-11T10:00:00", "c1", "450.00", { city: "Cape Town" }],
    ]);
    ok(ids(r[1]).includes("impossible-travel"), "JHB to CPT (1 265 km) in 60 minutes is impossible");
    const flight = run([
      ["2026-11-11T07:00:00", "c2", "120.00", { city: "Johannesburg" }],
      ["2026-11-11T11:30:00", "c2", "450.00", { city: "Cape Town" }],
    ]);
    ok(!ids(flight[1]).includes("impossible-travel"), "4.5 hours later is a normal flight");
    const online = run([
      ["2026-11-11T09:00:00", "c3", "120.00", { city: "Johannesburg" }],
      ["2026-11-11T09:10:00", "c3", "450.00", { city: "London", channel: "online" }],
    ]);
    ok(!ids(online[1]).includes("impossible-travel"), "online purchases have no reliable location");
  }],

  ["Amount spike compares with the card's own history", () => {
    const r = run([...history("c1"), ["2026-11-11T12:00:00", "c1", "4500.00"]]);
    ok(ids(r[5]).includes("amount-spike"), "15x usual spend");
    ok(r[5].findings.find((f) => f.id === "amount-spike").detail.includes("15×"), "explains the multiple");
    const big = run([...history("c2", 5, 10).map(([t, c]) => [t, c, "4000.00"]), ["2026-11-11T12:00:00", "c2", "4500.00"]]);
    ok(!ids(big[5]).includes("amount-spike"), "normal for a big spender");
    const newCard = run([["2026-11-11T12:00:00", "c3", "4500.00"]]);
    ok(!ids(newCard[0]).includes("amount-spike"), "no history, no comparison");
  }],

  ["Declines followed by an approval", () => {
    const declined = { status: "declined", channel: "online" };
    const r = run([
      ["2026-11-11T01:00:00", "c1", "900.00", declined],
      ["2026-11-11T01:04:00", "c1", "900.00", declined],
      ["2026-11-11T01:08:00", "c1", "900.00", declined],
      ["2026-11-11T01:12:00", "c1", "900.00", { channel: "online" }],
    ]);
    ok(ids(r[3]).includes("declines-then-approved"), "flagged");
    ok(!ids(r[2]).includes("declines-then-approved"), "only the approval is flagged");
  }],

  ["Velocity, new country, night-time and risky merchants", () => {
    const spree = run(Array.from({ length: 5 }, (_, i) => [`2026-11-11T20:${String(i * 10).padStart(2, "0")}:00`, "c1", "200.00"]));
    ok(ids(spree[4]).includes("velocity") && !ids(spree[3]).includes("velocity"), "5th in an hour");
    const abroad = run([...history("c2", 3), ["2026-11-12T12:00:00", "c2", "300.00", { city: "Gaborone", country: "BW" }]]);
    ok(ids(abroad[3]).includes("new-country"), "first time in Botswana");
    const night = run([["2026-11-11T02:30:00", "c3", "5200.00"], ["2026-11-11T22:30:00", "c3", "5200.00"]]);
    ok(ids(night[0]).includes("night-high-value") && !ids(night[1]).includes("night-high-value"), "02:30 vs 22:30");
    const bet = run([["2026-11-11T12:00:00", "c4", "50.00", { category: "gambling" }]]);
    eq([ids(bet[0]), bet[0].level], [["high-risk-merchant"], "low"], "one weak signal stays low");
  }],

  ["Scores add up, cap at 100 and set the level", () => {
    const declined = { status: "declined", channel: "online", category: "crypto" };
    const r = run([
      ...history("c1"),
      ["2026-11-11T00:57:00", "c1", "7000.00", declined],
      ["2026-11-11T01:00:00", "c1", "7000.00", declined],
      ["2026-11-11T01:03:00", "c1", "7000.00", declined],
      ["2026-11-11T01:06:00", "c1", "7000.00", declined],
      ["2026-11-11T01:09:00", "c1", "7000.00", { channel: "online", category: "crypto" }],
    ]);
    const last = r[r.length - 1];
    eq([last.score, last.level], [100, "high"], "capped");
    ok(last.findings[0].points >= last.findings[last.findings.length - 1].points, "strongest signal first");
    eq(run(history("c2"))[4].level, "low", "normal spending is low");
  }],

  ["Sample data: every planted fraud is caught, normal cards are not", () => {
    const p = parseTransactions(generateSample());
    ok(p.ok && p.errors.length === 0, "sample parses cleanly");
    const { results, summary } = analyze(p.transactions);
    const worst = (card) => results.filter((r) => r.card === card).reduce((m, r) => Math.max(m, r.score), 0);
    for (const card of ["card_1007", "card_1012", "card_1021", "card_1025"]) ok(worst(card) >= 60, `${card} should be high risk`);
    ok(worst("card_1003") >= 30 && worst("card_1018") >= 30, "spree and spike need review");
    ok(worst("card_1015") < 30, "one small bet stays low");
    eq(worst("card_1028"), 0, "genuine business trip is not flagged");
    const normal = results.filter((r) => !SCENARIOS[r.card]);
    eq(normal.filter((r) => r.level !== "low").length, 0, "no false positives on normal cards");
    eq(summary.cardsAffected, 6, "six cards need action");
    ok(summary.valueAtRiskCents < summary.totalValueCents, "value at risk counts approved flagged spend");
    eq(generateSample(), generateSample(), "sample is deterministic");
  }],

  ["Export of flagged transactions", () => {
    const { results } = analyze(parseTransactions(generateSample()).transactions);
    const lines = flaggedToCsv(results).split("\n");
    eq(lines.length, 1 + results.filter((r) => r.level !== "low").length, "header + flagged rows");
    ok(lines[0].startsWith("id,timestamp,card,amount"), "header");
  }],
];
