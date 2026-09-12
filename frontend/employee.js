function initEmployeeView() {
  $('btn-lookup-employee').addEventListener('click', handleEmployeeLookup);
  $('input-employee-id').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleEmployeeLookup();
  });
  $('link-logout').addEventListener('click', function (e) {
    e.preventDefault();
    currentEmployee = null;
    sessionStorage.removeItem(SESSION_KEY_EMPLOYEE);
    $('input-employee-id').value = '';
    switchTopView('view-login');
  });

  $('tab-new-request').addEventListener('click', function () { setEmployeeTab('new-request'); });
  $('tab-my-requests').addEventListener('click', function () { setEmployeeTab('my-requests'); });

  $('btn-add-line').addEventListener('click', function () { addLineItemRow(); });
  $('btn-submit-request').addEventListener('click', handleSubmitRequest);
}

function handleEmployeeLookup() {
  var errorEl = $('login-error');
  clearMessage(errorEl);
  var employeeId = $('input-employee-id').value.trim();
  if (!employeeId) {
    setMessage(errorEl, 'Please enter your Biometric ID no.', true);
    return;
  }

  $('btn-lookup-employee').disabled = true;
  runServer('getEmployeeByID', employeeId)
    .then(function (result) {
      $('btn-lookup-employee').disabled = false;
      if (!result.found) {
        setMessage(errorEl, result.error, true);
        return;
      }
      completeEmployeeLogin_(result.employee);
    })
    .catch(function (err) {
      $('btn-lookup-employee').disabled = false;
      setMessage(errorEl, 'Lookup failed: ' + err.message, true);
    });
}

function completeEmployeeLogin_(employee) {
  currentEmployee = employee;
  sessionStorage.setItem(SESSION_KEY_EMPLOYEE, JSON.stringify(employee));
  $('employee-display-name').textContent = currentEmployee.Name;
  $('employee-display-id').textContent = ' (' + currentEmployee.EmployeeID + ')';
  switchTopView('view-employee-main');
  setEmployeeTab('new-request');
  resetLineItems();
  applyEmployeeCategory_();
}

// Restores a previously logged-in employee from sessionStorage (e.g. after a
// page refresh) so the login screen isn't forced every reload. Returns true
// if a session was found and restored, false otherwise.
function restoreEmployeeSession_() {
  var saved = sessionStorage.getItem(SESSION_KEY_EMPLOYEE);
  if (!saved) return false;
  try {
    completeEmployeeLogin_(JSON.parse(saved));
    return true;
  } catch (e) {
    sessionStorage.removeItem(SESSION_KEY_EMPLOYEE);
    return false;
  }
}

// ---- Mother Branch / employee category (Area Head, Technical, Audit, or
// plain Staff) — a UX mirror of the same resolution RequestService.gs does
// authoritatively at approval time. Only Area Head/Technical/Audit may use
// the Meal Allowance utility; the server independently re-verifies who can
// approve regardless of what this shows, so a fetch failure here degrades to
// "hide the Utilities tab" (fail closed) rather than blocking anything else.

// Column indices in the store-directory CSV (0-indexed) — several headers
// are blank/duplicated in that sheet, so columns are addressed positionally,
// not by header name. See frontend/config.js's STORE_DIRECTORY_CSV_URL comment.
// NOTE: Area Head is read from columns 24/25, NOT the more obvious-looking
// 11/12 — confirmed via real data that 11/12 are off-by-one-row misaligned
// with column 26 (STORES) for most stores, while 24/25 are correctly
// aligned. See StoreDirectoryService.gs's file header comment for details.
var STORE_DIR_COL_AREHEAD_BIO = 24;
var STORE_DIR_COL_AREHEAD_NAME = 25;
var STORE_DIR_COL_TECH_BIO = 16;
var STORE_DIR_COL_AUDIT_BIO = 21;
var STORE_DIR_COL_STORE = 26;
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

// The store-directory sheet (STORE_DIRECTORY_CSV_URL, used by
// resolveEmployeeCategory_ above) and the store-coordinates sheet
// (STORE_COORDINATES_CSV_URL, used by the Meal Allowance utility) are two
// independently-maintained published sheets that can disagree on which
// store is a Tech/Area Head's actual home branch — confirmed via real data
// (BIO 373 shown as Area Head of "Harbor Point" in the directory sheet, but
// the coordinates sheet marks their SM Tarlac row with the literal text
// "MOTHER BRANCH", meaning Harbor Point is just a store they cover, not
// home). The coordinates sheet's literal marker is authoritative for this
// display since it's the same one the Meal Allowance amount logic already
// treats as authoritative (see meal-allowance.js's maResolveRegularAllowance_).
function resolveMotherBranchFromCoordinates_(rows, employeeId) {
  var id = String(employeeId || '').trim().toLowerCase();
  var match = rows.filter(function (r) {
    var techBioId = String(r['BIO ID'] || '').trim().toLowerCase();
    var areaHeadBioId = String(r['BIO'] || '').trim().toLowerCase();
    if (techBioId && id === techBioId && /mother\s*branch/i.test(r['Meal Allowance'] || '')) return true;
    if (areaHeadBioId && id === areaHeadBioId && /mother\s*branch/i.test(r['Meal Alowance'] || '')) return true;
    return false;
  })[0];
  return match ? match['Store'] : null;
}

function loadStoreCoordinatesForMotherBranch_() {
  return fetch(STORE_COORDINATES_CSV_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) { return parseStoreCoordinatesCsv_(text); })
    .catch(function () { return null; }); // non-fatal — falls back to the directory sheet's store below
}

function applyEmployeeCategory_() {
  hideEl($('tab-utilities')); // fail closed until resolved

  Promise.all([loadStoreDirectory_(), loadStoreCoordinatesForMotherBranch_()])
    .then(function (results) {
      var rows = results[0];
      var coordinateRows = results[1];
      var result = resolveEmployeeCategory_(rows, currentEmployee.EmployeeID, currentEmployee.Department);
      var markedMotherBranch = coordinateRows
        ? resolveMotherBranchFromCoordinates_(coordinateRows, currentEmployee.EmployeeID)
        : null;
      var motherBranch = markedMotherBranch || result.store || currentEmployee.BaseLocation || '';
      $('employee-mother-branch').textContent = motherBranch ? 'Mother Branch: ' + motherBranch : '';

      if (result.category === 'AreaHead' || result.category === 'Technical' ||
          result.category === 'Audit' || result.category === 'HeadOffice') {
        showEl($('tab-utilities'));
      }

      populateLocationSuggestions_(rows);
    })
    .catch(function () {
      // Directory unreachable — Mother Branch just stays blank, the
      // Utilities tab stays hidden (fail closed, see comment above), and
      // Base Location simply has no suggestions this session.
      $('employee-mother-branch').textContent = currentEmployee.BaseLocation
        ? 'Mother Branch: ' + currentEmployee.BaseLocation
        : '';
    });
}

// Every unique store name from the directory — used to power each line
// item's custom Base Location suggestion dropdown (wireLocationAutocomplete_
// below). A plain array cached once per login rather than re-derived per
// row; native <datalist> was tried first but renders inconsistently/oddly
// across browsers, so this is a small hand-rolled suggestion list styled to
// match the rest of the app instead.
var locationSuggestionNames = [];

function populateLocationSuggestions_(rows) {
  var seen = {};
  locationSuggestionNames = [];
  rows.forEach(function (r) {
    var store = String(r[STORE_DIR_COL_STORE] || '').trim();
    if (store && !seen[store]) {
      seen[store] = true;
      locationSuggestionNames.push(store);
    }
  });
}

var LOCATION_SUGGESTION_MAX = 8;

// Wires one line item's Base Location input to its own suggestion <ul>
// (both live inside the same cloned row — see addLineItemRow). Suggestions
// only appear once the user has typed something (an empty query showing all
// ~100+ stores would be overwhelming), capped to LOCATION_SUGGESTION_MAX,
// and filtered by simple case-insensitive substring match.
function wireLocationAutocomplete_(input, list) {
  function renderSuggestions() {
    var query = input.value.trim().toLowerCase();
    if (!query) {
      hideEl(list);
      list.innerHTML = '';
      return;
    }

    var matches = locationSuggestionNames.filter(function (name) {
      return name.toLowerCase().indexOf(query) !== -1;
    }).slice(0, LOCATION_SUGGESTION_MAX);

    if (!matches.length) {
      hideEl(list);
      list.innerHTML = '';
      return;
    }

    list.innerHTML = matches.map(function (name) {
      return '<li>' + escapeHtml_(name) + '</li>';
    }).join('');
    showEl(list);
  }

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('blur', function () { hideEl(list); });

  // mousedown (not click) fires before the input's blur, so the selection
  // registers before the list gets hidden; preventDefault keeps focus on
  // the input instead of letting it flicker away to the <li>.
  list.addEventListener('mousedown', function (e) {
    var li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    input.value = li.textContent;
    hideEl(list);
    list.innerHTML = '';
  });
}

function setEmployeeTab(tab) {
  $('tab-new-request').classList.toggle('active', tab === 'new-request');
  $('tab-new-request').setAttribute('aria-selected', String(tab === 'new-request'));
  $('tab-my-requests').classList.toggle('active', tab === 'my-requests');
  $('tab-my-requests').setAttribute('aria-selected', String(tab === 'my-requests'));
  $('tab-utilities').classList.toggle('active', tab === 'utilities');
  $('tab-utilities').setAttribute('aria-selected', String(tab === 'utilities'));

  $('view-new-request').classList.toggle('hidden', tab !== 'new-request');
  $('view-my-requests').classList.toggle('hidden', tab !== 'my-requests');
  $('view-utilities').classList.toggle('hidden', tab !== 'utilities');

  if (tab === 'my-requests') loadMyRequests();
}

// ---- New request line items ----

var lineItemCounter = 0;

function resetLineItems() {
  $('line-items-container').innerHTML = '';
  lineItemCounter = 0;
  updateRunningTotal();
  clearMessage($('submit-error'));
  clearMessage($('submit-success'));
}

// Fields whose input+label pair need a unique id/for per cloned row (template markup is static and repeats).
var LINE_ITEM_FIELDS = ['date', 'category', 'location', 'amount', 'description', 'file'];

// Formats a Date as YYYY-MM-DD in local time (toISOString() would shift by timezone offset).
function formatDateForInput_(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function addLineItemRow() {
  lineItemCounter++;
  var rowId = 'li' + lineItemCounter;

  var template = $('line-item-template');
  var clone = document.importNode(template.content, true);

  LINE_ITEM_FIELDS.forEach(function (field) {
    var input = clone.querySelector('.li-' + field);
    var label = clone.querySelector('.li-' + field + '-label');
    var fieldId = rowId + '-' + field;
    input.id = fieldId;
    label.setAttribute('for', fieldId);
  });

  ['date', 'category', 'location', 'amount', 'description', 'file'].forEach(function (field) {
    var requiredInput = clone.querySelector('.li-' + field);
    var clearEvent = (field === 'category' || field === 'file') ? 'change' : 'input';
    requiredInput.addEventListener(clearEvent, function () {
      requiredInput.classList.remove('input-error');
    });
  });

  if (currentEmployee && currentEmployee.BaseLocation) {
    clone.querySelector('.li-location').value = currentEmployee.BaseLocation;
  }

  var dateInput = clone.querySelector('.li-date');
  var today = new Date();
  var oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  dateInput.max = formatDateForInput_(today);
  dateInput.min = formatDateForInput_(oneMonthAgo);

  clone.querySelector('.li-amount').addEventListener('input', updateRunningTotal);
  clone.querySelector('.line-item-remove').addEventListener('click', function (e) {
    var row = e.target.closest('.line-item-row');
    row.remove();
    updateRunningTotal();
  });

  wireLocationAutocomplete_(clone.querySelector('.li-location'), clone.querySelector('.li-location-suggestions'));

  $('line-items-container').appendChild(clone);
}

function updateRunningTotal() {
  var total = 0;
  document.querySelectorAll('.li-amount').forEach(function (input) {
    total += Number(input.value) || 0;
  });
  $('running-total').textContent = formatCurrency(total);
}

function collectLineItems() {
  var rows = document.querySelectorAll('#line-items-container .line-item-row');
  var lines = [];
  var fileReadPromises = [];

  rows.forEach(function (row) {
    var line = {
      date: row.querySelector('.li-date').value,
      category: row.querySelector('.li-category').value,
      baseLocation: row.querySelector('.li-location').value.trim(),
      amount: Number(row.querySelector('.li-amount').value),
      description: row.querySelector('.li-description').value.trim(),
      file: null,
      receiptUrl: row.dataset.receiptUrl || ''
    };
    lines.push(line);

    if (!line.receiptUrl) {
      var fileInput = row.querySelector('.li-file');
      if (fileInput && fileInput.files && fileInput.files[0]) {
        var file = fileInput.files[0];
        if (file.size > 5 * 1024 * 1024) {
          throw new Error('Receipt file "' + file.name + '" exceeds 5MB.');
        }
        fileReadPromises.push(
          compressImageForUpload_(file)
            .then(function (compressed) { return readFileAsBase64(compressed); })
            .then(function (encoded) { line.file = encoded; })
        );
      }
    }
  });

  return Promise.all(fileReadPromises).then(function () { return lines; });
}

// Re-encodes a receipt photo down toward ~1MB before it's uploaded to Drive,
// while keeping resolution high enough that receipt text/numbers stay
// legible: caps the longer dimension at 2500px (generous — rarely the
// limiting factor for a phone photo) and steps JPEG quality down from 0.9 in
// 0.1 increments until the result is under the target or quality hits a 0.5
// floor (stops there even if still slightly over, rather than degrading
// legibility further — Validation.gs's server-side ceiling has headroom for
// that edge case). Already-small files are returned unchanged.
var RECEIPT_COMPRESS_TARGET_BYTES = 1 * 1024 * 1024;
var RECEIPT_COMPRESS_MAX_DIMENSION = 2500;
var RECEIPT_COMPRESS_MIN_QUALITY = 0.5;

function compressImageForUpload_(file) {
  if (file.size <= RECEIPT_COMPRESS_TARGET_BYTES) return Promise.resolve(file);

  return new Promise(function (resolve, reject) {
    var objectUrl = URL.createObjectURL(file);
    var img = new Image();

    img.onload = function () {
      URL.revokeObjectURL(objectUrl);

      var scale = Math.min(1, RECEIPT_COMPRESS_MAX_DIMENSION / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

      var baseName = file.name.replace(/\.\w+$/, '') || 'receipt';

      function tryQuality(quality) {
        canvas.toBlob(function (blob) {
          if (!blob) {
            reject(new Error('Could not compress "' + file.name + '".'));
            return;
          }
          if (blob.size <= RECEIPT_COMPRESS_TARGET_BYTES || quality <= RECEIPT_COMPRESS_MIN_QUALITY) {
            resolve(new File([blob], baseName + '.jpg', { type: 'image/jpeg' }));
          } else {
            tryQuality(quality - 0.1);
          }
        }, 'image/jpeg', quality);
      }

      tryQuality(0.9);
    };
    img.onerror = function () {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read "' + file.name + '" for compression.'));
    };
    img.src = objectUrl;
  });
}

// Highlights any required line-item field left blank (or, for Amount, not a
// positive number) and returns false if anything is invalid. Runs only on
// Submit click, not real-time.
function validateRequiredLineFields_() {
  var rows = document.querySelectorAll('#line-items-container .line-item-row');
  var requiredFields = ['date', 'category', 'location', 'amount', 'description'];
  var allValid = true;
  var firstInvalid = null;

  rows.forEach(function (row) {
    requiredFields.forEach(function (field) {
      var input = row.querySelector('.li-' + field);
      var isEmpty = (field === 'amount')
        ? !(Number(input.value) > 0)
        : !input.value.trim();

      if (isEmpty) {
        input.classList.add('input-error');
        allValid = false;
        if (!firstInvalid) firstInvalid = input;
      } else {
        input.classList.remove('input-error');
      }
    });

    // Meal Allowance hand-off rows already carry a receiptUrl (their file
    // input is replaced entirely — see maLockRowAsMealAllowance_ in
    // meal-allowance.js) and are always valid without a manually-picked file.
    if (!row.dataset.receiptUrl) {
      var fileInput = row.querySelector('.li-file');
      if (fileInput) {
        var hasFile = fileInput.files && fileInput.files[0];
        if (!hasFile) {
          fileInput.classList.add('input-error');
          allValid = false;
          if (!firstInvalid) firstInvalid = fileInput;
        } else {
          fileInput.classList.remove('input-error');
        }
      }
    }
  });

  if (firstInvalid) firstInvalid.focus();
  return allValid;
}

function handleSubmitRequest() {
  var errorEl = $('submit-error');
  var successEl = $('submit-success');
  clearMessage(errorEl);
  clearMessage(successEl);

  if (!document.querySelectorAll('#line-items-container .line-item-row').length) {
    setMessage(errorEl, 'Add at least one line item.', true);
    return;
  }

  if (!validateRequiredLineFields_()) {
    setMessage(errorEl, 'Please fill in all required fields.', true);
    return;
  }

  var submitBtn = $('btn-submit-request');
  var submitLabel = $('submit-btn-label');
  submitBtn.disabled = true;
  submitLabel.innerHTML = '<span class="spinner" aria-hidden="true"></span> Submitting...';

  function resetSubmitButton() {
    submitBtn.disabled = false;
    submitLabel.textContent = 'Submit Request';
  }

  Promise.resolve()
    .then(collectLineItems)
    .then(function (lines) {
      return runServer('submitLiquidationRequest', {
        employeeId: currentEmployee.EmployeeID,
        employeeName: currentEmployee.Name,
        lines: lines
      });
    })
    .then(function (result) {
      resetSubmitButton();
      if (!result.success) {
        setMessage(errorEl, result.error, true);
        return;
      }
      setMessage(successEl, 'Request ' + result.requestId + ' submitted successfully.', false);
      resetLineItems();
      setEmployeeTab('my-requests');
    })
    .catch(function (err) {
      resetSubmitButton();
      setMessage(errorEl, err.message, true);
    });
}

// ---- My Requests ----

function loadMyRequests() {
  var container = $('my-requests-table-container');
  container.innerHTML = '<div class="state-message"><span class="spinner" aria-hidden="true" style="border-color:#e4e7eb;border-top-color:#1e3a5f;"></span><p>Loading your requests...</p></div>';
  runServer('getMyRequests', currentEmployee.EmployeeID)
    .then(function (requests) {
      renderRequestsTable(container, requests, { showEmployee: false });
    })
    .catch(function (err) {
      container.innerHTML = '<div class="msg msg-error" role="alert">' + MSG_ICON_ERROR + '<span>Failed to load: ' + err.message + '</span></div>';
    });
}
