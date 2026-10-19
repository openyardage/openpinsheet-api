"""Tests for tools/upload.py against a mock R2 server in this process."""
import contextlib
import hashlib
import http.server
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import index  # noqa: E402
import upload  # noqa: E402

EXAMPLES = os.path.join(ROOT, "examples", "v1")
BUCKET = "openpinsheet"
AUTH_RE = re.compile(
    r"^AWS4-HMAC-SHA256 Credential=([^/]+)/(\d{8})/auto/s3/aws4_request, "
    r"SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$")


class MockR2(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.objects = {}
        self.puts = []
        self.put_headers = []
        self.requests = []
        self.authorizations = []
        self.credentials = []
        self.auth_errors = []
        self.appear_on_put = None
        self.token = "cf-token-secret"
        self.token_id = "token-id-abc"
        self.deny_r2 = False
        self.deny_verify = False


class MockHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockR2/1"

    def log_message(self, *args):
        pass

    def _send(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _key(self):
        parts = urllib.parse.urlsplit(self.path).path.lstrip("/").split("/", 1)
        return parts[1] if len(parts) > 1 else ""

    def _check_auth(self):
        """Every R2 call must carry a SigV4 Authorization with our scope.

        R2 answers a signed request without x-amz-content-sha256 with 400, so
        the mock server does the same; the header must also be signed.
        """
        self.server.requests.append((self.command, self.path))
        auth = self.headers.get("Authorization", "")
        self.server.authorizations.append(auth)
        if not self.headers.get("x-amz-content-sha256"):
            self.server.auth_errors.append("x-amz-content-sha256 is missing")
            self._send(400, b"missing x-amz-content-sha256")
            return False
        if self.server.deny_r2:
            self._send(403, b"denied")
            return False
        match = AUTH_RE.match(auth)
        if match is None:
            self.server.auth_errors.append("bad authorization: %s" % auth)
            self._send(403, b"denied")
            return False
        if "x-amz-content-sha256" not in match.group(3).split(";"):
            self.server.auth_errors.append("x-amz-content-sha256 is not signed")
            self._send(400, b"x-amz-content-sha256 is not signed")
            return False
        for name in match.group(3).split(";"):
            # SigV4: every signed header must be on the wire.
            if self.headers.get(name) is None:
                self.server.auth_errors.append("%s is signed but not sent" % name)
                self._send(400, b"a signed header is missing")
                return False
        amz_date = self.headers.get("x-amz-date", "")
        if not amz_date.startswith(match.group(2)):
            self.server.auth_errors.append("date does not match the credential")
        self.server.credentials.append((match.group(1), match.group(2)))
        return True

    def do_HEAD(self):
        if not self._check_auth():
            return
        body = self.server.objects.get(self._key())
        if body is None:
            self._send(404)
            return
        self._send(200, headers={"ETag": '"%s"' % hashlib.md5(body).hexdigest()})

    def do_PUT(self):
        if not self._check_auth():
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        key = self._key()
        if_none_match = self.headers.get("If-None-Match")
        self.server.put_headers.append((key, if_none_match))
        # If-None-Match: * means "only when the object is not there". A key in
        # objects, or one that appeared after the HEAD, answers 412.
        if if_none_match == "*" and (key in self.server.objects
                                     or key == self.server.appear_on_put):
            self._send(412, b"precondition failed")
            return
        self.server.objects[key] = body
        self.server.puts.append(key)
        self._send(200, headers={"ETag": '"%s"' % hashlib.md5(body).hexdigest()})

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        self.server.requests.append(("GET", self.path))
        if path == "/client/v4/user/tokens/verify":
            expected = "Bearer " + self.server.token
            if self.server.deny_verify or self.headers.get("Authorization") != expected:
                self._send(403, b'{"success": false}')
                return
            body = json.dumps({"success": True,
                               "result": {"id": self.server.token_id}}).encode("utf-8")
            self._send(200, body, {"Content-Type": "application/json"})
            return
        self._send(404)


def make_v1(base):
    """The examples plus a year file and a matching index.json."""
    target = os.path.join(base, "v1")
    shutil.copytree(EXAMPLES, target)
    with open(os.path.join(target, "days", "2027-04-12.csv"), "rb") as handle:
        text = handle.read().decode("utf-8")
    text = text.replace("# OpenPinsheet day file 2027-04-12. Format 1.",
                        "# OpenPinsheet year file 2027. Format 1.", 1)
    years = os.path.join(target, "years")
    os.makedirs(years, exist_ok=True)
    with open(os.path.join(years, "2027.csv"), "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    with contextlib.redirect_stdout(io.StringIO()):
        index.main([target, "--generated", "2027-04-15"])
    return target


def write_env(path, text):
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return path


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.server = MockR2(("127.0.0.1", 0), MockHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.v1 = make_v1(self.tmp)
        self.env_path = write_env(os.path.join(self.tmp, "env"),
                                  "R2_ACCESS_KEY_ID=test-key\nR2_SECRET_ACCESS_KEY=test-secret\n")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def run_upload(self, args, env_path=None):
        env_path = env_path or self.env_path
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = upload.main(["--env", env_path, "--bucket", BUCKET,
                                "--endpoint", self.endpoint, "--api", self.endpoint] + args)
        return code, out.getvalue(), err.getvalue()


class TestUpload(UploadTest):
    def test_first_run_uploads_all_and_index_last(self):
        code, out, err = self.run_upload([self.v1])
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.server.puts, [
            "v1/days/2027-04-12.csv",
            "v1/days/2027-04-12.geojson",
            "v1/years/2027.csv",
            "v1/index.json",
        ])
        self.assertEqual(self.server.auth_errors, [])
        self.assertTrue(self.server.authorizations)
        self.assertIn("4 uploaded, 0 skipped, dry-run no", out)

    def test_second_run_skips_days_and_uploads_year_and_index(self):
        self.run_upload([self.v1])
        self.server.puts.clear()
        code, out, _ = self.run_upload([self.v1])
        self.assertEqual(code, 0)
        self.assertEqual(self.server.puts, ["v1/years/2027.csv", "v1/index.json"])
        self.assertIn("2 uploaded, 2 skipped, dry-run no", out)

    def test_day_files_carry_if_none_match_and_index_does_not(self):
        code, out, _ = self.run_upload([self.v1])
        self.assertEqual(code, 0, out)
        sent = dict(self.server.put_headers)
        self.assertEqual(sent["v1/days/2027-04-12.csv"], "*")
        self.assertEqual(sent["v1/days/2027-04-12.geojson"], "*")
        self.assertIsNone(sent["v1/years/2027.csv"])
        self.assertIsNone(sent["v1/index.json"])
        self.assertEqual(self.server.auth_errors, [])

    def test_day_file_race_with_412_aborts_before_index(self):
        self.server.appear_on_put = "v1/days/2027-04-12.csv"
        code, out, _ = self.run_upload([self.v1])
        self.assertEqual(code, 1, out)
        self.assertIn("HTTP 412", out)
        self.assertIn("appeared in the bucket meanwhile", out)
        self.assertNotIn("v1/index.json", self.server.puts)

    def test_changed_day_remote_aborts_without_put(self):
        self.server.objects["v1/days/2027-04-12.csv"] = b"something else"
        code, out, _ = self.run_upload([self.v1])
        self.assertEqual(code, 1, out)
        self.assertEqual(self.server.puts, [])
        self.assertIn("other content", out)

    def test_dry_run_makes_no_put(self):
        code, out, _ = self.run_upload(["--dry-run", self.v1])
        self.assertEqual(code, 0, out)
        self.assertEqual(self.server.puts, [])
        self.assertEqual(len(self.server.requests), 2)  # the two HEADs
        self.assertIn("would upload v1/index.json", out)
        self.assertIn("dry-run yes", out)

    def test_invalid_directory_aborts_without_network(self):
        with open(os.path.join(self.v1, "index.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        data["files"][0]["bytes"] += 1
        with open(os.path.join(self.v1, "index.json"), "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        code, out, _ = self.run_upload([self.v1])
        self.assertEqual(code, 1, out)
        self.assertEqual(self.server.requests, [])

    def test_derived_credentials_land_in_credential_line(self):
        env_path = write_env(os.path.join(self.tmp, "env_derived"),
                             "CLOUDFLARE_API_TOKEN=%s\n" % self.server.token)
        env = upload.read_env(env_path)
        access_key, secret_key = upload.resolve_credentials(env, self.endpoint)
        self.assertEqual(access_key, self.server.token_id)
        self.assertEqual(secret_key, hashlib.sha256(self.server.token.encode()).hexdigest())
        self.server.requests.clear()
        code, out, err = self.run_upload([self.v1], env_path=env_path)
        self.assertEqual(code, 0, out + err)
        self.assertIn(("GET", "/client/v4/user/tokens/verify"), self.server.requests)
        ids = [credential for credential, _date in self.server.credentials]
        self.assertTrue(ids)
        self.assertTrue(all(cid == self.server.token_id for cid in ids))

    def test_secrets_never_in_output(self):
        token = "cf-token-value-xyz"
        self.server.token = token
        self.server.token_id = "token-id-xyz"
        self.server.deny_r2 = True
        env_path = write_env(os.path.join(self.tmp, "env_secret"),
                             "CLOUDFLARE_API_TOKEN=%s\n" % token)
        code, out, err = self.run_upload([self.v1], env_path=env_path)
        output = out + err
        self.assertEqual(code, 1, output)
        self.assertNotIn(token, output)
        self.assertNotIn(hashlib.sha256(token.encode()).hexdigest(), output)
        self.assertNotIn(self.server.token_id, output)
        # The id did reach the wire, so its absence above is not for nothing.
        self.assertTrue(any(self.server.token_id in line for line in self.server.authorizations))

    def test_broken_env_line_reports_line_number_without_content(self):
        secret = "supersecretvalue-nobody-may-see"
        env_path = write_env(os.path.join(self.tmp, "env_broken"),
                             "# a comment\n"
                             "R2_ACCESS_KEY_ID=%s\n"
                             "\n"
                             "this line has no equals sign\n" % secret)
        code, out, err = self.run_upload([self.v1], env_path=env_path)
        output = out + err
        self.assertEqual(code, 2, output)
        self.assertIn("line 4", output)
        self.assertNotIn(secret, output)
        self.assertNotIn("this line has no equals sign", output)


class TestSendScheme(unittest.TestCase):
    def test_http_remote_is_refused_before_connecting(self):
        original = upload.http.client.HTTPConnection

        def boom(*args, **kwargs):
            raise AssertionError("a connection was built")

        upload.http.client.HTTPConnection = boom
        try:
            with self.assertRaises(upload.UploadError) as caught:
                upload.send("GET", "http://example.test/x", {})
        finally:
            upload.http.client.HTTPConnection = original
        self.assertIn("http is only allowed for a local endpoint", str(caught.exception))


class TestSigV4(unittest.TestCase):
    def test_signature_fixed_vector(self):
        # Fixed time, fixed keys, the scope of the tool itself, and
        # x-amz-content-sha256 like every signed request carries now. The
        # expected value is computed by hand from the SigV4 steps; the same
        # hand computation reproduces the published AWS IAM example.
        headers = {"Host": "example.r2.cloudflarestorage.com",
                   "x-amz-content-sha256": upload.EMPTY_SHA256,
                   "x-amz-date": "20260101T000000Z"}
        value = upload.authorization(
            "HEAD", "https://example.r2.cloudflarestorage.com/openpinsheet/v1/index.json",
            headers, upload.EMPTY_SHA256, "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20260101T000000Z")
        self.assertEqual(
            value,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/auto/s3/aws4_request, "
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
            "Signature=9c0ffc049062247ae5b67a87e22e5e51a38897fd91c9e19f4cd64101d20a7904")

    def test_endpoint_from_account_id(self):
        self.assertEqual(upload.resolve_endpoint(None, {"CLOUDFLARE_ACCOUNT_ID": "acc123"}),
                         "https://acc123.r2.cloudflarestorage.com")
        self.assertEqual(upload.resolve_endpoint("http://example.test/", {}),
                         "http://example.test")


if __name__ == "__main__":
    unittest.main()


class ContentTypeLikeWorker(unittest.TestCase):
    """upload.py and the worker put the same files into the same bucket."""

    def test_types_match_contentTypeFor(self):
        with open(os.path.join(ROOT, "api", "src", "worker.js"), encoding="utf-8") as handle:
            source = handle.read()
        block = re.search(r"function contentTypeFor\(path\) \{(.*?)\n\}", source, re.S).group(1)
        for key in ("days/2027-04-12.csv", "days/2027-04-12.geojson", "index.json"):
            with self.subTest(key=key):
                self.assertIn('"%s"' % upload._content_type(key), block)
