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
  cardio_recovery: "心拍数回復", mood: "気分",
};
const DEFAULT_METRICS = ["heart_rate_variability", "resting_heart_rate", "sleep_total"];

const WORKOUT_PREFIX = "workout:";
const WORKOUT_LABELS = {
  "Outdoor Run": "ランニング（屋外）", "Indoor Run": "ランニング（屋内）", "Running": "ランニング",
  "Outdoor Walk": "ウォーキング（屋外）", "Indoor Walk": "ウォーキング（屋内）", "Walking": "ウォーキング",
  "Outdoor Cycling": "サイクリング（屋外）", "Indoor Cycling": "サイクリング（屋内）", "Cycling": "サイクリング",
  "Hiking": "ハイキング", "Yoga": "ヨガ", "Pilates": "ピラティス", "Swimming": "水泳",
  "Pool Swim": "水泳（プール）", "Open Water Swim": "水泳（オープンウォーター）", "Elliptical": "エリプティカル",
  "Rower": "ローイング", "Stair Stepper": "ステアステッパー", "HIIT": "HIIT",
  "High Intensity Interval Training": "HIIT", "Traditional Strength Training": "筋トレ",
  "Functional Strength Training": "機能的筋トレ", "Core Training": "体幹トレーニング", "Dance": "ダンス",
  "Cooldown": "クールダウン", "Mixed Cardio": "ミックスカーディオ", "Tennis": "テニス", "Soccer": "サッカー",
  "Other": "その他",
};

const state = { catalog: [], categories: [], units: {} };
const $ = (sel) => document.querySelector(sel);
const charts = {};

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function label(metric) {
  return METRIC_LABELS[metric] || metric;
}
function workoutLabel(name) {
  return WORKOUT_LABELS[name] || name || "その他";
}
// イベントのカテゴリ表示名（ワークアウトは 'workout:<種類>' で来る）
function catLabel(category) {
  return category.startsWith(WORKOUT_PREFIX) ? `🏃 ${workoutLabel(category.slice(WORKOUT_PREFIX.length))}` : category;
}
function fmtMinutes(min) {
  if (min === null || min === undefined) return "―";
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}` : `${m}分`;
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
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function dateParts(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return { md: `${d.getMonth() + 1}/${d.getDate()}`, wd: WEEKDAYS[d.getDay()], year: d.getFullYear() };
}
function dateBlock(iso) {
  const p = dateParts(iso);
  const yearNote = p.year !== new Date().getFullYear() ? `${p.year} ` : "";
  return `<div class="list-date"><span class="day">${p.md}</span><span class="sub">${yearNote}${p.wd}曜</span></div>`;
}
const LIST_PAGE = 30;
function isoDate(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

// 読み込みが長引いたら状態を出す（Render の無料プランはスリープ復帰に数十秒かかる）
const net = { pending: 0, timers: [] };
function setNetStatus(text) {
  const el = $("#net-status");
  if (text) {
    $("#net-status-text").textContent = text;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
  } else {
    el.classList.remove("show");
  }
}
function netStart() {
  if (net.pending++ > 0) return;
  net.timers = [
    setTimeout(() => setNetStatus("読み込み中…"), 1200),
    setTimeout(() => setNetStatus("サーバーを起動しています（1分ほどかかることがあります）"), 5000),
  ];
}
function netEnd() {
  if (--net.pending > 0) return;
  net.timers.forEach(clearTimeout);
  setNetStatus(null);
}

async function api(path, options = {}) {
  netStart();
  let res;
  try {
    res = await fetch(path, options);
  } finally {
    netEnd();
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.status === 204 ? null : res.json();
}

// 完了・エラーの通知。action を渡すと「元に戻す」などのボタンが付く
let toastTimer = null;
function toast(text, { action, onAction, error = false, duration = 4000 } = {}) {
  const el = $("#toast");
  const btn = $("#toast-action");
  $("#toast-text").textContent = text;
  el.classList.toggle("error", error);
  btn.hidden = !action;
  btn.textContent = action || "";
  btn.onclick = action ? () => { hideToast(); onAction(); } : null;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? Math.max(duration, 6000) : duration);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").classList.remove("show");
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

const TAB_ORDER = ["dashboard", "events", "workouts", "analysis", "import"];
let currentTab = null;

function showTab(name) {
  if (!TAB_ORDER.includes(name)) name = "dashboard";
  const prev = currentTab;
  currentTab = name;
  document.querySelectorAll(".tabbar button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((s) => {
    s.hidden = s.id !== `tab-${name}`;
    s.classList.remove("enter-left", "enter-right");
  });
  // 右のタブへ移ったら右から、左へ戻ったら左から入ってくる（同じ道を行き来する）
  if (prev && prev !== name) {
    const panel = $(`#tab-${name}`);
    void panel.offsetWidth;
    panel.classList.add(TAB_ORDER.indexOf(name) > TAB_ORDER.indexOf(prev) ? "enter-right" : "enter-left");
    window.scrollTo({ top: 0 });
  }
  try { localStorage.setItem("tab", name); } catch (_) { /* ignore */ }
  if (name === "dashboard") loadDashboard();
  if (name === "events") { loadEvents(); loadMoods(); loadReminder(); }
  if (name === "workouts") loadWorkouts();
  if (name === "analysis") loadAnalysis();
}
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.querySelectorAll(".tab").forEach((s) => s.addEventListener("animationend", () => s.classList.remove("enter-left", "enter-right")));

// ヘッダーの境界線は、下にコンテンツが潜り込んでいるときだけ出す
const topBar = $("#top");
window.addEventListener("scroll", () => topBar.classList.toggle("scrolled", window.scrollY > 4), { passive: true });

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
  // 手入力イベントとワークアウトの種類。ワークアウトは 'workout:<種類>' として分析対象になる
  try {
    state.categories = await api("/api/analysis/categories");
  } catch (e) {
    state.categories = [];
  }
  const events = state.categories.filter((c) => c.kind === "event");
  const workouts = state.categories.filter((c) => c.kind === "workout");
  $("#category-list").innerHTML = events.map((c) => `<option value="${esc(c.category)}">`).join("");
  // よく使うカテゴリはワンタップで入力できるように
  $("#category-chips").innerHTML = events.slice(0, 8)
    .map((c) => `<button type="button" class="chip" data-category="${esc(c.category)}">${esc(c.category)}</button>`).join("");
  syncFormChips();
  const opt = (c) => `<option value="${esc(c.category)}">${esc(catLabel(c.category))}（${c.n}）</option>`;
  const group = (name, items) => (items.length ? `<optgroup label="${name}">${items.map(opt).join("")}</optgroup>` : "");
  document.querySelectorAll(".category-select").forEach((sel) => {
    const prev = sel.value;
    const all = sel.dataset.all ? `<option value="">${esc(sel.dataset.all)}</option>` : "";
    sel.innerHTML = all + group("イベント", events) + group("ワークアウト", workouts);
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  });
  const types = workouts.map((c) => c.category.slice(WORKOUT_PREFIX.length));
  document.querySelectorAll(".workout-type-select").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = `<option value="">${esc(sel.dataset.all)}</option>` +
      types.map((t) => `<option value="${esc(t)}">${esc(workoutLabel(t))}</option>`).join("");
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
    [data, events] = await Promise.all([api(`/api/metrics/daily?${params}`), api(`/api/occurrences?${evParams}`)]);
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
    ["イベント・ワークアウト", String(events.length), category ? catLabel(category) : "すべて"],
  ].map(([l, v, s]) => `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join("");

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
        return item.raw.evs.map((e) => `● ${catLabel(e.category)}${e.intensity ? `（強度${e.intensity}）` : ""}${e.note ? `: ${e.note}` : ""}`);
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
    [{ label: "日付" }, { label: label(metric), num: true }, { label: "イベント・ワークアウト", wrap: true }],
    [...data.series].reverse().map((p) => [
      esc(p.date), fmt(p.value),
      esc((eventsByDate[p.date] || []).map((e) => catLabel(e.category)).join(", ")),
    ]),
  );
}
["#dash-metric", "#dash-range", "#dash-category"].forEach((s) => $(s).addEventListener("change", loadDashboard));

// ---------------------------------------------------------------- イベント

const form = $("#event-form");
const eventsView = { rows: [], limit: LIST_PAGE };

function resetEventForm() {
  form.reset();
  form.id.value = "";
  form.date.value = isoDate(new Date());
  $("#event-form-title").textContent = "イベントを記録";
  $("#event-cancel").hidden = true;
  setCategoryError(false);
  $("#event-msg").textContent = "";
  syncFormChips();
}

function setCategoryError(on) {
  $("#category-error").hidden = !on;
  form.category.setAttribute("aria-invalid", String(on));
}

// チップの選択状態を入力値に合わせる
function syncFormChips() {
  const today = isoDate(new Date());
  document.querySelectorAll("[data-date-offset]").forEach((c) => {
    const d = new Date();
    d.setDate(d.getDate() + Number(c.dataset.dateOffset));
    c.setAttribute("aria-pressed", String(form.date.value === isoDate(d)));
  });
  const cat = form.category.value.trim().toLowerCase();
  document.querySelectorAll("[data-category]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.category === cat)));
  return today;
}

document.querySelectorAll("[data-date-offset]").forEach((c) => c.addEventListener("click", () => {
  const d = new Date();
  d.setDate(d.getDate() + Number(c.dataset.dateOffset));
  form.date.value = isoDate(d);
  syncFormChips();
}));
$("#category-chips").addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-category]");
  if (!chip) return;
  form.category.value = chip.dataset.category;
  setCategoryError(false);
  syncFormChips();
});
form.date.addEventListener("input", syncFormChips);
form.category.addEventListener("input", () => { setCategoryError(false); syncFormChips(); });

function intensityDots(n) {
  if (!n) return "";
  return `<span class="intensity" aria-label="強度${n}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderEvents() {
  const { rows, limit } = eventsView;
  if (!rows.length) {
    $("#event-list").innerHTML = '<p class="empty">まだ記録がありません。上のフォームから追加できます。</p>';
    return;
  }
  const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  $("#event-list").innerHTML = `<ul class="list">${rows.slice(0, limit).map((e) => `
    <li class="list-row tappable" data-id="${e.id}" tabindex="0" aria-label="${esc(e.date)} ${esc(e.category)} を編集">
      ${dateBlock(e.date)}
      <div class="list-main">
        <div class="list-title">${esc(e.category)}</div>
        ${e.note ? `<div class="list-sub">${esc(e.note)}</div>` : ""}
      </div>
      <div class="list-trailing">
        ${intensityDots(e.intensity)}
        <button type="button" class="icon-button danger" data-delete="${e.id}" aria-label="削除">${trash}</button>
      </div>
    </li>`).join("")}</ul>` +
    (rows.length > limit ? `<button type="button" class="more" data-more>さらに表示（残り${rows.length - limit}件）</button>` : "");
}

async function loadEvents() {
  try {
    eventsView.rows = await api("/api/events");
  } catch (e) {
    $("#event-list").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  renderEvents();
}

function editEvent(e) {
  form.id.value = e.id;
  form.date.value = e.date;
  form.category.value = e.category;
  form.intensity.value = e.intensity ?? "";
  form.note.value = e.note || "";
  $("#event-form-title").textContent = "イベントを編集";
  $("#event-cancel").hidden = false;
  syncFormChips();
  form.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

async function saveEvent(body, id = null) {
  return api(id ? `/api/events/${id}` : "/api/events", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function refreshAfterEventChange() {
  await Promise.all([loadEvents(), loadCategories()]);
}

// 削除は確認ダイアログを出さず、すぐ消して「元に戻す」を出す
async function deleteEvent(id) {
  const e = eventsView.rows.find((r) => String(r.id) === String(id));
  if (!e) return;
  eventsView.rows = eventsView.rows.filter((r) => r !== e);
  renderEvents();
  try {
    await api(`/api/events/${id}`, { method: "DELETE" });
  } catch (err) {
    toast(`削除できませんでした: ${err.message}`, { error: true });
    await loadEvents();
    return;
  }
  if (String(form.id.value) === String(id)) resetEventForm();
  toast(`「${e.category}」を削除しました`, {
    action: "元に戻す",
    onAction: async () => {
      try {
        await saveEvent({ date: e.date, category: e.category, intensity: e.intensity, note: e.note });
        toast("元に戻しました");
      } catch (err) {
        toast(`元に戻せませんでした: ${err.message}`, { error: true });
      }
      await refreshAfterEventChange();
    },
  });
  loadCategories();
}

$("#event-list").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-more]")) {
    eventsView.limit += LIST_PAGE;
    renderEvents();
    return;
  }
  const del = ev.target.closest("[data-delete]");
  if (del) {
    deleteEvent(del.dataset.delete);
    return;
  }
  const row = ev.target.closest(".list-row");
  if (row) editEvent(eventsView.rows.find((r) => String(r.id) === row.dataset.id));
});
$("#event-list").addEventListener("keydown", (ev) => {
  const row = ev.target.closest(".list-row");
  if (row && (ev.key === "Enter" || ev.key === " ") && ev.target === row) {
    ev.preventDefault();
    editEvent(eventsView.rows.find((r) => String(r.id) === row.dataset.id));
  }
});

$("#event-cancel").addEventListener("click", resetEventForm);

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const category = form.category.value.trim();
  if (!category) {
    setCategoryError(true);
    form.category.focus();
    return;
  }
  const body = {
    date: form.date.value || isoDate(new Date()),
    category,
    intensity: form.intensity.value ? Number(form.intensity.value) : null,
    note: form.note.value.trim() || null,
  };
  const id = form.id.value;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await saveEvent(body, id || null);
    const d = dateParts(body.date);
    toast(`${d.md}（${d.wd}）の「${category.toLowerCase()}」を${id ? "更新" : "記録"}しました`);
    resetEventForm();
    await refreshAfterEventChange();
  } catch (e) {
    $("#event-msg").className = "msg error";
    $("#event-msg").textContent = `保存できませんでした: ${e.message}`;
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- 気分

const MOODS = { 1: ["😣", "とても悪い"], 2: ["🙁", "悪い"], 3: ["😐", "ふつう"], 4: ["🙂", "良い"], 5: ["😄", "とても良い"] };
const MOOD_PAGE = 5;
const moodView = { rows: [], limit: MOOD_PAGE };

function agoText(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

function renderMoods() {
  const { rows, limit } = moodView;
  $("#mood-last").textContent = rows.length ? `最後の記録: ${agoText(rows[0].logged_at)}` : "";
  if (!rows.length) {
    $("#mood-list").innerHTML = '<p class="empty">まだ記録がありません。</p>';
    return;
  }
  const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  const today = isoDate(new Date());
  $("#mood-list").innerHTML = `<ul class="list mood-list">${rows.slice(0, limit).map((m) => {
    const [face, text] = MOODS[m.mood];
    const when = m.date === today ? m.time_local : `${dateParts(m.date).md} ${m.time_local}`;
    return `
    <li class="list-row">
      <div class="list-date"><span class="mood-face" aria-hidden="true">${face}</span></div>
      <div class="list-main">
        <div class="list-title">${esc(text)}</div>
        <div class="list-sub">${esc(when)}${m.note ? ` · ${esc(m.note)}` : ""}</div>
      </div>
      <div class="list-trailing">
        <button type="button" class="icon-button danger" data-delete-mood="${m.id}" aria-label="削除">${trash}</button>
      </div>
    </li>`;
  }).join("")}</ul>` +
    (rows.length > limit ? `<button type="button" class="more" data-more>さらに表示</button>` : "");
}

async function loadMoods() {
  try {
    moodView.rows = await api("/api/moods?limit=100");
  } catch (e) {
    $("#mood-list").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  renderMoods();
}

async function saveMood(body) {
  return api("/api/moods", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

document.querySelectorAll("[data-mood]").forEach((b) => b.addEventListener("click", async () => {
  const mood = Number(b.dataset.mood);
  const note = $("#mood-note").value.trim() || null;
  document.querySelectorAll("[data-mood]").forEach((x) => { x.disabled = true; });
  try {
    await saveMood({ mood, note });
    $("#mood-note").value = "";
    b.classList.add("saved");
    setTimeout(() => b.classList.remove("saved"), 600);
    toast(`${MOODS[mood][0]} 「${MOODS[mood][1]}」を記録しました`);
    await loadMoods();
  } catch (e) {
    toast(`記録できませんでした: ${e.message}`, { error: true });
  } finally {
    document.querySelectorAll("[data-mood]").forEach((x) => { x.disabled = false; });
  }
}));

$("#mood-list").addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-more]")) {
    moodView.limit += MOOD_PAGE * 4;
    renderMoods();
    return;
  }
  const del = ev.target.closest("[data-delete-mood]");
  if (!del) return;
  const m = moodView.rows.find((r) => String(r.id) === del.dataset.deleteMood);
  if (!m) return;
  moodView.rows = moodView.rows.filter((r) => r !== m);
  renderMoods();
  try {
    await api(`/api/moods/${m.id}`, { method: "DELETE" });
  } catch (err) {
    toast(`削除できませんでした: ${err.message}`, { error: true });
    await loadMoods();
    return;
  }
  toast(`${MOODS[m.mood][0]} の記録を削除しました`, {
    action: "元に戻す",
    onAction: async () => {
      try {
        await saveMood({ mood: m.mood, note: m.note, logged_at: m.logged_at });
        toast("元に戻しました");
      } catch (err) {
        toast(`元に戻せませんでした: ${err.message}`, { error: true });
      }
      await loadMoods();
    },
  });
});

// ---------------------------------------------------------------- 気分のリマインダー（Web Push）

const reminderForm = $("#reminder-form");
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function b64urlToBytes(s) {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function sameKey(buf, bytes) {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPushStatus() {
  const status = $("#push-status");
  const btn = $("#push-toggle");
  const help = $("#push-help");
  help.hidden = true;
  if (!pushSupported) {
    status.textContent = "このブラウザでは使えません";
    btn.hidden = true;
    if (isIOS && !isStandalone) {
      help.textContent = "iPhone では、Safari の共有ボタン →「ホーム画面に追加」で追加したアプリから開くと通知を受け取れます（iOS 16.4 以降）。";
      help.hidden = false;
    }
    return;
  }
  const sub = await currentSubscription();
  const denied = Notification.permission === "denied";
  status.textContent = sub ? "オン" : denied ? "ブロックされています" : "オフ";
  status.classList.toggle("on", Boolean(sub));
  btn.hidden = denied && !sub;
  btn.textContent = sub ? "この端末で受け取らない" : "通知をオンにする";
  if (denied && !sub) {
    help.textContent = "ブラウザ（iPhone は設定アプリ → 通知）でこのサイトの通知を許可してください。";
    help.hidden = false;
  }
}

async function enablePush() {
  // iOS はタップの直後でないと許可ダイアログを出せないので、通信より先に許可を求める
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした");
  const { public_key: publicKey } = await api("/api/push/public-key");
  const key = b64urlToBytes(publicKey);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // サーバーの鍵が作り直されていたら登録し直す
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}

$("#push-toggle").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const on = Boolean(await currentSubscription());
    await (on ? disablePush() : enablePush());
    toast(on ? "この端末では通知を受け取りません" : "この端末で通知を受け取ります");
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    btn.disabled = false;
    await Promise.all([renderPushStatus(), loadReminder()]);
  }
});

function intervalText(min) {
  return min % 60 ? `${Math.floor(min / 60) ? `${Math.floor(min / 60)}時間` : ""}${min % 60}分ごと` : min === 1440 ? "1日1回" : `${min / 60}時間ごと`;
}

async function loadReminder() {
  renderPushStatus();
  let s;
  try {
    s = await api("/api/reminders/settings");
  } catch (e) {
    $("#reminder-status").textContent = e.message;
    return;
  }
  const hm = (t) => t.slice(0, 5);
  reminderForm.enabled.checked = s.enabled;
  reminderForm.interval_minutes.value = String(s.interval_minutes);
  reminderForm.start_time.value = hm(s.start_time);
  reminderForm.end_time.value = hm(s.end_time);
  $("#reminder-summary").textContent = s.enabled
    ? `${intervalText(s.interval_minutes)}・${hm(s.start_time)}〜${hm(s.end_time)}` : "オフ";

  const lines = [`通知を受け取る端末: ${s.devices}台`];
  if (!s.push_configured) lines.push("⚠️ サーバーに VAPID 鍵が設定されていません（README 参照）");
  if (s.last_sent_at) lines.push(`最後のリマインド: ${agoText(s.last_sent_at)}`);
  if (!s.last_checked_at) {
    lines.push("⚠️ 定期チェックがまだ一度も届いていません。README の「気分のリマインダー」の手順で設定してください");
  } else if (Date.now() - new Date(s.last_checked_at).getTime() > 60 * 60000) {
    lines.push(`⚠️ 定期チェックが止まっているようです（最後: ${agoText(s.last_checked_at)}）`);
  }
  $("#reminder-status").textContent = lines.join(" / ");
}

reminderForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = reminderForm;
  if (!f.start_time.value || !f.end_time.value) {
    toast("時間帯を入力してください", { error: true });
    return;
  }
  try {
    await api("/api/reminders/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: f.enabled.checked, interval_minutes: Number(f.interval_minutes.value),
        start_time: f.start_time.value, end_time: f.end_time.value }),
    });
    toast("リマインダーの設定を保存しました");
    // オンにしたのにこの端末で通知を受け取っていなければ、そのまま受け取れるようにする
    if (f.enabled.checked && pushSupported && !(await currentSubscription()) && Notification.permission !== "denied") {
      await enablePush();
    }
  } catch (e) {
    toast(`保存できませんでした: ${e.message}`, { error: true });
  }
  await loadReminder();
});

$("#reminder-test").addEventListener("click", async () => {
  try {
    const r = await api("/api/reminders/test", { method: "POST" });
    toast(r.sent ? `${r.sent}台に送りました` : "送れる端末がありません。先に「通知をオンにする」を押してください",
      { error: !r.sent });
  } catch (e) {
    toast(`送れませんでした: ${e.message}`, { error: true });
  }
});

// 通知から開いたとき（#mood）は気分の入力へ
function openFromHash() {
  if (location.hash !== "#mood") return false;
  showTab("events");
  history.replaceState(null, "", location.pathname + location.search);
  requestAnimationFrame(() => $("#mood").scrollIntoView({ block: "start" }));
  return true;
}
window.addEventListener("hashchange", openFromHash);
if (pushSupported) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.error(e));
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type !== "open") return;
    location.hash = new URL(ev.data.url).hash;
  });
}

// ---------------------------------------------------------------- ワークアウト

// 月曜始まりの週の初日（YYYY-MM-DD）
function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

function sumBy(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

async function loadWorkouts() {
  const days = Number($("#wo-range").value);
  const params = new URLSearchParams();
  let start = null;
  if (days) {
    start = isoDate(new Date(Date.now() - days * 86400000));
    params.set("start", start);
  }
  if ($("#wo-type").value) params.set("name", $("#wo-type").value);
  let rows;
  try {
    rows = await api(`/api/workouts?${params}`);
  } catch (e) {
    $("#wo-stats").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }

  // 距離・カロリーは単位が混ざっていたら合計しない
  const unitOf = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];
  const distUnits = unitOf("distance_units");
  const energyUnits = unitOf("active_energy_units");
  const total = (key, units) => (units.length === 1 ? `${fmt(sumBy(rows, key))} ${units[0]}` : units.length ? "単位混在" : "―");
  $("#wo-stats").innerHTML = [
    ["回数", `${rows.length}回`],
    ["合計時間", fmtMinutes(sumBy(rows, "duration_min"))],
    ["合計距離", total("distance_qty", distUnits)],
    ["消費エネルギー", total("active_energy_qty", energyUnits)],
  ].map(([l, v]) => `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join("");

  // 週ごとの合計時間。運動しなかった週も0として並べる
  const weeks = {};
  rows.forEach((r) => { const w = weekStart(r.date); weeks[w] = (weeks[w] || 0) + (r.duration_min || 0); });
  const firstWeek = start ? weekStart(start) : Object.keys(weeks).sort()[0];
  const labels = [];
  if (firstWeek) {
    for (let d = new Date(`${firstWeek}T00:00:00`); d <= new Date(); d.setDate(d.getDate() + 7)) labels.push(isoDate(d));
  }
  const opts = baseChartOptions();
  opts.interaction = { mode: "index", intersect: false };
  opts.plugins.tooltip.callbacks = {
    title: (items) => `${items[0].label} の週`,
    label: (item) => `運動時間: ${fmtMinutes(item.parsed.y)}`,
  };
  renderChart("wo-chart", {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: labels.map((w) => Math.round(weeks[w] || 0)), backgroundColor: css("--series-1"),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 28 }],
    },
    options: opts,
  });

  workoutsView.rows = rows;
  workoutsView.limit = LIST_PAGE;
  renderWorkoutList();
}

const workoutsView = { rows: [], limit: LIST_PAGE };

function renderWorkoutList() {
  const { rows, limit } = workoutsView;
  if (!rows.length) {
    $("#wo-list").innerHTML = '<p class="empty">この期間のワークアウトはありません。</p>';
    return;
  }
  $("#wo-list").innerHTML = `<ul class="list">${rows.slice(0, limit).map((r) => {
    const sub = [r.start_local, r.is_indoor === null ? null : r.is_indoor ? "屋内" : "屋外",
      r.active_energy_qty === null ? null : `${fmt(r.active_energy_qty, 0)} ${r.active_energy_units || ""}`]
      .filter(Boolean).join(" · ");
    return `
    <li class="list-row">
      ${dateBlock(r.date)}
      <div class="list-main">
        <div class="list-title">${esc(workoutLabel(r.name))}</div>
        <div class="list-sub">${esc(sub)}</div>
      </div>
      <div class="list-metric">${esc(fmtMinutes(r.duration_min))}
        ${r.distance_qty === null ? "" : `<span class="sub">${esc(fmt(r.distance_qty, 2))} ${esc(r.distance_units || "")}</span>`}
      </div>
    </li>`;
  }).join("")}</ul>` +
    (rows.length > limit ? `<button type="button" class="more" data-more>さらに表示（残り${rows.length - limit}件）</button>` : "");
}
$("#wo-list").addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-more]")) return;
  workoutsView.limit += LIST_PAGE;
  renderWorkoutList();
});
["#wo-range", "#wo-type"].forEach((s) => $(s).addEventListener("change", loadWorkouts));

// ---------------------------------------------------------------- 分析

async function loadAnalysis() {
  await Promise.all([loadImpact(), loadCategoryComparison(), loadDose()]);
}

async function loadDose() {
  const metric = $("#an-metric").value;
  if (!metric) return;
  const params = new URLSearchParams({ metric, lag: $("#dose-lag").value });
  if ($("#dose-type").value) params.set("name", $("#dose-type").value);
  let r;
  try {
    r = await api(`/api/analysis/workout-dose?${params}`);
  } catch (e) {
    $("#dose-table").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  const unit = state.units[metric] || "";
  if (!r.n) {
    $("#dose-summary").textContent = "ワークアウトのデータが取り込まれると表示されます。";
    $("#dose-table").innerHTML = "";
    if (charts["dose-chart"]) charts["dose-chart"].destroy();
    return;
  }
  const strength = (v) => (v === null ? "" : Math.abs(v) < 0.1 ? "ほぼ関係なし" : Math.abs(v) < 0.3 ? "弱い" : Math.abs(v) < 0.5 ? "中程度" : "強い");
  const dir = r.r === null ? "" : r.r > 0 ? "（運動が多いほど高い）" : "（運動が多いほど低い）";
  $("#dose-summary").textContent = r.r === null
    ? `${r.n}日分のデータ。相関係数は計算できませんでした。`
    : `運動時間と${label(metric)}の相関係数 r = ${fmt(r.r, 2)}：${strength(r.r)}${Math.abs(r.r) >= 0.1 ? dir : ""}（${r.n}日分）`;

  const bins = r.bins;
  const opts = baseChartOptions();
  opts.interaction = { mode: "index", intersect: false };
  opts.scales.y.grid = { color: (ctx) => (ctx.tick.value === 0 ? css("--zero-line") : css("--grid")) };
  opts.plugins.tooltip.callbacks = {
    label: (item) => {
      const b = bins[item.dataIndex];
      return [`運動なしとの差: ${signed(b.diff)} ${unit}`, `平均: ${fmt(b.mean)} ${unit}`, `日数: ${b.n}`];
    },
  };
  renderChart("dose-chart", {
    type: "bar",
    data: {
      labels: bins.map((b) => `${b.label}（${b.n}）`),
      datasets: [{ data: bins.map((b) => b.diff), backgroundColor: css("--series-1"),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 48 }],
    },
    options: opts,
  });
  $("#dose-table").innerHTML = table(
    [{ label: "運動時間" }, { label: "日数", num: true }, { label: "平均", num: true }, { label: "中央値", num: true },
      { label: "四分位範囲", num: true }, { label: "運動なしとの差", num: true }],
    bins.map((b) => [esc(b.label), b.n, fmt(b.mean), fmt(b.median),
      b.n ? `${fmt(b.q1)}〜${fmt(b.q3)}` : "―", b.diff === null ? "―" : `${signed(b.diff)} ${esc(unit)}`]),
  );
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
  $("#impact-title").textContent = `「${catLabel(category)}」の前後での ${label(metric)} の変化（${r.n_events}件）`;

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
  const kind = $("#cc-kind").value;
  const params = new URLSearchParams({ metric, lag: $("#cc-lag").value, kind });
  if ($("#an-intensity").value) params.set("min_intensity", $("#an-intensity").value);
  const noneLabel = kind === "workout" ? "ワークアウトなし" : "イベントなし";
  $("#cc-note").textContent = `${noneLabel}の日の平均との差。ラベルの括弧内は件数。`;
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
      return [`差: ${signed(c.diff)} ${unit}`, `平均: ${fmt(c.event.mean)}（${noneLabel} ${fmt(r.control.mean)}）`,
        `中央値: ${fmt(c.event.median)}`, `件数: ${c.event.n}`];
    },
  };
  $("#cc-chart").parentElement.style.height = `${Math.max(160, cats.length * 40 + 60)}px`;
  renderChart("cc-chart", {
    type: "bar",
    data: {
      labels: cats.map((c) => `${catLabel(c.category)}（${c.event.n}）`),
      datasets: [{ data: cats.map((c) => c.diff), backgroundColor: css("--series-1"),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 24 }],
    },
    options: opts,
  });
  $("#cc-table").innerHTML = table(
    [{ label: "カテゴリ" }, { label: "件数", num: true }, { label: "平均", num: true }, { label: "中央値", num: true },
      { label: "四分位範囲", num: true }, { label: "差", num: true }, { label: "効果量 d", num: true }],
    [
      ...cats.map((c) => [esc(catLabel(c.category)), c.event.n, fmt(c.event.mean), fmt(c.event.median),
        `${fmt(c.event.q1)}〜${fmt(c.event.q3)}`, `${signed(c.diff)} ${esc(unit)}`, signed(c.cohens_d, 2)]),
      [`<em>${noneLabel}</em>`, r.control.n, fmt(r.control.mean), fmt(r.control.median),
        `${fmt(r.control.q1)}〜${fmt(r.control.q3)}`, "", ""],
    ],
  );
}

["#an-metric", "#an-intensity"].forEach((s) => $(s).addEventListener("change", loadAnalysis));
["#an-category", "#an-window"].forEach((s) => $(s).addEventListener("change", loadImpact));
["#cc-lag", "#cc-kind"].forEach((s) => $(s).addEventListener("change", loadCategoryComparison));
["#dose-lag", "#dose-type"].forEach((s) => $(s).addEventListener("change", loadDose));

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
    toast("取り込みが完了しました");
    await Promise.all([loadCatalog(), loadCategories()]);
  } catch (e) {
    msg.className = "msg error";
    msg.textContent = `失敗しました: ${e.message}`;
  }
});

// ---------------------------------------------------------------- 起動

(async function init() {
  resetEventForm();
  await Promise.all([loadCatalog(), loadCategories()]);
  if (openFromHash()) return;
  let tab = "dashboard";
  try { tab = localStorage.getItem("tab") || tab; } catch (_) { /* ignore */ }
  showTab(tab);
})();
