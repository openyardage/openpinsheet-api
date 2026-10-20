# OpenPinsheet

Where the pin was, by date and hole: an open data set of golf pin positions
under the Open Database License 1.0. This repository holds the format, the
API server and the tools that check and publish the files.

> [!NOTE]
> **Draft.** No day has been published yet; the format may still change
> until the first file goes out.

- Website: https://openpinsheet.com
- Format: [FORMAT.md](FORMAT.md)
- API: [API.md](API.md), machine-readable in [api/openapi.json](api/openapi.json)

## What is here

| Path | What it holds |
|---|---|
| `FORMAT.md` | The format, version 1. The source of truth; code follows it. |
| `schema/` | JSON Schema for one GeoJSON feature. |
| `api/` | The API server, a Cloudflare Worker with a D1 database. |
| `tools/` | Command-line tools: check, index, publish and upload files, manage partners. Python 3.10+, standard library only. |
| `examples/` | Made-up files that show the format. Not real data. |
| `tests/` | Tests of the tools and cross-checks with the server. |

## Check a file

    python3 tools/validate.py path/to/2027-04-12.csv path/to/2027-04-12.geojson

Exit code 0 means every file is valid; otherwise each problem is printed with
file, line and column.

## Publish

    python3 tools/publish.py --channel openyardage --out v1 --today 2027-04-20 exports/*.csv

Takes club exports whose `channel` is `club` and writes the public `v1`
files, with `club` replaced by the `--channel` value. A day D goes out once
`D + 3 days <= --today`; younger rows are skipped. Day files never change, so
an existing day file with different content stops the run before anything is
written. Every file is built and validated in memory first, and `index.json`
comes last.

Exit codes: 0 is fine, 1 means the input is invalid or a day file would
change, 2 means a program error with nothing written.

## Upload

    python3 tools/upload.py --env .env --bucket openpinsheet [--endpoint URL] [--dry-run] v1

Reads credentials from `--env`, a file of `NAME=VALUE` lines.
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are used directly; with only
`CLOUDFLARE_API_TOKEN`, the access key id comes from the token check and the
secret is the sha256 of the token. Without `--endpoint` the endpoint is built
from `CLOUDFLARE_ACCOUNT_ID`. No secret is printed.

Before anything is sent, the directory is checked like `index.py --check` and
every file is validated. A day file that exists remotely with other content
stops the run before the first upload. Year files always go out, and
`index.json` last, so the index never points at a missing file. `--dry-run`
does the checks and lists what would be uploaded.

Exit codes: 0 is fine, 1 means a check failed, a day file would change or a
request failed, 2 means a program error.

## Tests

    node --test api/test/*.test.mjs        # Node 24, the server
    python3 -m unittest discover -s tests  # the tools and cross-checks

CI runs both on every pull request.

## Contributing

Bug reports, questions about the format and reports of data that looks
wrong are welcome as issues. Read [CONTRIBUTING.md](CONTRIBUTING.md) before a
pull request, and report security problems privately as
[SECURITY.md](SECURITY.md) describes. Everyone here follows the
[Code of Conduct](https://github.com/openyardage/.github/blob/main/CODE_OF_CONDUCT.md).

## Licences

| Part | Licence |
|---|---|
| `api/`, the server, and `tests/test_api_*.py` | GNU Affero General Public License v3.0 or later |
| `api/openapi.json`, `schema/`, `tools/`, `tests/` (except `tests/test_api_*.py`), `.github/` | Apache License 2.0 |
| `FORMAT.md`, `API.md` and the other texts | Creative Commons Attribution 4.0 |
| `examples/` | Open Database License 1.0, as their header says |

Whoever runs a modified copy of the server must offer its source to the
people who use it (AGPL section 13). Implementing the format or calling the
API needs no permission. [LICENSE](LICENSE) and [REUSE.toml](REUSE.toml) give
the details; the published pin positions stand under the Open Database
License 1.0.

Estimated pin positions are computed against green outlines from
OpenStreetMap: map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
Open Database License.
