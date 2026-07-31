let allActionLogs = [];
let allSystemLogs = [];
let activeTab = 'actions'; // 'actions' or 'syslogs'

let sessions = [];
let defaultSessionId = null;
let activeSessionId = null;

let autoMode = false;

let modalActionId = null;
let modalActionType = null;
let modalSuggestions = [];

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initAutoMode();
    document.addEventListener("click", (e) => {
        const menu = document.getElementById("session-menu");
        const trigger = document.getElementById("session-trigger");
        if (!menu.contains(e.target) && !trigger.contains(e.target)) {
            closeSessionMenu();
        }
    });
    document.getElementById("session-create-form").addEventListener("submit", handleCreateSession);
    document.getElementById("chat-form").addEventListener("submit", handleChatSubmit);
    document.getElementById("espn-settings-form").addEventListener("submit", handleEspnSettingsSubmit);
    loadSessions();
});

/* ---------------------------------------------------------------------- */
/* Theme                                                                   */
/* ---------------------------------------------------------------------- */

function initTheme() {
    const saved = localStorage.getItem("nfl_theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    document.getElementById("theme-icon").innerText = saved === "dark" ? "🌙" : "☀️";
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", current);
    localStorage.setItem("nfl_theme", current);
    document.getElementById("theme-icon").innerText = current === "dark" ? "🌙" : "☀️";
}

/* ---------------------------------------------------------------------- */
/* Suggest / Auto execution mode                                            */
/* ---------------------------------------------------------------------- */

function initAutoMode() {
    autoMode = localStorage.getItem("nfl_auto_mode") === "true";
    renderModeToggle();
}

function setAutoMode(value) {
    autoMode = value;
    localStorage.setItem("nfl_auto_mode", String(value));
    renderModeToggle();
}

function renderModeToggle() {
    document.getElementById("mode-suggest").classList.toggle("active", !autoMode);
    document.getElementById("mode-auto").classList.toggle("active", autoMode);
    document.getElementById("mode-auto").classList.toggle("auto-active", autoMode);

    const hint = document.getElementById("mode-hint");
    hint.classList.toggle("warn", autoMode);
    hint.innerText = autoMode
        ? "Auto mode: accepted-by-default actions run on ESPN immediately, no review."
        : "Review and accept each suggestion before anything runs on ESPN.";
}

/* ---------------------------------------------------------------------- */
/* Sessions                                                                 */
/* ---------------------------------------------------------------------- */

async function loadSessions() {
    try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error("Failed to load sessions");
        const data = await res.json();
        sessions = data.sessions || [];
        defaultSessionId = data.default_session_id;

        const stored = localStorage.getItem("nfl_active_session");
        activeSessionId = sessions.find(s => s.id === stored) ? stored : defaultSessionId;

        renderSessionSwitcher();
        loadHistory();
        loadLeagueSettings();
        loadEspnSettings();
    } catch (err) {
        document.getElementById("session-trigger-name").innerText = "Sessions unavailable";
    }
}

async function loadLeagueSettings() {
    const formatEl = document.getElementById("league-format-value");
    const rosterEl = document.getElementById("league-roster-value");
    const wrapperEl = document.getElementById("league-info-inline");
    try {
        const res = await fetch(`/api/league-settings${sessionQuery()}`);
        if (!res.ok) throw new Error("Failed to load league settings");
        const settings = await res.json();
        if (settings) {
            formatEl.innerText = settings.league_format;
            rosterEl.innerText = settings.roster_settings;
            wrapperEl.title = `${settings.league_format} — ${settings.roster_settings}`;
        } else {
            formatEl.innerText = "Run Start Live Draft to fetch league settings";
            rosterEl.innerText = "";
            wrapperEl.title = "League settings haven't been fetched for this session yet";
        }
    } catch (err) {
        formatEl.innerText = "League settings unavailable";
        rosterEl.innerText = "";
        wrapperEl.title = err.message;
    }
}

async function loadEspnSettings() {
    const leagueInput = document.getElementById("espn-league-id-input");
    const teamInput = document.getElementById("espn-team-id-input");
    const s2Input = document.getElementById("espn-s2-input");
    const swidInput = document.getElementById("espn-swid-input");

    leagueInput.value = "";
    teamInput.value = "";
    s2Input.value = "";
    swidInput.value = "";

    try {
        const res = await fetch(`/api/espn-settings${sessionQuery()}`);
        if (!res.ok) throw new Error("Failed to load ESPN settings");
        const settings = await res.json();

        leagueInput.value = settings.league_id || "";
        leagueInput.placeholder = settings.league_id ? "" : "";
        teamInput.value = settings.team_id || "";
        teamInput.placeholder = settings.team_id ? "" : "";
        s2Input.placeholder = settings.espn_s2_set ? "Already saved — leave blank to keep" : "Auto-captured on login";
        swidInput.placeholder = settings.swid_set ? "Already saved — leave blank to keep" : "Auto-captured on login";
    } catch (err) {
        document.getElementById("espn-settings-hint").innerText = `Couldn't load current settings: ${err.message}`;
    }
}

async function handleEspnSettingsSubmit(event) {
    event.preventDefault();
    const hint = document.getElementById("espn-settings-hint");
    const payload = {
        league_id: document.getElementById("espn-league-id-input").value.trim(),
        team_id: document.getElementById("espn-team-id-input").value.trim(),
        espn_s2: document.getElementById("espn-s2-input").value.trim(),
        swid: document.getElementById("espn-swid-input").value.trim(),
    };

    try {
        const res = await fetch(`/api/espn-settings${sessionQuery()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status !== "success") throw new Error(data.message || "Couldn't save settings");

        hint.innerText = "Saved for this session.";
        await loadEspnSettings();
    } catch (err) {
        hint.innerText = `Couldn't save: ${err.message}`;
    }
}

function renderSessionSwitcher() {
    const activeSession = sessions.find(s => s.id === activeSessionId);
    document.getElementById("session-trigger-name").innerText = activeSession ? activeSession.name : "Select session";

    const list = document.getElementById("session-menu-list");
    list.innerHTML = sessions.map(s => {
        const isActive = s.id === activeSessionId;
        const isDefault = s.id === defaultSessionId;
        return `
            <div class="session-menu-item ${isActive ? 'active' : ''}" role="option" aria-selected="${isActive}" tabindex="0"
                 onclick="selectSession('${s.id}')"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectSession('${s.id}');}"
            >
                <span class="session-dot"></span>
                <span class="session-item-name">${escapeHtml(s.name)}</span>
                ${isDefault
                    ? `<span class="default-indicator default-star">Default</span>`
                    : `<button type="button" class="default-indicator set-default-btn" onclick="event.stopPropagation(); setDefaultSession('${s.id}')">Set default</button>`
                }
            </div>
        `;
    }).join("");
}

function toggleSessionMenu() {
    const menu = document.getElementById("session-menu");
    const trigger = document.getElementById("session-trigger");
    const nowHidden = !menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    trigger.setAttribute("aria-expanded", String(!nowHidden));
}

function closeSessionMenu() {
    document.getElementById("session-menu").classList.add("hidden");
    document.getElementById("session-trigger").setAttribute("aria-expanded", "false");
}

function selectSession(sessionId) {
    activeSessionId = sessionId;
    localStorage.setItem("nfl_active_session", sessionId);
    closeSessionMenu();
    renderSessionSwitcher();
    refreshActiveTab();
    loadLeagueSettings();
    loadEspnSettings();
}

async function setDefaultSession(sessionId) {
    try {
        const res = await fetch("/api/sessions/default", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId })
        });
        const data = await res.json();
        if (data.status === "success") {
            defaultSessionId = data.default_session_id;
            renderSessionSwitcher();
        }
    } catch (err) {
        showToast(`Couldn't set default session: ${err.message}`, false);
    }
}

async function handleCreateSession(event) {
    event.preventDefault();
    const input = document.getElementById("session-name-input");
    const name = input.value.trim();
    if (!name) return;

    try {
        const res = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.status !== "success") throw new Error(data.message || "Couldn't create session");

        input.value = "";
        sessions.push(data.session);
        activeSessionId = data.session.id;
        localStorage.setItem("nfl_active_session", activeSessionId);
        closeSessionMenu();
        renderSessionSwitcher();
        refreshActiveTab();
        loadLeagueSettings();
        loadEspnSettings();
    } catch (err) {
        showToast(`Couldn't create session: ${err.message}`, false);
    }
}

function sessionQuery() {
    return activeSessionId ? `?session=${encodeURIComponent(activeSessionId)}` : "";
}

function runQuery() {
    const params = new URLSearchParams();
    if (activeSessionId) params.set("session", activeSessionId);
    params.set("auto", autoMode ? "true" : "false");
    return `?${params.toString()}`;
}

/* ---------------------------------------------------------------------- */
/* Tabs                                                                     */
/* ---------------------------------------------------------------------- */

function switchTab(tab) {
    activeTab = tab;
    document.getElementById("nav-actions").classList.toggle("active", tab === 'actions');
    document.getElementById("nav-syslogs").classList.toggle("active", tab === 'syslogs');
    document.getElementById("nav-chat").classList.toggle("active", tab === 'chat');

    document.getElementById("history-view").classList.toggle("hidden", tab === 'chat');
    document.getElementById("chat-panel").classList.toggle("hidden", tab !== 'chat');

    if (tab === 'actions') {
        document.getElementById("page-heading").innerText = "Action History";
        document.getElementById("page-subheading").innerText = "Recommendations, prompts sent, and automated ESPN execution logs.";
        filterCurrentView();
    } else if (tab === 'syslogs') {
        document.getElementById("page-heading").innerText = "API Cache & System Log";
        document.getElementById("page-subheading").innerText = "IP rate-limit protection, cache hits, and step-by-step automation events.";
        loadSystemLogs();
    } else {
        document.getElementById("page-heading").innerText = "Ask DeepSeek";
        document.getElementById("page-subheading").innerText = "Free-form questions — DeepSeek can look up real player stats to answer.";
        loadChatMessages();
    }
}

function refreshActiveTab() {
    if (activeTab === 'actions') {
        loadHistory();
    } else if (activeTab === 'syslogs') {
        loadSystemLogs();
    } else {
        loadChatMessages();
    }
}

/* ---------------------------------------------------------------------- */
/* Data loading                                                             */
/* ---------------------------------------------------------------------- */

async function loadHistory() {
    const tbody = document.getElementById("logs-table-body");
    tbody.innerHTML = `<tr><td colspan="7" class="loading-state">Loading action history…</td></tr>`;

    try {
        const response = await fetch(`/api/history${sessionQuery()}`);
        if (!response.ok) throw new Error("Failed to fetch history");

        allActionLogs = await response.json();
        updateMetrics(allActionLogs, allSystemLogs);
        if (activeTab === 'actions') filterCurrentView();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" style="color: var(--status-fail); text-align: center;">Couldn't load history: ${escapeHtml(err.message)}</td></tr>`;
    }
}

async function loadSystemLogs() {
    const tbody = document.getElementById("logs-table-body");
    tbody.innerHTML = `<tr><td colspan="4" class="loading-state">Loading system activity…</td></tr>`;

    try {
        const response = await fetch(`/api/system-logs${sessionQuery()}`);
        if (!response.ok) throw new Error("Failed to fetch system logs");

        allSystemLogs = await response.json();
        updateMetrics(allActionLogs, allSystemLogs);
        if (activeTab === 'syslogs') filterCurrentView();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" style="color: var(--status-fail); text-align: center;">Couldn't load system logs: ${escapeHtml(err.message)}</td></tr>`;
    }
}

function updateMetrics(actionLogs, sysLogs) {
    document.getElementById("stat-total-actions").innerText = actionLogs.length;
    document.getElementById("bug-actions").innerText = actionLogs.length;

    const cacheHits = sysLogs.filter(l => l.category === "API_CACHE_HIT").length;
    document.getElementById("stat-cache-hits").innerText = cacheHits;
    document.getElementById("bug-cache").innerText = cacheHits;
}

/* ---------------------------------------------------------------------- */
/* Status → visual mapping                                                  */
/* ---------------------------------------------------------------------- */

function statusVisuals(status) {
    switch (status) {
        case "EXECUTED":
            return { row: "row-success", badge: "badge-success" };
        case "PARTIALLY_EXECUTED":
        case "SIMULATED_FALLBACK":
        case "PENDING_REVIEW":
            return { row: "row-warn", badge: "badge-simulated" };
        case "EXECUTION_FAILED":
            return { row: "row-fail", badge: "badge-failed" };
        case "DECLINED":
            return { row: "row-neutral", badge: "badge-neutral" };
        default:
            return { row: "row-warn", badge: "badge-simulated" };
    }
}

function statusLabel(status) {
    return (status || "").replace(/_/g, " ");
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                                */
/* ---------------------------------------------------------------------- */

function renderActionTable(logs) {
    const tableHead = document.getElementById("table-head");
    tableHead.innerHTML = `
        <tr>
            <th>ID & Date</th>
            <th>Week</th>
            <th>Action</th>
            <th>Players / Output</th>
            <th>Rationale</th>
            <th>Status</th>
            <th>Detail</th>
        </tr>
    `;

    const tbody = document.getElementById("logs-table-body");
    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No plays logged in this session yet. Call a play from the left to get started.</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(log => {
        const startersHtml = (log.starters || []).map(p => `<span class="player-tag">${escapeHtml(p)}</span>`).join("");
        const dateStr = new Date(log.timestamp).toLocaleString();
        const visuals = statusVisuals(log.status);
        const weekText = log.week === 0 ? "Draft" : `Week ${log.week || 1}`;

        return `
            <tr class="${visuals.row}">
                <td class="id-cell">#${log.id}<small>${dateStr}</small></td>
                <td><span class="badge badge-week">${weekText}</span></td>
                <td><strong>${escapeHtml(log.action_type || "LINEUP_OPTIMIZATION")}</strong></td>
                <td>${startersHtml || '<em style="color: var(--text-dim)">None</em>'}</td>
                <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(log.rationale || '')}</td>
                <td><span class="badge ${visuals.badge}">${statusLabel(log.status)}</span></td>
                <td>
                    <button class="btn" style="padding: 0.35rem 0.65rem; font-size: 0.75rem;" onclick="openModal(${log.id})">
                        View
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

function renderSystemTable(logs) {
    const tableHead = document.getElementById("table-head");
    tableHead.innerHTML = `
        <tr>
            <th>ID & Timestamp</th>
            <th>Category</th>
            <th>Event Message</th>
            <th>Details</th>
        </tr>
    `;

    const tbody = document.getElementById("logs-table-body");
    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No system events logged in this session yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(log => {
        const dateStr = new Date(log.timestamp).toLocaleString();
        let badgeClass = "badge-week";
        if (log.category === "API_CACHE_HIT") badgeClass = "badge-success";
        if (log.category.includes("ERROR")) badgeClass = "badge-failed";

        return `
            <tr>
                <td class="id-cell">#${log.id}<small>${dateStr}</small></td>
                <td><span class="badge ${badgeClass}">${log.category}</span></td>
                <td>${escapeHtml(log.message)}</td>
                <td><code style="font-size: 0.75rem;">${escapeHtml(JSON.stringify(log.details_json || {}))}</code></td>
            </tr>
        `;
    }).join("");
}

function statusMatchesFilter(status, filterValue) {
    if (filterValue === "ALL") return true;
    if (filterValue === "EXECUTED") return status === "EXECUTED" || status === "PARTIALLY_EXECUTED";
    return status === filterValue;
}

function filterCurrentView() {
    const query = document.getElementById("search-input").value.toLowerCase();

    if (activeTab === 'actions') {
        const statusFilter = document.getElementById("filter-status").value;
        const filtered = allActionLogs.filter(log => {
            const matchesSearch = !query || `${log.action_type} ${log.rationale} ${log.prompt_sent} ${(log.starters||[]).join(' ')}`.toLowerCase().includes(query);
            return matchesSearch && statusMatchesFilter(log.status, statusFilter);
        });
        renderActionTable(filtered);
    } else {
        const filtered = allSystemLogs.filter(log => {
            const textContent = `${log.category} ${log.message} ${JSON.stringify(log.details_json)}`.toLowerCase();
            return !query || textContent.includes(query);
        });
        renderSystemTable(filtered);
    }
}

/* ---------------------------------------------------------------------- */
/* Modal + suggestion review                                                */
/* ---------------------------------------------------------------------- */

async function openModal(id) {
    const log = allActionLogs.find(l => l.id === id);
    if (!log) return;

    modalActionId = log.id;
    modalActionType = log.action_type;

    const weekText = log.week === 0 ? "Live Draft" : `Week ${log.week}`;
    document.getElementById("modal-title").innerText = `Action #${log.id} — ${weekText}`;
    document.getElementById("modal-rationale").innerText = log.rationale || "No rationale recorded.";

    const startersList = (log.starters || []).map(s => `<span class="player-tag">${escapeHtml(s)}</span>`).join("");
    const benchList = (log.bench || []).map(b => `<span class="player-tag" style="opacity: 0.6">${escapeHtml(b)}</span>`).join("");

    document.getElementById("modal-starters-pills").innerHTML = `<strong>Starters / pick:</strong> ${startersList}`;
    document.getElementById("modal-bench-pills").innerHTML = log.bench && log.bench.length ? `<strong>Bench:</strong> ${benchList}` : "";

    document.getElementById("modal-prompt-sent").innerText = log.prompt_sent || "Default prompt format used.";

    let formattedJson = log.raw_model_response || "{}";
    try {
        formattedJson = JSON.stringify(JSON.parse(log.raw_model_response), null, 2);
    } catch (e) {}

    document.getElementById("modal-raw-json").innerText = formattedJson;
    document.getElementById("detail-modal").classList.remove("hidden");

    await loadModalSuggestions(log.status);
}

async function loadModalSuggestions(actionStatus) {
    const list = document.getElementById("modal-suggestions-list");
    list.innerHTML = `<p class="hint-text">Loading suggestions…</p>`;

    try {
        const res = await fetch(`/api/suggestions?action_id=${modalActionId}${sessionQuery() ? '&' + sessionQuery().slice(1) : ''}`);
        if (!res.ok) throw new Error("Failed to fetch suggestions");
        modalSuggestions = await res.json();
        renderModalSuggestions(actionStatus);
    } catch (err) {
        list.innerHTML = `<p class="hint-text" style="color: var(--status-fail);">Couldn't load suggestions: ${escapeHtml(err.message)}</p>`;
    }
}

function renderModalSuggestions(actionStatus) {
    const list = document.getElementById("modal-suggestions-list");
    const emptyMsg = document.getElementById("modal-suggestions-empty");
    const applyBtn = document.getElementById("modal-apply-btn");
    const reviewable = actionStatus === "PENDING_REVIEW";

    if (modalSuggestions.length === 0) {
        list.innerHTML = "";
        emptyMsg.classList.remove("hidden");
        applyBtn.classList.add("hidden");
        return;
    }
    emptyMsg.classList.add("hidden");

    list.innerHTML = modalSuggestions.map(s => {
        const isAccepted = s.status === "ACCEPTED";
        const isDeclined = s.status === "DECLINED";
        const controls = reviewable
            ? `
                <div class="suggestion-actions">
                    <button type="button" class="decision-btn accept ${isAccepted ? 'selected' : ''}" onclick="decideSuggestion(${s.id}, 'ACCEPTED')">Accept</button>
                    <button type="button" class="decision-btn decline ${isDeclined ? 'selected' : ''}" onclick="decideSuggestion(${s.id}, 'DECLINED')">Decline</button>
                </div>
              `
            : `<span class="badge ${statusVisuals(s.status).badge}">${statusLabel(s.status)}</span>`;

        return `
            <div class="suggestion-row">
                <div class="suggestion-info">
                    <span class="suggestion-type">${escapeHtml(s.suggestion_type || '')}</span>
                    <span class="suggestion-player">${escapeHtml(s.player || '')}</span>
                </div>
                ${controls}
            </div>
        `;
    }).join("");

    applyBtn.classList.toggle("hidden", !reviewable);
}

async function decideSuggestion(suggestionId, decision) {
    try {
        const res = await fetch(`/api/suggestions/decide${sessionQuery()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ suggestion_id: suggestionId, decision })
        });
        const data = await res.json();
        if (data.status !== "success") throw new Error(data.message || "Couldn't record decision");

        const idx = modalSuggestions.findIndex(s => s.id === suggestionId);
        if (idx !== -1) modalSuggestions[idx] = data.suggestion;
        renderModalSuggestions("PENDING_REVIEW");
    } catch (err) {
        showToast(`Couldn't record decision: ${err.message}`, false);
    }
}

async function applyAcceptedSuggestions() {
    const acceptedCount = modalSuggestions.filter(s => s.status === "ACCEPTED").length;
    const runsOnEspn = modalActionType === "LINEUP_OPTIMIZATION" || modalActionType === "LIVE_DRAFT_PICK";

    if (runsOnEspn && acceptedCount > 0) {
        const ok = confirm(`This opens a browser and clicks on ESPN for ${acceptedCount} accepted suggestion(s). Continue?`);
        if (!ok) return;
    }

    const applyBtn = document.getElementById("modal-apply-btn");
    applyBtn.disabled = true;
    applyBtn.innerText = "Applying…";

    try {
        const res = await fetch(`/api/suggestions/execute${sessionQuery()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action_log_id: modalActionId, action_type: modalActionType })
        });
        const data = await res.json();
        if (data.status !== "success") throw new Error(data.message || "Couldn't apply suggestions");

        showToast(`Applied ${data.executed || 0} accepted suggestion(s).`, false);
        closeModal();
        await loadHistory();
    } catch (err) {
        showToast(`Couldn't apply suggestions: ${err.message}`, false);
    } finally {
        applyBtn.disabled = false;
        applyBtn.innerText = "Apply Accepted";
    }
}

function closeModal(event) {
    document.getElementById("detail-modal").classList.add("hidden");
    modalActionId = null;
    modalActionType = null;
    modalSuggestions = [];
}

/* ---------------------------------------------------------------------- */
/* Workflow triggers                                                        */
/* ---------------------------------------------------------------------- */

async function triggerLineupOptimizer() {
    showToast(autoMode ? "Setting lineup automatically via local DeepSeek R1…" : "Getting lineup suggestions from local DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-lineup-optimizer${runQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`${data.message} (#${data.record_id || 'new'})`, false);
        } else {
            showToast(`Error: ${data.message}`, false);
        }
        await loadHistory();
    } catch (e) {
        showToast(`Execution error: ${e.message}`, false);
    } finally {
        setButtonsDisabled(false);
    }
}

async function triggerDraftAssistant() {
    showToast(autoMode ? "Scanning the draft room and drafting automatically…" : "Scanning the live draft room via DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-draft-assistant${runQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`${data.message} (#${data.record_id || 'new'})`, false);
        } else {
            showToast(`Error: ${data.message}`, false);
        }
        await loadHistory();
        await loadLeagueSettings();
    } catch (e) {
        showToast(`Execution error: ${e.message}`, false);
    } finally {
        setButtonsDisabled(false);
    }
}

async function triggerTradeAnalyzer() {
    showToast("Evaluating pending trade offers via DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-trade-analyzer${runQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`${data.message} (#${data.record_id || 'new'})`, false);
        } else {
            showToast(`Error: ${data.message}`, false);
        }
        await loadHistory();
    } catch (e) {
        showToast(`Execution error: ${e.message}`, false);
    } finally {
        setButtonsDisabled(false);
    }
}

/* ---------------------------------------------------------------------- */
/* Chat ("Ask DeepSeek")                                                    */
/* ---------------------------------------------------------------------- */

async function loadChatMessages() {
    const container = document.getElementById("chat-messages");
    try {
        const res = await fetch(`/api/chat${sessionQuery()}`);
        if (!res.ok) throw new Error("Failed to load chat history");
        const messages = await res.json();
        renderChatMessages(messages);
    } catch (err) {
        container.innerHTML = `<p class="empty-state" style="color: var(--status-fail);">Couldn't load chat history: ${escapeHtml(err.message)}</p>`;
    }
}

function renderChatMessages(messages) {
    const container = document.getElementById("chat-messages");
    if (!messages.length) {
        container.innerHTML = `<p class="empty-state">Ask about a player, matchup, or your league settings — DeepSeek can look up real stats to answer.</p>`;
        return;
    }
    container.innerHTML = messages.map(chatBubbleHtml).join("");
    container.scrollTop = container.scrollHeight;
}

function chatBubbleHtml(message) {
    const trace = message.tool_trace_json || [];
    const traceHtml = trace.length
        ? `<div class="chat-tool-trace">Looked up: ${trace.map(t => escapeHtml(t.call?.player_name || t.call?.tool || 'data')).join(", ")}</div>`
        : "";
    return `
        <div class="chat-bubble-row ${message.role}">
            <div class="chat-bubble">${escapeHtml(message.content)}${traceHtml}</div>
        </div>
    `;
}

async function handleChatSubmit(event) {
    event.preventDefault();
    const input = document.getElementById("chat-input");
    const question = input.value.trim();
    if (!question) return;

    const container = document.getElementById("chat-messages");
    const emptyState = container.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    container.insertAdjacentHTML("beforeend", chatBubbleHtml({ role: "user", content: question, tool_trace_json: [] }));

    const thinkingId = "chat-thinking";
    container.insertAdjacentHTML("beforeend", `
        <div class="chat-bubble-row assistant thinking" id="${thinkingId}">
            <div class="chat-bubble">Thinking…</div>
        </div>
    `);
    container.scrollTop = container.scrollHeight;

    input.value = "";
    input.disabled = true;

    try {
        const res = await fetch(`/api/chat${sessionQuery()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question })
        });
        const data = await res.json();
        document.getElementById(thinkingId)?.remove();

        if (data.status === "success") {
            container.insertAdjacentHTML("beforeend", chatBubbleHtml({ role: "assistant", content: data.answer, tool_trace_json: data.tool_trace || [] }));
        } else {
            container.insertAdjacentHTML("beforeend", chatBubbleHtml({ role: "assistant", content: `Error: ${data.message}`, tool_trace_json: [] }));
        }
    } catch (err) {
        document.getElementById(thinkingId)?.remove();
        container.insertAdjacentHTML("beforeend", chatBubbleHtml({ role: "assistant", content: `Execution error: ${err.message}`, tool_trace_json: [] }));
    } finally {
        input.disabled = false;
        input.focus();
        container.scrollTop = container.scrollHeight;
    }
}

function showToast(msg, isSpinning = true) {
    const banner = document.getElementById("toast-banner");
    const text = document.getElementById("toast-message");
    const spinner = banner.querySelector(".spinner");

    text.innerText = msg;
    banner.classList.remove("hidden");
    spinner.style.display = isSpinning ? "block" : "none";

    if (!isSpinning) {
        setTimeout(() => {
            banner.classList.add("hidden");
        }, 4000);
    }
}

function setButtonsDisabled(disabled) {
    const btns = document.querySelectorAll("#btn-optimizer, #btn-draft, #btn-trade");
    btns.forEach(b => b.disabled = disabled);
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
