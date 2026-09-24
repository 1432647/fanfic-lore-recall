// 配置 schema、默认值与读写。
// 配置存放于 getContext().extensionSettings.fanficLoreRecall，
// 通过 getContext().saveSettingsDebounced() 持久化。

import { MODULE_KEY, ctx, applyDefaults, EXT_PROMPT_TYPES, EXT_PROMPT_ROLES } from './util.js';

/** 默认注入包裹模板（role=system）。{{passages}} 为片段列表占位符。 */
export const DEFAULT_WRAP_TEMPLATE =
    '<原著参考 用途="仅供文风与场景参考，严禁照抄">\n' +
    '  <使用说明>下列片段来自原著，仅用于帮助你把握该世界观的叙事语气、意象与细节。' +
    '请吸收其风格与信息，用你自己的语言重新演绎当前剧情，不得直接复制原文语句。</使用说明>\n' +
    '  {{passages}}\n' +
    '</原著参考>';

/** 单个片段渲染模板（v1 固定，不做成可配置） */
export const PASSAGE_TEMPLATE = '<片段 来源="{{source}}·{{chapter}}" 相关度="{{score}}">{{text}}</片段>';

export const DEFAULTS = {
    enabled: true,
    llm: {
        endpoint: '',
        secretId: '',
        model: '',
        maxTokens: 200,
        temperature: 0.3,
    },
    embedding: {
        endpoint: 'https://api.jina.ai/v1/embeddings',
        apiKey: '',
        model: 'jina-embeddings-v3',
        dimensions: null, // 为空则用模型默认维度（jina-v3 默认 1024）
    },
    rerank: {
        enabled: true,
        endpoint: 'https://api.jina.ai/v1/rerank',
        apiKey: '',
        model: 'jina-reranker-v2-base-multilingual',
        topN: 5,
    },
    retrieval: {
        topK: 20,
        minScore: 0,
        enableTextHybridSearch: true,
        bm25K1: null,
        bm25B: null,
        textBoost: null,
    },
    chunking: {
        targetTokens: 400,
        overlapRatio: 0.15,
        chapterRegex: '', // 空则不启用章节识别
    },
    context: {
        floors: 3, // 当前输入 + 上 N 层（共 2N+1 条）
    },
    inject: {
        position: EXT_PROMPT_TYPES.IN_CHAT, // 1
        depth: 2,
        role: EXT_PROMPT_ROLES.SYSTEM, // 0
        perPassageCharCap: 600,
        wrapTemplate: DEFAULT_WRAP_TEMPLATE,
    },
    // 库注册表；每项结构见 libraries.js
    libraries: [],
};

/**
 * 获取插件配置（不存在则用默认值初始化，缺键则补齐）。
 * @returns {typeof DEFAULTS}
 */
export function getSettings() {
    const context = ctx();
    if (!context.extensionSettings[MODULE_KEY] || typeof context.extensionSettings[MODULE_KEY] !== 'object') {
        context.extensionSettings[MODULE_KEY] = structuredClone(DEFAULTS);
    }
    applyDefaults(context.extensionSettings[MODULE_KEY], DEFAULTS);
    return context.extensionSettings[MODULE_KEY];
}

/** 持久化配置 */
export function saveSettings() {
    ctx().saveSettingsDebounced();
}
