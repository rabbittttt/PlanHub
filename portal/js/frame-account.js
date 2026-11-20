// Listen before deferred portal modules and retain the account across app navigation.
window.planHubFrameAccount = (() => {
  let identity = null;
  let parentOrigin = location.ancestorOrigins?.[0];
  if (!parentOrigin && document.referrer) parentOrigin = new URL(document.referrer).origin;
  function update(value) {
    identity = value;
    window.dispatchEvent(new Event('planhub-account-change'));
  }
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent ||
        !/^https?:\/\//.test(event.origin) || (parentOrigin && event.origin !== parentOrigin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'account')) return;
    const text = value => typeof value === 'string' ? value.trim() : '';
    const account = text(data.account);
    const roleCode = Number.isSafeInteger(data.roleCode) ? String(data.roleCode) : text(data.roleCode);
    const roleName = text(data.roleName);
    if (![account, roleCode, roleName].every(field => field && field.length <= 100 && !/[\x00-\x1f\x7f]/.test(field))) {
      if (identity) update(null);
      return;
    }
    parentOrigin = event.origin;
    update({account, roleCode, roleName});
  });
  return {
    useLocalPreview() {
      if (window.parent === window) update({account:'local-debug', roleCode:'debug', roleName:'本地调试'});
    },
    send(frame) {
      frame.postMessage(identity || {account:'', roleCode:'', roleName:''}, location.origin);
    }
  };
})();
