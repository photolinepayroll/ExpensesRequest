/**
 * Server-side authoritative lookup of an employee's category (Area Head,
 * Technical, Audit, or plain Staff) and the Biometric ID of who must approve
 * their Pending requests — resolved from an external published directory
 * sheet (STORE_DIRECTORY_CSV_URL, Config.gs), not from anything the client
 * sends. Mirrored client-side (frontend/employee.js) for the Mother
 * Branch display / Utilities tab visibility, but that copy is UX only —
 * this file is what RequestService.gs's advanceRequestStage actually
 * enforces against.
 *
 * The directory sheet mixes several tables and has duplicate/blank headers,
 * so rows are read by fixed column index (0-indexed), not by header name:
 *   9/10  - fixed, constant on every row: Jayriel's Biometric ID/name
 *   11/12 - a per-store "Area Head" column pair — DO NOT USE, see warning below
 *   14/15 - fixed, constant: Cris Taglucop's Biometric ID/name (Technical)
 *   16    - this store's assigned Technical staff's Biometric ID
 *   19/20 - fixed, constant: Lanilyn Balane's Biometric ID/name (Audit)
 *   21    - this store's assigned Audit staff's Biometric ID
 *   24/25 - this store's ACTUAL Area Head Biometric ID/name (see below)
 *   26    - store name
 *   28/29 - fixed, constant: the shared "ADMIN" approver's Biometric ID/name
 *           (Biometric ID 9999 — a generic admin account, not a named person)
 *   30/31 - a listed Head Office employee's Biometric ID/name (one row per
 *           HO employee, unlike the single-per-store Tech/Audit columns)
 *
 * IMPORTANT — confirmed via real data (SM Cebu case, 2026-09-09): columns
 * 11/12 are NOT row-aligned with column 26 (STORES) — that whole first
 * "ARE HEAD" block is offset by one row relative to the rest of the sheet
 * (e.g. Arca South's column-11 value actually belongs to Ayala Bacolod), and
 * is blank outright for 101 of 118 stores. Columns 24/25 ("BIO ID"/
 * "APPROVERS", immediately followed by STORES at 26) are the reliable,
 * correctly-aligned trio and are what this file actually uses for Area Head
 * lookups. Column 11/12 are listed above only so a future reader doesn't
 * reintroduce them by assuming the obvious-looking pair is the right one —
 * if the source sheet ever gets its row alignment fixed, this whole note
 * (and the dead 11/12 columns) can be removed.
 */

var STORE_DIR_COL_JAYRIEL_BIO = 9;
var STORE_DIR_COL_JAYRIEL_NAME = 10;
var STORE_DIR_COL_CRIS_BIO = 14;
var STORE_DIR_COL_CRIS_NAME = 15;
var STORE_DIR_COL_TECH_BIO = 16;
var STORE_DIR_COL_LANILYN_BIO = 19;
var STORE_DIR_COL_LANILYN_NAME = 20;
var STORE_DIR_COL_AUDIT_BIO = 21;
var STORE_DIR_COL_AREHEAD_BIO = 24;
var STORE_DIR_COL_AREHEAD_NAME = 25;
var STORE_DIR_COL_STORE = 26;
var STORE_DIR_COL_ADMIN_BIO = 28;
var STORE_DIR_COL_ADMIN_NAME = 29;
var STORE_DIR_COL_HO_BIO = 30;

var STORE_DIRECTORY_CACHE_KEY = 'storeDirectoryRows';
var STORE_DIRECTORY_CACHE_SECONDS = 300; // 5 min — this sits in the approval hot path

// Returns the directory's data rows (header row stripped) as a 2D array, or
// null if the sheet couldn't be fetched/parsed — callers must treat null the
// same as "nothing found" and fall back gracefully, not throw.
function getStoreDirectoryRows_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(STORE_DIRECTORY_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // fall through and re-fetch
    }
  }

  try {
    var response = UrlFetchApp.fetch(STORE_DIRECTORY_CSV_URL, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('Store directory fetch returned HTTP ' + response.getResponseCode() + '. Body preview: ' + response.getContentText().substring(0, 200));
      return null;
    }
    var rows = Utilities.parseCsv(response.getContentText()).slice(1); // drop header row
    cache.put(STORE_DIRECTORY_CACHE_KEY, JSON.stringify(rows), STORE_DIRECTORY_CACHE_SECONDS);
    return rows;
  } catch (e) {
    Logger.log('Store directory fetch threw: ' + e.message);
    return null;
  }
}

// Department is a broader signal than the per-store directory — that sheet
// only lists ONE named Tech and ONE named Auditor per store, but many more
// employees can carry a Technical/Audit Department code without being that
// one specific per-store assignee. Matches loosely (substring, not exact) to
// tolerate both abbreviations ("TEC", "Aud") and full words ("Technical",
// "Auditing") already seen in real Employees data.
function isTechnicalDepartment_(department) {
  var d = String(department || '').trim().toLowerCase();
  return d === 'tec' || d.indexOf('tech') !== -1;
}
function isAuditDepartment_(department) {
  var d = String(department || '').trim().toLowerCase();
  return d === 'aud' || d.indexOf('audit') !== -1;
}

// { category: 'AreaHead'|'Technical'|'Audit'|'HeadOffice'|'Staff', store } —
// store is only set when found via the per-store directory listing (Staff,
// HeadOffice, and Technical/Audit resolved only via Department, aren't tied
// to one specific store; their Mother Branch comes from their own
// Employees.BaseLocation, except HeadOffice which is just labeled as such).
function resolveEmployeeCategory_(rows, employeeId, department) {
  var id = String(employeeId || '').trim().toLowerCase();

  function findByColumn(bioCol) {
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][bioCol] || '').trim().toLowerCase() === id) return rows[i];
    }
    return null;
  }

  var areHeadRow = findByColumn(STORE_DIR_COL_AREHEAD_BIO);
  if (areHeadRow) return { category: 'AreaHead', store: areHeadRow[STORE_DIR_COL_STORE] };

  var techRow = findByColumn(STORE_DIR_COL_TECH_BIO);
  if (techRow) return { category: 'Technical', store: techRow[STORE_DIR_COL_STORE] };

  var auditRow = findByColumn(STORE_DIR_COL_AUDIT_BIO);
  if (auditRow) return { category: 'Audit', store: auditRow[STORE_DIR_COL_STORE] };

  var hoRow = findByColumn(STORE_DIR_COL_HO_BIO);
  if (hoRow) return { category: 'HeadOffice', store: 'Head Office' };

  if (isTechnicalDepartment_(department)) return { category: 'Technical', store: null };
  if (isAuditDepartment_(department)) return { category: 'Audit', store: null };

  return { category: 'Staff', store: null };
}

function findStoreRowByName_(rows, locationText) {
  var loc = String(locationText || '').trim().toLowerCase();
  if (!loc) return null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][STORE_DIR_COL_STORE] || '').trim().toLowerCase() === loc) return rows[i];
  }
  return null;
}

// Resolves who must approve a Pending request from this employee.
// { found: false } means "couldn't determine" (directory unreachable, or a
// Staff employee whose location can't be matched to any listed store) — the
// caller (RequestService.gs) treats that as "fall back to the unscoped
// Approver-role check", never as "block the approval".
//
// requestLineLocation is the Base Location typed/selected on the request's
// own first line item — for Staff, this takes priority over their static
// Employees.BaseLocation, since a store employee's expense doesn't always
// happen at their usual home branch (e.g. covering a different store that
// day). BaseLocation is only a fallback when the line item's location is
// blank or doesn't match any listed store.
function resolveRequiredApprover_(employeeId, employeeBaseLocation, employeeDepartment, requestLineLocation) {
  var rows = getStoreDirectoryRows_();
  if (!rows) return { found: false };

  var result = resolveEmployeeCategory_(rows, employeeId, employeeDepartment);

  if (result.category === 'AreaHead') {
    return { found: true, bioId: rows[0][STORE_DIR_COL_JAYRIEL_BIO], name: rows[0][STORE_DIR_COL_JAYRIEL_NAME] };
  }
  if (result.category === 'Technical') {
    return { found: true, bioId: rows[0][STORE_DIR_COL_CRIS_BIO], name: rows[0][STORE_DIR_COL_CRIS_NAME] };
  }
  if (result.category === 'Audit') {
    return { found: true, bioId: rows[0][STORE_DIR_COL_LANILYN_BIO], name: rows[0][STORE_DIR_COL_LANILYN_NAME] };
  }
  if (result.category === 'HeadOffice') {
    return { found: true, bioId: rows[0][STORE_DIR_COL_ADMIN_BIO], name: rows[0][STORE_DIR_COL_ADMIN_NAME] };
  }

  // Staff: route to the Area Head of the store this request is actually
  // for (line-item location first, employee's home BaseLocation as fallback).
  var storeRow = findStoreRowByName_(rows, requestLineLocation) || findStoreRowByName_(rows, employeeBaseLocation);
  if (!storeRow) return { found: false };
  return { found: true, bioId: storeRow[STORE_DIR_COL_AREHEAD_BIO], name: storeRow[STORE_DIR_COL_AREHEAD_NAME] };
}
