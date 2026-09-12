/**
 * Backend for the "Meal Allowance" employee utility. Independent of
 * RequestService.gs's liquidation-request pipeline — this computes and logs
 * a duty-based meal/midnight allowance from external attendance data (the
 * attendance CSV itself is fetched client-side; see frontend/meal-allowance.js).
 * Saved records land in their own MealAllowances sheet, purely for payroll
 * reference — they are not Requests and do not go through any approval stage.
 */

function searchEmployeesForUtility(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  var employees = getAllRowsAsObjects_(SHEET_EMPLOYEES);
  var matches = employees.filter(function (row) {
    if (row.Active !== true) return false;
    var id = String(row.EmployeeID || '').toLowerCase();
    var name = String(row.Name || '').toLowerCase();
    return id.indexOf(q) !== -1 || name.indexOf(q) !== -1;
  });

  return matches.slice(0, 15).map(function (row) {
    return { EmployeeID: row.EmployeeID, Name: row.Name };
  });
}

function saveMealAllowanceRecord(payload) {
  if (!payload) {
    return { success: false, error: 'Request payload is missing.' };
  }
  if (!payload.employeeId || !payload.employeeName) {
    return { success: false, error: 'Employee is required.' };
  }
  if (!payload.dutyDate) {
    return { success: false, error: 'Duty date is required.' };
  }

  var startIn = new Date(payload.startIn);
  var endOut = new Date(payload.endOut);
  if (isNaN(startIn.getTime()) || isNaN(endOut.getTime())) {
    return { success: false, error: 'Start IN and End OUT must be valid times.' };
  }
  if (endOut.getTime() <= startIn.getTime()) {
    return { success: false, error: 'End OUT must be after Start IN.' };
  }

  var dutyHours = Number(payload.dutyHours);
  var regularMealAllowance = Number(payload.regularMealAllowance);
  var midnightAllowance = Number(payload.midnightAllowance);
  var totalAllowance = Number(payload.totalAllowance);
  if (!isFinite(dutyHours) || dutyHours < 0) {
    return { success: false, error: 'Duty hours must be a non-negative number.' };
  }
  if (!isFinite(regularMealAllowance) || regularMealAllowance < 0 ||
      !isFinite(midnightAllowance) || midnightAllowance < 0 ||
      !isFinite(totalAllowance) || totalAllowance < 0) {
    return { success: false, error: 'Allowance amounts must be non-negative numbers.' };
  }

  var recordId = generateMealAllowanceId_();

  appendRowFromObject_(SHEET_MEAL_ALLOWANCES, {
    RecordID: recordId,
    EmployeeID: payload.employeeId,
    EmployeeName: payload.employeeName,
    DutyDate: payload.dutyDate,
    StartIn: startIn,
    EndOut: endOut,
    DutyHours: dutyHours,
    RegularMealAllowance: regularMealAllowance,
    MidnightAllowance: midnightAllowance,
    TotalAllowance: totalAllowance,
    SubmittedDate: new Date(),
    PhotoLink: payload.photoLink || '',
    MatchedStore: payload.matchedStore || '',
    City: payload.city || '',
    Town: payload.town || '',
    AreaRegion: payload.areaRegion || '',
    AllowanceSource: payload.allowanceSource || ''
  });

  return { success: true, recordId: recordId };
}
