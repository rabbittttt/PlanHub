import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script = readFileSync(new URL('../portal/js/frame-account.js', import.meta.url), 'utf8');
function portal(embedded) {
  const origin = 'https://workbench.example';
  const parentOrigin = 'https://outer.example';
  const window = new EventTarget();
  window.parent = embedded ? {} : window;
  vm.runInNewContext(script, {window, Event, URL, location:{origin}, document:{referrer:embedded ? parentOrigin : ''}});
  return {
    preview: () => window.planHubFrameAccount.useLocalPreview(),
    message(data, source=window.parent, origin=parentOrigin) {
      window.dispatchEvent(Object.assign(new Event('message'), {data, source, origin}));
    },
    read() {
      let result;
      window.planHubFrameAccount.send({postMessage(data, target) {
        assert.equal(target, origin);
        result = {...data};
      }});
      return result;
    }
  };
}

test('a nested portal retains the immediate parent account until SOP loads or reloads', () => {
  const app = portal(true);
  const alice = {account:'alice', roleCode:0, roleName:'计划员'};
  app.preview();
  app.message(alice, {});
  app.message(alice, undefined, 'https://other.example');
  assert.equal(app.read().account, '');
  app.message(alice);
  assert.deepEqual(app.read(), {...alice, roleCode:'0'});
  assert.equal(app.read().account, 'alice');
  app.message({...alice,account:'bob'});
  assert.equal(app.read().account, 'bob');
  app.message({account:''});
  assert.equal(app.read().account, '');
});

test('only an explicitly marked top-level preview supplies the debug account', () => {
  const app = portal(false);
  assert.equal(app.read().account, '');
  app.preview();
  assert.equal(app.read().account, 'local-debug');
});
