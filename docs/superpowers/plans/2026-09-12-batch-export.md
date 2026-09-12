# Batch PDF + CSV Export Implementation Plan (v2 — print-preview)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Export Reviewed/Disbursed" button to `admin.html`'s queue that downloads a line-item CSV and opens a print-preview report (summary table + one receipt image per page) covering every request currently `Reviewed` or `Authorized` (Disbursed).

**Architecture:** This is a v2 plan superseding an earlier jsPDF-based design. Tasks 1, 4, and 5 of that earlier plan are being **reverted** — a client-generated PDF file via jsPDF (which needed a new backend action, `getReceiptImageBase64`, to work around canvas-tainting) is replaced with a browser print-preview window, matching a proven pattern already live in a sibling project (`photolinepayroll/attendance-app`'s `admin.html`). The print window is built as a plain HTML string, opened via `window.open('', '_blank')`, and uses real `<img>` tags pointing at the app's *existing* `driveThumbnailUrl_()` thumbnail URLs — no canvas involved, so no backend byte-fetching action is needed at all. The already-built CSV export (Task 3 of the old plan: `csvField_`/`EXPORT_CSV_HEADERS`/`buildExportCsv_`/`downloadTextFile_`) is kept exactly as-is.

**Tech Stack:** Google Apps Script (backend, only touched to *revert* Task 1), vanilla JS (`frontend/admin.js`/`admin.html`), no PDF library. No test framework exists in this repo — verification is `node --check` plus manual/`curl` smoke tests.

**Current state before this plan starts** (for context — do not re-verify, just be aware):
- `frontend/admin.js` currently has, in order: the on-screen queue rendering code (unchanged, keep), then `csvField_`, `EXPORT_CSV_HEADERS`, `buildExportCsv_`, `downloadTextFile_` (Task 3 — **keep exactly as-is**), then `EXPORT_PDF_MARGIN` through `handleExportClick_` (Tasks 4/5 — **all of this is being deleted and replaced** by this plan).
- `DriveService.gs` currently has `getOrCreateFolder_`/`uploadReceiptFile_` (original, keep) followed by `extractDriveFileId_`/`isUnderDriveRoot_`/`getReceiptImageBase64` (Task 1 — **being deleted**).
- `Code.gs`'s `API_ACTIONS` currently includes `getReceiptImageBase64: getReceiptImageBase64` as its last entry — **being removed**.
- `frontend/admin.html` currently has a jsPDF CDN `<script>` tag (line ~83) — **being removed** — and a `<div class="card-header-row">` wrapping an `<h2>Liquidation Requests</h2>` and a `<button id="btn-export">` plus a `<div id="export-error">` (from the old Task 2) — **this markup is kept as-is**, along with `initExportButton_();` in the bootstrap script (also kept, since the function name is reused).
- The live Apps Script deployment currently has `getReceiptImageBase64` live (deployment @28) — this plan reverts that too.

---

### Task 1: Revert the backend `getReceiptImageBase64` action

**Files:**
- Modify: `DriveService.gs` (remove the appended functions)
- Modify: `Code.gs:11-22` (remove the `API_ACTIONS` entry)

- [ ] **Step 1: Remove the appended functions from `DriveService.gs`**

Read the current file first. It should end with `uploadReceiptFile_` (the original function) followed by three functions added for the now-reverted jsPDF approach: `extractDriveFileId_`, `isUnderDriveRoot_`, and `getReceiptImageBase64`, each preceded by a comment block. Delete all three functions and their preceding comments, so the file ends cleanly after `uploadReceiptFile_`'s closing brace:

```javascript
/**
 * Receipt storage: Liquidation Receipts/<EmployeeID>/<RequestID>/<LineID>_<filename>
 */

function getOrCreateFolder_(parentFolder, name) {
  var existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(name);
}

/** Decodes and saves one receipt file, returning its Drive URL. */
function uploadReceiptFile_(employeeId, requestId, lineId, file) {
  var root = getDriveRootFolder_();
  var employeeFolder = getOrCreateFolder_(root, String(employeeId));
  var requestFolder = getOrCreateFolder_(employeeFolder, String(requestId));

  var bytes = Utilities.base64Decode(file.base64Data);
  var blob = Utilities.newBlob(bytes, file.mimeType, lineId + '_' + file.filename);

  var driveFile = requestFolder.createFile(blob);
  driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return driveFile.getUrl();
}
```

(This is the file's original content, before Task 1 of the v1 plan touched it — confirm the result matches this exactly.)

- [ ] **Step 2: Remove the `API_ACTIONS` entry in `Code.gs`**

Change:

```javascript
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
  getReceiptImageBase64: getReceiptImageBase64
};
```

to:

```javascript
var API_ACTIONS = {
  getEmployeeByID: getEmployeeByID,
  getMyRequests: getMyRequests,
  getAllRequestsForPayroll: getAllRequestsForPayroll,
  submitLiquidationRequest: submitLiquidationRequest,
  advanceRequestStage: advanceRequestStage,
  updateLineItemAmount: updateLineItemAmount,
  loginApprover: loginApprover,
  searchEmployeesForUtility: searchEmployeesForUtility,
  saveMealAllowanceRecord: saveMealAllowanceRecord
};
```

- [ ] **Step 3: Push and deploy the reverted backend**

```bash
clasp push -f
clasp deploy -i AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg
```
Expected: both exit 0.

- [ ] **Step 4: Smoke-test that the action is genuinely gone**

```bash
curl -s "https://script.google.com/macros/s/AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg/exec" \
  -H "Content-Type: text/plain" \
  -d '{"action":"getReceiptImageBase64","args":["https://drive.google.com/file/d/abc/view"]}' -L
```
Expected: `{"success":false,"error":"Unknown action: getReceiptImageBase64"}` (the generic `dispatch_` fallback in `Code.gs`, not the old function's own error shape) — confirms the action is truly removed from the dispatch table, not just returning a different error.

Also re-confirm `getAllRequestsForPayroll` still works normally (unaffected by this revert):
```bash
curl -s "https://script.google.com/macros/s/AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg/exec?action=getAllRequestsForPayroll&arg0=Reviewed" -L
```
Expected: HTTP 200 with a JSON array (there is at least one real `Reviewed` request in the live sheet at time of writing, `REQ-20260912-085527-728`).

- [ ] **Step 5: Commit**

```bash
git add DriveService.gs Code.gs
git commit -m "$(cat <<'EOF'
Revert getReceiptImageBase64: no longer needed after switching PDF export
to a print-preview window instead of jsPDF

Receipt images now load via existing thumbnail URLs directly in a real
<img> tag in the print window, avoiding the canvas-tainting problem the
jsPDF approach needed a backend byte-fetching workaround for.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the jsPDF CDN dependency

**Files:**
- Modify: `frontend/admin.html` (remove the jsPDF `<script>` tag only)

- [ ] **Step 1: Remove the jsPDF script tag**

Change:

```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="config.js"></script>
  <script src="common.js"></script>
  <script src="admin.js"></script>
```

to:

```html
  <script src="config.js"></script>
  <script src="common.js"></script>
  <script src="admin.js"></script>
```

Leave everything else in `admin.html` untouched for now — the `.card-header-row`/`#btn-export`/`#export-error` markup from the old Task 2, and the `initExportButton_();` call in the bootstrap script, are both being **kept and reused** (Task 4 below redefines what `initExportButton_`/`handleExportClick_` actually do, without needing any further HTML changes).

- [ ] **Step 2: Verify**

```bash
node --check frontend/admin.js
```
Expected: no output — `admin.js` isn't touched in this task, this just confirms the baseline is unaffected.

Grep to confirm no other reference to jsPDF remains anywhere in the frontend (there shouldn't be any yet, since Task 3 hasn't rewritten `admin.js` to stop using `window.jspdf` yet — that's fine, this task only removes the library load; Task 3 removes the code that used it):
```bash
grep -rn "jspdf\|jsPDF" frontend/ --include=*.html
```
Expected: no matches (the CDN tag was the only reference in any `.html` file).

- [ ] **Step 3: Commit**

```bash
git add frontend/admin.html
git commit -m "$(cat <<'EOF'
Remove jsPDF CDN dependency

No longer needed now that PDF export uses a browser print-preview window
instead of client-generated jsPDF output.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove the obsolete jsPDF drawing code from `admin.js`

**Files:**
- Modify: `frontend/admin.js` (delete everything from `EXPORT_PDF_MARGIN` through the end of `handleExportClick_`)

- [ ] **Step 1: Delete the obsolete code block**

In `frontend/admin.js`, find the CSV code's end — the `downloadTextFile_` function's closing brace, immediately followed by a comment starting `// Landscape A4 gives 277mm...` — and delete everything from that comment through the end of the file (the closing brace of `handleExportClick_`). Specifically, delete:
- `EXPORT_PDF_MARGIN`, `EXPORT_PDF_ROW_HEIGHT`, `EXPORT_SUMMARY_COLUMNS`
- `truncateToWidth_`
- `formatDateForExport_` — **note:** this one is being deleted here but **re-added in Task 4** with the same name/behavior, since the new print-preview report also needs date formatting. Deleting it now and re-adding it in Task 4 keeps each task's diff self-contained and independently revertable; don't skip the delete just because it'll come back.
- `drawSummaryTableHeader_`
- `drawSummaryTable_`
- `addReceiptPages_`
- `addMissingReceiptsNote_`
- `initExportButton_`
- `handleExportClick_`

After this deletion, `frontend/admin.js` should end with `downloadTextFile_`'s closing brace and nothing after it — i.e. it ends exactly where it did right after the old Task 3 was originally completed, before Task 4 was ever applied.

- [ ] **Step 2: Verify syntax**

```bash
node --check frontend/admin.js
```
Expected: no output.

- [ ] **Step 3: Confirm the Export button is now inert again**

```bash
grep -n "btn-export\|export-error\|initExportButton_" frontend/admin.js frontend/admin.html
```
Expected: `admin.html` still references `btn-export`/`export-error` (the markup) and calls `initExportButton_();` in its bootstrap script; `admin.js` has **no** definition of `initExportButton_` anymore (it was just deleted) — meaning if `admin.html` were loaded right now, that bootstrap call would throw a `ReferenceError`. This is expected and temporary — Task 4 re-adds `initExportButton_` with new behavior. Don't "fix" this by touching `admin.html` in this task; it's resolved by the very next task.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin.js
git commit -m "$(cat <<'EOF'
Remove obsolete jsPDF-based PDF drawing code

Superseded by a print-preview approach (Task 4) — this is an intentionally
incomplete intermediate state; the Export button's initExportButton_/
handleExportClick_ are re-added with new behavior in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Build the print-preview report + wire the Export button

**Files:**
- Modify: `frontend/admin.js` (add after `downloadTextFile_`)

- [ ] **Step 1: Add the print-preview report builder**

Append to `frontend/admin.js`:

```javascript
function formatDateForExport_(value) {
  if (!value) return '';
  var d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

// Builds the print-preview report as a single HTML string: a summary table
// followed by one full-page receipt image per line item, then a trailing
// note listing any line with no ReceiptFileURL. Uses driveThumbnailUrl_
// (already defined in common.js, proven by the on-screen receipt modal) so
// each receipt is a plain cross-origin <img> — no canvas involved, so no
// backend byte-fetching action is needed the way jsPDF's addImage required.
function buildExportReportHtml_(requests) {
  var now = new Date().toLocaleDateString();

  var summaryRows = requests.map(function (req) {
    return '<tr>' +
      '<td>' + escapeHtml_(req.RequestID) + '</td>' +
      '<td>' + escapeHtml_(req.EmployeeName) + '</td>' +
      '<td>' + escapeHtml_(STATUS_DISPLAY_LABELS[req.Status] || req.Status) + '</td>' +
      '<td>' + escapeHtml_(formatCurrency(req.TotalAmount)) + '</td>' +
      '<td>' + escapeHtml_(req.ApprovedBy) + '<br>' + escapeHtml_(formatDateForExport_(req.ApprovedDate)) + '</td>' +
      '<td>' + escapeHtml_(req.ReviewedBy) + '<br>' + escapeHtml_(formatDateForExport_(req.ReviewedDate)) + '</td>' +
      '<td>' + escapeHtml_(req.AuthorizedBy) + '<br>' + escapeHtml_(formatDateForExport_(req.AuthorizedDate)) + '</td>' +
      '<td>' + escapeHtml_(formatDateForExport_(req.CreditingDate)) + '</td>' +
      '</tr>';
  }).join('');

  var missing = [];
  var receiptPages = [];
  requests.forEach(function (req) {
    (req.lines || []).forEach(function (line) {
      if (!line.ReceiptFileURL) {
        missing.push(req.RequestID + ' — ' + req.EmployeeName + ' — ' +
          formatDateForExport_(line.Date) + ' — ' + line.Category + ' (No receipt on file)');
        return;
      }
      var caption = req.RequestID + ' — ' + req.EmployeeName + ' — ' +
        formatDateForExport_(line.Date) + ' — ' + line.Category + ' — ' + formatCurrency(line.Amount);
      receiptPages.push(
        '<div class="receipt-page">' +
        '<p class="receipt-caption">' + escapeHtml_(caption) + '</p>' +
        '<img src="' + escapeHtml_(driveThumbnailUrl_(line.ReceiptFileURL)) + '" alt="Receipt">' +
        '</div>'
      );
    });
  });

  var missingHtml = missing.length
    ? '<div class="missing-note"><h2>Lines with no receipt on file</h2><ul>' +
      missing.map(function (m) { return '<li>' + escapeHtml_(m) + '</li>'; }).join('') +
      '</ul></div>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<title>Liquidation Export — ' + escapeHtml_(now) + '</title>' +
    '<style>' +
    '* { box-sizing: border-box; }' +
    'body { font-family: Arial, sans-serif; margin: 16px; color: #1e293b; }' +
    'h1 { color: #1e3a5f; font-size: 18px; margin-bottom: 4px; }' +
    'p.subtitle { color: #64748b; font-size: 12px; margin-top: 0; margin-bottom: 16px; }' +
    'table { width: 100%; border-collapse: collapse; font-size: 11px; }' +
    'th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }' +
    'th { background: #1e3a5f; color: #fff; }' +
    '.receipt-page { page-break-before: always; padding-top: 16px; }' +
    '.receipt-caption { font-weight: bold; font-size: 13px; margin-bottom: 8px; }' +
    '.receipt-page img { max-width: 100%; max-height: 90vh; display: block; margin: 0 auto; }' +
    '.missing-note { page-break-before: always; padding-top: 16px; }' +
    '.missing-note li { font-size: 12px; margin-bottom: 4px; }' +
    '.no-print { position: fixed; top: 16px; right: 16px; display: flex; gap: 8px; }' +
    '.no-print button { padding: 10px 18px; border: none; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }' +
    '.btn-print { background: #1e3a5f; color: #fff; }' +
    '.btn-close { background: #64748b; color: #fff; }' +
    '@media print { .no-print { display: none !important; } }' +
    '</style></head><body>' +
    '<div class="no-print">' +
    '<button class="btn-print" onclick="window.print()">Print / Save PDF</button>' +
    '<button class="btn-close" onclick="window.close()">Close</button>' +
    '</div>' +
    '<h1>Liquidation Requests Export — Reviewed / Disbursed</h1>' +
    '<p class="subtitle">Generated ' + escapeHtml_(now) + '</p>' +
    '<table><thead><tr>' +
    '<th>Request ID</th><th>Employee</th><th>Status</th><th>Total</th>' +
    '<th>Approved</th><th>Reviewed</th><th>Authorized</th><th>Crediting Date</th>' +
    '</tr></thead><tbody>' + summaryRows + '</tbody></table>' +
    receiptPages.join('') +
    missingHtml +
    '</body></html>';
}

function initExportButton_() {
  $('btn-export').addEventListener('click', handleExportClick_);
}

function handleExportClick_() {
  var btn = $('btn-export');
  var errorEl = $('export-error');
  clearMessage(errorEl);
  var originalLabel = btn.querySelector('span').textContent;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Exporting...';

  Promise.all([
    runServer('getAllRequestsForPayroll', 'Reviewed'),
    runServer('getAllRequestsForPayroll', 'Authorized')
  ]).then(function (results) {
    if (!Array.isArray(results[0]) || !Array.isArray(results[1])) {
      var failed = !Array.isArray(results[0]) ? results[0] : results[1];
      throw new Error(failed && failed.error ? failed.error : 'Failed to load requests.');
    }
    var requests = results[0].concat(results[1]);
    if (!requests.length) {
      setMessage(errorEl, 'No Reviewed or Disbursed requests to export.', true);
      return;
    }

    var dateStamp = new Date().toISOString().slice(0, 10);
    downloadTextFile_('liquidation-export-' + dateStamp + '.csv', 'text/csv', buildExportCsv_(requests));

    var reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      setMessage(errorEl, 'Please allow popups for this site to view the printable report.', true);
      return;
    }
    reportWindow.document.write(buildExportReportHtml_(requests));
    reportWindow.document.close();
  }).catch(function (err) {
    setMessage(errorEl, 'Export failed: ' + err.message, true);
  }).finally(function () {
    btn.disabled = false;
    btn.querySelector('span').textContent = originalLabel;
  });
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check frontend/admin.js
```
Expected: no output.

- [ ] **Step 3: Verify `buildExportReportHtml_`'s output structure**

No real browser is likely available. Verify with Node directly (this function has no DOM dependency other than the globals it reads, which can be stubbed):

```bash
node -e "
global.escapeHtml_ = function(v) { return String(v == null ? '' : v).replace(/[&<>\"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]; }); };
global.formatCurrency = function(n) { return Number(n || 0).toFixed(2); };
global.STATUS_DISPLAY_LABELS = { Authorized: 'Disbursed' };
global.driveThumbnailUrl_ = function(url) { return 'https://drive.google.com/thumbnail?id=FAKEID&sz=w2000'; };
var fs = require('fs');
var src = fs.readFileSync('frontend/admin.js', 'utf8');
eval(src.slice(src.indexOf('function formatDateForExport_'), src.indexOf('function initExportButton_')));
var html = buildExportReportHtml_([{
  RequestID: 'REQ-1', EmployeeName: 'Alontaga, Gilbert', Status: 'Authorized', TotalAmount: 500,
  ApprovedBy: 'A', ApprovedDate: '2026-09-01', ReviewedBy: 'B', ReviewedDate: '2026-09-02',
  AuthorizedBy: 'C', AuthorizedDate: '2026-09-03', CreditingDate: '2026-09-05',
  lines: [
    { Date: '2026-09-01', Category: 'Fare', Amount: 100, ReceiptFileURL: 'https://drive.google.com/file/d/abc/view' },
    { Date: '2026-09-01', Category: 'Meal Allowance', Amount: 100 }
  ]
}]);
console.log('has receipt img:', html.indexOf('<img src=\"https://drive.google.com/thumbnail') !== -1);
console.log('has missing note:', html.indexOf('No receipt on file') !== -1);
console.log('has print button:', html.indexOf('window.print()') !== -1);
console.log('status shows Disbursed:', html.indexOf('>Disbursed<') !== -1);
"
```
Expected: all four `console.log` lines print `true`.

- [ ] **Step 4: Commit**

```bash
git add frontend/admin.js
git commit -m "$(cat <<'EOF'
Build print-preview export report and wire up the Export button

Replaces jsPDF with a plain HTML report opened in a new tab, using the
browser's native print/Save-as-PDF — matches the pattern already proven in
the sibling attendance-app project. Receipt images load via the existing
driveThumbnailUrl_ helper as real <img> tags, so no backend action is
needed to fetch receipt bytes. CSV export (already built) is unchanged;
the button now downloads the CSV and opens the report in one click.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm the backend revert and frontend rebuild are both live**

```bash
clasp deployments
```
Confirm the target deployment ID is at the version deployed in Task 1, Step 3.

```bash
node --check frontend/admin.js
```
Expected: no output.

- [ ] **Step 2: Manual browser test — happy path**

Open `admin.html`, log in as any approver, ensure at least one request each is currently `Reviewed` and `Authorized` (advance a test request through the stages first if needed — there is already at least one real `Reviewed` request in the live sheet, `REQ-20260912-085527-728`, as of this plan being written). Click "Export Reviewed/Disbursed". Confirm:
- A CSV downloads named `liquidation-export-<today>.csv` — one row per line item, correct columns (unchanged behavior from the already-verified Task 3 CSV builder).
- A new browser tab/window opens showing the report: a summary table listing every Reviewed/Authorized request, followed by one page per receipt (each captioned, image visible and legible), followed by a missing-receipts note if applicable.
- Click the in-page "Print / Save PDF" button (or Ctrl+P) and confirm the browser's print preview shows the summary table and each receipt on its own page, with the "Print / Save PDF"/"Close" buttons hidden in the print preview (not printed).
- Click "Close" and confirm the tab closes.
- Confirm the main Export button re-enables with its original label after the flow completes.

- [ ] **Step 3: Manual browser test — missing receipt**

Find or create a Reviewed/Authorized request with a line that has no `ReceiptFileURL` (e.g. an older test request, if one exists). Export again and confirm that line appears in the "Lines with no receipt on file" section at the end of the report rather than a broken image or a skipped/silent gap.

- [ ] **Step 4: Manual browser test — empty result set and popup-blocked**

Temporarily test in a state with no Reviewed/Authorized requests (or filter your test data) and confirm the "No Reviewed or Disbursed requests to export." message shows with no download/window. Separately, enable your browser's popup blocker for the site and click Export again — confirm the CSV still downloads and a clear "Please allow popups..." message shows instead of a silent no-op.

- [ ] **Step 5: Update `resume.md` and `CLAUDE.md`**

Add a new numbered item to `resume.md`'s history documenting: the batch export feature was built, initially via jsPDF (Task 1-5 of the v1 plan), then revised mid-implementation after the user pointed to the `photolinepayroll/attendance-app` sibling project's simpler print-preview pattern — describe what was reverted (the `getReceiptImageBase64` backend action, jsPDF CDN dependency, and jsPDF drawing code) and what the final shipped behavior is (CSV unchanged from the original Task 3; PDF replaced by a `window.open` print-preview report using `driveThumbnailUrl_` directly). Update `CLAUDE.md`'s "Planned work" section — remove it entirely now that the feature is shipped, and instead add a short paragraph to the Architecture section (near `admin.js`'s other documented behaviors) describing the Export button, matching this codebase's existing style of documenting non-obvious "why" decisions (e.g. why print-preview instead of jsPDF, why no backend action is needed).

- [ ] **Step 6: Commit**

```bash
git add resume.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Document completed batch export feature (print-preview revision)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
