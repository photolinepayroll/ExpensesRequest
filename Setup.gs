/**
 * One-time setup helper. After creating a blank Google Sheet and setting
 * SPREADSHEET_ID in Config.gs, run setupSheets() once from the Apps Script
 * editor (select this function, click Run) to create the 3 tabs with
 * correct headers. Safe to re-run: it skips tabs that already exist, and
 * for existing tabs it appends any headers that are missing (e.g. after
 * the 3-stage approval columns were added) without touching existing data.
 */

function setupSheets() {
  var ss = getSpreadsheet_();

  createOrMigrateSheet_(ss, SHEET_EMPLOYEES,
    ['EmployeeID', 'Name', 'Department', 'Email', 'BaseLocation', 'Active']);

  createOrMigrateSheet_(ss, SHEET_REQUESTS,
    ['RequestID', 'EmployeeID', 'EmployeeName', 'DateSubmitted', 'Status', 'TotalAmount',
     'ApprovedBy', 'ApprovedDate',
     'ReviewedBy', 'ReviewedDate',
     'AuthorizedBy', 'AuthorizedDate', 'CreditingDate',
     'RejectedBy', 'RejectedDate',
     'Remarks']);

  createOrMigrateSheet_(ss, SHEET_REQUEST_LINES,
    ['LineID', 'RequestID', 'Date', 'Category', 'BaseLocation', 'Amount',
     'Description', 'ReceiptFileURL', 'GpsMapLink']);

  createOrMigrateSheet_(ss, SHEET_APPROVERS,
    ['UserID', 'Password', 'FullName', 'Role', 'Active', 'BiometricID']);

  createOrMigrateSheet_(ss, SHEET_MEAL_ALLOWANCES,
    ['RecordID', 'EmployeeID', 'EmployeeName', 'DutyDate', 'StartIn', 'EndOut', 'DutyHours',
     'RegularMealAllowance', 'MidnightAllowance', 'TotalAllowance', 'SubmittedDate', 'PhotoLink',
     'MatchedStore', 'City', 'Town', 'AreaRegion', 'AllowanceSource', 'EndGpsMapLink']);

  // Remove the default "Sheet1" if it's still empty and unused.
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
  }

  applyBaseLocationDropdown_();

  Logger.log('Setup complete.');
}

// Turns Employees.BaseLocation into a dropdown of real store names (sourced
// from the same store directory StoreDirectoryService.gs uses), so it can
// only ever be one of the exact spellings the approver-routing lookup
// expects — a free-text mismatch here (e.g. "SM Baliwag" vs "Baliwag") is
// what silently breaks Mother Branch display and Area Head-scoped approval
// for that employee. Safe to re-run: re-applying the same validation rule
// is a no-op. Existing rows with a value not in the list will show Sheets'
// invalid-data warning until manually corrected via the dropdown.
function applyBaseLocationDropdown_() {
  var rows = getStoreDirectoryRows_();
  if (!rows) {
    Logger.log('Could not fetch the store directory — skipped BaseLocation dropdown setup.');
    return;
  }

  var seen = {};
  var storeNames = [];
  rows.forEach(function (row) {
    var store = String(row[STORE_DIR_COL_STORE] || '').trim();
    if (store && !seen[store]) {
      seen[store] = true;
      storeNames.push(store);
    }
  });
  if (!storeNames.length) return;

  var sheet = getSheet_(SHEET_EMPLOYEES);
  var headerMap = getHeaderMap_(sheet);
  var col = headerMap['BaseLocation'];
  if (col === undefined) return;

  var numRows = Math.max(sheet.getMaxRows() - 1, 999);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(storeNames, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, col + 1, numRows, 1).setDataValidation(rule);

  Logger.log('Applied BaseLocation dropdown with ' + storeNames.length + ' stores.');
}

function createOrMigrateSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }

  var lastCol = sheet.getLastColumn();
  var existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var missingHeaders = headers.filter(function (h) { return existingHeaders.indexOf(h) === -1; });

  if (missingHeaders.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missingHeaders.length).setValues([missingHeaders]);
    sheet.getRange(1, lastCol + 1, 1, missingHeaders.length).setFontWeight('bold');
    Logger.log('Added missing columns to ' + name + ': ' + missingHeaders.join(', '));
  }

  return sheet;
}
