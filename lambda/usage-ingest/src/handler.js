'use strict';

/**
 * S3 -> parsed, deduped, rolled-up usage.
 *
 * Triggered by an S3 put on the landing bucket. The key tells us the carrier
 * and the billing day:
 *
 *   incoming/bell/2020-06-14/usage.psv
 *
 * The pure work lives in parsers.js and usage.js. This file is the shell: it
 * fetches, calls them, writes the results, and decides what counts as bad
 * enough to fail on.
 */

var AWS = require('aws-sdk');
var parsers = require('./parsers');
var usage = require('./usage');

var s3 = new AWS.S3();
var dynamo = new AWS.DynamoDB.DocumentClient();

var OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;
var SEEN_TABLE = process.env.SEEN_TABLE;

/**
 * If more than this fraction of lines fail to parse, something has changed at
 * the carrier's end and we would rather fail loudly than silently bill a
 * customer for the tenth of the file we understood.
 */
var MAX_BAD_LINE_RATIO = 0.02;

var KEY_PATTERN = /^incoming\/([a-z]+)\/(\d{4}-\d{2}-\d{2})\/[^/]+$/;

function parseKey(key) {
  var match = KEY_PATTERN.exec(decodeURIComponent(key.replace(/\+/g, ' ')));

  if (!match) {
    return null;
  }

  return { carrier: match[1], day: match[2] };
}

exports.handler = async function (event) {
  var results = [];

  for (var i = 0; i < event.Records.length; i++) {
    var s3Event = event.Records[i].s3;
    var bucket = s3Event.bucket.name;
    var key = s3Event.object.key;

    var meta = parseKey(key);

    if (!meta) {
      // An unexpected key shape is a deployment mistake, not a data problem.
      // Failing here would retry forever, so log and move on.
      console.error(JSON.stringify({ level: 'error', msg: 'unrecognised key', key: key }));
      continue;
    }

    results.push(await ingestOne(bucket, key, meta));
  }

  return { processed: results.length, results: results };
};

async function ingestOne(bucket, key, meta) {
  var object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  var text = object.Body.toString('utf8');

  var parsed = parsers.parse(meta.carrier, text, {
    offsetMinutes: offsetFor(meta.carrier, meta.day)
  });

  var totalLines = parsed.records.length + parsed.issues.length;
  var badRatio = totalLines === 0 ? 0 : parsed.issues.length / totalLines;

  if (badRatio > MAX_BAD_LINE_RATIO) {
    // Throwing sends this to the DLQ with the event intact, so it can be
    // replayed once somebody has looked at the file.
    throw new Error(
      'Too many unparseable lines in ' + key + ': ' +
      parsed.issues.length + ' of ' + totalLines
    );
  }

  var seen = await loadSeenKeys(meta.carrier, meta.day);

  var processed = usage.process(parsed.records, {
    alreadySeen: seen,
    windowStart: meta.day + 'T00:00:00.000Z',
    // A day's file legitimately contains records from either side of
    // midnight, so the window is wider than the day it is named after.
    windowEnd: addDays(meta.day, 2) + 'T00:00:00.000Z'
  });

  await writeTotals(meta, processed.totals);
  await saveSeenKeys(meta.carrier, meta.day, processed.seenKeys);

  console.log(JSON.stringify({
    level: 'info',
    msg: 'ingested',
    key: key,
    carrier: meta.carrier,
    day: meta.day,
    accepted: processed.accepted,
    duplicates: processed.duplicates,
    rejected: processed.rejected.length,
    unparseable: parsed.issues.length
  }));

  return {
    key: key,
    accepted: processed.accepted,
    duplicates: processed.duplicates,
    rejected: processed.rejected.length
  };
}

/**
 * Bell send local Eastern with no offset. Everyone else is UTC.
 *
 * The offset is derived from the file's day rather than from each record,
 * because doing it per record gets the two DST changeover nights wrong and
 * those are exactly the nights anybody checks.
 */
function offsetFor(carrier, day) {
  if (carrier !== 'bell') {
    return 0;
  }

  return isEasternDaylight(day) ? -240 : -300;
}

function isEasternDaylight(day) {
  var date = new Date(day + 'T12:00:00Z');
  var year = date.getUTCFullYear();

  return date >= secondSundayOfMarch(year) && date < firstSundayOfNovember(year);
}

function secondSundayOfMarch(year) {
  var d = new Date(Date.UTC(year, 2, 1));
  var sundays = 0;
  while (true) {
    if (d.getUTCDay() === 0) {
      sundays++;
      if (sundays === 2) return d;
    }
    d = new Date(d.getTime() + 86400000);
  }
}

function firstSundayOfNovember(year) {
  var d = new Date(Date.UTC(year, 10, 1));
  while (d.getUTCDay() !== 0) {
    d = new Date(d.getTime() + 86400000);
  }
  return d;
}

function addDays(day, count) {
  var date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().substring(0, 10);
}

async function loadSeenKeys(carrier, day) {
  var response = await dynamo.get({
    TableName: SEEN_TABLE,
    Key: { pk: carrier + '#' + day }
  }).promise();

  return response.Item ? response.Item.keys : [];
}

async function saveSeenKeys(carrier, day, keys) {
  await dynamo.put({
    TableName: SEEN_TABLE,
    Item: {
      pk: carrier + '#' + day,
      keys: keys,
      // Usage disputes go back ninety days; after that the dedupe set is
      // dead weight and DynamoDB can reap it.
      expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600
    }
  }).promise();
}

async function writeTotals(meta, totals) {
  await s3.putObject({
    Bucket: OUTPUT_BUCKET,
    Key: 'rated/' + meta.carrier + '/' + meta.day + '/totals.json',
    Body: JSON.stringify(totals),
    ContentType: 'application/json',
    ServerSideEncryption: 'aws:kms'
  }).promise();
}

// Exported for tests. The pure logic is in parsers.js and usage.js; these are
// the couple of decisions that live in the shell and still deserve pinning.
exports._internal = {
  parseKey: parseKey,
  offsetFor: offsetFor,
  isEasternDaylight: isEasternDaylight,
  addDays: addDays,
  MAX_BAD_LINE_RATIO: MAX_BAD_LINE_RATIO
};
