import { EventBus } from './core/EventBus.js';
import { ApiClient } from './core/ApiClient.js';
import { MqttClient } from './core/MqttClient.js';
import { showToast, getApiError, stateToIconColor } from './utils/formatters.js';
import { AgentStore } from './models/AgentStore.js';
import { CalibrationStore } from './models/CalibrationStore.js';
import { ExperimentStore } from './models/ExperimentStore.js';
import { DebugPanel } from './components/DebugPanel.js';
import { AgentTable } from './components/AgentTable.js';
import { ExperimentTable } from './components/ExperimentTable.js';
import { CalibrationTable } from './components/CalibrationTable.js';
import { TopologyGraph } from './components/TopologyGraph.js';
import { ExperimentModal } from './components/modals/ExperimentModal.js';
import { CalibrationDetailsModal } from './components/modals/CalibrationDetailsModal.js';
import { CalibrationFormModal } from './components/modals/CalibrationFormModal.js';
import { PingModal } from './components/modals/PingModal.js';
import { SpgModal } from './components/modals/SpgModal.js';
import { EgpModal } from './components/modals/EgpModal.js';
import { AgentModal } from './components/modals/AgentModal.js';
import { BsmChart } from './components/charts/BsmChart.js';
import { HomChart } from './components/charts/HomChart.js';
import { PolTrackingChart } from './components/charts/PolTrackingChart.js';
import { TimeTaggerChart } from './components/charts/TimeTaggerChart.js';
import { CalibrationChart } from './components/charts/CalibrationChart.js';
import { DataChart } from './components/charts/DataChart.js';
import { HistogramChart } from './components/charts/HistogramChart.js';

/**
 * App — Main application bootstrap.
 *
 * Instantiates all stores, components, charts, and modals,
 * wires EventBus subscriptions, and sets up DOM event listeners.
 *
 * Usage (in main.html):
 *   const data = {{ data | tojson }};
 *   const app = new App(data);
 */
export class App {
    /**
     * @param {Object} data - Server-rendered data payload
     * @param {Object[]} data.nodes - Agent node list
     * @param {Object[]} data.calibrations - Calibration list
     * @param {Object[]} data.experiments - Experiment list
     * @param {Object} data.topology - Topology graph data
     * @param {string} data.ws_host - MQTT WebSocket host
     * @param {number} data.ws_port - MQTT WebSocket port
     */
    constructor(data, role = 'admin') {
        // Expose on window so inline onclick handlers can reach components
        window.app = this;

        this.role = role;
        // Extract username from the page context (passed by main.py)
        this.username = document.body.getAttribute('data-username') || 'unknown';
        console.log('View data:', data, 'Role:', role, 'Username:', this.username);

        // ── Instantiate core services ────────────────────────────────────
        this.eventBus = new EventBus();
        this.apiClient = new ApiClient();

        // ── Instantiate stores ───────────────────────────────────────────
        this.agentStore = new AgentStore(this.eventBus);
        this.calibrationStore = new CalibrationStore(this.eventBus);
        this.experimentStore = new ExperimentStore(this.eventBus);

        // Hydrate from server data
        this.agentStore.loadFromServer(data.nodes);
        this.calibrationStore.loadCalibrations(data.calibrations);
        this.experimentStore.loadFromServer(data);

        // ── Shared state references ──────────────────────────────────────
        this.nodes = this.agentStore.getAll();
        this.calibrations = this.calibrationStore.getAllCalibrations();
        this.agentCalibrationData = this.calibrationStore._agentData;
        this.chartCache = this.calibrationStore.getChartCache();
        this.activeAgentId = null;
        this.tokenCallbacks = {};
        this.expSortDescending = this.experimentStore.sortDescending.experiments;
        this.calSortDescending = this.experimentStore.sortDescending.calibrations;

        // ── Instantiate modal components ─────────────────────────────────
        this.experimentModal = new ExperimentModal('ExperimentDetailsModal');
        this.calibDetailsModal = new CalibrationDetailsModal('CalibrationDetailsModal');
        this.calibFormModal = new CalibrationFormModal('CalibrationModal');
        this.pingModal = new PingModal('AgentPingModal', {
            tokenCallbacks: this.tokenCallbacks
        });
        this.spgModal = new SpgModal('spgModal');
        this.egpModal = new EgpModal('EGPModal');
        this.agentModal = new AgentModal('AgentDetailsModal', {
            calibrationStore: this.calibrationStore,
            agentCalibrationData: this.agentCalibrationData,
            chartCache: this.chartCache,
            getActiveAgentId: () => this.activeAgentId,
            setActiveAgentId: (id) => { this.activeAgentId = id; },
            nodes: this.nodes
        });

        // ── Instantiate table components ─────────────────────────────────
        this.debugPanel = new DebugPanel('debug-panel');
        this.experimentTable = new ExperimentTable('exp-table-body', {
            cardSelector: '#exp-card',
            onOpenModal: (exp) => this.experimentModal.open(exp)
        });
        this.calibrationTable = new CalibrationTable('calibration-table-body', {
            cardSelector: '#cal-card',
            onOpenModal: (calib) => this.calibDetailsModal.open(calib),
            onOpenChart: () => this.polChart.openModal(),
            calibrations: this.calibrations
        });
        this.topology = new TopologyGraph('topology-container', {
            onDoubleClick: (nodeId) => this.agentModal.openFromTopology(nodeId)
        });
        this.agentTable = new AgentTable('agent-table-body', {
            onOpenModal: (agentData) => this.agentModal.open(agentData),
            getTopoNodes: () => this.topology.getNodes()
        });

        // ── Instantiate chart components ─────────────────────────────────
        this.bsmChart = new BsmChart('bsm-chart');
        this.homChart = new HomChart('hom-chart');
        this.polChart = new PolTrackingChart('pol-chart', 'polChartModal');
        this.ttChart = new TimeTaggerChart({
            wavepacketUCB: 'wavepacketChartUCB',
            collectionUCB: 'collectionRateChartUCB',
            wavepacketLBL: 'wavepacketChartLBL',
            collectionLBL: 'collectionRateChartLBL',
            labelUCB: 'photon-count-label-ucb',
            labelLBL: 'photon-count-label-lbnl'
        });
        this.calibChart = new CalibrationChart({
            agentCalibrationData: this.agentCalibrationData,
            chartCache: this.chartCache,
            agentModal: this.agentModal
        });
        // Wire circular dependency
        this.agentModal._calibChart = this.calibChart;

        // ── MQTT Client ──────────────────────────────────────────────────
        this.mqttClient = new MqttClient(
            this.eventBus,
            data.ws_host,
            data.ws_port,
            {
                isKnownRequestType: (rtype) =>
                    this.experimentStore.isKnownRequestType(rtype)
            }
        );

        // ── Wire EventBus subscriptions ──────────────────────────────────
        this._wireEventBus();

        // ── DOM event listeners ──────────────────────────────────────────
        this._wireDomListeners();

        // ── Periodic tasks ───────────────────────────────────────────────
        setInterval(() => this.agentTable.incrementLastSeen(this.nodes), 1000);

        // ── Page load ────────────────────────────────────────────────────
        window.onload = () => this._onLoad();
    }

    /** @private */
    _onLoad() {
        this.topology.draw(this.experimentStore.getTopology());
        this.mqttClient.connect();
        this.agentTable.render(this.nodes);
        this.experimentTable.render(
            this.experimentStore.getExperiments(),
            this.expSortDescending
        );
        this.pingModal.populateNodeSelect(this.agentStore.nodeList());
        this.calibrationTable.render(
            this.calibrations,
            this.calSortDescending,
            this.experimentStore.getCalTypeMap()
        );
        this.calibFormModal.populateDropdowns(
            this.experimentStore.getCalTypeMap(),
            this.agentStore.nodeList()
        );
        this.spgModal.populateSources(this.agentStore.nodeList());
    }

    /** @private */
    _wireEventBus() {
        const eb = this.eventBus;

        // Agent heartbeat
        eb.on('mqtt:agent:heartbeat', ({ rid, raw }) => {
            if (!this.nodes[rid]) return;
            this.nodes[rid].lastSeen = 0;
            const icon = document.querySelector(`.status-icon[data-id="${rid}"]`);
            if (icon) {
                icon.classList.add('pulse');
                setTimeout(() => icon.classList.remove('pulse'), 500);
            }
            this.agentTable.updateLastSeenDisplay(this.nodes);
            this.debugPanel.addMessage(JSON.stringify(raw));
        });

        // Agent state change
        eb.on('mqtt:agent:state', ({ rid, value, raw }) => {
            if (!this.nodes[rid]) return;
            this.nodes[rid].iconColor = stateToIconColor(raw);
            this.nodes[rid].lastSeen = 0;
            this.nodes[rid].state = value;
            this.agentTable.updateStatusIcon(this.nodes, rid, stateToIconColor);
        });

        // Agent task scheduler phase
        eb.on('mqtt:agent:taskPhase', ({ rid, value, raw }) => {
            const agentId = rid;
            if (!this.agentCalibrationData[agentId]) {
                this.agentCalibrationData[agentId] =
                    CalibrationStore.newCalibrationData();
            }
            const agentData = this.agentCalibrationData[agentId];
            const taskMap = agentData.tasks;

            if (value.dag_traversal === 'inspect' &&
                value.task_name && value.state) {
                const taskName = value.task_name;
                const taskState = value.state;
                const isNewTask = !taskMap.has(taskName);
                if (agentId === this.activeAgentId) {
                    if (isNewTask) {
                        this.agentModal.appendCalibrationAccordionTask(
                            agentId, taskName, taskState
                        );
                        taskMap.set(taskName, taskState);
                        agentData.totalTasks += 1;
                    } else {
                        taskMap.set(taskName, taskState);
                        this.agentModal.updateCalibrationTaskState(
                            agentId, taskName, taskState
                        );
                    }
                }
            } else if (value.dag_traversal === 'change' && value.task_state) {
                const taskName = value.task_name;
                const taskState = value.state;
                taskMap.set(taskName, taskState);
                this.agentModal.updateCalibrationTaskState(
                    agentId, taskName, taskState
                );
            }

            if (rid === this.activeAgentId) {
                this.agentModal.updateCalibrationModal(agentId);
            }
        });

        // Agent task scheduler task
        eb.on('mqtt:agent:taskUpdate', ({ rid, value, raw }) => {
            const agentId = rid;
            if (!this.agentCalibrationData[agentId]) {
                this.agentCalibrationData[agentId] =
                    CalibrationStore.newCalibrationData();
            }
            this.agentCalibrationData[agentId].currentTask = value;
            if (rid === this.activeAgentId) {
                this.agentModal.updateCalibrationModal(agentId);
            }
            this.debugPanel.addMessage(JSON.stringify(raw));
        });

        // Agent task result
        eb.on('mqtt:agent:taskResult', ({ data }) => {
            this.calibChart.handleTaskResult(data);
        });

        // Experiment result
        eb.on('mqtt:experiment:result', ({ data }) => {
            this.calibChart.handleExperimentResult(data);
        });

        // Calibration response
        eb.on('mqtt:calibration:response', ({ data }) => {
            const calId = data.calibrations?.[0]?.id;
            if (calId) {
                this.apiClient.getCalibrations({ calId })
                    .then(calData => {
                        const calList = Array.isArray(calData)
                            ? calData : [calData];
                        calList.forEach(c => {
                            if (c && c.id) {
                                this.calibrationStore.setCalibration(c.id, c);
                            }
                        });
                        this.calibrationTable.render(
                            this.calibrations,
                            this.calSortDescending,
                            this.experimentStore.getCalTypeMap()
                        );
                    })
                    .catch(err => {
                        console.error(
                            'Error fetching calibration details for',
                            calId, ':', err.message
                        );
                        this.calibrationStore.setCalibration(
                            calId, data.calibrations[0]
                        );
                        this.calibrationTable.render(
                            this.calibrations,
                            this.calSortDescending,
                            this.experimentStore.getCalTypeMap()
                        );
                    });
            } else {
                console.warn(
                    'agentCalibrationResponse missing calibration ID', data
                );
            }
        });

        // Known request type
        eb.on('mqtt:request:update', ({ data }) => {
            const mqttErr = getApiError(data);
            if (mqttErr) {
                console.warn(`Experiment ${data.rtype} failed:`, data);
                showToast(`${data.rtype} failed:<br>${mqttErr}`, 'danger');
            }
            const rid = data.rid;
            const url = `api/experiments/${rid}?request=true`;
            fetch(url)
                .then(response => {
                    if (!response.ok) {
                        return response.json().then(body => {
                            throw new Error(
                                body.detail || body.error ||
                                `Status ${response.status}`
                            );
                        }).catch(parseErr => {
                            if (parseErr.message &&
                                !parseErr.message.startsWith('Status')) {
                                throw parseErr;
                            }
                            throw new Error(
                                `Request failed with status ${response.status}`
                            );
                        });
                    }
                    return response.json();
                })
                .then(experimentData => {
                    console.log('Experiment Data Received:', experimentData);
                    this.experimentStore.addExperiments(experimentData);
                    this.experimentTable.render(
                        this.experimentStore.getExperiments(),
                        this.expSortDescending
                    );
                })
                .catch(error =>
                    console.error(
                        'Error fetching experiment data:', error.message
                    )
                );
        });

        // Token-based callbacks
        eb.on('mqtt:token:callback', ({ token, data }) => {
            if (this.tokenCallbacks[token]) {
                this.tokenCallbacks[token](data);
            }
        });

        // Calibration topic
        eb.on('mqtt:calibration:topic', ({ data }) => {
            const calId = data.id;
            if (calId) {
                this.apiClient.getCalibrations({ calId })
                    .then(calData => {
                        const calList = Array.isArray(calData)
                            ? calData : [calData];
                        calList.forEach(c => {
                            if (c && c.id) {
                                this.calibrationStore.setCalibration(c.id, c);
                                this.calibrationTable.updateRow(c);
                            }
                        });
                    })
                    .catch(err => {
                        console.error(
                            'Error fetching calibration update for',
                            calId, ':', err.message
                        );
                        this.calibrationTable.updateRow(data);
                    });
            } else {
                this.calibrationTable.updateRow(data);
            }
        });

        // Experiment data — update all charts
        eb.on('mqtt:experiment:data', ({ data }) => {
            this.bsmChart.update(data);
            this.polChart.update(data);
            this.homChart.update(data);
            this.ttChart.update(data);
        });
    }

    /** @private */
    _wireDomListeners() {
        // Sort headers
        document.getElementById('exp-time-header')
            ?.addEventListener('click', () => {
                this.expSortDescending = !this.expSortDescending;
                document.getElementById('exp-time-header').textContent =
                    `Created Time ${this.expSortDescending ? '▼' : '▲'}`;
                this.experimentTable.render(
                    this.experimentStore.getExperiments(),
                    this.expSortDescending
                );
            });

        document.getElementById('cal-time-header')
            ?.addEventListener('click', () => {
                this.calSortDescending = !this.calSortDescending;
                document.getElementById('cal-time-header').textContent =
                    `Created Time ${this.calSortDescending ? '▼' : '▲'}`;
                this.calibrationTable.render(
                    this.calibrations,
                    this.calSortDescending,
                    this.experimentStore.getCalTypeMap()
                );
            });

        // Chart tab activation
        document.getElementById('bsm-tab')
            ?.addEventListener('shown.bs.tab', () => {
                this.bsmChart.initialize();
            });

        document.getElementById('hom-tab')
            ?.addEventListener('shown.bs.tab', () => {
                this.homChart.initialize();
            });

        document.getElementById('timetaggerucb-tab')
            ?.addEventListener('shown.bs.tab', () => {
                this.ttChart.initialize();
            });

        document.getElementById('timetaggerlbl-tab')
            ?.addEventListener('shown.bs.tab', () => {
                this.ttChart.initialize();
            });

        // BSM chart clear button
        document.getElementById('clearBsmChartBtn')
            ?.addEventListener('click', () => {
                if (this.bsmChart._chart) {
                    this.bsmChart._chart.data.labels = [];
                    this.bsmChart._chart.data.datasets.forEach(
                        ds => ds.data = []
                    );
                    this.bsmChart._chart.update();
                }
                const visElem = document.getElementById(
                    'bsm-visibility-value'
                );
                if (visElem) visElem.textContent = '';
            });

        // Agent modal cleanup on close
        document.getElementById('AgentDetailsModal')
            ?.addEventListener('hidden.bs.modal', () => {
                if (this.activeAgentId) {
                    this.calibrationStore.resetAgentData(this.activeAgentId);
                }
                const accordion = document.getElementById(
                    'calibrationAccordion'
                );
                if (accordion) accordion.innerHTML = '';

                const progressBar = document.getElementById('taskProgressBar');
                if (progressBar) {
                    progressBar.style.width = '0%';
                    progressBar.textContent = '0%';
                }

                const spinnerDiv = document.getElementById(
                    'calibrationSpinner'
                );
                if (spinnerDiv) {
                    spinnerDiv.innerHTML = `
                        <div id="calibration-loading-spinner"
                             class="text-center my-3">
                            <div class="spinner-border text-primary"
                                 role="status">
                                <span class="visually-hidden">Loading...</span>
                            </div>
                        </div>`;
                }

                this.activeAgentId = null;
                this.calibrationStore.setActiveAgentId(null);
            });

        // Calibration accordion collapse — populate chart
        document.getElementById('AgentDetailsModal')
            ?.addEventListener('shown.bs.collapse', (e) => {
                const panelId = e.target.id;
                const match = panelId.match(/^collapse-(.+)$/);
                if (!match) return;
                const taskId = match[1];
                this.calibChart.populate(this.activeAgentId, taskId);
            });
    }
}
