/** Unit tests only — no infrastructure required (Redis is mocked/faked). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Unit tests exercise pure logic (window math, bucket, breaker) and must
  // stay fast enough to run on every commit.
  testTimeout: 5000,
};
