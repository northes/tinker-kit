import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticTarget, detectTargetProtocol, explicitHostPort } from './network-target.ts';

test('RTSP 目标允许内嵌凭据并识别为 rtsp', () => {
  assert.equal(detectTargetProtocol('rtsp://user:pass@test.rtsp.stream/movie'), 'rtsp');
  assert.equal(detectTargetProtocol('rtsps://user:pass@camera.local/stream'), 'rtsp');
  assert.equal(detectTargetProtocol('rtsp://user@example.com:8554/stream'), 'rtsp');
});

test('RTSP 目标无需凭据时保持识别', () => {
  assert.equal(detectTargetProtocol('rtsp://example.com/movie'), 'rtsp');
  assert.equal(detectTargetProtocol('rtsp://example.com:554/movie'), 'rtsp');
  assert.equal(detectTargetProtocol('rtsp:///movie'), null);
  assert.equal(detectTargetProtocol('rtsp://'), null);
});

test('其余协议仍不接受内嵌凭据', () => {
  assert.equal(detectTargetProtocol('https://user:pass@example.com/'), null);
  assert.equal(detectTargetProtocol('wss://user:pass@example.com/socket'), null);
  assert.equal(detectTargetProtocol('http://user:pass@example.com/'), null);
});

test('按端口与协议补全目标', () => {
  assert.equal(detectTargetProtocol('example.com:554'), 'rtsp');
  assert.equal(detectTargetProtocol('example.com:8554'), 'rtsp');
  assert.equal(detectTargetProtocol('example.com:123'), 'ntp');
  assert.equal(detectTargetProtocol('example.com:53'), 'udp');
  assert.equal(detectTargetProtocol('example.com:8080'), 'http');
  assert.equal(detectTargetProtocol('example.com:9000'), 'tcp');
  assert.equal(detectTargetProtocol('example.com'), 'http');
  assert.equal(detectTargetProtocol(''), null);
});

test('自动模式保留 RTSP 目标原文，包含凭据', () => {
  const target = 'rtsp://user:pass@test.rtsp.stream/movie';
  const protocol = detectTargetProtocol(target);
  assert.equal(protocol, 'rtsp');
  assert.equal(automaticTarget(target, protocol), target);
  assert.equal(automaticTarget('camera.local:322', 'rtsp'), 'rtsps://camera.local:322');
  assert.equal(automaticTarget('camera.local:8554', 'rtsp'), 'camera.local:8554');
  assert.equal(automaticTarget('example.com:443', 'http'), 'https://example.com:443');
});

test('explicitHostPort 只接受纯 host:port', () => {
  assert.equal(explicitHostPort('example.com:554'), 554);
  assert.equal(explicitHostPort('user:pass@example.com:554'), null);
  assert.equal(explicitHostPort('example.com'), null);
  assert.equal(explicitHostPort('example.com:99999'), null);
});
