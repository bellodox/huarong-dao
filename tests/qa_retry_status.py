"""Local-only retry metadata regression against the actual public assets; no Worker or database."""
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'application/javascript'}

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'public')))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
checks = 0
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for locale in ['bg-BG', 'en-US']:
            context = browser.new_context(locale=locale, viewport={'width': 390, 'height': 844})
            page = context.new_page()
            errors, posts = [], []
            state = {'get': {'status': 'queued'}, 'post': {'status': 'queued'}}
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('https://**', lambda route: route.abort())
            page.route('**/api/leaderboard?*', lambda route: route.fulfill(json={'available': True, 'epoch': 0, 'rows': [], 'pending': []}))
            page.route('**/api/submissions/*', lambda route: route.fulfill(status=404) if state['get'] is None else route.fulfill(json=state['get']))

            def submit(route):
                posts.append(route.request.post_data)
                route.fulfill(json=state['post'])

            page.route('**/api/score', submit)
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='domcontentloaded')
            page.wait_for_function('window.hd1UI!==undefined && HUARONG_PUBLIC_ENABLED===true')
            page.locator('#btn-game-story-done').click()
            page.locator('#cookie-reject').click()
            page.evaluate("""() => {
                nickname='RetryPlayer'; nameLocked=true; publicNameReady=true; allowPublicScores=true;
                localStorage.setItem('huarong_hd1_outbox_v1', JSON.stringify({saved:{id:'saved',player:nickname,bytes:'exact-signed-evidence',
                  witness:{id:'fixture-session',proof:'fixture-proof',rodAnchor:{hash:'a'.repeat(64),height:123}}}}));
            }""")
            page.locator('#btn-leaderboard').click()
            page.wait_for_function("document.activeElement.id==='btn-close-leaderboard'")
            original = page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')")
            blocked = 'Publication retry unavailable' if locale == 'en-US' else 'Повторното публикуване не е достъпно'
            reasons = {
                'retry_exhausted': ('publication attempts exhausted', 'изчерпани опити за публикуване'),
                'broadcast_budget_exhausted': ('broadcast budget exhausted', 'изчерпан бюджет за излъчване'),
                'transaction_budget_exhausted': ('transaction budget exhausted', 'изчерпан бюджет за транзакции'),
                'spend_budget_exhausted': ('spend budget exhausted', 'изчерпан бюджет за разходи'),
                'claim_outside_scope': ('outside authorized scope', 'извън разрешения обхват'),
            }
            for reason, translations in reasons.items():
                for status in ['queued', 'broadcast_unknown', 'broadcast_pending']:
                    state['get'] = {'status': status, 'retryable': True, 'publication_retryable': False, 'retry_code': reason}
                    before = len(posts)
                    page.evaluate('hd1UI.sync()')
                    assert len(posts) == before, (locale, status, reason, 'blocked publication was reposted')
                    page.wait_for_function('(text) => document.getElementById("hd1-submission-note").textContent.includes(text)', arg=blocked)
                    assert translations[0 if locale == 'en-US' else 1] in page.locator('#hd1-submission-note').inner_text()
                    assert page.evaluate('document.activeElement.id') == 'btn-close-leaderboard'
                    checks += 1
            for metadata in [{}, {'retryable': True}, {'publication_retryable': True, 'retryable': True}]:
                state['get'] = {'status': 'queued', **metadata}
                state['post'] = {'status': 'queued'}
                before = len(posts)
                page.evaluate('hd1UI.sync()')
                assert len(posts) == before + 1 and posts[-1] == 'exact-signed-evidence'
                checks += 1
            # Non-publication recovery remains distinct even with additive false metadata.
            for status in ['not_improved', 'unsigned_preparing', 'signed_persisted']:
                state['get'] = {'status': status, 'publication_retryable': False, 'retry_code': None}
                before = len(posts)
                page.evaluate('hd1UI.sync()')
                assert len(posts) == before + 1 and posts[-1] == 'exact-signed-evidence'
                checks += 1
            for status in ['confirmed', 'included', 'signing_unknown', 'reorged']:
                state['get'] = {'status': status, 'publication_retryable': False, 'retry_code': None}
                before = len(posts)
                page.evaluate('hd1UI.sync()')
                assert len(posts) == before
                assert blocked not in page.locator('#hd1-submission-note').inner_text()
                checks += 1
            # The initial local outbox recovery is still allowed when no server claim exists.
            state['get'] = None
            state['post'] = {'status': 'broadcast_pending', 'publication_retryable': False, 'retry_code': 'broadcast_budget_exhausted'}
            before = len(posts)
            page.evaluate('hd1UI.sync()')
            page.wait_for_function('(text) => document.getElementById("hd1-submission-note").textContent.includes(text)', arg=blocked)
            assert len(posts) == before + 1
            checks += 1
            # Unknown backend reasons, including inherited property names, stay generic.
            for reason in ['<img src=x onerror=alert(1)>', 'constructor']:
                state['get'] = {'status': 'queued', 'publication_retryable': False, 'retry_code': reason}
                before = len(posts)
                page.evaluate('hd1UI.sync()')
                page.wait_for_function('(text) => document.getElementById("hd1-submission-note").textContent === text', arg=blocked)
                assert len(posts) == before
                checks += 1
            # Witness-less historical bytes stay durable but never auto-publish.
            page.evaluate("""() => {
                const saved=JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'));
                delete saved.saved.witness;
                localStorage.setItem('huarong_hd1_outbox_v1',JSON.stringify(saved));
            }""")
            historical = page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')")
            before = len(posts)
            page.evaluate('hd1UI.sync()')
            assert len(posts) == before
            assert page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')") == historical
            page.evaluate('(saved) => localStorage.setItem("huarong_hd1_outbox_v1",saved)', original)
            checks += 1
            page.evaluate('allowPublicScores=false')
            state['get'] = {'status': 'queued', 'publication_retryable': True}
            page.evaluate('hd1UI.sync()')
            assert len(posts) == before
            assert page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')") == original
            assert page.locator('#hd1-status').get_attribute('role') == 'status'
            assert page.locator('#hd1-status').get_attribute('aria-live') == 'polite'
            page.keyboard.press('Escape')
            assert page.evaluate('document.activeElement.id') == 'btn-leaderboard'
            assert not errors, errors
            checks += 1
            print('PASS', locale, '30 retry/consent scenarios, translated status, exact bytes retained, live region and focus', flush=True)
            context.close()
        browser.close()
    print('PASS', checks, 'scenarios', flush=True)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
