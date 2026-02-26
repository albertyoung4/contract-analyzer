// ===== ClaudeAPI.gs =====
// Sends PDF attachments to the Anthropic Claude API for contract analysis

// System prompt — identical to the web app
var SYSTEM_PROMPT = 'You are a real estate contract analyst. Extract key details from the purchase agreement text provided and return ONLY valid JSON with no markdown formatting, no code fences, and no explanation.\n\nUse this exact JSON structure. For any field not found in the document, use null. Do not guess or fabricate values.\n\n{\n  "property": {\n    "street": "string",\n    "city": "string",\n    "state": "string (2-letter abbreviation)",\n    "zip": "string",\n    "county": "string",\n    "legal_description": "string (brief, if available)",\n    "parcel_id": "string (tax PIN/parcel number if available)"\n  },\n  "price_and_terms": {\n    "purchase_price": "number",\n    "earnest_money_deposit": "number",\n    "earnest_money_holder": "string",\n    "due_diligence_fee": "number (NC-specific, null if not applicable)",\n    "option_fee": "number (TX-specific, null if not applicable)",\n    "option_period_days": "number (TX-specific, null if not applicable)"\n  },\n  "financing": {\n    "type": "string (Conventional, FHA, VA, USDA, Cash, Seller Financing, Other)",\n    "loan_amount": "number",\n    "down_payment": "number",\n    "down_payment_percent": "number",\n    "interest_rate": "number (if specified)",\n    "loan_term_years": "number (if specified)",\n    "seller_paid_closing_costs": "string (dollar amount or percentage description)",\n    "seller_concessions": "string (describe any other seller concessions)"\n  },\n  "dates": {\n    "contract_date": "string (YYYY-MM-DD)",\n    "due_diligence_deadline": "string (YYYY-MM-DD, inspection/option period end)",\n    "appraisal_deadline": "string (YYYY-MM-DD, if specified separately)",\n    "financing_deadline": "string (YYYY-MM-DD, if specified)",\n    "closing_date": "string (YYYY-MM-DD)",\n    "possession_date": "string (YYYY-MM-DD or description like \'At closing\')"\n  },\n  "settlement": {\n    "agent_or_company": "string (settlement agent, title company, or closing attorney)",\n    "location": "string (if specified)"\n  },\n  "home_warranty": {\n    "included": "boolean",\n    "amount": "number",\n    "paid_by": "string (Buyer, Seller, or description)",\n    "company": "string"\n  },\n  "property_details": {\n    "personal_property_included": ["list of items included in sale"],\n    "personal_property_excluded": ["list of items excluded from sale"],\n    "fixtures_notes": "string"\n  },\n  "contingencies": {\n    "inspection": "boolean",\n    "appraisal": "boolean",\n    "financing": "boolean",\n    "sale_of_home": "boolean",\n    "other": ["list of any other contingency descriptions"]\n  },\n  "parties": {\n    "buyers": ["list of buyer full names"],\n    "sellers": ["list of seller full names"],\n    "listing_agent": "string",\n    "listing_agent_email": "string",\n    "listing_agent_phone": "string",\n    "listing_brokerage": "string",\n    "selling_agent": "string (buyer\'s agent)",\n    "selling_agent_email": "string",\n    "selling_agent_phone": "string",\n    "selling_brokerage": "string"\n  },\n  "special_stipulations": "string (verbatim or summarized additional provisions, special stipulations, or addenda references)",\n  "contract_form_type": "string (e.g., \'NC Offer to Purchase and Contract - Form 2-T\', \'GAR Purchase and Sale Agreement\', \'TREC 1-4 Family Residential Contract\', etc.)"\n}\n\nImportant extraction rules:\n1. For dates, convert all formats to YYYY-MM-DD. If only a description is given (e.g., "30 days from effective date"), include the description as a string.\n2. For monetary amounts, return as numbers without currency symbols or commas.\n3. For contingencies, mark as true if the contingency is present/active, false if explicitly waived, null if not mentioned.\n4. For NC contracts: look for "Due Diligence Fee" and "Due Diligence Period" specifically.\n5. For TX contracts: look for "Option Fee" and "Option Period" specifically.\n6. The "special_stipulations" field should capture any additional terms, addenda references, or special provisions.\n7. If the document appears to be a specific state form, identify it in "contract_form_type".';

/**
 * Send a PDF to Claude for contract analysis.
 * Uses the document content type to send the raw PDF — no text extraction needed.
 * @param {string} base64Data - Base64-encoded PDF bytes
 * @returns {Object} Parsed JSON analysis result
 */
function analyzeContractPDF(base64Data) {
  var config = getConfig();

  var payload = {
    model: config.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64Data
          }
        },
        {
          type: 'text',
          text: 'Extract all contract details from this real estate purchase agreement PDF.'
        }
      ]
    }]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var statusCode = response.getResponseCode();

  if (statusCode === 429 || statusCode === 529) {
    throw new Error('RATE_LIMITED');
  }

  if (statusCode !== 200) {
    var errorText = response.getContentText();
    try {
      var errorBody = JSON.parse(errorText);
      throw new Error('Claude API error (' + statusCode + '): ' + (errorBody.error ? errorBody.error.message : errorText));
    } catch (e) {
      if (e.message.indexOf('Claude API error') === 0) throw e;
      throw new Error('Claude API error (' + statusCode + '): ' + errorText);
    }
  }

  var data = JSON.parse(response.getContentText());
  var content = data.content && data.content[0] ? data.content[0].text : '';

  // Strip markdown code fences if present
  var jsonStr = content.trim();
  if (jsonStr.indexOf('```') === 0) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  return JSON.parse(jsonStr);
}

/**
 * Call Claude with retry and exponential backoff for rate limits
 * @param {string} base64Data - Base64-encoded PDF
 * @param {number} [maxRetries=3] - Max retry attempts
 * @returns {Object} Analysis result
 */
function callClaudeWithRetry(base64Data, maxRetries) {
  maxRetries = maxRetries || 3;
  var backoffMs = 5000;

  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return analyzeContractPDF(base64Data);
    } catch (err) {
      if (err.message === 'RATE_LIMITED' && attempt < maxRetries) {
        Logger.log('Rate limited on attempt ' + attempt + '. Waiting ' + (backoffMs / 1000) + 's...');
        Utilities.sleep(backoffMs);
        backoffMs *= 2;
      } else {
        throw err;
      }
    }
  }
}
