"""Signed user tokens (dh_chart_ext.tokens): no server needed."""
import time

from dh_chart_ext.tokens import sign_token, verify_token

SECRET = "test-secret"


def test_round_trip():
    assert verify_token(sign_token("alice", SECRET), SECRET) == "alice"


def test_user_with_dots():
    assert verify_token(sign_token("a.b.c", SECRET), SECRET) == "a.b.c"


def test_wrong_secret():
    assert verify_token(sign_token("alice", SECRET), "other") is None


def test_tampered_user():
    user, exp, sig = sign_token("alice", SECRET).rsplit(".", 2)
    assert verify_token(f"mallory.{exp}.{sig}", SECRET) is None


def test_expired():
    assert verify_token(sign_token("alice", SECRET, ttl_s=-10), SECRET) is None


def test_malformed():
    for t in ["", "alice", "alice.x", "alice.notanumber.sig", "...."]:
        assert verify_token(t, SECRET) is None


def test_expiry_in_token():
    _, exp, _ = sign_token("alice", SECRET, ttl_s=60).rsplit(".", 2)
    assert abs(int(exp) - (time.time() + 60)) < 5
