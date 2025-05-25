document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key-input');
  const llmEndpointInput = document.getElementById('llm-endpoint-input');
  const whisperEndpointInput = document.getElementById('whisper-endpoint-input');
  const status = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['openaiApiKey', 'llmEndpoint', 'whisperEndpoint'], (result) => {
    if (result.openaiApiKey) {
      apiKeyInput.value = result.openaiApiKey;
    }
    if (result.llmEndpoint) {
      llmEndpointInput.value = result.llmEndpoint;
    }
    if (result.whisperEndpoint) {
      whisperEndpointInput.value = result.whisperEndpoint;
    }
  });

  // Save settings
  document.getElementById('api-key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    const llmEndpoint = llmEndpointInput.value.trim();
    const whisperEndpoint = whisperEndpointInput.value.trim();

    if (!apiKey) {
      status.textContent = 'Please enter a valid API key.';
      return;
    }

    const settingsToSave = { openaiApiKey: apiKey };
    if (llmEndpoint) {
      settingsToSave.llmEndpoint = llmEndpoint;
    } else {
      // Clear the setting if the field is empty
      chrome.storage.local.remove('llmEndpoint');
    }
    if (whisperEndpoint) {
      settingsToSave.whisperEndpoint = whisperEndpoint;
    } else {
      // Clear the setting if the field is empty
      chrome.storage.local.remove('whisperEndpoint');
    }

    chrome.storage.local.set(settingsToSave, () => {
      status.textContent = 'Settings saved.';
      setTimeout(() => { status.textContent = ''; }, 3000);
    });
  });
});
