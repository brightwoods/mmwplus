// ==UserScript==
// @name         멜론 뮤직웨이브 플러스 (Core)
// @namespace    https://musicwave.melon.com/
// @version      2.8.2
// @description  볼륨/알람/백그라운드 + 통신복구 + 외부 플러그인 로더 (GM 저장소 공유, iOS 대응)
// @author       봉준 무수 하데스 팬카페 [미월신금]
// @match        https://musicwave.melon.com/musicwave.htm*
// @match        https://*.melon.com/*
// @match        https://cafe.naver.com/moomoo*
// @match        https://cafe.naver.com/f-e/cafes/31091221/*
// @match        https://m.cafe.naver.com/moomoo*
// @match        https://m.cafe.naver.com/ca-fe/web/cafes/31091221/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @connect      hades905.mooo.com
// @connect      gistcdn.githack.com
// @connect      cdn.jsdelivr.net
// @connect      cdnjs.cloudflare.com
// @connect      *
// @downloadURL  https://gistcdn.githack.com/brightwoods/8f89bcc1845a365da50f0c52d882efab/raw/melon_musicwave_helper.user.js
// @updateURL    https://gistcdn.githack.com/brightwoods/8f89bcc1845a365da50f0c52d882efab/raw/melon_musicwave_helper.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// ==/UserScript==

(function () {
    'use strict';

    const CORE_VERSION = '2.8.2';

    /* =========================================================
     * 환경(OS) 감지
     *   - iOS 판정: iPhone/iPad/iPod + iPadOS(데스크톱 UA로 위장한 iPad) 대응
     * =======================================================*/
    const Env = (function () {
        const ua = navigator.userAgent || '';
        const platform = navigator.platform || '';
        const maxTouch = navigator.maxTouchPoints || 0;
        // iPadOS 13+ 는 Mac UA 로 위장하므로 touch point 로 보정
        const isIPadOS = /Macintosh/.test(ua) && maxTouch > 1;
        const isIOS = /iPad|iPhone|iPod/.test(ua) || /iPad|iPhone|iPod/.test(platform) || isIPadOS;
        const isAndroid = /Android/.test(ua);
        const isMobile = isIOS || isAndroid || /Mobi/.test(ua);
        return { isIOS, isAndroid, isMobile, osParam: isIOS ? 'ios' : 'default' };
    })();

    const REMOTE = {
        requestApiPath: 'hades905.mooo.com/mmw/api/request.php',
        authPlugin: 'https://gistcdn.githack.com/brightwoods/ca912f84e591e16848ac17f1768f2fa3/raw/mmw_auth_plugin.js',
    };

    // GM 저장 키 (오리진 공유용)
    const STORE = {
        hash: 'mw_pl_hash',
        encoded: 'mw_pl_encoded',
        userId: 'mw_pl_userid',
        plVersion: 'mw_pl_version',
        plOs: 'mw_pl_os', // 캐시된 플러그인이 어느 OS 용인지 기록
    };

    const DefaultConfig = {
        debug: true,
        volume: 0.01,
        alarmEnabled: true,
        alarmVolume: 1.0,
        keepAlive: true,
    };
    const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

    /* =========================================================
     * 0. Logger
     * =======================================================*/
    let DEBUG_FLAG = false;
    const Logger = {
        get DEBUG() { return DEBUG_FLAG; },
        _ts() { return new Date().toISOString().substr(11, 12); },
        log(...a) { if (this.DEBUG) try { console.log(`[MWU ${this._ts()}]`, ...a); } catch (e) {} },
        warn(...a) { if (this.DEBUG) try { console.warn(`[MWU ${this._ts()}]`, ...a); } catch (e) {} },
        err(...a) { if (this.DEBUG) try { console.error(`[MWU ${this._ts()}]`, ...a); } catch (e) {} },
        group(t) { if (this.DEBUG) try { console.group(`[MWU] ${t}`); } catch (e) {} },
        groupEnd() { if (this.DEBUG) try { console.groupEnd(); } catch (e) {} },
    };

    /* =========================================================
     * 0-1. GM 저장소 래퍼 (오리진 공유 핵심)
     * =======================================================*/
    const Store = {
        _gmSet: (typeof GM_setValue !== 'undefined') ? GM_setValue
            : (typeof GM !== 'undefined' && GM.setValue ? GM.setValue.bind(GM) : null),
        _gmGet: (typeof GM_getValue !== 'undefined') ? GM_getValue
            : (typeof GM !== 'undefined' && GM.getValue ? GM.getValue.bind(GM) : null),
        get usingGM() { return !!(this._gmSet && this._gmGet); },
        async set(key, val) {
            if (this.usingGM) {
                await Promise.resolve(this._gmSet(key, val));
                Logger.log(`Store.set[GM] ${key} = ${String(val).slice(0, 40)}...`);
            } else {
                localStorage.setItem(key, val);
                Logger.warn(`Store.set[localStorage-폴백!] ${key} — 오리진 간 공유 안 됨`);
            }
        },
        async get(key, def) {
            if (this.usingGM) {
                const v = await Promise.resolve(this._gmGet(key, def));
                Logger.log(`Store.get[GM] ${key} = ${v == null ? '(없음)' : String(v).slice(0, 40) + '...'}`);
                return v;
            } else {
                const v = localStorage.getItem(key);
                return v == null ? def : v;
            }
        },
    };

    /* =========================================================
     * 1. Config (페이지별 설정: localStorage)
     * =======================================================*/
    const Config = {
        data: {},
        get(key, def) {
            const v = localStorage.getItem(`mw_cfg_${key}`);
            if (v === null) return def;
            try {
                if (typeof def === 'number') return Number.isFinite(Number(v)) ? Number(v) : def;
                if (typeof def === 'boolean') return v === '1';
                if (Array.isArray(def)) { const a = JSON.parse(v); return Array.isArray(a) ? a : def; }
                return v;
            } catch (e) { return def; }
        },
        set(key, val) {
            const v = typeof val === 'boolean' ? (val ? '1' : '0')
                : (Array.isArray(val) ? JSON.stringify(val) : String(val));
            localStorage.setItem(`mw_cfg_${key}`, v);
        },
        load() {
            this.data = Object.keys(DefaultConfig).reduce((acc, key) => {
                acc[key] = this.get(key, DefaultConfig[key]);
                return acc;
            }, {});
            this.data.volume = clamp(this.data.volume);
            this.data.alarmVolume = clamp(this.data.alarmVolume);
            DEBUG_FLAG = this.data.debug;
        },
        saveAll() { Object.keys(this.data).forEach(k => this.set(k, this.data[k])); },
    };
    Config.load();

    window.__mwDebug = function (on) {
        Config.data.debug = (on === undefined) ? !Config.data.debug : Boolean(on);
        Config.set('debug', Config.data.debug);
        DEBUG_FLAG = Config.data.debug;
        console.log('[MWU] DEBUG =', Config.data.debug);
        return Config.data.debug;
    };

    Logger.group('부팅');
    Logger.log('URL =', location.href);
    Logger.log('OS =', Env.isIOS ? 'iOS' : (Env.isAndroid ? 'Android' : 'PC/기타'), '/ osParam =', Env.osParam);
    Logger.log('저장소 =', Store.usingGM ? 'GM (공유 OK)' : 'localStorage 폴백(공유 불가!)');
    if (!Store.usingGM) Logger.err('⚠ GM_setValue 미지원 — @grant 확인 필요');
    Logger.groupEnd();

    /* =========================================================
     * 2. GM XHR
     * =======================================================*/
    const gmXhr = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    function httpRequest(opts) {
        return new Promise((resolve, reject) => {
            if (!gmXhr) return reject(new Error('GM_xmlhttpRequest 사용 불가'));
            Logger.log(`HTTP ${opts.method || 'GET'} ${opts.url}`);
            gmXhr({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.data || null,
                timeout: opts.timeout || 15000,
                onload: (r) => { Logger.log(`HTTP 응답 ${r.status} (${(r.responseText || '').length} bytes)`); resolve(r); },
                onerror: (e) => { Logger.err('HTTP 오류', e); reject(e); },
                ontimeout: () => { Logger.err('HTTP 타임아웃'); reject(new Error('timeout')); },
            });
        });
    }

    function getRequestApiCandidates() {
        const raw = String(REMOTE.requestApiPath || REMOTE.requestApi || '').trim();
        const normalized = raw.replace(/^https?:\/\//i, '');
        return [`https://${normalized}`, `http://${normalized}`];
    }

    /* =========================================================
     * 3. AudioCtrl (iOS 는 볼륨/알람 미사용이지만 재생감지는 사용)
     * =======================================================*/
    const AudioCtrl = {
        volume: Config.data.volume,
        analyzers: new Set(),
        gains: new Set(),
        sysCtx: null,
        getSysCtx() {
            if (!this.sysCtx) {
                const C = window.AudioContext || window.webkitAudioContext;
                if (C) { this.sysCtx = new C(); this.sysCtx.__mwSysCtx = true; }
            }
            return this.sysCtx;
        },
        playTone({ freq, vol, start, dur, ramps }) {
            const ctx = this.getSysCtx();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            gain.gain.value = ramps ? 0.0001 : vol;
            if (ramps) {
                osc.frequency.setValueAtTime(freq, now + start);
                osc.frequency.setValueAtTime(freq * 1.33, now + start + 0.08);
                gain.gain.setValueAtTime(0.0001, now + start);
                gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), now + start + 0.025);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur - 0.02);
            }
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + start);
            osc.stop(now + start + dur);
        },
        setMasterVolume(val) {
            this.volume = clamp(val);
            Config.data.volume = this.volume;
            Config.set('volume', this.volume);
            this.gains.forEach(g => { try { g.gain.value = this.volume; } catch (e) {} });
            document.querySelectorAll('audio, video').forEach(m => this.forceMediaVolume(m));
            UI.updateVolume();
        },
        forceMediaVolume(media) {
            try {
                const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
                if (d && d.set) {
                    media.__mwInternalSet = true;
                    d.set.call(media, this.volume);
                    media.__mwInternalSet = false;
                }
            } catch (e) {}
        },
        hook() {
            const proto = HTMLMediaElement.prototype;
            if (!proto.__mwHooked) {
                proto.__mwHooked = true;
                const vDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
                if (vDesc) {
                    Object.defineProperty(proto, 'volume', {
                        configurable: true,
                        enumerable: vDesc.enumerable,
                        get() { return vDesc.get.call(this); },
                        set(v) { return vDesc.set.call(this, this.__mwInternalSet ? v : AudioCtrl.volume); },
                    });
                }
                const oPlay = proto.play;
                proto.play = function (...a) { AudioCtrl.forceMediaVolume(this); return oPlay.apply(this, a); };
            }
            if (window.AudioNode && !window.AudioNode.prototype.__mwWAHooked) {
                window.AudioNode.prototype.__mwWAHooked = true;
                const oConn = window.AudioNode.prototype.connect;
                const oDisconn = window.AudioNode.prototype.disconnect;
                const chains = new WeakMap();
                function getChain(ctx) {
                    if (!chains.has(ctx)) {
                        const analyser = ctx.createAnalyser();
                        const gain = ctx.createGain();
                        analyser.fftSize = 512;
                        gain.gain.value = AudioCtrl.volume;
                        chains.set(ctx, { analyser, gain, buffer: new Uint8Array(512) });
                        AudioCtrl.analyzers.add(chains.get(ctx));
                        AudioCtrl.gains.add(gain);
                        oConn.call(analyser, gain);
                        oConn.call(gain, ctx.destination);
                    }
                    return chains.get(ctx);
                }
                const isSys = (c, d) => (c && c.__mwSysCtx) || (d && d.context && d.context.__mwSysCtx);
                window.AudioNode.prototype.connect = function (dest, ...rest) {
                    if (!isSys(this.context, dest) && dest && this.context && dest === this.context.destination) {
                        oConn.call(this, getChain(this.context).analyser, ...rest);
                        return dest;
                    }
                    return oConn.call(this, dest, ...rest);
                };
                window.AudioNode.prototype.disconnect = function (dest, ...rest) {
                    if (!isSys(this.context, dest) && dest && this.context && dest === this.context.destination && chains.has(this.context)) {
                        return oDisconn.call(this, chains.get(this.context).analyser, ...rest);
                    }
                    return oDisconn.apply(this, arguments);
                };
            }
            ['play', 'playing', 'volumechange'].forEach(ev => document.addEventListener(ev, e => {
                if (e.target instanceof HTMLMediaElement) this.forceMediaVolume(e.target);
            }, true));
        },
        isPlaying() {
            const ms = document.querySelectorAll('audio, video');
            for (const m of ms) if (!m.paused && !m.ended && m.readyState >= 2) return true;
            for (const c of this.analyzers) {
                if (!c.analyser) continue;
                c.analyser.getByteTimeDomainData(c.buffer);
                for (let i = 0; i < c.buffer.length; i++) if (Math.abs(c.buffer[i] - 128) >= 4) return true;
            }
            return false;
        },
    };

    /* =========================================================
     * 4. App (재생 모니터 / 알람 / keepAlive / 훅)
     * =======================================================*/
    const App = {
        state: { everPlayed: false, alarmActive: false, silentSince: 0 },
        timers: {},
        hooks: { onPlaybackFail: [], onTick: [] },
        registerHook(n, fn) { if (this.hooks[n] && typeof fn === 'function') this.hooks[n].push(fn); },
        fireHook(n, ...a) {
            (this.hooks[n] || []).forEach(fn => { try { fn(...a); } catch (e) { Logger.err('hook error', n, e); } });
        },
        handlePlaybackFail(reason) {
            this.fireHook('onPlaybackFail', reason);
            // iOS 는 알람(오디오톤) 미지원 → 상태표시만
            if (!Env.isIOS && Config.data.alarmEnabled) {
                UI.setStatus('경고: 재생 실패 (알람)');
                this.startAlarm();
            } else {
                UI.setStatus('재생 실패 감지');
            }
        },
        startMonitors() {
            setTimeout(() => {
                if (AudioCtrl.isPlaying()) { this.state.everPlayed = true; UI.setStatus('정상: 재생 중'); }
                else this.handlePlaybackFail('자동재생 실패');
            }, 5000);
            this.timers.monitor = setInterval(() => {
                const p = AudioCtrl.isPlaying();
                this.fireHook('onTick', p);
                if (p) { this.state.everPlayed = true; this.state.silentSince = 0; }
                else if (this.state.everPlayed && !this.state.alarmActive) {
                    const now = Date.now();
                    if (!this.state.silentSince) this.state.silentSince = now;
                    else if (now - this.state.silentSince >= 3000) {
                        this.state.silentSince = 0;
                        this.handlePlaybackFail('재생 정지 지속');
                    }
                }
            }, 2000);
        },
        startAlarm() {
            if (Env.isIOS) return; // iOS 미지원
            if (this.state.alarmActive) return;
            this.state.alarmActive = true;
            UI.updateAlarmState();
            const ring = () => [0, 0.18, 0.36].forEach(o => AudioCtrl.playTone({
                freq: 880, vol: 0.72 * Config.data.alarmVolume, start: o, dur: 0.16, ramps: true,
            }));
            ring();
            this.timers.alarm = setInterval(() => {
                if (!this.state.alarmActive || !Config.data.alarmEnabled) return this.stopAlarm();
                if (AudioCtrl.isPlaying()) { this.stopAlarm(); UI.setStatus('정상: 재생 감지 (알람 정지)'); }
                else ring();
            }, 1900);
        },
        stopAlarm() {
            clearInterval(this.timers.alarm);
            this.state.alarmActive = false;
            UI.updateAlarmState();
        },
        manageKeepAlive(enable) {
            clearInterval(this.timers.keepAlive);
            if (!enable) return;
            const ping = () => AudioCtrl.playTone({ freq: 40, vol: 0.0008, start: 0, dur: 0.12, ramps: false });
            const wl = async () => {
                if ('wakeLock' in navigator && document.visibilityState === 'visible') {
                    try { await navigator.wakeLock.request('screen'); } catch (e) {}
                }
            };
            if (!Env.isIOS) ping(); // iOS 는 시스템톤 대신 wakelock 위주
            wl();
            this.timers.keepAlive = setInterval(() => { if (!Env.isIOS) ping(); wl(); }, 25000);
            document.addEventListener('visibilitychange', wl);
        },
    };

    /* =========================================================
     * 5. NetGuard + Recovery (구 복구 플러그인 → 코어 통합)
     * =======================================================*/
    const NetGuard = {
        failStreak: 0,
        lastFailTs: 0,
        criticalPatterns: [/musicwave/i, /stream/i, /play/i, /\.melon\.com\/.*api/i],
        isCritical(url) { try { return this.criticalPatterns.some(re => re.test(String(url))); } catch (e) { return false; } },
        reportFail(url, detail) {
            this.failStreak++; this.lastFailTs = Date.now();
            Logger.warn(`네트워크 실패 (${this.failStreak}회): ${url}`, detail);
            if (this.failStreak >= 2) Recovery.begin('네트워크 오류 연속 감지');
        },
        reportOk(url) {
            if (this.failStreak > 0) Logger.log('네트워크 정상 복귀:', url);
            this.failStreak = 0;
        },
        hookFetch() {
            const orig = window.fetch;
            if (!orig || orig.__mwNetHooked) return;
            const self = this;
            const wrapped = function (input) {
                const url = (typeof input === 'string') ? input : (input && input.url) || '';
                return orig.apply(this, arguments).then(res => {
                    if (self.isCritical(url) && (res.status >= 500 || res.status === 0)) self.reportFail(url, 'status ' + res.status);
                    else if (self.isCritical(url)) self.reportOk(url);
                    return res;
                }).catch(err => { if (self.isCritical(url)) self.reportFail(url, err); throw err; });
            };
            wrapped.__mwNetHooked = true;
            window.fetch = wrapped;
        },
        hookXhr() {
            const proto = XMLHttpRequest.prototype;
            if (proto.__mwNetHooked) return;
            proto.__mwNetHooked = true;
            const oOpen = proto.open, oSend = proto.send;
            const self = this;
            proto.open = function (method, url, ...rest) { this.__mwUrl = url; return oOpen.call(this, method, url, ...rest); };
            proto.send = function (...args) {
                const url = this.__mwUrl || '';
                if (self.isCritical(url)) {
                    this.addEventListener('error', () => self.reportFail(url, 'xhr error'));
                    this.addEventListener('timeout', () => self.reportFail(url, 'xhr timeout'));
                    this.addEventListener('load', () => {
                        if (this.status >= 500 || this.status === 0) self.reportFail(url, 'xhr status ' + this.status);
                        else self.reportOk(url);
                    });
                }
                return oSend.apply(this, args);
            };
        },
        init() { this.hookFetch(); this.hookXhr(); Logger.log('NetGuard: fetch/XHR 후킹 완료'); },
    };

    const Recovery = {
        running: false,
        retryScheduled: false,
        retryTimer: null,
        async begin(reason) {
            if (this.running || this.retryScheduled) return;
            this.running = true;
            Logger.warn('복구 시퀀스 시작:', reason);
            UI.setStatus('통신 확인 중...');
            let ok = false;
            try { ok = await this.probe(); } catch (e) { Logger.err('probe 예외', e); ok = false; }
            this.running = false;
            if (ok) { Logger.log('재접속 확인 → 새로고침'); this.doReload(reason); }
            else { Logger.warn('재접속 실패 → 재시도 예약'); UI.setStatus('통신 대기 중 (재시도 예정)'); this.scheduleRetry(); }
        },
        scheduleRetry() {
            if (this.retryScheduled) return;
            this.retryScheduled = true;
            this.retryTimer = setTimeout(() => {
                this.retryScheduled = false; this.retryTimer = null; this.begin('재시도');
            }, 10000);
        },
        probe() {
            return new Promise(resolve => {
                const iframe = document.createElement('iframe');
                iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;left:-9999px;top:-9999px;pointer-events:none;border:0;';
                const OVERALL_TIMEOUT = 30000, POLL_INTERVAL = 500, MIN_READY_STATE = 1;
                let settled = false, pollTimer = null;
                const finish = (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(overallTo);
                    if (pollTimer) clearTimeout(pollTimer);
                    try { iframe.remove(); } catch (e) {}
                    Logger.log(`probe 종료: ${result ? '정상(플레이어 발견)' : '실패'}`);
                    resolve(result);
                };
                const pollForPlayer = () => {
                    if (settled) return;
                    let doc = null;
                    try { doc = iframe.contentDocument; } catch (e) { doc = null; }
                    if (doc) {
                        const medias = doc.querySelectorAll('audio, video');
                        for (const m of medias) {
                            const hasSrc = !!(m.currentSrc || m.src || (m.querySelector && m.querySelector('source[src]')));
                            if (hasSrc || m.readyState >= MIN_READY_STATE) { Logger.log('probe: 플레이어 확인'); finish(true); return; }
                        }
                    }
                    pollTimer = setTimeout(pollForPlayer, POLL_INTERVAL);
                };
                iframe.addEventListener('load', () => { Logger.log('probe: iframe load'); pollForPlayer(); });
                iframe.addEventListener('error', () => { Logger.warn('probe: iframe error'); finish(false); });
                const overallTo = setTimeout(() => { Logger.warn('probe: 타임아웃'); finish(false); }, OVERALL_TIMEOUT);
                iframe.src = location.href;
                pollTimer = setTimeout(pollForPlayer, POLL_INTERVAL);
                document.body.appendChild(iframe);
            });
        },
        doReload(reason) {
            // 플러그인(핵심)이 쿠키삭제+새로고침 브릿지를 걸어두면 그걸 우선 사용
            if (typeof window.__mwReloaderTrigger === 'function') window.__mwReloaderTrigger('복구: ' + reason);
            else { try { location.reload(); } catch (e) { window.location.href = location.href; } }
        },
    };

    /* =========================================================
     * 6. PluginLoader (OS 파라미터 지원 + 캐시 OS 검증)
     * =======================================================*/
    const PluginLoader = {
        decrypt(hash, encodedBase64) {
            try {
                const key = CryptoJS.SHA256(hash);
                const raw = CryptoJS.enc.Base64.parse(encodedBase64);
                const iv = CryptoJS.lib.WordArray.create(raw.words.slice(0, 4), 16);
                const ct = CryptoJS.lib.WordArray.create(raw.words.slice(4), raw.sigBytes - 16);
                const dec = CryptoJS.AES.decrypt({ ciphertext: ct }, key, {
                    iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
                });
                const str = dec.toString(CryptoJS.enc.Utf8);
                Logger.log(`복호화 완료: ${str.length} chars`);
                return str;
            } catch (e) { Logger.err('복호화 예외', e); return ''; }
        },
        getApi() {
            return { Config, Logger, AudioCtrl, App, UI, httpRequest, Store, clamp, Env, version: CORE_VERSION };
        },
        execute(codeStr) {
            try {
                const factory = new Function('MW', `"use strict";\n${codeStr}`);
                factory(this.getApi());
                Logger.log('✔ 핵심 플러그인 실행 완료');
                return true;
            } catch (e) { Logger.err('플러그인 실행 실패', e); UI.setStatus('플러그인 실행 오류'); return false; }
        },
        async clearPluginCache(reason) {
            Logger.warn(`플러그인 캐시 폐기: ${reason}`);
            await Store.set(STORE.hash, null);
            await Store.set(STORE.encoded, null);
            await Store.set(STORE.plVersion, null);
            await Store.set(STORE.plOs, null);
        },
        async tryRunCached() {
            const cachedVer = await Store.get(STORE.plVersion, null);
            const cachedOs = await Store.get(STORE.plOs, null);
            if (cachedVer !== CORE_VERSION) {
                await this.clearPluginCache(cachedVer == null ? '버전 정보 없음' : `버전 불일치 (캐시=${cachedVer}, 코어=${CORE_VERSION})`);
                return false;
            }
            if (cachedOs !== Env.osParam) {
                await this.clearPluginCache(`OS 불일치 (캐시=${cachedOs}, 현재=${Env.osParam})`);
                return false;
            }
            const hash = await Store.get(STORE.hash, null);
            const encoded = await Store.get(STORE.encoded, null);
            Logger.log(`캐시 확인: hash=${hash ? '있음' : '없음'}, encoded=${encoded ? '있음' : '없음'}, os=${cachedOs}`);
            if (!hash || !encoded) return false;
            const code = this.decrypt(hash, encoded);
            if (!code) { Logger.warn('복호화 결과 비어있음'); return false; }
            return this.execute(code);
        },
        async fetchFromServer(userId) {
            Logger.log(`서버 플러그인 요청. userId=${userId} / os=${Env.osParam}`);
            const requestUrls = getRequestApiCandidates();
            const requestData = `client_hash=${encodeURIComponent(userId)}&os=${encodeURIComponent(Env.osParam)}`;
            let res = null;
            let lastError = null;

            UI.setServerConnectFailed(false);

            for (const url of requestUrls) {
                try {
                    Logger.log(`서버 접속 시도: ${url}`);
                    res = await httpRequest({
                        method: 'POST',
                        url,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        data: requestData,
                    });
                    Logger.log(`서버 접속 성공: ${url}`);
                    lastError = null;
                    break;
                } catch (e) {
                    lastError = e;
                    Logger.warn(`서버 접속 실패: ${url}`, e);
                }
            }

            if (!res) {
                UI.setServerConnectFailed(true);
                throw lastError || new Error('hades905 서버접속 실패');
            }

            UI.setServerConnectFailed(false);

            let json;
            try { json = JSON.parse(res.responseText); }
            catch (e) { Logger.err('서버 응답 원문:', (res.responseText || '').slice(0, 200)); throw new Error('JSON 파싱 실패'); }
            Logger.log('서버 응답 OK. cached =', json.cached, '/ hash 길이 =', (json.hash || '').length);
            if (!json.hash || !json.encoded) throw new Error('서버 응답에 hash/encoded 없음');
            await Store.set(STORE.hash, json.hash);
            await Store.set(STORE.encoded, json.encoded);
            await Store.set(STORE.plVersion, CORE_VERSION);
            await Store.set(STORE.plOs, Env.osParam);
            Logger.log(`플러그인 캐시 저장 (버전=${CORE_VERSION}, os=${Env.osParam})`);
            return json;
        },
        async boot() {
            Logger.group('PluginLoader.boot');
            if (await this.tryRunCached()) {
                UI.setStatus('플러그인 로드됨 (캐시)'); UI.setAuthNeeded(false);
                Logger.groupEnd(); return;
            }
            const userId = await Store.get(STORE.userId, null);
            Logger.log('저장된 userId =', userId ? userId.slice(0, 12) + '...' : '(없음)');
            if (userId) {
                try {
                    await this.fetchFromServer(userId);
                    if (await this.tryRunCached()) {
                        UI.setStatus('플러그인 로드됨 (서버)'); UI.setAuthNeeded(false);
                        Logger.groupEnd(); return;
                    }
                } catch (e) { Logger.err('서버 요청 실패', e); }
            }
            UI.setAuthNeeded(true);
            UI.setStatus('인증 필요 (기능제한)');
            Logger.warn('부트 실패 — 인증 필요');
            Logger.groupEnd();
        },
    };

    window.__mwSetUserId = async function (userId) {
        await Store.set(STORE.userId, userId);
        Logger.log('✔ 사용자ID 저장(GM):', userId.slice(0, 12) + '...');
        if (/musicwave\.melon\.com/.test(location.hostname)) await PluginLoader.boot();
    };
    window.__mwLoader = PluginLoader;
    window.__mwStore = Store;

    /* =========================================================
     * 7. UI (설정 플로팅 패널 + 플러그인 설정 확장 지원)
     * =======================================================*/
    const UI = {
        // 플러그인이 등록하는 설정 스키마 저장소
        pluginSettings: [], // [{ id, title, fields:[{key,label,type,get,set,options?}] }]
        _settingsOpen: false,

        inject() {
            if (document.getElementById('mwu-root')) return;
            // FAB 50px → 35px (70%), 배지/패널 위치도 그에 맞춤
            document.head.insertAdjacentHTML('beforeend', `<style>
#mwu-root{position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:sans-serif}
#mwu-fab{width:35px;height:35px;border-radius:50%;cursor:pointer;border:none;color:#fff;font-size:20px;font-weight:700;background:radial-gradient(circle at 30% 30%,#2ec96b,#0a8f43);box-shadow:0 4px 14px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
#mwu-root.mwu-alarm #mwu-fab{background:radial-gradient(circle at 30% 30%,#ff6b6b,#b02020);animation:mwuPulse 1s infinite}
@keyframes mwuPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
#mwu-server-fail{position:absolute;right:0;bottom:72px;background:#5a1a1a;color:#ffd6d6;font-size:11px;font-weight:700;padding:4px 8px;border-radius:8px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4);display:none}
#mwu-server-fail.show{display:block}
#mwu-auth-badge{position:absolute;right:0;bottom:42px;background:#b02020;color:#fff;font-size:11px;font-weight:700;padding:4px 8px;border-radius:8px;cursor:pointer;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4);display:none}
#mwu-auth-badge.show{display:block}
#mwu-panel{position:absolute;right:0;bottom:46px;width:130px;padding:12px 10px;border-radius:14px;background:#15181b;border:1px solid rgba(46,201,107,.35);box-shadow:0 14px 36px rgba(0,0,0,.55);text-align:center;display:none;max-height:100vh;overflow-y:auto}
#mwu-panel.open{display:block}
#mwu-vol-num{font-size:16px;font-weight:800;margin:3px 0 9px;color:#fff}
#mwu-slider-wrap{height:105px;display:flex;justify-content:center;margin-bottom:10px}
#mwu-range{-webkit-appearance:slider-vertical;appearance:slider-vertical;writing-mode:vertical-lr;direction:rtl;width:6px;height:100%;accent-color:#2ec96b;cursor:pointer}
#mwu-presets{display:flex;flex-direction:column-reverse;gap:4px}
.mwu-preset{border:1px solid rgba(46,201,107,.4);background:rgba(46,201,107,.08);color:#d8ffe6;border-radius:7px;padding:5px 0;font-size:11px;cursor:pointer}
.mwu-preset.active{background:#2ec96b;color:#06210f}
.mwu-sec{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1)}
.mwu-check{color:#e8e8e8;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer}
.mwu-btn{width:100%;border:none;border-radius:8px;font-size:11px;padding:6px 0;cursor:pointer;margin-top:8px}
#mwu-alarm-stop{background:rgba(255,90,90,.2);color:#ffd6d6}
#mwu-settings-btn{background:rgba(255,255,255,.1);color:#cfd6d2;margin-top:10px}
#mwu-status{font-size:11px;color:#b9c2bd;line-height:1.4;word-break:keep-all}
.mwu-ios-note{font-size:11px;color:#ffd98a;line-height:1.5;word-break:keep-all;padding:8px 4px}
/* 설정 플로팅 박스 */
#mwu-settings-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center}
#mwu-settings-overlay.open{display:flex}
#mwu-settings-box{width:min(340px,90vw);max-height:85vh;overflow-y:auto;background:#15181b;border:1px solid rgba(46,201,107,.4);border-radius:16px;padding:18px 16px;box-shadow:0 20px 50px rgba(0,0,0,.6);font-family:sans-serif}
#mwu-settings-box h3{margin:0 0 6px;color:#2ec96b;font-size:15px}
.mwu-set-group{margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1)}
.mwu-set-group:first-of-type{border-top:none;margin-top:8px}
.mwu-set-group h4{margin:0 0 8px;font-size:12px;color:#9fe8bf}
.mwu-field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0}
.mwu-field label{font-size:12px;color:#e0e0e0;flex:1}
.mwu-field input[type=text],.mwu-field input[type=number],.mwu-field textarea,.mwu-field select{background:#0d0f11;border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:6px;padding:5px 6px;font-size:12px;width:120px}
.mwu-field textarea{width:100%;min-height:56px;resize:vertical}
.mwu-field.col{flex-direction:column;align-items:stretch}
.mwu-set-actions{display:flex;gap:8px;margin-top:16px}
.mwu-set-actions button{flex:1;border:none;border-radius:8px;padding:9px 0;font-size:13px;cursor:pointer}
#mwu-set-save{background:#2ec96b;color:#06210f;font-weight:700}
#mwu-set-cancel{background:rgba(255,255,255,.12);color:#ddd}
</style>`);

            const iosNote = `<div class="mwu-ios-note">iOS에서는 볼륨 조절과 알람이 지원되지 않습니다.</div>`;
            const desktopVolUI = `
<h4 style="margin:0;font-size:12px;color:#2ec96b">Volume</h4>
<div id="mwu-vol-num">0%</div>
<div id="mwu-slider-wrap"><input id="mwu-range" type="range" min="0" max="100" step="1" orient="vertical"></div>
<div id="mwu-presets">${[1, 3, 30, 50, 70, 100].map(p => `<button class="mwu-preset" data-v="${p}">${p}%</button>`).join('')}</div>
<div class="mwu-sec"><label class="mwu-check"><input id="mwu-alarm-enabled" type="checkbox"> 재생실패 알람</label><button class="mwu-btn" id="mwu-alarm-stop">알림음 정지</button></div>`;

            document.body.insertAdjacentHTML('beforeend', `<div id="mwu-root">
<div id="mwu-server-fail">hades905 서버접속 실패</div>
<div id="mwu-auth-badge">인증 필요 (기능제한)</div>
<div id="mwu-panel">
${Env.isIOS ? iosNote : desktopVolUI}
<div class="mwu-sec" id="mwu-status">대기 중</div>
<button class="mwu-btn" id="mwu-settings-btn">⚙ 설정</button>
</div>
<button id="mwu-fab" title="볼륨/상태">♪</button>
</div>
<div id="mwu-settings-overlay"><div id="mwu-settings-box"></div></div>`);

            this.bindEvents();
            if (!Env.isIOS) {
                this.updateVolume();
                const ae = document.getElementById('mwu-alarm-enabled');
                if (ae) ae.checked = Config.data.alarmEnabled;
            }
        },

        bindEvents() {
            const qs = s => document.querySelector(s);
            qs('#mwu-fab').addEventListener('click', e => {
                e.stopPropagation();
                qs('#mwu-panel').classList.toggle('open');
                AudioCtrl.getSysCtx(); // 사용자 제스처로 오디오 컨텍스트 unlock
            });
            qs('#mwu-panel').addEventListener('click', e => e.stopPropagation());
            document.addEventListener('click', e => {
                if (!qs('#mwu-root').contains(e.target)) qs('#mwu-panel').classList.remove('open');
            }, true);

            if (!Env.isIOS) {
                qs('#mwu-range').addEventListener('input', e => AudioCtrl.setMasterVolume(e.target.value / 100));
                document.querySelectorAll('.mwu-preset').forEach(b =>
                    b.addEventListener('click', () => AudioCtrl.setMasterVolume(b.dataset.v / 100)));
                qs('#mwu-alarm-enabled').addEventListener('change', e => {
                    Config.data.alarmEnabled = e.target.checked;
                    Config.set('alarmEnabled', Config.data.alarmEnabled);
                    if (!Config.data.alarmEnabled) App.stopAlarm();
                    this.setStatus(`알람 ${Config.data.alarmEnabled ? '켜짐' : '꺼짐'}`);
                });
                qs('#mwu-alarm-stop').addEventListener('click', () => {
                    App.stopAlarm(); this.setStatus('알림음 수동 정지');
                });
            }

            qs('#mwu-settings-btn').addEventListener('click', () => this.openSettings());
            qs('#mwu-auth-badge').addEventListener('click', () => {
                Logger.log('인증 요청 → 카페 창 오픈');
                window.open('https://cafe.naver.com/moomoo#mwauth', '_blank');
            });
            // 설정 오버레이 바깥 클릭 시 닫기
            qs('#mwu-settings-overlay').addEventListener('click', e => {
                if (e.target.id === 'mwu-settings-overlay') this.closeSettings();
            });
        },

        setAuthNeeded(need) {
            const b = document.getElementById('mwu-auth-badge');
            if (b) b.classList.toggle('show', !!need);
        },
        setServerConnectFailed(failed) {
            const e = document.getElementById('mwu-server-fail');
            if (e) e.classList.toggle('show', !!failed);
        },
        updateVolume() {
            if (Env.isIOS) return;
            const v = Math.round(AudioCtrl.volume * 100);
            const n = document.getElementById('mwu-vol-num');
            const r = document.getElementById('mwu-range');
            if (n) n.textContent = `${v}%`;
            if (r) r.value = v;
            document.querySelectorAll('.mwu-preset').forEach(b =>
                b.classList.toggle('active', Math.abs(b.dataset.v / 100 - AudioCtrl.volume) < 0.005));
        },
        setStatus(m) { const e = document.getElementById('mwu-status'); if (e) e.textContent = m; },
        updateAlarmState() {
            const r = document.getElementById('mwu-root');
            if (r) r.classList.toggle('mwu-alarm', App.state.alarmActive);
        },

        /* ---- 플러그인 설정 등록 API ----
         * schema = { id, title, fields:[
         *    { key, label, type:'bool'|'number'|'text'|'textarea'|'select',
         *      get:()=>value, set:(v)=>void, options?:[{value,label}] }
         * ]}
         */
        registerSettings(schema) {
            if (!schema || !schema.id) return;
            const idx = this.pluginSettings.findIndex(s => s.id === schema.id);
            if (idx >= 0) this.pluginSettings[idx] = schema;
            else this.pluginSettings.push(schema);
            Logger.log(`설정 스키마 등록: ${schema.id} (필드 ${schema.fields.length}개)`);
        },

        /* ---- 코어 기본 설정 스키마 (iOS 는 알람 항목 제외) ---- */
        _coreSchema() {
            const fields = [];
            if (!Env.isIOS) {
                fields.push({
                    key: 'alarmEnabled', label: '재생실패 알람', type: 'bool',
                    get: () => Config.data.alarmEnabled,
                    set: v => { Config.data.alarmEnabled = v; Config.set('alarmEnabled', v); if (!v) App.stopAlarm(); },
                });
                fields.push({
                    key: 'alarmVolume', label: '알람 볼륨(%)', type: 'number',
                    get: () => Math.round(Config.data.alarmVolume * 100),
                    set: v => { Config.data.alarmVolume = clamp((Number(v) || 0) / 100); Config.set('alarmVolume', Config.data.alarmVolume); },
                });
            }
            fields.push({
                key: 'keepAlive', label: '백그라운드 유지', type: 'bool',
                get: () => Config.data.keepAlive,
                set: v => { Config.data.keepAlive = v; Config.set('keepAlive', v); App.manageKeepAlive(v); },
            });
            fields.push({
                key: 'debug', label: '디버그 로그', type: 'bool',
                get: () => Config.data.debug,
                set: v => { Config.data.debug = v; Config.set('debug', v); DEBUG_FLAG = v; },
            });
            return { id: '__core', title: '기본 설정', fields };
        },

        _renderField(f) {
            const cur = f.get();
            let inner = '';
            if (f.type === 'bool') {
                inner = `<label>${f.label}</label><input type="checkbox" data-fk="${f.key}" ${cur ? 'checked' : ''}>`;
                return `<div class="mwu-field">${inner}</div>`;
            }
            if (f.type === 'number') {
                inner = `<label>${f.label}</label><input type="number" data-fk="${f.key}" value="${cur}">`;
                return `<div class="mwu-field">${inner}</div>`;
            }
            if (f.type === 'select') {
                const opts = (f.options || []).map(o =>
                    `<option value="${o.value}" ${String(o.value) === String(cur) ? 'selected' : ''}>${o.label}</option>`).join('');
                inner = `<label>${f.label}</label><select data-fk="${f.key}">${opts}</select>`;
                return `<div class="mwu-field">${inner}</div>`;
            }
            if (f.type === 'textarea') {
                const val = Array.isArray(cur) ? cur.join('\n') : String(cur);
                return `<div class="mwu-field col"><label>${f.label}</label><textarea data-fk="${f.key}">${val}</textarea></div>`;
            }
            // text
            const tval = Array.isArray(cur) ? cur.join(', ') : String(cur);
            inner = `<label>${f.label}</label><input type="text" data-fk="${f.key}" value="${tval}">`;
            return `<div class="mwu-field">${inner}</div>`;
        },

        openSettings() {
            const box = document.getElementById('mwu-settings-box');
            if (!box) return;
            const schemas = [this._coreSchema(), ...this.pluginSettings];
            this._activeSchemas = schemas;
            let html = `<h3>⚙ 환경설정</h3>`;
            schemas.forEach(sc => {
                html += `<div class="mwu-set-group" data-gid="${sc.id}"><h4>${sc.title}</h4>`;
                sc.fields.forEach(f => { html += this._renderField(f); });
                html += `</div>`;
            });
            html += `<div class="mwu-set-actions"><button id="mwu-set-cancel">취소</button><button id="mwu-set-save">저장</button></div>`;
            box.innerHTML = html;
            document.getElementById('mwu-set-save').addEventListener('click', () => this._saveSettings());
            document.getElementById('mwu-set-cancel').addEventListener('click', () => this.closeSettings());
            document.getElementById('mwu-settings-overlay').classList.add('open');
            document.getElementById('mwu-panel').classList.remove('open');
            this._settingsOpen = true;
        },

        _saveSettings() {
            const box = document.getElementById('mwu-settings-box');
            (this._activeSchemas || []).forEach(sc => {
                sc.fields.forEach(f => {
                    const el = box.querySelector(`[data-fk="${f.key}"]`);
                    if (!el) return;
                    let val;
                    if (f.type === 'bool') val = el.checked;
                    else if (f.type === 'number') val = Number(el.value);
                    else if (f.type === 'textarea') val = el.value; // set 쪽에서 파싱
                    else val = el.value;
                    try { f.set(val); } catch (e) { Logger.err('설정 저장 오류', f.key, e); }
                });
            });
            DEBUG_FLAG = Config.data.debug;
            this.updateVolume();
            const ae = document.getElementById('mwu-alarm-enabled');
            if (ae) ae.checked = Config.data.alarmEnabled;
            this.setStatus('설정 저장됨');
            this.closeSettings();
        },

        closeSettings() {
            const o = document.getElementById('mwu-settings-overlay');
            if (o) o.classList.remove('open');
            this._settingsOpen = false;
        },
    };

    /* =========================================================
     * 8. 인증 플러그인 로더 (외부 유지)
     * =======================================================*/
    async function loadAuthPlugin(reason) {
        Logger.log('인증 플러그인 로드 시도. 사유 =', reason);
        try {
            const res = await httpRequest({ method: 'GET', url: REMOTE.authPlugin });
            const factory = new Function('MW', `"use strict";\n${res.responseText}`);
            factory(PluginLoader.getApi());
            Logger.log('✔ 인증 플러그인 실행 완료');
        } catch (e) { Logger.err('인증 플러그인 로드 실패', e); }
    }

    /* =========================================================
     * 9. Init
     * =======================================================*/
    function init() {
        const onCafe = /cafe\.naver\.com/.test(location.hostname);

        if (onCafe) {
            const start = () => loadAuthPlugin('카페 진입 (인증 컨텍스트)');
            const kickIfNeeded = async () => {
                const hashSignal = /(^|#)mwauth/.test(location.hash);
                let mobileInProgress = false;
                try { mobileInProgress = (await Store.get('mw_pl_mobile_authing', null)) === '1'; } catch (e) {}
                if (!hashSignal && !mobileInProgress) return;
                Logger.log('컨텍스트: 카페(인증) / hash =', hashSignal, '/ 모바일진행 =', mobileInProgress);
                start();
            };
            if (document.readyState === 'loading')
                document.addEventListener('DOMContentLoaded', () => { kickIfNeeded(); }, { once: true });
            else kickIfNeeded();
            return;
        }

        if (window.top !== window.self) return;

        const isMusicwaveTarget = location.hostname === 'musicwave.melon.com' && /^\/musicwave\.htm/.test(location.pathname);
        if (!isMusicwaveTarget) return;

        Logger.log('컨텍스트: 뮤직웨이브 / OS =', Env.osParam);
        AudioCtrl.hook();
        NetGuard.init(); // 통신 후킹은 항상 활성

        const onReady = async () => {
            UI.inject();
            App.startMonitors();
            App.manageKeepAlive(Config.data.keepAlive);
            if (!Env.isIOS) {
                [0, 100, 300, 800, 1500].forEach(d => setTimeout(() => AudioCtrl.setMasterVolume(AudioCtrl.volume), d));
            }
            await PluginLoader.boot();
            const userId = await Store.get(STORE.userId, null);
            if (!userId) {
                UI.setAuthNeeded(true);
                UI.setStatus('인증 필요 (기능제한) — 배지를 눌러 인증');
            }
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
        else onReady();
    }
    init();
})();
