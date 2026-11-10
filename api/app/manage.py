"""Management commands, run inside the api container (the `sickleguard` CLI calls them):

    python -m app.manage list
    python -m app.manage create EMAIL [--name N] [--role R] [--mrn MRN] [--password-stdin]
    python -m app.manage set-role EMAIL ROLE
    python -m app.manage reset-password EMAIL [--password-stdin]
    python -m app.manage link-patient EMAIL MRN
    python -m app.manage disable EMAIL | enable EMAIL
    python -m app.manage reindex-knowledge

Passwords never travel on the command line: either one line on stdin (--password-stdin) or a generated password
printed once. A disabled account keeps its row (history, audit) but its password hash is prefixed so no password
matches; sign-in tokens already issued stay valid until they expire (JWT_HOURS).
"""
import argparse
import asyncio
import secrets
import sys
from typing import IO, Optional

from sqlalchemy import func, select

from app import db
from app.security import hash_password

ROLES = ("admin", "clinician", "patient", "policy")
DISABLED = "!disabled:"
MIN_PASSWORD = 10


class Fail(Exception):
    """A user-facing error: printed without a traceback, exit code 1."""


def generate_password() -> str:
    return secrets.token_urlsafe(15)  # 20 characters


def is_disabled(u: db.User) -> bool:
    if hasattr(db.User, "disabled"):
        return bool(getattr(u, "disabled"))
    return u.password_hash.startswith(DISABLED)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m app.manage", description="SickleGuard management commands")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="list accounts")
    c = sub.add_parser("create", help="create an account")
    c.add_argument("email")
    c.add_argument("--name", default="")
    c.add_argument("--role", choices=ROLES, default="clinician")
    c.add_argument("--mrn", default="", help="patient record number (role patient)")
    c.add_argument("--password-stdin", action="store_true", help="read the password from one line on stdin")
    r = sub.add_parser("set-role", help="change the role")
    r.add_argument("email")
    r.add_argument("role", choices=ROLES)
    pw = sub.add_parser("reset-password", help="set a new password")
    pw.add_argument("email")
    pw.add_argument("--password-stdin", action="store_true")
    lp = sub.add_parser("link-patient", help="link a patient account to a patient record")
    lp.add_argument("email")
    lp.add_argument("mrn")
    for name in ("disable", "enable"):
        d = sub.add_parser(name, help=f"{name} an account")
        d.add_argument("email")
    sub.add_parser("reindex-knowledge", help="re-index the bundled guidance (Qdrant + keyword passages)")
    return p


def _read_password(use_stdin: bool, stdin: IO[str]) -> tuple[str, bool]:
    """Returns (password, generated)."""
    if not use_stdin:
        return generate_password(), True
    pw = stdin.readline().strip()
    if len(pw) < MIN_PASSWORD:
        raise Fail(f"The password needs at least {MIN_PASSWORD} characters.")
    return pw, False


async def _user(session, email: str) -> db.User:
    u = await session.scalar(select(db.User).where(func.lower(db.User.email) == email.strip().lower()))
    if u is None:
        raise Fail(f"No account {email}.")
    return u


async def _patient(session, mrn: str) -> db.Patient:
    p = await session.scalar(select(db.Patient).where(func.lower(db.Patient.mrn) == mrn.strip().lower()))
    if p is None:
        raise Fail(f"No patient with MRN {mrn}.")
    return p


async def run(argv: list[str], stdin: Optional[IO[str]] = None, out: Optional[IO[str]] = None) -> int:
    """Run one command. Returns the exit code (0 ok, 1 failed)."""
    stdin = stdin or sys.stdin
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    say = lambda s: print(s, file=out)  # noqa: E731
    try:
        await db.create_tables()
        if args.cmd == "reindex-knowledge":
            from app import rag
            n = await rag.load_folder(reindex_vectors=True)
            say(f"Re-indexed {n} guidance documents.")
            return 0
        async with db.open_session() as s:
            if args.cmd == "list":
                users = (await s.scalars(select(db.User).order_by(db.User.role, db.User.email))).all()
                mrns = {}
                pids = [u.patient_id for u in users if u.patient_id]
                if pids:
                    rows = await s.execute(select(db.Patient.id, db.Patient.mrn).where(db.Patient.id.in_(pids)))
                    mrns = dict(rows.all())
                say(f"{'EMAIL':<36} {'ROLE':<10} {'STATUS':<9} {'PATIENT':<12} NAME")
                for u in users:
                    say(f"{u.email:<36} {u.role:<10} {'disabled' if is_disabled(u) else 'active':<9} "
                        f"{mrns.get(u.patient_id, '-') if u.patient_id else '-':<12} {u.name}")
                say(f"{len(users)} account(s)")
                return 0

            if args.cmd == "create":
                email = args.email.strip().lower()
                if "@" not in email:
                    raise Fail("Give an e-mail address.")
                if await s.scalar(select(db.User).where(func.lower(db.User.email) == email)):
                    raise Fail(f"{email} already exists (use reset-password or set-role).")
                patient_id = None
                if args.role == "patient":
                    if not args.mrn:
                        raise Fail("A patient account needs --mrn.")
                    p = await _patient(s, args.mrn)
                    other = await s.scalar(select(db.User).where(db.User.patient_id == p.id))
                    if other is not None:
                        raise Fail(f"MRN {p.mrn} is already linked to {other.email}.")
                    patient_id = p.id
                elif args.mrn:
                    raise Fail("--mrn is only for role patient.")
                pw, generated = _read_password(args.password_stdin, stdin)
                u = db.User(email=email, name=args.name or email.split("@")[0], role=args.role,
                            password_hash=hash_password(pw), patient_id=patient_id)
                s.add(u)
                await s.commit()
                say(f"Created {email} ({args.role}).")
                if generated:
                    say(f"Password (shown once, give it over a safe channel): {pw}")
                return 0

            u = await _user(s, args.email)
            if args.cmd == "set-role":
                if u.role == "admin" and args.role != "admin":
                    admins = await s.scalar(select(func.count()).select_from(db.User).where(db.User.role == "admin"))
                    if admins <= 1:
                        raise Fail("This is the last administrator; make another admin first.")
                u.role = args.role
                if args.role != "patient" and u.patient_id:
                    u.patient_id = None
                    say("Unlinked the patient record (only patient accounts have one).")
                await s.commit()
                say(f"{u.email} is now {args.role}.")
                if args.role == "patient" and not u.patient_id:
                    say(f"Link the record next: link-patient {u.email} <MRN>")
            elif args.cmd == "reset-password":
                pw, generated = _read_password(args.password_stdin, stdin)
                was_disabled = is_disabled(u) and not hasattr(db.User, "disabled")
                u.password_hash = (DISABLED if was_disabled else "") + hash_password(pw)
                await s.commit()
                say(f"New password set for {u.email}." + (" The account is still disabled." if was_disabled else ""))
                if generated:
                    say(f"Password (shown once, give it over a safe channel): {pw}")
            elif args.cmd == "link-patient":
                if u.role != "patient":
                    raise Fail(f"{u.email} is {u.role}; only patient accounts are linked (set-role {u.email} patient).")
                p = await _patient(s, args.mrn)
                other = await s.scalar(select(db.User).where(db.User.patient_id == p.id, db.User.id != u.id))
                if other is not None:
                    raise Fail(f"MRN {p.mrn} is already linked to {other.email}.")
                u.patient_id = p.id
                await s.commit()
                say(f"{u.email} now sees the record of MRN {p.mrn}.")
            elif args.cmd == "disable":
                if is_disabled(u):
                    say(f"{u.email} is already disabled.")
                    return 0
                if u.role == "admin":
                    active_admins = [a for a in (await s.scalars(select(db.User).where(db.User.role == "admin"))).all()
                                     if not is_disabled(a)]
                    if len(active_admins) <= 1:
                        raise Fail("This is the last active administrator.")
                if hasattr(db.User, "disabled"):
                    u.disabled = True
                else:
                    u.password_hash = DISABLED + u.password_hash
                await s.commit()
                say(f"{u.email} can no longer sign in (sessions already open end within the sign-in lifetime).")
            elif args.cmd == "enable":
                if not is_disabled(u):
                    say(f"{u.email} is already active.")
                    return 0
                if hasattr(db.User, "disabled"):
                    u.disabled = False
                else:
                    u.password_hash = u.password_hash[len(DISABLED):]
                await s.commit()
                say(f"{u.email} can sign in again.")
            return 0
    except Fail as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def main(argv: Optional[list[str]] = None) -> int:
    async def go() -> int:
        try:
            return await run(sys.argv[1:] if argv is None else argv)
        finally:
            await db.dispose()
    return asyncio.run(go())


if __name__ == "__main__":
    sys.exit(main())
