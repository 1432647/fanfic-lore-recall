// 同人原著向量召回插件 —— 公共工具与常量
// 该模块只提供无副作用的纯工具与宿主访问器，供其余模块复用（DRY）。

/** extensionSettings 下的配置键 */
export const MODULE_KEY = 'fanficLoreRecall';

/** setExtensionPrompt 使用的注入键（同 key 覆盖） */
export const INJECT_KEY = 'FANFIC_LORE_RECALL';

/** 注册到 globalThis 的生成拦截器函数名（需与 manifest.generate_interceptor 一致） */
export const INTERCEPTOR_NAME = 'fanficLoreRecall_intercept';

/** 供 LLM 密钥使用的 secret 存储键（自定义 OpenAI 兼容端点） */
export const CUSTOM_SECRET_KEY = 'api_key_custom';

// extension_prompt_types / roles 属于宿主稳定契约常量，此处本地固化，
// 避免第三方扩展去 import 宿主内部模块。
export const EXT_PROMPT_TYPES = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const EXT_PROMPT_ROLES = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

const LOG_PREFIX = '[FanficLoreRecall]';
export const log = (...a) => console.log(LOG_PREFIX, ...a);
export const warn = (...a) => console.warn(LOG_PREFIX, ...a);
export const error = (...a) => console.error(LOG_PREFIX, ...a);
export const debug = (...a) => console.debug(LOG_PREFIX, ...a);

/** 获取宿主 SillyTavern 上下文（懒访问，调用时宿主已就绪） */
export function ctx() {
    const st = globalThis.SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('SillyTavern 上下文尚不可用');
    }
    return st.getContext();
}

/** 等待 TauriTavern 宿主就绪 */
export async function hostReady() {
    const gate = window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__;
    if (gate) {
        await gate;
    }
}

/** 是否运行在 TauriTavern 宿主中（决定 api.db 是否可用） */
export function isTauri() {
    return !!window.__TAURITAVERN__?.api?.db;
}

/** 获取 TriviumDB 数据库 API，缺失即 fail-fast */
export function db() {
    const api = window.__TAURITAVERN__?.api?.db;
    if (!api) {
        throw new Error('window.__TAURITAVERN__.api.db 不可用（需在 TauriTavern 中运行）');
    }
    return api;
}

/** HTML 属性/文本转义（用于包裹模板，防止原文里的尖括号破坏结构） */
export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 截断到 n 个字符，超出加省略号 */
export function truncate(text, n) {
    const s = String(text ?? '');
    if (!Number.isFinite(n) || n <= 0 || s.length <= n) {
        return s;
    }
    return s.slice(0, n).trimEnd() + '…';
}

/**
 * 粗略 token 估算：CJK 约 1 token ≈ 1.6 字，其余按 ~4 字符/token。
 * 仅用于切块预算，不追求精确。
 */
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const other = s.length - cjk;
    return Math.ceil(cjk / 1.6 + other / 4);
}

/** 由任意 id 生成合法 TriviumDB 命名空间：fflr_<id>，仅 [a-z0-9-_]，≤128 */
export function sanitizeNamespace(id) {
    const ns = ('fflr_' + String(id)).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return ns.slice(0, 128);
}

/**
 * 当前角色卡的稳定标识：avatar 文件名（重命名显示名不影响它）。
 * 群组或无角色时返回 null。
 */
export function currentCharacterKey(context = ctx()) {
    if (context.groupId) {
        return null;
    }
    const character = context.characters?.[context.characterId];
    const avatar = character?.avatar;
    return typeof avatar === 'string' && avatar.length ? avatar : null;
}

/** 生成 uuid（优先宿主提供，回退 crypto） */
export function uuid(context = ctx()) {
    if (typeof context.uuidv4 === 'function') {
        return context.uuidv4();
    }
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** 简单深合并默认值：只在目标缺键时补齐，不覆盖已有值 */
export function applyDefaults(target, defaults) {
    if (target === null || typeof target !== 'object') {
        return structuredClone(defaults);
    }
    for (const [key, dv] of Object.entries(defaults)) {
        if (!(key in target)) {
            target[key] = structuredClone(dv);
        } else if (dv && typeof dv === 'object' && !Array.isArray(dv)
            && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            applyDefaults(target[key], dv);
        }
    }
    return target;
}
