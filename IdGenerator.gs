/**
 * Human-sortable, collision-improbable IDs. LockService around the caller's
 * critical section (see RequestService) is the real concurrency guard.
 */

// A short, sequential, human-friendly ID (REQ#000001, REQ#000002, ...)
// instead of a timestamp+random string. Safe without its own locking because
// every caller (submitLiquidationRequest) already invokes this from inside
// its own LockService.getScriptLock() section, so this read-increment-write
// can never race across concurrent submissions. Starts at 1 — pre-existing
// REQ-YYYYMMDD-... IDs stay as historical values and can't collide with this
// format, so no migration/backfill is needed.
function generateRequestId_() {
  var props = PropertiesService.getScriptProperties();
  var seq = Number(props.getProperty('nextRequestSeq') || '1');
  props.setProperty('nextRequestSeq', String(seq + 1));
  return 'REQ#' + String(seq).padStart(6, '0');
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

function generateExemptionId_() {
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var rand = Math.floor(100 + Math.random() * 900);
  return 'EXM-' + stamp + '-' + rand;
}
