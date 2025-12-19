const statusEl = document.getElementById("status");
const apiKeyInput = document.getElementById("apiKey");
const europeanaKeyInput = document.getElementById("europeanaKey");
const saveBtn = document.getElementById("saveBtn");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function loadKeys() {
  chrome.storage.local.get(["openaiApiKey", "europeanaApiKey"], (res) => {
    if (res.openaiApiKey) {
      apiKeyInput.value = res.openaiApiKey;
    }
    if (res.europeanaApiKey) {
      europeanaKeyInput.value = res.europeanaApiKey;
    }
    if (res.openaiApiKey || res.europeanaApiKey) setStatus("Keys loaded.");
  });
}

function saveKeys() {
  const openaiKey = apiKeyInput.value.trim();
  const europeanaKey = europeanaKeyInput.value.trim();
  if (!openaiKey && !europeanaKey) {
    setStatus("Enter at least one key.");
    return;
  }
  setStatus("Saving...");
  const payload = {};
  if (openaiKey) payload.openaiApiKey = openaiKey;
  if (europeanaKey) payload.europeanaApiKey = europeanaKey;
  chrome.storage.local.set(payload, () => {
    setStatus("Saved.");
  });
}

saveBtn.addEventListener("click", saveKeys);
document.addEventListener("DOMContentLoaded", loadKeys);

