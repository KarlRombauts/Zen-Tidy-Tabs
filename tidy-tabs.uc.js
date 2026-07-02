// ==UserScript==
// @ignorecache
// @name          Ai tab sort and tab clearer
// @description    sorts tab and arrange them into tab groups
// ==/UserScript==

(() => {
  const CONFIG = {
    SIMILARITY_THRESHOLD: 0.45,
    GROUP_SIMILARITY_THRESHOLD: 0.65, // Lowered from 0.75 to be more inclusive for existing groups
    MIN_TABS_FOR_SORT: 6, // This is the ammount of tabs for the button to show, not the ammount of tabs you need in a group
    DEBOUNCE_DELAY: 250,
    ANIMATION_DURATION: 800,
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
    CONSOLIDATION_DISTANCE_THRESHOLD: 2,
    EMBEDDING_BATCH_SIZE: 5,
    EXISTING_GROUP_BOOST: 0.1, // Boost similarity score for existing groups to prefer them
  };

  // --- Globals & State ---
  let isSorting = false;
  let sortButtonListenerAdded = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;
  let eventListenersAdded = false;

  // DOM Cache for performance
  const domCache = {
    separators: null,
    commandSet: null,

    getSeparators() {
      if (!this.separators || !this.separators.length) {
        this.separators = document.querySelectorAll(
          ".pinned-tabs-container-separator"
        );
      }
      return this.separators;
    },

    getCommandSet() {
      if (!this.commandSet) {
        this.commandSet = document.querySelector("commandset#zenCommandSet");
      }
      return this.commandSet;
    },

    invalidate() {
      this.separators = null;
      this.commandSet = null;
    },
  };

  // --- Helper Functions ---

  // Optimized tab filtering function
  const getFilteredTabs = (workspaceId, options = {}) => {
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
      return [];
    }

    const {
      includeGrouped = false,
      includeSelected = true,
      includePinned = false,
      includeEmpty = false,
      includeGlance = false,
    } = options;

    return Array.from(gBrowser.tabs).filter((tab) => {
      if (!tab?.isConnected) return false;

      const isInCorrectWorkspace =
        tab.getAttribute("zen-workspace-id") === workspaceId;
      if (!isInCorrectWorkspace) return false;

      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;

      return (
        (includePinned || !tab.pinned) &&
        (includeGrouped || !isInGroup) &&
        (includeSelected || !tab.selected) &&
        (includeEmpty || !tab.hasAttribute("zen-empty-tab")) &&
        (includeGlance || !tab.hasAttribute("zen-glance-tab"))
      );
    });
  };

  const getTabTitle = (tab) => {
    if (!tab?.isConnected) {
      return "Invalid Tab";
    }
    try {
      const originalTitle =
        tab.getAttribute("label") ||
        tab.querySelector(".tab-label, .tab-text")?.textContent ||
        "";

      if (
        !originalTitle ||
        originalTitle === "New Tab" ||
        originalTitle === "about:blank" ||
        originalTitle === "Loading..." ||
        originalTitle.startsWith("http:") ||
        originalTitle.startsWith("https:")
      ) {
        const browser =
          tab.linkedBrowser ||
          tab._linkedBrowser ||
          gBrowser?.getBrowserForTab?.(tab);

        if (
          browser?.currentURI?.spec &&
          !browser.currentURI.spec.startsWith("about:")
        ) {
          try {
            const currentURL = new URL(browser.currentURI.spec);
            const hostname = currentURL.hostname.replace(/^www\./, "");
            if (
              hostname &&
              hostname !== "localhost" &&
              hostname !== "127.0.0.1"
            ) {
              return hostname;
            }
            const pathSegment = currentURL.pathname.split("/")[1];
            if (pathSegment) return pathSegment;
          } catch {
            /* ignore */
          }
        }
        return "Untitled Page";
      }
      return originalTitle.trim() || "Untitled Page";
    } catch (e) {
      console.error("Error getting tab title for tab:", tab, e);
      return "Error Processing Tab";
    }
  };

  const toTitleCase = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const levenshteinDistance = (a, b) => {
    if (!a || !b || typeof a !== "string" || typeof b !== "string") {
      return Math.max(a?.length ?? 0, b?.length ?? 0);
    }
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // Deletion
          matrix[i][j - 1] + 1, // Insertion
          matrix[i - 1][j - 1] + cost // Substitution
        );
      }
    }
    return matrix[b.length][a.length];
  };

  const findGroupElement = (topicName, workspaceId) => {
    if (!topicName || typeof topicName !== "string" || !workspaceId)
      return null;

    const sanitizedTopicName = topicName.trim();
    if (!sanitizedTopicName) return null;

    const safeSelectorTopicName = sanitizedTopicName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    try {
      return document.querySelector(
        `tab-group[label="${safeSelectorTopicName}"][zen-workspace-id="${workspaceId}"]`
      );
    } catch (e) {
      console.error(
        `Error finding group selector for "${sanitizedTopicName}":`,
        e
      );
      return null;
    }
  };

  // Batch DOM operations for better performance
  const batchDOMUpdates = (operations) => {
    if (!Array.isArray(operations) || operations.length === 0) return;

    // Use document fragment for batching when possible
    const fragment = document.createDocumentFragment();

    try {
      operations.forEach((operation) => {
        if (typeof operation === "function") {
          operation(fragment);
        }
      });
    } catch (error) {
      console.error("Error in batch DOM operations:", error);
    }
  };

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
        ? `\nExisting groups (reuse one of these names whenever a tab fits it):\n${existingGroupNames
            .map((n) => `- ${n}`)
            .join("\n")}\n`
        : "";
    return [
      "You organize a user's open browser tabs into a small number of clear, useful groups.",
      existing,
      "Tabs (index. title — url):",
      lines.join("\n"),
      "",
      "How to group:",
      "- Group tabs about the SAME subject, entity, task, or research thread. A search query, its result pages, related maps, menus, articles, docs, and repos about one thing ALL belong in the same group (e.g. a 'Grillo's Pickles' web search, its homepage, and a 'where to buy' page go together).",
      "- Prefer FEWER, BROADER groups over many tiny ones. If two would-be groups are really about the same underlying topic (one package manager, one restaurant, one car task), MERGE them into one.",
      "- Be COMPREHENSIVE: put every tab that clearly relates to at least one other tab into a group. Do not create a group and then leave obvious members of it ungrouped. Only omit a tab if it has no clear connection to any other tab.",
      "- Reuse an existing group name (listed above) whenever a tab fits it, instead of inventing a near-duplicate.",
      "",
      "Naming:",
      "- Name each group after its shared subject as a short, specific noun phrase in Title Case, at most 24 characters.",
      "- Avoid vague or single generic words like 'Space', 'Misc', 'Problem', or 'Car'. Use the concrete subject instead (e.g. 'Bun Package Manager', 'Car Interior Cleaning', 'Trilium Notes').",
      "",
      "Rules:",
      "- Every group must contain at least 2 tabs.",
      "- Each tab index appears in at most one group.",
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

  // --- Providers ---
  const PROVIDERS = {
    gemini: {
      build(prompt) {
        const key = PREFS.geminiKey();
        if (!key) throw new Error("Gemini API key not set");
        const model = PREFS.geminiModel();
        const generationConfig = {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: GEMINI_SCHEMA,
        };
        // Tab-sorting is a quick classification, not a reasoning task. Disabling
        // "thinking" cuts latency dramatically (~11s → ~1.4s on gemini-2.5-flash)
        // with equal or better grouping. Pro models cannot disable it (400), so
        // only apply this on flash-tier models.
        if (!/pro/i.test(model)) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(key)}`,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
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

  // Animation cleanup utility
  const cleanupAnimation = () => {
    // Don't cleanup if failure animation is playing
    if (isPlayingFailureAnimation) {
      return;
    }

    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
      sortAnimationId = null;

      try {
        const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
        const activeSeparator = activeWorkspace?.querySelector(
          ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
        );
        const pathElement = activeSeparator?.querySelector("#separator-path");
        if (pathElement) {
          pathElement.setAttribute("d", "M 0 1 L 100 1");
        }
      } catch (resetError) {
        console.error("Error resetting animation:", resetError);
      }
    }
  };

  // Spiky failure animation utility
  const startFailureAnimation = () => {
    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
    }

    isPlayingFailureAnimation = true;

    try {
      // Find the separator in the ACTIVE workspace, not the first one in DOM
      const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
      const activeSeparator = activeWorkspace?.querySelector(
        ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
      );
      const pathElement = activeSeparator?.querySelector("#separator-path");

      if (pathElement) {
        const maxAmplitude = 8; // Much higher amplitude for spiky effect
        const frequency = 20; // Higher frequency for more spikes
        const segments = 100; // More segments for sharper spikes
        const pulseDuration = 400; // Duration of each pulse
        const totalPulses = 3; // Number of pulses
        let currentPulse = 0;
        let t = 0;
        let startTime = performance.now();
        let pulseStartTime = startTime;

        function animateFailureLoop(timestamp) {
          if (sortAnimationId === null) return;

          const elapsedSincePulseStart = timestamp - pulseStartTime;
          const pulseProgress = elapsedSincePulseStart / pulseDuration;

          if (pulseProgress >= 1) {
            currentPulse++;
            if (currentPulse >= totalPulses) {
              // Animation complete, reset to straight line
              pathElement.setAttribute("d", "M 0 1 L 100 1");
              sortAnimationId = null;
              isPlayingFailureAnimation = false;
              return;
            }
            // Start next pulse
            pulseStartTime = timestamp;
          }

          // Create spiky wave with sharp peaks and valleys
          const currentProgress = Math.min(pulseProgress, 1);
          const intensity = Math.sin(currentProgress * Math.PI); // Pulse intensity (0 to 1 to 0)
          const currentAmplitude = maxAmplitude * intensity;

          t += 1.2; // Faster animation speed

          const points = [];
          for (let i = 0; i <= segments; i++) {
            const x = (i / segments) * 100;
            // Create sharp spikes using a combination of sine waves
            const baseWave = Math.sin(
              (x / (100 / frequency)) * 2 * Math.PI + t * 0.15
            );
            const sharpWave =
              Math.sign(baseWave) * Math.pow(Math.abs(baseWave), 0.3); // Sharp peaks
            const y = 1 + currentAmplitude * sharpWave;
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
          }

          if (pathElement?.isConnected) {
            const pathData = "M" + points.join(" L");
            pathElement.setAttribute("d", pathData);
            sortAnimationId = requestAnimationFrame(animateFailureLoop);
          } else {
            sortAnimationId = null;
            isPlayingFailureAnimation = false;
          }
        }

        sortAnimationId = requestAnimationFrame(animateFailureLoop);
      }
    } catch (error) {
      console.error("Error in failure animation:", error);
      isPlayingFailureAnimation = false;
    }
  };

  // --- Main Sorting Function ---
  const sortTabsByTopic = async () => {
    if (isSorting) return;
    isSorting = true;

    let separatorsToSort = [];
    try {
      separatorsToSort = domCache.getSeparators();
      // Apply visual indicator
      if (separatorsToSort.length > 0) {
        batchDOMUpdates([
          () =>
            separatorsToSort.forEach((sep) => {
              if (sep?.isConnected) {
                sep.classList.add("separator-is-sorting");
              }
            }),
        ]);
      }

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) {
        console.error("Cannot get current workspace ID.");
        return; // Exit early
      }

      // --- Step 1: Get ALL Existing Group Names for Context ---
      const allExistingGroupNames = new Set();
      const groupSelector = `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`;

      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          allExistingGroupNames.add(label);
        }
      });

      // --- Filter initial tabs using optimized function ---
      const initialTabsToSort = getFilteredTabs(currentWorkspaceId, {
        includeGrouped: false,
        includeSelected: true,
        includePinned: false,
        includeEmpty: false,
        includeGlance: false,
      }).filter((tab) => {
        const groupParent = tab.closest("tab-group");
        const isInGroupInCorrectWorkspace = groupParent
          ? groupParent.matches(groupSelector)
          : false;
        return !isInGroupInCorrectWorkspace;
      });

      console.log(
        "[TabSort] Debug - Initial tabs to sort count:",
        initialTabsToSort.length
      );
      if (initialTabsToSort.length === 0) {
        console.log("[TabSort] Debug - No tabs to sort, returning early");
        return;
      }

      // --- AI Grouping ---
      console.log(
        "[TabSort] Debug - Starting AI grouping for",
        initialTabsToSort.length,
        "tabs"
      );
      const aiTabTopics = await askAIForMultipleTopics(initialTabsToSort);
      console.log(
        "[TabSort] Debug - AI returned",
        aiTabTopics.length,
        "tab-topic pairs"
      );
      // --- End AI Grouping ---

      // --- Create Final Groups ---
      const finalGroups = {};
      aiTabTopics.forEach(({ tab, topic }) => {
        if (!topic || topic === "Uncategorized" || !tab || !tab.isConnected) {
          return;
        }
        if (!finalGroups[topic]) {
          finalGroups[topic] = [];
        }
        finalGroups[topic].push(tab);
      });

      // Single-tab groups are already filtered out at the clustering level
      // --- End Create Final Groups ---

      // --- Consolidate Similar Category Names ---
      const originalKeys = Object.keys(finalGroups);
      const mergedKeys = new Set();
      const consolidationMap = {};

      for (let i = 0; i < originalKeys.length; i++) {
        let keyA = originalKeys[i];
        if (mergedKeys.has(keyA)) continue;
        while (consolidationMap[keyA]) {
          keyA = consolidationMap[keyA];
        }
        if (mergedKeys.has(keyA)) continue;

        for (let j = i + 1; j < originalKeys.length; j++) {
          let keyB = originalKeys[j];
          if (mergedKeys.has(keyB)) continue;
          while (consolidationMap[keyB]) {
            keyB = consolidationMap[keyB];
          }
          if (mergedKeys.has(keyB) || keyA === keyB) continue;

          const distance = levenshteinDistance(keyA, keyB);
          const threshold = CONFIG.CONSOLIDATION_DISTANCE_THRESHOLD;

          if (distance <= threshold && distance > 0) {
            let canonicalKey = keyA;
            let mergedKey = keyB;
            const keyAIsActuallyExisting = allExistingGroupNames.has(keyA);
            const keyBIsActuallyExisting = allExistingGroupNames.has(keyB);

            if (keyBIsActuallyExisting && !keyAIsActuallyExisting) {
              [canonicalKey, mergedKey] = [keyB, keyA];
            } else if (keyAIsActuallyExisting && keyBIsActuallyExisting) {
              if (keyA.length > keyB.length)
                [canonicalKey, mergedKey] = [keyB, keyA];
            } else if (!keyAIsActuallyExisting && !keyBIsActuallyExisting) {
              if (keyA.length > keyB.length)
                [canonicalKey, mergedKey] = [keyB, keyA];
            }

            if (finalGroups[mergedKey]) {
              if (!finalGroups[canonicalKey]) finalGroups[canonicalKey] = [];
              const uniqueTabsToAdd = finalGroups[mergedKey].filter(
                (tab) =>
                  tab &&
                  tab.isConnected &&
                  !finalGroups[canonicalKey].some(
                    (existingTab) => existingTab === tab
                  )
              );
              finalGroups[canonicalKey].push(...uniqueTabsToAdd);
            }
            mergedKeys.add(mergedKey);
            consolidationMap[mergedKey] = canonicalKey;
            delete finalGroups[mergedKey];
            if (mergedKey === keyA) {
              keyA = canonicalKey;
              break;
            }
          }
        }
      }

      // --- End Consolidation ---

      // Check if sorting failed (no meaningful grouping occurred)
      // Success criteria:
      // 1. Created groups with multiple tabs, OR
      // 2. Successfully matched tabs to existing groups (even single tabs)
      const multiTabGroups = Object.values(finalGroups).filter(
        (tabs) => tabs.length > 1
      );
      
      // Count tabs that were successfully matched to existing groups
      const tabsMatchedToExistingGroups = aiTabTopics.length;
      
      // Sorting is successful if:
      // - We created new multi-tab groups, OR
      // - We matched tabs to existing groups, OR  
      // - We only had 1 tab to sort (no failure for single tabs)
      const sortingFailed = 
        multiTabGroups.length === 0 && 
        tabsMatchedToExistingGroups === 0 && 
        initialTabsToSort.length > 1;

      console.log(
        "[TabSort] Debug - Initial tabs to sort:",
        initialTabsToSort.length
      );
      console.log("[TabSort] Debug - Final groups:", Object.keys(finalGroups));
      console.log("[TabSort] Debug - Multi-tab groups:", multiTabGroups.length);
      console.log("[TabSort] Debug - Tabs matched to existing groups:", tabsMatchedToExistingGroups);
      console.log(
        "[TabSort] Debug - multiTabGroups.length === 0:",
        multiTabGroups.length === 0
      );
      console.log(
        "[TabSort] Debug - tabsMatchedToExistingGroups === 0:",
        tabsMatchedToExistingGroups === 0
      );
      console.log(
        "[TabSort] Debug - initialTabsToSort.length > 1:",
        initialTabsToSort.length > 1
      );
      console.log("[TabSort] Debug - Sorting failed:", sortingFailed);

      if (sortingFailed) {
        console.log("[TabSort] Triggering failure animation");
        // Trigger failure animation
        startFailureAnimation();
        return;
      }

      if (Object.keys(finalGroups).length === 0) {
        console.log(
          "[TabSort] Debug - No final groups, returning early (this should not happen after failure detection)"
        );
        return;
      }

      // --- Get existing group ELEMENTS ---
      const existingGroupElementsMap = new Map();
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          existingGroupElementsMap.set(label, groupEl);
        }
      });

      // --- Process each final, consolidated group ---
      for (const topic in finalGroups) {
        const tabsForThisTopic = finalGroups[topic].filter((t) => {
          const groupParent = t.closest("tab-group");
          const isInGroupInCorrectWorkspace = groupParent
            ? groupParent.matches(groupSelector)
            : false;
          return t && t.isConnected && !isInGroupInCorrectWorkspace;
        });

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const existingGroupElement = existingGroupElementsMap.get(topic);

        if (existingGroupElement && existingGroupElement.isConnected) {
          try {
            if (existingGroupElement.getAttribute("collapsed") === "true") {
              existingGroupElement.setAttribute("collapsed", "false");
              const groupLabelElement =
                existingGroupElement.querySelector(".tab-group-label");
              if (groupLabelElement) {
                groupLabelElement.setAttribute("aria-expanded", "true");
              }
            }
            for (const tab of tabsForThisTopic) {
              const groupParent = tab.closest("tab-group");
              const isInGroupInCorrectWorkspace = groupParent
                ? groupParent.matches(groupSelector)
                : false;
              if (tab && tab.isConnected && !isInGroupInCorrectWorkspace) {
                gBrowser.moveTabToExistingGroup(tab, existingGroupElement);
              } else {
                console.warn(
                  ` -> Tab "${
                    getTabTitle(tab) || "Unknown"
                  }" skipped moving to "${topic}" (already grouped or invalid).`
                );
              }
            }
          } catch (e) {
            console.error(
              `Error moving tabs to existing group "${topic}":`,
              e,
              existingGroupElement
            );
          }
        } else {
          if (existingGroupElement && !existingGroupElement.isConnected) {
            console.warn(
              ` -> Existing group element for "${topic}" was found in map but is no longer connected to DOM. Will create a new group.`
            );
          }

          // Create group for any topic with tabs
          if (tabsForThisTopic.length > 0) {
            const firstValidTabForGroup = tabsForThisTopic[0];
            const groupOptions = {
              label: topic,
              insertBefore: firstValidTabForGroup,
            };
            try {
              const newGroup = gBrowser.addTabGroup(
                tabsForThisTopic,
                groupOptions
              );
              if (newGroup && newGroup.isConnected) {
                existingGroupElementsMap.set(topic, newGroup);

                // Try to set group color to average favicon if advanced-tab-groups is available
                try {
                  if (typeof newGroup._useFaviconColor === "function") {
                    setTimeout(() => newGroup._useFaviconColor(), 500);
                  }
                } catch (e) {
                  // Silently ignore if advanced-tab-groups is not installed
                }
              } else {
                console.warn(
                  ` -> addTabGroup didn't return a connected element for "${topic}". Attempting fallback find.`
                );
                // Use the CORRECT findGroupElement helper from clear script (needs to be added/updated)
                const newGroupElFallback = findGroupElement(
                  topic,
                  currentWorkspaceId
                );
                if (newGroupElFallback && newGroupElFallback.isConnected) {
                  existingGroupElementsMap.set(topic, newGroupElFallback);

                  // Try to set group color to average favicon if advanced-tab-groups is available
                  try {
                    if (
                      typeof newGroupElFallback._useFaviconColor === "function"
                    ) {
                      setTimeout(
                        () => newGroupElFallback._useFaviconColor(),
                        500
                      );
                    }
                  } catch (e) {
                    // Silently ignore if advanced-tab-groups is not installed
                  }
                } else {
                  console.error(
                    ` -> Failed to find the newly created group element for "${topic}" even with fallback.`
                  );
                }
              }
            } catch (e) {
              console.error(
                `Error calling gBrowser.addTabGroup for topic "${topic}":`,
                e
              );
              const groupAfterError = findGroupElement(
                topic,
                currentWorkspaceId
              );
              if (groupAfterError && groupAfterError.isConnected) {
                console.warn(
                  ` -> Group "${topic}" might exist despite error. Found via findGroupElement.`
                );
                existingGroupElementsMap.set(topic, groupAfterError);

                // Try to set group color to average favicon if advanced-tab-groups is available
                try {
                  if (typeof groupAfterError._useFaviconColor === "function") {
                    setTimeout(() => groupAfterError._useFaviconColor(), 500);
                  }
                } catch (e) {
                  // Silently ignore if advanced-tab-groups is not installed
                }
              } else {
                console.error(
                  ` -> Failed to find group "${topic}" after creation error.`
                );
              }
            }
          } else {
          }
        }
      } // End loop through final groups

      // --- Reorder tabs: groups first, then ungrouped tabs ---
      try {
        const workspaceElement = gZenWorkspaces?.activeWorkspaceElement;
        
        if (workspaceElement?.tabsContainer) {
          const tabsContainer = workspaceElement.tabsContainer;
          const allChildren = Array.from(tabsContainer.children);
          
          // Separate groups and ungrouped tabs
          // Since we're in the workspace's tabsContainer, all direct children belong to this workspace
          const groups = [];
          const ungroupedTabs = [];
          const otherElements = []; // For any other elements (like periphery hbox)
          
          for (const child of allChildren) {
            const tagName = child.tagName?.toLowerCase();
            if (tagName === "tab-group") {
              // All tab-groups in this container belong to the workspace
              groups.push(child);
            } else if (tagName === "tab") {
              // Check if tab is valid (not empty, not glance)
              if (
                !child.hasAttribute("zen-empty-tab") &&
                !child.hasAttribute("zen-glance-tab")
              ) {
                ungroupedTabs.push(child);
              } else {
                otherElements.push(child);
              }
            } else {
              // Other elements (like hbox periphery)
              otherElements.push(child);
            }
          }
          
          console.log("[TabSort] Reorder - groups:", groups.length, "ungrouped:", ungroupedTabs.length);
          
          // Only reorder if we have both groups AND ungrouped tabs
          if (groups.length > 0 && ungroupedTabs.length > 0) {
            console.log("[TabSort] Reorder - Moving ungrouped tabs below groups...");
            
            // Move each ungrouped tab to after the last group
            const lastGroup = groups[groups.length - 1];
            let insertAfterElement = lastGroup;
            
            ungroupedTabs.forEach((tab) => {
              if (tab.isConnected && insertAfterElement?.isConnected) {
                // Insert tab after the reference element
                const nextSibling = insertAfterElement.nextSibling;
                if (nextSibling) {
                  tabsContainer.insertBefore(tab, nextSibling);
                } else {
                  tabsContainer.appendChild(tab);
                }
                insertAfterElement = tab;
              }
            });
            
            console.log("[TabSort] Reorder - Complete!");
          }
        }
      } catch (reorderError) {
        console.error("Error reordering tabs (groups first):", reorderError);
        // Don't fail the whole sort if reordering fails
      }
    } catch (error) {
      console.error("Error during overall sorting process:", error);
    } finally {
      // If failure animation is playing, delay the cleanup
      if (isPlayingFailureAnimation) {
        // Wait for failure animation to complete (3 pulses * 400ms each + buffer)
        setTimeout(() => {
          isSorting = false;
          cleanupAnimation();

          // Remove separator pulse indicator
          if (separatorsToSort.length > 0) {
            batchDOMUpdates([
              () =>
                separatorsToSort.forEach((sep) => {
                  if (sep?.isConnected) {
                    sep.classList.remove("separator-is-sorting");
                  }
                }),
            ]);
          }

          // Remove tab loading indicators and update button visibility
          setTimeout(() => {
            batchDOMUpdates([
              () => {
                if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                  Array.from(gBrowser.tabs).forEach((tab) => {
                    if (tab?.isConnected) {
                      tab.classList.remove("tab-is-sorting");
                    }
                  });
                }
              },
            ]);
            updateButtonsVisibilityState();
          }, 500);
        }, 1500); // 3 pulses * 400ms + 300ms buffer
      } else {
        isSorting = false;

        // Cleanup animation
        cleanupAnimation();

        // Remove separator pulse indicator
        if (separatorsToSort.length > 0) {
          batchDOMUpdates([
            () =>
              separatorsToSort.forEach((sep) => {
                if (sep?.isConnected) {
                  sep.classList.remove("separator-is-sorting");
                }
              }),
          ]);
        }

        // Remove tab loading indicators and update button visibility
        setTimeout(() => {
          batchDOMUpdates([
            () => {
              if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                Array.from(gBrowser.tabs).forEach((tab) => {
                  if (tab?.isConnected) {
                    tab.classList.remove("tab-is-sorting");
                  }
                });
              }
            },
          ]);
          updateButtonsVisibilityState();
        }, 500);
      }
    }
  };

  // --- Button Initialization & Workspace Handling ---
  function ensureSortButtonExists(separator) {
    if (!separator) {
      return;
    }
    try {
      // --- Create and Insert SVG with SINGLE Path ---
      if (!separator.querySelector("svg.separator-line-svg")) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("class", "separator-line-svg");
        svg.setAttribute("viewBox", "0 0 100 2");
        svg.setAttribute("preserveAspectRatio", "none");

        // Create ONE path
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("id", `separator-path`); // Single ID
        path.setAttribute("class", "separator-path-segment"); // Keep common class
        path.setAttribute("d", "M 0 1 L 100 1"); // Initial straight line
        path.style.fill = "none";
        path.style.opacity = "1"; // Ensure it's visible
        path.setAttribute("stroke-width", "1"); // Added: Set initial stroke width
        path.setAttribute("stroke-linecap", "round"); // Added: Make path ends round
        svg.appendChild(path);

        separator.insertBefore(svg, separator.firstChild);
      } else {
      }
      // --- End SVG ---

      // --- Create and Append Sort Button (positioned before native clear button) ---
      if (!separator.querySelector("#sort-button")) {
        // Find the native clear button to position sort button before it
        const nativeClearButton = separator.querySelector(".zen-workspace-close-unpinned-tabs-button");
        const buttonFragment = window.MozXULElement.parseXULToFragment(`
                        <toolbarbutton
                            id="sort-button"
                            class="sort-button-with-icon"
                            command="cmd_zenSortTabs"
                            tooltiptext="Sort Tabs into Groups by Topic (AI)">
                            <hbox class="toolbarbutton-box" align="center">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 28 28" class="broom-icon">
                                    <g>
                                        <path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z" stroke="none"/>
                                        <path d="M16.719 1.7134C17.4929-0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z" stroke="none"/>
                                    </g>
                                </svg>
                            </hbox>
                        </toolbarbutton>
                    `);
        const buttonNode = buttonFragment.firstChild.cloneNode(true);

        // Insert before native clear button if it exists, otherwise append
        if (nativeClearButton) {
          separator.insertBefore(buttonNode, nativeClearButton);
        } else {
          separator.appendChild(buttonNode);
        }
      } else {
      }
      // --- End Sort Button ---
    } catch (e) {}
  }

  function addSortButtonToAllSeparators() {
    const separators = domCache.getSeparators();
    if (separators.length > 0) {
      separators.forEach(ensureSortButtonExists);
      updateButtonsVisibilityState();
    } else {
      const periphery = document.querySelector(
        "#tabbrowser-arrowscrollbox-periphery"
      );
      if (periphery && !periphery.querySelector("#sort-button")) {
        ensureSortButtonExists(periphery);
      }
    }
    updateButtonsVisibilityState();
  }

  function setupSortCommandAndListener() {
    const zenCommands = domCache.getCommandSet();
    if (!zenCommands) return;

    // Add Sort command
    if (!zenCommands.querySelector("#cmd_zenSortTabs")) {
      try {
        const command = window.MozXULElement.parseXULToFragment(
          `<command id="cmd_zenSortTabs"/>`
        ).firstChild;
        zenCommands.appendChild(command);
      } catch (e) {}
    }

    // Add Sort button listener
    if (!sortButtonListenerAdded) {
      try {
        zenCommands.addEventListener("command", (event) => {
          if (event.target.id === "cmd_zenSortTabs") {
            // Find the separator in the ACTIVE workspace
            const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
            const separator = activeWorkspace?.querySelector(
              ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
            );

            // Add brushing animation class to the sort button in the active workspace
            const sortButton = separator?.querySelector("#sort-button");
            if (sortButton) {
              sortButton.classList.add("brushing");
              // Remove class after animation completes
              setTimeout(() => {
                if (sortButton?.isConnected) {
                  sortButton.classList.remove("brushing");
                }
              }, CONFIG.ANIMATION_DURATION);
            }

            // Prevent starting animation if already running
            if (sortAnimationId !== null) return;

            if (!separator) {
              sortTabsByTopic(); // Still run sort even if animation fails
              return;
            }

            // --- Start Animation logic ---
            const pathElement = separator.querySelector("#separator-path");
            if (pathElement) {
              const maxAmplitude = 3;
              const frequency = 8;
              const segments = 50;
              const growthDuration = 500;
              let t = 0;
              let startTime = performance.now();

              function animateWaveLoop(timestamp) {
                // Check if animation should continue
                if (sortAnimationId === null) return;

                const elapsedTime = timestamp - startTime;
                const growthProgress = Math.min(
                  elapsedTime / growthDuration,
                  1
                );
                const currentAmplitude = maxAmplitude * growthProgress;

                t += 0.5;

                const points = [];
                for (let i = 0; i <= segments; i++) {
                  const x = (i / segments) * 100;
                  const y =
                    1 +
                    currentAmplitude *
                      Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.1);
                  points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
                }

                if (pathElement?.isConnected) {
                  const pathData = "M" + points.join(" L");
                  pathElement.setAttribute("d", pathData);
                  sortAnimationId = requestAnimationFrame(animateWaveLoop);
                } else {
                  sortAnimationId = null;
                }
              }

              sortAnimationId = requestAnimationFrame(animateWaveLoop);
            }
            // --- End Animation Logic ---

            // Call the actual sorting logic AFTER starting animation
            sortTabsByTopic();
          }
        });
        sortButtonListenerAdded = true;
      } catch (e) {}
    }
  }

  // --- gZenWorkspaces Hooks ---
  function setupgZenWorkspacesHooks() {
    if (typeof window.gZenWorkspaces === "undefined") {
      return;
    }

    const originalOnTabBrowserInserted =
      window.gZenWorkspaces.onTabBrowserInserted;
    const originalUpdateTabsContainers =
      window.gZenWorkspaces.updateTabsContainers;

    window.gZenWorkspaces.onTabBrowserInserted = function (event) {
      if (typeof originalOnTabBrowserInserted === "function") {
        try {
          originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original onTabBrowserInserted:",
            e
          );
        }
      }
      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };

    window.gZenWorkspaces.updateTabsContainers = function (...args) {
      if (typeof originalUpdateTabsContainers === "function") {
        try {
          originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original updateTabsContainers:",
            e
          );
        }
      }
      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };
  }

  // --- Patch Clear Button to Preserve Tab-Groups ---
  function patchClearButtonToPreserveGroups() {
    if (typeof window.gZenWorkspaces === "undefined") {
      console.warn("[TidyTabs] gZenWorkspaces not available, cannot patch clear button");
      return;
    }

    // Store the original method
    const originalCloseAllUnpinnedTabs = window.gZenWorkspaces.closeAllUnpinnedTabs;
    
    if (typeof originalCloseAllUnpinnedTabs !== "function") {
      console.warn("[TidyTabs] closeAllUnpinnedTabs method not found");
      return;
    }

    // Override the method
    window.gZenWorkspaces.closeAllUnpinnedTabs = function() {
      console.log("[TidyTabs] Clear button clicked - filtering to preserve tab-groups");
      
      try {
        // Get the ACTIVE workspace ID - this is critical!
        const currentWorkspaceId = this.activeWorkspace;
        if (!currentWorkspaceId) {
          console.warn("[TidyTabs] No active workspace found");
          return;
        }
        
        // Get all tabs and filter to ONLY the active workspace
        const allTabs = Array.from(gBrowser.tabs).filter(tab => {
          const tabWorkspaceId = tab.getAttribute("zen-workspace-id");
          return tabWorkspaceId === currentWorkspaceId;
        });
        
        // Filter tabs to close: exclude pinned, grouped, essential, empty, and selected tabs
        const tabsToClose = allTabs.filter(tab => {
          // Safety check
          if (!tab || !tab.isConnected) return false;
          
          // Don't close the selected tab
          if (tab.selected) {
            return false;
          }
          
          // Don't close pinned tabs
          if (tab.pinned) {
            return false;
          }
          
          // Don't close tabs that are in a group/folder
          if (tab.group) {
            // Check if it's a zen-folder
            if (tab.group.isZenFolder || tab.group.tagName === "zen-folder") {
              return false;
            }
            // Check if it's a regular tab-group (not split-view)
            if (tab.group.tagName === "tab-group" && !tab.group.hasAttribute("split-view-group")) {
              return false;
            }
          }
          
          // Don't close essential tabs
          if (tab.hasAttribute("zen-essential")) {
            return false;
          }
          
          // Don't close empty tabs
          if (tab.hasAttribute("zen-empty-tab")) {
            return false;
          }
          
          // Don't close glance tabs
          if (tab.hasAttribute("zen-glance-tab")) {
            return false;
          }
          
          // This tab can be closed
          return true;
        });
        
        console.log(`[TidyTabs] Closing ${tabsToClose.length} tabs, preserving ${allTabs.length - tabsToClose.length} tabs`);
        
        // Close the filtered tabs
        if (tabsToClose.length > 0) {
          gBrowser.removeTabs(tabsToClose);
          
          // Show a toast notification
          if (typeof gZenUIManager !== "undefined" && gZenUIManager.showToast) {
            gZenUIManager.showToast("zen-workspaces-close-all-unpinned-tabs-toast", {
              shortcut: "Ctrl+Shift+T"
            });
          }
        } else {
          console.log("[TidyTabs] No tabs to close");
        }
      } catch (error) {
        console.error("[TidyTabs] Error in patched closeAllUnpinnedTabs:", error);
        // Fallback to original method if there's an error
        if (typeof originalCloseAllUnpinnedTabs === "function") {
          originalCloseAllUnpinnedTabs.call(this);
        }
      }
    };
    
    console.log("[TidyTabs] Successfully patched closeAllUnpinnedTabs to preserve tab-groups");
  }

  // --- Optimized Helper: Count Tabs for Button Visibility ---
  const countTabsForButtonVisibility = () => {
    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;

    if (
      !currentWorkspaceId ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabs
    ) {
      return {
        ungroupedTotal: 0,
        ungroupedNonSelected: 0,
        hasGroupedTabs: false,
      };
    }

    let ungroupedTotal = 0;
    let ungroupedNonSelected = 0;
    let hasGroupedTabs = false;

    // Use optimized filtering
    const allTabs = getFilteredTabs(currentWorkspaceId, {
      includeGrouped: true,
      includeSelected: true,
      includePinned: false,
      includeEmpty: false,
      includeGlance: false,
    });

    for (const tab of allTabs) {
      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;
      const isSelected = tab.selected;

      if (isInGroup) {
        hasGroupedTabs = true;
      } else {
        ungroupedTotal++;
        if (!isSelected) {
          ungroupedNonSelected++;
        }
      }
    }

    return {
      ungroupedTotal,
      ungroupedNonSelected,
      hasGroupedTabs,
    };
  };

  // --- Updated Helper: Update Button Visibility State ---
  const updateButtonsVisibilityState = () => {
    const { ungroupedTotal, ungroupedNonSelected, hasGroupedTabs } =
      countTabsForButtonVisibility();
    const separators = domCache.getSeparators();

    batchDOMUpdates([
      () => {
        separators.forEach((separator) => {
          if (!separator?.isConnected) return;

          // Handle Tidy button visibility
          const tidyButton = separator.querySelector("#sort-button");
          if (tidyButton) {
            // Show button if:
            // 1. We have existing groups and any ungrouped tabs (even just 1)
            // 2. OR we have enough ungrouped tabs to potentially create new groups
            const shouldShowTidyButton = hasGroupedTabs
              ? ungroupedTotal > 0  // Show if any ungrouped tabs exist when groups are present
              : ungroupedTotal >= CONFIG.MIN_TABS_FOR_SORT; // Original logic for new group creation

            if (shouldShowTidyButton) {
              tidyButton.classList.remove("hidden-button");
              // Update tooltip based on context
              if (hasGroupedTabs && ungroupedTotal > 0) {
                tidyButton.setAttribute("tooltiptext", 
                  ungroupedTotal === 1 
                    ? "Sort Tab into Existing Groups by Topic (AI)"
                    : "Sort Tabs into Groups by Topic (AI)"
                );
              } else {
                tidyButton.setAttribute("tooltiptext", "Sort Tabs into Groups by Topic (AI)");
              }
            } else {
              tidyButton.classList.add("hidden-button");
            }
          }

          // Always keep the separator visible
          separator.classList.remove("has-no-sortable-tabs");
        });
      },
    ]);
  };

  // --- Add Tab Event Listeners for Visibility Updates ---
  function addTabEventListeners() {
    if (
      eventListenersAdded ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    const updateVisibilityDebounced = debounce(
      updateButtonsVisibilityState,
      CONFIG.DEBOUNCE_DELAY
    );

    const events = [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabPinned",
      "TabUnpinned",
      "TabGroupAdd",
      "TabGroupRemove",
      "TabGrouped",
      "TabUngrouped",
      "TabAttrModified",
    ];

    events.forEach((eventName) => {
      gBrowser.tabContainer.addEventListener(
        eventName,
        updateVisibilityDebounced
      );
    });

    // Listen to workspace changes
    if (typeof window.gZenWorkspaces !== "undefined") {
      window.addEventListener(
        "zen-workspace-switched",
        updateVisibilityDebounced
      );
    }

    eventListenersAdded = true;
  }

  // --- Debounce Utility (to prevent rapid firing) ---
  function debounce(func, wait) {
    if (typeof func !== "function" || typeof wait !== "number") {
      return () => {};
    }

    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // --- Cleanup Function ---
  const cleanup = () => {
    try {
      // Stop any running animations
      cleanupAnimation();

      // Clear DOM cache
      domCache.invalidate();

      // Reset state
      isSorting = false;
      eventListenersAdded = false;

      console.log("Tab sort script cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  };

  // --- Initial Setup Trigger ---
  function initializeScript() {
    const tryInitialize = () => {
      try {
        const separatorExists = domCache.getSeparators().length > 0;
        const commandSetExists = !!domCache.getCommandSet();
        const gBrowserReady =
          typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
        const gZenWorkspacesReady =
          typeof window.gZenWorkspaces !== "undefined";

        const ready =
          gBrowserReady &&
          commandSetExists &&
          separatorExists &&
          gZenWorkspacesReady;

        if (ready) {
          setupSortCommandAndListener();
          addSortButtonToAllSeparators();
          setupgZenWorkspacesHooks();
          patchClearButtonToPreserveGroups(); // Patch the clear button
          updateButtonsVisibilityState();
          addTabEventListeners();

          return true;
        }
      } catch (e) {
        console.error("Error during initialization:", e);
      }
      return false;
    };

    // Try immediate initialization
    if (tryInitialize()) return;

    // Fallback to polling
    let checkCount = 0;
    const initCheckInterval = setInterval(() => {
      checkCount++;

      if (tryInitialize()) {
        clearInterval(initCheckInterval);
      } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
        clearInterval(initCheckInterval);
        console.warn(
          `Tab sort initialization timed out after ${
            CONFIG.MAX_INIT_CHECKS * CONFIG.INIT_CHECK_INTERVAL
          }ms`
        );
      }
    }, CONFIG.INIT_CHECK_INTERVAL);
  }

  // --- Start Initialization ---
  if (document.readyState === "complete") {
    initializeScript();
  } else {
    window.addEventListener("load", initializeScript, { once: true });
  }

  // --- Add Cleanup Listeners ---
  window.addEventListener("unload", cleanup, { once: true });
  window.addEventListener("beforeunload", cleanup, { once: true });
})(); // End script
