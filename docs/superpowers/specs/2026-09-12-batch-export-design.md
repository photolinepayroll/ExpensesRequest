# Batch PDF + CSV export design

## Context
Payroll/record-keeping currently has no way to pull a consolidated view of processed requests —
each `Reviewed`/`Authorized` (Disbursed) request has to be opened individually in `admin.html` to
see its receipts and detail. The user asked for a one-click batch export: a combined PDF (summary
+ receipt images) and a separate line-item CSV, covering all currently `Reviewed` or `Authorized`
requests. Confirmed with the user via the brainstorming skill's clarifying-questions flow;
design approved as-is with no revisions.

## Scope
Batch export only — not a single-request export, not date-range filtered. One "Export" button in
`admin.html`'s queue always exports every request currently in `Reviewed` **or** `Authorized`
status, at the moment the button is clicked. Visible to any logged-in approver role — no role
gating on the button itself, consistent with this app having no hard server-side auth boundary
beyond the existing per-action role/credential checks (see `CLAUDE.md`'s Security model section).

## Data fetching (`admin.js`)
No change needed to `getAllRequestsForPayroll` — it already accepts a single `statusFilter`. The
export handler calls it twice, once for `'Reviewed'` and once for `'Authorized'` (no
`approverBiometricId`, since both statuses are already unscoped/unfiltered reads), and
concatenates the two result arrays. Each request object already carries its joined `lines` array
(via `buildRequestsWithLines_` server-side), so no extra per-request fetch is needed for the
non-receipt data.

## Backend: `getReceiptImageBase64` (new action)
`<img src>` display works today via `driveThumbnailUrl_()` because it's just a cross-origin URL a
browser `<img>` tag can load. jsPDF instead needs actual pixel bytes it can draw to a canvas/embed
directly — pulling a cross-origin image into a canvas without a matching CORS response taints the
canvas and blocks `toDataURL`/`addImage`. So a new server-side action is needed:

```
getReceiptImageBase64(driveUrl)
```
- New function, added to `DriveService.gs` (it already owns the Drive file-ID-regex pattern used
  by `driveThumbnailUrl_`/`driveDownloadUrl_` on the frontend — this is the server-side mirror of
  that same extraction).
- Extracts the Drive file ID from `driveUrl` with the same regex pattern already used client-side
  in `common.js`. If no ID can be extracted, returns `{ success: false, error: 'Invalid receipt URL.' }`.
- `DriveApp.getFileById(id).getBlob()`, base64-encodes via `Utilities.base64Encode(blob.getBytes())`,
  reads the mime type via `blob.getContentType()`.
- Wrapped in try/catch — a deleted/inaccessible file returns `{ success: false, error: 'Receipt not found or inaccessible.' }`
  rather than throwing, since this runs in a loop across potentially many receipts and one bad
  file shouldn't abort the whole export.
- On success: `{ success: true, base64: '<...>', mimeType: 'image/jpeg' }`.
- This is a read-only action (no Sheet/Drive writes), but it's registered as a POST-style
  action in `Code.gs`'s `API_ACTIONS` like every other action — it's **not** added to
  `common.js`'s `READ_ONLY_ACTIONS` list, since that list controls GET-with-query-params dispatch
  and a Drive URL (containing `/`, `?`, `=`) is unsafe to pass as a raw query param; it goes
  through the existing POST-with-JSON-body path instead, same as every mutation.

## PDF generation (client-side, `admin.js` + `admin.html`)
Library: jsPDF, loaded via CDN `<script>` in `admin.html` (no bundler in this project, consistent
with every other frontend dependency being either hand-written or CDN-loaded).

Flow, triggered by a new "Export" button in `admin.html`'s queue toolbar:
1. Button shows a loading state (disabled, "Exporting...") — the receipt-fetch loop below can take
   a while for many requests.
2. Fetch both statuses, merge (see above). If the merged list is empty, show a message ("No
   Reviewed or Disbursed requests to export.") and stop — don't generate an empty PDF/CSV.
3. Build page 1 (+ overflow pages, jsPDF's `autoTable` or manual row-pagination): one row per
   request — RequestID, Employee, Status (displayed via the existing `STATUS_DISPLAY_LABELS` map
   so `Authorized` shows as "Disbursed"), TotalAmount, ApprovedBy/Date, ReviewedBy/Date,
   AuthorizedBy/Date, CreditingDate.
4. Walk every line item across every request; for each with a `ReceiptFileURL`, call
   `getReceiptImageBase64(line.ReceiptFileURL)` (sequentially, not in parallel — Apps Script's
   concurrent-execution quota is shared across the whole project, and this isn't latency-critical
   since the button already shows a loading state). On success, add a new PDF page: a caption
   header (RequestID, Employee, line Date, Category, Amount) followed by the image, scaled to fit
   the page width/height while preserving aspect ratio.
5. On failure (missing `ReceiptFileURL`, or `getReceiptImageBase64` returning `success: false`):
   skip that line's image page silently — no placeholder page — and record
   `{ requestId, employee, lineDate, category, reason }` into a `missingReceipts` list.
6. After all lines are processed, if `missingReceipts` is non-empty, append one final page (or
   extra rows under the summary table if it fits) listing them: "The following lines have no
   receipt on file:" followed by one line per entry.
7. Save via `doc.save('liquidation-export-YYYY-MM-DD.pdf')` (jsPDF's own download trigger — no
   manual Blob/`<a download>` needed for the PDF specifically, since jsPDF provides this natively).

## CSV generation (client-side, `admin.js`)
One row per line item (not per request), built as an in-memory array of arrays / string, from the
same merged request list already fetched for the PDF (no extra backend call — the CSV doesn't
need receipt bytes, only `ReceiptURL` as a link).

Columns, in order:
`RequestID, EmployeeID, EmployeeName, Status, SubmittedDate, ApprovedBy, ApprovedDate, ReviewedBy, ReviewedDate, AuthorizedBy, AuthorizedDate, CreditingDate, LineDate, Category, Amount, BaseLocation, ReceiptURL, Remarks`

- `Status` uses the same `STATUS_DISPLAY_LABELS`-mapped display text as the PDF, for consistency
  between the two exported files.
- Values are CSV-escaped (quote-wrap and double any embedded quotes) — `Remarks`/`Description`-
  adjacent free text can contain commas/newlines (the same free-text fields `escapeHtml_` already
  treats as untrusted elsewhere in this app).
- Built as a plain string, downloaded via `Blob(['text/csv'])` + a temporary `<a download>` click
  (jsPDF has no CSV equivalent, so this path needs the manual Blob/anchor pattern) —
  `liquidation-export-YYYY-MM-DD.csv`.

Both downloads are triggered from the same button click, one after the other (PDF first, then
CSV) — two separate file-save prompts/downloads is expected browser behavior, not a bug to hide.

## Error handling
- Empty result set (no Reviewed/Authorized requests): message shown, no files generated.
- Per-receipt fetch failure: logged into the PDF's own missing-receipts summary, never surfaced as
  a blocking error — the export always completes with whatever receipts it could fetch.
- Total `getReceiptImageBase64` failure pattern mirrors every other action in this codebase:
  `{ success: false, error }`, never a thrown exception the client has to guess at.
- If the whole export flow throws unexpectedly (e.g. network failure mid-loop), the button's
  loading state is cleared in a `finally` and a generic error message shown — partial progress is
  discarded rather than producing a half-built PDF.

## Out of scope (explicitly not doing)
- No date-range filtering — always "everything currently Reviewed or Authorized as of button
  click," per user's choice.
- No single-request export — batch only.
- No role gating on the Export button itself.
- No placeholder pages for missing receipts — summary-note-only, per user's choice.
- No server-side PDF/CSV generation — both are built entirely client-side in `admin.js`, with the
  backend only supplying raw receipt bytes via the one new action.

## Testing
- `node --check` on `frontend/admin.js`.
- Manual: click Export with a mix of Reviewed and Authorized requests present, confirm both files
  download with correct filenames; confirm the PDF summary table and receipt pages match the data;
  confirm a request with a missing/deleted receipt shows up in the missing-receipts note instead of
  breaking the export; confirm CSV opens correctly in a spreadsheet app with one row per line item;
  confirm behavior when there are zero Reviewed/Authorized requests (no crash, clear message).
- Live-smoke-test `getReceiptImageBase64` via `curl` against the deployed `/exec` URL with a known
  receipt URL and with a bad/inaccessible one, same pattern used to verify prior backend additions.
