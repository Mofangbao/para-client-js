'use strict';
var gulp = require('gulp');
var mocha = require('gulp-mocha');
var plumber = require('gulp-plumber');

var handleErr = function (err) {
	console.log(err.message);
	process.exit(1);
};

gulp.task('static', function () {
	return gulp.src([
		'**/*.js',
		'!node_modules/**'
	])
	.on('error', handleErr);
});

gulp.task('test', [], function (cb) {
	var mochaErr;

	gulp.src('test/**/*.js')
		.pipe(plumber())
		.pipe(mocha({reporter: 'spec'}))
		.on('error', function (err) {
			mochaErr = err;
		})
		.on('end', function () {
			cb(mochaErr);
		});
});

gulp.task('default', ['static', 'test']);
