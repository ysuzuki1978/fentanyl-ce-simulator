/**
 * Deterministic simulation of a fentanyl dosing record.
 *
 * Integrates the 3-compartment + effect-site system with classical RK4 on a
 * fixed grid. Boluses are added to the central compartment at their event time;
 * the infusion rate is a step function that changes at each dose event and
 * holds until the next one.
 */

const SIM_DEFAULT_DT = 0.02;              // min, integration step
const SIM_DEFAULT_SAMPLE_INTERVAL = 0.5;  // min, output sampling
const DECREMENT_HORIZON_MIN = 720;        // cap for decrement-time search

/**
 * Normalises the dose record into a bolus list and an infusion step function.
 * Multiple events at the same time are merged: boluses add, the last infusion
 * rate written for that time wins.
 */
function buildDoseSchedule(doseEvents) {
    const sorted = [...(doseEvents || [])].sort((a, b) => a.timeInMinutes - b.timeInMinutes);

    const boluses = [];
    const infusionChanges = [{ time: 0, rateUgHr: 0 }];

    for (const event of sorted) {
        if (event.bolusUg > 0) {
            boluses.push({ time: event.timeInMinutes, doseUg: event.bolusUg });
        }
        const last = infusionChanges[infusionChanges.length - 1];
        if (event.timeInMinutes === last.time) {
            last.rateUgHr = event.continuousUgHr;
        } else {
            infusionChanges.push({ time: event.timeInMinutes, rateUgHr: event.continuousUgHr });
        }
    }

    return { boluses, infusionChanges };
}

/** Infusion rate (ug/hr) in force at time t. */
function infusionRateAt(infusionChanges, t) {
    let rate = 0;
    for (const change of infusionChanges) {
        if (change.time <= t + 1e-9) rate = change.rateUgHr;
        else break;
    }
    return rate;
}

/**
 * Runs the simulation for one PK parameter set.
 * Returns time (min), Cp and Ce (ng/mL) and the infusion rate (ug/hr) on the
 * output grid, plus the final internal state so decrement times can start there.
 */
function simulateDoseRecord(doseEvents, pk, options = {}) {
    const dt = options.dt || SIM_DEFAULT_DT;
    const sampleInterval = options.sampleIntervalMin || SIM_DEFAULT_SAMPLE_INTERVAL;
    const { boluses, infusionChanges } = buildDoseSchedule(doseEvents);

    const lastEventTime = doseEvents && doseEvents.length
        ? Math.max(...doseEvents.map(e => e.timeInMinutes))
        : 0;
    const duration = options.durationMin || (lastEventTime + 120);

    const totalSteps = Math.round(duration / dt);
    const sampleEvery = Math.max(1, Math.round(sampleInterval / dt));

    let state = { a1: 0, a2: 0, a3: 0, ce: 0 };
    let bolusIndex = 0;

    const times = [];
    const cp = [];
    const ce = [];
    const rates = [];

    for (let i = 0; i <= totalSteps; i++) {
        const t = i * dt;

        while (bolusIndex < boluses.length && boluses[bolusIndex].time <= t + dt / 2) {
            state.a1 += boluses[bolusIndex].doseUg;
            bolusIndex++;
        }

        const rateUgHr = infusionRateAt(infusionChanges, t);

        if (i % sampleEvery === 0 || i === totalSteps) {
            times.push(t);
            cp.push(plasmaConcentration(state, pk));
            ce.push(state.ce);
            rates.push(rateUgHr);
        }

        if (i < totalSteps) {
            state = rk4Step(state, rateUgHr / 60.0, pk, dt);
        }
    }

    return {
        times, cp, ce, rates,
        finalState: state,
        maxCp: cp.length ? Math.max(...cp) : 0,
        maxCe: ce.length ? Math.max(...ce) : 0,
        durationMin: duration
    };
}

/**
 * Context-sensitive decrement time: minutes from `state` until Ce first falls
 * below each threshold with every infusion stopped. Returns null for a
 * threshold that is not reached within DECREMENT_HORIZON_MIN, and 0 for a
 * threshold already below Ce.
 */
function decrementTimes(state, pk, thresholds, options = {}) {
    const dt = options.dt || 0.05;
    const horizon = options.horizonMin || DECREMENT_HORIZON_MIN;
    const remaining = thresholds.map((value, index) => ({ value, index }))
        .filter(t => state.ce > t.value);

    const result = thresholds.map(v => (state.ce > v ? null : 0));
    if (remaining.length === 0) return result;

    let s = { a1: state.a1, a2: state.a2, a3: state.a3, ce: state.ce };
    const steps = Math.round(horizon / dt);
    let pending = remaining;

    for (let i = 1; i <= steps && pending.length > 0; i++) {
        s = rk4Step(s, 0, pk, dt);
        const t = i * dt;
        const stillPending = [];
        for (const target of pending) {
            if (s.ce <= target.value) result[target.index] = t;
            else stillPending.push(target);
        }
        pending = stillPending;
    }

    return result;
}

/**
 * Steady-state infusion rate (ug/hr) that holds Cp at the given target.
 * At steady state the whole dose is cleared, so rate = CL * target.
 * Ce equals Cp at steady state, so this is also the rate that maintains a
 * target Ce once equilibrium is reached.
 */
function maintenanceRateUgHr(targetConcentration, pk) {
    return targetConcentration * pk.cl * 60.0;
}

/**
 * Loading bolus (ug) whose peak Ce equals the target, given an empty patient.
 * Uses the unit-bolus peak Ce so the scaling is exact for a single bolus.
 */
function loadingBolusUg(targetCe, pk) {
    const { peakCe } = timeToPeakEffect(pk);
    if (!(peakCe > 0)) return NaN;
    return targetCe / peakCe;
}

/**
 * Minutes for Ce to reach the given fraction of its steady-state value under a
 * constant infusion started in an empty patient. The system is linear, so the
 * answer does not depend on the infusion rate.
 *
 * This matters for fentanyl specifically. rate = Ce * CL is exact at steady
 * state, but the third compartment is large (V3 around 300 L) and empties
 * slowly (k31 under 0.01 /min), so a rate computed from that relation sits well
 * below its target for hours. Reporting the maintenance rate without this
 * number invites reading it as "the rate that gets you there".
 */
function timeToSteadyStateFraction(pk, fraction = 0.9, horizonMin = 6000, dt = 0.1) {
    const unitRateUgMin = 1.0;
    const steadyState = unitRateUgMin / pk.cl;   // Cp = Ce at steady state
    const target = fraction * steadyState;

    let state = { a1: 0, a2: 0, a3: 0, ce: 0 };
    const steps = Math.round(horizonMin / dt);
    for (let i = 1; i <= steps; i++) {
        state = rk4Step(state, unitRateUgMin, pk, dt);
        if (state.ce >= target) return i * dt;
    }
    return null;
}

if (typeof window !== 'undefined') {
    window.buildDoseSchedule = buildDoseSchedule;
    window.infusionRateAt = infusionRateAt;
    window.simulateDoseRecord = simulateDoseRecord;
    window.decrementTimes = decrementTimes;
    window.maintenanceRateUgHr = maintenanceRateUgHr;
    window.loadingBolusUg = loadingBolusUg;
    window.timeToSteadyStateFraction = timeToSteadyStateFraction;
    window.SIM_DEFAULT_DT = SIM_DEFAULT_DT;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildDoseSchedule, infusionRateAt, simulateDoseRecord,
        decrementTimes, maintenanceRateUgHr, loadingBolusUg, timeToSteadyStateFraction,
        SIM_DEFAULT_DT, SIM_DEFAULT_SAMPLE_INTERVAL
    };
}
