/* */ 
(function(process) {
  'use strict';
  var path = require('path');
  var inspect = require('util').inspect;
  function assertPath(path) {
    if (typeof path !== 'string') {
      throw new TypeError('Path must be a string. Received ' + inspect(path));
    }
  }
  function posix(path) {
    assertPath(path);
    if (path.length === 0)
      return '.';
    var code = path.charCodeAt(0);
    var hasRoot = (code === 47);
    var end = -1;
    var matchedSlash = true;
    for (var i = path.length - 1; i >= 1; --i) {
      code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1)
      return hasRoot ? '/' : '.';
    if (hasRoot && end === 1)
      return '//';
    return path.slice(0, end);
  }
  function win32(path) {
    assertPath(path);
    var len = path.length;
    if (len === 0)
      return '.';
    var rootEnd = -1;
    var end = -1;
    var matchedSlash = true;
    var offset = 0;
    var code = path.charCodeAt(0);
    if (len > 1) {
      if (code === 47 || code === 92) {
        rootEnd = offset = 1;
        code = path.charCodeAt(1);
        if (code === 47 || code === 92) {
          var j = 2;
          var last = j;
          for (; j < len; ++j) {
            code = path.charCodeAt(j);
            if (code === 47 || code === 92)
              break;
          }
          if (j < len && j !== last) {
            last = j;
            for (; j < len; ++j) {
              code = path.charCodeAt(j);
              if (code !== 47 && code !== 92)
                break;
            }
            if (j < len && j !== last) {
              last = j;
              for (; j < len; ++j) {
                code = path.charCodeAt(j);
                if (code === 47 || code === 92)
                  break;
              }
              if (j === len) {
                return path;
              }
              if (j !== last) {
                rootEnd = offset = j + 1;
              }
            }
          }
        }
      } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        code = path.charCodeAt(1);
        if (path.charCodeAt(1) === 58) {
          rootEnd = offset = 2;
          if (len > 2) {
            code = path.charCodeAt(2);
            if (code === 47 || code === 92)
              rootEnd = offset = 3;
          }
        }
      }
    } else if (code === 47 || code === 92) {
      return path[0];
    }
    for (var i = len - 1; i >= offset; --i) {
      code = path.charCodeAt(i);
      if (code === 47 || code === 92) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) {
      if (rootEnd === -1)
        return '.';
      else
        end = rootEnd;
    }
    return path.slice(0, end);
  }
  module.exports = process.platform === 'win32' ? win32 : posix;
  module.exports.posix = posix;
  module.exports.win32 = win32;
})(require('process'));
