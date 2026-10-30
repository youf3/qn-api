/**
 * DebugPanel — Encapsulates the debug message log with scrollback limit.
 *
 * Replaces the global `addDebugMessage()`, `debugMessages[]`, and
 * `maxDebugMessages` from qn.js.
 *
 * Usage:
 *   const debugPanel = new DebugPanel('debug-panel', { maxMessages: 1000 });
 *   debugPanel.addMessage('Hello world');
 */
export class DebugPanel {
    /**
     * @param {string} panelId - ID of the <textarea> element
     * @param {Object} [options]
     * @param {number} [options.maxMessages=200] - Maximum lines to retain
     * @param {number} [options.maxMessageLength=1500] - Maximum characters per line
     */
    constructor(panelId, options = {}) {
        this._panelId = panelId;
        this._maxMessages = options.maxMessages || 200;
        this._maxMessageLength = options.maxMessageLength || 1500;
        this._messages = [];
        this._flushPending = false;
    }

    /**
     * Append a message to the debug panel with scrollback limit.
     * @param {string} message
     */
    addMessage(message) {
        const panel = document.getElementById(this._panelId);
        if (!panel) return;

        const str = typeof message === 'string' ? message : String(message);
        const trimmed = str.length > this._maxMessageLength
            ? `${str.slice(0, this._maxMessageLength)}...`
            : str;

        this._messages.push(trimmed);

        // Trim messages if exceeding limit
        if (this._messages.length > this._maxMessages) {
            this._messages.splice(0, this._messages.length - this._maxMessages);
        }

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            if (!this._flushPending) {
                this._flushPending = true;
                window.requestAnimationFrame(() => {
                    this._flushPending = false;
                    this.flush();
                });
            }
        } else {
            this.flush();
        }
    }

    /**
     * Flush buffered debug messages into the textarea DOM element.
     */
    flush() {
        const panel = document.getElementById(this._panelId);
        if (!panel) return;

        // Check if the user was near the bottom before updating value
        const shouldScroll = !panel.clientHeight ||
            (panel.scrollHeight - panel.scrollTop < 2 * panel.clientHeight);

        panel.value = this._messages.join('\n');

        if (shouldScroll) {
            panel.scrollTop = panel.scrollHeight;
        }
    }
}
