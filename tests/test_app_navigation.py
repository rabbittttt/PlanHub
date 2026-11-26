"""Browser regression: run with python -B -m unittest discover -s tests -p test_app_navigation.py.

Requires Playwright and local Edge. All business pages are disposable HTTP fixtures.
"""
import json
import io
import os
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
        self.json_responses = {}
        owner = self
        self.config = {'platform': {'name': 'Fixture portal', 'defaultApp': 'home', 'loadTimeoutMs': 1000},
                  'groups': [{'id': 'test', 'name': 'Fixture apps', 'apps': [
                      {'id': name, 'name': name, 'url': f'/{name}/', 'enabled': True,
                       'description': f'Introduction for {name}',
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
                    body = json.dumps(owner.config).encode()
                    kind = 'application/json'
                elif path in owner.json_responses:
                    body = json.dumps(owner.json_responses[path]).encode()
                    kind = 'application/json'
                elif path.startswith(('/alpha/', '/beta/', '/pending/', '/escaped/', '/sop/', '/vehicle-config/')):
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

    def test_home_lists_enabled_apps_and_opens_ready_apps_from_the_keyboard(self):
        apps = self.config['groups'][0]['apps']
        apps.extend([
            dict(apps[0], id='paused', name='Paused', status='maintenance', url='/paused/'),
            dict(apps[0], id='hidden', name='Hidden', enabled=False, url='/hidden/'),
        ])
        self.page.reload()
        home = self.page.locator('#home-view')
        home.wait_for(state='visible')
        self.assertEqual(home.locator('h1').inner_text(), self.config['platform']['name'])
        directory = home.locator('#home-apps')
        cards = directory.get_by_role('listitem')
        self.assertEqual(cards.count(), 4)
        for app in apps:
            if app['enabled']:
                card = cards.filter(has=self.page.get_by_role('heading', name=app['name'], exact=True))
                self.assertIn(app['description'], card.inner_text())
                if app['status'] != 'ready':
                    self.assertEqual(card.get_by_role('link').count(), 0)
                    self.assertIn({'pending': '待接入', 'maintenance': '维护中'}[app['status']], card.inner_text())
        self.assertEqual(home.get_by_role('heading', name='Hidden', exact=True).count(), 0)
        links = directory.get_by_role('link')
        self.assertEqual([item.get_attribute('href') for item in links.all()], ['#/app/alpha', '#/app/beta'])
        self.assertNotRegex(home.inner_text(), r'(?i)demo|演示')
        for stage in home.locator('#workflow-stages').get_by_role('button').all():
            stage.click()
            self.assertEqual(home.locator('#workflow-tasks').get_by_role('link').count(), 0)
        links.first.focus()
        self.page.keyboard.press('Enter')
        self.page.wait_for_url('**/#/app/alpha')
        self.page.wait_for_selector('#frame-overlay', state='hidden')
        self.assertEqual(self.page.locator('iframe:visible').get_attribute('data-app'), 'alpha')

    def test_workflow_stages_show_distinct_tasks_and_registered_app_links(self):
        apps = [
            {'id': app_id, 'name': app_id, 'url': f'/{app_id}/', 'enabled': True, 'status': 'ready'}
            for app_id in ('sop', 'orderiq', 'forecast', 'quicklook', 'leads', 'vehicle-config')
        ]
        self.config['groups'][0]['apps'] = apps
        self.page.reload()
        self.page.locator('#home-view').wait_for(state='visible')
        stages = self.page.locator('#workflow-stages').get_by_role('button')
        tasks = self.page.locator('#workflow-tasks')
        self.assertEqual(stages.count(), 4)
        self.assertEqual(stages.locator('.stage-number').all_inner_texts(), ['01', '02', '03', '04'])
        self.assertEqual(stages.locator('svg, img, [data-icon]').count(), 0)
        allowed = {f"#/app/{app['id']}" for app in apps}
        task_card = self.page.get_by_role('region', name='办事清单')
        record_card = self.page.locator('#records-panel')
        calendar = self.page.locator('#workbench-calendar')
        seen_tasks = set()
        for stage in stages.all():
            stage.click()
            task_text = tasks.inner_text().strip()
            self.assertTrue(task_text)
            self.assertNotIn(task_text, seen_tasks)
            seen_tasks.add(task_text)
            left_bottom = record_card.evaluate('el => el.getBoundingClientRect().bottom')
            right = calendar.bounding_box()
            self.assertAlmostEqual(task_card.bounding_box()['y'], right['y'], delta=1)
            self.assertAlmostEqual(left_bottom, right['y'] + right['height'], delta=1)
            self.assertEqual(tasks.get_by_role('checkbox').count(), 0)
            links = tasks.get_by_role('link')
            self.assertGreater(links.count(), 0)
            for link in links.all():
                self.assertIn(link.get_attribute('href'), allowed)
        self.assertEqual(self.page.get_by_role('heading', name='月份参考').count(), 0)
        self.page.set_viewport_size({'width': 390, 'height': 844})
        record_bounds = record_card.bounding_box()
        self.assertLess(task_card.evaluate('el => el.getBoundingClientRect().bottom'), record_bounds['y'])
        self.assertLess(record_bounds['y'] + record_bounds['height'], calendar.bounding_box()['y'])
        records = self.page.locator('#plan-records')
        self.assertEqual(records.get_by_role('link').first.get_attribute('href'), '#/app/sop')
        next(app for app in apps if app['id'] == 'sop')['status'] = 'maintenance'
        self.page.reload()
        self.page.locator('#home-view').wait_for(state='visible')
        self.assertEqual(records.get_by_role('link').count(), 0)
        for stage in stages.all():
            stage.click()
            self.assertEqual(tasks.locator('a[href="#/app/sop"]').count(), 0)

    def open_calendar(self, entries, subjects, *, catalog_status=200):
        self.config['groups'][0]['apps'].append({
            'id': 'orderiq', 'name': '订单分析', 'url': '/alternate-order/',
            'enabled': True, 'status': 'ready',
        })
        self.json_responses['/alternate-order/api/annotations'] = {'entries': entries}
        self.json_responses['/alternate-order/api/catalog'] = {'subjects': subjects}
        self.status['/alternate-order/api/catalog'] = catalog_status
        self.page.context.new_cdp_session(self.page).send('Emulation.setTimezoneOverride', {'timezoneId': 'America/Los_Angeles'})
        self.page.clock.set_fixed_time('2026-12-31T17:30:00Z')
        self.page.reload()
        calendar = self.page.locator('#workbench-calendar')
        calendar.wait_for(state='visible')
        return calendar

    def test_calendar_places_order_notes_on_dates_and_tracks_iso_weeks_across_new_year(self):
        model_note = {'date': '2027-01-08', 'text': '样例车型上市'}
        entries = [
            {'id': 'jan-note', 'date': '2027-01-06', 'subject': 'brand', 'text': '一月锁单跟进'},
            {'id': 'dec-note', 'date': '2026-12-10', 'subject': 'brand', 'text': '十二月权益调整'},
        ]
        subjects = [
            {'id': 'brand', 'name': '样例品牌', 'stage_annotations': [model_note]},
            {'id': 'model', 'name': '样例车型', 'stage_annotations': [model_note]},
        ]
        calendar = self.open_calendar(entries, subjects)
        # Shanghai is already in January even though the browser clock still shows December.
        self.assertTrue(calendar.locator('[data-date="2027-01-20"]').is_visible())
        jan6 = calendar.locator('[data-date="2027-01-06"]')
        jan8 = calendar.locator('[data-date="2027-01-08"]')
        jan6.get_by_text('一月锁单跟进', exact=False).first.wait_for()
        self.assertNotIn('一月锁单跟进', calendar.locator('[data-date="2027-01-07"]').inner_text())
        self.assertIn('样例车型上市', jan8.inner_text())
        jan8.get_by_role('button').click()
        details = self.page.locator('#calendar-day-details')
        details.wait_for(state='visible')
        self.assertEqual(details.inner_text().count('样例车型上市'), 1)
        for day, week in (('2027-01-01', 'W53'), ('2027-01-04', 'W01')):
            row = calendar.locator('tr').filter(has=self.page.locator(f'[data-date="{day}"]'))
            self.assertEqual(row.locator('th[scope="row"]').inner_text(), week)
        calendar.get_by_role('button', name='上个月').click()
        self.assertIn('十二月权益调整', calendar.locator('[data-date="2026-12-10"]').inner_text())
        calendar.get_by_role('button', name='下个月').click()
        self.assertTrue(jan6.is_visible())
        self.assertEqual(self.counts['GET', '/orderiq/api/annotations'], 0)

    def test_calendar_date_opens_all_notes_on_a_narrow_screen(self):
        self.page.set_viewport_size({'width': 390, 'height': 844})
        messages = ['样例备注甲', '样例备注乙', '样例备注丙', '样例备注丁']
        entries = [
            {'id': str(index), 'date': '2027-01-08', 'subject': 'brand', 'text': message}
            for index, message in enumerate(messages)
        ]
        entries.append({'id': 'other-day', 'date': '2027-01-09', 'subject': 'brand', 'text': '另一天的事'})
        calendar = self.open_calendar(entries, [{'id': 'brand', 'name': '样例品牌', 'stage_annotations': []}])
        calendar.locator('[data-date="2027-01-08"]').get_by_role('button').click()
        details = self.page.locator('#calendar-day-details')
        details.wait_for(state='visible')
        for message in messages:
            self.assertIn(message, details.inner_text())
        self.assertNotIn('另一天的事', details.inner_text())
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
        calendar.locator('[data-date="2027-01-09"]').get_by_role('button').click()
        self.assertIn('另一天的事', details.inner_text())
        self.assertNotIn('样例备注甲', details.inner_text())

    def test_calendar_shows_custom_notes_even_when_order_catalog_is_unavailable(self):
        calendar = self.open_calendar([
            {'id': 'saved', 'date': '2027-01-06', 'subject': 'brand', 'text': '保留的日标注'}
        ], [], catalog_status=503)
        cell = calendar.locator('[data-date="2027-01-06"]')
        cell.get_by_text('保留的日标注', exact=False).first.wait_for()
        self.assertTrue(calendar.get_by_role('button', name='下个月').is_enabled())

    def test_business_account_reaches_sop_and_vehicle_config_on_load_switch_and_signout(self):
        apps = self.config['groups'][0]['apps']
        for name in ('sop', 'vehicle-config'):
            apps.append(dict(apps[0], id=name, name=name, url=f'/{name}/'))
        self.page.add_init_script("""window.addEventListener('message', event => {
            if (event.source === parent && event.origin === location.origin)
                window.lastAccount = event.data.account;
        });""")
        self.page.goto(self.origin + '/alpha/')
        self.page.evaluate("""() => {
            const portal = document.createElement('iframe');
            portal.id = 'workbench';
            portal.src = '/#/app/sop';
            document.body.append(portal);
        }""")
        workbench = self.page.locator('#workbench').element_handle().content_frame()
        send = """account => document.querySelector('#workbench').contentWindow.postMessage(
            {account, roleCode:1, roleName:'计划员'}, location.origin)"""
        workbench.wait_for_selector('#app-nav a')
        self.page.evaluate(send, 'account-a')
        sop = workbench.locator('#app-frame[data-app="sop"]').element_handle().content_frame()
        sop.wait_for_function("window.lastAccount === 'account-a'")

        workbench.evaluate("location.hash='/app/vehicle-config'")
        config = workbench.locator('#app-frame[data-app="vehicle-config"]').element_handle().content_frame()
        config.wait_for_function("window.lastAccount === 'account-a'")
        workbench.evaluate("location.hash='/app/beta'")
        other = workbench.locator('#app-frame[data-app="beta"]').element_handle().content_frame()
        for account in ('account-b', ''):
            self.page.evaluate(send, account)
            for target in (sop, config):
                target.wait_for_function("account => window.lastAccount === account", arg=account)
            self.assertIsNone(other.evaluate('window.lastAccount'))

    def test_all_apps_preserve_documents_drafts_and_history_without_new_requests(self):
        instances = {}
        for app in ('alpha', 'beta'):
            self.navigate(app)
            # Business pages recognize their workbench host on the very first load.
            self.assertTrue(self.frame().evaluate(
                """app => window.frameElement.matches(`#frame-container > iframe[data-app="${app}"]`)""", app))
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

    def test_embedded_page_meets_sidebar_and_viewport_edges(self):
        self.navigate('alpha')
        self.page.emulate_media(reduced_motion='reduce')
        for width in (1440, 390):
            self.page.set_viewport_size({'width': width, 'height': 900})
            for expanded in (False, True):
                with self.subTest(width=width, expanded=expanded):
                    toggle = self.page.locator('#nav-toggle')
                    if toggle.get_attribute('aria-expanded') != str(expanded).lower():
                        toggle.click()
                    box = self.page.locator('#app-frame').bounding_box()
                    rail = self.page.locator('.sidebar').bounding_box()
                    self.assertAlmostEqual(box['x'], rail['x'] + rail['width'], delta=1)
                    self.assertAlmostEqual(box['y'], 0, delta=1)
                    self.assertAlmostEqual(box['x'] + box['width'], width, delta=1)
                    self.assertAlmostEqual(box['y'] + box['height'], 900, delta=1)
                    for selector in ('.frame-container', '#app-frame'):
                        radius = self.page.locator(selector).evaluate('(el) => getComputedStyle(el).borderTopLeftRadius')
                        self.assertEqual(radius, '0px')

    def test_sidebar_visual_baselines(self):
        from PIL import Image, ImageChops
        self.navigate('alpha')
        self.page.emulate_media(reduced_motion='reduce')
        folder = ROOT / 'tests' / 'visual-baselines'
        update = os.environ.get('PLANHUB_UPDATE_VISUAL_BASELINES') == '1'
        for width in (1440, 390):
            self.page.set_viewport_size({'width': width, 'height': 900})
            for expanded in (False, True):
                with self.subTest(width=width, expanded=expanded):
                    toggle = self.page.locator('#nav-toggle')
                    if toggle.get_attribute('aria-expanded') != str(expanded).lower():
                        toggle.click()
                    expected = folder / f'sidebar-{width}-{"open" if expanded else "closed"}.png'
                    # Only synthetic navigation goes into Git. App pixels belong to the child project.
                    self.page.mouse.move(width - 1, 850)
                    image = self.page.locator('.sidebar').screenshot(animations='disabled')
                    if update:
                        folder.mkdir(exist_ok=True)
                        expected.write_bytes(image)
                    with Image.open(expected) as baseline, Image.open(io.BytesIO(image)) as actual:
                        self.assertEqual(actual.size, baseline.size)
                        diff = ImageChops.difference(baseline.convert('RGB'), actual.convert('RGB'))
                        changed = sum(diff.convert('L').histogram()[25:])
                        self.assertLessEqual(changed, actual.width * actual.height * 0.005)

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
