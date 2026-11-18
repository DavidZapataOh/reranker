"""Verifies a DSSE envelope from stdin with pyca/cryptography, independently of the TypeScript code."""

import base64
import json
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def pae(payload_type: bytes, body: bytes) -> bytes:
    return b"DSSEv1 %d %s %d %s" % (len(payload_type), payload_type, len(body), body)


data = json.load(sys.stdin)
key = Ed25519PublicKey.from_public_bytes(base64.b64decode(data["publicKey"], validate=True))
envelope = data["envelope"]
payload_type = envelope["payloadType"].encode()
body = base64.b64decode(envelope["payload"], validate=True)
if not envelope["signatures"]:
    sys.exit("envelope has no signatures")
for signature in envelope["signatures"]:
    sig = base64.b64decode(signature["sig"], validate=True)
    key.verify(sig, pae(payload_type, body))
    try:
        key.verify(sig, pae(payload_type, body + b" "))
    except InvalidSignature:
        pass
    else:
        sys.exit("a tampered payload verified")
print(f"verified {len(envelope['signatures'])} DSSE signature(s) with cryptography")
