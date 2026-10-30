import { CalibrationStore } from '../../models/CalibrationStore.js';

/**
 * CalibrationChart — Handles real-time calibration task results and
 * populates per-task scatter charts inside the Agent Details modal.
 *
 * Replaces the global `handleAgentTaskResult()`, `handleExperimentResult()`,
 * and `populateCalibrationChart()` from qndata.js.
 *
 * @example
 *   const calibChart = new CalibrationChart({
 *       agentCalibrationData,
 *       chartCache,
 *       agentModal   // optional — for pager UI updates
 *   });
 *   calibChart.handleTaskResult(msg);
 *   calibChart.populate(agentId, taskId);
 */
export class CalibrationChart {
    /**
     * @param {Object} opts
     * @param {Object} opts.agentCalibrationData - Shared agent calibration data map
     * @param {Object} opts.chartCache           - Shared chart cache (canvasId → Chart)
     * @param {Object} [opts.agentModal]         - AgentModal instance for pager updates
     */
    constructor({ agentCalibrationData, chartCache, agentModal }) {
        this._agentCalibrationData = agentCalibrationData;
        this._chartCache = chartCache;
        this._agentModal = agentModal || null;
    }

    /**
     * Handle an incoming agent task result message.
     * Stores the result, updates history for paging, and refreshes the chart.
     * @param {Object} msg - { rid, value: { name, result, created_at? } }
     */
    handleTaskResult(msg) {
        const { rid, value } = msg;

        if (!this._agentCalibrationData[rid]) {
            this._agentCalibrationData[rid] = CalibrationStore.newCalibrationData();
        }
        const agentData = this._agentCalibrationData[rid];
        const taskId = `${rid}-${value.name.replace(/\s+/g, '')}`;

        // Save most recent result (used by chart rendering)
        agentData.results.set(taskId, value.result);

        // Prepend to resultHistory for pager support (newest first)
        if (!agentData.resultHistory.has(taskId)) {
            agentData.resultHistory.set(taskId, []);
        }
        const history = agentData.resultHistory.get(taskId);
        const latestResult = history.length > 0 ? history[0].result : null;
        if (latestResult !== value.result) {
            history.unshift({
                result: value.result,
                created_at: value.created_at || (Date.now() / 1000)
            });
            if (history.length > 50) {
                history.length = 50;
            }
            agentData.resultIndex.set(taskId, 0);
            if (this._agentModal) {
                this._agentModal._updatePagerUI(rid, taskId);
            }
        }

        const chart = this._chartCache[`chart-${taskId}`];
        if (!chart) return;

        this.populate(rid, taskId);
    }

    /**
     * Handle an incoming experiment result message (currently a no-op log).
     * @param {Object} msg
     */
    handleExperimentResult(msg) {
        console.log('Experiment result received:', msg);
    }

    /**
     * Populate a calibration scatter chart with stored result data.
     * @param {string} agentId - Agent identifier
     * @param {string} taskId  - Task identifier (agentId-taskName)
     */
    populate(agentId, taskId) {
        const chart = this._chartCache[`chart-${taskId}`];
        if (!chart) return;

        const taskMap = this._agentCalibrationData[agentId]?.results;
        if (!taskMap) return;
        const results = taskMap.get(taskId);
        if (!results) return;

        chart.data.labels = results['current_scan.plots.x'] || [];
        chart.data.datasets[0].data =
            (results['current_scan.plots.y'] || []).map(arr => arr[0]);
        chart.update();
    }
}
