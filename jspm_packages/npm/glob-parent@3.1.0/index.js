/* */ 
'use strict';
var path = require('path');
var isglob = require('is-glob');
var pathDirname = require('path-dirname');
var isWin32 = require('os').platform() === 'win32';
module.exports = function globParent(str) {
  if (isWin32 && str.indexOf('/') < 0)
    str = str.split('\\').join('/');
  if (/[\{\[].*[\/]*.*[\}\]]$/.test(str))
    str += '/';
  str += 'a';
  do {
    str = pathDirname.posix(str);
  } while (isglob(str) || /(^|[^\\])([\{\[]|\([^\)]+$)/.test(str));
  return str.replace(/\\([\*\?\|\[\]\(\)\{\}])/g, '$1');
};
