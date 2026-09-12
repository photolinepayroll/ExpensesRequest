// Meal Allowance utility (Employee Utilities tab). Self-contained: reads the
// external attendance CSV client-side and only talks to the backend to save
// the final record. Always operates on the currently logged-in employee
// (common.js's currentEmployee) — there is no way to look up another
// employee's attendance from here (see maSyncSelectedEmployee_).

var maAttendanceRowsCache = null; // parsed attendance rows, fetched once per page load
var maStoreCache = null;          // parsed store-coordinates reference rows, fetched once per page load
var maSelectedEmployee = null;    // { EmployeeID, Name } — always mirrors currentEmployee
var maStartInRecords = [];
var maEndOutRecords = [];
var maLastCalculation = null;
var maLastSavedLineItem = null; // set after a successful save, consumed by "Add to New Request"

// Not every duty happens at (or near) one of the listed stores — staff are
// sometimes sent elsewhere for other assignments. The Regular Meal Allowance
// bracket only depends on the broad region, so there's no distance cutoff
// for that. This radius instead gates the per-employee Tech/Area Head
// personal override: it only applies when they're actually near their own
// assigned store, not just because it happened to be the nearest reference
// row from far away. Real attendance GPS has shown drift up to ~4.5km even
// for confirmed correct visits, so this is intentionally generous.
var MA_ASSIGNED_OVERRIDE_RADIUS_METERS = 1500;

function initMealAllowanceUtility() {
  $('tab-utilities').addEventListener('click', function () {
    setEmployeeTab('utilities');
    maSyncSelectedEmployee_();
  });

  $('ma-duty-date').max = formatDateForInput_(new Date()); // no future duty dates
  $('ma-duty-date').addEventListener('change', function () {
    maResetSelectorsAndSummary_();
    maUpdateLoadButtonState_();
  });

  $('ma-crosses-midnight').addEventListener('change', function () {
    var checked = this.checked;
    if (checked) {
      showEl($('ma-end-date-row'));
      // Default to duty date + 1 day — the common case — but still editable.
      var dutyDateStr = $('ma-duty-date').value;
      if (dutyDateStr) {
        var nextDay = new Date(dutyDateStr + 'T00:00:00');
        nextDay.setDate(nextDay.getDate() + 1);
        $('ma-duty-end-date').value = formatDateForInput_(nextDay);
      }
    } else {
      hideEl($('ma-end-date-row'));
      $('ma-duty-end-date').value = '';
    }
    maResetSelectorsAndSummary_();
    maUpdateLoadButtonState_();
  });
  $('ma-duty-end-date').addEventListener('change', function () {
    maResetSelectorsAndSummary_();
    maUpdateLoadButtonState_();
  });

  $('ma-btn-load').addEventListener('click', maHandleLoadAttendance_);
  $('ma-start-in').addEventListener('change', maRecomputeSummary_);
  $('ma-end-out').addEventListener('change', maRecomputeSummary_);
  $('ma-btn-confirm').addEventListener('click', maHandleConfirmSave_);
  $('ma-btn-add-to-request').addEventListener('click', maHandleAddToNewRequest_);
}

// ---- Employee (always the logged-in employee) ----

function maSyncSelectedEmployee_() {
  if (!currentEmployee) return;
  if (maSelectedEmployee && String(maSelectedEmployee.EmployeeID) === String(currentEmployee.EmployeeID)) {
    return; // already showing the right employee
  }
  maSelectedEmployee = { EmployeeID: currentEmployee.EmployeeID, Name: currentEmployee.Name };
  $('ma-selected-name').textContent = maSelectedEmployee.Name;
  $('ma-selected-id').textContent = ' (' + maSelectedEmployee.EmployeeID + ')';
  showEl($('ma-selected-employee'));
  maResetSelectorsAndSummary_();
  maUpdateLoadButtonState_();
}

function maUpdateLoadButtonState_() {
  var crossesMidnight = $('ma-crosses-midnight').checked;
  var hasRequiredDates = $('ma-duty-date').value && (!crossesMidnight || $('ma-duty-end-date').value);
  $('ma-btn-load').disabled = !(maSelectedEmployee && hasRequiredDates);
}

// ---- Attendance CSV ----

function maLoadAttendanceCsv_() {
  if (maAttendanceRowsCache) return Promise.resolve(maAttendanceRowsCache);
  return fetch(ATTENDANCE_CSV_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) {
      maAttendanceRowsCache = csvToObjects_(parseCsv_(text));
      return maAttendanceRowsCache;
    });
}

// ---- Store coordinates reference table ----

function maLoadStoreCoordinates_() {
  if (maStoreCache) return Promise.resolve(maStoreCache);
  return fetch(STORE_COORDINATES_CSV_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) {
      maStoreCache = parseStoreCoordinatesCsv_(text);
      return maStoreCache;
    });
}

function maHaversineMeters_(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Returns { store, distanceMeters } for the closest reference store to the
// given coordinates, or null if the store table or the coordinates are unusable.
function maFindNearestStore_(lat, lon) {
  if (!maStoreCache || !isFinite(lat) || !isFinite(lon)) return null;
  var best = null;
  maStoreCache.forEach(function (store) {
    var sLat = parseFloat(store['Latitude (num)']);
    var sLon = parseFloat(store['Longitude (num)']);
    if (!isFinite(sLat) || !isFinite(sLon)) return;
    var dist = maHaversineMeters_(lat, lon, sLat, sLon);
    if (!best || dist < best.distanceMeters) best = { store: store, distanceMeters: dist };
  });
  return best;
}

// Resolves the day's "duty location" from the End OUT record only. Start IN
// is deliberately not used here — real usage showed employees often log IN
// from a different location (e.g. home, or a prior stop) before traveling to
// the actual duty site, so Start IN's GPS/destination isn't a reliable
// signal for where the duty allowance should be attributed; End OUT (where
// the employee actually finished duty) is.
//
// Not every duty happens at one of the listed stores — staff are sometimes
// sent elsewhere for other assignments/coverage areas that aren't in the
// reference sheet at all. Since the Regular Meal Allowance bracket only
// depends on which broad region (NCR/NORTH LUZON/VISMIN/MINDANAO) the duty
// falls in — not the exact store — this just uses the nearest reference row
// as a stand-in for "what region/city is this GPS point in", regardless of
// whether the employee was literally at that specific store. The per-
// employee Tech/Area Head override still requires them to be reasonably
// close to their own assigned store (see maResolveRegularAllowance_) so it
// doesn't get applied just because their assigned store happened to be the
// nearest reference point from far away.
function maResolveDutyLocation_(endRec) {
  var nearest = maFindNearestStore_(endRec.lat, endRec.lon);
  if (!nearest) return { matched: false };
  return { matched: true, store: nearest.store, distanceMeters: nearest.distanceMeters };
}

// Resolves the Regular Meal Allowance amount. Baseline is regionStore's
// generic regional bracket (regionStore is just whatever's nearest overall —
// a stand-in for "which region is this", not necessarily where the employee
// is assigned). Separately scans the *entire* store table for a row where
// the logged-in employee is the assigned Tech or Area Head (by Biometric ID)
// AND the End OUT GPS is within MA_ASSIGNED_OVERRIDE_RADIUS_METERS of that
// specific store — deliberately not limited to whichever store happens to be
// globally nearest, since an unrelated closer store shouldn't hide a real
// match against the employee's own assigned site. The sheet itself already
// marks which one of an employee's assigned rows is their actual home
// branch: that row's amount cell holds the literal text "MOTHER BRANCH"
// instead of a number (confirmed via real data — e.g. BIO 373 has a normal
// numeric rate at Harbor Point, a store they cover as Area Head, but the
// literal "MOTHER BRANCH" text at SM Tarlac, their actual home store). Duty
// at that specific marked row pays ₱0 (no travel away from home base); duty
// at any other of the employee's assigned rows still pays that row's real
// override amount (a covered branch, not home); duty matching neither
// falls back to the generic regional bracket.
function maResolveRegularAllowance_(endRec, regionStore) {
  var empId = String(maSelectedEmployee.EmployeeID || '').trim().toLowerCase();
  var regionAmount = Number(regionStore['REGULAR (AUDIT/TEC/STAFF)']);
  if (!isFinite(regionAmount)) regionAmount = 0;

  var matched = null;
  if (maStoreCache) {
    maStoreCache.forEach(function (store) {
      if (matched) return;

      var techBioId = String(store['BIO ID'] || '').trim().toLowerCase();
      var areaHeadBioId = String(store['BIO'] || '').trim().toLowerCase();
      var role, amountField;
      if (techBioId && empId === techBioId) { role = 'AssignedTech'; amountField = 'Meal Allowance'; }
      else if (areaHeadBioId && empId === areaHeadBioId) { role = 'AssignedAreaHead'; amountField = 'Meal Alowance'; }
      if (!role) return;

      var sLat = parseFloat(store['Latitude (num)']);
      var sLon = parseFloat(store['Longitude (num)']);
      if (!isFinite(sLat) || !isFinite(sLon)) return;
      if (maHaversineMeters_(endRec.lat, endRec.lon, sLat, sLon) > MA_ASSIGNED_OVERRIDE_RADIUS_METERS) return;

      var rawAmount = String(store[amountField] || '').trim();
      if (/mother\s*branch/i.test(rawAmount)) {
        matched = { amount: 0, source: role === 'AssignedTech' ? 'OwnMotherBranchTech' : 'OwnMotherBranchAreaHead' };
        return;
      }

      var amount = Number(rawAmount);
      var storeRegularAmount = Number(store['REGULAR (AUDIT/TEC/STAFF)']);
      if (!isFinite(storeRegularAmount)) storeRegularAmount = regionAmount;
      matched = { amount: isFinite(amount) ? amount : storeRegularAmount, source: role };
    });
  }

  return matched || { amount: regionAmount, source: 'RegularBracket' };
}

var MA_EVENING_START_HOUR = 18; // 6:00 PM
var MA_MIDNIGHT_WINDOW_END_HOUR = 6; // 6:00 AM the next day

// Whether Midnight Allowance is even possible for this duty session — checked
// against the End OUT time only, matching this utility's existing "End OUT is
// authoritative" convention (see maResolveDutyLocation_'s own comment on why
// Start IN isn't used as a signal). A same-day daytime shift never qualifies;
// a shift ending in the evening or in the early morning does.
function maIsInEveningToMidnightWindow_(timestamp) {
  var h = timestamp.getHours();
  return h >= MA_EVENING_START_HOUR || h < MA_MIDNIGHT_WINDOW_END_HOUR;
}


// "YYYY-MM-DD H:MM:SS" (no timezone marker in the source) -> local Date.
function maParseTimestamp_(ts) {
  var parts = String(ts || '').trim().split(' ');
  if (parts.length < 2) return null;
  var d = parts[0].split('-').map(Number);
  var t = parts[1].split(':').map(Number);
  if (d.length !== 3 || isNaN(d[0])) return null;
  var date = new Date(d[0], d[1] - 1, d[2], t[0] || 0, t[1] || 0, t[2] || 0);
  return isNaN(date.getTime()) ? null : date;
}

// ---- Load attendance for the selected employee + date ----

function maHandleLoadAttendance_() {
  clearMessage($('ma-attendance-error'));
  hideEl($('ma-records-empty'));
  maResetSelectorsAndSummary_();

  var dutyDateStr = $('ma-duty-date').value;
  var crossesMidnight = $('ma-crosses-midnight').checked;
  var endDateStr = crossesMidnight ? $('ma-duty-end-date').value : '';
  if (!maSelectedEmployee || !dutyDateStr || (crossesMidnight && !endDateStr)) return;

  if (crossesMidnight && endDateStr <= dutyDateStr) {
    setMessage($('ma-attendance-error'), 'Next Day Date must be after Duty Date.', true);
    return;
  }

  var btn = $('ma-btn-load');
  var originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading...';

  Promise.all([maLoadAttendanceCsv_(), maLoadStoreCoordinates_()])
    .then(function (results) {
      var rows = results[0];
      var empId = String(maSelectedEmployee.EmployeeID).trim().toLowerCase();
      var empName = String(maSelectedEmployee.Name).trim().toLowerCase();

      var dayRecords = rows.filter(function (r) {
        var bioId = String(r['BIO ID'] || '').trim().toLowerCase();
        var name = String(r['Name'] || '').trim().toLowerCase();
        var matches = bioId === empId;
        if (!matches && (!bioId || bioId === 'not found')) {
          matches = name === empName;
        }
        if (!matches) return false;

        var ts = maParseTimestamp_(r['Timestamp']);
        if (!ts) return false;
        var recDateStr = formatDateForInput_(ts);
        return recDateStr === dutyDateStr || (crossesMidnight && recDateStr === endDateStr);
      }).map(function (r) {
        return {
          type: String(r['Type'] || '').trim(),
          destination: r['Destination'] || '',
          timestamp: maParseTimestamp_(r['Timestamp']),
          photoLink: r['Photo Link'] || '',
          lat: parseFloat(r['Latitude']),
          lon: parseFloat(r['Longitude'])
        };
      }).sort(function (a, b) { return a.timestamp - b.timestamp; });

      btn.disabled = false;
      btn.textContent = originalLabel;

      if (!dayRecords.length) {
        showEl($('ma-records-empty'));
        return;
      }
      maPopulateSelectors_(dayRecords);
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      setMessage($('ma-attendance-error'), 'Failed to load attendance data: ' + err.message, true);
    });
}

function maPopulateSelectors_(dayRecords) {
  maStartInRecords = dayRecords.filter(function (r) { return r.type === 'Log In'; });
  maEndOutRecords = dayRecords.filter(function (r) { return r.type === 'Log Out'; });

  function optionsHtml(records) {
    return '<option value="">Select...</option>' + records.map(function (r, i) {
      return '<option value="' + i + '">' +
        escapeHtml_(r.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) +
        ' — ' + escapeHtml_(r.destination) + '</option>';
    }).join('');
  }

  $('ma-start-in').innerHTML = optionsHtml(maStartInRecords);
  $('ma-end-out').innerHTML = optionsHtml(maEndOutRecords);
  showEl($('ma-selectors'));
}

// ---- Calculation ----

// Regular Meal Allowance is auto-resolved from GPS (see maResolveDutyLocation_/
// maResolveRegularAllowance_ above) when duty hours qualify (>=5 hrs) and the
// location is recognized; otherwise it's a manual amount. Midnight Allowance
// has no automated business rule at all — it's always a manual amount typed
// in by whoever is entering the record.
function maRecomputeSummary_() {
  clearMessage($('ma-range-error'));
  hideEl($('ma-summary'));
  hideEl($('ma-btn-confirm'));
  maLastCalculation = null;

  var startIdx = $('ma-start-in').value;
  var endIdx = $('ma-end-out').value;
  if (startIdx === '' || endIdx === '') return;

  var startRec = maStartInRecords[Number(startIdx)];
  var endRec = maEndOutRecords[Number(endIdx)];
  if (!startRec || !endRec) return;

  if (endRec.timestamp.getTime() <= startRec.timestamp.getTime()) {
    setMessage($('ma-range-error'), 'End OUT must be after Start IN.', true);
    return;
  }

  var dutyHours = (endRec.timestamp.getTime() - startRec.timestamp.getTime()) / 3600000;
  var qualifies = dutyHours >= 5;

  var location = maResolveDutyLocation_(endRec);
  var resolved = (qualifies && location.matched) ? maResolveRegularAllowance_(endRec, location.store) : null;

  var locationHtml = location.matched
    ? '<div class="ma-summary-row"><span>Location</span><strong>' +
        escapeHtml_(location.store['City'] || '') +
        (location.store['Town'] && location.store['Town'] !== '-' ? ' / ' + escapeHtml_(location.store['Town']) : '') +
        ' — ' + escapeHtml_(location.store['Area/Region'] || '') + '</strong></div>'
    : '<div class="ma-summary-row"><span>Location</span><strong>GPS unavailable</strong></div>';

  var regularRowHtml;
  if (!qualifies) {
    regularRowHtml = '<div class="ma-summary-row"><span>Regular Meal Allowance (below 5 hrs)</span><strong>' + formatCurrency(0) + '</strong></div>';
  } else if (location.matched) {
    var isOwnStore = resolved.source === 'OwnMotherBranchTech' || resolved.source === 'OwnMotherBranchAreaHead';
    regularRowHtml = '<div class="ma-summary-row"><span>Regular Meal Allowance</span><strong>' + formatCurrency(resolved.amount) + '</strong></div>' +
      (isOwnStore ? '<p class="muted">Duty performed at own Mother Branch — no travel allowance.</p>' : '');
  } else {
    regularRowHtml =
      '<div class="ma-summary-row"><span>Regular Meal Allowance</span>' +
      '<input type="number" id="ma-regular-manual" min="0" step="0.01" placeholder="Enter amount"></div>' +
      '<p class="muted">GPS unavailable for this record — enter the Regular Meal Allowance amount manually.</p>';
  }

  var showMidnightInput = maIsInEveningToMidnightWindow_(endRec.timestamp);
  var midnightRowHtml = showMidnightInput
    ? '<div class="ma-summary-row"><span>Midnight Allowance</span>' +
      '<input type="number" id="ma-midnight-manual" min="0" step="0.01" placeholder="0.00"></div>'
    : '';

  var summary = $('ma-summary');
  summary.innerHTML =
    '<div class="ma-summary-row"><span>Duty Hours</span><strong>' + dutyHours.toFixed(2) + ' hrs</strong></div>' +
    locationHtml +
    regularRowHtml +
    midnightRowHtml +
    '<div class="ma-summary-row ma-summary-total"><span>Total</span><span id="ma-summary-total-value">' + formatCurrency(0) + '</span></div>' +
    '<div class="ma-summary-row"><span>Photo Proof (End OUT)</span><strong>' + (endRec.photoLink ? 'Available' : 'Missing') + '</strong></div>';
  showEl(summary);
  showEl($('ma-btn-confirm'));

  function recalculate() {
    var regularAmount;
    if (!qualifies) {
      regularAmount = 0;
    } else if (location.matched) {
      regularAmount = resolved.amount;
    } else {
      regularAmount = Number($('ma-regular-manual').value) || 0;
    }
    var midnightInputEl = $('ma-midnight-manual');
    var midnightAmount = midnightInputEl ? (Number(midnightInputEl.value) || 0) : 0;
    var total = regularAmount + midnightAmount;
    $('ma-summary-total-value').textContent = formatCurrency(total);

    maLastCalculation = {
      startIn: startRec.timestamp,
      endOut: endRec.timestamp,
      dutyHours: dutyHours,
      regular: regularAmount,
      midnight: midnightAmount,
      total: total,
      photoLink: endRec.photoLink,
      startDestination: startRec.destination || '',
      endDestination: endRec.destination || '',
      matchedStore: location.matched ? (location.store['Store'] || '') : '',
      city: location.matched ? (location.store['City'] || '') : '',
      town: location.matched ? (location.store['Town'] || '') : '',
      areaRegion: location.matched ? (location.store['Area/Region'] || '') : '',
      allowanceSource: !qualifies ? 'None' : (location.matched ? resolved.source : 'Manual'),
      endGpsMapLink: (isFinite(endRec.lat) && isFinite(endRec.lon))
        ? 'https://www.google.com/maps?q=' + endRec.lat + ',' + endRec.lon
        : ''
    };
  }

  var regularInput = $('ma-regular-manual');
  if (regularInput) regularInput.addEventListener('input', recalculate);
  var midnightInput = $('ma-midnight-manual');
  if (midnightInput) midnightInput.addEventListener('input', recalculate);

  recalculate();
}

// ---- Save ----

function maHandleConfirmSave_() {
  if (!maLastCalculation || !maSelectedEmployee) return;
  clearMessage($('ma-save-error'));
  clearMessage($('ma-save-success'));

  var btn = $('ma-btn-confirm');
  var originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving...';

  var dutyDate = $('ma-duty-date').value;

  runServer('saveMealAllowanceRecord', {
    employeeId: maSelectedEmployee.EmployeeID,
    employeeName: maSelectedEmployee.Name,
    dutyDate: dutyDate,
    startIn: maLastCalculation.startIn.toISOString(),
    endOut: maLastCalculation.endOut.toISOString(),
    dutyHours: maLastCalculation.dutyHours,
    regularMealAllowance: maLastCalculation.regular,
    midnightAllowance: maLastCalculation.midnight,
    totalAllowance: maLastCalculation.total,
    photoLink: maLastCalculation.photoLink,
    matchedStore: maLastCalculation.matchedStore,
    city: maLastCalculation.city,
    town: maLastCalculation.town,
    areaRegion: maLastCalculation.areaRegion,
    allowanceSource: maLastCalculation.allowanceSource,
    endGpsMapLink: maLastCalculation.endGpsMapLink
  })
    .then(function (result) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (!result.success) {
        setMessage($('ma-save-error'), result.error, true);
        return;
      }
      setMessage($('ma-save-success'), 'Meal allowance record ' + result.recordId + ' saved.', false);

      var savedLineItem = {
        employeeId: maSelectedEmployee.EmployeeID,
        dutyDate: dutyDate,
        total: maLastCalculation.total,
        dutyHours: maLastCalculation.dutyHours,
        photoLink: maLastCalculation.photoLink,
        startDestination: maLastCalculation.startDestination,
        endDestination: maLastCalculation.endDestination,
        city: maLastCalculation.city,
        areaRegion: maLastCalculation.areaRegion,
        endGpsMapLink: maLastCalculation.endGpsMapLink
      };

      maResetSelectorsAndSummary_();
      $('ma-duty-date').value = '';
      $('ma-crosses-midnight').checked = false;
      hideEl($('ma-end-date-row'));
      $('ma-duty-end-date').value = '';
      maUpdateLoadButtonState_();

      maLastSavedLineItem = savedLineItem;
      showEl($('ma-btn-add-to-request'));
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      setMessage($('ma-save-error'), 'Save failed: ' + err.message, true);
    });
}

// ---- Hand off to New Request ----

// Reuses employee.js's existing addLineItemRow()/updateRunningTotal() rather
// than duplicating line-item creation logic. Only offered when the utility's
// selected employee is the one currently logged in (New Request always
// submits as currentEmployee) — see the isCurrentEmployee check in
// maHandleConfirmSave_'s success handler.
function maHandleAddToNewRequest_() {
  if (!maLastSavedLineItem) return;
  clearMessage($('ma-add-to-request-error'));

  if (!maLastSavedLineItem.photoLink) {
    setMessage($('ma-add-to-request-error'),
      'This attendance record has no photo on file, so it cannot be attached as proof. It has still been saved to the Meal Allowance log.', true);
    return;
  }

  setEmployeeTab('new-request');
  addLineItemRow();

  var rows = document.querySelectorAll('#line-items-container .line-item-row');
  var row = rows[rows.length - 1];
  var hasLocation = !!maLastSavedLineItem.city;

  row.querySelector('.li-date').value = maLastSavedLineItem.dutyDate;
  row.querySelector('.li-amount').value = maLastSavedLineItem.total.toFixed(2);
  row.querySelector('.li-description').value =
    (maLastSavedLineItem.startDestination || 'Start') + ' → ' + (maLastSavedLineItem.endDestination || 'End') +
    ' (' + maLastSavedLineItem.dutyHours.toFixed(2) + ' hrs)' +
    (maLastSavedLineItem.endGpsMapLink ? ' — GPS: ' + maLastSavedLineItem.endGpsMapLink : '');
  if (hasLocation) {
    row.querySelector('.li-location').value = maLastSavedLineItem.city +
      (maLastSavedLineItem.areaRegion ? ' — ' + maLastSavedLineItem.areaRegion : '');
  }
  maLockRowAsMealAllowance_(row, maLastSavedLineItem.photoLink);

  updateRunningTotal();
  hideEl($('ma-btn-add-to-request'));
  maLastSavedLineItem = null;
}

// The shared line-item template no longer offers "Meal Allowance" as a
// manually-pickable category (it's utility-only now), so this row-specific
// option is injected here instead, then locked so it can't be changed.
// The file-upload receipt field is replaced with the attendance photo link.
// Base Location is deliberately left editable (just pre-filled) even though
// Date/Amount are locked — the GPS-matched store is only a stand-in for the
// employee's region, not necessarily the literal place they were at (real
// duty sometimes happens at an establishment that isn't in the store list
// at all), so the actual location text needs to stay correctable.
function maLockRowAsMealAllowance_(row, photoLink) {
  var categorySelect = row.querySelector('.li-category');
  var maOption = document.createElement('option');
  maOption.value = 'Meal Allowance';
  maOption.textContent = 'Meal Allowance';
  categorySelect.appendChild(maOption);
  categorySelect.value = 'Meal Allowance';
  categorySelect.disabled = true;

  var fileField = row.querySelector('.li-file-field');
  fileField.innerHTML = '<label>Receipt</label><p><a href="' + escapeHtml_(photoLink) +
    '" target="_blank" rel="noopener">View attendance photo</a> <span class="muted">(auto-attached)</span></p>';

  row.querySelector('.li-date').readOnly = true;
  row.querySelector('.li-amount').readOnly = true;

  row.dataset.receiptUrl = photoLink;
}

// ---- Reset helpers ----

function maResetSelectorsAndSummary_() {
  maStartInRecords = [];
  maEndOutRecords = [];
  maLastCalculation = null;
  maLastSavedLineItem = null;
  hideEl($('ma-selectors'));
  $('ma-start-in').innerHTML = '';
  $('ma-end-out').innerHTML = '';
  hideEl($('ma-summary'));
  $('ma-summary').innerHTML = '';
  hideEl($('ma-btn-confirm'));
  hideEl($('ma-records-empty'));
  hideEl($('ma-btn-add-to-request'));
  clearMessage($('ma-range-error'));
  clearMessage($('ma-attendance-error'));
  clearMessage($('ma-add-to-request-error'));
}
