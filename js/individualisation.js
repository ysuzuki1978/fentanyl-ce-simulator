/**
 * Per-patient estimation of the minimum effective analgesic concentration.
 *
 * The population curve in analgesia.js answers "in what fraction of patients is
 * this Ce enough". It is a monotone transform of Ce, so it carries exactly the
 * information Ce carries. This module answers a different question — "is this Ce
 * enough for THIS patient" — by treating each recorded judgement of adequate or
 * inadequate analgesia as an observation about that patient's own threshold and
 * updating a posterior over it. Once even one observation exists the readout is
 * no longer a function of Ce alone.
 *
 * ---------------------------------------------------------------------------
 * The model
 *
 * Let m be the patient's own MEAC. Work in ln m, where both the population
 * spread and the observation noise are logistic.
 *
 *   prior     ln m ~ Logistic( ln 0.99 , s_between )
 *   likelihood  P(adequate | Ce = c, m) = 1 / (1 + exp( -(ln c - ln m) / s_within ))
 *
 * Both scales are derived from published statistics rather than chosen:
 *
 *   s_total   from Bae 2020's MEAC quartiles. analgesia.js fits
 *             gamma = 4.215, and a log-logistic with shape gamma has
 *             scale 1/gamma in ln-space. That spread is the TOTAL variability
 *             Bae observed — between patients and within a patient combined.
 *
 *   s_within  from Gourlay 1988 (PMID 3354866), which measured the
 *             within-patient coefficient of variation of the threshold on
 *             repeated determinations: 30.2% (range 16-46%). A CV of 0.302 is
 *             an SD of sqrt(ln(1 + 0.302^2)) = 0.295 in ln-space.
 *
 *   s_between by variance decomposition, sd_between^2 = sd_total^2 - sd_within^2.
 *
 * The decomposition is what makes the construction self-consistent: integrating
 * the likelihood over the prior reproduces the published population curve, so
 * with no observations the individualised readout degrades exactly to the
 * population readout. `validate-individualisation.js` checks that numerically.
 *
 * ---------------------------------------------------------------------------
 * What this is NOT
 *
 * - The prior comes from Bae's postoperative PACU population and the
 *   within-patient CV from Gourlay's postoperative PCA population. Both are
 *   postoperative. Applying the result to intraoperative surgical stimulation
 *   is an extrapolation the sources do not support.
 * - The estimate is conditional on the PK model used to compute Ce at each
 *   observation. The three models in this app differ by up to a factor of 1.8,
 *   and that error is absorbed into the estimated threshold. The estimate must
 *   therefore always be reported together with the model that produced it.
 * - Bouillon 2004 (PMID 15166553) showed an opioid alone cannot ablate
 *   responses; it works by synergy with the hypnotic. A fentanyl-only threshold
 *   has a ceiling on how well it can predict intraoperative responses.
 */

const GOURLAY_WITHIN_PATIENT_CV = 0.302;   // Gourlay 1988, PMID 3354866

/** SD of a logistic distribution with the given scale. */
function sdFromLogisticScale(scale) {
    return (scale * Math.PI) / Math.sqrt(3);
}

/** Scale of a logistic distribution with the given SD. */
function logisticScaleFromSd(sd) {
    return (sd * Math.sqrt(3)) / Math.PI;
}

/** SD in ln-space implied by a coefficient of variation. */
function sdLogFromCv(cv) {
    return Math.sqrt(Math.log(1 + cv * cv));
}

/** Logistic density at x. */
function logisticPdf(x, location, scale) {
    const z = (x - location) / scale;
    const e = Math.exp(-Math.abs(z));
    return e / (scale * (1 + e) * (1 + e));
}

/** One recorded clinical judgement. */
class AnalgesiaObservation {
    constructor(timeInMinutes, adequate) {
        this.timeInMinutes = timeInMinutes;
        this.adequate = !!adequate;
    }

    formattedClockTime(patient) {
        return patient.minutesToClockTime(this.timeInMinutes).toLocaleTimeString('ja-JP', {
            hour: '2-digit', minute: '2-digit', hour12: false
        });
    }

    validate() {
        const errors = [];
        if (!isFinite(this.timeInMinutes) || this.timeInMinutes < 0 || this.timeInMinutes > 1440) {
            errors.push('評価時刻は麻酔開始から 0〜1440 分の範囲にしてください');
        }
        return { isValid: errors.length === 0, errors };
    }

    toJSON() {
        return { timeInMinutes: this.timeInMinutes, adequate: this.adequate };
    }

    static fromJSON(obj) {
        return new AnalgesiaObservation(obj.timeInMinutes, obj.adequate);
    }
}

const IndividualMEAC = {
    withinPatientCv: GOURLAY_WITHIN_PATIENT_CV,
    withinPatientSource: 'Gourlay 1988 (PMID 3354866): 患者内 CV 30.2% (16-46%)',

    GRID_MIN: 0.05,     // ng/mL
    GRID_MAX: 20.0,
    GRID_POINTS: 801,

    /**
     * Variance decomposition of the population MEAC spread into a between- and
     * a within-patient component. Recomputed on each call so that editing the
     * within-patient CV, or the population fit in analgesia.js, stays consistent.
     */
    scales() {
        const median = Analgesia.MEAC.median;
        const sdTotal = sdFromLogisticScale(1 / Analgesia.MEAC.gamma);
        const sdWithin = sdLogFromCv(this.withinPatientCv);
        const varBetween = sdTotal * sdTotal - sdWithin * sdWithin;

        // A within-patient CV large enough to exceed the whole population spread
        // would leave no between-patient variance to estimate. Guard rather than
        // return a NaN posterior.
        const degenerate = !(varBetween > 0);
        const sdBetween = degenerate ? sdTotal * 0.2 : Math.sqrt(varBetween);

        return {
            median,
            location: Math.log(median),
            sdTotal, sdWithin, sdBetween,
            scaleTotal: logisticScaleFromSd(sdTotal),
            scaleWithin: logisticScaleFromSd(sdWithin),
            scaleBetween: logisticScaleFromSd(sdBetween),
            degenerate
        };
    },

    /** Uniform grid in ln(concentration). */
    grid() {
        const lo = Math.log(this.GRID_MIN);
        const hi = Math.log(this.GRID_MAX);
        const step = (hi - lo) / (this.GRID_POINTS - 1);
        const x = new Array(this.GRID_POINTS);
        for (let i = 0; i < this.GRID_POINTS; i++) x[i] = lo + i * step;
        return { x, step };
    },

    /** P(judged adequate | Ce = c, threshold m). Logistic in ln-concentration. */
    probabilityAdequateGivenThreshold(ce, m, scaleWithin) {
        if (!(ce > 0)) return 0;
        return 1 / (1 + Math.exp(-(Math.log(ce) - Math.log(m)) / scaleWithin));
    },

    /**
     * Posterior over the patient's own MEAC.
     * `observations` are {ce, adequate}; an observation whose Ce is not positive
     * carries no information and is skipped.
     */
    posterior(observations) {
        const s = this.scales();
        const { x, step } = this.grid();
        const n = x.length;

        const priorDensity = new Array(n);
        const logPosterior = new Array(n);

        for (let i = 0; i < n; i++) {
            priorDensity[i] = logisticPdf(x[i], s.location, s.scaleBetween);
            logPosterior[i] = Math.log(priorDensity[i] + Number.MIN_VALUE);
        }

        let used = 0;
        for (const obs of (observations || [])) {
            if (!(obs.ce > 0)) continue;
            used++;
            const lnCe = Math.log(obs.ce);
            for (let i = 0; i < n; i++) {
                const z = (lnCe - x[i]) / s.scaleWithin;
                // log of the logistic CDF, and of its complement, without overflow
                const logP = z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z));
                const logQ = z >= 0 ? -z - Math.log1p(Math.exp(-z)) : -Math.log1p(Math.exp(z));
                logPosterior[i] += obs.adequate ? logP : logQ;
            }
        }

        const maxLog = Math.max(...logPosterior);
        const density = logPosterior.map(v => Math.exp(v - maxLog));

        const area = this.trapezoid(density, step);
        for (let i = 0; i < n; i++) density[i] /= area;

        const priorArea = this.trapezoid(priorDensity, step);
        const normalisedPrior = priorDensity.map(v => v / priorArea);

        return {
            x, step, density,
            priorDensity: normalisedPrior,
            scales: s,
            observationCount: used
        };
    },

    trapezoid(y, step) {
        let sum = 0;
        for (let i = 1; i < y.length; i++) sum += (y[i] + y[i - 1]) / 2;
        return sum * step;
    },

    /** Quantile of the posterior, returned on the concentration scale. */
    quantile(posterior, p) {
        const { x, step, density } = posterior;
        let cumulative = 0;
        for (let i = 1; i < x.length; i++) {
            const slice = ((density[i] + density[i - 1]) / 2) * step;
            if (cumulative + slice >= p) {
                const within = slice > 0 ? (p - cumulative) / slice : 0;
                return Math.exp(x[i - 1] + within * step);
            }
            cumulative += slice;
        }
        return Math.exp(x[x.length - 1]);
    },

    summary(posterior) {
        return {
            median: this.quantile(posterior, 0.5),
            lower: this.quantile(posterior, 0.05),
            upper: this.quantile(posterior, 0.95),
            observationCount: posterior.observationCount
        };
    },

    /**
     * Posterior predictive probability that this patient is adequately
     * analgesed at the given Ce, marginalising over their unknown threshold.
     * With no observations this equals the published population curve.
     */
    probabilityAdequate(ce, posterior) {
        if (!(ce > 0)) return 0;
        const { x, step, density, scales } = posterior;
        const lnCe = Math.log(ce);
        const integrand = new Array(x.length);
        for (let i = 0; i < x.length; i++) {
            const z = (lnCe - x[i]) / scales.scaleWithin;
            integrand[i] = density[i] / (1 + Math.exp(-z));
        }
        return this.trapezoid(integrand, step);
    },

    /** Individualised and population curves over a Ce range, for plotting. */
    curve(posterior, maxCe = 5.0, points = 200) {
        const ce = [];
        const individual = [];
        const population = [];
        for (let i = 0; i <= points; i++) {
            const value = (maxCe * i) / points;
            ce.push(value);
            individual.push(this.probabilityAdequate(value, posterior));
            population.push(Analgesia.probability(value, Analgesia.MEAC));
        }
        return { ce, individual, population };
    },

    /** Posterior density expressed on the concentration axis, for plotting. */
    densityOnConcentrationAxis(posterior) {
        const { x, density, priorDensity } = posterior;
        // p(m) dm = p(ln m) d(ln m), so dividing by m converts the density.
        return x.map((value, i) => {
            const m = Math.exp(value);
            return { ce: m, posterior: density[i] / m, prior: priorDensity[i] / m };
        });
    }
};

if (typeof window !== 'undefined') {
    window.AnalgesiaObservation = AnalgesiaObservation;
    window.IndividualMEAC = IndividualMEAC;
    window.GOURLAY_WITHIN_PATIENT_CV = GOURLAY_WITHIN_PATIENT_CV;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        AnalgesiaObservation, IndividualMEAC, GOURLAY_WITHIN_PATIENT_CV,
        sdFromLogisticScale, logisticScaleFromSd, sdLogFromCv, logisticPdf
    };
}
