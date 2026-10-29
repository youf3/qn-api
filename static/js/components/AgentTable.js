import { stateToIconColor } from '../utils/formatters.js';

/**
 * AgentTable — Encapsulates agent table rendering, heartbeat tracking,
 * status icon updates, and vis.js topology highlighting.
 *
 * Replaces the global functions `updateAgentTable()`, `incrementLastSeen()`,
 * `updateLastSeenDisplay()`, `updateStatusIcon()`, and
 * `highlightNodeInTopology()` from qn.js.
 *
 * Usage:
 *   const agentTable = new AgentTable('agent-table-body', {
 *       onOpenModal: (agentData) => openInfoModal(agentData),
 *       getTopoNodes: () => topology.getNodes()
 *   });
 *   agentTable.render(nodes);
 *   agentTable.incrementLastSeen(nodes);
 */
export class AgentTable {
    /**
     * @param {string} tableBodyId - ID of the <tbody> element
     * @param {Object} [options]
     * @param {Function} [options.onOpenModal] - Callback when info icon is clicked, receives agent data
     * @param {Function} [options.getTopoNodes] - Returns the vis.js DataSet for topology nodes
     */
    constructor(tableBodyId, options = {}) {
        this._tableBodyId = tableBodyId;
        this._onOpenModal = options.onOpenModal || null;
        this._getTopoNodes = options.getTopoNodes || null;
        this._onStateChange = options.onStateChange || null;
        this._originalNodeProperties = {};
    }

    /**
     * Render the full agent table.
     * @param {Object} nodes - Map of agentId → agent data
     */
    render(nodes) {
        const tableBody = document.getElementById(this._tableBodyId);
        if (!tableBody) return;
        tableBody.innerHTML = '';

        const sortedKeys = Object.keys(nodes).sort((a, b) => a.localeCompare(b));
        sortedKeys.forEach(k => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><span class="status-icon" style="background-color: ${nodes[k].iconColor};" data-id="${k}"></span>
                    ${k}
                </td>
                <td class="last-seen" data-id="${k}">${nodes[k].lastSeen}</td>
                <td class="agent-state" data-id="${k}">${nodes[k].state}</td>
                <td class="text-center">
                    <div class="d-flex justify-content-center align-items-center">
                        <span class="info-icon" style="cursor:pointer;">
                            ℹ️
                        </span>
                    </div>
                </td>
            `;

            // Assign the onclick function to open the modal
            if (this._onOpenModal) {
                const openModal = this._onOpenModal;
                row.querySelector('.info-icon').onclick = function () {
                    openModal(nodes[k]);
                };
            }

            // Add hover event listeners for vis.js topology highlighting
            row.addEventListener('mouseover', () => {
                this.highlightNode(k, true);
            });
            row.addEventListener('mouseout', () => {
                this.highlightNode(k, false);
            });

            tableBody.appendChild(row);
        });
    }

    /**
     * Increment "Last Seen" counter for all agents every tick.
     * @param {Object} nodes - Map of agentId → agent data
     */
    incrementLastSeen(nodes) {
        Object.values(nodes).forEach(node => {
            if (node.lastSeen === 'never') {
                // only increment if we have seen a heartbeat
            } else {
                node.lastSeen++;
            }
        });
        this.updateLastSeenDisplay(nodes);
    }

    /**
     * Update table display for "Last Seen" column and detect dead agents.
     * @param {Object} nodes - Map of agentId → agent data
     */
    updateLastSeenDisplay(nodes) {
        document.querySelectorAll('.last-seen').forEach(cell => {
            const agentID = cell.getAttribute('data-id');
            if (!nodes[agentID]) return;
            cell.textContent = nodes[agentID].lastSeen;

            if (nodes[agentID].lastSeen === 'never') {
                this.updateStatusIcon(nodes, agentID, 'orange');
            } else if (nodes[agentID].lastSeen > 20) {
                if (nodes[agentID].state !== 'dead') {
                    nodes[agentID].lastState = nodes[agentID].state;
                    nodes[agentID].state = 'dead';
                    if (this._onStateChange) {
                        this._onStateChange(agentID, 'dead');
                    }
                }
                this.updateStatusIcon(nodes, agentID, 'red');
            } else {
                if (nodes[agentID].state === 'dead') {
                    nodes[agentID].state = nodes[agentID].lastState;
                    if (this._onStateChange) {
                        this._onStateChange(agentID, nodes[agentID].state);
                    }
                }
                const iconColor = stateToIconColor({ value: nodes[agentID].state });
                this.updateStatusIcon(nodes, agentID, iconColor);
            }
        });
    }

    /**
     * Update the status icon color and state text for an agent.
     * @param {Object} nodes - Map of agentId → agent data
     * @param {string} agentID - The agent ID
     * @param {string|Function} color - CSS color string or color function
     */
    updateStatusIcon(nodes, agentID, color) {
        const icon = document.querySelector(`.status-icon[data-id="${agentID}"]`);
        const scell = document.querySelector(`.agent-state[data-id="${agentID}"]`);
        if (icon) {
            icon.style.backgroundColor = typeof color === 'function' ? color(nodes[agentID]) : color;
        }
        if (scell) {
            scell.textContent = nodes[agentID].state;
        }
    }

    /**
     * Highlight or unhighlight a node in the vis.js topology graph.
     * @param {string} nodeID - The node ID to highlight
     * @param {boolean} highlight - true to highlight, false to restore
     */
    highlightNode(nodeID, highlight) {
        const topoNodes = this._getTopoNodes ? this._getTopoNodes() : null;
        if (!topoNodes) return;

        const updateNodes = [];
        if (highlight) {
            topoNodes.forEach(node => {
                if (node.id === nodeID) {
                    const bgColor = node.color
                        ? (typeof node.color === 'string' ? node.color : (node.color.background || 'grey'))
                        : 'grey';
                    const origBorder = (node.color && typeof node.color === 'object' && node.color.border)
                        ? node.color.border
                        : '#666666';
                    // Save original border/size properties before highlighting
                    this._originalNodeProperties[node.id] = {
                        borderColor: origBorder,
                        borderWidth: node.borderWidth || 1,
                        size: node.size || 25
                    };
                    updateNodes.push({
                        id: node.id,
                        borderWidth: 4,
                        color: {
                            background: bgColor,
                            border: '#FF0000',
                            highlight: {
                                background: bgColor,
                                border: '#FF0000'
                            }
                        },
                        size: (node.size || 25) * 1.3
                    });
                }
            });
        } else {
            // Restore original border/size while preserving current state background color
            const saved = this._originalNodeProperties[nodeID];
            const currentNode = topoNodes.get(nodeID);
            if (saved && currentNode) {
                const currentBg = currentNode.color
                    ? (typeof currentNode.color === 'string' ? currentNode.color : (currentNode.color.background || 'grey'))
                    : 'grey';
                updateNodes.push({
                    id: nodeID,
                    borderWidth: saved.borderWidth,
                    size: saved.size,
                    color: {
                        background: currentBg,
                        border: saved.borderColor,
                        highlight: {
                            background: currentBg,
                            border: saved.borderColor
                        }
                    }
                });
                delete this._originalNodeProperties[nodeID];
            }
        }
        if (updateNodes.length > 0) {
            topoNodes.update(updateNodes);
        }
    }
}
