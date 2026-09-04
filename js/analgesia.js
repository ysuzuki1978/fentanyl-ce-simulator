/**
 * Turning a predicted fentanyl effect-site concentration into an analgesia
 * readout.
 *
 * Every number in this module is traceable to a named publication. Where a
 * continuous curve is needed but the source publishes only discrete summary
 * statistics, the interpolation is stated explicitly and reproduces the
 * published points; nothing here is a guessed constant.
 *
 * Sources
 * -------
 * Postoperative analgesia
 *   Bae J, Kwon M, Lee YH, Lee EK, Choi BM, Noh GJ. Br J Anaesth
 *     2020;125:976-85 (PMID 32861508). n=30 after major abdominal open surgery,
 *     PACU, VAS-driven titration. MEC median 0.72 (IQR 0.58-1.05) ng/mL,
 *     MEAC median 0.99 (IQR 0.76-1.28) ng/mL.
 *   Gourlay GK, Kowalski SR, Plummer JL, Cousins MJ, Armstrong PJ. Anesth Analg
 *     1988;67:329-37 (PMID 3354866). n=30 abdominal surgery, PCA demand-based.
 *     MEC 0.63 +/- 0.25 ng/mL (range 0.23-1.18).
 *   Lehmann KA, Heinrich C, van Heiss R. Acta Anaesthesiol Belg 1988;39:11-23
 *     (PMID 3369270). Postoperative MEC median 1.2 ng/mL (range 0.2-8.0, n=40).
 *
 * Intraoperative potency
 *   McEwan AI, Smith C, Dyar O, Goodman D, Smith LR, Glass PS. Anesthesiology
 *     1993;78:864-9 (PMID 8489058). Isoflurane MAC reduction: 50% at
 *     1.67 ng/mL, 63% at 3 ng/mL, a further 19% only by 10 ng/mL (~82% ceiling).
 *   Glass PS, Doherty M, Jacobs JR, Goodman D, Smith LR. Anesthesiology
 *     1993;78:842-7 (PMID 8489055). With 70% N2O, Cp50 for skin incision
 *     3.26 ng/mL; Cp50-BAR (movement, haemodynamic and autonomic response all
 *     suppressed) 4.17 ng/mL.
 *   Kazama T, Ikeda K, Morita K. Anesthesiology 1997;87:213-27 (PMID 9286884).
 *     Fentanyl 1 ng/mL lowers the propofol Cp50 for tetanic stimulus,
 *     laryngoscopy, intubation and incision by 31-34%; 3 ng/mL by 50-55%.
 *
 * Respiratory effect
 *   Cartwright P, Prys-Roberts C, Gill K, Dye A, Stafford M, Gray A. Anesth
 *     Analg 1983;62:966-74 (PMID 6414339). CO2 response curve depressed by 50%
 *     at 1.5-3.0 ng/mL.
 *   Mildh LH, Scheinin H, Kirvela OA. Anesth Analg 2001;93:939-46
 *     (PMID 11574361). EC50 for a 50% fall in respiratory rate 3.5 +/- 1.4,
 *     for a 50% fall in minute ventilation 6.1 +/- 1.4 ng/mL.
 *   Boom M, Olofsen E, et al. Anesthesiology 2013;119:663-74 (PMID 23756452).
 *     The analgesia-minus-respiratory-depression utility turns negative above
 *     about 0.5 ng/mL after a 3.5 ug/kg bolus.
 *
 * NOT implemented, because no primary source was found for them:
 *   - a Ce50 for fentanyl alone against tracheal intubation
 *   - a "respiratory depression begins at 1.5-2 ng/mL" threshold; the closest
 *     sourced statement is Cartwright's 1.5-3.0 ng/mL for an already halved
 *     CO2 response, which is a different claim and is shown as such.
 */

/**
 * Log-logistic population curve through a published median and IQR.
 *
 * MEC and MEAC are per-patient thresholds, so the distribution of that
 * threshold across the study population, evaluated at Ce, is the fraction of
 * patients for whom Ce reaches their own threshold:
 *     P(Ce) = 1 / (1 + (median/Ce)^gamma)
 * gamma is fixed by the quartiles rather than chosen:
 *     gamma = 2*ln(3) / ln(Q3/Q1)
 * so the curve passes through 25% at Q1, 50% at the median and 75% at Q3 when
 * the reported IQR is symmetric in log space, and splits the difference when it
 * is not.
 */
function fitLogLogistic(median, q1, q3) {
    return {
        median,
        q1,
        q3,
        gamma: (2 * Math.log(3)) / Math.log(q3 / q1)
    };
}

/**
 * Hyperbolic Emax fitted to two published (concentration, effect) points.
 *     E(c) = Emax * c / (C50 + c)
 */
function fitHyperbolicEmax(c1, e1, c2, e2) {
    const c50 = (c1 * c2 * (e1 - e2)) / (e2 * c1 - e1 * c2);
    const emax = (e1 * (c50 + c1)) / c1;
    return { c50, emax };
}

const Analgesia = {
    MEC: {
        ...fitLogLogistic(0.72, 0.58, 1.05),
        label: 'MEC',
        source: 'Bae 2020 (PMID 32861508) median 0.72 / IQR 0.58-1.05'
    },

    MEAC: {
        ...fitLogLogistic(0.99, 0.76, 1.28),
        label: 'MEAC',
        source: 'Bae 2020 (PMID 32861508) median 0.99 / IQR 0.76-1.28'
    },

    /** Isoflurane MAC reduction, fitted to McEwan 1993 (50% at 1.67, 63% at 3). */
    MAC: {
        ...fitHyperbolicEmax(1.67, 50, 3.0, 63),
        source: 'Hyperbolic Emax fitted to the three published points of McEwan 1993 (PMID 8489058)'
    },

    SCALE_MAX: 6.0,
    SCALE_TICKS: [0, 1, 2, 3, 4, 5, 6],

    BANDS: [
        {
            id: 'sub',
            name: 'Sub-analgesic',
            min: 0, max: 0.63,
            rangeLabel: '< 0.63',
            color: '#6E7681',
            description: 'Below the mean minimum concentration reported as effective for postoperative analgesia.',
            source: 'Gourlay 1988 (PMID 3354866): MEC 0.63 ± 0.25 ng/mL'
        },
        {
            id: 'mec',
            name: 'MEC band',
            min: 0.63, max: 0.99,
            rangeLabel: '0.63 – 0.99',
            color: '#D4A017',
            description: 'Pain at rest begins to ease in some patients, but most have not yet reached the concentration judged adequate for analgesia.',
            source: 'Gourlay 1988 (PMID 3354866) MEC 0.63 / Bae 2020 (PMID 32861508) MEC median 0.72'
        },
        {
            id: 'meac',
            name: 'Postoperative analgesia',
            min: 0.99, max: 1.67,
            rangeLabel: '0.99 – 1.67',
            color: '#2FBFA8',
            description: 'Above the median concentration judged adequate in the PACU after open abdominal surgery. Postoperative pain is controlled in more than half of patients.',
            source: 'Bae 2020 (PMID 32861508): MEAC median 0.99 (IQR 0.76-1.28) ng/mL'
        },
        {
            id: 'mac',
            name: 'Intraoperative adjunct',
            min: 1.67, max: 3.26,
            rangeLabel: '1.67 – 3.26',
            color: '#5BA4CF',
            description: 'Reduces isoflurane MAC by 50% or more. The propofol Cp50 also falls by 30-55%.',
            source: 'McEwan 1993 (PMID 8489058): 50% MAC reduction at 1.67 ng/mL / Kazama 1997 (PMID 9286884)'
        },
        {
            id: 'incision',
            name: 'High-stimulus range',
            min: 3.26, max: 4.17,
            rangeLabel: '3.26 – 4.17',
            color: '#9B72B0',
            description: 'From the concentration that suppresses movement to skin incision in half of patients under 70% N2O, up to the concentration that also suppresses the haemodynamic and autonomic response.',
            source: 'Glass 1993 (PMID 8489055): skin incision Cp50 3.26 / Cp50-BAR 4.17 ng/mL'
        },
        {
            id: 'high',
            name: 'High concentration',
            min: 4.17, max: Infinity,
            rangeLabel: '≥ 4.17',
            color: '#D85A30',
            description: 'The fall in respiratory rate becomes marked in spontaneously breathing patients. Check the Ce decrement time before planning extubation.',
            source: 'Mildh 2001 (PMID 11574361): EC50 3.5 for a 50% fall in respiratory rate, 6.1 ng/mL for a 50% fall in minute ventilation'
        }
    ],

    /** Thresholds offered in the decrement-time panel. */
    DECREMENT_THRESHOLDS: [
        { value: 1.67, label: '50% isoflurane MAC reduction (McEwan 1993)' },
        { value: 0.99, label: 'MEAC median (Bae 2020)' },
        { value: 0.72, label: 'MEC median (Bae 2020)' },
        { value: 0.50, label: 'Analgesia-minus-respiratory-depression utility boundary (Boom 2013)' }
    ],

    FOOTNOTE:
        'These bands place values from different studies and different endpoints on a single Ce axis. ' +
        'The postoperative MEC / MEAC are referenced to VAS at rest and on movement in the PACU after open abdominal surgery, which is a different concept from the concentration required against intraoperative surgical stimulus. ' +
        'The intraoperative values (MAC reduction, skin-incision Cp50) were obtained with a volatile agent or N2O co-administered and are not fentanyl-alone values. ' +
        'A fentanyl-alone Ce50 for tracheal intubation is not shown, because no primary source for it could be verified.',

    /** Fraction of the study population whose own threshold is reached at ce. */
    probability(ce, anchor) {
        if (!(ce > 0)) return 0;
        return 1 / (1 + Math.pow(anchor.median / ce, anchor.gamma));
    },

    /** Percent reduction in isoflurane MAC at ce. */
    macReduction(ce) {
        if (!(ce > 0)) return 0;
        return (this.MAC.emax * ce) / (this.MAC.c50 + ce);
    },

    bandFor(ce) {
        const value = isFinite(ce) && ce > 0 ? ce : 0;
        for (const band of this.BANDS) {
            if (value >= band.min && value < band.max) return band;
        }
        return this.BANDS[this.BANDS.length - 1];
    },

    /** Sourced description of the respiratory situation at ce. */
    respiratoryStatus(ce) {
        if (ce < 0.5) {
            return {
                display: 'Baseline',
                source: 'Boom 2013 (PMID 23756452): the analgesia-minus-respiratory-depression utility is positive below 0.5 ng/mL'
            };
        }
        if (ce < 1.5) {
            return {
                display: 'Mild',
                source: 'Boom 2013 (PMID 23756452): the utility turns negative above 0.5 ng/mL'
            };
        }
        if (ce < 3.5) {
            return {
                display: 'Reduced CO2 response',
                source: 'Cartwright 1983 (PMID 6414339): the CO2 response curve is depressed by 50% at 1.5-3.0 ng/mL'
            };
        }
        if (ce < 6.1) {
            return {
                display: 'Reduced respiratory rate',
                source: 'Mildh 2001 (PMID 11574361): EC50 3.5 ng/mL for a 50% fall in respiratory rate'
            };
        }
        return {
            display: 'Reduced minute ventilation',
            source: 'Mildh 2001 (PMID 11574361): EC50 6.1 ng/mL for a 50% fall in minute ventilation'
        };
    },

    /** Everything the UI panel needs for one Ce value. */
    evaluate(ce) {
        const value = isFinite(ce) && ce > 0 ? ce : 0;
        const pMeac = this.probability(value, this.MEAC);
        const pMec = this.probability(value, this.MEC);
        const mac = this.macReduction(value);
        const resp = this.respiratoryStatus(value);

        return {
            ce: value,
            band: this.bandFor(value),
            metrics: [
                {
                    key: 'pMeac',
                    label: 'Patients with postoperative pain controlled',
                    display: (pMeac * 100).toFixed(0),
                    unit: '%',
                    fraction: pMeac,
                    source: this.MEAC.source
                },
                {
                    key: 'pMec',
                    label: 'Patients reaching their MEC',
                    display: (pMec * 100).toFixed(0),
                    unit: '%',
                    fraction: pMec,
                    source: this.MEC.source
                },
                {
                    key: 'mac',
                    label: 'Isoflurane MAC reduction',
                    display: mac.toFixed(0),
                    unit: '%',
                    fraction: mac / this.MAC.emax,
                    source: this.MAC.source
                },
                {
                    key: 'resp',
                    label: 'Effect on spontaneous ventilation',
                    display: resp.display,
                    unit: '',
                    fraction: null,
                    source: resp.source
                }
            ]
        };
    },

    /** Series for the Ce-response chart. */
    curveSeries(maxCe = 5.0, points = 250) {
        const ce = [];
        const pMeac = [];
        const pMec = [];
        const macFraction = [];
        for (let i = 0; i <= points; i++) {
            const value = (maxCe * i) / points;
            ce.push(value);
            pMeac.push(this.probability(value, this.MEAC));
            pMec.push(this.probability(value, this.MEC));
            macFraction.push(this.macReduction(value) / 100);
        }
        return { ce, pMeac, pMec, macFraction };
    }
};

if (typeof window !== 'undefined') {
    window.Analgesia = Analgesia;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Analgesia, fitLogLogistic, fitHyperbolicEmax };
}
