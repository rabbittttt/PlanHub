import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script = readFileSync(new URL('../portal/js/frame-account.js', import.meta.url), 'utf8');
function portal(embedded, referrer=embedded ? 'https://outer.example' : '') {
  const origin = 'https://workbench.example';
  const parentOrigin = 'https://outer.example';
  const window = new EventTarget();
  window.parent = embedded ? {} : window;
  vm.runInNewContext(script, {window, Event, URL, location:{origin}, document:{referrer}});
  return {
    configure: origin => window.planHubFrameAccount.configure(origin),
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
  assert.equal(app.read().account, '');
  app.configure('https://outer.example');
  app.message({...alice,account:'unexpected'}, undefined, 'https://other.example');
  assert.deepEqual(app.read(), {...alice, roleCode:'0'});
  assert.equal(app.read().account, 'alice');
  app.message({...alice,account:'bob'});
  assert.equal(app.read().account, 'bob');
  app.message({account:''});
  assert.equal(app.read().account, '');
});

test('unknown parent origin leaves the display account empty', () => {
  const app = portal(true, '');
  app.message({account:'tester', roleCode:0, roleName:'计划员'});
  app.configure(null);
  assert.equal(app.read().account, '');
  app.message({account:'same',roleCode:0,roleName:'计划员'}, undefined, 'https://workbench.example');
  assert.equal(app.read().account,'same');
});

test('only an explicitly marked top-level preview supplies the debug account', () => {
  const app = portal(false);
  assert.equal(app.read().account, '');
  app.preview();
  assert.equal(app.read().account, 'local-debug');
});
