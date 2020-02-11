'use strict';

/**
 * Carrier usage file parsers.
 *
 * Every night each carrier drops a usage file in S3 and we turn it into rated
 * usage. Bell first; Vodafone and AT&T land in the same shape.
 *
 * The rules that matter, learned the hard way:
 *
 *  - Units differ. Bell reports kilobytes, Vodafone bytes, AT&T megabytes.
 *    Everything is normalised to bytes here. Getting this wrong overbills a
 *    customer by a factor of a thousand, which you hear about.
 *  - Bell timestamps are Eastern local with no offset. Everyone else is UTC.
 *  - Files can be truncated. The last line of a Bell file is regularly half
 *    written, because they upload while still writing it.
 *  - Rows repeat. The same record turns up in tomorrow's file often enough
 *    that dedupe is not optional.
 *
 * Pure functions: text in, records out. No S3, no clock.
 */

var KB = 1024;

function ParseIssue(line, lineNumber, reason) {
  this.line = line;
  this.lineNumber = lineNumber;
  this.reason = reason;
}

/**
 * Bell: pipe delimited, no header, timestamps as YYYYMMDDHHMMSS in Eastern
 * local time, data volume in kilobytes.
 *
 *   ICCID|MSISDN|YYYYMMDDHHMMSS|DURATION_S|KB|TYPE|RECORD_ID
 */
function parseBell(text, options) {
  var opts = options || {};
  // Eastern offset for the file's date. Passed in rather than computed,
  // because working it out from the record itself gets the DST boundary
  // wrong twice a year and those two nights are exactly when it matters.
  var offsetMinutes = typeof opts.offsetMinutes === 'number' ? opts.offsetMinutes : -300;

  var records = [];
  var issues = [];
  var lines = text.split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, '');

    if (line.trim().length === 0) {
      continue;
    }

    var parts = line.split('|');

    if (parts.length !== 7) {
      // Truncated final line is the usual cause and is not worth alerting on
      // by itself; the caller decides what to do with the issue list.
      issues.push(new ParseIssue(line, i + 1, 'FIELD_COUNT'));
      continue;
    }

    var timestamp = bellTimestamp(parts[2], offsetMinutes);
    if (!timestamp) {
      issues.push(new ParseIssue(line, i + 1, 'BAD_TIMESTAMP'));
      continue;
    }

    var kilobytes = Number(parts[4]);
    var duration = Number(parts[3]);

    if (!isFinite(kilobytes) || !isFinite(duration) || kilobytes < 0 || duration < 0) {
      issues.push(new ParseIssue(line, i + 1, 'BAD_NUMBER'));
      continue;
    }

    records.push({
      recordId: parts[6],
      carrier: 'bell',
      iccid: parts[0],
      msisdn: parts[1] || null,
      occurredAt: timestamp,
      durationSeconds: duration,
      bytes: Math.round(kilobytes * KB),
      kind: normaliseKind(parts[5])
    });
  }

  return { records: records, issues: issues };
}

/**
 * YYYYMMDDHHMMSS in a fixed offset -> ISO 8601 UTC.
 */
function bellTimestamp(raw, offsetMinutes) {
  if (!/^[0-9]{14}$/.test(raw)) {
    return null;
  }

  var year = Number(raw.substring(0, 4));
  var month = Number(raw.substring(4, 6));
  var day = Number(raw.substring(6, 8));
  var hour = Number(raw.substring(8, 10));
  var minute = Number(raw.substring(10, 12));
  var second = Number(raw.substring(12, 14));

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  var utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000;
  var date = new Date(utcMillis);

  // Catches things like the 31st of February, which Date.UTC rolls over
  // rather than rejecting.
  var check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }

  return date.toISOString();
}


var KINDS = {
  DATA: 'data',
  GPRS: 'data',
  D: 'data',
  VOICE: 'voice',
  MOC: 'voice',
  MTC: 'voice',
  V: 'voice',
  SMS: 'sms',
  SMSMO: 'sms',
  SMSMT: 'sms',
  S: 'sms'
};

function normaliseKind(raw) {
  if (typeof raw !== 'string') {
    return 'unknown';
  }
  var key = raw.trim().toUpperCase();
  return KINDS[key] || 'unknown';
}

var PARSERS = {
  bell: parseBell
};

function parse(carrier, text, options) {
  var parser = PARSERS[carrier];

  if (!parser) {
    throw new Error('No parser for carrier: ' + carrier);
  }

  return parser(text, options);
}

module.exports = {
  parse: parse,
  parseBell: parseBell,
  normaliseKind: normaliseKind
};
