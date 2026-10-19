-- OpenPinsheet API, migration 0005: two optional columns of FORMAT.md 2.
--
-- play_bearing_deg is the direction of the line of play an estimated position
-- was converted with; correction says how a surveyed position was corrected
-- (none, ppp, rtk, ppk). Both are empty for the pins stored before, which is
-- what FORMAT.md 2.1 allows. ALTER TABLE appends them after cell, the same
-- order as in schema.sql.

ALTER TABLE pins ADD COLUMN play_bearing_deg REAL;
ALTER TABLE pins ADD COLUMN correction TEXT;
