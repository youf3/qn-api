/**
 * Formatting and UI utilities — extracted from qn.js.
 *
 * Includes pure formatting functions for rendering data as HTML strings,
 * plus lightweight UI helpers (toast notifications, API error checking).
 */

// ── UI Helpers ───────────────────────────────────────────────────────────

/**
 * Show a Bootstrap toast notification.
 * @param {string} message - Text/HTML to display
 * @param {'danger'|'warning'|'success'|'info'} type - Bootstrap color class
 */
export function showToast(message, type = 'danger') {
    const toastEl = document.getElementById('apiToast');
    const bodyEl  = document.getElementById('apiToastBody');
    if (!toastEl || !bodyEl) {
        alert(message);
        return;
    }
    toastEl.className = toastEl.className.replace(/\btext-bg-\w+/g, '');
    toastEl.classList.add(`text-bg-${type}`);
    bodyEl.innerHTML = message;
    const toast = bootstrap.Toast.getOrCreateInstance(toastEl);
    toast.show();
}

/**
 * Check an API JSON response for application-level failure.
 * Returns a descriptive HTML string on error, or null if OK.
 * @param {Object} data - Parsed JSON response body
 * @returns {string|null}
 */
export function getApiError(data) {
    if (!data || !data.status) return null;
    if (data.status.code === 0) return null;
    const value  = data.status.value || 'ERROR';
    const detail = data.status.reason || data.status.message || data.reason || '';
    return detail ? `${value}: ${detail}` : value;
}

// ── Formatting Functions ─────────────────────────────────────────────────

/**
 * Render a nested object as a Bootstrap list-group.
 * Recursively handles nested objects and arrays.
 *
 * @param {Object} data - Key-value data to render
 * @returns {string} HTML string
 */
export function formatList(data) {
    let html = '<ul class="list-group">';
    for (let key in data) {
        if (typeof data[key] === 'object' && data[key] !== null && !Array.isArray(data[key])) {
            html += `<li class="list-group-item"><strong>${key}:</strong> ${formatList(data[key])}</li>`;
        } else if (Array.isArray(data[key])) {
            html += `<li class="list-group-item"><strong>${key}:</strong> ${data[key].join(', ')}</li>`;
        } else {
            html += `<li class="list-group-item"><strong>${key}:</strong> ${data[key]}</li>`;
        }
    }
    html += '</ul>';
    return html;
}

/**
 * Render data as a Bootstrap striped table.
 *
 * @param {string[]} headers - Column header labels
 * @param {Array[]} rows - Array of row arrays (each cell is a string/HTML)
 * @returns {string} HTML string
 */
export function formatTable(headers, rows) {
    let html = '<table class="table table-striped table-bordered">';
    html += '<thead><tr>';
    headers.forEach(header => html += `<th>${header}</th>`);
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
        html += '<tr>';
        row.forEach(cell => html += `<td>${cell}</td>`);
        html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

/**
 * Render qubit operations (one-qubit and two-qubit gates) as tables.
 *
 * @param {Object} operations - { oneQubitGates, twoQubitGates }
 * @returns {string} HTML string
 */
export function formatNestedOperations(operations) {
    let html = '';

    if (operations.oneQubitGates) {
        html += '<h5>One Qubit Gates</h5>';
        html += formatTable(
            ["Gate", "Qubits"],
            operations.oneQubitGates.map(gate => [
                gate.gate,
                gate.qubits.join(", ")
            ])
        );
    }

    if (operations.twoQubitGates) {
        html += '<h5>Two Qubit Gates</h5>';
        html += formatTable(
            ["Gate", "Qubit Pairs"],
            operations.twoQubitGates.map(gate => [
                gate.gate,
                gate.qubits.map(pair => pair.join("-")).join(", ")
            ])
        );
    }

    return html;
}

/**
 * Format a ping response into a human-readable text block.
 *
 * @param {Object} msg - Ping result message
 * @returns {string} Formatted text
 */
export function formatPingResult(msg) {
    try {
        const res = msg;
        let resultText = `--- ${res.agent} ping statistics ---\n`;
        resultText += `${res.iterations} requests made, ${res.successes} received, time ${((res.end_ts - res.start_ts) * 1e3).toFixed(0)}ms\n`;

        if (res.successes) {
            const rtt_min = parseFloat(res.rtt_min);
            const rtt_avg = parseFloat(res.rtt_avg);
            const rtt_max = parseFloat(res.rtt_max);
            const rtt_mdev = parseFloat(res.rtt_mdev);

            resultText += `rtt min/avg/max/mdev ${rtt_min.toFixed(3)}/${rtt_avg.toFixed(3)}/${rtt_max.toFixed(3)}/${rtt_mdev.toFixed(3)} ms\n`;

            try {
                const resultObj = JSON.parse(res.result.replace(/'/g, '"'));
                if (resultObj.message) {
                    resultText += `message: ${resultObj.message}`;
                }
            } catch (err) {
                console.error("Failed to parse result message:", err);
            }
        }

        return resultText;
    } catch (error) {
        console.error("Error formatting ping result:", error);
        return "Error formatting ping result.";
    }
}

/**
 * Map a calibration phase string to a Bootstrap text color class.
 *
 * @param {string} phase - Phase name (e.g. "Done", "Calibrating")
 * @returns {string} CSS class name
 */
export function phaseToColorClass(phase) {
    const map = {
        "Initializing": "text-primary",
        "Calibrating": "text-warning",
        "Cleanup": "text-info",
        "Done": "text-success",
        "Failed": "text-danger"
    };
    return map[phase] || "";
}

/**
 * Map a calibration task state to a Bootstrap badge color class.
 *
 * @param {string} state - State string (e.g. "IN_SPEC", "OUT_OF_SPEC")
 * @returns {string} CSS class name
 */
export function stateToColorClass(state) {
    switch (state) {
        case 'IN_SPEC': return 'bg-success';
        case 'OUT_OF_SPEC': return 'bg-warning';
        case 'FAILED': return 'bg-danger';
        default: return 'bg-secondary';
    }
}

/**
 * Determine the status icon color for an agent state.
 *
 * @param {Object} state - State object with .value property
 * @returns {string} CSS color string
 */
export function stateToIconColor(state) {
    if (state) {
        return state.value === "IN_SPEC" ? "#32CD32" :
            (state.value === "OUT_OF_SPEC" ? "#FF0000" : "grey");
    }
    return "grey";
}
