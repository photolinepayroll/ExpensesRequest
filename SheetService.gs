/**
 * Generic header-mapped helpers so column order in the Sheet can change
 * without touching every function that reads/writes rows.
 *
 * Spreadsheet/sheet objects and header maps are memoized in plain globals.
 * Apps Script gives every execution a fresh global scope, so this memo only
 * lives for one request and can never go stale across calls.
 */

var sheetMemo_ = { ss: null, sheets: {}, headers: {} };
var executionStartMs_ = new Date().getTime();

/** Clears the per-execution memo (call after changing headers within one run, e.g. setupSheets). */
function resetSheetMemo_() {
  sheetMemo_ = { ss: null, sheets: {}, headers: {} };
}

/** Logs elapsed ms since this execution started — for finding where time goes in the Executions log. */
function timeStep_(label) {
  Logger.log('[timing] ' + label + ' @ +' + (new Date().getTime() - executionStartMs_) + 'ms');
}

function getMemoSpreadsheet_() {
  if (!sheetMemo_.ss) {
    sheetMemo_.ss = getSpreadsheet_();
  }
  return sheetMemo_.ss;
}

function getSheet_(name) {
  if (sheetMemo_.sheets[name]) return sheetMemo_.sheets[name];
  var sheet = getMemoSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet not found: ' + name);
  }
  sheetMemo_.sheets[name] = sheet;
  return sheet;
}

function getHeaderMap_(sheet) {
  // Resolve the memo key by identity against sheets we already handed out (no extra API call).
  var key = null;
  Object.keys(sheetMemo_.sheets).forEach(function (n) {
    if (sheetMemo_.sheets[n] === sheet) key = n;
  });
  if (key === null) key = sheet.getName();
  if (sheetMemo_.headers[key]) return sheetMemo_.headers[key];
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    map[headers[i]] = i;
  }
  sheetMemo_.headers[key] = map;
  return map;
}

/**
 * Returns all data rows (excluding header) as plain objects keyed by header name.
 * Employees/Approvers/SubmissionExemptions are served from CacheLayer.gs; pass
 * { fresh: true } to force a direct sheet read. Everything else always reads directly.
 */
function getAllRowsAsObjects_(sheetName, opts) {
  if (!(opts && opts.fresh) && cacheableSheetTtls_()[sheetName]) {
    return getCachedRows_(sheetName, function () { return readAllRowsAsObjects_(sheetName); });
  }
  return readAllRowsAsObjects_(sheetName);
}

function readAllRowsAsObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (header, i) {
      obj[header] = row[i];
    });
    return obj;
  });
}

/** Builds a full-width row array from an object + header map, filling missing columns with ''. */
function buildRowArray_(headerMap, rowObject) {
  var row = new Array(Object.keys(headerMap).length).fill('');
  Object.keys(headerMap).forEach(function (header) {
    if (rowObject.hasOwnProperty(header)) {
      row[headerMap[header]] = rowObject[header];
    }
  });
  return row;
}

/** Appends a row built from an object + header map, filling missing columns with ''. */
function appendRowFromObject_(sheetName, rowObject) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  sheet.appendRow(buildRowArray_(headerMap, rowObject));
  invalidateSheetCache_(sheetName);
}

/** Appends many rows in one write (one setValues instead of N appendRow calls). */
function appendRowsFromObjects_(sheetName, rowObjects) {
  if (!rowObjects || rowObjects.length === 0) return;
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  var rows = rowObjects.map(function (obj) {
    return buildRowArray_(headerMap, obj);
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  invalidateSheetCache_(sheetName);
}

/** Finds the 1-indexed sheet row number for a given ID column/value, or -1 if not found. */
function findRowIndexById_(sheetName, idColumnName, idValue) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  var idCol = headerMap[idColumnName];
  if (idCol === undefined) {
    throw new Error('Column not found: ' + idColumnName);
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idValue)) {
      return i + 2; // +2: 1-indexed and header row offset
    }
  }
  return -1;
}

/** Reads one whole row (1-indexed sheet row) as an object keyed by header — one API read instead of one per cell. */
function getRowObject_(sheetName, rowIndex) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  var width = Object.keys(headerMap).length;
  var values = sheet.getRange(rowIndex, 1, 1, width).getValues()[0];
  var obj = {};
  Object.keys(headerMap).forEach(function (header) {
    obj[header] = values[headerMap[header]];
  });
  return obj;
}

/**
 * Updates specific columns (by header name) on an existing row (1-indexed sheet row).
 * Contiguous changed columns go out as one setValues; untouched cells in between are never
 * rewritten (so e.g. text IDs can't get re-parsed as numbers).
 */
function updateRowFields_(sheetName, rowIndex, fields) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  var cols = Object.keys(fields).map(function (header) {
    var col = headerMap[header];
    if (col === undefined) {
      throw new Error('Column not found: ' + header);
    }
    return { col: col, value: fields[header] };
  });
  cols.sort(function (a, b) { return a.col - b.col; });

  var i = 0;
  while (i < cols.length) {
    var j = i;
    while (j + 1 < cols.length && cols[j + 1].col === cols[j].col + 1) j++;
    var run = cols.slice(i, j + 1).map(function (c) { return c.value; });
    sheet.getRange(rowIndex, cols[i].col + 1, 1, run.length).setValues([run]);
    i = j + 1;
  }
  invalidateSheetCache_(sheetName);
}
