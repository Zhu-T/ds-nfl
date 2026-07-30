let allActionLogs = [];
let allSystemLogs = [];
let activeTab = 'actions'; // 'actions' or 'syslogs'

let sessions = [];
let defaultSessionId = null;
let activeSessionId = null;

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    document.addEventListener("click", (e) => {
        const menu = document.getElementById("session-menu");
        const trigger = document.getElementById("session-trigger");
        if (!menu.contains(e.target) && !trigger.contains(e.target)) {
            closeSessionMenu();
        }
    });
    document.getElementById("session-create-form").addEventListener("submit", handleCreateSession);
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
    } catch (err) {
        document.getElementById("session-trigger-name").innerText = "Sessions unavailable";
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
            <button type="button" class="session-menu-item ${isActive ? 'active' : ''}" onclick="selectSession('${s.id}')">
                <span class="session-dot"></span>
                <span class="session-item-name">${escapeHtml(s.name)}</span>
                ${isDefault
                    ? `<span class="default-star">Default</span>`
                    : `<button type="button" class="set-default-btn" onclick="event.stopPropagation(); setDefaultSession('${s.id}')">Set default</button>`
                }
            </button>
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
    } catch (err) {
        showToast(`Couldn't create session: ${err.message}`, false);
    }
}

function sessionQuery() {
    return activeSessionId ? `?session=${encodeURIComponent(activeSessionId)}` : "";
}

/* ---------------------------------------------------------------------- */
/* Tabs                                                                     */
/* ---------------------------------------------------------------------- */

function switchTab(tab) {
    activeTab = tab;
    document.getElementById("nav-actions").classList.toggle("active", tab === 'actions');
    document.getElementById("nav-syslogs").classList.toggle("active", tab === 'syslogs');

    if (tab === 'actions') {
        document.getElementById("page-heading").innerText = "Action History";
        document.getElementById("page-subheading").innerText = "Recommendations, prompts sent, and automated ESPN execution logs.";
        renderActionTable(allActionLogs);
    } else {
        document.getElementById("page-heading").innerText = "API Cache & System Log";
        document.getElementById("page-subheading").innerText = "IP rate-limit protection, cache hits, and step-by-step automation events.";
        loadSystemLogs();
    }
}

function refreshActiveTab() {
    if (activeTab === 'actions') {
        loadHistory();
    } else {
        loadSystemLogs();
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
        if (activeTab === 'actions') renderActionTable(allActionLogs);
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
        if (activeTab === 'syslogs') renderSystemTable(allSystemLogs);
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
        const rowClass = log.status === "SUCCESS" ? "row-success" : (log.status === "SIMULATED_FALLBACK" ? "row-warn" : "row-fail");
        const badgeClass = log.status === "SUCCESS" ? "badge-success" : (log.status === "SIMULATED_FALLBACK" ? "badge-simulated" : "badge-failed");
        const weekText = log.week === 0 ? "Draft" : `Week ${log.week || 1}`;

        return `
            <tr class="${rowClass}">
                <td class="id-cell">#${log.id}<small>${dateStr}</small></td>
                <td><span class="badge badge-week">${weekText}</span></td>
                <td><strong>${escapeHtml(log.action_type || "LINEUP_OPTIMIZATION")}</strong></td>
                <td>${startersHtml || '<em style="color: var(--text-dim)">None</em>'}</td>
                <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(log.rationale || '')}</td>
                <td><span class="badge ${badgeClass}">${log.status}</span></td>
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

function filterCurrentView() {
    const query = document.getElementById("search-input").value.toLowerCase();

    if (activeTab === 'actions') {
        const filtered = allActionLogs.filter(log => {
            const textContent = `${log.action_type} ${log.rationale} ${log.prompt_sent} ${(log.starters||[]).join(' ')}`.toLowerCase();
            return textContent.includes(query);
        });
        renderActionTable(filtered);
    } else {
        const filtered = allSystemLogs.filter(log => {
            const textContent = `${log.category} ${log.message} ${JSON.stringify(log.details_json)}`.toLowerCase();
            return textContent.includes(query);
        });
        renderSystemTable(filtered);
    }
}

/* ---------------------------------------------------------------------- */
/* Modal                                                                    */
/* ---------------------------------------------------------------------- */

function openModal(id) {
    const log = allActionLogs.find(l => l.id === id);
    if (!log) return;

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
}

function closeModal(event) {
    document.getElementById("detail-modal").classList.add("hidden");
}

/* ---------------------------------------------------------------------- */
/* Workflow triggers                                                        */
/* ---------------------------------------------------------------------- */

async function triggerLineupOptimizer() {
    showToast("Setting lineup via local DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-lineup-optimizer${sessionQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`Lineup set. Logged as #${data.record_id || 'new'}.`, false);
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
    showToast("Scanning the live draft room via DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-draft-assistant${sessionQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`Draft pick logged as #${data.record_id || 'new'}.`, false);
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

async function triggerTradeAnalyzer() {
    showToast("Evaluating pending trade offers via DeepSeek R1…");
    setButtonsDisabled(true);

    try {
        const res = await fetch(`/api/run-trade-analyzer${sessionQuery()}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "success") {
            showToast(`Trade review logged as #${data.record_id || 'new'}.`, false);
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
