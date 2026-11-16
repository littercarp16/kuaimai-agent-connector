import test from 'node:test';
import assert from 'node:assert/strict';
import {validWebOrigin,validAutoTrustOrigin} from '../../src/runtime/web-origin.mjs';
import {parseLaunchOptions} from '../../src/runtime/launch-options.mjs';
test('formal HTTPS and local development origins require explicit manual pairing',()=>{
 for(const origin of ['https://app.example.com','https://app.example.com:8443','http://local.lt.com:9528','http://localhost:9528','http://127.0.0.1:4173']){
  assert.equal(validWebOrigin(origin),true);
  const options=parseLaunchOptions(['--origin',origin]);assert.equal(options.origin,origin);assert.equal(options.auto,false);assert.equal(options.allowControl,false);
 }
 assert.equal(validAutoTrustOrigin('https://app.example.com'),false);
 assert.throws(()=>parseLaunchOptions(['--trust-origin','https://app.example.com']),/来源/);
 assert.throws(()=>parseLaunchOptions(['--origin','https://app.example.com','--trust-origin','http://127.0.0.1:4173']),/来源/);
});
test('reject wildcard, non-local insecure origins and non-Origin URLs',()=>{
 for(const origin of ['null','*','https://*.example.com','http://app.example.com','https://app.example.com/','https://a:b@app.example.com','https://app.example.com/path','https://app.example.com?q=x','file:///tmp/example','https://app.example.com#x']) assert.equal(validWebOrigin(origin),false,origin);
});

test('additional origins preserve the primary automatic handshake and require explicit distinct entries', () => {
  const primary = 'http://127.0.0.1:4173', extra = 'http://local.lt.com:8251';
  const options = parseLaunchOptions(['--trust-origin', primary, '--allow-origin', extra]);
  assert.equal(options.origin, primary); assert.equal(options.auto, true);
  assert.deepEqual(options.additionalOrigins, [extra]); assert.equal(options.allowControl, false);
  for (const invalid of ['*', primary, extra + '/', 'http://remote.example'])
    assert.throws(() => parseLaunchOptions(['--trust-origin', primary, '--allow-origin', invalid]), /来源/);
  assert.throws(() => parseLaunchOptions(['--allow-origin', extra, '--allow-origin', extra]), /来源/);
  assert.equal(parseLaunchOptions([]).additionalOrigins, undefined, 'existing instance profiles remain stable');
});
