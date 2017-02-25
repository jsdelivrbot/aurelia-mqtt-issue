/* */ 
(function(Buffer, process) {
  var test = require('tape');
  var mqtt = require('./mqtt');
  var WS = require('readable-stream').Writable;
  function testParseGenerate(name, object, buffer, opts) {
    test(name + ' parse', function(t) {
      t.plan(2);
      var parser = mqtt.parser(opts);
      var expected = object;
      var fixture = buffer;
      parser.on('packet', function(packet) {
        if (packet.cmd !== 'publish') {
          delete packet.topic;
          delete packet.payload;
        }
        t.deepEqual(packet, expected, 'expected packet');
      });
      t.equal(parser.parse(fixture), 0, 'remaining bytes');
    });
    test(name + ' generate', function(t) {
      t.equal(mqtt.generate(object).toString('hex'), buffer.toString('hex'));
      t.end();
    });
    test(name + ' mirror', function(t) {
      t.plan(2);
      var parser = mqtt.parser(opts);
      var expected = object;
      var fixture = mqtt.generate(object);
      parser.on('packet', function(packet) {
        if (packet.cmd !== 'publish') {
          delete packet.topic;
          delete packet.payload;
        }
        t.deepEqual(packet, expected, 'expected packet');
      });
      t.equal(parser.parse(fixture), 0, 'remaining bytes');
    });
  }
  function testParseError(expected, fixture) {
    test(expected, function(t) {
      t.plan(1);
      var parser = mqtt.parser();
      parser.on('error', function(err) {
        t.equal(err.message, expected, 'expected error message');
      });
      parser.on('packet', function() {
        t.fail('parse errors should not be followed by packet events');
      });
      parser.parse(fixture);
    });
  }
  function testGenerateError(expected, fixture) {
    test(expected, function(t) {
      t.plan(1);
      try {
        mqtt.generate(fixture);
      } catch (err) {
        t.equal(expected, err.message);
      }
    });
  }
  function testParseGenerateDefaults(name, object, buffer, opts) {
    test(name + ' parse', function(t) {
      var parser = mqtt.parser(opts);
      var expected = object;
      var fixture = buffer;
      t.plan(1 + Object.keys(expected).length);
      parser.on('packet', function(packet) {
        Object.keys(expected).forEach(function(key) {
          t.deepEqual(packet[key], expected[key], 'expected packet property ' + key);
        });
      });
      t.equal(parser.parse(fixture), 0, 'remaining bytes');
    });
    test(name + ' generate', function(t) {
      t.equal(mqtt.generate(object).toString('hex'), buffer.toString('hex'));
      t.end();
    });
  }
  function testWriteToStreamError(expected, fixture) {
    test('writeToStream ' + expected + ' error', function(t) {
      t.plan(2);
      var stream = WS();
      stream.write = () => t.fail('should not have called write');
      stream.on('error', () => t.pass('error emitted'));
      var result = mqtt.writeToStream(fixture, stream);
      t.false(result, 'result should be false');
    });
  }
  testParseGenerate('minimal connect', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 18,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    clean: false,
    keepalive: 30,
    clientId: 'test'
  }, new Buffer([16, 18, 0, 6, 77, 81, 73, 115, 100, 112, 3, 0, 0, 30, 0, 4, 116, 101, 115, 116]));
  testParseGenerate('no clientId with 3.1.1', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 12,
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    clientId: ''
  }, new Buffer([16, 12, 0, 4, 77, 81, 84, 84, 4, 2, 0, 30, 0, 0]));
  testParseGenerateDefaults('default connect', {
    cmd: 'connect',
    clientId: 'test'
  }, new Buffer([16, 16, 0, 4, 77, 81, 84, 84, 4, 2, 0, 0, 0, 4, 116, 101, 115, 116]));
  testParseGenerate('empty will payload', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 47,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: new Buffer(0)
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: new Buffer('password')
  }, new Buffer([16, 47, 0, 6, 77, 81, 73, 115, 100, 112, 3, 246, 0, 30, 0, 4, 116, 101, 115, 116, 0, 5, 116, 111, 112, 105, 99, 0, 0, 0, 8, 117, 115, 101, 114, 110, 97, 109, 101, 0, 8, 112, 97, 115, 115, 119, 111, 114, 100]));
  testParseGenerate('maximal connect', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: new Buffer('payload')
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: new Buffer('password')
  }, new Buffer([16, 54, 0, 6, 77, 81, 73, 115, 100, 112, 3, 246, 0, 30, 0, 4, 116, 101, 115, 116, 0, 5, 116, 111, 112, 105, 99, 0, 7, 112, 97, 121, 108, 111, 97, 100, 0, 8, 117, 115, 101, 114, 110, 97, 109, 101, 0, 8, 112, 97, 115, 115, 119, 111, 114, 100]));
  testParseGenerate('max connect with special chars', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 57,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'tòpic',
      payload: new Buffer('pay£oad')
    },
    clean: true,
    keepalive: 30,
    clientId: 'te$t',
    username: 'u$ern4me',
    password: new Buffer('p4$$w0£d')
  }, new Buffer([16, 57, 0, 6, 77, 81, 73, 115, 100, 112, 3, 246, 0, 30, 0, 4, 116, 101, 36, 116, 0, 6, 116, 195, 178, 112, 105, 99, 0, 8, 112, 97, 121, 194, 163, 111, 97, 100, 0, 8, 117, 36, 101, 114, 110, 52, 109, 101, 0, 9, 112, 52, 36, 36, 119, 48, 194, 163, 100]));
  test('connect all strings generate', function(t) {
    var message = {
      cmd: 'connect',
      retain: false,
      qos: 0,
      dup: false,
      length: 54,
      protocolId: 'MQIsdp',
      protocolVersion: 3,
      will: {
        retain: true,
        qos: 2,
        topic: 'topic',
        payload: 'payload'
      },
      clean: true,
      keepalive: 30,
      clientId: 'test',
      username: 'username',
      password: 'password'
    };
    var expected = new Buffer([16, 54, 0, 6, 77, 81, 73, 115, 100, 112, 3, 246, 0, 30, 0, 4, 116, 101, 115, 116, 0, 5, 116, 111, 112, 105, 99, 0, 7, 112, 97, 121, 108, 111, 97, 100, 0, 8, 117, 115, 101, 114, 110, 97, 109, 101, 0, 8, 112, 97, 115, 115, 119, 111, 114, 100]);
    t.equal(mqtt.generate(message).toString('hex'), expected.toString('hex'));
    t.end();
  });
  testParseError('Cannot parse protocol id', new Buffer([16, 4, 0, 6, 77, 81]));
  testParseGenerate('connack with return code 0', {
    cmd: 'connack',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    sessionPresent: false,
    returnCode: 0
  }, new Buffer([32, 2, 0, 0]));
  testParseGenerate('connack with return code 0 session present bit set', {
    cmd: 'connack',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    sessionPresent: true,
    returnCode: 0
  }, new Buffer([32, 2, 1, 0]));
  testParseGenerate('connack with return code 5', {
    cmd: 'connack',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    sessionPresent: false,
    returnCode: 5
  }, new Buffer([32, 2, 0, 5]));
  testParseGenerate('minimal publish', {
    cmd: 'publish',
    retain: false,
    qos: 0,
    dup: false,
    length: 10,
    topic: 'test',
    payload: new Buffer('test')
  }, new Buffer([48, 10, 0, 4, 116, 101, 115, 116, 116, 101, 115, 116]));
  ;
  (function() {
    var buffer = new Buffer(2048);
    testParseGenerate('2KB publish packet', {
      cmd: 'publish',
      retain: false,
      qos: 0,
      dup: false,
      length: 2054,
      topic: 'test',
      payload: buffer
    }, Buffer.concat([new Buffer([48, 134, 16, 0, 4, 116, 101, 115, 116]), buffer]));
  })();
  ;
  (function() {
    var buffer = new Buffer(2 * 1024 * 1024);
    testParseGenerate('2MB publish packet', {
      cmd: 'publish',
      retain: false,
      qos: 0,
      dup: false,
      length: 6 + 2 * 1024 * 1024,
      topic: 'test',
      payload: buffer
    }, Buffer.concat([new Buffer([48, 134, 128, 128, 1, 0, 4, 116, 101, 115, 116]), buffer]));
  })();
  testParseGenerate('maximal publish', {
    cmd: 'publish',
    retain: true,
    qos: 2,
    length: 12,
    dup: true,
    topic: 'test',
    messageId: 10,
    payload: new Buffer('test')
  }, new Buffer([61, 12, 0, 4, 116, 101, 115, 116, 0, 10, 116, 101, 115, 116]));
  test('publish all strings generate', function(t) {
    var message = {
      cmd: 'publish',
      retain: true,
      qos: 2,
      length: 12,
      dup: true,
      topic: 'test',
      messageId: 10,
      payload: new Buffer('test')
    };
    var expected = new Buffer([61, 12, 0, 4, 116, 101, 115, 116, 0, 10, 116, 101, 115, 116]);
    t.equal(mqtt.generate(message).toString('hex'), expected.toString('hex'));
    t.end();
  });
  testParseGenerate('empty publish', {
    cmd: 'publish',
    retain: false,
    qos: 0,
    dup: false,
    length: 6,
    topic: 'test',
    payload: new Buffer(0)
  }, new Buffer([48, 6, 0, 4, 116, 101, 115, 116]));
  test('splitted publish parse', function(t) {
    t.plan(3);
    var parser = mqtt.parser();
    var expected = {
      cmd: 'publish',
      retain: false,
      qos: 0,
      dup: false,
      length: 10,
      topic: 'test',
      payload: new Buffer('test')
    };
    parser.on('packet', function(packet) {
      t.deepEqual(packet, expected, 'expected packet');
    });
    t.equal(parser.parse(new Buffer([48, 10, 0, 4, 116, 101, 115, 116])), 6, 'remaining bytes');
    t.equal(parser.parse(new Buffer([116, 101, 115, 116])), 0, 'remaining bytes');
  });
  testParseGenerate('puback', {
    cmd: 'puback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 2
  }, new Buffer([64, 2, 0, 2]));
  testParseGenerate('pubrec', {
    cmd: 'pubrec',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 2
  }, new Buffer([80, 2, 0, 2]));
  testParseGenerate('pubrel', {
    cmd: 'pubrel',
    retain: false,
    qos: 1,
    dup: false,
    length: 2,
    messageId: 2
  }, new Buffer([98, 2, 0, 2]));
  testParseGenerate('pubcomp', {
    cmd: 'pubcomp',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 2
  }, new Buffer([112, 2, 0, 2]));
  testParseError('Wrong subscribe header', new Buffer([128, 9, 0, 6, 0, 4, 116, 101, 115, 116, 0]));
  testParseGenerate('subscribe to one topic', {
    cmd: 'subscribe',
    retain: false,
    qos: 1,
    dup: false,
    length: 9,
    subscriptions: [{
      topic: 'test',
      qos: 0
    }],
    messageId: 6
  }, new Buffer([130, 9, 0, 6, 0, 4, 116, 101, 115, 116, 0]));
  testParseGenerate('subscribe to three topics', {
    cmd: 'subscribe',
    retain: false,
    qos: 1,
    dup: false,
    length: 23,
    subscriptions: [{
      topic: 'test',
      qos: 0
    }, {
      topic: 'uest',
      qos: 1
    }, {
      topic: 'tfst',
      qos: 2
    }],
    messageId: 6
  }, new Buffer([130, 23, 0, 6, 0, 4, 116, 101, 115, 116, 0, 0, 4, 117, 101, 115, 116, 1, 0, 4, 116, 102, 115, 116, 2]));
  testParseGenerate('suback', {
    cmd: 'suback',
    retain: false,
    qos: 0,
    dup: false,
    length: 6,
    granted: [0, 1, 2, 128],
    messageId: 6
  }, new Buffer([144, 6, 0, 6, 0, 1, 2, 128]));
  testParseGenerate('unsubscribe', {
    cmd: 'unsubscribe',
    retain: false,
    qos: 1,
    dup: false,
    length: 14,
    unsubscriptions: ['tfst', 'test'],
    messageId: 7
  }, new Buffer([162, 14, 0, 7, 0, 4, 116, 102, 115, 116, 0, 4, 116, 101, 115, 116]));
  testParseGenerate('unsuback', {
    cmd: 'unsuback',
    retain: false,
    qos: 0,
    dup: false,
    length: 2,
    messageId: 8
  }, new Buffer([176, 2, 0, 8]));
  testParseGenerate('pingreq', {
    cmd: 'pingreq',
    retain: false,
    qos: 0,
    dup: false,
    length: 0
  }, new Buffer([192, 0]));
  testParseGenerate('pingresp', {
    cmd: 'pingresp',
    retain: false,
    qos: 0,
    dup: false,
    length: 0
  }, new Buffer([208, 0]));
  testParseGenerate('disconnect', {
    cmd: 'disconnect',
    retain: false,
    qos: 0,
    dup: false,
    length: 0
  }, new Buffer([224, 0]));
  testGenerateError('Unknown command', {});
  testGenerateError('Invalid protocol id', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 42,
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: 'password'
  });
  testGenerateError('clientId must be supplied before 3.1.1', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: true,
    keepalive: 30,
    username: 'username',
    password: 'password'
  });
  testGenerateError('clientId must be given if cleanSession set to 0', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQTT',
    protocolVersion: 4,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: false,
    keepalive: 30,
    username: 'username',
    password: 'password'
  });
  testGenerateError('Invalid keepalive', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: true,
    keepalive: 'hello',
    clientId: 'test',
    username: 'username',
    password: 'password'
  });
  testGenerateError('Invalid keepalive', {
    cmd: 'connect',
    keepalive: 3.1416
  });
  testGenerateError('Invalid will', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: 42,
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: 'password'
  });
  testGenerateError('Invalid will topic', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      payload: 'payload'
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: 'password'
  });
  testGenerateError('Invalid will payload', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 42
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: 'password'
  });
  testGenerateError('Invalid username', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 42,
    password: 'password'
  });
  testGenerateError('Invalid password', {
    cmd: 'connect',
    retain: false,
    qos: 0,
    dup: false,
    length: 54,
    protocolId: 'MQIsdp',
    protocolVersion: 3,
    will: {
      retain: true,
      qos: 2,
      topic: 'topic',
      payload: 'payload'
    },
    clean: true,
    keepalive: 30,
    clientId: 'test',
    username: 'username',
    password: 42
  });
  test('support cork', function(t) {
    t.plan(9);
    var dest = WS();
    dest._write = function(chunk, enc, cb) {
      t.pass('_write called');
      cb();
    };
    mqtt.writeToStream({
      cmd: 'connect',
      retain: false,
      qos: 0,
      dup: false,
      length: 18,
      protocolId: 'MQIsdp',
      protocolVersion: 3,
      clean: false,
      keepalive: 30,
      clientId: 'test'
    }, dest);
    dest.end();
  });
  testParseError('Packet too short', new Buffer([16, 9, 0, 6, 77, 81, 73, 115, 100, 112, 3]));
  testParseError('Invalid protocol id', new Buffer([16, 18, 0, 6, 65, 65, 65, 65, 65, 65, 3, 0, 0, 10, 0, 4, 116, 101, 115, 116]));
  testParseError('Invalid protocol version', new Buffer([16, 18, 0, 6, 77, 81, 73, 115, 100, 112, 1, 0, 0, 10, 0, 4, 116, 101, 115, 116]));
  testParseError('Cannot parse protocol id', new Buffer([16, 8, 0, 15, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112, 77, 81, 73, 115, 100, 112]));
  test('stops parsing after first error', function(t) {
    t.plan(4);
    var parser = mqtt.parser();
    var packetCount = 0;
    var errorCount = 0;
    var expectedPackets = 1;
    var expectedErrors = 1;
    parser.on('packet', function(packet) {
      t.ok(++packetCount <= expectedPackets, 'expected <= ' + expectedPackets + ' packets');
    });
    parser.on('error', function(erroneous) {
      t.ok(++errorCount <= expectedErrors, 'expected <= ' + expectedErrors + ' errors');
    });
    parser.parse(new Buffer([16, 12, 0, 4, 77, 81, 84, 84, 4, 2, 0, 30, 0, 0, 128, 9, 0, 6, 0, 4, 116, 101, 115, 116, 0, 128, 9, 0, 6, 0, 4, 116, 101, 115, 116, 0, 224, 0]));
    packetCount = 0;
    errorCount = 0;
    expectedPackets = 2;
    expectedErrors = 0;
    parser.parse(new Buffer([16, 12, 0, 4, 77, 81, 84, 84, 4, 2, 0, 30, 0, 0, 224, 0]));
  });
  testWriteToStreamError('Invalid protocol id', {
    cmd: 'connect',
    protocolId: {}
  });
  testWriteToStreamError('Invalid topic', {
    cmd: 'publish',
    topic: {}
  });
  testWriteToStreamError('Invalid message id', {
    cmd: 'subscribe',
    mid: {}
  });
})(require('buffer').Buffer, require('process'));
