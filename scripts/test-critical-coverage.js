const { spawnSync } = require('node:child_process');

const criticalSources = [
  'src/lifecycle/atomic-json-record.js',
  'src/lifecycle/exclusive-json-lock.js',
  'src/lifecycle/process-identity.js',
  'src/lifecycle/process-lock.js',
  'src/lifecycle/project-lifecycle.js',
  'src/lifecycle/project-process.js',
  'src/lifecycle/runtime-process-owner.js',
  'src/ports/port-gate.js',
  'src/ports/port-recovery.js',
  'src/ports/listener-identity.js',
  'src/projects/project-store.js'
];

const criticalTests = [
  'test/atomic-json-record.test.js',
  'test/exclusive-json-lock.test.js',
  'test/process-identity.test.js',
  'test/process-lock.test.js',
  'test/project-lifecycle-coordinator.test.js',
  'test/project-process.test.js',
  'test/project-restart.test.js',
  'test/runtime-process-owner.test.js',
  'test/port-gate.test.js',
  'test/port-recovery.test.js',
  'test/listener-identity.test.js',
  'test/project-store.test.js'
];

const result = spawnSync(process.execPath, [
  '--test',
  '--test-reporter=dot',
  '--experimental-test-coverage',
  '--test-coverage-branches=80',
  '--test-coverage-functions=75',
  '--test-coverage-lines=70',
  ...criticalSources.map((file) => `--test-coverage-include=${file}`),
  ...criticalTests
], { stdio: 'inherit' });

if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`Critical coverage tests terminated with signal ${result.signal}.`);
}
process.exitCode = result.status ?? 1;
