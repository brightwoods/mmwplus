/* =========================================================
 * [인증 플러그인] 사용자ID 생성 (카페 UI 3종: 신형/구형/모바일)
 * new Function('MW', <이 코드>) 로 실행됨.
 * MW = { Config, Logger, AudioCtrl, App, UI, httpRequest, Store, clamp, Env, version }
 * =======================================================*/

const { Logger, UI, Store } = MW;

const ALLOWED_GRADES = ['건빵', '팬가입', '봉빡이', '★ 클립전문가 ★', '★ VIP ★', '카페스탭', '카페매니저'];
const STORE_USERID = 'mw_pl_userid';
const STORE_MOBILE_AUTHING = 'mw_pl_mobile_authing';
const POLL_INTERVAL = 500;

async function sha256Hex(str) {
    try { if (typeof CryptoJS !== 'undefined' && CryptoJS.SHA256) return CryptoJS.SHA256(str).toString(CryptoJS.enc.Hex); } catch (e) {}
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const host = location.hostname;
const path = location.pathname;
const isCafe = /cafe\.naver\.com/.test(host);
const isMobile = /^m\.cafe\.naver\.com$/.test(host);
const isMobileProfilePage = isMobile && /\/ca-fe\/web\/cafes\//.test(path);
const isNewUI = !isMobile && /\/f-e\//.test(path);

Logger.group('인증 플러그인');
Logger.log('URL =', location.href);
Logger.log('카페 =', isCafe, '/ 모바일 =', isMobile, '/ 모바일프로필 =', isMobileProfilePage, '/ 신형UI =', isNewUI);
Logger.groupEnd();

if (!isCafe) {
    UI.setAuthNeeded(true);
    UI.setStatus('인증 필요 — 배지를 눌러 카페 인증');
    Logger.log('안내 모드 (뮤직웨이브)');
} else {
    async function pollUntil(probe, { onTick = null, label = '', logEvery = 20 } = {}) {
        let i = 0;
        while (true) {
            let result = null;
            try { result = probe(); } catch (e) {}
            if (result) return result;
            if (onTick) { try { onTick(i); } catch (e) {} }
            if (label && i > 0 && i % logEvery === 0)
                Logger.log(`...${label} 대기 중 (${Math.round((i * POLL_INTERVAL) / 1000)}초 경과)`);
            i++;
            await wait(POLL_INTERVAL);
        }
    }

    async function clearMobileFlag() {
        try { await Store.set(STORE_MOBILE_AUTHING, null); Logger.log('[모바일] 진행 플래그 제거'); } catch (e) {}
    }

    async function finalizeAuth(profile) {
        if (!ALLOWED_GRADES.includes(profile.grade)) {
            Logger.warn('등급 미허용 =', profile.grade);
            await clearMobileFlag();
            try { alert(`인증 실패: 등급("${profile.grade || '확인 불가'}")은 사용 대상이 아닙니다.`); } catch (e) {}
            return false;
        }
        const userId = await sha256Hex(profile.nickname);
        Logger.log('✔ userId 생성 =', userId.slice(0, 16) + '...');
        if (typeof window.__mwSetUserId === 'function') await window.__mwSetUserId(userId);
        else await Store.set(STORE_USERID, userId);
        const check = await Store.get(STORE_USERID, null);
        Logger.log('저장 검증: userId =', check ? check.slice(0, 16) + '...' : '(실패!)');
        if (!check) {
            Logger.err('⚠ 저장 실패! GM_setValue @grant 확인 필요.');
            await clearMobileFlag();
            try { alert('인증 저장에 실패했습니다. 스크립트 권한(@grant)을 확인하세요.'); } catch (e) {}
            return false;
        }
        await clearMobileFlag();
        try { history.replaceState(null, '', location.pathname + location.search); Logger.log('#mwauth 해시 제거'); }
        catch (e) { Logger.warn('해시 제거 실패', e); }
        try { alert('인증 완료! 이 창은 자동으로 닫힙니다. 뮤직웨이브 탭을 새로고침하세요.'); } catch (e) {}
        setTimeout(() => {
            try { window.close(); } catch (e) {}
            setTimeout(() => {
                if (!window.closed) { try { document.title = '✅ 인증완료 - 이 탭을 닫아주세요'; } catch (e) {} }
            }, 600);
        }, 800);
        return true;
    }

    function readGradeFromMemberGrade(gradeBox) {
        if (!gradeBox) return '';
        let grade = '';
        for (const s of gradeBox.querySelectorAll('span')) {
            if (s.classList.contains('blind')) continue;
            const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) { grade = t; break; }
        }
        if (!grade) grade = (gradeBox.textContent || '').replace(/\s+/g, ' ').replace(/^등급\s*/, '').trim();
        return grade;
    }

    /* ---- 데스크톱 ---- */
    function findMyActivityButton() {
        for (const b of document.querySelectorAll('button, a')) {
            if ((b.textContent || '').replace(/\s/g, '').includes('나의활동')) return b;
        }
        return null;
    }
    function extractProfile_new() {
        const panel = document.querySelector('#tab_my[role="tabpanel"]') || document.querySelector('#tab_my');
        if (!panel) return null;
        const nickEl = panel.querySelector('strong[class*="Sidebar_nickname"]') || panel.querySelector('strong');
        const nickname = nickEl ? nickEl.textContent.trim() : '';
        let grade = '';
        panel.querySelectorAll('span.blind').forEach(s => {
            const t = (s.textContent || '').trim();
            if (!grade && t.includes('멤버등급')) grade = t.replace(/^멤버등급\s*:\s*/, '').trim();
        });
        return nickname ? { nickname, grade } : null;
    }
    function extractProfile_old() {
        const panel = document.querySelector('#ia-action-data');
        if (!panel) return null;
        let nickname = '';
        const nickEl = panel.querySelector('.prfl_info a') || panel.querySelector('.prfl_info');
        if (nickEl) nickname = nickEl.textContent.trim();
        let grade = '';
        const gradeLi = panel.querySelector('li.info.grade, li.grade');
        if (gradeLi) {
            grade = (gradeLi.getAttribute('title') || '').trim();
            if (!grade) { const ell = gradeLi.querySelector('.ellipsis'); if (ell) grade = ell.textContent.trim(); }
        }
        return nickname ? { nickname, grade } : null;
    }
    const extractProfile_desktop = () => isNewUI ? extractProfile_new() : extractProfile_old();

    async function runAuth_desktop() {
        Logger.group('runAuth(desktop)');
        const btn = await pollUntil(findMyActivityButton, { label: '"나의 활동" 버튼' });
        Logger.log('"나의 활동" 클릭'); btn.click();
        const profile = await pollUntil(() => extractProfile_desktop(), {
            label: '프로필 패널',
            onTick: (i) => { if (i > 0 && i % 4 === 0) { const b = findMyActivityButton(); if (b) { Logger.log('재클릭'); b.click(); } } },
        });
        Logger.log('✔ 닉네임 =', profile.nickname, '/ 등급 =', profile.grade || '(빈값)');
        await finalizeAuth(profile);
        Logger.groupEnd();
    }

    /* ---- 모바일 ---- */
    function findDrawerButton() {
        let b = document.querySelector('button[data-nlog-area="header.open_cafe_drawer"]') || document.querySelector('button.btn_gnb_drawer');
        if (b) return b;
        for (const btn of document.querySelectorAll('button')) {
            const blind = btn.querySelector('.blind');
            if (blind && (blind.textContent || '').trim() === '메뉴') return btn;
        }
        return null;
    }
    function findMyProfileLink() {
        let a = document.querySelector('a[data-nlog-area="menu_drawer_layer.goto_my_profile"]');
        if (a) return a;
        const links = document.querySelectorAll('a.info_link');
        for (const link of links) if (link.offsetParent !== null) return link;
        return links[0] || null;
    }
    function extractProfile_mobile() {
        const infoArea = document.querySelector('.info_area');
        if (!infoArea) return null;
        let nickname = '';
        const nickEl = infoArea.querySelector('dd.nickname');
        if (nickEl) nickname = (nickEl.textContent || '').replace(/\s+/g, ' ').trim();
        const grade = readGradeFromMemberGrade(infoArea.querySelector('.member_grade'));
        return (nickname && grade) ? { nickname, grade } : null;
    }
    async function runAuth_mobile_navigate() {
        Logger.group('runAuth(mobile:navigate)');
        await Store.set(STORE_MOBILE_AUTHING, '1');
        Logger.log('[모바일] 진행 플래그 저장');
        const drawerBtn = await pollUntil(findDrawerButton, { label: '[모바일] 드로어 버튼' });
        Logger.log('[모바일] 드로어 클릭'); drawerBtn.click();
        const profileLink = await pollUntil(findMyProfileLink, {
            label: '[모바일] 프로필 링크',
            onTick: (i) => { if (i > 0 && i % 6 === 0) { const d = findDrawerButton(); if (d) { Logger.log('드로어 재클릭'); d.click(); } } },
        });
        Logger.log('[모바일] 프로필 링크 클릭 → 페이지 이동');
        profileLink.click();
        Logger.groupEnd();
    }
    async function runAuth_mobile_extract() {
        Logger.group('runAuth(mobile:extract)');
        const profile = await pollUntil(extractProfile_mobile, { label: '[모바일] 프로필(.info_area)' });
        Logger.log('✔ [모바일] 닉네임 =', profile.nickname, '/ 등급 =', profile.grade || '(빈값)');
        await finalizeAuth(profile);
        Logger.groupEnd();
    }

    async function runAuth() {
        if (isMobile) {
            if (isMobileProfilePage) return runAuth_mobile_extract();
            const inProgress = (await Store.get(STORE_MOBILE_AUTHING, null)) === '1';
            if (inProgress) { Logger.warn('[모바일] 잔여 플래그 초기화'); await clearMobileFlag(); }
            return runAuth_mobile_navigate();
        }
        return runAuth_desktop();
    }

    const start = () => runAuth().catch(e => Logger.err('runAuth 예외', e));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}
