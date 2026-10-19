// Tests for api/openapi.json against API.md, FORMAT.md, api/src/worker.js and
// api/src/core.js.
//
// Run from openpinsheet/ with a glob, because Node 24 no longer searches a
// directory argument to --test:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkSubmission, historyGeojson, liveGeojson } from "../src/core.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const workerSource = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

// Resolve a local JSON pointer of the form #/a/b against the spec, following
// one $ref if the target carries another. Every segment is unescaped as in RFC
// 6901 (~1 for "/", ~0 for "~").
function pointer(ref) {
  assert.equal(typeof ref, "string");
  assert.equal(ref.startsWith("#/"), true, "not a local $ref: " + ref);
  let node = spec;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    assert.ok(node !== null && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, part),
      "unresolved $ref: " + ref);
    node = node[part];
  }
  return node;
}

function deref(node) {
  let current = node;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    current = pointer(current.$ref);
  }
  return current;
}

test("the file is valid JSON, OpenAPI 3.1, and every $ref resolves inside it", () => {
  assert.equal(typeof spec, "object");
  assert.equal(spec.openapi.startsWith("3.1"), true);
  const refs = [];
  (function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      if (typeof node.$ref === "string") {
        refs.push(node.$ref);
      }
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  })(spec);
  assert.ok(refs.length > 0, "no $ref in the document");
  for (const ref of refs) {
    pointer(ref);
  }
});

test("every path and method worker.js answers is described", () => {
  // The paths come from the router in worker.js, so a new endpoint without a
  // description turns this red. Until 18.10.2026 the list here was typed by
  // hand, and GET /v1/pins went in without a line in openapi.json.
  const routed = [];
  for (const match of workerSource.matchAll(/url\.pathname === "\/v1(\/[a-z/]+)"/g)) {
    routed.push(match[1]);
  }
  assert.ok(routed.length >= 5, "collected " + routed.length + " paths: " + routed.join(", "));
  // The account and the review are pages for people (API.md 3), not JSON
  // endpoints; they must be named in API.md instead.
  const apiText = readFileSync(new URL("../../API.md", import.meta.url), "utf8");
  for (const path of routed) {
    if (path.startsWith("/account") || path === "/review") {
      assert.ok(apiText.includes(path.startsWith("/account") ? "/v1/account" : "review"),
        path + " is routed in worker.js but not named in API.md");
      continue;
    }
    assert.ok(spec.paths[path], path + " is routed in worker.js but missing from openapi.json");
  }
  assert.equal(typeof spec.paths["/live"].get, "object");
  assert.equal(typeof spec.paths["/pins"].get, "object");
  assert.equal(typeof spec.paths["/submissions"].post, "object");
  assert.equal(typeof spec.paths["/submissions"].delete, "object");
});

test("every reader error code appears in the description", () => {
  const block = /const READER_MESSAGES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(workerSource);
  assert.ok(block, "the READER_MESSAGES block was not found in worker.js");
  const text = JSON.stringify(spec);
  let count = 0;
  for (const line of block[1].split("\n")) {
    const match = /^\s*([a-z_]+):\s*"/.exec(line);
    if (match) {
      count += 1;
      assert.notEqual(text.indexOf(match[1]), -1, "error code missing from openapi.json: " + match[1]);
    }
  }
  assert.equal(count, 9, "collected " + count + " reader error codes");
});

test("every error code worker.js can return appears in the description", () => {
  const block = /const MESSAGES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(workerSource);
  assert.ok(block, "the MESSAGES block was not found in worker.js");
  const codes = [];
  for (const line of block[1].split("\n")) {
    const match = /^\s*([a-z_]+):\s*"/.exec(line);
    if (match) {
      codes.push(match[1]);
    }
  }
  assert.equal(codes.length, 12, "collected " + codes.length + " error codes: " + codes.join(", "));
  const text = JSON.stringify(spec);
  for (const code of codes) {
    assert.notEqual(text.indexOf(code), -1, "error code missing from openapi.json: " + code);
  }
});

test("the submission examples match checkSubmission", () => {
  const examples = spec.components.examples;
  const today = examples.submissionDay.value.date;
  assert.equal(checkSubmission(examples.submissionDay.value, today).ok, true, "the API.md 1 example is rejected");
  assert.equal(checkSubmission(examples.submissionLostPosition.value, today).ok, true, "the lost position is rejected");
  assert.equal(checkSubmission(examples.submissionUnknownField.value, today).ok, false, "the unknown field was accepted");

  // The example attached to POST /submissions is the same body as the API.md 1
  // example, so the request shown really passes.
  const attached = deref(spec.paths["/submissions"].post.requestBody.content["application/json"].examples.submissionDay);
  assert.deepEqual(attached.value, examples.submissionDay.value);
  assert.equal(checkSubmission(attached.value, attached.value.date).ok, true);
});

test("the 200 example of /live has the structure liveGeojson produces", () => {
  const example = spec.paths["/live"].get.responses["200"].content["application/geo+json"].example;
  const rows = example.features.map((feature) => {
    const row = Object.assign({}, feature.properties);
    if (feature.geometry !== null) {
      row.lat = feature.geometry.coordinates[1];
      row.lon = feature.geometry.coordinates[0];
    }
    return row;
  });
  const generated = JSON.parse(new TextDecoder().decode(liveGeojson(example.as_of, rows)));

  assert.deepEqual(Object.keys(example).sort(), Object.keys(generated).sort());
  assert.equal(example.features.length, 3, "the example must carry two positions and one lost position");
  assert.equal(generated.features.length, example.features.length);
  example.features.forEach((feature, index) => {
    assert.deepEqual(
      Object.keys(feature.properties).sort(),
      Object.keys(generated.features[index].properties).sort(),
      "property names of feature " + index,
    );
  });
  assert.equal(example.features.filter((feature) => feature.geometry === null).length, 1,
    "the lost position must carry geometry null");
});

// The codes and sentences of worker.js, read from its source like above.
function messagesOf(name) {
  const block = new RegExp("const " + name + " = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);").exec(workerSource);
  assert.ok(block, "the " + name + " block was not found in worker.js");
  const out = {};
  for (const match of block[1].matchAll(/^\s*([a-z_]+):\s*"([^"]*)"/gm)) {
    out[match[1]] = match[2];
  }
  return out;
}

function operations() {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === "object" && op.responses) {
        out.push({ path, method, op });
      }
    }
  }
  return out;
}

test("every error answer is a problem document whose examples match worker.js", () => {
  // RFC 9457 since 19.10.2026. The example is what problemBody()
  // in worker.js builds: title from STATUS_TITLES, detail the fixed sentence.
  const messages = Object.assign({}, messagesOf("MESSAGES"), messagesOf("READER_MESSAGES"));
  const titles = {};
  const block = /const STATUS_TITLES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(workerSource);
  for (const match of block[1].matchAll(/(\d{3}): "([^"]+)"/g)) {
    titles[match[1]] = match[2];
  }
  assert.deepEqual([...deref({ $ref: "#/components/schemas/ProblemDetails" }).properties.error.enum].sort(),
    Object.keys(messages).sort(), "the error enum and the codes of worker.js differ");
  let seen = 0;
  for (const { path, method, op } of operations()) {
    for (const [status, raw] of Object.entries(op.responses)) {
      const response = deref(raw);
      if (Number(status) < 400 || !response.content) {
        continue;
      }
      const where = method.toUpperCase() + " " + path + " " + status;
      assert.equal(response.content["application/json"], undefined, where + " still says application/json");
      const media = response.content["application/problem+json"];
      if (!media) {
        continue; // text/html of the login pages
      }
      assert.equal(media.schema.$ref, "#/components/schemas/ProblemDetails", where);
      const values = media.example ? [media.example] : Object.values(media.examples || {}).map((e) => deref(e).value);
      for (const value of values) {
        seen += 1;
        assert.equal(value.type, "about:blank", where);
        assert.equal(value.status, Number(status), where);
        assert.equal(value.title, titles[status], where);
        assert.equal(value.detail, messages[value.error], where + " " + value.error);
      }
    }
  }
  assert.ok(seen >= 25, "only " + seen + " error examples checked");
});

test("a 401 names WWW-Authenticate and a 405 names Allow", () => {
  for (const { path, method, op } of operations()) {
    const where = method.toUpperCase() + " " + path;
    if (op.responses["401"]) {
      assert.ok(deref(op.responses["401"]).headers["WWW-Authenticate"], where);
    }
    if (op.responses["405"]) {
      assert.ok(deref(op.responses["405"]).headers.Allow, where);
    }
  }
  assert.ok(spec.paths["/submissions"].post.responses["405"], "POST /submissions lacks its 405");
});

test("every operation states its security, and only the two bearer keys exist", () => {
  const schemes = spec.components.securitySchemes;
  assert.deepEqual(Object.keys(schemes).sort(), ["partnerKey", "readerKey"]);
  for (const scheme of Object.values(schemes)) {
    assert.equal(scheme.type, "http");
    assert.equal(scheme.scheme, "bearer");
  }
  for (const { path, method, op } of operations()) {
    assert.ok(Array.isArray(op.security), method.toUpperCase() + " " + path + " has no security");
  }
  assert.deepEqual(spec.paths["/live"].get.security, [{ readerKey: [] }]);
  assert.deepEqual(spec.paths["/pins"].get.security, [{ readerKey: [] }]);
  assert.deepEqual(spec.paths["/submissions"].post.security, [{ partnerKey: [] }]);
});

test("the read answers name the headers worker.js sends, and CORS exposes them", () => {
  const expose = /"Access-Control-Expose-Headers": "([^"]+)"/.exec(workerSource);
  assert.ok(expose, "no Expose-Headers in worker.js");
  const exposed = expose[1].split(", ");
  for (const path of ["/live", "/pins"]) {
    const ok = spec.paths[path].get.responses["200"].headers;
    for (const name of ["ETag", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) {
      assert.ok(ok[name], path + " 200 lacks " + name);
      assert.ok(exposed.includes(name), name + " is not exposed");
      assert.ok(workerSource.includes("\"" + name + "\":") || workerSource.includes(" " + name + ": "),
        name + " is documented but never sent");
    }
    assert.ok(spec.paths[path].get.responses["304"], path + " lacks its 304");
    assert.ok(deref(spec.paths[path].get.responses["429"]).headers["Retry-After"], path + " 429 lacks Retry-After");
  }
});

test("the 200 example of /pins is what historyGeojson produces", () => {
  const example = spec.paths["/pins"].get.responses["200"].content["application/geo+json"].example;
  const rows = example.features.map((feature) => {
    const row = Object.assign({}, feature.properties);
    if (feature.geometry !== null) {
      row.lat = feature.geometry.coordinates[1];
      row.lon = feature.geometry.coordinates[0];
    }
    return row;
  });
  const from = /from (\d{4}-\d{2}-\d{2}) to/.exec(example.notes[0])[1];
  const generated = JSON.parse(new TextDecoder().decode(historyGeojson(from, example.as_of, rows)));
  assert.deepEqual(example, generated);
});
