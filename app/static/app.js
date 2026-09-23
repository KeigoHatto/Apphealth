"use strict";

// ---------------------------------------------------------------- 共通

const METRIC_LABELS = {
  sleep_total: "睡眠時間（合計）", sleep_deep: "睡眠（深い）", sleep_rem: "睡眠（レム）",
  sleep_core: "睡眠（コア）", sleep_awake: "睡眠中の覚醒",
  heart_rate: "心拍数", resting_heart_rate: "安静時心拍数", heart_rate_variability: "心拍変動 (HRV)",
  walking_heart_rate_average: "歩行時平均心拍数", respiratory_rate: "呼吸数", vo2_max: "VO2max",
  step_count: "歩数", active_energy: "アクティブエネルギー", basal_energy_burned: "安静時消費エネルギー",
  walking_running_distance: "歩行+走行距離", apple_exercise_time: "エクササイズ時間",
  apple_stand_time: "スタンド時間", flights_climbed: "上った階数", time_in_daylight: "日光を浴びた時間",
  cardio_recovery: "心拍数回復",
};
const DEFAULT_METRICS = ["heart_rate_variability", "resting_heart_rate", "sleep_total"];

const state = { catalog: [], categories: [], units: {} };
const $ = (sel) => document.querySelector(sel);
const charts = {};

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function label(metric) {
  return METRIC_LABELS[metric] || metric;
}
function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "―";
  const abs = Math.abs(v);
  const d = abs >= 1000 ? 0 : abs >= 100 ? Math.min(digits, 1) : digits;
  return v.toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function signed(v, digits = 1) {
  if (v === null || v === undefined) return "―";
  return (v > 0 ? "+" : "") + fmt(v, digits);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function isoDate(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.status === 204 ? null : res.json();
}

function baseChartOptions() {
  const text = css("--text-secondary");
  const grid = css("--grid");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--surface-1"), titleColor: css("--text-primary"),
        bodyColor: css("--text-secondary"), borderColor: css("--border"), borderWidth: 1,
        padding: 10, displayColors: false,
      },
    },
    scales: {
      x: { ticks: { color: text, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false }, border: { color: grid } },
      y: { ticks: { color: text }, grid: { color: grid }, border: { display: false } },
    },
  };
}

function renderChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function table(headers, rows) {
  const th = headers.map((h) => `<th class="${h.num ? "num" : ""}">${esc(h.label)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + r.map((c, i) =>
    `<td class="${headers[i].num ? "num" : ""}${headers[i].wrap ? " note-cell" : ""}">${c}</td>`).join("") + "</tr>").join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}">データがありません</td></tr>`}</tbody></table>`;
}

// ---------------------------------------------------------------- タブ

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  try { localStorage.setItem("tab", name); } catch (_) { /* ignore */ }
  if (name === "dashboard") loadDashboard();
  if (name === "events") loadEvents();
  if (name === "analysis") loadAnalysis();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------- セレクタ

async function loadCatalog() {
  try {
    state.catalog = await api("/api/metrics/catalog");
  } catch (e) {
    state.catalog = [];
    console.error(e);
  }
  state.units = Object.fromEntries(state.catalog.map((m) => [m.metric_name, m.units || ""]));
  const opts = state.catalog.map((m) => `<option value="${esc(m.metric_name)}">${esc(label(m.metric_name))}</option>`).join("");
  document.querySelectorAll(".metric-select").forEach((sel, i) => {
    sel.innerHTML = opts;
    const available = DEFAULT_METRICS.find((m) => state.catalog.some((c) => c.metric_name === m && c.n_rows !== 0));
    sel.value = available || DEFAULT_METRICS[i % DEFAULT_METRICS.length];
  });
}

async function loadCategories() {
  try {
    state.categories = await api("/api/events/categories");
  } catch (e) {
    state.categories = [];
  }
  $("#category-list").innerHTML = state.categories.map((c) => `<option value="${esc(c.category)}">`).join("");
  document.querySelectorAll(".category-select").forEach((sel) => {
    const prev = sel.value;
    const all = sel.dataset.all ? `<option value="">${esc(sel.dataset.all)}</option>` : "";
    sel.innerHTML = all + state.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)}（${c.n}）</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  });
}

// ---------------------------------------------------------------- ダッシュボード

async function loadDashboard() {
  const metric = $("#dash-metric").value;
  if (!metric) return;
  const days = Number($("#dash-range").value);
  const category = $("#dash-category").value;
  const params = new URLSearchParams({ metric });
  const evParams = new URLSearchParams();
  if (days) {
    const start = isoDate(new Date(Date.now() - days * 86400000));
    params.set("start", start);
    evParams.set("start", start);
  }
  if (category) evParams.set("category", category);

  let data, events;
  try {
    [data, events] = await Promise.all([api(`/api/metrics/daily?${params}`), api(`/api/events?${evParams}`)]);
  } catch (e) {
    $("#dash-stats").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  const unit = state.units[metric] || "";
  $("#dash-title").textContent = `${label(metric)}${unit ? `（${unit}）` : ""}`;

  const values = data.series.map((p) => p.value);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const last = data.series.at(-1);
  $("#dash-stats").innerHTML = [
    ["最新", last ? fmt(last.value) : "―", last ? last.date : ""],
    ["期間平均", fmt(mean), `${values.length}日分`],
    ["最小", values.length ? fmt(Math.min(...values)) : "―", ""],
    ["最大", values.length ? fmt(Math.max(...values)) : "―", ""],
    ["イベント", String(events.length), category || "すべて"],
  ].map(([l, v, s]) => `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="label">${esc(s)}</div></div>`).join("");

  // イベントの日はラインの値の位置に点を打つ（値がない日は描かない）
  const byDate = Object.fromEntries(data.series.map((p) => [p.date, p.value]));
  const eventsByDate = {};
  events.forEach((e) => { (eventsByDate[e.date] ||= []).push(e); });
  const markers = Object.entries(eventsByDate)
    .filter(([d]) => d in byDate)
    .map(([d, evs]) => ({ x: d, y: byDate[d], evs }));

  const s1 = css("--series-1");
  const s2 = css("--series-2");
  const surface = css("--surface-1");
  const opts = baseChartOptions();
  opts.scales.x.type = "category";
  opts.plugins.tooltip.callbacks = {
    title: (items) => items[0]?.label || "",
    label: (item) => {
      if (item.dataset.type === "scatter") {
        return item.raw.evs.map((e) => `● ${e.category}${e.intensity ? `（強度${e.intensity}）` : ""}${e.note ? `: ${e.note}` : ""}`);
      }
      return `${label(metric)}: ${fmt(item.parsed.y)} ${unit}`;
    },
  };
  renderChart("dash-chart", {
    data: {
      labels: data.series.map((p) => p.date),
      datasets: [
        { type: "line", data: values, borderColor: s1, backgroundColor: s1, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true },
        { type: "scatter", data: markers, backgroundColor: s2, borderColor: surface, borderWidth: 2,
          pointRadius: 5, pointHoverRadius: 7, pointHitRadius: 10 },
      ],
    },
    options: opts,
  });

  $("#dash-table").innerHTML = table(
    [{ label: "日付" }, { label: label(metric), num: true }, { label: "イベント", wrap: true }],
    [...data.series].reverse().map((p) => [
      esc(p.date), fmt(p.value),
      esc((eventsByDate[p.date] || []).map((e) => e.category).join(", ")),
    ]),
  );
}
["#dash-metric", "#dash-range", "#dash-category"].forEach((s) => $(s).addEventListener("change", loadDashboard));

// ---------------------------------------------------------------- イベント

const form = $("#event-form");

function resetEventForm() {
  form.reset();
  form.id.value = "";
  form.date.value = isoDate(new Date());
  $("#event-form-title").textContent = "イベントを記録";
  $("#event-cancel").hidden = true;
}

async function loadEvents() {
  let events;
  try {
    events = await api("/api/events");
  } catch (e) {
    $("#event-list").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  $("#event-list").innerHTML = table(
    [{ label: "日付" }, { label: "カテゴリ" }, { label: "強度", num: true }, { label: "メモ", wrap: true }, { label: "" }],
    events.map((e) => [
      esc(e.date), esc(e.category), e.intensity ?? "―", esc(e.note || ""),
      `<button class="link" data-edit='${esc(JSON.stringify(e))}'>編集</button>` +
      `<button class="link danger" data-delete="${e.id}">削除</button>`,
    ]),
  );
}

$("#event-list").addEventListener("click", async (ev) => {
  const edit = ev.target.closest("[data-edit]");
  const del = ev.target.closest("[data-delete]");
  if (edit) {
    const e = JSON.parse(edit.dataset.edit);
    form.id.value = e.id;
    form.date.value = e.date;
    form.category.value = e.category;
    form.intensity.value = e.intensity ?? "";
    form.note.value = e.note || "";
    $("#event-form-title").textContent = "イベントを編集";
    $("#event-cancel").hidden = false;
    form.scrollIntoView({ behavior: "smooth" });
  } else if (del && confirm("このイベントを削除しますか？")) {
    await api(`/api/events/${del.dataset.delete}`, { method: "DELETE" });
    await Promise.all([loadEvents(), loadCategories()]);
  }
});

$("#event-cancel").addEventListener("click", resetEventForm);

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = {
    date: form.date.value,
    category: form.category.value,
    intensity: form.intensity.value ? Number(form.intensity.value) : null,
    note: form.note.value || null,
  };
  const id = form.id.value;
  const msg = $("#event-msg");
  try {
    await api(id ? `/api/events/${id}` : "/api/events", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    msg.className = "msg";
    msg.textContent = `${body.date} の「${body.category.trim().toLowerCase()}」を保存しました`;
    resetEventForm();
    await Promise.all([loadEvents(), loadCategories()]);
  } catch (e) {
    msg.className = "msg error";
    msg.textContent = `保存できませんでした: ${e.message}`;
  }
});

// ---------------------------------------------------------------- 分析

async function loadAnalysis() {
  await Promise.all([loadImpact(), loadCategoryComparison()]);
}

async function loadImpact() {
  const metric = $("#an-metric").value;
  const category = $("#an-category").value;
  if (!metric || !category) {
    $("#lag-table").innerHTML = '<p class="note">イベントを記録すると分析できます。</p>';
    if (charts["impact-chart"]) charts["impact-chart"].destroy();
    return;
  }
  const params = new URLSearchParams({ metric, category, window: $("#an-window").value });
  if ($("#an-intensity").value) params.set("min_intensity", $("#an-intensity").value);
  let r;
  try {
    r = await api(`/api/analysis/event-impact?${params}`);
  } catch (e) {
    $("#lag-table").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  const unit = state.units[metric] || "";
  $("#impact-title").textContent = `「${category}」の前後での ${label(metric)} の変化（${r.n_events}件）`;

  const opts = baseChartOptions();
  opts.interaction = { mode: "index", intersect: false };
  opts.plugins.tooltip.callbacks = {
    title: (items) => `${items[0].label}`,
    label: (item) => {
      const p = r.profile[item.dataIndex];
      return [`ベースラインとの差: ${signed(p.mean_delta)} ${unit}`, `平均値: ${fmt(p.mean_value)} ${unit}`, `件数: ${p.n}`];
    },
  };
  const zero = css("--zero-line");
  opts.scales.y.grid = { color: (ctx) => (ctx.tick.value === 0 ? zero : css("--grid")) };
  const s1 = css("--series-1");
  renderChart("impact-chart", {
    type: "bar",
    data: {
      labels: r.profile.map((p) => (p.offset === 0 ? "当日" : `${p.offset > 0 ? "+" : ""}${p.offset}日`)),
      datasets: [{
        data: r.profile.map((p) => p.mean_delta),
        backgroundColor: s1, borderRadius: 4, borderSkipped: false, maxBarThickness: 36,
      }],
    },
    options: opts,
  });

  $("#lag-table").innerHTML = table(
    [{ label: "" }, { label: "件数", num: true }, { label: "イベント後の平均", num: true },
      { label: "影響のない日の平均", num: true }, { label: "差", num: true }, { label: "効果量 d", num: true }],
    r.lags.map((l) => [
      l.lag === 0 ? "当日" : `${l.lag}日後`, l.event.n, fmt(l.event.mean), fmt(l.control.mean),
      `${signed(l.diff)} ${esc(unit)}`, signed(l.cohens_d, 2),
    ]),
  );
}

async function loadCategoryComparison() {
  const metric = $("#an-metric").value;
  if (!metric) return;
  const params = new URLSearchParams({ metric, lag: $("#cc-lag").value });
  if ($("#an-intensity").value) params.set("min_intensity", $("#an-intensity").value);
  let r;
  try {
    r = await api(`/api/analysis/category-comparison?${params}`);
  } catch (e) {
    $("#cc-table").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  const unit = state.units[metric] || "";
  const cats = r.categories.filter((c) => c.event.n > 0);
  const opts = baseChartOptions();
  opts.indexAxis = "y";
  opts.interaction = { mode: "nearest", axis: "y", intersect: false };
  opts.scales = {
    x: { ticks: { color: css("--text-secondary") }, grid: { color: (ctx) => (ctx.tick.value === 0 ? css("--zero-line") : css("--grid")) }, border: { display: false } },
    y: { ticks: { color: css("--text-secondary") }, grid: { display: false } },
  };
  opts.plugins.tooltip.callbacks = {
    label: (item) => {
      const c = cats[item.dataIndex];
      return [`差: ${signed(c.diff)} ${unit}`, `平均: ${fmt(c.event.mean)}（イベントなし ${fmt(r.control.mean)}）`,
        `中央値: ${fmt(c.event.median)}`, `件数: ${c.event.n}`];
    },
  };
  $("#cc-chart").parentElement.style.height = `${Math.max(160, cats.length * 40 + 60)}px`;
  renderChart("cc-chart", {
    type: "bar",
    data: {
      labels: cats.map((c) => `${c.category}（${c.event.n}）`),
      datasets: [{ data: cats.map((c) => c.diff), backgroundColor: css("--series-1"),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 24 }],
    },
    options: opts,
  });
  $("#cc-table").innerHTML = table(
    [{ label: "カテゴリ" }, { label: "件数", num: true }, { label: "平均", num: true }, { label: "中央値", num: true },
      { label: "四分位範囲", num: true }, { label: "差", num: true }, { label: "効果量 d", num: true }],
    [
      ...cats.map((c) => [esc(c.category), c.event.n, fmt(c.event.mean), fmt(c.event.median),
        `${fmt(c.event.q1)}〜${fmt(c.event.q3)}`, `${signed(c.diff)} ${esc(unit)}`, signed(c.cohens_d, 2)]),
      ["<em>イベントなし</em>", r.control.n, fmt(r.control.mean), fmt(r.control.median),
        `${fmt(r.control.q1)}〜${fmt(r.control.q3)}`, "", ""],
    ],
  );
}

["#an-metric", "#an-intensity"].forEach((s) => $(s).addEventListener("change", loadAnalysis));
["#an-category", "#an-window"].forEach((s) => $(s).addEventListener("change", loadImpact));
$("#cc-lag").addEventListener("change", loadCategoryComparison);

// ---------------------------------------------------------------- 取り込み

$("#webhook-url").textContent = `${location.origin}/webhook/health-export`;

$("#import-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("#import-msg");
  const fd = new FormData(ev.target);
  msg.className = "msg";
  msg.textContent = "取り込み中…";
  try {
    const r = await api("/api/import/zip", { method: "POST", body: fd });
    msg.textContent = "取り込み完了: " + Object.entries(r.imported).map(([k, v]) => `${k} ${v}件`).join(", ");
    await loadCatalog();
  } catch (e) {
    msg.className = "msg error";
    msg.textContent = `失敗しました: ${e.message}`;
  }
});

// ---------------------------------------------------------------- 起動

(async function init() {
  resetEventForm();
  await Promise.all([loadCatalog(), loadCategories()]);
  let tab = "dashboard";
  try { tab = localStorage.getItem("tab") || tab; } catch (_) { /* ignore */ }
  showTab(tab);
})();
