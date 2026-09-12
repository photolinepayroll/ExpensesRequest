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
