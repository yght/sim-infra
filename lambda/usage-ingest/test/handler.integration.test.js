'use strict';

var mockGetObject = jest.fn();
var mockPutObject = jest.fn();
var mockGet = jest.fn();
var mockPut = jest.fn();
jest.mock('aws-sdk', () => ({
  S3: function () { return { getObject: mockGetObject, putObject: mockPutObject }; },
  DynamoDB: { DocumentClient: function () { return { get: mockGet, put: mockPut }; } }
}), { virtual: true });
var handler = require('../src/handler').handler;
const response = value => ({ promise: () => Promise.resolve(value) });
const event = key => ({ Records: [{ s3: { bucket: { name: 'landing' }, object: { key } } }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetObject.mockImplementation(() => response({ Body: Buffer.from('') }));
  mockPutObject.mockImplementation(() => response({}));
  mockGet.mockImplementation(() => response({}));
  mockPut.mockImplementation(() => response({}));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each([
  ['usage+file.jsonl', 'usage file.jsonl'],
  ['usage%2Bfile.jsonl', 'usage+file.jsonl'],
  ['usage%2520file.jsonl', 'usage%20file.jsonl'],
  ['caf%C3%A9.jsonl', 'café.jsonl']
])('fetches the actual object for encoded key %s', async (encoded, decoded) => {
  await handler(event('incoming/att/2020-06-14/' + encoded));
  expect(mockGetObject).toHaveBeenCalledWith({
    Bucket: 'landing', Key: 'incoming/att/2020-06-14/' + decoded
  });
});

test('skips malformed encoding and continues with the next record', async () => {
  const input = event('incoming/att/2020-06-14/bad%ZZ.jsonl');
  input.Records.push(...event('incoming/att/2020-06-14/valid.jsonl').Records);
  const result = await handler(input);
  expect(result.processed).toBe(1);
  expect(mockGetObject).toHaveBeenCalledTimes(1);
});

test('still propagates a real storage failure for retry', async () => {
  mockGetObject.mockImplementation(() => ({ promise: () => Promise.reject(new Error('S3 unavailable')) }));
  await expect(handler(event('incoming/att/2020-06-14/valid.jsonl'))).rejects.toThrow('S3 unavailable');
  expect(mockPutObject).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
});
