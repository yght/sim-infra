'use strict';

var parsers = require('../src/parsers');

var ICCID = '8913027201000024686';

describe('Bell', function () {
  var line = [ICCID, '14165550142', '20200614213000', '0', '2048', 'GPRS', 'BL-99001'].join('|');

  it('parses a well formed row', function () {
    var result = parsers.parseBell(line);

    expect(result.issues).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].recordId).toBe('BL-99001');
    expect(result.records[0].kind).toBe('data');
  });

  it('converts kilobytes to bytes', function () {
    // 2048 KB is 2 MiB. Getting this wrong overbills by a factor of 1024.
    expect(parsers.parseBell(line).records[0].bytes).toBe(2097152);
  });

  it('reads the timestamp as Eastern and stores UTC', function () {
    // 21:30 on 14 June is EDT, which is UTC-4, so 01:30 the next day.
    var result = parsers.parseBell(line, { offsetMinutes: -240 });
    expect(result.records[0].occurredAt).toBe('2020-06-15T01:30:00.000Z');
  });

  it('uses the offset it is given rather than guessing at DST', function () {
    var winter = parsers.parseBell(line, { offsetMinutes: -300 });
    expect(winter.records[0].occurredAt).toBe('2020-06-15T02:30:00.000Z');
  });

  it('reports a truncated final line instead of throwing', function () {
    var text = line + '\n' + ICCID + '|14165550142|202006142';
    var result = parsers.parseBell(text);

    expect(result.records).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toBe('FIELD_COUNT');
    expect(result.issues[0].lineNumber).toBe(2);
  });

  it('rejects an impossible date rather than rolling it over', function () {
    var bad = [ICCID, '14165550142', '20200231120000', '0', '10', 'GPRS', 'BL-2'].join('|');
    var result = parsers.parseBell(bad);

    expect(result.records).toHaveLength(0);
    expect(result.issues[0].reason).toBe('BAD_TIMESTAMP');
  });

  it('rejects a negative volume', function () {
    var bad = [ICCID, '14165550142', '20200614213000', '0', '-5', 'GPRS', 'BL-3'].join('|');
    expect(parsers.parseBell(bad).issues[0].reason).toBe('BAD_NUMBER');
  });

  it('ignores blank lines and trailing carriage returns', function () {
    var result = parsers.parseBell('\r\n' + line + '\r\n\r\n');

    expect(result.records).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });
});

describe('Vodafone', function () {
  var csv = [
    'record_id,iccid,msisdn,timestamp,duration_s,bytes,type',
    'VF-4001,8944150002000035712,447700900142,2020-06-14T21:30:00Z,0,1048576,DATA'
  ].join('\n');

  it('parses a header and a row', function () {
    var result = parsers.parseVodafone(csv);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].recordId).toBe('VF-4001');
    expect(result.records[0].bytes).toBe(1048576);
    expect(result.records[0].occurredAt).toBe('2020-06-14T21:30:00.000Z');
  });

  it('takes bytes as bytes, without scaling', function () {
    expect(parsers.parseVodafone(csv).records[0].bytes).toBe(1048576);
  });

  it('copes with quoted fields and embedded commas', function () {
    var quoted = [
      'record_id,iccid,msisdn,timestamp,duration_s,bytes,type',
      '"VF-4002","8944150002000035712","447700900142","2020-06-14T21:30:00Z","0","2048","VOICE"'
    ].join('\n');

    expect(parsers.parseVodafone(quoted).records[0].recordId).toBe('VF-4002');
    expect(parsers.parseVodafone(quoted).records[0].kind).toBe('voice');
  });

  it('flags a row with the wrong number of fields', function () {
    var broken = csv + '\nVF-4003,8944150002000035712';
    var result = parsers.parseVodafone(broken);

    expect(result.records).toHaveLength(1);
    expect(result.issues[0].reason).toBe('FIELD_COUNT');
  });

  it('is case insensitive about the header', function () {
    var upper = csv.replace(
      'record_id,iccid,msisdn,timestamp,duration_s,bytes,type',
      'RECORD_ID,ICCID,MSISDN,TIMESTAMP,DURATION_S,BYTES,TYPE'
    );

    expect(parsers.parseVodafone(upper).records).toHaveLength(1);
  });
});

describe('AT&T', function () {
  var jsonl = JSON.stringify({
    recordId: 'ATT-7001',
    simIdentifier: '8913104103000048267',
    phoneNumber: '4165550142',
    eventTime: '2020-06-14T21:30:00Z',
    durationSeconds: 0,
    dataVolumeMb: '1.5',
    usageType: 'DATA'
  });

  it('parses newline delimited JSON', function () {
    var result = parsers.parseAtt(jsonl);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].recordId).toBe('ATT-7001');
  });

  it('converts megabytes to bytes, rounding rather than truncating', function () {
    // 1.5 MB is 1572864 bytes exactly. Truncating loses bytes on every
    // record and the monthly totals drift low enough to get noticed.
    expect(parsers.parseAtt(jsonl).records[0].bytes).toBe(1572864);
  });

  it('handles a fractional volume that does not divide evenly', function () {
    var odd = JSON.stringify({
      recordId: 'ATT-7002',
      simIdentifier: '8913104103000048267',
      eventTime: '2020-06-14T21:30:00Z',
      dataVolumeMb: '0.333',
      usageType: 'DATA'
    });

    expect(parsers.parseAtt(odd).records[0].bytes).toBe(Math.round(0.333 * 1048576));
  });

  it('reports a malformed JSON line and keeps going', function () {
    var text = jsonl + '\n{ not json\n' + jsonl.replace('ATT-7001', 'ATT-7003');
    var result = parsers.parseAtt(text);

    expect(result.records).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toBe('BAD_JSON');
    expect(result.issues[0].lineNumber).toBe(2);
  });
});

describe('usage kinds', function () {
  it('folds each carrier vocabulary onto ours', function () {
    expect(parsers.normaliseKind('GPRS')).toBe('data');
    expect(parsers.normaliseKind('DATA')).toBe('data');
    expect(parsers.normaliseKind('MOC')).toBe('voice');
    expect(parsers.normaliseKind('SMSMT')).toBe('sms');
  });

  it('is unknown rather than wrong for a code we do not have', function () {
    expect(parsers.normaliseKind('MMS')).toBe('unknown');
    expect(parsers.normaliseKind(null)).toBe('unknown');
  });
});

describe('cross-carrier agreement', function () {
  it('reports the same volume for the same usage in three formats', function () {
    // One mebibyte, expressed the way each carrier expresses it.
    var bell = parsers.parseBell([ICCID, '1', '20200614213000', '0', '1024', 'GPRS', 'B1'].join('|'));
    var vodafone = parsers.parseVodafone(
      'record_id,iccid,msisdn,timestamp,duration_s,bytes,type\nV1,' + ICCID + ',1,2020-06-14T21:30:00Z,0,1048576,DATA'
    );
    var att = parsers.parseAtt(
      JSON.stringify({
        recordId: 'A1',
        simIdentifier: ICCID,
        eventTime: '2020-06-14T21:30:00Z',
        dataVolumeMb: '1',
        usageType: 'DATA'
      })
    );

    expect(bell.records[0].bytes).toBe(1048576);
    expect(vodafone.records[0].bytes).toBe(1048576);
    expect(att.records[0].bytes).toBe(1048576);
  });
});
