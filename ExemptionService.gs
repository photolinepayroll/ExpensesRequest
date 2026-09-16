/**
 * Authorizer-only emergency exemption from the Thu/Fri submission window
 * (see Validation.gs's submissionWindowError_). An exemption is a row in the
 * SubmissionExemptions sheet, valid for exactly 1 hour from the moment it's
 * granted, checked lazily (ExpiresAt vs. Date.now()) wherever it matters —
 * there is no cron/trigger, nothing "closes" it automatically except the
 * next read simply no longer counting it as active. Revoke is a soft update
 * (RevokedBy/RevokedDate), never a row delete, so this sheet doubles as a
 * full audit trail of every grant and revoke.
 */

// Shared "is this row still active" rule, used by every read/write below.
function isExemptionRowActive_(row, nowMs) {
  return !row.RevokedDate && new Date(row.ExpiresAt).getTime() > nowMs;
}

// Internal lookup shared by Validation.gs's gate and the employee-side check
// action. Returns the active row object for this employee, or null.
function getActiveExemptionForEmployee_(employeeId) {
  var now = Date.now();
  var active = getAllRowsAsObjects_(SHEET_SUBMISSION_EXEMPTIONS).filter(function (row) {
    return String(row.EmployeeID) === String(employeeId) && isExemptionRowActive_(row, now);
  });
  if (!active.length) return null;
  // Defensive: re-grant is supposed to replace, so there should only ever be
  // one, but if more than one somehow exists, prefer the latest-expiring.
  active.sort(function (a, b) { return new Date(b.ExpiresAt) - new Date(a.ExpiresAt); });
  return active[0];
}

// Soft-revokes every currently-active row for one employee. Shared by the
// re-grant "replace" step in grantSubmissionExemption and by the standalone
// manual revoke below. Iterates the sheet directly (not
// getAllRowsAsObjects_) since it needs real row indices to write back.
function revokeAllActiveForEmployee_(employeeId, actorName, now) {
  var sheet = getSheet_(SHEET_SUBMISSION_EXEMPTIONS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var headerMap = getHeaderMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var nowMs = now.getTime();

  rows.forEach(function (rowValues, i) {
    var row = {};
    Object.keys(headerMap).forEach(function (header) {
      row[header] = rowValues[headerMap[header]];
    });
    if (String(row.EmployeeID) === String(employeeId) && isExemptionRowActive_(row, nowMs)) {
      updateRowFields_(SHEET_SUBMISSION_EXEMPTIONS, i + 2, {
        RevokedBy: actorName,
        RevokedDate: now
      });
    }
  });
}

// Grants (or re-grants, replacing any existing active exemption) a 1-hour
// submission-window exemption to one employee. Authorizer-only.
function grantSubmissionExemption(employeeId, userId, password) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  if (approverResult.role !== ROLE_AUTHORIZER) {
    return { success: false, error: 'This action requires the ' + ROLE_AUTHORIZER + ' role.' };
  }

  var employeeResult = getEmployeeByID(employeeId);
  if (!employeeResult.found) {
    return { success: false, error: 'Employee is invalid or inactive: ' + employeeResult.error };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var now = new Date();
    // Re-grant = replace: soft-revoke any existing active row for this
    // employee first, so getActiveExemptionForEmployee_ never sees two
    // "active" rows for the same person at once.
    revokeAllActiveForEmployee_(employeeId, approverResult.fullName, now);

    var exemptionId = generateExemptionId_();
    var expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // exactly 1 hour

    appendRowFromObject_(SHEET_SUBMISSION_EXEMPTIONS, {
      ExemptionID: exemptionId,
      EmployeeID: employeeResult.employee.EmployeeID,
      EmployeeName: employeeResult.employee.Name,
      GrantedBy: approverResult.fullName,
      GrantedDate: now,
      ExpiresAt: expiresAt,
      RevokedBy: '',
      RevokedDate: ''
    });

    return { success: true, exemptionId: exemptionId, expiresAt: expiresAt.toISOString() };
  } catch (e) {
    return { success: false, error: 'Grant failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Manually revokes one specific exemption by ID before it naturally expires.
// Authorizer-only.
function revokeSubmissionExemption(exemptionId, userId, password) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  if (approverResult.role !== ROLE_AUTHORIZER) {
    return { success: false, error: 'This action requires the ' + ROLE_AUTHORIZER + ' role.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var rowIndex = findRowIndexById_(SHEET_SUBMISSION_EXEMPTIONS, 'ExemptionID', exemptionId);
    if (rowIndex === -1) {
      return { success: false, error: 'Exemption not found.' };
    }

    updateRowFields_(SHEET_SUBMISSION_EXEMPTIONS, rowIndex, {
      RevokedBy: approverResult.fullName,
      RevokedDate: new Date()
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Revoke failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Read-only: every currently-active exemption, soonest-expiring first.
// Powers the Authorizer's live list. No credential gate — a plain read, same
// openness as getAllRequestsForPayroll (see CLAUDE.md's security-model note).
function getActiveSubmissionExemptions() {
  var now = Date.now();
  return getAllRowsAsObjects_(SHEET_SUBMISSION_EXEMPTIONS)
    .filter(function (row) { return isExemptionRowActive_(row, now); })
    .map(function (row) {
      return {
        ExemptionID: row.ExemptionID,
        EmployeeID: row.EmployeeID,
        EmployeeName: row.EmployeeName,
        GrantedBy: row.GrantedBy,
        GrantedDate: row.GrantedDate,
        ExpiresAt: row.ExpiresAt
      };
    })
    .sort(function (a, b) { return new Date(a.ExpiresAt) - new Date(b.ExpiresAt); });
}

// Read-only, lightweight: does this employee currently have an active
// exemption? Powers the employee-side New Request banner/Submit-button mirror.
function checkMySubmissionExemption(employeeId) {
  var active = getActiveExemptionForEmployee_(employeeId);
  return active ? { exempt: true, expiresAt: active.ExpiresAt } : { exempt: false };
}
