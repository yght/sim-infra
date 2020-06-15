'use strict';

// The handler pulls in aws-sdk at require time. It is on the Lambda runtime
// rather than in our dependencies, so stub it before requiring.
jest.mock('aws-sdk', function () {
  function noop() {
    return { promise: function () { return Promise.resolve({}); } };
  }
  return {
    S3: function () { return { getObject: noop, putObject: noop }; },
    DynamoDB: { DocumentClient: function () { return { get: noop, put: noop }; } }
  };
}, { virtual: true });

var internal = require('../src/handler')._internal;

describe('the S3 key', function () {
  it('reads the carrier and the day', function () {
    expect(internal.parseKey('incoming/bell/2020-06-14/usage.psv')).toEqual({
      carrier: 'bell',
      day: '2020-06-14'
    });
  });

  it('handles a URL encoded key, which is how S3 events deliver them', function () {
    expect(internal.parseKey('incoming/att/2020-06-14/usage+file.jsonl').carrier).toBe('att');
  });

  it('refuses a key that does not match the layout', function () {
    expect(internal.parseKey('incoming/bell/usage.psv')).toBeNull();
    expect(internal.parseKey('rated/bell/2020-06-14/totals.json')).toBeNull();
    expect(internal.parseKey('incoming/bell/14-06-2020/usage.psv')).toBeNull();
  });

  it('does not allow a nested path to smuggle in a different prefix', function () {
    expect(internal.parseKey('incoming/bell/2020-06-14/nested/usage.psv')).toBeNull();
  });
});

describe('the Eastern offset for Bell', function () {
  it('is zero for carriers that send UTC', function () {
    expect(internal.offsetFor('vodafone', '2020-06-14')).toBe(0);
    expect(internal.offsetFor('att', '2020-06-14')).toBe(0);
  });

  it('is -240 in summer', function () {
    expect(internal.offsetFor('bell', '2020-06-14')).toBe(-240);
  });

  it('is -300 in winter', function () {
    expect(internal.offsetFor('bell', '2020-01-14')).toBe(-300);
  });

  it('changes on the second Sunday of March', function () {
    // In 2020 that was the 8th.
    expect(internal.isEasternDaylight('2020-03-07')).toBe(false);
    expect(internal.isEasternDaylight('2020-03-08')).toBe(true);
  });

  it('changes back on the first Sunday of November', function () {
    // In 2020 that was the 1st.
    expect(internal.isEasternDaylight('2020-10-31')).toBe(true);
    expect(internal.isEasternDaylight('2020-11-01')).toBe(false);
  });

  it('gets the boundary right in a different year too', function () {
    // 2021: 14 March and 7 November.
    expect(internal.isEasternDaylight('2021-03-13')).toBe(false);
    expect(internal.isEasternDaylight('2021-03-14')).toBe(true);
    expect(internal.isEasternDaylight('2021-11-06')).toBe(true);
    expect(internal.isEasternDaylight('2021-11-07')).toBe(false);
  });
});

describe('addDays', function () {
  it('crosses a month boundary', function () {
    expect(internal.addDays('2020-06-30', 2)).toBe('2020-07-02');
  });

  it('crosses a year boundary', function () {
    expect(internal.addDays('2020-12-31', 2)).toBe('2021-01-02');
  });

  it('handles a leap day', function () {
    expect(internal.addDays('2020-02-28', 2)).toBe('2020-03-01');
  });
});
