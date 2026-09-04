// ============================================================
// CALORIE TRACKER — Google Apps Script Backend
// ============================================================
// SETUP INSTRUCTIONS:
// 1. Open your CalorieTracker Google Sheet
// 2. Extensions → Apps Script
// 3. Delete the default myFunction() code
// 4. Paste this entire file
// 5. Save (Ctrl+S), name the project "CalorieTrackerAPI"
// 6. Run populateStarterData() once to seed the Ingredients sheet
// 7. Deploy → New deployment → Web App
//    - Execute as: Me
//    - Who has access: Anyone
// 8. Copy the Web App URL → paste into your config.js
// ============================================================

function doGet(e) {
  try {
    const action = e.parameter.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sc = CacheService.getScriptCache();

    if (action === 'getIngredients') {
      const cached = sc.get('ingredients');
      if (cached) return jsonResponse({ success: true, data: JSON.parse(cached) });
      const data = getSheetRows(ss, 'Ingredients');
      sc.put('ingredients', JSON.stringify(data), 600); // 10 min
      return jsonResponse({ success: true, data });
    }

    if (action === 'getLogs') {
      const date = e.parameter.date;
      const key = 'logs_' + date;
      const cached = sc.get(key);
      if (cached) return jsonResponse({ success: true, data: JSON.parse(cached) });
      const all = getSheetRows(ss, 'Logs');
      const filtered = all.filter(r => r.date === date);
      sc.put(key, JSON.stringify(filtered), 300); // 5 min
      return jsonResponse({ success: true, data: filtered });
    }

    if (action === 'getLogsRange') {
      const from = e.parameter.from;
      const to = e.parameter.to;
      const all = getSheetRows(ss, 'Logs');
      const filtered = all.filter(r => r.date >= from && r.date <= to);
      // Aggregate by date to keep response small (raw rows exceed URL limit)
      const byDate = {};
      filtered.forEach(r => {
        if (!byDate[r.date]) byDate[r.date] = { date: r.date, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
        byDate[r.date].calories += Number(r.calories);
        byDate[r.date].protein  += Number(r.protein);
        byDate[r.date].carbs    += Number(r.carbs);
        byDate[r.date].fat      += Number(r.fat);
        byDate[r.date].fiber    += Number(r.fiber);
      });
      return jsonResponse({ success: true, data: Object.values(byDate) });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sc = CacheService.getScriptCache();

    if (body.action === 'addIngredient') {
      const sheet = ss.getSheetByName('Ingredients');
      const id = Utilities.getUuid();
      const now = new Date().toISOString();
      const unit = body.unit || 'g';
      sheet.appendRow([
        id, body.name, body.calories, body.protein,
        body.carbs, body.fat, body.fiber, body.sugar, now, unit
      ]);
      sc.remove('ingredients');
      return jsonResponse({
        success: true,
        data: {
          id, name: body.name, calories: body.calories, protein: body.protein,
          carbs: body.carbs, fat: body.fat, fiber: body.fiber, sugar: body.sugar,
          unit, createdAt: now
        }
      });
    }

    if (body.action === 'addMealEntries') {
      const sheet = ss.getSheetByName('Logs');
      const now = new Date().toISOString();
      const ids = body.entries.map(entry => {
        const id = Utilities.getUuid();
        sheet.appendRow([
          id, entry.date, entry.mealName, entry.ingredientId, entry.ingredientName,
          entry.grams, entry.calories, entry.protein, entry.carbs,
          entry.fat, entry.fiber, entry.sugar, now
        ]);
        return id;
      });
      const dates = [...new Set(body.entries.map(en => en.date))];
      sc.removeAll(dates.map(d => 'logs_' + d));
      return jsonResponse({ success: true, ids });
    }

    if (body.action === 'deleteLog') {
      const sheet = ss.getSheetByName('Logs');
      const data = sheet.getDataRange().getValues();
      const idCol = data[0].indexOf('id');
      for (let i = 1; i < data.length; i++) {
        if (data[i][idCol] === body.id) {
          sheet.deleteRow(i + 1);
          if (body.date) sc.remove('logs_' + body.date);
          return jsonResponse({ success: true });
        }
      }
      return jsonResponse({ success: false, error: 'Row not found' });
    }

    if (body.action === 'updateIngredient') {
      const sheet = ss.getSheetByName('Ingredients');
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idCol = headers.indexOf('id');
      for (let i = 1; i < data.length; i++) {
        if (data[i][idCol] === body.id) {
          const r = i + 1;
          ['name','calories','protein','carbs','fat','fiber','sugar','unit'].forEach(field => {
            const col = headers.indexOf(field);
            if (col !== -1) sheet.getRange(r, col + 1).setValue(body[field] !== undefined ? body[field] : '');
          });
          sc.remove('ingredients');
          return jsonResponse({ success: true });
        }
      }
      return jsonResponse({ success: false, error: 'Ingredient not found' });
    }

    if (body.action === 'deleteIngredient') {
      const sheet = ss.getSheetByName('Ingredients');
      const data = sheet.getDataRange().getValues();
      const idCol = data[0].indexOf('id');
      for (let i = 1; i < data.length; i++) {
        if (data[i][idCol] === body.id) {
          sheet.deleteRow(i + 1);
          sc.remove('ingredients');
          return jsonResponse({ success: true });
        }
      }
      return jsonResponse({ success: false, error: 'Ingredient not found' });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ---- Helpers ----

function getSheetRows(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  const range = sheet.getDataRange();
  const data = range.getDisplayValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1)
    .filter(row => row[0])
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- Run this ONCE to add the 'unit' column to an existing Ingredients sheet ----

function addUnitColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Ingredients');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  if (headers.includes('unit')) {
    Logger.log('unit column already exists — nothing to do.');
    return;
  }

  const lastCol = headers.length + 1;
  sheet.getRange(1, lastCol).setValue('unit');
  for (let i = 2; i <= data.length; i++) {
    sheet.getRange(i, lastCol).setValue('g');
  }
  Logger.log('unit column added. All existing ingredients set to g.');
}

// ---- Run this ONCE from the Apps Script editor to seed starter ingredients ----

function populateStarterData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let ingSheet = ss.getSheetByName('Ingredients');
  if (!ingSheet) ingSheet = ss.insertSheet('Ingredients');
  ingSheet.clearContents();
  ingSheet.appendRow(['id', 'name', 'calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'createdAt', 'unit']);

  let logSheet = ss.getSheetByName('Logs');
  if (!logSheet) logSheet = ss.insertSheet('Logs');
  logSheet.clearContents();
  logSheet.appendRow([
    'id', 'date', 'mealName', 'ingredientId', 'ingredientName',
    'grams', 'calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'loggedAt'
  ]);

  const starters = [
    ['Chicken Breast',      165, 31,   0,    3.6,  0,    0   ],
    ['Brown Rice (cooked)', 123, 2.7,  25.6, 1,    1.8,  0.4 ],
    ['Whole Egg',           155, 13,   1.1,  11,   0,    1.1 ],
    ['Olive Oil',           884, 0,    0,    100,  0,    0   ],
    ['Oats (dry)',          389, 17,   66,   7,    11,   1   ],
    ['Banana',              89,  1.1,  23,   0.3,  2.6,  12  ],
    ['Greek Yogurt (plain)', 59, 10,   3.6,  0.4,  0,    3.6 ],
    ['Almonds',             579, 21,   22,   50,   12.5, 4.4 ],
    ['Broccoli',            34,  2.8,  7,    0.4,  2.6,  1.7 ],
    ['Salmon',              208, 20,   0,    13,   0,    0   ],
  ];

  const now = new Date().toISOString();
  starters.forEach(([name, cal, p, c, f, fiber, sugar]) => {
    ingSheet.appendRow([Utilities.getUuid(), name, cal, p, c, f, fiber, sugar, now, 'g']);
  });

  Logger.log('Starter data populated successfully.');
}
