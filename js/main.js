/**
 * Application controller for the Fentanyl Ce Simulator.
 *
 * Three steps, mirroring the layout of the companion Propofol TCI app:
 *   1. real-time Ce prediction with the analgesia readout
 *   2. analgesia assessment and target-Ce design
 *   3. dose-record simulation over the whole anaesthetic
 */

const APP_VERSION = 'V1.0.0';

class MainController {
    constructor() {
        this.patient = null;
        this.engine = new RealtimeEngine();
        this.doseEvents = [];
        this.observations = [];         // AnalgesiaObservation[]
        this.simulationResult = null;   // {modelId: run}
        this.individualCurveChart = null;

        this.modelMode = FENTANYL_DEFAULT_MODEL;  // a model id, or 'all'
        this.currentStep = 0;
        this.totalSteps = 3;

        this.realtimeChart = null;
        this.curveChart = null;
        this.recordChart = null;

        this.showCp = true;
        this.chartRedrawAt = 0;
        this.holdState = null;
        this.touchStartX = 0;
        this.touchDeltaX = 0;
        this.isSwiping = false;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initialize());
        } else {
            this.initialize();
        }
    }

    initialize() {
        setTimeout(() => {
            document.getElementById('loadingScreen').classList.add('hidden');
        }, 900);

        this.initializeDefaultPatient();
        this.setupEventListeners();
        this.setupWizard();
        this.setupStepperControls();

        this.engine.addUpdateCallback((state) => this.onRealtimeUpdate(state));
        this.engine.setPatient(this.patient);

        this.initializeRealtimeChart();
        this.initializeCurveChart();

        this.updatePatientDisplay();
        this.updateModelNote();
        this.renderBandReference();
        this.renderConcentrationCards(this.engine.getState());
        this.updateAnalgesiaPanel('rt', 0);
        this.renderCeScale('rt', { primary: 0, others: [] });
        this.updateAnalgesiaEvaluation();
        this.setShowCp(true);
    }

    // =============================================
    // Patient
    // =============================================
    initializeDefaultPatient() {
        const start = new Date();
        start.setHours(9, 0, 0, 0);
        this.patient = new Patient(
            `Patient-${new Date().toISOString().split('T')[0]}`,
            45, 60.0, 165.0, SexType.MALE, AsapsType.CLASS_1_2, start
        );
    }

    updatePatientDisplay() {
        document.getElementById('headerPatientSummary').textContent =
            `${this.patient.age} y ${this.patient.weight} kg`;
        this.updateWeightWarning();
    }

    /**
     * The Shafer model carries no weight covariate and its original validation
     * covered roughly 40-90 kg, so an out-of-range weight is worth flagging.
     */
    updateWeightWarning() {
        const banner = document.getElementById('shaferWeightWarning');
        const w = this.patient.weight;
        const messages = [];

        for (const id of this.activeModelIds()) {
            const model = FentanylModels[id];
            const range = model.validWeightRange;
            if (range && (w < range[0] || w > range[1])) {
                messages.push(
                    `A weight of ${w} kg is outside the range studied for the ${model.shortLabel} model (${range[0]}-${range[1]} kg).`
                );
            }
        }

        // Neither Scott & Stanski nor Shafer has a weight covariate, so at the
        // extremes of body habitus the fixed-parameter models drift; Shibutani
        // 2004 quantified this for the Shafer model in obesity.
        const fixedShown = this.activeModelIds().some(id => !FentanylModels[id].weightScaled);
        if (fixedShown && (w < 40 || w > 90)) {
            messages.push(
                'You are viewing a fixed-parameter model with no body-weight covariate. ' +
                'Shibutani et al (PMID 15329584) report that the Shafer model overestimates concentration increasingly as weight rises, ' +
                'so at this weight compare it against the Bae model, which does carry a weight covariate.'
            );
        }

        if (messages.length) {
            banner.textContent = messages.join(' ');
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }

    // =============================================
    // Wizard
    // =============================================
    setupWizard() {
        document.querySelectorAll('.step-tab').forEach(tab => {
            tab.addEventListener('click', () => this.goToStep(parseInt(tab.dataset.step, 10)));
        });
        document.querySelectorAll('[data-goto]').forEach(btn => {
            btn.addEventListener('click', () => this.goToStep(parseInt(btn.dataset.goto, 10)));
        });

        const viewport = document.querySelector('.wizard-viewport');
        viewport.addEventListener('touchstart', (e) => {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'CANVAS' || tag === 'SELECT') return;
            this.touchStartX = e.touches[0].clientX;
            this.isSwiping = false;
        }, { passive: true });

        viewport.addEventListener('touchmove', (e) => {
            if (this.touchStartX === 0) return;
            this.touchDeltaX = e.touches[0].clientX - this.touchStartX;
            if (Math.abs(this.touchDeltaX) > 20) this.isSwiping = true;
        }, { passive: true });

        viewport.addEventListener('touchend', () => {
            if (this.isSwiping && Math.abs(this.touchDeltaX) > 60) {
                if (this.touchDeltaX < 0) this.goToStep(this.currentStep + 1);
                else this.goToStep(this.currentStep - 1);
            }
            this.touchStartX = 0;
            this.touchDeltaX = 0;
            this.isSwiping = false;
        });

        this.goToStep(0);
    }

    goToStep(step) {
        if (step < 0 || step >= this.totalSteps) return;
        this.currentStep = step;

        document.getElementById('wizardTrack').style.transform =
            `translateX(${-(step * 100 / this.totalSteps)}%)`;

        document.querySelectorAll('.step-tab').forEach((tab, i) => {
            tab.classList.toggle('active', i === step);
        });

        if (step === 1) this.onEnterAnalgesiaStep();
        if (step === 2) this.onEnterRecordStep();
    }

    // =============================================
    // Event listeners
    // =============================================
    setupEventListeners() {
        const disclaimerBtn = document.getElementById('acceptDisclaimer');
        disclaimerBtn.addEventListener('click', () => this.hideDisclaimer());

        document.getElementById('editPatientBtn').addEventListener('click', () => this.showPatientModal());
        document.getElementById('closePatientModal').addEventListener('click', () => this.hidePatientModal());
        document.getElementById('cancelPatientEdit').addEventListener('click', () => this.hidePatientModal());
        document.getElementById('patientForm').addEventListener('submit', (e) => this.savePatientData(e));

        document.getElementById('modelToggle').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-model]');
            if (btn) this.setModelMode(btn.dataset.model);
        });

        document.getElementById('speedToggle').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-speed]');
            if (btn) this.setSpeed(parseInt(btn.dataset.speed, 10));
        });

        document.getElementById('traceToggle').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-trace]');
            if (btn) this.setShowCp(btn.dataset.trace === 'both');
        });

        document.getElementById('startRealtimeBtn').addEventListener('click', () => this.startRealtime());
        document.getElementById('stopRealtimeBtn').addEventListener('click', () => this.stopRealtime());
        document.getElementById('addBolusBtn').addEventListener('click', () => this.addRealtimeBolus());
        document.getElementById('recordSnapshotBtn').addEventListener('click', () => this.recordSnapshot());

        document.getElementById('rtContinuous').addEventListener('change', () => {
            this.engine.setContinuousRate(this.readNumber('rtContinuous', 0));
        });

        document.getElementById('evalCe').addEventListener('change', () => this.updateAnalgesiaEvaluation());
        document.getElementById('evalCe').addEventListener('input', () => this.updateAnalgesiaEvaluation());

        document.getElementById('addDoseBtn').addEventListener('click', () => this.showDoseModal());
        document.getElementById('runSimulationBtn').addEventListener('click', () => this.runRecordSimulation());
        document.getElementById('exportCsvBtn').addEventListener('click', () => this.exportCsv());
        document.getElementById('saveSessionBtn').addEventListener('click', () => this.saveSession());
        document.getElementById('loadSessionBtn').addEventListener('click', () =>
            document.getElementById('loadSessionInput').click());
        document.getElementById('loadSessionInput').addEventListener('change', (e) => this.handleSessionFile(e));

        document.getElementById('closeDoseModal').addEventListener('click', () => this.hideDoseModal());
        document.getElementById('cancelDoseAdd').addEventListener('click', () => this.hideDoseModal());
        document.getElementById('doseTimeNowBtn').addEventListener('click', () => this.setDoseTimeToNow());
        document.getElementById('doseForm').addEventListener('submit', (e) => this.addDoseEvent(e));

        document.getElementById('addObservationBtn').addEventListener('click', () => this.showObservationModal());
        document.getElementById('closeObservationModal').addEventListener('click', () => this.hideObservationModal());
        document.getElementById('cancelObservationAdd').addEventListener('click', () => this.hideObservationModal());
        document.getElementById('observationTimeNowBtn').addEventListener('click', () => {
            const now = new Date();
            document.getElementById('observationTime').value =
                `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        });
        document.getElementById('observationForm').addEventListener('submit', (e) => this.addObservation(e));

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.remove('active');
            });
        });
    }

    readNumber(id, fallback) {
        const value = parseFloat(document.getElementById(id).value);
        return isFinite(value) ? value : fallback;
    }

    // =============================================
    // Stepper controls
    // =============================================
    setupStepperControls() {
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.stepper-btn');
            if (btn) this.handleStepperButton(btn);
        });

        document.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('.stepper-btn');
            if (btn) {
                e.preventDefault();
                this.startHold(btn);
            }
        });

        ['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => {
            document.addEventListener(evt, () => this.stopHold());
        });
        window.addEventListener('blur', () => this.stopHold());
    }

    handleStepperButton(button) {
        const targetId = button.getAttribute('data-target');
        const stepStr = button.getAttribute('data-step');
        const step = parseFloat(stepStr);
        const input = document.getElementById(targetId);
        if (!input) return;

        const isIncrement = button.classList.contains('stepper-plus');
        const current = parseFloat(input.value) || 0;
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);

        let next = isIncrement ? current + step : current - step;
        next = Math.round(next * 1000) / 1000;
        if (!isNaN(min)) next = Math.max(min, next);
        if (!isNaN(max)) next = Math.min(max, next);

        const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
        input.value = next.toFixed(decimals);
        input.dispatchEvent(new Event('change'));

        this.onStepperValueChanged(targetId, next);
    }

    onStepperValueChanged(targetId, value) {
        if (targetId === 'rtContinuous') {
            this.engine.setContinuousRate(value);
        }
        if (targetId === 'editWeight' || targetId === 'editHeight') {
            this.updateBMICalculation();
        }
        if (targetId === 'evalCe') {
            this.updateAnalgesiaEvaluation();
        }
    }

    startHold(button) {
        this.stopHold();
        this.holdState = { button, timeout: null, interval: null, currentInterval: 200 };
        button.classList.add('holding');
        this.holdState.timeout = setTimeout(() => this.startHoldInterval(button), 500);
    }

    startHoldInterval(button) {
        if (!this.holdState) return;
        this.holdState.interval = setInterval(() => {
            this.handleStepperButton(button);
            this.holdState.currentInterval = Math.max(50, this.holdState.currentInterval * 0.9);
            clearInterval(this.holdState.interval);
            this.startHoldInterval(button);
        }, this.holdState.currentInterval);
    }

    stopHold() {
        if (!this.holdState) return;
        clearTimeout(this.holdState.timeout);
        clearInterval(this.holdState.interval);
        if (this.holdState.button) this.holdState.button.classList.remove('holding');
        this.holdState = null;
    }

    // =============================================
    // Modals
    // =============================================
    hideDisclaimer() {
        document.getElementById('disclaimerModal').classList.remove('active');
        document.getElementById('mainApp').classList.remove('hidden');
        this.resizeCharts();
    }

    showPatientModal() {
        const p = this.patient;
        document.getElementById('editPatientId').value = p.id;
        document.getElementById('editAge').value = p.age;
        document.getElementById('editWeight').value = p.weight;
        document.getElementById('editHeight').value = p.height;
        document.querySelector(`input[name="sex"][value="${p.sex === SexType.MALE ? 'male' : 'female'}"]`).checked = true;
        document.querySelector(`input[name="asa"][value="${p.asaPS === AsapsType.CLASS_1_2 ? '1-2' : '3-4'}"]`).checked = true;
        document.getElementById('editAnesthesiaStart').value = p.formattedStartTime;
        this.updateBMICalculation();
        document.getElementById('patientModal').classList.add('active');
    }

    hidePatientModal() {
        document.getElementById('patientModal').classList.remove('active');
    }

    updateBMICalculation() {
        const weight = this.readNumber('editWeight', 0);
        const height = this.readNumber('editHeight', 0);
        const bmi = height > 0 ? weight / Math.pow(height / 100, 2) : NaN;
        document.getElementById('bmiCalculated').textContent = isFinite(bmi) ? bmi.toFixed(1) : '—';
    }

    savePatientData(e) {
        e.preventDefault();
        const formData = new FormData(e.target);

        const timeValue = document.getElementById('editAnesthesiaStart').value;
        const start = new Date(this.patient.anesthesiaStartTime);
        const [hours, minutes] = timeValue.split(':').map(Number);
        start.setHours(hours, minutes, 0, 0);

        const candidate = new Patient(
            document.getElementById('editPatientId').value,
            parseInt(document.getElementById('editAge').value, 10),
            this.readNumber('editWeight', NaN),
            this.readNumber('editHeight', NaN),
            formData.get('sex') === 'male' ? SexType.MALE : SexType.FEMALE,
            formData.get('asa') === '1-2' ? AsapsType.CLASS_1_2 : AsapsType.CLASS_3_4,
            start
        );

        const validation = candidate.validate();
        if (!validation.isValid) {
            alert('Input error:\n' + validation.errors.join('\n'));
            return;
        }

        this.patient = candidate;
        this.engine.setPatient(candidate);
        this.updatePatientDisplay();
        this.updateAnalgesiaEvaluation();
        this.renderDoseEvents();
        if (this.simulationResult) this.runRecordSimulation();
        this.hidePatientModal();
    }

    showDoseModal() {
        document.getElementById('doseTime').value = this.patient.formattedStartTime;
        document.getElementById('doseBolusAmount').value = 0;
        document.getElementById('doseContinuousRate').value = 0;
        document.getElementById('anesthesiaStartReference').textContent = this.patient.formattedStartTime;
        document.getElementById('doseModal').classList.add('active');
    }

    hideDoseModal() {
        document.getElementById('doseModal').classList.remove('active');
    }

    setDoseTimeToNow() {
        const now = new Date();
        document.getElementById('doseTime').value =
            `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }

    // =============================================
    // Model selection
    // =============================================
    setModelMode(mode) {
        this.modelMode = mode;
        document.querySelectorAll('#modelToggle button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.model === mode);
        });
        this.updateModelNote();
        this.updateWeightWarning();
        this.renderConcentrationCards(this.engine.getState());
        this.rebuildRealtimeChart();
        this.updateAnalgesiaEvaluation();
        if (this.simulationResult) {
            this.renderRecordChart();
            this.renderIndividualisation();
        }
    }

    activeModelIds() {
        return this.modelMode === 'all' ? [...FENTANYL_MODEL_IDS] : [this.modelMode];
    }

    /** The model whose Ce drives the analgesia readout and the target design. */
    primaryModelId() {
        return this.modelMode === 'all' ? FENTANYL_DEFAULT_MODEL : this.modelMode;
    }

    updateModelNote() {
        const ids = this.activeModelIds();

        // One line the user always sees: which model drives the analgesia
        // readout, and how the bolus peak differs between the models shown.
        const peaks = ids.map(id => {
            const m = FentanylModels[id];
            const { peakTime } = timeToPeakEffect(m.getParameters(this.patient));
            return `${m.shortLabel} ${peakTime.toFixed(1)} min`;
        }).join(' / ');

        const primary = FentanylModels[this.primaryModelId()];
        document.getElementById('modelSummary').innerHTML =
            `Primary model for the analgesia readout: <strong>${primary.shortLabel}</strong>` +
            `${primary.isHybrid ? '<span class="hybrid-flag">HYBRID</span>' : ''}` +
            ` &middot; Ce peak after a bolus: ${peaks}`;

        const parts = ids.map(id => {
            const m = FentanylModels[id];
            const { peakTime, peakFraction } = timeToPeakEffect(m.getParameters(this.patient));
            return `<strong>${m.fullName}</strong>${m.isHybrid ? '<span class="hybrid-flag">HYBRID</span>' : ''}<br>` +
                `Ce peak after a bolus: ${peakTime.toFixed(1)} min, at ${(peakFraction * 100).toFixed(0)}% of the initial plasma concentration<br>` +
                `${m.note}<br>${m.reference}`;
        });

        if (this.modelMode === 'all') {
            parts.push(
                `All three models use the same ke0 = ${FENTANYL_KE0} /min, but that ke0 was estimated jointly with the Scott &amp; Stanski PK. ` +
                `Transplanting it onto another PK model shifts the post-bolus peak time. The analgesia readout uses ` +
                `the Ce from ${FentanylModels[FENTANYL_DEFAULT_MODEL].shortLabel} as its primary value.`
            );
        }
        document.getElementById('modelNote').innerHTML = parts.join('<br><br>');
    }

    setSpeed(multiplier) {
        this.engine.setSpeed(multiplier);
        document.querySelectorAll('#speedToggle button').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.speed, 10) === multiplier);
        });
    }

    // =============================================
    // Step 1: real-time
    // =============================================
    startRealtime() {
        const bolus = this.readNumber('rtBolus', 0);
        const continuous = this.readNumber('rtContinuous', 0);

        if (this.realtimeChart) {
            this.realtimeChart.data.labels = [];
            this.realtimeChart.data.datasets.forEach(ds => { ds.data = []; });
            this.realtimeChart.update('none');
        }

        if (this.engine.start(this.patient, bolus, continuous)) {
            this.updateRealtimeControls(true);
        }
    }

    stopRealtime() {
        if (this.engine.stop()) this.updateRealtimeControls(false);
    }

    addRealtimeBolus() {
        const bolus = this.readNumber('rtBolus', 0);
        if (!(bolus > 0)) {
            alert('Set the extra bolus to a value greater than 0.');
            return;
        }
        this.engine.applyBolus(bolus);
        this.onRealtimeUpdate(this.engine.getState());
    }

    recordSnapshot() {
        const state = this.engine.getState();
        const label = `Record #${state.snapshots.length + 1}`;
        this.engine.takeSnapshot(label);
        this.renderSnapshots(this.engine.getState());
    }

    updateRealtimeControls(isRunning) {
        document.getElementById('startRealtimeBtn').classList.toggle('hidden', isRunning);
        document.getElementById('stopRealtimeBtn').classList.toggle('hidden', !isRunning);
        document.getElementById('addBolusBtn').classList.toggle('hidden', !isRunning);
        document.getElementById('recordSnapshotBtn').classList.toggle('hidden', !isRunning);
    }

    onRealtimeUpdate(state) {
        this.renderConcentrationCards(state);
        document.getElementById('rtElapsed').textContent = state.elapsedString;

        const primaryId = this.primaryModelId();
        const primary = state.concentrations[primaryId];
        const primaryCe = primary ? primary.ce : 0;
        this.updateAnalgesiaPanel('rt', primaryCe);

        const others = this.activeModelIds()
            .filter(id => id !== primaryId)
            .map(id => ({ value: state.concentrations[id] ? state.concentrations[id].ce : null,
                          color: FentanylModels[id].color }));
        this.renderCeScale('rt', { primary: primaryCe, others });

        this.appendRealtimeChartPoint(state);
    }

    renderConcentrationCards(state) {
        const container = document.getElementById('rtConcGrid');
        const ids = this.activeModelIds();
        container.style.gridTemplateColumns = ids.length > 1
            ? 'repeat(auto-fit, minmax(120px, 1fr))'
            : '1fr';
        container.innerHTML = '';

        for (const id of ids) {
            const model = FentanylModels[id];
            const values = state.concentrations[id] || { cp: 0, ce: 0 };
            const card = document.createElement('div');
            card.className = 'model-conc-card' + (id === this.primaryModelId() ? ' model-primary' : '');
            card.innerHTML = `
                <div class="model-conc-head">
                    <span class="model-conc-name">${model.shortLabel}${model.isHybrid ? '<span class="hybrid-flag">HYBRID</span>' : ''}</span>
                </div>
                <div class="model-conc-row">
                    <span class="model-conc-key">Ce</span>
                    <span><span class="model-conc-value ce">${values.ce.toFixed(3)}</span><span class="model-conc-unit">ng/mL</span></span>
                </div>
                <div class="model-conc-row">
                    <span class="model-conc-key">Cp</span>
                    <span><span class="model-conc-value" style="font-size:15px">${values.cp.toFixed(3)}</span><span class="model-conc-unit">ng/mL</span></span>
                </div>
            `;
            container.appendChild(card);
        }
    }

    renderSnapshots(state) {
        const section = document.getElementById('snapshotsSection');
        const list = document.getElementById('snapshotsList');

        if (!state.snapshots.length) {
            section.classList.add('hidden');
            return;
        }
        section.classList.remove('hidden');
        list.innerHTML = '';

        for (const snapshot of state.snapshots) {
            const ids = this.activeModelIds();
            const values = ids.map(id => {
                const r = snapshot.results[id];
                return `<span>${FentanylModels[id].shortLabel}: Ce ${r.ce.toFixed(3)} / Cp ${r.cp.toFixed(3)}</span>`;
            }).join('');

            const item = document.createElement('div');
            item.className = 'snapshot-item';
            item.innerHTML = `
                <div class="snapshot-header">
                    <span class="snapshot-title">${snapshot.label}</span>
                    <span class="snapshot-time">${snapshot.formattedTime}</span>
                </div>
                <div class="snapshot-values">${values}</div>
            `;
            list.appendChild(item);
        }
    }

    // =============================================
    // Analgesia panel rendering
    // =============================================
    updateAnalgesiaPanel(prefix, ce) {
        const evaluation = Analgesia.evaluate(ce);
        const band = evaluation.band;

        document.getElementById(`${prefix}BandDot`).style.background = band.color;
        document.getElementById(`${prefix}BandName`).textContent = band.name;
        document.getElementById(`${prefix}BandRange`).textContent = band.rangeLabel;
        document.getElementById(`${prefix}BandDesc`).textContent = band.description;

        const metricsContainer = document.getElementById(`${prefix}Metrics`);
        metricsContainer.innerHTML = '';
        for (const metric of evaluation.metrics) {
            const card = document.createElement('div');
            card.className = 'metric-card';
            const bar = metric.fraction === null || metric.fraction === undefined
                ? ''
                : `<div class="prob-bar"><div class="prob-bar-fill" style="width:${(Math.max(0, Math.min(1, metric.fraction)) * 100).toFixed(1)}%"></div></div>`;
            card.innerHTML = `
                <span class="metric-label">${metric.label}</span>
                <span><span class="metric-value">${metric.display}</span><span class="metric-unit">${metric.unit}</span></span>
                ${bar}
                <span class="metric-source">${metric.source}</span>
            `;
            metricsContainer.appendChild(card);
        }
    }

    renderCeScale(prefix, marks) {
        const track = document.getElementById(`${prefix}CeScaleTrack`);
        const labels = document.getElementById(`${prefix}CeScaleLabels`);
        if (!track) return;

        const max = Analgesia.SCALE_MAX;
        track.innerHTML = '';

        for (const band of Analgesia.BANDS) {
            const lo = Math.max(0, band.min);
            const hi = Math.min(max, band.max === Infinity ? max : band.max);
            if (hi <= lo) continue;
            const seg = document.createElement('div');
            seg.className = 'ce-scale-seg';
            seg.style.background = band.color;
            seg.style.width = `${((hi - lo) / max) * 100}%`;
            seg.title = band.name;
            track.appendChild(seg);
        }

        const addMarker = (value, color) => {
            if (value === null || value === undefined || !isFinite(value)) return;
            const marker = document.createElement('div');
            marker.className = 'ce-scale-marker';
            if (color) marker.style.background = color;
            marker.style.left = `${Math.min(100, Math.max(0, (value / max) * 100))}%`;
            track.appendChild(marker);
        };
        for (const other of (marks.others || [])) addMarker(other.value, other.color);
        addMarker(marks.primary, null);

        if (labels && !labels.dataset.rendered) {
            labels.innerHTML = '';
            for (const tick of Analgesia.SCALE_TICKS) {
                const span = document.createElement('span');
                span.textContent = tick.toFixed(tick < 1 ? 1 : 0);
                labels.appendChild(span);
            }
            labels.dataset.rendered = '1';
        }
    }

    // =============================================
    // Step 2: analgesia assessment
    // =============================================
    onEnterAnalgesiaStep() {
        const state = this.engine.getState();
        const primary = state.concentrations[this.primaryModelId()];
        const banner = document.getElementById('ceTransferBanner');

        if (primary && primary.ce > 0) {
            banner.innerHTML =
                `Current real-time prediction (${FentanylModels[this.primaryModelId()].shortLabel}): ` +
                `<strong>Ce ${primary.ce.toFixed(3)} ng/mL</strong> ` +
                `<button type="button" class="btn btn-secondary btn-sm" id="useCurrentCeBtn" style="margin-left:8px">Use this value</button>`;
            banner.classList.remove('hidden');
            document.getElementById('useCurrentCeBtn').addEventListener('click', () => {
                document.getElementById('evalCe').value = primary.ce.toFixed(2);
                this.updateAnalgesiaEvaluation();
            });
        } else {
            banner.classList.add('hidden');
        }

        this.updateAnalgesiaEvaluation();
        this.resizeCharts();
    }

    updateAnalgesiaEvaluation() {
        const ce = this.readNumber('evalCe', 0);
        this.updateAnalgesiaPanel('eval', ce);
        this.updateTargetDesign(ce);
        this.updateCurveChart(ce);
    }

    updateTargetDesign(ce) {
        const model = FentanylModels[this.primaryModelId()];
        const pk = model.getParameters(this.patient);
        const rate = maintenanceRateUgHr(ce, pk);
        const bolus = loadingBolusUg(ce, pk);
        const { peakTime } = timeToPeakEffect(pk);
        const t90 = timeToSteadyStateFraction(pk, 0.9);

        document.getElementById('maintRate').textContent = isFinite(rate) ? rate.toFixed(1) : '—';
        document.getElementById('loadingBolus').textContent = isFinite(bolus) ? bolus.toFixed(0) : '—';
        document.getElementById('tPeakValue').textContent = peakTime.toFixed(1);
        document.getElementById('t90Value').textContent =
            t90 === null ? '> 100' : (t90 / 60).toFixed(1);

        document.getElementById('targetDesignNote').innerHTML =
            'The maintenance rate comes from the steady-state relation rate = Ce &times; CL. ' +
            'Fentanyl has a large third compartment, however (' + model.shortLabel +
            ' gives V3 ' + pk.v3.toFixed(0) + ' L), and it equilibrates slowly, so holding this rate constant reaches 90% of the target Ce only after about ' +
            (t90 === null ? 'more than 100 hours' : (t90 / 60).toFixed(1) + ' hours') +
            '. Boluses are therefore needed alongside it to hold a target Ce within a normal operating time. ' +
            'The loading bolus is the dose whose peak Ce in an empty patient equals the target; in practice Ce overshoots the target during the distribution phase. ' +
            'Time to peak is the interval from the bolus until Ce reaches its maximum.';
    }

    // =============================================
    // Step 3: dose record
    // =============================================
    onEnterRecordStep() {
        this.renderDoseEvents();
        this.resizeCharts();
    }

    addDoseEvent(e) {
        e.preventDefault();

        const timeValue = document.getElementById('doseTime').value;
        const bolus = this.readNumber('doseBolusAmount', 0);
        const rate = this.readNumber('doseContinuousRate', 0);

        const doseTime = new Date(this.patient.anesthesiaStartTime);
        const [hours, minutes] = timeValue.split(':').map(Number);
        doseTime.setHours(hours, minutes, 0, 0);

        let minutesFromStart = this.patient.clockTimeToMinutes(doseTime);
        if (minutesFromStart < 0) minutesFromStart += 1440;
        minutesFromStart = Math.max(0, Math.round(minutesFromStart));

        const event = new DoseEvent(minutesFromStart, bolus, rate);
        const validation = event.validate();
        if (!validation.isValid) {
            alert('Input error:\n' + validation.errors.join('\n'));
            return;
        }

        this.doseEvents.push(event);
        this.doseEvents.sort((a, b) => a.timeInMinutes - b.timeInMinutes);
        this.renderDoseEvents();
        this.hideDoseModal();
    }

    renderDoseEvents() {
        const container = document.getElementById('doseEventsList');
        container.innerHTML = '';

        if (!this.doseEvents.length) {
            const empty = document.createElement('div');
            empty.className = 'dose-events-empty';
            empty.textContent = 'No dose events yet. Add one with "+ Add".';
            container.appendChild(empty);
            return;
        }

        this.doseEvents.forEach((event, index) => {
            const div = document.createElement('div');
            div.className = 'dose-event';

            const info = document.createElement('div');
            info.className = 'dose-info';

            const title = document.createElement('h4');
            title.textContent = `${event.timeInMinutes} min (${event.formattedClockTime(this.patient)})`;

            const details = document.createElement('div');
            details.className = 'dose-details';

            if (event.bolusUg > 0) {
                const span = document.createElement('span');
                span.textContent = `Bolus ${event.bolusUg.toFixed(0)} µg`;
                details.appendChild(span);
            }
            if (event.continuousUgHr > 0) {
                const span = document.createElement('span');
                span.textContent = `Infusion ${event.continuousUgHr.toFixed(0)} µg/hr`;
                details.appendChild(span);
            }
            if (event.bolusUg <= 0 && event.continuousUgHr <= 0) {
                const span = document.createElement('span');
                span.className = 'dose-stop';
                span.textContent = 'Dosing stopped';
                details.appendChild(span);
            }

            info.appendChild(title);
            info.appendChild(details);

            const del = document.createElement('button');
            del.className = 'delete-dose';
            del.textContent = '×';
            del.setAttribute('aria-label', 'Delete this dose event');
            del.addEventListener('click', () => {
                this.doseEvents.splice(index, 1);
                this.renderDoseEvents();
            });

            div.appendChild(info);
            div.appendChild(del);
            container.appendChild(div);
        });
    }

    runRecordSimulation() {
        if (!this.doseEvents.length) {
            alert('No dose events have been entered.');
            return;
        }

        const results = {};
        for (const id of FENTANYL_MODEL_IDS) {
            const pk = FentanylModels[id].getParameters(this.patient);
            results[id] = simulateDoseRecord(this.doseEvents, pk, { sampleIntervalMin: 0.5 });
            results[id].pk = pk;
        }
        this.simulationResult = results;

        this.renderRecordResults();
        this.renderRecordChart();
        this.renderDecrementList();
        this.renderIndividualisation();
    }

    // =============================================
    // Per-patient MEAC estimation
    // =============================================
    showObservationModal() {
        if (!this.simulationResult) {
            alert('Enter dose events and run the simulation first.\nThe Ce at the recorded time is required.');
            return;
        }
        document.getElementById('observationTime').value = this.patient.formattedStartTime;
        document.getElementById('observationStartReference').textContent = this.patient.formattedStartTime;
        document.querySelector('input[name="adequate"][value="yes"]').checked = true;
        document.getElementById('observationModal').classList.add('active');
    }

    hideObservationModal() {
        document.getElementById('observationModal').classList.remove('active');
    }

    addObservation(e) {
        e.preventDefault();
        const timeValue = document.getElementById('observationTime').value;
        const adequate = new FormData(e.target).get('adequate') === 'yes';

        const clock = new Date(this.patient.anesthesiaStartTime);
        const [hours, minutes] = timeValue.split(':').map(Number);
        clock.setHours(hours, minutes, 0, 0);

        let minutesFromStart = this.patient.clockTimeToMinutes(clock);
        if (minutesFromStart < 0) minutesFromStart += 1440;
        minutesFromStart = Math.max(0, Math.round(minutesFromStart));

        const observation = new AnalgesiaObservation(minutesFromStart, adequate);
        const validation = observation.validate();
        if (!validation.isValid) {
            alert('Input error:\n' + validation.errors.join('\n'));
            return;
        }

        const run = this.simulationResult[this.primaryModelId()];
        if (minutesFromStart > run.durationMin) {
            alert(`The assessment time is beyond the simulated range (maximum ${run.durationMin.toFixed(0)} min).`);
            return;
        }

        this.observations.push(observation);
        this.observations.sort((a, b) => a.timeInMinutes - b.timeInMinutes);
        this.renderIndividualisation();
        this.hideObservationModal();
    }

    /** Ce under one model at an arbitrary time, interpolated from the run grid. */
    ceAtTime(modelId, timeInMinutes) {
        const run = this.simulationResult && this.simulationResult[modelId];
        if (!run || !run.times.length) return null;
        if (timeInMinutes <= run.times[0]) return run.ce[0];
        const last = run.times.length - 1;
        if (timeInMinutes >= run.times[last]) return run.ce[last];

        let i = 1;
        while (i < last && run.times[i] < timeInMinutes) i++;
        const t0 = run.times[i - 1];
        const t1 = run.times[i];
        const w = t1 > t0 ? (timeInMinutes - t0) / (t1 - t0) : 0;
        return run.ce[i - 1] + w * (run.ce[i] - run.ce[i - 1]);
    }

    /** Observations paired with the Ce that one model predicts at their time. */
    observationsForModel(modelId) {
        return this.observations
            .map(o => ({ ce: this.ceAtTime(modelId, o.timeInMinutes), adequate: o.adequate, source: o }))
            .filter(o => o.ce !== null && o.ce > 0);
    }

    renderIndividualisation() {
        this.renderObservationsList();

        const primaryId = this.primaryModelId();
        const paired = this.observationsForModel(primaryId);
        const posterior = IndividualMEAC.posterior(paired);
        const summary = IndividualMEAC.summary(posterior);

        document.getElementById('meacEstimate').textContent = summary.median.toFixed(2);
        document.getElementById('meacInterval').textContent =
            `${summary.lower.toFixed(2)} – ${summary.upper.toFixed(2)}`;
        document.getElementById('meacObsCount').textContent = summary.observationCount;

        const run = this.simulationResult && this.simulationResult[primaryId];
        if (run) {
            const finalCe = run.ce[run.ce.length - 1];
            document.getElementById('meacProbAtFinal').textContent =
                (IndividualMEAC.probabilityAdequate(finalCe, posterior) * 100).toFixed(0);
        } else {
            document.getElementById('meacProbAtFinal').textContent = '—';
        }

        this.renderIndividualCurveChart(posterior, paired);
        this.renderMeacModelComparison();
        this.renderMeacAssumptions(posterior);
    }

    renderObservationsList() {
        const container = document.getElementById('observationsList');
        container.innerHTML = '';

        if (!this.observations.length) {
            const empty = document.createElement('div');
            empty.className = 'dose-events-empty';
            empty.textContent = 'No analgesia assessments recorded. The population curve is shown unchanged.';
            container.appendChild(empty);
            return;
        }

        const primaryId = this.primaryModelId();
        this.observations.forEach((observation, index) => {
            const ce = this.ceAtTime(primaryId, observation.timeInMinutes);
            const row = document.createElement('div');
            row.className = 'observation-row' + (observation.adequate ? ' adequate' : ' inadequate');

            const info = document.createElement('div');
            info.className = 'dose-info';
            const title = document.createElement('h4');
            title.textContent = `${observation.formattedClockTime(this.patient)} — ` +
                (observation.adequate ? 'Adequate' : 'Inadequate');
            const details = document.createElement('div');
            details.className = 'dose-details';
            const span = document.createElement('span');
            span.textContent = ce === null
                ? 'Ce unavailable'
                : `Ce at that time ${ce.toFixed(3)} ng/mL (${FentanylModels[primaryId].shortLabel})`;
            details.appendChild(span);
            info.appendChild(title);
            info.appendChild(details);

            const del = document.createElement('button');
            del.className = 'delete-dose';
            del.textContent = '×';
            del.setAttribute('aria-label', 'Delete this assessment');
            del.addEventListener('click', () => {
                this.observations.splice(index, 1);
                this.renderIndividualisation();
            });

            row.appendChild(info);
            row.appendChild(del);
            container.appendChild(row);
        });
    }

    renderIndividualCurveChart(posterior, paired) {
        const canvas = document.getElementById('individualCurveChart');
        if (!canvas) return;
        if (this.individualCurveChart) this.individualCurveChart.destroy();

        const maxCe = 5.0;
        const curve = IndividualMEAC.curve(posterior, maxCe, 200);
        const asPoints = (ys) => curve.ce.map((x, i) => ({ x, y: ys[i] }));

        const options = this.baseChartOptions('Probability that analgesia is adequate');
        options.scales = {
            x: {
                type: 'linear', min: 0, max: maxCe,
                title: { display: true, text: 'Effect-site concentration Ce (ng/mL)', color: '#8B949E', font: { size: 10 } },
                ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#8B949E' },
                grid: { color: 'rgba(255,255,255,0.06)' }
            },
            y: {
                beginAtZero: true, max: 1,
                title: { display: true, text: 'Probability that analgesia is adequate', font: { size: 10 }, color: '#8B949E' },
                ticks: { color: '#8B949E', callback: (v) => `${Math.round(v * 100)}%` },
                grid: { color: 'rgba(255,255,255,0.06)' }
            }
        };

        this.individualCurveChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Population (Bae 2020)',
                        data: asPoints(curve.population),
                        borderColor: '#8B949E', borderWidth: 1.5, borderDash: [5, 4],
                        pointRadius: 0, fill: false, tension: 0.1
                    },
                    {
                        label: 'This patient (estimated)',
                        data: asPoints(curve.individual),
                        borderColor: '#2FBFA8', borderWidth: 2.5,
                        pointRadius: 0, fill: false, tension: 0.1
                    },
                    {
                        label: 'Recorded adequate',
                        data: paired.filter(o => o.adequate).map(o => ({ x: o.ce, y: 1 })),
                        borderColor: '#2FBFA8', backgroundColor: '#2FBFA8',
                        pointRadius: 5, pointStyle: 'circle', showLine: false
                    },
                    {
                        label: 'Recorded inadequate',
                        data: paired.filter(o => !o.adequate).map(o => ({ x: o.ce, y: 0 })),
                        borderColor: '#D85A30', backgroundColor: '#D85A30',
                        pointRadius: 5, pointStyle: 'triangle', showLine: false
                    }
                ]
            },
            options
        });
    }

    /**
     * The same observations read through each PK model. A model that predicts Ce
     * badly pushes its error into the estimated threshold, so a wide spread here
     * is a statement about the PK models, not about the patient.
     */
    renderMeacModelComparison() {
        const element = document.getElementById('meacModelComparison');
        if (!this.observations.length) {
            element.textContent = '';
            return;
        }

        const parts = FENTANYL_MODEL_IDS.map(id => {
            const summary = IndividualMEAC.summary(
                IndividualMEAC.posterior(this.observationsForModel(id)));
            return `${FentanylModels[id].shortLabel} ${summary.median.toFixed(2)}`;
        });

        element.innerHTML =
            `Estimated MEAC (ng/mL) when the same records are read through each PK model: ${parts.join(' / ')}. ` +
            'Error in the PK model is absorbed directly into the threshold estimate, so this spread reflects the difference between models, not the patient.';
    }

    renderMeacAssumptions(posterior) {
        const s = posterior.scales;
        document.getElementById('meacAssumptions').innerHTML =
            `The prior is a log-logistic fitted to the Bae 2020 (PMID 32861508) MEAC median ${Analgesia.MEAC.median} ng/mL ` +
            `and IQR ${Analgesia.MEAC.q1}-${Analgesia.MEAC.q3}, decomposed into a between-patient and a within-patient component. ` +
            `Within-patient variability is taken from ${IndividualMEAC.withinPatientSource}, giving on the log scale ` +
            `sd_total ${s.sdTotal.toFixed(3)} = sd_between ${s.sdBetween.toFixed(3)} ` +
            `+ sd_within ${s.sdWithin.toFixed(3)}. ` +
            'Because of this decomposition, the predictive distribution with zero records matches the published population curve.<br><br>' +
            'Limitations: both the prior and the within-patient variability come from postoperative studies, so applying them to intraoperative surgical stimulus is an extrapolation the sources do not support. ' +
            'As Bouillon 2004 (PMID 15166553) shows, an opioid alone cannot abolish the response and acts synergistically with a hypnotic, so there is a fundamental ceiling on how well a fentanyl-alone threshold can predict intraoperative responses. ' +
            'Always interpret the estimate together with the PK model that produced it.';
    }

    renderRecordResults() {
        const id = this.primaryModelId();
        const run = this.simulationResult[id];
        document.getElementById('simulationResults').classList.remove('hidden');

        document.getElementById('simMaxCp').textContent = run.maxCp.toFixed(3);
        document.getElementById('simMaxCe').textContent = run.maxCe.toFixed(3);
        document.getElementById('simFinalCe').textContent = run.ce[run.ce.length - 1].toFixed(3);
        document.getElementById('simDuration').textContent = run.durationMin.toFixed(0);

        const total = this.doseEvents.reduce((sum, e) => sum + e.bolusUg, 0)
            + this.integratedInfusionUg();
        document.getElementById('simTotalDose').textContent = total.toFixed(0);

        const meac = Analgesia.MEAC.median;
        const above = run.ce.filter(v => v >= meac).length;
        document.getElementById('simTimeAboveMeac').textContent =
            ((above / run.ce.length) * 100).toFixed(0);
    }

    /** Total micrograms delivered by the infusion steps over the record. */
    integratedInfusionUg() {
        const { infusionChanges } = buildDoseSchedule(this.doseEvents);
        const end = this.simulationResult
            ? this.simulationResult[this.primaryModelId()].durationMin
            : 0;
        let total = 0;
        for (let i = 0; i < infusionChanges.length; i++) {
            const from = infusionChanges[i].time;
            const to = i + 1 < infusionChanges.length ? infusionChanges[i + 1].time : end;
            if (to > from) total += infusionChanges[i].rateUgHr * (to - from) / 60;
        }
        return total;
    }

    renderDecrementList() {
        const container = document.getElementById('decrementList');
        container.innerHTML = '';

        const id = this.primaryModelId();
        const run = this.simulationResult[id];

        // The clinically meaningful reference point is the last dose event —
        // "if everything is stopped now" — not the end of the plotted window,
        // which already contains two hours of decay.
        const stopMinutes = Math.max(...this.doseEvents.map(e => e.timeInMinutes));
        const upToStop = simulateDoseRecord(this.doseEvents, run.pk, {
            durationMin: stopMinutes,
            sampleIntervalMin: 1
        });

        const stopClock = this.patient.minutesToClockTime(stopMinutes)
            .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
        document.getElementById('decrementReference').textContent =
            `Time for Ce (${FentanylModels[id].shortLabel}) to fall below each threshold if all dosing stops at the last dose event, ` +
            `${stopClock} (${stopMinutes} min). ` +
            `Ce at that moment is ${upToStop.finalState.ce.toFixed(3)} ng/mL.`;

        const thresholds = Analgesia.DECREMENT_THRESHOLDS;
        const times = decrementTimes(upToStop.finalState, run.pk, thresholds.map(t => t.value));

        thresholds.forEach((threshold, index) => {
            const minutes = times[index];
            const row = document.createElement('div');
            row.className = 'decrement-row';
            let display;
            if (minutes === null) display = 'over 12 h';
            else if (minutes === 0) display = 'already below';
            else if (minutes >= 60) display = `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
            else display = `${minutes.toFixed(0)} min`;

            row.innerHTML = `
                <span class="decrement-target">Ce &lt; ${threshold.value.toFixed(2)} ng/mL<small>${threshold.label}</small></span>
                <span class="decrement-time">${display}</span>
            `;
            container.appendChild(row);
        });
    }

    // =============================================
    // Charts
    // =============================================
    baseChartOptions(yTitle) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            interaction: { mode: 'index', intersect: false, axis: 'x' },
            plugins: {
                legend: { labels: { boxWidth: 12, font: { size: 11 }, color: '#8B949E' } },
                tooltip: {
                    padding: 10, cornerRadius: 8,
                    backgroundColor: '#161B22', titleColor: '#E6EDF3', bodyColor: '#C9D1D9',
                    borderColor: '#30363D', borderWidth: 1,
                    titleFont: { size: 12 }, bodyFont: { size: 11 }
                }
            },
            scales: {
                x: {
                    ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#8B949E' },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: yTitle, font: { size: 10 }, color: '#8B949E' },
                    ticks: { color: '#8B949E' },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                }
            }
        };
    }

    /** Horizontal MEC / MEAC reference lines drawn as flat datasets. */
    thresholdDatasets(length) {
        return [
            {
                label: `MEAC ${Analgesia.MEAC.median} ng/mL`,
                data: new Array(length).fill(Analgesia.MEAC.median),
                borderColor: 'rgba(216,90,48,0.85)',
                borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false
            },
            {
                label: `MEC ${Analgesia.MEC.median} ng/mL`,
                data: new Array(length).fill(Analgesia.MEC.median),
                borderColor: 'rgba(212,160,23,0.85)',
                borderDash: [3, 3], borderWidth: 1.5, pointRadius: 0, fill: false
            }
        ];
    }

    initializeRealtimeChart() {
        const ctx = document.getElementById('realtimeChart').getContext('2d');
        const options = this.baseChartOptions('Concentration (ng/mL)');
        options.scales.x = {
            title: { display: true, text: 'Elapsed time (min)', color: '#8B949E', font: { size: 10 } },
            ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#8B949E' },
            grid: { color: 'rgba(255,255,255,0.06)' }
        };
        this.realtimeChart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [] },
            options
        });
    }

    /**
     * Ce and, optionally, Cp for every active model plus the MEC/MEAC lines.
     * A fentanyl bolus sends Cp above 15 ng/mL while Ce stays near 2, so
     * plotting both on one axis flattens the Ce trace; hiding Cp rescales the
     * axis to the concentrations the analgesia bands are defined on.
     */
    buildConcentrationDatasets(points, ceOf, cpOf) {
        const datasets = [];
        for (const id of this.activeModelIds()) {
            const model = FentanylModels[id];
            datasets.push({
                label: `Ce (${model.shortLabel})`,
                data: points.map(p => ceOf(p, id)),
                borderColor: model.color, borderWidth: 2,
                pointRadius: 0, fill: false, tension: 0.1
            });
            if (this.showCp) {
                datasets.push({
                    label: `Cp (${model.shortLabel})`,
                    data: points.map(p => cpOf(p, id)),
                    borderColor: model.cpColor,
                    borderWidth: 1.2, borderDash: [4, 3],
                    pointRadius: 0, fill: false, tension: 0.1
                });
            }
        }
        datasets.push(...this.thresholdDatasets(points.length));
        return datasets;
    }

    setShowCp(showCp) {
        this.showCp = showCp;
        document.querySelectorAll('#traceToggle button').forEach(btn => {
            btn.classList.toggle('active', (btn.dataset.trace === 'both') === showCp);
        });
        this.appendRealtimeChartPoint(this.engine.getState(), true);
        if (this.simulationResult) this.renderRecordChart();
    }

    rebuildRealtimeChart() {
        this.appendRealtimeChartPoint(this.engine.getState(), true);
    }

    /**
     * Redraws the trace from the engine history, thinned to a bounded number of
     * points so a long fast-forwarded run stays responsive.
     */
    appendRealtimeChartPoint(state, force = false) {
        if (!this.realtimeChart) return;
        const now = Date.now();
        if (!force && now - this.chartRedrawAt < 400) return;
        this.chartRedrawAt = now;

        const history = state.history;
        if (!history.length) {
            this.realtimeChart.data.labels = [];
            this.realtimeChart.data.datasets = [];
            this.realtimeChart.update('none');
            return;
        }

        const maxPoints = 400;
        const stride = Math.max(1, Math.ceil(history.length / maxPoints));
        const points = history.filter((_, i) => i % stride === 0 || i === history.length - 1);

        this.realtimeChart.data.labels = points.map(p => p.t.toFixed(1));
        this.realtimeChart.data.datasets = this.buildConcentrationDatasets(
            points, (p, id) => p.ce[id], (p, id) => p.cp[id]);
        this.realtimeChart.update('none');
    }

    initializeCurveChart() {
        const ctx = document.getElementById('analgesiaCurveChart').getContext('2d');
        const series = Analgesia.curveSeries();

        // A linear x axis (rather than the concentrations as category labels)
        // lets the "current Ce" marker be drawn as a genuine vertical line at an
        // arbitrary concentration, and gives round tick values.
        const asPoints = (ys) => series.ce.map((x, i) => ({ x, y: ys[i] }));

        this.curveChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'P(Ce >= this patient\u2019s MEAC)',
                        data: asPoints(series.pMeac),
                        borderColor: '#2FBFA8', borderWidth: 2,
                        pointRadius: 0, fill: false, tension: 0.1
                    },
                    {
                        label: 'P(Ce >= this patient\u2019s MEC)',
                        data: asPoints(series.pMec),
                        borderColor: '#D4A017', borderWidth: 2,
                        pointRadius: 0, fill: false, tension: 0.1
                    },
                    {
                        label: 'Isoflurane MAC reduction',
                        data: asPoints(series.macFraction),
                        borderColor: '#9B72B0', borderWidth: 2, borderDash: [6, 3],
                        pointRadius: 0, fill: false, tension: 0.1
                    },
                    {
                        label: 'Ce being evaluated',
                        data: [],
                        borderColor: '#E6EDF3', borderWidth: 1.5, borderDash: [4, 3],
                        pointRadius: 0, fill: false
                    }
                ]
            },
            options: {
                ...this.baseChartOptions('Proportion'),
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        max: series.ce[series.ce.length - 1],
                        title: { display: true, text: 'Effect-site concentration Ce (ng/mL)', color: '#8B949E', font: { size: 10 } },
                        ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#8B949E' },
                        grid: { color: 'rgba(255,255,255,0.06)' }
                    },
                    y: {
                        beginAtZero: true, max: 1,
                        title: { display: true, text: 'Proportion of the population', font: { size: 10 }, color: '#8B949E' },
                        ticks: {
                            color: '#8B949E',
                            callback: (v) => `${Math.round(v * 100)}%`
                        },
                        grid: { color: 'rgba(255,255,255,0.06)' }
                    }
                }
            }
        });
    }

    updateCurveChart(ce) {
        if (!this.curveChart) return;
        const max = this.curveChart.options.scales.x.max;
        const x = Math.min(Math.max(ce, 0), max);
        this.curveChart.data.datasets[3].data = [{ x, y: 0 }, { x, y: 1 }];
        this.curveChart.update('none');
    }

    renderRecordChart() {
        const canvas = document.getElementById('recordChart');
        if (!canvas || !this.simulationResult) return;
        if (this.recordChart) this.recordChart.destroy();

        const ids = this.activeModelIds();
        const reference = this.simulationResult[ids[0]];
        const labels = reference.times.map(t =>
            this.patient.minutesToClockTime(t).toLocaleTimeString('en-GB',
                { hour: '2-digit', minute: '2-digit', hour12: false }));

        const indices = reference.times.map((_, i) => i);
        const datasets = this.buildConcentrationDatasets(
            indices,
            (i, id) => this.simulationResult[id].ce[i],
            (i, id) => this.simulationResult[id].cp[i]);

        this.recordChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                ...this.baseChartOptions('Concentration (ng/mL)'),
                scales: {
                    x: {
                        title: { display: true, text: 'Clock time', color: '#8B949E', font: { size: 10 } },
                        ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#8B949E' },
                        grid: { color: 'rgba(255,255,255,0.06)' }
                    },
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: 'Concentration (ng/mL)', font: { size: 10 }, color: '#8B949E' },
                        ticks: { color: '#8B949E' },
                        grid: { color: 'rgba(255,255,255,0.06)' }
                    }
                }
            }
        });
    }

    resizeCharts() {
        [this.realtimeChart, this.curveChart, this.recordChart].forEach(chart => {
            if (chart) chart.resize();
        });
    }

    // =============================================
    // Reference table
    // =============================================
    renderBandReference() {
        const table = document.getElementById('bandRefTable');
        const rows = Analgesia.BANDS.map(band => `
            <tr>
                <td><span class="band-swatch" style="background:${band.color}"></span>${band.name}</td>
                <td class="num">${band.rangeLabel}</td>
                <td>${band.description}</td>
                <td>${band.source}</td>
            </tr>
        `).join('');

        table.innerHTML = `
            <thead><tr>
                <th>Band</th><th>Ce (ng/mL)</th><th>Description</th><th>Source</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        `;

        document.getElementById('bandRefFootnote').innerHTML = Analgesia.FOOTNOTE;
    }

    // =============================================
    // Export
    // =============================================
    triggerDownload(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    exportCsv() {
        if (!this.simulationResult) {
            alert('Run the simulation first.');
            return;
        }

        const p = this.patient;
        const primaryId = this.primaryModelId();
        const reference = this.simulationResult[primaryId];
        const { infusionChanges } = buildDoseSchedule(this.doseEvents);

        const lines = [];
        lines.push(`# Fentanyl Ce Simulator ${APP_VERSION}`);
        lines.push(`# PatientID,${p.id},Age,${p.age},Weight,${p.weight} kg,Height,${p.height} cm,Sex,${SexType.displayName(p.sex)},ASA-PS,${AsapsType.displayName(p.asaPS)},AnaesthesiaStart,${p.formattedStartTime}`);
        lines.push(`# PrimaryModel,${FentanylModels[primaryId].fullName}`);
        lines.push(`# MEC,${Analgesia.MEC.median} ng/mL,MEAC,${Analgesia.MEAC.median} ng/mL,${Analgesia.MEAC.source}`);

        const meac = IndividualMEAC.summary(
            IndividualMEAC.posterior(this.observationsForModel(primaryId)));
        lines.push(`# IndividualisedMEAC,${meac.median.toFixed(3)} ng/mL,90%CI,${meac.lower.toFixed(3)}-${meac.upper.toFixed(3)},Records,${meac.observationCount}`);
        for (const observation of this.observations) {
            const ce = this.ceAtTime(primaryId, observation.timeInMinutes);
            lines.push(`# AnalgesiaAssessment,${observation.formattedClockTime(p)},${observation.adequate ? 'Adequate' : 'Inadequate'},Ce,${ce === null ? 'NA' : ce.toFixed(4)}`);
        }

        const header = ['ClockTime', 'Elapsed(min)', 'Bolus(µg)', 'Infusion(µg/hr)'];
        for (const id of FENTANYL_MODEL_IDS) {
            header.push(`Cp_${id}(ng/mL)`, `Ce_${id}(ng/mL)`);
        }
        header.push('Band', 'P(Ce>=MEAC)', 'P(Ce>=MEC)');
        lines.push(header.join(','));

        for (let i = 0; i < reference.times.length; i++) {
            const t = reference.times[i];
            const bolus = this.doseEvents
                .filter(e => Math.abs(e.timeInMinutes - t) < 0.25)
                .reduce((sum, e) => sum + e.bolusUg, 0);
            const rate = infusionRateAt(infusionChanges, t);

            const row = [
                p.minutesToClockTime(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
                t.toFixed(1),
                bolus.toFixed(0),
                rate.toFixed(1)
            ];
            for (const id of FENTANYL_MODEL_IDS) {
                row.push(this.simulationResult[id].cp[i].toFixed(4));
                row.push(this.simulationResult[id].ce[i].toFixed(4));
            }
            const ce = reference.ce[i];
            row.push(Analgesia.bandFor(ce).name);
            row.push(Analgesia.probability(ce, Analgesia.MEAC).toFixed(4));
            row.push(Analgesia.probability(ce, Analgesia.MEC).toFixed(4));
            lines.push(row.join(','));
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const safeId = p.id.replace(/[^a-zA-Z0-9]/g, '_');
        // BOM so Excel on Windows reads the Japanese headers as UTF-8.
        this.triggerDownload('﻿' + lines.join('\n'), 'text/csv;charset=utf-8;',
            `fentanyl_${safeId}_${dateStr}.csv`);
    }

    saveSession() {
        const session = FentanylSession.build(this.patient, this.doseEvents, APP_VERSION, this.observations);
        const dateStr = new Date().toISOString().split('T')[0];
        const safeId = this.patient.id.replace(/[^a-zA-Z0-9]/g, '_');
        this.triggerDownload(JSON.stringify(session, null, 2), 'application/json;charset=utf-8;',
            `fentanyl_${safeId}_session_${dateStr}.json`);
    }

    handleSessionFile(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                this.applySession(ev.target.result);
            } catch (error) {
                console.error('session load failed:', error);
                alert('Load error:\n' + error.message);
            }
        };
        reader.onerror = () => alert('Load error:\nThe file could not be read.');
        reader.readAsText(file);
    }

    applySession(text) {
        const { patient, doseEvents, observations } = FentanylSession.parse(text);

        const patientValidation = patient.validate();
        if (!patientValidation.isValid) {
            throw new Error('The patient data is invalid:\n' + patientValidation.errors.join('\n'));
        }
        for (const event of doseEvents) {
            const v = event.validate();
            if (!v.isValid) {
                throw new Error(`The dose event at ${event.timeInMinutes} min is invalid:\n` + v.errors.join('\n'));
            }
        }

        for (const observation of observations) {
            const v = observation.validate();
            if (!v.isValid) {
                throw new Error(`The analgesia assessment at ${observation.timeInMinutes} min is invalid:\n` + v.errors.join('\n'));
            }
        }

        this.patient = patient;
        this.engine.setPatient(patient);
        this.doseEvents = doseEvents;
        this.observations = observations;

        this.updatePatientDisplay();
        this.renderDoseEvents();
        this.updateAnalgesiaEvaluation();
        if (doseEvents.length) this.runRecordSimulation();
        else this.renderObservationsList();
    }
}

const app = new MainController();

if (typeof window !== 'undefined') {
    window.app = app;
}
