'use strict';

var _ = require('lodash');

function initWatchVal() { }

function Scope() {
    this.$$watchers = [];
    this.$$lastDirtyWatch = null;
    this.$$asyncQueue = [];
    this.$$applyAsyncQueue = [];
    this.$$applyAsyncId = null;
    this.$$postDigestQueue = [];
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
 * Run all postDigest functions at the end
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
            try {
                var asyncTask = this.$$asyncQueue.shift();
                asyncTask.scope.$eval(asyncTask.expression);
            } catch (e) {
                console.log(e);
            }
        }
        dirty = this.$$digestOnce();
        if ((dirty || this.$$asyncQueue.length) && !(ttl--)) {
            this.$clearPhase();
            throw '10 Digest iterations reached';
        }
    } while (dirty || this.$$asyncQueue.length);
    this.$clearPhase();
    while(this.$$postDigestQueue.length){
        try {
            this.$$postDigestQueue.shift()();
        } catch (e) {
            console.log(e);
        }
    }
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
        try {
            this.$$applyAsyncQueue.shift()();
        } catch (e) {
            console.log(e);
        }
    }
    this.$$applyAsyncId = null;
};

/**
 * Apply the expression asynchronously (after current execution)
 * the function only runs once
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

/**
 * interna function
 * Provide a function that runs once at the end of the next digest
 */
Scope.prototype.$$postDigest = function(fn) {
    this.$$postDigestQueue.push(fn);
};

/**
 * Watch multiple functions, if ANY change, fire the listener function
 */
Scope.prototype.$watchGroup = function(watchFns, listenerFn) {
    var self = this, firstRun = true;
    var newValues = new Array(watchFns.length);
    var oldValues = new Array(watchFns.length);
    var listenerScheduled = false;
    var destroyFunctions = [];
    
    // If it's an empty array, run the listener at the end
    if (!watchFns.length) {
        var shouldCall = true;
        self.$evalAsync(function() {
            if (shouldCall) listenerFn(newValues, newValues, self);
        });
        
        return function() {
            shouldCall = false;
        };
    }
    
    function watchGroupListener() {
        if (firstRun) {
            firstRun = false;
            listenerFn(newValues, newValues, self);
        } else {
            listenerFn(newValues, oldValues, self);
        }
        listenerScheduled = false;
    }
    
    _.forEach(watchFns, function(watchFn, index) {
       destroyFunctions.push(self.$watch(watchFn, function(newValue, oldValue) {
          newValues[index] = newValue;
          oldValues[index] = oldValue;
          if(!listenerScheduled) {
              listenerScheduled = true;
              self.$evalAsync(watchGroupListener);
          }
       }));
    });
    
    return function() {
        _.forEach(destroyFunctions, function(destroyFunction) {
            destroyFunction();
        });
    };
};

/**
 * return an instance of Scope with this as the prototype/ancestor
 */
Scope.prototype.$new = function() {
    var child = Object.create(this);
    // To allow own digest loop to occur properly, assign it's own $$watchers
    child.$$watchers = [];
    return child;
};

module.exports = Scope;