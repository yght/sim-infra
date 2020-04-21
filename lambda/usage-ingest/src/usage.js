'use strict';

/**
 * Turning parsed records into something billable.
 *
 * Two jobs: throw away what we have already counted, and roll the rest up per
 * SIM per day. Both are pure so that a month-end discrepancy can be
 * reproduced from a fixture rather than argued about.
 */

/**
 * Records repeat. The same row turns up in the next night's file often
 * enough that this is load-bearing, not defensive.
 *
 * Identity is (carrier, recordId). Carriers do not coordinate their id
 * spaces, and Bell and AT&T have collided on plain integers before.
 */
function dedupe(records, alreadySeen) {
  var seen = alreadySeen ? new Set(alreadySeen) : new Set();
  var kept = [];
  var duplicates = 0;

  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    var key = record.carrier + ':' + record.recordId;

    if (!record.recordId || seen.has(key)) {
      duplicates++;
      continue;
    }

    seen.add(key);
    kept.push(record);
  }

  return { records: kept, duplicates: duplicates, keys: Array.from(seen) };
}

/**
 * Records that should not be trusted.
 *
 * A carrier replaying an old file would otherwise bill a customer twice for
 * a month they have already paid, and a clock error at their end produced
 * records dated 2049 once, which sailed through and showed up on an invoice.
 */
function quarantine(records, windowStart, windowEnd) {
  var kept = [];
  var rejected = [];

  for (var i = 0; i < records.length; i++) {
    var record = records[i];

    if (record.occurredAt < windowStart) {
      rejected.push({ record: record, reason: 'BEFORE_WINDOW' });
    } else if (record.occurredAt > windowEnd) {
      rejected.push({ record: record, reason: 'AFTER_WINDOW' });
    } else {
      kept.push(record);
    }
  }

  return { records: kept, rejected: rejected };
}

/**
 * Roll up per SIM, per UTC day, per usage kind.
 *
 * The day is taken from the UTC timestamp. Billing runs on UTC days across
 * every carrier, which means a Bell record at 9pm Eastern lands on the
 * following billing day. That is deliberate and the finance team asked for
 * it - one boundary for everyone beats three.
 */
function aggregate(records) {
  var buckets = {};

  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    var day = record.occurredAt.substring(0, 10);
    var key = record.iccid + '|' + day + '|' + record.kind;

    if (!buckets[key]) {
      buckets[key] = {
        iccid: record.iccid,
        carrier: record.carrier,
        day: day,
        kind: record.kind,
        bytes: 0,
        durationSeconds: 0,
        records: 0
      };
    }

    buckets[key].bytes += record.bytes;
    buckets[key].durationSeconds += record.durationSeconds;
    buckets[key].records += 1;
  }

  return Object.keys(buckets)
    .sort()
    .map(function (key) { return buckets[key]; });
}

/**
 * The whole pipeline for one file.
 */
function process(records, options) {
  var opts = options || {};

  var deduped = dedupe(records, opts.alreadySeen);
  var checked = quarantine(
    deduped.records,
    opts.windowStart || '0000-01-01T00:00:00.000Z',
    opts.windowEnd || '9999-12-31T23:59:59.999Z'
  );

  return {
    totals: aggregate(checked.records),
    duplicates: deduped.duplicates,
    rejected: checked.rejected,
    seenKeys: deduped.keys,
    accepted: checked.records.length
  };
}

module.exports = {
  dedupe: dedupe,
  quarantine: quarantine,
  aggregate: aggregate,
  process: process
};
