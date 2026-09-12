# Required-field highlighting + Receipt preview/amount-edit design

## Context
Two related New Request / review-flow gaps were reported by the user:
1. Submitting a New Request with missing required fields gives no visual feedback about which
   field is missing — only a generic error message.
2. Reviewing a receipt currently just opens the raw Drive file URL in a new tab
   (`common.js`'s `buildLineItemsHtml_`, `<a href="..." target="_blank">View</a>`), with no way
   to see the line item's details alongside it, and no way for an Approver/Reviewer to correct a
   line item's Amount if it was entered wrong — today the only fix is Reject-and-resubmit.

This spec covers both, confirmed with the user via clarifying questions.

## Feature 1 — Required-field highlighting on submit

**Scope:** `frontend/employee.js`, `frontend/styles.css` only. No backend change.

Required fields per line item: Date, Category, Location (Base Location), Amount, Description.
Receipt stays optional (unchanged — some categories/flows never attach one).

`handleSubmitRequest` (currently `frontend/employee.js`) gains a validation pass, run only when
the Submit button is clicked (not real-time), before `collectLineItems()`:
- For every `.line-item-row`, check each required field's value is non-empty (Amount: also `> 0`).
- Any failing field gets `.input-error` added to its element; the first invalid field is scrolled
  into view / focused.
- If anything failed, block submission and show the existing `submit-error` banner with
  "Please fill in all required fields." — do not call `collectLineItems`/`runServer`.
- Each input gets a one-time `input`/`change` listener (wired once, at row-creation time in
  `addLineItemRow`) that removes `.input-error` from itself as soon as it's edited, so the
  highlight doesn't linger after the user fixes it.

CSS: add `.input-error { border-color: var(--color-danger); }` (and a light focus-ring variant)
in `styles.css`, next to the other field/input rules — reuses the existing danger color token,
no new color introduced.

## Feature 2 — Receipt preview screen + Approver/Reviewer amount edit

**Scope:** `frontend/common.js` (shared modal + row wiring), `frontend/admin.js` (editability +
save wiring), `frontend/styles.css` (modal styling), `RequestService.gs` (new mutation),
`Code.gs` (register the new action).

### Frontend: shared preview modal (`common.js`)
A single modal, injected into `document.body` once on first use (`ensureReceiptModal_()`), reused
by both `index.html` and `admin.html` — avoids duplicating markup across the two pages.

Layout (Messenger-style full-screen overlay):
- Dark, semi-opaque backdrop covering the viewport.
- Centered receipt image (`<img>`) when `line.ReceiptFileURL` is present; on image load failure
  (e.g. the file is a PDF, not an image), fall back to a generic file icon + "Open receipt in new
  tab" link. When there's no `ReceiptFileURL` at all, show a "No receipt uploaded" placeholder
  instead of an image.
- A details panel (Date, Category, Location, Description, Amount) — either below the image or
  beside it on wider viewports (responsive, consistent with the existing `640px` breakpoint
  pattern already used elsewhere in `styles.css`).
- Amount renders as plain text normally. When the modal is opened with `editable: true`, it
  instead renders as a number input + a "Save Amount" button (disabled until the value actually
  changes) + an inline error slot for save failures.
- Close via an X button (top-right of the overlay), the Escape key, or a click on the backdrop
  itself (not the content panel, so accidental image-area clicks don't close it).

New function `openLineItemPreview_(line, options)`:
- `options.editable` (bool) — whether to render the Amount as editable.
- `options.onSaveAmount(newAmount)` — returns a Promise; called when "Save Amount" is clicked.
  On resolve, the modal shows the updated amount and stays open (user still needs to close it or
  can keep reviewing); on reject, shows the error inline in the modal without closing.

### Frontend: wiring into the shared request table (`common.js`)
`buildLineItemsHtml_(request)` — each `<tr>` gains `data-line-id="<LineID>"` and `cursor:pointer`
styling; the Receipt cell keeps its "View"/"None" text but is no longer a real `<a>` (clicking
anywhere in the row opens the same preview).

`renderRequestsTable`'s `toggleRow` — right after `panel.innerHTML = buildLineItemsHtml_(...)`,
call a new `wireLineItemRows_(panel, request, options)` that attaches a click handler per row,
looks up the matching `line` object from `request.lines` by `data-line-id`, and calls
`openLineItemPreview_(line, { editable: options.isLineEditable ? options.isLineEditable(request) : false, onSaveAmount: ... })`.

`options.isLineEditable` and `options.onSaveAmount` are supplied by the caller:
- `employee.js`'s My Requests call: neither is passed → always view-only.
- `admin.js`'s queue call: `isLineEditable(request)` returns true only when
  `currentApprover.role === REQUIRED_ROLE_BY_STATUS[request.Status]` (the exact same condition
  `loadAdminRequests`'s `onDetailRendered` already uses to decide whether to show the Approve/
  Reject panel) — reuses that existing logic rather than duplicating it. `onSaveAmount(newAmount)`
  reuses the same "prompt for password if not held in memory" gate already written for Approve/
  Reject (`admin.js`'s `process()`), then calls the new `updateLineItemAmount` action; on success
  it also calls `loadAdminRequests()` so the list's Total column and audit trail refresh.

### Backend: `updateLineItemAmount` (`RequestService.gs`)
```
updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark)
```
- `getApproverByCredentials_(userId, password)` — same as `advanceRequestStage`; generic failure
  message on bad credentials (never reveals which part was wrong).
- Validates `Number(newAmount) > 0`; otherwise `{ success: false, error: 'Amount must be a positive number.' }`.
- Locks via `LockService.getScriptLock()` (same 10s timeout / "System is busy" pattern as every
  other mutating function in this file).
- Looks up the request's current `Status`. If `REQUIRED_ROLE_BY_STATUS[currentStatus]` is
  undefined (terminal — `Authorized`/`Rejected`) → `{ success: false, error: 'This request can no longer be edited.' }`.
- If `approverResult.role !== REQUIRED_ROLE_BY_STATUS[currentStatus]` → same "requires the X role"
  error `advanceRequestStage` already uses.
- When `currentStatus === STATUS_PENDING`: re-run the identical category/store routing check
  `advanceRequestStage` performs (`getEmployeeRoutingInfo_` + `getFirstLineBaseLocation_` +
  `resolveRequiredApprover_`, comparing `approverResult.biometricId`) — so only the specific
  required Approver can edit a Pending request's amounts, not just any Approver-role account.
- Finds the line row via `findRowIndexById_(SHEET_REQUEST_LINES, 'LineID', lineId)`; verifies its
  `RequestID` matches `requestId` (defense in depth against a mismatched/stale lineId); 404s with
  `{ success: false, error: 'Line item not found.' }` otherwise.
- Reads the old `Amount`, writes the new one via `updateRowFields_`.
- Recomputes `TotalAmount` by re-fetching all of that request's lines and summing `Amount`,
  writes it to the `Requests` row via `updateRowFields_`.
- Appends one line to `Remarks` (existing `existingRemarks + '\n' + line` pattern): e.g.
  `Amount edited by <FullName>: ₱100.00 → ₱150.00 (Fare line)` — reuses `formatCurrency`-equivalent
  formatting already used server-side for consistency, includes the line's `Category` for context
  since a request can have several lines.
- Returns `{ success: true, newAmount: ..., newTotalAmount: ... }`.

### `Code.gs`
Add `updateLineItemAmount: updateLineItemAmount` to `API_ACTIONS`. No change to
`READ_ONLY_ACTIONS` in `common.js` — it's a mutation, so `runServer` already sends it as POST.

## Error handling
- Every new failure path returns `{ success: false, error }` — the frontend already has a
  generic error-display path (`setMessage`/inline modal error) to surface these, no new pattern
  needed.
- Fail-closed server-side regardless of what the client UI shows: the role/stage/routing checks
  are the real boundary, mirroring every other mutation in this codebase (see `CLAUDE.md`'s
  Security model section) — a client bug or stale UI state can never bypass them.

## Out of scope (explicitly not doing)
- No real-time (on-blur) validation for Feature 1 — submit-time only, per user's choice.
- No edit history/versioning beyond the single Remarks log line — matches the existing
  append-only Remarks pattern used for every other audit event in this app.
- No amount editing outside of an Approver/Reviewer's own current turn (e.g. Authorizer editing
  after Reviewed) — explicitly out per user's choice ("kapag sila ang dapat kumilos sa stage").

## Testing
- `node --check` on `frontend/employee.js`, `frontend/common.js`, `frontend/admin.js`.
- Manual (both features) per the flows listed in the design discussion — submit with a blank
  field, edit an amount as the correct-turn Approver, confirm it's not editable as the wrong
  role/turn or on the employee's own My Requests view, confirm Total/Remarks update after a save.
