/**
 * Human-sortable, collision-improbable IDs. LockService around the caller's
 * critical section (see RequestService) is the real concurrency guard.
 */

function generateRequestId_() {
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var rand = Math.floor(100 + Math.random() * 900);
  return 'REQ-' + stamp + '-' + rand;
}

function generateLineId_(requestId, index) {
  return requestId + '-L' + (index + 1);
}

function generateMealAllowanceId_() {
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var rand = Math.floor(100 + Math.random() * 900);
  return 'MA-' + stamp + '-' + rand;
}
