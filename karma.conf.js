module.exports = function (config) {
    config.set({
        frameworks: ['browserify', 'jasmine'],
        files: [
            'src/**/*.js',
            'test/**/*.spec.js'
        ],
        preprocessors: {
            'test/**/*.js': ['jshint', 'browserify'],
            'src/**/*.js': ['jshint', 'browserify']
        },
        browsers: ['PhantomJS'],
        browserify: {
            // debug in browserify allows sourcemaps
            debug: true
        }
    })
}
