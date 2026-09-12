# Batch PDF + CSV export design

## Revision note (v2)
This spec was revised after Tasks 1-5 of the original jsPDF-based plan were already
implemented and reviewed. The user pointed to a sibling project
(`photolinepayroll/attendance-app`'s `admin.html`) whose export feature uses a simpler,
already-proven pattern: a browser print-preview window instead of a client-generated PDF
file. This revision replaces the PDF-generation approach; the CSV approach and the overall
scope/access rules are unchanged from v1. Confirmed with the user via clarifying questions.

## Context
Payroll/record-keeping has no way to pull a consolidated view of processed requests — each
`Reviewed`/`Authorized` (Disbursed) request has to be opened individually in `admin.html` to
see its receipts and detail. This feature adds a one-click batch export: a CSV (line-item
detail) plus a printable report (summary + one receipt image per page), covering all
currently `Reviewed` or `Authorized` requests.

## Scope (unchanged from v1)
Batch export only — not a single-request export, not date-range filtered. One "Export
Reviewed/Disbursed" button in `admin.html`'s queue always exports every request currently in
`Reviewed` **or** `Authorized` status, at the moment the button is clicked. Visible to any
logged-in approver role — no role gating on the button itself, consistent with this app's
existing security model.

One combined button drives both outputs (not two separate buttons like the reference app):
clicking it downloads the CSV, then opens the print-preview report in a new tab, in one action.

## Data fetching (`admin.js`) — unchanged from v1
`admin.js` calls `getAllRequestsForPayroll` twice (`'Reviewed'`, `'Authorized'`) and merges the
two result arrays — no backend change needed there. Each request object already carries its
joined `lines` array.

## PDF generation — REVISED: print-preview instead of jsPDF

**No new backend action, no PDF library.** The originally-built `getReceiptImageBase64`
backend action (added in Task 1) is being reverted — it exists only to get raw pixel bytes
past canvas-tainting for jsPDF's `addImage`, which is no longer needed once nothing draws to
a canvas.

Instead, clicking Export (after downloading the CSV — see below) builds one HTML document as
a string, entirely client-side, and opens it via `window.open('', '_blank')` +
`win.document.write(html)` — the same pattern already proven in the reference app. That
window shows:

1. **A summary section** at the top: one row per request — RequestID, Employee, Status
   (via `STATUS_DISPLAY_LABELS`, so `Authorized` reads "Disbursed"), TotalAmount,
   Approved/Reviewed/Authorized By+Date, CreditingDate — as a plain HTML `<table>`, styled
   with print-friendly CSS (borders, readable font sizes, matches the app's existing navy
   brand color for headers per `styles.css`'s design tokens).
2. **One full-size receipt image per page after that** — each receipt gets its own `<div>`
   with `page-break-before: always` (via `@media print` CSS, matching the reference app's
   `.page`/`@page` pattern), a caption (RequestID, Employee, line Date, Category, Amount)
   above the image, and the image itself as a plain `<img src="...">` pointing at the
   **existing** `driveThumbnailUrl_()`-rewritten URL (`https://drive.google.com/thumbnail?
   id=<ID>&sz=w2000`) — the same cross-origin-safe thumbnail endpoint already used by the
   on-screen receipt preview modal (`common.js`). Because this is a real `<img>` tag in a
   real browser tab (not drawn into a `<canvas>` for embedding), there is no CORS/tainting
   concern at all — this is exactly why no backend byte-fetching action is needed.
   One full-size image per page (not a compact multi-per-page grid) — this app's receipts
   need to stay legible (matches the existing compression requirement's "keep text/numbers
   readable" goal), so bigger is better here than the reference app's denser card-grid style.
3. **A missing-receipts note** at the end, listing any line with no `ReceiptFileURL` — no
   placeholder page for those, same "don't hide it, don't fake it" rule as v1.
4. **Two floating "no-print" buttons** (top-right, hidden during actual printing via
   `@media print { .no-print { display:none } }`): "🖨️ Print / Save PDF" (`onclick="window.print()"`,
   which surfaces the browser's own "Save as PDF" destination — no library needed to
   produce an actual PDF file) and "✕ Close" (`onclick="window.close()"`).

Because the browser's own print/layout engine paginates the summary table and inserts page
breaks via CSS, there's no manual y-position tracking, no per-row height math, no text
truncation/ellipsis logic, and no sequential-fetch-loop needed to avoid a shared execution
quota — the whole receipt-gathering complexity from v1's `addReceiptPages_` disappears, since
nothing needs to be *fetched* by this app at all; the browser fetches each `<img src>`
natively, in parallel, exactly as it already does for the on-screen preview modal.

## CSV generation — unchanged from v1
Kept exactly as already built in Task 3: `csvField_` (RFC4180 escaping), `EXPORT_CSV_HEADERS`,
`buildExportCsv_` (one row per line item), `downloadTextFile_` (Blob + temporary `<a
download>`). No changes to this code. Filename: `liquidation-export-YYYY-MM-DD.csv`.

## Error handling
- Empty result set (no Reviewed/Authorized requests): message shown, nothing downloaded, no
  print window opened.
- A receipt image that fails to load in the print window (broken link, deleted file) simply
  shows the browser's normal broken-image icon on that one page — this is an accepted,
  visible-not-hidden failure mode consistent with "don't hide it, don't fake it"; it does not
  block the rest of the report, and the missing-receipts note (item 3 above) is populated
  from `ReceiptFileURL` being absent, not from image-load success (the browser has no
  synchronous way to know if a cross-origin thumbnail 404s before print time, so this note
  only tracks "no URL on file", the same limitation the reference app has).
- If `window.open('', '_blank')` returns `null` (popup blocked), show an inline error message
  telling the approver to allow popups for this site — matches the reference app's own
  `if(win){...}` guard, extended with a user-visible message instead of silently doing
  nothing.

## Out of scope (explicitly not doing)
- No date-range filtering.
- No single-request export.
- No role gating on the Export button itself.
- No jsPDF or any other PDF-generation library.
- No backend action for fetching receipt bytes (removed after this revision).
- No compact multi-receipt-per-page grid layout.
- No separate "Export CSV" / "Print PDF" buttons — one combined action.

## Testing
- `node --check` on `frontend/admin.js`.
- Manual: click Export with a mix of Reviewed and Authorized requests present, confirm the
  CSV downloads correctly (unchanged from v1's already-verified behavior) and a new tab opens
  showing the summary table followed by one receipt page per line, each captioned correctly;
  confirm print preview (Ctrl+P or the in-page "Print / Save PDF" button) paginates cleanly
  with each receipt on its own page; confirm a request with a missing receipt shows up in the
  missing-receipts note; confirm behavior when there are zero Reviewed/Authorized requests;
  confirm behavior when the browser blocks the popup.
