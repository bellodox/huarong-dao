"""Loopback-only admission UI/local evidence checks; programmatic moves are not human-input proof."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PATHS = json.loads((ROOT / 'tests/fixtures/paths.json').read_text())
BASE = 'http://127.0.0.1:8798'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for locale in ['bg-BG', 'en-US']:
        context = browser.new_context(locale=locale)
        page = context.new_page()
        errors, posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**', lambda route: route.abort())
        page.route('**/api/leaderboard?**', lambda route: route.fulfill(json={
            'available': True, 'stale': False, 'epoch': 10, 'rows': [], 'pending': []}))
        def session(route):
            posts.append(route.request.url)
            route.fulfill(status=503, json={'code': 'issuance_disabled'})
        page.route('**/api/session/**', session)
        page.route('**/api/score', lambda route: (_ for _ in ()).throw(AssertionError('No score POST permitted')))
        page.goto(BASE, wait_until='domcontentloaded')
        page.wait_for_function('window.hd1UI && HUARONG_PUBLIC_ENABLED && window.hdRanked')
        page.locator('#btn-game-story-done').click()
        if page.locator('#cookie-reject').is_visible():
            page.locator('#cookie-reject').click()
        for layout, count in [('wings', 220), ('fayaa_sideBySide', 221), ('wings', 448)]:
            path = next(row for row in PATHS if row['l'] == layout)
            result = page.evaluate('''({path,count}) => {
                selectLayout(GAME_LAYOUTS.findIndex(row=>row.id===path.l));
                const ids=['CC','ZY','ZF','MC','HZ','GY','S1','S2','S3','S4'];
                const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
                const directions=[{dx:0,dy:-1},{dx:1,dy:0},{dx:0,dy:1},{dx:-1,dy:0}];
                const grid=buildGrid(currentState);
                let pair;
                for(let i=0;i<ids.length&&!pair;i++)for(let d=0;d<4;d++){
                    const dir=directions[d];
                    if(canMovePiece(ids[i],currentState,dir.dx,dir.dy,grid)){
                        pair=alphabet[i*4+d]+alphabet[i*4+(d+2)%4];break;
                    }
                }
                const moves=pair.repeat((count-path.m.length)/2)+path.m;
                for(const symbol of moves){
                    const a=alphabet.indexOf(symbol),dir=directions[a%4];
                    if(!executeMove(ids[Math.floor(a/4)],dir.dx,dir.dy))throw Error('illegal fixture');
                }
                return {moves,actual:userMovesCount,assisted:assistedRun};
            }''', {'path': path, 'count': count})
            assert result['actual'] == count and not result['assisted']
            if page.locator('#player-gate').is_visible():
                page.locator('#player-name-input').fill('CeilingUser')
                page.locator('#btn-confirm-gate').click()
            saved = page.evaluate('JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY))')
            evidence = list(saved['evidence'].values())[-1]
            assert evidence['m'] == result['moves'] and evidence['moves'] == count
            assert not evidence.get('assisted') and saved['owner'] == 'CeilingUser'
            assert page.locator('#btn-submit-score').is_visible() == (count <= 220)
            if count > 220:
                page.wait_for_function("document.getElementById('victory-rank-status').textContent.includes('220')")
                text = page.locator('#victory-rank-status').inner_text()
                assert ('inclusive' in text if locale == 'en-US' else 'включително' in text), text
            assert page.evaluate("!localStorage.getItem('huarong_rod_identity_v1') && !localStorage.getItem('huarong_hd1_outbox_v1')")
            page.locator('#modal-btn-replay').click()
        assert not errors, errors
        print('PASS', locale, '220 submit offered; 221/448 local-only; full paths/owner retained; no identity/outbox/score POST; zero page errors', flush=True)
        context.close()
    browser.close()
