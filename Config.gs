/**
 * Central configuration. Fill in SPREADSHEET_ID and DRIVE_ROOT_FOLDER_ID
 * after creating the Sheet and Drive folder (see plan's Deployment section).
 */

var SPREADSHEET_ID = '1HnVD67MnD1pqIRxF2Jn9rFAGiFOcQ4WcPi9MStBIRlk';
var DRIVE_ROOT_FOLDER_ID = '1LVoWqXcAmplZmLtoLuXTLCBAT3ImPXm2';

var SHEET_EMPLOYEES = 'Employees';
var SHEET_REQUESTS = 'Requests';
var SHEET_REQUEST_LINES = 'RequestLines';
var SHEET_APPROVERS = 'Approvers';
var SHEET_MEAL_ALLOWANCES = 'MealAllowances';

var CATEGORIES = ['Fare', 'Meal Allowance', 'Accommodation', 'Timesheet'];

var STATUS_PENDING = 'Pending';
var STATUS_APPROVED = 'Approved';
var STATUS_REVIEWED = 'Reviewed';
var STATUS_AUTHORIZED = 'Authorized'; // terminal — cleared to disburse
var STATUS_REJECTED = 'Rejected'; // terminal — can happen from Pending/Approved/Reviewed

// Sequential approval checkpoints. A request must advance one stage at a time,
// or move to STATUS_REJECTED from any non-terminal stage.
var STAGE_ORDER = [STATUS_PENDING, STATUS_APPROVED, STATUS_REVIEWED, STATUS_AUTHORIZED];

// Each stage in STAGE_ORDER (except the initial Pending) is gated by one of
// these roles, looked up from the Approvers sheet via a personal PIN.
var ROLE_APPROVER = 'Approver';
var ROLE_REVIEWER = 'Reviewer';
var ROLE_AUTHORIZER = 'Authorizer';

// Published (Publish to web, CSV) directory mapping each store to its
// assigned Area Head/Technical/Audit staff (by Biometric ID), plus the 3
// fixed org-wide approvers (Area Head requests -> Jayriel, Technical -> Cris,
// Audit -> Lanilyn). Fetched server-side (StoreDirectoryService.gs) to
// authoritatively gate who can approve a Pending request. Has duplicate/
// blank headers, so read by fixed column index, not by header name.
var STORE_DIRECTORY_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQFtMwuPhOPY7h4GlrGI4DhTrnHx4OKBcEIizjwAH53N1NWnnrdxZftEnNQmDePhtEvFPoLjkRd61TX/pub?gid=1184189088&single=true&output=csv';

var MAX_RECEIPT_BYTES = 2 * 1024 * 1024; // 2MB — client compresses toward ~1MB, this is the server-side ceiling
var ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getDriveRootFolder_() {
  return DriveApp.getFolderById(DRIVE_ROOT_FOLDER_ID);
}
