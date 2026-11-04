"""Loopback exact signed outbox recovery with genuine ranked-session witnesses."""
import json
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
from ranked_browser_fixture import complete_ranked

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8788'
vectors = json.loads((ROOT / 'tests/fixtures/receipt.json').read_text())

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for outcome in ['offline', 'ambiguous']:
        requests.post(BASE + '/__fixture/reset', timeout=30).raise_for_status()
        context = browser.new_context(locale='en-US')
        page = context.new_page()
        page.set_default_timeout(30000)
        errors, posts = [], []
        phase = {'value': 'initial'}
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**', lambda route: route.abort())

        def status(route):
            if phase['value'] == 'withdraw':
                page.evaluate('setPublicScoreConsent(false)')
            route.fulfill(status=404 if phase['value'] == 'initial' else 200,
                          json={'status': 'broadcast_unknown'})

        def post(route):
            item = {'bytes': route.request.post_data,
                    'id': route.request.headers['idempotency-key'],
                    'witness': {key: value for key, value in route.request.headers.items()
                                if key.startswith('x-hd-')}}
            posts.append(item)
            if json.loads(item['bytes'])['l'] == 'wings':
                if outcome == 'ambiguous':
                    response = route.fetch(timeout=30000)
                    assert response.status == 202, (response.status, response.text())
                    if phase['value'] == 'initial':
                        route.abort()  # SQL persisted exact bytes; browser lost acknowledgement.
                    else:
                        route.fulfill(response=response)
                else:
                    route.abort()
            else:
                response = route.fetch(timeout=30000)
                assert response.status == 202, (response.status, response.text())
                route.fulfill(response=response)

        page.route('**/api/submissions/*', status)
        page.route('**/api/score', post)
        page.goto(BASE + '/', wait_until='domcontentloaded')
        page.wait_for_function('window.hd1UI && HUARONG_PUBLIC_ENABLED')
        page.locator('#btn-game-story-done').click()
        page.locator('#cookie-reject').click()
        original_path = complete_ranked(page, 'wings')
        page.locator('#player-name-input').fill('OutboxPlayer')
        page.locator('#btn-confirm-gate').click()
        assert page.evaluate("!localStorage.getItem('huarong_rod_identity_v1')")
        page.locator('#btn-submit-score').click()
        page.locator('#public-score-consent').check()
        page.locator('#btn-confirm-gate').click()
        page.wait_for_function("Object.keys(JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1') || '{}')).length === 1")
        # Signing starts asynchronously; an overlapping sync only queues work, it does not await it.
        page.wait_for_function("document.getElementById('hd1-submission-note').textContent.includes('The request may have been accepted')")
        assert len(posts) >= 1, posts
        original = posts[0]
        assert json.loads(original['bytes'])['m'] == original_path
        assert json.loads(original['bytes'])['p'] == 'hd2' and original['witness']['x-hd-session-proof']
        assert all(item == original for item in posts)
        durable = page.evaluate("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'))")
        assert durable[original['id']]['bytes'] == original['bytes']
        persisted = None
        if outcome == 'ambiguous':
            state = requests.get(BASE + '/__fixture/state', timeout=30).json()
            persisted = state['claims'][0]
            assert persisted['raw'] and persisted['state'] == 'broadcast_unknown'
            assert persisted['bytes'] == original['bytes']
        page.evaluate('''claim => {
            const saved=JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY));
            saved.evidence.newer={...claim,n:nickname,moves:claim.m.length,assisted:false};
            localStorage.setItem(SCORE_STORE_V2_KEY,JSON.stringify(saved));
        }''', vectors['longReceipt'])
        assert page.evaluate("hd1UI.candidate('wings').moves") == 1536
        identity = page.evaluate("localStorage.getItem('huarong_rod_identity_v1')")
        phase['value'] = 'retry'
        posts.clear()
        page.evaluate('hd1UI.sync()')
        assert posts == [original], ('exact bytes/ID/witness survive newer evidence', posts)
        assert page.evaluate("localStorage.getItem('huarong_rod_identity_v1')") == identity
        assert page.evaluate("hd1UI.candidate('wings').m.length") == 1536
        after = page.evaluate("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'))")
        assert after == durable, 'Witness-less newer evidence must stay local and not replace the signed outbox'
        # Real eligible evidence on another layout must not be starved by the overlimit row.
        page.keyboard.press('Escape')
        if page.locator('#victory-modal').is_visible():
            page.locator('#modal-btn-replay').click()
        page.evaluate('setPublicScoreConsent(false)')
        other_path = complete_ranked(page)
        page.wait_for_function("hd1UI.candidate('rear_guard')?.witness?.proof")
        posts.clear()
        page.evaluate('setPublicScoreConsent(true)')
        page.evaluate('hd1UI.sync()')
        page.wait_for_function("document.getElementById('hd1-submission-note').textContent.includes('awaiting') || document.getElementById('hd1-submission-note').textContent.includes('Awaiting') || document.getElementById('hd1-submission-note').textContent.includes('broadcast outcome')")
        page.wait_for_function("Object.keys(JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'))).length === 2")
        assert posts[0] == original and len(posts) == 2, posts
        assert json.loads(posts[1]['bytes'])['p'] == 'hd2'
        assert json.loads(posts[1]['bytes'])['m'] == other_path
        assert posts[1]['witness']['x-hd-session-id'] != original['witness']['x-hd-session-id']
        assert page.evaluate("hd1UI.candidate('wings').m.length") == 1536
        state = requests.get(BASE + '/__fixture/state', timeout=30).json()
        assert state['coordinator']['generation'] == 1
        if persisted:
            same = next(row for row in state['claims'] if row['id'] == original['id'])
            assert len(state['claims']) == 2
            assert same['raw'] == persisted['raw'] and same['txid'] == persisted['txid']
        # Historical witness-less bytes remain durable, but are not automatically retried.
        page.evaluate('''() => {const saved=JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'));
            saved.historical={id:'0'.repeat(64),player:nickname,bytes:'historical-exact-bytes'};
            localStorage.setItem('huarong_hd1_outbox_v1',JSON.stringify(saved));}''')
        posts.clear()
        page.evaluate('hd1UI.sync()')
        assert posts and all(item['bytes'] != 'historical-exact-bytes' for item in posts)
        assert page.evaluate("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1')).historical.bytes") == 'historical-exact-bytes'
        phase['value'] = 'withdraw'
        posts.clear()
        before = page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')")
        page.evaluate('hd1UI.sync()')
        page.evaluate('hd1UI.sync()')
        assert not posts, 'Withdrawal while awaiting status must block every POST'
        assert page.evaluate("localStorage.getItem('huarong_hd1_outbox_v1')") == before
        assert not errors, errors
        print('PASS browser outbox', outcome,
              'exact hd2 bytes/ID/witness retry; intact 1536-move evidence; other-layout real session; withdrawal blocks all retries; 0 page errors', flush=True)
        context.close()
    browser.close()
