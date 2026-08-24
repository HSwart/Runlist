const crypto = require('crypto');
const fs = require('fs');

function withExclusiveJsonLock(options, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Expected a lock operation.');
  }
  const lockPath = options?.lockPath;
  if (typeof lockPath !== 'string' || !lockPath) {
    throw new TypeError('Expected a lock path.');
  }
  const heldLocks = options.heldLocks;
  if (heldLocks?.has(lockPath)) {
    return operation();
  }

  const maxAttempts = options.maxAttempts ?? 200;
  const retryMs = options.retryMs ?? 5;
  const wait = options.wait || defaultWait;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const identityCache = new Map();
  let acquired = false;
  let token;
  let contended = false;
  let attemptCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attemptCount = attempt + 1;
    let descriptor;
    let created = false;
    try {
      token = randomUUID();
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      created = true;
      fs.writeFileSync(descriptor, JSON.stringify(options.createRecord(token, now())));
      fs.closeSync(descriptor);
      descriptor = undefined;
      acquired = true;
      if (contended || options.diagnoseImmediate !== false) {
        diagnose(options, options.events?.acquired || 'lock.acquired', {
          reasonCode: contended ? 'after-contention' : 'immediate',
          attemptCount
        });
      }
      break;
    } catch (error) {
      cleanupFailedCreation(lockPath, descriptor, created, error);
      if (error.code !== 'EEXIST') {
        throw error;
      }
      contended = true;
      const observed = options.observe();
      const record = observed && options.recordFromObservation(observed);
      if (record && options.ownerIsAbandoned(record, identityCache)) {
        const removed = options.removeObserved(
          observed,
          (current) => current?.token === record.token
            && options.ownerIsAbandoned(current, identityCache)
        );
        if (removed) {
          diagnose(options, options.events?.staleRecovered || 'lock.stale-recovered', {
            reasonCode: 'owner-absent',
            attemptCount
          });
          continue;
        }
      } else if (!record && options.removeInvalid?.()) {
        diagnose(options, options.events?.staleRecovered || 'lock.stale-recovered', {
          reasonCode: 'invalid-record',
          attemptCount
        });
        continue;
      }
      wait(retryMs);
    }
  }

  const current = acquired ? options.observe() : undefined;
  if (!acquired || options.recordFromObservation(current)?.token !== token) {
    diagnose(options, options.events?.timeout || 'lock.timeout', {
      reasonCode: 'owner-active-or-uncertain',
      attemptCount
    });
    throw options.timeoutError();
  }

  heldLocks?.add(lockPath);
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }

  heldLocks?.delete(lockPath);
  try {
    const observed = options.observe();
    if (observed) {
      options.removeObserved(observed, (record) => record?.token === token);
    }
  } catch (cleanupError) {
    if (!operationError) {
      throw cleanupError;
    }
    operationError.cleanupErrors = [
      ...(Array.isArray(operationError.cleanupErrors) ? operationError.cleanupErrors : []),
      cleanupError
    ];
  }
  if (operationError) {
    throw operationError;
  }
  return result;
}

function cleanupFailedCreation(lockPath, descriptor, created, error) {
  const cleanupErrors = [];
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (created) {
    try {
      fs.unlinkSync(lockPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        cleanupErrors.push(cleanupError);
      }
    }
  }
  if (cleanupErrors.length
    && error
    && (typeof error === 'object' || typeof error === 'function')) {
    error.cleanupErrors = [
      ...(Array.isArray(error.cleanupErrors) ? error.cleanupErrors : []),
      ...cleanupErrors
    ];
  }
}

function diagnose(options, event, details) {
  try {
    options.diagnose?.(event, {
      ...details,
      lockKind: options.lockKind
    });
  } catch {
    // Local diagnostics must never alter lock behavior.
  }
}

function defaultWait(milliseconds) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, milliseconds);
}

module.exports = { withExclusiveJsonLock };
