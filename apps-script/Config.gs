// ===== CONFIG.gs =====
// Reads settings from Script Properties (Project Settings > Script properties)

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    apiKey: props.getProperty('ANTHROPIC_API_KEY'),
    gmailLabel: props.getProperty('GMAIL_LABEL') || 'Purchase Agreements',
    processedLabel: props.getProperty('PROCESSED_LABEL') || 'Purchase Agreements/Processed',
    notificationEmail: props.getProperty('NOTIFICATION_EMAIL') || '',
    model: props.getProperty('CLAUDE_MODEL') || 'claude-sonnet-4-20250514',
    hubspotApiKey: props.getProperty('HUBSPOT_API_KEY'),
    hubspotDealProperty: props.getProperty('HUBSPOT_DEAL_PROPERTY') || 'current_acquisiton_price'
  };
}

// Run this once from the editor to securely store your Anthropic API key
function setApiKey() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Enter your Anthropic API key:');
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', result.getResponseText().trim());
    ui.alert('API key saved securely.');
  }
}

// Run this once to securely store your HubSpot private app access token
function setHubSpotApiKey() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Enter your HubSpot private app access token:');
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('HUBSPOT_API_KEY', result.getResponseText().trim());
    ui.alert('HubSpot API key saved securely.');
  }
}

// Run this to set the HubSpot deal property name for acquisition price
function setHubSpotDealProperty() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Enter the HubSpot deal property internal name for acquisition price:', 'current_acquisiton_price', ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('HUBSPOT_DEAL_PROPERTY', result.getResponseText().trim());
    ui.alert('HubSpot deal property saved.');
  }
}

// Run this to set your notification email
function setNotificationEmail() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Enter email for notifications (leave blank to disable):');
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('NOTIFICATION_EMAIL', result.getResponseText().trim());
    ui.alert('Notification email saved.');
  }
}
