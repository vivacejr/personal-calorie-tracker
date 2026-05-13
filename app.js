'use strict';

// ── API URL (stored in localStorage, entered once by user) ─────────────────
let API_URL = localStorage.getItem('calorie_tracker_url') || '';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  ingredients: [],
  currentMeal: { name: '', items: [] }, // items: [{ingredient, grams}]
  charts: { today: null, history: null },
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

  getIngredients:    ()        => api._get({ action: 'getIngredients' }),
  getLogs:           (date)    => api._get({ action: 'getLogs', date }),
  addIngredient:     (data)    => api._post({ action: 'addIngredient', ...data }),
  updateIngredient:  (data)    => api._post({ action: 'updateIngredient', ...data }),
  deleteIngredient:  (id)      => api._post({ action: 'deleteIngredient', id }),
  addMealEntries:    (entries) => api._post({ action: 'addMealEntries', entries }),
  deleteLog:         (id)      => api._post({ action: 'deleteLog', id }),
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

function computeMacros(ing, grams) {
  const f = grams / 100;
  return {
    calories: r1(Number(ing.calories) * f),
    protein:  r1(Number(ing.protein)  * f),
    carbs:    r1(Number(ing.carbs)    * f),
    fat:      r1(Number(ing.fat)      * f),
    fiber:    r1(Number(ing.fiber)    * f),
    sugar:    r1(Number(ing.sugar)    * f),
  };
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
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');

  if (name === 'today')       loadToday();
  if (name === 'log')         initLogView();
  if (name === 'ingredients') renderIngList();
  if (name === 'history')     initHistoryView();
}

// ── Shared renderers ───────────────────────────────────────────────────────
function macroCardHTML(t) {
  const fiberLine = t.fiber ? `<div class="macro-pill"><span class="pill-val clr-fiber">${t.fiber}g</span><span class="pill-lbl">FIBER</span></div>` : '';
  const sugarLine = t.sugar ? `<div class="macro-pill"><span class="pill-val clr-sugar">${t.sugar}g</span><span class="pill-lbl">SUGAR</span></div>` : '';
  return `
    <div class="macro-card">
      <div class="macro-cal-row">
        <span class="macro-cal-num">${t.calories}</span><span class="macro-cal-unit">kcal</span>
      </div>
      <div class="macro-pills">
        <div class="macro-pill"><span class="pill-val clr-protein">${t.protein}g</span><span class="pill-lbl">PROTEIN</span></div>
        <div class="macro-pill"><span class="pill-val clr-carbs">${t.carbs}g</span><span class="pill-lbl">CARBS</span></div>
        <div class="macro-pill"><span class="pill-val clr-fat">${t.fat}g</span><span class="pill-lbl">FAT</span></div>
        ${fiberLine}${sugarLine}
      </div>
    </div>`;
}

function renderPie(canvasId, totals, existing) {
  if (existing) existing.destroy();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const { protein, carbs, fat } = totals;
  if (!protein && !carbs && !fat) {
    canvas.parentElement.innerHTML = '<div class="empty-state" style="padding:16px">No macro data</div>';
    return null;
  }
  return new Chart(canvas, {
    type: 'pie',
    data: {
      labels: ['Protein', 'Carbs', 'Fat'],
      datasets: [{
        data: [protein, carbs, fat],
        backgroundColor: ['#00ff88', '#ffe600', '#ff3366'],
        borderColor: '#12121a',
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#e0e0ff', font: { size: 11, family: 'Inter, system-ui' }, padding: 14 },
        },
      },
    },
  });
}

function renderMealGroups(logs, containerId, deletable) {
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
          <div class="log-row-meta">${row.grams}g &nbsp;·&nbsp; P:${row.protein} C:${row.carbs} F:${row.fat}</div>
        </div>
        <span class="log-row-kcal">${row.calories}</span>
        ${deletable ? `<button class="del-btn" data-id="${esc(row.id)}" title="Delete">×</button>` : ''}
      </div>`;
    });
    html += '</div>';
  });
  el.innerHTML = html;

  if (deletable) {
    el.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this entry?')) return;
        btn.disabled = true;
        try {
          await api.deleteLog(btn.dataset.id);
          loadToday();
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
  const content = document.getElementById('today-content');
  content.innerHTML = '<div class="loading-state">Loading</div>';

  const date = todayStr();
  document.getElementById('today-date').textContent = fmtDate(date);

  try {
    const logs = await api.getLogs(date);

    if (!logs.length) {
      content.innerHTML =
        macroCardHTML({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 }) +
        '<div class="chart-wrap"><div class="empty-state" style="padding:12px">No meals logged today</div></div>' +
        '<div id="today-meals"></div>';
      state.charts.today = null;
      return;
    }

    const totals = sumMacros(logs);
    content.innerHTML =
      macroCardHTML(totals) +
      '<div class="chart-wrap"><canvas id="today-chart"></canvas></div>' +
      '<div id="today-meals"></div>';

    state.charts.today = renderPie('today-chart', totals, state.charts.today);
    renderMealGroups(logs, 'today-meals', true);
  } catch (e) {
    content.innerHTML = '<div class="empty-state">Failed to load. Tap to retry.</div>';
    content.querySelector('.empty-state').addEventListener('click', loadToday);
  }
}

// ── LOG MEAL ───────────────────────────────────────────────────────────────
function initLogView() {
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
  el.innerHTML = items.map(ing => `
    <div class="picker-row">
      <div class="picker-row-info">
        <div class="picker-row-name">${esc(ing.name)}</div>
        <div class="picker-row-macros">${ing.calories} kcal &nbsp;·&nbsp; P:${ing.protein} C:${ing.carbs} F:${ing.fat} per 100g</div>
      </div>
      <button class="plus-btn" data-id="${esc(ing.id)}">+</button>
    </div>`).join('');

  el.querySelectorAll('.plus-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const ing = state.ingredients.find(i => i.id === btn.dataset.id);
      if (!ing) return;
      if (state.currentMeal.items.find(it => it.ingredient.id === ing.id)) {
        toast('Already added — adjust grams below');
        return;
      }
      state.currentMeal.items.push({ ingredient: ing, grams: 100 });
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

  list.innerHTML = state.currentMeal.items.map((item, idx) => `
    <div class="selected-row">
      <span class="selected-row-name">${esc(item.ingredient.name)}</span>
      <div class="grams-wrap">
        <input type="number" class="grams-input" data-idx="${idx}"
               value="${item.grams}" min="1" inputmode="decimal">
        <span class="grams-unit">g</span>
      </div>
      <button class="rm-btn" data-idx="${idx}">×</button>
    </div>`).join('');

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

  const date = todayStr();
  const entries = state.currentMeal.items.map(({ ingredient, grams }) => ({
    date, mealName,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    grams,
    ...computeMacros(ingredient, grams),
  }));

  try {
    await api.addMealEntries(entries);
    toast('Meal saved!', 'success');
    state.currentMeal = { name: '', items: [] };
    document.getElementById('meal-name').value = '';
    showView('today');
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
        ${ing.sugar ? `<span class="clr-muted">Sugar: ${ing.sugar}g</span>` : ''}
        <span class="clr-muted">per 100g</span>
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
    calories: Number(document.getElementById('new-calories').value) || 0,
    protein:  Number(document.getElementById('new-protein').value)  || 0,
    carbs:    Number(document.getElementById('new-carbs').value)    || 0,
    fat:      Number(document.getElementById('new-fat').value)      || 0,
    fiber:    Number(document.getElementById('new-fiber').value)    || 0,
    sugar:    Number(document.getElementById('new-sugar').value)    || 0,
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

function openModal(ing = null) {
  editingIngredient = ing;
  document.getElementById('modal-title').textContent  = ing ? 'EDIT INGREDIENT' : 'NEW INGREDIENT';
  document.getElementById('modal-confirm').textContent = ing ? 'SAVE' : 'ADD';
  document.getElementById('new-name').value     = ing ? ing.name     : '';
  document.getElementById('new-calories').value = ing ? ing.calories : '';
  document.getElementById('new-protein').value  = ing ? ing.protein  : '';
  document.getElementById('new-carbs').value    = ing ? ing.carbs    : '';
  document.getElementById('new-fat').value      = ing ? ing.fat      : '';
  document.getElementById('new-fiber').value    = ing ? ing.fiber    : '';
  document.getElementById('new-sugar').value    = ing ? ing.sugar    : '';
  document.getElementById('add-modal').style.display = 'flex';
  document.getElementById('new-name').focus();
}

function closeModal() {
  document.getElementById('add-modal').style.display = 'none';
  editingIngredient = null;
  ['new-name','new-calories','new-protein','new-carbs','new-fat','new-fiber','new-sugar']
    .forEach(id => { document.getElementById(id).value = ''; });
}

// ── HISTORY ────────────────────────────────────────────────────────────────
function initHistoryView() {
  const input = document.getElementById('history-date');
  if (!input.value) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toLocaleDateString('en-CA');
    input.max = yStr;
    input.value = yStr;
    loadHistory(yStr);
  }
}

async function loadHistory(date) {
  const content = document.getElementById('history-content');
  content.innerHTML = '<div class="loading-state">Loading</div>';

  try {
    const logs = await api.getLogs(date);

    if (!logs.length) {
      content.innerHTML = `<div class="empty-state">No meals logged on<br>${fmtDate(date)}</div>`;
      return;
    }

    const totals = sumMacros(logs);
    content.innerHTML =
      macroCardHTML(totals) +
      '<div class="chart-wrap"><canvas id="history-chart"></canvas></div>' +
      '<div id="history-meals"></div>';

    state.charts.history = renderPie('history-chart', totals, state.charts.history);
    renderMealGroups(logs, 'history-meals', false);
  } catch (e) {
    content.innerHTML = '<div class="empty-state">Failed to load.</div>';
  }
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
  document.getElementById('ingredient-search').addEventListener('input', e => renderPicker(e.target.value));
  document.getElementById('save-meal-btn').addEventListener('click', saveMeal);

  // Ingredients
  document.getElementById('ingredients-search').addEventListener('input', e => renderIngList(e.target.value));
  document.getElementById('add-ingredient-fab').addEventListener('click', openModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', saveIngredient);
  document.getElementById('modal-backdrop') && document.getElementById('modal-backdrop').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

  // History
  document.getElementById('history-date').addEventListener('change', e => { if (e.target.value) loadHistory(e.target.value); });

  // Load ingredients once, cache for session
  try {
    const ings = await api.getIngredients();
    state.ingredients = ings.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    toast('Could not load ingredients', 'error');
  }

  // Show today
  showView('today');
}

document.addEventListener('DOMContentLoaded', init);
