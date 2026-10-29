import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../static/js/core/EventBus.js';
import { MqttClient } from '../../static/js/core/MqttClient.js';
import { TopologyGraph } from '../../static/js/components/TopologyGraph.js';
import { AgentTable } from '../../static/js/components/AgentTable.js';
import { ProbeTable } from '../../static/js/components/ProbeTable.js';
import { stateToIconColor } from '../../static/js/utils/formatters.js';

/**
 * Minimal in-memory vis.DataSet mock matching the subset used by TopologyGraph, AgentTable, and ProbeTable.
 */
class MockDataSet {
    constructor(items = []) {
        this._items = new Map();
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
    assert.equal(node.color.background, 'grey');

    // Heartbeat arrives -> lastSeen reset to 0 -> restores IN_SPEC and #32CD32
    nodesMap['QPU-1'].lastSeen = 0;
    agentTable.updateLastSeenDisplay(nodesMap);
    assert.equal(nodesMap['QPU-1'].state, 'IN_SPEC');
    node = graph.getNodes().get('QPU-1');
    assert.equal(node.color.background, '#32CD32');
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

