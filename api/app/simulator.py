"""Literature-calibrated simulator of people with sickle cell disease in Ghana, day by day.

Why: SickleGuard has no real outcome data yet. This simulator produces patients, daily check-ins, IoT device data,
EMR labs, imaging studies and vaso-occlusive crises (VOC) so the whole pipeline (features -> model -> evaluation ->
UI) can be built and tested. Every number comes from `docs/research/sim_params.json` (sources and confidence in
`docs/research/DATA_SOURCES.md`); most effect sizes there are LOW confidence placeholders. **Model performance on
these data is not clinical accuracy** - retrain and validate on real outcomes (the `crises` table) before any use.

Outcome = healthcare-utilisation VOC (ED / day hospital / admission; Platt 1991 definition), the event recorded in
the `crises` table. Prediction target: an onset in days t+1..t+7 given data up to day t.

Records come out in the same shapes as the database rows (Patient, CheckIn, Reading, LabResult, ImagingStudy,
Crisis) so `app.features.build` runs unchanged on simulated and real data.

Generative story per patient:
  traits (genotype, age, Hb, HbF, WBC, hydroxyurea, imaging history, frailty)
  -> daily environment (Ghana seasons by climate zone) and behaviour (fluids, sleep, stress, alcohol, exertion,
     menses, infections incl. malaria, hydroxyurea adherence)
  -> daily VOC hazard = personal rate x trigger rate ratios (+ recurrence after a crisis)
  -> crises with a short pre-crisis drift (prodrome; strength tunable, research says evidence beyond 1 day is weak),
     plus home-managed pain episodes that never reach hospital (realistic false alarms)
  -> what devices, check-ins and labs would have recorded (with missingness).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from typing import Optional

import numpy as np

# =====================================================================================================================
# Parameters (sim_params.json key in brackets; confidence H/M/L as in that file)
# =====================================================================================================================
GENOTYPE_RATE = {"HbSS": 0.8, "HbSβ0": 1.0, "HbSC": 0.4, "HbSβ+": 0.4}  # VOC/yr, Platt 1991 [per_genotype.*.annual_voc_rate] H
FRAILTY_K = 0.6                      # Gamma shape, mean 1 [between_patient_heterogeneity.gamma_shape_k] L
AGE_RR = [(2, 0.3), (10, 0.6), (20, 1.0), (30, 1.5), (40, 1.2), (200, 0.9)]   # [age_multiplier_voc_HbSS] L
HU_RR = 0.56                         # MSH [effect_sizes_voc.hydroxyurea.rate_ratio] H
HU_ADHERENCE = 0.6                   # [hydroxyurea.adherence_fraction_ghana] L
HU_COVERAGE_SS = 0.15                # share of HbSS on hydroxyurea [ghana_policy.hydroxyurea.coverage] L
HBF_RR_PER_PCT = 0.95                # [hbf_per_1pct_increase] L
WBC_RR_PER_UNIT = 1.04               # [baseline_wbc_per_1e9_increase] L
HB_RR_PER_G = 1.15                   # HbSS only [baseline_hb_per_1g_dl_increase_HbSS] L
NOCT_SPO2_RR_PER_PCT = 1.10          # per 1 % lower mean nocturnal SpO2 [low_nocturnal_spo2_trait] L
RECURRENCE_RR = 3.0                  # within 30 days of a VOC [recent_voc_within_30d] M
TRIGGER_RR = {                       # multiplicative on the daily hazard [effect_sizes_voc.*]
    "dehydration": (1.5, 2),         # (rate ratio, window days): intake < 1.5 L/day  L
    "infection": (2.5, 5),           # infection / fever incl. malaria  L
    "menses": (2.0, 0),              # susceptible women (28.2 %) days -7..+5 around onset  L/M
    "stress": (1.3, 2),              # high-stress day (>= 7/10)  L
    "short_sleep": (1.3, 1),         # < 6 h  L
    "alcohol": (1.3, 2),             # heavy-drinking day  L
    "exertion": (1.3, 1),            # strenuous exertion  L
    "cold_wind": (1.13, 1),          # windy/cold exposure, Nolan 2008 OR 1.13  M
    "low_humidity": (1.10, 0),       # harmattan dryness, Jones 2005 direction  L
    "rain": (1.05, 0),               # rainy season, London/Paris  L
}
MENSES_SUSCEPTIBLE = 0.282           # [menstruation_perimenstrual.fraction_women_susceptible] M
INFECTION_PER_YEAR = {"child": 2.0, "adult": 1.0}   # incl. malaria 0.3/yr [malaria_episode_ghana] L
UTILISATION_ADMITTED = 0.6           # [fraction_utilisation_vocs_admitted_vs_ed_discharged] L
LOS_ADULT = (3.0, 2.0, 4.0)          # median, IQR - Ghana DHIMS-II [los_days_ghana_all_scd_admissions] M
LOS_CHILD = (6.0, 4.0, 10.0)         # Kumasi paediatric [los_days_ghana_kumasi_paediatric] M
HOME_EPISODES_PER_VOC = 1.5          # home-managed crises per utilisation VOC (PiSCES 12.7 % vs 3.5 % days) M-derived
ACS_PER_ADMISSION = {"HbSS": 0.15, "HbSβ0": 0.12, "HbSC": 0.08, "HbSβ+": 0.06}   # Castro 1994 rates / VOC rates M
# Triggers, recurrence and infections push the realised rate above the genotype averages; this factor brings the
# simulated cohort back to Platt 1991 (checked in docs/MODEL_REPORT.md, "Simulated cohort vs literature").
RATE_CALIBRATION = 0.76
SIGNAL_STRENGTH = 1.0                # scales every pre-crisis drift; 0 = no prodrome [pre_crisis_trajectories.note]

# Pre-crisis drift, by days before onset (index 0 = day -1, 1 = day -2, 2 = day -3) [pre_crisis_trajectories] all L
PRODROME = {
    "pain": (1.8, 0.8, 0.3), "hr": (3.0, 1.0, 0.0), "hrv_pct": (-0.15, -0.05, 0.0), "steps_pct": (-0.30, -0.10, 0.0),
    "sleep_h": (-0.6, -0.2, 0.0), "fluid_l": (-0.4, -0.2, 0.0), "hb": (-0.2, 0.0, 0.0),
    "skin_infect": (0.7, 0.3, 0.0),           # only when the crisis is infection-triggered (25 %)
    "spo2": (0.0, 0.0, 0.0),                  # research: no change before onset (-0.5 on day 0)
    "resp": (0.5, 0.0, 0.0),                  # ASSUMPTION, no source found: small rise the day before
}
DURING = {"pain": 7.5, "hr": 12.0, "hrv_pct": -0.30, "spo2": -1.0, "spo2_acs": -4.0, "skin": 0.3,
          "steps_home": -0.70, "steps_admitted": -0.90, "sleep_h": -1.2, "hb": -0.7, "hb_acs": -1.0,
          "wbc": 3.0, "wbc_infect": 6.0, "crp": 30.0, "crp_acs": 80.0, "ldh_pct": 0.30, "retic_pct": 0.15}

# Wearable baselines [wearable_baselines_scd] mostly L
HR_BASE = {"adult": (78, 9), "child": (90, 10)}; HR_DAY_SD = 3.5
HRV_BASE = (30, 14); HRV_CV = 0.25
SPO2_AWAKE = (96.0, 1.2); SPO2_DAY_SD = 0.8; SPO2_NOCT_GAP = (1.5, 1.0); OXIMETER_OVERREAD = 1.0
SKIN_SD = 0.3
STEPS_BASE = {"adult": (5500, 2500), "child": (8000, 3000)}; STEPS_CV = 0.35
SLEEP_BASE = (6.8, 1.0); SLEEP_DAY_SD = 0.9
FLUID_BASE = (2.0, 0.6)
PAIN_ZERO_DAYS = 0.45; PAIN_WHEN_PRESENT = 3.5      # PiSCES steady state M
AR_PHI = 0.5
DEVICE_OWNERSHIP = {"wearable": 0.7, "pulse_oximeter": 0.55, "smart_bottle": 0.4, "thermometer": 0.65}   # assumption
DEVICE_DAY_MISSING = (0.15, 0.30)   # share of days with no data, per patient range [wearable_baselines_scd.note] L

# Labs [labs] (bilirubin in mg/dL as in the research file)
LAB_CATALOG = {  # code: name, unit, ref_low, ref_high - same names/units as app/labs.py CATALOGUE
    "hb": ("Haemoglobin", "g/dL", 12.0, 16.0), "wbc": ("White cell count", "×10⁹/L", 4.0, 11.0),
    "retic": ("Reticulocytes", "%", 0.5, 2.5), "ldh": ("Lactate dehydrogenase (LDH)", "U/L", 140.0, 280.0),
    "bili": ("Bilirubin (total)", "µmol/L", 3.0, 21.0), "hbf": ("Fetal haemoglobin (HbF)", "%", 0.0, 2.0),
    "crp": ("C-reactive protein (CRP)", "mg/L", 0.0, 5.0), "plt": ("Platelets", "×10⁹/L", 150.0, 400.0),
}
LAB_STEADY = {   # genotype group: code -> (mean, sd); bilirubin converted from the research file's mg/dL (x17.1)
    "SS": {"hb": (8.0, 1.2), "hbf": (6.0, 4.0), "wbc": (11.5, 3.0), "retic": (9.0, 4.0), "ldh": (450, 150),
           "bili": (51, 26), "plt": (400, 120), "crp": (6.0, 4.0)},
    "SC": {"hb": (11.0, 1.2), "hbf": (1.8, 1.5), "wbc": (8.0, 2.5), "retic": (3.5, 1.5), "ldh": (280, 80),
           "bili": (26, 12), "plt": (300, 90), "crp": (4.0, 3.0)},
}
LAB_NOISE_CV = 0.05
LAB_INTERVAL = {"steady": 120, "on_hu": 75}         # days [labs.testing_cadence] L/M
HBF_ON_HU = (15.0, 7.0)

# Imaging [imaging] M/L
TCD_ELEVATED_CHILD = 0.132; TCD_ABNORMAL_SS = 0.08; TCD_ABNORMAL_SC = 0.005
SCI_CUMULATIVE = [(6, 0.25), (18, 0.39), (30, 0.53)]; SCI_SC_MULT = 0.5
EVER_ACS_ADULT = {"SS": 0.5, "SC": 0.25}
AVN_PER_YEAR = {"HbSS": 0.024, "HbSβ0": 0.036, "HbSβ+": 0.033, "HbSC": 0.019}
SPLENOMEGALY = {"SC": 0.033, "SS_young": 0.30}

# Ghana regions: 2021 PHC population and climate/allele zone [ghana_policy.regions] H (population) / L (zone)
ZONE_ALLELES = {"south": (0.07, 0.045), "middle": (0.06, 0.065), "north": (0.052, 0.085), "far_north": (0.038, 0.128)}
REGIONS: list[tuple[str, int, str, list[tuple[str, str]]]] = [
    # name, population, zone, [(district, facility)] - facility names are used only as plausible locations for
    # fictional records
    ("Greater Accra", 5455692, "south", [("Accra Metropolitan", "Korle Bu Teaching Hospital"),
                                         ("Accra Metropolitan", "Greater Accra Regional Hospital (Ridge)"),
                                         ("Tema Metropolitan", "Tema General Hospital"),
                                         ("Ga East", "Ga East Municipal Hospital")]),
    ("Ashanti", 5440463, "south", [("Kumasi Metropolitan", "Komfo Anokye Teaching Hospital"),
                                   ("Obuasi Municipal", "Obuasi Government Hospital"),
                                   ("Ejisu Municipal", "Ejisu Government Hospital")]),
    ("Eastern", 2925653, "south", [("New Juaben South", "Eastern Regional Hospital, Koforidua"),
                                   ("Akuapem North", "Tetteh Quarshie Memorial Hospital")]),
    ("Central", 2859821, "south", [("Cape Coast Metropolitan", "Cape Coast Teaching Hospital"),
                                   ("Effutu Municipal", "Winneba Municipal Hospital")]),
    ("Northern", 2310939, "north", [("Tamale Metropolitan", "Tamale Teaching Hospital"),
                                    ("Yendi Municipal", "Yendi Municipal Hospital")]),
    ("Western", 2060585, "south", [("Sekondi-Takoradi Metropolitan", "Effia-Nkwanta Regional Hospital"),
                                   ("Tarkwa-Nsuaem Municipal", "Tarkwa Municipal Hospital")]),
    ("Volta", 1659040, "south", [("Ho Municipal", "Ho Teaching Hospital"),
                                 ("Keta Municipal", "Keta Municipal Hospital")]),
    ("Upper East", 1301226, "far_north", [("Bolgatanga Municipal", "Upper East Regional Hospital"),
                                          ("Bawku Municipal", "Bawku Presbyterian Hospital")]),
    ("Bono", 1208649, "middle", [("Sunyani Municipal", "Bono Regional Hospital"),
                                 ("Berekum Municipal", "Berekum Holy Family Hospital")]),
    ("Bono East", 1203400, "middle", [("Techiman Municipal", "Holy Family Hospital, Techiman"),
                                      ("Kintampo North Municipal", "Kintampo Municipal Hospital")]),
    ("Upper West", 901502, "far_north", [("Wa Municipal", "Upper West Regional Hospital")]),
    ("Western North", 880921, "south", [("Sefwi Wiawso Municipal", "Sefwi Wiawso Municipal Hospital")]),
    ("Oti", 747248, "middle", [("Biakoye", "Worawora Government Hospital"),
                               ("Nkwanta South Municipal", "Nkwanta Municipal Hospital")]),
    ("North East", 658946, "north", [("East Mamprusi Municipal", "Baptist Medical Centre, Nalerigu")]),
    ("Savannah", 653266, "north", [("West Gonja Municipal", "West Gonja Hospital, Damongo")]),
    ("Ahafo", 564668, "middle", [("Asunafo North Municipal", "Goaso Municipal Hospital")]),
]
REGION = {r[0]: r for r in REGIONS}
# Registered patients concentrate near the specialist centres (assumption for the synthetic registry)
CARE_ACCESS = {"Greater Accra": 1.6, "Ashanti": 1.5, "Northern": 1.1, "Central": 1.1, "Volta": 1.0}

# Climate by zone and month (0..1 intensities): harmattan Dec-Feb (stronger north), rains Apr-Jul + Sep-Oct south,
# May-Oct north; hot season Feb-Apr. Approximations of Ghana Meteorological Agency climatology (assumption).
_H = {"south": [.6, .5, .1, 0, 0, 0, 0, 0, 0, 0, .1, .5], "middle": [.8, .6, .2, 0, 0, 0, 0, 0, 0, 0, .2, .7],
      "north": [1, .8, .3, 0, 0, 0, 0, 0, 0, 0, .4, .9], "far_north": [1, .9, .4, 0, 0, 0, 0, 0, 0, 0, .5, 1]}
_R = {"south": [0, .1, .3, .7, 1, 1, .6, .3, .6, .7, .3, 0], "middle": [0, .1, .3, .6, .8, .8, .7, .6, .9, .7, .2, 0],
      "north": [0, 0, .1, .3, .5, .7, .9, 1, 1, .5, .1, 0], "far_north": [0, 0, 0, .2, .4, .6, .9, 1, .9, .4, 0, 0]}
_HEAT = {"south": [.3, .7, .8, .6, .2, 0, 0, 0, 0, .1, .2, .2], "middle": [.4, .8, .9, .7, .3, 0, 0, 0, 0, .1, .3, .3],
         "north": [.3, .8, 1, 1, .6, .1, 0, 0, 0, .2, .4, .3], "far_north": [.3, .8, 1, 1, .7, .2, 0, 0, 0, .3, .5, .3]}

GIVEN_F = ["Ama", "Akosua", "Abena", "Efua", "Adwoa", "Yaa", "Afua", "Esi", "Akua", "Araba", "Mansa", "Dzifa",
           "Elikem", "Selorm", "Mawuena", "Fatima", "Amina", "Rahinatu", "Hawa", "Ayishetu", "Gifty", "Comfort",
           "Patience", "Mercy", "Priscilla", "Naa", "Dede", "Korkor", "Adjoa", "Ewurabena"]
GIVEN_M = ["Kwame", "Kofi", "Kwabena", "Kwaku", "Yaw", "Kwasi", "Kojo", "Kweku", "Fiifi", "Ekow", "Kobby", "Nii",
           "Tetteh", "Selasi", "Edem", "Mawuli", "Ibrahim", "Abdul", "Mohammed", "Issah", "Alhassan", "Yakubu",
           "Emmanuel", "Daniel", "Samuel", "Prince", "Richard", "Isaac", "Michael", "Joseph"]
FAMILY = {"south": ["Mensah", "Owusu", "Asante", "Boateng", "Osei", "Appiah", "Agyeman", "Ofori", "Darko", "Quaye",
                    "Tetteh", "Lartey", "Addo", "Ampofo", "Amoah", "Frimpong", "Acheampong", "Agbeko", "Kpodo",
                    "Dzidzienyo", "Amegah", "Arthur", "Eshun", "Quansah"],
          "middle": ["Gyamfi", "Bediako", "Takyi", "Asare", "Badu", "Sarpong", "Ntim", "Kumi", "Opoku", "Nkansah"],
          "north": ["Abdulai", "Iddrisu", "Mahama", "Fuseini", "Sulemana", "Alhassan", "Yakubu", "Mumuni", "Seidu"],
          "far_north": ["Ayamga", "Akolgo", "Atanga", "Apuri", "Abugri", "Azure", "Dery", "Bayor", "Naah", "Kuuire"]}

UTC = timezone.utc
SS_ASCERTAINMENT = 2.66   # makes the south match Kumasi SS 67 % / SC 33 % (derived)


def _zone(region: str) -> str:
    return REGION.get(region, REGIONS[0])[2]


def genotype_mix(zone: str) -> dict[str, float]:
    """Share of SCD genotypes among *clinic* patients by zone: births SS = q_S^2, SC = 2 q_S q_C (Hardy-Weinberg)
    [allele_freq_by_zone] L, times an ascertainment factor for SS (SC is milder and diagnosed less) chosen so the
    southern zone matches the Kumasi registry (SS 67.2 %, SC 32.5 %, PMC8908904) H; plus ~1.5 % HbSβ."""
    qs, qc = ZONE_ALLELES[zone]
    ss, sc = qs * qs * SS_ASCERTAINMENT, 2 * qs * qc
    tot = ss + sc
    return {"HbSS": 0.985 * ss / tot, "HbSC": 0.985 * sc / tot, "HbSβ0": 0.01, "HbSβ+": 0.005}


def _gtgroup(genotype: str) -> str:
    return "SS" if genotype in ("HbSS", "HbSβ0") else "SC"


def _age_rr(age: float) -> float:
    for hi, rr in AGE_RR:
        if age < hi:
            return rr
    return AGE_RR[-1][1]


def _lognormal(r: np.random.Generator, mean: float, sd: float) -> float:
    s2 = math.log(1 + (sd / mean) ** 2)
    return float(r.lognormal(math.log(mean) - s2 / 2, math.sqrt(s2)))


def _los(r: np.random.Generator, child: bool) -> float:
    med, q1, q3 = LOS_CHILD if child else LOS_ADULT
    sigma = (math.log(q3) - math.log(q1)) / 1.349
    return float(max(1.0, round(r.lognormal(math.log(med), sigma))))


# =====================================================================================================================
# Patient traits
# =====================================================================================================================
@dataclass
class Spec:
    id: str
    mrn: str
    name: str
    sex: str
    dob: date
    genotype: str
    region: str
    district: str
    facility: str
    on_hu: bool
    hu_since: Optional[date]
    adherence: float
    hb_baseline: float
    hbf: float
    hbf_known: bool
    frailty: float
    chronic_pain: float          # mean pain on pain days
    pain_days: float             # share of days with any pain
    labs0: dict                  # steady-state lab values
    hr0: float
    hrv0: float
    spo2_0: float
    spo2_noct: float
    skin0: float
    steps0: float
    sleep0: float
    fluid0: float
    resp0: float
    stress0: float
    drinker: float               # probability of a heavy-drinking day
    menses_susceptible: bool
    cycle_offset: int
    checkin_rate: float
    devices: tuple
    device_missing: float
    bottle_capture: float
    lab_interval: int
    has_labs: bool
    history: dict = field(default_factory=dict)   # prior ACS / AVN / SCI / TCD / spleen / gallstones (dates, values)
    featured: bool = False

    def age(self, on: date) -> float:
        return (on - self.dob).days / 365.25

    def rate(self, on: date) -> float:
        """Personal utilisation-VOC rate per year before triggers and hydroxyurea."""
        g = _gtgroup(self.genotype)
        rr = GENOTYPE_RATE[self.genotype] * self.frailty * _age_rr(self.age(on))
        rr *= HBF_RR_PER_PCT ** (self.hbf - LAB_STEADY[g]["hbf"][0])
        rr *= WBC_RR_PER_UNIT ** (self.labs0["wbc"] - LAB_STEADY[g]["wbc"][0])
        if self.genotype == "HbSS":
            rr *= HB_RR_PER_G ** (self.hb_baseline - LAB_STEADY["SS"]["hb"][0])
        rr *= NOCT_SPO2_RR_PER_PCT ** (94.5 - self.spo2_noct)
        return rr


def sample_spec(r: np.random.Generator, on: date, n: int = 0, region: Optional[str] = None,
                genotype: Optional[str] = None, age: Optional[float] = None, sex: Optional[str] = None,
                **overrides) -> Spec:
    """Draw one patient. `on` = the date the traits refer to (simulation start)."""
    if region is None:
        w = np.array([p * CARE_ACCESS.get(nm, 0.75) * (lambda q: q[0] ** 2 + 2 * q[0] * q[1])(ZONE_ALLELES[z])
                      for nm, p, z, _ in REGIONS])
        region = REGIONS[int(r.choice(len(REGIONS), p=w / w.sum()))][0]
    zone = _zone(region)
    district, facility = REGION[region][3][int(r.integers(len(REGION[region][3])))]
    if genotype is None:
        mix = genotype_mix(zone)
        genotype = str(r.choice(list(mix), p=np.array(list(mix.values())) / sum(mix.values())))
    g = _gtgroup(genotype)
    if age is None:   # clinic registries are young (newborn-screening cohorts): ~55 % children
        age = float(r.choice([r.uniform(1, 5), r.uniform(5, 12), r.uniform(12, 18), r.uniform(18, 30),
                              r.uniform(30, 45), r.uniform(45, 65)], p=[.14, .22, .19, .25, .15, .05]))
    sex = sex or ("F" if r.random() < 0.5 else "M")
    child = age < 18
    frailty = float(r.gamma(FRAILTY_K, 1 / FRAILTY_K))
    # hydroxyurea mostly for HbSS/Sβ0 with frequent crises (confounding by indication) [coverage 15 %] L
    p_hu = HU_COVERAGE_SS * (0.6 + 0.8 * min(frailty, 2.5) / 2.5) * 1.3 if g == "SS" else 0.03
    on_hu = bool(r.random() < p_hu and age >= 2)
    hu_since = on - timedelta(days=int(r.integers(30, 1500))) if on_hu else None
    labs0 = {}
    for code, (m, sd) in LAB_STEADY[g].items():
        if code == "hbf":
            continue
        labs0[code] = float(max(m * 0.4, r.normal(m, sd))) if code != "crp" else _lognormal(r, m, sd)
    if genotype == "HbSβ+":
        labs0["hb"] = float(r.normal(11.0, 1.5))
    hb0 = round(labs0["hb"], 1)
    hbf = _lognormal(r, *(HBF_ON_HU if on_hu else LAB_STEADY[g]["hbf"]))
    hbf = float(min(30.0, max(0.5, hbf)))
    hr_m, hr_sd = HR_BASE["child" if child else "adult"]
    st_m, st_sd = STEPS_BASE["child" if child else "adult"]
    spo2 = float(np.clip(r.normal(*SPO2_AWAKE) - (0.6 if g == "SS" else -0.8) - (0.5 if age >= 18 else 0), 89, 99.5))
    devices = tuple(k for k, p in DEVICE_OWNERSHIP.items() if r.random() < p)
    # imaging history
    hist: dict = {}
    yrs = max(0.5, age - 1)
    if r.random() < EVER_ACS_ADULT[g] * min(1.0, age / 18):
        hist["acs"] = on - timedelta(days=int(r.uniform(60, yrs * 365)))
    if age >= 8 and r.random() < 1 - (1 - AVN_PER_YEAR[genotype]) ** max(0.0, age - 8):
        hist["avn"] = (on - timedelta(days=int(r.uniform(30, max(60, (age - 8) * 365)))),
                       "hip" if r.random() < 0.8 else "shoulder")
    sci_p = next((p for a, p in SCI_CUMULATIVE if age <= a), SCI_CUMULATIVE[-1][1]) * (1 if g == "SS" else SCI_SC_MULT)
    if age >= 4 and r.random() < 0.35:    # ~35 % ever had a brain MRI
        hist["mri_brain"] = (on - timedelta(days=int(r.uniform(30, yrs * 365))), bool(r.random() < sci_p))
    if g == "SS" and 2 <= age <= 16:
        u = r.random()
        v = (r.uniform(200, 240) if u < TCD_ABNORMAL_SS else r.uniform(170, 199)
             if u < TCD_ELEVATED_CHILD + TCD_ABNORMAL_SS * 0.3 else r.normal(135, 18))
        hist["tcd"] = (on - timedelta(days=int(r.uniform(10, 330))), float(round(v)))
    if r.random() < 0.4:
        spleen = r.random() < (SPLENOMEGALY["SC"] if g == "SC" else SPLENOMEGALY["SS_young"] if age < 8 else 0.03)
        stones = r.random() < (0.3 if g == "SS" and age >= 15 else 0.08)
        hist["abdo_us"] = (on - timedelta(days=int(r.uniform(30, 900))), bool(spleen), bool(stones))
    fam = FAMILY[zone]
    first = str(r.choice(GIVEN_F if sex == "F" else GIVEN_M))
    spec = Spec(
        id=f"sim{n:06d}", mrn=f"SIM-{100000 + n}", name=f"{first} {r.choice(fam)}", sex=sex,
        dob=on - timedelta(days=int(age * 365.25)), genotype=genotype, region=region, district=district,
        facility=facility, on_hu=on_hu, hu_since=hu_since,
        adherence=float(np.clip(r.beta(HU_ADHERENCE * 4, (1 - HU_ADHERENCE) * 4), 0.05, 0.99)),
        hb_baseline=hb0, hbf=round(hbf, 1), hbf_known=bool(r.random() < 0.7), frailty=frailty,
        chronic_pain=float(np.clip(r.normal(PAIN_WHEN_PRESENT, 1.0) + (1.0 if "avn" in hist else 0), 1, 7)),
        pain_days=float(np.clip(r.beta(2.2, 2.2 * PAIN_ZERO_DAYS / (1 - PAIN_ZERO_DAYS)), 0.02, 0.98)),
        labs0=labs0, hr0=float(r.normal(hr_m, hr_sd)),
        hrv0=_lognormal(r, *HRV_BASE) * (1.3 if child else 1.0),
        spo2_0=spo2, spo2_noct=float(np.clip(spo2 - abs(r.normal(*SPO2_NOCT_GAP)), 85, 99)),
        skin0=float(r.normal(33.8, 0.5)), steps0=_lognormal(r, st_m, st_sd), sleep0=float(np.clip(
            r.normal(*SLEEP_BASE) + (1.5 if child else 0), 4.5, 10.5)),
        fluid0=float(np.clip(r.normal(*FLUID_BASE), 0.8, 4.0)), resp0=float(r.normal(18 if child else 15, 1.5)),
        stress0=float(np.clip(r.normal(3.5, 1.3), 0.5, 7)),
        drinker=float(r.choice([0, 0.02, 0.06], p=[.6, .3, .1])) if age >= 16 else 0.0,
        menses_susceptible=bool(sex == "F" and 12 <= age <= 50 and r.random() < MENSES_SUSCEPTIBLE),
        cycle_offset=int(r.integers(28)), checkin_rate=float(r.beta(3, 1.5)), devices=devices,
        device_missing=float(r.uniform(*DEVICE_DAY_MISSING)), bottle_capture=float(r.uniform(0.6, 0.9)),
        lab_interval=int(LAB_INTERVAL["on_hu"] if on_hu else r.choice([60, 90, 120, 180], p=[.2, .3, .3, .2])),
        has_labs=bool(r.random() < 0.85), history=hist)
    for k, v in overrides.items():
        setattr(spec, k, v)
    return spec


# =====================================================================================================================
# Scenario overrides (featured demo stories)
# =====================================================================================================================
@dataclass
class Scenario:
    """Day indices are offsets from the simulation start. Event days may lie beyond the end (a crisis brewing)."""
    events: list[dict] = field(default_factory=list)   # {day, severity, hospitalised, los, prodrome (days), acs}
    bad_days: set = field(default_factory=set)          # several triggers together
    cold_days: set = field(default_factory=set)
    infection_days: set = field(default_factory=set)
    fever: dict = field(default_factory=dict)            # day -> core temperature
    missed_hu_days: set = field(default_factory=set)
    random_events: bool = False
    home_episodes: bool = True


# =====================================================================================================================
# Simulation
# =====================================================================================================================
def _ar1(r: np.random.Generator, n: int, sd: float, phi: float = AR_PHI) -> np.ndarray:
    e = r.normal(0, sd * math.sqrt(1 - phi * phi), n)
    out = np.empty(n)
    prev = r.normal(0, sd)
    for i in range(n):
        prev = phi * prev + e[i]
        out[i] = prev
    return out


def _window_any(x: np.ndarray, w: int) -> np.ndarray:
    """True on day t if x was true on any of days t-w..t (w=0: same day)."""
    if w <= 0:
        return x.astype(bool)
    c = np.convolve(x.astype(float), np.ones(w + 1))[: len(x)]
    return c > 0


@dataclass
class Sim:
    spec: Spec
    start: date
    n: int
    dates: list
    a: dict                      # daily arrays (behaviour, physiology, masks)
    events: list                 # [{day, duration, severity, hospitalised, los, acs, infection}]
    history_crises: list         # crises before the start (rows)
    lab_rows: list
    imaging_rows: list

    # ---------- rows in DB shapes ----------
    def patient_row(self) -> dict:
        s = self.spec
        return {"id": s.id, "mrn": s.mrn, "name": s.name, "date_of_birth": s.dob, "sex": s.sex,
                "genotype": s.genotype, "on_hydroxyurea": s.on_hu, "hb_baseline": s.hb_baseline,
                "hbf_percent": s.hbf if s.hbf_known else None,
                "crises_12m": sum(1 for c in self.history_crises if (self.start - c["date"]).days <= 365),
                "region": s.region, "district": s.district, "facility": s.facility, "featured": s.featured}

    def checkins(self, upto: Optional[int] = None) -> list[dict]:
        a, s = self.a, self.spec
        out = []
        for t in range(self.n if upto is None else upto):
            if not a["checkin"][t]:
                continue
            out.append({
                "patient_id": s.id, "date": self.dates[t], "pain": int(a["pain_ci"][t]),
                "hydration_litres": float(a["hyd_ci"][t]), "sleep_hours": float(a["sleep_ci"][t]),
                "stress": int(a["stress_ci"][t]), "temperature_c": float(a["temp_ci"][t]),
                "spo2": float(a["spo2_ci"][t]) if a["spo2_ci"][t] > 0 else None,
                "cold_exposure": bool(a["cold"][t]), "infection_symptoms": bool(a["infect_sx"][t]),
                "chest_symptoms": bool(a["chest"][t]), "neuro_symptoms": False,
                "menstruating": bool(a["menses"][t]) if s.sex == "F" and 11 <= s.age(self.dates[t]) <= 52 else None,
                "alcohol": bool(a["alcohol"][t]), "strenuous_activity": bool(a["exert"][t]),
                "hydroxyurea_taken": (bool(a["hu_ci"][t]) if s.on_hu else None),
                "hb": None, "wbc": None, "retic_percent": None, "ldh": None, "notes": ""})
        return out

    def daily_vitals(self) -> dict:
        """Daily aggregates {date: {metric: {mean,min,max,n,sum}}} - what `features.daily_aggregates` returns for
        the raw readings of the same day (raw generation below is built around these values)."""
        a = self.a
        out: dict = {}
        for t in range(self.n):
            day: dict = {}
            if a["wear_on"][t]:
                for m, key, cnt, span in (("heart_rate", "hr", 48, 23.5), ("hrv_rmssd", "hrv", 6, 5.0),
                                          ("skin_temp_c", "skin", 48, 23.5), ("resp_rate", "resp", 6, 5.0)):
                    v = float(a[key][t])
                    day[m] = {"mean": v, "min": v, "max": v, "n": cnt, "sum": v * cnt, "span_h": span}
                for m, key in (("steps", "steps"), ("sleep_minutes", "sleep_min")):
                    v = float(a[key][t])
                    day[m] = {"mean": v, "min": v, "max": v, "n": 1, "sum": v}
            if a["oxi_on"][t]:
                day["spo2"] = {"mean": float(a["spo2_read"][t]), "min": float(a["spo2_min_read"][t]),
                               "max": 100.0, "n": 48, "sum": 0.0, "span_h": 23.5}
            if a["bottle_on"][t]:
                v = float(a["fluid_ml"][t])
                day["fluid_ml"] = {"mean": v, "min": v, "max": v, "n": 1, "sum": v}
            if a["thermo_n"][t] > 0:
                v = float(a["body_temp_max"][t])
                day["body_temp_c"] = {"mean": v - 0.15, "min": v - 0.3, "max": v, "n": int(a["thermo_n"][t]),
                                      "sum": 0.0}
            if day:
                out[self.dates[t]] = day
        return out

    def readings(self, device_ids: Optional[dict] = None, r: Optional[np.random.Generator] = None,
                 from_day: int = 0) -> list[dict]:
        """Raw readings like a real device would push: HR / SpO2 / skin temp every 30 min, HRV and breathing rate
        hourly at night, daily totals for sleep / steps / fluid, a few thermometer readings."""
        r = r or np.random.default_rng(hash(self.spec.id) % 2**32)
        a, pid = self.a, self.spec.id
        dev = device_ids or {}
        out: list[dict] = []
        slots = np.arange(48)
        hours = slots / 2
        night = (hours < 6) | (hours >= 22.5)
        circ_hr = np.where(night, -9.0, 4.0)
        circ_hr = circ_hr - circ_hr.mean()
        for t in range(from_day, self.n):
            d0 = datetime.combine(self.dates[t], time(0, 0), tzinfo=UTC)
            ts = [d0 + timedelta(minutes=30 * int(k)) for k in slots]
            if a["wear_on"][t]:
                did = dev.get("wearable")
                hr = a["hr"][t] + circ_hr + r.normal(0, 2.5, 48)
                hr += a["hr"][t] - hr.mean()
                skin = a["skin"][t] + np.where(night, 0.4, -0.2) + r.normal(0, 0.15, 48)
                skin += a["skin"][t] - skin.mean()
                for k in range(48):
                    out.append({"device_id": did, "patient_id": pid, "ts": ts[k], "metric": "heart_rate",
                                "value": round(float(hr[k]), 1)})
                    out.append({"device_id": did, "patient_id": pid, "ts": ts[k], "metric": "skin_temp_c",
                                "value": round(float(skin[k]), 2)})
                hrv = a["hrv"][t] * np.exp(r.normal(0, 0.08, 6))
                hrv *= a["hrv"][t] / hrv.mean()
                resp = a["resp"][t] + r.normal(0, 0.5, 6)
                resp += a["resp"][t] - resp.mean()
                for k in range(6):
                    tk = d0 + timedelta(hours=k)
                    out.append({"device_id": did, "patient_id": pid, "ts": tk, "metric": "hrv_rmssd",
                                "value": round(float(hrv[k]), 1)})
                    out.append({"device_id": did, "patient_id": pid, "ts": tk, "metric": "resp_rate",
                                "value": round(float(resp[k]), 1)})
                out.append({"device_id": did, "patient_id": pid, "ts": d0 + timedelta(hours=7), "metric":
                            "sleep_minutes", "value": float(round(a["sleep_min"][t]))})
                out.append({"device_id": did, "patient_id": pid, "ts": d0 + timedelta(hours=23, minutes=50),
                            "metric": "steps", "value": float(round(a["steps"][t]))})
            if a["oxi_on"][t]:
                did = dev.get("pulse_oximeter")
                sp = a["spo2_read"][t] + r.normal(0, 0.5, 48) + np.where(night, -0.6, 0.3)
                sp += a["spo2_read"][t] - sp.mean()
                low = int(r.integers(2, 10))                       # the night-time dip
                sp[low] = a["spo2_min_read"][t]
                sp = np.clip(np.round(sp), 70, 100)
                sp[low] = round(a["spo2_min_read"][t])
                if a.get("spo2_sustained") is not None and a["spo2_sustained"][t]:
                    sp[16:20] = np.minimum(sp[16:20], 90)          # >= 15 min below 92 % (red flag)
                for k in range(48):
                    out.append({"device_id": did, "patient_id": pid, "ts": ts[k], "metric": "spo2",
                                "value": float(sp[k])})
            if a["bottle_on"][t]:
                out.append({"device_id": dev.get("smart_bottle"), "patient_id": pid,
                            "ts": d0 + timedelta(hours=22), "metric": "fluid_ml",
                            "value": float(round(a["fluid_ml"][t]))})
            nt = int(a["thermo_n"][t])
            for k in range(nt):
                v = a["body_temp_max"][t] - (0 if k == nt - 1 else r.uniform(0.1, 0.4))
                out.append({"device_id": dev.get("thermometer"), "patient_id": pid,
                            "ts": d0 + timedelta(hours=8 + 6 * k), "metric": "body_temp_c", "value": round(float(v), 1)})
        return out

    def crises(self) -> list[dict]:
        rows = list(self.history_crises)
        for e in self.events:
            if e["day"] < self.n:
                rows.append(self._crisis_row(self.dates[0] + timedelta(days=e["day"]), e))
        return rows

    def _crisis_row(self, d: date, e: dict) -> dict:
        note = "Acute chest syndrome complicating VOC" if e.get("acs") else (
            "VOC with infection/fever" if e.get("infection") else "Vaso-occlusive crisis")
        return {"patient_id": self.spec.id, "date": d, "severity": e["severity"], "hospitalised": e["hospitalised"],
                "los_days": e["los"] if e["hospitalised"] else None, "facility": self.spec.facility,
                "notes": note + " (simulated)"}

    def labels(self, horizon: int = 7) -> tuple[np.ndarray, np.ndarray]:
        """y[t] = 1 if a crisis starts in days t+1..t+horizon; active[t] = inside a crisis episode (exclude)."""
        y = np.zeros(self.n, dtype=int)
        active = np.zeros(self.n, dtype=bool)
        for e in self.events:
            d = e["day"]
            y[max(0, d - horizon):max(0, min(self.n, d))] = 1
            active[max(0, d):min(self.n, d + int(e["duration"]))] = True
        return y, active


@lru_cache(maxsize=1)
def trigger_norm() -> float:
    """Average trigger rate ratio in the population, so the Platt genotype rates stay the population averages."""
    r = np.random.default_rng(12345)
    vals = []
    start = date(2025, 1, 1)
    for i in range(150):
        spec = sample_spec(r, start, i)
        a = _exposures(spec, start, 365, r, Scenario(random_events=True))
        vals.append(a["trig_rr"].mean())
    return float(np.mean(vals))


def _exposures(spec: Spec, start: date, n: int, r: np.random.Generator, sc: Scenario) -> dict:
    """Environment and behaviour per day, and the resulting trigger rate ratio (before hydroxyurea / recurrence)."""
    zone = _zone(spec.region)
    dates = [start + timedelta(days=i) for i in range(n)]
    months = np.array([d.month - 1 for d in dates])
    harm = np.array(_H[zone])[months]
    rain = np.array(_R[zone])[months]
    heat = np.array(_HEAT[zone])[months]
    weekend = np.array([d.weekday() >= 5 for d in dates])
    age = spec.age(start)
    child = age < 18

    hyd = np.clip(spec.fluid0 - 0.35 * heat - 0.2 * harm + _ar1(r, n, 0.35), 0.4, 4.5)
    sleep = np.clip(spec.sleep0 + _ar1(r, n, SLEEP_DAY_SD), 2.5, 11)
    stress = np.clip(spec.stress0 + _ar1(r, n, 1.5, 0.6), 0, 10)
    cold = r.random(n) < (0.04 + 0.30 * harm + 0.08 * rain)
    alcohol = r.random(n) < spec.drinker * np.where(weekend, 2.5, 0.6)
    exert = r.random(n) < np.where(weekend, 0.10, 0.06) * (1.5 if child else 1)
    # infections (incl. malaria), more in the rains
    infect = np.zeros(n, dtype=bool)
    fever = np.zeros(n)
    lam = INFECTION_PER_YEAR["child" if child else "adult"] / 365 * (0.6 + 1.0 * rain)
    t = 0
    while t < n:
        if r.random() < lam[t]:
            dur = int(r.integers(3, 9))
            infect[t:t + dur] = True
            if r.random() < 0.65:
                fd = int(r.integers(1, 4))
                fever[t:t + fd] = r.uniform(0.6, 2.2, len(fever[t:t + fd]))
            t += dur
        t += 1
    # menses: 5 days of a 28-day cycle
    menses = np.zeros(n, dtype=bool)
    if spec.sex == "F" and 11 <= age <= 52:
        menses = ((np.arange(n) + spec.cycle_offset) % 28) < 5
    peri = np.zeros(n, dtype=bool)
    if spec.menses_susceptible:
        ph = (np.arange(n) + spec.cycle_offset) % 28
        peri = (ph >= 21) | (ph < 5)                     # days -7..+5 around onset
    # hydroxyurea: two-state Markov chain with stationary adherence a
    hu = np.zeros(n, dtype=bool)
    if spec.on_hu:
        a_ = spec.adherence
        k = 0.25
        p_miss = (1 - a_) * k
        p_back = a_ * k
        state = r.random() < a_
        u = r.random(n)
        for i in range(n):
            state = (u[i] >= p_miss) if state else (u[i] < p_back)
            hu[i] = state
    # scenario overrides
    for d in sc.bad_days:
        if 0 <= d < n:
            hyd[d] = min(hyd[d], r.uniform(0.9, 1.4))
            sleep[d] = min(sleep[d], r.uniform(4.0, 5.6))
            stress[d] = max(stress[d], r.uniform(6, 8.5))
            alcohol[d] = alcohol[d] or (spec.drinker > 0 and r.random() < 0.3)
            exert[d] = exert[d] or r.random() < 0.3
    for d in sc.cold_days:
        if 0 <= d < n:
            cold[d] = True
    for d in sc.infection_days:
        if 0 <= d < n:
            infect[d] = True
    for d, tc in sc.fever.items():
        if 0 <= d < n:
            fever[d] = max(0.0, tc - 36.7)
            infect[d] = True
    for d in sc.missed_hu_days:
        if 0 <= d < n:
            hu[d] = False

    hyd2 = np.convolve(hyd, np.ones(2) / 2)[:n]
    hyd2[0] = hyd[0]
    rr = np.ones(n)
    rr *= np.where(hyd2 < 1.5, TRIGGER_RR["dehydration"][0], 1.0)
    rr *= np.where(_window_any(infect | (fever > 0), TRIGGER_RR["infection"][1]), TRIGGER_RR["infection"][0], 1.0)
    rr *= np.where(peri, TRIGGER_RR["menses"][0], 1.0)
    rr *= np.where(_window_any(stress >= 7, TRIGGER_RR["stress"][1]), TRIGGER_RR["stress"][0], 1.0)
    rr *= np.where(_window_any(sleep < 6, TRIGGER_RR["short_sleep"][1]), TRIGGER_RR["short_sleep"][0], 1.0)
    rr *= np.where(_window_any(alcohol, TRIGGER_RR["alcohol"][1]), TRIGGER_RR["alcohol"][0], 1.0)
    rr *= np.where(_window_any(exert, TRIGGER_RR["exertion"][1]), TRIGGER_RR["exertion"][0], 1.0)
    rr *= np.where(_window_any(cold, TRIGGER_RR["cold_wind"][1]), TRIGGER_RR["cold_wind"][0], 1.0)
    rr *= TRIGGER_RR["low_humidity"][0] ** harm
    rr *= TRIGGER_RR["rain"][0] ** rain
    # hydroxyurea: full effect after ~90 days on treatment, scaled by 14-day adherence
    hu_rr = np.ones(n)
    if spec.on_hu:
        cover = np.convolve(hu.astype(float), np.ones(14) / 14)[:n]
        cover[:14] = np.maximum(cover[:14], spec.adherence)
        days_on = np.array([(d - spec.hu_since).days for d in dates])
        ramp = np.clip(days_on / 90, 0, 1)
        hu_rr = HU_RR ** (ramp * np.clip(cover / max(HU_ADHERENCE, 1e-6), 0, 1.4))
    return dict(dates=dates, harm=harm, rain=rain, heat=heat, hyd=hyd, sleep=sleep, stress=stress, cold=cold,
                alcohol=alcohol, exert=exert, infect=infect, fever=fever, menses=menses, hu=hu, trig_rr=rr,
                hu_rr=hu_rr)


def simulate(spec: Spec, start: date, n: int, r: np.random.Generator, sc: Optional[Scenario] = None,
             signal_strength: float = SIGNAL_STRENGTH) -> Sim:
    sc = sc or Scenario(random_events=True)
    a = _exposures(spec, start, n, r, sc)
    age = spec.age(start)
    child = age < 18
    base_daily = spec.rate(start) * RATE_CALIBRATION / 365 / trigger_norm()

    # ---- crises (sequential: an episode blocks new onsets; recurrence risk for 30 days after) ----
    events: list[dict] = []
    busy_until = -1
    recur_until = -1

    def new_event(d: int, forced: Optional[dict] = None) -> dict:
        f = forced or {}
        infection = bool(a["infect"][max(0, min(d, n - 1))]) if d < n else bool(f.get("infection"))
        sev = f.get("severity") or str(r.choice(["mild", "moderate", "severe"], p=[.3, .45, .25]))
        p_adm = {"mild": 0.25, "moderate": 0.6, "severe": 0.95}[sev] * UTILISATION_ADMITTED / 0.6
        hosp = f.get("hospitalised", bool(r.random() < min(0.98, p_adm)))
        los = f.get("los") or (_los(r, child) if hosp else 0.0)
        acs = f.get("acs", bool(hosp and r.random() < ACS_PER_ADMISSION[spec.genotype]))
        if acs and hosp:
            los = max(los, float(r.integers(5, 10)))
        duration = max(los, float(r.integers(2, 5))) if hosp else float(r.integers(2, 5))
        pl = f.get("prodrome") or int(r.choice([1, 2, 3], p=[.3, .4, .3]))
        return {"day": d, "duration": duration, "severity": sev, "hospitalised": bool(hosp), "los": float(los),
                "acs": bool(acs), "infection": infection, "prodrome": pl,
                "intensity": f.get("intensity") or float(r.lognormal(0, 0.35))}

    forced = {e["day"]: e for e in sc.events}
    for t in range(n):
        if t in forced:
            e = new_event(t, forced[t])
        elif sc.random_events and t > busy_until:
            h = base_daily * a["trig_rr"][t] * a["hu_rr"][t] * (RECURRENCE_RR if t <= recur_until else 1.0)
            if r.random() >= -math.expm1(-h):
                continue
            e = new_event(t)
        else:
            continue
        events.append(e)
        busy_until = t + int(e["duration"])
        recur_until = busy_until + 30
    for d, f in forced.items():          # crises brewing beyond the window: only the prodrome is visible
        if d >= n:
            events.append(new_event(d, f))

    # home-managed pain episodes (never reach hospital): look like a mild crisis, realistic false alarms
    home: list[tuple[int, int, float]] = []
    if sc.home_episodes:
        lam_home = base_daily * HOME_EPISODES_PER_VOC
        for t in range(n):
            if r.random() < lam_home * a["trig_rr"][t] * a["hu_rr"][t]:
                home.append((t, int(r.integers(1, 4)), float(r.uniform(0.4, 0.9))))

    # ---- state arrays: prodrome ramp (by days before onset), active crisis, admitted, ACS ----
    pro = np.zeros((n, 3))         # pro[t, k] = intensity if day t is k+1 days before an onset
    pro_inf = np.zeros(n)
    active = np.zeros(n); admitted = np.zeros(n, dtype=bool); acs = np.zeros(n, dtype=bool)
    since_onset = np.full(n, 99)
    for e in events:
        d, I = e["day"], e["intensity"] * signal_strength
        for k in range(min(3, e["prodrome"])):
            t = d - 1 - k
            if 0 <= t < n:
                pro[t, k] = max(pro[t, k], I)
                if e["infection"]:
                    pro_inf[t] = max(pro_inf[t], PRODROME["skin_infect"][k] * I)
        for t in range(max(0, d), min(n, d + int(e["duration"]))):
            active[t] = 1.0
            since_onset[t] = t - d
            if e["hospitalised"] and t < d + max(1, int(e["los"])):
                admitted[t] = True
            if e["acs"] and t < d + 4:
                acs[t] = True
    home_level = np.zeros(n)
    for t0, dur, lvl in home:
        for t in range(t0 - 1, min(n, t0 + dur)):
            if t >= 0 and not active[t]:
                home_level[t] = max(home_level[t], lvl if t >= t0 else lvl * 0.5)

    def drift(key: str) -> np.ndarray:
        w = PRODROME[key]
        return pro[:, 0] * w[0] + pro[:, 1] * w[1] + pro[:, 2] * w[2]

    # ---- physiology (true daily values) ----
    infect = a["infect"]
    fever = a["fever"]
    core = 36.7 + r.normal(0, 0.15, n) + fever + 0.3 * pro_inf + 0.2 * active + 0.6 * acs
    sleep_true = np.clip(a["sleep"] + drift("sleep_h") + DURING["sleep_h"] * active - 0.8 * home_level, 1.5, 12)
    hyd_true = np.clip(a["hyd"] + drift("fluid_l") - 0.4 * home_level, 0.3, 5)
    hr = (spec.hr0 + _ar1(r, n, HR_DAY_SD) + 10 * fever + 3 * infect + 2.0 * np.maximum(0, 2.0 - hyd_true)
          + 0.8 * np.maximum(0, spec.sleep0 - sleep_true) + 1.5 * a["alcohol"] + drift("hr")
          + DURING["hr"] * active + 5 * home_level)
    hrv = spec.hrv0 * np.exp(_ar1(r, n, HRV_CV) - 0.02 * (a["stress"] - spec.stress0) - 0.12 * infect
                             - 0.10 * a["alcohol"]) * (1 + drift("hrv_pct")) * (1 + DURING["hrv_pct"] * active) \
        * (1 - 0.1 * home_level)
    spo2 = (spec.spo2_0 + _ar1(r, n, SPO2_DAY_SD) - 0.5 * infect + drift("spo2") + DURING["spo2"] * active
            + (DURING["spo2_acs"] - DURING["spo2"]) * acs)
    spo2_min = spo2 - (spec.spo2_0 - spec.spo2_noct) - 2.0 - np.abs(r.normal(0, 1.2, n)) - 1.5 * active - 3 * acs
    skin = spec.skin0 + _ar1(r, n, SKIN_SD) + 0.5 * fever + pro_inf + DURING["skin"] * active - 0.3 * a["cold"]
    steps = spec.steps0 * np.exp(_ar1(r, n, STEPS_CV, 0.3) + 0.4 * a["exert"] - 0.3 * infect - 0.3 * (fever > 0)) \
        * (1 + drift("steps_pct")) * np.where(admitted, 1 + DURING["steps_admitted"],
                                               1 + DURING["steps_home"] * active) * (1 - 0.4 * home_level)
    resp = spec.resp0 + _ar1(r, n, 0.8) + 1.5 * infect + 1.0 * fever + drift("resp") + 2 * active + 5 * acs

    # ---- what gets recorded ----
    owned = set(spec.devices)
    def worn(kind: str, extra: float = 0.0) -> np.ndarray:
        if kind not in owned:
            return np.zeros(n, dtype=bool)
        on = r.random(n) >= spec.device_missing + extra
        # outages: device offline for a few days now and then
        t = 0
        while t < n:
            if r.random() < 1 / 120:
                on[t:t + int(r.integers(2, 11))] = False
                t += 10
            t += 1
        return on & ~(admitted & (r.random(n) < 0.6))
    wear_on = worn("wearable")
    oxi_on = worn("pulse_oximeter", 0.05)
    bottle_on = worn("smart_bottle", 0.05)
    unwell = (fever > 0) | infect | (pro_inf > 0) | (active > 0)
    thermo_n = np.where(("thermometer" in owned) & (r.random(n) < np.where(unwell, 0.9, 0.35)),
                        np.where(unwell, r.integers(2, 4, n), 1), 0)

    # check-ins: per-patient rate, streaky; none while admitted
    ci = np.zeros(n, dtype=bool)
    state = r.random() < spec.checkin_rate
    k = 0.35
    for t in range(n):
        if state:
            state = r.random() >= (1 - spec.checkin_rate) * k
        else:
            state = r.random() < spec.checkin_rate * k
        ci[t] = state and not admitted[t]
    pain_bg = np.where(r.random(n) < spec.pain_days, np.clip(r.normal(spec.chronic_pain, 1.2, n), 1, 8), 0)
    pain = np.clip(np.round(pain_bg + drift("pain") + 1.0 * infect + (DURING["pain"] - pain_bg) * active * (
        np.where(since_onset < 2, 1.0, 0.6)) + 4.0 * home_level + r.normal(0, 0.6, n)), 0, 10)
    hu_ci = a["hu"] ^ (r.random(n) < 0.05)                    # 5 % recall error
    chest = acs | ((active > 0) & (r.random(n) < 0.05)) | (r.random(n) < 0.001)

    arr = dict(a)
    arr.update(
        hr=np.round(hr, 1), hrv=np.round(np.maximum(5, hrv), 1), skin=np.round(skin, 2),
        resp=np.round(np.maximum(8, resp), 1), steps=np.round(np.maximum(0, steps)),
        sleep_min=np.round(np.maximum(0, sleep_true * 60 + r.normal(0, 15, n))),
        spo2_read=np.round(np.clip(spo2 + OXIMETER_OVERREAD, 70, 100), 1),
        spo2_min_read=np.round(np.clip(spo2_min + OXIMETER_OVERREAD, 60, 100)),
        fluid_ml=np.round(np.maximum(0, hyd_true * 1000 * spec.bottle_capture * np.exp(r.normal(0, 0.12, n)))),
        body_temp_max=np.round(core + np.where(thermo_n > 1, 0.1, 0), 1), thermo_n=thermo_n,
        wear_on=wear_on, oxi_on=oxi_on, bottle_on=bottle_on, checkin=ci, pain_ci=pain,
        hyd_ci=np.round(np.clip(hyd_true + r.normal(0, 0.3, n), 0.2, 6), 1),
        sleep_ci=np.round(np.clip(sleep_true + r.normal(0, 0.5, n), 1, 13), 1),
        stress_ci=np.clip(np.round(a["stress"] + r.normal(0, 0.7, n)), 0, 10),
        temp_ci=np.round(np.where(thermo_n > 0, core, 36.6 + 0.6 * np.maximum(0, core - 36.7)
                                  + r.normal(0, 0.15, n)), 1),
        spo2_ci=np.where(oxi_on, np.round(np.clip(spo2 + OXIMETER_OVERREAD, 70, 100)), 0),
        infect_sx=infect & (r.random(n) < 0.85), chest=chest, hu_ci=hu_ci, core=core, active=active,
        admitted=admitted, acs=acs, pro=pro.max(axis=1), home=home_level, spo2_sustained=None)

    sim = Sim(spec, start, n, a["dates"], arr, events, [], [], [])
    sim.history_crises = _history_crises(spec, start, r)
    sim.lab_rows = _labs(sim, r)
    sim.imaging_rows = _imaging(sim, r)
    return sim


def _history_crises(spec: Spec, start: date, r: np.random.Generator, days: int = 730) -> list[dict]:
    """Crises in the 2 years before the simulation (for 'crises in the last 12 months')."""
    lam = spec.rate(start) * (HU_RR if spec.on_hu else 1.0) * days / 365
    k = int(r.poisson(lam * 1.15))     # recurrence clustering
    child = spec.age(start) < 18
    out = []
    for _ in range(k):
        d = start - timedelta(days=int(r.integers(1, days)))
        sev = str(r.choice(["mild", "moderate", "severe"], p=[.3, .45, .25]))
        hosp = bool(r.random() < {"mild": 0.25, "moderate": 0.6, "severe": 0.95}[sev])
        out.append({"patient_id": spec.id, "date": d, "severity": sev, "hospitalised": hosp,
                    "los_days": _los(r, child) if hosp else None, "facility": spec.facility,
                    "notes": "Vaso-occlusive crisis (simulated)"})
    return sorted(out, key=lambda c: c["date"])


def lab_row(pid: str, when: datetime, code: str, value: float, source: str = "sample") -> dict:
    name, unit, lo, hi = LAB_CATALOG[code]
    return {"patient_id": pid, "taken_at": when, "code": code, "name": name, "value": value, "unit": unit,
            "ref_low": lo, "ref_high": hi, "source": source}


def _lab_value(sim: Sim, code: str, t: int, r: np.random.Generator) -> float:
    s, a = sim.spec, sim.a
    t = max(0, min(sim.n - 1, t))
    base = s.hb_baseline if code == "hb" else s.hbf if code == "hbf" else s.labs0[code]
    pro = a["pro"][t]
    act = a["active"][t]
    inf = float(a["infect"][t]) + float(a["fever"][t] > 0)
    v = base
    if code == "hb":
        v += PRODROME["hb"][0] * pro + DURING["hb"] * act + (DURING["hb_acs"] - DURING["hb"]) * a["acs"][t]
    elif code == "wbc":
        v += 1.0 * pro + DURING["wbc"] * act + 1.5 * inf
    elif code == "crp":
        v += 5 * pro + DURING["crp"] * act + 20 * inf + (DURING["crp_acs"] - DURING["crp"]) * a["acs"][t]
    elif code == "ldh":
        v *= 1 + 0.05 * pro + DURING["ldh_pct"] * act
    elif code == "retic":
        v *= 1 + 0.05 * pro + DURING["retic_pct"] * act
    elif code == "bili":
        v *= 1 + 0.2 * act
    v *= math.exp(r.normal(0, LAB_NOISE_CV))
    return round(float(v), 1 if code not in ("ldh", "plt", "bili") else 0)


def _labs(sim: Sim, r: np.random.Generator) -> list[dict]:
    s = sim.spec
    if not s.has_labs:
        return []
    days = set()
    t = -int(r.integers(0, s.lab_interval))
    while t < sim.n:
        if t >= -365:
            days.add(t)
        t += max(14, int(r.normal(s.lab_interval, s.lab_interval * 0.25)))
    for e in sim.events:              # at presentation and on discharge
        if 0 <= e["day"] < sim.n:
            days.add(e["day"])
            if e["hospitalised"]:
                days.add(min(sim.n - 1, e["day"] + int(e["los"]) - 1))
    rows = []
    for t in sorted(days):
        when = datetime.combine(sim.start + timedelta(days=t), time(9, 30), tzinfo=UTC)
        codes = ["hb", "wbc", "retic", "ldh", "bili", "plt"] + (["crp"] if r.random() < 0.3 or
                                                                  (0 <= t < sim.n and sim.a["active"][t]) else [])
        if (s.on_hu and r.random() < 0.8) or r.random() < 0.15:
            codes.append("hbf")
        for c in codes:
            rows.append(lab_row(s.id, when, c, _lab_value(sim, c, t, r)))
    return rows


# ---------------------------------------------------------------------------------------------------------------------
# Imaging with fictional radiology report text
# ---------------------------------------------------------------------------------------------------------------------
def imaging_study(pid: str, kind: str, d: date, **kw) -> dict:
    """Fictional radiology report + structured findings. kinds: cxr_acs, cxr_normal, mri_hip_avn, mri_brain_sci,
    mri_brain_normal, tcd, us_abdomen."""
    base = {"patient_id": pid, "study_date": d, "ai_summary": None, "ai_findings": [], "file_name": "",
            "file_path": "", "content_type": "", "source": "sample", "tcd_velocity": None}
    if kind == "cxr_acs":
        side = kw.get("side", "right lower")
        return base | {"modality": "xray", "body_part": "chest", "indication": "Chest pain, fever and cough during "
                       "a painful crisis. ?Acute chest syndrome.",
                       "report": f"PA chest radiograph. New patchy airspace opacification in the {side} zone with "
                       "air bronchograms. Small blunting of the costophrenic angle. Heart size at the upper limit of "
                       "normal. No pneumothorax. Bones: H-shaped vertebral end-plate changes in keeping with sickle "
                       "cell disease.",
                       "impression": f"New {side} zone consolidation; in the clinical context consistent with acute "
                       "chest syndrome. Small effusion.",
                       "findings": [{"code": "acs_infiltrate", "label": f"New {side} zone infiltrate (acute chest "
                                     "syndrome)", "severity": "severe"}]}
    if kind == "cxr_normal":
        return base | {"modality": "xray", "body_part": "chest", "indication": kw.get(
                       "indication", "Painful crisis with mild cough; exclude chest syndrome."),
                       "report": "PA chest radiograph. Lungs are clear. No focal consolidation, effusion or "
                       "pneumothorax. Heart size normal. Mild bony changes of sickle cell disease.",
                       "impression": "No acute cardiopulmonary abnormality.",
                       "findings": [{"code": "normal", "label": "No acute abnormality", "severity": "info"}]}
    if kind == "mri_hip_avn":
        side = kw.get("side", "left")
        site = kw.get("site", "hip")
        if site == "shoulder":
            return base | {"modality": "mri", "body_part": f"{side} shoulder", "indication": "Chronic shoulder pain.",
                           "report": f"MRI {side} shoulder. Serpiginous low T1 signal in the humeral head with a "
                           "double-line sign on T2; no articular collapse.",
                           "impression": f"Avascular necrosis of the {side} humeral head, pre-collapse.",
                           "findings": [{"code": "avn_shoulder", "label": f"AVN {side} humeral head",
                                         "severity": "moderate"}]}
        return base | {"modality": "mri", "body_part": f"{side} hip", "indication": "Groin pain on walking for 3 "
                       "months; limp.",
                       "report": f"MRI pelvis and hips. Geographic subchondral area of low T1 signal in the {side} "
                       "femoral head with a double-line sign on STIR, involving about 30 % of the weight-bearing "
                       "surface. Early subchondral fracture without collapse. Small joint effusion. Contralateral hip "
                       "normal.",
                       "impression": f"Avascular necrosis of the {side} femoral head (Ficat-Arlet stage II-III). "
                       "Orthopaedic review advised.",
                       "findings": [{"code": "avn_hip", "label": f"AVN {side} femoral head", "severity": "moderate"}]}
    if kind == "mri_brain_sci":
        return base | {"modality": "mri", "body_part": "brain", "indication": "Screening; school difficulties.",
                       "report": "MRI brain. Two small foci of T2/FLAIR hyperintensity in the right frontal deep "
                       "white matter (4 and 6 mm), no restricted diffusion. No large-vessel territory infarct. MRA: "
                       "no stenosis.",
                       "impression": "Small deep white-matter infarcts consistent with silent cerebral infarction.",
                       "findings": [{"code": "silent_infarct", "label": "Silent cerebral infarcts (right frontal)",
                                     "severity": "moderate"}]}
    if kind == "mri_brain_normal":
        return base | {"modality": "mri", "body_part": "brain", "indication": "Headaches.",
                       "report": "MRI brain with MRA. Normal grey/white matter signal. No infarct. Vessels patent.",
                       "impression": "Normal study.",
                       "findings": [{"code": "normal", "label": "Normal brain MRI", "severity": "info"}]}
    if kind == "tcd":
        v = float(kw["velocity"])
        if v >= 200:
            f = [{"code": "tcd_abnormal", "label": f"Abnormal TCD ({v:.0f} cm/s)", "severity": "severe"}]
            imp = "ABNORMAL (>= 200 cm/s): high stroke risk. Repeat within 2 weeks and discuss urgently with " \
                  "haematology."
        elif v >= 170:
            f = [{"code": "tcd_conditional", "label": f"Conditional TCD ({v:.0f} cm/s)", "severity": "moderate"}]
            imp = "CONDITIONAL (170-199 cm/s). Repeat in 3 months."
        else:
            f = [{"code": "normal", "label": f"Normal TCD ({v:.0f} cm/s)", "severity": "info"}]
            imp = "NORMAL (< 170 cm/s). Annual screening."
        return base | {"modality": "tcd", "body_part": "head", "indication": "Annual stroke-risk screening (STOP).",
                       "report": f"Transcranial Doppler (non-imaging). Highest time-averaged mean of maximum velocity: "
                       f"{v:.0f} cm/s in the {kw.get('vessel', 'left MCA')}. Other vessels lower. Good windows.",
                       "impression": imp, "findings": f, "tcd_velocity": v}
    if kind == "us_abdomen":
        spleen, stones = kw.get("spleen", False), kw.get("stones", False)
        parts, f = [], []
        parts.append(f"Spleen {'enlarged, 15.2 cm, homogeneous' if spleen else 'small and echogenic (auto-infarction)' if kw.get('ss') else 'normal size, 10.4 cm'}.")
        parts.append("Gallbladder contains multiple mobile echogenic calculi with acoustic shadowing; wall not "
                     "thickened; CBD 4 mm." if stones else "Gallbladder normal, no calculi.")
        parts.append("Liver normal size and echotexture. Kidneys normal size, mildly increased cortical echogenicity.")
        if spleen:
            f.append({"code": "splenomegaly", "label": "Splenomegaly (15 cm)", "severity": "moderate"})
        if stones:
            f.append({"code": "gallstones", "label": "Cholelithiasis", "severity": "moderate"})
        if not f:
            f.append({"code": "normal", "label": "No significant abnormality", "severity": "info"})
        imp = "; ".join(x["label"] for x in f) if f[0]["code"] != "normal" else "No significant abnormality."
        return base | {"modality": "ultrasound", "body_part": "abdomen", "indication": "Abdominal pain / routine "
                       "review.", "report": " ".join(parts), "impression": imp, "findings": f}
    raise ValueError(kind)


def _imaging(sim: Sim, r: np.random.Generator) -> list[dict]:
    s, h, pid = sim.spec, sim.spec.history, sim.spec.id
    rows = []
    if "acs" in h:
        rows.append(imaging_study(pid, "cxr_acs", h["acs"], side=str(r.choice(["right lower", "left lower",
                                                                              "bilateral lower"]))))
    if "avn" in h:
        rows.append(imaging_study(pid, "mri_hip_avn", h["avn"][0], site=h["avn"][1],
                                  side=str(r.choice(["left", "right"]))))
    if "mri_brain" in h:
        rows.append(imaging_study(pid, "mri_brain_sci" if h["mri_brain"][1] else "mri_brain_normal", h["mri_brain"][0]))
    if "tcd" in h:
        rows.append(imaging_study(pid, "tcd", h["tcd"][0], velocity=h["tcd"][1]))
    if "abdo_us" in h:
        rows.append(imaging_study(pid, "us_abdomen", h["abdo_us"][0], spleen=h["abdo_us"][1],
                                  stones=h["abdo_us"][2], ss=_gtgroup(s.genotype) == "SS"))
    for e in sim.events:             # chest x-rays during admissions in the simulated window
        if 0 <= e["day"] < sim.n and e["hospitalised"] and (e["acs"] or r.random() < 0.3):
            d = sim.start + timedelta(days=e["day"] + (1 if e["acs"] else 0))
            rows.append(imaging_study(pid, "cxr_acs" if e["acs"] else "cxr_normal", d))
    return rows


# =====================================================================================================================
# Cohorts
# =====================================================================================================================
def cohort(n_patients: int, days: int = 365, seed: int = 7, start: Optional[date] = None,
           signal_strength: float = SIGNAL_STRENGTH):
    """Yield Sim objects one at a time (memory stays flat)."""
    start = start or date(2025, 1, 1)
    for i in range(n_patients):
        r = np.random.default_rng([seed, i])
        spec = sample_spec(r, start, i)
        yield simulate(spec, start, days, r, signal_strength=signal_strength)
