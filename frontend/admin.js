var currentApprover = null; // { fullName, role, userId, password, biometricId } — credentials are resent with every action; see common.js's runServer

function showAdminView(view) {
  ['view-login', 'view-admin'].forEach(function (id) { hideEl($(id)); });
  showEl($(view));
}

function initAdminView() {
  $('btn-login-approver').addEventListener('click', handleApproverLogin);
  $('input-approver-password').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleApproverLogin();
  });
  $('link-logout').addEventListener('click', function (e) {
    e.preventDefault();
    currentApprover = null;
    sessionStorage.removeItem(SESSION_KEY_APPROVER);
    $('input-approver-userid').value = '';
    $('input-approver-password').value = '';
    showAdminView('view-login');
  });
  $('admin-status-filter').addEventListener('change', loadAdminRequests);

  if (!restoreApproverSession_()) showAdminView('view-login');
}

// Restores a previously logged-in approver's identity (not password — that's
// deliberately never persisted, see handleApproverLogin) from sessionStorage
// after a page refresh. Returns true if a session was found and restored.
function restoreApproverSession_() {
  var saved = sessionStorage.getItem(SESSION_KEY_APPROVER);
  if (!saved) return false;
  try {
    var parsed = JSON.parse(saved);
    currentApprover = { fullName: parsed.fullName, role: parsed.role, userId: parsed.userId, password: null, biometricId: parsed.biometricId };
    $('approver-display-name').textContent = currentApprover.fullName;
    $('approver-display-role').textContent = ' (' + currentApprover.role + ')';
    showAdminView('view-admin');
    loadAdminRequests();
    return true;
  } catch (e) {
    sessionStorage.removeItem(SESSION_KEY_APPROVER);
    return false;
  }
}

function handleApproverLogin() {
  var errorEl = $('login-error');
  clearMessage(errorEl);
  var userId = $('input-approver-userid').value.trim();
  var password = $('input-approver-password').value;
  if (!userId || !password) {
    setMessage(errorEl, 'Please enter your User ID and password.', true);
    return;
  }

  var loginBtn = $('btn-login-approver');
  loginBtn.disabled = true;
  runServer('loginApprover', userId, password)
    .then(function (result) {
      loginBtn.disabled = false;
      if (!result.found) {
        setMessage(errorEl, result.error, true);
        return;
      }
      currentApprover = { fullName: result.fullName, role: result.role, userId: userId, password: password, biometricId: result.biometricId };
      sessionStorage.setItem(SESSION_KEY_APPROVER, JSON.stringify({ fullName: result.fullName, role: result.role, userId: userId, biometricId: result.biometricId }));
      $('approver-display-name').textContent = currentApprover.fullName;
      $('approver-display-role').textContent = ' (' + currentApprover.role + ')';
      showAdminView('view-admin');
      loadAdminRequests();
    })
    .catch(function (err) {
      loginBtn.disabled = false;
      setMessage(errorEl, 'Login failed: ' + err.message, true);
    });
}

function loadAdminRequests() {
  var container = $('admin-table-container');
  container.innerHTML = '<div class="state-message"><span class="spinner" aria-hidden="true" style="border-color:#e4e7eb;border-top-color:#1e3a5f;"></span><p>Loading requests...</p></div>';
  var statusFilter = $('admin-status-filter').value;

  // Only Approver-role accounts have their Pending view scoped to what this
  // specific person is actually meant to approve (mirrors the server's
  // category-based routing) — Reviewer/Authorizer queues stay unscoped, so
  // don't send a Biometric ID for those roles at all.
  var args = ['getAllRequestsForPayroll', statusFilter];
  if (currentApprover.role === 'Approver' && currentApprover.biometricId) {
    args.push(currentApprover.biometricId);
  }

  runServer.apply(null, args)
    .then(function (requests) {
      renderRequestsTable(container, requests, {
        showEmployee: true,
        isLineEditable: isLineEditableForCurrentApprover_,
        onSaveAmount: saveLineItemAmount_,
        onDetailRendered: function (panel, request) {
          var nextAction = NEXT_ACTION_BY_STATUS[request.Status];
          if (!nextAction) return; // terminal (Authorized/Rejected) — nothing left to do

          var requiredRole = REQUIRED_ROLE_BY_STATUS[request.Status];
          if (currentApprover.role !== requiredRole) {
            // Not this person's turn — show it's pending, but no action they can't legally take.
            panel.insertAdjacentHTML('beforeend',
              '<p class="muted">Awaiting action from a ' + escapeHtml_(requiredRole) + '.</p>');
            return;
          }

          panel.insertAdjacentHTML('beforeend', buildAdminActionsHtml_(request.RequestID, nextAction));
          wireAdminActions_(panel, request.RequestID, nextAction);
        }
      });
    })
    .catch(function (err) {
      container.innerHTML = '<div class="msg msg-error" role="alert">' + MSG_ICON_ERROR + '<span>Failed to load: ' + err.message + '</span></div>';
    });
}

var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

// The one forward action available for a request's current stage — Rejected
// is offered alongside this for Pending/Approved/Reviewed (not once Authorized).
var NEXT_ACTION_BY_STATUS = {
  Pending: { targetStage: 'Approved', label: 'Approve' },
  Approved: { targetStage: 'Reviewed', label: 'Mark Reviewed' },
  Reviewed: { targetStage: 'Authorized', label: 'Authorize Disbursement' }
};

// Mirrors RequestService.gs's REQUIRED_ROLE_BY_STATUS. This is what actually
// hides the action buttons for someone who isn't the right role for this
// request's current stage — the server enforces the same rule independently,
// so this is a UX nicety (don't show a button that will just error), not
// the security boundary.
var REQUIRED_ROLE_BY_STATUS = {
  Pending: 'Approver',
  Approved: 'Reviewer',
  Reviewed: 'Authorizer'
};

// Mirrors the same condition that decides whether to show the Approve/
// Reject panel at all (loadAdminRequests's onDetailRendered) — Amount is
// only editable while it's this approver's own turn to act on the request.
function isLineEditableForCurrentApprover_(request) {
  var requiredRole = REQUIRED_ROLE_BY_STATUS[request.Status];
  return !!requiredRole && currentApprover.role === requiredRole;
}

// Called from the shared receipt/detail modal's Save Amount button (see
// common.js's openLineItemPreview_ / wireLineItemRows_). Reuses the same
// password-reprompt gate as Approve/Reject since this is also a mutation.
function saveLineItemAmount_(request, line, newAmount) {
  if (!ensureApproverPassword_()) {
    return Promise.reject(new Error('Password required to save.'));
  }
  return runServer('updateLineItemAmount', request.RequestID, line.LineID, newAmount, currentApprover.userId, currentApprover.password, '')
    .then(function (result) {
      if (!result.success) {
        currentApprover.password = null; // can't tell if the password was the problem — re-prompt next time
        throw new Error(result.error);
      }
      loadAdminRequests(); // refreshes the Total column + audit trail for this request
      return result;
    });
}

function buildAdminActionsHtml_(requestId, nextAction) {
  var remarksId = 'remarks-' + requestId;
  return '' +
    '<div class="admin-actions" data-request-id="' + requestId + '">' +
    '  <div class="field">' +
    '    <label for="' + remarksId + '">Remarks (optional)</label>' +
    '    <input type="text" id="' + remarksId + '" class="admin-remarks" placeholder="Remarks">' +
    '  </div>' +
    '  <button class="btn btn-success btn-small admin-advance-btn" type="button">' + ICON_CHECK + '<span>' + nextAction.label + '</span></button>' +
    '  <button class="btn btn-danger btn-solid btn-small admin-reject-btn" type="button">' + ICON_X + '<span>Reject</span></button>' +
    '  <div class="msg msg-error hidden admin-action-error" role="alert"></div>' +
    '</div>';
}

// Re-prompts for the approver's password only when it's not already held in
// memory (e.g. right after a page-refresh restore, or after a prior action
// failed and cleared it) — never persisted to sessionStorage. Returns false
// if the user cancels the prompt.
function ensureApproverPassword_() {
  if (currentApprover.password) return true;
  var pwd = window.prompt('Re-enter your password to confirm this action, ' + currentApprover.fullName + ':');
  if (!pwd) return false;
  currentApprover.password = pwd;
  return true;
}

function wireAdminActions_(panel, requestId, nextAction) {
  var actionsEl = panel.querySelector('.admin-actions');
  var errorEl = actionsEl.querySelector('.admin-action-error');
  var advanceBtn = actionsEl.querySelector('.admin-advance-btn');
  var rejectBtn = actionsEl.querySelector('.admin-reject-btn');

  function process(targetStage, triggeringBtn) {
    clearMessage(errorEl);

    if (!ensureApproverPassword_()) return; // cancelled

    var remarks = actionsEl.querySelector('.admin-remarks').value.trim();

    var originalLabel = triggeringBtn.querySelector('span').textContent;
    triggeringBtn.querySelector('span').textContent = 'Processing...';
    actionsEl.querySelectorAll('button').forEach(function (b) { b.disabled = true; });

    function reEnable() {
      triggeringBtn.querySelector('span').textContent = originalLabel;
      actionsEl.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    }

    runServer('advanceRequestStage', requestId, targetStage, currentApprover.userId, currentApprover.password, remarks)
      .then(function (result) {
        if (!result.success) {
          currentApprover.password = null; // can't tell if it was the password that was wrong — re-prompt next time
          setMessage(errorEl, result.error, true);
          reEnable();
          return;
        }
        loadAdminRequests();
      })
      .catch(function (err) {
        currentApprover.password = null;
        setMessage(errorEl, err.message, true);
        reEnable();
      });
  }

  advanceBtn.addEventListener('click', function () { process(nextAction.targetStage, advanceBtn); });
  rejectBtn.addEventListener('click', function () { process('Rejected', rejectBtn); });
}

// CSV field escaping: quote-wraps any field containing a comma, quote, or
// newline, doubling embedded quotes — Remarks/Description are free text an
// employee/approver typed, so this must handle arbitrary content safely.
function csvField_(value) {
  var str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

var EXPORT_CSV_HEADERS = [
  'RequestID', 'EmployeeID', 'EmployeeName', 'Status', 'SubmittedDate',
  'ApprovedBy', 'ApprovedDate', 'ReviewedBy', 'ReviewedDate',
  'AuthorizedBy', 'AuthorizedDate', 'CreditingDate',
  'LineDate', 'Category', 'Amount', 'BaseLocation', 'ReceiptURL', 'Remarks'
];

// One row per line item (not per request) — a request with 3 lines produces
// 3 CSV rows, each repeating the request-level columns.
function buildExportCsv_(requests) {
  var rows = [EXPORT_CSV_HEADERS.map(csvField_).join(',')];
  requests.forEach(function (req) {
    var statusLabel = STATUS_DISPLAY_LABELS[req.Status] || req.Status;
    (req.lines || []).forEach(function (line) {
      rows.push([
        req.RequestID, req.EmployeeID, req.EmployeeName, statusLabel, req.DateSubmitted,
        req.ApprovedBy, req.ApprovedDate, req.ReviewedBy, req.ReviewedDate,
        req.AuthorizedBy, req.AuthorizedDate, req.CreditingDate,
        line.Date, line.Category, line.Amount, line.BaseLocation, line.ReceiptFileURL, req.Remarks
      ].map(csvField_).join(','));
    });
  });
  return rows.join('\r\n');
}

// Triggers a browser download of a text Blob — the print-preview report
// (buildExportReportHtml_) uses window.open()/document.write() instead,
// so this is the one place this app needs the manual Blob + temporary
// <a download> pattern.
function downloadTextFile_(filename, mimeType, text) {
  var blob = new Blob([text], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Builds the print-preview report as a single HTML string: a summary table
// followed by one full-page receipt image per line item, then a trailing
// note listing any line with no ReceiptFileURL. Uses driveThumbnailUrl_
// (already defined in common.js, proven by the on-screen receipt modal) so
// each receipt is a plain cross-origin <img> — no canvas involved, so no
// backend byte-fetching action is needed the way jsPDF's addImage required.
function buildExportReportHtml_(requests) {
  var now = new Date().toLocaleDateString();

  var summaryRows = requests.map(function (req) {
    return '<tr>' +
      '<td>' + escapeHtml_(req.RequestID) + '</td>' +
      '<td>' + escapeHtml_(req.EmployeeName) + '</td>' +
      '<td>' + escapeHtml_(STATUS_DISPLAY_LABELS[req.Status] || req.Status) + '</td>' +
      '<td>' + escapeHtml_(formatCurrency(req.TotalAmount)) + '</td>' +
      '<td>' + escapeHtml_(req.ApprovedBy) + '<br>' + escapeHtml_(formatDateDisplay(req.ApprovedDate)) + '</td>' +
      '<td>' + escapeHtml_(req.ReviewedBy) + '<br>' + escapeHtml_(formatDateDisplay(req.ReviewedDate)) + '</td>' +
      '<td>' + escapeHtml_(req.AuthorizedBy) + '<br>' + escapeHtml_(formatDateDisplay(req.AuthorizedDate)) + '</td>' +
      '<td>' + escapeHtml_(formatDateDisplay(req.CreditingDate)) + '</td>' +
      '</tr>';
  }).join('');

  var missing = [];
  var fareItems = [];
  var mealItems = [];
  requests.forEach(function (req) {
    (req.lines || []).forEach(function (line) {
      if (!line.ReceiptFileURL) {
        missing.push(req.RequestID + ' — ' + req.EmployeeName + ' — ' +
          formatDateDisplay(line.Date) + ' — ' + line.Category + ' (No receipt on file)');
        return;
      }
      var item = {
        caption: req.RequestID + ' — ' + req.EmployeeName + ' — ' +
          formatDateDisplay(line.Date) + ' — ' + line.Category + ' — ' + formatCurrency(line.Amount),
        url: driveThumbnailUrl_(line.ReceiptFileURL)
      };
      (line.Category === 'Meal Allowance' ? mealItems : fareItems).push(item);
    });
  });

  function chunk_(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function receiptCellHtml_(item) {
    return '<div class="receipt-cell">' +
      '<p class="receipt-caption">' + escapeHtml_(item.caption) + '</p>' +
      '<img src="' + escapeHtml_(item.url) + '" alt="Receipt">' +
      '</div>';
  }

  // Fare/Accommodation receipts get 2 per page (stacked, legible full-size
  // images); Meal Allowance receipts get 6 per page (2x3 grid) since there
  // are usually many more of them and they only need to be verifiable, not
  // as large. A partial final group (odd count) is handled purely by CSS —
  // see the .receipt-page-2up/-6up rules below — no placeholder markup
  // needed here.
  var receiptPagesHtml =
    chunk_(fareItems, 2).map(function (g) {
      return '<div class="receipt-page receipt-page-2up">' + g.map(receiptCellHtml_).join('') + '</div>';
    }).join('') +
    chunk_(mealItems, 6).map(function (g) {
      return '<div class="receipt-page receipt-page-6up">' + g.map(receiptCellHtml_).join('') + '</div>';
    }).join('');

  var missingHtml = missing.length
    ? '<div class="missing-note"><h2>Lines with no receipt on file</h2><ul>' +
      missing.map(function (m) { return '<li>' + escapeHtml_(m) + '</li>'; }).join('') +
      '</ul></div>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<title>Liquidation Export — ' + escapeHtml_(now) + '</title>' +
    '<style>' +
    '* { box-sizing: border-box; }' +
    'body { font-family: Arial, sans-serif; margin: 16px; color: #1e293b; }' +
    'h1 { color: #1e3a5f; font-size: 18px; margin-bottom: 4px; }' +
    'p.subtitle { color: #64748b; font-size: 12px; margin-top: 0; margin-bottom: 16px; }' +
    'table { width: 100%; border-collapse: collapse; font-size: 11px; }' +
    'th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }' +
    'th { background: #1e3a5f; color: #fff; }' +
    '@page { size: letter portrait; margin: 12mm; }' +
    '.receipt-page { page-break-before: always; padding-top: 8px; min-height: 90vh; }' +
    '.receipt-caption { font-weight: bold; font-size: 12px; margin-bottom: 4px; }' +
    '.receipt-page-2up { display: flex; flex-direction: column; gap: 12px; height: 100%; }' +
    '.receipt-page-2up .receipt-cell { flex: 1 1 50%; display: flex; flex-direction: column; min-height: 0; }' +
    '.receipt-page-2up .receipt-cell img { flex: 1 1 auto; min-height: 0; max-width: 100%; object-fit: contain; display: block; margin: 0 auto; }' +
    '.receipt-page-6up { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(3, 1fr); gap: 10px; height: 100%; }' +
    '.receipt-page-6up .receipt-cell { display: flex; flex-direction: column; min-height: 0; border: 1px solid #cbd5e1; padding: 6px; }' +
    '.receipt-page-6up .receipt-caption { font-size: 9px; margin-bottom: 3px; }' +
    '.receipt-page-6up .receipt-cell img { flex: 1 1 auto; min-height: 0; max-width: 100%; object-fit: contain; display: block; margin: 0 auto; }' +
    '.missing-note { page-break-before: always; padding-top: 16px; }' +
    '.missing-note li { font-size: 12px; margin-bottom: 4px; }' +
    '.no-print { position: fixed; top: 16px; right: 16px; display: flex; gap: 8px; }' +
    '.no-print button { padding: 10px 18px; border: none; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }' +
    '.btn-print { background: #1e3a5f; color: #fff; }' +
    '.btn-close { background: #64748b; color: #fff; }' +
    '@media print { .no-print { display: none !important; } }' +
    '</style></head><body>' +
    '<div class="no-print">' +
    '<button class="btn-print" onclick="window.print()">Print / Save PDF</button>' +
    '<button class="btn-close" onclick="window.close()">Close</button>' +
    '</div>' +
    '<h1>Liquidation Requests Export — Reviewed / Disbursed</h1>' +
    '<p class="subtitle">Generated ' + escapeHtml_(now) + '</p>' +
    '<table><thead><tr>' +
    '<th>Request ID</th><th>Employee</th><th>Status</th><th>Total</th>' +
    '<th>Approved</th><th>Reviewed</th><th>Authorized</th><th>Crediting Date</th>' +
    '</tr></thead><tbody>' + summaryRows + '</tbody></table>' +
    receiptPagesHtml +
    missingHtml +
    '</body></html>';
}

function initExportButtons_() {
  $('btn-export-csv').addEventListener('click', handleExportCsvClick_);
  $('btn-export-report').addEventListener('click', handleExportReportClick_);
}

function fetchExportableRequests_() {
  return Promise.all([
    runServer('getAllRequestsForPayroll', 'Reviewed'),
    runServer('getAllRequestsForPayroll', 'Authorized')
  ]).then(function (results) {
    if (!Array.isArray(results[0]) || !Array.isArray(results[1])) {
      var failed = !Array.isArray(results[0]) ? results[0] : results[1];
      throw new Error(failed && failed.error ? failed.error : 'Failed to load requests.');
    }
    return results[0].concat(results[1]);
  });
}

function handleExportCsvClick_() {
  var btn = $('btn-export-csv');
  var errorEl = $('export-error');
  clearMessage(errorEl);
  var originalLabel = btn.querySelector('span').textContent;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Exporting...';

  fetchExportableRequests_().then(function (requests) {
    if (!requests.length) {
      setMessage(errorEl, 'No Reviewed or Disbursed requests to export.', true);
      return;
    }
    var dateStamp = new Date().toISOString().slice(0, 10);
    downloadTextFile_('liquidation-export-' + dateStamp + '.csv', 'text/csv', buildExportCsv_(requests));
  }).catch(function (err) {
    setMessage(errorEl, 'Export failed: ' + err.message, true);
  }).finally(function () {
    btn.disabled = false;
    btn.querySelector('span').textContent = originalLabel;
  });
}

function handleExportReportClick_() {
  var btn = $('btn-export-report');
  var errorEl = $('export-error');
  clearMessage(errorEl);
  var originalLabel = btn.querySelector('span').textContent;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Loading...';

  // window.open must happen synchronously, right here in the click handler,
  // before any await/.then() — browsers (Safari especially) only honor the
  // "user activation" window open request during synchronous execution of
  // the click handler. Opening it after the fetch round-trip below gets
  // silently blocked even when the user never configured a popup blocker.
  // A placeholder is written immediately and swapped for the real report
  // once the data resolves.
  var reportWindow = window.open('', '_blank');
  if (reportWindow) {
    reportWindow.document.write('<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:24px;color:#64748b">Loading export…</body></html>');
    reportWindow.document.close();
  }

  fetchExportableRequests_().then(function (requests) {
    if (!requests.length) {
      if (reportWindow) reportWindow.close();
      setMessage(errorEl, 'No Reviewed or Disbursed requests to export.', true);
      return;
    }
    if (!reportWindow) {
      setMessage(errorEl, 'Please allow popups for this site to view the printable report.', true);
      return;
    }
    reportWindow.document.open();
    reportWindow.document.write(buildExportReportHtml_(requests));
    reportWindow.document.close();
  }).catch(function (err) {
    if (reportWindow) reportWindow.close();
    setMessage(errorEl, 'Export failed: ' + err.message, true);
  }).finally(function () {
    btn.disabled = false;
    btn.querySelector('span').textContent = originalLabel;
  });
}

