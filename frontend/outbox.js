// Employee-side "outbox": a submitted request is saved locally (IndexedDB, including the already-compressed
// receipt photos) and sent to Apps Script in the background, so the employee sees "Submitted" immediately
// instead of waiting through every Drive upload. Pipeline per request, each step persisted so a refresh,
// closed tab or dropped connection resumes where it stopped:
//
//   reserveRequestId  ->  uploadReceipt (one photo per call, 3 in parallel)  ->  submitLiquidationRequest
//
// Safety net: the server already collapses a replay of the same clientRequestId (and, as a fallback, a
// content-identical resubmit — see RequestService.gs), so retrying any step can never create a duplicate.
//
// Loaded after common.js (runServer, readFileAsBase64, generateClientRequestId_, patchCachedNewRequest_) and
// before employee.js. Needs no login: an item carries its own employeeId, so it keeps sending even from the
// login screen.

var OUTBOX_UPLOAD_CONCURRENCY = 3;
var OUTBOX_RETRY_DELAYS_MS = [3000, 8000, 20000, 45000, 90000, 180000]; // then 180s each, until OUTBOX_MAX_ATTEMPTS
var OUTBOX_MAX_ATTEMPTS = 10; // consecutive retryable failures before it stops and offers a manual Retry
var OUTBOX_DB_NAME = 'liquidation-outbox';
var OUTBOX_STORE_NAME = 'items';

// ---- storage: IndexedDB when available, otherwise an in-memory map (then a beforeunload warning protects it) ----

var outboxItems_ = {};            // id -> item (the live copy; also mirrored to IndexedDB)
var outboxListeners_ = [];
var outboxDb_ = null;             // IDBDatabase, or null when running memory-only
var outboxPersistent_ = false;
var outboxRunning_ = false;
var outboxTimer_ = null;

function outboxOpenDb_() {
  return new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
      var req = indexedDB.open(OUTBOX_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    } catch (e) {
      resolve(null); // e.g. Safari private mode / blocked site data
    }
  });
}

function outboxIdb_(mode, fn) {
  return new Promise(function (resolve) {
    if (!outboxDb_) { resolve(null); return; }
    try {
      var tx = outboxDb_.transaction(OUTBOX_STORE_NAME, mode);
      var store = tx.objectStore(OUTBOX_STORE_NAME);
      var result = fn(store);
      tx.oncomplete = function () { resolve(result && result.result !== undefined ? result.result : null); };
      tx.onerror = function () { resolve(null); };
      tx.onabort = function () { resolve(null); };
    } catch (e) {
      resolve(null);
    }
  });
}

function outboxPersist_(item) {
  return outboxIdb_('readwrite', function (store) { return store.put(item); });
}

function outboxForget_(id) {
  delete outboxItems_[id];
  return outboxIdb_('readwrite', function (store) { return store.delete(id); });
}

function outboxNotify_() {
  outboxListeners_.slice().forEach(function (fn) {
    try { fn(); } catch (e) { /* a listener must never break the runner */ }
  });
}

function outboxSubscribe_(fn) { outboxListeners_.push(fn); }

/** Items (not yet confirmed by the server) for one employee, oldest first. */
function outboxItemsFor_(employeeId) {
  return Object.keys(outboxItems_)
    .map(function (k) { return outboxItems_[k]; })
    .filter(function (it) { return String(it.employeeId) === String(employeeId); })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
}

function outboxHasPending_() {
  return Object.keys(outboxItems_).some(function (k) { return outboxItems_[k].state !== 'failed'; });
}

// ---- public API ----

/**
 * Saves a prepared request and starts sending it. `lines` are the request lines WITHOUT files; `photos` is
 * [{ lineIndex, file }] (already compressed). Resolves with the stored item once it is safely saved locally.
 */
function outboxEnqueue_(employee, lines, photos) {
  var item = {
    id: generateClientRequestId_(),
    employeeId: employee.EmployeeID,
    employeeName: employee.Name,
    lines: lines,
    photos: photos.map(function (p) {
      return { lineIndex: p.lineIndex, file: p.file, name: p.file.name || 'receipt.jpg', type: p.file.type || 'image/jpeg' };
    }),
    uploaded: {},          // lineIndex -> Drive URL
    state: 'queued',       // queued | sending | retrying | failed
    requestId: null,
    error: '',
    attempts: 0,
    retryAt: 0,
    createdAt: Date.now()
  };
  outboxItems_[item.id] = item;
  return outboxPersist_(item).then(function () {
    outboxNotify_();
    outboxKick_();
    return item;
  });
}

function outboxRetry_(id) {
  var item = outboxItems_[id];
  if (!item) return;
  item.state = 'queued';
  item.attempts = 0;
  item.retryAt = 0;
  item.error = '';
  outboxPersist_(item);
  outboxNotify_();
  outboxKick_();
}

function outboxDiscard_(id) {
  outboxForget_(id);
  outboxNotify_();
}

/** "3 / 11 photos" style progress for display. */
function outboxProgress_(item) {
  var total = item.photos.length;
  var done = Object.keys(item.uploaded).length;
  return { done: done, total: total };
}

// ---- runner ----

function outboxSleep_(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// Marks a retryable failure (network, busy, reservation expired): backs off, or gives up after too many tries.
function outboxRetryLater_(item, message) {
  item.attempts += 1;
  if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
    item.state = 'failed';
    item.error = message + ' (will not retry automatically — tap Retry)';
    return outboxPersist_(item);
  }
  var delay = OUTBOX_RETRY_DELAYS_MS[Math.min(item.attempts - 1, OUTBOX_RETRY_DELAYS_MS.length - 1)];
  item.state = 'retrying';
  item.retryAt = Date.now() + delay;
  item.error = message;
  return outboxPersist_(item);
}

function outboxFail_(item, message) {
  item.state = 'failed';
  item.error = message;
  return outboxPersist_(item);
}

function outboxToFile_(photo) {
  var f = photo.file;
  if (typeof File !== 'undefined' && !(f instanceof File)) {
    return new File([f], photo.name, { type: photo.type });
  }
  return f;
}

// Uploads every photo not yet uploaded, OUTBOX_UPLOAD_CONCURRENCY at a time. Resolves when all are done or
// a step failed (the item's state/error then says why).
function outboxUploadPhotos_(item) {
  var pending = item.photos.filter(function (p) { return !item.uploaded[p.lineIndex]; });
  var stop = false;

  function worker() {
    if (stop || !pending.length) return Promise.resolve();
    var photo = pending.shift();
    return readFileAsBase64(outboxToFile_(photo))
      .then(function (encoded) {
        return runServer('uploadReceipt', {
          requestId: item.requestId,
          employeeId: item.employeeId,
          lineIndex: photo.lineIndex,
          file: encoded
        });
      })
      .then(function (result) {
        if (result.success) {
          item.uploaded[photo.lineIndex] = result.url;
          return outboxPersist_(item).then(function () { outboxNotify_(); });
        }
        stop = true;
        if (result.notReserved) {
          // The server forgot the reservation (cache eviction) — start over from reserve with a fresh id.
          item.requestId = null;
          item.uploaded = {};
          return outboxRetryLater_(item, 'Preparing the upload again…');
        }
        if (/busy/i.test(result.error || '')) return outboxRetryLater_(item, 'Server is busy — retrying…');
        return outboxFail_(item, result.error || 'A receipt photo could not be uploaded.');
      })
      .catch(function (err) {
        stop = true;
        return outboxRetryLater_(item, err.message);
      })
      .then(worker);
  }

  var workers = [];
  for (var i = 0; i < OUTBOX_UPLOAD_CONCURRENCY; i++) workers.push(worker());
  return Promise.all(workers);
}

function outboxProcessItem_(item) {
  item.state = 'sending';
  item.error = '';
  outboxNotify_();

  return Promise.resolve()
    .then(function () {
      // No photos to upload (e.g. only Meal Allowance lines, which already carry a receiptUrl) = nothing
      // to reserve a folder for; submitLiquidationRequest assigns the id itself.
      if (item.requestId || !item.photos.length) return null;
      return runServer('reserveRequestId', item.employeeId, item.id).then(function (result) {
        if (result.success) {
          item.requestId = result.requestId;
          return outboxPersist_(item);
        }
        if (/busy/i.test(result.error || '') || /receipt folder/i.test(result.error || '')) {
          return outboxRetryLater_(item, result.error);
        }
        return outboxFail_(item, result.error || 'Could not start the submission.');
      });
    })
    .then(function () {
      if (item.state === 'failed' || item.state === 'retrying') return null;
      outboxNotify_();
      return outboxUploadPhotos_(item);
    })
    .then(function () {
      if (item.state === 'failed' || item.state === 'retrying') return null;
      if (Object.keys(item.uploaded).length < item.photos.length) return null;

      var lines = item.lines.map(function (line, i) {
        var copy = {};
        Object.keys(line).forEach(function (k) { copy[k] = line[k]; });
        if (!copy.receiptUrl && item.uploaded[i]) copy.receiptUrl = item.uploaded[i];
        return copy;
      });
      return runServer('submitLiquidationRequest', {
        employeeId: item.employeeId,
        employeeName: item.employeeName,
        lines: lines,
        clientRequestId: item.id,
        requestId: item.requestId
      }).then(function (result) {
        if (result.success) {
          return outboxComplete_(item, result.requestId, lines);
        }
        if (/not reserved/i.test(result.error || '')) {
          item.requestId = null;
          item.uploaded = {};
          return outboxRetryLater_(item, 'Preparing the upload again…');
        }
        if (/busy/i.test(result.error || '')) return outboxRetryLater_(item, 'Server is busy — retrying…');
        return outboxFail_(item, result.error || 'The request could not be submitted.');
      });
    })
    .catch(function (err) {
      return outboxRetryLater_(item, err.message);
    })
    .then(function () { outboxNotify_(); });
}

function outboxComplete_(item, requestId, lines) {
  // Show the request in My Requests right away (the published CSV can lag several minutes), then drop it.
  return patchCachedNewRequest_(requestId, item.employeeId, item.employeeName, lines)
    .catch(function () { /* cache patch is cosmetic */ })
    .then(function () {
      outboxCompleted_.push({ id: item.id, requestId: requestId, employeeId: item.employeeId });
      return outboxForget_(item.id);
    });
}

var outboxCompleted_ = []; // drained by employee.js to show "Request REQ#… submitted"

function outboxNextDue_() {
  var now = Date.now();
  var due = null;
  Object.keys(outboxItems_).forEach(function (k) {
    var it = outboxItems_[k];
    if (it.state === 'failed') return;
    if (it.state === 'retrying' && it.retryAt > now) return;
    if (!due || it.createdAt < due.createdAt) due = it;
  });
  return due;
}

function outboxScheduleWake_() {
  if (outboxTimer_) { clearTimeout(outboxTimer_); outboxTimer_ = null; }
  var next = null;
  Object.keys(outboxItems_).forEach(function (k) {
    var it = outboxItems_[k];
    if (it.state === 'retrying' && (next === null || it.retryAt < next)) next = it.retryAt;
  });
  if (next !== null) outboxTimer_ = setTimeout(outboxKick_, Math.max(500, next - Date.now()));
}

function outboxRunLoop_() {
  var item = outboxNextDue_();
  if (!item) return Promise.resolve();
  // One request at a time keeps load on the shared Apps Script lock low; photos inside it are parallel.
  return outboxProcessItem_(item).then(outboxRunLoop_);
}

function outboxKick_() {
  if (outboxRunning_) return;
  outboxRunning_ = true;

  function finish() {
    outboxRunning_ = false;
    outboxScheduleWake_();
    outboxNotify_();
  }
  function run() { return outboxRunLoop_().then(finish, finish); }

  // Web Locks (when available) make sure only ONE tab drives the pipeline for the shared IndexedDB items.
  if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
    navigator.locks.request('liquidation-outbox-runner', { ifAvailable: true }, function (lock) {
      if (!lock) { finish(); return null; }
      return run();
    }).catch(finish);
  } else {
    run();
  }
}

// ---- startup: reload saved items, resume, warn before leaving while memory-only items are pending ----

function outboxInit_() {
  return outboxOpenDb_().then(function (db) {
    outboxDb_ = db;
    outboxPersistent_ = !!db;
    return outboxIdb_('readonly', function (store) { return store.getAll(); });
  }).then(function (saved) {
    (saved || []).forEach(function (it) {
      // A tab that died mid-send left 'sending' behind — it is simply due again.
      if (it.state === 'sending') it.state = 'queued';
      if (!outboxItems_[it.id]) outboxItems_[it.id] = it;
    });
    outboxNotify_();
    outboxKick_();
  });
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeunload', function (e) {
    // With IndexedDB the outbox simply resumes next visit; only the memory-only fallback can lose data.
    if (!outboxPersistent_ && outboxHasPending_()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('online', function () { outboxKick_(); });
}
