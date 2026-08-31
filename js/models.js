/**
 * Data models, constants and validation for the Fentanyl Ce simulator.
 *
 * Unit convention used throughout the application:
 *   amount        micrograms (ug)
 *   volume        litres (L)
 *   concentration ng/mL  (== ug/L, so amount[ug] / volume[L] is already ng/mL)
 *   clearance     L/min
 *   rate          ug/hr on the UI, ug/min inside the integrators
 *   time          minutes
 */

const SexType = {
    MALE: 0,
    FEMALE: 1,
    displayName(value) {
        return value === this.MALE ? '男性' : '女性';
    }
};

const AsapsType = {
    CLASS_1_2: 0,
    CLASS_3_4: 1,
    displayName(value) {
        return value === this.CLASS_1_2 ? 'ASA I-II' : 'ASA III-IV';
    }
};

const ValidationLimits = {
    Patient: {
        minimumAge: 18,
        maximumAge: 100,
        minimumWeight: 30.0,
        maximumWeight: 200.0,
        minimumHeight: 130.0,
        maximumHeight: 220.0,
        minimumBMI: 12.0,
        maximumBMI: 50.0
    },
    Dosing: {
        minimumTime: 0,
        maximumTime: 1440,
        minimumBolus: 0.0,
        maximumBolus: 2000.0,      // ug
        minimumContinuous: 0.0,
        maximumContinuous: 1000.0  // ug/hr
    }
};

/**
 * Patient demographics. Fentanyl models implemented here take body weight only;
 * height/sex/ASA are recorded for the anaesthesia chart and for BMI display,
 * and are not covariates of either PK model.
 */
class Patient {
    constructor(id, age, weight, height, sex, asaPS, anesthesiaStartTime = null) {
        this.id = id;
        this.age = age;
        this.weight = weight;
        this.height = height;
        this.sex = sex;
        this.asaPS = asaPS;
        this.anesthesiaStartTime = anesthesiaStartTime || new Date();
    }

    get bmi() {
        return this.weight / Math.pow(this.height / 100, 2);
    }

    minutesToClockTime(minutesFromStart) {
        return new Date(this.anesthesiaStartTime.getTime() + minutesFromStart * 60000);
    }

    clockTimeToMinutes(clockTime) {
        return (clockTime.getTime() - this.anesthesiaStartTime.getTime()) / 60000;
    }

    get formattedStartTime() {
        return this.anesthesiaStartTime.toLocaleTimeString('ja-JP', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    validate() {
        const errors = [];
        const L = ValidationLimits.Patient;

        if (!this.id || this.id.trim().length === 0) {
            errors.push('患者 ID を入力してください');
        }
        if (!isFinite(this.age) || this.age < L.minimumAge || this.age > L.maximumAge) {
            errors.push(`年齢は ${L.minimumAge}〜${L.maximumAge} 歳の範囲で入力してください`);
        }
        if (!isFinite(this.weight) || this.weight < L.minimumWeight || this.weight > L.maximumWeight) {
            errors.push(`体重は ${L.minimumWeight}〜${L.maximumWeight} kg の範囲で入力してください`);
        }
        if (!isFinite(this.height) || this.height < L.minimumHeight || this.height > L.maximumHeight) {
            errors.push(`身長は ${L.minimumHeight}〜${L.maximumHeight} cm の範囲で入力してください`);
        }
        if (isFinite(this.bmi) && (this.bmi < L.minimumBMI || this.bmi > L.maximumBMI)) {
            errors.push(`BMI が範囲外です (計算値: ${this.bmi.toFixed(1)})`);
        }

        return { isValid: errors.length === 0, errors };
    }

    toJSON() {
        return {
            id: this.id,
            age: this.age,
            weight: this.weight,
            height: this.height,
            sex: this.sex,
            asaPS: this.asaPS,
            anesthesiaStartTime: this.anesthesiaStartTime.toISOString()
        };
    }

    static fromJSON(obj) {
        const start = obj.anesthesiaStartTime ? new Date(obj.anesthesiaStartTime) : null;
        return new Patient(obj.id, obj.age, obj.weight, obj.height, obj.sex, obj.asaPS, start);
    }
}

/**
 * One entry on the anaesthesia record: a bolus given at this time and/or the
 * infusion rate that applies from this time until the next event.
 */
class DoseEvent {
    constructor(timeInMinutes, bolusUg, continuousUgHr) {
        this.timeInMinutes = timeInMinutes;
        this.bolusUg = bolusUg;
        this.continuousUgHr = continuousUgHr;
    }

    get continuousUgMin() {
        return this.continuousUgHr / 60.0;
    }

    formattedClockTime(patient) {
        return patient.minutesToClockTime(this.timeInMinutes).toLocaleTimeString('ja-JP', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    validate() {
        const errors = [];
        const L = ValidationLimits.Dosing;

        if (!isFinite(this.timeInMinutes) || this.timeInMinutes < L.minimumTime || this.timeInMinutes > L.maximumTime) {
            errors.push(`投与時刻は麻酔開始から ${L.minimumTime}〜${L.maximumTime} 分の範囲にしてください`);
        }
        if (!isFinite(this.bolusUg) || this.bolusUg < L.minimumBolus || this.bolusUg > L.maximumBolus) {
            errors.push(`ボーラス量は ${L.minimumBolus}〜${L.maximumBolus} µg の範囲で入力してください`);
        }
        if (!isFinite(this.continuousUgHr) || this.continuousUgHr < L.minimumContinuous || this.continuousUgHr > L.maximumContinuous) {
            errors.push(`持続投与量は ${L.minimumContinuous}〜${L.maximumContinuous} µg/hr の範囲で入力してください`);
        }

        return { isValid: errors.length === 0, errors };
    }

    toJSON() {
        return {
            timeInMinutes: this.timeInMinutes,
            bolusUg: this.bolusUg,
            continuousUgHr: this.continuousUgHr
        };
    }

    static fromJSON(obj) {
        return new DoseEvent(obj.timeInMinutes, obj.bolusUg, obj.continuousUgHr);
    }
}

/** Three-compartment state plus the effect compartment. Amounts in ug, Ce in ng/mL. */
class SystemState {
    constructor(a1 = 0.0, a2 = 0.0, a3 = 0.0, ce = 0.0) {
        this.a1 = a1;
        this.a2 = a2;
        this.a3 = a3;
        this.ce = ce;
    }
}

/** One snapshot recorded by the user during the real-time run. */
class RealtimeSnapshot {
    constructor(label, elapsedMinutes, results) {
        this.label = label;
        this.elapsedMinutes = elapsedMinutes;
        this.results = results;   // { modelId: {cp, ce}, ... }
        this.recordedAt = new Date();
    }

    get formattedTime() {
        const totalSeconds = Math.floor(this.elapsedMinutes * 60);
        const mm = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
        const ss = (totalSeconds % 60).toString().padStart(2, '0');
        return `${mm}:${ss}`;
    }
}

/** Session file format for saving and restoring the full input state. */
const FentanylSession = {
    FORMAT: 'fentanyl-ce-session',
    VERSION: '1.0',

    build(patient, doseEvents, appVersion = '', observations = []) {
        return {
            format: this.FORMAT,
            version: this.VERSION,
            appVersion: appVersion,
            savedAt: new Date().toISOString(),
            patient: patient ? patient.toJSON() : null,
            doseEvents: (doseEvents || []).map(e => e.toJSON()),
            observations: (observations || []).map(o => o.toJSON())
        };
    },

    parse(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('JSON として読み取れませんでした: ' + e.message);
        }

        if (!data || data.format !== this.FORMAT) {
            throw new Error('このファイルは Fentanyl Ce Simulator のセッションファイルではありません。');
        }
        if (!data.patient) {
            throw new Error('セッションファイルに患者情報が含まれていません。');
        }

        const patient = Patient.fromJSON(data.patient);
        const doseEvents = Array.isArray(data.doseEvents)
            ? data.doseEvents.map(e => DoseEvent.fromJSON(e))
            : [];
        // Sessions written before analgesia observations existed simply have none.
        const observations = Array.isArray(data.observations)
            ? data.observations.map(o => AnalgesiaObservation.fromJSON(o))
            : [];

        return { patient, doseEvents, observations,
                 savedAt: data.savedAt || null, appVersion: data.appVersion || '' };
    }
};

if (typeof window !== 'undefined') {
    window.SexType = SexType;
    window.AsapsType = AsapsType;
    window.ValidationLimits = ValidationLimits;
    window.Patient = Patient;
    window.DoseEvent = DoseEvent;
    window.SystemState = SystemState;
    window.RealtimeSnapshot = RealtimeSnapshot;
    window.FentanylSession = FentanylSession;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SexType, AsapsType, ValidationLimits,
        Patient, DoseEvent, SystemState, RealtimeSnapshot, FentanylSession
    };
}
