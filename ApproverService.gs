/**
 * User ID + password identity lookup for Payroll's 3-stage approval chain.
 * Not real authentication (see CLAUDE.md's security-model note) — but it
 * does mean the audit trail records a full name the backend itself verified
 * via a matching Approvers row, not whatever string the client happened to send.
 */

function getApproverByCredentials_(userId, password) {
  if (!userId || !password) {
    return { found: false, error: 'Invalid User ID or password.' };
  }

  var approvers = getAllRowsAsObjects_(SHEET_APPROVERS);
  var match = approvers.filter(function (row) {
    return String(row.UserID) === String(userId);
  })[0];

  if (!match || String(match.Password) !== String(password) || match.Active !== true) {
    return { found: false, error: 'Invalid User ID or password.' };
  }

  return { found: true, fullName: match.FullName, role: match.Role, biometricId: match.BiometricID };
}

function loginApprover(userId, password) {
  return getApproverByCredentials_(userId, password);
}
