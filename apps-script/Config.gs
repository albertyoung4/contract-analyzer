// ===== CONFIG.gs =====
// Reads settings from Script Properties (Project Settings > Script properties)

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    apiKey: props.getProperty('ANTHROPIC_API_KEY'),
    gmailLabel: props.getProperty('GMAIL_LABEL') || 'Purchase Agreements',
    processedLabel: props.getProperty('PROCESSED_LABEL') || 'Purchase Agreements/Processed',
    notificationEmail: props.getProperty('NOTIFICATION_EMAIL') || '',
    model: props.getProperty('CLAUDE_MODEL') || 'claude-sonnet-4-20250514'
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

// Run this to set your notification email
function setNotificationEmail() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Enter email for notifications (leave blank to disable):');
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('NOTIFICATION_EMAIL', result.getResponseText().trim());
    ui.alert('Notification email saved.');
  }
}
