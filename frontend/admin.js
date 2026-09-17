var currentApprover = null; // { fullName, role, userId, password, biometricId } — credentials are resent with every action; see common.js's runServer

function showAdminView(view) {
  ['view-login', 'view-admin'].forEach(function (id) { hideEl($(id)); });
  showEl($(view));
}

// Two tabs within view-admin: the live "Liquidation Requests" queue
// (Pending/Approved/Rejected) and "Reviewed & Disbursed" (history +
// the Authorizer's Disburse action + Export/Print Preview). Mirrors
// employee.js's setEmployeeTab pattern.
var currentAdminTab_ = 'queue';

function setAdminTab(tab) {
  currentAdminTab_ = tab;
  $('tab-admin-queue').classList.toggle('active', tab === 'queue');
  $('tab-admin-queue').setAttribute('aria-selected', String(tab === 'queue'));
  $('tab-admin-history').classList.toggle('active', tab === 'history');
  $('tab-admin-history').setAttribute('aria-selected', String(tab === 'history'));
  $('tab-admin-exemptions').classList.toggle('active', tab === 'exemptions');
  $('tab-admin-exemptions').setAttribute('aria-selected', String(tab === 'exemptions'));

  $('view-admin-queue').classList.toggle('hidden', tab !== 'queue');
  $('view-admin-history').classList.toggle('hidden', tab !== 'history');
  $('view-admin-exemptions').classList.toggle('hidden', tab !== 'exemptions');

  stopExemptionCountdown_(); // only ticks while its own tab is actually showing

  if (tab === 'queue') loadAdminRequests();
  else if (tab === 'history') loadAdminHistory();
  else loadActiveExemptions();
}

// The "Reviewed & Disbursed" tab (permanent audit history + the
// Authorizer's Disburse action + Export/Print Preview) is only relevant to
// Reviewer/Authorizer roles — an Approver's only actionable stage is
// Pending, on the Liquidation Requests tab. "Submission Exemption" is the
// opposite shape of gate — visible to Authorizer only, not "everyone except
// one role" — since granting a submission-window bypass is specifically an
// Authorizer-level power, not something Reviewers/Approvers should even see.
// Called right after login/session restore, once currentApprover is known.
function applyAdminTabVisibility_() {
  var showHistoryTab = currentApprover.role !== 'Approver';
  $('tab-admin-history').classList.toggle('hidden', !showHistoryTab);
  $('tab-admin-exemptions').classList.toggle('hidden', currentApprover.role !== 'Authorizer');
}

// Refreshes whichever tab's list is currently showing — used after any
// mutation (single Approve/Reject/Disburse, Save Amount) whose action panel
// is rendered identically regardless of which tab it appeared in.
function refreshAdminActiveTab_() {
  if (currentAdminTab_ === 'history') loadAdminHistory();
  else loadAdminRequests();
}

function initAdminView() {
  $('btn-login-approver').addEventListener('click', handleApproverLogin);
  $('input-approver-password').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleApproverLogin();
  });
  $('link-logout').addEventListener('click', function (e) {
    e.preventDefault();
    stopExemptionCountdown_();
    currentApprover = null;
    sessionStorage.removeItem(SESSION_KEY_APPROVER);
    $('input-approver-userid').value = '';
    $('input-approver-password').value = '';
    showAdminView('view-login');
  });
  $('admin-status-filter').addEventListener('change', loadAdminRequests);
  $('admin-history-filter').addEventListener('change', loadAdminHistory);
  $('admin-history-name-filter').addEventListener('input', loadAdminHistory);
  $('admin-history-date-from').addEventListener('change', loadAdminHistory);
  $('admin-history-date-to').addEventListener('change', loadAdminHistory);
  $('tab-admin-queue').addEventListener('click', function () { setAdminTab('queue'); });
  $('tab-admin-history').addEventListener('click', function () { setAdminTab('history'); });
  $('tab-admin-exemptions').addEventListener('click', function () { setAdminTab('exemptions'); });
  queueBulkController_.wireClick();
  historyBulkController_.wireClick();

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
    applyAdminTabVisibility_();
    setAdminTab('queue');
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
      applyAdminTabVisibility_();
      setAdminTab('queue');
    })
    .catch(function (err) {
      loginBtn.disabled = false;
      setMessage(errorEl, 'Login failed: ' + err.message, true);
    });
}

// Shown for a request whose current stage isn't terminal — either offers the
// single-item action panel (this approver's own turn) or a "waiting on
// someone else" note. Shared by both the queue and history tabs, since the
// stage-advance UI is identical no matter which tab a request is viewed from.
function adminOnDetailRendered_(panel, request) {
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

// "Liquidation Requests" tab — the live queue: Pending (Approver),
// Approved (Reviewer), Rejected, or All of those three. Reviewed/Disbursed
// live on the separate "Reviewed & Disbursed" tab (loadAdminHistory) instead.
function loadAdminRequests() {
  var container = $('admin-table-container');
  container.innerHTML = '<div class="state-message"><span class="spinner" aria-hidden="true" style="border-color:#e4e7eb;border-top-color:#1e3a5f;"></span><p>Loading requests...</p></div>';
  var statusFilter = $('admin-status-filter').value;
  var queueStatuses = ['Pending', 'Approved', 'Rejected'];

  // Only Approver-role accounts have this whole tab scoped to what this
  // specific person is actually meant to approve — applied to every Status
  // filter option (Pending/Approved/Rejected/All), not just Pending, so an
  // Approver can also see their own approve history, not just their live
  // queue (a client-side mirror of the server's category-based routing,
  // common.js's resolveRequiredApprover_ — display/filtering only;
  // advanceRequestStage/updateLineItemAmount independently re-verify the
  // same routing server-side on every call, so a mismatch here can only
  // ever show the wrong list, never approve anything illegitimately). This
  // reads from the CSV-based joined list (loadJoinedRequests_) instead of a
  // live getAllRequestsForPayroll call — can lag a few minutes behind the
  // live sheet, an accepted trade-off for this read path.
  var scopeToApprover = currentApprover.role === 'Approver' && currentApprover.biometricId;

  Promise.all([
    loadJoinedRequests_(),
    scopeToApprover ? loadStoreDirectory_() : Promise.resolve(null),
    scopeToApprover ? loadEmployeesCsv_() : Promise.resolve(null)
  ])
    .then(function (results) {
      var allRequests = results[0];
      var directoryRows = results[1];
      var employeeRows = results[2];

      var requests = allRequests.filter(function (req) {
        if (statusFilter === 'All') {
          if (queueStatuses.indexOf(req.Status) === -1) return false;
        } else if (req.Status !== statusFilter) {
          return false;
        }

        if (scopeToApprover) {
          var emp = employeeRows.filter(function (e) { return String(e.EmployeeID) === String(req.EmployeeID); })[0];
          var lineLocation = (req.lines && req.lines[0]) ? req.lines[0].BaseLocation : '';
          var routing = resolveRequiredApprover_(
            directoryRows, req.EmployeeID,
            emp ? emp.BaseLocation : '', emp ? emp.Department : '',
            lineLocation
          );
          // Fail open (routing.found === false) shows the request to
          // everyone, same fallback philosophy as the server.
          if (routing.found && String(routing.bioId) !== String(currentApprover.biometricId)) return false;
        }
        return true;
      });

      // Bulk select/advance (+ bulk Reject) is offered for any status with a
      // forward action defined — Pending (bulk Approve), Approved (bulk Mark
      // Reviewed) — gated by the same role check the single-item action
      // panel already uses (REQUIRED_ROLE_BY_STATUS). Not offered for
      // All/Rejected views (no forward action defined for those). Bulk-
      // acting on Pending is safe even though it's per-request routed,
      // since this queue is already scoped to only the requests routed to
      // this approver — advanceRequestStage still independently re-checks
      // routing per item server-side regardless.
      var bulkAction = NEXT_ACTION_BY_STATUS[statusFilter];
      var bulkEligible = !!bulkAction &&
        currentApprover.role === REQUIRED_ROLE_BY_STATUS[statusFilter];

      queueBulkController_.reset(bulkEligible ? requests : [], bulkAction);

      renderRequestsTable(container, requests, {
        showEmployee: true,
        selectable: bulkEligible,
        onSelectionChange: bulkEligible ? queueBulkController_.updateSelection : undefined,
        isLineEditable: isLineEditableForCurrentApprover_,
        onSaveAmount: saveLineItemAmount_,
        onDetailRendered: adminOnDetailRendered_
      });
    })
    .catch(function (err) {
      container.innerHTML = '<div class="msg msg-error" role="alert">' + MSG_ICON_ERROR + '<span>Failed to load: ' + err.message + '</span></div>';
    });
}

// "Reviewed & Disbursed" tab — Reviewed (still actionable: the Authorizer
// disburses from here, single + bulk) and Authorized/"Disbursed" (pure
// history). Both statuses are already unscoped server-side (no category/
// store routing check applies past the Approved stage), so no routing
// re-check is needed here the way loadAdminRequests needs one for Pending.
function loadAdminHistory() {
  var container = $('admin-history-table-container');
  container.innerHTML = '<div class="state-message"><span class="spinner" aria-hidden="true" style="border-color:#e4e7eb;border-top-color:#1e3a5f;"></span><p>Loading requests...</p></div>';
  var statusFilter = $('admin-history-filter').value; // 'Reviewed' | 'Authorized' | 'All'
  var historyStatuses = ['Reviewed', 'Authorized'];

  // Permanent audit trail — this list is never time-windowed or capped
  // (loadJoinedRequests_ already returns the complete unfiltered dataset);
  // these three are purely additive search filters over that full history.
  var nameFilter = $('admin-history-name-filter').value.trim().toLowerCase();
  var dateFromRaw = $('admin-history-date-from').value; // 'YYYY-MM-DD' or ''
  var dateToRaw = $('admin-history-date-to').value;
  var dateFrom = dateFromRaw ? new Date(dateFromRaw + 'T00:00:00') : null;
  var dateTo = dateToRaw ? new Date(dateToRaw + 'T23:59:59') : null;

  loadJoinedRequests_()
    .then(function (allRequests) {
      var requests = allRequests.filter(function (req) {
        if (statusFilter === 'All') {
          if (historyStatuses.indexOf(req.Status) === -1) return false;
        } else if (req.Status !== statusFilter) {
          return false;
        }

        if (nameFilter && (req.EmployeeName || '').toLowerCase().indexOf(nameFilter) === -1) return false;

        if (dateFrom || dateTo) {
          var submitted = new Date(req.DateSubmitted);
          if (dateFrom && submitted < dateFrom) return false;
          if (dateTo && submitted > dateTo) return false;
        }

        return true;
      });

      var bulkAction = NEXT_ACTION_BY_STATUS[statusFilter];
      var bulkEligible = !!bulkAction && currentApprover.role === REQUIRED_ROLE_BY_STATUS[statusFilter];

      historyBulkController_.reset(bulkEligible ? requests : [], bulkAction);

      renderRequestsTable(container, requests, {
        showEmployee: true,
        selectable: bulkEligible,
        onSelectionChange: bulkEligible ? historyBulkController_.updateSelection : undefined,
        isLineEditable: isLineEditableForCurrentApprover_,
        onSaveAmount: saveLineItemAmount_,
        onDetailRendered: adminOnDetailRendered_
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
      patchCachedLineAmount_(request.RequestID, line.LineID, newAmount);
      refreshAdminActiveTab_(); // refreshes the Total column + audit trail for this request
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
        patchCachedRequestStage_(requestId, targetStage, currentApprover.fullName);
        refreshAdminActiveTab_();
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

// ---- Bulk select/advance (factory reused by the queue tab's Approved-bulk
// and the history tab's Reviewed-bulk — same UI/flow, different element ids,
// different underlying request list and refresh target) ----

function makeBulkController_(ids, refresh) {
  var requestsById = {}; // RequestID -> request object, for summing totals
  var action = null; // { targetStage, label }, or null when not eligible for the current filter
  var currentSelection = []; // array of selected RequestIDs, kept in sync by updateSelection

  // Called at the top of every load*'s render — resets selection state and
  // shows/hides the bar for the current filter/role combination.
  function reset(eligibleRequests, bulkAction) {
    action = bulkAction;
    requestsById = {};
    eligibleRequests.forEach(function (req) { requestsById[req.RequestID] = req; });

    var bar = $(ids.bar);
    clearMessage($(ids.error));
    if (!eligibleRequests.length || !bulkAction) {
      hideEl(bar);
      return;
    }
    $(ids.label).textContent = bulkAction.label + ' Selected';
    showEl(bar);
    updateSelection([]);
  }

  function updateSelection(selectedIds) {
    currentSelection = selectedIds;
    var total = 0;
    selectedIds.forEach(function (id) {
      var req = requestsById[id];
      if (req) total += Number(req.TotalAmount) || 0;
    });
    $(ids.summary).textContent = selectedIds.length + ' selected — Total ' + formatCurrency(total);
    $(ids.btn).disabled = selectedIds.length === 0;
    $(ids.btnReject).disabled = selectedIds.length === 0;
  }

  // Shared by both the forward-advance button and the Reject button — same
  // confirm/password-gate/sequential-processing/cache-patch pattern, only
  // the target stage, confirm wording, and which buttons get disabled differ.
  function processBatch(targetStage, actionLabel, activeBtn, otherBtn) {
    var errorEl = $(ids.error);
    clearMessage(errorEl);
    if (!action) return;

    var selectedIds = currentSelection.slice();
    if (!selectedIds.length) return;

    var total = selectedIds.reduce(function (sum, id) {
      var req = requestsById[id];
      return sum + (req ? Number(req.TotalAmount) || 0 : 0);
    }, 0);

    var confirmed = window.confirm(
      actionLabel + ' ' + selectedIds.length + ' request(s) totalling ' + formatCurrency(total) + '?'
    );
    if (!confirmed) return;

    if (!ensureApproverPassword_()) return; // cancelled

    var remarks = $(ids.remarks).value.trim();
    activeBtn.disabled = true;
    otherBtn.disabled = true;
    $(ids.label).textContent = 'Processing...';

    var failures = [];

    // Sequential, not Promise.all — avoids hammering Apps Script/LockService
    // with concurrent calls, and keeps per-request error attribution simple.
    selectedIds.reduce(function (chain, requestId) {
      return chain.then(function () {
        return runServer('advanceRequestStage', requestId, targetStage, currentApprover.userId, currentApprover.password, remarks)
          .then(function (result) {
            if (!result.success) {
              failures.push(requestId + ': ' + result.error);
              return;
            }
            patchCachedRequestStage_(requestId, targetStage, currentApprover.fullName);
          })
          .catch(function (err) {
            failures.push(requestId + ': ' + err.message);
          });
      });
    }, Promise.resolve())
      .then(function () {
        var succeeded = selectedIds.length - failures.length;
        if (failures.length) {
          currentApprover.password = null; // can't tell if a stale password caused a failure — re-prompt next time
          setMessage(errorEl, succeeded + ' processed, ' + failures.length + ' failed: ' + failures.join('; '), true);
        }
        refresh();
      });
  }

  function handleClick() {
    if (!action) return;
    processBatch(action.targetStage, action.label, $(ids.btn), $(ids.btnReject));
  }

  function handleRejectClick() {
    if (!action) return;
    processBatch('Rejected', 'Reject', $(ids.btnReject), $(ids.btn));
  }

  function wireClick() {
    $(ids.btn).addEventListener('click', handleClick);
    $(ids.btnReject).addEventListener('click', handleRejectClick);
  }

  return { reset: reset, updateSelection: updateSelection, wireClick: wireClick };
}

var queueBulkController_ = makeBulkController_({
  bar: 'bulk-action-bar', summary: 'bulk-selection-summary', remarks: 'bulk-remarks',
  btn: 'btn-bulk-advance', label: 'bulk-advance-label', btnReject: 'btn-bulk-reject',
  error: 'bulk-action-error'
}, function () { loadAdminRequests(); });

var historyBulkController_ = makeBulkController_({
  bar: 'bulk-action-bar-history', summary: 'bulk-selection-summary-history', remarks: 'bulk-remarks-history',
  btn: 'btn-bulk-advance-history', label: 'bulk-advance-label-history', btnReject: 'btn-bulk-reject-history',
  error: 'bulk-action-error-history'
}, function () { loadAdminHistory(); });

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
  'LineDate', 'CutoffEndDate', 'Category', 'Amount', 'BaseLocation', 'ReceiptURL', 'Remarks'
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
        line.Date, line.CutoffEndDate || '', line.Category, line.Amount, line.BaseLocation, line.ReceiptFileURL, req.Remarks
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

  var grandTotal = requests.reduce(function (sum, req) { return sum + (Number(req.TotalAmount) || 0); }, 0);
  var grandTotalRow = '<tfoot><tr class="grand-total-row">' +
    '<td colspan="3"><strong>Grand Total</strong></td>' +
    '<td><strong>' + escapeHtml_(formatCurrency(grandTotal)) + '</strong></td>' +
    '<td colspan="4"></td>' +
    '</tr></tfoot>';

  var missing = [];
  var fareItems = [];
  var mealItems = [];
  requests.forEach(function (req) {
    (req.lines || []).forEach(function (line) {
      if (!line.ReceiptFileURL) {
        missing.push(req.RequestID + ' — ' + req.EmployeeName + ' — ' +
          formatLineDateDisplay_(line) + ' — ' + line.Category + ' (No receipt on file)');
        return;
      }
      var amountCaption = line.Category === 'Timesheet' ? '' : (' — ' + formatCurrency(line.Amount));
      // Repeats the summary table's ApprovedBy/ReviewedBy/AuthorizedBy on
      // every receipt page too, so whoever is flipping through printed
      // receipts doesn't have to page back to the summary table to see who
      // signed off — ApprovedBy is always present (a prerequisite of both
      // exportable statuses), ReviewedBy likewise, AuthorizedBy only once
      // actually Disbursed.
      var approverParts = ['Approved by ' + req.ApprovedBy];
      if (req.ReviewedBy) approverParts.push('Reviewed by ' + req.ReviewedBy);
      if (req.AuthorizedBy) approverParts.push('Authorized by ' + req.AuthorizedBy);
      var item = {
        caption: req.RequestID + ' — ' + req.EmployeeName + ' — ' +
          formatLineDateDisplay_(line) + ' — ' + line.Category + amountCaption,
        approvers: approverParts.join(' · '),
        url: driveThumbnailUrl_(line.ReceiptFileURL)
      };
      // Timesheet receipts stay in the 2-per-page fareItems bucket — a
      // full-page reference document suits that legible layout better than
      // the 6-up grid meant for small allowance slips.
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
      '<p class="receipt-approvers">' + escapeHtml_(item.approvers) + '</p>' +
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
    // Letter is 215.9mm x 279.4mm; with 12mm margins the printable content
    // area is ~255mm tall. A fixed physical height here (not the old
    // "min-height: 90vh", a viewport unit meaningless once printed) is what
    // lets the 2-up/6-up children's "height: 100%" resolve to something real
    // instead of collapsing to auto content height — that collapse was the
    // actual cause of receipts not fitting/scaling to exactly 2 or 6 per page.
    // Letter content height after 12mm margins is ~255mm. Chrome/Firefox's
    // print engine does NOT reliably resolve a flex/grid child's percentage
    // height against print pages (this was tried first and still produced
    // 1 receipt per page instead of 2/6 — confirmed by the user) — so every
    // cell below gets an explicit millimeter height computed from that fixed
    // page height instead of relying on height:100% cascading through
    // flex-grow/1fr rows. This is deterministic across browsers because it
    // never depends on the parent's box being "definite" for percentage
    // resolution during pagination.
    '.receipt-page { page-break-before: always; padding-top: 3mm; box-sizing: border-box; }' +
    '.receipt-caption { font-weight: bold; font-size: 12px; margin-bottom: 2px; }' +
    '.receipt-approvers { font-size: 9px; color: #64748b; margin: 0 0 4px; }' +
    '.receipt-page-2up { display: flex; flex-direction: column; gap: 4mm; }' +
    '.receipt-page-2up .receipt-cell { height: 124mm; display: flex; flex-direction: column; min-height: 0; border: 1px solid #cbd5e1; padding: 6px; box-sizing: border-box; page-break-inside: avoid; }' +
    '.receipt-page-2up .receipt-cell img { flex: 1 1 auto; min-height: 0; max-width: 100%; max-height: 100%; object-fit: contain; display: block; margin: 0 auto; }' +
    '.receipt-page-6up { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(3, 82mm); gap: 3mm; }' +
    '.receipt-page-6up .receipt-cell { height: 82mm; display: flex; flex-direction: column; min-height: 0; border: 1px solid #cbd5e1; padding: 6px; box-sizing: border-box; page-break-inside: avoid; }' +
    '.receipt-page-6up .receipt-caption { font-size: 9px; margin-bottom: 2px; }' +
    '.receipt-page-6up .receipt-approvers { font-size: 7px; margin-bottom: 3px; }' +
    '.receipt-page-6up .receipt-cell img { flex: 1 1 auto; min-height: 0; max-width: 100%; max-height: 100%; object-fit: contain; display: block; margin: 0 auto; }' +
    '.grand-total-row td { border-top: 2px solid #1e3a5f; }' +
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
    '</tr></thead><tbody>' + summaryRows + '</tbody>' + grandTotalRow + '</table>' +
    receiptPagesHtml +
    missingHtml +
    '</body></html>';
}

// ---- "Submission Exemption" tab — Authorizer-only. Search an employee,
// grant them a 1-hour bypass of the Thu/Fri submission block (ExemptionService.gs),
// and see/revoke everyone currently exempted. ----

var exemptionCountdownTimer_ = null;
var exemptionActiveRows_ = []; // last-fetched active list, re-rendered each countdown tick

function initExemptionsTab_() {
  var searchInput = $('exemption-employee-search');
  var searchTimer = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    var query = searchInput.value.trim();
    if (!query) {
      $('exemption-search-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(function () { searchExemptionEmployees_(query); }, 300);
  });
}

// Uses the CSV-based employee search (common.js's searchEmployeesFromCsv_)
// instead of the Apps Script action searchEmployeesForUtility — the latter
// round-trips through Apps Script's GET/redirect/echo-content-URL dance and
// re-reads the whole Employees sheet, uncached, on every keystroke, which was
// the actual source of the visible lag while typing here. The CSV read is
// fetched once per page session and cached (loadEmployeesCsv_), so every
// subsequent keystroke is a local filter with no network round trip at all.
function searchExemptionEmployees_(query) {
  searchEmployeesFromCsv_(query)
    .then(renderExemptionSearchResults_)
    .catch(function () { $('exemption-search-results').innerHTML = ''; });
}

function renderExemptionSearchResults_(results) {
  var container = $('exemption-search-results');
  if (!results.length) {
    container.innerHTML = '<p class="muted">No matching employees.</p>';
    return;
  }
  container.innerHTML = '<div class="exemption-search-results">' +
    results.map(function (emp) {
      return '<div class="exemption-result-row" data-employee-id="' + escapeHtml_(emp.EmployeeID) + '">' +
        '<span>' + escapeHtml_(emp.Name) + '</span>' +
        '<span class="muted">' + escapeHtml_(emp.EmployeeID) + '</span>' +
        '</div>';
    }).join('') + '</div>';

  container.querySelectorAll('.exemption-result-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var empId = row.getAttribute('data-employee-id');
      var empName = row.querySelector('span').textContent;
      grantExemptionFor_(empId, empName);
    });
  });
}

function grantExemptionFor_(employeeId, employeeName) {
  var errorEl = $('exemption-grant-error');
  var successEl = $('exemption-grant-success');
  clearMessage(errorEl);
  clearMessage(successEl);

  if (!ensureApproverPassword_()) return; // cancelled

  runServer('grantSubmissionExemption', employeeId, currentApprover.userId, currentApprover.password)
    .then(function (result) {
      if (!result.success) {
        currentApprover.password = null; // can't tell if the password was the problem — re-prompt next time
        setMessage(errorEl, result.error, true);
        return;
      }
      setMessage(successEl, employeeName + ' may now submit until ' + formatTimeDisplay(result.expiresAt) + '.', false);
      $('exemption-employee-search').value = '';
      $('exemption-search-results').innerHTML = '';
      loadActiveExemptions();
    })
    .catch(function (err) {
      currentApprover.password = null;
      setMessage(errorEl, err.message, true);
    });
}

function loadActiveExemptions() {
  var container = $('exemption-active-list');
  runServer('getActiveSubmissionExemptions')
    .then(function (rows) {
      exemptionActiveRows_ = rows;
      renderActiveExemptions_();
      startExemptionCountdown_();
    })
    .catch(function (err) {
      container.innerHTML = '<div class="msg msg-error" role="alert">' + MSG_ICON_ERROR + '<span>Failed to load: ' + err.message + '</span></div>';
    });
}

function renderActiveExemptions_() {
  var container = $('exemption-active-list');
  if (!exemptionActiveRows_.length) {
    container.innerHTML = '<p class="muted">No active exemptions right now.</p>';
    return;
  }
  container.innerHTML = exemptionActiveRows_.map(function (row) {
    var remainingMs = new Date(row.ExpiresAt).getTime() - Date.now();
    return '<div class="exemption-active-row" data-exemption-id="' + escapeHtml_(row.ExemptionID) + '">' +
      '<div><span class="name">' + escapeHtml_(row.EmployeeName) + '</span> ' +
      '<span class="muted">(' + escapeHtml_(row.EmployeeID) + ')</span><br>' +
      '<span class="muted">Granted by ' + escapeHtml_(row.GrantedBy) + '</span></div>' +
      '<span class="exemption-countdown">' + formatCountdown_(remainingMs) + '</span>' +
      '<button class="btn btn-danger btn-solid btn-small" type="button">Revoke</button>' +
      '</div>';
  }).join('');

  container.querySelectorAll('.exemption-active-row').forEach(function (rowEl) {
    rowEl.querySelector('button').addEventListener('click', function () {
      revokeExemption_(rowEl.getAttribute('data-exemption-id'));
    });
  });
}

function revokeExemption_(exemptionId) {
  var errorEl = $('exemption-grant-error');
  clearMessage(errorEl);
  if (!ensureApproverPassword_()) return; // cancelled

  runServer('revokeSubmissionExemption', exemptionId, currentApprover.userId, currentApprover.password)
    .then(function (result) {
      if (!result.success) {
        currentApprover.password = null;
        setMessage(errorEl, result.error, true);
        return;
      }
      loadActiveExemptions();
    })
    .catch(function (err) {
      currentApprover.password = null;
      setMessage(errorEl, err.message, true);
    });
}

// Purely cosmetic ticking display — never writes anything, and a row it
// misses by a beat is still caught by the server's own lazy ExpiresAt check
// on the next real read. 30s is plenty granular for a 1-hour window.
function formatCountdown_(remainingMs) {
  if (remainingMs <= 0) return 'Expired';
  var totalMinutes = Math.floor(remainingMs / 60000);
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  return (hours > 0 ? hours + 'h ' : '') + minutes + 'm left';
}

function startExemptionCountdown_() {
  stopExemptionCountdown_();
  exemptionCountdownTimer_ = setInterval(function () {
    var stillActive = exemptionActiveRows_.filter(function (row) {
      return new Date(row.ExpiresAt).getTime() - Date.now() > 0;
    });
    if (stillActive.length !== exemptionActiveRows_.length) {
      exemptionActiveRows_ = stillActive; // let an expired row quietly drop off the visible list
    }
    renderActiveExemptions_();
  }, 30000);
}

function stopExemptionCountdown_() {
  if (exemptionCountdownTimer_) {
    clearInterval(exemptionCountdownTimer_);
    exemptionCountdownTimer_ = null;
  }
}

function initExportButtons_() {
  $('btn-export-csv').addEventListener('click', handleExportCsvClick_);
  $('btn-export-report').addEventListener('click', handleExportReportClick_);
}

// CSV-based read path (see loadJoinedRequests_ in common.js) instead of a
// live getAllRequestsForPayroll call — Reviewed/Authorized are never
// Pending-routing-scoped anyway (same as the server), so no client-side
// scoping logic is needed here, just a plain status filter.
function fetchExportableRequests_() {
  return loadJoinedRequests_().then(function (all) {
    return all.filter(function (req) {
      return req.Status === 'Reviewed' || req.Status === 'Authorized';
    });
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

