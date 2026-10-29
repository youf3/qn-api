/**
 * MqttClient — Encapsulates Paho MQTT connection, message parsing,
 * and event routing via EventBus.
 *
 * Replaces the inline `connectMQTT()` function from main.html.
 * All parsed messages are emitted as EventBus events so that
 * subscribers (UI components, stores) can react without coupling
 * to the MQTT layer directly.
 *
 * Usage:
 *   const mqtt = new MqttClient(eventBus, 'broker.example.com', 9001);
 *   mqtt.connect();
 *
 * Events emitted:
 *   mqtt:agent:heartbeat     — { rid, raw }
 *   mqtt:agent:state         — { rid, value, raw }
 *   mqtt:link:stateUpdate    — { src_cid, dst_cid, channel_id, state, raw }
 *   mqtt:agent:taskPhase     — { rid, value, raw }
 *   mqtt:agent:taskUpdate    — { rid, value, raw }
 *   mqtt:agent:taskResult    — { data }
 *   mqtt:experiment:result   — { data }
 *   mqtt:calibration:response — { data }
 *   mqtt:request:update      — { data }
 *   mqtt:token:callback      — { token, data }
 *   mqtt:calibration:topic   — { data }
 *   mqtt:experiment:data     — { data }
 *   mqtt:connected           — {}
 *   mqtt:disconnected        — { errorMessage }
 */
export class MqttClient {
    /**
     * @param {EventBus} eventBus - Shared event bus instance
     * @param {string} broker - MQTT broker hostname
     * @param {number} port - MQTT WebSocket port
     * @param {Object} [options]
     * @param {string} [options.topic='#'] - Topic to subscribe to
     * @param {number} [options.reconnectDelay=3000] - Reconnect delay in ms
     * @param {Function} [options.isKnownRequestType] - Predicate to check if rtype is a known request type
     */
    constructor(eventBus, broker, port, options = {}) {
        this._eventBus = eventBus;
        if (!broker || broker === '127.0.0.1' || broker === '0.0.0.0' || broker === 'localhost') {
            this._broker = (typeof window !== 'undefined' && window.location && window.location.hostname)
                ? window.location.hostname
                : (broker || '127.0.0.1');
        } else {
            this._broker = broker;
        }
        this._port = Number(port) || 8080;
        this._topic = options.topic || '#';
        this._reconnectDelay = options.reconnectDelay || 3000;
        this._isKnownRequestType = options.isKnownRequestType || (() => false);
        this._client = null;
    }

    /**
     * Establish the MQTT connection and begin listening.
     */
    connect() {
        const clientID = 'client-' + Math.random().toString(16).substr(2, 8);
        this._client = new Paho.Client(this._broker, this._port, clientID);

        this._client.onMessageArrived = (msg) => this._onMessage(msg);
        this._client.onConnectionLost = (resp) => this._onConnectionLost(resp);

        this._client.connect({
            onSuccess: () => {
                console.log('Connected to MQTT broker at', this._broker, ':', this._port);
                this._client.subscribe(this._topic);
                this._eventBus.emit('mqtt:connected', {});
            },
            onFailure: (error) => {
                console.error('MQTT connection failed:', error.errorMessage);
            }
        });
    }

    /**
     * Disconnect from the broker.
     */
    disconnect() {
        if (this._client) {
            try {
                this._client.disconnect();
            } catch (e) {
                // already disconnected
            }
        }
    }

    // ── Private ──────────────────────────────────────────────────────────

    /**
     * Handle an incoming MQTT message: parse JSON, then route via EventBus.
     * @param {Paho.Message} msg
     */
    _onMessage(msg) {
        let data = {};
        try {
            data = JSON.parse(msg.payloadString);
        } catch (error) {
            console.error('Error parsing JSON:', error.message, msg.payloadString);
            return;
        }

        const topic = msg.topic;

        // ── Route by eventType ───────────────────────────────────────────
        if (data.eventType === 'agentHeartbeat') {
            this._eventBus.emit('mqtt:agent:heartbeat', { rid: data.rid, raw: data });
        }
        else if (data.eventType === 'agentState') {
            this._eventBus.emit('mqtt:agent:state', { rid: data.rid, value: data.value, raw: data });
        }
        else if (data.eventType === 'linkStateUpdate') {
            const val = data.value || {};
            this._eventBus.emit('mqtt:link:stateUpdate', {
                src_cid: val.src_cid,
                dst_cid: val.dst_cid,
                channel_id: val.channel_id,
                state: val.state,
                value: val,
                raw: data
            });
        }
        else if (data.eventType === 'agentTaskSchedulerPhase') {
            this._eventBus.emit('mqtt:agent:taskPhase', { rid: data.rid, value: data.value, raw: data });
        }
        else if (data.eventType === 'agentTaskSchedulerTask') {
            this._eventBus.emit('mqtt:agent:taskUpdate', { rid: data.rid, value: data.value, raw: data });
        }
        else if (data.eventType === 'agentTaskResult') {
            this._eventBus.emit('mqtt:agent:taskResult', { data });
        }
        else if (data.eventType === 'experimentResult') {
            this._eventBus.emit('mqtt:experiment:result', { data });
        }

        // ── agentCalibrationResponse (message field) ─────────────────────
        if (data.message && data.message.toLowerCase() === 'agentcalibrationresponse') {
            this._eventBus.emit('mqtt:calibration:response', { data });
        }

        // ── Known request types (experiment updates) ─────────────────────
        if (this._isKnownRequestType(data.rtype)) {
            this._eventBus.emit('mqtt:request:update', { data });
        }

        // ── Token-based callbacks (e.g. ping responses) ──────────────────
        this._eventBus.emit('mqtt:token:callback', { token: topic, data });

        // ── calibration-* topic ──────────────────────────────────────────
        if (topic.startsWith('calibration-')) {
            this._eventBus.emit('mqtt:calibration:topic', { data });
        }

        // ── experiment_data topic (chart data) ───────────────────────────
        if (topic === 'experiment_data') {
            this._eventBus.emit('mqtt:experiment:data', { data });
        }
    }

    /**
     * Handle connection loss — log and schedule reconnect.
     * @param {Object} responseObject
     */
    _onConnectionLost(responseObject) {
        console.error('Connection lost:', responseObject.errorMessage);
        this._eventBus.emit('mqtt:disconnected', { errorMessage: responseObject.errorMessage });
        setTimeout(() => this.connect(), this._reconnectDelay);
    }
}
