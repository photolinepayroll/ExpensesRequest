/**
 * Employee lookup used for the no-login "enter your Employee ID" flow.
 */

function getEmployeeByID(employeeId) {
  if (!employeeId) {
    return { found: false, error: 'Biometric ID no. is required.' };
  }

  var employees = getAllRowsAsObjects_(SHEET_EMPLOYEES);
  var match = employees.filter(function (row) {
    return String(row.EmployeeID) === String(employeeId);
  })[0];

  if (!match) {
    return { found: false, error: 'Biometric ID no. not found.' };
  }
  if (match.Active !== true) {
    return { found: false, error: 'This Biometric ID no. is inactive.' };
  }

  return {
    found: true,
    employee: {
      EmployeeID: match.EmployeeID,
      Name: match.Name,
      Department: match.Department,
      BaseLocation: match.BaseLocation
    }
  };
}

// Used by RequestService.gs's advanceRequestStage to resolve the required
// approver for a Pending request (see StoreDirectoryService.gs's
// resolveRequiredApprover_/resolveEmployeeCategory_) — BaseLocation for the
// Staff-category store lookup, Department to catch Technical/Audit-dept
// employees who aren't individually listed as *the* assigned Tech/Auditor
// for any one store. Returns blank fields if the employee can't be found,
// rather than throwing — the caller treats that as "fall back to the
// unscoped role check".
function getEmployeeRoutingInfo_(employeeId) {
  var employees = getAllRowsAsObjects_(SHEET_EMPLOYEES);
  var match = employees.filter(function (row) {
    return String(row.EmployeeID) === String(employeeId);
  })[0];
  return {
    baseLocation: match ? match.BaseLocation : '',
    department: match ? match.Department : ''
  };
}
