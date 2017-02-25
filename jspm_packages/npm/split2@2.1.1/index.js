/* */ 
'use strict';
var through = require('through2');
var StringDecoder = require('string_decoder').StringDecoder;
function transform(chunk, enc, cb) {
  this._last += this._decoder.write(chunk);
  if (this._last.length > this.maxLength) {
    return cb(new Error('maximum buffer reached'));
  }
  var list = this._last.split(this.matcher);
  this._last = list.pop();
  for (var i = 0; i < list.length; i++) {
    push(this, this.mapper(list[i]));
  }
  cb();
}
function flush(cb) {
  this._last += this._decoder.end();
  if (this._last) {
    push(this, this.mapper(this._last));
  }
  cb();
}
function push(self, val) {
  if (val !== undefined) {
    self.push(val);
  }
}
function noop(incoming) {
  return incoming;
}
function split(matcher, mapper, options) {
  matcher = matcher || /\r?\n/;
  mapper = mapper || noop;
  options = options || {};
  switch (arguments.length) {
    case 1:
      if (typeof matcher === 'function') {
        mapper = matcher;
        matcher = /\r?\n/;
      } else if (typeof matcher === 'object' && !(matcher instanceof RegExp)) {
        options = matcher;
        matcher = /\r?\n/;
      }
      break;
    case 2:
      if (typeof matcher === 'function') {
        options = mapper;
        mapper = matcher;
        matcher = /\r?\n/;
      } else if (typeof mapper === 'object') {
        options = mapper;
        mapper = noop;
      }
  }
  var stream = through(options, transform, flush);
  stream._readableState.objectMode = true;
  stream._last = '';
  stream._decoder = new StringDecoder('utf8');
  stream.matcher = matcher;
  stream.mapper = mapper;
  stream.maxLength = options.maxLength;
  return stream;
}
module.exports = split;
