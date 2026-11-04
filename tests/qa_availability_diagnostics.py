"""Offline browser check of the real game, UI and translation observer; no server or publication."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for locale in ['en-US', 'bg-BG']:
        context = browser.new_context(locale=locale)
        page = context.new_page()
        errors, posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        state = {'available': False, 'code': 'issuance_disabled', 'rows': [], 'pending': [],
                 'publisher': {'available': False, 'code': 'issuer_not_configured'}}

        def route(request_route):
            request = request_route.request
            if request.method != 'GET':
                posts.append(request.url)
                request_route.abort()
            elif '/api/leaderboard' in request.url:
                request_route.fulfill(status=200, content_type='application/json', body=json.dumps(state))
            elif request.url == 'http://availability.test/':
                request_route.fulfill(status=200, content_type='text/html', path=str(ROOT / 'public/index.html'))
            elif request.url == 'http://availability.test/leaderboard-ui.js':
                request_route.fulfill(status=200, content_type='text/javascript', path=str(ROOT / 'public/leaderboard-ui.js'))
            else:
                request_route.abort()

        page.route('**/*', route)
        page.goto('http://availability.test/', wait_until='domcontentloaded')
        page.wait_for_function('window.hd1UI !== undefined')
        expected = 'New submissions temporarily unavailable' if locale == 'en-US' else 'Новите изпращания временно не са достъпни'
        page.wait_for_function('(text) => document.getElementById("hd1-status").textContent.includes(text)', arg=expected)
        assert 'issuer_not_configured' in page.locator('#hd1-status').text_content()
        for code in ['initial_sync', 'schema_upgrade_required', 'publisher_stale', 'provider_timeout', 'provider_unavailable', 'publisher_unavailable', 'recovery_required']:
            state['publisher']['code'] = code
            page.evaluate('hd1UI.refresh()')
            page.wait_for_function('(text) => document.getElementById("hd1-status").textContent.includes(text)', arg=expected)
            assert code in page.locator('#hd1-status').text_content()
            assert page.evaluate('HUARONG_PUBLIC_ENABLED') is False
        state['publisher']['code'] = 'issuance_disabled'
        page.evaluate('hd1UI.refresh()')
        disabled = 'New submissions are off' if locale == 'en-US' else 'Новите изпращания са изключени'
        page.wait_for_function('(text) => document.getElementById("hd1-status").textContent.includes(text)', arg=disabled)
        assert not posts and not errors, (posts, errors)
        assert page.evaluate("!localStorage.getItem('huarong_rod_identity_v1') && !localStorage.getItem('huarong_hd1_outbox_v1')")
        print('PASS', locale, 'real UI, translation observer, precise reason, disabled/unavailable distinction, no identity/outbox/POST', flush=True)
        context.close()
    browser.close()
