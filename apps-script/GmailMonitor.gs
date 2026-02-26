// ===== GmailMonitor.gs =====
// Monitors a Gmail label for purchase agreement PDFs and auto-analyzes them

/**
 * Main function — called by time trigger every 5 minutes.
 * Checks for unread emails with PDF attachments in the configured Gmail label,
 * analyzes each PDF with Claude, and saves results to the Google Sheet.
 */
function checkGmailForContracts() {
  var config = getConfig();

  // Validate API key
  if (!config.apiKey) {
    Logger.log('ERROR: Anthropic API key not set. Run setApiKey() first.');
    return;
  }

  // Get or create Gmail labels
  var sourceLabel = GmailApp.getUserLabelByName(config.gmailLabel);
  if (!sourceLabel) {
    Logger.log('Creating Gmail label: "' + config.gmailLabel + '"');
    sourceLabel = GmailApp.createLabel(config.gmailLabel);
    return; // Nothing to process yet
  }

  var processedLabel = GmailApp.getUserLabelByName(config.processedLabel);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(config.processedLabel);
  }

  // Search for unread threads in the label (max 10 per run to stay within time limits)
  var searchQuery = 'label:' + config.gmailLabel.replace(/ /g, '-') + ' is:unread';
  var threads = GmailApp.search(searchQuery, 0, 10);

  if (threads.length === 0) {
    Logger.log('No unread emails in "' + config.gmailLabel + '"');
    return;
  }

  Logger.log('Found ' + threads.length + ' unread thread(s) to process.');

  var results = [];
  var errors = [];

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();

    for (var m = 0; m < messages.length; m++) {
      var message = messages[m];

      // Skip already-read messages
      if (!message.isUnread()) continue;

      var attachments = message.getAttachments();
      var pdfAttachments = [];

      for (var a = 0; a < attachments.length; a++) {
        var att = attachments[a];
        if (att.getContentType() === 'application/pdf' ||
            att.getName().toLowerCase().indexOf('.pdf') > -1) {
          pdfAttachments.push(att);
        }
      }

      if (pdfAttachments.length === 0) {
        Logger.log('No PDF attachments in: "' + message.getSubject() + '"');
        message.markRead();
        continue;
      }

      // Process each PDF attachment
      for (var p = 0; p < pdfAttachments.length; p++) {
        var pdf = pdfAttachments[p];
        var fileName = pdf.getName();

        try {
          // Check file size (keep under 20MB for base64 expansion)
          var sizeBytes = pdf.getSize();
          if (sizeBytes > 20 * 1024 * 1024) {
            throw new Error('PDF too large (' + Math.round(sizeBytes / 1024 / 1024) + 'MB). Max 20MB.');
          }

          Logger.log('Analyzing: ' + fileName + ' (' + Math.round(sizeBytes / 1024) + 'KB)');

          // Encode to base64
          var base64 = Utilities.base64Encode(pdf.getBytes());

          // Call Claude API with retry for rate limits
          var analysis = callClaudeWithRetry(base64);

          // Map to the same 22-column row format as the web app
          var row = mapAnalysisToRow(analysis, fileName, message.getSubject(), message.getFrom());

          // Check for duplicates before saving
          var address = row['Property Address'];
          var contractDate = row['Contract Date'];
          if (address && contractDate && isDuplicate(address, contractDate)) {
            Logger.log('Duplicate detected, skipping: ' + address + ' / ' + contractDate);
            results.push({
              fileName: fileName,
              subject: message.getSubject(),
              address: address,
              price: row['Offer Price'],
              skipped: true
            });
            continue;
          }

          // Save to sheet
          saveRowToSheet(row);

          results.push({
            fileName: fileName,
            subject: message.getSubject(),
            address: address,
            price: row['Offer Price'],
            skipped: false
          });

          Logger.log('Saved: ' + fileName + ' -> ' + address);

        } catch (err) {
          Logger.log('ERROR processing ' + fileName + ': ' + err.message);
          errors.push({
            fileName: fileName,
            subject: message.getSubject(),
            error: err.message
          });
        }
      }

      // Mark message as read
      message.markRead();
    }

    // Move thread: remove source label, add processed label
    thread.removeLabel(sourceLabel);
    thread.addLabel(processedLabel);
  }

  // Log summary
  Logger.log('Done. Processed: ' + results.length + ', Errors: ' + errors.length);

  // Send notification if configured
  if (config.notificationEmail && (results.length > 0 || errors.length > 0)) {
    sendNotification(config.notificationEmail, results, errors);
  }
}

/**
 * Map Claude's analysis JSON to the same 22-column row as the web app.
 * Column names must match exactly for Historical Offers to work.
 */
function mapAnalysisToRow(data, fileName, emailSubject, emailFrom) {
  var p = data.property || {};
  var pt = data.price_and_terms || {};
  var f = data.financing || {};
  var dt = data.dates || {};
  var s = data.settlement || {};
  var c = data.contingencies || {};
  var pa = data.parties || {};

  return {
    'Date Analyzed': Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm:ss a'),
    'Property Address': [p.street, p.city, p.state, p.zip].filter(Boolean).join(', ') || '',
    'Buyers': (pa.buyers || []).join(', '),
    'Sellers': (pa.sellers || []).join(', '),
    "Buyer's Agent": pa.selling_agent || '',
    'Agent Email': pa.selling_agent_email || '',
    'Agent Phone': pa.selling_agent_phone || '',
    'Listing Agent': pa.listing_agent || '',
    'Offer Price': pt.purchase_price || '',
    'Financing Type': f.type || '',
    'Loan Amount': f.loan_amount || '',
    'Down Payment': f.down_payment || '',
    'EMD Amount': pt.earnest_money_deposit || '',
    'Inspection': c.inspection === true ? 'Yes' : c.inspection === false ? 'Waived' : '',
    'Appraisal': c.appraisal === true ? 'Yes' : c.appraisal === false ? 'Waived' : '',
    'Financing Contingency': c.financing === true ? 'Yes' : c.financing === false ? 'Waived' : '',
    'Title Company': s.agent_or_company || '',
    'Contract Date': dt.contract_date || '',
    'Closing Date': dt.closing_date || '',
    'Possession Date': dt.possession_date || '',
    'Special Stipulations': (data.special_stipulations || '').substring(0, 500),
    'Contract Form': data.contract_form_type || ''
  };
}

/**
 * Check if an analysis for this address + contract date already exists in the sheet.
 */
function isDuplicate(address, contractDate) {
  if (!address) return false;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getLastRow() < 2) return false;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

  var addrCol = headers.indexOf('Property Address');
  var dateCol = headers.indexOf('Contract Date');

  var addrLower = address.toLowerCase().trim();

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][addrCol]).toLowerCase().trim() === addrLower) {
      if (!contractDate || String(data[i][dateCol]).trim() === String(contractDate).trim()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Send an email notification summarizing processed contracts.
 */
function sendNotification(email, results, errors) {
  var subject = 'Contract Analyzer: ' + results.length + ' processed';
  if (errors.length > 0) subject += ', ' + errors.length + ' failed';

  var body = 'Gmail Contract Monitor Summary\n';
  body += '================================\n\n';

  if (results.length > 0) {
    body += 'Successfully Analyzed (' + results.length + '):\n\n';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      body += '  ' + r.fileName;
      if (r.skipped) body += ' [DUPLICATE - skipped]';
      body += '\n';
      body += '    Address: ' + (r.address || 'N/A') + '\n';
      if (r.price) body += '    Price: $' + Number(r.price).toLocaleString() + '\n';
      body += '    Email: ' + r.subject + '\n\n';
    }
  }

  if (errors.length > 0) {
    body += 'Errors (' + errors.length + '):\n\n';
    for (var j = 0; j < errors.length; j++) {
      var e = errors[j];
      body += '  ' + e.fileName + '\n';
      body += '    Error: ' + e.error + '\n';
      body += '    Email: ' + e.subject + '\n\n';
    }
  }

  MailApp.sendEmail(email, subject, body);
}

// ===== TRIGGER MANAGEMENT =====

/**
 * Run once to install the 5-minute time trigger.
 */
function installTrigger() {
  // Remove existing triggers first
  removeTrigger();

  ScriptApp.newTrigger('checkGmailForContracts')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('Trigger installed: checkGmailForContracts runs every 5 minutes.');
}

/**
 * Remove the Gmail monitor trigger.
 */
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkGmailForContracts') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('Removed existing trigger.');
    }
  }
}

/**
 * Manual test: run checkGmailForContracts() once.
 * Use this to test and authorize permissions.
 */
function testProcessOneEmail() {
  checkGmailForContracts();
}
