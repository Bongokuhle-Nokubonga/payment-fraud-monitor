import { parseTransactions, analyze, formatZar, flaggedToCsv, ACTIONS } from "./fraud.js";
import { generateSample } from "./sample.js";

const $ = (id) => document.getElementById(id);
const LEVEL_LABEL = { high: "High", review: "Review", low: "Low" };

let state = { results: [], summary: null, filter: "action", query: "", selected: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const when = (iso) => iso.slice(5, 10).replace("-", "/") + " " + iso.slice(11, 16);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "0%");

// Everything shown comes from the CSV (untrusted), so text is only ever set with textContent.
function load(text, label) {
  const parsed = parseTransactions(text);
  const notice = $("notice");
  if (!parsed.ok) {
    notice.hidden = false;
    notice.className = "notice error";
    notice.textContent = parsed.error;
    return;
  }
  if (parsed.errors.length) {
    notice.hidden = false;
    notice.className = "notice";
    notice.textContent = `Skipped ${parsed.errors.length} row(s) with problems. ${parsed.errors.slice(0, 3).join(" · ")}${parsed.errors.length > 3 ? " …" : ""}`;
  } else {
    notice.hidden = true;
  }
  const { results, summary } = analyze(parsed.transactions);
  state = { ...state, results, summary, selected: null };
  $("source").textContent = `Showing: ${label}`;
  render();
  const first = visible()[0];
  if (first) select(first.id, false);
}

function visible() {
  const q = state.query.trim().toLowerCase();
  return state.results
    .filter((r) => state.filter === "all" || (state.filter === "action" ? r.level !== "low" : r.level === state.filter))
    .filter((r) => !q || [r.card, r.merchant, r.city, r.country, r.id].some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => b.score - a.score || b.time - a.time);
}

function renderKpis() {
  const s = state.summary;
  $("kTotal").textContent = s.total.toLocaleString("en-ZA");
  $("kCards").textContent = `across ${s.cards} cards`;
  $("kHigh").textContent = String(s.high);
  $("kReview").textContent = String(s.review);
  $("kValue").textContent = formatZar(s.valueAtRiskCents);
  $("kValueShare").textContent = `${pct(s.valueAtRiskCents, s.totalValueCents)} of approved spend`;
  $("kAffected").textContent = String(s.cardsAffected);
  $("kAffectedShare").textContent = `${pct(s.cardsAffected, s.cards)} of cards`;

  const bars = $("ruleBars");
  bars.replaceChildren();
  const entries = Object.entries(s.ruleCounts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  if (!entries.length) bars.append(el("li", "muted", "No signals triggered."));
  for (const [title, count] of entries) {
    const li = el("li");
    const track = el("span", "track");
    const fill = el("i");
    fill.style.width = `${(count / max) * 100}%`;
    track.append(fill);
    li.append(el("span", "", title), el("b", "", String(count)), track);
    bars.append(li);
  }

  const counts = { action: s.high + s.review, high: s.high, review: s.review, all: s.total };
  $("cAction").textContent = String(counts.action);
  $("cHigh").textContent = String(counts.high);
  $("cReview").textContent = String(counts.review);
  $("cAll").textContent = String(counts.all);
}

function renderRows() {
  const body = $("rows");
  body.replaceChildren();
  const rows = visible();
  $("empty").hidden = rows.length > 0;
  for (const r of rows.slice(0, 500)) {
    const tr = el("tr", `lv-${r.level}`);
    tr.tabIndex = 0;
    tr.dataset.id = r.id;
    tr.setAttribute("aria-selected", String(r.id === state.selected));
    const merchant = el("td", "", r.merchant);
    merchant.title = r.merchant;
    if (r.status === "declined") merchant.append(el("span", "declined", "declined"));
    const risk = el("td");
    const riskWrap = el("span", "risk");
    riskWrap.append(el("span", `pill ${r.level}`, LEVEL_LABEL[r.level]), String(r.score));
    risk.append(riskWrap);
    const sigs = el("td");
    if (r.findings[0]) {
      const top = el("span", "sig", r.findings[0].title);
      top.title = r.findings.map((f) => f.title).join(", ");
      sigs.append(top);
    }
    if (r.findings.length > 1) sigs.append(el("span", "sig", `+${r.findings.length - 1}`));
    tr.append(el("td", "mono", when(r.timestamp)), el("td", "mono", r.card), merchant,
      el("td", "", `${r.city}, ${r.country}`), el("td", "num", formatZar(r.cents)), risk, sigs);
    tr.addEventListener("click", () => select(r.id, true));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(r.id, true); } });
    body.append(tr);
  }
}

function renderDetail() {
  const box = $("detail");
  box.replaceChildren();
  const r = state.results.find((x) => x.id === state.selected);
  if (!r) {
    box.append(el("p", "detail-hint", "Select a transaction to see why it was flagged and the card's recent activity."));
    return;
  }
  const head = el("div", "risk");
  head.append(el("span", `pill ${r.level}`, `${LEVEL_LABEL[r.level]} risk`), `Score ${r.score}/100`);
  box.append(head, el("h2", "", r.merchant), el("p", "amount", formatZar(r.cents)));

  const facts = el("dl", "facts");
  [["Card", r.card], ["When", `${r.timestamp.slice(0, 10)} ${r.timestamp.slice(11, 16)}`], ["Where", `${r.city}, ${r.country}`],
    ["Channel", r.channel === "pos" ? "In person (card present)" : "Online (card not present)"],
    ["Status", r.status === "approved" ? "Approved" : "Declined"], ["Category", r.category.replace(/_/g, " ")], ["Reference", r.id]]
    .forEach(([k, v]) => facts.append(el("dt", "", k), el("dd", "", v)));
  box.append(facts, el("div", `action ${r.level}`, ACTIONS[r.level]));

  box.append(el("h3", "", r.findings.length ? `Why it was flagged (${r.findings.length})` : "Why it was flagged"));
  const list = el("ul", "findings");
  if (!r.findings.length) list.append(el("li", "", "No rules fired for this transaction."));
  for (const f of r.findings) {
    const li = el("li");
    const b = el("b", "", f.title);
    b.append(el("span", "", `+${f.points}`));
    li.append(b, el("p", "", f.detail));
    list.append(li);
  }
  box.append(list);

  const history = state.results.filter((x) => x.card === r.card);
  box.append(el("h3", "", `Card activity (${history.length})`));
  const tl = el("ul", "timeline");
  for (const h of history.slice(-12)) {
    const li = el("li", `${h.level}${h.id === r.id ? " current" : ""}`);
    const t = el("span", "mono");
    t.append(el("span", "dot"), when(h.timestamp));
    li.append(t, el("span", "where", `${h.merchant} · ${h.city}${h.status === "declined" ? " · declined" : ""}`), el("span", "num", formatZar(h.cents)));
    tl.append(li);
  }
  box.append(tl);
}

function render() {
  if (!state.summary) return;
  renderKpis();
  renderRows();
  renderDetail();
}

function select(id, scroll) {
  state.selected = id;
  document.querySelectorAll("#rows tr").forEach((tr) => tr.setAttribute("aria-selected", String(tr.dataset.id === id)));
  renderDetail();
  if (scroll && window.matchMedia("(max-width: 1080px)").matches) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  state.filter = b.dataset.level;
  renderRows();
}));
$("search").addEventListener("input", (e) => { state.query = e.target.value; renderRows(); });
$("loadSample").addEventListener("click", () => load(generateSample(), "synthetic sample (30 cards, 4 days)"));
$("file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    $("notice").hidden = false;
    $("notice").className = "notice error";
    $("notice").textContent = "That file is over 5 MB. Upload a smaller extract.";
    return;
  }
  file.text().then((text) => load(text, file.name));
  e.target.value = "";
});
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([flaggedToCsv(state.results)], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "flagged-transactions.csv" });
  a.click();
  URL.revokeObjectURL(url);
});

load(generateSample(), "synthetic sample (30 cards, 4 days)");
