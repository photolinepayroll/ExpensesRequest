/**
 * Server-side validation (authoritative). Client-side checks exist only for
 * fast feedback; nothing here trusts the browser.
 */

function validateSubmission_(payload) {
  if (!payload || !payload.employeeId) {
    return 'Employee ID is missing.';
  }

  var employeeResult = getEmployeeByID(payload.employeeId);
  if (!employeeResult.found) {
    return 'Employee is invalid or inactive: ' + employeeResult.error;
  }

  if (!payload.lines || !Array.isArray(payload.lines) || payload.lines.length < 1) {
    return 'At least one line item is required.';
  }

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // Shared by both a line's start date and (for Timesheet) its cut-off end
  // date — same future/one-month-ago window applies to both.
  function dateSanityError_(rawValue, fieldLabel) {
    if (!rawValue || isNaN(new Date(rawValue).getTime())) {
      return fieldLabel + 'a valid date is required.';
    }
    var d = new Date(rawValue);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() > today.getTime()) {
      return fieldLabel + 'date cannot be in the future.';
    }
    if (d.getTime() < oneMonthAgo.getTime()) {
      return fieldLabel + 'date must be within the last 1 month.';
    }
    return null;
  }

  for (var i = 0; i < payload.lines.length; i++) {
    var line = payload.lines[i];
    var label = 'Line ' + (i + 1) + ': ';

    var startDateError = dateSanityError_(line.date, label);
    if (startDateError) return startDateError;

    if (CATEGORIES.indexOf(line.category) === -1) {
      return label + 'category must be one of ' + CATEGORIES.join(', ') + '.';
    }

    if (line.category === 'Timesheet') {
      var endDateError = dateSanityError_(line.cutoffEndDate, label + 'cut-off end date — ');
      if (endDateError) return endDateError;

      var startDate = new Date(line.date);
      var endDate = new Date(line.cutoffEndDate);
      if (endDate.getTime() < startDate.getTime()) {
        return label + 'cut-off end date cannot be before the start date.';
      }
    } else {
      if (!line.baseLocation || String(line.baseLocation).trim() === '') {
        return label + 'base location is required.';
      }
      var amount = Number(line.amount);
      if (!isFinite(amount) || amount <= 0) {
        return label + 'amount must be a positive number.';
      }
      if (!line.description || String(line.description).trim() === '') {
        return label + 'description is required.';
      }
    }

    if (!line.receiptUrl) {
      if (!line.file) {
        return label + 'a receipt photo is required.';
      }
      var mimeError = validateReceiptFile_(line.file);
      if (mimeError) return label + mimeError;
    }
  }

  return null; // no errors
}

function validateReceiptFile_(file) {
  if (!file.mimeType || ALLOWED_MIME_TYPES.indexOf(file.mimeType) === -1) {
    return 'receipt file type not allowed (' + file.mimeType + ').';
  }
  if (!file.base64Data) {
    return 'receipt file data is missing.';
  }
  // Base64 length approximates decoded byte size closely enough for a size gate.
  var approxBytes = Math.floor(file.base64Data.length * 3 / 4);
  if (approxBytes > MAX_RECEIPT_BYTES) {
    return 'receipt file exceeds the ' + (MAX_RECEIPT_BYTES / (1024 * 1024)) + 'MB limit.';
  }
  return null;
}

/**
 * A request can move to STATUS_REJECTED from any non-terminal stage, or
 * advance exactly one step forward through STAGE_ORDER. Anything else
 * (skipping a stage, moving backward, acting on a terminal request) is invalid.
 */
function validateStageTransition_(currentStatus, targetStage) {
  if (STAGE_ORDER.indexOf(targetStage) === -1 && targetStage !== STATUS_REJECTED) {
    return 'Unknown target stage: ' + targetStage;
  }

  if (currentStatus === STATUS_AUTHORIZED || currentStatus === STATUS_REJECTED) {
    return 'This request is already ' + currentStatus + ' and cannot be changed further.';
  }

  if (targetStage === STATUS_REJECTED) {
    return null; // rejection is allowed from Pending, Approved, or Reviewed
  }

  var currentIndex = STAGE_ORDER.indexOf(currentStatus);
  var targetIndex = STAGE_ORDER.indexOf(targetStage);

  if (currentIndex === -1) {
    return 'Cannot advance from unknown status: ' + currentStatus;
  }
  if (targetIndex !== currentIndex + 1) {
    return 'Cannot mark ' + targetStage + ' — this request is still ' + currentStatus + '.';
  }

  return null;
}
