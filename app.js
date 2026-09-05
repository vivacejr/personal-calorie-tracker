'use strict';

// ── API URL (stored in localStorage, entered once by user) ─────────────────
const HARDCODED_URL = 'https://script.google.com/macros/s/AKfycbwtgpFbOCTqs2uMzo-9Upq54iwECxKbjh0Hhv4P0vbKZjHV-hGa_z9mEzJxhRW46Ev6/exec'; // paste your Apps Script URL here
let API_URL = HARDCODED_URL || localStorage.getItem('calorie_tracker_url') || '';

// ── Frontend log cache (avoids repeat API calls when switching views) ───────
const logCache = {}; // { "2026-05-14": [...logs] }
let trendsCache = null; // { days, dates, dailyTotals }
let trendsDays = 7;
let trendsCharts = []; // Chart.js instances

function invalidateLogCache(date) {
  delete logCache[date];
  trendsCache = null; // trends data is also stale
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  ingredients: [],
  currentMeal: { name: '', items: [] }, // items: [{ingredient, grams}]
};

// ── API layer ──────────────────────────────────────────────────────────────
const api = {
  async _get(params) {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Server error');
    return json.data;
  },

  async _post(body) {
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(body),
      // No Content-Type header → browser sends text/plain → no CORS preflight
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Server error');
    return json;
  },

  getIngredients:    ()          => api._get({ action: 'getIngredients' }),
  getLogs:           (date)      => api._get({ action: 'getLogs', date }),
  getLogsRange:      (from, to)  => api._get({ action: 'getLogsRange', from, to }),
  addIngredient:     (data)    => api._post({ action: 'addIngredient', ...data }),
  updateIngredient:  (data)    => api._post({ action: 'updateIngredient', ...data }),
  deleteIngredient:  (id)      => api._post({ action: 'deleteIngredient', id }),
  addMealEntries:    (entries) => api._post({ action: 'addMealEntries', entries }),
  deleteLog:         (id, date) => api._post({ action: 'deleteLog', id, date }),
};

// ── Utils ──────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString('en-CA'); // "2026-05-12"
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function r1(n) { return Math.round(Number(n) * 10) / 10; }

function computeMacros(ing, amount) {
  const factor = (ing.unit || 'g') === 'qty' ? amount : amount / 100;
  return {
    calories: r1(Number(ing.calories) * factor),
    protein:  r1(Number(ing.protein)  * factor),
    carbs:    r1(Number(ing.carbs)    * factor),
    fat:      r1(Number(ing.fat)      * factor),
    fiber:    r1(Number(ing.fiber)    * factor),
    sugar:    r1(Number(ing.sugar)    * factor),
  };
}

function getIngUnit(ingredientId) {
  const ing = state.ingredients.find(i => i.id === ingredientId);
  return (ing && ing.unit) || 'g';
}

function getModalUnit() {
  const active = document.querySelector('.unit-opt.active');
  return active ? active.dataset.unit : 'g';
}

function sumMacros(logs) {
  return logs.reduce((acc, row) => ({
    calories: r1(acc.calories + Number(row.calories)),
    protein:  r1(acc.protein  + Number(row.protein)),
    carbs:    r1(acc.carbs    + Number(row.carbs)),
    fat:      r1(acc.fat      + Number(row.fat)),
    fiber:    r1(acc.fiber    + Number(row.fiber)),
    sugar:    r1(acc.sugar    + Number(row.sugar)),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 });
}

function groupByMeal(logs) {
  const map = Object.create(null);
  logs.forEach(row => {
    if (!map[row.mealName]) map[row.mealName] = [];
    map[row.mealName].push(row);
  });
  return map;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ── Router ─────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  const navBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (name === 'today')       loadToday();
  if (name === 'log')         initLogView();
  if (name === 'ingredients') renderIngList();
  if (name === 'history')     initHistoryView();
  if (name === 'trends')      loadTrends(trendsDays);
}

// ── Shared renderers ───────────────────────────────────────────────────────
function macroCardHTML(t) {
  const fiberLine = t.fiber ? `<div class="macro-pill"><span class="pill-val clr-fiber">${t.fiber}g</span><span class="pill-lbl">FIBER</span></div>` : '';
  return `
    <div class="macro-card">
      <div class="macro-cal-row">
        <span class="macro-cal-num">${t.calories}</span><span class="macro-cal-unit">kcal</span>
      </div>
      <div class="macro-pills">
        <div class="macro-pill"><span class="pill-val clr-protein">${t.protein}g</span><span class="pill-lbl">PROTEIN</span></div>
        <div class="macro-pill"><span class="pill-val clr-carbs">${t.carbs}g</span><span class="pill-lbl">CARBS</span></div>
        <div class="macro-pill"><span class="pill-val clr-fat">${t.fat}g</span><span class="pill-lbl">FAT</span></div>
        ${fiberLine}
      </div>
    </div>`;
}


function renderMealGroups(logs, containerId, onDelete) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const groups = groupByMeal(logs);
  let html = '';
  Object.entries(groups).forEach(([meal, rows]) => {
    const mealKcal = r1(rows.reduce((s, r) => s + Number(r.calories), 0));
    html += `<div class="meal-group">
      <div class="meal-group-header">
        <span class="meal-group-name">${esc(meal)}</span>
        <span class="meal-group-kcal">${mealKcal} kcal</span>
      </div>`;
    rows.forEach(row => {
      html += `<div class="log-row">
        <div class="log-row-info">
          <div class="log-row-name">${esc(row.ingredientName)}</div>
          <div class="log-row-meta">${row.grams}${getIngUnit(row.ingredientId) === 'qty' ? '×' : 'g'} &nbsp;·&nbsp; P:${row.protein} C:${row.carbs} F:${row.fat}</div>
        </div>
        <span class="log-row-kcal">${row.calories}</span>
        ${onDelete ? `<button class="del-btn" data-id="${esc(row.id)}" data-date="${esc(row.date)}" title="Delete">×</button>` : ''}
      </div>`;
    });
    html += '</div>';
  });
  el.innerHTML = html;

  if (onDelete) {
    el.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this entry?')) return;
        btn.disabled = true;
        try {
          await api.deleteLog(btn.dataset.id, btn.dataset.date);
          invalidateLogCache(btn.dataset.date);
          onDelete();
        } catch (e) {
          toast('Failed to delete', 'error');
          btn.disabled = false;
        }
      });
    });
  }
}

// ── TODAY ──────────────────────────────────────────────────────────────────
async function loadToday() {
  const date = todayStr();
  document.getElementById('today-date').textContent = fmtDate(date);

  if (logCache[date]) { renderTodayLogs(date, logCache[date]); return; }

  const content = document.getElementById('today-content');
  content.innerHTML = '<div class="loading-state">Loading</div>';

  try {
    const logs = await api.getLogs(date);
    logCache[date] = logs;

    renderTodayLogs(date, logs);
  } catch (e) {
    const content = document.getElementById('today-content');
    content.innerHTML = '<div class="empty-state">Failed to load. Tap to retry.</div>';
    content.querySelector('.empty-state').addEventListener('click', loadToday);
  }
}

function renderTodayLogs(date, logs) {
  const content = document.getElementById('today-content');
  if (!logs.length) {
    content.innerHTML =
      macroCardHTML({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 }) +
      '<div class="empty-state">No meals logged today</div>';
    return;
  }
  const totals = sumMacros(logs);
  content.innerHTML = macroCardHTML(totals) + '<div id="today-meals"></div>';
  renderMealGroups(logs, 'today-meals', () => { invalidateLogCache(date); loadToday(); });
}

// ── LOG MEAL ───────────────────────────────────────────────────────────────
function initLogView() {
  document.getElementById('meal-date').value = todayStr();
  document.getElementById('ingredient-search').value = '';
  renderPicker('');
  renderSelected();
}

function renderPicker(filter) {
  const el = document.getElementById('ingredient-picker');
  const items = filter
    ? state.ingredients.filter(i => i.name.toLowerCase().includes(filter.toLowerCase()))
    : state.ingredients;

  if (!items.length) {
    el.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:12px">No ingredients found</div>';
    return;
  }
  el.innerHTML = items.map(ing => {
    const unitLabel = (ing.unit || 'g') === 'qty' ? 'per unit' : 'per 100g';
    return `
    <div class="picker-row">
      <div class="picker-row-info">
        <div class="picker-row-name">${esc(ing.name)}</div>
        <div class="picker-row-macros">${ing.calories} kcal &nbsp;·&nbsp; P:${ing.protein} C:${ing.carbs} F:${ing.fat} <span style="opacity:0.6">${unitLabel}</span></div>
      </div>
      <button class="plus-btn" data-id="${esc(ing.id)}">+</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.plus-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const ing = state.ingredients.find(i => i.id === btn.dataset.id);
      if (!ing) return;
      if (state.currentMeal.items.find(it => it.ingredient.id === ing.id)) {
        toast('Already added — adjust grams below');
        return;
      }
      const defaultAmt = (ing.unit || 'g') === 'qty' ? 1 : 100;
      state.currentMeal.items.push({ ingredient: ing, grams: defaultAmt });
      renderSelected();
    });
  });
}

function renderSelected() {
  const section = document.getElementById('selected-section');
  const list    = document.getElementById('selected-list');
  const totalsEl= document.getElementById('meal-totals');

  if (!state.currentMeal.items.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  list.innerHTML = state.currentMeal.items.map((item, idx) => {
    const unitLabel = (item.ingredient.unit || 'g') === 'qty' ? '×' : 'g';
    return `
    <div class="selected-row">
      <span class="selected-row-name">${esc(item.ingredient.name)}</span>
      <div class="grams-wrap">
        <input type="number" class="grams-input" data-idx="${idx}"
               value="${item.grams}" min="1" inputmode="decimal">
        <span class="grams-unit">${unitLabel}</span>
      </div>
      <button class="rm-btn" data-idx="${idx}">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.grams-input').forEach(input => {
    input.addEventListener('input', () => {
      state.currentMeal.items[+input.dataset.idx].grams = Number(input.value) || 0;
      updateTotalsBar();
    });
  });
  list.querySelectorAll('.rm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentMeal.items.splice(+btn.dataset.idx, 1);
      renderSelected();
    });
  });

  updateTotalsBar();
}

function updateTotalsBar() {
  const t = state.currentMeal.items.reduce((acc, { ingredient, grams }) => {
    const m = computeMacros(ingredient, grams);
    return {
      calories: r1(acc.calories + m.calories),
      protein:  r1(acc.protein  + m.protein),
      carbs:    r1(acc.carbs    + m.carbs),
      fat:      r1(acc.fat      + m.fat),
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

  document.getElementById('meal-totals').innerHTML =
    `<span class="t-cal">${t.calories} kcal</span>` +
    `<span class="t-prot">P: ${t.protein}g</span>` +
    `<span class="t-carb">C: ${t.carbs}g</span>` +
    `<span class="t-fat">F: ${t.fat}g</span>`;
}

async function saveMeal() {
  const mealName = document.getElementById('meal-name').value.trim();
  if (!mealName)                          { toast('Enter a meal name', 'error'); return; }
  if (!state.currentMeal.items.length)    { toast('Add at least one ingredient', 'error'); return; }
  if (state.currentMeal.items.some(it => !it.grams || it.grams <= 0)) {
    toast('Enter grams for all ingredients', 'error'); return;
  }

  const btn = document.getElementById('save-meal-btn');
  btn.disabled = true; btn.textContent = 'SAVING…';

  const date = document.getElementById('meal-date').value || todayStr();
  const entries = state.currentMeal.items.map(({ ingredient, grams }) => ({
    date, mealName,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    grams,
    ...computeMacros(ingredient, grams),
  }));

  try {
    await api.addMealEntries(entries);
    invalidateLogCache(date);
    state.currentMeal = { name: '', items: [] };
    document.getElementById('meal-name').value = '';
    if (date === todayStr()) {
      toast('Meal saved!', 'success');
      showView('today');
    } else {
      toast('Meal saved!', 'success');
      document.getElementById('history-date').value = date;
      showView('history');
      loadHistory(date);
    }
  } catch (e) {
    toast('Failed to save. Try again.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'SAVE MEAL';
  }
}

// ── INGREDIENTS ────────────────────────────────────────────────────────────
function renderIngList(filter) {
  const el = document.getElementById('ingredients-list');
  if (!filter) filter = document.getElementById('ingredients-search').value;
  const items = filter
    ? state.ingredients.filter(i => i.name.toLowerCase().includes(filter.toLowerCase()))
    : state.ingredients;

  if (!items.length) {
    el.innerHTML = state.ingredients.length === 0
      ? '<div class="loading-state">Loading</div>'
      : '<div class="empty-state">No ingredients match</div>';
    return;
  }
  el.innerHTML = items.map(ing => `
    <div class="ing-card">
      <div class="ing-card-top">
        <div class="ing-card-name">${esc(ing.name)}</div>
        <div class="ing-card-actions">
          <button class="ing-edit-btn" data-id="${esc(ing.id)}" title="Edit">Edit</button>
          <button class="ing-del-btn" data-id="${esc(ing.id)}" title="Delete">×</button>
        </div>
      </div>
      <div class="ing-card-macros">
        <span class="clr-cal">${ing.calories} kcal</span>
        <span class="clr-protein">P: ${ing.protein}g</span>
        <span class="clr-carbs">C: ${ing.carbs}g</span>
        <span class="clr-fat">F: ${ing.fat}g</span>
        ${ing.fiber ? `<span class="clr-muted">Fiber: ${ing.fiber}g</span>` : ''}
        <span class="clr-muted">${(ing.unit || 'g') === 'qty' ? 'per unit' : 'per 100g'}</span>
      </div>
    </div>`).join('');

  el.querySelectorAll('.ing-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ing = state.ingredients.find(i => i.id === btn.dataset.id);
      if (ing) openModal(ing);
    });
  });

  el.querySelectorAll('.ing-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ing = state.ingredients.find(i => i.id === btn.dataset.id);
      if (!ing) return;
      if (!confirm(`Delete "${ing.name}"? This won't remove it from past logs.`)) return;
      btn.disabled = true;
      try {
        await api.deleteIngredient(ing.id);
        state.ingredients = state.ingredients.filter(i => i.id !== ing.id);
        renderIngList();
        toast('Ingredient deleted', 'success');
      } catch (e) {
        toast('Failed to delete', 'error');
        btn.disabled = false;
      }
    });
  });
}

// null = adding new; ingredient object = editing existing
let editingIngredient = null;

async function saveIngredient() {
  const name = document.getElementById('new-name').value.trim();
  if (!name) { toast('Enter a name', 'error'); return; }

  const isDupe = state.ingredients.find(i =>
    i.name.toLowerCase() === name.toLowerCase() && i.id !== (editingIngredient && editingIngredient.id)
  );
  if (isDupe) { toast('Ingredient already exists', 'error'); return; }

  const data = {
    name,
    unit:     getModalUnit(),
    calories: Number(document.getElementById('new-calories').value) || 0,
    protein:  Number(document.getElementById('new-protein').value)  || 0,
    carbs:    Number(document.getElementById('new-carbs').value)    || 0,
    fat:      Number(document.getElementById('new-fat').value)      || 0,
    fiber:    Number(document.getElementById('new-fiber').value)    || 0,
    sugar:    0,
  };

  const btn = document.getElementById('modal-confirm');
  btn.disabled = true; btn.textContent = editingIngredient ? 'SAVING…' : 'ADDING…';

  try {
    if (editingIngredient) {
      await api.updateIngredient({ id: editingIngredient.id, ...data });
      const idx = state.ingredients.findIndex(i => i.id === editingIngredient.id);
      if (idx !== -1) state.ingredients[idx] = { ...state.ingredients[idx], ...data };
      toast('Ingredient updated!', 'success');
    } else {
      const result = await api.addIngredient(data);
      state.ingredients.push(result.data);
      state.ingredients.sort((a, b) => a.name.localeCompare(b.name));
      toast('Ingredient added!', 'success');
    }
    closeModal();
    renderIngList();
  } catch (e) {
    toast('Failed to save. Try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = editingIngredient ? 'SAVE' : 'ADD';
  }
}

function setModalUnit(unit) {
  document.querySelectorAll('.unit-opt').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
  document.getElementById('macro-per-label').textContent = unit === 'qty' ? 'Macros per 1 unit' : 'Macros per 100g';
}

function openModal(ing = null) {
  editingIngredient = ing;
  document.getElementById('modal-title').textContent   = ing ? 'EDIT INGREDIENT' : 'NEW INGREDIENT';
  document.getElementById('modal-confirm').textContent = ing ? 'SAVE' : 'ADD';
  document.getElementById('new-name').value     = ing ? ing.name     : '';
  document.getElementById('new-calories').value = ing ? ing.calories : '';
  document.getElementById('new-protein').value  = ing ? ing.protein  : '';
  document.getElementById('new-carbs').value    = ing ? ing.carbs    : '';
  document.getElementById('new-fat').value      = ing ? ing.fat      : '';
  document.getElementById('new-fiber').value    = ing ? ing.fiber    : '';
  setModalUnit(ing ? (ing.unit || 'g') : 'g');
  document.getElementById('add-modal').style.display = 'flex';
  document.getElementById('new-name').focus();
}

function closeModal() {
  document.getElementById('add-modal').style.display = 'none';
  editingIngredient = null;
  setModalUnit('g');
  ['new-name','new-calories','new-protein','new-carbs','new-fat','new-fiber']
    .forEach(id => { document.getElementById(id).value = ''; });
}

// ── HISTORY ────────────────────────────────────────────────────────────────
function initHistoryView() {
  const input = document.getElementById('history-date');
  if (!input.value) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    input.value = yesterday.toLocaleDateString('en-CA');
  }
  loadHistory(input.value); // always refresh on view switch
}

async function loadHistory(date) {
  if (logCache[date]) { renderHistoryLogs(date, logCache[date]); return; }

  const content = document.getElementById('history-content');
  content.innerHTML = '<div class="loading-state">Loading</div>';

  try {
    const logs = await api.getLogs(date);
    logCache[date] = logs;
    renderHistoryLogs(date, logs);
  } catch (e) {
    content.innerHTML = '<div class="empty-state">Failed to load.</div>';
  }
}

function renderHistoryLogs(date, logs) {
  const content = document.getElementById('history-content');
  if (!logs.length) {
    content.innerHTML = `<div class="empty-state">No meals logged on<br>${fmtDate(date)}</div>`;
    return;
  }
  const totals = sumMacros(logs);
  content.innerHTML = macroCardHTML(totals) + '<div id="history-meals"></div>';
  renderMealGroups(logs, 'history-meals', () => { invalidateLogCache(date); loadHistory(date); });
}

// ── TRENDS ────────────────────────────────────────────────────────────────
function makeDateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString('en-CA'));
  }
  return dates;
}

function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function computeDailyTotals(aggregatedRows, dates) {
  const byDate = {};
  dates.forEach(d => { byDate[d] = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }; });
  aggregatedRows.forEach(row => {
    if (!byDate[row.date]) return;
    byDate[row.date] = {
      calories: r1(Number(row.calories)),
      protein:  r1(Number(row.protein)),
      carbs:    r1(Number(row.carbs)),
      fat:      r1(Number(row.fat)),
      fiber:    r1(Number(row.fiber)),
    };
  });
  return byDate;
}

async function loadTrends(days) {
  trendsDays = days;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.days) === days);
  });

  if (trendsCache && trendsCache.days === days) {
    renderTrendCharts(trendsCache.dates, trendsCache.dailyTotals);
    return;
  }

  const content = document.getElementById('trends-content');
  content.innerHTML = '<div class="loading-state">Loading</div>';

  const dates = makeDateRange(days);
  try {
    const logs = await api.getLogsRange(dates[0], dates[dates.length - 1]);
    const dailyTotals = computeDailyTotals(logs, dates);
    trendsCache = { days, dates, dailyTotals };
    renderTrendCharts(dates, dailyTotals);
  } catch (e) {
    content.innerHTML = '<div class="empty-state">Failed to load trends.</div>';
  }
}

function computePeriodAverages(dates, dailyTotals) {
  const loggedDates = dates.filter(d => dailyTotals[d].calories > 0);
  const n = loggedDates.length || 1;
  const sum = (key) => loggedDates.reduce((s, d) => s + dailyTotals[d][key], 0);
  return {
    calories: r1(sum('calories') / n),
    protein:  r1(sum('protein')  / n),
    carbs:    r1(sum('carbs')    / n),
    fat:      r1(sum('fat')      / n),
    fiber:    r1(sum('fiber')    / n),
    loggedDays: loggedDates.length,
    totalDays:  dates.length,
  };
}

function renderTrendCharts(dates, dailyTotals) {
  trendsCharts.forEach(c => c.destroy());
  trendsCharts = [];

  const macros = [
    { key: 'calories', label: 'CALORIES', color: '#60a5fa', benchmark: 1900 },
    { key: 'protein',  label: 'PROTEIN',  color: '#34d399', benchmark: 120  },
    { key: 'carbs',    label: 'CARBS',    color: '#fbbf24' },
    { key: 'fat',      label: 'FAT',      color: '#f87171' },
    { key: 'fiber',    label: 'FIBER',    color: '#a78bfa' },
  ];

  const avgs = computePeriodAverages(dates, dailyTotals);
  const unit = (key) => key === 'calories' ? 'kcal' : 'g';

  const labels = dates.map(shortDate);
  const content = document.getElementById('trends-content');

  const avgNote = avgs.loggedDays < avgs.totalDays
    ? `<span class="trend-avg-note">${avgs.loggedDays}/${avgs.totalDays} days logged</span>`
    : '';

  content.innerHTML = `<div class="trend-avg-summary">
    <div class="trend-avg-summary-title">DAILY AVERAGE${avgNote}</div>
    <div class="trend-avg-pills">
      ${macros.map(m => `<div class="trend-avg-pill" style="border-color:${m.color}20">
        <span class="trend-avg-val" style="color:${m.color}">${avgs[m.key]}</span>
        <span class="trend-avg-lbl">${m.label === 'CALORIES' ? 'kcal' : m.label.slice(0,1) + unit(m.key)}</span>
      </div>`).join('')}
    </div>
  </div>` + macros.map(m => `
    <div class="trend-card">
      <div class="trend-card-header">
        <span class="trend-card-label" style="color:${m.color}">${m.label}</span>
        <span class="trend-card-avg">avg <strong style="color:${m.color}">${avgs[m.key]}</strong> ${unit(m.key)}</span>
      </div>
      <div class="trend-chart-wrap"><canvas id="tchart-${m.key}"></canvas></div>
    </div>`).join('');

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#5a5a7a', font: { size: 9 }, maxRotation: 45 },
        grid: { color: '#1c1c32' },
      },
      y: {
        ticks: { color: '#5a5a7a', font: { size: 9 } },
        grid: { color: '#1c1c32' },
        beginAtZero: true,
      },
    },
  };

  macros.forEach(m => {
    const canvas = document.getElementById('tchart-' + m.key);
    const avg = avgs[m.key];
    const datasets = [{
      type: 'bar',
      data: dates.map(d => dailyTotals[d][m.key]),
      backgroundColor: m.color + '40',
      borderColor: m.color,
      borderWidth: 1,
      borderRadius: 3,
    }, {
      type: 'line',
      data: dates.map(() => avg),
      borderColor: m.color,
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      fill: false,
    }];
    if (m.benchmark) {
      datasets.push({
        type: 'line',
        data: dates.map(() => m.benchmark),
        borderColor: m.color + '60',
        borderWidth: 1,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
      });
    }
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: chartDefaults,
    });
    trendsCharts.push(chart);
  });
}

// ── Setup screen ───────────────────────────────────────────────────────────
function showSetup() {
  document.getElementById('setup-screen').style.display = 'flex';
}

function hideSetup() {
  document.getElementById('setup-screen').style.display = 'none';
}

function saveApiUrl() {
  const val = document.getElementById('setup-url').value.trim();
  if (!val || !val.startsWith('https://script.google.com')) {
    toast('Paste a valid Apps Script URL', 'error');
    return;
  }
  API_URL = val;
  localStorage.setItem('calorie_tracker_url', API_URL);
  hideSetup();
  start();
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  // Setup screen
  document.getElementById('setup-connect-btn').addEventListener('click', saveApiUrl);
  document.getElementById('setup-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveApiUrl();
  });

  if (!API_URL) { showSetup(); return; }
  start();
}

async function start() {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Log meal
  document.getElementById('log-fab').addEventListener('click', () => showView('log'));
  document.getElementById('log-back-btn').addEventListener('click', () => showView('today'));
  document.getElementById('ingredient-search').addEventListener('input', e => renderPicker(e.target.value));
  document.getElementById('save-meal-btn').addEventListener('click', saveMeal);

  // Ingredients
  document.getElementById('ingredients-search').addEventListener('input', e => renderIngList(e.target.value));
  document.getElementById('add-ingredient-fab').addEventListener('click', () => openModal());
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('.unit-opt').forEach(btn => {
    btn.addEventListener('click', () => setModalUnit(btn.dataset.unit));
  });
  document.getElementById('modal-confirm').addEventListener('click', saveIngredient);
  document.getElementById('modal-backdrop') && document.getElementById('modal-backdrop').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

  // History
  document.getElementById('history-date').addEventListener('change', e => { if (e.target.value) loadHistory(e.target.value); });

  // Trends period selector
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => loadTrends(Number(btn.dataset.days)));
  });

  // Load ingredients + today's logs in parallel
  try {
    const [ings, todayLogs] = await Promise.all([
      api.getIngredients(),
      api.getLogs(todayStr()),
    ]);
    state.ingredients = ings.sort((a, b) => a.name.localeCompare(b.name));
    logCache[todayStr()] = todayLogs;
  } catch (e) {
    toast('Could not load data', 'error');
  }

  // Show today (renders instantly from cache)
  showView('today');
}

document.addEventListener('DOMContentLoaded', init);
