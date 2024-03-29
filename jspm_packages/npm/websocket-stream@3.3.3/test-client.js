/* */ 
(function(Buffer) {
  var ws = require('./stream');
  var test = require('tape');
  test('echo works', function(t) {
    var stream = ws('ws://localhost:8343');
    stream.on('data', function(o) {
      t.ok(Buffer.isBuffer(o), 'is buffer');
      t.equal(o.toString(), 'hello', 'got hello back');
      stream.destroy();
      t.end();
    });
    stream.write(new Buffer('hello'));
  });
  test('echo works two times', function(t) {
    var stream = ws('ws://localhost:8343');
    stream.once('data', function(o) {
      t.equal(o.toString(), 'hello', 'got first hello back');
      stream.write(new Buffer('hello'));
      stream.once('data', function(o) {
        t.equal(o.toString(), 'hello', 'got second hello back');
        stream.destroy();
        t.end();
      });
    });
    stream.write(new Buffer('hello'));
  });
  test('with bare WebSocket, strings as strings', function(t) {
    var socket = new WebSocket('ws://localhost:8344');
    socket.onmessage = function(e) {
      var data = e.data;
      t.ok(typeof data === 'string', 'data must be a string');
      socket.close();
      t.end();
    };
  });
  test('with bare WebSocket, binary only', function(t) {
    var socket = new WebSocket('ws://localhost:8345');
    socket.onmessage = function(e) {
      var data = e.data;
      t.notOk(typeof data === 'string', 'data must not be a string');
      socket.close();
      t.end();
    };
  });
  test('coerce client data as binary', function(t) {
    var stream = ws('ws://localhost:8346', {binary: true});
    stream.on('data', function(o) {
      t.ok(Buffer.isBuffer(o), 'is buffer');
      t.equal(o.toString(), 'success', 'success!');
      stream.destroy();
      t.end();
    });
    stream.write('hello');
  });
})(require('buffer').Buffer);
