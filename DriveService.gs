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

/** Creates (or finds) <root>/<EmployeeID>/<RequestID> and returns that Drive folder. */
function ensureRequestFolder_(employeeId, requestId) {
  var root = getDriveRootFolder_();
  var employeeFolder = getOrCreateFolder_(root, String(employeeId));
  return getOrCreateFolder_(employeeFolder, String(requestId));
}

/**
 * Saves one receipt into an already-resolved request folder and returns its Drive URL.
 * Idempotent per (folder, lineId, filename): a retried upload of the same photo returns the
 * existing file's URL instead of creating a second copy.
 */
function uploadReceiptFileToFolder_(folder, lineId, file) {
  var fileName = lineId + '_' + file.filename;
  var existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    return existing.next().getUrl();
  }

  var bytes = Utilities.base64Decode(file.base64Data);
  var blob = Utilities.newBlob(bytes, file.mimeType, fileName);

  var driveFile = folder.createFile(blob);
  driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return driveFile.getUrl();
}

/** Decodes and saves one receipt file, returning its Drive URL. (Legacy path: file arrives inside the submit payload.) */
function uploadReceiptFile_(employeeId, requestId, lineId, file) {
  return uploadReceiptFileToFolder_(ensureRequestFolder_(employeeId, requestId), lineId, file);
}
