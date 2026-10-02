import { showToast, getApiError } from '../../utils/formatters.js';

/**
 * SpgModal — Encapsulates the SPG/BSM experiment modal form.
 *
 * Replaces the global functions `openSpgModal()`, `handleSpgSubmit()`,
 * `submitSPG()`, `addSpgSourceDropdown()`, `resetSpgSourceForm()`,
 * `populateSpgSources()`, and the `spgModalMode` global from qn.js.
 *
 * Usage:
 *   const spgModal = new SpgModal('spgModal');
 *   spgModal.populateSources(nodeList);
 *   spgModal.open('spg');
 */
export class SpgModal {
    /**
     * @param {string} modalId - ID of the modal element
     */
    constructor(modalId) {
        this._modalId = modalId;
        this._mode = null; // 'spg' or 'bsm'
    }

    /**
     * Populate the initial SPG source dropdown with node options.
     * @param {Array} nodes - Array of node objects with systemSettings.ID
     */
    populateSources(nodes) {
        const select = document.querySelector('.spg-source');
        if (!select) return;
        select.innerHTML = '';
        nodes.forEach(node => {
            const opt = document.createElement('option');
            opt.value = node.systemSettings.ID;
            opt.textContent = node.systemSettings.ID;
            select.appendChild(opt);
        });
    }

    /**
     * Open the SPG/BSM modal in the given mode.
     * @param {'spg'|'bsm'} mode - Which experiment type to configure
     */
    open(mode) {
        this._mode = mode;
        const modal = new bootstrap.Modal(document.getElementById(this._modalId));
        this._resetForm();
        modal.show();

        // Update modal title
        const label = document.getElementById('spgModalLabel');
        if (label) {
            label.textContent = {
                spg: 'Single Photon Generation',
                bsm: 'BSM Experiment'
            }[mode] || 'Request Form';
        }

        // Set default source
        const select = document.querySelector('.spg-source');
        if (select) {
            select.value = { spg: 'UCB-Q', bsm: 'LBNL-BSM' }[mode];
        }

        // Update rate label
        const flabel = document.getElementById('spg-rate-label');
        if (flabel) {
            flabel.textContent = {
                spg: 'Rate (Hz)',
                bsm: 'Coincidence Rate (Hz)'
            }[mode];
        }

        // Add default second source
        if (mode === 'spg') this.addSourceDropdown('LBNL-Q');
        else if (mode === 'bsm') this.addSourceDropdown('UCB-BSM');
    }

    /**
     * Handle form submission — delegates to submit with current mode.
     */
    handleSubmit() {
        this._submit(this._mode);
    }

    /**
     * Add an additional source dropdown to the form.
     * @param {string} [defaultValue] - Optional default value for the new dropdown
     */
    addSourceDropdown(defaultValue) {
        const container = document.getElementById('spgSourceContainer');
        const firstDropdown = container.querySelector('select');
        if (!firstDropdown) return;

        const clone = firstDropdown.cloneNode(true);
        clone.value = '';

        const wrapper = document.createElement('div');
        wrapper.classList.add('input-group', 'mb-2', 'spg-source-group');

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-outline-danger';
        removeBtn.innerHTML = '&times;';
        removeBtn.onclick = () => wrapper.remove();

        const btnWrapper = document.createElement('div');
        btnWrapper.classList.add('input-group-append');
        btnWrapper.appendChild(removeBtn);

        wrapper.appendChild(clone);
        wrapper.appendChild(btnWrapper);
        container.appendChild(wrapper);

        if (defaultValue) clone.value = defaultValue;
    }

    /** @private */
    _resetForm() {
        const container = document.getElementById('spgSourceContainer');
        if (!container) return;

        const sourceGroups = container.querySelectorAll('.spg-source-group');
        sourceGroups.forEach((group, index) => {
            if (index === 0) {
                const select = group.querySelector('select');
                if (select) select.selectedIndex = 0;
            } else {
                group.remove();
            }
        });
    }

    /** @private */
    _submit(endpoint) {
        const form = document.getElementById('spgForm');
        const rate = form.rate.value;
        const duration = form.duration.value;

        const srcNodes = [...form.querySelectorAll('.spg-source')]
            .map(select => select.value)
            .filter(Boolean);

        if (srcNodes.length === 0) {
            alert('Please select at least one source agent.');
            return;
        }

        const queryParams = new URLSearchParams();
        srcNodes.forEach(src => queryParams.append('src', src));
        queryParams.append('rate', rate);
        queryParams.append('duration', duration);
        queryParams.append('owner', window.app.username);

        const url = `api/${endpoint}?${queryParams.toString()}`;
        console.log(url);

        fetch(url, { method: 'POST' })
            .then(resp => {
                if (!resp.ok) {
                    return resp.json().then(body => {
                        throw new Error(body.detail || body.error || `Request failed (${resp.status})`);
                    }).catch(parseErr => {
                        if (parseErr.message && parseErr.message !== 'Request failed') throw parseErr;
                        throw new Error(`Request failed with status ${resp.status}`);
                    });
                }
                return resp.json();
            })
            .then(data => {
                console.log('Single Photon Generation Response:', data);
                const apiErr = getApiError(data);
                if (apiErr) {
                    showToast(`${endpoint.toUpperCase()} experiment failed: ${apiErr}`, 'danger');
                    return;
                }
                bootstrap.Modal.getInstance(document.getElementById(this._modalId)).hide();
                showToast(`${endpoint.toUpperCase()} experiment submitted successfully`, 'success');
            })
            .catch(err => {
                console.error('SPG Request Error:', err);
                showToast(`${endpoint.toUpperCase()} request failed: ` + err.message, 'danger');
            });
    }
}
