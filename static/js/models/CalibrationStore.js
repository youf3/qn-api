/**
 * CalibrationStore — centralised state for calibration data.
 *
 * Encapsulates the old globals:
 *   - `calibrations`          (link-level calibration records)
 *   - `agentCalibrationData`  (per-agent task state, results, history, pager)
 *   - `chartCache`            (Chart.js instance cache for calibration charts)
 *   - `activeAgentId`         (currently open agent modal)
 *
 * Usage:
 *   const calibrationStore = new CalibrationStore(eventBus);
 *   calibrationStore.loadCalibrations(obj.calibrations);
 *   calibrationStore.getCalibration('abc-123');
 */
export class CalibrationStore {
    /**
     * @param {EventBus} eventBus
     */
    constructor(eventBus) {
        /** @type {EventBus} */
        this.eventBus = eventBus;

        /**
         * Link-level calibration records keyed by calibration ID.
         * @type {Object<string, Object>}
         */
        this._calibrations = {};

        /**
         * Per-agent calibration task data.
         * Keyed by agent ID → { tasks: Map, results: Map, resultHistory: Map,
         *                        resultIndex: Map, currentTask: string, totalTasks: number }
         * @type {Object<string, Object>}
         */
        this._agentData = {};

        /**
         * Chart.js instance cache for calibration scatter plots.
         * Keyed by canvas element ID.
         * @type {Object<string, Chart>}
         */
        this._chartCache = {};

        /**
         * Currently open agent modal ID (null when no modal is open).
         * @type {string|null}
         */
        this._activeAgentId = null;
    }

    /* ------------------------------------------------------------------ */
    /*  Link Calibrations                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Populate from initial server payload (obj.calibrations).
     * @param {Array} calibrationList
     */
    loadCalibrations(calibrationList) {
        calibrationList.forEach(c => {
            this._calibrations[c.id] = c;
        });
    }

    /**
     * Get a single calibration by ID.
     * @param {string} id
     * @returns {Object|undefined}
     */
    getCalibration(id) {
        return this._calibrations[id];
    }

    /**
     * Get all calibrations as a dictionary (for legacy compat).
     * @returns {Object<string, Object>}
     */
    getAllCalibrations() {
        return this._calibrations;
    }

    /**
     * Add or update a calibration record.
     * @param {string} id
     * @param {Object} cal
     */
    setCalibration(id, cal) {
        this._calibrations[id] = cal;
        this.eventBus.emit('calibration:updated', { id, calibration: cal });
    }

    /* ------------------------------------------------------------------ */
    /*  Active Agent (modal state)                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Get the currently active agent ID.
     * @returns {string|null}
     */
    getActiveAgentId() {
        return this._activeAgentId;
    }

    /**
     * Set the active agent ID (when modal opens).
     * @param {string|null} agentId
     */
    setActiveAgentId(agentId) {
        this._activeAgentId = agentId;
    }

    /* ------------------------------------------------------------------ */
    /*  Per-Agent Calibration Data                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Create a fresh calibration data structure for an agent.
     * Mirrors the old `newCalibrationData()` function.
     * @returns {Object}
     */
    static newCalibrationData() {
        return {
            tasks: new Map(),
            results: new Map(),
            resultHistory: new Map(),
            resultIndex: new Map(),
            currentTask: '',
            totalTasks: 0
        };
    }

    /**
     * Get or create calibration data for an agent.
     * @param {string} agentId
     * @returns {Object}
     */
    getAgentData(agentId) {
        if (!this._agentData[agentId]) {
            this._agentData[agentId] = CalibrationStore.newCalibrationData();
        }
        return this._agentData[agentId];
    }

    /**
     * Check if agent data exists (without creating it).
     * @param {string} agentId
     * @returns {boolean}
     */
    hasAgentData(agentId) {
        return agentId in this._agentData;
    }

    /**
     * Reset agent calibration data (when modal closes).
     * @param {string} agentId
     */
    resetAgentData(agentId) {
        if (this._agentData[agentId]) {
            this._agentData[agentId].tasks = new Map();
            this._agentData[agentId].resultHistory = new Map();
            this._agentData[agentId].resultIndex = new Map();
            this._agentData[agentId].totalTasks = 0;
        }
        const prefix = `chart-${agentId}-`;
        Object.keys(this._chartCache).forEach(key => {
            if (key.startsWith(prefix)) {
                const chart = this._chartCache[key];
                if (chart && typeof chart.destroy === 'function') {
                    chart.destroy();
                }
                delete this._chartCache[key];
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Chart Cache                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Get a cached Chart.js instance by canvas ID.
     * @param {string} canvasId
     * @returns {Chart|undefined}
     */
    getChart(canvasId) {
        return this._chartCache[canvasId];
    }

    /**
     * Store a Chart.js instance in the cache.
     * @param {string} canvasId
     * @param {Chart} chart
     */
    setChart(canvasId, chart) {
        this._chartCache[canvasId] = chart;
    }

    /**
     * Get the full chart cache (for legacy compat).
     * @returns {Object<string, Chart>}
     */
    getChartCache() {
        return this._chartCache;
    }
}
