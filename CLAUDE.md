# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is no build step, package manager dependency tree, linter, or test suite in this repo — it's a Google Apps Script backend + a static HTML/CSS/JS frontend, edited and deployed via `clasp`.

- `clasp login` — one-time OAuth login (required before push/deploy).
- `clasp push -f` — uploads the backend `.gs` files + `appsscript.json` to the Apps Script project. **This alone does not update the live `/exec` URL.**
- `clasp deployments` — list deployment IDs.
- `clasp deploy -i <deploymentId>` — publishes the currently-pushed code to that deployment's `/exec` URL. **Must be run after every backend change** that should go live — a deployment is pinned to a saved version snapshot, it does not auto-track pushed code the way the "Head" test URL does.
- `npm run deploy` — currently just runs `clasp push -f`; it does *not* run `clasp deploy -i`, so a manual deploy step is still required after backend edits (see README's "Backend setup" section for the full sequence).
- `node --check <file>.js` — quick syntax check for a single frontend JS file (no test framework exists; this is the closest thing to a smoke test).
- Frontend has no build: `frontend/index.html` (employees) or `frontend/admin.html` (Approvers) can be opened directly (double-click or any static server) and work against the live deployed backend immediately, since it's a plain static site calling `fetch()`.

## Architecture

This is **two independently deployed halves that only communicate over HTTP**, not a typical single-framework app:

1. **Backend** — Google Apps Script project (the root `.gs` files + `appsscript.json`), deployed as a Web App. It is a **pure JSON API**, not an HTML-serving app: `Code.gs` is the only entry point (`doGet`/`doPost`), dispatching to one of the whitelisted functions via a lookup table (`API_ACTIONS`) and returning `ContentService` JSON. There is no session/auth layer at the transport level — `doGet`/`doPost` execute as the deploying user (`executeAs: USER_DEPLOYING` in `appsscript.json`) regardless of caller identity, which is what lets an anonymous frontend read/write the Sheet and Drive at all; the User ID/password system described below is an *application-level* identity check layered on top of this, not a replacement for it.
   - Reads (`getEmployeeByID`, `getMyRequests`, `getAllRequestsForPayroll`) arrive via `GET ?action=<name>&arg0=...&arg1=...` (positional args as query params).
   - Mutations, and anything carrying credentials (`submitLiquidationRequest`, `advanceRequestStage`, `loginApprover`) arrive via `POST` with a JSON body `{"action": "...", "args": [...]}`. The client deliberately sends `Content-Type: text/plain` on these (see `frontend/common.js`'s `runServer`) — Apps Script cannot respond to a CORS preflight `OPTIONS` request, so both directions are engineered to stay "simple requests" that skip preflight entirely. Note: Apps Script answers a POST with a `302` to a `script.googleusercontent.com` content URL — `doPost` already ran and its result is cached there before the redirect is issued, so the redirect target only ever needs a `GET` (this trips up `curl -L -X POST`, which wrongly forces POST on the redirect hop too — don't "fix" that by changing the server).
   - Google Sheets is the datastore (no external DB). `SheetService.gs` provides header-name-keyed helpers (`getAllRowsAsObjects_`, `appendRowFromObject_`, `findRowIndexById_`, `updateRowFields_`) so business logic never hardcodes column indices — every other backend file goes through these rather than calling `SpreadsheetApp` directly.
   - `RequestService.gs` is the core business logic and the one place that wraps multi-step writes in `LockService.getScriptLock()` (both `submitLiquidationRequest` and `advanceRequestStage`), since concurrent Apps Script executions across different callers can otherwise race on the same Sheet rows.
   - Approval is a 4-stage sequential state machine, not a single approve/reject action: `Config.gs`'s `STAGE_ORDER` (`Pending → Approved → Reviewed → Authorized`) defines the only legal forward path, plus `Rejected` as a terminal state reachable from any non-terminal stage. Each non-initial stage is additionally gated by a role — `RequestService.gs`'s `REQUIRED_ROLE_BY_STATUS` (`Pending` needs `ROLE_APPROVER`, `Approved` needs `ROLE_REVIEWER`, `Reviewed` needs `ROLE_AUTHORIZER`) — checked against whichever role owns the credentials passed in. `ROLE_AUTHORIZER`'s job-title *value* is `'Verifier'` (renamed from `'Authorizer'` — the constant's name was kept, only the string it holds changed, same "internal identifier stays, display/data value changes" pattern used for `STATUS_AUTHORIZED`/"Disbursed" below); the `Approvers` sheet's `Role` column must contain `'Verifier'` for that account's role checks to pass. `advanceRequestStage(requestId, targetStage, userId, password, remark)` is the single mutation entry point: it resolves `userId`/`password` to a full name+role via `ApproverService.gs`'s `getApproverByCredentials_` (failing generically on a bad User ID or password, deliberately not saying which), looks up the request's current `Status`, calls `Validation.gs`'s `validateStageTransition_(currentStatus, targetStage)` to reject anything except "next stage in order" or "→ Rejected", **then** checks the resolved role against `REQUIRED_ROLE_BY_STATUS[currentStatus]`, and only then writes that stage's `*By`/`*Date` column pair (via `STAGE_FIELD_NAMES`) using the **server-resolved `fullName`** (never a client-supplied string) and **appends** (never overwrites) one line to `Remarks` — using `STAGE_DISPLAY_LABEL` rather than the raw status string, since the terminal `Authorized` stage is worded "Disbursed" in every user-facing surface (the *stored* value is still `Authorized`, matching `STAGE_ORDER`/Sheet column names — only display text changed, on both frontend and backend, so don't rename the enum itself for this). The frontend UI only ever offering the single next legal action is a UX nicety — these two server-side checks are what actually enforce order and identity, and are the thing to preserve if you touch this function.
   - When `targetStage === STATUS_AUTHORIZED`, `advanceRequestStage` also stamps a `CreditingDate` via `computeNextCreditingFriday_()` — a fixed weekly-Friday disbursement schedule (Friday of the current Mon–Sun week, or the following Friday if today is already Sat/Sun past that week's Friday), not a user-editable field. This is a business rule (money is credited on Fridays), not a formatting choice — don't let it drift into an editable date picker without an explicit ask.
   - `updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark)` is a second mutation entry point, letting the Approver/Reviewer/Verifier whose turn it currently is correct a line item's `Amount` (e.g. a typo caught during review) without going through Reject-and-resubmit. It deliberately mirrors every guard `advanceRequestStage` already has rather than inventing separate authorization logic: same `getApproverByCredentials_` credential resolution, same `REQUIRED_ROLE_BY_STATUS` role gate (derived from the request's *current* status — a request with no entry in that map, i.e. terminal `Authorized`/`Rejected`, is rejected as "no longer be edited"), the same Pending-stage `resolveRequiredApprover_` routing re-check, and the same `LockService.getScriptLock()` pattern. It also does a defense-in-depth check that the resolved `LineID` actually belongs to the given `requestId` (since both arrive as untrusted client args with no server session — `findRowIndexById_` searches `LineID` globally across the whole sheet, not scoped to one request), recomputes `TotalAmount` by re-summing *all* of that request's lines from scratch (not applying a delta, to stay drift-safe), and appends an audit-trail line to `Remarks` (e.g. "Amount edited by X: 100.00 → 150.00 (Fare line)"). `frontend/admin.js`'s `isLineEditableForCurrentApprover_` (UX-only, reusing the same `REQUIRED_ROLE_BY_STATUS` map) is what decides whether to even show the Amount field as editable in the shared receipt preview modal (see below) — same "client mirrors the server, server independently re-verifies" pattern as everywhere else in this app.
   - `ApproverService.gs`'s `getApproverByCredentials_(userId, password)` scans the `Approvers` sheet (`UserID, Password, FullName, Role, Active`) for a matching, active, password-matching `UserID` — same shape/pattern as `EmployeeService.gs`'s employee lookup. `loginApprover(userId, password)` is the same lookup exposed as a public action, used only so `admin.html` can greet the user by their `FullName` before they act; it is **not** itself a security boundary — `advanceRequestStage` re-resolves the credentials independently on every call, since it's the raw User ID/password (not a session token) that the client resends each time.
   - Data model is three Sheet tabs: `Requests` (one row per submission — `Status`/`TotalAmount`/the four stage-checkpoint column-pairs/`Remarks`), `RequestLines` (N rows per request — date/category/amount/receipt-URL line items), and `Approvers` (the login/role roster). `getMyRequests`/`getAllRequestsForPayroll` both go through `buildRequestsWithLines_`, which joins `Requests`+`RequestLines` client-side after fetching both tables in full (no Sheet-side querying).
   - Receipts go to Drive, not Sheets: `DriveService.gs` decodes a base64 payload the client sent and files it under `<DRIVE_ROOT_FOLDER_ID>/<EmployeeID>/<RequestID>/`, folder-per-level created on demand via `getOrCreateFolder_`. `submitLiquidationRequest` splits its work into 3 phases to minimize how long it holds the shared script-wide `LockService` lock (all 5 mutation entry points in this app — submit, `advanceRequestStage`, `updateLineItemAmount`, and both exemption actions — share the same `LockService.getScriptLock()`, so anything slow held under it blocks every other queued action, not just other submissions): a short **Phase 1** lock generates the sequential `RequestID`/`LineID`s (fast `PropertiesService` work, see `IdGenerator.gs`), then releases; **Phase 2** runs Drive uploads *unlocked*, now able to use the real `RequestID` for the normal `<EmployeeID>/<RequestID>/` folder path since it was already generated in Phase 1; a second short **Phase 3** lock does only the `Requests`/`RequestLines` Sheet writes. This means a Sheet row is no longer guaranteed atomic with its receipt succeeding first the way a single locked section would be — if Phase 3 fails after Phase 2's upload already succeeded, the uploaded file is orphaned in Drive (unreferenced by any row). This is an accepted tradeoff (no test suite, Phase 3 has no external calls so it's rare to fail, and building upload-rollback would add more Drive API surface for a very rare failure path), not an oversight — don't "fix" it by moving Drive I/O back inside a single lock without discussing the resulting lock-contention regression first. A line can instead arrive with `line.receiptUrl` already set (the Meal Allowance utility's attendance-photo hand-off, see below) — when present, `submitLiquidationRequest` stores that URL directly as `ReceiptFileURL` and skips the Drive upload entirely; `line.file` and `line.receiptUrl` are mutually exclusive, `receiptUrl` taking precedence. **`ReceiptFileURL` is a Drive *viewer* URL** (`driveFile.getUrl()`, e.g. `.../file/d/<ID>/view?...`), not raw image bytes — it was never renderable directly in an `<img src>` (this was a real, previously-unnoticed bug: the receipt preview modal always silently fell back to "Preview not available" until fixed). `frontend/common.js`'s `driveThumbnailUrl_()`/`driveDownloadUrl_()` regex-extract the file ID from that URL and rewrite it to Drive's `thumbnail?id=...&sz=w2000` (a real image-serving endpoint, used for the on-screen `<img src>` — conveniently also renders a page-1 preview for a PDF) and `uc?export=download&id=...` (forces the original full-resolution file to download) respectively — both are pure frontend URL rewrites, no backend/schema change, so they retroactively work on every already-submitted receipt too. Receipt is now a **required, photo-only** field (`Config.gs`'s `ALLOWED_MIME_TYPES` no longer includes `application/pdf`; `MAX_RECEIPT_BYTES` is 2MB) — `frontend/employee.js` compresses any selected photo over ~1MB down toward that target client-side (`compressImageForUpload_`, canvas re-encode to JPEG, stepping quality down before ever shrinking dimensions, since legible text/numbers was the explicit requirement) before it's even base64-encoded and sent, since Apps Script itself has no image re-encode API to do this server-side.
   - `Validation.gs`'s `validateSubmission_` (called from `submitLiquidationRequest`) also enforces a business rule on each line item's date: it must fall within the last 1 month and cannot be in the future. This is a business constraint (expense dates shouldn't be stale or forward-dated), not just type checking — `frontend/employee.js` mirrors it client-side via `min`/`max` on the date input for fast feedback, but `Validation.gs` is authoritative and re-checked on every submission regardless of what the client sends. It similarly requires either `line.file` or `line.receiptUrl` to be present on every line — mirrored client-side by `frontend/employee.js`'s `validateRequiredLineFields_` (see below), but re-checked here as the authoritative boundary per this file's own header comment ("nothing here trusts the browser").
   - `Config.gs` is the single source of truth for the two external IDs (`SPREADSHEET_ID`, `DRIVE_ROOT_FOLDER_ID`) and shared enums (`CATEGORIES`, `STATUS_*`, `STAGE_ORDER`, `ROLE_*`) — every other backend file reads from here rather than duplicating string literals.
   - `MealAllowanceService.gs` is a separate, self-contained feature backing the "Meal Allowance" employee utility: `saveMealAllowanceRecord` validates and appends to a standalone `MealAllowances` sheet tab (including `PhotoLink`, plus `MatchedStore`/`City`/`Town`/`AreaRegion`/`AllowanceSource` recording how the Regular Meal Allowance amount was resolved — see `frontend/meal-allowance.js` below), and `searchEmployeesForUtility` (employee search by ID/name) still exists but is currently unused by the frontend (see below — the utility was later locked to self-lookup only). Saving here does **not** touch `Requests`/`RequestLines` or the approval pipeline — it's a payroll reference log computed from an *external* published Google Sheet (attendance IN/OUT, fetched client-side by `frontend/meal-allowance.js` via `ATTENDANCE_CSV_URL` in `config.js`), not from this app's own Sheet. Any `.gs` file added to this project must also be whitelisted by name in `.claspignore` — it uses an explicit per-file allowlist (`**/**` then `!EachFile.gs`), not a wildcard, so a new backend file silently won't be pushed by `clasp push` until added there.
   - `StoreDirectoryService.gs` is the **authoritative, server-side** source for a second, distinct concern from the Meal Allowance CSVs above: which category (`AreaHead` / `Technical` / `Audit` / `HeadOffice` / plain `Staff`) an employee belongs to, and who must approve their Pending request. It fetches a separate published sheet (`STORE_DIRECTORY_CSV_URL`, `Config.gs`) via `UrlFetchApp` (the **only** server-side external HTTP call in this codebase — every other external CSV fetch, in `meal-allowance.js`, happens client-side) and caches the parsed result in `CacheService.getScriptCache()` for 5 minutes, since it now sits in `advanceRequestStage`'s hot path. That sheet mixes several tables and has duplicate/blank column headers (three different columns are all literally named `BIO ID`), so it's read by **fixed column index**, not header name — see the file's own header comment for the exact index map. Columns 9/14/19 hold the fixed, org-wide Biometric IDs for three fixed roles (Area Head requests → Jayriel Guardacasa, Technical → Cris Taglucop, Audit → Lanilyn Balane) and 28/29 a fourth (HeadOffice → a shared "ADMIN" account, BIO `9999`) — all read live from the sheet each time rather than hardcoded, so reassigning who holds these roles is a spreadsheet edit, not a code change.
     **Known data trap, already hit once**: the sheet's "obviously right-looking" Area Head columns (11/12) are actually **off-by-one-row misaligned** with the `STORES` column (26) for most of the sheet (confirmed: 115 of 118 stores mismatched, 101 outright blank) — this is a defect in the externally-maintained source spreadsheet, not this codebase. The columns that actually work are 24/25 (a trailing `BIO ID`/`APPROVERS` pair immediately followed by `STORES` at 26) — that's what `STORE_DIR_COL_AREHEAD_BIO`/`_NAME` point to. Do not "simplify" this back to 11/12 without re-verifying row alignment against the live sheet first; the file's own header comment has the full story.
     `resolveRequiredApprover_(employeeId, employeeBaseLocation, employeeDepartment, requestLineLocation)` returns `{ found: false }` (never throws) whenever it can't determine a required approver — `advanceRequestStage` treats that as "fall back to the unscoped role-only check that existed before this feature", the same fail-open philosophy used everywhere else authorization can't be fully resolved in this app. For a Staff-category employee, `requestLineLocation` (the request's own first line item's `BaseLocation` — see `getFirstLineBaseLocation_`) is tried before falling back to `employeeBaseLocation`, since a store employee's expense doesn't always happen at their usual home branch.
   - `advanceRequestStage`'s authorization is therefore now **two layers** for the `Pending → Approved` transition specifically (Reviewer/Verifier stages are completely unaffected by `StoreDirectoryService.gs` and still use only the role check): first the existing `REQUIRED_ROLE_BY_STATUS` role check (any active `Approver`-role account), **then**, only when `currentStatus === STATUS_PENDING`, a check that the specific logged-in account's `BiometricID` (a column added to `Approvers` for exactly this) matches whichever Biometric ID `resolveRequiredApprover_` says is required for that request's employee. `getApproverByCredentials_` (`ApproverService.gs`) returns `biometricId` alongside `fullName`/`role` for this comparison. `EmployeeService.gs`'s `getEmployeeRoutingInfo_` fetches `BaseLocation`+`Department` inside `advanceRequestStage`. This is why `Employees.BaseLocation` accuracy still matters even though line-item location is checked first: a typo or blank value there is the fallback's fallback. `Setup.gs`'s `applyBaseLocationDropdown_()` (called automatically by `setupSheets()`) mitigates bad `BaseLocation` values going forward by turning it into a Sheets dropdown sourced from the same directory's exact store-name spellings — it doesn't retroactively fix existing bad values.
   - `getAllRequestsForPayroll(statusFilter, approverBiometricId)` mirrors this same Pending-routing check on the **read** side, so an Approver's queue only shows requests they're actually meant to act on (Reviewer/Verifier queues stay unscoped) — `admin.js` only sends `biometricId` when the logged-in account's role is `Approver`. It batches the `RequestLines` lookup once (`firstLineLocationByRequestId`) rather than calling the single-request helper per row.
   - `resolveEmployeeCategory_` (`StoreDirectoryService.gs`) has **two ways** to land on `Technical`/`Audit`: being the one specific person the directory sheet lists as a store's assigned Tech/Auditor (checked first), **or** having `Employees.Department` match `isTechnicalDepartment_`/`isAuditDepartment_` (loose substring match — `'tec'`/`'tech...'` and `'aud'`/`'audit...'`, since real data has used both abbreviations and full words). The Department path is deliberately a fallback checked *after* the directory listing, and its `store` is always `null` (Department-based Tech/Audit staff aren't tied to one specific store the way the directory's named assignee is — their Mother Branch still comes from their own `BaseLocation`, same as plain Staff). `HeadOffice` is checked via column 30 and always displays `store: 'Head Office'`. This same set of helper functions is duplicated in `frontend/employee.js` for the Utilities-tab-visibility mirror — keep both in sync if the matching rule ever changes.
   - `Setup.gs`'s `setupSheets()` is an idempotent bootstrapper, safe to re-run: on a missing tab it creates it with the current header list; on an existing tab it appends any headers that are missing (via `createOrMigrateSheet_`) without touching existing rows or removing old columns. It is run manually from the Apps Script editor (`clasp run` doesn't work here without extra GCP project setup this repo doesn't have — don't assume it's available), not part of any deploy pipeline — re-run it after adding new columns to the header lists in this file. It also calls `applyBaseLocationDropdown_()` (see above) every time, which itself calls `StoreDirectoryService.gs`'s fetch — so re-running `setupSheets()` for the first time after this feature shipped is what triggers Apps Script's one-time authorization prompt for server-side external requests; that's expected, not an error.

2. **Frontend** (`frontend/`) — a framework-free, **two-page** static site with no build tool: `index.html` (employees) and `admin.html` (Approvers) are separate real pages/URLs, not a single page with a client-side view switch. `config.js` holds the one thing that couples either page to a specific backend deployment (`APPS_SCRIPT_URL`). `common.js` is loaded by *both* pages and owns shared state (`currentEmployee`), the `runServer()` fetch wrapper described above, `escapeHtml_()` (used everywhere free-text from Sheets is interpolated into `innerHTML` — remarks and employee-entered line-item text are both untrusted input rendered back into the page), and `renderRequestsTable()`/`buildLineItemsHtml_()`/`buildAuditTrailHtml_()`, the shared request-list-with-expandable-detail-and-audit-trail rendering used by both "My Requests" and the Approvers' queue. `employee.js` is loaded only by `index.html`; `admin.js` only by `admin.html` — there is no `?page=admin` query-param routing anywhere, the header's "Approvers"/"Employee" nav is just two plain `<a href>` links between the two files.
   - Both pages persist their logged-in identity to `sessionStorage` (survives a refresh, clears when the tab/browser closes — deliberately not `localStorage`) so a reload doesn't force a re-login: `employee.js`'s `completeEmployeeLogin_`/`restoreEmployeeSession_` (keyed `SESSION_KEY_EMPLOYEE`) and `admin.js`'s `restoreApproverSession_` (keyed `SESSION_KEY_APPROVER`, both constants in `common.js`). **The Approver's password is deliberately never persisted** — only `{fullName, role, userId, biometricId}` is saved, so `currentApprover.password` can be `null` right after a restore; `admin.js`'s `ensureApproverPassword_()` (shared by Approve/Reject and the Save Amount flow below) re-prompts via `window.prompt` only when it's actually missing, rather than every action.
   - Line items in the new-request form are cloned from a single `<template id="line-item-template">` in `index.html`; `employee.js` assigns unique per-row element IDs at clone time (`li<N>-<field>`) purely so `<label for>` associations work, since the template markup itself can't hardcode IDs for a repeating row. `handleSubmitRequest` runs `validateRequiredLineFields_()` on Submit click (not real-time): every line's Date/Category/Location/Amount/Description/Receipt must be filled (Receipt: either a selected file or an already-set `row.dataset.receiptUrl` from the Meal Allowance hand-off below) or the offending field gets a `.input-error` highlight and focus jumps to the first one.
   - Clicking any line item row (in both My Requests and the Approvers' queue) opens a shared full-screen preview modal — `common.js`'s `ensureReceiptModal_()` (builds/caches one DOM node, reused for every open) and `openLineItemPreview_(line, options)`. `wireImageZoomPan_` adds mouse-wheel zoom (clamped 1×–4×, center-anchored), drag-to-pan once zoomed (clamped via `img.offsetWidth/offsetHeight`, since CSS `transform` doesn't affect layout — this is also why `<img draggable="false">` plus `-webkit-user-drag: none` is required, otherwise the browser's native image-drag hijacks the mouse gesture before pan code ever sees it), and two-finger pinch via the Pointer Events API (one code path for mouse+touch); all zoom/pan state is closure-local and resets automatically since the `<img>` element itself is rebuilt on every open. On `admin.html` only, when it's currently that logged-in Approver/Reviewer/Verifier's own turn on the request (`isLineEditableForCurrentApprover_`), Amount renders as an editable input with its own "Save Amount" button (calling `updateLineItemAmount` above) — `employee.js`'s call site for My Requests never passes `options.isLineEditable`/`onSaveAmount`, so it stays view-only there by construction, not by a separate flag.
   - `admin.js` gates everything behind a User ID + password login: `showAdminView('view-login' | 'view-admin')` is a local view-toggle separate from `common.js`'s `switchTopView` (which only knows about `index.html`'s two view IDs — reusing it here would `hideEl()` a `null` element and throw, since `admin.html` doesn't have `view-employee-main`). On successful `loginApprover`, `currentApprover = {fullName, role, userId, password, biometricId}` is kept in memory for the page's lifetime; every `advanceRequestStage`/`updateLineItemAmount` call resends `currentApprover.userId`/`currentApprover.password` rather than a typed name.
   - `admin.js`'s `NEXT_ACTION_BY_STATUS` lookup is what makes the UI show exactly one primary action (e.g. "Approve" on a `Pending` request, "Mark Reviewed" on `Approved`) plus a Reject button. Its own `REQUIRED_ROLE_BY_STATUS` (mirroring `RequestService.gs`'s map of the same name) is what actually **hides** that action panel entirely when `currentApprover.role` doesn't match the role the current stage needs — showing "Awaiting action from a &lt;Role&gt;." instead. Both of these client-side maps are UX-only; the server independently re-checks stage order and role on every call and is the real enforcement. If the stage names, order, or roles ever change, they must change in `Config.gs`, `RequestService.gs`, both of these `admin.js` maps, `common.js`'s `AUDIT_TRAIL_STAGES`, and `Setup.gs`'s header list — there is no single source of truth shared across the language boundary, so a stage rename is a multi-file, both-runtimes change.
   - `admin.js`'s "Export Reviewed/Disbursed" button (`#btn-export`, `handleExportClick_`) is a one-click batch export of every request currently `Reviewed` or `Authorized` — not date-range filtered, not role-gated. It calls `getAllRequestsForPayroll` twice (`'Reviewed'`, `'Authorized'`, no new backend action needed) and merges the results, then produces two outputs: a CSV (`buildExportCsv_`, one row per line item, `csvField_` doing RFC4180 escaping, downloaded via `downloadTextFile_`'s Blob + temporary `<a download>`) and a print-preview report (`buildExportReportHtml_`) opened in a new tab via `window.open('', '_blank')` + `document.write()` — a summary table followed by one full-page receipt `<img>` per line item (reusing the existing `driveThumbnailUrl_()`/`formatDateDisplay` helpers, so `Authorized` still displays as "Disbursed" via `STATUS_DISPLAY_LABELS`), then a missing-receipts note for any line with no `ReceiptFileURL`. This was originally built with jsPDF generating an actual PDF client-side, which needed a new `getReceiptImageBase64` backend action to get raw image bytes past canvas-tainting for jsPDF's `addImage` — that whole approach was reverted mid-implementation in favor of the print-preview pattern above, because a real `<img>` tag in a real browser tab has no canvas-tainting issue at all (the browser fetches each thumbnail natively, same as the on-screen receipt modal), making the backend action, the jsPDF CDN dependency, and all PDF-drawing code unnecessary — the "Print / Save PDF" button in the report window (`window.print()`) delegates PDF creation to the browser's own print dialog instead. `window.open` is called **synchronously**, before the `getAllRequestsForPayroll` calls resolve (a placeholder page is written immediately, then swapped for the real report once data arrives) — Safari/Firefox popup blockers only honor a popup-open request during synchronous execution of a click handler, so opening it after an `await`/`.then()` gets silently blocked even without a misconfigured popup blocker.
   - `styles.css` has a `max-width: 640px` responsive breakpoint that turns `table.data-table` (the shared rendering used by `renderRequestsTable`/`buildLineItemsHtml_`) into stacked label:value cards instead of a horizontally-scrolling table — driven by `data-label="<Column Name>"` attributes that `common.js` sets on each `<td>`. Any future column added to those two renderers needs a matching `data-label` or it will silently render without a mobile label.
   - `index.html` has a third employee tab, "Utilities" (`#view-utilities`), housing the Meal Allowance calculator — `frontend/meal-allowance.js` (loaded only by `index.html`, after `employee.js`) owns all of its logic independently. `employee.js`'s `setEmployeeTab` was generalized to a 3-way switch to support it, but the tab itself is now conditionally hidden — see the Mother Branch/category note below. The utility is locked to the logged-in employee only — `maSyncSelectedEmployee_` mirrors `common.js`'s `currentEmployee` whenever the tab is opened; there is no way to search or look up another employee's attendance from this page (an earlier version allowed free lookup by ID/name — deliberately removed). The generic quoted-CSV parser it uses (`parseCsv_`/`csvToObjects_`) lives in `common.js`, not here — it's shared with `employee.js`'s Mother Branch lookup below.
   - Regular Meal Allowance is resolved from the End OUT attendance record's GPS only (Start IN is deliberately ignored — real usage showed employees often log IN from an unrelated location, like home, before traveling to the actual duty site). `maResolveDutyLocation_` just takes the *nearest* row in `STORE_COORDINATES_CSV_URL`'s reference table as a stand-in for "which region is this" — no name-matching, no distance cutoff — since the region-based bracket amount (`REGULAR (AUDIT/TEC/STAFF)`) only depends on broad region (NCR/NORTH LUZON/VISMIN/MINDANAO), not the exact store, and staff are sometimes sent to places not in the reference table at all (confirmed via a real "coverage area" case). Don't reintroduce a distance/name-match requirement on this general bracket lookup without an explicit ask — an earlier, more restrictive version was tried and rejected after multiple real cases (documented in `resume.md`) showed attendance GPS can legitimately drift several kilometers from a store's true location even for a confirmed-correct visit. Separately, `maResolveRegularAllowance_` scans the *entire* reference table (not just the nearest row) for a store where the logged-in employee's own Biometric ID is the assigned Tech/Area Head, applying their personal override amount only when the End OUT GPS is within `MA_ASSIGNED_OVERRIDE_RADIUS_METERS` (1.5km) of *that specific store* — deliberately not limited to whichever store is globally nearest, since an unrelated closer store shouldn't hide a legitimate match against the employee's own assigned site. Midnight Allowance has no automated rule at all (an earlier tiered-by-clock-out-hour version was removed as too broad) — it's a plain manual amount input, always.
   - The Meal Allowance utility can hand a computed line off into New Request: `maHandleAddToNewRequest_` reuses `employee.js`'s `addLineItemRow()`/`updateRunningTotal()` to add a pre-filled line, then `maLockRowAsMealAllowance_` injects a `Meal Allowance` `<option>` into just that row's category `<select>` and disables it (the shared `<template id="line-item-template">` no longer offers "Meal Allowance" as a manually-pickable category at all — manual entry is Fare/Accommodation only, so `CATEGORIES` in `Config.gs` staying unchanged is intentional, it must still accept the value arriving via this path), and replaces that row's file-upload field with a read-only link to the attendance End OUT photo, stashing the URL on `row.dataset.receiptUrl` for `employee.js`'s `collectLineItems()` to pick up as `line.receiptUrl`. If the End OUT record has no photo, the hand-off is blocked with a warning rather than submitting a Meal Allowance line with no proof. Date and Amount are locked read-only on that row (once saved to the log, those shouldn't drift); **Base Location is deliberately left editable** even though it's pre-filled as `"<City> — <Area/Region>"` when resolved — the GPS-matched store is only a stand-in for the region, not necessarily the literal establishment (real duty sometimes happens somewhere not in the store list at all), so it needs to stay correctable. Description shows the actual point-to-point duty (`"<Start destination> → <End destination> (<hrs>)"`), not a generic date string.
   - `employee.js` resolves a "Mother Branch" and employee category (`AreaHead`/`Technical`/`Audit`/`HeadOffice`/`Staff`) client-side right after login, via `applyEmployeeCategory_`/`resolveEmployeeCategory_`, fetching the **separate** `STORE_DIRECTORY_CSV_URL` reference sheet (not the coordinates one above — see `StoreDirectoryService.gs`'s Architecture note for its column layout, including the 11/12-vs-24/25 misalignment trap). This is a **UX mirror only**: it drives the Mother Branch display on the identity card and hides the Utilities tab entirely unless the category is `AreaHead`/`Technical`/`Audit`/`HeadOffice` (plain Staff never get Meal Allowance access) — same "client mirrors the server, server independently re-verifies" pattern as `admin.js`'s role maps. It fails **closed** on any fetch error (Utilities tab stays hidden, Mother Branch falls back to the employee's raw `BaseLocation`) since showing the utility to someone who shouldn't have it would violate the business rule, whereas a legitimate Tech/Audit/Area Head losing temporary access to a tab on a fetch hiccup is the safer failure direction. The same `applyEmployeeCategory_` pass also populates a per-store-name suggestion list (`populateLocationSuggestions_`/`locationSuggestionNames`) used by every line item's Base Location field — see below.
   - Each New Request line item's Base Location field has a hand-rolled autocomplete (`wireLocationAutocomplete_`, wired per-row in `addLineItemRow()`): a `.li-location-suggestions` `<ul>` filters `locationSuggestionNames` by substring as the user types and shows up to 8 matches, styled in `styles.css` to match the app. A native `<datalist>` was tried first but rendered inconsistently/oddly across browsers, so this replaced it — free text is still always allowed, it only suggests.
   - New Request's line-item form starts completely empty on login (no auto-added first line, no "Line N" badge on each card — both removed) — `resetLineItems()` just clears the container, and the remove button can now clear a card list down to zero.
   - There used to be a build step that inlined this same frontend source into Apps Script `HtmlService` templates (`Index.html`, `CSS.html`, `JS_*.html`) so Apps Script served the UI directly. That approach was abandoned in favor of the current fully-decoupled static-site-calls-JSON-API design; if you see references to `build.js` or those generated `.html` partials in history, they're obsolete — do not resurrect that pattern without instruction.

## Recently completed (verify in a real browser before considering fully done)

Items 1-6 below (submission window, bulk approve/disburse, admin tabs, audit filters,
sequential IDs, export PDF fix) and item 10 (Authorizer submission exemption) are
**deployed live** — `clasp deploy -i` was run against deployment
`AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg` (now `@35`)
and confirmed via `curl` against the real `/exec` URL. Items 7-9 are all 100% frontend,
no backend push/deploy needed — live as soon as the static files are served. Item 11
(concurrency/lag fix + exemption search speedup) is also fully deployed —
`clasp deploy -i` was run against the same deployment, now `@36`. Items 12-14 (Print
Preview Employee ID grouping/subtotal, Grand Total/signature fix, export filter
selection + post-cycle My Requests hiding, explicit row-selection for export + filter
bar restyle) are also 100% frontend — no backend push/deploy needed.

10. **Authorizer-only "Submission Exemption" — emergency 1-hour bypass of the Thu/Fri
    submission block.** New backend file `ExemptionService.gs` (whitelisted in
    `.claspignore`) and a new `SubmissionExemptions` sheet tab (`ExemptionID, EmployeeID,
    EmployeeName, GrantedBy, GrantedDate, ExpiresAt, RevokedBy, RevokedDate`), created by
    re-running `setupSheets()`. An Authorizer searches an employee (reusing
    `MealAllowanceService.gs`'s previously-unused `searchEmployeesForUtility`) on a new
    "Submission Exemption" tab in `admin.html`, gated to `currentApprover.role ===
    'Authorizer'` only (the opposite shape of gate from the existing history tab's negative
    `!== 'Approver'` check — this one is positive, since granting a bypass is specifically
    an Authorizer-level power). Granting calls `grantSubmissionExemption(employeeId, userId,
    password)`, which resolves credentials via the same `getApproverByCredentials_` +
    hardcoded `ROLE_AUTHORIZER` gate every other mutation in this app uses, then — inside
    `LockService.getScriptLock()` — soft-revokes any existing active exemption for that
    employee first (**re-grant always replaces with a fresh 1-hour window**, never
    stacks/merges) before appending a new row with `ExpiresAt = now + 1 hour`. Revoke is
    always a soft update (`RevokedBy`/`RevokedDate` stamped, row never deleted), so the
    sheet doubles as a full audit trail, matching how `Requests` never deletes rows either.
    `Validation.gs`'s `submissionWindowError_()` (the single call site, from
    `validateSubmission_`) now takes an `employeeId` param and checks
    `getActiveExemptionForEmployee_(employeeId)` before blocking Thu/Fri — "active" is a
    derived rule (`RevokedDate` blank AND `ExpiresAt > now`), checked lazily on every call,
    no cron/trigger involved. The Authorizer's panel also shows a live list of every
    currently-active exemption (`getActiveSubmissionExemptions`, sorted soonest-expiring
    first) with a cosmetic client-side `setInterval` countdown (30s tick, only while that
    tab is showing) and a per-row manual Revoke button
    (`revokeSubmissionExemption(exemptionId, userId, password)`) — all three of these were
    explicit answers to clarifying questions asked before planning (replace-on-regrant,
    show-the-list, allow-manual-revoke). On the employee side, `employee.js`'s
    `applySubmissionWindowState_()` and the actual submit-click guard in
    `handleSubmitRequest()` both became exemption-aware via a new
    `checkMySubmissionExemption(employeeId)` read action — **fails closed** on any error
    (unlike this app's fail-open routing fallback elsewhere, which is a UX convenience, not
    an authorization gate), so a check failure can only ever produce a wrongly-blocked
    submit, never a wrongly-allowed one; `Validation.gs` remains the real authority either
    way. Four new `API_ACTIONS` entries in `Code.gs`; `checkMySubmissionExemption` and
    `getActiveSubmissionExemptions` added to `common.js`'s `READ_ONLY_ACTIONS` (GET, no
    credentials); `grantSubmissionExemption`/`revokeSubmissionExemption` stay POST, same as
    `advanceRequestStage`. Tab/panel label is "Submission Exemption" (renamed from an
    initial "Emergency Exemption" per the user's own follow-up ask — code-level identifiers
    like `ExemptionService.gs`/`SubmissionExemptions` were kept as-is, only user-facing text
    changed).
    - **Verified**: `node --check` on all touched frontend files; a Node simulation of the
      active/expired/revoked/re-grant-replaces/non-Thu-Fri-never-blocks logic (mirroring
      `isExemptionRowActive_`/`submissionWindowError_`) all passed; live `curl` smoke test
      against the deployed `/exec` URL confirmed `getActiveSubmissionExemptions` returns
      `[]` only after `setupSheets()` was re-run to create the `SubmissionExemptions` tab
      (it correctly errored with `"Sheet not found"` beforehand, confirming the code path is
      real, not silently no-op-ing).
    - **Not yet checked in a real browser**: the actual Authorizer search → grant → see-in-
      list → countdown → revoke flow, and confirming an exempted employee's Submit button
      actually re-enables and a real submission succeeds during a live Thu/Fri window.

11. **Concurrency/lag fix — shrink the shared `LockService` lock window, raise its
    timeout, add silent client-side retry on "System is busy," and stop the
    Submission Exemption tab's employee search from hitting Apps Script per
    keystroke.** Users reported lag/timeouts on submit/upload/loading data under
    multi-user load. All 5 mutation entry points (`submitLiquidationRequest`,
    `advanceRequestStage`, `updateLineItemAmount`, `grantSubmissionExemption`,
    `revokeSubmissionExemption`) already serialize through one shared, script-wide
    `LockService.getScriptLock()` — so "one at a time" already existed; the actual
    problem was `submitLiquidationRequest` running its Drive receipt upload(s)
    *inside* that lock, so a slow external Drive API call blocked every other
    queued action app-wide (not just other submissions), plus a fixed 10s
    `waitLock` that hard-rejected callers with "System is busy, please try again."
    under real contention. See the Architecture section's Drive-upload paragraph
    above for the resulting 3-phase `submitLiquidationRequest` structure (short
    lock for ID generation → unlocked Drive upload → short lock for the Sheet
    writes). `waitLock` was raised from `10000` to `20000` in
    `submitLiquidationRequest` (both phases), `advanceRequestStage`, and
    `updateLineItemAmount` — the two exemption actions in `ExemptionService.gs`
    were deliberately left at `10000` (rare, Authorizer-only, no reason to make
    them wait longer). `SheetService.gs`'s uncached full-sheet reads and per-field
    `updateRowFields_` writes were deliberately left untouched this pass — a real
    further improvement, but shared by every other backend file
    (`EmployeeService.gs`/`ApproverService.gs`/`MealAllowanceService.gs`/
    `StoreDirectoryService.gs`), so riskier to bundle here with no test coverage;
    scope it as its own separate pass if lag persists after this fix.
    `frontend/common.js`'s `fetchJsonWithRetry_` gained a second, independent
    retry budget (`busyAttemptsLeft`, `BUSY_RETRY_DELAYS_MS = [500, 1000, 2000,
    4000]`) that only fires on a well-formed `{success:false, error:'System is
    busy...'}` response (regex `/busy/i` against `error`) — any other
    `success:false` error (validation, "Request not found", etc.) is never
    retried. This sits *after* the existing network-failure and malformed-JSON
    retry layers in the same function, so all three retry reasons compose without
    duplicating logic, and needed no changes at `runServer` or any
    `employee.js`/`admin.js` call site since they all already funnel through
    `fetchJsonWithRetry_` uniformly. Ordering across concurrent requests is
    explicitly NOT guaranteed by any of this (`LockService` has no FIFO fairness)
    — confirmed with the user that this doesn't matter, only "stop timing
    out/lagging" does.
    - **Separate, related fix same session**: the Authorizer's Submission
      Exemption tab search box (`admin.js`'s `searchExemptionEmployees_`) was
      calling `searchEmployeesForUtility` — an Apps Script action that re-reads
      the whole `Employees` sheet uncached — on every debounced keystroke,
      visibly laggy in a screenshot the user shared. Switched it to a new
      `frontend/common.js` function, `searchEmployeesFromCsv_()`, a client-side
      port of that same search logic (ID/Name substring match, Active-only, top
      15 results) run against the already-cached `EMPLOYEES_CSV_URL` data
      (`loadEmployeesCsv_()` — the same cache the Biometric ID login already
      uses), so a search is now a local filter with zero backend round trips
      after the first page-load fetch. `searchEmployeesForUtility` itself is
      untouched and now unused again (same fate as the last time this pattern
      was applied — see the CSV-based-read-paths section below).
    - **Verified**: `node --check` passes on both touched frontend files;
      `clasp push -f` + `clasp deploy -i` succeeded, live at deployment `@36`,
      confirmed via `curl` against `getAllRequestsForPayroll` (both `Reviewed`
      and `Authorized` filters returned valid JSON). The CSV-based exemption
      search was verified against the real live published Employees CSV in
      Node (not just code inspection) — searching "celis" correctly matches
      employee 150 (Celis, Louwin), same result the old backend search would
      have returned.
    - **Not yet done / cannot verify without a real browser and real concurrent
      callers**: whether the lock/upload restructuring actually reduces
      observed lag/"System is busy" failures under real multi-user load;
      whether the 20s `waitLock` makes any single caller wait uncomfortably
      long in silence; that the busy-retry doesn't mask a genuinely persistent
      (non-transient) failure behind repeated silent retries; the orphaned-
      Drive-file edge case (Sheet write failing after a successful upload)
      actually occurring; and confirming the Submission Exemption search feels
      fast in an actual browser, not just in a Node simulation.
    - **Same-session follow-up**: after this deployed, multiple Approvers
      intermittently hit "Login failed: Connection problem — please check your
      signal and try again." on `admin.html`. Confirmed via investigation this
      is structurally unrelated to the lock/upload changes above — that message
      can only come from `common.js`'s `fetchWithRetry_` when the raw `fetch()`
      promise itself rejects or the 25s `AbortController` timeout fires, after
      retries are exhausted; `loginApprover` never returns `{success:false,...}`
      (it returns `{found:false, error:...}`) so the busy-retry branch can't
      even match it, and `ApproverService.gs`'s `loginApprover` path has no
      `LockService` call at all. Most likely cause: Apps Script's GET/POST→302→
      echo-redirect content-URL dance (already documented as "confirmed
      transient... after a fresh deploy or a cold start") occasionally
      outlasting the old 1-retry/400ms budget, or a brief real network drop —
      happening across multiple people, not one person's signal, so purely a
      retry-budget tuning: raised `fetchWithRetry_`'s default attempt count from
      2 to 3 (1 retry → 2 retries) and switched its fixed 400ms backoff to an
      increasing schedule via a new `NETWORK_RETRY_DELAYS_MS = [400, 1200]`
      (mirroring `BUSY_RETRY_DELAYS_MS`'s shape); `fetchJsonWithRetry_`'s own
      default moved to match since both retry mechanisms share the same
      `attemptsLeft` counter. `FETCH_TIMEOUT_MS` (25s per attempt) is
      unchanged — this is about giving more chances to recover, not waiting
      longer per attempt. 100% frontend (`common.js`), no backend change.
      **Verified**: `node --check` passes; a Node simulation of the retry
      indexing confirmed exactly 3 total attempts with 400ms then 1200ms
      backoff before giving up. **Cannot verify without it recurring in the
      wild** — the root cause (cold-start/redirect timing vs. real network) was
      never directly observed, only inferred, so there's no way to confirm this
      actually resolves the intermittent failures until it's tried again by the
      affected users.

12. **Print Preview summary table grouped by Employee ID with a per-employee,
    per-Crediting-Date subtotal.** User asked for the "Print Preview" export
    report to arrange its summary table by Employee ID and show a total of
    expenses per employee grouped by their disbursement (Crediting) date,
    while leaving the itemized receipt pages' content and the Approved/
    Reviewed/Verified columns/captions unchanged. 100% frontend
    (`frontend/admin.js`), no backend/CSV-export change, no deploy needed.
    - New pure helper `groupRequestsForReport_(requests)` in `admin.js`:
      sorts requests by `EmployeeID` (primary, numeric-aware string compare)
      then `CreditingDate` (secondary; a blank/null `CreditingDate` — a
      legacy or not-yet-disbursed row — sorts *last* within that employee,
      not first), then buckets them into groups keyed by
      `EmployeeID + CreditingDate`.
    - `buildExportReportHtml_`'s summary-table build now walks these groups
      instead of the flat `requests` array, appending a `subtotal-row`
      (`Subtotal — <EmployeeName> — Crediting <date or "N/A">`, summing that
      group's `TotalAmount`) after every group with **2+ requests only** —
      a single-request group's subtotal would just repeat that one row's own
      Total column, so it's deliberately skipped to avoid noise. (The overall
      grand-total row itself was later changed from `<tfoot>` to a plain
      `<tbody>` row — see the follow-up below.)
    - The itemized receipt-page build (the 2-up Fare/Accommodation and 6-up
      Meal Allowance buckets, `fareItems`/`mealItems`/`missing`) now iterates
      the same `groups` structure rather than the flat `requests` array, so
      the printed receipt packet follows the same Employee ID → Crediting
      Date order as the summary table above it — the bucketing/chunking/
      caption logic itself is byte-for-byte unchanged.
    - New `.subtotal-row` CSS rule added to the report's inline `<style>`
      block (light gray background + bold text, prints fine in black-and-
      white), next to the existing `.grand-total-row` rule.
    - Explicitly out of scope, confirmed with the user beforehand: CSV export
      (`buildExportCsv_`/`EXPORT_CSV_HEADERS`) keeps its current per-line-item
      order untouched; the Approved/Reviewed/Verified column contents and the
      "Approved by X · Reviewed by Y · Verified by Z" caption wording are
      unchanged; no backend, sheet, or `setupSheets()` change.
    - **Verified**: `node --check frontend/admin.js` passes; a standalone Node
      test of `groupRequestsForReport_` against synthetic data confirmed
      numeric-aware Employee ID ordering, blank-`CreditingDate`-sorts-last
      within an employee, and correct subtotal-eligibility (multi-request
      groups get a subtotal, single-request groups don't) — all assertions
      passed. **Not yet checked in a real browser** — the subtotal row's
      visual shading/bold styling in an actual print/PDF render, and whether
      the reordered receipt-page sequence reads well end-to-end, still need a
      manual pass.
    - **Same-session follow-up**: user reported the Grand Total row was
      printing on *every* page of the summary table instead of once at the
      end. Root cause: it was wrapped in `<tfoot>`, and Chrome/Firefox repeat
      a table's `<tfoot>` at the bottom of every printed page a multi-page
      table spans (mirroring how `<thead>` repeats at the top) — the
      `subtotal-row`s were unaffected since those are plain `<tbody>` rows.
      Fixed by moving the Grand Total into a plain `<tr class="grand-total-
      row">` appended as the last row of `<tbody>` instead of a `<tfoot>` —
      a `<tbody>` row only ever renders once, wherever it falls in the
      table's content flow, so it now lands on the table's actual last page.
      Also added a static two-column **signature block** (`signature-block`
      div, blank underline + label + Date line for "Reviewer" and "Verified
      by") right after `</table>` and before the itemized receipt pages, for
      a physical pen signature on the printed copy — deliberately blank, not
      pre-filled with the recorded `ReviewedBy`/`AuthorizedBy` names, since
      those are already shown per-row in the table itself. Appears exactly
      once per report, not per employee group or per page.
      **Verified**: `node --check` passes; rendered `buildExportReportHtml_`
      in Node against mock request data and confirmed no `<tfoot>` remains
      anywhere in the output, the Grand Total row is the last child of
      `<tbody>`, and the signature block appears exactly once. **Not yet
      checked in a real browser** — the signature block's actual print
      appearance and whether it ever splits awkwardly across a page break.

13. **Export CSV/Print Preview now respect the on-screen filters (+ a new
    Crediting Date range), and a Disbursed request drops off the employee's
    own "My Requests" the day after its CreditingDate.** Two related asks:
    exporting should let Payroll actually select what gets printed (e.g. by
    Crediting Date, by employee name), and once a disbursement cycle is
    finished, that request shouldn't linger indefinitely in the employee's
    own view — but must stay visible forever to Reviewer/Verifier as the
    audit trail. Both 100% frontend (`admin.html`, `admin.js`, `common.js`,
    `employee.js`), no backend/schema change, no deploy needed.
    - **Export now filter-aware**: previously `fetchExportableRequests_`
      independently re-fetched every `Reviewed`/`Authorized` request,
      ignoring whatever the visible "Reviewed & Disbursed" table's Status/
      Employee Name/Date Requested filters were set to. The filter logic
      inside `loadAdminHistory` was extracted into a new shared
      `getFilteredHistoryRequests_(allRequests)`, and `fetchExportableRequests_`
      now calls `loadJoinedRequests_().then(getFilteredHistoryRequests_)` —
      so Export CSV and Print Preview always export exactly what's currently
      on screen, not an independent unfiltered set.
    - **New Crediting Date range filter**: two more `<input type="date">`
      fields (`admin-history-crediting-date-from`/`-to`) added to the same
      filter bar as the existing Date Requested range, wired the same way
      (`change` → `loadAdminHistory`). Composes with AND alongside Status/
      Name/Date Requested inside `getFilteredHistoryRequests_`. A
      `Reviewed`-status row (no `CreditingDate` yet) is excluded whenever
      this filter is actively narrowing by a crediting-date range — it has
      nothing to compare against.
    - **Employee's My Requests hides a Disbursed request the day after its
      CreditingDate**: new `isPastCreditingDate_(creditingDateStr)` in
      `common.js` (plain calendar "today > CreditingDate" check, comparing
      local midnight-to-midnight, no business-day skipping — the
      CreditingDate itself still shows). `employee.js`'s `loadMyRequests()`
      filter gained `if (req.Status === 'Authorized' && req.CreditingDate &&
      isPastCreditingDate_(req.CreditingDate)) return false;` alongside the
      existing own-EmployeeID check.
    - **No change needed for the Approver role or the Reviewer/Verifier
      history tab** — confirmed by reading the code first: an Approver-role
      login's queue (`loadAdminRequests`'s `queueStatuses`) never includes
      `Reviewed`/`Authorized` in any filter state today, so it was already
      impossible for an Approver to see a Disbursed request regardless of
      date; and the "Reviewed & Disbursed" tab (Reviewer/Verifier only, per
      `applyAdminTabVisibility_`) is explicitly the permanent, date-unfiltered
      audit trail and was deliberately left untouched.
    - **No "N hidden" indicator added** to My Requests — matches this app's
      existing precedent (the Approver queue already silently omits
      out-of-scope requests with no messaging).
    - **Verified**: `node --check` passes on all four touched files; a
      standalone Node test of the filter-composition logic and
      `isPastCreditingDate_` against synthetic data confirmed: Crediting Date
      range filtering composes correctly with Status/Name/Date Requested
      (AND semantics, a Reviewed row with no CreditingDate is excluded when
      the range filter is active); a request credited yesterday is hidden
      from a simulated My Requests, one credited today still shows, and a
      non-Authorized request is never excluded regardless of any stray date
      field — all assertions passed. **Not yet checked in a real browser**:
      that Export CSV/Print Preview reflect an applied Crediting Date filter
      end-to-end, and a real Disbursed request actually disappearing from an
      employee's My Requests the day after its CreditingDate (can't be
      verified live without a real date rollover or adjusted test data).

14. **Explicit row-selection for Export/Print, dropped the Date Requested filter,
    restyled the filter bar.** User (in Filipino) asked for a real way to hand-pick
    exactly which requests get exported/printed (example: check exactly 3 requests,
    only those appear in Print Preview) instead of only being able to narrow via
    filters; asked to remove the "Date requested — from/to" filter entirely; and
    asked for the filter bar's UI/UX to look cleaner. 100% frontend (`admin.html`,
    `admin.js`, `styles.css`), no backend/deploy needed. Confirmed via clarifying
    questions: one shared checkbox column, always rendered on the "Reviewed &
    Disbursed" table regardless of status filter/role (previously checkboxes only
    appeared when filtering "Reviewed" as a Verifier, for bulk-disburse) — the same
    checks also still drive the existing bulk-disburse bar whenever that happens to
    be eligible; and when nothing is checked, export falls back to the current
    filtered-view behavior, unchanged.
    - New module-level `historyExportSelection_` (array of checked RequestIDs),
      reset to `[]` at the top of every `loadAdminHistory()` run. `renderRequestsTable`
      is now always called with `selectable: true`; its `onSelectionChange` updates
      `historyExportSelection_` unconditionally and *additionally* calls
      `historyBulkController_.updateSelection(selectedIds)` only when `bulkEligible`
      is also true — decoupling "can select rows for export" from "can bulk-advance
      the selection," which used to be the same gate.
    - `fetchExportableRequests_` now checks `historyExportSelection_` first: if
      non-empty, filters `loadJoinedRequests_()`'s result to just those RequestIDs
      (bypassing the Status/Name/Crediting-Date filters entirely — an explicit pick
      always wins); otherwise falls back to `getFilteredHistoryRequests_`, exactly
      as the prior session left it.
    - New `updateExportSelectionIndicator_(count)` writes a small hint line ("N
      requests selected — export will use only these") near the export buttons,
      cleared on every reload — the only UI feedback that a selection is active,
      since the checkboxes alone don't make the effect on Export obvious.
    - **Removed** the `admin-history-date-from`/`-to` (Date Requested/`DateSubmitted`)
      filter entirely — fields deleted from `admin.html`, their filter block and
      event listeners removed from `admin.js`. The Crediting Date range filter
      (added last session) is unaffected and remains the only date-range filter.
    - **Filter bar restyle**: the filter fields are now wrapped in a `.filter-panel`
      (light inset background, `--color-bg`, distinct from the white `.card`) with a
      small "Filters" header and a new "Clear filters" button
      (`#btn-clear-history-filters`, resets Stage to `Reviewed` and clears
      Name/Crediting Date, then reloads) — new `.filter-panel`/`.filter-panel-header`/
      `.filter-panel-title`/`.btn-link`/`.export-selection-hint` rules in `styles.css`.
    - **Verified**: `node --check frontend/admin.js` passes; confirmed no dangling
      references to the removed `admin-history-date-from`/`-to` IDs remain anywhere
      in `frontend/`; a standalone Node test of the selection-vs-filter logic
      confirmed an explicit 3-item selection is returned exactly and ignores an
      active Status filter that would otherwise exclude them, an empty selection
      falls back to the filtered view, and a stale/nonexistent selected ID is
      silently ignored rather than crashing. **Not yet checked in a real browser**:
      the new filter-panel/hint visual appearance, checking specific rows and
      confirming Export CSV/Print Preview include exactly those, and "Clear
      filters" resetting the view correctly.

7. **"Senior Head" region-based Meal Allowance bracket.** `STORE_COORDINATES_CSV_URL`'s
   published sheet gained a new sub-table (columns 24-27: BIO ID / SENIOR HEAD name /
   Area-Region / amount) — a per-person, per-region rate distinct from both the existing
   flat regional bracket and the existing per-store Tech/Area Head proximity override.
   `frontend/common.js`'s `parseStoreCoordinatesCsv_` reads it via fixed column index into
   collision-safe keys (`SeniorHeadBioId`/`Name`/`Region`/`Amount`), and a new
   `buildSeniorHeadBracket_()` turns it into a `{bioId: {region: amount}}` lookup, built once
   alongside `maStoreCache`. `frontend/meal-allowance.js`'s `maResolveRegularAllowance_` checks
   this bracket first (highest priority, no proximity radius — it's region-wide by
   definition), falling through to the existing per-store override then the flat regional
   bracket if the employee isn't a listed Senior Head or their current region isn't in their
   table. Data-driven, not hardcoded to the one person (Jayriel, BIO 783) currently listed —
   a future Senior Head added as a new row needs no code change.
   - **Real bug found and fixed along the way, not just the new feature**: the same sheet
     edit that added these columns reused the header names `"Area/Region"` (already at column
     17) and `"Meal Allowance"` (already at column 5), so the existing header-keyed parsing
     silently started reading the *new*, mostly-blank sub-table's values instead — breaking
     the on-screen "Location" display for 113 of 119 stores and silently zeroing every
     Tech-role personal override amount. Fixed by extending the same fixed-column-index
     pattern already used for the prior `BIO ID`/`REGULAR (AUDIT/TEC/STAFF)` duplicate-header
     bug (see `common.js`'s header comment above `parseStoreCoordinatesCsv_`).
   - **Verified against live data**: parsed the real published CSV in Node and confirmed
     `Area/Region` is non-blank for all 119 rows, a real Tech override amount resolves
     correctly (not 0), and BIO 783 resolves to ₱200 at a MINDANAO-region store / ₱100 at an
     NCR-region store (matching the source sheet), while an unrelated employee at the same
     stores is unaffected. `node --check` passes on both touched files. No backend
     push/deploy needed — static frontend only, live immediately. **Not yet checked in a real
     browser.**

8. **Messenger-style Prev/Next attachment navigation + bulk select on every approval stage,
   including bulk Reject.** Both 100% frontend (`common.js`, `admin.js`, `admin.html`,
   `styles.css`), no backend push/deploy needed.
   - The shared receipt/line-item preview modal now shows Prev/Next arrows + an "N / total"
     counter (plus Left/Right arrow-key support) whenever a request has 2+ line items, so an
     Approver can page through every attachment on a request without closing and reopening the
     modal — `wireLineItemRows_` resolves the clicked line's index in `request.lines` (already
     in scope) and hands off to a new `openLineItemPreviewWithNav_`, which recomputes the
     editable/`onSaveAmount` binding per line shown (so Save Amount always targets whichever
     attachment is currently displayed) and re-invokes the existing `openLineItemPreview_`.
   - Bulk select is no longer limited to Approved→Reviewed and Reviewed→Authorized: the
     Pending→Approve exclusion in `loadAdminRequests` was removed (safe since the Pending queue
     is already server-side scoped to the logged-in Approver's own routed requests, and
     `advanceRequestStage` re-checks routing per item regardless), and `makeBulkController_`
     gained a second "Reject Selected" button on every bulk bar, sharing the same
     checkboxes/running-total/confirm/password-gate/sequential-processing flow as the forward
     action.
   - **Two real bugs found and fixed along the way** (not just the two features above):
     (1) `.receipt-modal-image-pane` had no `position: relative`, so every overlay button inside
     it (download, rotate, and the new Prev/Next/counter) was positioning itself relative to the
     whole `.receipt-modal` card instead of just the image area — harmless by coincidence for
     the existing top-left buttons, but the new right-anchored Next button and center counter
     would have bled into the details pane on desktop. Fixed with one `position: relative`.
     (2) User reported the "Reviewed & Disbursed" tab's expanded row showing a completely blank
     line-items panel with no console error. Root cause (found by simulating both admin tabs
     rendered at once in a Node+jsdom harness, matching how `admin.html` actually keeps both
     tables in the DOM simultaneously): `toggleRow`'s panel lookup used a global
     `document.getElementById('detail-panel-' + idx)`, but both tabs' tables number their rows
     from 0, so `detail-panel-0` existed twice and the lookup always grabbed the *first* one in
     the document — silently writing content into the other (hidden) tab's panel while the
     visible one stayed empty. Fixed by scoping the lookup to
     `container.querySelector('#detail-panel-' + idx)`.
   - **Verified via Node/jsdom against the real live published Requests/RequestLines CSVs**
     (not just `node --check`): confirmed the exact reported request renders all 9 line items
     correctly after the fix, and re-simulated the two-tables-at-once collision scenario to
     confirm the fix resolves it without touching the other tab's panel. **Not yet checked in a
     real browser** — Prev/Next positioning, arrow-key nav, and bulk-approve/bulk-reject on all
     three bars still need a manual pass.

9. **Mobile "Failed to fetch" resilience, Approver queue routing-scope widened to every status,
   and approver names added to Print Preview receipt captions.** All 100% frontend
   (`common.js`, `admin.js`, `admin.html`), no backend push/deploy needed.
   - **Network resilience**: `common.js`'s `fetchJsonWithRetry_()` previously only retried when
     the response body was bad JSON (Apps Script's known transient echo-redirect 404) — a real
     rejected `fetch()` promise (a dropped/unstable connection, common on cellular) propagated
     straight to the caller as a raw, unactionable `TypeError: Failed to fetch`, and nothing
     anywhere had a timeout, so a stalled mobile connection could hang indefinitely. New shared
     `fetchWithRetry_()` wraps every request with a 25s `AbortController` timeout and one silent
     400ms-backoff retry on actual network failure (not just bad JSON), throwing a friendly
     `"Connection problem — please check your signal and try again."` after retries are
     exhausted instead of letting the raw TypeError surface — `employee.js`'s existing
     `setMessage(errorEl, err.message, true)` call sites needed no changes to pick this up.
     `fetchJsonWithRetry_` (all RPC calls: login, submit, every mutation) and a new
     `fetchTextWithRetry_` (the Biometric ID login's CSV lookup, `loadEmployeesCsv_`) both build
     on it — directly covers the reported "logging in... especially in mobiles" failures. Other
     bare `fetch()` CSV reads elsewhere in the app (store directory, requests/lines, attendance,
     store coordinates) were deliberately left untouched — out of scope for this pass.
   - **Approver queue scoping widened, after a same-session correction**: first pass hid the
     Status dropdown for Approver-role logins entirely and hardcoded their view to `Pending`
     only — the user then clarified (in Filipino) that went too far: an Approver should still be
     able to see requests **they've already approved** (their own history for employees routed
     to them), not just their live Pending queue. Reverted the dropdown-hiding
     (`applyAdminTabVisibility_` no longer touches `#admin-status-filter-field`) and instead
     widened the existing `resolveRequiredApprover_` routing-scope check in
     `loadAdminRequests()` — previously gated to `req.Status === 'Pending'` only — to apply to
     every Status filter option (Pending/Approved/Rejected/All), since the routing check itself
     is stage-independent (resolved from the employee's Department/BaseLocation and the
     request's own line location, not from `Status`). An Approver switching to "Approved" now
     sees only the ones they themselves approved, not everyone's. Reviewer/Authorizer's
     "Reviewed & Disbursed" tab/filter is completely unaffected either way. Purely a
     client-side *display* refinement, same "client mirrors server, server re-verifies" pattern
     as the rest of the app — `getAllRequestsForPayroll`'s own Pending-only server-side scope is
     unchanged.
   - **Print Preview receipt captions now show who approved**: the summary table already showed
     `ApprovedBy`/`ReviewedBy`/`AuthorizedBy`, but the individual receipt image pages further
     down only captioned Request ID/Employee/Date/Category/Amount. `buildExportReportHtml_`
     now adds a second caption line per receipt — "Approved by X · Reviewed by Y · Authorized by
     Z" (only showing stages that have actually happened; `ApprovedBy`/`ReviewedBy` are always
     present since only Reviewed/Authorized statuses are exportable, `AuthorizedBy` only once
     Disbursed) — reusing the exact field names already on the request object, no backend or
     CSV-export changes needed.
   - `node --check` passes on all touched files. **Not yet checked in a real browser** — flaky/
     throttled-connection retry behavior, the Approver dropdown's per-status scoping, and the
     new receipt-caption line all still need a manual pass.

<details>
<summary>Prior session — items 1-6 (submission window, bulk approve/disburse, admin tabs, audit filters, sequential IDs, export PDF fix)</summary>

1. **Saturday–Wednesday submission window.** `Validation.gs`'s `submissionWindowError_()`
   (called at the top of `validateSubmission_`) blocks `submitLiquidationRequest` on
   Thursday/Friday (Manila time, per `appsscript.json`'s `timeZone`), naming the reopening
   Saturday and the week's disbursement Friday in the error message —
   `RequestService.gs`'s sibling `computeNextSubmissionOpenSaturday_()` supplies the reopen
   date (same Monday-indexed week math as the existing `computeNextCreditingFriday_()`).
   `frontend/employee.js` mirrors this with a banner + disabled Submit button on the New
   Request tab (`applySubmissionWindowState_`, checked once per tab view) — UX only, the
   backend re-validates independently on every submit.
2. **Bulk select + "select all" + running total, Approve/Disburse in bulk.**
   `frontend/common.js`'s `renderRequestsTable` gained an optional `selectable`/
   `onSelectionChange` mode (checkboxes + a header "select all", ids skipped for My
   Requests since it never passes the option). `frontend/admin.js`'s
   `makeBulkController_(ids, refresh)` factory drives two independent bulk bars — one for
   the Reviewer's Approved queue, one for the Authorizer's Reviewed queue on the history tab
   (see item 3) — showing a running total of selected requests' `TotalAmount` and advancing
   every selected request sequentially through the existing `advanceRequestStage` (not
   `Promise.all`, to avoid hammering `LockService` concurrently), patching the CSV cache
   after each success the same way the single-item flow already does.
3. **Admin split into two tabs: "Liquidation Requests" + "Reviewed & Disbursed".**
   The old single queue+dropdown mixed all five statuses together, which was confusing for
   the Reviewer/Authorizer roles specifically. Now: `view-admin-queue`
   (Pending/Approved/Rejected/All — "All" now strictly means those three, not silently
   including Reviewed/Authorized as before) is the live "still needs action" queue;
   `view-admin-history` ("Reviewed & Disbursed") holds Reviewed (Authorizer still disburses
   from here, single + bulk) and Authorized/"Disbursed" (pure history) together, plus the
   Export CSV/Print Preview buttons (moved here since they only ever exported this exact
   status pair anyway). `admin.js`'s `setAdminTab`/`refreshAdminActiveTab_` mirror
   `employee.js`'s tab pattern; `adminOnDetailRendered_` is shared by both tabs' single-item
   action panel so `wireAdminActions_`/`isLineEditableForCurrentApprover_` needed no changes.
   The history tab is now also **hidden entirely for Approver-role logins**
   (`applyAdminTabVisibility_`, called right after login/session-restore) — an Approver only
   ever needs the live queue.
4. **Reviewed & Disbursed: permanent audit filters.** Since this tab is the permanent audit
   trail (never time-windowed — `loadJoinedRequests_` already returns the full dataset, no
   code change needed for that part), added Employee Name (substring, case-insensitive) and
   Date Requested (from/to range on `DateSubmitted`) filters alongside the existing Status
   dropdown in `loadAdminHistory()`, ANDed together. The Export CSV/Print Preview buttons in
   this tab's header were also regrouped into a `.header-actions` wrapper so they sit right
   next to each other instead of being spread apart by `.card-header-row`'s
   `justify-content: space-between` (which, with 3 flex children, spread all three evenly).
5. **Shorter, sequential Request IDs.** `IdGenerator.gs`'s `generateRequestId_()` replaced
   the long `REQ-20260912-122045-176` timestamp+random format with a persistent counter via
   `PropertiesService` — `REQ#000001`, `REQ#000002`, etc. Safe without new locking since
   `submitLiquidationRequest` already calls this from inside its existing
   `LockService.getScriptLock()` section. Old `REQ-...` IDs stay as historical values (no
   migration needed — the two formats can never collide). `generateLineId_`/
   `generateMealAllowanceId_` are unaffected.
6. **Export PDF page-fit bug — fixed.** `admin.js`'s `buildExportReportHtml_` 2-up/6-up
   receipt layouts were only fitting 1 receipt per printed page instead of 2/6. Root cause:
   `.receipt-page` had `min-height: 90vh` (a *viewport* unit, meaningless once printed) and
   no real `height`, so children's `height: 100%` never resolved to anything definite and
   collapsed to auto content height. First attempted fix (giving `.receipt-page` a real
   `height: 255mm`) still didn't fix it — browsers' print engines don't reliably resolve a
   flex/grid child's *percentage* height against print pages either. Final fix: every cell
   gets an **explicit millimeter height** computed from the fixed page height instead
   (124mm × 2 for the 2-up layout, 82mm × 3 for the 6-up grid), which is deterministic
   because it never depends on a parent being "definite" during pagination. Also added
   `page-break-inside: avoid` per cell, matching borders on both bucket types, and a
   grand-total `<tfoot>` row summing `TotalAmount` across the exported set.
   - **Not yet verified in a real browser/PDF** — the CSS reasoning is sound and the two
     earlier attempts' failure modes are understood, but nobody has actually printed/saved a
     PDF with this exact fix yet.

</details>

Older, previously-shipped work below (Timesheet category, CSV-based read paths + optimistic
cache patching) is fully deployed; see `resume.md` for the full narrative history.

<details>
<summary>Prior session: CSV-based read paths for speed + resilience against Apps Script's transient "echo" 404 — DONE.</summary>

   Apps Script's GET/POST flow always redirects to a one-time `script.googleusercontent.com`
   content URL, and that hop intermittently 404s (confirmed transient: the exact same call
   always succeeds on an immediate retry, both via a live `curl`/Node test and by re-clicking in
   the browser) — this was showing up as "Unexpected token '<'" / "Login failed" / "Export
   failed" errors across the app. Two complementary fixes, both live:
   - **Silent auto-retry** — `common.js`'s `runServer()` now goes through a new
     `fetchJsonWithRetry_()` helper: if the response body isn't valid JSON (the 404's HTML page),
     it waits 400ms and retries once before surfacing an error. This covers every remaining
     Apps Script mutation in the app (`loginApprover`, `advanceRequestStage`,
     `updateLineItemAmount`, `submitLiquidationRequest`, `saveMealAllowanceRecord`) automatically,
     since they all go through the one shared `runServer()`.
   - **Moved read-only, high-frequency lookups off Apps Script entirely**, onto the same
     "published Google Sheet as CSV, parsed client-side" pattern already used for the 3
     external reference sheets (attendance/store-coordinates/store-directory). Three more
     sheets — **Employees, Requests, RequestLines** — are now also published to the web as CSV
     (`frontend/config.js`'s `EMPLOYEES_CSV_URL`/`REQUESTS_CSV_URL`/`REQUEST_LINES_CSV_URL`).
     Only mutations stay on Apps Script; nothing here changes `submitLiquidationRequest`,
     `advanceRequestStage`, `updateLineItemAmount`, `loginApprover`, or `saveMealAllowanceRecord`.
     - `common.js`'s `lookupEmployeeFromCsv_`/`loadEmployeesCsv_` replace the Biometric ID
       login's `getEmployeeByID` call — same error strings, same `Active` gate (mirrored as the
       CSV text `"TRUE"`, since a published sheet has no real boolean type).
     - `common.js`'s `loadJoinedRequests_` is a client-side port of `RequestService.gs`'s
       `buildRequestsWithLines_` (fetches+joins Requests+RequestLines, sorts newest-first) — used
       by `employee.js`'s My Requests tab (filtered by own `EmployeeID`) and `admin.js`'s
       Approver queue (filtered by status).
     - The Approver queue's Pending-only routing scope (an Approver should only see requests
       actually meant for them) is mirrored client-side too: `resolveEmployeeCategory_`/
       `isTechnicalDepartment_`/`isAuditDepartment_`/`STORE_DIR_COL_*` were **moved** from
       `employee.js` into `common.js` (so `admin.js` can reuse them — they used to live only in
       `employee.js` for the Utilities-tab-visibility mirror), and a new `resolveRequiredApprover_`
       in `common.js` ports `StoreDirectoryService.gs`'s function of the same name. This is a
       **known, accepted duplication of routing logic across the language boundary** (on top of
       the one that already existed) — safe under this app's existing philosophy because it's
       *display/filtering only*: `advanceRequestStage`/`updateLineItemAmount` independently
       re-verify routing server-side on every call regardless of what this shows, so a bug here
       could only ever make an Approver's queue show the wrong list, never let anyone
       illegitimately approve something the server would otherwise block. **Verified against
       live data** (not just syntax): the client-side routing simulation was run in Node against
       the real published CSVs and matched the live `getAllRequestsForPayroll` results exactly
       for multiple real accounts (Jayriel/783, Cris/33) before this was considered done.
     - `admin.js`'s Export CSV / Print Preview (`fetchExportableRequests_`) also switched from
       two `getAllRequestsForPayroll` calls to the same `loadJoinedRequests_` + status filter —
       it's read-only and never Pending-routing-scoped, so no extra logic was needed there.
   - **Trade-off, explicitly accepted by the user**: a published-to-web CSV can lag a few
     minutes behind the live sheet (Google's own refresh interval), and — critically —
     `requestsCsvCache`/`requestLinesCsvCache`/`employeesCsvCache` are cached for the whole page
     session and only ever fetched once. Without something to bridge that gap, a request you
     just approved/rejected/amount-edited, or just submitted, would appear stuck/missing until a
     full page reload. Fixed with **optimistic client-side cache patching**, applied right after
     each mutation's success response (the server already confirmed the change; no need to wait
     for the CSV to catch up to reflect it locally):
     - `common.js`'s `patchCachedRequestStage_(requestId, targetStage, actorName)` — called from
       `admin.js`'s Approve/Reject success handler. Mirrors `RequestService.gs`'s
       `STAGE_FIELD_NAMES` (as `STAGE_FIELD_NAMES_CLIENT`) to patch the right `*By`/`*Date`
       column pair alongside `Status`. `Remarks`/`CreditingDate` are deliberately left stale
       until a genuine cache refresh (full page reload) — a minor, temporary cosmetic gap, not
       the "doesn't disappear from the list" bug this was fixing.
     - `common.js`'s `patchCachedLineAmount_(requestId, lineId, newAmount)` — called from
       `admin.js`'s Save Amount success handler; patches the line's `Amount` and recomputes
       `TotalAmount` by re-summing all of that request's lines (matching the server's own
       from-scratch re-sum, not a delta).
     - `common.js`'s `patchCachedNewRequest_(requestId, employeeId, employeeName, lines)` —
       called from `employee.js`'s `handleSubmitRequest` success handler, right before switching
       to the My Requests tab. Inserts a synthetic Pending row + line rows built from the exact
       `lines` payload just submitted. First calls `loadJoinedRequests_()` itself (cheap/
       idempotent, thanks to its own caching) to guarantee the cache is actually populated before
       appending — appending onto a still-`null` cache would otherwise silently strand the
       employee's *other*, already-real requests once the genuine fetch eventually happened.
       `ReceiptFileURL` is left blank for a freshly-uploaded photo (the real Drive URL isn't
       known client-side until the CSV catches up) — cosmetic only, not a functional block.
   - **All three patch functions were verified directly** (not just by inspection): simulated in
     Node against the real published CSVs, confirming a patched request's `Status` changes
     immediately, disappears from a `Pending`-filtered list immediately, and a synthetic new
     request appears alongside an employee's real existing ones without disturbing them.

</details>

## Security model (intentional, not an oversight)

The `/exec` URL is a fully open, unauthenticated-at-the-transport-level API once deployed with "Anyone" access — anyone with the URL can call any of the `API_ACTIONS` directly (not just through the UI). `submitLiquidationRequest` has no application-level identity check at all beyond the Employee ID text match. `advanceRequestStage`, `updateLineItemAmount`, `grantSubmissionExemption`, and `revokeSubmissionExemption` are somewhat better: each requires a valid, active User ID + matching password from the `Approvers` sheet *and* that account's role matching what the action requires (`REQUIRED_ROLE_BY_STATUS`, or a hardcoded `ROLE_AUTHORIZER` check for the exemption actions) — so stolen/guessed credentials are required to act at all, and the audit trail's names are the server-resolved `FullName` rather than anything client-typed. But passwords are plain text in a Sheet, there's no rate-limiting/lockout on wrong guesses, and there's no session expiry — this is "harder to spoof by accident," not real authentication. This is a deliberate, incremental trade-off (see README), not something to silently "fix" further by adding real auth/hashing — if requirements change, that needs an explicit design conversation first.
