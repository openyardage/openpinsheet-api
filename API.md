# OpenPinsheet API, version 1

`FORMAT.md` defines what a record is; this file defines how records come in
and how today's records go out. Where the two meet, `FORMAT.md` wins. The same
interface as OpenAPI 3.1: `api/openapi.json`, served at
`https://openpinsheet.com/openapi.json`.

Base address: `https://api.openpinsheet.com/v1/`

Three ways through OpenPinsheet:

| Way | Who | What |
|---|---|---|
| `POST /v1/submissions` | data partners, with a key | deliver the pins of one ground for one day |
| `GET /v1/live` | anyone, with a key from GitHub | the current pins in an area, while the day is still open |
| `GET /v1/pins` | anyone, with a key from GitHub | closed days in an area, up to 31 days at once |
| `/v1/account` | people, signed in with GitHub | the reader key, signing up as a data partner, the partner key, upload (3) |
| files on `data.openpinsheet.com` | anyone, no key | closed days, three days later; a day file never changes, the year file grows (`FORMAT.md` 4.3) |

Keys go as `Authorization: Bearer <key>`, the reader key (2.2) as well as the
partner key (3). `HEAD` works wherever `GET` does and is counted like it.

Errors are problem details (RFC 9457), as `application/problem+json`:

```json
{ "type": "about:blank", "title": "Unauthorized", "status": 401,
  "detail": "a valid key is required in the header Authorization: Bearer",
  "error": "unauthorized" }
```

`error` is the fixed code to branch on and `detail` its fixed sentence;
`title` is the reason phrase of the status. Every endpoint can answer:

| Status | `error` | Meaning |
|---|---|---|
| 401 | `unauthorized` | key missing, unknown or revoked; always the same answer, with `WWW-Authenticate: Bearer realm="openpinsheet"` |
| 404 | `not_found` | no such path |
| 405 | `method_not_allowed` | `Allow` lists the methods the path takes |
| 500 | `internal_error` | an unexpected failure |

## 1. Submitting pins

    POST /v1/submissions
    Authorization: Bearer <key of the data partner>
    Content-Type: application/json

```json
{
 "format": 1,
 "group": "w620181682",
 "date": "2027-04-12",
 "pins": [
  { "hole": "7", "lat": 52.1234561, "lon": 13.1234573, "source": "estimated",
    "front_m": 12, "left_m": 9.5,
    "input": { "front": 12, "offset": 5, "side": "right", "unit": "m" },
    "play_bearing_deg": 274.5 },
  { "hole": "8", "lat": 52.1241077, "lon": 13.122915, "source": "surveyed",
    "accuracy_m": 0.03, "correction": "rtk" },
  { "hole": "9", "missing": true }
 ]
}
```

### 1.1 Fields

- `format`: the integer `1`.
- `group`: the data partner's own label for one golf ground, 1 to 64
  characters `A-Z a-z 0-9 . _ : -`. It is never published. It only tells
  OpenPinsheet which earlier submission a new one replaces (1.3).
- `date`: the calendar date at the ground, `YYYY-MM-DD`. Published as `date`
  with `date_basis` `local`.
- `pins`: 1 to 150 entries, each `hole` at most once. A pin carries the
  columns of `FORMAT.md` 2 except `date`, `date_basis` and `channel` (they come
  from the envelope and the key); `input` holds `input_front`, `input_offset`,
  `input_side` and `input_unit` as `front`, `offset`, `side`, `unit`; a lost
  position is `{ "hole": "9", "missing": true }`.
- `play_bearing_deg` and `correction` are optional. A partner that converts
  typed distances into a coordinate sends the bearing it used, so that the
  conversion can be redone (`FORMAT.md` 2.1).
- Numbers as JSON numbers, at most 7 decimals (`FORMAT.md` 4.1).
- `null` counts as absent for the fields named here.
- A field that is not named here, in the envelope or in a pin, is a problem
  even when it is `null`: a misspelt `accuracy` must not vanish silently.

### 1.2 Checks

Every pin passes the rules of `FORMAT.md` 2 and 2.1, the same rules as
`tools/validate.py`. On top:

- `date` lies within one day of today's UTC date (yesterday, today or
  tomorrow), and the day is still open (1.4).
- All pins with a coordinate lie within 5 km of each other: one submission is
  one ground. The problem is reported at one of the two pins farthest apart.
- The body is at most 64 KiB.

If any check fails, nothing is stored.

### 1.3 Replacing

A submission replaces everything the same data partner sent for the same
`group` and `date`. Holes it does not name are gone afterwards. To correct a
day, send the whole day again. To withdraw it while it is open:

    DELETE /v1/submissions?group=w620181682&date=2027-04-12

### 1.4 When a day closes

A day `D` closes at `D` + 3 days, 00:00 UTC (`FORMAT.md` 4.3) and is then
written to the files. After that it cannot be replaced or withdrawn here;
corrections get files of their own (`FORMAT.md` 4.3, not part of this version).

### 1.5 Answers

`200`:

```json
{ "stored": 3, "group": "w620181682", "date": "2027-04-12",
  "replaced": false, "visible_from": "2027-04-12T06:00:00Z" }
```

With `?dry_run=true` (or `1`) everything is checked and nothing is stored;
the answer says `"stored": 0` and `"dry_run": true`. Without `dry_run`, or
with `false` or `0`, the pins are stored. Any other value, an empty one too,
is `400` with `invalid_dry_run`, so a misspelt switch never stores.

`DELETE` answers `{ "deleted": <number of pins> }`.

Errors besides those of every endpoint:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_json` | `POST`: the body is not JSON |
| 400 | `invalid_dry_run` | `POST`: `dry_run` is neither `true`, `false`, `1` nor `0` |
| 400 | `invalid_request` | `DELETE`: `group` or `date` is missing or malformed |
| 409 | `day_closed` | `DELETE`: the day is already published. A `POST` for a closed day fails the date check (422). |
| 413 | `body_too_large` | `POST`: more than 64 KiB |
| 422 | `invalid_submission` | `POST`: `problems` lists each problem with `hole` (or `null` for the envelope), `field` and `message` |
| 429 | `partner_limit` | `POST`: a data partner waiting for review sent 20 grounds that day already (3.1) |

## 2. Today's pins

    GET /v1/live?bbox=<west>,<south>,<east>,<north>
    Authorization: Bearer <key of the reader>

- A reader key is required (2.2). Any website may call it (CORS `*`), and a
  script may read the limit headers.
- The box is at most 0.5 degrees wide and 0.5 degrees high, otherwise `400`
  with `bbox_too_large`; a malformed box is `400` with `invalid_bbox`.
- The answer is a GeoJSON FeatureCollection like a published file
  (`FORMAT.md` 4.2): `format`, `as_of` (today's UTC date), `license`,
  `attribution`, `notes`, `features`. The features carry the columns of
  `FORMAT.md` 2.
- For every data partner and ground in the box, only its most recent visible
  day is returned.
- A box cannot cross the 180th meridian; query both sides separately.
- A ground is found through its pins with a coordinate; a day of a ground
  without any coordinate does not appear here, only in the files.
- Live records can still change until the day closes. For anything you keep,
  use the files.
- Cached for five minutes in the reader's browser, never in shared caches.
  Every answer carries an `ETag`; sent back in `If-None-Match`, an unchanged
  answer is `304` without a body.

### 2.1 Visible from about seven in the morning

The pins of day `D` become visible at about 07:00 local time at the ground,
not when they are sent. That way nobody can read off when a greenkeeper set
the pins, which at a small club is one person's working hours (`FORMAT.md` 1:
no time of day).

Local time is taken from longitude, not from time zones: `visible_from` is
`D` 07:00 UTC minus `round(lon / 15)` hours, with `lon` the mean longitude of
the submission's pins and halves rounded up (7.5 becomes 8, -7.5 becomes -7).
A day without any coordinate uses `lon` 0.

### 2.2 Keys for reading

- Log in at `https://api.openpinsheet.com/v1/auth/github`. GitHub asks for the
  login only, no other scope; the answer opens the account (3), which shows
  the key once at the first login.
- One key per GitHub account is active. "New key" in the account replaces it;
  the old key stops working at once. A later login keeps the key.
- Limits per GitHub account: 30 requests a minute, 1000 per UTC day; a new
  login does not reset them. A key bound to a website's origins is shared by
  its visitors: it may carry another day limit, and its minute limit counts
  per visitor, with a ceiling of about 300 a minute for the key as a whole
  (Cloudflare counts per location).
- Every answer that spends a request carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining` and `X-RateLimit-Reset` (the next 00:00 UTC in Unix
  seconds). A `400` is refused before anything is counted; a `304` counts like
  a `200`.
- Errors: `403` `origin_not_allowed` (the key is bound to other origins; a
  request without an `Origin` header, as from a server, is not checked),
  `429` `rate_limited` (with `Retry-After: 60`), `429` `daily_limit` (with
  `Retry-After` until 00:00 UTC). Both 429 carry the day values above.
- A key in the query string is not accepted: it would end up in browser
  history and server logs. The old header `X-API-Key: <key>` still works
  until OpenYardage has moved to `Authorization`, then it goes.
- The files on `data.openpinsheet.com` need no key; that does not change.

### 2.3 Past days

    GET /v1/pins?bbox=<west>,<south>,<east>,<north>&from=YYYY-MM-DD&to=YYYY-MM-DD
    Authorization: Bearer <key of the reader>

- Key, CORS, box, `ETag` and errors work as under `/v1/live` (2, 2.2). The two
  endpoints share one day counter per GitHub account: 1000 requests a UTC day
  together.
- `from` and `to` are both required, `from` not after `to`, at most 31 days
  between them: otherwise `400` with `invalid_range`.
- `to` must be a closed day (1.4): otherwise `400` with `range_not_closed`.
- The answer is a GeoJSON FeatureCollection like a published file
  (`FORMAT.md` 4.2). Its records are the records of the day files of the range:
  a ground is in the box as soon as one of its rows has a coordinate in the
  box, and then all its rows in the range come.
- Cached for one day in the reader's browser, never in shared caches; a closed
  day does not change.

## 3. The account, data partners and keys

`https://api.openpinsheet.com/v1/account` is a page for people, not part of
the JSON API. The GitHub login (2.2) opens it; a cookie `ops_session` keeps
it open for 30 days or until "Sign out".

- **Reading:** the reader key's first characters, its date and today's
  requests, and "New key".
- **Becoming a data partner:** a name as it appears in the credit, an
  optional website, and the promise that the pins may be shared under the
  Open Database License 1.0. The name gives the `channel` (`FORMAT.md` 5):
  lowercase ASCII letters and digits joined by `-`, starting with a letter,
  at most 40 characters (`1. Golfclub Berlin` becomes `golfclub-berlin`),
  each name once. One partner per GitHub account.
- **The partner key** is shown once; "New partner key" replaces it at once.
  It is the bearer key of `POST /v1/submissions` (1). OpenPinsheet stores
  only the sha256 of any key.

### 3.1 Review

A new data partner delivers at once, and its pins are live at once. The
operator gets a mail and reviews the partner, with the signed link in the
mail or in the admin area of the account (the GitHub ids in
`ADMIN_GITHUB_IDS`), which lists every partner with Confirm and Block and
opens a page per partner: its grounds with a map link, deliveries of the
last 30 days, the mix of sources, median accuracy, lost positions and its
key:

- Until the review, a partner delivers at most 20 grounds a day; one more is
  `429` with `partner_limit`. Replacing a ground already sent that day is
  allowed.
- Until the review, its pins stay out of the files and out of `/v1/pins`.
  The review takes in every day still open (from today - 2 days on). Days
  that closed before stay without them: a published day file never changes.
- Blocking stops the key for good and deletes the partner's pins of open
  days. The account issues no new key, and a review cannot undo it. A
  partner whose GitHub account is blocked as a reader is stopped the same
  way.

The partners set up before 18.10.2026 count as reviewed.

### 3.2 Upload

A data partner can upload a CSV or KML file in the account instead of
calling the API: one point per hole, for example from an RTK app. A CSV
needs the columns `hole` (or `name`, `pin`), `lat` (or `latitude`) and `lon`
(or `longitude`); `date`, `source` and `accuracy_m` are optional and
otherwise come from the form. Without `accuracy_m`, the `Easting RMS` and
`Northing RMS` of an Emlid Flow export, or its `Lateral RMS`, become the
95 % radius of FORMAT.md 2.3. Names like `Pin 7` become hole
`7`. Points more than 5 km apart become separate grounds, at most 5 per
upload; a file has at most 1000 points and 1 MB. Each ground goes through the checks of 1.2, and a new upload for the
same course and day replaces the old one (1.3).

## 4. What is stored

Per pin: data partner, `group`, `date`, and the columns of `FORMAT.md` 2. No
time of day, no IP address, no names. Which day files are written is kept,
so none is written twice.

Per reader of the live API: the GitHub id, the GitHub login name, the
time the first key was created, the sha256 and first 12 characters of the
key, and the number of requests per reader and UTC day. The GitHub token
used for the login is not stored. The day counters are deleted after 30
days; the rest is deleted on request.

Per open account: the sha256 of the session cookie, a form token, and when
it started and ends. Expired sessions are deleted every night.

Per data partner: name, `channel`, website, GitHub id and login name, when
the licence was accepted, and from which date its pins go into the files.

## 5. Versioning

The path carries `/v1/`. New optional fields keep the version. A change a
client would misread is `/v2/`, run next to `/v1/` for a year.
