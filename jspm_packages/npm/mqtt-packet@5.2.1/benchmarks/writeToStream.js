/* */ 
(function(Buffer) {
  var mqtt = require('../mqtt');
  var max = 1000000;
  var i = 0;
  var start = Date.now();
  var time;
  var buf = new Buffer(10);
  var net = require('net');
  var server = net.createServer(handle);
  var dest;
  function handle(sock) {
    sock.resume();
  }
  buf.fill('test');
  server.listen(0, function() {
    dest = net.connect(server.address());
    dest.on('connect', tickWait);
    dest.on('drain', tickWait);
    dest.on('finish', function() {
      time = Date.now() - start;
      console.log('Total time', time);
      console.log('Total packets', max);
      console.log('Packet/s', max / time * 1000);
      server.close();
    });
  });
  function tickWait() {
    var res = true;
    for (; i < max && res; i++) {
      res = mqtt.writeToStream({
        cmd: 'publish',
        topic: 'test',
        payload: buf
      }, dest);
    }
    if (i >= max) {
      dest.end();
      return;
    }
  }
})(require('buffer').Buffer);
