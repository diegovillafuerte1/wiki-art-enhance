const LLM_DEFAULT_MODEL = "gpt-4o-mini";
const LLM_MAX_TOKENS = 400;

function getStoredApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["openaiApiKey"], (res) => {
      resolve(res.openaiApiKey || null);
    });
  });
}

async function callLLM({ prompt, model = LLM_DEFAULT_MODEL }) {
  const apiKey = await getStoredApiKey();
  if (!apiKey) {
    throw new Error("Missing OpenAI API key");
  }

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You extract location + year pairs from Wikipedia text to help find art from that place/time."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0.2
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  return content;
}

