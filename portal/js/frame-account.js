// Listen before deferred portal modules and retain the account across app navigation.
window.planHubFrameAccount = (() => {
  let identity = null;
  let configured = false;
  let extraOrigin = null;
  let pending = null;
  function update(value) {
    identity = value;
    window.dispatchEvent(new Event('planhub-account-change'));
  }
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent ||
        !/^https?:\/\//.test(event.origin) ||
        (configured && event.origin !== location.origin && event.origin !== extraOrigin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'account')) return;
    const text = value => typeof value === 'string' ? value.trim() : '';
    const account = text(data.account);
    const roleCode = Number.isSafeInteger(data.roleCode) ? String(data.roleCode) : text(data.roleCode);
    const roleName = text(data.roleName);
    const valid = [account, roleCode, roleName].every(field => field && field.length <= 100 && !/[\x00-\x1f\x7f]/.test(field));
    const value = valid ? {account, roleCode, roleName} : null;
    if (!configured) pending = {origin:event.origin, value};
    else update(value);
  });
  return {
    configure(origin) {
      if (configured) return;
      configured = true;
      extraOrigin = origin;
      if (!extraOrigin && window.parent !== window) {
        const parentUrl = location.ancestorOrigins?.[0] || document.referrer;
        if (parentUrl) {
          try { extraOrigin = new URL(parentUrl).origin; } catch { /* No usable parent origin. */ }
        }
      }
      if (pending && (pending.origin === location.origin || pending.origin === extraOrigin)) update(pending.value);
      pending = null;
    },
    useLocalPreview() {
      if (window.parent === window) update({account:'local-debug', roleCode:'debug', roleName:'本地调试'});
    },
    send(frame) {
      frame.postMessage(identity || {account:'', roleCode:'', roleName:''}, location.origin);
    }
  };
})();
