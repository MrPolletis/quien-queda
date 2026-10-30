/* ==========================================================================
   QUIÉN QUEDA? — MOTOR COMPLETO DE GAMIFICACIÓN, ESTADÍSTICAS Y CÁPSULA
   ========================================================================== */

const STORAGE_KEY = 'quien_queda_custom_v2';

// Configuración Supabase
const SUPABASE_URL = "https://gaedfzothousntkdszwi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_idxoK1zSmo_oFVMg_oG6LA_VIkJiB4b";
let supabaseClient = null;

try {
    if (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
} catch (err) {
    console.warn("Modo local activo:", err);
}

const SEASONS_CONFIG = {
    winter: { id: 'winter', name: 'Invierno', icon: '❄️', months: [12, 1, 2] },
    spring: { id: 'spring', name: 'Primavera', icon: '🌸', months: [3, 4, 5] },
    summer: { id: 'summer', name: 'Verano', icon: '☀️', months: [6, 7, 8] },
    autumn: { id: 'autumn', name: 'Otoño', icon: '🍂', months: [9, 10, 11] }
};

const MONTH_NAMES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];
const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DEFAULT_AVATARS = ['😎', '🔥', '🤠', '🦁', '⚡', '🦊', '👑', '⚽', '🍻', '🚀'];
const ROULETTE_COLORS = ['#ff6a00', '#7928ca', '#2ecc71', '#ff2a5f', '#f39c12', '#3498db', '#e74c3c', '#1abc9c'];

let appState = {
    currentAccount: null, // { username, name, password, totpSecret, avatar }
    accounts: {},         // username -> { username, name, password, totpSecret, avatar }
    activeGroupId: null,
    activeUserId: null,
    groups: []
};

function normalizeUsername(raw) {
    if (!raw) return '';
    return String(raw)
        .trim()
        .replace(/^@+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, '');
}

function formatHandle(username) {
    const clean = normalizeUsername(username);
    return clean ? `@${clean}` : '';
}

// ==========================================================================
// MOTOR OFICIAL TOTP (GOOGLE / MICROSOFT AUTHENTICATOR — RFC 6238 HMAC-SHA1)
// ==========================================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(length = 16) {
    const randomBytes = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(randomBytes);
    } else {
        for (let i = 0; i < length; i++) randomBytes[i] = Math.floor(Math.random() * 256);
    }
    let secret = '';
    for (let i = 0; i < length; i++) {
        secret += BASE32_ALPHABET[randomBytes[i] % 32];
    }
    return secret;
}

function base32ToBytes(base32) {
    const clean = String(base32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (let i = 0; i < clean.length; i++) {
        const val = BASE32_ALPHABET.indexOf(clean[i]);
        if (val >= 0) bits += val.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    return bytes;
}

async function computeTotpToken(secretBase32, stepOffset = 0) {
    try {
        const keyBytes = base32ToBytes(secretBase32);
        const epochSeconds = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epochSeconds / 30) + stepOffset;

        const counterBytes = new Uint8Array(8);
        let temp = counter;
        for (let i = 7; i >= 0; i--) {
            counterBytes[i] = temp & 0xff;
            temp = Math.floor(temp / 256);
        }

        const cryptoKey = await window.crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash: 'SHA-1' },
            false,
            ['sign']
        );
        const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
        const hmac = new Uint8Array(signature);
        const offset = hmac[hmac.length - 1] & 0x0f;
        const binary =
            ((hmac[offset] & 0x7f) << 24) |
            ((hmac[offset + 1] & 0xff) << 16) |
            ((hmac[offset + 2] & 0xff) << 8) |
            (hmac[offset + 3] & 0xff);
        return String(binary % 1000000).padStart(6, '0');
    } catch (e) {
        return null;
    }
}

async function verifyTotpCode(secretBase32, enteredCode) {
    const cleanCode = String(enteredCode || '').trim();
    if (!secretBase32 || !/^\d{6}$/.test(cleanCode)) return false;
    // Comprobar ventana actual y ±30 segundos por si el reloj del móvil va unos segundos adelantado/atrasado
    for (const offset of [-1, 0, 1]) {
        const token = await computeTotpToken(secretBase32, offset);
        if (token && token === cleanCode) return true;
    }
    return false;
}

function getOtpAuthUri(username, secretBase32) {
    const handle = formatHandle(username);
    return `otpauth://totp/${encodeURIComponent('QuienQueda:' + handle)}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent('QuienQueda')}&algorithm=SHA1&digits=6&period=30`;
}

// ==========================================================================
// REGISTRO GLOBAL DE @USUARIOS EN SUPABASE (PARA GARANTIZAR @ IRREPETIBLE)
// ==========================================================================
const CLOUD_ACCOUNTS_KEY = '__ACCOUNTS_REGISTRY__';

async function fetchCloudAccountsRegistry() {
    if (!supabaseClient) return {};
    try {
        const { data, error } = await supabaseClient
            .from('quien_queda_groups')
            .select('group_data')
            .eq('invite_code', CLOUD_ACCOUNTS_KEY)
            .maybeSingle();
        if (!error && data && data.group_data && data.group_data.accounts) {
            return data.group_data.accounts;
        }
    } catch (e) {
        // Modo local
    }
    return {};
}

async function saveAccountToCloudRegistry(account) {
    if (!account || !account.username) return;
    const u = normalizeUsername(account.username);
    if (!appState.accounts) appState.accounts = {};
    appState.accounts[u] = account;

    if (!supabaseClient) return;
    try {
        const remoteAccounts = await fetchCloudAccountsRegistry();
        remoteAccounts[u] = account;
        await supabaseClient
            .from('quien_queda_groups')
            .upsert({
                invite_code: CLOUD_ACCOUNTS_KEY,
                name: 'ACCOUNTS_REGISTRY',
                group_data: { accounts: remoteAccounts },
                updated_at: new Date().toISOString()
            }, { onConflict: 'invite_code' });
    } catch (e) {
        // Modo local
    }
}

async function findAccountByUsername(username) {
    const u = normalizeUsername(username);
    if (!u) return null;

    // 1. Buscar en cuentas globales de la nube si está online
    const cloudRegistry = await fetchCloudAccountsRegistry();
    if (cloudRegistry && cloudRegistry[u]) {
        if (!appState.accounts) appState.accounts = {};
        appState.accounts[u] = cloudRegistry[u];
        return cloudRegistry[u];
    }

    // 2. Buscar en cuentas locales guardadas
    if (appState.accounts && appState.accounts[u]) {
        return appState.accounts[u];
    }

    // 3. Buscar en integrantes de los grupos cargados
    for (const g of appState.groups || []) {
        const m = (g.members || []).find(mem => normalizeUsername(mem.username) === u && mem.password);
        if (m) {
            return {
                username: u,
                name: m.name,
                password: m.password,
                totpSecret: m.totpSecret || '',
                avatar: m.avatar || '😎'
            };
        }
    }
    return null;
}

// Estado temporal Onboarding
let onboardingDraftPhoto = '';
let onboardingDraftMembers = [];

// Estado temporal Ruleta
let rouletteOptions = [];
let rouletteAngle = 0;
let rouletteSpinning = false;
let rouletteWinnerText = '';

// Estado temporal Foto de Recuerdo (Cápsula del Tiempo)
let currentDraftMemoryPhoto = '';
let selectedCreateTag = 'General';

let currentTab = 'view-plans';
let currentPlanFilter = 'upcoming'; // 'upcoming' | 'pending_check' | 'completed'
let statsPeriodMode = 'month';      // 'month' | 'season' | 'year'
let selectedPeriodKey = null;

// ==========================================================================
// PERSISTENCIA Y NORMALIZACIÓN DE DATOS DEL GRUPO
// ==========================================================================
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.groups)) {
                appState = {
                    currentAccount: parsed.currentAccount && parsed.currentAccount.username ? parsed.currentAccount : null,
                    accounts: parsed.accounts || {},
                    activeGroupId: parsed.activeGroupId || null,
                    activeUserId: parsed.activeUserId || null,
                    customPublicUrl: parsed.customPublicUrl || '',
                    groups: parsed.groups
                };
                appState.groups.forEach(normalizeGroupStructure);
            }
        }
    } catch (e) {
        console.warn('Error leyendo estado local:', e);
    }
}

function normalizeGroupStructure(group) {
    if (!group.members) group.members = [];
    if (!group.plans) group.plans = [];
    ensureAtLeastOneAdmin(group);

    if (!group.customTags || !Array.isArray(group.customTags) || group.customTags.length === 0) {
        group.customTags = ['Tardeo', 'Cena', 'Deporte', 'Gaming', 'Paseo'];
    }
    if (!group.customExcuses || !Array.isArray(group.customExcuses)) {
        group.customExcuses = [
            'Me ha surgido un imprevisto',
            'Tengo compromiso familiar',
            'Estoy sin un duro este mes',
            'Tengo que madrugar mañana',
            'Me da pereza máxima salir hoy'
        ];
    }
    if (!group.customTitles) {
        group.customTitles = {
            mvp: 'El alma de la fiesta',
            zero: 'Secuestrado / Visto en línea',
            flake: 'Vende humos profesional',
            late: 'Llegando en 5 minutos'
        };
    }
}

// Regla WhatsApp: siempre debe haber mínimo 1 admin en el grupo
function ensureAtLeastOneAdmin(group) {
    if (!group.members || group.members.length === 0) return;
    const hasAdmin = group.members.some(m => m.isAdmin === true);
    if (!hasAdmin) {
        group.members[0].isAdmin = true;
    }
}

function saveState(syncToCloud = true) {
    const group = getActiveGroup();
    if (group) ensureAtLeastOneAdmin(group);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
        console.warn('No se pudo guardar en LocalStorage:', e);
    }
    if (syncToCloud) {
        pushActiveGroupToCloud();
    }
}

async function pushActiveGroupToCloud() {
    if (!supabaseClient) return;
    const group = getActiveGroup();
    if (!group || !group.inviteCode) return;

    try {
        const { error } = await supabaseClient
            .from('quien_queda_groups')
            .upsert({
                invite_code: group.inviteCode.toUpperCase(),
                name: group.name,
                group_data: group,
                updated_at: new Date().toISOString()
            }, { onConflict: 'invite_code' });

        if (!error) setCloudBadge(true);
    } catch (e) {
        // Silencioso en modo local
    }
}

async function fetchGroupFromCloudByCode(inviteCode) {
    if (!supabaseClient || !inviteCode) return null;
    try {
        const cleanCode = inviteCode.trim().toUpperCase();
        const { data, error } = await supabaseClient
            .from('quien_queda_groups')
            .select('group_data')
            .eq('invite_code', cleanCode)
            .maybeSingle();

        if (!error && data && data.group_data) {
            setCloudBadge(true);
            normalizeGroupStructure(data.group_data);
            return data.group_data;
        }
    } catch (e) {
        // Modo local
    }
    return null;
}

function setCloudBadge(online) {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;
    badge.textContent = online ? '● Online' : '● Local';
    badge.classList.toggle('online', online);
}

function getActiveGroup() {
    if (!appState.groups || appState.groups.length === 0) return null;
    return appState.groups.find(g => g.id === appState.activeGroupId) || appState.groups[0];
}

function getActiveUser() {
    const group = getActiveGroup();
    if (!group || !group.members || group.members.length === 0) return { id: 'none', name: 'Yo', avatar: '👤', isAdmin: true };
    return group.members.find(m => m.id === appState.activeUserId) || group.members[0];
}

function getMemberById(memberId) {
    const group = getActiveGroup();
    if (!group) return { id: memberId, name: 'Integrante', avatar: '👤' };
    return group.members.find(m => m.id === memberId) || { id: memberId, name: 'Integrante', avatar: '👤' };
}

function isLocalEnvironment() {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    return proto === 'file:' || host === 'localhost' || host === '127.0.0.1' || !host;
}

const DEFAULT_PUBLIC_WEB_URL = 'https://mrpolletis.github.io/quien-queda';

// Convierte cualquier URL o reemplaza enlaces de panel de Netlify que piden cuenta por la web pública abierta
function normalizePublicBaseUrl(rawUrl) {
    if (!rawUrl) return DEFAULT_PUBLIC_WEB_URL;
    let clean = rawUrl.trim().split('?')[0].replace(/\/+$/, '');
    if (!clean) return DEFAULT_PUBLIC_WEB_URL;

    // Si es el proyecto sin reclamar de Netlify Drop que pide cuenta o un enlace interno de app.netlify.com
    if (clean.includes('ephemeral-sunshine-4cf14b') || clean.includes('app.netlify.com')) {
        return DEFAULT_PUBLIC_WEB_URL;
    }

    if (!/^https?:\/\//i.test(clean) && !clean.includes('.') && !clean.includes('localhost')) {
        clean = `https://${clean}.netlify.app`;
    } else if (!/^https?:\/\//i.test(clean)) {
        clean = `https://${clean}`;
    }
    return clean.replace(/\/+$/, '');
}

function getCleanPublicGroupPayload(group) {
    return {
        id: group.id,
        name: group.name,
        description: group.description || '',
        emoji: group.emoji || '👥',
        photo: group.photo || '',
        inviteCode: group.inviteCode,
        members: (group.members || []).map(m => ({
            id: m.id,
            name: m.name,
            avatar: m.avatar || '😎',
            isAdmin: !!m.isAdmin,
            username: m.username || ''
        })),
        customTags: group.customTags,
        customExcuses: group.customExcuses,
        customTitles: group.customTitles,
        plans: group.plans || []
    };
}

async function uploadGroupSnapshotForShortLink(group) {
    try {
        const payload = getCleanPublicGroupPayload(group);
        const res = await fetch('https://bytebin.lucko.me/post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.key) {
                group.lastCloudKey = data.key;
                return data.key;
            }
        }
    } catch (e) {
        // Fallback silencioso
    }
    return group.lastCloudKey || null;
}

async function fetchGroupFromShortKey(key) {
    if (!key) return null;
    try {
        const res = await fetch(`https://bytebin.lucko.me/${encodeURIComponent(key.trim())}`);
        if (res.ok) {
            const parsed = await res.json();
            if (parsed && parsed.name && Array.isArray(parsed.members)) {
                normalizeGroupStructure(parsed);
                return parsed;
            }
        }
    } catch (e) {
        console.warn('No se pudo descargar snapshot corto:', e);
    }
    return null;
}

function encodeGroupPack(group) {
    try {
        // Formato ultracompacto [v1, inviteCode, name, desc, emoji, members[[id, name, avatar, isAdmin, username]], plans]
        // NUNCA incluye contraseñas ni claves TOTP en el enlace compartido
        const compact = [
            1,
            group.inviteCode || 'GRUP01',
            group.name || 'Grupo',
            group.description || '',
            group.emoji || '👥',
            (group.members || []).map(m => [
                m.id,
                m.name,
                m.avatar || '😎',
                m.isAdmin ? 1 : 0,
                m.username || ''
            ]),
            (group.plans || []).slice(0, 10).map(p => ({
                id: p.id,
                t: p.title,
                g: p.tag,
                d: p.date,
                tm: p.time,
                l: p.location,
                n: p.notes || '',
                c: p.createdBy,
                v: p.votingOpen ? 1 : 0,
                ok: p.completed ? 1 : 0,
                pr: p.proposals || [],
                at: p.attendance || {},
                ex: p.excuses || {},
                fl: p.flakes || {},
                lt: p.lateMemberId || null,
                mq: p.memoryQuote || ''
            }))
        ];
        const json = JSON.stringify(compact);
        const utf8Bytes = unescape(encodeURIComponent(json));
        return btoa(utf8Bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) {
        return '';
    }
}

function decodeGroupPack(packStr) {
    try {
        if (!packStr) return null;
        // Soporte para formato ultracompacto URL-safe y para enlaces antiguos
        let b64 = packStr.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';

        let json = '';
        try {
            json = decodeURIComponent(escape(atob(b64)));
        } catch (innerErr) {
            json = decodeURIComponent(atob(packStr));
        }

        const parsed = JSON.parse(json);

        // Formato compacto v1 (array)
        if (Array.isArray(parsed) && parsed[0] === 1) {
            const rebuilt = {
                id: 'g_' + parsed[1],
                inviteCode: parsed[1],
                name: parsed[2],
                description: parsed[3] || '',
                emoji: parsed[4] || '👥',
                members: (parsed[5] || []).map(arr => ({
                    id: arr[0] || ('u_' + Math.random().toString(36).slice(2, 8)),
                    name: arr[1] || 'Integrante',
                    avatar: arr[2] || '😎',
                    isAdmin: arr[3] === 1,
                    username: arr[4] || ''
                })),
                plans: (parsed[6] || []).map(p => ({
                    id: p.id,
                    title: p.t,
                    tag: p.g,
                    date: p.d,
                    time: p.tm,
                    location: p.l,
                    notes: p.n,
                    createdBy: p.c,
                    votingOpen: !!p.v,
                    completed: !!p.ok,
                    proposals: p.pr || [],
                    attendance: p.at || {},
                    excuses: p.ex || {},
                    flakes: p.fl || {},
                    lateMemberId: p.lt || null,
                    memoryQuote: p.mq || ''
                }))
            };
            normalizeGroupStructure(rebuilt);
            return rebuilt;
        }

        // Compatibilidad con formato antiguo (objeto)
        if (parsed && parsed.name && Array.isArray(parsed.members)) {
            parsed.members.forEach(m => {
                delete m.password;
                delete m.totpSecret;
            });
            normalizeGroupStructure(parsed);
            return parsed;
        }
    } catch (e) {
        console.warn('No se pudo decodificar pack de URL:', e);
    }
    return null;
}

function getPublicBaseUrl() {
    if (!isLocalEnvironment() && !window.location.hostname.includes('netlify')) {
        return `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, '');
    }
    if (appState.customPublicUrl && appState.customPublicUrl.trim()) {
        return normalizePublicBaseUrl(appState.customPublicUrl);
    }
    return DEFAULT_PUBLIC_WEB_URL;
}

function getGroupInviteUrl(group) {
    const baseUrl = getPublicBaseUrl();
    if (group.lastShortUrl) {
        return group.lastShortUrl;
    }
    if (group.lastCloudKey) {
        return `${baseUrl}/?k=${encodeURIComponent(group.lastCloudKey)}`;
    }
    const pack = encodeGroupPack(group);
    return `${baseUrl}/?grupo=${encodeURIComponent(group.inviteCode)}${pack ? `&pack=${pack}` : ''}`;
}

async function prepareShortGroupInviteUrl(group) {
    const baseUrl = getPublicBaseUrl();
    const key = await uploadGroupSnapshotForShortLink(group);
    if (key) {
        const cleanKeyUrl = `${baseUrl}/?k=${encodeURIComponent(key)}`;
        group.lastShortUrl = cleanKeyUrl;
        return cleanKeyUrl;
    }
    return getGroupInviteUrl(group);
}

// ==========================================================================
// COMPRESIÓN DE IMÁGENES (FOTOS DE GRUPO Y CÁPSULA DEL TIEMPO)
// ==========================================================================
function readAndCompressImage(file, maxSize, callback) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            let w = img.width;
            let h = img.height;
            if (w > h) {
                if (w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; }
            } else {
                if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; }
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            callback(canvas.toDataURL('image/jpeg', 0.78));
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// ==========================================================================
// UTILIDADES DE FECHA, TIEMPO RESTANTE Y ESTADOS DE QUEDADA
// ==========================================================================
function getPlanStartDateObj(plan) {
    const [y, m, d] = (plan.date || '2099-01-01').split('-').map(Number);
    const [hh, mm] = (plan.time || '20:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh || 20, mm || 0);
}

function getHoursUntilPlan(plan) {
    const start = getPlanStartDateObj(plan);
    const now = new Date();
    return (start.getTime() - now.getTime()) / (1000 * 60 * 60);
}

function getPlanLifecycleState(plan) {
    if (plan.completed) return 'completed';
    const start = getPlanStartDateObj(plan);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    if (new Date() >= end || plan.pendingAttendanceCheck) {
        return 'pending_check';
    }
    return 'upcoming';
}

function checkPendingFinishedHangouts() {
    const group = getActiveGroup();
    if (!group) return;

    const pendingPlans = group.plans.filter(p => getPlanLifecycleState(p) === 'pending_check');
    const banner = document.getElementById('finished-hangout-banner');
    const badge = document.getElementById('notif-pending-count');

    if (pendingPlans.length > 0) {
        badge.textContent = pendingPlans.length;
        badge.classList.remove('hidden');

        const firstPending = pendingPlans[0];
        document.getElementById('finished-banner-title').textContent = `🔔 "${firstPending.title}" ha finalizado`;
        document.getElementById('finished-banner-sub').textContent = pendingPlans.length === 1
            ? 'Toca para confirmar asistencia, puntualidad y foto de prueba'
            : `Tienes ${pendingPlans.length} quedadas pendientes de pasar lista`;
        banner.classList.remove('hidden');
        banner.dataset.planId = firstPending.id;

        if (!firstPending.notifiedFinish) {
            firstPending.notifiedFinish = true;
            saveState(false);
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('🔔 ¿Quiénes han asistido?', {
                    body: `La quedada "${firstPending.title}" ha terminado. Pasa lista y sube la foto del recuerdo.`
                });
            }
        }
    } else {
        badge.classList.add('hidden');
        banner.classList.add('hidden');
    }
}

function toIsoDateString(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getDateForPreset(preset) {
    const d = new Date();
    if (preset === 'today') return toIsoDateString(d);
    if (preset === 'tomorrow') {
        d.setDate(d.getDate() + 1);
        return toIsoDateString(d);
    }
    if (preset === 'weekend') {
        const day = d.getDay();
        const diff = day === 6 ? 0 : (6 - day + 7) % 7;
        d.setDate(d.getDate() + diff);
        return toIsoDateString(d);
    }
    return toIsoDateString(d);
}

function getSeasonFromDateStr(dateStr) {
    const [, monthStr] = (dateStr || '2026-01-01').split('-');
    const month = parseInt(monthStr, 10);
    if ([3, 4, 5].includes(month)) return SEASONS_CONFIG.spring;
    if ([6, 7, 8].includes(month)) return SEASONS_CONFIG.summer;
    if ([9, 10, 11].includes(month)) return SEASONS_CONFIG.autumn;
    return SEASONS_CONFIG.winter;
}

function formatHumanDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return `${days[dateObj.getDay()]} ${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

function showToast(msg) {
    const toast = document.getElementById('toast-notification');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ==========================================================================
// CÁLCULO DE RACHAS DE ASISTENCIA (STREAKS)
// ==========================================================================
function computeStreaksForGroup(group) {
    const streaks = {};
    group.members.forEach(m => {
        streaks[m.id] = { current: 0, max: 0 };
    });

    // Ordenar quedadas cronológicamente (de más antigua a más reciente)
    const chronologicalPlans = [...group.plans].sort((a, b) => a.date.localeCompare(b.date));

    chronologicalPlans.forEach(plan => {
        group.members.forEach(m => {
            const st = plan.attendance ? plan.attendance[m.id] : null;
            if (st === 'yes') {
                streaks[m.id].current += 1;
                if (streaks[m.id].current > streaks[m.id].max) {
                    streaks[m.id].max = streaks[m.id].current;
                }
            } else if (plan.completed || st === 'no') {
                streaks[m.id].current = 0;
            }
        });
    });

    return streaks;
}

function getStreakVisuals(streakCount) {
    if (streakCount >= 10) {
        return { borderClass: 'streak-border-10', badgeHtml: `<span class="streak-pill">👑🔥x${streakCount}</span>` };
    }
    if (streakCount >= 5) {
        return { borderClass: 'streak-border-5', badgeHtml: `<span class="streak-pill">🔥🔥x${streakCount}</span>` };
    }
    if (streakCount >= 3) {
        return { borderClass: 'streak-border-3', badgeHtml: `<span class="streak-pill">🔥x${streakCount}</span>` };
    }
    if (streakCount >= 1) {
        return { borderClass: '', badgeHtml: `<span style="font-size:10px; color:var(--text-muted);">🔥${streakCount}</span>` };
    }
    return { borderClass: '', badgeHtml: '' };
}

// ==========================================================================
// RENDERIZADO PRINCIPAL
// ==========================================================================
function renderApp() {
    const authEl = document.getElementById('auth-screen');
    const onboardingEl = document.getElementById('onboarding-screen');

    if (!appState.currentAccount || !appState.currentAccount.username) {
        if (authEl) authEl.classList.remove('hidden');
        if (onboardingEl) onboardingEl.classList.add('hidden');
        return;
    }

    if (authEl) authEl.classList.add('hidden');

    const group = getActiveGroup();

    if (!group) {
        onboardingEl.classList.remove('hidden');
        if (onboardingDraftMembers.length === 0 && appState.currentAccount) {
            onboardingDraftMembers.push({
                id: 'u_' + Date.now(),
                name: appState.currentAccount.name,
                avatar: appState.currentAccount.avatar || '😎',
                username: appState.currentAccount.username,
                password: appState.currentAccount.password,
                totpSecret: appState.currentAccount.totpSecret || '',
                isAdmin: true
            });
        }
        renderOnboardingDraftMembers();
        return;
    }

    normalizeGroupStructure(group);

    // Si hay un integrante cuyo @usuario coincide con la cuenta actual, seleccionarlo automáticamente
    const myUsername = normalizeUsername(appState.currentAccount.username);
    const matchedByUsername = group.members.find(m => m.username && normalizeUsername(m.username) === myUsername);
    if (matchedByUsername) {
        const currentSelected = group.members.find(m => m.id === appState.activeUserId);
        if (!currentSelected || (currentSelected.username && normalizeUsername(currentSelected.username) !== myUsername)) {
            appState.activeUserId = matchedByUsername.id;
        }
    }

    onboardingEl.classList.add('hidden');
    checkPendingFinishedHangouts();
    renderHeader();
    renderPlansView();
    renderStatsView();
    renderGroupView();
}

function renderOnboardingDraftMembers() {
    const container = document.getElementById('onboarding-members-chips');
    if (onboardingDraftMembers.length === 0) {
        container.innerHTML = `<span style="font-size:11.5px; color:var(--text-dim);">Aún no has añadido integrantes. El primero será Admin.</span>`;
        return;
    }
    container.innerHTML = onboardingDraftMembers.map((m, idx) => `
        <span class="member-chip-tag">
            <span>${m.avatar} ${escapeHtml(m.name)} ${idx === 0 || m.isAdmin ? '👑' : ''} ${m.username ? `<small style="opacity:0.8; color:#ff9a3c;">(${escapeHtml(formatHandle(m.username))})</small>` : ''}</span>
            <button type="button" class="member-chip-remove" data-remove-draft-idx="${idx}" title="Quitar">&times;</button>
        </span>
    `).join('');
}

function renderHeader() {
    const group = getActiveGroup();
    const user = getActiveUser();

    const emojiEl = document.getElementById('header-group-emoji');
    const imgEl = document.getElementById('header-group-img');

    if (group.photo) {
        imgEl.src = group.photo;
        imgEl.classList.remove('hidden');
        emojiEl.classList.add('hidden');
    } else {
        imgEl.classList.add('hidden');
        emojiEl.classList.remove('hidden');
        emojiEl.textContent = group.emoji || '👥';
    }

    document.getElementById('header-group-name').textContent = group.name;
    document.getElementById('active-user-avatar').textContent = user.avatar;
    document.getElementById('active-user-name').textContent =
        user.name + (user.isAdmin ? ' 👑' : '') + (user.username ? ` (${formatHandle(user.username)})` : '');
}

// ==========================================================================
// VISTA 1: QUEDADAS
// ==========================================================================
function renderPlansView() {
    const group = getActiveGroup();
    const activeUser = getActiveUser();
    const streaks = computeStreaksForGroup(group);

    const sortedPlans = [...group.plans].sort((a, b) => b.date.localeCompare(a.date));

    const upcomingPlans = sortedPlans.filter(p => getPlanLifecycleState(p) === 'upcoming').sort((a, b) => a.date.localeCompare(b.date));
    const pendingPlans = sortedPlans.filter(p => getPlanLifecycleState(p) === 'pending_check');
    const completedPlans = sortedPlans.filter(p => getPlanLifecycleState(p) === 'completed');

    document.getElementById('count-upcoming').textContent = upcomingPlans.length;
    document.getElementById('count-pending').textContent = pendingPlans.length;
    document.getElementById('count-past').textContent = completedPlans.length;

    let listToRender = upcomingPlans;
    if (currentPlanFilter === 'pending_check') listToRender = pendingPlans;
    if (currentPlanFilter === 'completed') listToRender = completedPlans;

    const listEl = document.getElementById('plans-list');
    if (listToRender.length === 0) {
        const emptyMessages = {
            upcoming: 'No hay quedadas activas.<br>Pulsa en <strong>Crear Quedada</strong> para elegir día, hora, lugar y etiqueta.',
            pending_check: 'No hay quedadas pendientes de pasar lista.',
            completed: 'Aún no hay quedadas cerradas. Al finalizar una quedada podrás subir la foto de prueba y verla aquí.'
        };
        listEl.innerHTML = `
            <div class="empty-state">
                <div style="font-size: 32px; margin-bottom: 8px;">📅</div>
                ${emptyMessages[currentPlanFilter]}
            </div>
        `;
        return;
    }

    listEl.innerHTML = listToRender.map(plan => renderPlanCardHTML(plan, group, activeUser, streaks)).join('');
}

function renderPlanCardHTML(plan, group, activeUser, streaks) {
    const creator = getMemberById(plan.createdBy);
    const season = getSeasonFromDateStr(plan.date);
    const state = getPlanLifecycleState(plan);
    const myStatus = (plan.attendance && plan.attendance[activeUser.id]) || null;

    const yesMembers = [];
    const maybeMembers = [];
    const noMembers = [];

    group.members.forEach(m => {
        const st = plan.attendance ? plan.attendance[m.id] : null;
        if (st === 'yes') yesMembers.push(m);
        else if (st === 'maybe') maybeMembers.push(m);
        else if (st === 'no') noMembers.push(m);
    });

    let statusPillHTML = `<span class="plan-status-pill active">⏳ Activa</span>`;
    if (state === 'pending_check') {
        statusPillHTML = `<span class="plan-status-pill pending">🔔 Pendiente pasar lista</span>`;
    } else if (state === 'completed') {
        statusPillHTML = `<span class="plan-status-pill done">✅ Cerrada</span>`;
    }

    // Mostrar propuestas de hora/lugar si están abiertas
    let votingHTML = '';
    if (plan.votingOpen && state === 'upcoming') {
        const proposals = plan.proposals || [];
        const proposalsItemsHTML = proposals.map(prop => {
            const hasVoted = prop.votes && prop.votes.includes(activeUser.id);
            const author = getMemberById(prop.authorId);
            return `
                <div class="proposal-item ${hasVoted ? 'voted' : ''}" data-action="toggle-vote" data-plan-id="${plan.id}" data-prop-id="${prop.id}">
                    <div>
                        <span class="proposal-main">⏰ ${escapeHtml(prop.time)} · 📍 ${escapeHtml(prop.location)}</span>
                        <span class="proposal-sub">Por ${escapeHtml(author.name)}${prop.reason ? ` — "${escapeHtml(prop.reason)}"` : ''}</span>
                    </div>
                    <div class="proposal-votes-pill">
                        ${hasVoted ? '✅' : '👍'} ${(prop.votes || []).length}
                    </div>
                </div>
            `;
        }).join('');

        votingHTML = `
            <div class="voting-section">
                <div class="voting-header">
                    <span class="voting-title">🗳️ Propuestas de Hora y Lugar</span>
                    <button class="btn-link-mini" data-action="open-add-proposal" data-plan-id="${plan.id}">+ Añadir otra</button>
                </div>
                ${proposalsItemsHTML}
                <div class="voting-footer-actions">
                    <button class="btn-voting-action" data-action="open-add-proposal" data-plan-id="${plan.id}">➕ Proponer hora/sitio</button>
                    <button class="btn-voting-action confirm" data-action="close-voting" data-plan-id="${plan.id}">🔒 Fijar más votada</button>
                </div>
            </div>
        `;
    }

    // Mostrar excusas registradas en esta quedada
    const excusesEntries = Object.entries(plan.excuses || {});
    let excusesHTML = '';
    if (excusesEntries.length > 0) {
        excusesHTML = `
            <div style="margin-top:8px; font-size:11px; color:var(--text-muted); background:rgba(255,71,87,0.06); padding:7px 10px; border-radius:9px;">
                ${excusesEntries.map(([uid, exc]) => {
                    const m = getMemberById(uid);
                    const isFlake = plan.flakes && plan.flakes[uid];
                    return `<div>🤥 <strong>${escapeHtml(m.name)}</strong>: "${escapeHtml(exc)}" ${isFlake ? '<span style="color:#ff4757; font-weight:800;">(👻 Flake)</span>' : ''}</div>`;
                }).join('')}
            </div>
        `;
    }

    // Mostrar Cápsula del Tiempo si tiene foto o frase mítica
    let memoryHTML = '';
    if (plan.memoryPhoto || plan.memoryQuote || plan.lateMemberId) {
        const lateMember = plan.lateMemberId ? getMemberById(plan.lateMemberId) : null;
        memoryHTML = `
            <div class="plan-memory-box">
                ${plan.memoryPhoto ? `<img src="${plan.memoryPhoto}" class="plan-memory-thumb" alt="Foto recuerdo">` : ''}
                <div style="flex:1;">
                    ${plan.memoryQuote ? `<div style="font-size:12px; font-weight:700; color:#ff9a3c;">📸 "${escapeHtml(plan.memoryQuote)}"</div>` : ''}
                    ${lateMember ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">🐢 Llegó el último: <strong>${escapeHtml(lateMember.name)}</strong></div>` : ''}
                </div>
            </div>
        `;
    }

    return `
        <article class="plan-card ${state === 'pending_check' ? 'pending-confirm' : ''} ${state === 'completed' ? 'completed-card' : ''}">
            <div class="plan-card-top">
                <div style="display:flex; gap:6px; align-items:center;">
                    ${statusPillHTML}
                    ${plan.tag ? `<span class="plan-status-pill" style="background:rgba(255,255,255,0.07); color:#fff;">🏷️ ${escapeHtml(plan.tag)}</span>` : ''}
                </div>
                <span class="plan-season-tag">${season.icon} ${season.name}</span>
            </div>

            <h3 class="plan-title">${escapeHtml(plan.title)}</h3>
            <div class="plan-creator">Creada por <strong>${creator.avatar} ${escapeHtml(creator.name)}</strong></div>

            <div class="plan-datetime-box">
                <div class="plan-dt-row">📅 ${formatHumanDate(plan.date)} · ⏰ <strong>${escapeHtml(plan.time)}</strong></div>
                <div class="plan-dt-row">📍 ${escapeHtml(plan.location)}</div>
            </div>

            ${plan.notes ? `<div class="plan-notes">"${escapeHtml(plan.notes)}"</div>` : ''}

            ${votingHTML}

            <div class="rsvp-buttons-row">
                <button class="rsvp-btn yes ${myStatus === 'yes' ? 'selected' : ''}" data-action="rsvp" data-plan-id="${plan.id}" data-status="yes">
                    ✅ Voy (${yesMembers.length})
                </button>
                <button class="rsvp-btn maybe ${myStatus === 'maybe' ? 'selected' : ''}" data-action="rsvp" data-plan-id="${plan.id}" data-status="maybe">
                    🤔 Duda (${maybeMembers.length})
                </button>
                <button class="rsvp-btn no ${myStatus === 'no' ? 'selected' : ''}" data-action="rsvp" data-plan-id="${plan.id}" data-status="no">
                    ❌ No voy (${noMembers.length})
                </button>
            </div>

            <div class="attendees-breakdown">
                <div class="attendees-pills">
                    ${yesMembers.map(m => {
                        const sv = getStreakVisuals(streaks[m.id]?.current || 0);
                        return `<span class="attendee-chip status-yes">✅ ${escapeHtml(m.name)} ${sv.badgeHtml}</span>`;
                    }).join('')}
                    ${maybeMembers.map(m => `<span class="attendee-chip status-maybe">🤔 ${escapeHtml(m.name)}</span>`).join('')}
                    ${noMembers.map(m => `<span class="attendee-chip status-no">❌ ${escapeHtml(m.name)}</span>`).join('')}
                </div>
                ${excusesHTML}
                ${memoryHTML}
            </div>

            <div class="plan-card-footer-tools">
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="btn-finish-hangout" data-action="open-confirm-attendance" data-plan-id="${plan.id}">
                        ${state === 'completed' ? '📸 Editar cierre / recuerdo' : '🔔 Finalizar y pasar lista'}
                    </button>
                    <button class="btn-wa-share-plan" data-action="share-plan-wa" data-plan-id="${plan.id}">
                        📲 WhatsApp
                    </button>
                </div>
                <button class="btn-delete-plan" data-action="delete-plan" data-plan-id="${plan.id}" title="Eliminar quedada">
                    🗑️
                </button>
            </div>
        </article>
    `;
}

// ==========================================================================
// MODAL DE CIERRE DE QUEDADA (PASE DE LISTA + FANTASMETRO + PUNTUALIDAD + FOTO)
// ==========================================================================
function openConfirmAttendanceModal(planId) {
    const group = getActiveGroup();
    if (!group) return;
    const plan = group.plans.find(p => p.id === planId);
    if (!plan) return;

    // Guardar foto de quién había dicho "yes" antes del pase de lista para detectar Flakes
    if (!plan.rsvpBeforeFinish) {
        plan.rsvpBeforeFinish = { ...(plan.attendance || {}) };
    }

    document.getElementById('confirm-attendance-plan-id').value = plan.id;
    document.getElementById('confirm-attendance-plan-title').textContent = `${plan.title} · ${formatHumanDate(plan.date)}`;

    if (!plan.attendance) plan.attendance = {};
    renderConfirmAttendanceModalRows(plan);

    // Rellenar selector de puntualidad ("¿Quién llegó el último?")
    const lateSelect = document.getElementById('confirm-late-member-select');
    lateSelect.innerHTML = `<option value="">Nadie / Todos puntuales</option>` +
        group.members.map(m => `<option value="${m.id}" ${plan.lateMemberId === m.id ? 'selected' : ''}>🐢 ${escapeHtml(m.name)}</option>`).join('');

    // Cargar foto de prueba y frase mítica si ya existían
    currentDraftMemoryPhoto = plan.memoryPhoto || '';
    const previewImg = document.getElementById('memory-photo-preview');
    const placeholder = document.getElementById('memory-photo-placeholder');
    if (currentDraftMemoryPhoto) {
        previewImg.src = currentDraftMemoryPhoto;
        previewImg.classList.remove('hidden');
        placeholder.classList.add('hidden');
    } else {
        previewImg.classList.add('hidden');
        placeholder.classList.remove('hidden');
    }
    document.getElementById('confirm-memory-quote-input').value = plan.memoryQuote || '';

    document.getElementById('modal-confirm-attendance').classList.remove('hidden');
}

function renderConfirmAttendanceModalRows(plan) {
    const group = getActiveGroup();
    const listEl = document.getElementById('confirm-attendance-members-list');
    listEl.innerHTML = group.members.map(m => {
        const st = plan.attendance[m.id] === 'yes' ? 'yes' : 'no';
        const promisedYes = plan.rsvpBeforeFinish && plan.rsvpBeforeFinish[m.id] === 'yes';
        return `
            <div class="attendance-member-row">
                <div>
                    <div style="display:flex; align-items:center; gap:6px; font-weight:700; font-size:13px;">
                        <span>${m.avatar}</span>
                        <span>${escapeHtml(m.name)}</span>
                    </div>
                    ${promisedYes && st === 'no' ? `<span style="font-size:10px; color:#ff4757; font-weight:800;">👻 Dijo que iba (+1 Fantasmetro)</span>` : ''}
                </div>
                <div class="mini-rsvp-group">
                    <button type="button" class="mini-rsvp-btn yes ${st === 'yes' ? 'active' : ''}" data-action="confirm-row-toggle" data-plan-id="${plan.id}" data-member-id="${m.id}" data-status="yes">
                        ✅ Asistió
                    </button>
                    <button type="button" class="mini-rsvp-btn no ${st === 'no' ? 'active' : ''}" data-action="confirm-row-toggle" data-plan-id="${plan.id}" data-member-id="${m.id}" data-status="no">
                        ❌ No vino
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// ==========================================================================
// RULETA DE INDECISOS (CANVAS INTERACTIVO)
// ==========================================================================
function openRouletteModal() {
    if (rouletteOptions.length === 0) {
        rouletteOptions = ['Terraza / Cañas', 'Hamburguesería', 'Pizzería', 'Casa de alguien'];
    }
    rouletteWinnerText = '';
    document.getElementById('roulette-winner-banner').classList.add('hidden');
    document.getElementById('btn-use-roulette-winner').classList.add('hidden');
    renderRouletteOptionsChips();
    drawRouletteWheel();
    document.getElementById('modal-roulette').classList.remove('hidden');
}

function renderRouletteOptionsChips() {
    const container = document.getElementById('roulette-options-chips');
    container.innerHTML = rouletteOptions.map((opt, idx) => `
        <span class="member-chip-tag">
            <span>${escapeHtml(opt)}</span>
            <button type="button" class="member-chip-remove" data-remove-roulette-idx="${idx}">&times;</button>
        </span>
    `).join('');
}

function drawRouletteWheel() {
    const canvas = document.getElementById('roulette-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = cx - 8;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const n = Math.max(rouletteOptions.length, 1);
    const arc = (2 * Math.PI) / n;

    for (let i = 0; i < n; i++) {
        const startAngle = rouletteAngle + i * arc;
        const endAngle = startAngle + arc;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = ROULETTE_COLORS[i % ROULETTE_COLORS.length];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#10131c';
        ctx.stroke();

        // Texto de cada porción
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(startAngle + arc / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Montserrat, sans-serif';
        const label = (rouletteOptions[i] || 'Opción').slice(0, 16);
        ctx.fillText(label, radius - 12, 4);
        ctx.restore();
    }

    // Círculo central
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, 2 * Math.PI);
    ctx.fillStyle = '#171b28';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
}

function spinRouletteWheel() {
    if (rouletteSpinning || rouletteOptions.length < 2) {
        if (rouletteOptions.length < 2) showToast('⚠️ Añade al menos 2 opciones a la ruleta');
        return;
    }
    rouletteSpinning = true;
    document.getElementById('roulette-winner-banner').classList.add('hidden');
    document.getElementById('btn-use-roulette-winner').classList.add('hidden');

    const startAngle = rouletteAngle;
    const extraSpins = (5 + Math.random() * 4) * 2 * Math.PI;
    const duration = 3200;
    const startTime = performance.now();

    function animate(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const easeOut = 1 - Math.pow(1 - t, 3);
        rouletteAngle = startAngle + extraSpins * easeOut;
        drawRouletteWheel();

        if (t < 1) {
            requestAnimationFrame(animate);
        } else {
            rouletteSpinning = false;
            // El puntero está arriba en -PI/2 (270 grados)
            const n = rouletteOptions.length;
            const arc = (2 * Math.PI) / n;
            const pointerAngle = (1.5 * Math.PI - (rouletteAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            const winnerIdx = Math.floor(pointerAngle / arc) % n;
            rouletteWinnerText = rouletteOptions[winnerIdx];

            const banner = document.getElementById('roulette-winner-banner');
            banner.textContent = `🎉 ¡Ha salido: "${rouletteWinnerText}"!`;
            banner.classList.remove('hidden');
            document.getElementById('btn-use-roulette-winner').classList.remove('hidden');
        }
    }

    requestAnimationFrame(animate);
}

// ==========================================================================
// VISTA 2: ESTADÍSTICAS COMPLETAS (GRÁFICOS, FANTASMETRO, EXCUSÓMETRO, DÚOS, HEATMAP Y CÁPSULA)
// ==========================================================================
function getAvailablePeriods(plans) {
    const now = new Date();
    const currentYear = String(now.getFullYear());
    const currentMonth = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentSeason = `${currentYear}-${getSeasonFromDateStr(toIsoDateString(now)).id}`;

    const monthsSet = new Set([currentMonth]);
    const seasonsSet = new Set([currentSeason]);
    const yearsSet = new Set([currentYear]);

    plans.forEach(p => {
        if (!p.date) return;
        const [y, m] = p.date.split('-');
        monthsSet.add(`${y}-${m}`);
        const season = getSeasonFromDateStr(p.date);
        seasonsSet.add(`${y}-${season.id}`);
        yearsSet.add(y);
    });

    const months = Array.from(monthsSet).sort().reverse().map(key => {
        const [y, m] = key.split('-');
        return { key, label: `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}` };
    });

    const seasonOrder = ['autumn', 'summer', 'spring', 'winter'];
    const seasons = Array.from(seasonsSet).map(key => {
        const [y, sId] = key.split('-');
        const cfg = SEASONS_CONFIG[sId] || SEASONS_CONFIG.autumn;
        return { key, label: `${cfg.icon} ${cfg.name} ${y}` };
    }).sort((a, b) => {
        const [yA, sA] = a.key.split('-');
        const [yB, sB] = b.key.split('-');
        if (yA !== yB) return yB.localeCompare(yA);
        return seasonOrder.indexOf(sA) - seasonOrder.indexOf(sB);
    });

    const years = Array.from(yearsSet).sort().reverse().map(y => ({
        key: y,
        label: `🏆 Año ${y}`
    }));

    return { months, seasons, years };
}

function filterPlansByPeriod(plans, mode, key) {
    return plans.filter(p => {
        if (!p.date) return false;
        const [y, m] = p.date.split('-');
        if (mode === 'month') return `${y}-${m}` === key;
        if (mode === 'season') {
            const [targetYear, targetSeasonId] = key.split('-');
            const s = getSeasonFromDateStr(p.date);
            return y === targetYear && s.id === targetSeasonId;
        }
        if (mode === 'year') return y === key;
        return true;
    });
}

function computeFullPeriodStats(plans, group) {
    const members = group.members;
    const totalPlans = plans.length;
    const streaks = computeStreaksForGroup(group);

    const memberStats = members.map(m => ({
        member: m,
        attended: 0,
        missed: 0,
        flakes: 0,
        lateCount: 0,
        rate: 0,
        currentStreak: streaks[m.id]?.current || 0,
        maxStreak: streaks[m.id]?.max || 0
    }));

    const statsMap = {};
    memberStats.forEach(ms => { statsMap[ms.member.id] = ms; });

    let totalAttendances = 0;
    const placesCount = {};
    const excusesCount = {};
    const tagsStats = {};
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0]; // Lun(0) .. Dom(6)

    plans.forEach(p => {
        if (p.location) {
            placesCount[p.location] = (placesCount[p.location] || 0) + 1;
        }
        if (p.date) {
            const [y, m, d] = p.date.split('-').map(Number);
            const jsDay = new Date(y, m - 1, d).getDay(); // 0=Dom .. 6=Sab
            const monIdx = (jsDay + 6) % 7; // 0=Lun .. 6=Dom
            weekdayCounts[monIdx] += 1;
        }

        const tagKey = p.tag || 'General';
        if (!tagsStats[tagKey]) tagsStats[tagKey] = { tag: tagKey, plansCount: 0, totalYes: 0 };
        tagsStats[tagKey].plansCount += 1;

        if (p.lateMemberId && statsMap[p.lateMemberId]) {
            statsMap[p.lateMemberId].lateCount += 1;
        }

        if (p.flakes) {
            Object.keys(p.flakes).forEach(uid => {
                if (statsMap[uid]) statsMap[uid].flakes += 1;
            });
        }

        if (p.excuses) {
            Object.entries(p.excuses).forEach(([uid, exc]) => {
                const clean = exc.trim();
                if (!clean) return;
                if (!excusesCount[clean]) excusesCount[clean] = { text: clean, count: 0, lastBy: getMemberById(uid).name };
                excusesCount[clean].count += 1;
            });
        }

        members.forEach(m => {
            const st = p.attendance ? p.attendance[m.id] : null;
            if (st === 'yes') {
                statsMap[m.id].attended += 1;
                totalAttendances += 1;
                tagsStats[tagKey].totalYes += 1;
            } else {
                statsMap[m.id].missed += 1;
            }
        });
    });

    memberStats.forEach(ms => {
        ms.rate = totalPlans > 0 ? Math.round((ms.attended / totalPlans) * 100) : 0;
    });

    // Dúos Dinámicos (Afinidad por parejas)
    const pairs = [];
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            const mA = members[i];
            const mB = members[j];
            let together = 0;
            plans.forEach(p => {
                if (p.attendance && p.attendance[mA.id] === 'yes' && p.attendance[mB.id] === 'yes') {
                    together += 1;
                }
            });
            const pct = totalPlans > 0 ? Math.round((together / totalPlans) * 100) : 0;
            pairs.push({ mA, mB, together, pct });
        }
    }
    pairs.sort((a, b) => b.together - a.together);

    const ranked = [...memberStats].sort((a, b) => b.attended - a.attended || b.rate - a.rate);
    const rankedLow = [...memberStats].sort((a, b) => a.rate - b.rate || b.missed - a.missed);
    const rankedFlakes = [...memberStats].sort((a, b) => b.flakes - a.flakes || b.lateCount - a.lateCount);
    const rankedLate = [...memberStats].sort((a, b) => b.lateCount - a.lateCount);

    const topPlaces = Object.entries(placesCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const topExcuses = Object.values(excusesCount).sort((a, b) => b.count - a.count);
    const tagsArray = Object.values(tagsStats).map(t => ({
        ...t,
        avgRate: members.length > 0 ? Math.round((t.totalYes / (t.plansCount * members.length)) * 100) : 0
    })).sort((a, b) => b.avgRate - a.avgRate || b.plansCount - a.plansCount);

    const avgGroupRate = totalPlans > 0 && members.length > 0
        ? Math.round((totalAttendances / (totalPlans * members.length)) * 100)
        : 0;

    return {
        totalPlans,
        avgGroupRate,
        memberStats,
        ranked,
        mvp: ranked[0] || null,
        lowest: rankedLow[0] || null,
        topFlaker: rankedFlakes[0] || null,
        topLate: rankedLate[0] || null,
        bestPair: pairs[0] || null,
        worstPair: pairs.length > 1 ? pairs[pairs.length - 1] : null,
        topPlaces,
        topExcuses,
        tagsArray,
        weekdayCounts
    };
}

function renderStatsView() {
    const group = getActiveGroup();
    if (!group) return;

    const periods = getAvailablePeriods(group.plans);
    let activeOptions = periods.months;
    if (statsPeriodMode === 'season') activeOptions = periods.seasons;
    if (statsPeriodMode === 'year') activeOptions = periods.years;

    if (!selectedPeriodKey || !activeOptions.some(o => o.key === selectedPeriodKey)) {
        selectedPeriodKey = activeOptions[0].key;
    }

    const activePeriodObj = activeOptions.find(o => o.key === selectedPeriodKey) || activeOptions[0];

    document.getElementById('period-selector-strip').innerHTML = activeOptions.map(opt => `
        <button class="period-pill ${opt.key === selectedPeriodKey ? 'active' : ''}" data-period-key="${opt.key}">
            ${escapeHtml(opt.label)}
        </button>
    `).join('');

    document.getElementById('chart-members-period-label').textContent = activePeriodObj.label;

    const filteredPlans = filterPlansByPeriod(group.plans, statsPeriodMode, selectedPeriodKey);
    const stats = computeFullPeriodStats(filteredPlans, group);
    const titles = group.customTitles;

    // 1. KPIs
    document.getElementById('stats-kpi-grid').innerHTML = `
        <div class="kpi-box">
            <div class="kpi-val">${stats.totalPlans}</div>
            <div class="kpi-label">Quedadas</div>
        </div>
        <div class="kpi-box">
            <div class="kpi-val">${group.members.length}</div>
            <div class="kpi-label">Integrantes</div>
        </div>
        <div class="kpi-box">
            <div class="kpi-val" style="color: var(--accent-secondary);">${stats.avgGroupRate}%</div>
            <div class="kpi-label">% Asistencia</div>
        </div>
    `;

    // 2. Títulos Dinámicos Personalizados del Grupo
    document.getElementById('dynamic-titles-grid').innerHTML = `
        <div class="award-card">
            <span class="award-role">👑 ${escapeHtml(titles.mvp)}</span>
            <div class="award-winner">${stats.mvp ? `${stats.mvp.member.avatar} ${escapeHtml(stats.mvp.member.name)}` : '—'}</div>
            <span class="award-metric">${stats.mvp ? `${stats.mvp.rate}% asistencia (${stats.mvp.attended}/${stats.totalPlans})` : 'Sin datos'}</span>
        </div>
        <div class="award-card">
            <span class="award-role">💀 ${escapeHtml(titles.zero)}</span>
            <div class="award-winner">${stats.lowest ? `${stats.lowest.member.avatar} ${escapeHtml(stats.lowest.member.name)}` : '—'}</div>
            <span class="award-metric">${stats.lowest ? `${stats.lowest.rate}% asistencia` : 'Sin datos'}</span>
        </div>
        <div class="award-card">
            <span class="award-role">👻 ${escapeHtml(titles.flake)}</span>
            <div class="award-winner">${stats.topFlaker && stats.topFlaker.flakes > 0 ? `${stats.topFlaker.member.avatar} ${escapeHtml(stats.topFlaker.member.name)}` : 'Nadie aún'}</div>
            <span class="award-metric">${stats.topFlaker ? `${stats.topFlaker.flakes} espantadas (Flakes)` : '0 flakes'}</span>
        </div>
        <div class="award-card">
            <span class="award-role">🐢 ${escapeHtml(titles.late)}</span>
            <div class="award-winner">${stats.topLate && stats.topLate.lateCount > 0 ? `${stats.topLate.member.avatar} ${escapeHtml(stats.topLate.member.name)}` : 'Todos puntuales'}</div>
            <span class="award-metric">${stats.topLate ? `${stats.topLate.lateCount} veces llegó el último` : '0 retrasos'}</span>
        </div>
    `;

    // 3. Gráfico de Barras de Asistencia por Integrante
    const membersChartEl = document.getElementById('members-bar-chart');
    membersChartEl.innerHTML = stats.memberStats.map(item => {
        const barColor = item.rate >= 70 ? 'linear-gradient(180deg, #2ecc71, #27ae60)'
            : item.rate >= 40 ? 'linear-gradient(180deg, #f39c12, #d35400)'
            : 'linear-gradient(180deg, #ff4757, #c0392b)';
        const heightPct = stats.totalPlans > 0 ? Math.max(item.rate, 6) : 6;
        return `
            <div class="vbar-col">
                <span class="vbar-value">${item.attended} (${item.rate}%)</span>
                <div class="vbar-track">
                    <div class="vbar-fill" style="height: ${heightPct}%; background: ${barColor};"></div>
                </div>
                <span class="vbar-label">${item.member.avatar} ${escapeHtml(item.member.name)}</span>
            </div>
        `;
    }).join('');

    // 4. Ranking + Rachas de Fuego (Streaks)
    document.getElementById('attendance-ranking-list').innerHTML = stats.ranked.map((item, idx) => {
        const barColor = item.rate >= 70 ? '#2ecc71' : item.rate >= 40 ? '#f39c12' : '#ff4757';
        const sv = getStreakVisuals(item.currentStreak);
        return `
            <div class="ranking-row">
                <div class="ranking-top-line">
                    <div class="ranking-user-info">
                        <span class="member-avatar ${sv.borderClass}" style="width:28px; height:28px; font-size:14px;">${item.member.avatar}</span>
                        <span>${idx + 1}. ${escapeHtml(item.member.name)}</span>
                        ${sv.badgeHtml}
                    </div>
                    <div class="ranking-numbers">
                        <strong>${item.attended}/${stats.totalPlans}</strong> (<strong>${item.rate}%</strong>)
                    </div>
                </div>
                <div class="progress-track">
                    <div class="progress-fill" style="width: ${item.rate}%; background: ${barColor};"></div>
                </div>
            </div>
        `;
    }).join('');

    // 5. Gráfico de Quedadas Realizadas
    const targetYear = selectedPeriodKey.slice(0, 4);
    const timelineChartEl = document.getElementById('hangouts-timeline-chart');
    if (statsPeriodMode === 'season') {
        document.getElementById('chart-timeline-label').textContent = `Por Estación (${targetYear})`;
        const sKeys = ['spring', 'summer', 'autumn', 'winter'];
        const counts = sKeys.map(sId => {
            const cfg = SEASONS_CONFIG[sId];
            const c = group.plans.filter(p => p.date && p.date.startsWith(targetYear) && getSeasonFromDateStr(p.date).id === sId).length;
            return { label: `${cfg.icon} ${cfg.name.slice(0, 4)}`, count: c };
        });
        const maxCount = Math.max(...counts.map(x => x.count), 1);
        timelineChartEl.innerHTML = counts.map(col => {
            const h = Math.max(Math.round((col.count / maxCount) * 100), 6);
            return `
                <div class="vbar-col">
                    <span class="vbar-value">${col.count}</span>
                    <div class="vbar-track">
                        <div class="vbar-fill" style="height: ${h}%; background: var(--accent-gradient);"></div>
                    </div>
                    <span class="vbar-label">${col.label}</span>
                </div>
            `;
        }).join('');
    } else {
        document.getElementById('chart-timeline-label').textContent = `Quedadas por Mes (${targetYear})`;
        const nowMonthIdx = new Date().getMonth();
        const monthsToShow = [];
        for (let i = 5; i >= 0; i--) {
            const mIdx = (nowMonthIdx - i + 12) % 12;
            const mNum = String(mIdx + 1).padStart(2, '0');
            const key = `${targetYear}-${mNum}`;
            const count = group.plans.filter(p => p.date && p.date.startsWith(key)).length;
            monthsToShow.push({ label: MONTH_SHORT[mIdx], count });
        }
        const maxCount = Math.max(...monthsToShow.map(x => x.count), 1);
        timelineChartEl.innerHTML = monthsToShow.map(col => {
            const h = Math.max(Math.round((col.count / maxCount) * 100), 6);
            return `
                <div class="vbar-col">
                    <span class="vbar-value">${col.count}</span>
                    <div class="vbar-track">
                        <div class="vbar-fill" style="height: ${h}%; background: var(--accent-gradient);"></div>
                    </div>
                    <span class="vbar-label">${col.label}</span>
                </div>
            `;
        }).join('');
    }

    // 6. El Fantasmetro e Impuntualidad
    document.getElementById('fantasmetro-list').innerHTML = stats.memberStats.map(item => `
        <div class="place-row">
            <span>${item.member.avatar} ${escapeHtml(item.member.name)}</span>
            <div style="display:flex; gap:6px;">
                <span class="place-badge" style="background:rgba(255,71,87,0.16); color:#ff7f8a;">👻 ${item.flakes} flakes</span>
                <span class="place-badge" style="background:rgba(243,156,18,0.16); color:#f8c265;">🐢 ${item.lateCount} tarde</span>
            </div>
        </div>
    `).join('');

    // 7. El Excusómetro
    const excEl = document.getElementById('excusometro-list');
    if (stats.topExcuses.length === 0) {
        excEl.innerHTML = `<div class="empty-state" style="padding:10px;">Nadie ha puesto excusas en este periodo todavía.</div>`;
    } else {
        excEl.innerHTML = stats.topExcuses.map(ex => `
            <div class="place-row">
                <div>
                    <div>🤥 "${escapeHtml(ex.text)}"</div>
                    <div style="font-size:10px; color:var(--text-muted);">Última vez por: ${escapeHtml(ex.lastBy)}</div>
                </div>
                <span class="place-badge">${ex.count}x</span>
            </div>
        `).join('');
    }

    // 8. Dúos Dinámicos (Afinidad)
    const duosEl = document.getElementById('duos-afinidad-box');
    if (!stats.bestPair) {
        duosEl.innerHTML = `<div class="empty-state" style="padding:10px;">Se necesitan al menos 2 integrantes para calcular afinidad.</div>`;
    } else {
        duosEl.innerHTML = `
            <div class="duo-card best">
                <div>
                    <div style="font-size:10px; font-weight:800; color:#2ecc71;">💚 DÚO INSEPARABLE (MÁS COINCIDEN)</div>
                    <div style="font-size:13.5px; font-weight:800; margin-top:2px;">
                        ${stats.bestPair.mA.avatar} ${escapeHtml(stats.bestPair.mA.name)} + ${stats.bestPair.mB.avatar} ${escapeHtml(stats.bestPair.mB.name)}
                    </div>
                </div>
                <span class="place-badge" style="background:rgba(46,204,113,0.2); color:#2ecc71;">${stats.bestPair.together} juntos (${stats.bestPair.pct}%)</span>
            </div>
            ${stats.worstPair ? `
            <div class="duo-card worst">
                <div>
                    <div style="font-size:10px; font-weight:800; color:#5dade2;">🧊 NI SE VEN EL PELO (MENOS COINCIDEN)</div>
                    <div style="font-size:13.5px; font-weight:800; margin-top:2px;">
                        ${stats.worstPair.mA.avatar} ${escapeHtml(stats.worstPair.mA.name)} + ${stats.worstPair.mB.avatar} ${escapeHtml(stats.worstPair.mB.name)}
                    </div>
                </div>
                <span class="place-badge" style="background:rgba(52,152,219,0.2); color:#5dade2;">${stats.worstPair.together} juntos (${stats.worstPair.pct}%)</span>
            </div>
            ` : ''}
        `;
    }

    // 9. Mapa de Calor por Días de la Semana + Éxito por Etiqueta
    const dayLabels = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const maxDay = Math.max(...stats.weekdayCounts, 1);
    document.getElementById('weekday-heatmap').innerHTML = stats.weekdayCounts.map((cnt, idx) => {
        const intensity = cnt > 0 ? 0.2 + (cnt / maxDay) * 0.75 : 0.04;
        const bg = cnt > 0 ? `rgba(255, 106, 0, ${intensity.toFixed(2)})` : 'rgba(255,255,255,0.03)';
        return `
            <div class="heat-col">
                <div class="heat-cell" style="background: ${bg};">${cnt}</div>
                <span class="heat-day-name">${dayLabels[idx]}</span>
            </div>
        `;
    }).join('');

    const tagsEl = document.getElementById('tags-stats-list');
    if (stats.tagsArray.length === 0) {
        tagsEl.innerHTML = `<div class="empty-state" style="padding:10px;">Sin etiquetas registradas en este periodo.</div>`;
    } else {
        tagsEl.innerHTML = stats.tagsArray.map(t => `
            <div class="place-row">
                <span>🏷️ ${escapeHtml(t.tag)} (${t.plansCount} planes)</span>
                <span class="place-badge">${t.avgRate}% éxito</span>
            </div>
        `).join('');
    }

    // 10. Cápsula del Tiempo (Galería de Fotos de Prueba y Frases Míticas)
    const capsulePlans = filteredPlans.filter(p => p.memoryPhoto || p.memoryQuote);
    const capsuleEl = document.getElementById('time-capsule-gallery');
    if (capsulePlans.length === 0) {
        capsuleEl.innerHTML = `<div class="empty-state" style="grid-column: span 2; padding:14px;">Aún no hay recuerdos en la Cápsula del Tiempo de este periodo. Al finalizar una quedada, sube una foto de prueba y una frase mítica.</div>`;
    } else {
        capsuleEl.innerHTML = capsulePlans.map(p => `
            <div class="capsule-item">
                ${p.memoryPhoto
                    ? `<img src="${p.memoryPhoto}" class="capsule-img" alt="Recuerdo">`
                    : `<div class="capsule-img" style="display:flex;align-items:center;justify-content:center;font-size:32px;">🍻</div>`}
                <div class="capsule-meta">
                    <div class="capsule-title">${escapeHtml(p.title)}</div>
                    ${p.memoryQuote ? `<div class="capsule-quote">"${escapeHtml(p.memoryQuote)}"</div>` : ''}
                    <div class="capsule-date">📅 ${formatHumanDate(p.date)} · 📍 ${escapeHtml(p.location)}</div>
                </div>
            </div>
        `).join('');
    }
}

// ==========================================================================
// STORY WRAPPED ESTACIONAL Y DE FIN DE AÑO (FORMATO HISTORIA VERTICAL)
// ==========================================================================
function openStoryWrappedModal() {
    const group = getActiveGroup();
    if (!group) return;
    const periods = getAvailablePeriods(group.plans);
    let activeOptions = periods.months;
    if (statsPeriodMode === 'season') activeOptions = periods.seasons;
    if (statsPeriodMode === 'year') activeOptions = periods.years;
    const activePeriodObj = activeOptions.find(o => o.key === selectedPeriodKey) || activeOptions[0];

    const filteredPlans = filterPlansByPeriod(group.plans, statsPeriodMode, selectedPeriodKey);
    const stats = computeFullPeriodStats(filteredPlans, group);
    const topPlace = stats.topPlaces[0];
    const maxStreakMember = [...stats.memberStats].sort((a, b) => b.maxStreak - a.maxStreak)[0];

    document.getElementById('wrapped-story-content').innerHTML = `
        <div style="text-align:center; margin-bottom:14px;">
            <span style="background:rgba(255,255,255,0.14); padding:4px 12px; border-radius:99px; font-size:10px; font-weight:800; letter-spacing:1px;">
                ✨ QUIÉN QUEDA? RECAP ✨
            </span>
            <h2 style="font-size:22px; font-weight:900; margin-top:8px;">${escapeHtml(group.name)}</h2>
            <p style="font-size:12.5px; color:#ff9a3c; font-weight:700;">${escapeHtml(activePeriodObj.label)}</p>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
            <div style="background:rgba(0,0,0,0.35); padding:11px; border-radius:14px; text-align:center;">
                <div style="font-size:24px; font-weight:900;">${stats.totalPlans}</div>
                <div style="font-size:9.5px; color:#ccc; font-weight:700;">QUEDADAS</div>
            </div>
            <div style="background:rgba(0,0,0,0.35); padding:11px; border-radius:14px; text-align:center;">
                <div style="font-size:24px; font-weight:900; color:#2ecc71;">${stats.avgGroupRate}%</div>
                <div style="font-size:9.5px; color:#ccc; font-weight:700;">ASISTENCIA MEDIA</div>
            </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px;">
            <div style="background:rgba(46,204,113,0.14); border:1px solid rgba(46,204,113,0.4); padding:10px 12px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:9.5px; font-weight:800; color:#2ecc71;">👑 MVP (${escapeHtml(group.customTitles.mvp)})</div>
                    <div style="font-size:14px; font-weight:800;">${stats.mvp ? `${stats.mvp.member.avatar} ${escapeHtml(stats.mvp.member.name)}` : '—'}</div>
                </div>
                <div style="font-size:15px; font-weight:900;">${stats.mvp ? `${stats.mvp.rate}%` : ''}</div>
            </div>

            <div style="background:rgba(255,71,87,0.14); border:1px solid rgba(255,71,87,0.4); padding:10px 12px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:9.5px; font-weight:800; color:#ff7f8a;">💀 DESAPARECIDO (${escapeHtml(group.customTitles.zero)})</div>
                    <div style="font-size:14px; font-weight:800;">${stats.lowest ? `${stats.lowest.member.avatar} ${escapeHtml(stats.lowest.member.name)}` : '—'}</div>
                </div>
                <div style="font-size:13px; font-weight:800;">${stats.lowest ? `${stats.lowest.rate}%` : ''}</div>
            </div>

            <div style="background:rgba(255,106,0,0.14); border:1px solid rgba(255,106,0,0.4); padding:10px 12px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:9.5px; font-weight:800; color:#ff9a3c;">🔥 RACHA MÁS LARGA</div>
                    <div style="font-size:14px; font-weight:800;">${maxStreakMember ? `${maxStreakMember.member.avatar} ${escapeHtml(maxStreakMember.member.name)}` : '—'}</div>
                </div>
                <div style="font-size:13px; font-weight:900;">🔥 ${maxStreakMember ? maxStreakMember.maxStreak : 0} seguidas</div>
            </div>

            <div style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); padding:10px 12px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size:9.5px; font-weight:800; color:#ccc;">📍 LUGAR MÁS REPETIDO</div>
                    <div style="font-size:14px; font-weight:800;">${topPlace ? escapeHtml(topPlace.name) : '—'}</div>
                </div>
                <div style="font-size:12px; font-weight:800;">${topPlace ? `${topPlace.count} veces` : ''}</div>
            </div>
        </div>
    `;

    document.getElementById('modal-wrapped').classList.remove('hidden');
}

// ==========================================================================
// VISTA 3: GRUPO Y GESTIÓN DE ADMINS ESTILO WHATSAPP
// ==========================================================================
function renderGroupView() {
    const group = getActiveGroup();
    if (!group) return;
    const activeUser = getActiveUser();
    const streaks = computeStreaksForGroup(group);

    const emojiEl = document.getElementById('group-view-emoji');
    const imgEl = document.getElementById('group-view-img');

    if (group.photo) {
        imgEl.src = group.photo;
        imgEl.classList.remove('hidden');
        emojiEl.classList.add('hidden');
    } else {
        imgEl.classList.add('hidden');
        emojiEl.classList.remove('hidden');
        emojiEl.textContent = group.emoji || '👥';
    }

    document.getElementById('group-view-name').textContent = group.name;
    document.getElementById('group-view-desc').textContent = group.description || 'Sin descripción';
    document.getElementById('group-invite-code').textContent = group.inviteCode;
    document.getElementById('members-count-badge').textContent = group.members.length;

    const allStats = computeFullPeriodStats(group.plans, group);
    const statsByMemberId = {};
    allStats.memberStats.forEach(r => { statsByMemberId[r.member.id] = r; });

    const myUsername = appState.currentAccount ? normalizeUsername(appState.currentAccount.username) : '';

    document.getElementById('group-members-list').innerHTML = group.members.map(m => {
        const isMe = m.id === activeUser.id;
        const st = statsByMemberId[m.id] || { attended: 0, rate: 0 };
        const sv = getStreakVisuals(streaks[m.id]?.current || 0);
        const memberUsername = m.username ? normalizeUsername(m.username) : '';
        let handleBadgeHTML = `<span style="font-size:10px; color:#f39c12; font-weight:700;">🔓 Libre para vincular</span>`;
        if (memberUsername) {
            if (memberUsername === myUsername) {
                handleBadgeHTML = `<span style="font-size:10px; color:#2ecc71; font-weight:800;">🔒 Tu cuenta (${escapeHtml(formatHandle(memberUsername))})</span>`;
            } else {
                handleBadgeHTML = `<span style="font-size:10px; color:var(--text-muted); font-weight:700;">🔒 ${escapeHtml(formatHandle(memberUsername))}</span>`;
            }
        }

        return `
            <div class="member-item ${isMe ? 'active-me' : ''}" data-action="switch-user" data-user-id="${m.id}">
                <div class="member-left">
                    <div class="member-avatar ${sv.borderClass}">${m.avatar}</div>
                    <div>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <span class="member-name">${escapeHtml(m.name)}</span>
                            ${m.isAdmin ? `<span class="admin-badge-wa">Admin del grupo</span>` : ''}
                            ${sv.badgeHtml}
                        </div>
                        <div class="member-role">${st.attended} asistencias (${st.rate}%) · ${handleBadgeHTML}</div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    <button type="button" class="btn-admin-toggle" data-action="toggle-admin" data-user-id="${m.id}" title="Dar o quitar Admin">
                        ${m.isAdmin ? 'Quitar Admin' : '👑 Hacer Admin'}
                    </button>
                    <button type="button" class="btn-delete-plan" data-action="remove-member" data-user-id="${m.id}" title="Eliminar integrante">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

function openWhoAreYouModal() {
    const group = getActiveGroup();
    if (!group) return;
    const activeUser = getActiveUser();
    const myAcc = appState.currentAccount;
    const myUsername = myAcc ? normalizeUsername(myAcc.username) : '';

    document.getElementById('who-modal-group-title').textContent = `Grupo: ${group.name}`;

    const bannerEl = document.getElementById('who-modal-account-banner');
    if (bannerEl && myAcc) {
        bannerEl.innerHTML = `👤 Tu cuenta activa: <strong>${escapeHtml(myAcc.name)}</strong> (<span style="color:#ff9a3c; font-weight:800;">${escapeHtml(formatHandle(myAcc.username))}</span>)`;
    }

    document.getElementById('who-modal-members-grid').innerHTML = group.members.map(m => {
        const mUser = m.username ? normalizeUsername(m.username) : '';
        let statusLine = '🔓 Libre — Vincular a mi @usuario';
        if (mUser) {
            if (mUser === myUsername) {
                statusLine = `✅ Tu perfil (${formatHandle(mUser)})`;
            } else {
                statusLine = `🔒 ${formatHandle(mUser)}`;
            }
        }
        return `
            <div class="who-member-card ${m.id === activeUser.id ? 'selected' : ''}" data-pick-member="${m.id}">
                <span style="font-size: 22px;">${m.avatar}</span>
                <div>
                    <div style="font-size: 13px; font-weight: 800; color:#fff;">${escapeHtml(m.name)} ${m.isAdmin ? '👑' : ''}</div>
                    <div style="font-size: 10px; color: ${!mUser ? '#ff9a3c' : (mUser === myUsername ? '#2ecc71' : 'var(--text-muted)')}; font-weight:700;">${escapeHtml(statusLine)}</div>
                </div>
            </div>
        `;
    }).join('');
    document.getElementById('modal-who-are-you').classList.remove('hidden');
}

function trySelectOrLinkMember(memberId) {
    const group = getActiveGroup();
    if (!group) return;
    const member = group.members.find(m => m.id === memberId);
    if (!member) return;

    const myAcc = appState.currentAccount;
    const myUsername = myAcc ? normalizeUsername(myAcc.username) : '';
    const memberUsername = member.username ? normalizeUsername(member.username) : '';

    // Caso 1: El nombre estaba sin vincular (lo creó el Admin) -> Se vincula al @usuario actual
    if (!memberUsername && myAcc) {
        member.username = myAcc.username;
        member.password = myAcc.password;
        member.totpSecret = myAcc.totpSecret || '';
        appState.activeUserId = member.id;
        saveState();
        document.getElementById('modal-who-are-you').classList.add('hidden');
        renderApp();
        showToast(`🔗 ¡"${member.name}" vinculado a ${formatHandle(myAcc.username)}!`);
        return;
    }

    // Caso 2: Ya pertenece al @usuario activo
    if (memberUsername === myUsername) {
        appState.activeUserId = member.id;
        saveState(false);
        document.getElementById('modal-who-are-you').classList.add('hidden');
        renderApp();
        showToast(`👤 Conectado como ${member.name} (${formatHandle(memberUsername)})`);
        return;
    }

    // Caso 3: Pertenece a otro amigo (tiene otro @usuario) -> Pedir su contraseña o código de Authenticator
    document.getElementById('pin-verify-member-id').value = member.id;
    document.getElementById('pin-verify-subtitle').textContent = `"${member.name}" está vinculado a ${formatHandle(memberUsername)}.`;
    document.getElementById('pin-verify-input').value = '';
    document.getElementById('modal-pin-verify').classList.remove('hidden');
}

// ==========================================================================
// ETIQUETAS PERSONALIZABLES EN CREAR QUEDADA
// ==========================================================================
function renderCustomTagsInModal() {
    const group = getActiveGroup();
    if (!group) return;
    if (!group.customTags.includes(selectedCreateTag)) {
        selectedCreateTag = group.customTags[0] || 'General';
    }
    const container = document.getElementById('plan-custom-tags-list');
    container.innerHTML = group.customTags.map(tag => `
        <button type="button" class="cat-chip ${tag === selectedCreateTag ? 'active' : ''}" data-select-tag="${escapeHtml(tag)}">
            🏷️ ${escapeHtml(tag)}
        </button>
    `).join('');
}

// ==========================================================================
// EXCUSÓMETRO MODAL (CUANDO ALGUIEN DICE "❌ NO VOY")
// ==========================================================================
function openExcuseModal(plan) {
    const group = getActiveGroup();
    const activeUser = getActiveUser();
    document.getElementById('excuse-plan-id').value = plan.id;

    const hoursLeft = getHoursUntilPlan(plan);
    const hadSaidYes = plan.attendance && plan.attendance[activeUser.id] === 'yes';
    const warningEl = document.getElementById('excuse-warning-flake');

    if (hadSaidYes && hoursLeft <= 2 && hoursLeft >= -4) {
        warningEl.textContent = '👻 ¡OJO! Tenías puesto que ibas y faltan menos de 2h: sumarás +1 punto en el Fantasmetro.';
    } else {
        warningEl.textContent = `Para: ${plan.title}`;
    }

    const presetsEl = document.getElementById('excuse-presets-chips');
    presetsEl.innerHTML = (group.customExcuses || []).map(exc => `
        <button type="button" class="cat-chip" data-pick-excuse="${escapeHtml(exc)}">${escapeHtml(exc)}</button>
    `).join('');

    document.getElementById('excuse-custom-input').value = (plan.excuses && plan.excuses[activeUser.id]) || '';
    document.getElementById('modal-excuse').classList.remove('hidden');
}

// ==========================================================================
// COMPARTIR POR WHATSAPP
// ==========================================================================
function sharePlanToWhatsApp(plan) {
    const group = getActiveGroup();
    const yesNames = [];
    const maybeNames = [];
    const noNames = [];

    group.members.forEach(m => {
        const st = plan.attendance ? plan.attendance[m.id] : null;
        if (st === 'yes') yesNames.push(m.name);
        else if (st === 'maybe') maybeNames.push(m.name);
        else if (st === 'no') noNames.push(m.name);
    });

    const inviteUrl = getGroupInviteUrl(group);
    const lines = [
        `📅 *¿QUIÉN QUEDA?* — *${plan.title}* ${plan.tag ? `[${plan.tag}]` : ''}`,
        `🗓️ ${formatHumanDate(plan.date)} a las *${plan.time}*`,
        `📍 *${plan.location}*`,
        plan.notes ? `📝 _"${plan.notes}"_` : '',
        '',
        `✅ *Asisten (${yesNames.length}):* ${yesNames.length ? yesNames.join(', ') : 'Nadie aún'}`,
        maybeNames.length ? `🤔 *En duda (${maybeNames.length}):* ${maybeNames.join(', ')}` : '',
        noNames.length ? `❌ *Bajas (${noNames.length}):* ${noNames.join(', ')}` : '',
        '',
        `👉 *Entra al grupo para apuntarte:*`,
        inviteUrl
    ].filter(Boolean).join('\n');

    window.open(`https://wa.me/?text=${encodeURIComponent(lines)}`, '_blank');
}

// ==========================================================================
// EVENTOS E INTERACCIONES
// ==========================================================================
function setupEventListeners() {
    // --- 0. CUENTA CON @USUARIO ÚNICO + CONTRASEÑA + GOOGLE/MICROSOFT AUTHENTICATOR ---
    let pendingCreatedAccount = null;

    const regForm = document.getElementById('form-auth-register');
    const loginForm = document.getElementById('form-auth-login');
    const recoverForm = document.getElementById('form-auth-recover');
    const totpSetupCard = document.getElementById('card-auth-totp-setup');
    const authModeTabs = document.getElementById('auth-mode-tabs');

    function switchAuthView(view) {
        if (!regForm || !loginForm || !recoverForm || !totpSetupCard) return;
        regForm.classList.toggle('hidden', view !== 'register');
        loginForm.classList.toggle('hidden', view !== 'login');
        recoverForm.classList.toggle('hidden', view !== 'recover');
        totpSetupCard.classList.toggle('hidden', view !== 'totp_setup');
        if (authModeTabs) {
            authModeTabs.classList.toggle('hidden', view === 'totp_setup' || view === 'recover');
            authModeTabs.querySelectorAll('[data-auth-tab]').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-auth-tab') === view);
            });
        }
    }

    function showAuthenticatorSetupCard(account) {
        pendingCreatedAccount = account;
        const otpUri = getOtpAuthUri(account.username, account.totpSecret);
        const qrImg = document.getElementById('totp-qr-img');
        if (qrImg) {
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpUri)}`;
        }
        const openAppLink = document.getElementById('totp-open-app-link');
        if (openAppLink) {
            openAppLink.href = otpUri;
        }
        const secretText = document.getElementById('totp-secret-text');
        if (secretText) {
            secretText.textContent = account.totpSecret;
        }
        const verifyInput = document.getElementById('totp-verify-setup-input');
        if (verifyInput) verifyInput.value = '';
        switchAuthView('totp_setup');
    }

    function completeAccountLogin(account) {
        appState.currentAccount = account;
        if (!appState.accounts) appState.accounts = {};
        appState.accounts[normalizeUsername(account.username)] = account;

        const group = getActiveGroup();
        if (group) {
            const byUser = group.members.find(
                m => m.username && normalizeUsername(m.username) === normalizeUsername(account.username)
            );
            if (byUser) {
                byUser.password = account.password;
                byUser.totpSecret = account.totpSecret || '';
                appState.activeUserId = byUser.id;
                saveState();
                renderApp();
                showToast(`🎉 Conectado como ${byUser.name} (${formatHandle(account.username)})`);
                return;
            }

            saveState(false);
            renderApp();
            openWhoAreYouModal();
            showToast('👇 Toca tu nombre en la lista para vincularlo a tu @usuario');
            return;
        }

        saveState(false);
        renderApp();
        showToast(`✅ Sesión iniciada: ${formatHandle(account.username)}`);
    }

    if (authModeTabs) {
        authModeTabs.addEventListener('click', e => {
            const btn = e.target.closest('[data-auth-tab]');
            if (!btn) return;
            switchAuthView(btn.getAttribute('data-auth-tab'));
        });
    }

    document.querySelectorAll('#auth-avatar-picker .avatar-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#auth-avatar-picker .avatar-opt').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    if (regForm) {
        regForm.addEventListener('submit', async e => {
            e.preventDefault();
            const rawUsername = document.getElementById('reg-username-input').value;
            const username = normalizeUsername(rawUsername);
            const name = document.getElementById('reg-name-input').value.trim();
            const password = document.getElementById('reg-password-input').value;
            const avatarEl = document.querySelector('#auth-avatar-picker .avatar-opt.active');
            const avatar = avatarEl ? avatarEl.getAttribute('data-avatar') : '😎';

            if (username.length < 2) {
                showToast('⚠️ El @usuario debe tener al menos 2 caracteres (letras o números)');
                return;
            }
            if (password.length < 4) {
                showToast('⚠️ La contraseña debe tener al menos 4 caracteres');
                return;
            }

            const submitBtn = document.getElementById('btn-submit-register');
            const origText = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = '⏳ Comprobando disponibilidad de @' + username + '...';
            }

            const existing = await findAccountByUsername(username);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = origText;
            }

            if (existing) {
                showToast(`❌ El usuario @${username} ya existe. Elige otro o inicia sesión.`);
                return;
            }

            const totpSecret = generateBase32Secret(16);
            const newAccount = {
                username,
                name,
                password,
                totpSecret,
                avatar
            };

            await saveAccountToCloudRegistry(newAccount);
            saveState(false);
            showAuthenticatorSetupCard(newAccount);
            showToast(`🎉 ¡@${username} creado! Guarda tu Authenticator por si olvidas la clave.`);
        });
    }

    const copySecretBtn = document.getElementById('btn-copy-totp-secret');
    if (copySecretBtn) {
        copySecretBtn.addEventListener('click', () => {
            if (!pendingCreatedAccount) return;
            if (navigator.clipboard) navigator.clipboard.writeText(pendingCreatedAccount.totpSecret);
            showToast('📋 Clave secreta copiada para pegar en Authenticator');
        });
    }

    const confirmTotpBtn = document.getElementById('btn-confirm-totp-setup');
    if (confirmTotpBtn) {
        confirmTotpBtn.addEventListener('click', async () => {
            if (!pendingCreatedAccount) return;
            const codeInput = document.getElementById('totp-verify-setup-input');
            const typedCode = codeInput ? codeInput.value.trim() : '';

            if (typedCode) {
                const isValid = await verifyTotpCode(pendingCreatedAccount.totpSecret, typedCode);
                if (!isValid) {
                    showToast('❌ El código de 6 dígitos no coincide con el del Authenticator');
                    return;
                }
                showToast('🛡️ ¡Authenticator verificado correctamente!');
            }

            switchAuthView('register');
            completeAccountLogin(pendingCreatedAccount);
        });
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async e => {
            e.preventDefault();
            const username = normalizeUsername(document.getElementById('login-username-input').value);
            const password = document.getElementById('login-password-input').value;

            if (!username) {
                showToast('⚠️ Introduce tu @usuario');
                return;
            }

            const acc = await findAccountByUsername(username);
            if (!acc) {
                showToast(`❌ No existe ninguna cuenta con @${username}`);
                return;
            }

            if (acc.password !== password) {
                showToast('❌ Contraseña incorrecta. Si la olvidaste, usa Authenticator abajo.');
                return;
            }

            completeAccountLogin(acc);
        });
    }

    const openRecoverBtn = document.getElementById('btn-open-recover-totp');
    if (openRecoverBtn) {
        openRecoverBtn.addEventListener('click', () => {
            const currentLoginVal = document.getElementById('login-username-input').value;
            if (currentLoginVal) {
                document.getElementById('recover-username-input').value = normalizeUsername(currentLoginVal);
            }
            switchAuthView('recover');
        });
    }

    const backToLoginBtn = document.getElementById('btn-back-to-login');
    if (backToLoginBtn) {
        backToLoginBtn.addEventListener('click', () => {
            switchAuthView('login');
        });
    }

    if (recoverForm) {
        recoverForm.addEventListener('submit', async e => {
            e.preventDefault();
            const username = normalizeUsername(document.getElementById('recover-username-input').value);
            const totpCode = document.getElementById('recover-totp-input').value.trim();
            const newPassword = document.getElementById('recover-new-password-input').value;

            const acc = await findAccountByUsername(username);
            if (!acc) {
                showToast(`❌ No se encontró el usuario @${username}`);
                return;
            }
            if (!acc.totpSecret) {
                showToast('⚠️ Esta cuenta no tiene clave de Authenticator asociada');
                return;
            }

            const validTotp = await verifyTotpCode(acc.totpSecret, totpCode);
            if (!validTotp) {
                showToast('❌ Código de Authenticator incorrecto o caducado');
                return;
            }

            acc.password = newPassword;
            await saveAccountToCloudRegistry(acc);

            // Actualizar también en los grupos donde esté este @usuario
            (appState.groups || []).forEach(g => {
                (g.members || []).forEach(m => {
                    if (normalizeUsername(m.username) === username) {
                        m.password = newPassword;
                    }
                });
            });

            switchAuthView('register');
            completeAccountLogin(acc);
            showToast(`🔑 ¡Contraseña de @${username} actualizada con Authenticator!`);
        });
    }

    // --- 1. ONBOARDING: CREAR GRUPO DESDE CERO ---
    document.getElementById('onboarding-photo-input').addEventListener('change', e => {
        readAndCompressImage(e.target.files[0], 240, dataUrl => {
            onboardingDraftPhoto = dataUrl;
            const img = document.getElementById('onboarding-photo-img');
            img.src = dataUrl;
            img.classList.remove('hidden');
            document.getElementById('onboarding-photo-placeholder').classList.add('hidden');
        });
    });

    const addDraftMember = () => {
        const input = document.getElementById('onboarding-member-name');
        const name = input.value.trim();
        if (!name) return;
        const avatar = DEFAULT_AVATARS[onboardingDraftMembers.length % DEFAULT_AVATARS.length];
        onboardingDraftMembers.push({
            id: 'u_' + Date.now() + '_' + Math.floor(Math.random() * 999),
            name,
            avatar,
            isAdmin: onboardingDraftMembers.length === 0 // El primero es Admin por defecto
        });
        input.value = '';
        input.focus();
        renderOnboardingDraftMembers();
    };

    document.getElementById('btn-add-onboarding-member').addEventListener('click', addDraftMember);
    document.getElementById('onboarding-member-name').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addDraftMember();
        }
    });

    document.getElementById('onboarding-members-chips').addEventListener('click', e => {
        const btn = e.target.closest('[data-remove-draft-idx]');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-remove-draft-idx'), 10);
        onboardingDraftMembers.splice(idx, 1);
        if (onboardingDraftMembers.length > 0 && !onboardingDraftMembers.some(m => m.isAdmin)) {
            onboardingDraftMembers[0].isAdmin = true;
        }
        renderOnboardingDraftMembers();
    });

    document.getElementById('form-onboarding-group').addEventListener('submit', e => {
        e.preventDefault();
        const groupName = document.getElementById('onboarding-group-name').value.trim();
        const groupDesc = document.getElementById('onboarding-group-desc').value.trim();

        const pendingName = document.getElementById('onboarding-member-name').value.trim();
        if (pendingName) {
            onboardingDraftMembers.push({
                id: 'u_' + Date.now(),
                name: pendingName,
                avatar: DEFAULT_AVATARS[onboardingDraftMembers.length % DEFAULT_AVATARS.length],
                isAdmin: onboardingDraftMembers.length === 0
            });
            document.getElementById('onboarding-member-name').value = '';
        }

        if (onboardingDraftMembers.length === 0) {
            showToast('⚠️ Añade al menos 1 integrante al grupo');
            return;
        }

        const code = (groupName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || 'GRUP') + Math.floor(10 + Math.random() * 89);

        const newGroup = {
            id: 'g_' + Date.now(),
            name: groupName,
            description: groupDesc,
            emoji: '👥',
            photo: onboardingDraftPhoto || '',
            inviteCode: code,
            members: [...onboardingDraftMembers],
            plans: [],
            customTags: ['Tardeo', 'Cena', 'Deporte', 'Gaming', 'Paseo'],
            customExcuses: [
                'Me ha surgido un imprevisto',
                'Tengo compromiso familiar',
                'Estoy sin un duro este mes',
                'Tengo que madrugar mañana',
                'Me da pereza máxima salir hoy'
            ],
            customTitles: {
                mvp: 'El alma de la fiesta',
                zero: 'Secuestrado / Visto en línea',
                flake: 'Vende humos profesional',
                late: 'Llegando en 5 minutos'
            }
        };

        ensureAtLeastOneAdmin(newGroup);
        appState.groups.push(newGroup);
        appState.activeGroupId = newGroup.id;
        appState.activeUserId = newGroup.members[0].id;

        onboardingDraftPhoto = '';
        onboardingDraftMembers = [];
        document.getElementById('form-onboarding-group').reset();
        document.getElementById('onboarding-photo-img').classList.add('hidden');
        document.getElementById('onboarding-photo-placeholder').classList.remove('hidden');

        saveState();
        renderApp();
        showToast(`🎉 ¡Grupo "${groupName}" creado!`);

        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    });

    document.getElementById('btn-onboarding-join').addEventListener('click', async () => {
        const code = document.getElementById('onboarding-join-code').value.trim().toUpperCase();
        if (!code) return;
        const cloudGroup = await fetchGroupFromCloudByCode(code);
        if (cloudGroup) {
            appState.groups.push(cloudGroup);
            appState.activeGroupId = cloudGroup.id;
            appState.activeUserId = cloudGroup.members[0]?.id || null;
            saveState(false);
            renderApp();
            showToast(`✅ Unido al grupo "${cloudGroup.name}"`);
        } else {
            showToast('⚠️ No se encontró un grupo online con ese código');
        }
    });

    // --- 2. NAVEGACIÓN PRINCIPAL ---
    document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            switchMainTab(btn.getAttribute('data-target'));
        });
    });

    document.querySelectorAll('.sub-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPlanFilter = btn.getAttribute('data-plan-filter');
            renderPlansView();
        });
    });

    // --- 3. CREAR QUEDADA + ETIQUETAS EDITABLES ---
    const openCreatePlanModal = () => {
        document.querySelectorAll('#day-preset-pills .day-pill').forEach(b => b.classList.remove('active'));
        document.querySelector('#day-preset-pills [data-day-preset="today"]').classList.add('active');
        document.getElementById('plan-date-input').value = getDateForPreset('today');
        renderCustomTagsInModal();
        document.getElementById('modal-create-plan').classList.remove('hidden');
    };

    document.getElementById('open-create-plan-btn').addEventListener('click', openCreatePlanModal);
    document.getElementById('quick-create-trigger').addEventListener('click', openCreatePlanModal);

    document.getElementById('plan-custom-tags-list').addEventListener('click', e => {
        const chip = e.target.closest('[data-select-tag]');
        if (!chip) return;
        selectedCreateTag = chip.getAttribute('data-select-tag');
        renderCustomTagsInModal();
    });

    document.getElementById('btn-add-custom-tag').addEventListener('click', () => {
        const input = document.getElementById('new-custom-tag-input');
        const val = input.value.trim();
        if (!val) return;
        const group = getActiveGroup();
        if (!group.customTags.includes(val)) {
            group.customTags.push(val);
        }
        selectedCreateTag = val;
        input.value = '';
        saveState();
        renderCustomTagsInModal();
    });

    document.querySelectorAll('#day-preset-pills .day-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('#day-preset-pills .day-pill').forEach(b => b.classList.remove('active'));
            pill.classList.add('active');
            const preset = pill.getAttribute('data-day-preset');
            const dateInput = document.getElementById('plan-date-input');
            if (preset === 'custom') {
                dateInput.focus();
                if (dateInput.showPicker) dateInput.showPicker();
            } else {
                dateInput.value = getDateForPreset(preset);
            }
        });
    });

    document.getElementById('form-create-plan').addEventListener('submit', e => {
        e.preventDefault();
        const group = getActiveGroup();
        const activeUser = getActiveUser();
        const title = document.getElementById('plan-title-input').value.trim();
        const date = document.getElementById('plan-date-input').value;
        const time = document.getElementById('plan-time-input').value;
        const location = document.getElementById('plan-location-input').value.trim();
        const notes = document.getElementById('plan-notes-input').value.trim();
        const votingOpen = document.getElementById('plan-voting-toggle').checked;

        const newPlan = {
            id: 'plan_' + Date.now(),
            title,
            tag: selectedCreateTag || 'General',
            date,
            time,
            location,
            notes,
            createdBy: activeUser.id,
            votingOpen,
            completed: false,
            pendingAttendanceCheck: false,
            proposals: votingOpen
                ? [{ id: 'prop_' + Date.now(), time, location, reason: 'Propuesta inicial', authorId: activeUser.id, votes: [activeUser.id] }]
                : [],
            attendance: { [activeUser.id]: 'yes' },
            excuses: {},
            flakes: {}
        };

        group.plans.unshift(newPlan);
        saveState();
        document.getElementById('form-create-plan').reset();
        document.getElementById('modal-create-plan').classList.add('hidden');
        switchMainTab('view-plans');
        renderApp();
        showToast('✅ Quedada publicada');
    });

    // --- 4. RULETA DE INDECISOS ---
    document.getElementById('open-standalone-roulette-btn').addEventListener('click', openRouletteModal);
    document.getElementById('btn-open-roulette-from-create').addEventListener('click', openRouletteModal);

    const addRouletteOpt = () => {
        const input = document.getElementById('roulette-option-input');
        const val = input.value.trim();
        if (!val) return;
        rouletteOptions.push(val);
        input.value = '';
        renderRouletteOptionsChips();
        drawRouletteWheel();
    };

    document.getElementById('btn-add-roulette-option').addEventListener('click', addRouletteOpt);
    document.getElementById('roulette-option-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addRouletteOpt();
        }
    });

    document.getElementById('roulette-options-chips').addEventListener('click', e => {
        const btn = e.target.closest('[data-remove-roulette-idx]');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-remove-roulette-idx'), 10);
        rouletteOptions.splice(idx, 1);
        renderRouletteOptionsChips();
        drawRouletteWheel();
    });

    document.getElementById('btn-spin-roulette').addEventListener('click', spinRouletteWheel);

    document.getElementById('btn-use-roulette-winner').addEventListener('click', () => {
        if (rouletteWinnerText) {
            document.getElementById('plan-location-input').value = rouletteWinnerText;
            document.getElementById('modal-roulette').classList.add('hidden');
            document.getElementById('modal-create-plan').classList.remove('hidden');
            showToast(`📍 Lugar elegido: ${rouletteWinnerText}`);
        }
    });

    // --- 5. INTERACCIONES EN TARJETAS DE QUEDADA + EXCUSÓMETRO + FANTASMETRO ---
    document.getElementById('plans-list').addEventListener('click', e => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        const action = actionEl.getAttribute('data-action');
        const planId = actionEl.getAttribute('data-plan-id');
        const group = getActiveGroup();
        const activeUser = getActiveUser();
        const plan = group.plans.find(p => p.id === planId);
        if (!plan) return;

        if (action === 'rsvp') {
            const status = actionEl.getAttribute('data-status');
            if (status === 'no') {
                // Abrir el Excusómetro
                openExcuseModal(plan);
                return;
            }
            if (!plan.attendance) plan.attendance = {};
            plan.attendance[activeUser.id] = status;
            if (plan.excuses) delete plan.excuses[activeUser.id];
            saveState();
            renderApp();
            showToast(`${activeUser.name}: ${status === 'yes' ? '✅ ¡Apuntado!' : '🤔 En duda'}`);
        }

        if (action === 'toggle-vote') {
            const propId = actionEl.getAttribute('data-prop-id');
            const prop = (plan.proposals || []).find(pr => pr.id === propId);
            if (!prop) return;
            if (!prop.votes) prop.votes = [];
            const idx = prop.votes.indexOf(activeUser.id);
            if (idx >= 0) prop.votes.splice(idx, 1);
            else prop.votes.push(activeUser.id);
            saveState();
            renderPlansView();
        }

        if (action === 'open-add-proposal') {
            document.getElementById('proposal-plan-id').value = plan.id;
            document.getElementById('proposal-plan-title-label').textContent = plan.title;
            document.getElementById('proposal-time-input').value = plan.time;
            document.getElementById('proposal-location-input').value = '';
            document.getElementById('proposal-reason-input').value = '';
            document.getElementById('modal-add-proposal').classList.remove('hidden');
        }

        if (action === 'close-voting') {
            if (plan.proposals && plan.proposals.length > 0) {
                const winner = [...plan.proposals].sort((a, b) => (b.votes || []).length - (a.votes || []).length)[0];
                plan.time = winner.time;
                plan.location = winner.location;
            }
            plan.votingOpen = false;
            saveState();
            renderApp();
            showToast(`🔒 Fijado: ${plan.time} en ${plan.location}`);
        }

        if (action === 'open-confirm-attendance') {
            openConfirmAttendanceModal(plan.id);
        }

        if (action === 'share-plan-wa') {
            sharePlanToWhatsApp(plan);
        }

        if (action === 'delete-plan') {
            group.plans = group.plans.filter(p => p.id !== plan.id);
            saveState();
            renderApp();
            showToast('🗑️ Quedada eliminada');
        }
    });

    // Excusómetro submit
    document.getElementById('excuse-presets-chips').addEventListener('click', e => {
        const chip = e.target.closest('[data-pick-excuse]');
        if (!chip) return;
        document.getElementById('excuse-custom-input').value = chip.getAttribute('data-pick-excuse');
    });

    document.getElementById('form-excuse').addEventListener('submit', e => {
        e.preventDefault();
        const planId = document.getElementById('excuse-plan-id').value;
        const excuseText = document.getElementById('excuse-custom-input').value.trim();
        const group = getActiveGroup();
        const activeUser = getActiveUser();
        const plan = group.plans.find(p => p.id === planId);
        if (!plan) return;

        const hadSaidYes = plan.attendance && plan.attendance[activeUser.id] === 'yes';
        const hoursLeft = getHoursUntilPlan(plan);

        if (!plan.attendance) plan.attendance = {};
        if (!plan.excuses) plan.excuses = {};
        if (!plan.flakes) plan.flakes = {};

        plan.attendance[activeUser.id] = 'no';
        plan.excuses[activeUser.id] = excuseText;

        if (!group.customExcuses.includes(excuseText)) {
            group.customExcuses.unshift(excuseText);
        }

        // Si dijo que iba y se borra a menos de 2 horas, suma punto en el Fantasmetro
        if (hadSaidYes && hoursLeft <= 2 && hoursLeft >= -4) {
            plan.flakes[activeUser.id] = 'Baja a última hora (<2h)';
            showToast(`👻 ¡${activeUser.name} suma +1 en el Fantasmetro por borrarse a última hora!`);
        } else {
            showToast('🤥 Excusa registrada en el Excusómetro');
        }

        saveState();
        document.getElementById('modal-excuse').classList.add('hidden');
        renderApp();
    });

    // --- 6. CIERRE DE QUEDADA: PASE DE LISTA + PUNTUALIDAD + FOTO DE PRUEBA ---
    document.getElementById('btn-finished-banner-open').addEventListener('click', () => {
        const planId = document.getElementById('finished-hangout-banner').dataset.planId;
        if (planId) openConfirmAttendanceModal(planId);
    });

    document.getElementById('open-notifications-btn').addEventListener('click', () => {
        const group = getActiveGroup();
        if (!group) return;
        const pending = group.plans.find(p => getPlanLifecycleState(p) === 'pending_check');
        if (pending) openConfirmAttendanceModal(pending.id);
        else showToast('🔔 No tienes quedadas pendientes de pasar lista');
    });

    document.getElementById('confirm-attendance-members-list').addEventListener('click', e => {
        const btn = e.target.closest('[data-action="confirm-row-toggle"]');
        if (!btn) return;
        const planId = btn.getAttribute('data-plan-id');
        const memberId = btn.getAttribute('data-member-id');
        const status = btn.getAttribute('data-status');
        const group = getActiveGroup();
        const plan = group.plans.find(p => p.id === planId);
        if (!plan) return;
        if (!plan.attendance) plan.attendance = {};
        plan.attendance[memberId] = status;
        renderConfirmAttendanceModalRows(plan);
    });

    document.getElementById('confirm-memory-photo-input').addEventListener('change', e => {
        readAndCompressImage(e.target.files[0], 480, dataUrl => {
            currentDraftMemoryPhoto = dataUrl;
            const preview = document.getElementById('memory-photo-preview');
            preview.src = dataUrl;
            preview.classList.remove('hidden');
            document.getElementById('memory-photo-placeholder').classList.add('hidden');
        });
    });

    document.getElementById('btn-save-final-attendance').addEventListener('click', () => {
        const planId = document.getElementById('confirm-attendance-plan-id').value;
        const group = getActiveGroup();
        const plan = group.plans.find(p => p.id === planId);
        if (!plan) return;

        if (!plan.flakes) plan.flakes = {};

        group.members.forEach(m => {
            const finalSt = plan.attendance[m.id] === 'yes' ? 'yes' : 'no';
            plan.attendance[m.id] = finalSt;
            // Si había prometido que iba y no vino en el pase de lista final -> Flake
            if (plan.rsvpBeforeFinish && plan.rsvpBeforeFinish[m.id] === 'yes' && finalSt === 'no') {
                plan.flakes[m.id] = 'No apareció en la quedada';
            }
        });

        plan.lateMemberId = document.getElementById('confirm-late-member-select').value || null;
        plan.memoryPhoto = currentDraftMemoryPhoto || '';
        plan.memoryQuote = document.getElementById('confirm-memory-quote-input').value.trim();

        plan.completed = true;
        plan.pendingAttendanceCheck = false;
        plan.votingOpen = false;
        saveState();
        document.getElementById('modal-confirm-attendance').classList.add('hidden');
        renderApp();
        showToast('📸 ¡Quedada cerrada y guardada en la Cápsula del Tiempo!');
    });

    // --- 7. TÍTULOS DINÁMICOS Y WRAPPED ---
    const openCustomTitlesModal = () => {
        const group = getActiveGroup();
        if (!group) return;
        document.getElementById('title-mvp-input').value = group.customTitles.mvp;
        document.getElementById('title-zero-input').value = group.customTitles.zero;
        document.getElementById('title-flake-input').value = group.customTitles.flake;
        document.getElementById('title-late-input').value = group.customTitles.late;
        document.getElementById('modal-custom-titles').classList.remove('hidden');
    };

    document.getElementById('btn-edit-custom-titles').addEventListener('click', openCustomTitlesModal);
    document.getElementById('btn-open-titles-from-group').addEventListener('click', openCustomTitlesModal);

    document.getElementById('form-custom-titles').addEventListener('submit', e => {
        e.preventDefault();
        const group = getActiveGroup();
        if (!group) return;
        group.customTitles = {
            mvp: document.getElementById('title-mvp-input').value.trim(),
            zero: document.getElementById('title-zero-input').value.trim(),
            flake: document.getElementById('title-flake-input').value.trim(),
            late: document.getElementById('title-late-input').value.trim()
        };
        saveState();
        document.getElementById('modal-custom-titles').classList.add('hidden');
        renderApp();
        showToast('🏷️ Títulos dinámicos actualizados');
    });

    document.getElementById('open-wrapped-btn').addEventListener('click', openStoryWrappedModal);

    document.getElementById('share-wrapped-btn').addEventListener('click', () => {
        const group = getActiveGroup();
        const url = getGroupInviteUrl(group);
        const text = `✨ *Story Wrapped de ${group.name} en Quién queda?!*\nMira nuestras estadísticas, rachas y títulos del grupo:\n${url}`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    });

    // --- 8. PROPUESTAS Y FILTROS DE ESTADÍSTICAS ---
    document.getElementById('form-add-proposal').addEventListener('submit', e => {
        e.preventDefault();
        const planId = document.getElementById('proposal-plan-id').value;
        const time = document.getElementById('proposal-time-input').value;
        const location = document.getElementById('proposal-location-input').value.trim();
        const reason = document.getElementById('proposal-reason-input').value.trim();
        const group = getActiveGroup();
        const activeUser = getActiveUser();
        const plan = group.plans.find(p => p.id === planId);
        if (!plan) return;

        if (!plan.proposals) plan.proposals = [];
        plan.proposals.push({
            id: 'prop_' + Date.now(),
            time,
            location,
            reason,
            authorId: activeUser.id,
            votes: [activeUser.id]
        });

        saveState();
        document.getElementById('modal-add-proposal').classList.add('hidden');
        renderPlansView();
        showToast('🗳️ Propuesta añadida');
    });

    document.querySelectorAll('#view-stats .period-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#view-stats .period-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            statsPeriodMode = btn.getAttribute('data-period-mode');
            selectedPeriodKey = null;
            renderStatsView();
        });
    });

    document.getElementById('period-selector-strip').addEventListener('click', e => {
        const pill = e.target.closest('[data-period-key]');
        if (!pill) return;
        selectedPeriodKey = pill.getAttribute('data-period-key');
        renderStatsView();
    });

    // --- 9. GESTIÓN DEL GRUPO Y ADMINS ESTILO WHATSAPP ---
    document.getElementById('edit-group-photo-input').addEventListener('change', e => {
        readAndCompressImage(e.target.files[0], 240, dataUrl => {
            const group = getActiveGroup();
            if (!group) return;
            group.photo = dataUrl;
            saveState();
            renderApp();
            showToast('📷 Foto del grupo actualizada');
        });
    });

    document.getElementById('btn-edit-group-info').addEventListener('click', () => {
        const group = getActiveGroup();
        if (!group) return;
        document.getElementById('edit-group-name-input').value = group.name;
        document.getElementById('edit-group-desc-input').value = group.description || '';
        document.getElementById('modal-edit-group').classList.remove('hidden');
    });

    document.getElementById('form-edit-group').addEventListener('submit', e => {
        e.preventDefault();
        const group = getActiveGroup();
        if (!group) return;
        group.name = document.getElementById('edit-group-name-input').value.trim();
        group.description = document.getElementById('edit-group-desc-input').value.trim();
        saveState();
        document.getElementById('modal-edit-group').classList.add('hidden');
        renderApp();
        showToast('✏️ Datos del grupo actualizados');
    });

    document.getElementById('open-user-switcher').addEventListener('click', () => {
        openWhoAreYouModal();
    });

    document.getElementById('who-modal-members-grid').addEventListener('click', e => {
        const card = e.target.closest('[data-pick-member]');
        if (!card) return;
        trySelectOrLinkMember(card.getAttribute('data-pick-member'));
    });

    const openMyAuthenticatorBtn = document.getElementById('btn-open-my-authenticator');
    if (openMyAuthenticatorBtn) {
        openMyAuthenticatorBtn.addEventListener('click', async () => {
            if (!appState.currentAccount) return;
            if (!appState.currentAccount.totpSecret) {
                appState.currentAccount.totpSecret = generateBase32Secret(16);
                await saveAccountToCloudRegistry(appState.currentAccount);
                saveState();
            }
            document.getElementById('modal-who-are-you').classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
            document.getElementById('onboarding-screen').classList.add('hidden');
            document.getElementById('main-app-shell').classList.add('hidden');
            showAuthenticatorSetupCard(appState.currentAccount);
        });
    }

    const switchPhoneBtn = document.getElementById('btn-switch-phone-account');
    if (switchPhoneBtn) {
        switchPhoneBtn.addEventListener('click', () => {
            document.getElementById('modal-who-are-you').classList.add('hidden');
            appState.currentAccount = null;
            saveState(false);
            renderApp();
        });
    }

    const pinVerifyForm = document.getElementById('form-pin-verify');
    if (pinVerifyForm) {
        pinVerifyForm.addEventListener('submit', async e => {
            e.preventDefault();
            const memberId = document.getElementById('pin-verify-member-id').value;
            const enteredVal = document.getElementById('pin-verify-input').value.trim();
            const group = getActiveGroup();
            if (!group) return;
            const member = group.members.find(m => m.id === memberId);
            if (!member) return;

            let verified = false;
            const linkedAcc = member.username ? await findAccountByUsername(member.username) : null;
            const targetPassword = (linkedAcc && linkedAcc.password) || member.password || '';
            const targetTotpSecret = (linkedAcc && linkedAcc.totpSecret) || member.totpSecret || '';

            if (targetPassword && enteredVal === targetPassword) {
                verified = true;
            } else if (targetTotpSecret && /^\d{6}$/.test(enteredVal)) {
                verified = await verifyTotpCode(targetTotpSecret, enteredVal);
            } else if (!targetPassword && !targetTotpSecret && enteredVal.length >= 4) {
                // Si el admin pre-asignó el @usuario pero el amigo aún no había registrado contraseña
                member.password = enteredVal;
                verified = true;
            }

            if (!verified) {
                showToast('❌ Contraseña o código de Authenticator incorrecto.');
                return;
            }

            if (member.username) {
                const handle = normalizeUsername(member.username);
                appState.currentAccount = linkedAcc || {
                    username: handle,
                    name: member.name,
                    password: targetPassword || enteredVal,
                    totpSecret: targetTotpSecret || generateBase32Secret(16),
                    avatar: member.avatar
                };
                if (!appState.accounts) appState.accounts = {};
                appState.accounts[handle] = appState.currentAccount;
            }

            appState.activeUserId = member.id;
            saveState();
            document.getElementById('modal-pin-verify').classList.add('hidden');
            document.getElementById('modal-who-are-you').classList.add('hidden');
            renderApp();
            showToast(`🔓 Perfil de ${member.name} (${formatHandle(member.username)}) verificado`);
        });
    }

    document.getElementById('who-modal-new-member-btn').addEventListener('click', () => {
        document.getElementById('modal-who-are-you').classList.add('hidden');
        document.getElementById('modal-add-member').classList.remove('hidden');
    });

    document.getElementById('group-members-list').addEventListener('click', e => {
        const group = getActiveGroup();
        if (!group) return;

        // Dar o quitar Admin (Garantizando siempre mínimo 1 Admin como en WhatsApp)
        const adminBtn = e.target.closest('[data-action="toggle-admin"]');
        if (adminBtn) {
            e.stopPropagation();
            const userId = adminBtn.getAttribute('data-user-id');
            const targetMember = group.members.find(m => m.id === userId);
            if (!targetMember) return;

            const currentAdminsCount = group.members.filter(m => m.isAdmin).length;
            if (targetMember.isAdmin && currentAdminsCount <= 1) {
                showToast('⚠️ Siempre debe haber mínimo 1 Admin en el grupo. Nombra a otro antes.');
                return;
            }
            targetMember.isAdmin = !targetMember.isAdmin;
            saveState();
            renderApp();
            showToast(targetMember.isAdmin ? `👑 ${targetMember.name} ahora es Admin` : `${targetMember.name} ya no es Admin`);
            return;
        }

        const removeBtn = e.target.closest('[data-action="remove-member"]');
        if (removeBtn) {
            e.stopPropagation();
            const userId = removeBtn.getAttribute('data-user-id');
            if (group.members.length <= 1) {
                showToast('⚠️ El grupo debe tener al menos 1 integrante');
                return;
            }
            group.members = group.members.filter(m => m.id !== userId);
            ensureAtLeastOneAdmin(group);
            if (appState.activeUserId === userId) {
                appState.activeUserId = group.members[0].id;
            }
            saveState();
            renderApp();
            showToast('🗑️ Integrante eliminado');
            return;
        }

        const switchItem = e.target.closest('[data-action="switch-user"]');
        if (switchItem) {
            trySelectOrLinkMember(switchItem.getAttribute('data-user-id'));
        }
    });

    document.getElementById('open-add-member-btn').addEventListener('click', () => {
        document.getElementById('modal-add-member').classList.remove('hidden');
    });

    document.querySelectorAll('#member-avatar-picker .avatar-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#member-avatar-picker .avatar-opt').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    document.getElementById('form-add-member').addEventListener('submit', e => {
        e.preventDefault();
        const name = document.getElementById('member-name-input').value.trim();
        const usernameInputEl = document.getElementById('member-username-input');
        const rawUsername = usernameInputEl ? usernameInputEl.value.trim() : '';
        const username = normalizeUsername(rawUsername);
        const avatarEl = document.querySelector('#member-avatar-picker .avatar-opt.active');
        const avatar = avatarEl ? avatarEl.getAttribute('data-avatar') : '😎';
        const isAdmin = document.getElementById('member-is-admin-toggle').checked;
        const group = getActiveGroup();
        if (!group) return;

        if (username && group.members.some(m => normalizeUsername(m.username) === username)) {
            showToast(`⚠️ Ya hay un integrante con ${formatHandle(username)} en el grupo`);
            return;
        }

        const newMember = {
            id: 'u_' + Date.now(),
            name,
            avatar,
            isAdmin,
            username: username || '',
            password: '',
            totpSecret: ''
        };
        group.members.push(newMember);
        ensureAtLeastOneAdmin(group);
        saveState();
        document.getElementById('form-add-member').reset();
        document.getElementById('modal-add-member').classList.add('hidden');
        renderApp();
        showToast(username ? `👥 ${name} añadido y reservado para ${formatHandle(username)}` : `👥 ${name} añadido (vinculará su @usuario al entrar)`);
    });

    // --- 10. COMPARTIR WEB Y GRUPO POR WHATSAPP ---
    const updateShareInputsWithUrl = (group, url) => {
        const linkInput = document.getElementById('share-generated-link-input');
        if (linkInput) linkInput.value = url;
        const msgInput = document.getElementById('share-custom-message-input');
        if (msgInput) {
            msgInput.value = `Métete al grupo ${group.name} en Quién queda?:\n${url}`;
        }
    };

    const openShareGroupModal = async () => {
        const group = getActiveGroup();
        if (!group) return;

        appState.customPublicUrl = normalizePublicBaseUrl(appState.customPublicUrl);

        const warningBox = document.getElementById('local-url-warning-box');
        if (warningBox) {
            warningBox.classList.add('hidden');
        }

        document.getElementById('custom-public-url-input').value = appState.customPublicUrl || DEFAULT_PUBLIC_WEB_URL;
        document.getElementById('modal-share-group').classList.remove('hidden');

        // Mostrar primero versión inmediata y en 0.2s reemplazar por enlace corto ?k=... sin &pack
        delete group.lastShortUrl;
        const fallbackUrl = getGroupInviteUrl(group);
        updateShareInputsWithUrl(group, '⏳ Generando enlace corto...');

        const shortUrl = await prepareShortGroupInviteUrl(group);
        saveState(false);
        updateShareInputsWithUrl(group, shortUrl || fallbackUrl);
    };

    document.getElementById('open-share-header-btn').addEventListener('click', openShareGroupModal);
    document.getElementById('share-whatsapp-btn').addEventListener('click', openShareGroupModal);

    document.getElementById('btn-save-public-url').addEventListener('click', async () => {
        const rawVal = document.getElementById('custom-public-url-input').value.trim();
        const val = normalizePublicBaseUrl(rawVal);
        appState.customPublicUrl = val;
        document.getElementById('custom-public-url-input').value = val;
        saveState(false);
        const group = getActiveGroup();
        if (group) {
            delete group.lastShortUrl;
            const shortUrl = await prepareShortGroupInviteUrl(group);
            updateShareInputsWithUrl(group, shortUrl);
        }
        showToast(`✅ Dominio actualizado: ${val}`);
    });

    document.getElementById('btn-copy-magic-link').addEventListener('click', async () => {
        const group = getActiveGroup();
        if (!group) return;
        const linkInput = document.getElementById('share-generated-link-input');
        const url = (linkInput && linkInput.value && !linkInput.value.startsWith('⏳'))
            ? linkInput.value
            : await prepareShortGroupInviteUrl(group);
        if (navigator.clipboard) navigator.clipboard.writeText(url);
        showToast('📋 Enlace corto copiado');
    });

    document.getElementById('copy-code-btn').addEventListener('click', async () => {
        const group = getActiveGroup();
        if (!group) return;
        const url = await prepareShortGroupInviteUrl(group);
        if (navigator.clipboard) navigator.clipboard.writeText(url);
        showToast('🔗 Enlace corto del grupo copiado');
    });

    document.getElementById('btn-send-wa-direct').addEventListener('click', async () => {
        const group = getActiveGroup();
        if (!group) return;
        const msgInput = document.getElementById('share-custom-message-input');
        let msg = msgInput ? msgInput.value.trim() : '';
        if (!msg || msg.includes('⏳')) {
            const url = await prepareShortGroupInviteUrl(group);
            msg = `Métete al grupo ${group.name} en Quién queda?:\n${url}`;
        }
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    });

    document.getElementById('btn-native-share').addEventListener('click', async () => {
        const group = getActiveGroup();
        if (!group) return;
        const url = await prepareShortGroupInviteUrl(group);
        if (navigator.share) {
            try {
                await navigator.share({
                    title: group.name,
                    url
                });
            } catch (e) {
                // Cancelado por el usuario
            }
        } else {
            if (navigator.clipboard) navigator.clipboard.writeText(url);
            showToast('📋 Enlace corto copiado');
        }
    });

    const openGroupSwitcherModal = () => {
        const listEl = document.getElementById('groups-switcher-list');
        listEl.innerHTML = appState.groups.map(g => `
            <div class="member-item ${g.id === appState.activeGroupId ? 'active-me' : ''}" data-switch-group="${g.id}">
                <div class="member-left">
                    <div class="member-avatar">${g.emoji || '👥'}</div>
                    <div>
                        <div class="member-name">${escapeHtml(g.name)}</div>
                        <div class="member-role">${g.members.length} integrantes · ${g.plans.length} quedadas</div>
                    </div>
                </div>
                ${g.id === appState.activeGroupId ? `<span class="member-badge-me">ACTIVO</span>` : ''}
            </div>
        `).join('');
        document.getElementById('modal-group-switcher').classList.remove('hidden');
    };

    document.getElementById('open-group-switcher').addEventListener('click', openGroupSwitcherModal);
    document.getElementById('btn-create-new-group').addEventListener('click', openGroupSwitcherModal);

    document.getElementById('groups-switcher-list').addEventListener('click', e => {
        const item = e.target.closest('[data-switch-group]');
        if (!item) return;
        appState.activeGroupId = item.getAttribute('data-switch-group');
        const g = getActiveGroup();
        appState.activeUserId = g.members[0]?.id || null;
        saveState(false);
        document.getElementById('modal-group-switcher').classList.add('hidden');
        renderApp();
    });

    document.getElementById('btn-launch-new-group-wizard').addEventListener('click', () => {
        document.getElementById('modal-group-switcher').classList.add('hidden');
        onboardingDraftPhoto = '';
        onboardingDraftMembers = [];
        document.getElementById('onboarding-screen').classList.remove('hidden');
        renderOnboardingDraftMembers();
    });

    document.getElementById('btn-delete-current-group').addEventListener('click', () => {
        const group = getActiveGroup();
        if (!group) return;
        appState.groups = appState.groups.filter(g => g.id !== group.id);
        appState.activeGroupId = appState.groups[0]?.id || null;
        appState.activeUserId = appState.groups[0]?.members[0]?.id || null;
        saveState(false);
        renderApp();
        showToast('🗑️ Grupo eliminado');
    });

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.getAttribute('data-close-modal');
            document.getElementById(modalId).classList.add('hidden');
        });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.classList.add('hidden');
        });
    });
}

function switchMainTab(targetId) {
    currentTab = targetId;
    document.querySelectorAll('.tab-view').forEach(sec => {
        sec.classList.toggle('hidden', sec.id !== targetId);
    });
    document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
    });
    document.getElementById('app-content').scrollTop = 0;
    renderApp();
}

// ==========================================================================
// INICIO DE LA APLICACIÓN (IMPORTA DESDE ENLACE CORTO ?k=, NUBE O PACK)
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    loadState();
    setupEventListeners();

    const params = new URLSearchParams(window.location.search);
    const shortKeyParam = params.get('k');
    const codeParam = params.get('grupo');
    const packParam = params.get('pack');

    let importedGroup = null;

    if (shortKeyParam) {
        importedGroup = await fetchGroupFromShortKey(shortKeyParam);
    }

    if (!importedGroup && codeParam) {
        importedGroup = await fetchGroupFromCloudByCode(codeParam);
        if (!importedGroup && packParam) {
            importedGroup = decodeGroupPack(packParam);
        }
    }

    if (importedGroup) {
        const idx = appState.groups.findIndex(
            g => (g.inviteCode && importedGroup.inviteCode && g.inviteCode.toUpperCase() === importedGroup.inviteCode.toUpperCase()) || g.id === importedGroup.id
        );
        if (idx >= 0) appState.groups[idx] = importedGroup;
        else appState.groups.push(importedGroup);
        appState.activeGroupId = importedGroup.id;
        appState.activeUserId = importedGroup.members[0]?.id || null;
        saveState(false);
    }

    renderApp();
    if ((shortKeyParam || codeParam) && getActiveGroup() && appState.currentAccount) {
        openWhoAreYouModal();
    }
    setInterval(checkPendingFinishedHangouts, 30000);
});
