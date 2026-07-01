# Multi-Provider AI Tab Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Zen-Tidy-Tabs' local Mozilla-ML tab-grouping brain with a hosted-LLM brain (Gemini / Claude / OpenAI / Ollama), selectable from a settings page.

**Architecture:** Rewrite the single grouping function `askAIForMultipleTopics(tabs)` to build one prompt, call the selected LLM via `fetch()` (userChrome scripts run with the system principal, so no CORS), and map the LLM's `{groups:[{name,tabIndices}]}` response back to the existing `[{tab, topic}]` contract. All UI, group-creation, animation, and existing-group-merge code downstream is untouched. Provider config lives in `about:config` prefs surfaced by a Sine `preferences.json` settings page.

**Tech Stack:** JavaScript (single `userChrome.js` IIFE), Sine mod loader (`theme.json` + `preferences.json`), Firefox/Zen chrome globals (`Services`, `document`, `gBrowser`, `gZenWorkspaces`, `fetch`).

## Global Constraints

- Target file: `tidy-tabs.uc.js` (single IIFE). Do **not** split into multiple files — the Sine loader's cross-file scope sharing is unverified; keep one file.
- The public contract of `askAIForMultipleTopics(tabs)` is unchanged: it returns `Array<{ tab: <tab element>, topic: string }>`; omitted tabs stay ungrouped; groups of fewer than 2 tabs are never emitted.
- No fallback to the local Mozilla ML engine. On any failure: `console.error` with `[TabSort]` prefix, call `startFailureAnimation()`, return `[]`.
- Pref keys are namespaced `extensions.tidy-tabs.<key>`. All pref reads go through the `PREFS` accessor object — no `Services.prefs` calls scattered elsewhere.
- Do not send `temperature` on the Claude request (rejected with 400 on Opus 4.8/4.7 and Sonnet 5, which are user-selectable).
- Claude requests must include `"anthropic-version": "2023-06-01"` and `"anthropic-dangerous-direct-browser-access": "true"`.
- Default models: Gemini `gemini-2.5-flash`, Claude `claude-haiku-4-5`, OpenAI `gpt-4o-mini`, Ollama `llama3.1`. Default provider `gemini`. Default Ollama URL `http://localhost:11434`.
- This is a browser-chrome mod: there is no automated test runner. Verification is (a) JSON validity via CLI for the two JSON files, (b) pure-function checks pasted into Zen's **Browser Console** (`Ctrl+Shift+J` / Cmd+Shift+J) against the `window.TidyTabsDev` handle, and (c) manual sort-button integration checks. After editing `tidy-tabs.uc.js`, reload the mod (Sine: re-apply/restart, or restart Zen) before verifying.

## How to load & reload during development

The engineer needs a running Zen with this mod active. Two supported ways:
- Point the Sine mod manager at `~/code/zen-tidy-tabs-ai` (the mod folder with `theme.json`), enable it, restart Zen.
- Or copy `tidy-tabs.uc.js`, `userChrome.css`, `preferences.json`, `theme.json` into the Zen profile's chrome/mods location Sine uses, then restart Zen.

After any `.uc.js` edit: restart Zen (or Sine "re-apply"), then open Browser Console (`Cmd+Shift+J`). A clean load prints no red errors mentioning `tidy-tabs`.

## File Structure

- Modify: `~/code/zen-tidy-tabs-ai/preferences.json` — settings-page schema (replace the single checkbox with provider/keys/models).
- Modify: `~/code/zen-tidy-tabs-ai/theme.json` — description/tags/version.
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` — insert the pref accessor, pure helpers, schemas, provider layer, and dev handle **before** `const askAIForMultipleTopics`; then replace the body of `askAIForMultipleTopics`; then delete the now-dead local-ML helpers.

All work happens on the existing `gemini-multi-provider` branch.

---

### Task 1: Settings page — `preferences.json` + `theme.json`

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/preferences.json`
- Modify: `~/code/zen-tidy-tabs-ai/theme.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `about:config` prefs `extensions.tidy-tabs.{enabled,provider,gemini_api_key,gemini_model,claude_api_key,claude_model,openai_api_key,openai_model,ollama_url,ollama_model}` that Task 2's `PREFS` accessor reads.

- [ ] **Step 1: Replace `preferences.json` contents**

Overwrite the whole file with:

```json
[
  {
    "type": "checkbox",
    "label": "Enable AI sorting",
    "property": "extensions.tidy-tabs.enabled",
    "defaultValue": true
  },
  {
    "type": "dropdown",
    "label": "AI Provider",
    "property": "extensions.tidy-tabs.provider",
    "defaultValue": "gemini",
    "options": [
      { "value": "gemini", "label": "Gemini (Google)" },
      { "value": "claude", "label": "Claude (Anthropic)" },
      { "value": "openai", "label": "OpenAI" },
      { "value": "ollama", "label": "Ollama (local)" }
    ]
  },
  {
    "type": "string",
    "label": "Gemini API Key",
    "property": "extensions.tidy-tabs.gemini_api_key",
    "placeholder": "AIza...",
    "defaultValue": ""
  },
  {
    "type": "string",
    "label": "Gemini Model",
    "property": "extensions.tidy-tabs.gemini_model",
    "placeholder": "gemini-2.5-flash",
    "defaultValue": "gemini-2.5-flash"
  },
  {
    "type": "string",
    "label": "Claude API Key",
    "property": "extensions.tidy-tabs.claude_api_key",
    "placeholder": "sk-ant-...",
    "defaultValue": ""
  },
  {
    "type": "string",
    "label": "Claude Model",
    "property": "extensions.tidy-tabs.claude_model",
    "placeholder": "claude-haiku-4-5",
    "defaultValue": "claude-haiku-4-5"
  },
  {
    "type": "string",
    "label": "OpenAI API Key",
    "property": "extensions.tidy-tabs.openai_api_key",
    "placeholder": "sk-...",
    "defaultValue": ""
  },
  {
    "type": "string",
    "label": "OpenAI Model",
    "property": "extensions.tidy-tabs.openai_model",
    "placeholder": "gpt-4o-mini",
    "defaultValue": "gpt-4o-mini"
  },
  {
    "type": "string",
    "label": "Ollama URL",
    "property": "extensions.tidy-tabs.ollama_url",
    "placeholder": "http://localhost:11434",
    "defaultValue": "http://localhost:11434"
  },
  {
    "type": "string",
    "label": "Ollama Model",
    "property": "extensions.tidy-tabs.ollama_model",
    "placeholder": "llama3.1",
    "defaultValue": "llama3.1"
  }
]
```

- [ ] **Step 2: Update `theme.json` description and tags**

In `~/code/zen-tidy-tabs-ai/theme.json`, change the `description` field to:

```json
  "description": "Sort your tabs with your choice of AI — Gemini, Claude, OpenAI, or Ollama — but make it look awesome!",
```

In the same file, remove the `"Local"` entry from the `tags` array (leave the other tags), and bump `"version"` to `"2.0.0"`.

- [ ] **Step 3: Verify both JSON files parse**

Run:
```bash
cd ~/code/zen-tidy-tabs-ai && node -e "JSON.parse(require('fs').readFileSync('preferences.json','utf8')); JSON.parse(require('fs').readFileSync('theme.json','utf8')); console.log('OK')"
```
Expected output: `OK`

- [ ] **Step 4: Verify settings render in Zen**

Restart Zen, open the Sine mod settings for this mod. Expected: the ten fields above appear (Enable checkbox, Provider dropdown, four key fields, four model/url fields). No console error.

- [ ] **Step 5: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add preferences.json theme.json
git commit -m "feat(settings): multi-provider preferences schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

### Task 2: Pref accessor + dev handle

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` (insert before `const askAIForMultipleTopics = async (tabs) => {`)

**Interfaces:**
- Consumes: the prefs defined in Task 1; the chrome global `Services`.
- Produces: `PREFS` object with methods `enabled()→bool`, `provider()→string`, `geminiKey()/geminiModel()/claudeKey()/claudeModel()/openaiKey()/openaiModel()/ollamaUrl()/ollamaModel()→string`. Also `window.TidyTabsDev` extended with `{ PREFS }`.

- [ ] **Step 1: Insert the `PREFS` block**

Find the line `  const askAIForMultipleTopics = async (tabs) => {` and insert the following **immediately before it**:

```js
  // ===== Hosted-LLM grouping brain =====

  // --- Preferences (single source of truth for pref keys) ---
  const PREFS = {
    _base: "extensions.tidy-tabs.",
    _str(key, def) {
      try {
        return Services.prefs.getStringPref(this._base + key, def);
      } catch (e) {
        return def;
      }
    },
    _bool(key, def) {
      try {
        return Services.prefs.getBoolPref(this._base + key, def);
      } catch (e) {
        return def;
      }
    },
    enabled() {
      return this._bool("enabled", true);
    },
    provider() {
      return this._str("provider", "gemini");
    },
    geminiKey() {
      return this._str("gemini_api_key", "").trim();
    },
    geminiModel() {
      return this._str("gemini_model", "gemini-2.5-flash").trim() || "gemini-2.5-flash";
    },
    claudeKey() {
      return this._str("claude_api_key", "").trim();
    },
    claudeModel() {
      return this._str("claude_model", "claude-haiku-4-5").trim() || "claude-haiku-4-5";
    },
    openaiKey() {
      return this._str("openai_api_key", "").trim();
    },
    openaiModel() {
      return this._str("openai_model", "gpt-4o-mini").trim() || "gpt-4o-mini";
    },
    ollamaUrl() {
      return this._str("ollama_url", "http://localhost:11434").trim() || "http://localhost:11434";
    },
    ollamaModel() {
      return this._str("ollama_model", "llama3.1").trim() || "llama3.1";
    },
  };

  // Dev handle for manual verification via the Browser Console.
  window.TidyTabsDev = Object.assign(window.TidyTabsDev || {}, { PREFS });
```

- [ ] **Step 2: Reload Zen and verify the handle**

Restart Zen. Open Browser Console (`Cmd+Shift+J`). Run:
```js
TidyTabsDev.PREFS.provider()
```
Expected: `"gemini"` (or whatever provider you set in settings).
Run:
```js
TidyTabsDev.PREFS.geminiModel()
```
Expected: `"gemini-2.5-flash"`.

- [ ] **Step 3: Verify the mod still sorts (no regression)**

With ≥6 ungrouped tabs, click the sort button. Expected: it still groups via the (still-present) local ML path — grouping quality is unchanged at this task. No console errors.

- [ ] **Step 4: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add tidy-tabs.uc.js
git commit -m "feat(prefs): PREFS accessor and dev handle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

### Task 3: Pure helpers — tab info, prompt, schemas, response parsing

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` (insert after the `PREFS`/dev-handle block from Task 2, still before `const askAIForMultipleTopics`)

**Interfaces:**
- Consumes: `getTabTitle(tab)` (existing, ~line 91), `PREFS` (Task 2), chrome globals `document`, `gBrowser`.
- Produces:
  - `getTabUrl(tab) → string` ("" for about:/missing)
  - `getExistingGroupNames(workspaceId) → string[]`
  - `buildPrompt(tabInfos, existingGroupNames) → string` where `tabInfos` is `Array<{index:number,title:string,url:string}>`
  - `parseGroupsJSON(text) → Array<{name, tabIndices}>` (throws on bad input)
  - `flattenGroups(groups, tabCount) → Array<{index:number, group:string}>`
  - `dropSmallGroups(pairs) → Array<{index, group}>` (removes groups with <2 members)
  - Constants `GEMINI_SCHEMA`, `STRICT_SCHEMA` (JSON-schema objects)
  - `window.TidyTabsDev` extended with `{ buildPrompt, parseGroupsJSON, flattenGroups, dropSmallGroups, getExistingGroupNames }`

- [ ] **Step 1: Insert the helpers block**

Insert immediately after the Task 2 block (still before `const askAIForMultipleTopics`):

```js
  // --- Response JSON schemas ---
  // Gemini's responseSchema is an OpenAPI subset — no additionalProperties.
  const GEMINI_SCHEMA = {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            tabIndices: { type: "array", items: { type: "integer" } },
          },
          required: ["name", "tabIndices"],
        },
      },
    },
    required: ["groups"],
  };
  // OpenAI/Claude strict json_schema — requires additionalProperties:false.
  const STRICT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            tabIndices: { type: "array", items: { type: "integer" } },
          },
          required: ["name", "tabIndices"],
        },
      },
    },
    required: ["groups"],
  };

  // --- Tab info extraction ---
  const getTabUrl = (tab) => {
    try {
      const browser =
        tab.linkedBrowser ||
        tab._linkedBrowser ||
        gBrowser?.getBrowserForTab?.(tab);
      const spec = browser?.currentURI?.spec || "";
      if (!spec || spec.startsWith("about:")) return "";
      return spec;
    } catch (e) {
      return "";
    }
  };

  const getExistingGroupNames = (workspaceId) => {
    if (!workspaceId) return [];
    const names = [];
    document
      .querySelectorAll(`tab-group:has(tab[zen-workspace-id="${workspaceId}"])`)
      .forEach((el) => {
        const label = el.getAttribute("label");
        if (label) names.push(label);
      });
    return names;
  };

  // --- Prompt ---
  const buildPrompt = (tabInfos, existingGroupNames) => {
    const lines = tabInfos.map(
      (t) => `${t.index}. ${t.title}${t.url ? " — " + t.url : ""}`
    );
    const existing =
      existingGroupNames && existingGroupNames.length
        ? `\nExisting groups (prefer one of these when a tab clearly fits):\n${existingGroupNames
            .map((n) => `- ${n}`)
            .join("\n")}\n`
        : "";
    return [
      "You organize browser tabs into groups by topic.",
      existing,
      "Tabs (index. title — url):",
      lines.join("\n"),
      "",
      "Rules:",
      "- Group tabs that share a clear topic or task.",
      "- Reuse an existing group name when a tab fits it; otherwise create a concise new name.",
      "- Group names: Title Case, at most 24 characters.",
      "- Only include a tab if it belongs with at least one other tab. Omit tabs that don't fit any group.",
      '- Return JSON only, matching: {"groups":[{"name":"...","tabIndices":[0,1]}]}',
    ].join("\n");
  };

  // --- Response parsing ---
  const parseGroupsJSON = (text) => {
    if (typeof text !== "string") throw new Error("no text in response");
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const data = JSON.parse(s);
    const groups = Array.isArray(data) ? data : data && data.groups;
    if (!Array.isArray(groups)) throw new Error("response missing groups array");
    return groups;
  };

  const flattenGroups = (groups, tabCount) => {
    const out = [];
    const seen = new Set();
    for (const g of groups) {
      const name = g && typeof g.name === "string" ? g.name.trim() : "";
      if (!name) continue;
      const idxs = g && Array.isArray(g.tabIndices) ? g.tabIndices : [];
      for (const raw of idxs) {
        const i = Number(raw);
        if (!Number.isInteger(i) || i < 0 || i >= tabCount || seen.has(i)) continue;
        seen.add(i);
        out.push({ index: i, group: name });
      }
    }
    return out;
  };

  const dropSmallGroups = (pairs) => {
    const counts = {};
    pairs.forEach((p) => {
      counts[p.group] = (counts[p.group] || 0) + 1;
    });
    return pairs.filter((p) => counts[p.group] >= 2);
  };

  window.TidyTabsDev = Object.assign(window.TidyTabsDev || {}, {
    buildPrompt,
    parseGroupsJSON,
    flattenGroups,
    dropSmallGroups,
    getExistingGroupNames,
  });
```

- [ ] **Step 2: Reload and verify `parseGroupsJSON` handles fenced + plain JSON**

Restart Zen, open Browser Console. Run:
```js
TidyTabsDev.parseGroupsJSON('```json\n{"groups":[{"name":"Work","tabIndices":[0,1]}]}\n```')
```
Expected: `[{name: "Work", tabIndices: [0, 1]}]`.
Run:
```js
TidyTabsDev.parseGroupsJSON('{"groups":[{"name":"News","tabIndices":[2]}]}')
```
Expected: `[{name: "News", tabIndices: [2]}]`.

- [ ] **Step 3: Verify `flattenGroups` + `dropSmallGroups`**

Run:
```js
TidyTabsDev.flattenGroups([{name:"A",tabIndices:[0,1,99]},{name:"B",tabIndices:[2]},{name:"",tabIndices:[3]}], 5)
```
Expected: `[{index:0,group:"A"},{index:1,group:"A"},{index:2,group:"B"}]` (99 dropped as out-of-range, unnamed group dropped).
Run:
```js
TidyTabsDev.dropSmallGroups([{index:0,group:"A"},{index:1,group:"A"},{index:2,group:"B"}])
```
Expected: `[{index:0,group:"A"},{index:1,group:"A"}]` (group B dropped — only 1 member).

- [ ] **Step 4: Verify `buildPrompt` shape**

Run:
```js
TidyTabsDev.buildPrompt([{index:0,title:"Gmail",url:"https://mail.google.com"},{index:1,title:"Docs",url:""}], ["Work"])
```
Expected: a string containing `0. Gmail — https://mail.google.com`, `1. Docs` (no `— ` since url is ""), and an `Existing groups` section listing `- Work`.

- [ ] **Step 5: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add tidy-tabs.uc.js
git commit -m "feat(core): pure helpers for tab info, prompt, schema, parsing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

### Task 4: Provider layer — `PROVIDERS` map + `callLLM`

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` (insert after the Task 3 block, still before `const askAIForMultipleTopics`)

**Interfaces:**
- Consumes: `PREFS`, `GEMINI_SCHEMA`, `STRICT_SCHEMA`, `parseGroupsJSON`, global `fetch`.
- Produces: `callLLM(prompt) → Promise<Array<{name, tabIndices}>>` (throws on missing key / non-2xx / no text / parse failure / Claude refusal). Also `window.TidyTabsDev` extended with `{ callLLM }`.

- [ ] **Step 1: Insert the provider block**

Insert immediately after the Task 3 block (still before `const askAIForMultipleTopics`):

```js
  // --- Providers ---
  const PROVIDERS = {
    gemini: {
      build(prompt) {
        const key = PREFS.geminiKey();
        if (!key) throw new Error("Gemini API key not set");
        const model = PREFS.geminiModel();
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(key)}`,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
                responseSchema: GEMINI_SCHEMA,
              },
            }),
          },
        };
      },
      extractText(json) {
        const t = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof t !== "string") throw new Error("Gemini: no text in response");
        return t;
      },
    },

    claude: {
      build(prompt) {
        const key = PREFS.claudeKey();
        if (!key) throw new Error("Claude API key not set");
        return {
          url: "https://api.anthropic.com/v1/messages",
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
              model: PREFS.claudeModel(),
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
              output_config: {
                format: { type: "json_schema", schema: STRICT_SCHEMA },
              },
            }),
          },
        };
      },
      extractText(json) {
        if (json?.stop_reason === "refusal") throw new Error("Claude refused the request");
        const block =
          Array.isArray(json?.content) &&
          json.content.find((b) => b && b.type === "text");
        const t = block && block.text;
        if (typeof t !== "string") throw new Error("Claude: no text in response");
        return t;
      },
    },

    openai: {
      build(prompt) {
        const key = PREFS.openaiKey();
        if (!key) throw new Error("OpenAI API key not set");
        return {
          url: "https://api.openai.com/v1/chat/completions",
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: PREFS.openaiModel(),
              temperature: 0.2,
              messages: [{ role: "user", content: prompt }],
              response_format: {
                type: "json_schema",
                json_schema: { name: "tab_groups", strict: true, schema: STRICT_SCHEMA },
              },
            }),
          },
        };
      },
      extractText(json) {
        const t = json?.choices?.[0]?.message?.content;
        if (typeof t !== "string") throw new Error("OpenAI: no text in response");
        return t;
      },
    },

    ollama: {
      build(prompt) {
        const base = PREFS.ollamaUrl().replace(/\/+$/, "");
        return {
          url: `${base}/api/chat`,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: PREFS.ollamaModel(),
              stream: false,
              format: "json",
              options: { temperature: 0.2 },
              messages: [{ role: "user", content: prompt }],
            }),
          },
        };
      },
      extractText(json) {
        const t = json?.message?.content;
        if (typeof t !== "string") throw new Error("Ollama: no text in response");
        return t;
      },
    },
  };

  const callLLM = async (prompt) => {
    const providerName = PREFS.provider();
    const provider = PROVIDERS[providerName];
    if (!provider) throw new Error(`unknown provider: ${providerName}`);
    const req = provider.build(prompt);
    const resp = await fetch(req.url, req.init);
    if (!resp.ok) {
      let body = "";
      try {
        body = await resp.text();
      } catch (e) {}
      throw new Error(`${providerName} HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = await resp.json();
    const text = provider.extractText(json);
    return parseGroupsJSON(text);
  };

  window.TidyTabsDev = Object.assign(window.TidyTabsDev || {}, { callLLM, PROVIDERS });
```

- [ ] **Step 2: Verify the missing-key error path (no network)**

In Zen settings, set Provider = Gemini and clear the Gemini API Key. Restart Zen, open Browser Console. Run:
```js
TidyTabsDev.callLLM("test").then(r => console.log("OK", r)).catch(e => console.log("ERR", e.message))
```
Expected: `ERR Gemini API key not set`.

- [ ] **Step 3: Verify a real provider round-trip**

Set Provider to one you have a key for (Gemini/Claude/OpenAI) and enter the key in settings; or set Provider = Ollama with a running local server and a pulled model. Restart Zen, open Browser Console. Run:
```js
TidyTabsDev.callLLM(TidyTabsDev.buildPrompt([{index:0,title:"Gmail - Inbox",url:"https://mail.google.com"},{index:1,title:"Outlook Mail",url:"https://outlook.com"},{index:2,title:"YouTube - Music",url:"https://youtube.com"}], [])).then(r => console.log(JSON.stringify(r))).catch(e => console.log("ERR", e.message))
```
Expected: a JSON array of `{name, tabIndices}` where the two mail tabs share a group (e.g. `[{"name":"Email","tabIndices":[0,1]}]`). If it errors, read the `[TabSort]`-style message (HTTP status + body) and fix the key/model/URL.

- [ ] **Step 4: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add tidy-tabs.uc.js
git commit -m "feat(providers): Gemini/Claude/OpenAI/Ollama callLLM layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

### Task 5: Rewrite `askAIForMultipleTopics` to use the LLM pipeline

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` — replace the entire body of `askAIForMultipleTopics` (currently the block from `const askAIForMultipleTopics = async (tabs) => {` through its closing `};`, roughly lines 362–670 in the original file; confirm by symbol, not line number, since earlier tasks shifted line numbers).

**Interfaces:**
- Consumes: `PREFS`, `getTabTitle` (existing), `getTabUrl`, `getExistingGroupNames`, `buildPrompt`, `callLLM`, `flattenGroups`, `dropSmallGroups`, `startFailureAnimation` (existing, defined later in the file — referenced at call time, so definition order is fine), `window.gZenWorkspaces`.
- Produces: `askAIForMultipleTopics(tabs) → Promise<Array<{tab, topic}>>` — same contract as before.

- [ ] **Step 1: Replace the whole function**

Delete the existing `askAIForMultipleTopics` definition (the `const askAIForMultipleTopics = async (tabs) => { ... };` block) and replace it with:

```js
  const askAIForMultipleTopics = async (tabs) => {
    if (!PREFS.enabled()) return [];
    if (!Array.isArray(tabs)) return [];

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (validTabs.length < 2) return [];

    const workspaceId = window.gZenWorkspaces?.activeWorkspace;
    const tabInfos = validTabs.map((tab, index) => ({
      index,
      title: getTabTitle(tab),
      url: getTabUrl(tab),
    }));
    const existing = getExistingGroupNames(workspaceId);
    const prompt = buildPrompt(tabInfos, existing);

    let groups;
    try {
      groups = await callLLM(prompt);
    } catch (e) {
      console.error("[TabSort][AI] grouping failed:", (e && e.message) || e);
      startFailureAnimation();
      return [];
    }

    const pairs = dropSmallGroups(flattenGroups(groups, validTabs.length));
    console.log(
      `[TabSort][AI] ${PREFS.provider()} → ${pairs.length} tabs grouped into ${
        new Set(pairs.map((p) => p.group)).size
      } groups`
    );
    return pairs.map(({ index, group }) => ({ tab: validTabs[index], topic: group }));
  };
```

- [ ] **Step 2: Verify happy-path grouping via the sort button**

In settings, select a working provider + key. Restart Zen. Open ≥6 ungrouped tabs across clear topics (e.g. 2 email tabs, 2 news tabs, 2 shopping tabs). Open Browser Console, then click the sort button. Expected: console logs `[TabSort][AI] <provider> → N tabs grouped into M groups`; tab groups are created with sensible names; grouping quality is visibly better than the old local model.

- [ ] **Step 3: Verify failure path (blank key)**

In settings, clear the selected provider's API key (or set provider = Ollama with no server running). Restart Zen. Click the sort button. Expected: the failure animation plays, no groups are created, and the console shows `[TabSort][AI] grouping failed: ...`.

- [ ] **Step 4: Verify existing-group reuse**

Manually create a tab group named e.g. "Email" with one mail tab. Open another mail tab ungrouped. Click sort. Expected: the new mail tab joins the existing "Email" group rather than forming a duplicate group (the existing name was passed in the prompt).

- [ ] **Step 5: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add tidy-tabs.uc.js
git commit -m "feat(grouping): route askAIForMultipleTopics through hosted LLM

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

### Task 6: Remove dead local-ML code

**Files:**
- Modify: `~/code/zen-tidy-tabs-ai/tidy-tabs.uc.js` — delete now-unused local-ML helpers.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Pure deletion; the grouping contract is unchanged.

- [ ] **Step 1: Confirm each helper is now orphaned**

Run each grep and confirm the symbol appears **only** in its own definition (no other call sites):

```bash
cd ~/code/zen-tidy-tabs-ai
for fn in generateEmbedding processTabsInBatches clusterEmbeddings cosineSimilarity averageEmbedding; do
  echo "== $fn =="; grep -n "$fn" tidy-tabs.uc.js
done
```
Expected: for each, only the definition line (and, for `cosineSimilarity`, references *inside* `clusterEmbeddings`/`averageEmbedding`, which are themselves being deleted). If any function shows a call site outside this set, **do not delete it** — stop and report.

- [ ] **Step 2: Delete the orphaned helpers**

Delete the full definitions of `averageEmbedding`, `cosineSimilarity`, `clusterEmbeddings`, `processTabsInBatches`, and `generateEmbedding` (they are the contiguous block of helper functions above the old grouping code — `averageEmbedding` through `generateEmbedding`, roughly the original lines 208–360). Do **not** touch `batchDOMUpdates`, `getFilteredTabs`, `getTabTitle`, `toTitleCase`, `levenshteinDistance`, `findGroupElement`, or any animation/DOM/button code.

- [ ] **Step 3: Verify no dangling references remain**

```bash
cd ~/code/zen-tidy-tabs-ai
grep -nE "generateEmbedding|processTabsInBatches|clusterEmbeddings|cosineSimilarity|averageEmbedding|EngineProcess|smart-tab-embedding|smart-tab-topic" tidy-tabs.uc.js
```
Expected: **no output** (all local-ML references gone).

- [ ] **Step 4: Verify the mod still loads and sorts**

Restart Zen, open Browser Console (expect no red errors mentioning `tidy-tabs`). With a working provider set, click the sort button. Expected: grouping works exactly as in Task 5.

- [ ] **Step 5: Commit**

```bash
cd ~/code/zen-tidy-tabs-ai
git add tidy-tabs.uc.js
git commit -m "refactor: remove dead local-ML grouping helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012zuzxCVREwk5PiSciEmRAL"
```

---

## Self-Review

**Spec coverage:**
- Rewrite of `askAIForMultipleTopics` seam → Task 5. ✓
- `getTabInfo`/`buildPrompt`/`callLLM`/`prefs` units → Tasks 2–4. ✓
- Four providers with native structured output → Task 4 (`PROVIDERS`). ✓
- Claude: no temperature, structured outputs, refusal guard, version + browser-access headers → Task 4 + Global Constraints. ✓
- Fail-gracefully (log + `startFailureAnimation` + `[]`, no local fallback) → Task 5 + Global Constraints. ✓
- Drop <2-tab groups → Task 3 `dropSmallGroups`, applied in Task 5. ✓
- Existing-group reuse via prompt context → Task 3 `getExistingGroupNames` + Task 5. ✓
- Delete dead local-ML code (grep-guarded) → Task 6. ✓
- Settings page (`preferences.json`) with provider/keys/models + `theme.json` update → Task 1. ✓
- Per-provider default models → Task 1 defaults + `PREFS` fallbacks (Task 2). ✓
- Manual verification protocol (browser mod, no test runner) → each task's verify steps. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code; every verify step has an exact command/console call + expected result. ✓

**Type consistency:** `{index, group}` used consistently by `flattenGroups`/`dropSmallGroups`/Task 5 mapping; `{name, tabIndices}` used consistently by schemas/`parseGroupsJSON`/`flattenGroups`; `{tab, topic}` matches the downstream consumer at `sortTabsByTopic`. `PREFS` method names match between Task 2 definition and Task 4 usage. ✓
