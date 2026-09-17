/**
 * Core liquidation request business logic.
 */

// Split into 3 phases to keep the shared script-wide LockService lock held for
// as little time as possible — Drive receipt uploads are slow external API
// calls, and prior to this split they ran *inside* the lock, blocking every
// other queued submit/approve/reject/exemption action (all 5 mutation entry
// points in this app share one LockService.getScriptLock()). Phases 1 and 3
// each do only fast, local (PropertiesService/Sheet) work under the lock;
// Phase 2's Drive I/O runs unlocked in between.
function submitLiquidationRequest(payload) {
  var validationError = validateSubmission_(payload);
  if (validationError) {
    return { success: false, error: validationError };
  }

  var employeeResult = getEmployeeByID(payload.employeeId);
  var employee = employeeResult.employee;

  // Phase 1 (short lock): only sequential ID generation (a fast
  // PropertiesService read-increment-write, see IdGenerator.gs) — resolved
  // now so Phase 2's Drive folders still land at the normal
  // <EmployeeID>/<RequestID>/ path.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }
  var requestId;
  try {
    requestId = generateRequestId_();
  } finally {
    lock.releaseLock();
  }

  // Phase 2 (no lock): receipt uploads to Drive happen here, unlocked.
  var now = new Date();
  var totalAmount = 0;
  var lineRows;
  try {
    lineRows = payload.lines.map(function (line, index) {
      var lineId = generateLineId_(requestId, index);
      var receiptUrl = '';

      if (line.receiptUrl) {
        // Pre-existing URL (e.g. an attendance photo link from the Meal
        // Allowance utility) — stored directly, no Drive upload needed.
        receiptUrl = line.receiptUrl;
      } else if (line.file) {
        receiptUrl = uploadReceiptFile_(employee.EmployeeID, requestId, lineId, line.file);
      }

      var amount = Number(line.amount);
      totalAmount += amount;

      return {
        LineID: lineId,
        RequestID: requestId,
        Date: line.date,
        Category: line.category,
        BaseLocation: line.baseLocation,
        Amount: amount,
        Description: line.description,
        ReceiptFileURL: receiptUrl,
        GpsMapLink: line.gpsMapLink || '',
        CutoffEndDate: line.cutoffEndDate || ''
      };
    });
  } catch (e) {
    return { success: false, error: 'Submission failed: ' + e.message };
  }

  // Phase 3 (short lock again): only the Sheet writes. If this fails after
  // Phase 2's uploads already succeeded, the uploaded file(s) are orphaned in
  // Drive (unreferenced by any row) — an accepted tradeoff, not a bug: this
  // is an internal tool with no test suite, this step has no external calls
  // so failures here are rare, and adding upload-rollback would add more
  // Drive API surface to reason about for a very rare failure path.
  var lock2 = LockService.getScriptLock();
  try {
    lock2.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    lineRows.forEach(function (row) {
      appendRowFromObject_(SHEET_REQUEST_LINES, row);
    });

    appendRowFromObject_(SHEET_REQUESTS, {
      RequestID: requestId,
      EmployeeID: employee.EmployeeID,
      EmployeeName: employee.Name,
      DateSubmitted: now,
      Status: STATUS_PENDING,
      TotalAmount: totalAmount,
      Remarks: ''
    });

    SpreadsheetApp.flush();
    return { success: true, requestId: requestId };
  } catch (e) {
    return { success: false, error: 'Submission failed: ' + e.message };
  } finally {
    lock2.releaseLock();
  }
}

function getMyRequests(employeeId) {
  return buildRequestsWithLines_(function (req) {
    return String(req.EmployeeID) === String(employeeId);
  });
}

// approverBiometricId is optional — when provided, Pending requests are
// further filtered to only the ones this specific approver is actually
// meant to act on (mirrors advanceRequestStage's category-based routing via
// StoreDirectoryService.gs's resolveRequiredApprover_), so an Approver
// logged in for e.g. Cris's Technical queue doesn't see requests meant for
// Jayriel's Area Head queue or a per-store Area Head's own queue. Approved/
// Reviewed/etc. rows are never filtered by this — Reviewer/Authorizer stay
// unscoped, same as advanceRequestStage. A request whose required approver
// can't be resolved (directory unreachable, unmapped employee) is still
// shown to everyone — same fail-open fallback used at write time.
function getAllRequestsForPayroll(statusFilter, approverBiometricId) {
  var employeesById = null;
  var firstLineLocationByRequestId = null;
  if (approverBiometricId) {
    employeesById = {};
    getAllRowsAsObjects_(SHEET_EMPLOYEES).forEach(function (emp) {
      employeesById[String(emp.EmployeeID)] = emp;
    });

    // First matching row per RequestID wins — SHEET_REQUEST_LINES rows are
    // appended in submission order, so this is that request's first line item.
    firstLineLocationByRequestId = {};
    getAllRowsAsObjects_(SHEET_REQUEST_LINES).forEach(function (line) {
      var rid = String(line.RequestID);
      if (!(rid in firstLineLocationByRequestId)) {
        firstLineLocationByRequestId[rid] = line.BaseLocation;
      }
    });
  }

  return buildRequestsWithLines_(function (req) {
    if (statusFilter && statusFilter !== 'All' && req.Status !== statusFilter) return false;

    if (req.Status === STATUS_PENDING && approverBiometricId) {
      var emp = employeesById[String(req.EmployeeID)] || {};
      var lineLocation = firstLineLocationByRequestId[String(req.RequestID)] || '';
      var required = resolveRequiredApprover_(req.EmployeeID, emp.BaseLocation, emp.Department, lineLocation);
      if (required.found) {
        var requiredBioId = String(required.bioId || '').trim().toLowerCase();
        var approverBio = String(approverBiometricId || '').trim().toLowerCase();
        if (requiredBioId !== approverBio) return false;
      }
    }

    return true;
  });
}

// Used by advanceRequestStage's routing check for a single request — the
// batch equivalent (getAllRequestsForPayroll above) fetches all lines once
// instead of calling this per row.
function getFirstLineBaseLocation_(requestId) {
  var lines = getAllRowsAsObjects_(SHEET_REQUEST_LINES).filter(function (line) {
    return String(line.RequestID) === String(requestId);
  });
  return lines.length ? lines[0].BaseLocation : '';
}

function buildRequestsWithLines_(requestFilterFn) {
  var requests = getAllRowsAsObjects_(SHEET_REQUESTS).filter(requestFilterFn);
  var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES);

  requests.sort(function (a, b) {
    return new Date(b.DateSubmitted) - new Date(a.DateSubmitted);
  });

  return requests.map(function (req) {
    var lines = allLines.filter(function (line) {
      return String(line.RequestID) === String(req.RequestID);
    });
    var copy = {};
    Object.keys(req).forEach(function (k) { copy[k] = req[k]; });
    copy.lines = lines;
    return copy;
  });
}

var STAGE_FIELD_NAMES = {
  Approved: { by: 'ApprovedBy', date: 'ApprovedDate' },
  Reviewed: { by: 'ReviewedBy', date: 'ReviewedDate' },
  Authorized: { by: 'AuthorizedBy', date: 'AuthorizedDate' },
  Rejected: { by: 'RejectedBy', date: 'RejectedDate' }
};

// The role permitted to act (advance the next stage, or reject) while a
// request sits in a given current status.
var REQUIRED_ROLE_BY_STATUS = {
  Pending: ROLE_APPROVER,
  Approved: ROLE_REVIEWER,
  Reviewed: ROLE_AUTHORIZER
};

// Display wording for the Remarks running log — kept separate from the
// internal STATUS_* values (Config.gs) so the terminal "Authorized" stage
// reads as "Disbursed" to users without touching STAGE_ORDER/Sheet data.
var STAGE_DISPLAY_LABEL = {
  Approved: 'Approved',
  Reviewed: 'Reviewed',
  Authorized: 'Disbursed',
  Rejected: 'Rejected'
};

// Crediting happens weekly on Fridays: the Friday of the current Mon-Sun
// week, or if today is already past that Friday (Sat/Sun), the next one.
function computeNextCreditingFriday_() {
  var today = new Date();
  var mondayIndex = (today.getDay() + 6) % 7; // Mon=0 ... Sun=6
  var daysUntilFriday = 4 - mondayIndex; // Fri=4 in Monday-indexed week
  if (daysUntilFriday < 0) daysUntilFriday += 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilFriday);
}

// The submission window reopens every Saturday (see Validation.gs's
// submissionWindowError_) — this is the Saturday of the current Mon-Sun
// week, or next week's if today is already past it (Sun and Mon-Wed, since
// those days are actually inside the window; only called when computing a
// reopen date to show alongside a Thu/Fri "closed" message).
function computeNextSubmissionOpenSaturday_() {
  var today = new Date();
  var mondayIndex = (today.getDay() + 6) % 7; // Mon=0 ... Sun=6
  var daysUntilSaturday = 5 - mondayIndex; // Sat=5 in Monday-indexed week
  if (daysUntilSaturday < 0) daysUntilSaturday += 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntilSaturday);
}

function advanceRequestStage(requestId, targetStage, userId, password, remark) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  var actorName = approverResult.fullName;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var rowIndex = findRowIndexById_(SHEET_REQUESTS, 'RequestID', requestId);
    if (rowIndex === -1) {
      return { success: false, error: 'Request not found.' };
    }

    var sheet = getSheet_(SHEET_REQUESTS);
    var headerMap = getHeaderMap_(sheet);
    var currentStatus = sheet.getRange(rowIndex, headerMap['Status'] + 1).getValue();

    var transitionError = validateStageTransition_(currentStatus, targetStage);
    if (transitionError) {
      return { success: false, error: transitionError };
    }

    var requiredRole = REQUIRED_ROLE_BY_STATUS[currentStatus];
    if (approverResult.role !== requiredRole) {
      return { success: false, error: 'This action requires the ' + requiredRole + ' role.' };
    }

    // Pending requests route to a specific approver based on the submitting
    // employee's own category (Area Head/Technical/Audit each have one fixed
    // approver; plain Staff route to their own store's Area Head) — see
    // StoreDirectoryService.gs. If it can't be resolved (directory
    // unreachable, or a Staff employee whose store isn't listed), this
    // falls back to the role-only check already passed above.
    if (currentStatus === STATUS_PENDING) {
      var employeeId = sheet.getRange(rowIndex, headerMap['EmployeeID'] + 1).getValue();
      var employeeInfo = getEmployeeRoutingInfo_(employeeId);
      var lineLocation = getFirstLineBaseLocation_(requestId);
      var required = resolveRequiredApprover_(employeeId, employeeInfo.baseLocation, employeeInfo.department, lineLocation);
      if (required.found) {
        var approverBioId = String(approverResult.biometricId || '').trim().toLowerCase();
        var requiredBioId = String(required.bioId || '').trim().toLowerCase();
        if (!approverBioId || approverBioId !== requiredBioId) {
          return { success: false, error: 'This request must be approved by ' + required.name + '.' };
        }
      }
    }

    var fieldNames = STAGE_FIELD_NAMES[targetStage];
    var existingRemarks = sheet.getRange(rowIndex, headerMap['Remarks'] + 1).getValue();
    var remarkLine = STAGE_DISPLAY_LABEL[targetStage] + ' by ' + actorName + (remark ? ': ' + remark : '');
    var updatedRemarks = existingRemarks ? existingRemarks + '\n' + remarkLine : remarkLine;

    var fields = { Status: targetStage, Remarks: updatedRemarks };
    fields[fieldNames.by] = actorName;
    fields[fieldNames.date] = new Date();

    if (targetStage === STATUS_AUTHORIZED) {
      fields['CreditingDate'] = computeNextCreditingFriday_();
    }

    updateRowFields_(SHEET_REQUESTS, rowIndex, fields);

    return { success: true };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Lets the Approver/Reviewer currently allowed to act on a request correct a
// line item's Amount before advancing it — e.g. a typo caught during review.
// Reuses every guard advanceRequestStage already has (role check, the
// Pending-stage category/store routing check, script locking) rather than
// inventing separate authorization logic for a second mutation path.
function updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  var actorName = approverResult.fullName;

  var amount = Number(newAmount);
  if (!amount || amount <= 0) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var requestRowIndex = findRowIndexById_(SHEET_REQUESTS, 'RequestID', requestId);
    if (requestRowIndex === -1) {
      return { success: false, error: 'Request not found.' };
    }

    var requestSheet = getSheet_(SHEET_REQUESTS);
    var requestHeaderMap = getHeaderMap_(requestSheet);
    var currentStatus = requestSheet.getRange(requestRowIndex, requestHeaderMap['Status'] + 1).getValue();

    var requiredRole = REQUIRED_ROLE_BY_STATUS[currentStatus];
    if (!requiredRole) {
      return { success: false, error: 'This request can no longer be edited.' };
    }
    if (approverResult.role !== requiredRole) {
      return { success: false, error: 'This action requires the ' + requiredRole + ' role.' };
    }

    // Same category/store routing check advanceRequestStage performs for the
    // Pending stage — only the specific required Approver can edit amounts
    // on a Pending request, not just any Approver-role account.
    if (currentStatus === STATUS_PENDING) {
      var employeeId = requestSheet.getRange(requestRowIndex, requestHeaderMap['EmployeeID'] + 1).getValue();
      var employeeInfo = getEmployeeRoutingInfo_(employeeId);
      var lineLocation = getFirstLineBaseLocation_(requestId);
      var required = resolveRequiredApprover_(employeeId, employeeInfo.baseLocation, employeeInfo.department, lineLocation);
      if (required.found) {
        var approverBioId = String(approverResult.biometricId || '').trim().toLowerCase();
        var requiredBioId = String(required.bioId || '').trim().toLowerCase();
        if (!approverBioId || approverBioId !== requiredBioId) {
          return { success: false, error: 'Only ' + required.name + ' can edit amounts on this request.' };
        }
      }
    }

    var lineRowIndex = findRowIndexById_(SHEET_REQUEST_LINES, 'LineID', lineId);
    if (lineRowIndex === -1) {
      return { success: false, error: 'Line item not found.' };
    }

    var lineSheet = getSheet_(SHEET_REQUEST_LINES);
    var lineHeaderMap = getHeaderMap_(lineSheet);
    var lineRequestId = lineSheet.getRange(lineRowIndex, lineHeaderMap['RequestID'] + 1).getValue();
    if (String(lineRequestId) !== String(requestId)) {
      return { success: false, error: 'Line item not found.' };
    }

    var oldAmount = Number(lineSheet.getRange(lineRowIndex, lineHeaderMap['Amount'] + 1).getValue()) || 0;
    var category = lineSheet.getRange(lineRowIndex, lineHeaderMap['Category'] + 1).getValue();

    updateRowFields_(SHEET_REQUEST_LINES, lineRowIndex, { Amount: amount });

    var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES).filter(function (line) {
      return String(line.RequestID) === String(requestId);
    });
    var newTotal = allLines.reduce(function (sum, line) { return sum + (Number(line.Amount) || 0); }, 0);

    var existingRemarks = requestSheet.getRange(requestRowIndex, requestHeaderMap['Remarks'] + 1).getValue();
    var remarkLine = 'Amount edited by ' + actorName + ': ' + oldAmount.toFixed(2) + ' → ' + amount.toFixed(2) +
      ' (' + category + ' line)' + (remark ? ' — ' + remark : '');
    var updatedRemarks = existingRemarks ? existingRemarks + '\n' + remarkLine : remarkLine;

    updateRowFields_(SHEET_REQUESTS, requestRowIndex, { TotalAmount: newTotal, Remarks: updatedRemarks });

    return { success: true, newAmount: amount, newTotalAmount: newTotal };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}
