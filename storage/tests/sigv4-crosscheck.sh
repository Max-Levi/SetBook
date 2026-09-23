#!/bin/bash
# Cross-checks the browser SigV4 implementation (storage-adapters.js, WebCrypto)
# against an independent Python reference (tests/sigv4-ref.py, hashlib).
# Both sign the AWS-documented IAM ListUsers example input; the signatures must agree.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"

JS_SIG=$(node --input-type=module -e "
import fs from 'fs';
const src = fs.readFileSync('$DIR/storage-adapters.js', 'utf8') + '\n;globalThis.__SBS = SetBookStorage;';
eval(src);
const { s3SignV4 } = globalThis.__SBS;
const out = await s3SignV4({
  method: 'GET',
  url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-01',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
  payload: '',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'iam',
  amzDate: '20150830T123600Z',
});
console.log(out.authorization.split('Signature=')[1]);
")

PY_SIG=$(python3 "$DIR/tests/sigv4-ref.py")

echo "JS (WebCrypto):  $JS_SIG"
echo "PY (hashlib):    $PY_SIG"
if [ "$JS_SIG" = "$PY_SIG" ]; then
  echo "MATCH — two independent implementations agree."
  exit 0
else
  echo "MISMATCH"
  exit 1
fi
