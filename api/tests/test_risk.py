from datetime import date, timedelta

from app import risk

P = risk.Profile("HbSS", True, 8.5, 6.0, 3)


def days(**kw):
    return [risk.Day(date=date.today() - timedelta(i), **kw) for i in range(7)]


def test_calm_days_are_low_and_triggers_raise_risk():
    calm = risk.assess(P, days(pain=1, hydration_litres=2.8, sleep_hours=7.5, stress=2, hydroxyurea_taken=True))
    bad = risk.assess(P, days(pain=6, hydration_litres=1.2, sleep_hours=5, stress=7, cold_exposure=True,
                              hydroxyurea_taken=False))
    assert calm.level == "low" and bad.score > calm.score + 30
    keys = [f["key"] for f in bad.factors]
    assert "low_hydration" in keys and "missed_hu" in keys
    assert any(f["key"] == "on_hu" and f["direction"] == "down" for f in calm.factors)


def test_red_flags_override_the_model():
    for kw, key in ((dict(temperature_c=38.9), "fever"), (dict(chest_symptoms=True), "chest"),
                    (dict(neuro_symptoms=True), "neuro"), (dict(spo2=90), "spo2")):
        r = risk.assess(P, [risk.Day(date=date.today(), **kw)])
        assert r.level == "critical" and r.red_flags[0]["key"] == key
    r = risk.assess(P, [risk.Day(date=date.today(), pain=9)])
    assert r.level in ("high", "critical") and r.red_flags[0]["key"] == "severe_pain"
    old = risk.assess(P, [risk.Day(date=date.today() - timedelta(days=5), temperature_c=39)])
    assert old.red_flags == []          # stale check-ins don't raise emergencies


def test_model_card_is_honest():
    c = risk.card()
    assert c["auc"] > 0.75 and "synthetic" in c["data_note"].lower() and len(c["features"]) == len(risk.KEYS)
