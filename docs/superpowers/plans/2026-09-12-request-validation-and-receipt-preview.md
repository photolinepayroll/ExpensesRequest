# Required-Field Highlighting + Receipt Preview/Amount-Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (1) required-field highlighting on New Request submit, and (2) a Messenger-style receipt preview modal — shared by both pages, with Amount editable by the Approver/Reviewer whose turn it currently is.

**Architecture:** Two independent, additive frontend features plus one new backend mutation. No existing function's behavior changes except `buildLineItemsHtml_`'s Receipt cell (a plain link becomes a click target for the new modal) and `addLineItemRow`'s per-row wiring (gains blur-clearing listeners). The new backend action (`updateLineItemAmount` in `RequestService.gs`) reuses every guard `advanceRequestStage` already has (role check, Pending-stage routing check, locking) rather than inventing new authorization logic.

**Tech Stack:** Vanilla JS (no framework), Google Apps Script backend, Google Sheets datastore. No test framework exists in this repo — verification is `node --check` (syntax) plus manual browser testing against the live `/exec` deployment, per this project's own conventions (see `CLAUDE.md`).

**Note:** This project is not a git repository (`git rev-parse --is-inside-work-tree` fails here), so there are no "commit" steps below — each task ends with "save the file" instead.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/styles.css` | `.input-error` style; new `.receipt-modal*` styles (Messenger-style overlay). |
| `frontend/employee.js` | Required-field validation on submit; clears `.input-error` as fields are edited. |
| `frontend/common.js` | Shared receipt/detail modal (`ensureReceiptModal_`, `openLineItemPreview_`); row-click wiring (`wireLineItemRows_`); `buildLineItemsHtml_` gains `data-line-id` + drops the raw `<a>`; `renderRequestsTable` calls the new wiring function. |
| `frontend/admin.js` | `ensureApproverPassword_` extracted from `process()` and reused; `isLineEditableForCurrentApprover_` + `saveLineItemAmount_` wired into `loadAdminRequests`'s `renderRequestsTable` call. |
| `RequestService.gs` | New `updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark)`. |
| `Code.gs` | Register `updateLineItemAmount` in `API_ACTIONS`. |

---

### Task 1: CSS — required-field highlight + receipt modal styles

**Files:**
- Modify: `frontend/styles.css`

- [ ] **Step 1: Add `.input-error` next to the existing form input rules**

Insert right after the existing `.field { margin-bottom: var(--space-4); }` rule (around line 209):

```css
.field { margin-bottom: var(--space-4); }

.input-error {
  border-color: var(--color-danger) !important;
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.12);
}
```

- [ ] **Step 2: Add the receipt modal styles at the end of the file**

Append after the existing `.ma-summary-row.ma-summary-total { ... }` block (end of file):

```css
/* ---- Receipt preview modal ---- */

.receipt-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  z-index: 100;
}

.receipt-modal {
  position: relative;
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  max-width: 900px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-md);
}
@media (min-width: 720px) {
  .receipt-modal { flex-direction: row; }
}

.receipt-modal-image-pane {
  flex: 1 1 55%;
  background: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 260px;
}
.receipt-modal-image-pane img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}
.receipt-modal-placeholder {
  color: #cbd5e1;
  text-align: center;
  padding: var(--space-5);
  font-size: 0.9rem;
}
.receipt-modal-placeholder svg { width: 40px; height: 40px; margin-bottom: var(--space-2); opacity: 0.7; }

.receipt-modal-details {
  flex: 1 1 45%;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.receipt-modal-details h3 { font-size: 1rem; margin-bottom: var(--space-1); }
.receipt-modal-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 0.9rem;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
}
.receipt-modal-row .rm-label { color: var(--color-muted-text); font-weight: 600; }
.receipt-modal-row .rm-value { text-align: right; }
.receipt-modal-amount-edit { display: flex; gap: var(--space-2); align-items: center; }
.receipt-modal-amount-edit input { max-width: 140px; }

.receipt-modal-close {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(15, 23, 42, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2;
}
.receipt-modal-close:hover { background: rgba(15, 23, 42, 0.8); }
.receipt-modal-close svg { width: 18px; height: 18px; }

table.data-table tr.line-detail-row { cursor: pointer; transition: background 100ms ease; }
table.data-table tr.line-detail-row:hover { background: var(--color-surface); }
table.data-table tr.line-detail-row:focus-visible { outline-offset: -2px; }
```

- [ ] **Step 3: Save the file. No build step exists for CSS — visual verification happens in Task 8.**

---

### Task 2: Required-field highlighting on submit (`employee.js`)

**Files:**
- Modify: `frontend/employee.js`

- [ ] **Step 1: Wire per-field error-clearing when a line item row is created**

In `addLineItemRow` (around line 268-304), immediately after the existing `LINE_ITEM_FIELDS.forEach(...)` block that assigns `id`/`for` (ends around line 281), add:

```javascript
  LINE_ITEM_FIELDS.forEach(function (field) {
    var input = clone.querySelector('.li-' + field);
    var label = clone.querySelector('.li-' + field + '-label');
    var fieldId = rowId + '-' + field;
    input.id = fieldId;
    label.setAttribute('for', fieldId);
  });

  ['date', 'category', 'location', 'amount', 'description'].forEach(function (field) {
    var requiredInput = clone.querySelector('.li-' + field);
    var clearEvent = (field === 'category') ? 'change' : 'input';
    requiredInput.addEventListener(clearEvent, function () {
      requiredInput.classList.remove('input-error');
    });
  });
```

- [ ] **Step 2: Add the validation function**

Add this new function right before `function handleSubmitRequest() {` (around line 348):

```javascript
// Highlights any required line-item field left blank (or, for Amount, not a
// positive number) and returns false if anything is invalid. Receipt stays
// optional. Runs only on Submit click, not real-time.
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
  });

  if (firstInvalid) firstInvalid.focus();
  return allValid;
}
```

- [ ] **Step 3: Call it from `handleSubmitRequest`**

Find the start of `handleSubmitRequest` (around line 348-357):

```javascript
function handleSubmitRequest() {
  var errorEl = $('submit-error');
  var successEl = $('submit-success');
  clearMessage(errorEl);
  clearMessage(successEl);

  if (!document.querySelectorAll('#line-items-container .line-item-row').length) {
    setMessage(errorEl, 'Add at least one line item.', true);
    return;
  }
```

Add the new check immediately after the existing "at least one line item" check:

```javascript
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
```

- [ ] **Step 4: Syntax check**

Run: `node --check "D:/EXPENSES FARE/frontend/employee.js"`
Expected: no output (exit code 0).

- [ ] **Step 5: Save the file.**

---

### Task 3: Shared receipt/detail modal (`common.js`)

**Files:**
- Modify: `frontend/common.js`

- [ ] **Step 1: Replace `buildLineItemsHtml_`'s Receipt cell and add `data-line-id`**

Find (around line 128-145):

```javascript
function buildLineItemsHtml_(request) {
  var html = '<table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Location</th><th>Amount</th><th>Description</th><th>Receipt</th></tr></thead><tbody>';
  request.lines.forEach(function (line) {
    html += '<tr>';
    html += '<td data-label="Date">' + formatDateDisplay(line.Date) + '</td>';
    html += '<td data-label="Category">' + escapeHtml_(line.Category) + '</td>';
    html += '<td data-label="Location">' + escapeHtml_(line.BaseLocation) + '</td>';
    html += '<td data-label="Amount">' + formatCurrency(line.Amount) + '</td>';
    html += '<td data-label="Description">' + escapeHtml_(line.Description) + '</td>';
    html += '<td data-label="Receipt">' + (line.ReceiptFileURL
      ? '<a href="' + escapeHtml_(line.ReceiptFileURL) + '" target="_blank" rel="noopener">View</a>'
      : '<span class="muted">None</span>') + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += buildAuditTrailHtml_(request);
  return html;
}
```

Replace with (the whole row is now the click target that opens the preview modal, so the Receipt cell is plain text, not a separate link):

```javascript
function buildLineItemsHtml_(request) {
  var html = '<table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Location</th><th>Amount</th><th>Description</th><th>Receipt</th></tr></thead><tbody>';
  request.lines.forEach(function (line) {
    html += '<tr class="line-detail-row" data-line-id="' + escapeHtml_(line.LineID) + '" tabindex="0" role="button">';
    html += '<td data-label="Date">' + formatDateDisplay(line.Date) + '</td>';
    html += '<td data-label="Category">' + escapeHtml_(line.Category) + '</td>';
    html += '<td data-label="Location">' + escapeHtml_(line.BaseLocation) + '</td>';
    html += '<td data-label="Amount">' + formatCurrency(line.Amount) + '</td>';
    html += '<td data-label="Description">' + escapeHtml_(line.Description) + '</td>';
    html += '<td data-label="Receipt">' + (line.ReceiptFileURL
      ? '<span class="link-inline">View</span>'
      : '<span class="muted">None</span>') + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += buildAuditTrailHtml_(request);
  return html;
}
```

- [ ] **Step 2: Wire the row clicks — add `wireLineItemRows_` right after `buildLineItemsHtml_`**

Insert this new function immediately after the `buildLineItemsHtml_` function (before the `// Checkpoints in display order...` comment / `AUDIT_TRAIL_STAGES` block):

```javascript
// Opens the shared receipt/detail preview for whichever line item's row was
// clicked. `options` is the same object passed into renderRequestsTable:
// options.isLineEditable(request) -> bool decides whether Amount is editable
// (admin.js only; My Requests never passes it, so it stays view-only), and
// options.onSaveAmount(request, line, newAmount) -> Promise performs the save.
function wireLineItemRows_(panel, request, options) {
  function openFor(row) {
    var lineId = row.getAttribute('data-line-id');
    var line = null;
    request.lines.forEach(function (l) {
      if (String(l.LineID) === String(lineId)) line = l;
    });
    if (!line) return;

    var editable = !!(options.isLineEditable && options.isLineEditable(request));
    openLineItemPreview_(line, {
      editable: editable,
      onSaveAmount: (editable && options.onSaveAmount)
        ? function (newAmount) { return options.onSaveAmount(request, line, newAmount); }
        : null
    });
  }

  panel.querySelectorAll('tr.line-detail-row').forEach(function (row) {
    row.addEventListener('click', function () { openFor(row); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFor(row);
      }
    });
  });
}
```

- [ ] **Step 3: Call `wireLineItemRows_` from `renderRequestsTable`'s `toggleRow`**

Find (around line 99-115):

```javascript
  function toggleRow(row) {
    var idx = row.getAttribute('data-idx');
    var detailRow = container.querySelector('[data-detail-idx="' + idx + '"]');
    var isHidden = detailRow.classList.contains('hidden');
    container.querySelectorAll('.detail-row').forEach(function (r) { r.classList.add('hidden'); });
    container.querySelectorAll('.request-row').forEach(function (r) { r.setAttribute('aria-expanded', 'false'); });
    if (isHidden) {
      detailRow.classList.remove('hidden');
      row.setAttribute('aria-expanded', 'true');
      var panel = $('detail-panel-' + idx);
      if (!panel.dataset.rendered) {
        panel.innerHTML = buildLineItemsHtml_(requests[idx]);
        panel.dataset.rendered = '1';
        if (options.onDetailRendered) options.onDetailRendered(panel, requests[idx]);
      }
    }
  }
```

Replace the `if (!panel.dataset.rendered) { ... }` block with:

```javascript
      if (!panel.dataset.rendered) {
        panel.innerHTML = buildLineItemsHtml_(requests[idx]);
        panel.dataset.rendered = '1';
        wireLineItemRows_(panel, requests[idx], options);
        if (options.onDetailRendered) options.onDetailRendered(panel, requests[idx]);
      }
```

- [ ] **Step 4: Add the modal builder + opener functions**

Add these two functions at the end of `common.js` (after the last existing function in the file):

```javascript
// ---- Shared receipt/line-item preview modal (used by both index.html's My
// Requests and admin.html's queue) — injected into the DOM once, reused for
// every open. View-only unless opened with { editable: true, onSaveAmount }.

var receiptModal_ = null;

function ensureReceiptModal_() {
  if (receiptModal_) return receiptModal_;

  var backdrop = document.createElement('div');
  backdrop.className = 'receipt-modal-backdrop hidden';
  backdrop.innerHTML =
    '<div class="receipt-modal">' +
    '<button type="button" class="receipt-modal-close" aria-label="Close">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
    '</button>' +
    '<div class="receipt-modal-image-pane"></div>' +
    '<div class="receipt-modal-details"></div>' +
    '</div>';
  document.body.appendChild(backdrop);

  function close() { backdrop.classList.add('hidden'); }

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.receipt-modal-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
  });

  receiptModal_ = { backdrop: backdrop, close: close };
  return receiptModal_;
}

var RECEIPT_PLACEHOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

function openLineItemPreview_(line, options) {
  options = options || {};
  var modal = ensureReceiptModal_();
  var imagePane = modal.backdrop.querySelector('.receipt-modal-image-pane');
  var detailsPane = modal.backdrop.querySelector('.receipt-modal-details');

  if (line.ReceiptFileURL) {
    imagePane.innerHTML = '<img src="' + escapeHtml_(line.ReceiptFileURL) + '" alt="Receipt">';
    imagePane.querySelector('img').addEventListener('error', function () {
      imagePane.innerHTML =
        '<div class="receipt-modal-placeholder">' + RECEIPT_PLACEHOLDER_ICON +
        '<p>Preview not available.</p>' +
        '<a href="' + escapeHtml_(line.ReceiptFileURL) + '" target="_blank" rel="noopener" class="link-inline">Open receipt in new tab</a>' +
        '</div>';
    }, { once: true });
  } else {
    imagePane.innerHTML =
      '<div class="receipt-modal-placeholder">' + RECEIPT_PLACEHOLDER_ICON + '<p>No receipt uploaded.</p></div>';
  }

  var amountHtml = options.editable
    ? '<div class="receipt-modal-amount-edit">' +
      '<input type="number" step="0.01" min="0.01" class="receipt-modal-amount-input" value="' + Number(line.Amount).toFixed(2) + '">' +
      '<button type="button" class="btn btn-primary btn-small receipt-modal-save-btn" disabled>Save Amount</button>' +
      '</div>'
    : escapeHtml_(formatCurrency(line.Amount));

  detailsPane.innerHTML =
    '<h3>Line item details</h3>' +
    '<div class="receipt-modal-row"><span class="rm-label">Date</span><span class="rm-value">' + escapeHtml_(formatDateDisplay(line.Date)) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Category</span><span class="rm-value">' + escapeHtml_(line.Category) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Location</span><span class="rm-value">' + escapeHtml_(line.BaseLocation) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Description</span><span class="rm-value">' + escapeHtml_(line.Description) + '</span></div>' +
    '<div class="receipt-modal-row"><span class="rm-label">Amount</span><span class="rm-value">' + amountHtml + '</span></div>' +
    '<div class="msg msg-error hidden receipt-modal-error" role="alert"></div>';

  if (options.editable) {
    var input = detailsPane.querySelector('.receipt-modal-amount-input');
    var saveBtn = detailsPane.querySelector('.receipt-modal-save-btn');
    var errorEl = detailsPane.querySelector('.receipt-modal-error');
    var originalValue = input.value;

    input.addEventListener('input', function () {
      var num = Number(input.value);
      saveBtn.disabled = (input.value === originalValue) || !num || num <= 0;
    });

    saveBtn.addEventListener('click', function () {
      var newAmount = Number(input.value);
      if (!newAmount || newAmount <= 0) return;
      clearMessage(errorEl);
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      options.onSaveAmount(newAmount)
        .then(function () {
          line.Amount = newAmount;
          originalValue = input.value;
          saveBtn.textContent = 'Saved';
        })
        .catch(function (err) {
          setMessage(errorEl, err.message, true);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Amount';
        });
    });
  }

  modal.backdrop.classList.remove('hidden');
}
```

- [ ] **Step 5: Syntax check**

Run: `node --check "D:/EXPENSES FARE/frontend/common.js"`
Expected: no output (exit code 0).

- [ ] **Step 6: Save the file.**

---

### Task 4: Approver-side editability + save wiring (`admin.js`)

**Files:**
- Modify: `frontend/admin.js`

- [ ] **Step 1: Extract the password-reprompt gate into a reusable function**

Find the `process` function inside `wireAdminActions_` (around line 138-164):

```javascript
  function process(targetStage, triggeringBtn) {
    clearMessage(errorEl);

    if (!currentApprover.password) {
      var pwd = window.prompt('Re-enter your password to confirm this action, ' + currentApprover.fullName + ':');
      if (!pwd) return; // cancelled
      currentApprover.password = pwd; // memory-only for the rest of this tab session, never persisted
    }

    var remarks = actionsEl.querySelector('.admin-remarks').value.trim();
```

Replace the inline password-prompt block with a call to a shared helper:

```javascript
  function process(targetStage, triggeringBtn) {
    clearMessage(errorEl);

    if (!ensureApproverPassword_()) return; // cancelled

    var remarks = actionsEl.querySelector('.admin-remarks').value.trim();
```

Then add the extracted helper as its own top-level function, right before `function wireAdminActions_(panel, requestId, nextAction) {` (around line 132):

```javascript
// Re-prompts for the approver's password only when it's not already held in
// memory (e.g. right after a page-refresh restore, or after a prior action
// failed and cleared it) — never persisted to sessionStorage. Returns false
// if the user cancels the prompt.
function ensureApproverPassword_() {
  if (currentApprover.password) return true;
  var pwd = window.prompt('Re-enter your password to confirm this action, ' + currentApprover.fullName + ':');
  if (!pwd) return false;
  currentApprover.password = pwd;
  return true;
}

function wireAdminActions_(panel, requestId, nextAction) {
```

- [ ] **Step 2: Add editability check + save function**

Add these two functions right after `REQUIRED_ROLE_BY_STATUS` (around line 116, before `function buildAdminActionsHtml_`):

```javascript
// Mirrors the same condition that decides whether to show the Approve/
// Reject panel at all (loadAdminRequests's onDetailRendered) — Amount is
// only editable while it's this approver's own turn to act on the request.
function isLineEditableForCurrentApprover_(request) {
  var requiredRole = REQUIRED_ROLE_BY_STATUS[request.Status];
  return !!requiredRole && currentApprover.role === requiredRole;
}

// Called from the shared receipt/detail modal's Save Amount button (see
// common.js's openLineItemPreview_ / wireLineItemRows_). Reuses the same
// password-reprompt gate as Approve/Reject since this is also a mutation.
function saveLineItemAmount_(request, line, newAmount) {
  if (!ensureApproverPassword_()) {
    return Promise.reject(new Error('Password required to save.'));
  }
  return runServer('updateLineItemAmount', request.RequestID, line.LineID, newAmount, currentApprover.userId, currentApprover.password, '')
    .then(function (result) {
      if (!result.success) {
        currentApprover.password = null; // can't tell if the password was the problem — re-prompt next time
        throw new Error(result.error);
      }
      loadAdminRequests(); // refreshes the Total column + audit trail for this request
      return result;
    });
}
```

- [ ] **Step 3: Pass the new options into `renderRequestsTable`**

Find `loadAdminRequests` (around line 56-94):

```javascript
  runServer.apply(null, args)
    .then(function (requests) {
      renderRequestsTable(container, requests, {
        showEmployee: true,
        onDetailRendered: function (panel, request) {
```

Replace with:

```javascript
  runServer.apply(null, args)
    .then(function (requests) {
      renderRequestsTable(container, requests, {
        showEmployee: true,
        isLineEditable: isLineEditableForCurrentApprover_,
        onSaveAmount: saveLineItemAmount_,
        onDetailRendered: function (panel, request) {
```

(The rest of `onDetailRendered`'s body and the closing braces stay exactly as they are today — only the two new keys are added above it.)

- [ ] **Step 4: Syntax check**

Run: `node --check "D:/EXPENSES FARE/frontend/admin.js"`
Expected: no output (exit code 0).

- [ ] **Step 5: Save the file.**

---

### Task 5: Backend — `updateLineItemAmount` (`RequestService.gs`)

**Files:**
- Modify: `RequestService.gs`

- [ ] **Step 1: Add the new function**

Add this function at the end of `RequestService.gs` (after `advanceRequestStage`'s closing `}`):

```javascript
// Lets the Approver/Reviewer currently allowed to act on a request correct a
// line item's Amount before advancing it — e.g. a typo caught during review.
// Reuses every guard advanceRequestStage already has (role check, the
// Pending-stage category/store routing check, script locking) rather than
// inventing separate authorization logic for a second mutation path.
function updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark) {
  var approverResult = getApproverByCredentials_(userId, password);
  if (!approverResult.found) {
    return { success: false, error: approverResult.error };
  }
  var actorName = approverResult.fullName;

  var amount = Number(newAmount);
  if (!amount || amount <= 0) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again.' };
  }

  try {
    var requestRowIndex = findRowIndexById_(SHEET_REQUESTS, 'RequestID', requestId);
    if (requestRowIndex === -1) {
      return { success: false, error: 'Request not found.' };
    }

    var requestSheet = getSheet_(SHEET_REQUESTS);
    var requestHeaderMap = getHeaderMap_(requestSheet);
    var currentStatus = requestSheet.getRange(requestRowIndex, requestHeaderMap['Status'] + 1).getValue();

    var requiredRole = REQUIRED_ROLE_BY_STATUS[currentStatus];
    if (!requiredRole) {
      return { success: false, error: 'This request can no longer be edited.' };
    }
    if (approverResult.role !== requiredRole) {
      return { success: false, error: 'This action requires the ' + requiredRole + ' role.' };
    }

    // Same category/store routing check advanceRequestStage performs for the
    // Pending stage — only the specific required Approver can edit amounts
    // on a Pending request, not just any Approver-role account.
    if (currentStatus === STATUS_PENDING) {
      var employeeId = requestSheet.getRange(requestRowIndex, requestHeaderMap['EmployeeID'] + 1).getValue();
      var employeeInfo = getEmployeeRoutingInfo_(employeeId);
      var lineLocation = getFirstLineBaseLocation_(requestId);
      var required = resolveRequiredApprover_(employeeId, employeeInfo.baseLocation, employeeInfo.department, lineLocation);
      if (required.found) {
        var approverBioId = String(approverResult.biometricId || '').trim().toLowerCase();
        var requiredBioId = String(required.bioId || '').trim().toLowerCase();
        if (!approverBioId || approverBioId !== requiredBioId) {
          return { success: false, error: 'This request must be approved by ' + required.name + '.' };
        }
      }
    }

    var lineRowIndex = findRowIndexById_(SHEET_REQUEST_LINES, 'LineID', lineId);
    if (lineRowIndex === -1) {
      return { success: false, error: 'Line item not found.' };
    }

    var lineSheet = getSheet_(SHEET_REQUEST_LINES);
    var lineHeaderMap = getHeaderMap_(lineSheet);
    var lineRequestId = lineSheet.getRange(lineRowIndex, lineHeaderMap['RequestID'] + 1).getValue();
    if (String(lineRequestId) !== String(requestId)) {
      return { success: false, error: 'Line item not found.' };
    }

    var oldAmount = Number(lineSheet.getRange(lineRowIndex, lineHeaderMap['Amount'] + 1).getValue()) || 0;
    var category = lineSheet.getRange(lineRowIndex, lineHeaderMap['Category'] + 1).getValue();

    updateRowFields_(SHEET_REQUEST_LINES, lineRowIndex, { Amount: amount });

    var allLines = getAllRowsAsObjects_(SHEET_REQUEST_LINES).filter(function (line) {
      return String(line.RequestID) === String(requestId);
    });
    var newTotal = allLines.reduce(function (sum, line) { return sum + (Number(line.Amount) || 0); }, 0);

    var existingRemarks = requestSheet.getRange(requestRowIndex, requestHeaderMap['Remarks'] + 1).getValue();
    var remarkLine = 'Amount edited by ' + actorName + ': ' + oldAmount.toFixed(2) + ' \u2192 ' + amount.toFixed(2) +
      ' (' + category + ' line)' + (remark ? ' \u2014 ' + remark : '');
    var updatedRemarks = existingRemarks ? existingRemarks + '\n' + remarkLine : remarkLine;

    updateRowFields_(SHEET_REQUESTS, requestRowIndex, { TotalAmount: newTotal, Remarks: updatedRemarks });

    return { success: true, newAmount: amount, newTotalAmount: newTotal };
  } catch (e) {
    return { success: false, error: 'Update failed: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 2: Save the file.** (Apps Script has no local runner — this is verified live in Task 7.)

---

### Task 6: Register the new action (`Code.gs`)

**Files:**
- Modify: `Code.gs`

- [ ] **Step 1: Add to `API_ACTIONS`**

Find (lines 11-20):

```javascript
var API_ACTIONS = {
  getEmployeeByID: getEmployeeByID,
  getMyRequests: getMyRequests,
  getAllRequestsForPayroll: getAllRequestsForPayroll,
  submitLiquidationRequest: submitLiquidationRequest,
  advanceRequestStage: advanceRequestStage,
  loginApprover: loginApprover,
  searchEmployeesForUtility: searchEmployeesForUtility,
  saveMealAllowanceRecord: saveMealAllowanceRecord
};
```

Replace with:

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

Note: `updateLineItemAmount` is a mutation (changes Sheet data), so it must **not** be added to `frontend/common.js`'s `READ_ONLY_ACTIONS` array — leaving it out means `runServer` already sends it as a POST automatically. No change needed there.

- [ ] **Step 2: Save the file.**

---

### Task 7: Deploy the backend

**Files:** none (CLI only)

- [ ] **Step 1: Push the updated `.gs` files**

Run: `clasp push -f`
Expected: lists the pushed files including `Code.gs` and `RequestService.gs`, no error. If it crashes with a `JavaScript heap out of memory` error, retry with `NODE_OPTIONS="--max-old-space-size=4096" clasp push -f` (a known clasp CLI issue on this machine, unrelated to the code — see `resume.md`).

- [ ] **Step 2: Confirm the live deployment ID**

Run: `clasp deployments`
Expected: a list of deployments. Confirm which deployment ID is the one baked into `frontend/config.js`'s `APPS_SCRIPT_URL` (the `/exec` URL's ID segment) — do not assume it from memory, read it off this command's output.

- [ ] **Step 3: Deploy to that ID**

Run: `clasp deploy -i <deploymentId>` (the ID confirmed in Step 2)
Expected: success message. This is the step that actually makes the new backend code live at the existing `/exec` URL — pushing alone does not do this (see `CLAUDE.md`'s Commands section).

---

### Task 8: Manual verification

**Files:** none — exercised through the browser against the live deployment.

- [ ] **Step 1: Syntax-check everything once more together**

Run: `node --check "D:/EXPENSES FARE/frontend/common.js" && node --check "D:/EXPENSES FARE/frontend/employee.js" && node --check "D:/EXPENSES FARE/frontend/admin.js" && echo OK`
Expected: `OK`

- [ ] **Step 2: Required-field highlighting**

Open `frontend/index.html`, log in with a Biometric ID, go to New Request, add a line item, leave Description blank, click Submit. Expected: Description gets a red border, focus jumps to it, and the "Please fill in all required fields." banner shows. Fill it in — the red border should clear as soon as you type. Fill in all fields and submit — should succeed normally (unchanged from before).

- [ ] **Step 3: Receipt preview — view-only (My Requests)**

On the same page, go to My Requests, expand a request, click anywhere on a line item row. Expected: the dark overlay opens with the receipt image (or the "No receipt uploaded" / "Preview not available" fallback) and the details panel — Amount shown as plain text, not editable. Close via the X button, Escape key, and clicking the dark backdrop — all three should work.

- [ ] **Step 4: Receipt preview — editable (Approvers page, correct turn)**

Open `frontend/admin.html`, log in as an Approver whose turn it currently is on a Pending request routed to them. Expand that request, click a line item row. Expected: Amount renders as an editable number input + a disabled "Save Amount" button. Change the value — button enables. Click Save Amount — expect a `window.prompt` for the password (first time this session), enter it, expect the button to briefly read "Saved", and the request list's Total column and audit trail (Remarks) to reflect the change after it reloads.

- [ ] **Step 5: Receipt preview — not editable (wrong turn/role)**

Log in as a Reviewer or Authorizer, or as an Approver on a request that isn't theirs to act on. Expand a request, click a line item. Expected: Amount shows as plain text, no input/Save button — same as the view-only case.

- [ ] **Step 6: Confirm the routing/role guard server-side**

Using `curl` (or the browser devtools Network tab) with a request currently in `Approved` status, call `updateLineItemAmount` with an `Approver`-role account's credentials instead of a `Reviewer`'s. Expected: `{ "success": false, "error": "This action requires the Reviewer role." }` — confirms the server rejects it even if a client bug ever showed the field as editable.
