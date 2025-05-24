document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('api-key-input');
  const status = document.getElementById('status');
  chrome.storage.local.get(['openaiApiKey'], (result) => {
    if (result.openaiApiKey) {
      input.value = result.openaiApiKey;
    }
  });
  document.getElementById('api-key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) {
      status.textContent = 'Please enter a valid API key.';
      return;
    }
    chrome.storage.local.set({ openaiApiKey: key }, () => {
      status.textContent = 'API key saved.';
      setTimeout(() => { status.textContent = ''; }, 3000);
    });
  });
});
