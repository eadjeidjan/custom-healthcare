"""app.manage: the account commands the sickleguard CLI runs inside the api container."""
import io

import pytest
from sqlalchemy import select

from app import db, manage


async def cmd(*argv: str, stdin: str = "") -> tuple[int, str]:
    out = io.StringIO()
    code = await manage.run(list(argv), stdin=io.StringIO(stdin), out=out)
    return code, out.getvalue()


async def a_mrn() -> str:
    async with db.open_session() as s:
        linked = select(db.User.patient_id).where(db.User.patient_id.is_not(None))
        return await s.scalar(select(db.Patient.mrn).where(db.Patient.id.not_in(linked)).limit(1))


async def test_list_shows_the_admin(client):
    code, out = await cmd("list")
    assert code == 0
    assert "admin@sickleguard.local" in out and "admin" in out


async def test_create_with_generated_password_signs_in(client):
    code, out = await cmd("create", "nurse@example.org", "--name", "Nurse A", "--role", "clinician")
    assert code == 0 and "shown once" in out
    pw = out.strip().splitlines()[-1].rsplit(" ", 1)[-1]
    r = await client.post("/api/v1/auth/login", json={"email": "nurse@example.org", "password": pw})
    assert r.status_code == 200 and r.json()["user"]["role"] == "clinician"
    code, _ = await cmd("create", "NURSE@example.org")
    assert code == 1  # duplicate (case-insensitive)


async def test_password_from_stdin_never_printed(client):
    code, out = await cmd("create", "pol@example.org", "--role", "policy", "--password-stdin",
                          stdin="a-long-secret-pass\n")
    assert code == 0 and "a-long-secret-pass" not in out
    r = await client.post("/api/v1/auth/login", json={"email": "pol@example.org", "password": "a-long-secret-pass"})
    assert r.status_code == 200
    code, _ = await cmd("reset-password", "pol@example.org", "--password-stdin", stdin="short\n")
    assert code == 1


async def test_patient_account_link_and_role(client):
    mrn = await a_mrn()
    assert (await cmd("create", "pt@example.org", "--role", "patient"))[0] == 1  # needs --mrn
    assert (await cmd("create", "pt0@example.org", "--role", "patient", "--mrn", "NO-SUCH-MRN"))[0] == 1
    code, _ = await cmd("create", "pt@example.org", "--role", "patient", "--mrn", mrn, "--password-stdin",
                        stdin="patient-pass-123\n")
    assert code == 0
    _, out = await cmd("list")
    assert mrn in out
    # one record, one patient account
    assert (await cmd("create", "pt2@example.org", "--role", "patient", "--mrn", mrn))[0] == 1
    # only patient accounts are linked
    assert (await cmd("link-patient", "admin@sickleguard.local", mrn))[0] == 1
    code, out = await cmd("set-role", "pt@example.org", "clinician")
    assert code == 0 and "Unlinked" in out
    await cmd("set-role", "pt@example.org", "patient")
    assert (await cmd("link-patient", "pt@example.org", mrn))[0] == 0
    async with db.open_session() as s:
        u = await s.scalar(select(db.User).where(db.User.email == "pt@example.org"))
        assert u.role == "patient" and u.patient_id


async def test_disable_and_enable(client):
    await cmd("create", "temp@example.org", "--password-stdin", stdin="temp-pass-12345\n")
    assert (await cmd("disable", "temp@example.org"))[0] == 0
    r = await client.post("/api/v1/auth/login", json={"email": "temp@example.org", "password": "temp-pass-12345"})
    assert r.status_code == 401
    _, out = await cmd("list")
    assert "disabled" in out
    assert (await cmd("enable", "temp@example.org"))[0] == 0
    r = await client.post("/api/v1/auth/login", json={"email": "temp@example.org", "password": "temp-pass-12345"})
    assert r.status_code == 200


async def test_last_admin_is_protected(client):
    assert (await cmd("disable", "admin@sickleguard.local"))[0] == 1
    assert (await cmd("set-role", "admin@sickleguard.local", "clinician"))[0] == 1
    assert (await cmd("disable", "nobody@example.org"))[0] == 1


def test_bad_role_is_rejected_by_argparse():
    with pytest.raises(SystemExit):
        manage._parser().parse_args(["set-role", "a@b.c", "superuser"])
