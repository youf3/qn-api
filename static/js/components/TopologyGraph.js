/**
 * TopologyGraph — Encapsulates vis.js network graph rendering and interaction.
 *
 * Replaces the inline `drawTopology()` function and the `network`, `topo_nodes`,
 * `topo_edges` globals from main.html.
 *
 * Usage:
 *   const topology = new TopologyGraph('topology-container', {
 *       onDoubleClick: (nodeId) => openAgentModalFromTopology(nodeId)
 *   });
 *   topology.draw(experimentStore.getTopology());
 *   // AgentTable can reference: topology.getNodes()
 */
export class TopologyGraph {
    /**
     * @param {string} containerId - ID of the DOM element for the vis.js graph
     * @param {Object} eventBus - Event bus for MQTT updates
     * @param {Object} [options]
     * @param {Function} [options.onDoubleClick] - Callback when a node is double-clicked, receives nodeId
     * @param {Object} [options.networkOptions] - vis.js Network options override
     */
    constructor(containerId, eventBus, options = {}) {
        this._containerId = containerId;
        this._eventBus = eventBus;
        this._onDoubleClick = options.onDoubleClick || null;
        this._networkOptions = options.networkOptions || {
            physics: { enabled: true },
            edges: { arrows: 'to' }
        };

        /** @type {vis.Network|null} */
        this._network = null;
        /** @type {vis.DataSet|null} */
        this._nodes = null;
        /** @type {vis.DataSet|null} */
        this._edges = null;
    }

    /**
     * Draw (or redraw) the topology graph.
     * @param {Object} topo - Topology data with `nodes` and `edges` arrays
     */
    draw(topo) {
        const container = document.getElementById(this._containerId);
        if (!container) {
            console.warn(`TopologyGraph: container #${this._containerId} not found`);
            return;
        }

        console.log('Embedded Data:', topo);

        this._nodes = new vis.DataSet(topo.nodes || []);
        this._edges = new vis.DataSet(topo.edges || []);

        this._network = new vis.Network(
            container,
            { nodes: this._nodes, edges: this._edges },
            this._networkOptions
        );

        // Double-click opens agent modal
        if (this._onDoubleClick) {
            this._network.on('doubleClick', (params) => {
                if (params.nodes.length > 0) {
                    this._onDoubleClick(params.nodes[0]);
                }
            });
        }

        // Subscribe to MQTT link state updates
        if (this._eventBus) {
            this._eventBus.on('mqtt:link:stateUpdate', ({ src_cid, dst_cid, state }) => {
                this.updateLinkState(src_cid, dst_cid, state);
            });
            this._eventBus.on('mqtt:agent:state', ({ rid, value }) => {
                this.updateNodeState(rid, value);
            });
        }
    }

    /**
     * Get the vis.js DataSet of nodes (used by AgentTable for highlighting).
     * @returns {vis.DataSet|null}
     */
    getNodes() {
        return this._nodes;
    }

    /**
     * Get the vis.js DataSet of edges.
     * @returns {vis.DataSet|null}
     */
    getEdges() {
        return this._edges;
    }

    /**
     * Get the vis.js Network instance.
     * @returns {vis.Network|null}
     */
    getNetwork() {
        return this._network;
    }

    /**
     * Update edge styling based on link state.
     * Finds all edges between src_cid and dst_cid and applies width/opacity/dashes/color.
     * @param {string} src_cid - Source node ID
     * @param {string} dst_cid - Destination node ID
     * @param {string} state - Link state: QUANTUM_UP, CONTROL_UP, INIT, or DOWN
     */
    updateLinkState(src_cid, dst_cid, state) {
        if (!this._edges) return;
        
        const styleMap = {
            'QUANTUM_UP': { width: 3, opacity: 1.0, dashes: false, color: null },
            'CONTROL_UP': { width: 2, opacity: 1.0, dashes: false, color: null },
            'INIT': { width: 1, opacity: 0.5, dashes: [5, 5], color: null },
            'DOWN': { width: 1, opacity: 0.3, dashes: [2, 4], color: '#cccccc' }
        };
        
        const style = styleMap[state] || styleMap['DOWN'];
        
        // Find edges matching (from, to) and update them
        const updates = [];
        this._edges.forEach(edge => {
            if (edge.from === src_cid && edge.to === dst_cid) {
                const update = { id: edge.id };
                update.width = style.width;
                update.opacity = style.opacity;
                update.dashes = style.dashes;
                if (style.color) {
                    update.color = style.color;
                }
                updates.push(update);
            }
        });
        
        if (updates.length > 0) {
            this._edges.update(updates);
        }
    }

    /**
     * Update node border styling based on agent state.
     * @param {string} nodeId - Node ID (agent ID)
     * @param {string} state - Agent state: IN_SPEC or OUT_OF_SPEC
     */
    updateNodeState(nodeId, state) {
        if (!this._nodes) return;
        
        let borderColor = '#999999';  // default grey
        let borderWidth = 1;
        
        if (state === 'IN_SPEC') {
            borderColor = '#32CD32';  // green
            borderWidth = 3;
        } else if (state === 'OUT_OF_SPEC') {
            borderColor = '#FF0000';  // red
            borderWidth = 3;
        }
        
        // Update node border properties, preserving background color
        this._nodes.update({
            id: nodeId,
            color: {
                border: borderColor,
                borderWidth: borderWidth
            }
        });
    }
}
