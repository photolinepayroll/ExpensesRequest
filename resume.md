# Resume Notes — Expense Liquidation Request System

## Status: functional, deployed, verified end-to-end

## What this is
An internal Payroll tool: employees submit expense liquidation requests (Fare, Meal Allowance, Accommodation) with receipts, tied to an Employee ID; Payroll reviews and approves/rejects. Full requirements and design rationale are in the plan this was built from — see **Context** section of the original plan, and `README.md` for the current architecture.

## Current architecture (pivoted mid-project — see below)
- **Backend**: Google Apps Script, deployed as a Web App, acting as a **pure JSON API** (no HTML serving). Entry point `Code.gs` → `doGet`/`doPost` → `API_ACTIONS` dispatch table → `RequestService.gs`/`EmployeeService.gs`. Data lives in a Google Sheet (`Employees`, `Requests`, `RequestLines` tabs) and receipts in Google Drive.
- **Frontend**: fully static site in `frontend/` (`index.html`, `styles.css`, `common.js`, `employee.js`, `admin.js`, `config.js`). No build step. Talks to the backend via `fetch()` — GET for reads, POST (`text/plain` body) for mutations, both deliberately avoiding CORS preflight since Apps Script can't answer `OPTIONS`.
- These are two **independently deployed** things now. The frontend is meant to be pushed to GitHub Pages (or opened locally) separately from the Apps Script backend.

## Key deployed identifiers (live, already configured)
- Spreadsheet ID: `1HnVD67MnD1pqIRxF2Jn9rFAGiFOcQ4WcPi9MStBIRlk` ("Liquidation Expenses" sheet)
- Drive root folder ID: `1LVoWqXcAmplZmLtoLuXTLCBAT3ImPXm2` ("Liquidation Expenses" folder)
- Apps Script deployment (`/exec`) URL — same one baked into `frontend/config.js`'s `APPS_SCRIPT_URL`:
  `https://script.google.com/macros/s/AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg/exec`
- Deployment ID for that URL (needed for `clasp deploy -i <id>`): `AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg`
- clasp is logged in on this machine as `photoline.payroll20@gmail.com`, linked via local `.clasp.json` to script ID `1kg5zrrCEqvGC1jyi8DPwoUIqyhmZOn_WjQR3BljsnEDI2MxVChLdE-c2`.

## Important operational gotcha (already hit once, now documented in README/CLAUDE.md)
`clasp push` uploads code but does **not** update the live `/exec` URL — that URL is pinned to a specific saved deployment version. After any backend change: `clasp push -f` **then** `clasp deploy -i AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg`. `npm run deploy` currently only does the push half — the deploy step is still manual.

## History / how we got here (context for why some things look the way they do)
1. Built as a single Apps Script project serving HTML via `HtmlService` (frontend inlined into `Index.html`/`CSS.html`/`JS_*.html`, built from `frontend/` source via a `build.js` script).
2. User asked for a real design pass — applied a navy/trust color palette + Lexend/Source Sans 3 typography via the `ui-ux-pro-max` skill, plus accessibility fixes (label associations, `role="alert"`, focus states).
3. User then asked for the frontend to be genuinely standalone HTML so it could be deployed to GitHub Pages independent of Apps Script. This was a real architecture change, not just a file reorg:
   - `Code.gs` rewritten as a JSON-only API (`doGet`/`doPost`/`API_ACTIONS`).
   - `frontend/common.js`'s `runServer()` rewritten from `google.script.run` to `fetch()`.
   - `build.js` and the generated `Index.html`/`CSS.html`/`JS_*.html` were deleted — no longer needed.
   - Verified live with `curl`: confirmed `Access-Control-Allow-Origin: *` and a real Sheet-backed response.
   - Discovered along the way that the existing deployment was pinned to an old version snapshot (see gotcha above) and had to explicitly `clasp deploy -i` to publish the new API code to the existing URL.

4. User then asked for a separate `admin.html` reflecting a real 3-stage approval chain — Reviewed/Approved/Authorized to Disburse. Built: `Config.gs`'s `STAGE_ORDER`, `RequestService.gs`'s `advanceRequestStage` (replacing the old single-step `updateRequestStatus`), `Validation.gs`'s `validateStageTransition_`, `Setup.gs` migrated to add per-stage `*By`/`*Date` columns, `frontend/admin.html` as a genuinely separate page, `admin.js`'s one-action-per-stage UI.
5. User then corrected two things about that just-built workflow:
   - **Stage order was backwards** — real order is **Approved → Reviewed → Authorized to Disburse**, not Reviewed → Approved. Fixed in `Config.gs`'s `STAGE_ORDER`, `Setup.gs`'s column order, `RequestService.gs`'s `STAGE_FIELD_NAMES`, `admin.js`'s `NEXT_ACTION_BY_STATUS`, `common.js`'s `AUDIT_TRAIL_STAGES`.
   - **Free-text actor names weren't good enough** — added real per-role PIN login. New `Approvers` sheet (`Name, Role, PIN, Active`); new `ApproverService.gs` (`getApproverByPin_`, `loginApprover`); `advanceRequestStage`'s signature changed from `(requestId, targetStage, actorName, remark)` to `(requestId, targetStage, pin, remark)` — the server now resolves the actor's name from the PIN itself (never trusts a client-supplied name) and additionally checks the PIN's role matches `REQUIRED_ROLE_BY_STATUS[currentStatus]` before allowing the action. `admin.html` gained a PIN-entry gate (`admin.js`'s `showAdminView`/`currentApprover`) shown once per page load; the PIN is kept in memory and resent with every action so the server can re-verify it every time (not just at login).
   - Verified the whole POST pipeline still works after this change (`curl` testing note: Apps Script POST responses are a `302` to a `googleusercontent.com` content URL computed *before* the redirect — `doPost` already ran, so the redirect target only needs GET; forcing `curl -X POST` together with `-L` breaks this, but real browsers/`fetch()` handle it fine).
6. User then asked to replace PIN login with **User ID + password**, and for `admin.html`'s "Approved by" to show the person's real full name (it had been showing a login-handle-looking string like "jayriel.photo" because the PIN scheme's `Name` column was, in practice, being filled with a login handle, not a real name). Also renamed the "Payroll" nav label/page copy to **"Approvers"** (their pick from a set of suggested names) since the three roles aren't necessarily Payroll department staff.
   - `Approvers` sheet schema changed again: `Name, Role, PIN, Active` → `UserID, Password, FullName, Role, Active`.
   - `ApproverService.gs`: `getApproverByPin_` → `getApproverByCredentials_(userId, password)`; `loginApprover(pin)` → `loginApprover(userId, password)`.
   - `RequestService.gs`'s `advanceRequestStage` signature: `(requestId, targetStage, pin, remark)` → `(requestId, targetStage, userId, password, remark)` — writes `approverResult.fullName` (not the old PIN-resolved `name`) to the audit trail.
   - `admin.js`/`admin.html`: PIN field replaced with separate User ID + password fields; `currentApprover` is now `{fullName, role, userId, password}`; every action resends both credentials (same "log in once, server re-verifies every call" pattern as before).
   - Verified live via `curl` that the new `loginApprover(userId, password)` signature round-trips correctly against the deployed backend.
   - **Plain text password storage** was again the explicit, confirmed choice (same trade-off as the PIN before it) — user picked it over SHA-256 hashing when asked, for simplicity of Sheet-based account management.
   - **Confirmed working end-to-end**: user re-ran `setupSheets()` and populated the `Approvers` sheet themselves — a full Approve → Review → Authorize cycle with 3 different real people (Jayriel Guardacasa, Mae Jean Manalo, Gilbert Alontaga) showed correct full names in the audit trail, not User IDs.
7. User then asked to rename the terminal "Authorized" stage to **"Disburse"/"Disbursed"** in the UI, and to auto-compute a **crediting date** — the Friday of the current week (rolling forward to next Friday if authorized on a Sat/Sun). Confirmed via clarifying questions: label-only rename (no new backend stage/status value), roll-forward on weekend, and show the date both as a new table column and in the audit trail line.
   - Backend: `Setup.gs` adds a `CreditingDate` column to `Requests`. `RequestService.gs` adds `computeNextCreditingFriday_()` (Monday-indexed week math, Friday = index 4, roll forward by adding 7 if already past) and stamps it only when `targetStage === STATUS_AUTHORIZED`. Also added `STAGE_DISPLAY_LABEL` so the `Remarks` log line reads "Disbursed by X" instead of "Authorized by X" — the internal `STATUS_AUTHORIZED`/`STAGE_ORDER` value is still literally `'Authorized'`, unchanged, only display text changed.
   - Frontend: `common.js` gets a parallel `STATUS_DISPLAY_LABELS` map (`Authorized` → `'Disbursed'`) used by `statusBadge()`; `renderRequestsTable()` gained a "Crediting Date" column (shared by both `index.html`'s My Requests and `admin.html`'s queue); `buildAuditTrailHtml_`'s `AUDIT_TRAIL_STAGES` entry for that stage now reads "Disbursed" and appends "— crediting on [date]" when present. `admin.html`'s filter dropdown option text changed (value stays `"Authorized"`, display text now "Disbursed").
   - Verified live via `curl` that the existing already-authorized test request correctly has no `CreditingDate` (it predates this feature) — new authorizations going forward will get one.

8. User then asked for several smaller fixes/polish items in one session:
   - **Terminology rename**: "Employee ID" → **"Biometric ID no."** in the employee-facing ID-entry screen — `frontend/index.html` (heading/label/placeholder) and `frontend/employee.js` (the "Please enter your..." validation message), plus the three backend error strings in `EmployeeService.gs`'s `getEmployeeByID` (required/not-found/inactive). The underlying `EmployeeID` field/column name is unchanged — this was a display-text-only rename, same pattern as the earlier "Authorized"→"Disbursed" display rename.
   - **CSS bugfix**: `admin.html`'s login Password field was rendering at native browser size (narrow, short) instead of matching the User ID field, because `styles.css`'s shared input-styling selector list was missing `input[type="password"]` entirely. Fixed by adding it alongside `input[type="text"]` etc.
   - **Mobile responsive pass**: both pages had almost no responsive behavior beyond the line-item grid and header. Added a `max-width: 640px` breakpoint in `styles.css` that turns `table.data-table` (the shared list/detail tables from `common.js`'s `renderRequestsTable`/`buildLineItemsHtml_`) into stacked label:value cards instead of forcing horizontal scroll — this also fixed a nested-table double-scroll problem in the expandable detail rows. `common.js` cell markup gained `data-label` attributes to drive the card labels. `.btn-small`/`.btn-icon-only` (Approve/Reject, line-item remove) bumped from 36px to 44px minimum on all viewports (touch-target guideline). `.identity-card` and `.admin-actions` gained dedicated small-screen stacking rules instead of relying on generic flex-wrap. Desktop appearance (≥640px) is unchanged.
   - **New business rule**: expense line-item dates must be within the last 1 month and cannot be in the future. Enforced authoritatively server-side in `Validation.gs`'s `validateSubmission_` (rejects with a per-line error), and mirrored client-side via `min`/`max` attributes set on each date input in `employee.js`'s `addLineItemRow` (so the native date picker also blocks out-of-range dates).
   - All of the above backend changes (`EmployeeService.gs`, `Validation.gs`) were pushed and deployed live via `clasp push -f` + `clasp deploy -i`.

9. User then asked for a **Meal Allowance Utility** under a new "Employee Utilities" tab — a self-serve calculator for a duty-based meal/midnight allowance, computed from an external biometric attendance log (a separately published Google Sheet, not part of this app's own data), independent of the existing liquidation-request pipeline. Built entirely additively (no existing function's behavior changed):
   - New third tab "Utilities" in `index.html`'s employee tab bar; `employee.js`'s `setEmployeeTab` was generalized from a 2-way to a 3-way tab switch (same behavior preserved for the two existing tabs) to support it.
   - New `frontend/meal-allowance.js` (loaded only by `index.html`): fetches and parses the published attendance CSV (`ATTENDANCE_CSV_URL` in `config.js`) client-side with a small quoted-CSV parser (the source data has embedded commas in Name/Address fields), searches employees via a new backend action, lets the user pick which Start IN / End OUT pair from that day's records to use, computes duty hours + Regular Meal Allowance (flat ₱100 for 5+ hours) + Midnight Allowance (tiered ₱50/₱100/₱150 by the End OUT clock-out time — see the code comment on `maComputeMidnightAllowance_` for the exact boundaries and the ambiguity in how they were originally specified), and saves the confirmed record.
   - New backend file `MealAllowanceService.gs`: `searchEmployeesForUtility(query)` (employee search by ID or name, reusing `SheetService.gs`'s existing helpers) and `saveMealAllowanceRecord(payload)` (validates and appends to a new `MealAllowances` sheet tab — a standalone payroll reference log, **not** wired into the `Requests`/`RequestLines` approval pipeline, and unrelated to the existing "Meal Allowance" *expense category* despite the shared name).
   - Minimal necessary wiring additions to existing files: `Config.gs` (`SHEET_MEAL_ALLOWANCES` constant), `Setup.gs` (one new `createOrMigrateSheet_` call), `IdGenerator.gs` (`generateMealAllowanceId_()`), `Code.gs` (two new `API_ACTIONS` entries), `frontend/common.js`'s `READ_ONLY_ACTIONS` array (one new entry), `frontend/config.js` (`ATTENDANCE_CSV_URL`), and `.claspignore` (had to whitelist the new `MealAllowanceService.gs` by name, same as every other backend file — it uses an explicit per-file allowlist, not a wildcard).
   - Confirmed via `curl` that the published-CSV redirect chain sends permissive CORS headers, so the frontend fetches it directly with no backend proxy needed.
   - Pushed and deployed live. **`setupSheets()` still needs to be re-run once** from the Apps Script editor to actually create the `MealAllowances` tab before `saveMealAllowanceRecord` will work (it currently fails with "Sheet not found" until that's done).

10. User then evolved the Meal Allowance utility further, plus made a UI pass on New Request and the header:
   - **"Add to New Request" hand-off**: after saving a Meal Allowance record, a button now switches to New Request and auto-fills a pre-filled line item (Date, Amount, Description) via `meal-allowance.js`'s `maHandleAddToNewRequest_`, reusing `employee.js`'s existing `addLineItemRow()`/`updateRunningTotal()` rather than duplicating line-item logic.
   - **Auto-attached photo proof, category locked**: the End OUT attendance scan's `Photo Link` (a column already present in the source CSV, previously unused) is now carried through the whole flow and becomes that line item's receipt automatically — `maLockRowAsMealAllowance_` injects a locked `Meal Allowance` option into that specific row's category `<select>` (disabled so it can't be changed) and replaces the file-upload field with a read-only "View attendance photo" link, storing the URL on `row.dataset.receiptUrl`. If the End OUT record has no photo, "Add to New Request" is blocked with a warning (the record is still saved to the `MealAllowances` log either way). Since Meal Allowance lines now always originate from the utility, **"Meal Allowance" was removed from the manual Category dropdown** in `index.html`'s line-item template — manual entry is Fare/Accommodation only; `Config.gs`'s `CATEGORIES` backend list is unchanged (still accepts `'Meal Allowance'` from this auto-fill path). `RequestService.gs`'s `submitLiquidationRequest` gained a `line.receiptUrl` branch — if present, it's stored directly as `ReceiptFileURL` with no Drive upload. `MealAllowanceService.gs`/`Setup.gs` also log the photo link (`PhotoLink` column) on each saved record for reference.
   - **Search locked to self**: the utility's employee search (by ID or name, look up *any* employee) was removed entirely — it now always auto-syncs to whoever is currently logged in (`maSyncSelectedEmployee_` mirrors `common.js`'s `currentEmployee`), so an employee can only ever compute their own attendance-based allowance, never someone else's. The `searchEmployeesForUtility` backend action still exists (harmless, unused by the current UI) but nothing in the frontend calls it anymore.
   - **New Request UX simplification**: the form no longer auto-adds an empty "Line 1" on login — it starts completely empty with just the "+ Add Line Item" button (`resetLineItems()` no longer calls `addLineItemRow()`). The "Line N" numbered badge was removed from every line-item card entirely (`renumberLineItems()` deleted). The remove (trash) button can now clear a line item down to zero, since starting empty is now the normal state.
   - **Header logo**: replaced the generic SVG brand icon with the actual Photoline logo image (`frontend/logo.png`) in both `index.html` and `admin.html`, floating with no border/card background, sized ~72px tall (went through a few size iterations — extra-large was tried and dialed back for balance). User plans to crop the source image tighter themselves for a cleaner fill later.
   - Backend changes (`RequestService.gs`, `MealAllowanceService.gs`, `Setup.gs`) pushed and deployed live. **`setupSheets()` needs to be re-run again** to pick up the new `PhotoLink` column on `MealAllowances`.

11. User then asked for the Meal Allowance utility's "Regular Meal Allowance" to stop being a flat ₱100 and instead automate from GPS against a new published reference sheet of stores (coordinates, regional bracket amount, and per-store assigned Tech/Area Head personal override amounts), plus removed the auto-computed Midnight Allowance tiers entirely (the code itself flagged its 3rd tier as too broad) in favor of a plain manual amount field. This went through several real-data-driven corrections in one session:
    - **v1** (`maResolveDutyLocation_`): matched both Start IN and End OUT GPS to the nearest reference store within 500m — required both to agree.
    - **v2**: a real case (SM Baliwag) showed the *reference* coordinate itself was rounded/imprecise (~1,084m off from real GPS) even though it was genuinely the right store — widened to 1.5km with Destination-text corroboration required beyond 500m.
    - **v3**: a second real case (C. Center) showed real attendance GPS itself can drift several km (Start IN 2,391m off, End OUT 4,564m off) even for a confirmed-correct, confirmed-assigned employee — the user clarified Start IN is often logged from a different location (employee starts their day elsewhere) so location should resolve from **End OUT only**, and that name-matching should be **primary**, with distance only breaking ties between same-scoring name matches or serving as a last-resort tight (500m) fallback when there's no name match at all (`maFindStoreMatchesByName_` + token-overlap scoring, stopword-filtered).
    - **v4 (final)**: the user then pointed out staff are sometimes sent to places outside the listed stores entirely (confirmed via a real "Tandang Sora" case — not in the reference sheet at all) — since the peso bracket only depends on the broad region, not the exact store, `maResolveDutyLocation_` was simplified to just use the nearest reference row unconditionally (no name-matching, no cutoff) as a stand-in for "which region is this". Name-matching code (`maFindStoreMatchesByName_`/`maNormalizeNameTokens_`/`maStoreNameTokens_`) was deleted as dead weight. The per-employee Tech/Area Head **personal override** is still gated by proximity (`MA_ASSIGNED_OVERRIDE_RADIUS_METERS`, 1.5km) but was corrected to scan the *entire* store table for the employee's own assigned row (by Biometric ID) rather than only checking whichever store happened to be globally nearest — an unrelated closer store could otherwise hide a legitimate nearby assigned-store match.
    - Also added to the New Request hand-off (`maHandleAddToNewRequest_`/`maLockRowAsMealAllowance_`): Base Location now auto-fills as `"<City> — <Area/Region>"` and locks (read-only) when the duty location resolved; Description now shows the actual point-to-point duty (`"<Start destination> → <End destination> (<hrs>)"` instead of a generic date string); Amount is now locked (read-only) unconditionally; and the Date field is now also locked (previously only Category/Receipt were).
    - Backend (`MealAllowanceService.gs`/`Setup.gs`): `saveMealAllowanceRecord` and the `MealAllowances` sheet gained `MatchedStore, City, Town, AreaRegion, AllowanceSource` columns for the payroll log's audit trail. `setupSheets()` needed re-running for these.
    - All changes verified by simulating the matching logic in Node against the real downloaded CSV data (not just live UI testing) — this repeatedly caught cases the initial design missed before the user even had to report them live.

12. User then described the real approval structure, which is a **category-based routing model**, not the flat single-Approver-account behavior that existed before: (1) an employee who is themself an **Area Head** → approved by **Jayriel Guardacasa**; (2) a **Technical** staff member → approved by **Cris Taglucop**; (3) an **Audit** staff member → approved by **Lanilyn Balane**; (4) a plain **store employee** (none of the above) → approved by *their own store's* assigned Area Head. Also asked for a "Mother Branch" field on New Request (which store an employee belongs to) and confirmed Meal Allowance utility access should be restricted to Area Head/Technical/Audit only (plain store staff get Fare/Accommodation only, no meal allowance at all). Built from a second new published reference sheet (a store directory with duplicate/blank headers, read by fixed column index, not header name) — see `CLAUDE.md`'s Architecture section for the exact column layout and file list. Key points not obvious from the code alone:
    - The fixed columns naming Jayriel/Cris/Lanilyn (with their Biometric IDs) are read live from the directory sheet each time, not hardcoded — if the org reassigns who holds these 3 roles, updating the published sheet is enough, no code/deploy needed.
    - This only changes the **Pending → Approved** stage's authorization. Reviewer/Authorizer (Mae Jean/Gilbert) are completely unaffected — still the same unscoped role check as before.
    - **Fallback is deliberately permissive**: if an employee's category/store can't be resolved (directory unreachable, or a Staff employee's `BaseLocation` doesn't match any listed store), `advanceRequestStage` falls back to "any active Approver-role account can approve" rather than blocking the request — same philosophy as the Meal Allowance GPS fallback above.
    - New `Approvers` sheet column `BiometricID` lets the backend compare "who's actually logging in" against "who the directory says is required" — **Cris Taglucop and Lanilyn Balane currently have no login accounts at all** (they only exist as fixed reference values in the directory, not in the roster) and need brand new `Approvers` rows created; Jayriel's existing row needs `BiometricID = 783` added. Per-store Area Heads need the same treatment one row per person for the Staff-routing case to actually take effect for their store — until then it safely falls back to "any Approver".
    - **Debugging note**: first live test threw `ReferenceError: getStoreDirectoryRows_ is not defined` — `StoreDirectoryService.gs` hadn't been pushed yet (`clasp push -f` needed after any new backend file, on top of being whitelisted in `.claspignore`). Second issue after pushing: the fetch silently returned null — turned out to be Apps Script's one-time authorization prompt for the *first-ever* `UrlFetchApp` call in this project (this codebase had never made a server-side external HTTP call before this feature); granting it on re-run fixed it.
    - Also added `Setup.gs`'s `applyBaseLocationDropdown_()` (called automatically at the end of `setupSheets()`): turns `Employees.BaseLocation` into a real dropdown of exact store names sourced from the same directory sheet, since a free-text mismatch there (e.g. "SM Baliwag" vs "Baliwag") is exactly what silently breaks both the Mother Branch display and the Staff-routing lookup — caught live via a real employee (Sabater, BIO 51814) whose blank `BaseLocation` meant no Mother Branch showed and no store-scoped approver could be resolved for him.

13. Same session, continued refining the category-based routing feature with several more real-data-driven fixes:
    - Added a 5th category, **HeadOffice** (an employee's Biometric ID listed under the directory's column 30, `REGULAR (HO)`), routing to a shared fixed **"ADMIN"** approver (BIO `9999`, columns 28/29) — also grants Meal Allowance utility access alongside Area Head/Technical/Audit.
    - **Department-based Technical/Audit detection**: `isTechnicalDepartment_`/`isAuditDepartment_` (loose match on `Employees.Department`, e.g. "TEC"/"Technical", "Aud"/"Auditing") as a fallback when an employee isn't the *one specific* person the directory lists as a store's assigned Tech/Auditor — many employees can carry that department code without being that unique per-store assignee. Mirrored in both `StoreDirectoryService.gs` and `employee.js`.
    - Base Location's native `<datalist>` suggestion (added earlier this session) rendered inconsistently/ugly across browsers — replaced with a hand-rolled suggestion dropdown (`employee.js`'s `wireLocationAutocomplete_`, styled `.li-location-suggestions` list in `styles.css`) that filters the same store list as-you-type instead.
    - Meal Allowance's New Request hand-off: Base Location was locked read-only when GPS resolved a store — **un-locked it**, since the auto-filled store name is only a stand-in for the *region*, not necessarily the literal establishment (real duty sometimes happens somewhere not in the store list at all). Date/Amount/Category/Receipt stay locked.
    - **Approver queue scoping**: `admin.html`'s Pending list showed every Pending request to every logged-in Approver regardless of category — confusing even though the write-side (`advanceRequestStage`) was already correctly scoped. `getAllRequestsForPayroll(statusFilter, approverBiometricId)` now filters Pending rows to only the ones that specific approver is actually meant to act on (Reviewer/Authorizer queues stay unscoped/unaffected); `admin.js` only sends `biometricId` for Approver-role logins.
    - **Staff routing now prefers the request's own line-item location over the employee's static `Employees.BaseLocation`** — confirmed via a real case (an employee whose line item said "SM Cebu" was showing in an unrelated Area Head's queue because her `BaseLocation` field pointed elsewhere/was stale). `resolveRequiredApprover_` gained a `requestLineLocation` param, tried first, falling back to `BaseLocation` only if the line location is blank/unmatched. Both `advanceRequestStage` (new `getFirstLineBaseLocation_`) and `getAllRequestsForPayroll` (batched — one pass over `RequestLines`, not per-row) pass this through.
    - **Critical data-integrity bug found in the directory sheet itself, not the code**: the "obvious" Area Head columns (11/12) turned out to be off-by-one-row misaligned with the `STORES` column for 115 of 118 stores (caught by cross-referencing a user screenshot against a fresh CSV pull — e.g. Arca South's column-11 value actually belonged to Ayala Bacolod), and blank outright for 101 of them. The reliably-aligned pair turned out to be columns 24/25 (`BIO ID`/`APPROVERS`, immediately followed by `STORES` at 26). Switched `STORE_DIR_COL_AREHEAD_BIO`/`_NAME` to 24/25 in both `StoreDirectoryService.gs` and `employee.js`, with a loud code comment warning future readers not to "fix" it back to the obvious-looking 11/12. This was the actual root cause of a real Area Head (Ochin Ibay, SM Cebu) never receiving her queue items — not a bug in the routing logic itself.
    - Also hit (and worked around) a `clasp push`/`deploy` crash — the CLI itself ran out of memory (`FATAL ERROR: ... JavaScript heap out of memory`), unrelated to any code change. Retrying with `NODE_OPTIONS="--max-old-space-size=4096" clasp push -f` (and the same for `deploy`) fixed it — worth trying first if this recurs, before assuming a code/config problem.

14. User then reported that refreshing/reloading either page logged them out (no session persistence existed anywhere in the frontend — `currentEmployee`/`currentApprover` were plain in-memory JS vars, and both pages' bootstrap scripts unconditionally forced the login view on every load). Added `sessionStorage`-based persistence (survives refresh, clears on tab/browser close — the user explicitly chose this over `localStorage`'s longer-lived "remember me"):
    - `common.js` gained `SESSION_KEY_EMPLOYEE`/`SESSION_KEY_APPROVER` constants.
    - `employee.js`: login flow refactored through a new `completeEmployeeLogin_(employee)` (also saves to `sessionStorage`), plus `restoreEmployeeSession_()` called from `index.html`'s bootstrap before falling back to the login view; logout clears the stored session.
    - `admin.js`: same pattern via `restoreApproverSession_()`/`initAdminView()`, **but the password is deliberately never persisted** (the user's explicit choice, to avoid storing a plaintext credential in browser storage) — only `{fullName, role, userId, biometricId}` is saved. Approve/Reject actions already re-prompt for the password via `window.prompt` whenever `currentApprover.password` is missing (a pre-existing pattern from the PIN/password redesign) — this now also covers the "just restored from a refresh" case for free, no new UI needed.

15. Same session, user then asked for two related feature adds, planned via a written spec/plan (`docs/superpowers/specs/2026-09-12-request-validation-and-receipt-preview-design.md`, `docs/superpowers/plans/2026-09-12-request-validation-and-receipt-preview.md`) and built with subagent-driven-development (fresh implementer + spec-compliance review + code-quality review per task):
    - **Required-field highlighting**: `employee.js`'s `handleSubmitRequest` now runs `validateRequiredLineFields_()` on Submit click (not real-time) — any line item missing Date/Category/Location/Amount/Description gets a red `.input-error` highlight (new CSS in `styles.css`) and focus jumps to the first invalid field; clears as each field is edited. Receipt was *initially* left optional in this pass (matching the user's choice at the time) — see item 16 below where that was reversed.
    - **Receipt/line-item preview modal**: clicking any line item row (both `index.html`'s My Requests, view-only, and `admin.html`'s queue) opens a shared full-screen modal (`common.js`'s `ensureReceiptModal_`/`openLineItemPreview_`, injected into the DOM once and reused) showing the receipt image plus Date/Category/Location/Description/Amount. On `admin.html`, Amount becomes editable — with its own "Save Amount" button, separate from Approve/Reject — only when it's currently that logged-in Approver/Reviewer/Authorizer's own turn to act on the request (`admin.js`'s `isLineEditableForCurrentApprover_`, reusing the existing `REQUIRED_ROLE_BY_STATUS` map). Saving calls a new backend action, `updateLineItemAmount(requestId, lineId, newAmount, userId, password, remark)` (`RequestService.gs`, registered in `Code.gs`'s `API_ACTIONS`), which deliberately mirrors every guard `advanceRequestStage` already has — role check, the same Pending-stage category/store routing re-check via `resolveRequiredApprover_`, `LockService` locking — rather than inventing a separate authorization path; it also recomputes the request's `TotalAmount` from a full re-sum of that request's lines (not a delta) and appends an audit-trail line to `Remarks` (e.g. "Amount edited by X: 100.00 → 150.00 (Fare line)"). `admin.js`'s existing password-reprompt-if-missing logic was extracted into a shared `ensureApproverPassword_()` reused by both Approve/Reject and Save Amount.
    - Old raw `<a href target=_blank>` receipt links (`common.js`'s `buildLineItemsHtml_`) were replaced — the whole line-item row is now the click target (`class="line-detail-row" data-line-id="..."`), opening the modal instead of navigating away.
    - All 6 code tasks individually passed spec-compliance + code-quality review; a final holistic cross-file review afterward found no blocking issues. Backend pushed and deployed (`clasp push -f` + `clasp deploy -i`), live-smoke-tested via `curl` against the deployed `/exec` URL.

16. Still the same session, several follow-up refinements to the receipt preview modal, driven by real usage:
    - **Zoom/pan + bigger desktop modal**: `common.js` gained `wireImageZoomPan_(img, pane)` — mouse-wheel zoom (clamped 1×–4×, center-anchored not cursor-anchored, simpler/robust), drag-to-pan once zoomed (clamped so the image can't be dragged fully out of view, using `img.offsetWidth/offsetHeight` since CSS `transform` doesn't affect layout), two-finger pinch-to-zoom and one-finger pan via the Pointer Events API (covers mouse+touch in one code path), and double-click to reset. All zoom/pan state lives in closure variables re-created fresh on every modal open (the `<img>` element itself is rebuilt each time), so no explicit reset-on-close was needed. `styles.css`'s `.receipt-modal` grows to ~100vw × 100vh (true edge-to-edge, no rounded corners/backdrop padding) at a `min-width: 900px` desktop breakpoint — the user's explicit ask after an initial 95vw/95vh version wasn't "full screen" enough.
    - **Bug found and fixed: the receipt image never actually rendered** — `DriveService.gs`'s `uploadReceiptFile_` stores `driveFile.getUrl()`, which is a Drive *viewer HTML page* URL (`.../file/d/<ID>/view?...`), not raw image bytes, so it could never load in an `<img src>` and always silently fell through to the "Preview not available" fallback. Fixed purely client-side (no backend/schema change, so it retroactively fixes every already-submitted receipt too): `common.js`'s new `driveThumbnailUrl_(url)` regex-extracts the Drive file ID and rewrites it to `https://drive.google.com/thumbnail?id=<ID>&sz=w2000` (a real image-serving endpoint — conveniently also generates a page-1 preview image for PDF receipts) for the `<img src>` only; "Open receipt in new tab" still uses the original URL.
    - **Bug found and fixed: drag-to-pan didn't work** — `<img>` elements have native browser drag-and-drop ("ghost image" drag) that hijacks the mouse-drag gesture before custom `pointermove` panning code ever sees it. Fixed with `draggable="false"` on the `<img>` plus `-webkit-user-drag: none; user-select: none;` in CSS.
    - **Download button added**: a small icon button (top-left of the modal, mirroring the close button's top-right position) links to `driveDownloadUrl_(url)` (`https://drive.google.com/uc?export=download&id=<ID>`, same regex-extraction pattern as the thumbnail helper) — lets the viewer grab the original full-resolution file from Drive, since the on-screen thumbnail is intentionally a downscaled/compressed preview for fast loading.

17. Finally, user reversed the earlier "Receipt stays optional" choice from item 15 and added a compression requirement:
    - **Receipt is now required, photo-only**: `index.html`'s file input label changed to "Receipt (Photo, required, max 5MB)", `accept` narrowed from `"image/*,application/pdf"` to `"image/*"`. `employee.js`'s `validateRequiredLineFields_` gained a file check per row — valid if `row.dataset.receiptUrl` is already set (the Meal Allowance hand-off's auto-attached photo — its file input is replaced entirely, see `maLockRowAsMealAllowance_` in `meal-allowance.js`) or the `.li-file` input has a selected file; missing gets the same `.input-error` highlight as the other required fields. `Validation.gs`'s `validateSubmission_` (the authoritative server-side check) gained the matching requirement — a line is now invalid unless `line.receiptUrl` or `line.file` is present. `Config.gs`'s `ALLOWED_MIME_TYPES` dropped `'application/pdf'`.
    - **Client-side compression toward ~1MB before upload**: since Apps Script has no image re-encode API, this has to happen in the browser before the base64 payload is ever sent. New `employee.js` function `compressImageForUpload_(file)`: skips files already ≤1MB, otherwise draws to an off-screen `<canvas>` (capping the longer dimension at 2500px — generous, rarely the limiting factor), re-encodes as JPEG via `canvas.toBlob`, stepping quality down from 0.9 in 0.1 increments until ≤1MB or a 0.5 quality floor (stops there even if still slightly over, rather than degrading legibility further — this was the user's explicit requirement: "malinaw pa rin ang resolution basta visible ang text/numbers"). Wired into `collectLineItems()` ahead of the existing `readFileAsBase64` call. `Config.gs`'s `MAX_RECEIPT_BYTES` (the server-side ceiling) dropped from 5MB to 2MB — headroom above the ~1MB target for that quality-floor edge case, while still much tighter than before.
    - Backend changes (`Config.gs`, `Validation.gs`) pushed and deployed; live-smoke-tested via `curl` (confirmed the deployment is live and `validateSubmission_` runs — a fake Employee ID test hit the employee-lookup guard first, as expected, since that check runs before the per-line receipt check).

19. User then asked for a **batch export** of processed requests, planned via the brainstorming skill's clarifying-questions flow (`docs/superpowers/specs/2026-09-12-batch-export-design.md`, `docs/superpowers/plans/2026-09-12-batch-export.md`) and built with subagent-driven-development (fresh implementer + spec-compliance review + code-quality review per task), with a mid-implementation design revision:
    - **v1 (jsPDF)**: Tasks 1-5 of the original plan built a CSV export (`admin.js`'s `csvField_`, `EXPORT_CSV_HEADERS`, `buildExportCsv_`, `downloadTextFile_`) plus a client-generated PDF via the jsPDF library (CDN-loaded), including a new backend action `getReceiptImageBase64` whose sole purpose was fetching a receipt's raw image bytes server-side so jsPDF's `addImage` could embed it without hitting a canvas-tainting error on the cross-origin Drive thumbnail URL.
    - **Revision (v2)**: after these were already implemented and reviewed, the user pointed to a sibling project (`photolinepayroll/attendance-app`'s `admin.html`) whose export feature uses a simpler, already-proven pattern — a browser print-preview window instead of a client-generated PDF file. Confirmed via clarifying questions and re-planned (`docs/superpowers/specs/2026-09-12-batch-export-design.md`'s "Revision note (v2)"). Reverted: the `getReceiptImageBase64` backend action, the jsPDF CDN `<script>` tag, and all jsPDF drawing code (summary-table row layout, `addReceiptPages_`'s sequential-fetch loop, y-position/pagination math). The CSV builder was kept exactly as built in v1 — unaffected by the revision.
    - **Final shipped behavior**: one "Export Reviewed/Disbursed" button in `admin.html`'s queue (visible to any logged-in approver role, no role gating, no date-range filter) triggers `admin.js`'s `handleExportClick_`, which calls `getAllRequestsForPayroll` for `'Reviewed'` and `'Authorized'`, merges the results, downloads the CSV, and opens a print-preview report (`buildExportReportHtml_`) via `window.open('', '_blank')` + `document.write()` — a summary table (Status column already showing "Disbursed" for `Authorized` via `STATUS_DISPLAY_LABELS`) followed by one full-page receipt `<img>` per line item using the existing `driveThumbnailUrl_()` on-screen-modal helper (no backend involvement — the browser fetches each thumbnail as a normal cross-origin image, exactly as the receipt preview modal already does), then a missing-receipts note for any line with no `ReceiptFileURL`. A code-review pass during implementation caught and fixed a Safari/Firefox popup-blocker timing bug (`window.open` must be called synchronously in the click handler, before the `getAllRequestsForPayroll` round-trip — a placeholder page is written immediately and swapped for the real report once data resolves) and a duplicate-helper cleanup.
    - **Verification performed** (final task, no real browser available in this environment): confirmed the deployed `/exec` URL (deployment `AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg`) is live at version `@29`; `node --check frontend/admin.js` passes; re-read `buildExportReportHtml_`/`handleExportClick_`/`csvField_`/`buildExportCsv_` end-to-end in the current file to confirm correct wiring; wrote and ran a fresh jsdom end-to-end test (loads `common.js`+`admin.js` into a real jsdom DOM, mocks `runServer` with deferred promises, clicks `#btn-export`) that confirmed `window.open` fires synchronously before the mocked data resolves (asserted via call-order tracking), a placeholder is written first and the real report second, the report HTML contains a receipt `<img>` for lines with a `ReceiptFileURL`, the missing-receipt note for a line without one, and the correct "Disbursed"/"Reviewed" labels — all checks passed. Also hit the live `/exec` URL directly with `curl` for both `getAllRequestsForPayroll('Reviewed')` (returned real joined request+line data) and `('Authorized')` (returned `[]` — no currently-disbursed requests, a valid empty result, not an error).
    - **Genuinely NOT verified — flagged for the user to check personally**: real-browser popup-blocker behavior (Safari/Firefox specifically), the actual print-preview visual appearance and pagination when printing/saving as PDF, and clicking the actual Export button in a real browser session end-to-end.

20. Same session, several more real-data-driven corrections and two new features, planned via
    plan mode with clarifying questions each time (no written spec docs this round — plans
    lived in Claude's plan-mode file, summarized here instead):
    - **Export UI split + print-report layout**: the single "Export Reviewed/Disbursed" button
      (item 19) was split into two independent buttons — "Export CSV" and "Print Preview" —
      each doing its own fetch (`admin.js`'s `fetchExportableRequests_`/`handleExportCsvClick_`/
      `handleExportReportClick_`). The print-preview report's receipt layout changed from one
      receipt per page to bucketed pages: Fare/Accommodation get 2-per-page (stacked, legible
      full-size), Meal Allowance gets 6-per-page in a 2x3 grid — explicit
      `@page { size: letter portrait; }` added since none existed before.
    - **Photo rotation added** to the shared receipt preview modal (`common.js`'s
      `wireImageZoomPan_` now returns `{rotateLeft, rotateRight}`, 90° increments, composes
      with existing zoom/pan via `transform: translate() scale() rotate()` — rotate is
      right-most/inner-most so it doesn't change what "horizontal"/"vertical" mean for pan).
    - **Real, confirmed data bug found and fixed**: `STORE_COORDINATES_CSV_URL`'s published
      sheet has duplicate column headers (`"BIO ID"` and `"REGULAR (AUDIT/TEC/STAFF)"` each
      appear twice — once for real per-store data, once for an unrelated "Technical Staff
      Roster" sub-table crammed into the same sheet). `common.js`'s old header-keyed
      `csvToObjects_` silently used the wrong (roster) column for every row, which was making
      the plain regional-bracket Regular Meal Allowance compute to ₱0 for ordinary Staff
      employees — confirmed live via a real report (Jan Marnelle Insigne, BIO 863, showing
      ₱0.00 at SM Aura instead of the correct ₱100 NCR bracket). Fixed with a new
      `parseStoreCoordinatesCsv_` in `common.js` that restores the two affected fields by
      fixed column index (2 and 3), used by both `meal-allowance.js` and a new Mother-Branch
      lookup in `employee.js`.
    - **Meal Allowance "own store" rule corrected**: previously any duty within 1.5km of ANY
      store where the employee was listed as assigned Tech/Area Head paid ₱0 (wrong — this
      was this session's own earlier, since-corrected fix). The sheet already encodes which
      *specific* assigned store is the employee's true home branch via the literal text
      `"MOTHER BRANCH"` in that row's amount cell (confirmed live: BIO 373/Cacho has a real
      ₱150 rate at Harbor Point, a store they cover, but `"MOTHER BRANCH"` text at SM Tarlac,
      their actual home) — `maResolveRegularAllowance_` now pays ₱0 only at the row literally
      marked that way, and the real override amount at any other assigned/covered store.
      `employee.js`'s identity-card "Mother Branch" display now also checks this same marker
      (via a new `resolveMotherBranchFromCoordinates_`) and prefers it over the separately-
      maintained `STORE_DIRECTORY_CSV_URL` sheet when the two disagree.
    - **Meal Allowance midnight-crossing duty support**: `#ma-duty-date` gained a "crosses
      midnight" checkbox that reveals a second date field, so a Start IN/End OUT pair spanning
      two calendar days can be found (`maHandleLoadAttendance_` previously hard-filtered to one
      date, silently excluding any End OUT record dated the next day). Midnight Allowance's
      manual input is now only shown when End OUT falls in the 6:00 PM–6:00 AM window
      (`maIsInEveningToMidnightWindow_`) instead of always being available regardless of time.
    - **GPS audit link added**: every saved Meal Allowance record now includes a Google Maps
      link built from the End OUT record's own coordinates (new `EndGpsMapLink` column,
      `MealAllowanceService.gs`/`Setup.gs`), and the same link travels into the actual
      liquidation request when handed off via "Add to New Request" (new `GpsMapLink` column on
      `RequestLines`, `RequestService.gs`/`Setup.gs`) — shown as a "View GPS Map Link" link next
      to "View attendance photo" on the New Request row, and as a "GPS Location: View Map" row
      in the shared receipt preview modal, so it's visible to the employee AND every approval
      role reviewing the request (not just buried in the internal payroll log). An earlier
      attempt appended the raw URL as text inside the Description field — corrected after the
      user flagged it as awkward/wrong; the link is now a proper field, not description text.
    - All backend changes in this item were pushed and deployed (`clasp push -f` +
      `clasp deploy -i`) and confirmed live; `setupSheets()` was re-run twice (once for
      `MealAllowances.EndGpsMapLink`, once for `RequestLines.GpsMapLink`) and confirmed by the
      user with a real saved entry showing a populated, clickable map link.
    - Work committed in two commits: `f8cbc17` (export split/layout/rotation + Meal Allowance
      data fixes + midnight-crossing support) and `3713bfc` (GPS link moved from Description
      text to a proper field).

**Two more changes were planned (via plan mode, full plan preserved at
`C:\Users\Gilbert\.claude\plans\update-plan-separate-the-lexical-riddle.md` on this machine)
and are mid-implementation when this session ended — see CLAUDE.md's "Planned work" section
for the exact done/not-done breakdown, summarized here:**
- **Zoom/pan edge-visibility fix — DONE, uncommitted.** Root cause: `wireImageZoomPan_`'s pan
  clamp used the image's un-rotated `offsetWidth`/`offsetHeight` even at 90°/270° rotation,
  where the rendered bounding box has them swapped — permanently hiding part of a rotated
  image from panning. Fixed in `common.js`'s `applyTransform()` (swaps effective width/height
  when `rotation` is 90 or 270 before computing the clamp). Confirmed via first-principles
  re-derivation that 0°/180° has no separate bug. No further work needed on this item.
- **New "Timesheet" category — partially done, uncommitted, NOT deployed.** A manually-
  selectable category (unlike Meal Allowance, injected only via hand-off) for attaching a
  reference timesheet photo used by reviewers to cross-check a request's other lines: no
  Amount/Location/Description, a Cut-off date range instead of one date, receipt still
  required. Backend (`Config.gs`, `Setup.gs`, `RequestService.gs`, `Validation.gs`) and the
  `frontend/index.html` template markup are done locally but **not pushed/deployed** and
  **`setupSheets()` has not been re-run** (so `CutoffEndDate` doesn't exist on the live
  `RequestLines` sheet yet). Still to do: `frontend/employee.js` (the `applyCategoryLayout_`
  helper and its wiring into `addLineItemRow()`/`collectLineItems()`/
  `validateRequiredLineFields_()`), `frontend/common.js` (`formatLineDateDisplay_`/
  `formatLineAmountDisplay_` helpers, `buildLineItemsHtml_` and receipt-modal display
  updates), `frontend/admin.js` (CSV export column, print-report caption fix). Resume by
  editing `frontend/employee.js` next, per the plan file's exact code.

21. Resumed the session after a usage-limit interruption and finished both items left
    mid-implementation in item 20 (per `CLAUDE.md`'s "Recently completed" section and the plan
    file `C:\Users\Gilbert\.claude\plans\update-plan-separate-the-lexical-riddle.md`):
    - Zoom/pan fix was already done and committed to the working tree from the prior session —
      no further work needed.
    - Finished the Timesheet category's frontend wiring exactly per the plan:
      `frontend/employee.js` (`LINE_ITEM_FIELDS`, `applyCategoryLayout_`, `addLineItemRow()`,
      `collectLineItems()`, `validateRequiredLineFields_()`), `frontend/common.js`
      (`formatLineDateDisplay_`/`formatLineAmountDisplay_`, `buildLineItemsHtml_`, the receipt
      modal's details pane), and `frontend/admin.js` (`EXPORT_CSV_HEADERS`/`buildExportCsv_`,
      `buildExportReportHtml_`'s caption logic). All backend pieces (`Config.gs`, `Setup.gs`,
      `RequestService.gs`, `Validation.gs`) and `frontend/index.html`'s template were already
      done from the prior session and needed no changes.
    - `node --check` passed on all three touched frontend files.
    - Pushed and deployed live (`clasp push -f` then `clasp deploy -i` against deployment
      `AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg`, now at
      version `@32`); confirmed live via `curl` against `getAllRequestsForPayroll`.
    - **Still needed, not done this session**: re-run `setupSheets()` from the Apps Script
      editor to materialize the `CutoffEndDate` column on the live `RequestLines` sheet (a
      real Timesheet submission will fail/misbehave until then), and a real-browser
      end-to-end test of the whole Timesheet flow (add line → toggle category → submit →
      view in My Requests/admin queue/receipt modal/CSV export/print-preview report) — nothing
      in this session touched a real browser.

22. Same day, the user actually started testing in a real browser and immediately hit a
    recurring "Unexpected token '<'" / "Login failed" / "Export failed" error on nearly every
    action (Biometric ID lookup, Approver login, the Pending queue, Export). Root-caused
    (confirmed via live `curl`/Node tests, not guessed): Apps Script's GET/POST flow always
    redirects to a one-time `script.googleusercontent.com` content URL, and that hop
    intermittently 404s — transient, since the exact same call reliably succeeds on an
    immediate retry. Two fixes, both planned via plan mode with the user's explicit sign-off on
    every trade-off (publishing 3 more sheets to CSV, accepted staleness, accepted duplicated
    routing logic) — see `CLAUDE.md`'s new "CSV-based read paths..." section for the full
    technical writeup, summarized here:
    - **Moved 3 read-only, high-frequency lookups off Apps Script onto the same
      published-CSV-parsed-client-side pattern** already used for the attendance/store
      reference sheets: Employees (Biometric ID login), and Requests+RequestLines (My Requests,
      the Approver queue, and CSV/print-preview export) — new
      `EMPLOYEES_CSV_URL`/`REQUESTS_CSV_URL`/`REQUEST_LINES_CSV_URL` in `frontend/config.js`,
      published by the user mid-session. The Approver queue's Pending-only routing scope was
      ported client-side too (`common.js`'s new `resolveRequiredApprover_`, plus
      `resolveEmployeeCategory_`/`STORE_DIR_COL_*` moved there from `employee.js` so `admin.js`
      can reuse them) — verified by running the exact routing simulation in Node against the
      live published CSVs and confirming an exact match against live `getAllRequestsForPayroll`
      results for two real accounts (Jayriel/783, Cris/33) before considering it done. All
      mutations (`submitLiquidationRequest`, `advanceRequestStage`, `updateLineItemAmount`,
      `loginApprover`, `saveMealAllowanceRecord`) deliberately untouched — still Apps Script.
    - **Added a silent auto-retry** (`common.js`'s `fetchJsonWithRetry_`, wired into the one
      shared `runServer()`) for the mutations that do still hit the flaky echo-redirect —
      retries once after 400ms before surfacing an error, covering all 5 remaining mutations
      automatically since they all go through `runServer()`.
    - The user explicitly asked whether the *Approvers* sheet (which holds plaintext passwords)
      could also move to CSV for the same speed/reliability reason — **declined**, since
      publishing it would make every Approver's password fetchable by anyone with the link, a
      real new exposure (unlike Employees/Requests, which are no more exposed via CSV than they
      already are via the existing open, unauthenticated API).
    - **Found and fixed a real bug this change introduced**: `requestsCsvCache`/
      `requestLinesCsvCache`/`employeesCsvCache` are fetched once and cached for the whole page
      session — so without something to bridge the gap, an Approve/Reject/Amount-edit/new
      submission would succeed on the server but never disappear/appear in the list until a full
      page reload (worse than the pre-existing "CSV can lag a few minutes" trade-off the user had
      already accepted for page-load speed — this was "never updates at all this session," caught
      when the user reported "pending approve/reject dapat mawawala, unless refresh"). Fixed with
      optimistic client-side cache patching right after each mutation's success response —
      `common.js`'s `patchCachedRequestStage_` (Approve/Reject), `patchCachedLineAmount_` (Save
      Amount), and `patchCachedNewRequest_` (new submission, called from `employee.js`'s
      `handleSubmitRequest` right before switching to My Requests). All three verified directly
      in Node against the real cached CSV data — confirmed a patched request's Status changes
      immediately and disappears from a Pending-filtered list, and a synthetic new request
      appears correctly alongside an employee's real existing ones without disturbing them.
    - Also converted `admin.js`'s Export CSV/Print Preview (`fetchExportableRequests_`) to the
      same CSV-based `loadJoinedRequests_` path — it's read-only and never Pending-scoped, so no
      extra routing logic was needed there.
    - **Not yet done**: none of this session's frontend changes have been committed to git (the
      backend/Timesheet changes from item 21 were already pushed/deployed, but nothing from item
      22 touches the backend — it's 100% frontend, no push/deploy/setupSheets() needed). Also
      still outstanding from item 21: `setupSheets()` re-run for `CutoffEndDate`, and a full
      real-browser Timesheet end-to-end pass.

23. New session, three separate small plans executed back to back (each via plan mode with
    clarifying questions), all pushed to Apps Script Head (`clasp push -f`) but **not yet
    deployed live** (`clasp deploy -i` not run this session) and not yet committed to git as
    of writing this entry:
    - **Sat–Wed submission window, bulk approve/disburse, export PDF fit fix.**
      `Validation.gs` blocks new submissions on Thursday/Friday (Manila time), naming the
      reopening Saturday and the week's disbursement Friday; mirrored client-side in
      `employee.js` with a banner + disabled Submit button. `common.js`'s
      `renderRequestsTable` gained optional checkbox/"select all" support; `admin.js` uses it
      to let the Reviewer/Authorizer advance many requests at once with a running total,
      reusing the existing single-request `advanceRequestStage` call in a sequential loop
      (not `Promise.all`, to avoid hammering `LockService`). The print-preview export's
      2-up/6-up receipt layout was fitting only 1 receipt per page instead of 2/6 — root
      cause was `.receipt-page` using `min-height: 90vh` (a viewport unit, meaningless when
      printed) with no real `height`, so children's `height: 100%` never resolved. First fix
      (giving `.receipt-page` a real `height: 255mm`) still didn't work — browsers don't
      reliably resolve flex/grid *percentage* heights during print pagination either. Final,
      confirmed-working-in-principle fix: explicit millimeter heights per cell (124mm × 2,
      82mm × 3) instead of any percentage/flex-grow chain. Added a grand-total row to the
      export summary too.
    - **Admin split into "Liquidation Requests" + "Reviewed & Disbursed" tabs.** The single
      queue+dropdown mixing all five statuses was confusing for Reviewer/Authorizer — split
      into a live queue (Pending/Approved/Rejected/All) and a history tab (Reviewed —
      still actionable for the Authorizer — plus Authorized/Disbursed, pure history), with
      Export CSV/Print Preview moved into the history tab since they only ever exported that
      exact status pair. Confirmed via clarifying questions with the user each time.
    - **Shorter sequential Request IDs + audit filters + a UI polish fix.**
      `IdGenerator.gs`'s `generateRequestId_()` replaced the long timestamp+random ID
      (`REQ-20260912-122045-176`) with a persistent-counter short ID (`REQ#000001`,
      `REQ#000002`, ...) via `PropertiesService`, safe under the existing `LockService` lock
      `submitLiquidationRequest` already holds when calling it. The "Reviewed & Disbursed"
      tab (the permanent audit trail — already showed full, uncapped history by construction)
      gained Employee Name and Date Requested (from/to, on `DateSubmitted`) filters alongside
      the existing Status dropdown, and was hidden entirely for Approver-role logins
      (`applyAdminTabVisibility_`) since only Reviewer/Authorizer need it. Also fixed the
      Export CSV/Print Preview buttons visually being spread far apart by
      `.card-header-row`'s 3-way `justify-content: space-between` — grouped them into a
      `.header-actions` wrapper so they sit tight together.
    - **Still needed**: `clasp deploy -i` to make the three `.gs` changes
      (`Validation.gs`/`RequestService.gs`/`IdGenerator.gs`) live on the real `/exec` URL —
      Head-only so far, per the user's explicit "locally only for checking" request earlier
      in the session. A real-browser pass on all of the above (bulk-select UX, the fixed PDF
      page-fit, the new admin tabs/filters, and confirming a real submission actually gets a
      `REQ#000001`-style ID) — nothing in this session was checked in an actual browser.
      `git commit`/`push` to GitHub, plus this same doc-update pass, are the user's explicit
      next ask (see the message that triggered writing this entry).

24. New session, resumed and confirmed via `clasp deployments` that item 23's backend changes
    were already deployed live (deployment `@34`) despite the commit message/doc note saying
    "Head-only" — the deploy had actually been run at the end of that session, just not
    reflected back into the docs at the time. Then the user showed a screenshot of a newly
    added sub-table in the published `STORE_COORDINATES_CSV_URL` sheet: **BIO ID / SENIOR
    HEAD / Area-Region / Meal Allowance**, currently one person (Jayriel Guardacasa, BIO 783)
    with a different peso amount per broad region (₱200 for MINDANAO/VISMIN/NORTH LUZON/SOUTH
    LUZON/CAVITE AREA, ₱100 for NCR AREA). Planned via plan mode with clarifying questions
    (confirmed: treat as a general, data-driven "Senior Head" role category, not hardcoded to
    Jayriel; source from the same sheet, not a new one) and implemented:
    - Live-fetched and parsed the real CSV in Node first to confirm the exact column layout
      (columns 24-27) before writing any code — same verification discipline as the earlier
      store-directory column-index work.
    - `frontend/common.js`'s `parseStoreCoordinatesCsv_` gained fixed-column-index reads for
      the new columns, stored under collision-safe keys (`SeniorHeadBioId`/`Name`/`Region`/
      `Amount`), plus a new `buildSeniorHeadBracket_()` that scans all rows into a
      `{bioId: {region: amount}}` lookup — picks up any future Senior Head added as a new row
      with no code change. `frontend/meal-allowance.js`'s `maResolveRegularAllowance_` checks
      this bracket first (region-wide, no proximity radius, unlike the existing per-store
      Tech/Area Head override), falling through to the existing paths if the employee isn't
      listed or their current region isn't in their table.
    - **Real bug found and fixed as a side effect**: the sheet edit that added the Senior Head
      columns reused two header names already in use elsewhere in the same row —
      `"Area/Region"` (already at column 17) and `"Meal Allowance"` (already at column 5) —
      which silently broke the existing header-keyed parsing the same way an earlier session's
      `BIO ID`/`REGULAR (AUDIT/TEC/STAFF)` duplicate-header bug did (see `common.js`'s existing
      comment on that class of bug, now updated to describe both rounds). Confirmed live: 113
      of 119 stores' `Area/Region` was reading blank (breaking the on-screen "Location"
      display), and every Tech-role personal override amount was silently resolving to 0.
      Fixed with the same fixed-column-index pattern as the first round.
    - Verified directly against live data (not just `node --check`): re-fetched the real
      published CSV in Node, ran the new parsing/bracket-building/resolution functions against
      it, and confirmed `Area/Region` is now non-blank for all 119 rows, a real Tech override
      amount resolves correctly (150, not 0), BIO 783 resolves to ₱200 at a MINDANAO-region
      store and ₱100 at an NCR-region store (matching the screenshot exactly), and an unrelated
      employee at the same stores still gets the flat regional bracket, unaffected.
    - 100% static frontend change (`common.js`, `meal-allowance.js`) — no backend push/deploy
      or `setupSheets()` needed, live immediately. **Not yet checked in a real browser** — only
      verified via the Node simulation against live CSV data.
    - `CLAUDE.md`/`resume.md` updated and this session's changes committed/pushed to GitHub as
      the user's explicit next ask.

25. New session, two Approvers-side usability requests, planned via plan mode (Explore agents
    surveyed the existing receipt modal and bulk-select code first, then clarifying questions on
    scope) and built entirely in the frontend (`common.js`, `admin.js`, `admin.html`,
    `styles.css`) — no backend changes, no deploy needed:
    - **Messenger-style Prev/Next attachment navigation in the receipt modal.** Clicking a line
      item still opens the same shared modal, but if the request has 2+ line items it now shows
      Prev/Next arrow buttons plus an "N / total" counter overlaid on the image pane, and
      Left/Right arrow keys navigate too — matching how Facebook Messenger's single-attachment
      viewer works. `wireLineItemRows_` now resolves the clicked line's *index* within
      `request.lines` (the full array was already sitting in scope, no new plumbing needed) and
      hands off to a new `openLineItemPreviewWithNav_(lines, index, computeLineOptionsFn)`, which
      recomputes the editable/onSaveAmount pair for whichever line is currently shown (needed
      since Save Amount must always target the *currently displayed* line, not the originally
      clicked one) and re-invokes the existing `openLineItemPreview_` — zoom/pan/rotation state
      naturally resets per attachment since a fresh `<img>` is built every call, matching
      Messenger's own behavior. The existing single global `keydown` listener (already handling
      Escape) was extended to also read `modal.currentNav.onPrev`/`onNext` for the arrow keys,
      rather than adding a new listener per modal open.
    - **Bulk select extended to every approval stage, including Reject.** Previously bulk
      select-all only existed for Approved→Reviewed and Reviewed→Authorized, and only ever did
      the forward action — no bulk on Pending (deliberately excluded before) and no bulk Reject
      anywhere. Confirmed via clarifying questions that both should be added: the Pending queue
      an Approver sees is already server-side scoped to only their routed requests, so
      bulk-approving within that pre-filtered list carries no new authorization risk (`advanceRequestStage`
      still independently re-checks routing per item regardless). Removed the
      `statusFilter !== 'Pending'` exclusion in `loadAdminRequests`, and extended
      `makeBulkController_` with a second "Reject Selected" button sharing the same checkboxes/
      running-total/confirm/password-gate/sequential-processing flow as the forward action —
      only the target stage (`'Rejected'`) and confirm wording differ. Both bulk bars in
      `admin.html` gained the new button, wrapped in a `.bulk-action-buttons` flex group.
    - **Bug found and fixed along the way (CSS): nav/download/rotate buttons weren't scoped to
      the image pane.** `.receipt-modal-image-pane` had no `position: relative`, so every
      absolutely-positioned overlay button appended inside it (download, rotate, and the new
      Prev/Next/counter) was actually positioning itself relative to the whole `.receipt-modal`
      card — harmless by coincidence for top-left-anchored buttons, but the new right-anchored
      Next button and center counter would land at the edge/center of the *entire* modal
      (bleeding into the details pane on desktop's side-by-side layout) instead of the image
      area. Fixed with one `position: relative` on `.receipt-modal-image-pane`.
    - **Real, confirmed bug found and fixed, unrelated to the two features above**: user reported
      expanding a request row on the "Reviewed & Disbursed" tab showed the row highlighting as
      expanded but the line-items panel stayed completely blank, no console error. Verified with
      a Node+jsdom harness against the real live published CSVs (not just code inspection) that
      `buildLineItemsHtml_`/`renderRequestsTable` correctly produce the full 9-line-item table for
      the exact reported request (`REQ-20260912-122045-176`) in isolation — ruling out a data or
      parsing bug. Root cause found by simulating **both admin tabs rendered at once** (as
      `admin.html` actually does — both tables stay in the DOM simultaneously, just CSS-hidden
      when inactive): `toggleRow`'s panel lookup (`common.js`) used a global
      `document.getElementById('detail-panel-' + idx)`, but both tabs' tables number their rows
      from 0, so `detail-panel-0` existed twice in the document and `getElementById` always
      grabbed the *first* one — silently writing content into the other (hidden) tab's panel
      while the currently-visible one stayed empty. No exception, since the wrong panel was still
      a valid element. Fixed by scoping the lookup to `container.querySelector('#detail-panel-' +
      idx)` instead of a global id search. Re-verified the exact collision scenario (two tables,
      both idx=0) in the jsdom harness after the fix — the correct table's panel now renders its
      9 lines and the other tab's panel is confirmed untouched.
    - `node --check` passes on both touched `.js` files. **Not yet checked in a real browser** —
      verified via Node/jsdom simulation against live CSV data only; still to confirm personally:
      Prev/Next arrows position correctly and don't overlap the details pane on desktop, arrow-key
      navigation, bulk-approve on the Pending queue, and bulk-Reject on all three bars.

26. New session, three more user-reported issues, planned via plan mode with Explore agents +
    clarifying questions. All 100% frontend (`frontend/common.js`, `frontend/admin.js`,
    `frontend/admin.html`) — no backend push/deploy needed:
    - **Mobile "Failed to fetch" fix.** Root-caused via an Explore agent: `common.js`'s
      `fetchJsonWithRetry_()` only ever retried when the response body was bad JSON (the known
      transient Apps Script echo-redirect 404) — a genuinely rejected `fetch()` promise (a
      dropped/unstable cellular connection) propagated straight through as a raw
      `TypeError: Failed to fetch`, shown to the user verbatim in `employee.js`'s
      `setMessage(errorEl, err.message, true)` call sites. There was also no timeout anywhere,
      so a stalled connection could hang indefinitely instead of failing fast. Fixed with a new
      shared `fetchWithRetry_()`: wraps every request in a 25s `AbortController` timeout plus one
      silent 400ms-backoff retry on actual network failure (not just bad JSON), and throws a
      friendly `"Connection problem — please check your signal and try again."` message once
      retries are exhausted. `fetchJsonWithRetry_` (every RPC call — login, submit, every
      mutation) and a new `fetchTextWithRetry_` (the Biometric ID login's CSV lookup,
      `loadEmployeesCsv_`, previously a bare unretried `fetch()`) both build on it.
    - **Approver queue visibility — two passes, self-corrected mid-session.** First pass (per the
      user's initial ask, "approvers can see only the list what request they approve"): hid the
      Status filter dropdown entirely for Approver-role logins and hardcoded their queue view to
      `Pending` only (`applyAdminTabVisibility_` hiding `#admin-status-filter-field`,
      `loadAdminRequests()` forcing `statusFilter = 'Pending'`). The user then came back (in
      Filipino) clarifying that went too far — they also want to see requests **they've already
      approved**, not just their live Pending queue. Corrected: restored the dropdown (removed
      the hiding logic) and instead widened the existing `resolveRequiredApprover_` routing-scope
      check in `loadAdminRequests()` — previously gated to `req.Status === 'Pending'` only — to
      apply to every Status option (Pending/Approved/Rejected/All), since the check itself is
      stage-independent (resolved from the employee's Department/BaseLocation and the request's
      own line location, not from `Status`). End result: an Approver's dropdown still offers all
      four options, but every one of them is now scoped to only the employees routed to that
      specific Approver — switching to "Approved" shows their own approval history, not
      everyone's. Reviewer/Authorizer's separate "Reviewed & Disbursed" tab/filter was untouched
      by either pass.
    - **Print Preview: approver names added to each receipt page.** The export report's summary
      table (page 1) already showed `ApprovedBy`/`ReviewedBy`/`AuthorizedBy` with dates — but the
      individual receipt image pages further down only captioned Request ID/Employee/Date/
      Category/Amount, confirmed via an Explore agent before writing any code. Added a second
      caption line per receipt in `buildExportReportHtml_` — "Approved by X · Reviewed by Y ·
      Authorized by Z" (only the stages that have actually happened; `ApprovedBy`/`ReviewedBy`
      always present since only Reviewed/Authorized statuses are exportable, `AuthorizedBy` only
      once Disbursed) — reusing the exact field names already present on the request object, no
      backend or CSV changes needed.
    - `node --check` passes on all touched files. **Not yet checked in a real browser** —
      throttled/offline-toggle retry behavior, the Approver dropdown's per-status scoping, and
      the new receipt-caption line all still need a manual pass. `CLAUDE.md`/`resume.md` updated
      and this session's changes committed/pushed to GitHub as the user's explicit next ask.

27. New session, user asked for an Authorizer-only emergency escape hatch from the existing
    Sat–Wed submission window: search an employee, grant them a 1-hour, self-expiring
    exemption so they can submit during the normally-blocked Thu/Fri window. Planned via
    plan mode: an Explore agent first mapped every existing pattern to reuse (credential/
    role-gate shape from `advanceRequestStage`, sheet-migration pattern, the
    already-unused-but-functional `searchEmployeesForUtility`), then three clarifying
    questions were asked and answered before writing the plan — re-granting an already-
    exempted employee **replaces** with a fresh 1-hour window (no merge/reject); the
    Authorizer's panel **shows a live list** of everyone currently exempted, not just a bare
    grant form; and the Authorizer can **manually revoke** an active exemption early via a
    per-row button, not only let it expire naturally. Built and deployed same session:
    - New backend file `ExemptionService.gs` (whitelisted in `.claspignore`) and a new
      `SubmissionExemptions` sheet tab, following every existing convention exactly:
      `getActiveExemptionForEmployee_`/`isExemptionRowActive_` derive "active" as
      `RevokedDate` blank AND `ExpiresAt > now` (no boolean status column); revoke is
      always a soft update, never a row delete, so the sheet is its own audit trail;
      `grantSubmissionExemption`/`revokeSubmissionExemption` mirror `advanceRequestStage`'s
      exact credential-resolve → role-gate → `LockService` pattern, hardcoded to
      `ROLE_AUTHORIZER` rather than looked up from a status map since this isn't a
      stage-advance action.
    - `Validation.gs`'s `submissionWindowError_()` — the single call site, from
      `validateSubmission_` — changed from zero-arg to accepting `employeeId`, checking for
      an active exemption before returning the Thu/Fri block message. Purely a lazy
      timestamp comparison at call time — no cron, no trigger, nothing that "closes" an
      exemption except the next read simply no longer counting it as active.
    - `admin.html`/`admin.js` gained a new tab (initially labeled "Emergency Exemption",
      renamed to **"Submission Exemption"** after the user asked for a plainer label
      following a short suggestions-and-pick exchange — only user-facing text changed, the
      file/sheet/function names stayed as `ExemptionService.gs`/`SubmissionExemptions`/etc.),
      gated to `currentApprover.role === 'Authorizer'` only — a **positive** role check,
      the opposite shape from the existing history tab's negative `!== 'Approver'` gate,
      since granting a submission bypass is specifically an Authorizer-level power nobody
      else should even see the option for. Employee search reuses
      `searchEmployeesForUtility` (`MealAllowanceService.gs`) — its first real frontend
      consumer, previously defined but completely unused. The active-exemptions list has a
      purely cosmetic client-side 30-second countdown (`setInterval`, only ticking while
      that tab is actually showing, cleared on tab switch/logout) — the server-side
      timestamp comparison is what's actually authoritative regardless of any client drift.
    - `employee.js`'s submission-window UX mirror (`applySubmissionWindowState_` and the
      real submit-click guard in `handleSubmitRequest`) became exemption-aware via a new
      `checkMySubmissionExemption` read action, deliberately **failing closed** on any
      error — unlike this app's fail-open routing fallback elsewhere (a UX convenience),
      this is a security-relevant gate, so a check failure should only ever produce a
      wrongly-blocked submit, never a wrongly-allowed one; `Validation.gs` stays the real
      authority regardless of what this client mirror shows.
    - `Code.gs` gained 4 new `API_ACTIONS`; `common.js`'s `READ_ONLY_ACTIONS` gained the 2
      pure-read ones (`checkMySubmissionExemption`, `getActiveSubmissionExemptions`) so they
      route via GET.
    - **Verified**: `node --check` passed on every touched frontend file; a throwaway Node
      simulation (scratchpad, not committed) of the active/expired/revoked/re-grant-
      replaces/non-Thu-Fri-never-blocks logic all passed. Pushed (`clasp push -f`, confirmed
      `ExemptionService.gs` was actually in the uploaded file list — the `.claspignore`
      allowlist footgun this repo has hit before) and deployed live (`clasp deploy -i`
      against the existing deployment ID, now `@35`). `setupSheets()` was re-run by the user
      directly in the Apps Script editor (execution log confirmed "Setup complete." with no
      errors) to create the `SubmissionExemptions` tab — a live `curl` smoke test against
      `getActiveSubmissionExemptions` failed with `"Sheet not found"` *before* that run and
      returned `[]` correctly *after*, confirming both that the deployed code path is real
      (not silently no-op-ing) and that the tab now exists.
    - **Not yet done**: the actual Authorizer search → grant → see-in-list → countdown →
      revoke flow has not been exercised in a real browser, nor has an exempted employee's
      Submit button actually being confirmed to re-enable and a real submission succeeding
      during a live Thu/Fri window. `CLAUDE.md`/`resume.md` updated and this session's
      changes committed/pushed to GitHub as the user's explicit next ask.

28. New session, user reported the app "lagging" on submit/upload/data-loading under
    multi-user load and suggested a first-come-first-served queue so concurrent access
    wouldn't crash/lag Google Sheets. Planned via plan mode: an Explore agent first
    confirmed the backend already serializes every mutation through one shared
    `LockService.getScriptLock()` (so "one at a time" already existed), then three
    clarifying questions settled the approach (lightweight tuning, not a full ticket
    queue; exact processing order doesn't matter; retries should be silent, no visible
    "queued" UI) before a Plan agent designed the fix, refined after reading the actual
    files (`RequestService.gs`, `DriveService.gs`, `IdGenerator.gs`) — the plan's
    original "temporary Drive folder token" idea for pre-lock uploads was replaced with
    a cleaner two-phase-lock design once `generateRequestId_()`'s fast
    `PropertiesService` counter (no external I/O) was confirmed, preserving the
    existing `<EmployeeID>/<RequestID>/` Drive folder convention exactly. Built and
    deployed same session:
    - `submitLiquidationRequest` (`RequestService.gs`) split into 3 phases: a short
      lock just to generate `requestId`/`lineId`s, unlocked Drive receipt upload(s)
      using that real ID, then a second short lock for the actual `Requests`/
      `RequestLines` Sheet writes — since all 5 mutation entry points in this app
      (submit, advance-stage, edit-amount, grant/revoke exemption) share one
      script-wide lock, this was blocking every queued action app-wide, not just other
      submissions, on Drive's real external-API latency. Accepted tradeoff: a Sheet
      write failing after a successful Phase-2 upload orphans that file in Drive — no
      rollback built (no test suite, rare failure path, more Drive API surface isn't
      worth it for this), documented explicitly in `CLAUDE.md` instead.
    - `waitLock` raised `10000` → `20000` on `submitLiquidationRequest` (both phases),
      `advanceRequestStage`, `updateLineItemAmount`; left at `10000` on the two rare
      Authorizer-only exemption actions. `SheetService.gs`'s uncached full-sheet reads
      and per-field writes were deliberately left alone this pass — shared by every
      other backend file, riskier to touch without test coverage, and not the dominant
      lag source once Drive I/O moved out of the lock.
    - `frontend/common.js`'s `fetchJsonWithRetry_` gained a second, independent retry
      budget that fires only on a well-formed `{success:false, error:'System is
      busy...'}` response (`500/1000/2000/4000ms` backoff) — silent from the user's
      perspective (existing spinner keeps showing), and layered after the existing
      network/malformed-JSON retry without touching `runServer` or any call site.
    - Pushed (`clasp push -f`) and deployed (`clasp deploy -i`, now `@36`); confirmed
      live via `curl` against `getAllRequestsForPayroll` for both `Reviewed` and
      `Authorized` filters.
    - **Separate follow-up same session**: user shared a screenshot showing visible lag
      typing into the Authorizer's Submission Exemption search box. Root cause: that
      search called the Apps Script action `searchEmployeesForUtility` (full, uncached
      `Employees` sheet read) on every debounced keystroke. Fixed by porting the same
      search logic to a new `frontend/common.js` function,
      `searchEmployeesFromCsv_()`, run against the already-cached published Employees
      CSV (`loadEmployeesCsv_()`, the same cache the Biometric ID login uses) — 100%
      frontend, no backend change, live as soon as `admin.js`/`common.js` are served.
      Verified against the real live published CSV in Node (not just code
      inspection): searching "celis" correctly matches employee 150 (Celis, Louwin).
    - Work committed and pushed to GitHub as commit `9061ea9`
      ("Reduce lock contention lag and speed up exemption employee search").
    - **Not yet done**: no real-browser or real-concurrent-multi-user test of any of
      this — cannot be simulated via curl/Node alone. Specifically unverified: whether
      lag/"System is busy" failures actually drop under real concurrent load; whether
      the 20s `waitLock` ever makes a single user wait uncomfortably long in silence;
      whether the busy-retry could mask a genuinely stuck backend behind repeated
      silent retries; the orphaned-Drive-file edge case actually occurring; and that
      the Submission Exemption search actually feels fast in a real browser.

29. Same session, right after the concurrency fix went live, the user shared a screenshot of
    an Approver ("Mjean.photo") hitting "Login failed: Connection problem — please check your
    signal and try again." on `admin.html`, happening intermittently for multiple people (not
    just one person's device). Investigated via plan mode with an Explore agent before
    touching anything: confirmed this specific message can only come from `common.js`'s
    `fetchWithRetry_` when the raw `fetch()` promise itself rejects or the 25s
    `AbortController` timeout fires after retries run out — structurally unrelated to the
    concurrency fix just shipped (`loginApprover` never returns `{success:false,...}`, so the
    new busy-retry branch can't even match it, and its backend path has no `LockService` call
    at all). Most likely cause given it hit multiple people: Apps Script's known
    cold-start/echo-redirect dance occasionally outlasting the old 1-retry budget, or a brief
    real network drop — not a code bug. User confirmed the fix direction (make retries more
    forgiving, same shape as the busy-retry backoff just built). Raised `fetchWithRetry_`'s
    default attempts from 2 to 3 (1 retry → 2 retries) with a new increasing backoff schedule
    `NETWORK_RETRY_DELAYS_MS = [400, 1200]` replacing the old fixed 400ms delay;
    `fetchJsonWithRetry_`'s default moved to match since both share one counter.
    `FETCH_TIMEOUT_MS` (25s) left unchanged. 100% frontend (`common.js`), no backend deploy.
    - **Verified**: `node --check` passes; a Node simulation of the retry indexing confirmed
      exactly 3 total attempts with 400ms then 1200ms backoff.
    - **Cannot verify without it recurring in the wild**: the root cause was inferred, not
      directly observed (no way to reproduce a cold-start or network drop on demand), so
      there's no way to confirm this actually resolves the intermittent login failures until
      the affected users try again.

## Known loose ends / not yet done
- **Items 14-17 above (session persistence, receipt preview modal + zoom/pan/download, receipt required + compression) have not been manually tested in a real browser.** Split status, confirmed by asking "has this actually been working?" and checking rather than assuming:
    - **Confirmed live via `curl` against the deployed `/exec` URL** (server-side logic, testable without a browser): `updateLineItemAmount` rejects bad credentials; `submitLiquidationRequest` now rejects a line with no `file`/`receiptUrl` (`"Line 1: a receipt photo is required."`) and rejects a PDF mime type (`"receipt file type not allowed (application/pdf)."`); the file picker's `accept="image/*"` change means a PDF can't even be selected anymore. A full successful-submission test was deliberately skipped to avoid writing real test data into the production Sheet/Drive.
    - **Genuinely NOT verified — client-side-only, `curl` can't exercise it**: the actual **compression step** (`compressImageForUpload_` in `employee.js` — canvas re-encode toward ~1MB, quality stepped down from 0.9 to a 0.5 floor). It's in the deployed code and passes `node --check`, but nobody has yet uploaded a real large receipt photo and confirmed the file that lands in Drive is actually ~1MB and still legible. Likewise untested: session persistence across refresh, the zoom/pan/drag/download modal interactions, and the Approver Save Amount UI flow.
    - Worth a real end-to-end pass: log in on both pages and refresh; submit a request with a blank field and with no receipt (should block on both); open a receipt preview and try scroll-zoom, drag-pan, double-click-reset, and the download button; as an Approver during their own turn, edit and save a line item's Amount; select a large photo as a receipt and confirm it actually shrinks toward ~1MB while staying legible.
- Old unused `Index.html`/`CSS.html`/`JS_Common.html`/`JS_Employee.html`/`JS_Admin.html` files still sit in the **remote** Apps Script project (clasp doesn't delete remote files that vanish locally) — harmless but could be manually deleted in the Apps Script editor for cleanliness.
- Old `Name`/`PIN` columns (from the PIN scheme, before User ID + password) and older `ProcessedBy`/`ProcessedDate` columns (from the original single-step approval) are all sitting unused in the `Approvers`/`Requests` sheets — `createOrMigrateSheet_` only adds missing columns, never removes old ones. Worth a manual cleanup pass in the Sheet UI at some point, not urgent.
- No automated tests exist anywhere in this project.
- Security model is intentionally incremental, not fully "real" — User ID + password login is a step up from free-text names (server-verified identity+role on every action) but passwords are plain text with no rate-limiting/session expiry. Documented in `CLAUDE.md`; don't silently "harden" this further (hashing, real accounts, etc.) without an explicit ask.
- **`Approvers` sheet needs real data entered** (see item 12 above): `BiometricID` for Jayriel (783, confirmed done); brand-new login rows for Cris Taglucop (33) and Lanilyn Balane (452) — confirmed done, both already have working logins with correct `BiometricID`s; a shared **"ADMIN"** login row with `BiometricID = 9999` for HeadOffice-category routing (item 13) — not yet confirmed set up; and one row per per-store Area Head who should be able to approve their own store's plain-staff requests (several confirmed already set up — Richard Bual/SM Calamba, Ochin Ibay/SM Cebu, others — but not necessarily all 118 stores). Until a given store's Area Head has a row, that store's Staff-category requests fall back to "any active Approver" — not stuck, just unscoped.
- **Some employees' `Employees.BaseLocation` values predate the new dropdown** and may not exactly match a store name in the directory sheet (known case: Sabater, BIO 51814, was blank) — worth an audit pass across the whole `Employees` sheet now that the dropdown will flag mismatches with Sheets' invalid-data warning. Note this matters less than it used to for routing specifically, since Staff-category routing now prefers the request's own line-item location first (item 13) — `BaseLocation` is only the fallback.
- **Janelyn Taglucop Angcay (BIO 51077)** was expected by the user to be an Area-Head-category person (routing to Jayriel) but isn't currently listed anywhere in the directory sheet — resolves as plain Staff instead. If she's meant to be Area Head, she needs adding to the directory's columns 24/25 (paired with any store in column 26) — a data fix, not code.
- **The directory sheet's columns 11/12 are dead/misleading data** (see item 13's row-misalignment bug) — worth flagging to whoever maintains that external sheet, since they could either be cleaned up/removed, or fixed to realign with `STORES`, at which point revisit whether `StoreDirectoryService.gs`/`employee.js` should switch back or a maintainer explicitly confirms 24/25 should remain authoritative long-term.
- **Batch export (item 19) print-preview window has not been tested in a real browser.** Deployment/syntax were confirmed live, and the export logic was verified end-to-end with a jsdom simulation plus live `curl` calls against `getAllRequestsForPayroll`, but a jsdom test can't see actual rendering. Still outstanding, for the user to check personally: whether the popup actually opens (vs. gets blocked) in real Safari/Firefox/Chrome; the print-preview report's real visual appearance (summary table styling, receipt image sizing/legibility); and the browser's print dialog/"Save as PDF" pagination behavior when a request has multiple lines with receipts.
