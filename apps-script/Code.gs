// ===== Code.gs =====
// Main entry points: doPost (web app save), doGet (JSONP history), saveRowToSheet (shared)

/**
 * Shared function: saves a row object to the active sheet.
 * Used by both doPost (web app) and checkGmailForContracts (email monitor).
 */
function saveRowToSheet(rowObject) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // If sheet is empty, create header row from the keys
  if (sheet.getLastRow() === 0) {
    var keys = Object.keys(rowObject);
    sheet.appendRow(keys);
    sheet.getRange(1, 1, 1, keys.length).setFontWeight('bold');
  }

  // Get headers and build row array in correct column order
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rowArray = headers.map(function(header) {
    return rowObject[header] !== undefined ? rowObject[header] : '';
  });

  sheet.appendRow(rowArray);
}

/**
 * POST endpoint — called by the web app to save analysis results.
 * Receives JSON data via form field or request body.
 */
function doPost(e) {
  var jsonStr = e.parameter.data || e.postData.contents;
  var data = JSON.parse(jsonStr);
  saveRowToSheet(data);
  return ContentService
    .createTextOutput(JSON.stringify({status: 'success'}))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET endpoint — called by the web app for Historical Offers (JSONP).
 * Supports two modes:
 *   ?mode=all&callback=fn         → returns ALL rows (newest first)
 *   ?address=123+Main&callback=fn → returns rows matching that address
 */
function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var callback = e.parameter.callback || 'callback';
  var mode = e.parameter.mode || '';

  // Mode: return all rows (for History tab)
  if (mode === 'all') {
    if (sheet.getLastRow() < 2) {
      return ContentService.createTextOutput(callback + '([])')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

    var allRows = [];
    for (var i = 0; i < data.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = data[i][j];
      }
      allRows.push(obj);
    }

    // Return newest first
    allRows.reverse();

    return ContentService.createTextOutput(callback + '(' + JSON.stringify(allRows) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // Default mode: address-based matching (for Historical Offers per-property)
  var address = (e.parameter.address || '').toLowerCase().trim();

  if (!address || sheet.getLastRow() < 2) {
    return ContentService.createTextOutput(callback + '([])')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var addrCol = headers.indexOf('Property Address');

  var matches = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][addrCol]).toLowerCase().trim() === address) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = data[i][j];
      }
      matches.push(obj);
    }
  }

  return ContentService.createTextOutput(callback + '(' + JSON.stringify(matches) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
