// Backend API URL — your Apps Script web app's /exec URL.
// Update this if you ever redeploy and get a new URL.
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyymBuUmMtShtXcw9YB8z-L9xsNwxIhnDZFSZJbt36wpWjyAQz4tDxZi-8CrVonRLoiSg/exec';

// Published (View → Publish to web, CSV) Google Sheet used as the attendance
// source for the Meal Allowance utility. Fetched directly client-side.
var ATTENDANCE_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRZHyqa-jPGZYgystWjoXi8nG1TCvmodSqXT675cY4xpA5jpWWVw-lYSBoLSbgWS0LNHgvyXxLcgZWt/pub?gid=0&single=true&output=csv';

// Published (View → Publish to web, CSV) reference table of store locations
// (coordinates, regional meal-allowance bracket, and per-store assigned
// Tech/Area Head personal amounts) used to auto-resolve the Meal Allowance
// utility's Regular Meal Allowance from attendance GPS. Fetched client-side.
var STORE_COORDINATES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQFtMwuPhOPY7h4GlrGI4DhTrnHx4OKBcEIizjwAH53N1NWnnrdxZftEnNQmDePhtEvFPoLjkRd61TX/pub?gid=230789532&single=true&output=csv';

// Published (View → Publish to web, CSV) directory mapping each store to its
// assigned Area Head/Technical/Audit staff (by Biometric ID) plus the 3 fixed
// org-wide approvers. Used to resolve an employee's category ("Mother Branch")
// and gate the Employee Utilities tab. Columns have duplicate/blank headers —
// read by fixed column index (see employee.js), not by header name.
var STORE_DIRECTORY_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQFtMwuPhOPY7h4GlrGI4DhTrnHx4OKBcEIizjwAH53N1NWnnrdxZftEnNQmDePhtEvFPoLjkRd61TX/pub?gid=1184189088&single=true&output=csv';
