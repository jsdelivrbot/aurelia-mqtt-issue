/* */ 
(function(process) {
  'use strict';
  var Readable = require('readable-stream').Readable;
  var streamsOpts = {objectMode: true};
  function Store() {
    if (!(this instanceof Store)) {
      return new Store();
    }
    this._inflights = {};
  }
  Store.prototype.put = function(packet, cb) {
    this._inflights[packet.messageId] = packet;
    if (cb) {
      cb();
    }
    return this;
  };
  Store.prototype.createStream = function() {
    var stream = new Readable(streamsOpts);
    var inflights = this._inflights;
    var ids = Object.keys(this._inflights);
    var destroyed = false;
    var i = 0;
    stream._read = function() {
      if (!destroyed && i < ids.length) {
        this.push(inflights[ids[i++]]);
      } else {
        this.push(null);
      }
    };
    stream.destroy = function() {
      if (destroyed) {
        return;
      }
      var self = this;
      destroyed = true;
      process.nextTick(function() {
        self.emit('close');
      });
    };
    return stream;
  };
  Store.prototype.del = function(packet, cb) {
    packet = this._inflights[packet.messageId];
    if (packet) {
      delete this._inflights[packet.messageId];
      cb(null, packet);
    } else if (cb) {
      cb(new Error('missing packet'));
    }
    return this;
  };
  Store.prototype.get = function(packet, cb) {
    packet = this._inflights[packet.messageId];
    if (packet) {
      cb(null, packet);
    } else if (cb) {
      cb(new Error('missing packet'));
    }
    return this;
  };
  Store.prototype.close = function(cb) {
    this._inflights = null;
    if (cb) {
      cb();
    }
  };
  module.exports = Store;
})(require('process'));
