import { showToast, getApiError } from '../../utils/formatters.js';

/**
 * EgpModal — Encapsulates the Entanglement Generation Protocol modal form.
 *
 * Replaces the global `submitEGP()` from qn.js.
 *
 * Usage:
 *   const egpModal = new EgpModal('EGPModal');
 *   egpModal.submit();
 */
export class EgpModal {
    /**
     * @param {string} modalId - ID of the modal element
     */
    constructor(modalId) {
        this._modalId = modalId;
    }

    /**
     * Submit the EGP form.
     */
    submit() {
        const src = document.getElementById('egpSource').value;
        const dst = document.getElementById('egpDestination').value;
        const pairs = document.getElementById('pairs').value;
        const bellState = document.getElementById('bellState').value;
        const fidelity = document.getElementById('fidelity').value;

        const params = new URLSearchParams({ src, dst, pairs, bellState, fidelity, owner: window.app.username });

        fetch(`api/egp?${params.toString()}`, { method: 'POST' })
            .then(response => {
                if (!response.ok) {
                    return response.json().then(body => {
                        throw new Error(body.detail || body.error || `Request failed (${response.status})`);
                    }).catch(parseErr => {
                        if (parseErr.message && parseErr.message !== 'Request failed') throw parseErr;
                        throw new Error(`Request failed with status ${response.status}`);
                    });
                }
                return response.json();
            })
            .then(data => {
                console.log('EGP Request Submitted:', data);
                const apiErr = getApiError(data);
                if (apiErr) {
                    showToast(`Entanglement generation failed: ${apiErr}`, 'danger');
                    return;
                }
                bootstrap.Modal.getInstance(document.getElementById(this._modalId)).hide();
                showToast('Entanglement generation submitted successfully', 'success');
            })
            .catch(error => {
                console.error('EGP Submission Failed:', error);
                showToast('Entanglement generation failed: ' + error.message, 'danger');
            });
    }
}
