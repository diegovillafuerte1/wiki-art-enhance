# wiki-art-enhance

## Firefox (MV3) testing
- Use Firefox 128+ (MV3 support).
- Open `about:debugging`, select “This Firefox”, click “Load Temporary Add-on…”, and choose this folder’s `manifest.json`.
- Visit a Wikipedia page (e.g., a city with a year); hover the inline “Art” marker to see the tooltip, click “Show more” for the gallery.
- Allow host permissions for Met Museum/Wikimedia if prompted. The bundled `lib/browser-polyfill.js` enables `browser.*` usage across Chrome/Firefox.

## LLM mode (OpenAI)
- Open Options (extension menu → Options) and save your OpenAI API key (stored locally via chrome.storage).
- On page load the content script sends larger page text to the LLM to extract candidate (location, year) pairs; if the key is missing or the call fails, heuristics are used instead.
- Ensure host permission to `https://api.openai.com/*` is granted when prompted.
- LLM defaults to `gpt-4o-mini`; tokens are limited to reduce cost. Content includes top portions of the page—be mindful of privacy when enabling.

## Europeana support
- Add your Europeana API key via Options (stored locally). If you have a build step that injects env vars, you can also set `EUROPEANA_API_KEY` at build time.
- Queries use the detected location/year and fetch image-only items from Europeana alongside Met results. When debugging, check the console for `[WAC][EU]` logs showing the request URL and result count.
