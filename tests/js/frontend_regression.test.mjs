import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../static/js/core/EventBus.js';
import { MqttClient } from '../../static/js/core/MqttClient.js';
import { TopologyGraph } from '../../static/js/components/TopologyGraph.js';
import { AgentTable } from '../../static/js/components/AgentTable.js';
import { ProbeTable } from '../../static/js/components/ProbeTable.js';
import { DebugPanel } from '../../static/js/components/DebugPanel.js';
import { CalibrationChart } from '../../static/js/components/charts/CalibrationChart.js';
import { stateToIconColor } from '../../static/js/utils/formatters.js';

/**
 * Minimal in-memory vis.DataSet mock matching the subset used by TopologyGraph, AgentTable, and ProbeTable.
 */
class MockDataSet {
    constructor(items = []) {
        this._items = new Map();
        this.updateCallCount = 0;
        items.forEach((item, idx) => {
            const id = item.id !== undefined ? item.id : `edge-${idx}`;
            this._items.set(id, { ...item, id });
        });
    }

    get(id) {
        if (id === undefined) {
            return Array.from(this._items.values());
        }
        return this._items.get(id) || null;
    }

    forEach(fn) {
        this._items.forEach(val => fn(val));
    }

    update(updates) {
        this.updateCallCount += 1;
        const list = Array.isArray(updates) ? updates : [updates];
        list.forEach(u => {
            const prev = this._items.get(u.id) || {};
            this._items.set(u.id, { ...prev, ...u });
        });
    }
}

class MockNetwork {
    constructor(container, data, options) {
        this.container = container;
        this.data = data;
        this.options = options;
        this._handlers = {};
    }

    on(event, fn) {
        this._handlers[event] = fn;
    }
}

/**
 * Minimal DOM environment for testing TopologyGraph, AgentTable, and ProbeTable without a browser.
 */
function setupMockDom(elementsById = {}) {
    const createEl = (tag = 'div') => ({
        tagName: tag.toUpperCase(),
        innerHTML: '',
        textContent: '',
        style: {},
        className: '',
        attributes: {},
        children: [],
        listeners: {},
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); }
        },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
        querySelector(sel) {
            if (sel === '.info-icon') {
                if (!this._infoIcon) this._infoIcon = createEl('span');
                return this._infoIcon;
            }
            const ageMatch = sel.match(/^\[data-age-key="(.+)"\]$/);
            if (ageMatch) {
                const key = ageMatch[1];
                for (const tr of this.children) {
                    if (tr._ageCells && tr._ageCells[key]) {
                        return tr._ageCells[key];
                    }
                }
            }
            return null;
        }
    });

    const registry = {};
    for (const [id, el] of Object.entries(elementsById)) {
        registry[id] = el || createEl('div');
    }

    globalThis.CSS = { escape: (s) => s };
    globalThis.vis = {
        DataSet: MockDataSet,
        Network: MockNetwork
    };
    globalThis.document = {
        getElementById(id) {
            return registry[id] || null;
        },
        createElement(tag) {
            return createEl(tag);
        },
        querySelectorAll(sel) {
            if (sel === '.last-seen') {
                return registry._lastSeenCells || [];
            }
            return [];
        },
        querySelector(sel) {
            const iconMatch = sel.match(/^\.status-icon\[data-id="(.+)"\]$/);
            if (iconMatch && registry._statusIcons) {
                return registry._statusIcons[iconMatch[1]] || null;
            }
            const stateMatch = sel.match(/^\.agent-state\[data-id="(.+)"\]$/);
            if (stateMatch && registry._stateCells) {
                return registry._stateCells[stateMatch[1]] || null;
            }
            return null;
        }
    };

    return { registry, createEl };
}

test('stateToIconColor maps IN_SPEC, OUT_OF_SPEC, and fallback states consistently', () => {
    assert.equal(stateToIconColor({ value: 'IN_SPEC' }), '#32CD32');
    assert.equal(stateToIconColor({ value: 'OUT_OF_SPEC' }), '#FF0000');
    assert.equal(stateToIconColor({ value: 'UNKNOWN' }), 'grey');
    assert.equal(stateToIconColor({ value: 'dead' }), 'grey');
    assert.equal(stateToIconColor(null), 'grey');
});

test('MqttClient resolves loopback broker host to window.location.hostname and routes events', () => {
    globalThis.window = { location: { hostname: 'controller.fabric.local' } };
    const bus = new EventBus();
    const client = new MqttClient(bus, '127.0.0.1', 8080);
    assert.equal(client._broker, 'controller.fabric.local');
    assert.equal(client._port, 8080);

    const received = {};
    bus.on('mqtt:agent:heartbeat', (p) => { received.heartbeat = p; });
    bus.on('mqtt:agent:state', (p) => { received.state = p; });
    bus.on('mqtt:link:stateUpdate', (p) => { received.link = p; });

    client._onMessage({
        topic: 'monitor',
        payloadString: JSON.stringify({ eventType: 'agentHeartbeat', rid: 'QPU-1' })
    });
    client._onMessage({
        topic: 'monitor',
        payloadString: JSON.stringify({ eventType: 'agentState', rid: 'QPU-1', value: 'IN_SPEC' })
    });
    client._onMessage({
        topic: 'monitor',
        payloadString: JSON.stringify({
            eventType: 'linkStateUpdate',
            value: {
                src_cid: 'QPU-1',
                dst_cid: 'BSM-1',
                channel_id: '2',
                is_quantum: true,
                state: 'QUANTUM_UP'
            }
        })
    });

    assert.equal(received.heartbeat.rid, 'QPU-1');
    assert.equal(received.state.rid, 'QPU-1');
    assert.equal(received.state.value, 'IN_SPEC');
    assert.equal(received.link.src_cid, 'QPU-1');
    assert.equal(received.link.dst_cid, 'BSM-1');
    assert.equal(received.link.state, 'QUANTUM_UP');
    assert.equal(received.link.value.is_quantum, true);
});

test('TopologyGraph disambiguates quantum vs classical parallel edges and styles all states', () => {
    setupMockDom({ 'topo-container': null });
    const bus = new EventBus();
    const graph = new TopologyGraph('topo-container', bus);

    graph.draw({
        nodes: [
            { id: 'QPU-1', label: 'QPU-1', color: 'grey' },
            { id: 'BSM-1', label: 'BSM-1', color: 'grey' }
        ],
        edges: [
            {
                id: 'e-quantum',
                from: 'QPU-1',
                to: 'BSM-1',
                channel_type: 'quantum',
                base_color: 'blue',
                color: '#cccccc',
                width: 1,
                dashes: [2, 4]
            },
            {
                id: 'e-classical',
                from: 'QPU-1',
                to: 'BSM-1',
                channel_type: 'classical',
                base_color: 'purple',
                color: '#cccccc',
                width: 1,
                dashes: [2, 4]
            }
        ]
    });

    // Classical CONTROL_UP update must ONLY update the classical edge
    bus.emit('mqtt:link:stateUpdate', {
        src_cid: 'QPU-1',
        dst_cid: 'BSM-1',
        state: 'CONTROL_UP',
        value: {
            src_cid: 'QPU-1',
            dst_cid: 'BSM-1',
            channel_id: '1',
            is_quantum: false,
            state: 'CONTROL_UP'
        }
    });

    let qEdge = graph.getEdges().get('e-quantum');
    let cEdge = graph.getEdges().get('e-classical');
    assert.equal(cEdge.color, 'purple');
    assert.equal(cEdge.width, 2);
    assert.equal(cEdge.dashes, false);
    assert.equal(cEdge.title, 'classical (CONTROL_UP)');
    // Quantum edge remains untouched (DOWN)
    assert.equal(qEdge.color, '#cccccc');
    assert.equal(qEdge.width, 1);
    assert.deepEqual(qEdge.dashes, [2, 4]);

    // Quantum QUANTUM_UP update must ONLY update the quantum edge
    bus.emit('mqtt:link:stateUpdate', {
        src_cid: 'QPU-1',
        dst_cid: 'BSM-1',
        state: 'QUANTUM_UP',
        value: {
            src_cid: 'QPU-1',
            dst_cid: 'BSM-1',
            channel_id: '2',
            is_quantum: true,
            state: 'QUANTUM_UP',
            probe_tx_count: 4,
            last_probe_info: { tof: 0.0153, vlink: 'QPU-1:2->BSM-1:1' }
        }
    });

    qEdge = graph.getEdges().get('e-quantum');
    cEdge = graph.getEdges().get('e-classical');
    assert.equal(qEdge.color, 'blue');
    assert.equal(qEdge.width, 3);
    assert.equal(qEdge.dashes, false);
    assert.equal(qEdge.title, 'quantum (QUANTUM_UP) | Probes: 4 | ToF: 15.30ms | QPU-1:2->BSM-1:1');
    // Classical edge remains purple width 2
    assert.equal(cEdge.color, 'purple');
    assert.equal(cEdge.width, 2);

    // INIT state uses [5, 5] dashes and baseColor
    graph.updateLinkState('QPU-1', 'BSM-1', 'INIT', { is_quantum: true });
    qEdge = graph.getEdges().get('e-quantum');
    assert.equal(qEdge.color, 'blue');
    assert.equal(qEdge.width, 1);
    assert.deepEqual(qEdge.dashes, [5, 5]);
});

test('TopologyGraph and AgentTable coordinate node fill and border colors accurately', () => {
    const { registry, createEl } = setupMockDom({
        'topo-container': null,
        'agent-tbody': null
    });
    const bus = new EventBus();
    const graph = new TopologyGraph('topo-container', bus);
    graph.draw({
        nodes: [{ id: 'QPU-1', label: 'QPU-1', type: 'MNode', color: 'grey' }],
        edges: []
    });

    // Update node state via EventBus: IN_SPEC -> #32CD32 fill, #666666 border
    bus.emit('mqtt:agent:state', { rid: 'QPU-1', value: 'IN_SPEC' });
    let node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#32CD32');
    assert.equal(node.color.border, '#666666');

    // Hover in AgentTable highlights border to #FF0000 and borderWidth: 4 while preserving #32CD32 fill
    const agentTable = new AgentTable('agent-tbody', {
        getTopoNodes: () => graph.getNodes(),
        onStateChange: (agentId, newState) => graph.updateNodeState(agentId, newState)
    });
    agentTable.highlightNode('QPU-1', true);
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.borderWidth, 4);
    assert.equal(node.color.background, '#32CD32');
    assert.equal(node.color.border, '#FF0000');

    // If agent state changes to OUT_OF_SPEC while hovered, fill becomes #FF0000 and hover border stays #FF0000
    graph.updateNodeState('QPU-1', 'OUT_OF_SPEC');
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#FF0000');
    assert.equal(node.color.border, '#FF0000');

    // Unhover restores border to #666666 and borderWidth: 1 while keeping the updated #FF0000 fill
    agentTable.highlightNode('QPU-1', false);
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.borderWidth, 1);
    assert.equal(node.color.background, '#FF0000');
    assert.equal(node.color.border, '#666666');

    // Simulate dead transition (>20s without heartbeat) and recovery
    const lastSeenCell = createEl('td');
    lastSeenCell.setAttribute('data-id', 'QPU-1');
    const iconEl = createEl('span');
    const stateCell = createEl('td');
    registry._lastSeenCells = [lastSeenCell];
    registry._statusIcons = { 'QPU-1': iconEl };
    registry._stateCells = { 'QPU-1': stateCell };

    const nodesMap = {
        'QPU-1': { lastSeen: 20, state: 'IN_SPEC', iconColor: '#32CD32' }
    };
    agentTable.incrementLastSeen(nodesMap);
    assert.equal(nodesMap['QPU-1'].lastSeen, 21);
    assert.equal(nodesMap['QPU-1'].state, 'dead');
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#FF0000');
    assert.equal(iconEl.style.backgroundColor, '#FF0000');

    // Heartbeat arrives -> lastSeen reset to 0 -> restores IN_SPEC and #32CD32
    nodesMap['QPU-1'].lastSeen = 0;
    agentTable.updateLastSeenDisplay(nodesMap);
    assert.equal(nodesMap['QPU-1'].state, 'IN_SPEC');
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#32CD32');
    assert.equal(iconEl.style.backgroundColor, '#32CD32');

    // Passing stateToIconColor function directly (as app.js does on mqtt:agent:state)
    // must resolve nodes[rid].state rather than passing the raw node wrapper
    agentTable.updateStatusIcon(nodesMap, 'QPU-1', stateToIconColor);
    assert.equal(iconEl.style.backgroundColor, '#32CD32');
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#32CD32');
});

test('TopologyGraph strips group property and ProbeTable highlight preserves IN_SPEC node color', () => {
    setupMockDom({ 'topo-canvas': null, 'probe-tbody': null });

    const graph = new TopologyGraph('topo-canvas');
    graph.draw({
        nodes: [
            { id: 'QPU-1', label: 'QPU-1', group: 1, color: 'grey' },
            { id: 'BSM-1_2', label: 'BSM-1_2', group: 2, color: 'grey' }
        ],
        edges: []
    });

    // `group` must be stripped so vis-network never applies Group 1 blue (#97C2FC)
    assert.equal(graph.getNodes().get('QPU-1').group, undefined);
    assert.equal(graph.getNodes().get('BSM-1_2').group, undefined);

    graph.updateNodeState('QPU-1', 'IN_SPEC');
    graph.updateNodeState('BSM-1_2', 'IN_SPEC');
    assert.equal(graph.getNodes().get('QPU-1').color.background, '#32CD32');

    const probeTable = new ProbeTable('probe-tbody', {
        getTopoNodes: () => graph.getNodes()
    });
    probeTable._highlightTopology('QPU-1', 'BSM-1_2', true);
    assert.equal(graph.getNodes().get('QPU-1').size, 35);
    assert.equal(graph.getNodes().get('QPU-1').color.background, '#32CD32');

    probeTable._highlightTopology('QPU-1', 'BSM-1_2', false);
    assert.equal(graph.getNodes().get('QPU-1').size, 25);
    assert.equal(graph.getNodes().get('QPU-1').color.background, '#32CD32');
});

test('ProbeTable displays ToF (and never RTT) for quantum links, and RTT for classical links', () => {
    const { registry } = setupMockDom({
        'probe-tbody': null,
        'probe-summary-badges': null,
        'probe-history-table-body': null,
        'probe-stream-counter': null
    });

    const probeTable = new ProbeTable('probe-tbody');
    probeTable.loadFromServer([
        {
            src_cid: 'QPU-1',
            dst_cid: 'BSM-1',
            channel_id: '2',
            is_quantum: true,
            state: 'QUANTUM_UP',
            probe_tx_count: 3,
            probe_rx_count: 3,
            probe_ok_count: 3,
            probe_fail_count: 0,
            last_probe_status: 'ok',
            last_probe_info: {
                probe_id: 'q-probe-1',
                tof: 0.0254,
                counts: 1,
                rtt_ms: 999.99, // even if present, quantum link must NOT show rtt_ms
                vlink: 'QPU-1:2->BSM-1:1'
            },
            probe_history: [
                {
                    ts: '2026-10-29T20:00:00.000000',
                    seq: 3,
                    probe_id: 'q-probe-1',
                    tof: 0.0254,
                    counts: 1,
                    rtt_ms: 999.99,
                    vlink: 'QPU-1:2->BSM-1:1',
                    status: 'ok',
                    state: 'QUANTUM_UP'
                }
            ]
        },
        {
            src_cid: 'BSM-1',
            dst_cid: 'QPU-1',
            channel_id: '1',
            is_quantum: false,
            state: 'CONTROL_UP',
            probe_tx_count: 5,
            probe_rx_count: 5,
            probe_ok_count: 5,
            probe_fail_count: 0,
            last_probe_status: 'ok',
            last_probe_info: {
                probe_id: 'c-hello-1',
                kind: 'hello',
                rtt_ms: 42.15,
                vlink: 'BSM-1:1->QPU-1:1'
            },
            probe_history: [
                {
                    ts: '2026-10-29T20:00:01.000000',
                    seq: 5,
                    probe_id: 'c-hello-1',
                    kind: 'hello',
                    rtt_ms: 42.15,
                    vlink: 'BSM-1:1->QPU-1:1',
                    status: 'ok',
                    state: 'CONTROL_UP'
                }
            ]
        }
    ]);

    const mainRows = registry['probe-tbody'].children;
    assert.equal(mainRows.length, 2);

    // Row 0 is sorted to Quantum first
    const quantumRowHtml = mainRows[0].innerHTML;
    assert.match(quantumRowHtml, /Quantum/);
    assert.match(quantumRowHtml, /25\.40 ms \(1 ph\)/);
    assert.doesNotMatch(quantumRowHtml, /999\.99/);

    // Row 1 is Classical
    const classicalRowHtml = mainRows[1].innerHTML;
    assert.match(classicalRowHtml, /Classical/);
    assert.match(classicalRowHtml, /42\.15 ms/);
    assert.match(classicalRowHtml, /HELLO OK/);

    // Stream table also shows ToF (never RTT) for quantum, and RTT for classical
    const streamRows = registry['probe-history-table-body'].children;
    assert.equal(streamRows.length, 2);
    const allStreamHtml = streamRows.map(r => r.innerHTML).join('\n');
    assert.match(allStreamHtml, /25\.40 ms \(1 ph\)/);
    assert.match(allStreamHtml, /42\.15 ms/);
    assert.doesNotMatch(allStreamHtml, /999\.99/);
});

test('Long-running dashboard stability: skips redundant DataSet updates, prevents probe_history re-ingestion, and bounds memory', () => {
    const { registry } = setupMockDom({
        'topo-container': null,
        'probe-tbody': null,
        'probe-summary-badges': null,
        'probe-history-table-body': null,
        'probe-stream-counter': null,
        'debug-panel': null
    });

    // 1. TopologyGraph skips DataSet.update() when visual state/color has not changed
    const bus = new EventBus();
    const graph = new TopologyGraph('topo-container', bus);
    graph.draw({
        nodes: [{ id: 'QPU-1', label: 'QPU-1', color: 'grey' }],
        edges: [{
            id: 'e-quantum',
            from: 'QPU-1',
            to: 'BSM-1',
            channel_type: 'quantum',
            base_color: 'blue',
            color: '#cccccc',
            width: 1,
            dashes: [2, 4]
        }]
    });

    graph.updateNodeState('QPU-1', 'IN_SPEC');
    assert.equal(graph.getNodes().updateCallCount, 1);
    // Repeated identical state updates must NOT trigger vis.DataSet.update
    graph.updateNodeState('QPU-1', 'IN_SPEC');
    graph.updateNodeState('QPU-1', 'IN_SPEC');
    assert.equal(graph.getNodes().updateCallCount, 1);

    graph.updateLinkState('QPU-1', 'BSM-1', 'QUANTUM_UP', {
        is_quantum: true,
        probe_tx_count: 1,
        last_probe_info: { tof: 0.01, vlink: 'QPU-1:2->BSM-1:1' }
    });
    assert.equal(graph.getEdges().updateCallCount, 1);

    // Subsequent periodic probes in the same QUANTUM_UP state update tooltip in-place without calling DataSet.update
    graph.updateLinkState('QPU-1', 'BSM-1', 'QUANTUM_UP', {
        is_quantum: true,
        probe_tx_count: 2,
        last_probe_info: { tof: 0.012, vlink: 'QPU-1:2->BSM-1:1' }
    });
    assert.equal(graph.getEdges().updateCallCount, 1);
    assert.match(graph.getEdges().get('e-quantum').title, /Probes: 2/);

    // 2. ProbeTable does not re-ingest evicted probe_history entries once >40 events have been seen
    const probeTable = new ProbeTable('probe-tbody');
    const history50 = Array.from({ length: 50 }, (_, idx) => ({
        ts: new Date((1700000000 + idx) * 1000).toISOString(),
        seq: idx + 1,
        probe_id: `probe-${idx + 1}`,
        tof: 0.01,
        counts: 1,
        status: 'ok',
        state: 'QUANTUM_UP'
    }));
    const payload = [{
        src_cid: 'QPU-1',
        dst_cid: 'BSM-1',
        channel_id: '2',
        is_quantum: true,
        state: 'QUANTUM_UP',
        probe_tx_count: 50,
        last_probe_id: 'probe-50',
        probe_history: history50
    }];
    probeTable.loadFromServer(payload, { isPoll: false });
    assert.equal(probeTable._probeEvents.size, 40);

    // Polling again with the exact same 50-entry history must detect 0 new events and NOT re-render
    let renderCount = 0;
    const origRender = probeTable.render.bind(probeTable);
    probeTable.render = (...args) => { renderCount += 1; return origRender(...args); };
    probeTable.loadFromServer(payload, { isPoll: true });
    assert.equal(renderCount, 0);

    // 3. DebugPanel bounds messages and truncates oversized payloads
    const debug = new DebugPanel('debug-panel', { maxMessages: 5, maxMessageLength: 20 });
    for (let i = 0; i < 10; i++) {
        debug.addMessage(`msg-${i}-abcdefghijklmnopqrstuvwxyz`);
    }
    assert.equal(debug._messages.length, 5);
    assert.ok(debug._messages.every(m => m.length <= 23));
    assert.match(registry['debug-panel'].value, /msg-9/);

    // 4. CalibrationChart initializes missing agent data and caps resultHistory at 50
    const agentCalibrationData = {};
    const calibChart = new CalibrationChart({ agentCalibrationData, chartCache: {} });
    for (let i = 0; i < 65; i++) {
        calibChart.handleTaskResult({
            rid: 'QPU-1',
            value: {
                name: 'Rabi Frequency',
                result: { idx: i },
                created_at: 1700000000 + i
            }
        });
    }
    const hist = agentCalibrationData['QPU-1'].resultHistory.get('QPU-1-RabiFrequency');
    assert.equal(hist.length, 50);
    assert.deepEqual(hist[0].result, { idx: 64 });
});


