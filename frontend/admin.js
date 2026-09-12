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

// Triggers a browser download of a text Blob — jsPDF has no CSV equivalent
// (Task 5 uses doc.save() for the PDF instead), so this is the one place
// this app needs the manual Blob + temporary <a download> pattern.
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
