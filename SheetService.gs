/**
 * Generic header-mapped helpers so column order in the Sheet can change
 * without touching every function that reads/writes rows.
 */

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet not found: ' + name);
  }
  return sheet;
}

function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    map[headers[i]] = i;
  }
  return map;
}

/** Returns all data rows (excluding header) as plain objects keyed by header name. */
function getAllRowsAsObjects_(sheetName) {
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

/** Appends a row built from an object + header map, filling missing columns with ''. */
function appendRowFromObject_(sheetName, rowObject) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  var row = new Array(Object.keys(headerMap).length).fill('');
  Object.keys(headerMap).forEach(function (header) {
    if (rowObject.hasOwnProperty(header)) {
      row[headerMap[header]] = rowObject[header];
    }
  });
  sheet.appendRow(row);
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

/** Updates specific columns (by header name) on an existing row (1-indexed sheet row). */
function updateRowFields_(sheetName, rowIndex, fields) {
  var sheet = getSheet_(sheetName);
  var headerMap = getHeaderMap_(sheet);
  Object.keys(fields).forEach(function (header) {
    var col = headerMap[header];
    if (col === undefined) {
      throw new Error('Column not found: ' + header);
    }
    sheet.getRange(rowIndex, col + 1).setValue(fields[header]);
  });
}
