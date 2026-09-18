// Shared state & utilities (used by employee.js and admin.js)

var currentEmployee = null; // { EmployeeID, Name, Department, BaseLocation }

// sessionStorage keys — survive a refresh but clear when the tab/browser closes.
var SESSION_KEY_EMPLOYEE = 'expenseApp_employee';
var SESSION_KEY_APPROVER = 'expenseApp_approver';

function $(id) { return document.getElementById(id); }

function showEl(el) { el.classList.remove('hidden'); }
function hideEl(el) { el.classList.add('hidden'); }

var MSG_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
var MSG_ICON_SUCCESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';

function setMessage(el, text, isError) {
  el.innerHTML = (isError ? MSG_ICON_ERROR : MSG_ICON_SUCCESS) + '<span>' + text + '</span>';
  el.className = 'msg ' + (isError ? 'msg-error' : 'msg-success');
  showEl(el);
}

function clearMessage(el) {
  hideEl(el);
  el.textContent = '';
}

var ESCAPE_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ESCAPE_HTML_MAP[c]; });
}

function formatCurrency(n) {
  var num = Number(n) || 0;
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateDisplay(value) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

// True once today's calendar date is strictly after the given CreditingDate
// (the CreditingDate itself still counts as "not yet past") — used to hide
// a Disbursed request from the employee's own My Requests view the day
// after its disbursement, once the cycle is finished. Compares calendar
// dates only, in local time, ignoring time-of-day on either side.
function isPastCreditingDate_(creditingDateStr) {
  var crediting = new Date(creditingDateStr);
  var creditingMidnight = new Date(crediting.getFullYear(), crediting.getMonth(), crediting.getDate());
  var todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  return todayMidnight > creditingMidnight;
}

// Used by the Verifier's Submission Exemption panel and the employee-side
// exemption banner to show a plain clock time ("2:45 PM"), not a full date —
// an exemption only ever lasts 1 hour so the date itself is never in question.
function formatTimeDisplay(value) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Renders a single date, or (when a cut-off end date is present, i.e. a
// Timesheet line) a "start – end" range. Shared by buildLineItemsHtml_, the
// receipt modal, and admin.js's CSV/print-report builders.
function formatLineDateDisplay_(line) {
  if (line.CutoffEndDate) {
    return formatDateDisplay(line.Date) + ' – ' + formatDateDisplay(line.CutoffEndDate);
  }
  return formatDateDisplay(line.Date);
}

// Timesheet lines' Amount is always 0 and isn't a real reimbursable figure.
function formatLineAmountDisplay_(line) {
  return line.Category === 'Timesheet' ? '—' : formatCurrency(line.Amount);
}

var STATUS_BADGE_CLASSES = {
  Pending: 'badge-pending',
  Reviewed: 'badge-reviewed',
  Approved: 'badge-approved',
  Authorized: 'badge-authorized',
  Rejected: 'badge-rejected'
};

// Display wording only — the underlying Status value stored/sent is still
// "Authorized" (matches RequestService.gs's STAGE_ORDER); this just renders
// the terminal stage as "Disbursed" to users.
var STATUS_DISPLAY_LABELS = {
  Authorized: 'Disbursed'
};

function statusBadge(status) {
  var cls = STATUS_BADGE_CLASSES[status] || 'badge-pending';
  var label = STATUS_DISPLAY_LABELS[status] || status;
  return '<span class="badge ' + cls + '">' + escapeHtml_(label) + '</span>';
}

/** Renders a request list (used by both My Requests and Admin views) into a table with expandable rows. */
function renderRequestsTable(container, requests, options) {
  options = options || {};
  if (!requests.length) {
    container.innerHTML = '<div class="state-message">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12h6m-6 4h6M9 8h6M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"></path></svg>' +
      '<p>No requests found.</p></div>';
    return;
  }

  var showEmployee = !!options.showEmployee;
  var selectable = !!options.selectable;
  var colCount = showEmployee ? 6 : 5;
  if (selectable) colCount += 1;
  var html = '<div class="table-scroll"><table class="data-table"><thead><tr>';
  if (selectable) html += '<th class="select-col"><input type="checkbox" id="select-all-requests" aria-label="Select all"></th>';
  html += '<th>Request ID</th><th>Date</th>';
  if (showEmployee) html += '<th>Employee</th>';
  html += '<th>Total</th><th>Status</th><th>Crediting Date</th></tr></thead><tbody>';

  requests.forEach(function (req, idx) {
    html += '<tr class="request-row" data-idx="' + idx + '" tabindex="0" role="button" aria-expanded="false">';
    if (selectable) {
      html += '<td class="select-col" data-label="Select"><input type="checkbox" class="row-select" data-request-id="' + escapeHtml_(req.RequestID) + '" aria-label="Select request ' + escapeHtml_(req.RequestID) + '"></td>';
    }
    html += '<td data-label="Request ID">' + escapeHtml_(req.RequestID) + '</td>';
    html += '<td data-label="Date">' + formatDateDisplay(req.DateSubmitted) + '</td>';
    if (showEmployee) html += '<td data-label="Employee">' + escapeHtml_(req.EmployeeName) + ' (' + escapeHtml_(req.EmployeeID) + ')</td>';
    html += '<td data-label="Total">' + formatCurrency(req.TotalAmount) + '</td>';
    html += '<td data-label="Status">' + statusBadge(req.Status) + '</td>';
    html += '<td data-label="Crediting Date">' + (req.CreditingDate ? formatDateDisplay(req.CreditingDate) : '<span class="muted">—</span>') + '</td>';
    html += '</tr>';
    html += '<tr class="detail-row hidden" data-detail-idx="' + idx + '"><td colspan="' + colCount + '">';
    html += '<div class="detail-panel" id="detail-panel-' + idx + '"></div>';
    html += '</td></tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;

  if (selectable) {
    var selectAllEl = container.querySelector('#select-all-requests');
    var rowCheckboxes = container.querySelectorAll('.row-select');

    function currentSelectedIds() {
      var ids = [];
      rowCheckboxes.forEach(function (cb) { if (cb.checked) ids.push(cb.getAttribute('data-request-id')); });
      return ids;
    }

    function fireSelectionChange() {
      if (options.onSelectionChange) options.onSelectionChange(currentSelectedIds());
    }

    rowCheckboxes.forEach(function (cb) {
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        if (!cb.checked) selectAllEl.checked = false;
        else if (currentSelectedIds().length === rowCheckboxes.length) selectAllEl.checked = true;
        fireSelectionChange();
      });
    });

    selectAllEl.addEventListener('click', function (e) { e.stopPropagation(); });
    selectAllEl.addEventListener('change', function () {
      rowCheckboxes.forEach(function (cb) { cb.checked = selectAllEl.checked; });
      fireSelectionChange();
    });
  }

  function toggleRow(row) {
    var idx = row.getAttribute('data-idx');
    var detailRow = container.querySelector('[data-detail-idx="' + idx + '"]');
    var isHidden = detailRow.classList.contains('hidden');
    container.querySelectorAll('.detail-row').forEach(function (r) { r.classList.add('hidden'); });
    container.querySelectorAll('.request-row').forEach(function (r) { r.setAttribute('aria-expanded', 'false'); });
    if (isHidden) {
      detailRow.classList.remove('hidden');
      row.setAttribute('aria-expanded', 'true');
      // Scoped to this table's own container, not a global getElementById lookup —
      // admin.html keeps two tables (queue + history) in the DOM at once, each
      // numbering its own detail panels from 0, so a global id lookup here would
      // silently write into the wrong (other tab's, hidden) panel.
      var panel = container.querySelector('#detail-panel-' + idx);
      if (!panel.dataset.rendered) {
        panel.innerHTML = buildLineItemsHtml_(requests[idx]);
        panel.dataset.rendered = '1';
        wireLineItemRows_(panel, requests[idx], options);
        if (options.onDetailRendered) options.onDetailRendered(panel, requests[idx]);
      }
    }
  }

  container.querySelectorAll('.request-row').forEach(function (row) {
    row.addEventListener('click', function () { toggleRow(row); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRow(row);
      }
    });
  });
}

function buildLineItemsHtml_(request) {
  var html = '<table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Location</th><th>Amount</th><th>Description</th><th>Receipt</th></tr></thead><tbody>';
  request.lines.forEach(function (line) {
    var isTimesheet = line.Category === 'Timesheet';
    html += '<tr class="line-detail-row" data-line-id="' + escapeHtml_(line.LineID) + '" tabindex="0" role="button">';
    html += '<td data-label="Date">' + formatLineDateDisplay_(line) + '</td>';
    html += '<td data-label="Category">' + escapeHtml_(line.Category) + '</td>';
    html += '<td data-label="Location">' + (isTimesheet ? '<span class="muted">—</span>' : escapeHtml_(line.BaseLocation)) + '</td>';
    html += '<td data-label="Amount">' + formatLineAmountDisplay_(line) + '</td>';
    html += '<td data-label="Description">' + (isTimesheet ? '<span class="muted">—</span>' : escapeHtml_(line.Description)) + '</td>';
    html += '<td data-label="Receipt">' + (line.ReceiptFileURL
      ? '<span class="link-inline">View</span>'
      : '<span class="muted">None</span>') + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += buildAuditTrailHtml_(request);
  return html;
}

// Opens the shared receipt/detail preview for whichever line item's row was
// clicked. `options` is the same object passed into renderRequestsTable:
// options.isLineEditable(request) -> bool decides whether Amount is editable
// (admin.js only; My Requests never passes it, so it stays view-only), and
// options.onSaveAmount(request, line, newAmount) -> Promise performs the save.
function wireLineItemRows_(panel, request, options) {
  function computeLineOptions(line) {
    var editable = !!(options.isLineEditable && options.isLineEditable(request) && options.onSaveAmount);
    return {
      editable: editable,
      onSaveAmount: (editable && options.onSaveAmount)
        ? function (newAmount) { return options.onSaveAmount(request, line, newAmount); }
        : null
    };
  }

  function openFor(row) {
    var lineId = row.getAttribute('data-line-id');
    var index = -1;
    request.lines.forEach(function (l, i) {
      if (String(l.LineID) === String(lineId)) index = i;
    });
    if (index === -1) return;
    openLineItemPreviewWithNav_(request.lines, index, computeLineOptions);
  }

  panel.querySelectorAll('tr.line-detail-row').forEach(function (row) {
    row.addEventListener('click', function () { openFor(row); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFor(row);
      }
    });
  });
}

// Checkpoints in display order, each naming the By/Date fields the backend fills in
// as a request advances (see RequestService.gs's STAGE_FIELD_NAMES).
var AUDIT_TRAIL_STAGES = [
  { label: 'Approved', by: 'ApprovedBy', date: 'ApprovedDate' },
  { label: 'Reviewed', by: 'ReviewedBy', date: 'ReviewedDate' },
  { label: 'Disbursed', by: 'AuthorizedBy', date: 'AuthorizedDate', creditingDate: 'CreditingDate' },
  { label: 'Rejected', by: 'RejectedBy', date: 'RejectedDate' }
];

function buildAuditTrailHtml_(request) {
  var completedStages = AUDIT_TRAIL_STAGES.filter(function (stage) {
    return request[stage.date];
  });

  if (!completedStages.length) return '';

  var html = '<ul class="audit-trail">';
  completedStages.forEach(function (stage) {
    html += '<li><strong>' + stage.label + '</strong> by ' + escapeHtml_(request[stage.by]) +
      ' on ' + formatDateDisplay(request[stage.date]);
    if (stage.creditingDate && request[stage.creditingDate]) {
      html += ' — crediting on ' + formatDateDisplay(request[stage.creditingDate]);
    }
    html += '</li>';
  });
  html += '</ul>';

  if (request.Remarks) {
    html += '<p class="muted audit-remarks">' + escapeHtml_(request.Remarks).replace(/\n/g, '<br>') + '</p>';
  }

  return html;
}

// Minimal quoted-CSV parser (handles embedded commas and "" escaped quotes),
// shared by any feature that fetches a published Google Sheet as CSV
// client-side (meal-allowance.js, employee.js's Mother Branch lookup).
function parseCsv_(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;

  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip, \n (if present) ends the row below
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Converts parsed CSV rows (array of arrays) into header-keyed objects,
// using row 0 as headers. NOTE: not safe for a CSV with duplicate/blank
// headers (later columns silently overwrite earlier ones with the same
// key) — for a sheet like that, work with the raw parseCsv_ rows directly
// and index by column number instead (see employee.js's Mother Branch lookup).
function csvToObjects_(rows) {
  if (!rows.length) return [];
  var headers = rows[0];
  return rows.slice(1)
    .filter(function (r) { return r.length > 1 || (r[0] && r[0].trim() !== ''); })
    .map(function (r) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
}

// STORE_COORDINATES_CSV_URL's real header row (confirmed via a live fetch)
// has had duplicate column names added onto it twice now. Round 1 (already
// fixed): "Store", "BIO ID", and "REGULAR (AUDIT/TEC/STAFF)" all appeared
// twice — once for the per-store data near the front of the row, and again
// at columns 21/22 for an unrelated "Technical Staff Roster" sub-table
// crammed into the same sheet — which silently broke the regional-bracket
// amount (always ₱0) and BIO ID membership matches. Round 2 (this fix): a
// new "Senior Head" bracket sub-table was appended at columns 24-27, and it
// happens to reuse the header names "Area/Region" (also column 17) and
// "Meal Allowance" (also column 5) — so those two also started silently
// resolving to the *new* sub-table's mostly-blank values (113 of 119 rows
// blank) instead of the real per-store ones, breaking the on-screen
// "Location" display and the Tech-role personal override amount. All four
// affected fields are restored by fixed column index below — re-verify
// these indices if the sheet's layout ever changes; "Store" also duplicates
// (columns 0 and 10) but both copies hold the same value in practice, so
// it's left as-is.
var STORE_COORD_COL_REGULAR_BRACKET = 2;
var STORE_COORD_COL_TECH_BIO = 3;
var STORE_COORD_COL_TECH_AMOUNT = 5;
var STORE_COORD_COL_AREA_REGION = 17;

// Senior Head bracket (columns 24-27): a per-person, per-region rate table
// — e.g. BIO 783 gets ₱200 in most regions but ₱100 in NCR AREA — distinct
// from both the flat per-store regional bracket and the existing per-store
// Tech/Area Head proximity override. Stored under keys that don't collide
// with any header name, so a future duplicate elsewhere in the sheet can't
// silently break this the same way. Most rows have these blank; only the
// rows that actually carry the bracket table populate them.
var STORE_COORD_COL_SENIOR_HEAD_BIO = 24;
var STORE_COORD_COL_SENIOR_HEAD_NAME = 25;
var STORE_COORD_COL_SENIOR_HEAD_REGION = 26;
var STORE_COORD_COL_SENIOR_HEAD_AMOUNT = 27;

function parseStoreCoordinatesCsv_(text) {
  var rows = parseCsv_(text);
  var headers = rows[0];
  return rows.slice(1)
    .filter(function (r) { return r.length > 1 || (r[0] && r[0].trim() !== ''); })
    .map(function (r) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = r[i] !== undefined ? r[i] : ''; });
      obj['REGULAR (AUDIT/TEC/STAFF)'] = r[STORE_COORD_COL_REGULAR_BRACKET] !== undefined ? r[STORE_COORD_COL_REGULAR_BRACKET] : '';
      obj['BIO ID'] = r[STORE_COORD_COL_TECH_BIO] !== undefined ? r[STORE_COORD_COL_TECH_BIO] : '';
      obj['Meal Allowance'] = r[STORE_COORD_COL_TECH_AMOUNT] !== undefined ? r[STORE_COORD_COL_TECH_AMOUNT] : '';
      obj['Area/Region'] = r[STORE_COORD_COL_AREA_REGION] !== undefined ? r[STORE_COORD_COL_AREA_REGION] : '';
      obj['SeniorHeadBioId'] = r[STORE_COORD_COL_SENIOR_HEAD_BIO] !== undefined ? r[STORE_COORD_COL_SENIOR_HEAD_BIO] : '';
      obj['SeniorHeadName'] = r[STORE_COORD_COL_SENIOR_HEAD_NAME] !== undefined ? r[STORE_COORD_COL_SENIOR_HEAD_NAME] : '';
      obj['SeniorHeadRegion'] = r[STORE_COORD_COL_SENIOR_HEAD_REGION] !== undefined ? r[STORE_COORD_COL_SENIOR_HEAD_REGION] : '';
      obj['SeniorHeadAmount'] = r[STORE_COORD_COL_SENIOR_HEAD_AMOUNT] !== undefined ? r[STORE_COORD_COL_SENIOR_HEAD_AMOUNT] : '';
      return obj;
    });
}

// Scans all parsed store-coordinate rows for the Senior Head bracket
// sub-table (see column comment above) and builds a
// { [bioId-lowercase]: { [region-trimmed-uppercase]: amount } } lookup.
// Data-driven — picks up any future person/region added as a new row with
// no code change, since most rows simply have blank Senior Head fields.
function buildSeniorHeadBracket_(storeRows) {
  var bracket = {};
  (storeRows || []).forEach(function (row) {
    var bioId = String(row['SeniorHeadBioId'] || '').trim().toLowerCase();
    var region = String(row['SeniorHeadRegion'] || '').trim().toUpperCase();
    var amount = Number(row['SeniorHeadAmount']);
    if (!bioId || !region || !isFinite(amount)) return;
    if (!bracket[bioId]) bracket[bioId] = {};
    bracket[bioId][region] = amount;
  });
  return bracket;
}

// ---- Store directory (Mother Branch / employee category / Pending-queue
// routing) — shared by employee.js (Utilities-tab-visibility mirror) and
// admin.js (Approver queue's Pending-routing scope). A UX/display mirror of
// StoreDirectoryService.gs's authoritative server-side resolution — the
// server independently re-verifies routing on every advanceRequestStage/
// updateLineItemAmount call regardless of what this shows, so a bug here can
// only ever show an Approver the wrong Pending list, never let them
// illegitimately approve something the server would otherwise block.

// Column indices in the store-directory CSV (0-indexed) — several headers
// are blank/duplicated in that sheet, so columns are addressed positionally,
// not by header name. See frontend/config.js's STORE_DIRECTORY_CSV_URL comment.
// NOTE: Area Head is read from columns 24/25, NOT the more obvious-looking
// 11/12 — confirmed via real data that 11/12 are off-by-one-row misaligned
// with column 26 (STORES) for most stores, while 24/25 are correctly
// aligned. See StoreDirectoryService.gs's file header comment for details.
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

var storeDirectoryRowsCache = null;

function loadStoreDirectory_() {
  if (storeDirectoryRowsCache) return Promise.resolve(storeDirectoryRowsCache);
  return fetch(STORE_DIRECTORY_CSV_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) {
      storeDirectoryRowsCache = parseCsv_(text).slice(1); // drop header row
      return storeDirectoryRowsCache;
    });
}

// Department is a broader signal than the per-store directory — that sheet
// only lists ONE named Tech and ONE named Auditor per store, but many more
// employees can carry a Technical/Audit Department code without being that
// one specific per-store assignee. Matches loosely (substring, not exact) to
// tolerate both abbreviations ("TEC", "Aud") and full words ("Technical",
// "Auditing") already seen in real Employees data. Mirrors
// StoreDirectoryService.gs's isTechnicalDepartment_/isAuditDepartment_.
function isTechnicalDepartment_(department) {
  var d = String(department || '').trim().toLowerCase();
  return d === 'tec' || d.indexOf('tech') !== -1;
}
function isAuditDepartment_(department) {
  var d = String(department || '').trim().toLowerCase();
  return d === 'aud' || d.indexOf('audit') !== -1;
}

// Returns { category: 'AreaHead'|'Technical'|'Audit'|'HeadOffice'|'Staff', store } —
// store is only set when found via the per-store directory listing (Staff,
// HeadOffice, and Technical/Audit resolved only via Department, aren't tied
// to one specific store; Mother Branch falls back to their own BaseLocation,
// except HeadOffice which is just labeled as such).
function resolveEmployeeCategory_(rows, employeeId, department) {
  var id = String(employeeId || '').trim().toLowerCase();

  function findByColumn(bioCol) {
    return rows.filter(function (r) {
      return String(r[bioCol] || '').trim().toLowerCase() === id;
    })[0];
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
  return rows.filter(function (r) {
    return String(r[STORE_DIR_COL_STORE] || '').trim().toLowerCase() === loc;
  })[0] || null;
}

// Client-side port of StoreDirectoryService.gs's resolveRequiredApprover_ —
// used only to scope which Pending requests admin.js shows an Approver
// (display/filtering only; advanceRequestStage/updateLineItemAmount
// independently re-verify this same routing server-side on every call, so a
// mismatch here can never let someone illegitimately approve a request).
// Returns { found: false } when routing can't be determined (directory
// unreachable, or a Staff employee's location matches no listed store) —
// callers should treat that the same way the backend does: fail open, show
// the request rather than hide it.
function resolveRequiredApprover_(rows, employeeId, employeeBaseLocation, employeeDepartment, requestLineLocation) {
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

// ---- Joined request list (My Requests / Approver queue) — CSV-based read
// path, a client-side port of RequestService.gs's buildRequestsWithLines_.
// Mutations (submit/approve/reject/amount-edit) are unaffected and still go
// through Apps Script; this is only used to render lists faster and without
// a live round trip. Can lag a few minutes behind the live sheet (Google's
// publish-to-web refresh interval) — an accepted trade-off for this read path.
var requestsCsvCache = null;
var requestLinesCsvCache = null;

function loadJoinedRequests_() {
  var requestsPromise = requestsCsvCache
    ? Promise.resolve(requestsCsvCache)
    : fetch(REQUESTS_CSV_URL)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
        .then(function (text) {
          requestsCsvCache = csvToObjects_(parseCsv_(text));
          return requestsCsvCache;
        });

  var linesPromise = requestLinesCsvCache
    ? Promise.resolve(requestLinesCsvCache)
    : fetch(REQUEST_LINES_CSV_URL)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
        .then(function (text) {
          requestLinesCsvCache = csvToObjects_(parseCsv_(text));
          return requestLinesCsvCache;
        });

  return Promise.all([requestsPromise, linesPromise]).then(function (results) {
    var requests = results[0];
    var allLines = results[1];

    var sorted = requests.slice().sort(function (a, b) {
      return new Date(b.DateSubmitted) - new Date(a.DateSubmitted);
    });

    return sorted.map(function (req) {
      var lines = allLines.filter(function (line) {
        return String(line.RequestID) === String(req.RequestID);
      });
      var copy = {};
      Object.keys(req).forEach(function (k) { copy[k] = req[k]; });
      copy.lines = lines;
      return copy;
    });
  });
}

// Mirrors RequestService.gs's STAGE_FIELD_NAMES — which *By/*Date column
// pair a given targetStage writes. Used only to optimistically patch the
// CSV-based cache below right after a successful mutation, so the UI
// reflects the change immediately instead of waiting for Google's
// publish-to-web refresh (which can lag several minutes and, since
// requestsCsvCache/requestLinesCsvCache are cached for the whole page
// session, would otherwise never pick up the change until a full reload).
var STAGE_FIELD_NAMES_CLIENT = {
  Approved: { by: 'ApprovedBy', date: 'ApprovedDate' },
  Reviewed: { by: 'ReviewedBy', date: 'ReviewedDate' },
  Authorized: { by: 'AuthorizedBy', date: 'AuthorizedDate' },
  Rejected: { by: 'RejectedBy', date: 'RejectedDate' }
};

// Called right after advanceRequestStage/updateLineItemAmount succeeds, so
// the next loadJoinedRequests_() call (from the cache, not a refetch)
// reflects the just-made change. Only patches what the client already knows
// for certain (the new Status and, for a stage advance, the acting
// approver's name/today's date) — Remarks and CreditingDate are left as-is
// and simply catch up whenever the CSV cache is genuinely refreshed later
// (e.g. next full page load), a minor, temporary cosmetic gap rather than
// the reported "doesn't disappear at all" bug.
function patchCachedRequestStage_(requestId, targetStage, actorName) {
  if (!requestsCsvCache) return;
  var row = requestsCsvCache.filter(function (r) { return String(r.RequestID) === String(requestId); })[0];
  if (!row) return;
  row.Status = targetStage;
  var fieldNames = STAGE_FIELD_NAMES_CLIENT[targetStage];
  if (fieldNames) {
    row[fieldNames.by] = actorName;
    row[fieldNames.date] = new Date().toISOString();
  }
}

// Called right after updateLineItemAmount succeeds — patches the specific
// line's Amount and recomputes the request's TotalAmount from scratch (not
// a delta, matching the server's own re-sum-everything approach), same
// reasoning as patchCachedRequestStage_ above.
function patchCachedLineAmount_(requestId, lineId, newAmount) {
  if (!requestLinesCsvCache || !requestsCsvCache) return;
  var line = requestLinesCsvCache.filter(function (l) { return String(l.LineID) === String(lineId); })[0];
  if (line) line.Amount = newAmount;

  var req = requestsCsvCache.filter(function (r) { return String(r.RequestID) === String(requestId); })[0];
  if (req) {
    var total = 0;
    requestLinesCsvCache.forEach(function (l) {
      if (String(l.RequestID) === String(requestId)) total += Number(l.Amount) || 0;
    });
    req.TotalAmount = total;
  }
}

// Called right after submitLiquidationRequest succeeds — inserts a synthetic
// Pending row (+ its lines) into the CSV-based cache so the new request
// shows up in My Requests immediately, instead of waiting on Google's
// publish-to-web refresh. Ensures the cache is actually loaded first (via
// loadJoinedRequests_, cheap/idempotent thanks to its own caching) before
// appending, so this also correctly handles the case where My Requests
// hasn't been opened yet this session (cache still null) — appending to a
// null cache would otherwise silently drop the employee's real other
// requests once the real fetch did happen. ReceiptFileURL is left blank for
// a freshly-uploaded photo (the real Drive URL isn't known until the CSV
// catches up) — a minor, temporary cosmetic gap, not a functional block.
function patchCachedNewRequest_(requestId, employeeId, employeeName, lines) {
  return loadJoinedRequests_().then(function () {
    var totalAmount = 0;
    var lineRows = lines.map(function (line, i) {
      var amount = Number(line.amount) || 0;
      totalAmount += amount;
      return {
        LineID: requestId + '-L' + (i + 1),
        RequestID: requestId,
        Date: line.date,
        Category: line.category,
        BaseLocation: line.baseLocation,
        Amount: amount,
        Description: line.description,
        ReceiptFileURL: line.receiptUrl || '',
        GpsMapLink: line.gpsMapLink || '',
        CutoffEndDate: line.cutoffEndDate || ''
      };
    });

    requestLinesCsvCache = requestLinesCsvCache.concat(lineRows);
    requestsCsvCache = requestsCsvCache.concat([{
      RequestID: requestId,
      EmployeeID: employeeId,
      EmployeeName: employeeName,
      DateSubmitted: new Date().toISOString(),
      Status: 'Pending',
      TotalAmount: totalAmount,
      Remarks: ''
    }]);
  });
}

// ---- Employees (CSV-based login lookup) — read-only speed path for the
// Biometric ID login screen, replacing a live getEmployeeByID Apps Script
// round trip. Mirrors EmployeeService.gs's getEmployeeByID exactly (same
// error strings, same Active gate) except Active arrives as the CSV text
// "TRUE"/"FALSE" rather than a real Sheets boolean.
var employeesCsvCache = null;

function loadEmployeesCsv_() {
  if (employeesCsvCache) return Promise.resolve(employeesCsvCache);
  return fetchTextWithRetry_(EMPLOYEES_CSV_URL)
    .then(function (text) {
      employeesCsvCache = csvToObjects_(parseCsv_(text));
      return employeesCsvCache;
    });
}

function lookupEmployeeFromCsv_(employeeId) {
  if (!employeeId) {
    return Promise.resolve({ found: false, error: 'Biometric ID no. is required.' });
  }
  return loadEmployeesCsv_().then(function (rows) {
    var match = rows.filter(function (row) {
      return String(row.EmployeeID) === String(employeeId);
    })[0];

    if (!match) {
      return { found: false, error: 'Biometric ID no. not found.' };
    }
    if (String(match.Active).trim().toUpperCase() !== 'TRUE') {
      return { found: false, error: 'This Biometric ID no. is inactive.' };
    }

    return {
      found: true,
      employee: {
        EmployeeID: match.EmployeeID,
        Name: match.Name,
        Department: match.Department,
        BaseLocation: match.BaseLocation
      }
    };
  });
}

// Client-side port of MealAllowanceService.gs's searchEmployeesForUtility —
// used by admin.js's Submission Exemption tab so typing in the search box
// doesn't round-trip through Apps Script (a full, uncached Employees sheet
// read plus the GET/redirect/echo-content-URL dance) on every keystroke.
// Same match rule (ID or Name substring, case-insensitive, Active only, top
// 15 results) except Active arrives as the CSV text "TRUE" rather than a real
// Sheets boolean, same as lookupEmployeeFromCsv_ above.
function searchEmployeesFromCsv_(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return Promise.resolve([]);
  return loadEmployeesCsv_().then(function (rows) {
    var matches = rows.filter(function (row) {
      if (String(row.Active).trim().toUpperCase() !== 'TRUE') return false;
      var id = String(row.EmployeeID || '').toLowerCase();
      var name = String(row.Name || '').toLowerCase();
      return id.indexOf(q) !== -1 || name.indexOf(q) !== -1;
    });
    return matches.slice(0, 15).map(function (row) {
      return { EmployeeID: row.EmployeeID, Name: row.Name };
    });
  });
}

function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = reader.result; // data:<mime>;base64,<data>
      var base64Data = result.substring(result.indexOf(',') + 1);
      resolve({ filename: file.name, mimeType: file.type, base64Data: base64Data });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Reads have no file payload and no side effects, so they're sent as a simple
// GET (no CORS preflight). Everything else — file uploads, status changes —
// goes over POST with a text/plain body, which also avoids a preflight
// (Apps Script has no way to answer an OPTIONS request).
var READ_ONLY_ACTIONS = ['getEmployeeByID', 'getMyRequests', 'getAllRequestsForPayroll', 'searchEmployeesForUtility',
  'getActiveSubmissionExemptions', 'checkMySubmissionExemption'];

// Shared network layer under both fetchJsonWithRetry_ (Apps Script RPCs) and
// fetchTextWithRetry_ (published-CSV reads): a plain fetch() rejects outright
// on a real network failure — a dropped/unstable connection, common on
// cellular — with no built-in retry or timeout, which is what let a single
// bad moment on mobile surface as a raw, unactionable "TypeError: Failed to
// fetch". This wraps every request with (a) a timeout via AbortController, so
// a stalled mobile connection fails fast and retries instead of hanging
// indefinitely, and (b) up to 2 silent retries (increasing backoff — raised
// from 1 retry after users kept hitting "Connection problem" intermittently
// during Apps Script's cold-start/echo-redirect dance, not just on weak
// signal) before giving up with a friendly message.
var FETCH_TIMEOUT_MS = 25000;
var NETWORK_RETRY_DELAYS_MS = [400, 1200];

function fetchWithRetry_(url, options, attemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = NETWORK_RETRY_DELAYS_MS.length + 1;
  options = options || {};

  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var fetchOptions = options;
  var timeoutId = null;
  if (controller) {
    fetchOptions = {};
    for (var key in options) { if (options.hasOwnProperty(key)) fetchOptions[key] = options[key]; }
    fetchOptions.signal = controller.signal;
    timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  }

  return fetch(url, fetchOptions)
    .then(function (res) {
      if (timeoutId) clearTimeout(timeoutId);
      return res;
    })
    .catch(function (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (attemptsLeft > 1) {
        var delay = NETWORK_RETRY_DELAYS_MS[NETWORK_RETRY_DELAYS_MS.length - (attemptsLeft - 1)];
        return new Promise(function (resolve) { setTimeout(resolve, delay); })
          .then(function () { return fetchWithRetry_(url, options, attemptsLeft - 1); });
      }
      throw new Error('Connection problem — please check your signal and try again.');
    });
}

function fetchTextWithRetry_(url, attemptsLeft) {
  return fetchWithRetry_(url, undefined, attemptsLeft).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

// Apps Script's POST/GET flow answers with a 302 to a one-time
// script.googleusercontent.com "echo" content URL — that hop intermittently
// 404s right after a fresh deploy or a cold start (confirmed transient: the
// exact same call always succeeds on an immediate retry, both via curl/node
// and manually re-clicking in the browser). Rather than surfacing that as a
// user-facing error, retry the whole call once, silently, before giving up.
//
// Separately, a well-formed {success:false, error:'System is busy...'}
// response means every mutation lost the race for the backend's shared
// LockService lock under heavy concurrent load (see RequestService.gs) — this
// is transient, not a real failure, so it gets its own silent retry budget
// (busyAttemptsLeft) independent of the network/malformed-JSON one above, on
// an increasing backoff since lock waits there can now run up to ~20s. Any
// other success:false error (validation, "Request not found", etc.) is never
// retried — only this specific message is.
var BUSY_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

function fetchJsonWithRetry_(url, options, attemptsLeft, busyAttemptsLeft) {
  if (attemptsLeft === undefined) attemptsLeft = NETWORK_RETRY_DELAYS_MS.length + 1;
  if (busyAttemptsLeft === undefined) busyAttemptsLeft = BUSY_RETRY_DELAYS_MS.length;
  return fetchWithRetry_(url, options, attemptsLeft)
    .then(function (res) { return res.text(); })
    .then(function (text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        if (attemptsLeft > 1) {
          var delay = NETWORK_RETRY_DELAYS_MS[NETWORK_RETRY_DELAYS_MS.length - (attemptsLeft - 1)];
          return new Promise(function (resolve) { setTimeout(resolve, delay); })
            .then(function () { return fetchJsonWithRetry_(url, options, attemptsLeft - 1, busyAttemptsLeft); });
        }
        throw new Error('Server returned an unexpected response — please try again.');
      }

      if (parsed && parsed.success === false && /busy/i.test(parsed.error || '') && busyAttemptsLeft > 0) {
        var delay = BUSY_RETRY_DELAYS_MS[BUSY_RETRY_DELAYS_MS.length - busyAttemptsLeft];
        return new Promise(function (resolve) { setTimeout(resolve, delay); })
          .then(function () { return fetchJsonWithRetry_(url, options, attemptsLeft, busyAttemptsLeft - 1); });
      }

      return parsed;
    });
}

function runServer(functionName) {
  var args = Array.prototype.slice.call(arguments, 1);

  if (READ_ONLY_ACTIONS.indexOf(functionName) !== -1) {
    var params = new URLSearchParams();
    params.set('action', functionName);
    args.forEach(function (arg, i) { params.set('arg' + i, arg); });
    return fetchJsonWithRetry_(APPS_SCRIPT_URL + '?' + params.toString());
  }

  return fetchJsonWithRetry_(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: functionName, args: args })
  });
}

// ---- View toggling (index.html only: login vs employee-main) ----
// admin.html is a separate page now, so the header's Employee/Payroll nav is
// just two plain <a href> links — no JS routing needed between them.

function switchTopView(view) {
  ['view-login', 'view-employee-main'].forEach(function (id) {
    hideEl($(id));
  });
  showEl($(view));
}

// ---- Shared receipt/line-item preview modal (used by both index.html's My
// Requests and admin.html's queue) — injected into the DOM once, reused for
// every open. View-only unless opened with { editable: true, onSaveAmount }.

var receiptModal_ = null;

function ensureReceiptModal_() {
  if (receiptModal_) return receiptModal_;

  var backdrop = document.createElement('div');
  backdrop.className = 'receipt-modal-backdrop hidden';
  backdrop.innerHTML =
    '<div class="receipt-modal">' +
    '<button type="button" class="receipt-modal-close" aria-label="Close">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
    '</button>' +
    '<div class="receipt-modal-image-pane"></div>' +
    '<div class="receipt-modal-details"></div>' +
    '</div>';
  document.body.appendChild(backdrop);

  function close() { backdrop.classList.add('hidden'); }

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.receipt-modal-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (backdrop.classList.contains('hidden')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowLeft' && receiptModal_.currentNav && receiptModal_.currentNav.onPrev) receiptModal_.currentNav.onPrev();
    if (e.key === 'ArrowRight' && receiptModal_.currentNav && receiptModal_.currentNav.onNext) receiptModal_.currentNav.onNext();
  });

  receiptModal_ = { backdrop: backdrop, close: close, currentNav: null };
  return receiptModal_;
}

var RECEIPT_PLACEHOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

// Wires scroll/pinch-to-zoom + drag-to-pan on a freshly-inserted receipt
// <img>. All state lives in these closure variables, so every call (i.e.
// every modal open, since openLineItemPreview_ rebuilds the <img> each time)
// starts fresh at 1x/centered — no explicit reset-on-close needed. Zoom is
// center-anchored (not cursor-anchored) — simpler and robust, still gives
// scroll-to-zoom + drag-to-pan. Pointer Events cover mouse and touch (drag,
// and two-finger pinch) through one code path.
function wireImageZoomPan_(img, pane) {
  var MIN_SCALE = 1;
  var MAX_SCALE = 4;
  var scale = 1;
  var translateX = 0;
  var translateY = 0;
  var activePointers = {};
  var pinchStartDistance = 0;
  var pinchStartScale = 1;
  var dragPointerId = null;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragStartTranslateX = 0;
  var dragStartTranslateY = 0;
  var rotation = 0; // 0/90/180/270 — resets fresh every call, same as scale/translate

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function applyTransform() {
    // img.offsetWidth/Height are the element's un-rotated layout-box size —
    // CSS rotate() never changes them, only visual rendering. At 90/270deg
    // the on-screen bounding box has width/height swapped versus that layout
    // box, so the pan clamp must swap them too or part of the image becomes
    // permanently unreachable (the edges-cut-off bug). At 0/180deg nothing
    // swaps, so this is a no-op there.
    var rotated90 = (rotation === 90 || rotation === 270);
    var effectiveWidth = rotated90 ? img.offsetHeight : img.offsetWidth;
    var effectiveHeight = rotated90 ? img.offsetWidth : img.offsetHeight;

    var maxOffsetX = Math.max(0, (effectiveWidth * scale - pane.clientWidth) / 2);
    var maxOffsetY = Math.max(0, (effectiveHeight * scale - pane.clientHeight) / 2);
    translateX = clamp(translateX, -maxOffsetX, maxOffsetX);
    translateY = clamp(translateY, -maxOffsetY, maxOffsetY);
    // rotate() stays right-most/inner-most so it spins the image around its
    // own center without changing what "horizontal"/"vertical" mean for the
    // translate() pan offsets above (which are screen-space pixel deltas).
    img.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ') rotate(' + rotation + 'deg)';
    img.style.cursor = scale > 1 ? (dragPointerId !== null ? 'grabbing' : 'grab') : 'default';
  }

  function setScale(newScale) {
    scale = clamp(newScale, MIN_SCALE, MAX_SCALE);
    if (scale === MIN_SCALE) { translateX = 0; translateY = 0; }
    applyTransform();
  }

  function rotateBy(delta) {
    rotation = (rotation + delta + 360) % 360;
    applyTransform();
  }

  pane.addEventListener('wheel', function (e) {
    e.preventDefault();
    setScale(scale - e.deltaY * 0.0015 * scale);
  }, { passive: false });

  img.addEventListener('dblclick', function () {
    scale = MIN_SCALE;
    translateX = 0;
    translateY = 0;
    applyTransform();
  });

  function pointerDistance() {
    var pts = Object.keys(activePointers).map(function (id) { return activePointers[id]; });
    var dx = pts[0].x - pts[1].x;
    var dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  img.addEventListener('pointerdown', function (e) {
    activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(activePointers);

    if (ids.length === 2) {
      dragPointerId = null;
      pinchStartDistance = pointerDistance();
      pinchStartScale = scale;
    } else if (ids.length === 1 && scale > 1) {
      dragPointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartTranslateX = translateX;
      dragStartTranslateY = translateY;
      img.setPointerCapture(e.pointerId);
      applyTransform();
    }
  });

  img.addEventListener('pointermove', function (e) {
    if (!activePointers[e.pointerId]) return;
    activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(activePointers);

    if (ids.length === 2 && pinchStartDistance > 0) {
      setScale(pinchStartScale * (pointerDistance() / pinchStartDistance));
    } else if (dragPointerId === e.pointerId) {
      translateX = dragStartTranslateX + (e.clientX - dragStartX);
      translateY = dragStartTranslateY + (e.clientY - dragStartY);
      applyTransform();
    }
  });

  function endPointer(e) {
    delete activePointers[e.pointerId];
    if (dragPointerId === e.pointerId) {
      dragPointerId = null;
      applyTransform();
    }
    if (Object.keys(activePointers).length < 2) {
      pinchStartDistance = 0;
    }
  }

  img.addEventListener('pointerup', endPointer);
  img.addEventListener('pointercancel', endPointer);

  return { rotateLeft: function () { rotateBy(-90); }, rotateRight: function () { rotateBy(90); } };
}

// Drive URLs seen in this app come in two shapes: ".../file/d/<ID>/view..."
// (this app's own uploaded receipts, via DriveService.gs's uploadReceiptFile_
// -> driveFile.getUrl()) and ".../uc?id=<ID>" (the Meal Allowance utility's
// attendance "Photo Link" column — confirmed by inspecting the real
// published CSV). Neither serves raw image bytes directly — the first is an
// HTML viewer page, the second a redirect — so neither loads in an <img src>
// as-is (which is why receipt previews used to fall through to "Preview not
// available"). Both get rewritten below to Drive's thumbnail/download
// endpoints, which do serve real bytes for the same file ID.
function driveFileId_(url) {
  var s = String(url || '');
  var m = /\/file\/d\/([^/?#]+)/.exec(s);
  if (m) return m[1];
  m = /[?&]id=([^&#]+)/.exec(s);
  return m ? m[1] : null;
}

// Drive's thumbnail endpoint serves an actual image for a given file ID —
// and generates a page-1 preview image even for a PDF receipt, which is
// exactly what we want here. Anything whose file ID can't be extracted
// passes through unchanged, still used directly as the <img src>.
function driveThumbnailUrl_(url) {
  var id = driveFileId_(url);
  return id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w2000' : url;
}

// The thumbnail above is a downscaled/compressed preview (capped at
// sz=w2000) — good enough to review on-screen, but not for zooming into
// fine print at full quality. This gives access to the original,
// full-resolution file straight from Drive for that case.
function driveDownloadUrl_(url) {
  var id = driveFileId_(url);
  return id ? 'https://drive.google.com/uc?export=download&id=' + id : url;
}

var ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

var ICON_ROTATE_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><polyline points="3 4 3 9 8 9"></polyline></svg>';
var ICON_ROTATE_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"></path><polyline points="21 4 21 9 16 9"></polyline></svg>';
var ICON_CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>';
var ICON_CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

// Messenger-style "N of total" navigation across a request's other line
// items/attachments. `computeLineOptionsFn(line)` re-derives the
// editable/onSaveAmount pair for whichever line is being shown (see
// wireLineItemRows_) since that closure is bound to a specific line.
function openLineItemPreviewWithNav_(lines, index, computeLineOptionsFn) {
  var line = lines[index];
  var opts = computeLineOptionsFn(line);
  opts.position = index + 1;
  opts.total = lines.length;
  opts.onPrev = index > 0
    ? function () { openLineItemPreviewWithNav_(lines, index - 1, computeLineOptionsFn); }
    : null;
  opts.onNext = index < lines.length - 1
    ? function () { openLineItemPreviewWithNav_(lines, index + 1, computeLineOptionsFn); }
    : null;
  openLineItemPreview_(line, opts);
}

function openLineItemPreview_(line, options) {
  options = options || {};
  var modal = ensureReceiptModal_();
  var imagePane = modal.backdrop.querySelector('.receipt-modal-image-pane');
  var detailsPane = modal.backdrop.querySelector('.receipt-modal-details');

  if (line.ReceiptFileURL) {
    var downloadLinkHtml = '<a href="' + escapeHtml_(driveDownloadUrl_(line.ReceiptFileURL)) + '" class="receipt-modal-download" target="_blank" rel="noopener" title="Download original receipt" aria-label="Download original receipt">' + ICON_DOWNLOAD + '</a>';
    var rotateControlsHtml =
      '<div class="receipt-modal-rotate-group">' +
      '<button type="button" class="receipt-modal-rotate-left" aria-label="Rotate left">' + ICON_ROTATE_LEFT + '</button>' +
      '<button type="button" class="receipt-modal-rotate-right" aria-label="Rotate right">' + ICON_ROTATE_RIGHT + '</button>' +
      '</div>';

    imagePane.innerHTML = '<img src="' + escapeHtml_(driveThumbnailUrl_(line.ReceiptFileURL)) + '" alt="Receipt" draggable="false">' + downloadLinkHtml + rotateControlsHtml;
    var receiptImg = imagePane.querySelector('img');
    receiptImg.addEventListener('error', function () {
      imagePane.innerHTML =
        '<div class="receipt-modal-placeholder">' + RECEIPT_PLACEHOLDER_ICON +
        '<p>Preview not available.</p>' +
        '<a href="' + escapeHtml_(line.ReceiptFileURL) + '" target="_blank" rel="noopener" class="link-inline">Open receipt in new tab</a>' +
        '</div>' + downloadLinkHtml;
    }, { once: true });
    var zoomPan = wireImageZoomPan_(receiptImg, imagePane);
    imagePane.querySelector('.receipt-modal-rotate-left').addEventListener('click', zoomPan.rotateLeft);
    imagePane.querySelector('.receipt-modal-rotate-right').addEventListener('click', zoomPan.rotateRight);
  } else {
    imagePane.innerHTML =
      '<div class="receipt-modal-placeholder">' + RECEIPT_PLACEHOLDER_ICON + '<p>No receipt uploaded.</p></div>';
  }

  modal.currentNav = { onPrev: options.onPrev || null, onNext: options.onNext || null };

  if (options.total > 1) {
    var navHtml =
      '<div class="receipt-modal-counter">' + options.position + ' / ' + options.total + '</div>' +
      '<button type="button" class="receipt-modal-nav-prev" aria-label="Previous attachment"' + (options.onPrev ? '' : ' disabled') + '>' + ICON_CHEVRON_LEFT + '</button>' +
      '<button type="button" class="receipt-modal-nav-next" aria-label="Next attachment"' + (options.onNext ? '' : ' disabled') + '>' + ICON_CHEVRON_RIGHT + '</button>';
    imagePane.insertAdjacentHTML('beforeend', navHtml);
    if (options.onPrev) {
      imagePane.querySelector('.receipt-modal-nav-prev').addEventListener('click', options.onPrev);
    }
    if (options.onNext) {
      imagePane.querySelector('.receipt-modal-nav-next').addEventListener('click', options.onNext);
    }
  }

  var isTimesheet = line.Category === 'Timesheet';
  var editableNow = options.editable && !isTimesheet;

  var amountHtml = editableNow
    ? '<div class="receipt-modal-amount-edit">' +
      '<input type="number" step="0.01" min="0.01" class="receipt-modal-amount-input" value="' + Number(line.Amount).toFixed(2) + '">' +
      '<button type="button" class="btn btn-primary btn-small receipt-modal-save-btn" disabled>Save Amount</button>' +
      '</div>'
    : formatLineAmountDisplay_(line);

  var gpsRowHtml = line.GpsMapLink
    ? '<div class="receipt-modal-row"><span class="rm-label">GPS Location</span><span class="rm-value">' +
      '<a href="' + escapeHtml_(line.GpsMapLink) + '" target="_blank" rel="noopener">View Map</a></span></div>'
    : '';

  detailsPane.innerHTML =
    '<h3>Line item details</h3>' +
    '<div class="receipt-modal-row"><span class="rm-label">Date</span><span class="rm-value">' + escapeHtml_(formatLineDateDisplay_(line)) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Category</span><span class="rm-value">' + escapeHtml_(line.Category) + '</span></div>' +
    (isTimesheet ? '' :
      '<div class="receipt-modal-row"><span class="rm-label">Location</span><span class="rm-value">' + escapeHtml_(line.BaseLocation) + '</span></div>' +
      '<div class="receipt-modal-row"><span class="rm-label">Description</span><span class="rm-value">' + escapeHtml_(line.Description) + '</span></div>') +
    '<div class="receipt-modal-row"><span class="rm-label">Amount</span><span class="rm-value">' + amountHtml + '</span></div>' +
    gpsRowHtml +
    '<div class="msg msg-error hidden receipt-modal-error" role="alert"></div>';

  if (editableNow) {
    var input = detailsPane.querySelector('.receipt-modal-amount-input');
    var saveBtn = detailsPane.querySelector('.receipt-modal-save-btn');
    var errorEl = detailsPane.querySelector('.receipt-modal-error');
    var originalValue = input.value;

    input.addEventListener('input', function () {
      var num = Number(input.value);
      saveBtn.disabled = (input.value === originalValue) || !num || num <= 0;
    });

    saveBtn.addEventListener('click', function () {
      var newAmount = Number(input.value);
      if (!newAmount || newAmount <= 0) return;
      clearMessage(errorEl);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      options.onSaveAmount(newAmount)
        .then(function () {
          line.Amount = newAmount;
          originalValue = input.value;
          saveBtn.textContent = 'Saved';
        })
        .catch(function (err) {
          setMessage(errorEl, err.message, true);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Amount';
        });
    });
  }

  modal.backdrop.classList.remove('hidden');
}
