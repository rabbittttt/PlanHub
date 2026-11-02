import test from 'node:test';
import assert from 'node:assert/strict';
import { localPath, validateConfig, routeFromHash } from '../portal/js/config.js';

function registry() {
  return {
    platform: { name: '测试门户', defaultApp: 'orderiq' },
    groups: [{ id: 'business', name: '业务', apps: [
      { id: 'orderiq', name: '订单', url: '/orderiq/', enabled: true, status: 'ready' },
      { id: 'hidden', name: '隐藏', url: '/hidden/', enabled: false, status: 'ready' },
      { id: 'sop', name: '计划', url: '/sop/', enabled: true, status: 'pending' },
    ] }],
  };
}

test('configuration keeps enabled apps and resolves default, explicit and unknown routes', () => {
  const config = validateConfig(registry());
  assert.deepEqual(config.apps.map(app => app.id), ['orderiq', 'sop']);
  assert.equal(routeFromHash('', config), 'orderiq');
  assert.equal(routeFromHash('#/app/orderiq', config), 'orderiq');
  assert.equal(routeFromHash('#/app/sop', config), 'sop');
  for (const hash of ['#/home', '#/app/hidden', '#/app/unknown', '#/app/orderiq/../hidden', '#/app/%6frderiq']) {
    assert.equal(routeFromHash(hash, config), 'home', hash);
  }
});

test('application addresses reject origins, traversal and unscoped roots', () => {
  assert.equal(localPath('/orderiq/'), '/orderiq/');
  assert.equal(localPath('/business/forecast-v2/'), '/business/forecast-v2/');
  for (const input of ['/', 'orderiq/', '//evil.test/', 'https://evil.test/', 'javascript:alert(1)', '/foo/../bar/', '/foo/./bar/', '/foo//bar/', '/foo/%2e%2e/bar/', '/foo\\bar/', '/foo/?url=evil', null, 42]) {
    assert.throws(() => localPath(input), undefined, String(input));
  }
});

test('duplicate identifiers and invalid default applications fail before rendering', () => {
  for (const mutate of [
    value => { value.groups.push(structuredClone(value.groups[0])); },
    value => { value.groups[0].apps[1].id = 'orderiq'; },
    value => { value.groups[0].apps[0].id = 'home'; },
    value => { value.platform.defaultApp = 'hidden'; },
    value => { value.platform.defaultApp = 'sop'; },
    value => { value.groups[0].apps[0].enabled = 'true'; },
    value => { value.groups[0].apps[0].status = 'unknown'; },
    value => { value.platform.loadTimeoutMs = 0; },
    value => { value.platform.identityEndpoint = 'https://evil.test/me'; },
  ]) {
    const value = registry();
    mutate(value);
    assert.throws(() => validateConfig(value));
  }
});

test('identifiers must be strings instead of implicitly converted JavaScript values', () => {
  for (const invalid of [undefined, null, true, false, {}, [], 42]) {
    for (const target of ['group', 'app']) {
      const value = registry();
      // Keep the default neutral so default-app validation cannot mask an accepted ID.
      value.platform.defaultApp = 'home';
      const record = target === 'group' ? value.groups[0] : value.groups[0].apps[0];
      if (invalid === undefined) delete record.id;
      else record.id = invalid;
      assert.throws(() => validateConfig(value), undefined, `${target}: ${String(invalid)}`);
    }
  }
});

test('the all group identifier is reserved for the complete application list', () => {
  const value = registry();
  value.groups[0].id = 'all';
  assert.throws(() => validateConfig(value));
});
