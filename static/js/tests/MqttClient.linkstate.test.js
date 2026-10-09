import { MqttClient } from '../core/MqttClient.js';
import { EventBus } from '../core/EventBus.js';

describe('MqttClient - linkStateUpdate routing', () => {
    it('should emit mqtt:link:stateUpdate when linkStateUpdate message arrives', () => {
        const eventBus = new EventBus();
        const mqtt = new MqttClient(eventBus, 'localhost', 8080);
        
        const mockMessage = {
            topic: 'monitor',
            payloadString: JSON.stringify({
                eventType: 'linkStateUpdate',
                value: {
                    src_cid: 'LBNL-Q',
                    dst_cid: 'LBNL-BSM',
                    channel_id: 'ch-out-1',
                    state: 'QUANTUM_UP'
                }
            })
        };
        
        let emitted = null;
        eventBus.on('mqtt:link:stateUpdate', (data) => {
            emitted = data;
        });
        
        mqtt._onMessage(mockMessage);
        
        expect(emitted).toBeTruthy();
        expect(emitted.src_cid).toBe('LBNL-Q');
        expect(emitted.state).toBe('QUANTUM_UP');
    });
});
