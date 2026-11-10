"""Train, evaluate and save the VOC risk model:  `python -m app.train`  (about 1-2 minutes on a laptop).

1. Simulate a literature-calibrated cohort (`app.simulator`, default 2,000 patients x 365 days).
2. Build the v2 feature vector for every patient-day with the same code the API uses (`app.features`).
3. Compare logistic regression and gradient boosting (plus a check-ins-only ablation) on a patient-level split,
   calibrate on separate patients, check a temporal hold-out (last 2 months), a learning curve (how many patients
   are needed) and a no-prodrome robustness run.
4. Save the chosen model to `api/models/voc_model.joblib` and write `docs/MODEL_REPORT.md`.

Everything here is SYNTHETIC. The numbers show how the pipeline behaves on data that follow the published
literature; they are not clinical accuracy. To retrain on real data see "Retraining on real data" in the report.

Options: --patients N --days D --seed S --workers W --no-report --out PATH
"""
from __future__ import annotations

import argparse
import logging
import math
import os

os.environ.setdefault("KMP_BLOCKTIME", "0")      # libomp: don't spin-wait between parallel regions (shared machine)
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from app import features as F
from app import simulator as S

log = logging.getLogger("app.train")
HORIZON = 7
WARMUP = 14                     # first days of each simulated patient are skipped (no history yet)
REPORT_PATH = Path(__file__).resolve().parents[2] / "docs" / "MODEL_REPORT.md"
SIM_START = date(2025, 1, 1)
CHECKIN_GROUPS = ("check-in", "history")


# =====================================================================================================================
# Dataset
# =====================================================================================================================
@dataclass
class Dataset:
    X: np.ndarray            # rows x features
    y: np.ndarray            # VOC onset in the next 7 days
    pid: np.ndarray          # patient index
    t: np.ndarray            # day index
    events: dict             # pid -> [onset day]
    patients: int
    days: int
    genotypes: dict          # pid -> genotype
    rates: dict              # genotype -> [events per patient-year]
    hospitalised: float
    los_median: float
    acs_share: float
    hu_share: float
    child_share: float
    device_share: dict

    @property
    def n_events(self) -> int:
        return int(sum(len(v) for v in self.events.values()))

    def subset(self, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return self.X[mask], self.y[mask]


def _patient_rows(args) -> tuple:
    i, seed, days, signal = args
    r = np.random.default_rng([seed, i])
    spec = S.sample_spec(r, SIM_START, i)
    sim = S.simulate(spec, SIM_START, days, r, signal_strength=signal)
    rec = F.Records.from_rows(sim.patient_row(), sim.checkins(), sim.daily_vitals(), sim.lab_rows,
                              sim.imaging_rows, sim.crises())
    y, active = sim.labels(HORIZON)
    ts = [t for t in range(WARMUP, days - HORIZON) if not active[t]]
    X = np.array([F.build(rec, sim.dates[t]).vector() for t in ts], dtype=np.float32).reshape(-1, len(F.KEYS))
    ev = [e for e in sim.events if e["day"] < days]
    meta = {"genotype": spec.genotype, "events": [e["day"] for e in ev], "n_year": len(ev) * 365 / days,
            "hosp": [e["hospitalised"] for e in ev], "los": [e["los"] for e in ev if e["hospitalised"]],
            "acs": [e["acs"] for e in ev], "hu": spec.on_hu, "child": spec.age(SIM_START) < 18,
            "devices": spec.devices}
    return i, X, y[ts], np.array(ts, dtype=np.int16), meta


def build_dataset(patients: int = 2000, days: int = 365, seed: int = 7, workers: int = 1,
                  signal_strength: float = S.SIGNAL_STRENGTH) -> Dataset:
    S.trigger_norm()
    jobs = [(i, seed, days, signal_strength) for i in range(patients)]
    if workers > 1:
        with ProcessPoolExecutor(workers) as ex:
            parts = list(ex.map(_patient_rows, jobs, chunksize=max(1, patients // (workers * 4))))
    else:
        parts = [_patient_rows(j) for j in jobs]
    Xs, ys, ps, ts = [], [], [], []
    events, gts, rates = {}, {}, {}
    hosp, los, acs, hu, child = [], [], [], [], []
    dev = {k: 0 for k in S.DEVICE_OWNERSHIP}
    for i, X, y, t, m in parts:
        Xs.append(X); ys.append(y); ps.append(np.full(len(y), i, dtype=np.int32)); ts.append(t)
        events[i] = m["events"]; gts[i] = m["genotype"]
        rates.setdefault(m["genotype"], []).append(m["n_year"])
        hosp += m["hosp"]; los += m["los"]; acs += m["acs"]; hu.append(m["hu"]); child.append(m["child"])
        for k in m["devices"]:
            dev[k] += 1
    return Dataset(np.vstack(Xs), np.concatenate(ys), np.concatenate(ps), np.concatenate(ts), events, patients,
                   days, gts, rates, float(np.mean(hosp)) if hosp else 0.0,
                   float(np.median(los)) if los else 0.0, float(np.mean(acs)) if acs else 0.0,
                   float(np.mean(hu)), float(np.mean(child)), {k: v / patients for k, v in dev.items()})


# =====================================================================================================================
# Models
# =====================================================================================================================
ALGOS = {"lr": "Logistic regression (sign-constrained)", "gbm": "Gradient boosting (HistGradientBoosting, monotonic)"}


def _fit_base(algo: str, X: np.ndarray, y: np.ndarray, cols: Optional[list[int]] = None):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    from app.risk import ColumnSubset, SignedLogistic
    dirs = [F.DIRECTION[k] for k in F.KEYS]
    if cols is not None:
        dirs = [dirs[c] for c in cols]
    if algo == "lr":
        est = SignedLogistic(dirs, C=0.3)
    else:
        # shallow, strongly regularised trees: the outcome is rare (~1 %) and deeper trees overfit (see report)
        est = HistGradientBoostingClassifier(learning_rate=0.03, max_iter=250, max_depth=3, min_samples_leaf=2000,
                                             l2_regularization=10.0, max_features=0.5, early_stopping=False,
                                             monotonic_cst=dirs, random_state=0)
    if cols is not None:
        est = ColumnSubset(est, cols)
    est.fit(X, y)
    return est


def fit(algo: str, X: np.ndarray, y: np.ndarray, Xc: np.ndarray, yc: np.ndarray,
        cols: Optional[list[int]] = None):
    """Fit on (X, y), calibrate on separate patients (Xc, yc): isotonic or sigmoid, whichever has the lower
    log-loss on the calibration patients."""
    from sklearn.metrics import log_loss

    from app.risk import CalibratedModel
    base = _fit_base(algo, X, y, cols)
    raw = base.predict_proba(Xc)[:, 1]
    best = None
    for method in ("isotonic", "sigmoid"):
        m = CalibratedModel.fit(base, raw, yc, method)
        loss = log_loss(yc, np.clip(m.predict_proba(Xc)[:, 1], 1e-6, 1 - 1e-6))
        if best is None or loss < best[0]:
            best = (loss, m)
    return best[1]


# =====================================================================================================================
# Metrics
# =====================================================================================================================
CAL_BINS = [0, 0.01, 0.02, 0.05, 0.10, 0.20, 0.35, 1.0]


def _bin_label(lo: float, hi: float) -> str:
    return f"{lo * 100:g}–{hi * 100:g}%"


def evaluate(p: np.ndarray, y: np.ndarray, pid: np.ndarray, t: np.ndarray, events: dict,
             thresholds: dict) -> dict:
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
    out = {"auroc": round(float(roc_auc_score(y, p)), 3), "auprc": round(float(average_precision_score(y, p)), 3),
           "brier": round(float(brier_score_loss(y, p)), 4), "prevalence": round(float(y.mean()), 4),
           "rows": int(len(y)), "positives": int(y.sum())}
    cal = []
    ece = 0.0
    for lo, hi in zip(CAL_BINS[:-1], CAL_BINS[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo)
        if m.sum() == 0:
            continue
        pr, ob = float(p[m].mean()), float(y[m].mean())
        ece += m.sum() / len(p) * abs(pr - ob)
        cal.append({"bin": _bin_label(lo, hi), "predicted": round(pr, 4), "observed": round(ob, 4),
                    "n": int(m.sum())})
    out["calibration"] = cal
    out["ece"] = round(ece, 4)
    # calibration slope / intercept-in-large (logistic recalibration of the logit)
    lp = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    try:
        from sklearn.linear_model import LogisticRegression
        lr = LogisticRegression(C=1e6, max_iter=1000).fit(lp.reshape(-1, 1), y)
        out["calibration_slope"] = round(float(lr.coef_[0][0]), 2)
    except Exception:  # noqa: BLE001
        out["calibration_slope"] = None
    out["observed_over_expected"] = round(float(y.sum() / max(p.sum(), 1e-9)), 2)

    order = np.lexsort((t, pid))
    p_o, y_o, pid_o, t_o = p[order], y[order], pid[order], t[order]
    weeks = len(p) / 7
    ops = []
    for level in ("moderate", "high", "critical"):
        thr = thresholds[level]
        pred = p_o >= thr
        tp = int((pred & (y_o == 1)).sum()); fp = int((pred & (y_o == 0)).sum())
        fn = int((~pred & (y_o == 1)).sum()); tn = int((~pred & (y_o == 0)).sum())
        alerts = _alert_episodes(pred, pid_o, t_o)
        ev_sens, lead, persistent = _event_detection(pred, pid_o, t_o, events)
        ops.append({"level": level, "threshold": thr,
                    "sensitivity": round(tp / max(1, tp + fn), 3), "specificity": round(tn / max(1, tn + fp), 3),
                    "ppv": round(tp / max(1, tp + fp), 3), "flagged_days_pct": round(float(pred.mean()) * 100, 1),
                    "alerts_per_100_weeks": round(alerts / weeks * 100, 1),
                    "events_warned": round(ev_sens, 3), "already_flagged": round(persistent, 3),
                    "median_lead_days": lead})
    out["operating_points"] = ops
    return out


def _alert_episodes(pred, pid, t) -> int:
    """New alerts: a flagged day with no flagged day for that patient in the 7 days before (one open alert)."""
    n = 0
    last: dict = {}
    for f, i, d in zip(pred, pid, t):
        if f:
            if i not in last or d - last[i] > 7:
                n += 1
            last[i] = d
    return n


def _event_detection(pred, pid, t, events) -> tuple[float, Optional[float], float]:
    """For crises with the week before onset in the data: share with any flagged day in that week, median days of
    warning from a *new* alert (a flagged run that started inside the week), and the share already flagged at the
    start of the week (persistently high-risk patients: no new information, so not counted as lead time)."""
    flagged: dict = {}
    for f, i, d in zip(pred, pid, t):
        if f:
            flagged.setdefault(int(i), set()).add(int(d))
    present = set(int(i) for i in np.unique(pid))
    tmin, tmax = int(t.min()), int(t.max())
    leads, warned, persistent, total = [], 0, 0, 0
    for i in present:
        fl = flagged.get(i, set())
        for d in events.get(i, []):
            if not (tmin + HORIZON <= d <= tmax + 1):
                continue
            total += 1
            week = [d - k for k in range(1, HORIZON + 1) if d - k in fl]
            if not week:
                continue
            warned += 1
            start = max(week)
            while start - 1 in fl:                       # walk back to the start of the flagged run
                start -= 1
            if d - start > HORIZON:
                persistent += 1
            else:
                leads.append(d - start)
    return ((warned / total) if total else 0.0, (float(np.median(leads)) if leads else None),
            (persistent / total) if total else 0.0)


# =====================================================================================================================
# Training run
# =====================================================================================================================
def _split(ds: Dataset, seed: int = 11) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    r = np.random.default_rng(seed)
    ids = r.permutation(ds.patients)
    n_tr, n_cal = int(0.6 * ds.patients), int(0.15 * ds.patients)
    tr, cal, te = set(ids[:n_tr]), set(ids[n_tr:n_tr + n_cal]), set(ids[n_tr + n_cal:])
    return np.isin(ds.pid, list(tr)), np.isin(ds.pid, list(cal)), np.isin(ds.pid, list(te))


def _choose(results: dict) -> str:
    """Best AUPRC among models whose calibration error is within 0.005 of the best-calibrated one."""
    best_ece = min(r["ece"] for r in results.values())
    ok = {k: r for k, r in results.items() if r["ece"] <= best_ece + 0.005} or results
    return max(ok, key=lambda k: ok[k]["auprc"])


def run(patients: int = 2000, days: int = 365, seed: int = 7, workers: int = 1, full: bool = True,
        path: Optional[Path] = None, report: bool = True, threads: Optional[int] = None) -> dict:
    """Simulate, fit, evaluate, save. BLAS/OpenMP threads are capped: several processes (API, MCP, tests) may train
    at the same time and oversubscribed OpenMP threads make gradient boosting crawl."""
    from threadpoolctl import threadpool_limits
    with threadpool_limits(limits=threads or (min(8, os.cpu_count() or 1) if full else 2)):
        return _run(patients, days, seed, workers, full, path, report)


def _run(patients: int, days: int, seed: int, workers: int, full: bool, path: Optional[Path],
         report: bool) -> dict:
    from app import risk
    t0 = time.time()
    path = path or risk.MODEL_PATH
    thresholds = risk.THRESHOLDS
    ds = build_dataset(patients, days, seed, workers)
    log.info("Simulated %d patients x %d days: %d rows, %d events (%.1fs)", patients, days, len(ds.y),
             ds.n_events, time.time() - t0)
    tr, cal, te = _split(ds)
    Xtr, ytr = ds.subset(tr); Xc, yc = ds.subset(cal); Xte, yte = ds.subset(te)
    ev = lambda p, m: evaluate(p, ds.y[m], ds.pid[m], ds.t[m], ds.events, thresholds)  # noqa: E731

    candidates = {"gbm": None, "lr": None} if full else {"lr": None}   # small cohorts: the simpler model
    results, models = {}, {}
    for algo in candidates:
        m = fit(algo, Xtr, ytr, Xc, yc)
        models[algo] = m
        results[algo] = ev(m.predict_proba(Xte)[:, 1], te)
        log.info("%s: AUROC %.3f AUPRC %.3f Brier %.4f", algo, results[algo]["auroc"], results[algo]["auprc"],
                 results[algo]["brier"])
    algo = _choose(results)
    comparison = [{"algorithm": ALGOS[a], "key": a, "auroc": r["auroc"], "auprc": r["auprc"], "brier": r["brier"],
                   "ece": r["ece"]} for a, r in results.items()]
    extra: dict = {}
    if full:
        cols = [i for i, k in enumerate(F.KEYS) if F.GROUP[k] in CHECKIN_GROUPS]
        m = fit(algo, Xtr, ytr, Xc, yc, cols)
        r = ev(m.predict_proba(Xte)[:, 1], te)
        comparison.append({"algorithm": f"{ALGOS[algo]}, check-ins + history only (no devices, labs, imaging)",
                           "key": f"{algo}_checkin_only", "auroc": r["auroc"], "auprc": r["auprc"],
                           "brier": r["brier"], "ece": r["ece"]})
        # temporal hold-out: fit on everything before the last 2 months, test on the last 2 months
        cutoff = days - 61
        ptr = tr | te
        before = ptr & (ds.t < cutoff - HORIZON)
        cal_before = cal & (ds.t < cutoff - HORIZON)
        after = ds.t >= cutoff
        m = fit(algo, ds.X[before], ds.y[before], ds.X[cal_before], ds.y[cal_before])
        extra["temporal"] = ev(m.predict_proba(ds.X[after])[:, 1], after)
        extra["temporal"]["period"] = (f"{SIM_START + timedelta(days=cutoff)} to "
                                       f"{SIM_START + timedelta(days=days - HORIZON - 1)}")
        # learning curve: how many training patients are needed
        lc = []
        train_ids = np.unique(ds.pid[tr])
        for n in (100, 250, 500, len(train_ids)):
            ids = train_ids[:n]
            msk = np.isin(ds.pid, ids)
            m = fit(algo, ds.X[msk], ds.y[msk], Xc, yc)
            r = ev(m.predict_proba(Xte)[:, 1], te)
            lc.append({"patients": int(n), "patient_weeks": int(msk.sum() / 7), "events": int(
                sum(len(ds.events[i]) for i in ids)), "auroc": r["auroc"], "auprc": r["auprc"], "brier": r["brier"]})
        extra["learning_curve"] = lc
        # robustness: what if there is no pre-crisis drift at all (evidence for a multi-day prodrome is weak)
        rob = []
        for strength in (0.0, 0.5, 1.0):        # same 1,000 simulated patients, only the drift strength changes
            d2 = build_dataset(min(patients, 1000), days, seed + 100, workers, signal_strength=strength)
            a, b, c = _split(d2)
            m = fit(algo, d2.X[a], d2.y[a], d2.X[b], d2.y[b])
            r = evaluate(m.predict_proba(d2.X[c])[:, 1], d2.y[c], d2.pid[c], d2.t[c], d2.events, thresholds)
            rob.append({"signal_strength": strength, "patients": d2.patients, "auroc": r["auroc"],
                        "auprc": r["auprc"], "brier": r["brier"]})
        extra["robustness"] = rob

    # feature importance (permutation, on test patients) for the chosen algorithm
    importance = _importance(models[algo], Xte, yte) if full else {}
    # final model: refit on train + test patients, calibrate on the calibration patients
    final = fit(algo, np.vstack([Xtr, Xte]), np.concatenate([ytr, yte]), Xc, yc)
    main = results[algo]
    high = next(o for o in main["operating_points"] if o["level"] == "high")
    rates = {g: round(float(np.mean(v)), 2) for g, v in sorted(ds.rates.items())}
    bundle = {
        "model": final, "version": f"voc-{algo}-2.0", "schema": risk.SCHEMA, "keys": list(F.KEYS),
        "algorithm_key": algo, "algorithm": ALGOS[algo],
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "training_rows": int(len(Xtr) + len(Xte)), "calibration_rows": int(len(Xc)),
        "positive_rate": round(float(ds.y.mean()), 4), "auc": main["auroc"], "auprc": main["auprc"],
        "brier": main["brier"], "ece": main["ece"], "calibration": main["calibration"],
        "calibration_slope": main["calibration_slope"], "operating_points": main["operating_points"],
        "lead_time_days": high["median_lead_days"], "comparison": comparison,
        "cohort": {"patients": patients, "patient_days": int(len(ds.y)), "events": ds.n_events,
                   "source": "synthetic", "days": days, "start": SIM_START.isoformat(),
                   "voc_rate_per_year": rates,
                   "genotype_patients": {g: len(v) for g, v in sorted(ds.rates.items())},
                   "hospitalised_share": round(ds.hospitalised, 2),
                   "los_median_days": ds.los_median, "acs_share": round(ds.acs_share, 3),
                   "hydroxyurea_share": round(ds.hu_share, 3), "child_share": round(ds.child_share, 2),
                   "device_share": {k: round(v, 2) for k, v in ds.device_share.items()}},
        "importance": importance, "quick": not full, **extra,
        "train_seconds": round(time.time() - t0, 1),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    import joblib
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    joblib.dump(bundle, tmp)
    os.replace(tmp, path)          # atomic: the API / MCP server may be loading it
    if report:
        write_report(bundle)
    log.info("Saved %s (%s) in %.0fs", path, bundle["version"], time.time() - t0)
    return bundle


def _importance(model, X: np.ndarray, y: np.ndarray) -> dict:
    """Permutation importance (drop in AUPRC x 100 when a feature is shuffled), signed by the model's average
    effect: mean of (risk now - risk with that feature at its normal value) over rows where it is not normal."""
    from sklearn.metrics import average_precision_score
    r = np.random.default_rng(0)
    idx = r.choice(len(y), size=min(len(y), 60000), replace=False)
    Xs, ys = X[idx], y[idx]
    base = average_precision_score(ys, model.predict_proba(Xs)[:, 1])
    out = {}
    for j, k in enumerate(F.KEYS):
        if np.all(Xs[:, j] == Xs[0, j]):
            out[k] = 0.0
            continue
        drops = []
        for rep in range(2):
            Xp = Xs.copy()
            Xp[:, j] = Xs[r.permutation(len(ys)), j]
            drops.append(base - average_precision_score(ys, model.predict_proba(Xp)[:, 1]))
        rows = Xs[Xs[:, j] != F.NORMAL[j]][:5000]
        sign = 1.0
        if len(rows):
            alt = rows.copy()
            alt[:, j] = F.NORMAL[j]
            eff = float(np.mean(model.predict_proba(rows)[:, 1] - model.predict_proba(alt)[:, 1]))
            sign = -1.0 if eff < 0 else 1.0
        out[k] = round(float(max(0.0, np.mean(drops)) * 100 * sign), 3)
    return out


def quick(path: Optional[Path] = None) -> dict:
    """Small model for a cold start (no saved model): 400 patients, logistic regression, ~10 s."""
    return run(patients=400, days=365, seed=7, workers=1, full=False, path=path, report=False)


# =====================================================================================================================
# Report
# =====================================================================================================================
def _pct(x) -> str:
    return "–" if x is None else f"{x * 100:.1f}%"


def write_report(b: dict, path: Path = REPORT_PATH) -> None:
    from app import risk
    c = b["cohort"]
    L = []
    w = L.append
    w("# SickleGuard VOC risk model: report")
    w("")
    w(f"_Generated by `python -m app.train` on {b['trained_at']} · model `{b['version']}` · "
      f"training took {b['train_seconds']} s._")
    w("")
    w("> **All data here are synthetic.** The cohort was produced by `app/simulator.py` from published rates and "
      "effect sizes (`docs/research/sim_params.json`, sources and confidence in `docs/research/DATA_SOURCES.md`), "
      "many of them low-confidence placeholders. The metrics show how the pipeline behaves when the world works the "
      "way the simulator assumes. **They are not clinical accuracy** and must not be quoted as such. The model has to "
      "be retrained and validated on real, consented outcome data before any clinical use.")
    w("")
    w("## Task")
    w("Predict a **healthcare-utilisation vaso-occlusive crisis** (ED / day hospital / admission, the event stored in "
      "the `crises` table; Platt 1991 definition) starting in the **next 7 days**, from data up to today: daily "
      "check-ins, IoT devices (wearable, pulse oximeter, smart bottle, thermometer), EMR labs, imaging findings and "
      "crisis history. Days inside an ongoing crisis are not scored.")
    w("")
    w("## Simulated cohort vs literature")
    w(f"- {c['patients']:,} patients × {c['days']} days from {c['start']} (Ghana regions weighted by 2021 census "
      f"population, genotype mix by climate zone, ~{c['child_share'] * 100:.0f}% children); "
      f"{c['patient_days']:,} scored patient-days; **{c['events']:,} crises**; "
      f"7-day outcome rate {b['positive_rate'] * 100:.2f}%.")
    lit = {"HbSS": 0.8, "HbSβ0": 1.0, "HbSC": 0.4, "HbSβ+": 0.4}
    w("")
    w("| Genotype | Patients | Simulated VOC / patient-year | Platt 1991 (utilisation-defined) |")
    w("| --- | --- | --- | --- |")
    for g, v in c["voc_rate_per_year"].items():
        w(f"| {g} | {c.get('genotype_patients', {}).get(g, '–')} | {v} | {lit.get(g, '–')} |")
    w("")
    w("Rates for HbSβ0 / HbSβ+ rest on very few simulated patients (rare in Ghana: Kumasi registry Sβ+ 0.3 %); "
      "Platt's rates are US cohort means, African utilisation rates may differ.")
    w("")
    w(f"- Admitted: {c['hospitalised_share'] * 100:.0f}% of crises (research placeholder 60%); median length of stay "
      f"{c['los_median_days']:g} days (Ghana DHIMS-II median 3 adults, Kumasi paediatric 6); acute chest syndrome in "
      f"{c['acs_share'] * 100:.1f}% of crises.")
    w(f"- Hydroxyurea: {c['hydroxyurea_share'] * 100:.0f}% of patients (assumed 15% coverage among HbSS, adherence "
      f"~60%). Devices owned: " + ", ".join(f"{k.replace('_', ' ')} {v * 100:.0f}%"
                                          for k, v in c["device_share"].items()) +
      "; each device misses 15–30% of days plus outages.")
    w("- Pre-crisis drift follows the research file (pain +0.3/+0.8/+1.8 on days −3/−2/−1, resting HR +1/+3, HRV "
      "−5/−15%, steps −10/−30%, sleep −0.2/−0.6 h, fluids −0.2/−0.4 L, skin temperature only when infection-"
      "triggered). Fever means ≥ 38.5 °C (101.3 °F). Home-managed pain episodes that never reach hospital (1.5 per utilisation crisis) are simulated "
      "as realistic false alarms.")
    w("")
    w("## Results (patient-level split)")
    w("Patients were split 60% training / 15% calibration / 25% test; no patient appears in two parts. Calibration "
      "(isotonic or sigmoid, whichever fitted the calibration patients better) was learned on the calibration "
      "patients only.")
    w("")
    w("| Model | AUROC | AUPRC | Brier | Calibration error (ECE) |")
    w("| --- | --- | --- | --- | --- |")
    for r in b["comparison"]:
        chosen = " **(chosen)**" if r["key"] == b["algorithm_key"] else ""
        w(f"| {r['algorithm']}{chosen} | {r['auroc']:.3f} | {r['auprc']:.3f} | {r['brier']:.4f} | {r['ece']:.4f} |")
    w("")
    full_r = next(r for r in b["comparison"] if r["key"] == b["algorithm_key"])
    ci = next((r for r in b["comparison"] if r["key"].endswith("checkin_only")), None)
    if ci:
        w(f"**Do devices, labs and imaging help?** In this simulation, with device effect sizes taken from the "
          f"(weak) literature, the full model reaches AUPRC {full_r['auprc']:.3f} vs {ci['auprc']:.3f} for check-ins + "
          f"history alone (AUROC {full_r['auroc']:.3f} vs {ci['auroc']:.3f}): "
          + ("little or no gain. " if full_r["auprc"] - ci["auprc"] < 0.01 else "a modest gain. ")
          + "Crisis history and self-reported pain carry most of the signal. Whether wearables add real value can "
            "only be answered with real device data, which is the main reason to start collecting it.")
        w("")
    w(f"Outcome prevalence in the test patients is {b['positive_rate'] * 100:.2f}%, so an AUPRC of "
      f"{b['auprc']:.3f} is about {b['auprc'] / max(b['positive_rate'], 1e-9):.0f}× chance. "
      f"Calibration slope {b.get('calibration_slope')} (1 = ideal). Selection rule: best AUPRC among models whose "
      "calibration error is within 0.005 of the best-calibrated one.")
    w("")
    w("### Operating points (risk levels)")
    w("Sensitivity / specificity / PPV are per patient-day. Alerts = a new alert when a patient crosses the threshold "
      "with no alert in the previous 7 days (as the app does: one open alert per patient). Crises warned = a flagged "
      "day in the week before onset; some of those patients were flagged all week (persistently high risk, no new "
      "signal). Lead time = days from the start of a *new* flagged run inside that week to the crisis.")
    w("")
    w("| Level | Threshold | Sensitivity (days) | Specificity | PPV | Alerts / 100 patient-weeks | Crises warned | "
      "…of which flagged all week | Median lead of new alerts (days) |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for o in b["operating_points"]:
        w(f"| {o['level']} | ≥ {o['threshold'] * 100:g}% | {_pct(o['sensitivity'])} | {_pct(o['specificity'])} | "
          f"{_pct(o['ppv'])} | {o['alerts_per_100_weeks']} | {_pct(o['events_warned'])} | "
          f"{_pct(o.get('already_flagged'))} | "
          f"{'–' if o['median_lead_days'] is None else o['median_lead_days']} |")
    w("")
    w("### Calibration (test patients)")
    w("| Predicted risk | Mean predicted | Observed | Patient-days |")
    w("| --- | --- | --- | --- |")
    for r in b["calibration"]:
        w(f"| {r['bin']} | {r['predicted'] * 100:.2f}% | {r['observed'] * 100:.2f}% | {r['n']:,} |")
    if b.get("temporal"):
        t = b["temporal"]
        w("")
        w("## Temporal hold-out")
        w(f"Fitted on data before the last two months, tested on {t['period']} (all patients; the window includes the "
          f"start of the harmattan season): AUROC {t['auroc']:.3f}, AUPRC {t['auprc']:.3f}, Brier {t['brier']:.4f}, "
          f"ECE {t['ece']:.4f}, observed/expected {t['observed_over_expected']}.")
    if b.get("learning_curve"):
        w("")
        w("## How much data is enough? (learning curve)")
        w("Same test patients, chosen algorithm trained on more and more patients:")
        w("")
        w("| Training patients | Patient-weeks | Crises | AUROC | AUPRC | Brier |")
        w("| --- | --- | --- | --- | --- | --- |")
        for r in b["learning_curve"]:
            w(f"| {r['patients']:,} | {r['patient_weeks']:,} | {r['events']:,} | {r['auroc']:.3f} | {r['auprc']:.3f} | "
              f"{r['brier']:.4f} |")
        w("")
        w("For real data, the research file's sample-size calculation (Riley et al. BMJ 2020, 7-day risk 2%, ~20 "
          "parameters) asks for **≥ 6,600 patient-weeks and ≥ 130 crises**, better **≥ 200 crises from ≥ 150–200 "
          "different patients**, plus **100–200 crises** at another site or period for external validation. The "
          "simulated curve is still rising at ~700 crises, so more data keeps helping; on early real data prefer the "
          "simpler logistic regression (fewer parameters, easier to check) and compare with gradient boosting once "
          "there are several hundred crises.")
    if b.get("robustness"):
        w("")
        w("## Robustness: how much depends on the assumed pre-crisis drift?")
        w("Evidence for a multi-day prodrome visible on consumer devices is weak (one pilot shows a 1-day lead). "
          "Re-running with weaker or no drift:")
        w("")
        w("| Prodrome strength | Patients | AUROC | AUPRC | Brier |")
        w("| --- | --- | --- | --- | --- |")
        for r in b["robustness"]:
            w(f"| {r['signal_strength']:g} | {r['patients']:,} | {r['auroc']:.3f} | {r['auprc']:.3f} | "
              f"{r['brier']:.4f} |")
        w("")
        gain = b["robustness"][-1]["auprc"] - b["robustness"][0]["auprc"]
        w("Strength 1 = the drifts in the research file; 0 = no pre-crisis change at all, so the model can only use "
          "triggers, traits and history (same 1,000 simulated patients in every row). "
          + (f"The literature-sized drifts change AUPRC by only {gain:+.3f}: at these effect sizes the short "
             "pre-crisis changes are buried in day-to-day noise, and the score mostly ranks patients by baseline "
             "risk (history, genotype, hydroxyurea adherence) and current triggers. Real early-warning value depends "
             "on prodromes that are larger or longer than published pilots show."
             if gain < 0.01 else
             f"The drifts add {gain:+.3f} AUPRC, so part of the performance rests on this weakly evidenced "
             "assumption."))
    w("")
    w("## Top features (permutation importance)")
    w("Drop in AUPRC (×100) when the feature is shuffled in the test patients; sign = direction of effect.")
    w("")
    w("| Feature | Source | Importance |")
    w("| --- | --- | --- |")
    imp = sorted(b["importance"].items(), key=lambda kv: abs(kv[1]), reverse=True)
    for k, v in imp[:15]:
        w(f"| {F.LABELS[k]} | {F.GROUP[k]} | {v:+.2f} |")
    w("")
    w("## Inputs by source")
    for g in ("check-in", "device", "lab", "imaging", "history"):
        w(f"- **{g}**: " + ", ".join(F.LABELS[k] for k in F.KEYS if F.GROUP[k] == g))
    w("")
    w("Missing data never stop a score: a missing value counts as normal and a missing indicator (no wearable / "
      "oximeter / bottle / thermometer data in 2 days, no Hb in 90 days, days since the last check-in) tells the "
      "model. Device signals are compared with the patient's own 14-day baseline (days −16 to −3).")
    w("")
    w("## Safety rules (always override the model)")
    w("Fever ≥ 38.5 °C (101.3 °F) (check-in, or a thermometer reading in the last 24 h); SpO2 < 92% on a check-in or sustained "
      "≥ 15 min on the pulse oximeter in the last 24 h (two or more consecutive low readings spanning ≥ 15 min); "
      "chest symptoms; stroke-like symptoms; Hb ≥ 2 g/dL below baseline (lab or check-in in the last 2 days); "
      "pain ≥ 8/10.")
    w("")
    w("## Limitations")
    for x in risk.LIMITATIONS:
        w(f"- {x}")
    w("- The model family matches the simulator's structure (multiplicative triggers, small drifts), so simulated "
      "performance is optimistic compared with messy real data.")
    w("- Thresholds were set for the simulated prevalence; re-derive them from real alert burden and capacity.")
    w("")
    w("## Retraining on real data")
    w("1. Collect consented data: check-ins, device readings, labs, imaging and every crisis in the `crises` table "
      "(date, hospitalised, length of stay). The label is a crisis starting in the 7 days after the scored day.")
    w("2. Build rows with the **same code**: for each patient and day, `features.load(session, patient, as_of=day)` "
      "then `features.build(records, day)` (or bulk-load rows and call `features.Records.from_rows`).")
    w("3. Fit with `train.fit(algo, X_train, y_train, X_cal, y_cal)` using patient-level splits plus a temporal "
      "hold-out, evaluate with `train.evaluate(...)`, then save a bundle like `train.run` does (same keys, a new "
      "`version`, e.g. `voc-gbm-3.0-real`).")
    w("4. Keep the simulator for pre-training or augmentation only; **report metrics on real data only**, following "
      "TRIPOD+AI (calibration slope and intercept, decision curves), and validate externally on another site.")
    w("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(L), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Train the SickleGuard VOC model on simulated data.")
    ap.add_argument("--patients", type=int, default=2000)
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--no-report", action="store_true")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    b = run(a.patients, a.days, a.seed, a.workers, full=True, path=a.out, report=not a.no_report)
    print(f"{b['version']}: AUROC {b['auc']:.3f} AUPRC {b['auprc']:.3f} Brier {b['brier']:.4f} "
          f"(synthetic data) -> {a.out or 'api/models/voc_model.joblib'}")


if __name__ == "__main__":
    main()
