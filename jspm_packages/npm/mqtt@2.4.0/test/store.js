/* */ 
'use strict';
var Store = require('../lib/store');
var abstractTest = require('./abstract_store');
describe('in-memory store', function() {
  abstractTest(function(done) {
    done(null, new Store());
  });
});
