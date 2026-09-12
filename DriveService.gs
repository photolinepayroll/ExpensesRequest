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

// Extracts a Drive file ID from any of the URL shapes this app produces
// (driveFile.getUrl()'s .../file/d/<ID>/view, or a thumbnail/uc URL) — same
// pattern as frontend/common.js's driveThumbnailUrl_/driveDownloadUrl_, kept
// in sync manually since this runs server-side and those run client-side.
function extractDriveFileId_(url) {
  var match = String(url || '').match(/[-\w]{25,}/);
  return match ? match[0] : null;
}

// Walks a file's parent-folder chain up to the root, confirming it actually
// lives under this app's Drive root (uploadReceiptFile_'s
// <DRIVE_ROOT_FOLDER_ID>/<EmployeeID>/<RequestID>/<file> tree) rather than
// being some other file the deploying account happens to have access to.
// Written as a general ancestor walk rather than hardcoding "2 levels up"
// so it keeps working if that folder depth ever changes.
function isUnderDriveRoot_(file) {
  var rootId = getDriveRootFolder_().getId();
  var current = file;
  var guard = 0; // Drive folder chains are shallow in practice; this just prevents an infinite loop if Drive ever returns a cycle
  while (guard++ < 10) {
    var parents = current.getParents();
    if (!parents.hasNext()) {
      return false;
    }
    var parent = parents.next();
    if (parent.getId() === rootId) {
      return true;
    }
    current = parent;
  }
  return false;
}

// Returns a receipt's raw bytes as base64 so client-side PDF generation
// (jsPDF) can embed it directly — a plain <img src> works cross-origin for
// on-screen display (see driveThumbnailUrl_), but pulling a cross-origin
// image into a canvas for jsPDF without a matching CORS response taints the
// canvas. Read-only; never throws (used in a loop across many receipts in
// the batch export, so one missing/deleted file must not abort the whole
// export) — see RequestService.gs's export caller for how failures surface.
// Scoped to this app's own Drive root (isUnderDriveRoot_) so it can't be used
// to fetch arbitrary files the deploying account happens to have access to;
// out-of-scope files fail with the same generic error as a missing file, so
// a caller can't distinguish "doesn't exist" from "exists but isn't yours".
function getReceiptImageBase64(driveUrl) {
  var fileId = extractDriveFileId_(driveUrl);
  if (!fileId) {
    return { success: false, error: 'Invalid receipt URL.' };
  }
  try {
    var driveFile = DriveApp.getFileById(fileId);
    if (!isUnderDriveRoot_(driveFile)) {
      return { success: false, error: 'Receipt not found or inaccessible.' };
    }
    var blob = driveFile.getBlob();
    return {
      success: true,
      base64: Utilities.base64Encode(blob.getBytes()),
      mimeType: blob.getContentType()
    };
  } catch (e) {
    return { success: false, error: 'Receipt not found or inaccessible.' };
  }
}
