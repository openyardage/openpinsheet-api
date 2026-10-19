#!/usr/bin/env python3
"""Upload a v1 directory built by publish.py to an R2 bucket.

Standard library only, Python 3.10+. The bucket speaks the S3 API, so the
requests are signed with AWS SigV4, region "auto", service "s3".

Credentials come from the env file (--env), a file of NAME=VALUE lines. Either
R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are used directly, or an access key is
derived from CLOUDFLARE_API_TOKEN: the id of GET .../user/tokens/verify and the
sha256 of the token value as the secret. No secret ever reaches stdout, stderr
or an exception message.

Before anything is sent the directory is checked like `index.py --check` and
every file is validated with validate.py. Day files are immutable (FORMAT.md
4.3): they are HEADed first, a missing one is uploaded and a present one is
compared by ETag against the local md5. A different ETag stops the run before
the first PUT. Day files go up with If-None-Match: *, so a run that races
another cannot overwrite one. Year files always go out, and index.json is
always last, so an index never points at a file that is not there yet.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import http.client
import json
import os
import re
import sys
import urllib.parse

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import index as _index  # noqa: E402

REGION = "auto"
SERVICE = "s3"
DEFAULT_API = "https://api.cloudflare.com"
VERIFY_PATH = "/client/v4/user/tokens/verify"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
DAY_CACHE = "public, max-age=31536000, immutable"
SHORT_CACHE = "public, max-age=300"
TIMEOUT = 30
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# http is a local convenience for tests; anything else must be https.
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


class UploadError(Exception):
    """A problem the caller reports. The message never carries a secret."""


# The env file ------------------------------------------------------------

def read_env(path):
    """Read NAME=VALUE lines. Empty lines and # lines are allowed.

    Every other line form raises with its line number and never with the line
    text, because the file carries secrets.
    """
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
    except OSError as exc:
        raise UploadError("cannot read the env file: %s" % (exc.strerror or "error"))
    for number, line in enumerate(raw.split("\n"), start=1):
        line = line.rstrip("\r")
        if line.strip() == "" or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise UploadError("env line %d is not NAME=VALUE" % number)
        name, value = line.split("=", 1)
        if ENV_NAME_RE.match(name.strip()) is None:
            raise UploadError("env line %d has a name that is not a shell name" % number)
        values[name.strip()] = value
    return values


def resolve_endpoint(explicit, env):
    if explicit:
        return explicit.rstrip("/")
    account = env.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        raise UploadError("no --endpoint and no CLOUDFLARE_ACCOUNT_ID in the env file")
    return "https://%s.r2.cloudflarestorage.com" % account


def resolve_credentials(env, api_base):
    access_key = env.get("R2_ACCESS_KEY_ID")
    secret_key = env.get("R2_SECRET_ACCESS_KEY")
    if access_key and secret_key:
        return access_key, secret_key
    token = env.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise UploadError("the env file carries neither R2_ACCESS_KEY_ID/"
                          "R2_SECRET_ACCESS_KEY nor CLOUDFLARE_API_TOKEN")
    token_id = _verify_token(api_base, token)
    return token_id, hashlib.sha256(token.encode("utf-8")).hexdigest()


def _verify_token(api_base, token):
    url = api_base.rstrip("/") + VERIFY_PATH
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    try:
        status, _headers, body = send("GET", url, headers)
    except (OSError, http.client.HTTPException) as exc:
        raise UploadError("the token verify request failed: %s" % type(exc).__name__)
    if status != 200:
        raise UploadError("the token verify request answered HTTP %d" % status)
    try:
        token_id = json.loads(body.decode("utf-8"))["result"]["id"]
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise UploadError("the token verify answer carried no token id")
    if not isinstance(token_id, str) or token_id == "":
        raise UploadError("the token verify answer carried no token id")
    return token_id


# HTTP --------------------------------------------------------------------

def send(method, url, headers, body=None):
    """One request over http.client. Returns status, headers, body bytes."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise UploadError("unsupported endpoint scheme")
    if parsed.scheme == "http" and parsed.hostname not in LOCAL_HOSTS:
        raise UploadError("http is only allowed for a local endpoint")
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=TIMEOUT)
    else:
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=TIMEOUT)
    out = dict(headers)
    # The signed Host must be the sent one, so both come from the URL.
    out["Host"] = _host_header(parsed)
    try:
        connection.request(method, target, body=body, headers=out)
        response = connection.getresponse()
        return response.status, response.headers, response.read()
    finally:
        connection.close()


def _send_or_error(method, url, headers, body=None):
    try:
        return send(method, url, headers, body)
    except (OSError, http.client.HTTPException) as exc:
        raise UploadError("%s %s failed: %s" % (method, url, type(exc).__name__))


def _host_header(parsed):
    host = parsed.hostname or ""
    default = 443 if parsed.scheme == "https" else 80
    if parsed.port is not None and parsed.port != default:
        return "%s:%d" % (host, parsed.port)
    return host


# SigV4 -------------------------------------------------------------------

def _sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _canonical_uri(path):
    """Percent-encode every path segment; the slashes between them stay."""
    if not path:
        path = "/"
    return "/".join(urllib.parse.quote(segment, safe="~") for segment in path.split("/"))


def _canonical_query(query):
    if not query:
        return ""
    pairs = []
    for part in query.split("&"):
        name, _, value = part.partition("=")
        pairs.append((urllib.parse.quote(name, safe="-_.~"),
                      urllib.parse.quote(value, safe="-_.~")))
    pairs.sort()
    return "&".join("%s=%s" % (name, value) for name, value in pairs)


def _signing_key(secret_key, date, region, service):
    key = ("AWS4" + secret_key).encode("utf-8")
    for part in (date, region, service, "aws4_request"):
        key = hmac.new(key, part.encode("utf-8"), hashlib.sha256).digest()
    return key


def authorization(method, url, headers, payload_hash, access_key, secret_key,
                  amz_date, region=REGION, service=SERVICE):
    """The AWS SigV4 Authorization header value.

    The canonical headers are sorted and lowercased, the date is UTC and the
    scope is <YYYYMMDD>/<region>/<service>/aws4_request.
    """
    parsed = urllib.parse.urlsplit(url)
    lower = {name.lower(): " ".join(str(value).split()) for name, value in headers.items()}
    lower.setdefault("host", _host_header(parsed))
    lower["x-amz-date"] = amz_date
    names = sorted(lower)
    canonical_headers = "".join("%s:%s\n" % (name, lower[name]) for name in names)
    signed_headers = ";".join(names)
    canonical_request = "\n".join((method, _canonical_uri(parsed.path),
                                   _canonical_query(parsed.query), canonical_headers,
                                   signed_headers, payload_hash))
    date = amz_date[:8]
    scope = "%s/%s/%s/aws4_request" % (date, region, service)
    string_to_sign = "\n".join(("AWS4-HMAC-SHA256", amz_date, scope,
                                _sha256_hex(canonical_request.encode("utf-8"))))
    signature = hmac.new(_signing_key(secret_key, date, region, service),
                         string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return ("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
            % (access_key, scope, signed_headers, signature))


def _amz_date():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _signed_headers(method, url, headers, body, access_key, secret_key):
    payload_hash = _sha256_hex(body) if body is not None else EMPTY_SHA256
    amz_date = _amz_date()
    signed = dict(headers)
    signed["x-amz-date"] = amz_date
    # R2 needs x-amz-content-sha256 on every signed request, also on a HEAD
    # without a body, and it takes part in the signature.
    signed["x-amz-content-sha256"] = payload_hash
    signed["Authorization"] = authorization(method, url, signed, payload_hash,
                                            access_key, secret_key, amz_date)
    return signed


# The run -----------------------------------------------------------------

def _content_type(key):
    # The same types as contentTypeFor() in api/src/worker.js; header=present
    # says the first line names the columns (RFC 4180, 3).
    if key.endswith(".csv"):
        return "text/csv; charset=utf-8; header=present"
    if key.endswith(".geojson"):
        return "application/geo+json"
    return "application/json"


def _cache_control(key):
    return DAY_CACHE if key.startswith("v1/days/") else SHORT_CACHE


def _r2_url(endpoint, bucket, key):
    return endpoint.rstrip("/") + "/" + bucket + "/" + key


def _read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def check_directory(directory):
    """Like `index.py --check`: validate every file and compare index.json.

    Returns a list of message lines. An empty list means the directory is
    ready to upload.
    """
    problems = []
    for path, problem in _index._validate_directory(directory):
        problems.append("%s:%s: %s: %s" % (path, problem.where, problem.column, problem.message))
    target = os.path.join(directory, "index.json")
    try:
        with open(target, encoding="utf-8") as handle:
            existing = json.load(handle)
    except OSError:
        problems.append("missing %s" % target)
        return problems
    except ValueError as exc:
        problems.append("%s: index.json: %s" % (target, exc))
        return problems
    if not isinstance(existing, dict):
        problems.append("%s: index.json must be an object" % target)
        return problems
    built = _index.build_index(directory, existing.get("generated", "1970-01-01"))
    existing.pop("generated", None)
    built.pop("generated", None)
    if existing != built:
        problems.append("%s does not match the files" % target)
    return problems


def run(directory, bucket, endpoint, access_key, secret_key, dry_run):
    """HEAD the day files, then PUT day, year and index files. Returns 0 or 1."""
    entries = list(_index._iter_files(directory))
    day_files = [(rel, path) for kind, rel, path in entries if kind == "day"]
    year_files = [(rel, path) for kind, rel, path in entries if kind == "year"]

    # All HEADs first, so a changed day file stops the run before any PUT.
    decisions = []
    mismatches = []
    for rel, path in day_files:
        body = _read_bytes(path)
        key = "v1/" + rel
        url = _r2_url(endpoint, bucket, key)
        headers = _signed_headers("HEAD", url, {}, None, access_key, secret_key)
        status, response_headers, _ = _send_or_error("HEAD", url, headers)
        if status == 404:
            decisions.append((key, body, "upload"))
        elif 200 <= status < 300:
            etag = (response_headers.get("ETag") or "").strip().strip('"')
            if etag.lower() == hashlib.md5(body).hexdigest():
                decisions.append((key, body, "skip"))
            else:
                mismatches.append(key)
        else:
            raise UploadError("HEAD %s answered HTTP %d" % (key, status))
    if mismatches:
        for key in mismatches:
            print("%s is in the bucket with other content" % key)
        print("a day file does not change, nothing uploaded")
        return 1

    skipped = sum(1 for _, _, decision in decisions if decision == "skip")
    planned = [(key, body, True) for key, body, decision in decisions if decision == "upload"]
    for rel, path in year_files:
        planned.append(("v1/" + rel, _read_bytes(path), False))
    # index.json last: the index never points at a file that is not there.
    planned.append(("v1/index.json", _read_bytes(os.path.join(directory, "index.json")), False))

    uploaded = 0
    if dry_run:
        for key, _body, _immutable in planned:
            print("would upload %s" % key)
        print("%d file(s) would upload" % len(planned))
    else:
        for key, body, immutable in planned:
            url = _r2_url(endpoint, bucket, key)
            # x-amz-content-sha256 is set in _signed_headers, from the body.
            headers = {
                "Content-Type": _content_type(key),
                "Cache-Control": _cache_control(key),
                "Content-MD5": base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
            }
            if immutable:
                # A day file never changes, so the bucket must not have it yet.
                headers["If-None-Match"] = "*"
            headers = _signed_headers("PUT", url, headers, body, access_key, secret_key)
            status, _response_headers, _ = _send_or_error("PUT", url, headers, body)
            if immutable and status == 412:
                raise UploadError("PUT %s answered HTTP 412: the day file appeared "
                                  "in the bucket meanwhile" % key)
            if not 200 <= status < 300:
                raise UploadError("PUT %s answered HTTP %d" % (key, status))
            uploaded += 1

    print("%d uploaded, %d skipped, dry-run %s"
          % (uploaded, skipped, "yes" if dry_run else "no"))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Upload a v1 directory to an R2 bucket")
    parser.add_argument("--env", required=True, help="file of NAME=VALUE lines")
    parser.add_argument("--bucket", required=True, help="the R2 bucket")
    parser.add_argument("--endpoint", default=None,
                        help="S3 endpoint, default from CLOUDFLARE_ACCOUNT_ID")
    parser.add_argument("--api", default=None, help="Cloudflare API base for the token verify")
    parser.add_argument("--dry-run", action="store_true", help="check and list, send no PUT")
    parser.add_argument("v1dir", help="the v1 directory built by publish.py")
    args = parser.parse_args(argv)

    # The directory is checked before any network call.
    problems = check_directory(args.v1dir)
    if problems:
        for line in problems:
            print(line)
        print("validation failed, nothing uploaded")
        return 1

    try:
        env = read_env(args.env)
        endpoint = resolve_endpoint(args.endpoint, env)
        api_base = args.api or os.environ.get("OPS_CF_API") or DEFAULT_API
        access_key, secret_key = resolve_credentials(env, api_base)
    except UploadError as exc:
        print("error: %s" % exc)
        return 2

    try:
        return run(args.v1dir, args.bucket, endpoint, access_key, secret_key, args.dry_run)
    except UploadError as exc:
        print("error: %s" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
