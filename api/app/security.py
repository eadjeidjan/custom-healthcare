"""Passwords (bcrypt), sign-in tokens (JWT) and the request dependencies that check them."""
from datetime import timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import User, get_session, now

_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode()[:72], bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode()[:72], hashed.encode())
    except ValueError:
        return False


def make_token(user: User) -> str:
    s = get_settings()
    claims = {"sub": user.id, "role": user.role, "exp": now() + timedelta(hours=s.jwt_hours)}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


async def current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
                       session: AsyncSession = Depends(get_session)) -> User:
    if creds is None:
        raise HTTPException(401, "Sign in first.")
    try:
        claims = jwt.decode(creds.credentials, get_settings().jwt_secret, algorithms=["HS256"])
        user = await session.get(User, claims["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        user = None
    if user is None:
        raise HTTPException(401, "Your sign-in has expired. Sign in again.")
    return user


async def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Only an administrator can do this.")
    return user


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role}
