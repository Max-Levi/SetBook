"""Independent Python reference for AWS SigV4 (hashlib/hmac), used to cross-check
the browser implementation in storage-adapters.js. Transcribed separately
from the AWS documented signing process."""
import hashlib
import hmac
import sys
import urllib.parse


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sign(method, url, headers, payload, access_key, secret_key, region, service, amz_date):
    u = urllib.parse.urlparse(url)
    hdrs = {k.lower(): v.strip() for k, v in headers.items()}
    hdrs["host"] = u.hostname
    hdrs["x-amz-date"] = amz_date
    names = sorted(hdrs)
    canon_headers = "".join(f"{n}:{hdrs[n]}\n" for n in names)
    qs = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
    )
    payload_hash = sha256_hex(payload)
    canon_req = "\n".join([method, u.path or "/", qs, canon_headers, ";".join(names), payload_hash])
    scope = f"{amz_date[:8]}/{region}/{service}/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, sha256_hex(canon_req.encode())])
    key = hmac.new(("AWS4" + secret_key).encode(), amz_date[:8].encode(), hashlib.sha256).digest()
    for part in (region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, sts.encode(), hashlib.sha256).hexdigest()
    return (f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
            f"SignedHeaders={';'.join(names)}, Signature={sig}")


if __name__ == "__main__":
    auth = sign(
        "GET",
        "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-01",
        {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
        b"",
        "AKIDEXAMPLE",
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "us-east-1",
        "iam",
        "20150830T123600Z",
    )
    print(auth.split("Signature=")[1])
