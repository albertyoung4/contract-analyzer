// ===== HubSpotAPI.gs =====
// Looks up acquisition price from HubSpot deals by matching property address to deal name

/**
 * Search HubSpot deals by address and return the acquisition price.
 * Matches the deal name against the property address (street portion).
 * @param {string} address - Property address to search for
 * @returns {Object} { found: boolean, acquisition_price: number|null, deal_name: string|null }
 */
function lookupAcquisitionPrice(address) {
  var config = getConfig();

  if (!config.hubspotApiKey) {
    return { found: false, error: 'HubSpot API key not configured. Run setHubSpotApiKey() in Apps Script.' };
  }

  if (!address || !address.trim()) {
    return { found: false, error: 'No address provided' };
  }

  var propertyName = config.hubspotDealProperty;

  // Extract just the street address for matching (first part before city/state/zip)
  var searchTerm = address.split(',')[0].trim();

  // Search HubSpot deals by deal name
  var searchPayload = {
    filterGroups: [{
      filters: [{
        propertyName: 'dealname',
        operator: 'CONTAINS_TOKEN',
        value: searchTerm
      }]
    }],
    properties: ['dealname', propertyName, 'amount'],
    limit: 5
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + config.hubspotApiKey
    },
    payload: JSON.stringify(searchPayload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals/search', options);
  var statusCode = response.getResponseCode();

  if (statusCode !== 200) {
    var errorText = response.getContentText();
    Logger.log('HubSpot API error (' + statusCode + '): ' + errorText);

    // If CONTAINS_TOKEN fails, try a broader search
    if (statusCode === 400) {
      return lookupAcquisitionPriceFallback(searchTerm, config, propertyName);
    }

    return { found: false, error: 'HubSpot API error (' + statusCode + ')' };
  }

  var data = JSON.parse(response.getContentText());
  var results = data.results || [];

  if (results.length === 0) {
    // Try fallback with broader matching
    return lookupAcquisitionPriceFallback(searchTerm, config, propertyName);
  }

  // Find best match - prefer exact street match
  var bestMatch = findBestDealMatch(results, searchTerm, propertyName);
  return bestMatch;
}

/**
 * Fallback search using a simpler query when CONTAINS_TOKEN doesn't work
 */
function lookupAcquisitionPriceFallback(searchTerm, config, propertyName) {
  // Try searching with just key words from the address
  var words = searchTerm.replace(/[^\w\s]/g, '').split(/\s+/).filter(function(w) {
    // Skip common words and numbers-only tokens
    return w.length > 2 && !/^\d+$/.test(w);
  });

  if (words.length === 0) {
    return { found: false, error: 'Could not extract search terms from address' };
  }

  // Use the street name word(s) for search
  var searchPayload = {
    query: searchTerm,
    properties: ['dealname', propertyName, 'amount'],
    limit: 10
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + config.hubspotApiKey
    },
    payload: JSON.stringify(searchPayload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals/search', options);

  if (response.getResponseCode() !== 200) {
    return { found: false, error: 'HubSpot search failed' };
  }

  var data = JSON.parse(response.getContentText());
  var results = data.results || [];

  if (results.length === 0) {
    return { found: false, error: 'No matching deal found for: ' + searchTerm };
  }

  return findBestDealMatch(results, searchTerm, propertyName);
}

/**
 * Find the best matching deal from search results
 */
function findBestDealMatch(results, searchTerm, propertyName) {
  var normalizedSearch = searchTerm.toLowerCase().replace(/[^\w\s]/g, '').trim();

  var bestMatch = null;
  var bestScore = -1;

  for (var i = 0; i < results.length; i++) {
    var deal = results[i];
    var dealName = (deal.properties.dealname || '').toLowerCase().replace(/[^\w\s]/g, '').trim();

    // Score: exact match > contains > partial word match
    var score = 0;
    if (dealName === normalizedSearch) {
      score = 100;
    } else if (dealName.indexOf(normalizedSearch) !== -1 || normalizedSearch.indexOf(dealName) !== -1) {
      score = 50;
    } else {
      // Check word overlap
      var searchWords = normalizedSearch.split(/\s+/);
      var dealWords = dealName.split(/\s+/);
      var matches = 0;
      for (var j = 0; j < searchWords.length; j++) {
        for (var k = 0; k < dealWords.length; k++) {
          if (searchWords[j] === dealWords[k]) matches++;
        }
      }
      score = matches;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = deal;
    }
  }

  if (!bestMatch || bestScore === 0) {
    return { found: false, error: 'No matching deal found for: ' + searchTerm };
  }

  var acquisitionPrice = bestMatch.properties[propertyName];
  // Fall back to 'amount' if custom property is empty
  if (acquisitionPrice === null || acquisitionPrice === undefined || acquisitionPrice === '') {
    acquisitionPrice = bestMatch.properties.amount;
  }

  return {
    found: true,
    acquisition_price: acquisitionPrice ? parseFloat(acquisitionPrice) : null,
    deal_name: bestMatch.properties.dealname,
    deal_id: bestMatch.id
  };
}
