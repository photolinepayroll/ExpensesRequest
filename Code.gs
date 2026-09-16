/**
 * JSON API entry point. The frontend is a fully separate static site
 * (see /frontend, deployable to GitHub Pages) that calls this web app's
 * /exec URL over fetch() — this file no longer serves any HTML.
 *
 * GET  <url>?action=<name>&arg0=...&arg1=...   -> read-only calls (no file payloads)
 * POST <url>  body: {"action": "<name>", "args": [...]}  (Content-Type: text/plain
 *      to avoid a CORS preflight, which Apps Script cannot answer) -> mutations
 */

var API_ACTIONS = {
  getEmployeeByID: getEmployeeByID,
  getMyRequests: getMyRequests,
  getAllRequestsForPayroll: getAllRequestsForPayroll,
  submitLiquidationRequest: submitLiquidationRequest,
  advanceRequestStage: advanceRequestStage,
  updateLineItemAmount: updateLineItemAmount,
  loginApprover: loginApprover,
  searchEmployeesForUtility: searchEmployeesForUtility,
  saveMealAllowanceRecord: saveMealAllowanceRecord,
  grantSubmissionExemption: grantSubmissionExemption,
  revokeSubmissionExemption: revokeSubmissionExemption,
  getActiveSubmissionExemptions: getActiveSubmissionExemptions,
  checkMySubmissionExemption: checkMySubmissionExemption
};

function doGet(e) {
  var action = e.parameter.action;
  if (!action) {
    return jsonResponse_({
      success: false,
      error: 'This is a JSON API endpoint. Call it with ?action=<name>, or POST for mutations.'
    });
  }
  return dispatch_(action, extractGetArgs_(e));
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ success: false, error: 'Invalid JSON request body.' });
  }
  return dispatch_(body.action, body.args || []);
}

function extractGetArgs_(e) {
  var args = [];
  var i = 0;
  while (Object.prototype.hasOwnProperty.call(e.parameter, 'arg' + i)) {
    args.push(e.parameter['arg' + i]);
    i++;
  }
  return args;
}

function dispatch_(action, args) {
  var fn = API_ACTIONS[action];
  if (!fn) {
    return jsonResponse_({ success: false, error: 'Unknown action: ' + action });
  }
  try {
    return jsonResponse_(fn.apply(null, args));
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
