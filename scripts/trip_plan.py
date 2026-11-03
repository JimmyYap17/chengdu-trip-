#!/usr/bin/env python3
"""Encrypt or decrypt the trip planner's itinerary (plan.enc.json).

The repository is public, so the plan is only ever committed encrypted. The app
decrypts it on the phone with the trip passphrase (AES-256-GCM, key from
PBKDF2-SHA256), the same format the browser's Web Crypto API uses.

Usage:
  TRIP_KEY=... python3 scripts/trip_plan.py decrypt /path/outside/repo/plan.json
  (edit that file)
  TRIP_KEY=... python3 scripts/trip_plan.py encrypt /path/outside/repo/plan.json

Never commit the plaintext plan or the passphrase.
"""
import base64, json, os, sys
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ENC = os.path.join(os.path.dirname(__file__), "..", "plan.enc.json")
ITER = 250_000
b64 = lambda b: base64.b64encode(b).decode()


def key(passphrase, salt, iterations):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(passphrase.encode())


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("encrypt", "decrypt"):
        sys.exit(__doc__)
    passphrase = os.environ.get("TRIP_KEY", "").strip()
    if not passphrase:
        sys.exit("Set TRIP_KEY to the trip passphrase.")
    path = os.path.abspath(sys.argv[2])
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if sys.argv[1] == "encrypt":
        plan = json.load(open(path))  # also checks it is valid JSON
        salt, iv = os.urandom(16), os.urandom(12)
        ct = AESGCM(key(passphrase, salt, ITER)).encrypt(iv, json.dumps(plan, ensure_ascii=False).encode(), None)
        json.dump({"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}, open(ENC, "w"))
        print(f"Encrypted {len(plan.get('days', []))} days into plan.enc.json")
    else:
        if path.startswith(repo + os.sep):
            sys.exit("Decrypt to a path outside the repository so the plaintext is never committed.")
        e = json.load(open(ENC))
        pt = AESGCM(key(passphrase, base64.b64decode(e["salt"]), e["iter"])).decrypt(base64.b64decode(e["iv"]), base64.b64decode(e["ct"]), None)
        json.dump(json.loads(pt), open(path, "w"), ensure_ascii=False, indent=1)
        print(f"Decrypted to {path}")


if __name__ == "__main__":
    main()
