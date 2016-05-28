'use strict';

var _ = require('lodash');

function initWatchVal() { }

function Scope() {
    this.$$watchers = [];
    this.$$lastDirtyWatch = null;
    this.$$asyncQueue = [];
    this.$$applyAsyncQueue = [];
    this.$$applyAsyncId = null;
    this.$$phase = null;
}

/**
 * Runs every time in a digest loop
 * if result of watchFn is different from last time,
 * call listenerFn(oldValue, newValue, scope)
 * valueEq: boolean whether to check value (true) or exact
 */
Scope.prototype.$watch = function (watchFn, listenerFn, valueEq) {
    var self = this;
    var watcher = {
        watchFn: watchFn,
        listenerFn: listenerFn || function () { },
        last: initWatchVal,
        valueEq: !!valueEq
    };

    this.$$watchers.unshift(watcher);
    this.$$lastDirtyWatch = null;
    return function () {
        var index = self.$$watchers.indexOf(watcher);
        if (index > -1) {
            self.$$watchers.splice(index, 1);
            self.$$lastDirtyWatch = null;
        }
    };
};

/**
 * internal function
 * are the VALUEs equal?
 */
Scope.prototype.$$areEqual = function (newValue, oldValue, valueEq) {
    if (valueEq) {
        return _.isEqual(newValue, oldValue);
    } else {
        return newValue === oldValue ||
            (typeof newValue === 'number' && typeof oldValue === 'number' &&
                isNaN(newValue) && isNaN(oldValue));
    }
};

/**
 * internal function
 * One digest loop. For each watcher, call the listener if the value changed
 * return dirty(boolean) if there was a change in the loop
 */
Scope.prototype.$$digestOnce = function () {
    var self = this, newValue, oldValue, dirty;

    _.forEachRight(this.$$watchers, function (watcher) {
        try {
            if (watcher) {
                newValue = watcher.watchFn(self);
                oldValue = watcher.last;

                if (!self.$$areEqual(newValue, oldValue, watcher.valueEq)) {
                    self.$$lastDirtyWatch = watcher;
                    watcher.last = watcher.valueEq ? _.cloneDeep(newValue) : newValue;
                    watcher.listenerFn(newValue,
                        (oldValue === initWatchVal ? newValue : oldValue),
                        self);
                    dirty = true;
                } else if (self.$$lastDirtyWatch === watcher) {
                    return false;
                }
            }
        } catch (e) {
            console.error(e);
        }
    });

    return dirty;
};

/**
 * Trigger the digest loop. If the loop is dirty, run again
 * Run no more than 10 times.
 * Clear the evalAsync array before each loop
 */
Scope.prototype.$digest = function () {
    var dirty, ttl = 10;
    this.$$lastDirtyWatch = null;
    this.$beginPhase('$digest');
    if (this.$$applyAsyncId) {
        clearTimeout(this.$$applyAsyncId);
        this.$$flushApplyAsync();
    }
    do {
        while (this.$$asyncQueue.length) {
            var asyncTask = this.$$asyncQueue.shift();
            asyncTask.scope.$eval(asyncTask.expression);
        }
        dirty = this.$$digestOnce();
        if ((dirty || this.$$asyncQueue.length) && !(ttl--)) {
            this.$clearPhase();
            throw '10 Digest iterations reached';
        }
    } while (dirty || this.$$asyncQueue.length);
    this.$clearPhase();
};

/**
 * Evaluate the function in the scope
 */
Scope.prototype.$eval = function (expr, locals) {
    return expr(this, locals);
};

/**
 * Evaluate the expression, then run the digest loop
 */
Scope.prototype.$apply = function (expr) {
    this.$beginPhase('$apply');
    try {
        return this.$eval(expr);
    } finally {
        this.$clearPhase();
        this.$digest();
    }
};

/**
 * Evaluate the expression next time the digest loop runs.
 * If the loop is already running, eval in current loop
 */
Scope.prototype.$evalAsync = function (expr) {
    var self = this;
    if (!self.$$phase && !self.$$asyncQueue.length) {
        setTimeout(function() {
            if (self.$$asyncQueue.length) {
                self.$digest();
            }
        }, 0);
    }
    this.$$asyncQueue.push({ scope: this, expression: expr });
};

/**
 * Change the internal phase tracking
 */
Scope.prototype.$beginPhase = function (phase) {
    if (this.$$phase) {
        throw 'Phase ' + this.$$phase + ' already in progress';
    }
    this.$$phase = phase;
};

/**
 * Clear internal phase tracker
 */
Scope.prototype.$clearPhase = function () {
    this.$$phase = null;
};

/**
 * Flush and run the current applyAsync array
 */
Scope.prototype.$$flushApplyAsync = function () {
    while (this.$$applyAsyncQueue.length) {
        this.$$applyAsyncQueue.shift()();
    }
    this.$$applyAsyncId = null;
};

/**
 * Apply the expression asynchronously (after current execution)
 */
Scope.prototype.$applyAsync = function (expr) {
    var self = this;
    this.$$applyAsyncQueue.push(function() {
        self.$eval(expr); 
    });
    if (self.$$applyAsyncId === null) {
        self.$$applyAsyncId = setTimeout(function(){
            self.$apply(_.bind(self.$$flushApplyAsync, self));
        },0);
    }
};

module.exports = Scope;