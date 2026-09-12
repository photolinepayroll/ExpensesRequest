# Expense Liquidation Request System

Two separate, independently deployed pieces:

- **Backend** (this folder's `.gs` files) — a Google Apps Script web app that is a plain **JSON API** over your Google Sheet/Drive. No HTML, no login pages — just `doGet`/`doPost` returning JSON.
- **Frontend** (`/frontend`) — a fully static site of **two separate pages**: `index.html` (employee submission + status) and `admin.html` (Approvers' review/approval queue), sharing `styles.css`, `common.js`, and `config.js`. `employee.js` is only loaded by `index.html`; `admin.js` only by `admin.html`. Deploy anywhere static files are served — GitHub Pages, Netlify, or just opening the HTML files locally.

## Approval workflow

A request moves through four ordered stages, each gated by a specific role, before landing in a terminal state:

```
Pending → Approved → Reviewed → Authorized (cleared to disburse)
   ↓          ↓          ↓
   └────── Rejected (terminal, from any non-terminal stage) ──────┘
```

| Current status | Role required to act | Action available |
|---|---|---|
| Pending | Approver | Approve, or Reject |
| Approved | Reviewer | Mark Reviewed, or Reject |
| Reviewed | Authorizer | Authorize Disbursement, or Reject |
| Authorized / Rejected | — | terminal, no further action |

**Note:** the internal status value stored/sent for the terminal stage is still `Authorized` (matches `Config.gs`'s `STAGE_ORDER` and the Sheet column names below) — but it's *displayed* to users as **"Disbursed"** everywhere (badge, filter dropdown, audit trail, Remarks log lines) via `common.js`'s `STATUS_DISPLAY_LABELS` on the frontend and `RequestService.gs`'s `STAGE_DISPLAY_LABEL` on the backend.

Each forward stage records who acted and when (`ApprovedBy`/`ApprovedDate`, `ReviewedBy`/`ReviewedDate`, `AuthorizedBy`/`AuthorizedDate`, or `RejectedBy`/`RejectedDate` on rejection) in the `Requests` sheet, and `Remarks` accumulates a running log — one line appended per action, never overwritten — so the full history survives every stage. `admin.html` only ever shows the single next legal action for a request's current stage; the backend (`RequestService.gs`'s `advanceRequestStage`, guarded by `Validation.gs`'s `validateStageTransition_` plus a role check against `REQUIRED_ROLE_BY_STATUS`) independently rejects any out-of-order transition or wrong-role action regardless of what the UI sends.

### Crediting date

The moment a request is Authorized (Disbursed), `RequestService.gs`'s `computeNextCreditingFriday_()` automatically stamps a `CreditingDate`: the Friday of the current Monday–Sunday week, or — if authorized on a Saturday or Sunday, after that week's Friday has already passed — the following Friday instead. This is shown as its own column in both the employee's "My Requests" table and the Approvers' queue, and appended to the "Disbursed by..." line in the audit trail. It's a fixed weekly-Friday schedule, not user-editable per request.

### Approver login (User ID + password, not a real account system)

Approvers are listed in an `Approvers` sheet: `UserID, Password, FullName, Role, Active`. `admin.html` shows a login gate before the requests queue; on success it greets the person by their `FullName`/role and keeps the credentials in memory for the rest of that page load — every subsequent action (Approve/Mark Reviewed/Authorize/Reject) resends that same User ID + password, and the backend re-verifies both (and the role) on every single call via `ApproverService.gs`'s `getApproverByCredentials_`. This means the audit trail's names are `FullName` values the server itself confirmed, not free text the browser sent — a real improvement over free-text names, but the password is still stored as **plain text** in the Sheet and there's no session/token/expiry — treat this as "harder to spoof by accident," not "secure," consistent with the rest of this project's accepted internal-tool security stance below.

## How they talk to each other

`frontend/config.js` holds `APPS_SCRIPT_URL`, your backend's `/exec` URL. `common.js`'s `runServer()` calls it:
- **Reads** (`getEmployeeByID`, `getMyRequests`, `getAllRequestsForPayroll`) go out as a simple `GET ?action=<name>&arg0=...` — no CORS preflight.
- **Mutations and anything carrying credentials** (`submitLiquidationRequest`, `advanceRequestStage`, `loginApprover`) go out as `POST` with a `text/plain` body `{"action": "...", "args": [...]}` — also preflight-free, since Apps Script can't answer an OPTIONS request, and it keeps passwords out of URLs/browser history/server logs.

`Code.gs` dispatches both to the matching function in `RequestService.gs`/`EmployeeService.gs`/`ApproverService.gs` and returns the result as JSON via `ContentService`, which Apps Script serves with `Access-Control-Allow-Origin: *` — so any static site can call it.

**Note on how Apps Script serves POST responses:** a POST to `/exec` gets a `302` redirect to a `script.googleusercontent.com` URL to fetch the actual response — this is normal, `doPost` already ran synchronously before the redirect was issued, so the redirect target only ever needs a `GET` (browsers/`fetch()` handle this correctly on their own; if testing with `curl`, don't force `-X POST` together with `-L`, or curl will wrongly try to POST the redirect hop too).

**Security note:** this means your `/exec` URL is a fully open API to anyone who has it — there's no auth beyond the Employee ID text match and the Approver's User ID/password. That's an accepted trade-off for an internal tool, but don't treat the URL as secret-safe; anyone with it could call `submitLiquidationRequest` or `advanceRequestStage` directly (with guessed/leaked credentials), not just through your UI.

## Backend setup (Apps Script)

1. Create a new Google Sheet (blank). Copy its ID from the URL (`.../d/<ID>/edit`).
2. Create a Google Drive folder for receipts. Copy its ID from the URL.
3. Open `Config.gs` and set `SPREADSHEET_ID` and `DRIVE_ROOT_FOLDER_ID`.
4. Push and deploy:
   ```
   clasp login                      # once
   clasp push -f                    # uploads code
   clasp deployments                # find your deployment id (or clasp deploy to create a first one)
   clasp deploy -i <deploymentId>   # publishes the pushed code to that deployment's /exec URL
   ```
   **Important:** `clasp push` alone does *not* update your live `/exec` URL — a deployment is pinned to a saved version snapshot. Every time you change backend code, you must also run `clasp deploy -i <deploymentId>` (same id = same URL). `npm run deploy` only runs `clasp push -f`; add the `clasp deploy -i` step yourself when backend logic changes.
5. In the Apps Script editor, run `setupSheets` (in `Setup.gs`) to create the `Employees`, `Requests`, `RequestLines`, `Approvers` tabs — safe to re-run any time; on an existing sheet it only appends any headers that are missing (e.g. after the approval columns were added) without touching existing data or removing old columns.
6. Populate `Employees`: EmployeeID, Name, Department, Email, BaseLocation, Active (TRUE/FALSE).
   Populate `Approvers`: UserID, Password, FullName, Role (`Approver`/`Reviewer`/`Authorizer`), Active (TRUE/FALSE) — one row per Approver, multiple people can share a Role. `FullName` is what appears in the audit trail (`ApprovedBy`/`ReviewedBy`/`AuthorizedBy`), so put a real name there, not a login handle.
7. Deployment access must allow anonymous calls (Deploy → Manage deployments → Edit → "Execute as: Me", "Who has access: Anyone") — not "Anyone within [domain]", or unauthenticated `fetch()` calls will hit a Google sign-in wall instead of your API.
8. Copy the `/exec` URL into `frontend/config.js` as `APPS_SCRIPT_URL`.

## Frontend setup (static site)

Nothing to build — `frontend/` is deployable as-is:
- **GitHub Pages:** push the contents of `frontend/` to a repo (root or `/docs`), enable Pages on that branch/folder.
- **Local preview:** just open `frontend/index.html` (employees) or `frontend/admin.html` (Approvers) in a browser — both call the real backend over the internet, so lookup, submission, and approval all work exactly like the deployed site.
- **Approvers view:** `admin.html` is a real, separate page/URL now — e.g. `https://yourname.github.io/expense-liquidation/admin.html` — not a query-string flag on the employee page.

## Project structure

```
Code.gs                JSON API dispatcher (doGet/doPost) — the only backend entry point
Config.gs               Spreadsheet ID, Drive folder ID, constants, stage order, role names
SheetService.gs         Generic header-mapped Sheet read/write helpers
EmployeeService.gs      Employee ID lookup
ApproverService.gs      User ID + password lookup for the Approver/Reviewer/Authorizer roles
RequestService.gs       Submit / list / advance-stage business logic, incl. crediting-date computation
DriveService.gs         Receipt upload + folder management
IdGenerator.gs          Request/Line ID generation
Validation.gs           Server-side validation (authoritative), incl. stage-transition rules
Setup.gs                Idempotent setupSheets() helper (creates/migrates all 4 tabs)
appsscript.json         Manifest

frontend/
  index.html            Employee page: ID entry, new request form, my requests
  admin.html            Approvers page: filterable queue, stage-by-stage approval
  styles.css            All styling (shared by both pages)
  common.js             Shared state, fetch() wrapper, request table + audit-trail rendering (shared by both pages)
  employee.js           Employee-page-only logic — loaded by index.html only
  admin.js              Approvers-page-only logic — loaded by admin.html only
  config.js             APPS_SCRIPT_URL — point this at your backend (shared by both pages)
```

## Notes

- No Google sign-in for employees — they type an Employee ID matched against the `Employees` sheet.
- Approvers log into `admin.html` with a personal User ID + password matched against the `Approvers` sheet — see "Approver login" above.
- Receipts are stored in Drive under `<root folder>/<EmployeeID>/<RequestID>/`.
- No email notifications in this version.
