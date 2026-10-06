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
// Idempotency: a slow submission (Phase 2's Drive upload in particular) can
// outlast the client's fetch timeout, causing the frontend's retry layer to
// resend an identical POST while the original call is still running or has
// already finished server-side (aborting the client fetch does not cancel
// the Apps Script execution). Without a dedupe key, each retry would create
// its own fully independent request row. `clientRequestId` — generated once
// per submit click and reused unchanged across the frontend's own retries —
// lets us collapse those into a single result via CacheService, the same
// primitive StoreDirectoryService.gs already uses for caching.
var SUBMIT_DEDUPE_CACHE_PREFIX_ = 'submitdedupe_';
var SUBMIT_DEDUPE_IN_PROGRESS_ = 'IN_PROGRESS';
var SUBMIT_DEDUPE_RESULT_TTL_SECONDS_ = 3600; // 1 hour — comfortably covers any retry storm
var SUBMIT_DEDUPE_MARKER_TTL_SECONDS_ = 21600; // CacheService's max (6h)
var SUBMIT_DEDUPE_POLL_INTERVAL_MS_ = 1500;
var SUBMIT_DEDUPE_POLL_ATTEMPTS_ = 20; // ~30s total — gives a same-clientRequestId retry more
                                        // room to catch a slow original call finishing, before
                                        // falling back to the content-based check below

// A same-clientRequestId retry only catches an automatic frontend retry of
// the *same* submit click. A user manually clicking Submit again after
// seeing "System is busy" (form still filled in, see frontend/employee.js's
// proceedWithSubmit_) mints a brand-new clientRequestId, which bypasses the
// cache above entirely. This second, content-based check is the real
// safety net: right before writing (Phase 3, under lock2, so it's
// serialized against every other concurrent submit the same way the rest of
// this app already is), look for an existing Pending request from the same
// employee, submitted recently, whose lines match — and coalesce into it
// instead of appending a duplicate row. See findRecentDuplicateRequest_.
// The reference "now" for this window is the Phase-2-start timestamp (before
// this call's own Drive uploads), not a fresh timestamp at check-time — a
// multi-receipt submission's own upload time would otherwise silently eat
// into the window before the check even runs (confirmed live: an 11-receipt
// resubmit 171s after the original slipped past the old check because its
// own upload phase pushed the actual check past 180s).
var DUPLICATE_SUBMIT_WINDOW_MS_ = 300000; // 5 minutes

/** Normalizes one line's comparable fields into a single string key, insensitive to
 * whether Date arrives as a Sheet-read Date object or a payload date string. */
function buildLineSignatureKey_(line) {
  var dateValue = line.Date || line.date;
  var dateKey = (dateValue instanceof Date)
    ? Utilities.formatDate(dateValue, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : String(dateValue || '').trim();
  var amount = Number(line.Amount != null ? line.Amount : line.amount);
  return [
    dateKey,
    String(line.Category || line.category || '').trim(),
    String(line.BaseLocation || line.baseLocation || '').trim(),
    amount.toFixed(2),
    String(line.Description || line.description || '').trim()
  ].join('|');
}

/** Order-independent signature for a whole request's line items. */
function buildLineSignature_(lines) {
  return lines.map(buildLineSignatureKey_).sort().join(';;');
}

/**
 * Content-based fallback dedupe: catches a genuine manual resubmit (a fresh
 * clientRequestId, so the CacheService check above never sees it) by looking
 * for an existing Pending request from the same employee, submitted within
 * DUPLICATE_SUBMIT_WINDOW_MS_, whose line items match. Returns the existing
 * RequestID, or null if no match is found.
 * @param {number} referenceTimeMs Timestamp to measure the window from —
 *   pass the caller's Phase-2-start time (captured before its own Drive
 *   uploads), not a fresh check-time timestamp, so the current submission's
 *   own upload duration doesn't silently shrink the window.
 */
function findRecentDuplicateRequest_(employeeId, lineRows, referenceTimeMs) {
  var incomingSignature = buildLineSignature_(lineRows);
  var now = referenceTimeMs;

  var candidateRequests = getAllRowsAsObjects_(SHEET_REQUESTS).filter(function (req) {
    if (String(req.EmployeeID) !== String(employeeId)) return false;
    if (req.Status !== STATUS_PENDING) return false;
    var submitted = req.DateSubmitted instanceof Date ? req.DateSubmitted.getTime() : new Date(req.DateSubmitted).getTime();
    return (now - submitted) >= 0 && (now - submitted) <= DUPLICATE_SUBMIT_WINDOW_MS_;
  });
  if (!candidateRequests.length) return null;

  var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES);
  for (var i = 0; i < candidateRequests.length; i++) {
    var candidateId = candidateRequests[i].RequestID;
    var candidateLines = allLines.filter(function (l) { return l.RequestID === candidateId; });
    if (candidateLines.length !== lineRows.length) continue;
    if (buildLineSignature_(candidateLines) === incomingSignature) {
      return candidateId;
    }
  }
  return null;
}

function getSubmitDedupeResult_(cache, key) {
  var cached = cache.get(key);
  if (cached && cached !== SUBMIT_DEDUPE_IN_PROGRESS_) {
    return JSON.parse(cached);
  }
  return null;
}

function submitLiquidationRequest(payload) {
  var cache = CacheService.getScriptCache();
  var dedupeKey = payload.clientRequestId ? SUBMIT_DEDUPE_CACHE_PREFIX_ + payload.clientRequestId : null;

  if (dedupeKey) {
    var alreadyDone = getSubmitDedupeResult_(cache, dedupeKey);
    if (alreadyDone) return alreadyDone;
  }

  validatedEmployee_ = null;
  var validationError = validateSubmission_(payload);
  if (validationError) {
    return { success: false, error: validationError };
  }
  timeStep_('submit: validated');

  var employee = validatedEmployee_ || getEmployeeByID(payload.employeeId).employee;

  // A request ID reserved earlier by reserveRequestId (the outbox flow: receipts were already uploaded
  // one photo at a time into that request's folder) — must belong to this same employee.
  var reservedRequestId = payload.requestId ? String(payload.requestId) : '';
  if (reservedRequestId && !getReservation_(reservedRequestId, employee.EmployeeID)) {
    return { success: false, error: 'This request ID was not reserved for this employee (or the reservation expired) — please resubmit.' };
  }

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
  timeStep_('submit: phase 1 lock acquired');
  var requestId;
  var awaitDedupeResult = false;
  try {
    if (dedupeKey) {
      var cachedInLock = cache.get(dedupeKey);
      if (cachedInLock === SUBMIT_DEDUPE_IN_PROGRESS_) {
        // A duplicate retry landed while the original call (for this same
        // clientRequestId) is still running — don't start a second copy of
        // the work, wait for the original to publish its result instead.
        awaitDedupeResult = true;
      } else if (cachedInLock) {
        return JSON.parse(cachedInLock);
      } else {
        cache.put(dedupeKey, SUBMIT_DEDUPE_IN_PROGRESS_, SUBMIT_DEDUPE_MARKER_TTL_SECONDS_);
      }
    }
    if (!awaitDedupeResult) {
      requestId = reservedRequestId || generateRequestId_();
    }
  } finally {
    lock.releaseLock();
  }

  if (awaitDedupeResult) {
    for (var attempt = 0; attempt < SUBMIT_DEDUPE_POLL_ATTEMPTS_; attempt++) {
      Utilities.sleep(SUBMIT_DEDUPE_POLL_INTERVAL_MS_);
      var polled = getSubmitDedupeResult_(cache, dedupeKey);
      if (polled) return polled;
    }
    // Original call still hasn't finished — ask the client to back off and
    // retry, the same shape it already knows how to handle; by the time it
    // does, the result should be cached and will be replayed instead of
    // creating a new request.
    return { success: false, error: 'System is busy, please try again.' };
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
    if (dedupeKey) cache.remove(dedupeKey);
    return { success: false, error: 'Submission failed: ' + e.message };
  }

  timeStep_('submit: phase 2 uploads done');
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
    if (dedupeKey) cache.remove(dedupeKey);
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    // Content-based fallback dedupe — catches a manual resubmit that arrives
    // with a fresh clientRequestId (see the comment above
    // DUPLICATE_SUBMIT_WINDOW_MS_). Runs under this same lock, so it's safe
    // against a near-simultaneous duplicate attempt too: whichever call
    // reaches this point first writes the real row, and the other finds it
    // here and coalesces instead of appending a second one.
    var duplicateRequestId = findRecentDuplicateRequest_(employee.EmployeeID, lineRows, now.getTime());
    if (duplicateRequestId) {
      var duplicateResult = { success: true, requestId: duplicateRequestId };
      if (dedupeKey) cache.put(dedupeKey, JSON.stringify(duplicateResult), SUBMIT_DEDUPE_RESULT_TTL_SECONDS_);
      return duplicateResult;
    }

    appendRowsFromObjects_(SHEET_REQUEST_LINES, lineRows);

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
    timeStep_('submit: phase 3 writes done');
    var result = { success: true, requestId: requestId };
    if (dedupeKey) cache.put(dedupeKey, JSON.stringify(result), SUBMIT_DEDUPE_RESULT_TTL_SECONDS_);
    return result;
  } catch (e) {
    if (dedupeKey) cache.remove(dedupeKey);
    return { success: false, error: 'Submission failed: ' + e.message };
  } finally {
    lock2.releaseLock();
  }
}

// ---- Reserve-then-upload flow (used by frontend/outbox.js) ----
// reserveRequestId hands out the sequential RequestID up front and pre-creates its Drive folder once;
// uploadReceipt then saves ONE photo per call (no lock — Drive I/O never blocks other users);
// submitLiquidationRequest finally arrives with receiptUrl lines only, so it does no Drive work at all.
// The reservation lives in CacheService (6h) keyed by RequestID, bound to one employee, so uploadReceipt
// can only write into a folder that was reserved for that same employee.
var RESERVE_CID_CACHE_PREFIX_ = 'reserve_cid_';   // clientRequestId -> RequestID
var RESERVATION_CACHE_PREFIX_ = 'reservation_';   // RequestID -> JSON { employeeId, folderId }
var RESERVATION_TTL_SECONDS_ = 21600;             // CacheService max (6h)

/** The cached reservation for a RequestID if it belongs to employeeId, else null. */
function getReservation_(requestId, employeeId) {
  var raw = CacheService.getScriptCache().get(RESERVATION_CACHE_PREFIX_ + requestId);
  if (!raw) return null;
  try {
    var resv = JSON.parse(raw);
    return String(resv.employeeId) === String(employeeId) ? resv : null;
  } catch (e) {
    return null;
  }
}

function reserveRequestId(employeeId, clientRequestId) {
  if (!clientRequestId) {
    return { success: false, error: 'clientRequestId is required.' };
  }
  var employeeResult = getEmployeeByID(employeeId);
  if (!employeeResult.found) {
    return { success: false, error: 'Employee is invalid or inactive: ' + employeeResult.error };
  }
  var employee = employeeResult.employee;
  var cache = CacheService.getScriptCache();
  var cidKey = RESERVE_CID_CACHE_PREFIX_ + clientRequestId;

  // Idempotent per clientRequestId: a retried reserve returns the SAME RequestID.
  var requestId = cache.get(cidKey);
  if (!requestId) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (e) {
      return { success: false, error: 'System is busy, please try again.' };
    }
    try {
      requestId = cache.get(cidKey); // a concurrent retry may have won while we waited for the lock
      if (!requestId) {
        requestId = generateRequestId_(); // only this fast counter bump runs under the lock
        cache.put(cidKey, requestId, RESERVATION_TTL_SECONDS_);
      }
    } finally {
      lock.releaseLock();
    }
  }
  timeStep_('reserveRequestId: id ready');

  if (!getReservation_(requestId, employee.EmployeeID)) {
    try {
      var folder = ensureRequestFolder_(employee.EmployeeID, requestId); // created once, so parallel uploads never race
      cache.put(RESERVATION_CACHE_PREFIX_ + requestId,
        JSON.stringify({ employeeId: String(employee.EmployeeID), folderId: folder.getId() }), RESERVATION_TTL_SECONDS_);
    } catch (e) {
      cache.remove(cidKey); // let a retry start clean
      return { success: false, error: 'Could not prepare the receipt folder: ' + e.message };
    }
  }
  timeStep_('reserveRequestId: folder ready');
  return { success: true, requestId: requestId };
}

// payload: { requestId, employeeId, lineIndex, file: { filename, mimeType, base64Data } } — one photo per call.
function uploadReceipt(payload) {
  if (!payload || !payload.requestId || !payload.file) {
    return { success: false, error: 'Invalid upload request.' };
  }
  var resv = getReservation_(String(payload.requestId), payload.employeeId);
  if (!resv) {
    return { success: false, notReserved: true, error: 'This request ID was not reserved for this employee (or the reservation expired).' };
  }
  var lineIndex = Number(payload.lineIndex);
  if (!isFinite(lineIndex) || lineIndex < 0 || lineIndex > 99 || Math.floor(lineIndex) !== lineIndex) {
    return { success: false, error: 'Invalid line index.' };
  }
  var fileError = validateReceiptFile_(payload.file);
  if (fileError) {
    return { success: false, error: fileError };
  }
  try {
    var folder = DriveApp.getFolderById(resv.folderId);
    var url = uploadReceiptFileToFolder_(folder, generateLineId_(payload.requestId, lineIndex), payload.file);
    timeStep_('uploadReceipt: done');
    return { success: true, url: url };
  } catch (e) {
    return { success: false, error: 'Upload failed: ' + e.message };
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
// Reviewed/etc. rows are never filtered by this — Reviewer/Verifier stay
// unscoped, same as advanceRequestStage. A request whose required approver
// can't be resolved (directory unreachable, unmapped employee) is still
// shown to everyone — same fail-open fallback used at write time.
function getAllRequestsForPayroll(statusFilter, approverBiometricId) {
  var employeesById = null;
  var firstLineLocationByRequestId = null;
  var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES); // read once, shared below
  if (approverBiometricId) {
    employeesById = {};
    getAllRowsAsObjects_(SHEET_EMPLOYEES).forEach(function (emp) {
      employeesById[String(emp.EmployeeID)] = emp;
    });

    // First matching row per RequestID wins — SHEET_REQUEST_LINES rows are
    // appended in submission order, so this is that request's first line item.
    firstLineLocationByRequestId = {};
    allLines.forEach(function (line) {
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
  }, allLines);
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

// preloadedLines is optional: callers that already read RequestLines pass it
// in to avoid a second full-sheet read.
function buildRequestsWithLines_(requestFilterFn, preloadedLines) {
  var requests = getAllRowsAsObjects_(SHEET_REQUESTS).filter(requestFilterFn);
  var allLines = preloadedLines || getAllRowsAsObjects_(SHEET_REQUEST_LINES);

  // Index lines by RequestID once (O(R+L)) instead of re-filtering per request.
  var linesByRequestId = {};
  allLines.forEach(function (line) {
    var rid = String(line.RequestID);
    (linesByRequestId[rid] = linesByRequestId[rid] || []).push(line);
  });

  requests.sort(function (a, b) {
    return new Date(b.DateSubmitted) - new Date(a.DateSubmitted);
  });

  return requests.map(function (req) {
    var lines = linesByRequestId[String(req.RequestID)] || [];
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
  timeStep_('advanceRequestStage: approver resolved');

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }
  timeStep_('advanceRequestStage: lock acquired');

  try {
    var result = advanceOne_(requestId, targetStage, approverResult, remark, null);
    timeStep_('advanceRequestStage: done');
    return result;
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Advances/rejects MANY requests in one call: credentials resolved once, the shared script lock taken
// once, and Requests/RequestLines/Employees each read once — instead of N x (lock + several sheet
// reads) when the client loops advanceRequestStage. Every request still goes through the exact same
// per-request guards (advanceOne_), so the server remains the real enforcer of stage order, role and
// Pending routing. A per-request failure never aborts the rest.
var BATCH_ADVANCE_MAX_ = 25;

function advanceRequestsBatch(requestIds, targetStage, userId, password, remark) {
  if (!Array.isArray(requestIds) || !requestIds.length) {
    return { success: false, error: 'No requests selected.' };
  }
  var seen = {};
  var ids = [];
  requestIds.forEach(function (id) {
    var key = String(id);
    if (!seen[key]) { seen[key] = true; ids.push(key); }
  });
  if (ids.length > BATCH_ADVANCE_MAX_) {
    return { success: false, error: 'At most ' + BATCH_ADVANCE_MAX_ + ' requests can be processed per call.' };
  }

  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  timeStep_('advanceRequestsBatch: approver resolved');

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }
  timeStep_('advanceRequestsBatch: lock acquired');

  try {
    // One read of Requests (rows are never deleted or moved, so index + 2 is the sheet row).
    var requestsById = {};
    getAllRowsAsObjects_(SHEET_REQUESTS, { fresh: true }).forEach(function (row, i) {
      requestsById[String(row.RequestID)] = { rowIndex: i + 2, row: row };
    });

    var needsRouting = ids.some(function (id) {
      return requestsById[id] && requestsById[id].row.Status === STATUS_PENDING;
    });
    var batchCtx = { requestsById: requestsById, employeesById: null, firstLineLocationByRequestId: null };
    if (needsRouting) {
      batchCtx.employeesById = {};
      getAllRowsAsObjects_(SHEET_EMPLOYEES).forEach(function (emp) {
        batchCtx.employeesById[String(emp.EmployeeID)] = emp;
      });
      // First matching row per RequestID wins = that request's first line item (lines are appended in order).
      batchCtx.firstLineLocationByRequestId = {};
      getAllRowsAsObjects_(SHEET_REQUEST_LINES).forEach(function (line) {
        var rid = String(line.RequestID);
        if (!(rid in batchCtx.firstLineLocationByRequestId)) {
          batchCtx.firstLineLocationByRequestId[rid] = line.BaseLocation;
        }
      });
    }
    timeStep_('advanceRequestsBatch: data read');

    var results = ids.map(function (id) {
      var result;
      try {
        result = advanceOne_(id, targetStage, approverResult, remark, batchCtx);
      } catch (e) {
        result = { success: false, error: 'Update failed: ' + e.message };
      }
      result.requestId = id;
      return result;
    });
    timeStep_('advanceRequestsBatch: done');
    return { success: true, results: results };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Shared core of advanceRequestStage / advanceRequestsBatch — every guard lives here, once. Must be
// called while holding the script lock. batchCtx is null for the single-request path (reads on demand);
// the batch path passes pre-read lookups so nothing is re-read per request.
function advanceOne_(requestId, targetStage, approverResult, remark, batchCtx) {
  var actorName = approverResult.fullName;
  var rowIndex;
  var requestRow;
  if (batchCtx) {
    var found = batchCtx.requestsById[String(requestId)];
    if (!found) {
      return { success: false, error: 'Request not found.' };
    }
    rowIndex = found.rowIndex;
    requestRow = found.row;
  } else {
    rowIndex = findRowIndexById_(SHEET_REQUESTS, 'RequestID', requestId);
    if (rowIndex === -1) {
      return { success: false, error: 'Request not found.' };
    }
    requestRow = getRowObject_(SHEET_REQUESTS, rowIndex);
  }
  var currentStatus = requestRow['Status'];

  // Idempotent replay: the client's background queue may resend an action whose first attempt actually
  // succeeded (response lost). If this request is already at the target stage AND that very same
  // person did it, report success instead of "already ...". A different person's action is never masked.
  var stageFields = STAGE_FIELD_NAMES[targetStage];
  if (stageFields && currentStatus === targetStage && String(requestRow[stageFields.by]) === String(actorName)) {
    return { success: true, alreadyApplied: true };
  }

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
    var employeeId = requestRow['EmployeeID'];
    var employeeInfo;
    var lineLocation;
    if (batchCtx && batchCtx.employeesById) {
      var emp = batchCtx.employeesById[String(employeeId)] || {};
      employeeInfo = { baseLocation: emp.BaseLocation || '', department: emp.Department || '' };
      lineLocation = batchCtx.firstLineLocationByRequestId[String(requestId)] || '';
    } else {
      employeeInfo = getEmployeeRoutingInfo_(employeeId);
      lineLocation = getFirstLineBaseLocation_(requestId);
    }
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
  var existingRemarks = requestRow['Remarks'];
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
    var ctx = authorizeLineEdit_(requestId, lineId, approverResult);
    if (ctx.error) {
      return { success: false, error: ctx.error };
    }

    if (ctx.lineHeaderMap['Excluded'] !== undefined &&
        isLineExcludedValue_(ctx.lineSheet.getRange(ctx.lineRowIndex, ctx.lineHeaderMap['Excluded'] + 1).getValue())) {
      return { success: false, error: 'Include this line again before editing its amount.' };
    }

    var oldAmount = Number(ctx.lineSheet.getRange(ctx.lineRowIndex, ctx.lineHeaderMap['Amount'] + 1).getValue()) || 0;
    var category = ctx.lineSheet.getRange(ctx.lineRowIndex, ctx.lineHeaderMap['Category'] + 1).getValue();

    updateRowFields_(SHEET_REQUEST_LINES, ctx.lineRowIndex, { Amount: amount });

    var remarkLine = 'Amount edited by ' + actorName + ': ' + oldAmount.toFixed(2) + ' → ' + amount.toFixed(2) +
      ' (' + category + ' line)' + (remark ? ' — ' + remark : '');
    var newTotal = recomputeRequestTotalAndAppendRemark_(requestId, ctx, remarkLine);

    return { success: true, newAmount: amount, newTotalAmount: newTotal };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// Marks a single line item "Not included" (Amount forced to 0, reason
// required) or includes it again (original Amount restored) — for an
// attachment the Approver/Reviewer/Verifier judges isn't a valid expense,
// without rejecting the whole request. Same authorization as
// updateLineItemAmount (via authorizeLineEdit_), same lock, same
// re-sum-from-scratch TotalAmount + appended Remarks audit line.
function setLineItemExclusion(requestId, lineId, excluded, reason, userId, password) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  var actorName = approverResult.fullName;

  var wantExcluded = (excluded === true || String(excluded).toLowerCase() === 'true');
  var trimmedReason = String(reason || '').trim();
  if (wantExcluded && !trimmedReason) {
    return { success: false, error: 'A reason is required to mark a line as Not included.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var ctx = authorizeLineEdit_(requestId, lineId, approverResult);
    if (ctx.error) {
      return { success: false, error: ctx.error };
    }

    var lineSheet = ctx.lineSheet;
    var lineHeaderMap = ctx.lineHeaderMap;
    if (lineHeaderMap['Excluded'] === undefined || lineHeaderMap['OriginalAmount'] === undefined) {
      return { success: false, error: 'RequestLines sheet is missing the exclusion columns — re-run setupSheets().' };
    }

    function cell(name) {
      return lineSheet.getRange(ctx.lineRowIndex, lineHeaderMap[name] + 1).getValue();
    }

    var category = cell('Category');
    if (category === 'Timesheet') {
      return { success: false, error: "Timesheet lines can't be excluded." };
    }

    var currentlyExcluded = isLineExcludedValue_(cell('Excluded'));
    var remarkLine;
    var amount;

    if (wantExcluded) {
      if (currentlyExcluded) {
        return { success: false, error: 'This line is already marked Not included.' };
      }
      var oldAmount = Number(cell('Amount')) || 0;
      amount = 0;
      updateRowFields_(SHEET_REQUEST_LINES, ctx.lineRowIndex, {
        OriginalAmount: oldAmount,
        Amount: 0,
        Excluded: 'TRUE',
        ExcludedReason: trimmedReason,
        ExcludedBy: actorName
      });
      remarkLine = 'Line marked Not included by ' + actorName + ': ' + oldAmount.toFixed(2) + ' → 0.00 (' +
        category + ' line) — ' + trimmedReason;
    } else {
      if (!currentlyExcluded) {
        return { success: false, error: 'This line is not marked Not included.' };
      }
      amount = Number(cell('OriginalAmount')) || 0;
      updateRowFields_(SHEET_REQUEST_LINES, ctx.lineRowIndex, {
        Amount: amount,
        Excluded: '',
        ExcludedReason: '',
        ExcludedBy: '',
        OriginalAmount: ''
      });
      remarkLine = 'Line included again by ' + actorName + ': 0.00 → ' + amount.toFixed(2) + ' (' + category + ' line)';
    }

    var newTotal = recomputeRequestTotalAndAppendRemark_(requestId, ctx, remarkLine);

    return { success: true, amount: amount, newTotalAmount: newTotal, actorName: actorName };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

// A Sheets checkbox/boolean reads back as a real boolean, a typed value as
// the string "TRUE" — accept both.
function isLineExcludedValue_(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

// Shared guard for every per-line mutation (updateLineItemAmount,
// setLineItemExclusion). Must be called while holding the script lock.
// Returns { error } or the resolved sheet/row context.
function authorizeLineEdit_(requestId, lineId, approverResult) {
  var requestRowIndex = findRowIndexById_(SHEET_REQUESTS, 'RequestID', requestId);
  if (requestRowIndex === -1) {
    return { error: 'Request not found.' };
  }

  var requestSheet = getSheet_(SHEET_REQUESTS);
  var requestHeaderMap = getHeaderMap_(requestSheet);
  var requestRowData = getRowObject_(SHEET_REQUESTS, requestRowIndex);
  var currentStatus = requestRowData['Status'];

  var requiredRole = REQUIRED_ROLE_BY_STATUS[currentStatus];
  if (!requiredRole) {
    return { error: 'This request can no longer be edited.' };
  }
  if (approverResult.role !== requiredRole) {
    return { error: 'This action requires the ' + requiredRole + ' role.' };
  }

  // Same category/store routing check advanceRequestStage performs for the
  // Pending stage — only the specific required Approver can edit line items
  // on a Pending request, not just any Approver-role account.
  if (currentStatus === STATUS_PENDING) {
    var employeeId = requestRowData['EmployeeID'];
    var employeeInfo = getEmployeeRoutingInfo_(employeeId);
    var lineLocation = getFirstLineBaseLocation_(requestId);
    var required = resolveRequiredApprover_(employeeId, employeeInfo.baseLocation, employeeInfo.department, lineLocation);
    if (required.found) {
      var approverBioId = String(approverResult.biometricId || '').trim().toLowerCase();
      var requiredBioId = String(required.bioId || '').trim().toLowerCase();
      if (!approverBioId || approverBioId !== requiredBioId) {
        return { error: 'Only ' + required.name + ' can edit line items on this request.' };
      }
    }
  }

  var lineRowIndex = findRowIndexById_(SHEET_REQUEST_LINES, 'LineID', lineId);
  if (lineRowIndex === -1) {
    return { error: 'Line item not found.' };
  }

  var lineSheet = getSheet_(SHEET_REQUEST_LINES);
  var lineHeaderMap = getHeaderMap_(lineSheet);
  var lineRequestId = lineSheet.getRange(lineRowIndex, lineHeaderMap['RequestID'] + 1).getValue();
  if (String(lineRequestId) !== String(requestId)) {
    return { error: 'Line item not found.' };
  }

  return {
    requestSheet: requestSheet,
    requestHeaderMap: requestHeaderMap,
    requestRowIndex: requestRowIndex,
    lineSheet: lineSheet,
    lineHeaderMap: lineHeaderMap,
    lineRowIndex: lineRowIndex
  };
}

// Re-sums all of a request's lines from scratch (drift-safe, never a delta)
// and appends one audit line to Remarks. Returns the new TotalAmount.
function recomputeRequestTotalAndAppendRemark_(requestId, ctx, remarkLine) {
  var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES).filter(function (line) {
    return String(line.RequestID) === String(requestId);
  });
  var newTotal = allLines.reduce(function (sum, line) { return sum + (Number(line.Amount) || 0); }, 0);

  var existingRemarks = ctx.requestSheet.getRange(ctx.requestRowIndex, ctx.requestHeaderMap['Remarks'] + 1).getValue();
  var updatedRemarks = existingRemarks ? existingRemarks + '\n' + remarkLine : remarkLine;

  updateRowFields_(SHEET_REQUESTS, ctx.requestRowIndex, { TotalAmount: newTotal, Remarks: updatedRemarks });
  return newTotal;
}
