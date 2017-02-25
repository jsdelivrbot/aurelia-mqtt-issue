/* */ 
(function(process) {
  'use strict';
  var through2 = require('through2');
  var Combine = require('ordered-read-streams');
  var unique = require('unique-stream');
  var glob = require('glob');
  var micromatch = require('micromatch');
  var resolveGlob = require('to-absolute-glob');
  var globParent = require('glob-parent');
  var path = require('path');
  var extend = require('extend');
  var sepRe = (process.platform === 'win32' ? /[\/\\]/ : /\/+/);
  var gs = {
    createStream: function(ourGlob, negatives, opt) {
      var ourOpt = extend({}, opt);
      delete ourOpt.root;
      var basePath = ourOpt.base || getBasePath(ourGlob, opt);
      ourGlob = resolveGlob(ourGlob, opt);
      var globber = new glob.Glob(ourGlob, ourOpt);
      var stream = through2.obj(opt, negatives.length ? filterNegatives : undefined);
      var found = false;
      globber.on('error', stream.emit.bind(stream, 'error'));
      globber.once('end', function() {
        if (opt.allowEmpty !== true && !found && globIsSingular(globber)) {
          stream.emit('error', new Error('File not found with singular glob: ' + ourGlob));
        }
        stream.end();
      });
      globber.on('match', function(filename) {
        found = true;
        stream.write({
          cwd: opt.cwd,
          base: basePath,
          path: path.normalize(filename)
        });
      });
      return stream;
      function filterNegatives(filename, enc, cb) {
        var matcha = isMatch.bind(null, filename);
        if (negatives.every(matcha)) {
          cb(null, filename);
        } else {
          cb();
        }
      }
    },
    create: function(globs, opt) {
      if (!opt) {
        opt = {};
      }
      if (typeof opt.cwd !== 'string') {
        opt.cwd = process.cwd();
      }
      if (typeof opt.dot !== 'boolean') {
        opt.dot = false;
      }
      if (typeof opt.silent !== 'boolean') {
        opt.silent = true;
      }
      if (typeof opt.nonull !== 'boolean') {
        opt.nonull = false;
      }
      if (typeof opt.cwdbase !== 'boolean') {
        opt.cwdbase = false;
      }
      if (opt.cwdbase) {
        opt.base = opt.cwd;
      }
      if (!Array.isArray(globs)) {
        globs = [globs];
      }
      var positives = [];
      var negatives = [];
      var ourOpt = extend({}, opt);
      delete ourOpt.root;
      globs.forEach(function(glob, index) {
        if (typeof glob !== 'string' && !(glob instanceof RegExp)) {
          throw new Error('Invalid glob at index ' + index);
        }
        var globArray = isNegative(glob) ? negatives : positives;
        if (globArray === negatives && typeof glob === 'string') {
          var ourGlob = resolveGlob(glob, opt);
          glob = micromatch.matcher(ourGlob, ourOpt);
        }
        globArray.push({
          index: index,
          glob: glob
        });
      });
      if (positives.length === 0) {
        throw new Error('Missing positive glob');
      }
      if (positives.length === 1) {
        return streamFromPositive(positives[0]);
      }
      var streams = positives.map(streamFromPositive);
      var aggregate = new Combine(streams);
      var uniqueStream = unique('path');
      var returnStream = aggregate.pipe(uniqueStream);
      aggregate.on('error', function(err) {
        returnStream.emit('error', err);
      });
      return returnStream;
      function streamFromPositive(positive) {
        var negativeGlobs = negatives.filter(indexGreaterThan(positive.index)).map(toGlob);
        return gs.createStream(positive.glob, negativeGlobs, opt);
      }
    }
  };
  function isMatch(file, matcher) {
    if (typeof matcher === 'function') {
      return matcher(file.path);
    }
    if (matcher instanceof RegExp) {
      return matcher.test(file.path);
    }
  }
  function isNegative(pattern) {
    if (typeof pattern === 'string') {
      return pattern[0] === '!';
    }
    if (pattern instanceof RegExp) {
      return true;
    }
  }
  function indexGreaterThan(index) {
    return function(obj) {
      return obj.index > index;
    };
  }
  function toGlob(obj) {
    return obj.glob;
  }
  function globIsSingular(glob) {
    var globSet = glob.minimatch.set;
    if (globSet.length !== 1) {
      return false;
    }
    return globSet[0].every(function isString(value) {
      return typeof value === 'string';
    });
  }
  function getBasePath(ourGlob, opt) {
    var basePath;
    var parent = globParent(ourGlob);
    if (parent === '/' && opt && opt.root) {
      basePath = path.normalize(opt.root);
    } else {
      basePath = resolveGlob(parent, opt);
    }
    if (!sepRe.test(basePath.charAt(basePath.length - 1))) {
      basePath += path.sep;
    }
    return basePath;
  }
  module.exports = gs;
})(require('process'));
