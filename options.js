const statusEl = document.getElementById("status");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");

function setStatus(text) {
  statusEl.textContent = text || "";
}

function loadKey() {
  chrome.storage.local.get(["openaiApiKey"], (res) => {
    if (res.openaiApiKey) {
      apiKeyInput.value = res.openaiApiKey;
      setStatus("Key loaded.");
    }
  });
}

function saveKey() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus("Enter a key.");
    return;
  }
  setStatus("Saving...");
  chrome.storage.local.set({ openaiApiKey: key }, () => {
    setStatus("Saved.");
  });
}

saveBtn.addEventListener("click", saveKey);
document.addEventListener("DOMContentLoaded", loadKey);

