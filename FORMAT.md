# OpenPinsheet format, version 1

Status: **draft**. Nothing has been published in this format yet. Field names
and rules may still change before the first file goes out; after that, the
versioning rules at the end apply.

## 1. What a record says

On this date, on this hole, the pin was here.

A record carries no identifier for a course, a hole, a green or a person. The
coordinate locates itself: whoever wants to know which course or green a record
belongs to asks the point. The hole number is the one the club uses; it
describes the record and is not a key.

Not in the data, by design:

- no IDs of courses, holes, greens, people, or OpenStreetMap elements
- no names, no e-mail addresses
- no time of day (at a small club it is one person's working hours)
- no pin sets, rotations or plans (those belong to the tool a club uses)

## 2. Columns

One row per hole and day. A day file holds many golf grounds, so the same
`date` and `hole` appear many times; the coordinate tells them apart. The CSV columns and the GeoJSON `properties` use the
same names, in this order:

| # | Column | Type | Rule |
|---|---|---|---|
| 1 | `date` | text | Calendar date at the course, `YYYY-MM-DD`, a valid date. |
| 2 | `date_basis` | text | `local`, or `utc` where the local date was not recorded and `date` is the UTC date. |
| 3 | `hole` | text | 1 to 8 characters `0-9 A-Z a-z`, as the club names the hole (`7`, `B3`). |
| 4 | `lat` | number | WGS84 latitude in degrees, -90 to 90, at most 7 decimals. |
| 5 | `lon` | number | WGS84 longitude in degrees, -180 to 180, at most 7 decimals. |
| 6 | `source` | text | `estimated`, `surveyed`, `mapped` or `detected` (section 3). |
| 7 | `accuracy_m` | number | Horizontal accuracy in metres, greater than 0: the 95 % radius (2.3). |
| 8 | `front_m` | number | Metres from the front edge of the green, 0 or more. |
| 9 | `left_m` | number | Metres from the left edge of the green, 0 or more. |
| 10 | `input_front` | number | What was typed: distance from the front edge, 0 or more, in `input_unit`. |
| 11 | `input_offset` | number | What was typed: distance from the side edge, 0 or more, in `input_unit`. |
| 12 | `input_side` | text | `left` or `right`: the edge `input_offset` is measured from. |
| 13 | `input_unit` | text | `m` or `yd`. |
| 14 | `channel` | text | The channel the record came through (section 5). |
| 15 | `missing` | flag | A pin was set that day, but its position is lost. |
| 16 | `play_bearing_deg` | number | Direction of the line of play at the green, in degrees clockwise from true north, 0 or more and less than 360, at most 1 decimal. |
| 17 | `correction` | text | How a `surveyed` position was corrected: `none`, `ppp`, `rtk` or `ppk` (section 3). |

Empty means unknown. It never means zero.

`date`, `date_basis` and `hole` are required in every row.

`lat` and `lon` are always WGS84. A position measured in a regional frame such
as ETRS89, for example against SAPOS, is transformed to WGS84 before delivery;
in Europe the two differ by about 80 cm today.

"Front" and "left" are seen from the line of play, the way a greenkeeper reads
them off. `front_m` and `left_m` are read against the OpenStreetMap outline of
the green on that day; they describe the day, not today's map.
`play_bearing_deg` is the direction of that line of play, the one a producer
used to convert `input_*` into `lat` and `lon`.

### 2.1 Rules between columns

A row is either a **lost position** or a **position**.

**Lost position:** `missing` is set. Then every column from `lat` to `channel`
is empty, and so are `play_bearing_deg` and `correction`. Such a row is not
dropped: a pin did stand on that hole that day.

**Position:** `missing` is not set, and `channel` is given. Further:

1. `lat` and `lon` are given together or not at all.
2. If `lat` and `lon` are given, `source` is required.
3. If `source` is empty, `lat` and `lon` are empty and `front_m` and `left_m`
   are both given. This covers entries made before a tool stored coordinates;
   no source is invented for them.
4. `front_m` and `left_m` are given together or not at all.
5. `accuracy_m` is required for `surveyed` and `detected`, optional for
   `mapped`, and empty for `estimated` and for rows without `source`.
6. `input_front`, `input_offset`, `input_side` and `input_unit` are given all
   four or none, and only with `source` = `estimated`.
7. `play_bearing_deg` is given only together with the four `input_*`. It is
   optional in format 1, because the first producers do not send it yet. A
   producer that converts typed distances gives it, so that the conversion
   can be redone (section 3).
8. `correction` is given only with `source` = `surveyed`. Empty means not
   recorded.

### 2.2 Order

Rows are sorted by `date`, then by `hole`: holes made only of digits first, by
numeric value (`2` before `10`), then all others by text.

### 2.3 Accuracy

`accuracy_m` is the radius of the circle around `lat` and `lon` that holds the
true position with 95 % probability. Receivers report other measures; convert
them before writing, with the factors of the US National Standard for Spatial
Data Accuracy (FGDC-STD-007.3-1998), which assume the error is about the same
in every direction:

| The device reports | Multiply by |
|---|---|
| RMS or standard deviation of one axis, for example NMEA GST | 2.4477 |
| horizontal RMS, sqrt(RMS east² + RMS north²) | 1.7308 |
| CEP, the radius that holds 50 % | 2.0789 |
| the 95 % radius | 1 |

A receiver reporting 2 cm per axis gives `accuracy_m` 0.049. The upload in
the account converts an Emlid Flow export by itself (API.md 3.2).

## 3. Sources

| `source` | Meaning | `accuracy_m` |
|---|---|---|
| `estimated` | Metres or yards from the front edge and from the left or right edge, converted to a coordinate against the OpenStreetMap outline of the green on that day. What was typed stays in `input_*`. With `play_bearing_deg` as well, anyone can redo the conversion. | empty: it depends on how well the outline matches the green, and that is not measured |
| `surveyed` | GNSS with corrections. `correction` says which: `ppp` (precise point positioning, including Galileo HAS), `rtk` (real time against a base or a network), `ppk` (worked out afterwards against a reference station), or `none`. | required, converted to the 95 % radius (2.3) |
| `mapped` | Placed on a map or an aerial image. | optional |
| `detected` | A camera or LiDAR finds the pin. | required |

Phone GPS is not a source. At two metres at best, it cannot tell two pin
positions on one green apart.

Coordinates carry up to 7 decimals for every source. With 6, 1.61 % of
estimated points moved more than 0.1 m on a round trip from metres to
coordinate and back; with 7, two of 168,804 (measured by OpenYardage over
331,178 points, October 2026).

## 4. Files

### 4.1 CSV

- UTF-8 with byte order mark, lines end in CRLF.
- Comma as separator, decimal point, quoting as in RFC 4180.
- Before the header row, comment lines starting with `# ` carry the title,
  the licence and the attribution. A comment line contains no comma, so in a
  spreadsheet it stays one cell. A published file ends its comment lines with exactly these four:

      # OpenPinsheet day file 2027-04-12. Format 1.
      # Licence: Open Database License 1.0 (ODbL) https://opendatacommons.org/licenses/odbl/1-0/
      # Attribution: Pin positions: OpenPinsheet and its data partners. Open Database License 1.0.
      # Estimated positions are computed against green outlines from OpenStreetMap: map data © OpenStreetMap contributors (ODbL).

  A year file says `year file 2027` in the first line. The same four sentences,
  without `# `, are the `notes` of the GeoJSON.
- A published file carries exactly the 17 columns of section 2. Readers accept
  further columns after them (section 7).
- Numbers in plain decimal form, at most 7 decimals, without trailing zeros
  and without exponent (`12`, `9.5`, `52.1234561`); `-0` is written `0`.
- `missing` is `1` or empty.

Readers should accept LF line ends and a missing byte order mark as well.

### 4.2 GeoJSON

An RFC 7946 FeatureCollection with these members before `features`:

```json
{
 "type": "FeatureCollection",
 "format": 1,
 "as_of": "2027-04-14",
 "license": { "name": "Open Database License 1.0", "spdx": "ODbL-1.0",
              "url": "https://opendatacommons.org/licenses/odbl/1-0/" },
 "attribution": "Pin positions: OpenPinsheet and its data partners, Open Database License 1.0. Estimated positions are computed against green outlines from OpenStreetMap: map data © OpenStreetMap contributors (ODbL).",
 "notes": [ "OpenPinsheet day file 2027-04-12. Format 1.", "..." ],
 "features": [
  { "type": "Feature",
    "geometry": { "type": "Point", "coordinates": [13.1234573, 52.1234561] },
    "properties": { "date": "2027-04-12", "date_basis": "local", "hole": "7",
                    "source": "estimated", "front_m": 12, "left_m": 9.5,
                    "input_front": 12, "input_offset": 5, "input_side": "right",
                    "input_unit": "m", "channel": "openyardage",
                    "play_bearing_deg": 274.5 } }
 ]
}
```

- `geometry` is a Point `[lon, lat]`, or `null` where the row has no
  coordinate (RFC 7946, 3.2). A lost position always has `null`.
- `license` carries `name`, `spdx` and `url` as shown. `attribution` is the
  text of section 6. `notes` is a list of texts and may be empty.
- Numbers follow the rule of 4.1: plain decimal form, at most 7 decimals, no
  trailing zeros, no exponent (`12`, not `12.0` or `1.2e1`).
- `properties` holds the columns except `lat` and `lon`. Unknown values are
  left out, not written as `null`. A published file carries no other
  properties.
- `missing` is `true` or left out.
- Numbers are JSON numbers, text is JSON strings; `hole` is always a string.

### 4.3 Layout

```
v1/index.json
v1/days/YYYY-MM-DD.csv
v1/days/YYYY-MM-DD.geojson
v1/years/YYYY.csv
```

- A **day file** holds every record with that `date`, from all courses and
  channels.
- A day `D` is published from `D` + 3 days, 00:00 UTC. That is the first
  moment at which no course anywhere (UTC-12 to UTC+14) can still enter pins
  for `D`, including the one day of tolerance a channel has around its local
  date. After that the file does not change.
- A **year file** holds all days of a year, in the order of section 2.2.
- `index.json` lists every file:

```json
{
 "format": 1,
 "generated": "2027-04-15",
 "license": { "name": "Open Database License 1.0", "spdx": "ODbL-1.0",
              "url": "https://opendatacommons.org/licenses/odbl/1-0/" },
 "files": [
  { "path": "days/2027-04-12.csv", "kind": "day", "date": "2027-04-12",
    "bytes": 1234, "sha256": "...", "rows": 18 }
 ]
}
```

`path` is relative to `v1/`. `kind` is `day` or `year`; a day carries `date`,
a year carries `year`.

Corrections and withdrawals after a day is closed get files of their own, so
that what was published on a day can always be checked. Their form is defined
together with submissions by more than one channel and is not part of this
draft.

## 5. Channels

Nobody enters pins into OpenPinsheet directly. Records come through channels:
tools that clubs already use. A channel decides who may enter pins for a
course and vouches for it.

`channel` is the channel's identifier from the public list: 2 to 40
characters, lowercase letters and digits joined by single hyphens, starting
with a letter, such as `golfclub-berlin`.

| `channel` | Organisation |
|---|---|
| `openyardage` | OpenYardage, openyardage.com |

In a club's own export from a tool, before anything is published, the value
`club` stands for "entered by the club itself". It does not appear in the
published files. Such an export is the comma CSV of 4.1; a spreadsheet
variant with semicolons and decimal commas is for people, not for exchange.
An export may end after `missing`; `play_bearing_deg` and `correction` are
then empty.

## 6. Licence and attribution

The data is under the Open Database License 1.0. Anyone may use, copy and
share it, also commercially. Whoever builds a database from it names the
source and shares that database under the same licence. The licence cannot be
withdrawn.

Attribution:

> Pin positions: OpenPinsheet and its data partners, Open Database License 1.0.
> Estimated positions are computed against green outlines from OpenStreetMap:
> map data © OpenStreetMap contributors (ODbL).

The second sentence is required, not a courtesy: a position computed against
an OpenStreetMap outline is derived from OpenStreetMap.

This description stands under Creative Commons Attribution 4.0. Implementing
the format needs no permission.

## 7. Versioning

- `format` is an integer, in every GeoJSON file and in `index.json`; the path
  carries `/v1/`.
- A new column that nobody needs to read the old ones keeps the version. New
  CSV columns are appended at the end.
- A change a reader would misread (a column changes meaning or unit, a rule
  gets stricter, a column goes away) is a new version under `/v2/`, published
  next to `/v1/` for a year.
- This file is the source of the format, not the code.
