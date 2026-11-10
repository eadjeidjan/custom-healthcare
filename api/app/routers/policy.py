"""Policy dashboard endpoints (see docs/API.md, "Policy dashboard"; methods in docs/POLICY.md).

Role policy or admin. Anonymised aggregates only: no names, MRNs, ids, dates of birth or free text, and any group of
fewer than 5 patients is suppressed (analytics.MIN_GROUP)."""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app import analytics as an
from app import risk
from app.db import User, get_session
from app.security import policy_user

router = APIRouter(prefix="/policy", tags=["policy"])

CostBedDay = Query(an.DEFAULT_COST_BED_DAY, ge=0, le=100_000, description="GHS per bed-day")
EdVisit = Query(an.DEFAULT_ED_VISIT, ge=0, le=100_000, description="GHS per crisis treated without admission")


@router.get("/overview")
async def overview(cost_per_bed_day: float = CostBedDay, ed_visit_cost: float = EdVisit,
                   _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    return an.overview(await an.snapshot(s), cost_per_bed_day, ed_visit_cost)


@router.get("/regions")
async def regions(cost_per_bed_day: float = CostBedDay, ed_visit_cost: float = EdVisit,
                  _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    return an.regions(await an.snapshot(s), cost_per_bed_day, ed_visit_cost)


@router.get("/facilities")
async def facilities(cost_per_bed_day: float = CostBedDay, ed_visit_cost: float = EdVisit,
                     _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    return an.facilities(await an.snapshot(s), cost_per_bed_day, ed_visit_cost)


@router.get("/trends")
async def trends(months: int = Query(12, ge=1, le=24), region: Optional[str] = None,
                 _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    return an.trends(await an.snapshot(s), months, region)


@router.get("/forecast")
async def forecast(weeks: int = Query(8, ge=1, le=26), region: Optional[str] = None, detail: bool = False,
                   _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    """`[{week_start, expected_crises, low, high, expected_admissions, ...}]`; `detail=true` returns the object with
    the seasonality index and the admission rate used."""
    f = an.forecast(await an.snapshot(s), weeks, region)
    return f if detail else f["weeks"]


@router.get("/seasonality")
async def seasonality(_: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    return an.seasonality(await an.snapshot(s))


@router.get("/drivers")
async def drivers(detail: bool = False, _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    """`[{factor, label, share_of_risk, patients_affected, modifiable, ...}]`; `detail=true` adds totals."""
    d = an.drivers(await an.snapshot(s))
    return d if detail else d["drivers"]


@router.get("/interventions")
async def interventions(cost_per_bed_day: float = CostBedDay, ed_visit_cost: float = EdVisit,
                        hu_target: float = Query(0.6, ge=0, le=1), detail: bool = False,
                        _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    """Scenario estimates; `detail=true` adds the baseline and the formula so the client can recompute."""
    r = an.interventions(await an.snapshot(s), cost_per_bed_day, ed_visit_cost, hu_target)
    return r if detail else r["scenarios"]


@router.get("/meta")
async def meta(_: User = Depends(policy_user)):
    """What the dashboard is built on: privacy floor, sources, model version, defaults."""
    _pops, pop_source = an.populations()
    try:
        info = risk.card()
    except Exception:  # noqa: BLE001 - model file missing should not break the methods page
        info = {}
    return {"min_group": an.MIN_GROUP, "population_source": pop_source, "population_total": sum(_pops.values()),
            "model_version": info.get("version") or risk.MODEL_VERSION, "model_auc": info.get("auc"),
            "current_window_days": an.CURRENT_DAYS, "default_los": an.DEFAULT_LOS,
            "default_cost_per_bed_day_ghs": an.DEFAULT_COST_BED_DAY, "default_ed_visit_cost_ghs": an.DEFAULT_ED_VISIT,
            "season_prior": an.SEASON_PRIOR, "research_file": an.RESEARCH_FILE.exists(),
            "effects": {k: {**v, **an.research_effects().get(k, {})} for k, v in an.EFFECTS.items()},
            "programme_cost_ghs": an.PROGRAMME_COST, "research": an.research_highlights(),
            "as_of": date.today().isoformat()}


@router.get("/export.csv")
async def export_csv(cost_per_bed_day: float = CostBedDay, ed_visit_cost: float = EdVisit,
                     _: User = Depends(policy_user), s: AsyncSession = Depends(get_session)):
    snap = await an.snapshot(s)
    body = an.regions_csv(an.regions(snap, cost_per_bed_day, ed_visit_cost),
                          an.overview(snap, cost_per_bed_day, ed_visit_cost))
    name = f"sickleguard-regions-{snap.today.isoformat()}.csv"
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
