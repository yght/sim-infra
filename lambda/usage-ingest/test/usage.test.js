'use strict';

var usage = require('../src/usage');

var A = '8913027201000024686';
var B = '8944150002000035712';

function record(over) {
  return Object.assign({
    recordId: 'R1',
    carrier: 'bell',
    iccid: A,
    msisdn: '14165550142',
    occurredAt: '2020-06-14T21:30:00.000Z',
    durationSeconds: 0,
    bytes: 1024,
    kind: 'data'
  }, over || {});
}

describe('dedupe', function () {
  it('keeps distinct records', function () {
    var result = usage.dedupe([record({ recordId: 'R1' }), record({ recordId: 'R2' })]);

    expect(result.records).toHaveLength(2);
    expect(result.duplicates).toBe(0);
  });

  it('drops a record repeated inside one file', function () {
    var result = usage.dedupe([record({ recordId: 'R1' }), record({ recordId: 'R1' })]);

    expect(result.records).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });

  it('drops a record we counted in a previous run', function () {
    var result = usage.dedupe([record({ recordId: 'R1' })], ['bell:R1']);

    expect(result.records).toHaveLength(0);
    expect(result.duplicates).toBe(1);
  });

  it('does not confuse the same id from two different carriers', function () {
    // Bell and AT&T have both used plain integers and have collided.
    var result = usage.dedupe([
      record({ recordId: '1001', carrier: 'bell' }),
      record({ recordId: '1001', carrier: 'att' })
    ]);

    expect(result.records).toHaveLength(2);
    expect(result.duplicates).toBe(0);
  });

  it('treats a record with no id as unusable', function () {
    var result = usage.dedupe([record({ recordId: '' }), record({ recordId: null })]);

    expect(result.records).toHaveLength(0);
    expect(result.duplicates).toBe(2);
  });

  it('returns the key set so the next run can carry it forward', function () {
    var result = usage.dedupe([record({ recordId: 'R1' })]);
    expect(result.keys).toContain('bell:R1');
  });
});

describe('quarantine', function () {
  var start = '2020-06-01T00:00:00.000Z';
  var end = '2020-06-30T23:59:59.999Z';

  it('accepts records inside the billing window', function () {
    var result = usage.quarantine([record()], start, end);

    expect(result.records).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects a replayed file from a month we already billed', function () {
    var old = record({ occurredAt: '2020-04-02T10:00:00.000Z' });
    var result = usage.quarantine([old], start, end);

    expect(result.records).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('BEFORE_WINDOW');
  });

  it('rejects a record from the future', function () {
    // A carrier clock error produced records dated 2049 once, and they went
    // straight onto an invoice.
    var future = record({ occurredAt: '2049-01-01T00:00:00.000Z' });
    var result = usage.quarantine([future], start, end);

    expect(result.rejected[0].reason).toBe('AFTER_WINDOW');
  });

  it('keeps the offending record so somebody can look at it', function () {
    var future = record({ recordId: 'ODD-1', occurredAt: '2049-01-01T00:00:00.000Z' });
    var result = usage.quarantine([future], start, end);

    expect(result.rejected[0].record.recordId).toBe('ODD-1');
  });
});

describe('aggregate', function () {
  it('sums bytes per SIM per day per kind', function () {
    var totals = usage.aggregate([
      record({ recordId: '1', bytes: 1000 }),
      record({ recordId: '2', bytes: 2000 })
    ]);

    expect(totals).toHaveLength(1);
    expect(totals[0].bytes).toBe(3000);
    expect(totals[0].records).toBe(2);
  });

  it('keeps data, voice and sms apart', function () {
    var totals = usage.aggregate([
      record({ recordId: '1', kind: 'data', bytes: 1000 }),
      record({ recordId: '2', kind: 'voice', bytes: 0, durationSeconds: 60 })
    ]);

    expect(totals).toHaveLength(2);
  });

  it('keeps SIMs apart', function () {
    var totals = usage.aggregate([
      record({ recordId: '1', iccid: A }),
      record({ recordId: '2', iccid: B })
    ]);

    expect(totals).toHaveLength(2);
  });

  it('splits on the UTC day boundary, not the carrier local one', function () {
    // 9pm Eastern on the 14th is the 15th in UTC. Billing runs on UTC days
    // for every carrier - one boundary beats three.
    var totals = usage.aggregate([
      record({ recordId: '1', occurredAt: '2020-06-14T23:59:59.000Z' }),
      record({ recordId: '2', occurredAt: '2020-06-15T00:00:01.000Z' })
    ]);

    expect(totals).toHaveLength(2);
    expect(totals[0].day).toBe('2020-06-14');
    expect(totals[1].day).toBe('2020-06-15');
  });

  it('sums call duration for voice', function () {
    var totals = usage.aggregate([
      record({ recordId: '1', kind: 'voice', durationSeconds: 45, bytes: 0 }),
      record({ recordId: '2', kind: 'voice', durationSeconds: 75, bytes: 0 })
    ]);

    expect(totals[0].durationSeconds).toBe(120);
  });

  it('returns a stable order regardless of input order', function () {
    var forwards = usage.aggregate([record({ recordId: '1', iccid: A }), record({ recordId: '2', iccid: B })]);
    var backwards = usage.aggregate([record({ recordId: '2', iccid: B }), record({ recordId: '1', iccid: A })]);

    expect(forwards.map(t => t.iccid)).toEqual(backwards.map(t => t.iccid));
  });

  it('produces nothing from nothing', function () {
    expect(usage.aggregate([])).toEqual([]);
  });
});

describe('the whole pipeline', function () {
  it('dedupes, quarantines and rolls up in one pass', function () {
    var result = usage.process(
      [
        record({ recordId: 'R1', bytes: 1000 }),
        record({ recordId: 'R1', bytes: 1000 }),                                  // duplicate
        record({ recordId: 'R2', bytes: 2000 }),
        record({ recordId: 'R3', bytes: 9999, occurredAt: '2049-01-01T00:00:00.000Z' }) // future
      ],
      { windowStart: '2020-06-01T00:00:00.000Z', windowEnd: '2020-06-30T23:59:59.999Z' }
    );

    expect(result.duplicates).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.accepted).toBe(2);
    expect(result.totals).toHaveLength(1);
    expect(result.totals[0].bytes).toBe(3000);
  });

  it('is idempotent when the same file is processed twice', function () {
    var records = [record({ recordId: 'R1', bytes: 1000 })];
    var first = usage.process(records, {});
    var second = usage.process(records, { alreadySeen: first.seenKeys });

    expect(first.totals[0].bytes).toBe(1000);
    expect(second.totals).toEqual([]);
    expect(second.duplicates).toBe(1);
  });
});
