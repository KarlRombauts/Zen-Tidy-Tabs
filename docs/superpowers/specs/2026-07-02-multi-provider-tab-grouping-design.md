# Multi-Provider AI Tab Grouping for Zen-Tidy-Tabs

**Date:** 2026-07-02
**Status:** Approved design → ready for implementation plan

## Problem

[Zen-Tidy-Tabs](https://github.com/Vertex-Mods/Zen-Tidy-Tabs) is a `userChrome.js` mod for Zen Browser that auto-groups tabs. Its grouping "brain" is Firefox's **on-device ML engine** (Mozilla's `EngineProcess.sys.mjs`):

- Embeddings: `Mozilla/smart-tab-embedding` (feature-extraction) → per-tab vectors
- Clustering: cosine similarity + a greedy `clusterEmbeddings()`
- Group naming: `Mozilla/smart-tab-topic` (text2text) → ~8-token label

These are tiny local models. The embeddings are mediocre and the topic-namer is worse, so grouping quality is disappointing. That quality ceiling is inherent to the models and cannot be tuned away.

A sibling project, [Darsh-A/Ai-TabGroups](https://github.com/Darsh-A/Ai-TabGroups-ZenBrowser), already uses a hosted LLM (Gemini/Ollama) for grouping — a better brain — but its plumbing into Zen's tab-groups API is broken and unmaintained.

## Goal

Replace Zen-Tidy-Tabs' local-AI grouping brain with a **hosted LLM** while keeping all of its working UI/plumbing (group creation, animations, existing-group merging, the sort button). Support four providers, selectable from a settings page: **Gemini, Claude, OpenAI, Ollama**.

## Non-goals

- No changes to the animation, DOM, button, or workspace-hook machinery beyond what the swap requires.
- No new grouping *features* (folders, auto-sort-on-open, etc.). Same behavior, better decisions.
- No fixing or reusing the Darsh-A codebase; we build on Zen-Tidy-Tabs.

## The one seam

`tidy-tabs.uc.js` exposes exactly one function that decides grouping:

```
askAIForMultipleTopics(tabs) → [{ tab, topic }]
```

`topic` is a group-name string. Tabs omitted from the result stay ungrouped. The consumer (`sortTabsByTopic`, ~line 849) does only:

```js
aiTabTopics.forEach(({ tab, topic }) => {
  if (!topic || topic === "Uncategorized" || !tab?.isConnected) return;
  (finalGroups[topic] ||= []).push(tab);
});
```

Everything downstream — name consolidation, group creation, animations, existing-group merge — consumes only `finalGroups`. **We rewrite the body of `askAIForMultipleTopics` and touch nothing else in the grouping pipeline.**

## Architecture

### 1. Rewritten `askAIForMultipleTopics(tabs)`

New flow:

1. Filter to connected tabs; for each collect `{ index, title, url }`.
   - `title` via the existing `getTabTitle(tab)`.
   - `url` via `tab.linkedBrowser?.currentURI?.spec` (guarded; may be `about:*` or missing → send empty string).
2. Collect existing group names in the current workspace (label attribute of `tab-group` elements for the active `zen-workspace-id`) to give the LLM as reuse context.
3. Build one prompt (below) and call `callLLM(prompt)`.
4. Normalize the response to `[{ index, group }]`, then map to `[{ tab: validTabs[index], topic: group }]`.
5. **Drop groups with fewer than 2 tabs** (matches current behavior — the old clustering never emitted singletons).
6. On any failure (see §4) → log, trigger `startFailureAnimation()`, return `[]`.

### 2. Prompt

A single instruction string containing:

- The task: assign browser tabs to groups.
- Existing group names (if any): "Prefer assigning a tab to one of these when it fits: [names]".
- A numbered list of tabs: `index. <title> — <url>`.
- Rules: concise Title-Case names ≤24 chars; only group tabs sharing a clear topic; omit a tab that doesn't belong with others; return JSON matching the schema.

Target JSON shape (enforced via each provider's structured-output mechanism):

```json
{ "groups": [ { "name": "Work Email", "tabIndices": [0, 3, 7] } ] }
```

We then flatten to `[{ index, group }]` in JS.

### 3. Provider abstraction — `callLLM(prompt)`

`callLLM` reads the selected provider + its config from prefs, dispatches to a per-provider builder, issues one `fetch()`, and returns the normalized `[{ index, group }]`. Because a userChrome script runs with the system principal, `fetch()` is **not** subject to CORS — all four providers work from inside the browser.

| Provider | Endpoint | Auth | Structured output |
|---|---|---|---|
| **Gemini** | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}` | query param | `generationConfig.responseMimeType:"application/json"` + `responseSchema` |
| **Claude** | `POST https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | `output_config.format` = `{type:"json_schema", schema}` |
| **OpenAI** | `POST https://api.openai.com/v1/chat/completions` | `Authorization: Bearer {key}` | `response_format` = `{type:"json_schema", json_schema:{...}}` |
| **Ollama** | `POST {ollamaUrl}/api/chat` (default `http://localhost:11434`) | none | `format: "json"`, `stream:false` |

Provider-specific notes:

- **Claude:** do **not** send `temperature` (rejected with 400 on Opus 4.8/4.7 and Sonnet 5). Use `messages: [{role:"user", content: prompt}]`, `max_tokens: 1024`, and `output_config.format`. Default model `claude-haiku-4-5` (fast/cheap for a per-click classification); dropdown also offers `claude-opus-4-8` and `claude-sonnet-5`. Parse `response.content[0].text` as JSON. Guard `stop_reason === "refusal"` → treat as failure.
- **Gemini:** `temperature: 0.2` in `generationConfig`. Parse `candidates[0].content.parts[0].text` as JSON. Default model `gemini-2.5-flash`.
- **OpenAI:** `temperature: 0.2`, `messages:[{role:"user", content: prompt}]`. Parse `choices[0].message.content` as JSON. Default model `gpt-4o-mini` (string field — user can enter any model name).
- **Ollama:** `messages:[{role:"user", content: prompt}]`, `options:{temperature:0.2}`. Parse `message.content` as JSON. Default model `llama3.1`.

A small shared parser strips markdown code fences if present, then `JSON.parse`, then validates the `{groups:[{name, tabIndices}]}` shape before flattening. Out-of-range or duplicate indices are ignored.

### 4. Failure handling — fail gracefully, group nothing

Any of: empty/missing API key for the selected provider (Ollama exempt), non-2xx response, network error, JSON parse failure, schema-shape mismatch, Claude `refusal` →

- `console.error("[TabSort] ...", detail)` with the provider and a short cause.
- Call the existing `startFailureAnimation()`.
- Return `[]` (no tabs grouped).

No fallback to the local Mozilla models.

### 5. Remove dead local-ML code

After the rewrite, delete the now-unused local-ML helpers **once a grep confirms no remaining references**:

- `generateEmbedding`, `processTabsInBatches`, `clusterEmbeddings`, `cosineSimilarity`, `averageEmbedding`
- the inner `nameGroupWithSmartTabTopic` / `extractKeywords` (were nested in the old `askAIForMultipleTopics`)

Keep `levenshteinDistance`, `getTabTitle`, `toTitleCase`, `findGroupElement`, and all animation/DOM/button code unless a grep proves a specific helper is now orphaned. When in doubt, leave it.

### 6. Settings page — `preferences.json` (Sine schema)

Zen mods (Sine loader) render `preferences.json` as a settings UI, each entry bound to an `about:config` pref. The JS reads prefs via `Services.prefs.getStringPref/getBoolPref` (with defaults). Replace the current single "Enable AI" checkbox with:

| Type | Label | property | default |
|---|---|---|---|
| checkbox | Enable AI sorting | `extensions.tidy-tabs.enabled` | `true` |
| dropdown | Provider | `extensions.tidy-tabs.provider` | `gemini` (options: gemini, claude, openai, ollama) |
| string | Gemini API Key | `extensions.tidy-tabs.gemini_api_key` | "" |
| string | Gemini Model | `extensions.tidy-tabs.gemini_model` | `gemini-2.5-flash` |
| string | Claude API Key | `extensions.tidy-tabs.claude_api_key` | "" |
| string | Claude Model | `extensions.tidy-tabs.claude_model` | `claude-haiku-4-5` |
| string | OpenAI API Key | `extensions.tidy-tabs.openai_api_key` | "" |
| string | OpenAI Model | `extensions.tidy-tabs.openai_model` | `gpt-4o-mini` |
| string | Ollama URL | `extensions.tidy-tabs.ollama_url` | `http://localhost:11434` |
| string | Ollama Model | `extensions.tidy-tabs.ollama_model` | `llama3.1` |

Sine can't conditionally hide fields, so all fields always show (grouped by label prefix). A tiny pref-accessor object in the JS centralizes reads so pref keys live in one place.

Also update `theme.json`: description ("Sort your tabs with your choice of AI — Gemini, Claude, OpenAI, or Ollama"), tags (drop "Local"), version bump.

## Units and boundaries

- **`getTabInfo(tab) → {index, title, url}`** — pure extraction; depends on `getTabTitle` + browser URI. Testable by feeding tab-like objects.
- **`buildPrompt(tabInfos, existingGroupNames) → string`** — pure; no I/O.
- **`callLLM(prompt) → Promise<[{index, group}]>`** — the only I/O unit; dispatches on provider, one `fetch`, normalizes. Each provider is a small builder `{url, headers, body, parse}` so adding a fifth provider later is one entry.
- **`prefs`** — accessor object; the single place that knows pref key strings.
- **`askAIForMultipleTopics`** — orchestrates the above and maps back to `{tab, topic}`; keeps the same signature and contract as today.

## Testing / verification

This is a browser-chrome mod; there is no unit-test harness. Verification is manual:

1. Load the mod in Zen (via Sine pointed at `~/code/zen-tidy-tabs-ai`, or copy files into the Zen chrome/mods dir).
2. With ~6+ ungrouped tabs across clear topics, set provider=Gemini + key, click the sort button → observe sensible groups with good names.
3. Repeat for Claude, OpenAI, and Ollama (Ollama requires a local server + pulled model).
4. Failure paths: blank key → failure animation, no grouping; bad key → same; airplane mode → same.
5. Existing-group reuse: pre-create a group, add a matching new tab, sort → tab joins the existing group rather than making a duplicate.
6. Console shows `[TabSort]` logs describing the provider call and any errors.

## Open risks

- Zen's `tab-group` DOM/label selectors are what Zen-Tidy-Tabs already uses; if a future Zen update changes them, grouping breaks regardless of provider (out of scope, but note it).
- Provider APIs evolve; model names are user-editable strings for exactly this reason. Structured-output field names (`output_config`, `response_format`, `responseSchema`) are current as of 2026-07.
