"""Browser regression: run with python -B -m unittest discover -s tests -p test_app_navigation.py.

Requires Playwright and local Edge. All business pages are disposable HTTP fixtures.
"""
import json
import threading
import unittest
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sync_playwright, 'Playwright is required for browser regression')
class AppNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='msedge', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.counts = Counter()
        self.status = {}
        self.delays = {}
        owner = self
        config = {'platform': {'name': 'Fixture portal', 'defaultApp': 'home', 'loadTimeoutMs': 1000},
                  'groups': [{'id': 'test', 'name': 'Fixture apps', 'apps': [
                      {'id': name, 'name': name, 'url': f'/{name}/', 'enabled': True,
                       'status': 'pending' if name == 'pending' else 'ready'}
                      for name in ('alpha', 'beta', 'pending')]}]}

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(ROOT / 'portal'), **kwargs)

            def log_message(self, *_):
                pass

            def do_HEAD(self):
                self.respond(head=True)

            def do_GET(self):
                self.respond(head=False)

            def respond(self, head=False):
                path = urlsplit(self.path).path
                method = 'HEAD' if head else 'GET'
                owner.counts[method, path] += 1
                gate = owner.delays.get((method, path))
                if gate:
                    gate.wait(3)
                if path == '/config/apps.json':
                    body = json.dumps(config).encode()
                    kind = 'application/json'
                elif path.startswith(('/alpha/', '/beta/', '/pending/', '/escaped/')):
                    body = (f'<!doctype html><title>{path}</title><input aria-label="draft">'
                            '<a href="details/">Details</a><a href="/escaped/">Leave</a>'
                            '<script>window.instance=crypto.randomUUID()</script>').encode()
                    kind = 'text/html'
                else:
                    return super().do_HEAD() if head else super().do_GET()
                self.send_response(owner.status.get(path, 200))
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if not head:
                    try:
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.page = self.browser.new_page(viewport={'width': 1440, 'height': 960})
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(self.origin + '/#/home')
        self.page.wait_for_selector('#app-nav a')

    def tearDown(self):
        for gate in self.delays.values():
            gate.set()
        self.page.close()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=5)
        self.assertEqual(self.errors, [])

    def navigate(self, app, ready=True):
        self.page.evaluate('(id)=>location.hash=id==="home"?"/home":"/app/"+id', app)
        if ready and app != 'home':
            self.page.wait_for_function('''id => document.querySelector('#app-frame')?.dataset.app === id
                && document.querySelector('#frame-overlay').hidden''', arg=app, polling='raf')
        elif app == 'home':
            self.page.wait_for_selector('#home-view', state='visible')

    def frame(self):
        return self.page.locator('#app-frame').element_handle().content_frame()

    def test_all_apps_preserve_documents_drafts_and_history_without_new_requests(self):
        instances = {}
        for app in ('alpha', 'beta'):
            self.navigate(app)
            self.frame().get_by_role('textbox').fill(app + ' draft')
            instances[app] = self.frame().evaluate('window.instance')
        self.navigate('home')
        for app in ('alpha', 'beta', 'alpha'):
            self.navigate(app)
            self.assertEqual(self.frame().evaluate('window.instance'), instances[app])
            self.assertEqual(self.frame().get_by_role('textbox').input_value(), app + ' draft')
            self.assertEqual(self.counts['HEAD', f'/{app}/'], 1)
            self.assertEqual(self.counts['GET', f'/{app}/'], 1)
            self.assertEqual(self.page.locator('iframe:visible').count(), 1)
        self.page.go_back()
        self.page.wait_for_function("() => document.querySelector('#app-frame')?.dataset.app==='beta'")
        self.assertEqual(self.frame().evaluate('window.instance'), instances['beta'])
        self.page.reload()
        self.page.wait_for_selector('#frame-overlay', state='hidden')
        self.assertNotEqual(self.frame().evaluate('window.instance'), instances['beta'])
        self.assertEqual(self.page.locator('iframe').count(), 1)

    def test_failure_retry_and_pending_do_not_reuse_failed_documents(self):
        self.status['/alpha/'] = 503
        self.navigate('alpha', ready=False)
        self.page.wait_for_selector('#retry-app', state='visible')
        self.assertEqual(self.page.locator('iframe').count(), 0)
        self.status['/alpha/'] = 200
        self.page.locator('#retry-app').click()
        self.page.wait_for_selector('#frame-overlay', state='hidden')
        self.assertEqual(self.counts['HEAD', '/alpha/'], 2)
        self.navigate('pending', ready=False)
        self.page.wait_for_function("() => document.querySelector('#frame-message').textContent==='应用尚未接入'")
        self.assertEqual(self.counts['GET', '/pending/'], 0)
        self.assertEqual(self.page.locator('iframe:visible').count(), 0)

    def test_cancelled_probe_cannot_replace_the_current_app(self):
        gate = self.delays['HEAD', '/alpha/'] = threading.Event()
        self.navigate('alpha', ready=False)
        self.page.wait_for_function("() => document.querySelector('#frame-message').textContent==='正在打开alpha'")
        self.navigate('beta')
        gate.set()
        self.page.wait_for_timeout(200)
        self.assertEqual(self.page.locator('#app-frame').get_attribute('data-app'), 'beta')
        self.assertEqual(self.counts['GET', '/alpha/'], 0)
        self.navigate('alpha')
        self.assertEqual(self.counts['GET', '/alpha/'], 1)

    def test_mobile_navigation_keeps_hidden_pages_out_of_focus_order(self):
        for width, height in ((375, 812), (812, 375)):
            self.page.set_viewport_size({'width': width, 'height': height})
            self.navigate('alpha')
            self.navigate('beta')
            self.assertEqual(self.page.locator('iframe:visible').count(), 1)
            self.assertEqual(self.page.locator('iframe[hidden]').count(), 1)
            self.page.locator('#nav-toggle').click()
            self.assertEqual(self.page.locator('#nav-toggle').get_attribute('aria-expanded'), 'true')
            self.page.get_by_role('link', name='alpha', exact=True).focus()
            self.page.keyboard.press('Enter')
            self.page.wait_for_function("() => document.querySelector('#app-frame')?.dataset.app==='alpha'")
            self.assertEqual(self.page.locator('iframe:visible').count(), 1)
            self.page.locator('#nav-toggle').click()
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)

    def test_document_timeout_is_removed_and_retry_starts_fresh(self):
        gate = self.delays['GET', '/alpha/'] = threading.Event()
        self.navigate('alpha', ready=False)
        self.page.wait_for_function("() => document.querySelector('#frame-message').textContent==='应用加载超时'")
        self.assertEqual(self.page.locator('iframe').count(), 0)
        gate.set()
        self.page.locator('#retry-app').click()
        self.page.wait_for_selector('#frame-overlay', state='hidden')
        self.assertEqual(self.counts['HEAD', '/alpha/'], 2)
        self.assertEqual(self.page.locator('iframe').count(), 1)

    def test_hidden_navigation_outside_app_is_discarded_without_covering_active_app(self):
        self.navigate('alpha')
        old = self.frame()
        old.get_by_role('link', name='Details').click()
        old.wait_for_url('**/alpha/details/')
        instance = old.evaluate('window.instance')
        self.navigate('beta')
        self.navigate('alpha')
        self.assertEqual(self.frame().evaluate('window.instance'), instance)
        self.navigate('beta')
        old.evaluate('() => { location.href="/escaped/"; }')
        self.page.wait_for_function("() => document.querySelectorAll('iframe').length===1")
        self.assertTrue(self.page.locator('#frame-overlay').is_hidden())
        self.navigate('alpha')
        self.assertEqual(self.counts['GET', '/alpha/'], 2)


if __name__ == '__main__':
    unittest.main()
