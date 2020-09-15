# 2. Alarm on silence, not just on errors

Date: 2020-09-15
Status: Accepted

## Context

Vodafone stopped uploading usage files. We found out four days later, from
finance, when the revenue number looked wrong.

Every alarm we had was green the entire time. There were no errors because
nothing ran. There were no DLQ messages because nothing failed. There were no
Lambda invocations, and no alarm was watching for the absence of them. A
carrier going quiet is indistinguishable from a quiet night if you are only
watching for things going wrong.

Four days of unbilled data across the fleet is not a rounding error.

## Decision

An alarm on `Invocations < 1` over a 24 hour period, with
`treat_missing_data = "breaching"`.

The second half is the part that is easy to get wrong. Lambda does not emit an
`Invocations` data point of zero when it is not invoked — it emits nothing at
all. With the default `missing` treatment the alarm sits in INSUFFICIENT_DATA
forever and never fires, which is precisely the failure it exists to catch.

## Consequences

Good:

* A carrier going quiet is now noticed within a day rather than within a week.
* It has fired twice since: once for a genuine carrier outage, once when an
  SFTP credential rotation was not applied on their side.

Bad:

* It fires on public holidays when some carriers legitimately do not send a
  file, so it needs a suppression window that nobody has built yet. The
  on-call runbook says "check the calendar", which is not good enough.
* A 24 hour evaluation period means the alarm is slow by construction. Making
  it faster means encoding each carrier's expected schedule, which is real
  work and has not been worth it yet.
