import { formatList, formatTable, formatNestedOperations, stateToColorClass } from '../../utils/formatters.js';
import { CalibrationStore } from '../../models/CalibrationStore.js';

/**
 * AgentModal — Encapsulates the Agent Details modal, including node-type
 * display renderers, calibration accordion, task history loading, and pager.
 *
 * Replaces the global functions `openInfoModal()`, `openAgentModalFromTopology()`,
 * `displayMNode()`, `displayQNode()`, `displayBSMNode()`, `displayOpticalSwitch()`,
 * `updateCalibrationModal()`, `appendCalibrationAccordionTask()`,
 * `updateCalibrationTaskState()`, `pagerNext()`, `pagerPrev()`, `updatePagerUI()`,
 * `newCalibrationData()`, and `getStateColorClass()` from qn.js.
 *
 * Usage:
 *   const agentModal = new AgentModal('AgentDetailsModal', {
 *       calibrationStore,
 *       agentCalibrationData,
 *       chartCache,
 *       getActiveAgentId: () => activeAgentId,
 *       setActiveAgentId: (id) => { activeAgentId = id; }
 *   });
 *   agentModal.open(agentData);
 */
export class AgentModal {
    /**
     * @param {string} modalId - ID of the modal element
     * @param {Object} options
     * @param {CalibrationStore} options.calibrationStore - CalibrationStore instance
     * @param {Object} options.agentCalibrationData - Reference to agentCalibrationData map
     * @param {Object} options.chartCache - Reference to chart cache object
     * @param {Function} options.getActiveAgentId - Returns current active agent ID
     * @param {Function} options.setActiveAgentId - Sets the active agent ID
     * @param {Object} [options.nodes] - Reference to nodes map (for openFromTopology)
     * @param {Object} [options.calibChart] - CalibrationChart instance for chart population
     */
    constructor(modalId, options = {}) {
        this._modalId = modalId;
        this._calibrationStore = options.calibrationStore || null;
        this._agentCalibrationData = options.agentCalibrationData || {};
        this._chartCache = options.chartCache || {};
        this._getActiveAgentId = options.getActiveAgentId || (() => null);
        this._setActiveAgentId = options.setActiveAgentId || (() => {});
        this._nodes = options.nodes || {};
        this._calibChart = options.calibChart || null;
    }

    /**
     * Open the agent details modal from a topology node double-click.
     * @param {string} nodeId - The node ID from the topology graph
     */
    openFromTopology(nodeId) {
        if (this._nodes[nodeId]) {
            this.open(this._nodes[nodeId]);
        } else {
            console.warn(`No agent data found for topology node: ${nodeId}`);
        }
    }

    /**
     * Open the agent details modal with the given agent data.
     * @param {Object} data - Agent data object (with .value containing agent info)
     */
    async open(data) {
        const agent = data.value;
        const type = agent.systemSettings.type;
        const activeAgentId = agent.systemSettings.ID;
        this._setActiveAgentId(activeAgentId);
        if (this._calibrationStore) {
            this._calibrationStore.setActiveAgentId(activeAgentId);
        }

        // Set Modal Title
        document.getElementById('AgentInfoModalLabel').textContent =
            `${type} ${activeAgentId} Details`;

        // Clear previous details
        document.getElementById('AgentDetailsContent').innerHTML = '';

        // Reset Calibration Modal State
        document.getElementById('currentTaskOperation').textContent =
            'Loading calibration history...';
        document.getElementById('taskProgressBar').style.width = '0%';
        document.getElementById('taskProgressBar').textContent = '0%';
        const accordion = document.getElementById('calibrationAccordion');
        accordion.innerHTML = '';

        // Add spinner back if it was removed
        const spinnerDiv = document.getElementById('calibrationSpinner');
        if (spinnerDiv && !document.getElementById('calibration-loading-spinner')) {
            spinnerDiv.innerHTML = `
                <div id="calibration-loading-spinner" class="text-center my-3">
                  <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                  </div>
                </div>`;
        }

        // Initialize agent calibration data
        if (!this._agentCalibrationData[activeAgentId]) {
            this._agentCalibrationData[activeAgentId] =
                CalibrationStore.newCalibrationData();
            this._agentCalibrationData[activeAgentId].currentTask =
                'Loading calibration history...';
        } else {
            this._agentCalibrationData[activeAgentId].currentTask =
                'Loading calibration history...';
        }

        // Fetch task history
        this._fetchTaskHistory(activeAgentId);

        // Render agent details by type
        let contentHTML = '';
        switch (type) {
            case 'MNode':
                contentHTML = this._displayMNode(agent);
                break;
            case 'QNode':
                contentHTML = this._displayQNode(agent);
                break;
            case 'BSMNode':
                contentHTML = this._displayBSMNode(agent);
                break;
            case 'OpticalSwitch':
                contentHTML = this._displayOpticalSwitch(agent);
                break;
            default:
                contentHTML = `<p>Unknown agent type: ${type}</p>`;
        }

        document.getElementById('AgentDetailsContent').innerHTML = contentHTML;
        new bootstrap.Modal(document.getElementById(this._modalId)).show();
    }

    /**
     * Update the calibration progress display in the modal.
     * @param {string} agentId
     */
    updateCalibrationModal(agentId) {
        const currentTaskDiv = document.getElementById('currentTaskOperation');
        const progressBar = document.getElementById('taskProgressBar');

        if (!this._agentCalibrationData[agentId]) {
            currentTaskDiv.textContent = 'Waiting for task updates...';
            return;
        }

        const agentData = this._agentCalibrationData[agentId];
        currentTaskDiv.textContent = agentData.currentTask || 'No active task';

        let completedTasks = 0;
        for (const [, state] of agentData.tasks.entries()) {
            if (state === 'IN_SPEC' || state === 'PARTIAL_OUT_OF_SPEC' ||
                state === 'Done') {
                completedTasks++;
            }
        }

        const progressPercent = (agentData.totalTasks > 0)
            ? (completedTasks / agentData.totalTasks) * 100
            : 0;
        progressBar.style.width = `${progressPercent}%`;
        progressBar.textContent = `${Math.round(progressPercent)}%`;
    }

    /**
     * Append a calibration task accordion item.
     * @param {string} agentId
     * @param {string} taskName
     * @param {string} taskState
     * @param {number} [totalResults]
     */
    appendCalibrationAccordionTask(agentId, taskName, taskState, totalResults) {
        const taskId = `${agentId}-${taskName.replace(/\s+/g, '')}`;
        const canvasId = `chart-${taskId}`;
        const pagerId = `pager-${taskId}`;
        const container = document.getElementById('calibrationAccordion');
        const total = totalResults || 1;

        const html = `
          <div class="accordion-item" id="accordion-${taskId}">
            <h2 class="accordion-header" id="heading-${taskId}">
              <button class="accordion-button collapsed" type="button"
                      data-bs-toggle="collapse"
                      data-bs-target="#collapse-${taskId}"
                      aria-expanded="false">
                <div class="d-flex w-100 justify-content-between align-items-center">
                  <span>${taskName}</span>
                  <span class="badge ${stateToColorClass(taskState)} me-3"
                        id="task-state-${taskId}">
                    ${taskState || ''}
                  </span>
                </div>
              </button>
            </h2>
            <div id="collapse-${taskId}"
                 class="accordion-collapse collapse"
                 aria-labelledby="heading-${taskId}"
                 data-bs-parent="#calibrationAccordion">
              <div class="accordion-body">
                <div class="text-muted small text-end mb-1"
                     id="timestamp-${taskId}"></div>
                <div style="position:relative; height:300px; width:100%;">
                  <canvas id="${canvasId}"></canvas>
                </div>
                <div id="${pagerId}"
                     class="d-flex justify-content-between align-items-center mt-2 ${total <= 1 ? 'd-none' : ''}"
                     style="min-height:32px;">
                  <button class="btn btn-sm btn-outline-secondary"
                          id="pager-prev-${taskId}"
                          ${total <= 1 ? 'disabled' : ''}>
                    &#9664; Newer
                  </button>
                  <span class="text-muted small"
                        id="pager-label-${taskId}">1 of ${total}</span>
                  <button class="btn btn-sm btn-outline-secondary"
                          id="pager-next-${taskId}"
                          ${total <= 1 ? 'disabled' : ''}>
                    Older &#9654;
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;

        // Remove loading spinner
        const spinner = document.getElementById('calibration-loading-spinner');
        if (spinner) spinner.remove();

        container.insertAdjacentHTML('beforeend', html);

        // Attach pager button handlers
        const prevBtn = document.getElementById(`pager-prev-${taskId}`);
        const nextBtn = document.getElementById(`pager-next-${taskId}`);
        if (prevBtn) {
            prevBtn.onclick = () => this.pagerPrev(agentId, taskId);
        }
        if (nextBtn) {
            nextBtn.onclick = () => this.pagerNext(agentId, taskId);
        }

        // Determine x-axis label
        let xAxisLabel = 'X Axis';
        if (taskName.includes('Frequency')) {
            xAxisLabel = 'AOM Frequency';
        } else if (taskName.includes('Attenuation')) {
            xAxisLabel = 'Attenuation';
        }

        // Wait a tick to ensure canvas is in DOM
        setTimeout(() => {
            const ctx = document.getElementById(canvasId)?.getContext('2d');
            if (ctx) {
                if (this._chartCache[canvasId] && typeof this._chartCache[canvasId].destroy === 'function') {
                    this._chartCache[canvasId].destroy();
                }
                this._chartCache[canvasId] = new Chart(ctx, {
                    type: 'scatter',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'Value',
                            data: [],
                            backgroundColor: 'rgba(100, 149, 237, 0.6)',
                            borderColor: 'cornflowerblue',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                title: { display: true, text: xAxisLabel }
                            },
                            y: {
                                title: { display: true, text: 'PMT counts' }
                            }
                        }
                    }
                });

                if (this._calibChart) {
                    this._calibChart.populate(agentId, taskId);
                }
            }
        }, 0);
    }

    /**
     * Update the state badge for a calibration task.
     * @param {string} agentId
     * @param {string} taskName
     * @param {string} taskState
     */
    updateCalibrationTaskState(agentId, taskName, taskState) {
        const taskId = `${agentId}-${taskName.replace(/\s+/g, '')}`;
        const stateBadge = document.getElementById(`task-state-${taskId}`);
        if (stateBadge) {
            stateBadge.textContent = taskState;
            stateBadge.className =
                `badge ${stateToColorClass(taskState)} me-3`;
        }
    }

    /**
     * Navigate to the next (older) pager entry.
     */
    pagerNext(agentId, taskId) {
        const agentData = this._agentCalibrationData[agentId];
        if (!agentData) return;
        const history = agentData.resultHistory.get(taskId);
        if (!history) return;
        let idx = agentData.resultIndex.get(taskId) || 0;
        if (idx < history.length - 1) {
            idx++;
            agentData.resultIndex.set(taskId, idx);
            agentData.results.set(taskId, history[idx].result);
            if (this._calibChart) this._calibChart.populate(agentId, taskId);
            this._updatePagerUI(agentId, taskId);
        }
    }

    /**
     * Navigate to the previous (newer) pager entry.
     */
    pagerPrev(agentId, taskId) {
        const agentData = this._agentCalibrationData[agentId];
        if (!agentData) return;
        const history = agentData.resultHistory.get(taskId);
        if (!history) return;
        let idx = agentData.resultIndex.get(taskId) || 0;
        if (idx > 0) {
            idx--;
            agentData.resultIndex.set(taskId, idx);
            agentData.results.set(taskId, history[idx].result);
            if (this._calibChart) this._calibChart.populate(agentId, taskId);
            this._updatePagerUI(agentId, taskId);
        }
    }

    // ── Private methods ─────────────────────────────────────────────

    /** @private */
    _updatePagerUI(agentId, taskId) {
        const agentData = this._agentCalibrationData[agentId];
        if (!agentData) return;
        const history = agentData.resultHistory.get(taskId);
        if (!history) return;
        const idx = agentData.resultIndex.get(taskId) || 0;
        const total = history.length;

        const label = document.getElementById(`pager-label-${taskId}`);
        if (label) label.textContent = `${idx + 1} of ${total}`;

        const prevBtn = document.getElementById(`pager-prev-${taskId}`);
        if (prevBtn) prevBtn.disabled = (idx <= 0);

        const nextBtn = document.getElementById(`pager-next-${taskId}`);
        if (nextBtn) nextBtn.disabled = (idx >= total - 1);

        const tsLabel = document.getElementById(`timestamp-${taskId}`);
        if (tsLabel) {
            const entry = history[idx];
            if (entry && entry.created_at) {
                tsLabel.textContent =
                    `Collected: ${new Date(entry.created_at * 1000).toLocaleString()}`;
            } else {
                tsLabel.textContent = '';
            }
        }

        const pager = document.getElementById(`pager-${taskId}`);
        if (pager) {
            if (total > 1) pager.classList.remove('d-none');
            else pager.classList.add('d-none');
        }
    }

    /** @private */
    _fetchTaskHistory(activeAgentId) {
        fetch(`api/tasks?agent_id=${activeAgentId}`)
            .then(response => {
                if (!response.ok) {
                    return response.json().then(body => {
                        throw new Error(
                            body.detail || body.error ||
                            `Request failed (${response.status})`
                        );
                    }).catch(parseErr => {
                        if (parseErr.message &&
                            !parseErr.message.startsWith('Request failed')) {
                            throw parseErr;
                        }
                        throw new Error(
                            `Request failed with status ${response.status}`
                        );
                    });
                }
                return response.json();
            })
            .then(tasks => {
                this._processTaskHistory(tasks, activeAgentId);
            })
            .catch(error => {
                console.error('Failed to fetch calibration history:', error);
                document.getElementById('currentTaskOperation').textContent =
                    'Error loading history: ' + error.message;
                const spinner =
                    document.getElementById('calibration-loading-spinner');
                if (spinner) {
                    spinner.innerHTML =
                        '<div class="text-center text-danger">' +
                        'Failed to load calibration data.</div>';
                }
            });
    }

    /** @private */
    _processTaskHistory(tasks, activeAgentId) {
        if (!tasks || tasks.length === 0) {
            document.getElementById('currentTaskOperation').textContent =
                'No calibration history.';
            const spinner =
                document.getElementById('calibration-loading-spinner');
            if (spinner) {
                spinner.innerHTML =
                    '<div class="text-center text-muted">' +
                    'No historical data available.</div>';
            }
            return;
        }

        tasks.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        const allByType = new Map();
        tasks.forEach(task => {
            if (task.result && task.expName) {
                if (!allByType.has(task.expName)) {
                    allByType.set(task.expName, []);
                }
                allByType.set(
                    task.expName,
                    allByType.get(task.expName).concat(task)
                );
            }
        });

        if (allByType.size === 0) {
            document.getElementById('currentTaskOperation').textContent =
                'No recent calibration found.';
            const spinner =
                document.getElementById('calibration-loading-spinner');
            if (spinner) {
                spinner.innerHTML =
                    '<div class="text-center text-muted">' +
                    'No local historical data.</div>';
            }
            return;
        }

        console.log(
            'Loading historical calibration results for types:',
            Array.from(allByType.keys())
        );
        const agentData = this._agentCalibrationData[activeAgentId];
        agentData.totalTasks = allByType.size;

        let lastUpdate = 0;
        allByType.forEach((taskList, expName) => {
            const taskId =
                `${activeAgentId}-${expName.replace(/\s+/g, '')}`;

            agentData.resultHistory.set(
                taskId,
                taskList.map(t => ({
                    result: t.result,
                    created_at: t.created_at
                }))
            );
            agentData.resultIndex.set(taskId, 0);

            if (!agentData.tasks.has(expName)) {
                this.appendCalibrationAccordionTask(
                    activeAgentId, expName, 'Done', taskList.length
                );
                agentData.tasks.set(expName, 'Done');
            }

            const latest = taskList[0];
            if (this._calibChart) {
                this._calibChart.handleTaskResult({
                    rid: activeAgentId,
                    value: {
                        name: expName,
                        result: latest.result
                    }
                });
            }

            this._updatePagerUI(activeAgentId, taskId);
            if (latest.created_at > lastUpdate) {
                lastUpdate = latest.created_at;
            }
        });

        agentData.currentTask = 'Last calibration: ' +
            new Date(lastUpdate * 1000).toLocaleString();
        this.updateCalibrationModal(activeAgentId);
    }

    /** @private */
    _displayMNode(agent) {
        let html = '<h4>System Settings</h4>';
        html += formatList(agent.systemSettings);

        html += '<h4>Quantum Settings</h4>';
        html += formatList(agent.quantumSettings);

        if (agent.quantumSettings.detectorSettings) {
            html += '<h5>Detector Settings</h5>';
            html += formatTable(
                ['Name', 'Efficiency', 'Dark Count',
                 'Count Rate', 'Time Resolution'],
                agent.quantumSettings.detectorSettings.map(d => [
                    d.name, d.efficiency, d.darkCount,
                    `${d.countRate.value} ${d.countRate.unit}`,
                    `${d.timeResolution.value} ${d.timeResolution.unit}`
                ])
            );
        }

        html += '<h4>Channels</h4>';
        html += this._renderChannelsTable(agent.channels);
        return html;
    }

    /** @private */
    _displayQNode(agent) {
        let html = '<h4>System Settings</h4>';
        html += formatList(agent.systemSettings);

        html += '<h4>Qubit Settings</h4>';
        html += formatTable(
            ['ID', 'Quantum Object', 'T1', 'T2', 'Type'],
            agent.qubitSettings.qubits.map(q => [
                q.ID, q.quantumObject,
                `${q.T1.value} ${q.T1.unit}`,
                `${q.T2.value} ${q.T2.unit}`,
                q.type
            ])
        );

        html += '<h4>Operations</h4>';
        html += formatNestedOperations(agent.qubitSettings.operations);

        html += '<h4>Channels</h4>';
        html += this._renderChannelsTable(agent.channels);
        return html;
    }

    /** @private */
    _displayBSMNode(agent) {
        let html = '<h4>System Settings</h4>';
        html += formatList(agent.systemSettings);

        html += '<h4>Quantum Settings</h4>';

        if (agent.quantumSettings.detectorSettings) {
            html += '<h5>Detector Settings</h5>';
            html += formatTable(
                ['Name', 'Efficiency', 'Dark Count',
                 'Count Rate', 'Time Resolution'],
                agent.quantumSettings.detectorSettings.map(d => [
                    d.name, d.efficiency, d.darkCount,
                    `${d.countRate.value} ${d.countRate.unit}`,
                    `${d.timeResolution.value} ${d.timeResolution.unit}`
                ])
            );

            const { detectorSettings, ...rest } = agent.quantumSettings;
            html += formatList(rest);
        } else {
            html += formatList(agent.quantumSettings);
        }

        html += '<h4>Channels</h4>';
        html += this._renderChannelsTable(agent.channels);
        return html;
    }

    /** @private */
    _displayOpticalSwitch(agent) {
        let html = '<h4>System Settings</h4>';
        html += formatList(agent.systemSettings);

        html += '<h4>Channels</h4>';
        html += this._renderChannelsTable(agent.channels);
        return html;
    }

    /** @private */
    _renderChannelsTable(channels) {
        return formatTable(
            ['ID', 'Name', 'Type', 'Direction', 'Wavelength', 'Power'],
            channels.map(ch => [
                ch.ID, ch.name, ch.type, ch.direction,
                `${ch.wavelength.value} ${ch.wavelength.unit}`,
                ch.power
            ])
        );
    }
}
