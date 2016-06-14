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
    this.$$children = [];
    this.$root = this;
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
    this.$root.$$lastDirtyWatch = null;
    return function () {
        var index = self.$$watchers.indexOf(watcher);
        if (index > -1) {
            self.$$watchers.splice(index, 1);
            self.$root.$$lastDirtyWatch = null;
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
 * One digest loop for each scope and children. For each watcher, call the listener if the value changed
 * return dirty(boolean) if there was a change in the loop
 */
Scope.prototype.$$digestOnce = function () {
    var self = this, dirty, continueLoop = true;
    
    // Run a digest in this scope, and all children scopes
    this.$$everyScope(function(scope) {
        var newValue, oldValue;
        _.forEachRight(scope.$$watchers, function (watcher) {
            try {
                if (watcher) {
                    newValue = watcher.watchFn(scope);
                    oldValue = watcher.last;

                    if (!scope.$$areEqual(newValue, oldValue, watcher.valueEq)) {
                        self.$root.$$lastDirtyWatch = watcher;
                        watcher.last = watcher.valueEq ? _.cloneDeep(newValue) : newValue;
                        watcher.listenerFn(newValue,
                            (oldValue === initWatchVal ? newValue : oldValue),
                            scope);
                        dirty = true;
                    // if this watcher is also the lastDirtyWatcher, then short circuit
                    } else if (self.$root.$$lastDirtyWatch === watcher) {
                        continueLoop = false;
                        // break the forEachRight
                        return false;
                    }
                }
            } catch (e) {
                console.error(e);
            }
        });
        return continueLoop;
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
    this.$root.$$lastDirtyWatch = null;
    this.$beginPhase('$digest');
    if (this.$root.$$applyAsyncId) {
        clearTimeout(this.$root.$$applyAsyncId);
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
        this.$root.$digest();
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
                self.$root.$digest();
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
    this.$root.$$applyAsyncId = null;
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
    if (self.$root.$$applyAsyncId === null) {
        self.$root.$$applyAsyncId = setTimeout(function(){
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
Scope.prototype.$new = function(isolated, parent) {
    var child;
    parent = parent || this;
    
    if (isolated) {
        child = new Scope();
        child.$root = parent.$root;
        child.$$asyncQueue = parent.$$asyncQueue;
        child.$$postDigestQueue = parent.$$postDigestQueue;
        child.$$applyAsyncQueue = parent.$$applyAsyncQueue;
    } else {
        child = Object.create(this);
    }
    
    parent.$$children.push(child);
    // To allow own digest loop to occur properly, assign it's own $$watchers
    child.$$watchers = [];
    // don't allow child to inherit this.$$children;
    child.$$children = [];
    child.$parent = parent;
    return child;
};

/**
 * remove ourself from our parent
 */
Scope.prototype.$destroy = function() {
    if (this.$parent) {
        var siblings = this.$parent.$$children,
            indexOfThis = siblings.indexOf(this);
        if (indexOfThis > -1) {
            siblings.splice(indexOfThis);
        }
    }
    this.$$watchers = null;
};

/**
 * run code on each of the children scopes
 */
Scope.prototype.$$everyScope = function(fn) {
    if (fn(this)) {
        return this.$$children.every(function(child) {
            return child.$$everyScope(fn);
        });
    } else {
        return false;
    }
};

module.exports = Scope;