/* */ 
(function(process) {
  'use strict';
  var MqttClient = require('../client');
  var url = require('url');
  var xtend = require('xtend');
  var protocols = {};
  if (process.title !== 'browser') {
    protocols.mqtt = require('./tcp');
    protocols.tcp = require('./tcp');
    protocols.ssl = require('./tls');
    protocols.tls = require('./tls');
    protocols.mqtts = require('./tls');
  }
  protocols.ws = require('./ws');
  protocols.wss = require('./ws');
  function parseAuthOptions(opts) {
    var matches;
    if (opts.auth) {
      matches = opts.auth.match(/^(.+):(.+)$/);
      if (matches) {
        opts.username = matches[1];
        opts.password = matches[2];
      } else {
        opts.username = opts.auth;
      }
    }
  }
  function connect(brokerUrl, opts) {
    if ((typeof brokerUrl === 'object') && !opts) {
      opts = brokerUrl;
      brokerUrl = null;
    }
    opts = opts || {};
    if (brokerUrl) {
      opts = xtend(url.parse(brokerUrl, true), opts);
      if (opts.protocol === null) {
        throw new Error('Missing protocol');
      }
      opts.protocol = opts.protocol.replace(/:$/, '');
    }
    parseAuthOptions(opts);
    if (opts.query && typeof opts.query.clientId === 'string') {
      opts.clientId = opts.query.clientId;
    }
    if (opts.cert && opts.key) {
      if (opts.protocol) {
        if (['mqtts', 'wss'].indexOf(opts.protocol) === -1) {
          switch (opts.protocol) {
            case 'mqtt':
              opts.protocol = 'mqtts';
              break;
            case 'ws':
              opts.protocol = 'wss';
              break;
            default:
              throw new Error('Unknown protocol for secure connection: "' + opts.protocol + '"!');
              break;
          }
        }
      } else {
        throw new Error('Missing secure protocol key');
      }
    }
    if (!protocols[opts.protocol]) {
      var isSecure = ['mqtts', 'wss'].indexOf(opts.protocol) !== -1;
      opts.protocol = ['mqtt', 'mqtts', 'ws', 'wss'].filter(function(key, index) {
        if (isSecure && index % 2 === 0) {
          return false;
        }
        return (typeof protocols[key] === 'function');
      })[0];
    }
    if (opts.clean === false && !opts.clientId) {
      throw new Error('Missing clientId for unclean clients');
    }
    function wrapper(client) {
      if (opts.servers) {
        if (!client._reconnectCount || client._reconnectCount === opts.servers.length) {
          client._reconnectCount = 0;
        }
        opts.host = opts.servers[client._reconnectCount].host;
        opts.port = opts.servers[client._reconnectCount].port;
        opts.hostname = opts.host;
        client._reconnectCount++;
      }
      return protocols[opts.protocol](client, opts);
    }
    return new MqttClient(wrapper, opts);
  }
  module.exports = connect;
  module.exports.connect = connect;
  module.exports.MqttClient = MqttClient;
})(require('process'));
