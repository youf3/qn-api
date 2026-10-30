/**
 * ProbeTable — Renders the real-time Link & Quantum Probe Status table,
 * the Recent Periodic Probes live event stream, and summary badges.
 *
 * Hydrates from server-provided `link_states` (and periodic `/api/link_states` polling)
 * and updates live via `mqtt:link:stateUpdate` events over MQTT WebSocket.
 */
export class ProbeTable {
    /**
     * @param {string} tbodyId - ID of the per-link <tbody> element
     * @param {Object} [options]
     * @param {string} [options.summaryId='probe-summary-badges'] - ID of the summary badge container
     * @param {string} [options.historyTbodyId='probe-history-table-body'] - ID of the periodic probe stream <tbody>
     * @param {string} [options.streamCounterId='probe-stream-counter'] - ID of the stream event counter badge
     * @param {Function} [options.getTopoNodes] - Function returning vis.DataSet of topology nodes
     * @param {Function} [options.getTopoEdges] - Function returning vis.DataSet of topology edges
     * @param {Function} [options.onLinkUpdated] - Optional callback invoked when a poll detects a link/probe change
     */
    constructor(tbodyId, options = {}) {
        this._tbodyId = tbodyId;
        this._summaryId = options.summaryId || 'probe-summary-badges';
        this._historyTbodyId = options.historyTbodyId || 'probe-history-table-body';
        this._streamCounterId = options.streamCounterId || 'probe-stream-counter';
        this._getTopoNodes = options.getTopoNodes || (() => null);
        this._getTopoEdges = options.getTopoEdges || (() => null);
        this._onLinkUpdated = options.onLinkUpdated || null;
        /** @type {Map<string, Object>} keyed by `${src_cid}|${dst_cid}|${channel_id}` */
        this._links = new Map();
        /** @type {Map<string, Object>} keyed by unique probe event key */
        this._probeEvents = new Map();
        /** @type {Set<string>} bounded set of seen probe keys so evicted history is never re-ingested */
        this._seenProbeKeys = new Set();
        this._maxSeenKeys = 2000;
        this._maxEvents = 40;
        this._renderPending = false;
        this._pendingHighlightKey = null;
    }

    /**
     * Load or sync link states array from server/API and render.
     * @param {Object[]} linkStates
     * @param {Object} [opts]
     * @param {boolean} [opts.isPoll=false] - True when called from background periodic polling
     */
    loadFromServer(linkStates = [], opts = {}) {
        if (!Array.isArray(linkStates)) return;
        const isPoll = Boolean(opts.isPoll);
        const nowSec = Date.now() / 1000;
        let anyChanged = false;
        let firstLoad = this._links.size === 0;

        linkStates.forEach(ls => {
            const key = this._makeKey(ls);
            if (!key) return;
            const prev = this._links.get(key);
            const stateChanged = !prev || prev.state !== ls.state;
            const changed = stateChanged ||
                prev.probe_tx_count !== ls.probe_tx_count ||
                prev.probe_rx_count !== ls.probe_rx_count ||
                prev.last_probe_id !== ls.last_probe_id ||
                prev.last_probe_sent !== ls.last_probe_sent;

            const probeTs = this._parseTimestampSec(
                ls.last_probe_sent || ls.last_probe_received || ls.timestamp
            );
            const computedAge = probeTs !== null ? Math.max(0, Math.round(nowSec - probeTs)) : null;

            let ageSec = computedAge;
            if (isPoll && prev && !changed && prev._ageSec !== null && prev._ageSec !== undefined) {
                ageSec = prev._ageSec;
            } else if (isPoll && changed && prev) {
                ageSec = computedAge !== null ? Math.min(computedAge, 2) : 0;
            }

            const justUpdated = Boolean(isPoll && prev && changed);
            this._links.set(key, {
                ...(prev || {}),
                ...ls,
                last_probe_info: {
                    ...((prev && prev.last_probe_info) || {}),
                    ...(ls.last_probe_info || {})
                },
                _ageSec: ageSec,
                _justUpdated: justUpdated
            });

            const newEventsAdded = this._ingestProbeEvents(ls, !firstLoad && isPoll);
            if (changed || newEventsAdded) {
                anyChanged = true;
                if (stateChanged && this._onLinkUpdated) {
                    this._onLinkUpdated(ls);
                }
            }
        });

        if (firstLoad || !isPoll || anyChanged) {
            this.render();
        }
    }

    /**
     * Handle a live `mqtt:link:stateUpdate` event payload.
     * @param {Object} payload - { src_cid, dst_cid, channel_id, state, value, raw }
     */
    handleUpdate(payload) {
        const val = payload.value || payload || {};
        const key = this._makeKey(val);
        if (!key) return;

        const existing = this._links.get(key) || {};
        const merged = {
            ...existing,
            ...val,
            last_probe_info: {
                ...(existing.last_probe_info || {}),
                ...(val.last_probe_info || {})
            },
            _ageSec: 0,
            _justUpdated: true
        };
        this._links.set(key, merged);
        this._ingestProbeEvents(merged, true);
        this._scheduleRender(key);
    }

    /**
     * Coalesce rapid MQTT updates into at most one DOM render per animation frame.
     * Falls back to synchronous render when requestAnimationFrame is unavailable (e.g. unit tests).
     * @param {string} [highlightKey]
     */
    _scheduleRender(highlightKey = null) {
        if (highlightKey) {
            this._pendingHighlightKey = highlightKey;
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            if (!this._renderPending) {
                this._renderPending = true;
                window.requestAnimationFrame(() => {
                    this._renderPending = false;
                    const key = this._pendingHighlightKey;
                    this._pendingHighlightKey = null;
                    this.render(key);
                });
            }
        } else {
            const key = this._pendingHighlightKey;
            this._pendingHighlightKey = null;
            this.render(key);
        }
    }

    /**
     * Increment the elapsed seconds since last probe/update for each link.
     */
    incrementAge() {
        const tbody = document.getElementById(this._tbodyId);
        if (!tbody) return;
        this._links.forEach((entry, key) => {
            if (entry._ageSec !== null && entry._ageSec !== undefined) {
                entry._ageSec += 1;
                const cell = tbody.querySelector(`[data-age-key="${CSS.escape(key)}"]`);
                if (cell) {
                    cell.textContent = `${entry._ageSec}s ago`;
                }
            }
        });
    }

    /**
     * Render the per-link status rows, periodic probe stream rows, and summary badges.
     * @param {string} [highlightKey] - Optional key to flash/highlight on update
     */
    render(highlightKey = null) {
        const tbody = document.getElementById(this._tbodyId);
        if (!tbody) return;

        const entries = Array.from(this._links.entries());
        // Sort: quantum links first, then by src_cid -> dst_cid -> channel_id
        entries.sort(([, a], [, b]) => {
            const aQ = this._isQuantum(a) ? 0 : 1;
            const bQ = this._isQuantum(b) ? 0 : 1;
            if (aQ !== bQ) return aQ - bQ;
            const srcCmp = (a.src_cid || '').localeCompare(b.src_cid || '');
            if (srcCmp !== 0) return srcCmp;
            const dstCmp = (a.dst_cid || '').localeCompare(b.dst_cid || '');
            if (dstCmp !== 0) return dstCmp;
            return (a.channel_id || '').localeCompare(b.channel_id || '');
        });

        this._renderSummary(entries.map(([, v]) => v));

        tbody.innerHTML = '';
        if (entries.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="9" class="text-center text-muted py-3">Waiting for link &amp; probe telemetry...</td>`;
            tbody.appendChild(tr);
        } else {
            entries.forEach(([key, ls]) => {
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                if (key === highlightKey || ls._justUpdated) {
                    tr.classList.add('table-info');
                    ls._justUpdated = false;
                    setTimeout(() => tr.classList.remove('table-info'), 900);
                }

                const isQuantum = this._isQuantum(ls);
                const state = ls.state || 'DOWN';
                const stateBadge = this._formatStateBadge(state);
                const chanTypeBadge = isQuantum
                    ? `<span class="badge bg-primary me-1">Quantum</span>`
                    : `<span class="badge bg-secondary me-1">Classical</span>`;

                const probeInfo = ls.last_probe_info || {};
                const probeStatus = ls.last_probe_status || probeInfo.status || (state === 'QUANTUM_UP' ? 'OK' : '—');
                const probeBadge = this._formatProbeBadge(probeStatus, isQuantum, state);

                const txCount = ls.probe_tx_count ?? 0;
                const rxCount = ls.probe_rx_count ?? probeInfo.rx_count ?? 0;
                const okCount = ls.probe_ok_count ?? 0;
                const failCount = ls.probe_fail_count ?? 0;

                const countsStr = probeInfo.counts !== undefined && probeInfo.counts !== null
                    ? ` (${probeInfo.counts} ph)`
                    : '';
                const latencyStr = isQuantum
                    ? (probeInfo.tof !== undefined && probeInfo.tof !== null
                        ? `${(Number(probeInfo.tof) * 1000).toFixed(2)} ms${countsStr}`
                        : '—')
                    : (probeInfo.rtt_ms !== undefined && probeInfo.rtt_ms !== null
                        ? `${Number(probeInfo.rtt_ms).toFixed(2)} ms`
                        : '—');

                const vlink = probeInfo.vlink || probeInfo.target || ls.neighbor_channel_id || '—';
                const ageStr = (ls._ageSec !== null && ls._ageSec !== undefined && !Number.isNaN(ls._ageSec))
                    ? `${ls._ageSec}s ago`
                    : '—';

                tr.innerHTML = `
                    <td class="fw-semibold">${ls.src_cid || '?'} &rarr; ${ls.dst_cid || '?'}</td>
                    <td>${chanTypeBadge}<code class="small">${ls.channel_id || ''}</code></td>
                    <td>${stateBadge}</td>
                    <td>${probeBadge}</td>
                    <td><span class="text-primary fw-semibold">${txCount}</span> / <span class="text-info fw-semibold">${rxCount}</span></td>
                    <td><span class="text-success fw-semibold">${okCount}</span> / <span class="text-danger fw-semibold">${failCount}</span></td>
                    <td><small>${latencyStr}</small></td>
                    <td><code class="small">${vlink}</code></td>
                    <td data-age-key="${key}" class="text-muted small">${ageStr}</td>
                `;

                tr.addEventListener('mouseenter', () => this._highlightTopology(ls.src_cid, ls.dst_cid, true));
                tr.addEventListener('mouseleave', () => this._highlightTopology(ls.src_cid, ls.dst_cid, false));
                tbody.appendChild(tr);
            });
        }

        this._renderHistoryStream();
    }

    // ── Private helpers ──────────────────────────────────────────────────

    /**
     * Extract periodic probe events from a link_state record (`probe_history` and `last_probe_info`).
     * @returns {boolean} True if at least one new probe event was added
     */
    _ingestProbeEvents(ls, flashNew = false) {
        if (!ls) return false;
        const isQuantum = this._isQuantum(ls);
        let added = false;

        const addOne = (ev, seqFallback) => {
            if (!ev || typeof ev !== 'object') return;
            const probeId = ev.probe_id || ls.last_probe_id || '';
            const seq = ev.seq ?? ev.rx_count ?? seqFallback ?? ls.probe_tx_count ?? 0;
            const tsIso = ev.ts || ls.last_probe_sent || ls.timestamp || '';
            if (!probeId && !seq && !tsIso) return;
            const evKey = probeId
                ? `${ls.src_cid}|${ls.channel_id}|${probeId}`
                : `${ls.src_cid}|${ls.channel_id}|${seq}|${tsIso}`;
            if (this._seenProbeKeys.has(evKey) || this._probeEvents.has(evKey)) return;
            this._seenProbeKeys.add(evKey);
            if (this._seenProbeKeys.size > this._maxSeenKeys) {
                const oldestKey = this._seenProbeKeys.keys().next().value;
                this._seenProbeKeys.delete(oldestKey);
            }

            const tsSec = this._parseTimestampSec(tsIso) || (Date.now() / 1000);
            this._probeEvents.set(evKey, {
                _key: evKey,
                _tsSec: tsSec,
                _flash: flashNew,
                ts: tsIso,
                seq,
                probe_id: probeId,
                is_quantum: isQuantum,
                kind: ev.kind || (isQuantum ? 'probe' : 'hello'),
                src_cid: ev.src_cid || ls.src_cid,
                dst_cid: ev.dst_cid || ls.dst_cid,
                channel_id: ev.channel_id || ls.channel_id,
                vlink: ev.vlink || (ls.last_probe_info && ls.last_probe_info.vlink) || '—',
                peer_ip: ev.peer_ip || (ls.last_probe_info && ls.last_probe_info.peer_ip) || '',
                port: ev.port || (ls.last_probe_info && ls.last_probe_info.port) || '',
                wavelength: ev.wavelength ?? (ls.last_probe_info && ls.last_probe_info.wavelength),
                power: ev.power ?? (ls.last_probe_info && ls.last_probe_info.power),
                rtt_ms: ev.rtt_ms,
                tof: ev.tof,
                counts: ev.counts,
                status: ev.status || ls.last_probe_status || 'ok',
                state: ev.state || ls.state || (isQuantum ? 'QUANTUM_UP' : 'CONTROL_UP')
            });
            added = true;
        };

        if (Array.isArray(ls.probe_history) && ls.probe_history.length > 0) {
            ls.probe_history.forEach((h, idx) => addOne(h, idx + 1));
        } else if (ls.last_probe_info && Object.keys(ls.last_probe_info).length > 0) {
            addOne(ls.last_probe_info, ls.probe_tx_count);
        }

        // Trim oldest if exceeding maxEvents
        if (this._probeEvents.size > this._maxEvents) {
            const sorted = Array.from(this._probeEvents.values())
                .sort((a, b) => b._tsSec - a._tsSec)
                .slice(0, this._maxEvents);
            this._probeEvents.clear();
            sorted.reverse().forEach(item => this._probeEvents.set(item._key, item));
        }
        return added;
    }

    _renderHistoryStream() {
        const tbody = document.getElementById(this._historyTbodyId);
        if (!tbody) return;

        const events = Array.from(this._probeEvents.values())
            .sort((a, b) => {
                if (b._tsSec !== a._tsSec) return b._tsSec - a._tsSec;
                return (b.seq || 0) - (a.seq || 0);
            });

        const counterEl = document.getElementById(this._streamCounterId);
        if (counterEl) {
            counterEl.textContent = `${events.length} recent periodic probe${events.length === 1 ? '' : 's'}`;
        }

        tbody.innerHTML = '';
        if (events.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="8" class="text-center text-muted py-2">Waiting for periodic quantum probes...</td>`;
            tbody.appendChild(tr);
            return;
        }

        events.forEach(ev => {
            const tr = document.createElement('tr');
            if (ev._flash) {
                tr.classList.add('table-success');
                ev._flash = false;
                setTimeout(() => tr.classList.remove('table-success'), 1000);
            }

            const timeStr = this._formatUtcTime(ev.ts, ev._tsSec);
            const shortId = ev.probe_id ? String(ev.probe_id).slice(0, 8) : '—';
            const targetStr = ev.peer_ip
                ? (String(ev.peer_ip).includes(':') ? `[${ev.peer_ip}]:${ev.port}` : `${ev.peer_ip}:${ev.port}`)
                : '';
            const vlinkHtml = targetStr
                ? `<code>${ev.vlink}</code> <span class="text-muted">(${targetStr})</span>`
                : `<code>${ev.vlink}</code>`;
            const optStr = (ev.wavelength !== undefined && ev.wavelength !== null)
                ? `${ev.wavelength} nm / ${ev.power ?? '—'} dBm`
                : (ev.kind === 'hello' ? 'Control (MQTT)' : '—');
            const phStr = (ev.counts !== undefined && ev.counts !== null)
                ? ` (${ev.counts} ph)`
                : '';
            const latencyStr = ev.is_quantum
                ? (ev.tof !== undefined && ev.tof !== null
                    ? `${(Number(ev.tof) * 1000).toFixed(2)} ms${phStr}`
                    : '—')
                : (ev.rtt_ms !== undefined && ev.rtt_ms !== null
                    ? `${Number(ev.rtt_ms).toFixed(2)} ms`
                    : '—');
            const statusBadge = this._formatProbeBadge(ev.status, ev.is_quantum !== false, ev.state);

            tr.innerHTML = `
                <td class="text-nowrap font-monospace">${timeStr}</td>
                <td><span class="badge bg-light text-dark border">#${ev.seq || '—'}</span></td>
                <td><code title="${ev.probe_id || ''}">${shortId}</code></td>
                <td class="fw-semibold">${ev.src_cid || '?'} &rarr; ${ev.dst_cid || '?'} <code class="small">:${ev.channel_id || ''}</code></td>
                <td>${vlinkHtml}</td>
                <td class="text-muted">${optStr}</td>
                <td>${latencyStr}</td>
                <td>${statusBadge}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    _formatUtcTime(tsIso, tsSec) {
        if (tsIso && typeof tsIso === 'string' && tsIso.includes('T')) {
            const timePart = tsIso.split('T')[1] || '';
            return timePart.replace('Z', '').slice(0, 12);
        }
        if (tsSec) {
            return new Date(tsSec * 1000).toISOString().split('T')[1].replace('Z', '');
        }
        return '—';
    }

    _makeKey(ls) {
        if (!ls || !ls.src_cid || !ls.channel_id) return null;
        return `${ls.src_cid}|${ls.dst_cid || ''}|${ls.channel_id}`;
    }

    _parseTimestampSec(ts) {
        if (ts === null || ts === undefined || ts === '') return null;
        if (typeof ts === 'number' && !Number.isNaN(ts)) return ts;
        const num = Number(ts);
        if (!Number.isNaN(num) && num > 1e9) return num;
        const str = String(ts).trim();
        const iso = (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str)) ? str : `${str}Z`;
        const ms = Date.parse(iso);
        return Number.isNaN(ms) ? null : ms / 1000;
    }

    _isQuantum(ls) {
        if (ls.is_quantum !== undefined && ls.is_quantum !== null) {
            return Boolean(ls.is_quantum);
        }
        const ch = (ls.channel_id || '').toLowerCase();
        return ch.includes('quantum') || ls.state === 'QUANTUM_UP';
    }

    _formatStateBadge(state) {
        const map = {
            'QUANTUM_UP': 'bg-success',
            'CONTROL_UP': 'bg-primary',
            'INIT': 'bg-warning text-dark',
            'DOWN': 'bg-secondary'
        };
        const cls = map[state] || 'bg-secondary';
        return `<span class="badge ${cls}">${state}</span>`;
    }

    _formatProbeBadge(status, isQuantum, state) {
        const s = (status || '').toUpperCase();
        if (!isQuantum) {
            if (s === 'OK' || s === 'RECEIVED') {
                return `<span class="badge bg-info text-dark">● HELLO OK</span>`;
            }
            if (s === 'FAILED' || s === 'TIMEOUT' || s === 'ERROR' || s === 'RPC_ERROR') {
                return `<span class="badge bg-danger">▲ ${s}</span>`;
            }
            if (state === 'CONTROL_UP') {
                return `<span class="badge bg-info text-dark">● HELLO UP</span>`;
            }
            return `<span class="text-muted small">Pending (Control)</span>`;
        }
        if (s === 'OK' || s === 'RECEIVED') {
            return `<span class="badge bg-success">● ${s}</span>`;
        }
        if (s === 'FAILED' || s === 'TIMEOUT' || s === 'ERROR' || s === 'RPC_ERROR') {
            return `<span class="badge bg-danger">▲ ${s}</span>`;
        }
        if (state === 'QUANTUM_UP') {
            return `<span class="badge bg-success">● ACTIVE</span>`;
        }
        return `<span class="badge bg-light text-dark border">${status || 'PENDING'}</span>`;
    }

    _renderSummary(list) {
        const container = document.getElementById(this._summaryId);
        if (!container) return;

        let qUp = 0;
        let cUp = 0;
        let down = 0;
        let totalProbes = 0;

        list.forEach(ls => {
            if (ls.state === 'QUANTUM_UP') qUp++;
            else if (ls.state === 'CONTROL_UP') cUp++;
            else down++;
            totalProbes += (ls.probe_tx_count || 0);
        });

        container.innerHTML = `
            <span class="badge bg-success">QUANTUM_UP: ${qUp}</span>
            <span class="badge bg-primary">CONTROL_UP: ${cUp}</span>
            <span class="badge bg-secondary">INIT/DOWN: ${down}</span>
            <span class="badge bg-info text-dark">Probes Sent: ${totalProbes}</span>
        `;
    }

    _highlightTopology(srcId, dstId, highlight) {
        const nodes = this._getTopoNodes();
        if (!nodes) return;
        [srcId, dstId].forEach(id => {
            if (!id) return;
            const n = nodes.get(id);
            if (n) {
                nodes.update({
                    id,
                    size: highlight ? 35 : 25,
                    ...(n.color ? { color: n.color } : {})
                });
            }
        });
    }
}
