const WebSocket = require('ws');
const zlib = require('zlib');
const fs = require('fs');
const NightHttp2 = require('./nighthttp2.js');

const USER_TOKEN = "token";
const FOLLOWING_GUILD_ID = "1050346347112443945";
const TARGET_GUILD_ID = "1050346347112443945";
const MFA_FILE = "mfa.txt";

let mfaAuthToken = null;
let latestSequence = null;
let heartbeatTimer = null;
let currentVanityCode = null;
let http2Client = null;
let mfaWatcher = null;
let http2Ready = false;
let wsClient = null;

const preparedRequests = new Map();

function readMfaToken() {
    try {
        if (fs.existsSync(MFA_FILE)) {
            const token = fs.readFileSync(MFA_FILE, 'utf8').trim();
            if (token && token !== mfaAuthToken) {
                mfaAuthToken = token;
                console.log('[MFA] token loaded');
                
                if (http2Client) {
                    for (const [vanityCode, _] of preparedRequests) {
                        prepareRequestForVanity(vanityCode);
                    }
                }
                return true;
            }
        }
        return false;
    } catch (err) {
        return false;
    }
}

function watchMfaFile() {
    if (mfaWatcher) mfaWatcher.close();
    try {
        mfaWatcher = fs.watch(MFA_FILE, () => {
            console.log('[MFA] file changed');
            readMfaToken();
        });
        console.log('[MFA] watching file');
    } catch (err) {}
}

function prepareRequestForVanity(vanityCode) {
    if (!http2Client || !mfaAuthToken || !vanityCode) return false;
    
    console.log(`[HTTP2] prepping ${vanityCode}...`);
    
    const payload = http2Client.createPayload(vanityCode);
    
    const headers0 = http2Client._buildHeaders(USER_TOKEN, mfaAuthToken, payload.length, 0);
    const headers1 = http2Client._buildHeaders(USER_TOKEN, mfaAuthToken, payload.length, 1);
    
    preparedRequests.set(vanityCode, {
        vanityCode: vanityCode,
        payload: payload,
        headers0: headers0,
        headers1: headers1,
        lastUsed: 0,
        ready: true
    });
    
    console.log(`[HTTP2] ${vanityCode} ready (payload+headers)`);
    return true;
}

function sendInstantPatch(vanityCode) {
    if (!http2Client || !http2Ready) {
        console.log('[HTTP2] client not ready');
        return false;
    }
    
    const prepared = preparedRequests.get(vanityCode);
    
    if (!prepared || !prepared.ready) {
        console.log(`[HTTP2] ${vanityCode} not prepped, prepping now...`);
        prepareRequestForVanity(vanityCode);
        const newPrepared = preparedRequests.get(vanityCode);
        if (!newPrepared) return false;
        
        http2Client.patchVanityFast(vanityCode, USER_TOKEN, mfaAuthToken, (response) => {
            if (response) console.log('[HTTP2] response:', response);
        });
        return true;
    }
    
    console.log(`[HTTP2] sending ${vanityCode}...`);
    
    http2Client.sendPrebuilt({
        payload: prepared.payload,
        headers0: prepared.headers0,
        headers1: prepared.headers1
    }, (prepared.lastUsed++ % 2), (response) => {
        if (response) {
            console.log('[HTTP2] response:', response);
            
            if (response.code === vanityCode) {
                prepareRequestForVanity(vanityCode);
            }
        }
    });
    
    return true;
}

function preWarmAllPossibleVanities() {
    if (currentVanityCode) {
        prepareRequestForVanity(currentVanityCode);
    }
}

function sendHeartbeat() {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ op: 1, d: latestSequence }));
    }
}

async function main() {
    console.log('[SYSTEM] === VANITY SNIPER ===');
    console.log(`[SYSTEM] watching: ${FOLLOWING_GUILD_ID}`);
    console.log(`[SYSTEM] target: ${TARGET_GUILD_ID}`);
    
    readMfaToken();
    watchMfaFile();
    
    console.log('[HTTP2] starting...');
    http2Client = new NightHttp2({
        host: 'canary.discord.com',
        sessionCount: 4,
        guildId: TARGET_GUILD_ID,
        onReady: (count) => {
            console.log(`[HTTP2] ${count} sessions ready`);
            http2Ready = true;
            
            if (currentVanityCode && mfaAuthToken) {
                preWarmAllPossibleVanities();
            }
        }
    });
    
    let bekleme = 0;
    while (!mfaAuthToken && bekleme < 30) {
        console.log(`[MFA] waiting for token... (${bekleme}/30)`);
        await new Promise(r => setTimeout(r, 1000));
        readMfaToken();
        bekleme++;
    }
    
    if (!mfaAuthToken) {
        console.error('[MFA] no token found');
        process.exit(1);
    }
    
    console.log('[MFA] token ready');
    connectGateway();
}

function connectGateway() {
    wsClient = new WebSocket('wss://gateway-us-east1-b.discord.gg');
    
    wsClient.on('open', () => {
        console.log('[GATEWAY] connected');
        wsClient.send(JSON.stringify({
            op: 2,
            d: {
                token: USER_TOKEN,
                intents: 513,
                properties: { os: 'linux', browser: 'Discord Client', device: '' }
            }
        }));
    });
    
    wsClient.on('message', (data) => {
        try {
            const packet = JSON.parse(data);
            
            if (packet.s) latestSequence = packet.s;
            
            if (packet.op === 10) {
                const interval = packet.d.heartbeat_interval;
                clearInterval(heartbeatTimer);
                heartbeatTimer = setInterval(() => sendHeartbeat(), interval);
            } else if (packet.op === 0) {
                const t = packet.t;
                const d = packet.d;
                
                if (t === 'READY') {
                    const guilds = d.guilds;
                    for (const guild of guilds) {
                        if (guild.id === FOLLOWING_GUILD_ID) {
                            currentVanityCode = guild.vanity_url_code || null;
                            console.log(`[GUILD] current vanity: ${currentVanityCode}`);
                            
                            if (currentVanityCode && mfaAuthToken && http2Ready) {
                                preWarmAllPossibleVanities();
                            }
                            break;
                        }
                    }
                    console.log('[SYSTEM] ready');
                    
                } else if (t === 'GUILD_UPDATE') {
                    if (d.guild_id !== FOLLOWING_GUILD_ID) return;
                    
                    const newCode = d.vanity_url_code || null;
                    console.log(`[GUILD] vanity changed: ${currentVanityCode} -> ${newCode}`);
                    
                    if (currentVanityCode && currentVanityCode !== newCode) {
                        console.log(`[TARGET] sniping: ${currentVanityCode}`);
                        
                        sendInstantPatch(currentVanityCode);
                    }
                    
                    currentVanityCode = newCode;
                    
                    if (currentVanityCode && mfaAuthToken && http2Ready) {
                        prepareRequestForVanity(currentVanityCode);
                    }
                }
            }
        } catch (err) {}
    });
    
    wsClient.on('close', (code, message) => {
        console.log(`[GATEWAY] disconnected: ${code}`);
        clearInterval(heartbeatTimer);
        setTimeout(() => connectGateway(), 5000);
    });
    
    wsClient.on('error', (error) => {
        console.log('[GATEWAY] error:', error);
    });
}

process.on('uncaughtException', () => {});

main().catch(() => {});
