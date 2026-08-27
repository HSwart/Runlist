'use strict';

const HUNG_START_DETAIL = 'Start timed out before a process was available.';
const EMPTY_START_COMMAND_DETAIL = 'Start command is missing.';

function normalizeStartCommand(command) {
  return typeof command === 'string' ? command.trim() : '';
}

function isEmptyStartCommand(command) {
  return normalizeStartCommand(command).length === 0;
}

function hungStartShouldFail({
  processActive = false,
  readinessTimedOut = false,
  startAttemptAgeMs,
  startBoundMs = 30000
} = {}) {
  if (processActive) {
    return false;
  }
  if (readinessTimedOut) {
    return true;
  }
  return Number.isFinite(startAttemptAgeMs) && startAttemptAgeMs >= startBoundMs;
}

function hungStartFailureDetail() {
  return HUNG_START_DETAIL;
}

function emptyStartCommandDetail() {
  return EMPTY_START_COMMAND_DETAIL;
}

function hungStoppingShouldResolve({
  processActive = false,
  portsOpen = false,
  stoppingAgeMs,
  stopBoundMs
} = {}) {
  if (!processActive && !portsOpen) {
    return 'stopped';
  }
  if (Number.isFinite(stoppingAgeMs) && Number.isFinite(stopBoundMs) && stoppingAgeMs >= stopBoundMs) {
    return 'stop-failed';
  }
  return 'stopping';
}

module.exports = {
  EMPTY_START_COMMAND_DETAIL,
  HUNG_START_DETAIL,
  emptyStartCommandDetail,
  hungStartFailureDetail,
  hungStartShouldFail,
  hungStoppingShouldResolve,
  isEmptyStartCommand,
  normalizeStartCommand
};
