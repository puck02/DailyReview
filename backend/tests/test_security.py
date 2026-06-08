from app.security import create_access_token, decode_access_token, hash_password, verify_password


def test_password_hash_is_not_plaintext_and_verifies():
    password_hash = hash_password("correct horse battery staple")

    assert password_hash != "correct horse battery staple"
    assert "correct horse battery staple" not in password_hash
    assert verify_password("correct horse battery staple", password_hash)
    assert not verify_password("wrong password", password_hash)


def test_access_token_roundtrip():
    token = create_access_token(user_id=42, secret_key="test-secret")

    payload = decode_access_token(token, secret_key="test-secret")

    assert payload["sub"] == "42"
