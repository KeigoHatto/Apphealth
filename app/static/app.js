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

// ランの強度の基準（サーバーの RUN_MEASURES と同じキー）
const RUN_MEASURES = { load: "距離×速度", distance: "距離", speed: "速度", duration: "時間" };
function isRun(name) {
  return /run/i.test(name || "");
}

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
// 分/km → 5'30"/km
function fmtPace(minPerKm) {
  if (!minPerKm) return null;
  const sec = Math.round(minPerKm * 60);
  return `${Math.floor(sec / 60)}'${String(sec % 60).padStart(2, "0")}"/km`;
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
  if (name === "events") loadEvents();
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
  document.querySelectorAll(".run-type-select").forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = `<option value="">${esc(sel.dataset.all)}</option>` +
      types.filter(isRun).map((t) => `<option value="${esc(t)}">${esc(workoutLabel(t))}</option>`).join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  });
}

document.querySelectorAll(".run-measure-select").forEach((sel) => {
  sel.innerHTML = Object.entries(RUN_MEASURES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
});

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
// よく使う: テンプレート（カテゴリ + 強度 + メモ）と、過去に記録したカテゴリ（前回の強度付き）
const quick = { templates: [], categories: [], editing: false };
// 複数日モードのカレンダー
const cal = { month: null, selected: new Set() };

function eventMode() {
  return form.querySelector("[name=mode]:checked").value;
}
function setMode(mode) {
  form.querySelector(`[name=mode][value="${mode}"]`).checked = true;
  applyMode();
}
function applyMode() {
  const mode = eventMode();
  form.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
  if (mode === "multi") renderCalendar();
  if (mode === "paste") renderPastePreview();
  $("#event-msg").textContent = "";
  updateSubmitLabel();
}
form.querySelectorAll("[name=mode]").forEach((r) => r.addEventListener("change", applyMode));

function updateSubmitLabel() {
  const mode = eventMode();
  const btn = $("#event-submit");
  if (mode === "multi") btn.textContent = cal.selected.size ? `${cal.selected.size}日分を登録` : "登録";
  else if (mode === "paste") btn.textContent = pasteState.items.length ? `${pasteState.items.length}件を登録` : "登録";
  else btn.textContent = form.id.value ? "更新" : "保存";
}

function resetEventForm() {
  const mode = form.id.value ? "single" : eventMode();
  form.reset();
  form.id.value = "";
  form.date.value = isoDate(new Date());
  $("#event-form-title").textContent = "イベントを記録";
  $("#event-mode").hidden = false;
  $("#event-cancel").hidden = true;
  setCategoryError(false);
  cal.selected.clear();
  setMode(mode);
  syncIntensity();
  syncFormChips();
}

function setCategoryError(on) {
  $("#category-error").hidden = !on;
  form.category.setAttribute("aria-invalid", String(on));
}

// ---- 強度（1〜10）
function getIntensity() {
  const r = form.querySelector("[name=intensity]:checked");
  return r ? Number(r.value) : null;
}
function setIntensity(n) {
  form.querySelectorAll("[name=intensity]").forEach((r) => { r.checked = Number(r.value) === n; });
  syncIntensity();
}
function syncIntensity() {
  const n = getIntensity();
  $("#intensity-out").textContent = n ? `${n} / 10` : "なし";
  $("#intensity-clear").hidden = !n;
  syncFormChips();
}
form.querySelectorAll("[name=intensity]").forEach((r) => r.addEventListener("change", syncIntensity));
$("#intensity-clear").addEventListener("click", () => setIntensity(null));

// ---- よく使う（テンプレートと最近のカテゴリ）
async function loadQuickPicks() {
  try {
    [quick.templates, quick.categories] = await Promise.all([api("/api/event-templates"), api("/api/events/categories")]);
  } catch (e) {
    console.error(e);
  }
  if (!quick.templates.length) quick.editing = false;
  renderQuickPicks();
}

function renderQuickPicks() {
  const inTemplates = new Set(quick.templates.map((t) => t.category));
  const recents = quick.categories.filter((c) => !inTemplates.has(c.category)).slice(0, 8);
  const remove = '<span class="chip-remove" aria-hidden="true">×</span>';
  const tplChip = (t) => `<button type="button" class="chip tpl" data-template="${t.id}"
      aria-label="${esc(t.category)}${t.intensity ? ` 強度${t.intensity}` : ""}${t.note ? ` ${esc(t.note)}` : ""}${quick.editing ? " を削除" : ""}">
      <span class="chip-text">${esc(t.category)}${t.note ? `<span class="chip-note"> · ${esc(t.note)}</span>` : ""}</span>
      ${t.intensity ? `<span class="chip-badge">${t.intensity}</span>` : ""}${quick.editing ? remove : ""}</button>`;
  const catChip = (c) => `<button type="button" class="chip" data-category="${esc(c.category)}"
      aria-label="${esc(c.category)}${c.last_intensity ? `（前回の強度${c.last_intensity}）` : ""}">${esc(c.category)}</button>`;
  $("#template-chips").innerHTML = quick.templates.map(tplChip).join("") + (quick.editing ? "" : recents.map(catChip).join(""));
  $("#template-chips").classList.toggle("editing", quick.editing);
  $("#template-edit").hidden = !quick.templates.length;
  $("#template-edit").textContent = quick.editing ? "完了" : "編集";
  $("#template-hint").hidden = quick.templates.length > 0;
  syncFormChips();
}

$("#template-edit").addEventListener("click", () => {
  quick.editing = !quick.editing;
  renderQuickPicks();
});

$("#template-chips").addEventListener("click", async (ev) => {
  const tplEl = ev.target.closest("[data-template]");
  if (tplEl) {
    const t = quick.templates.find((x) => String(x.id) === tplEl.dataset.template);
    if (quick.editing) {
      await deleteTemplate(t);
      return;
    }
    form.category.value = t.category;
    form.note.value = t.note || "";
    setIntensity(t.intensity);
    setCategoryError(false);
    onCategoryChange();
    return;
  }
  const catEl = ev.target.closest("[data-category]");
  if (catEl) {
    const c = quick.categories.find((x) => x.category === catEl.dataset.category);
    form.category.value = c.category;
    setIntensity(c.last_intensity);  // 前回と同じ強度から始める
    setCategoryError(false);
    onCategoryChange();
  }
});

async function saveTemplate(body) {
  return api("/api/event-templates", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function deleteTemplate(t) {
  quick.templates = quick.templates.filter((x) => x !== t);
  if (!quick.templates.length) quick.editing = false;
  renderQuickPicks();
  try {
    await api(`/api/event-templates/${t.id}`, { method: "DELETE" });
  } catch (err) {
    toast(`削除できませんでした: ${err.message}`, { error: true });
    await loadQuickPicks();
    return;
  }
  toast(`テンプレート「${t.category}」を削除しました`, {
    action: "元に戻す",
    onAction: async () => {
      try {
        await saveTemplate({ category: t.category, intensity: t.intensity, note: t.note });
      } catch (err) {
        toast(`元に戻せませんでした: ${err.message}`, { error: true });
      }
      await loadQuickPicks();
    },
  });
}

// チップの選択状態を入力値に合わせる
function syncFormChips() {
  document.querySelectorAll("[data-date-offset]").forEach((c) => {
    const d = new Date();
    d.setDate(d.getDate() + Number(c.dataset.dateOffset));
    c.setAttribute("aria-pressed", String(form.date.value === isoDate(d)));
  });
  const cat = form.category.value.trim().toLowerCase();
  const note = form.note.value.trim();
  const intensity = getIntensity();
  document.querySelectorAll("#template-chips [data-template]").forEach((c) => {
    const t = quick.templates.find((x) => String(x.id) === c.dataset.template);
    const on = !quick.editing && t && t.category === cat && (t.intensity ?? null) === intensity && (t.note || "") === note;
    c.setAttribute("aria-pressed", String(Boolean(on)));
  });
  document.querySelectorAll("#template-chips [data-category]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.category === cat)));
}

document.querySelectorAll("[data-date-offset]").forEach((c) => c.addEventListener("click", () => {
  const d = new Date();
  d.setDate(d.getDate() + Number(c.dataset.dateOffset));
  form.date.value = isoDate(d);
  syncFormChips();
}));
function onCategoryChange() {
  syncFormChips();
  if (eventMode() === "multi") renderCalendar();
}
form.date.addEventListener("input", syncFormChips);
form.category.addEventListener("input", () => { setCategoryError(false); onCategoryChange(); });
form.note.addEventListener("input", syncFormChips);

// ---- 複数日（カレンダーで選ぶ）
function renderCalendar() {
  const now = new Date();
  if (!cal.month) cal.month = new Date(now.getFullYear(), now.getMonth(), 1);
  const y = cal.month.getFullYear();
  const m = cal.month.getMonth();
  $("#cal-title").textContent = `${y}年${m + 1}月`;
  const today = isoDate(now);
  const cat = form.category.value.trim().toLowerCase();
  const recorded = new Set(cat ? eventsView.rows.filter((e) => e.category === cat).map((e) => e.date) : []);
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;  // 月曜始まり
  const days = new Date(y, m + 1, 0).getDate();
  let html = ["月", "火", "水", "木", "金", "土", "日"].map((w) => `<span class="cal-wd" aria-hidden="true">${w}</span>`).join("");
  html += '<span aria-hidden="true"></span>'.repeat(lead);
  for (let day = 1; day <= days; day++) {
    const iso = isoDate(new Date(y, m, day));
    const done = recorded.has(iso);
    html += `<button type="button" class="cal-day${done ? " recorded" : ""}${iso === today ? " today" : ""}"
      data-date="${iso}" aria-pressed="${cal.selected.has(iso)}"${iso > today ? " disabled" : ""}
      aria-label="${m + 1}月${day}日${done ? "（記録済み）" : ""}">${day}</button>`;
  }
  $("#cal-grid").innerHTML = html;
  document.querySelector('[data-cal-nav="1"]').disabled = y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth());
  updateCalCount();
}

function updateCalCount() {
  const dates = [...cal.selected].sort();
  const short = (iso) => { const p = dateParts(iso); return `${p.year !== new Date().getFullYear() ? `${p.year}/` : ""}${p.md}`; };
  $("#cal-count").textContent = dates.length
    ? `${dates.length}日を選択中（${short(dates[0])}${dates.length > 1 ? `〜${short(dates.at(-1))}` : ""}）`
    : "日付を選んでください";
  $("#cal-clear").hidden = !dates.length;
  updateSubmitLabel();
}

$("#cal-grid").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-date]");
  if (!btn || btn.disabled) return;
  const d = btn.dataset.date;
  if (cal.selected.has(d)) cal.selected.delete(d); else cal.selected.add(d);
  btn.setAttribute("aria-pressed", String(cal.selected.has(d)));
  updateCalCount();
});
document.querySelectorAll("[data-cal-nav]").forEach((b) => b.addEventListener("click", () => {
  cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + Number(b.dataset.calNav), 1);
  renderCalendar();
}));
$("#cal-clear").addEventListener("click", () => {
  cal.selected.clear();
  renderCalendar();
});

$("#range-weekdays").addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-wd]");
  if (chip) chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
});
$("#range-add").addEventListener("click", () => {
  const from = $("#range-from").value;
  const to = $("#range-to").value;
  if (!from || !to || from > to) {
    toast("開始日と終了日を選んでください", { error: true });
    return;
  }
  const weekdays = new Set([...document.querySelectorAll("#range-weekdays [aria-pressed=true]")].map((c) => Number(c.dataset.wd)));
  const today = isoDate(new Date());
  let added = 0;
  for (let d = new Date(`${from}T00:00:00`); isoDate(d) <= to && isoDate(d) <= today; d.setDate(d.getDate() + 1)) {
    if (!weekdays.has(d.getDay()) || cal.selected.has(isoDate(d))) continue;
    cal.selected.add(isoDate(d));
    added++;
  }
  const end = new Date(`${to > today ? today : to}T00:00:00`);
  cal.month = new Date(end.getFullYear(), end.getMonth(), 1);
  renderCalendar();
  toast(added ? `${added}日を選択に追加しました` : "追加できる日がありませんでした");
});

// ---- 貼り付け（CSV / スプレッドシート）
const pasteState = { items: [], errors: [] };

function parseDateLoose(text) {
  const s = text.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  let y, mo, d;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[/.月](\d{1,2})日?$/))) [y, mo, d] = [new Date().getFullYear(), Number(m[1]), Number(m[2])];
  else return null;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? isoDate(dt) : null;
}

// 「日付, カテゴリ, 強度, メモ」の行を読む。メモにカンマが入っていてもよいように、区切るのは最初の3つだけ
function parsePaste(text) {
  const items = [];
  const errors = [];
  let first = true;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const sep = line.includes("\t") ? "\t" : ",";
    const parts = line.split(sep);
    const [d = "", cat = "", inten = ""] = parts.map((p) => p.trim());
    const note = parts.slice(3).join(sep).trim();
    const isFirst = first;
    first = false;
    const date = parseDateLoose(d);
    if (!date) {
      if (!isFirst) errors.push(`${i + 1}行目: 日付「${d}」を読み取れません`);  // 1行目は見出しとみなす
      return;
    }
    if (!cat) { errors.push(`${i + 1}行目: カテゴリがありません`); return; }
    if (cat.length > 50) { errors.push(`${i + 1}行目: カテゴリは50文字までです`); return; }
    let intensity = null;
    if (inten) {
      intensity = Number(inten.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
      if (!Number.isInteger(intensity) || intensity < 1 || intensity > 10) {
        errors.push(`${i + 1}行目: 強度「${inten}」は1〜10の整数にしてください`);
        return;
      }
    }
    items.push({ date, category: cat.toLowerCase(), intensity, note: note || null });
  });
  return { items, errors };
}

function renderPastePreview() {
  Object.assign(pasteState, parsePaste($("#paste-text").value));
  const { items, errors } = pasteState;
  const el = $("#paste-preview");
  if (!items.length && !errors.length) {
    el.innerHTML = "";
  } else {
    const shown = items.slice(0, 5);
    el.innerHTML =
      (errors.length ? `<ul class="paste-errors">${errors.slice(0, 5).map((e) => `<li>${esc(e)}</li>`).join("")}${errors.length > 5 ? `<li>ほか${errors.length - 5}件</li>` : ""}</ul>` : "") +
      (items.length ? `<p class="note">${items.length}件を読み取りました${items.length > shown.length ? `（先頭${shown.length}件を表示）` : ""}</p>` +
        `<div class="table-wrap">${table([{ label: "日付" }, { label: "カテゴリ" }, { label: "強度", num: true }, { label: "メモ", wrap: true }],
          shown.map((x) => [esc(x.date), esc(x.category), x.intensity ?? "―", esc(x.note || "")]))}</div>` : "");
  }
  updateSubmitLabel();
}
$("#paste-text").addEventListener("input", renderPastePreview);

// ---- 一覧
function intensityMeter(n) {
  if (!n) return "";
  return `<span class="intensity" aria-label="強度${n}"><b>${n}</b><i style="--w:${n * 10}%"></i></span>`;
}

function renderEvents() {
  const { rows, limit } = eventsView;
  if (!rows.length) {
    $("#event-list").innerHTML = '<p class="empty">まだ記録がありません。上のフォームから追加できます。</p>';
    return;
  }
  const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  const again = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>';
  $("#event-list").innerHTML = `<ul class="list">${rows.slice(0, limit).map((e) => `
    <li class="list-row tappable" data-id="${e.id}" tabindex="0" aria-label="${esc(e.date)} ${esc(e.category)} を編集">
      ${dateBlock(e.date)}
      <div class="list-main">
        <div class="list-title">${esc(e.category)}</div>
        ${e.note ? `<div class="list-sub">${esc(e.note)}</div>` : ""}
      </div>
      <div class="list-trailing">
        ${intensityMeter(e.intensity)}
        <button type="button" class="icon-button" data-reuse="${e.id}" aria-label="同じ内容でもう一度記録">${again}</button>
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
  if (eventMode() === "multi") renderCalendar();
}

function scrollToForm() {
  form.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function editEvent(e) {
  setMode("single");
  form.id.value = e.id;
  form.date.value = e.date;
  form.category.value = e.category;
  setIntensity(e.intensity);
  form.note.value = e.note || "";
  form.save_template.checked = false;
  $("#event-form-title").textContent = "イベントを編集";
  $("#event-mode").hidden = true;
  $("#event-cancel").hidden = false;
  updateSubmitLabel();
  syncFormChips();
  scrollToForm();
}

// 過去の記録を使い回す: 中身だけ入れて、日付は今日（複数日モードならカレンダーで選ぶ）
function reuseEvent(e) {
  resetEventForm();
  if (eventMode() === "paste") setMode("single");
  form.category.value = e.category;
  setIntensity(e.intensity);
  form.note.value = e.note || "";
  onCategoryChange();
  scrollToForm();
}

async function saveEvent(body, id = null) {
  return api(id ? `/api/events/${id}` : "/api/events", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function refreshAfterEventChange() {
  await Promise.all([loadEvents(), loadCategories(), loadQuickPicks()]);
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
  loadQuickPicks();
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
  const reuse = ev.target.closest("[data-reuse]");
  if (reuse) {
    reuseEvent(eventsView.rows.find((r) => String(r.id) === reuse.dataset.reuse));
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

// 一括登録。「元に戻す」で登録した分だけ消せる
async function saveBulk(events) {
  const r = await api("/api/events/bulk", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }),
  });
  const ids = r.events.map((e) => e.id);
  const skipped = r.skipped ? `（${r.skipped}件は記録済みのためスキップ）` : "";
  toast(r.created ? `${r.created}件を登録しました${skipped}` : `すべて記録済みでした${skipped}`, ids.length ? {
    action: "元に戻す",
    onAction: async () => {
      try {
        await api("/api/events/bulk-delete", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
        });
        toast("元に戻しました");
      } catch (err) {
        toast(`元に戻せませんでした: ${err.message}`, { error: true });
      }
      await refreshAfterEventChange();
    },
  } : {});
  return r;
}

function showFormError(text) {
  $("#event-msg").className = "msg error";
  $("#event-msg").textContent = text;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const mode = eventMode();
  $("#event-msg").textContent = "";
  let run;
  if (mode === "paste") {
    renderPastePreview();
    if (pasteState.errors.length) return showFormError("読み取れない行があります。直してから登録してください。");
    if (!pasteState.items.length) return showFormError("登録する行がありません。");
    const events = pasteState.items;
    run = async () => {
      await saveBulk(events);
      $("#paste-text").value = "";
      renderPastePreview();
    };
  } else {
    const category = form.category.value.trim();
    if (!category) {
      setCategoryError(true);
      form.category.focus();
      return;
    }
    const content = { category, intensity: getIntensity(), note: form.note.value.trim() || null };
    const withTemplate = form.save_template.checked;
    if (mode === "multi") {
      if (!cal.selected.size) return showFormError("カレンダーで日付を選んでください。");
      const events = [...cal.selected].sort().map((date) => ({ date, ...content }));
      run = async () => {
        await saveBulk(events);
        if (withTemplate) await saveTemplate(content).catch((e) => toast(`テンプレートを保存できませんでした: ${e.message}`, { error: true }));
        resetEventForm();
      };
    } else {
      const id = form.id.value;
      const body = { date: form.date.value || isoDate(new Date()), ...content };
      run = async () => {
        await saveEvent(body, id || null);
        if (withTemplate) await saveTemplate(content).catch((e) => toast(`テンプレートを保存できませんでした: ${e.message}`, { error: true }));
        const d = dateParts(body.date);
        toast(`${d.md}（${d.wd}）の「${category.toLowerCase()}」を${id ? "更新" : "記録"}しました`);
        resetEventForm();
      };
    }
  }
  const button = $("#event-submit");
  button.disabled = true;
  try {
    await run();
    await refreshAfterEventChange();
  } catch (e) {
    showFormError(`保存できませんでした: ${e.message}`);
  } finally {
    button.disabled = false;
  }
});

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
  // ランがあれば平均ペース（距離と時間が分かるランの合計から）
  const timedRuns = rows.filter((r) => r.is_run && r.distance_km && r.duration_min);
  const runKm = sumBy(timedRuns, "distance_km");
  const avgPace = timedRuns.length ? fmtPace(sumBy(timedRuns, "duration_min") / runKm) : null;
  $("#wo-stats").innerHTML = [
    ["回数", `${rows.length}回`],
    ["合計時間", fmtMinutes(sumBy(rows, "duration_min"))],
    ["合計距離", total("distance_qty", distUnits)],
    ["消費エネルギー", total("active_energy_qty", energyUnits)],
    ...(avgPace ? [["ランの平均ペース", avgPace]] : []),
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
      r.is_run ? fmtPace(r.pace_min_km) : null,
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
        ${r.is_run && r.intensity ? `<span class="sub">強度 ${intensityMeter(r.intensity)}</span>` : ""}
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
  await Promise.all([loadImpact(), loadCategoryComparison(), loadDose(), loadRunIntensity()]);
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
  const params = new URLSearchParams({ metric, category, window: $("#an-window").value,
    run_measure: $("#an-run-measure").value });
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
  const params = new URLSearchParams({ metric, lag: $("#cc-lag").value, kind, run_measure: $("#an-run-measure").value });
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

const LAG_LABELS = ["当日", "翌日", "翌々日"];

async function loadRunIntensity() {
  const metric = $("#an-metric").value;
  if (!metric) return;
  const params = new URLSearchParams({ metric, measure: $("#ri-measure").value, lag: $("#ri-lag").value });
  if ($("#ri-type").value) params.set("name", $("#ri-type").value);
  let r;
  try {
    r = await api(`/api/analysis/run-intensity?${params}`);
  } catch (e) {
    $("#ri-table").innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }
  const unit = state.units[metric] || "";
  const mu = r.measure_unit;
  if (!r.n_runs) {
    $("#ri-summary").textContent = "距離や時間の分かるランが取り込まれると表示されます。";
    $("#ri-table").innerHTML = "";
    ["ri-chart", "ri-scatter"].forEach((id) => charts[id]?.destroy());
    return;
  }
  const strength = (v) => (Math.abs(v) < 0.1 ? "ほぼ関係なし" : Math.abs(v) < 0.3 ? "弱い" : Math.abs(v) < 0.5 ? "中程度" : "強い");
  const dir = r.r > 0 ? `（${r.measure_label}が大きいほど高い）` : `（${r.measure_label}が大きいほど低い）`;
  const lagText = LAG_LABELS[r.lag] || `${r.lag}日後`;
  $("#ri-summary").textContent = r.r === null
    ? `ランした${r.n_runs}日分のデータ。相関係数は計算できませんでした。`
    : `${r.measure_label}と${lagText}の${label(metric)}の相関係数 r = ${fmt(r.r, 2)}：${strength(r.r)}${Math.abs(r.r) >= 0.1 ? dir : ""}（ランした${r.n_runs}日）`;

  const range = (b) => (b.lo === null && b.hi === null ? "" : b.lo === null ? `〜${fmt(b.hi)}` : b.hi === null ? `${fmt(b.lo)}超` : `${fmt(b.lo)}〜${fmt(b.hi)}`);
  const bins = r.bins;
  const opts = baseChartOptions();
  opts.interaction = { mode: "index", intersect: false };
  opts.scales.y.grid = { color: (ctx) => (ctx.tick.value === 0 ? css("--zero-line") : css("--grid")) };
  opts.plugins.tooltip.callbacks = {
    label: (item) => {
      const b = bins[item.dataIndex];
      return [`ランなしとの差: ${signed(b.diff)} ${unit}`, `平均: ${fmt(b.mean)} ${unit}`, `日数: ${b.n}`,
        ...(range(b) ? [`${r.measure_label}: ${range(b)} ${mu}`] : [])];
    },
  };
  renderChart("ri-chart", {
    type: "bar",
    data: {
      labels: bins.map((b) => `${b.label}（${b.n}）`),
      datasets: [{ data: bins.map((b) => b.diff), backgroundColor: css("--series-1"),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 48 }],
    },
    options: opts,
  });

  // 散布図: 横軸が強度、縦軸が指標。ランしなかった日の平均を横線で示す
  const none = bins[0].mean;
  const sopts = baseChartOptions();
  sopts.interaction = { mode: "nearest", intersect: true };
  sopts.scales.x = { type: "linear", title: { display: true, text: `${r.measure_label}（${mu}）`, color: css("--text-secondary") },
    ticks: { color: css("--text-secondary") }, grid: { color: css("--grid") }, border: { display: false } };
  sopts.scales.y.title = { display: true, text: `${lagText}の${label(metric)}`, color: css("--text-secondary") };
  sopts.plugins.tooltip.callbacks = {
    label: (item) => (item.dataset.type === "line" ? `ランなしの平均: ${fmt(none)} ${unit}`
      : [`${item.raw.date}`, `${r.measure_label}: ${fmt(item.raw.x)} ${mu}`, `${label(metric)}: ${fmt(item.raw.y)} ${unit}`]),
  };
  const xs = r.points.map((p) => p.dose);
  renderChart("ri-scatter", {
    data: {
      datasets: [
        { type: "scatter", data: r.points.map((p) => ({ x: p.dose, y: p.value, date: p.date })),
          backgroundColor: css("--series-1"), pointRadius: 4, pointHoverRadius: 6 },
        ...(none === null ? [] : [{ type: "line", data: [{ x: Math.min(...xs), y: none }, { x: Math.max(...xs), y: none }],
          borderColor: css("--zero-line"), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 }]),
      ],
    },
    options: sopts,
  });

  $("#ri-table").innerHTML = table(
    [{ label: "区分" }, { label: `${r.measure_label}（${mu}）`, num: true }, { label: "日数", num: true },
      { label: "平均", num: true }, { label: "中央値", num: true }, { label: "ランなしとの差", num: true }],
    bins.map((b) => [esc(b.label), range(b) || "―", b.n, fmt(b.mean), fmt(b.median),
      b.diff === null ? "―" : `${signed(b.diff)} ${esc(unit)}`]),
  );
}

["#an-metric", "#an-intensity"].forEach((s) => $(s).addEventListener("change", loadAnalysis));
$("#an-run-measure").addEventListener("change", () => Promise.all([loadImpact(), loadCategoryComparison()]));
["#ri-measure", "#ri-type", "#ri-lag"].forEach((s) => $(s).addEventListener("change", loadRunIntensity));
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
  await Promise.all([loadCatalog(), loadCategories(), loadQuickPicks()]);
  let tab = "dashboard";
  try { tab = localStorage.getItem("tab") || tab; } catch (_) { /* ignore */ }
  showTab(tab);
})();
