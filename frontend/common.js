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
  var colCount = showEmployee ? 6 : 5;
  var html = '<div class="table-scroll"><table class="data-table"><thead><tr>';
  html += '<th>Request ID</th><th>Date</th>';
  if (showEmployee) html += '<th>Employee</th>';
  html += '<th>Total</th><th>Status</th><th>Crediting Date</th></tr></thead><tbody>';

  requests.forEach(function (req, idx) {
    html += '<tr class="request-row" data-idx="' + idx + '" tabindex="0" role="button" aria-expanded="false">';
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

  function toggleRow(row) {
    var idx = row.getAttribute('data-idx');
    var detailRow = container.querySelector('[data-detail-idx="' + idx + '"]');
    var isHidden = detailRow.classList.contains('hidden');
    container.querySelectorAll('.detail-row').forEach(function (r) { r.classList.add('hidden'); });
    container.querySelectorAll('.request-row').forEach(function (r) { r.setAttribute('aria-expanded', 'false'); });
    if (isHidden) {
      detailRow.classList.remove('hidden');
      row.setAttribute('aria-expanded', 'true');
      var panel = $('detail-panel-' + idx);
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
    html += '<tr class="line-detail-row" data-line-id="' + escapeHtml_(line.LineID) + '" tabindex="0" role="button">';
    html += '<td data-label="Date">' + formatDateDisplay(line.Date) + '</td>';
    html += '<td data-label="Category">' + escapeHtml_(line.Category) + '</td>';
    html += '<td data-label="Location">' + escapeHtml_(line.BaseLocation) + '</td>';
    html += '<td data-label="Amount">' + formatCurrency(line.Amount) + '</td>';
    html += '<td data-label="Description">' + escapeHtml_(line.Description) + '</td>';
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
  function openFor(row) {
    var lineId = row.getAttribute('data-line-id');
    var line = null;
    request.lines.forEach(function (l) {
      if (String(l.LineID) === String(lineId)) line = l;
    });
    if (!line) return;

    var editable = !!(options.isLineEditable && options.isLineEditable(request) && options.onSaveAmount);
    openLineItemPreview_(line, {
      editable: editable,
      onSaveAmount: (editable && options.onSaveAmount)
        ? function (newAmount) { return options.onSaveAmount(request, line, newAmount); }
        : null
    });
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
// has three duplicate column names — "Store", "BIO ID", and
// "REGULAR (AUDIT/TEC/STAFF)" all appear twice: once for the per-store
// data near the front of the row, and again at columns 21/22 for an
// unrelated "Technical Staff Roster" sub-table (BIO ID -> employee name)
// crammed into the same published sheet. csvToObjects_ keys by header
// name, so the later roster occurrence silently overwrote the real
// per-store "BIO ID"/"REGULAR (AUDIT/TEC/STAFF)" values for every row —
// this broke the plain regional-bracket Meal Allowance amount entirely
// (it always computed to ₱0, confirmed live for a plain Staff employee)
// and any BIO ID membership match. This restores those two fields by
// fixed column index — re-verify these indices if the sheet's layout
// ever changes; "Store" also duplicates (columns 0 and 10) but both
// copies hold the same value in practice, so it's left as-is.
var STORE_COORD_COL_REGULAR_BRACKET = 2;
var STORE_COORD_COL_TECH_BIO = 3;

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
      return obj;
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
var READ_ONLY_ACTIONS = ['getEmployeeByID', 'getMyRequests', 'getAllRequestsForPayroll', 'searchEmployeesForUtility'];

function runServer(functionName) {
  var args = Array.prototype.slice.call(arguments, 1);

  if (READ_ONLY_ACTIONS.indexOf(functionName) !== -1) {
    var params = new URLSearchParams();
    params.set('action', functionName);
    args.forEach(function (arg, i) { params.set('arg' + i, arg); });
    return fetch(APPS_SCRIPT_URL + '?' + params.toString())
      .then(function (res) { return res.json(); });
  }

  return fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: functionName, args: args })
  }).then(function (res) { return res.json(); });
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
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
  });

  receiptModal_ = { backdrop: backdrop, close: close };
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
    var maxOffsetX = Math.max(0, (img.offsetWidth * scale - pane.clientWidth) / 2);
    var maxOffsetY = Math.max(0, (img.offsetHeight * scale - pane.clientHeight) / 2);
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

  var amountHtml = options.editable
    ? '<div class="receipt-modal-amount-edit">' +
      '<input type="number" step="0.01" min="0.01" class="receipt-modal-amount-input" value="' + Number(line.Amount).toFixed(2) + '">' +
      '<button type="button" class="btn btn-primary btn-small receipt-modal-save-btn" disabled>Save Amount</button>' +
      '</div>'
    : formatCurrency(line.Amount);

  var gpsRowHtml = line.GpsMapLink
    ? '<div class="receipt-modal-row"><span class="rm-label">GPS Location</span><span class="rm-value">' +
      '<a href="' + escapeHtml_(line.GpsMapLink) + '" target="_blank" rel="noopener">View Map</a></span></div>'
    : '';

  detailsPane.innerHTML =
    '<h3>Line item details</h3>' +
    '<div class="receipt-modal-row"><span class="rm-label">Date</span><span class="rm-value">' + escapeHtml_(formatDateDisplay(line.Date)) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Category</span><span class="rm-value">' + escapeHtml_(line.Category) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Location</span><span class="rm-value">' + escapeHtml_(line.BaseLocation) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Description</span><span class="rm-value">' + escapeHtml_(line.Description) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Amount</span><span class="rm-value">' + amountHtml + '</span></div>' +
    gpsRowHtml +
    '<div class="msg msg-error hidden receipt-modal-error" role="alert"></div>';

  if (options.editable) {
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
