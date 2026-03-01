// ===== MetabaseAPI.gs =====
// Looks up deal information and bids from PostgreSQL via Metabase API
// Uses the /api/dataset endpoint to run native queries through Metabase's
// existing SSH tunnel connection to the database.

/**
 * Search for a property's deal info and bids by address.
 * Returns dispo agent, acquisition price, listing price, and all logged bids.
 * @param {string} address - Full property address from the contract
 * @returns {Object} { found, dispo_agent, acquisition_price, listing_price, matched_address, bids[] }
 */
function lookupAcquisitionPrice(address) {
  var config = getConfig();

  if (!config.metabaseApiKey) {
    return { found: false, error: 'Metabase API key not configured. Run setMetabaseApiKey() in Apps Script.' };
  }

  if (!address || !address.trim()) {
    return { found: false, error: 'No address provided' };
  }

  var parsed = parseAddress(address);

  // Strategy 1: Try matching on normalized_full_address
  var result = queryDealInfoByNormalized(parsed, config);
  if (result.found) {
    result.bids = lookupBids(result.property_id, config);
    delete result.property_id;
    return result;
  }

  // Strategy 2: Try matching on component columns (house_number + street)
  result = queryDealInfoByComponents(parsed, config);
  if (result.found) {
    result.bids = lookupBids(result.property_id, config);
    delete result.property_id;
    return result;
  }

  // Strategy 3: Broader search using just street name
  result = queryDealInfoByStreet(parsed, config);
  if (result.found) {
    result.bids = lookupBids(result.property_id, config);
    delete result.property_id;
    return result;
  }

  return { found: false, error: 'No matching property found for: ' + address };
}

/**
 * Parse a street address into components.
 */
function parseAddress(address) {
  var parts = address.split(',').map(function(p) { return p.trim(); });

  var street = (parts[0] || '').trim();
  var city = (parts[1] || '').trim();

  var stateZip = (parts[2] || parts[1] || '').trim();
  var stateMatch = stateZip.match(/([A-Za-z]{2})\s*(\d{5})?/);
  var state = stateMatch ? stateMatch[1] : '';
  var zip = stateMatch ? (stateMatch[2] || '') : '';

  if (city && city.match(/^[A-Z]{2}\s*\d{5}$/)) {
    state = city.match(/[A-Z]{2}/)[0];
    zip = city.match(/\d{5}/)[0];
    city = '';
  }

  var streetMatch = street.match(/^(\d+)\s+(.+)$/);
  var houseNumber = streetMatch ? streetMatch[1] : '';
  var streetName = streetMatch ? streetMatch[2] : street;

  return {
    full: address,
    street: street,
    houseNumber: houseNumber,
    streetName: streetName,
    city: city,
    state: state,
    zip: zip
  };
}

// --- Deal Info Select (includes JOIN to vw_users for dispo agent) ---

var DEAL_INFO_SELECT = "SELECT p.id AS property_id, p.acquisition_price, p.price AS listing_price, " +
  "p.house_number, p.street, p.city, p.state, p.zip, p.normalized_full_address, " +
  "u.first_name || ' ' || u.surname AS dispo_agent " +
  "FROM properties p " +
  "LEFT JOIN vw_users u ON p.disposition_agent_id = u.id ";

function queryDealInfoByNormalized(parsed, config) {
  var searchTerm = (parsed.houseNumber + ' ' + parsed.streetName).toLowerCase().trim();

  var query = DEAL_INFO_SELECT +
    "WHERE p.normalized_full_address LIKE '%" + escapeSql(searchTerm) + "%' " +
    "LIMIT 5";

  var rows = runMetabaseQuery(query, config);
  return pickBestMatch(rows, parsed);
}

function queryDealInfoByComponents(parsed, config) {
  if (!parsed.houseNumber) return { found: false };

  var query = DEAL_INFO_SELECT +
    "WHERE LOWER(TRIM(p.house_number)) = '" + escapeSql(parsed.houseNumber.toLowerCase()) + "' " +
    "AND LOWER(TRIM(p.street)) LIKE '%" + escapeSql(parsed.streetName.toLowerCase().split(' ')[0]) + "%' " +
    "LIMIT 5";

  var rows = runMetabaseQuery(query, config);
  return pickBestMatch(rows, parsed);
}

function queryDealInfoByStreet(parsed, config) {
  var words = parsed.streetName.split(/\s+/).filter(function(w) {
    return w.length > 2 && !/^(rd|st|ave|blvd|dr|ln|ct|cir|way|pl|ter|hwy|pkwy)$/i.test(w);
  });
  if (words.length === 0) return { found: false };

  var searchWord = words[0].toLowerCase();
  var query = DEAL_INFO_SELECT +
    "WHERE LOWER(p.street) LIKE '%" + escapeSql(searchWord) + "%' " +
    (parsed.houseNumber ? "AND LOWER(TRIM(p.house_number)) = '" + escapeSql(parsed.houseNumber.toLowerCase()) + "' " : "") +
    "LIMIT 10";

  var rows = runMetabaseQuery(query, config);
  return pickBestMatch(rows, parsed);
}

// --- Bids lookup by property_id ---

/**
 * Get all bids/offers for a property by its ID.
 */
function lookupBids(propertyId, config) {
  if (!propertyId) return [];

  var query = "SELECT o.inserted_at AS bid_timestamp, " +
    "bu.first_name || ' ' || bu.surname AS bidder_name, " +
    "o.price AS offer_price, " +
    "o.price - p.acquisition_price AS spread " +
    "FROM vw_offers o " +
    "JOIN properties p ON o.property_id = p.id " +
    "LEFT JOIN vw_users bu ON o.offeror_id = bu.id " +
    "WHERE o.property_id = '" + escapeSql(String(propertyId)) + "' " +
    "ORDER BY o.inserted_at DESC " +
    "LIMIT 50";

  return runMetabaseQuery(query, config);
}

// --- Shared utilities ---

/**
 * Pick the best matching property from query results.
 */
function pickBestMatch(rows, parsed) {
  if (!rows || rows.length === 0) return { found: false };

  var bestMatch = null;
  var bestScore = -1;

  var searchHouse = (parsed.houseNumber || '').toLowerCase().trim();
  var searchStreet = (parsed.streetName || '').toLowerCase().trim();
  var searchCity = (parsed.city || '').toLowerCase().trim();
  var searchState = (parsed.state || '').toLowerCase().trim();
  var searchZip = (parsed.zip || '').trim();

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rowHouse = String(row.house_number || '').toLowerCase().trim();
    var rowStreet = String(row.street || '').toLowerCase().trim();
    var rowCity = String(row.city || '').toLowerCase().trim();
    var rowState = String(row.state || '').toLowerCase().trim();
    var rowZip = String(row.zip || '').trim();

    var score = 0;
    if (searchHouse && rowHouse === searchHouse) score += 40;
    if (searchStreet && rowStreet) {
      if (rowStreet === searchStreet) {
        score += 30;
      } else if (rowStreet.indexOf(searchStreet) !== -1 || searchStreet.indexOf(rowStreet) !== -1) {
        score += 20;
      } else {
        var sWords = searchStreet.split(/\s+/);
        var rWords = rowStreet.split(/\s+/);
        for (var j = 0; j < sWords.length; j++) {
          for (var k = 0; k < rWords.length; k++) {
            if (sWords[j] === rWords[k] && sWords[j].length > 2) score += 5;
          }
        }
      }
    }
    if (searchCity && rowCity && rowCity === searchCity) score += 15;
    if (searchState && rowState && rowState === searchState) score += 10;
    if (searchZip && rowZip && rowZip === searchZip) score += 5;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = row;
    }
  }

  if (!bestMatch || bestScore < 20) return { found: false };

  var matchedAddr = bestMatch.normalized_full_address ||
    ((bestMatch.house_number || '') + ' ' + (bestMatch.street || '') + ', ' +
     (bestMatch.city || '') + ', ' + (bestMatch.state || '') + ' ' + (bestMatch.zip || '')).trim();

  return {
    found: true,
    property_id: bestMatch.property_id,
    dispo_agent: bestMatch.dispo_agent || null,
    acquisition_price: bestMatch.acquisition_price != null ? parseFloat(bestMatch.acquisition_price) : null,
    listing_price: bestMatch.listing_price != null ? parseFloat(bestMatch.listing_price) : null,
    matched_address: matchedAddr,
    match_score: bestScore
  };
}

/**
 * Execute a native SQL query via the Metabase API.
 */
function runMetabaseQuery(query, config) {
  var payload = {
    database: config.metabaseDatabaseId,
    type: 'native',
    native: { query: query }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': config.metabaseApiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(config.metabaseUrl + '/api/dataset', options);
  var statusCode = response.getResponseCode();

  if (statusCode !== 202 && statusCode !== 200) {
    Logger.log('Metabase API error (' + statusCode + '): ' + response.getContentText());
    return [];
  }

  var data = JSON.parse(response.getContentText());
  var cols = (data.data && data.data.cols) ? data.data.cols.map(function(c) { return c.name; }) : [];
  var rawRows = (data.data && data.data.rows) ? data.data.rows : [];

  var results = [];
  for (var i = 0; i < rawRows.length; i++) {
    var obj = {};
    for (var j = 0; j < cols.length; j++) {
      obj[cols[j]] = rawRows[i][j];
    }
    results.push(obj);
  }

  return results;
}

/**
 * Escape single quotes in SQL to prevent injection.
 */
function escapeSql(str) {
  return String(str).replace(/'/g, "''");
}
