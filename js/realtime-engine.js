/**
 * Real-time engine: advances the fentanyl PK/PD state in wall-clock time and
 * notifies subscribers. Both PK models are integrated simultaneously from the
 * same dose history, so the two Ce traces can be compared side by side.
 *
 * The state is advanced by the real elapsed time between ticks rather than by a
 * fixed increment per tick, so a throttled or delayed timer does not silently
 * slow the simulated clock. A speed multiplier lets the user run faster than
 * real time, which matters for fentanyl: Ce peaks at about 3 min and the
 * decrement times run into hours.
 */

const RT_TICK_MS = 500;
const RT_MAX_SUBSTEP_MIN = 0.02;
const RT_HISTORY_INTERVAL_MIN = 0.05;   // initial trace resolution, simulated min
const RT_HISTORY_MAX_POINTS = 2000;

class RealtimeEngine {
    constructor() {
        this.isRunning = false;
        this.patient = null;
        this.speed = 1;
        this.elapsedMinutes = 0;
        this.continuousUgHr = 0;
        this.totalDoseUg = 0;
        this.states = {};      // modelId -> {a1,a2,a3,ce}
        this.pkParams = {};    // modelId -> parameter set
        this.snapshots = [];
        this.history = [];     // {t, ce: {modelId: value}, cp: {modelId: value}}
        this.timer = null;
        this.lastTickAt = null;
        this.historyIntervalMin = RT_HISTORY_INTERVAL_MIN;
        this.lastHistoryAt = -Infinity;
        this.updateCallbacks = [];
    }

    addUpdateCallback(callback) {
        this.updateCallbacks.push(callback);
    }

    notify() {
        const snapshot = this.getState();
        for (const callback of this.updateCallbacks) {
            try {
                callback(snapshot);
            } catch (error) {
                console.error('realtime callback failed:', error);
            }
        }
    }

    /** Recomputes PK parameters for the current patient without losing state. */
    setPatient(patient) {
        this.patient = patient;
        for (const id of FENTANYL_MODEL_IDS) {
            this.pkParams[id] = FentanylModels[id].getParameters(patient);
        }
    }

    setSpeed(multiplier) {
        this.speed = multiplier;
    }

    start(patient, bolusUg, continuousUgHr) {
        if (this.isRunning) return false;

        this.setPatient(patient);
        this.elapsedMinutes = 0;
        this.continuousUgHr = continuousUgHr;
        this.totalDoseUg = 0;
        this.snapshots = [];
        this.history = [];
        this.historyIntervalMin = RT_HISTORY_INTERVAL_MIN;
        this.lastHistoryAt = -Infinity;

        for (const id of FENTANYL_MODEL_IDS) {
            this.states[id] = { a1: 0, a2: 0, a3: 0, ce: 0 };
        }
        this.recordHistory(true);
        if (bolusUg > 0) this.applyBolus(bolusUg);
        this.isRunning = true;
        this.lastTickAt = Date.now();
        this.timer = setInterval(() => this.tick(), RT_TICK_MS);
        this.notify();
        return true;
    }

    stop() {
        if (!this.isRunning) return false;
        this.isRunning = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.notify();
        return true;
    }

    reset() {
        this.stop();
        this.elapsedMinutes = 0;
        this.continuousUgHr = 0;
        this.totalDoseUg = 0;
        this.snapshots = [];
        this.history = [];
        this.historyIntervalMin = RT_HISTORY_INTERVAL_MIN;
        this.lastHistoryAt = -Infinity;
        for (const id of FENTANYL_MODEL_IDS) {
            this.states[id] = { a1: 0, a2: 0, a3: 0, ce: 0 };
        }
        this.notify();
    }

    applyBolus(bolusUg) {
        if (!(bolusUg > 0)) return false;
        for (const id of FENTANYL_MODEL_IDS) {
            if (!this.states[id]) this.states[id] = { a1: 0, a2: 0, a3: 0, ce: 0 };
            this.states[id].a1 += bolusUg;
        }
        this.totalDoseUg += bolusUg;
        this.recordHistory(true);
        return true;
    }

    setContinuousRate(ugHr) {
        this.continuousUgHr = ugHr;
    }

    tick() {
        if (!this.isRunning) return;

        const now = Date.now();
        const wallMinutes = (now - this.lastTickAt) / 60000;
        this.lastTickAt = now;

        let remaining = wallMinutes * this.speed;
        if (!(remaining > 0)) return;
        // A backgrounded tab can hand back a very large gap; cap it so one tick
        // cannot spend an unbounded amount of time integrating.
        remaining = Math.min(remaining, 30);

        const infusionUgMin = this.continuousUgHr / 60.0;
        this.totalDoseUg += infusionUgMin * remaining;

        while (remaining > 1e-12) {
            const dt = Math.min(RT_MAX_SUBSTEP_MIN, remaining);
            for (const id of FENTANYL_MODEL_IDS) {
                this.states[id] = rk4Step(this.states[id], infusionUgMin, this.pkParams[id], dt);
            }
            this.elapsedMinutes += dt;
            remaining -= dt;
            this.recordHistory();
        }

        this.notify();
    }

    /**
     * Samples the trace on simulated time rather than on ticks, so the curve has
     * the same resolution at x1 and at x60. When the buffer fills, the trace is
     * halved and the interval doubled: the whole run stays on screen and memory
     * stays bounded, at progressively coarser resolution.
     */
    recordHistory(force = false) {
        if (!force && this.elapsedMinutes - this.lastHistoryAt < this.historyIntervalMin - 1e-9) return;
        this.lastHistoryAt = this.elapsedMinutes;

        const point = { t: this.elapsedMinutes, cp: {}, ce: {} };
        for (const id of FENTANYL_MODEL_IDS) {
            const state = this.states[id] || { a1: 0, ce: 0 };
            point.cp[id] = plasmaConcentration(state, this.pkParams[id]);
            point.ce[id] = state.ce;
        }
        this.history.push(point);

        if (this.history.length > RT_HISTORY_MAX_POINTS) {
            const last = this.history[this.history.length - 1];
            this.history = this.history.filter((_, i) => i % 2 === 0);
            if (this.history[this.history.length - 1] !== last) this.history.push(last);
            this.historyIntervalMin *= 2;
        }
    }

    takeSnapshot(label) {
        const results = {};
        for (const id of FENTANYL_MODEL_IDS) {
            const state = this.states[id] || { a1: 0, ce: 0 };
            results[id] = {
                cp: plasmaConcentration(state, this.pkParams[id]),
                ce: state.ce
            };
        }
        const snapshot = new RealtimeSnapshot(label, this.elapsedMinutes, results);
        this.snapshots.unshift(snapshot);
        if (this.snapshots.length > 12) this.snapshots.length = 12;
        return snapshot;
    }

    /** Decrement times from the current state, per model. */
    getDecrementTimes(thresholds) {
        const out = {};
        for (const id of FENTANYL_MODEL_IDS) {
            out[id] = decrementTimes(this.states[id] || { a1: 0, a2: 0, a3: 0, ce: 0 },
                this.pkParams[id], thresholds);
        }
        return out;
    }

    getState() {
        const concentrations = {};
        for (const id of FENTANYL_MODEL_IDS) {
            const state = this.states[id] || { a1: 0, a2: 0, a3: 0, ce: 0 };
            concentrations[id] = {
                cp: plasmaConcentration(state, this.pkParams[id]),
                ce: state.ce
            };
        }
        return {
            isRunning: this.isRunning,
            elapsedMinutes: this.elapsedMinutes,
            elapsedString: this.formatElapsed(),
            speed: this.speed,
            continuousUgHr: this.continuousUgHr,
            totalDoseUg: this.totalDoseUg,
            concentrations,
            snapshots: [...this.snapshots],
            history: this.history
        };
    }

    formatElapsed() {
        const totalSeconds = Math.floor(this.elapsedMinutes * 60);
        const hh = Math.floor(totalSeconds / 3600);
        const mm = Math.floor((totalSeconds % 3600) / 60);
        const ss = totalSeconds % 60;
        const pad = (n) => n.toString().padStart(2, '0');
        return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
    }
}

if (typeof window !== 'undefined') {
    window.RealtimeEngine = RealtimeEngine;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RealtimeEngine };
}
