'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.StreamItemsRecord =
  exports.DeferredFragmentRecord =
  exports.IncrementalPublisher =
    void 0;
const Path_js_1 = require('../jsutils/Path.js');
const promiseWithResolvers_js_1 = require('../jsutils/promiseWithResolvers.js');
/**
 * This class is used to publish incremental results to the client, enabling semi-concurrent
 * execution while preserving result order.
 *
 * The internal publishing state is managed as follows:
 *
 * '_released': the set of Incremental Data records that are ready to be sent to the client,
 * i.e. their parents have completed and they have also completed.
 *
 * `_pending`: the set of Incremental Data records that are definitely pending, i.e. their
 * parents have completed so that they can no longer be filtered. This includes all Incremental
 * Data records in `released`, as well as Incremental Data records that have not yet completed.
 *
 * `_initialResult`: a record containing the state of the initial result, as follows:
 * `isCompleted`: indicates whether the initial result has completed.
 * `children`: the set of Incremental Data records that can be be published when the initial
 * result is completed.
 *
 * Each Incremental Data record also contains similar metadata, i.e. these records also contain
 * similar `isCompleted` and `children` properties.
 *
 * @internal
 */
class IncrementalPublisher {
  constructor() {
    this._initialResult = {
      children: new Set(),
      isCompleted: false,
    };
    this._released = new Set();
    this._pending = new Set();
    this._reset();
  }
  hasNext() {
    return this._pending.size > 0;
  }
  subscribe() {
    let isDone = false;
    const _next = async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (isDone) {
          return { value: undefined, done: true };
        }
        for (const item of this._released) {
          this._pending.delete(item);
        }
        const released = this._released;
        this._released = new Set();
        const result = this._getIncrementalResult(released);
        if (!this.hasNext()) {
          isDone = true;
        }
        if (result !== undefined) {
          return { value: result, done: false };
        }
        // eslint-disable-next-line no-await-in-loop
        await this._signalled;
      }
    };
    const returnStreamIterators = async () => {
      const promises = [];
      this._pending.forEach((incrementalDataRecord) => {
        if (
          isStreamItemsRecord(incrementalDataRecord) &&
          incrementalDataRecord.asyncIterator?.return
        ) {
          promises.push(incrementalDataRecord.asyncIterator.return());
        }
      });
      await Promise.all(promises);
    };
    const _return = async () => {
      isDone = true;
      await returnStreamIterators();
      return { value: undefined, done: true };
    };
    const _throw = async (error) => {
      isDone = true;
      await returnStreamIterators();
      return Promise.reject(error);
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: _next,
      return: _return,
      throw: _throw,
    };
  }
  prepareNewDeferredFragmentRecord(opts) {
    const deferredFragmentRecord = new DeferredFragmentRecord(opts);
    const parentContext = opts.parentContext;
    if (parentContext) {
      parentContext.children.add(deferredFragmentRecord);
    } else {
      this._initialResult.children.add(deferredFragmentRecord);
    }
    return deferredFragmentRecord;
  }
  prepareNewStreamItemsRecord(opts) {
    const streamItemsRecord = new StreamItemsRecord(opts);
    const parentContext = opts.parentContext;
    if (parentContext) {
      parentContext.children.add(streamItemsRecord);
    } else {
      this._initialResult.children.add(streamItemsRecord);
    }
    return streamItemsRecord;
  }
  completeDeferredFragmentRecord(deferredFragmentRecord, data) {
    deferredFragmentRecord.data = data;
    deferredFragmentRecord.isCompleted = true;
    this._release(deferredFragmentRecord);
  }
  completeStreamItemsRecord(streamItemsRecord, items) {
    streamItemsRecord.items = items;
    streamItemsRecord.isCompleted = true;
    this._release(streamItemsRecord);
  }
  setIsCompletedAsyncIterator(streamItemsRecord) {
    streamItemsRecord.isCompletedAsyncIterator = true;
  }
  addFieldError(incrementalDataRecord, error) {
    incrementalDataRecord.errors.push(error);
  }
  publishInitial() {
    for (const child of this._initialResult.children) {
      this._publish(child);
    }
  }
  filter(nullPath, erroringIncrementalDataRecord) {
    const nullPathArray = (0, Path_js_1.pathToArray)(nullPath);
    const asyncIterators = new Set();
    const children =
      erroringIncrementalDataRecord === undefined
        ? this._initialResult.children
        : erroringIncrementalDataRecord.children;
    for (const child of this._getDescendants(children)) {
      if (!this._matchesPath(child.path, nullPathArray)) {
        continue;
      }
      this._delete(child);
      const parent =
        child.parentContext === undefined
          ? this._initialResult
          : child.parentContext;
      parent.children.delete(child);
      if (isStreamItemsRecord(child)) {
        if (child.asyncIterator !== undefined) {
          asyncIterators.add(child.asyncIterator);
        }
      }
    }
    asyncIterators.forEach((asyncIterator) => {
      asyncIterator.return?.().catch(() => {
        // ignore error
      });
    });
  }
  _trigger() {
    this._resolve();
    this._reset();
  }
  _reset() {
    // promiseWithResolvers uses void only as a generic type parameter
    // see: https://typescript-eslint.io/rules/no-invalid-void-type/
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    const { promise: signalled, resolve } = (0,
    promiseWithResolvers_js_1.promiseWithResolvers)();
    this._resolve = resolve;
    this._signalled = signalled;
  }
  _introduce(item) {
    this._pending.add(item);
  }
  _release(item) {
    if (this._pending.has(item)) {
      this._released.add(item);
      this._trigger();
    }
  }
  _push(item) {
    this._released.add(item);
    this._pending.add(item);
    this._trigger();
  }
  _delete(item) {
    this._released.delete(item);
    this._pending.delete(item);
    this._trigger();
  }
  _getIncrementalResult(completedRecords) {
    const incrementalResults = [];
    let encounteredCompletedAsyncIterator = false;
    for (const incrementalDataRecord of completedRecords) {
      const incrementalResult = {};
      for (const child of incrementalDataRecord.children) {
        this._publish(child);
      }
      if (isStreamItemsRecord(incrementalDataRecord)) {
        const items = incrementalDataRecord.items;
        if (incrementalDataRecord.isCompletedAsyncIterator) {
          // async iterable resolver just finished but there may be pending payloads
          encounteredCompletedAsyncIterator = true;
          continue;
        }
        incrementalResult.items = items;
      } else {
        const data = incrementalDataRecord.data;
        incrementalResult.data = data ?? null;
      }
      incrementalResult.path = incrementalDataRecord.path;
      if (incrementalDataRecord.label != null) {
        incrementalResult.label = incrementalDataRecord.label;
      }
      if (incrementalDataRecord.errors.length > 0) {
        incrementalResult.errors = incrementalDataRecord.errors;
      }
      incrementalResults.push(incrementalResult);
    }
    return incrementalResults.length
      ? { incremental: incrementalResults, hasNext: this.hasNext() }
      : encounteredCompletedAsyncIterator && !this.hasNext()
      ? { hasNext: false }
      : undefined;
  }
  _publish(incrementalDataRecord) {
    if (incrementalDataRecord.isCompleted) {
      this._push(incrementalDataRecord);
    } else {
      this._introduce(incrementalDataRecord);
    }
  }
  _getDescendants(children, descendants = new Set()) {
    for (const child of children) {
      descendants.add(child);
      this._getDescendants(child.children, descendants);
    }
    return descendants;
  }
  _matchesPath(testPath, basePath) {
    for (let i = 0; i < basePath.length; i++) {
      if (basePath[i] !== testPath[i]) {
        // testPath points to a path unaffected at basePath
        return false;
      }
    }
    return true;
  }
}
exports.IncrementalPublisher = IncrementalPublisher;
/** @internal */
class DeferredFragmentRecord {
  constructor(opts) {
    this.label = opts.label;
    this.path = (0, Path_js_1.pathToArray)(opts.path);
    this.parentContext = opts.parentContext;
    this.errors = [];
    this.children = new Set();
    this.isCompleted = false;
    this.data = null;
  }
}
exports.DeferredFragmentRecord = DeferredFragmentRecord;
/** @internal */
class StreamItemsRecord {
  constructor(opts) {
    this.items = null;
    this.label = opts.label;
    this.path = (0, Path_js_1.pathToArray)(opts.path);
    this.parentContext = opts.parentContext;
    this.asyncIterator = opts.asyncIterator;
    this.errors = [];
    this.children = new Set();
    this.isCompleted = false;
    this.items = null;
  }
}
exports.StreamItemsRecord = StreamItemsRecord;
function isStreamItemsRecord(incrementalDataRecord) {
  return incrementalDataRecord instanceof StreamItemsRecord;
}
