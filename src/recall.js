// 每轮召回流程编排（由 generate_interceptor 触发）。
// 失败哲学：per-turn 召回绝不阻断用户生成 —— 任何错误都清空注入并继续（fail-safe）。

import { log, warn, error, debug, truncate } from './util.js';
import { getSettings } from './settings.js';
import { resolveActiveLibrary } from './binding.js';
import { openLibraryDb } from './libraries.js';
import { writeQuery } from './llm.js';
import { embedQuery } from './embedding.js';
import { rerank } from './rerank.js';
import { buildWrapped, applyInjection, clearInjection } from './prompt.js';

/**
 * 从传入的 chat 数组取最近上下文（只看聊天，不含角色卡/世界书）。
 * 取末尾 2*floors+1 条，过滤 is_system/隐藏消息。
 * @returns {string}
 */
function buildContextText(chat, floors) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return '';
    }
    const windowSize = 2 * Math.max(0, Number(floors) || 0) + 1;
    const slice = chat.slice(-windowSize);
    const parts = [];
    for (const msg of slice) {
        if (!msg || msg.is_system) continue;
        const content = String(msg.mes ?? '').trim();
        if (!content) continue;
        const speaker = msg.is_user ? (msg.name || 'User') : (msg.name || 'Char');
        parts.push(`${speaker}: ${content}`);
    }
    // 限制总长度，防止召回词 LLM 输入过大（取尾部）
    let text = parts.join('\n');
    const MAX_CONTEXT_CHARS = 4000;
    if (text.length > MAX_CONTEXT_CHARS) {
        text = text.slice(-MAX_CONTEXT_CHARS);
    }
    return text;
}

/** 组装 search 选项，仅包含已设置的可选项 */
function buildSearchOptions(retrieval, query) {
    const options = {
        topK: Number(retrieval.topK) || 20,
        queryText: query,
        enableTextHybridSearch: retrieval.enableTextHybridSearch !== false,
    };
    if (Number.isFinite(Number(retrieval.minScore))) {
        options.minScore = Number(retrieval.minScore);
    }
    if (Number.isFinite(Number(retrieval.bm25K1))) options.bm25K1 = Number(retrieval.bm25K1);
    if (Number.isFinite(Number(retrieval.bm25B))) options.bm25B = Number(retrieval.bm25B);
    if (Number.isFinite(Number(retrieval.textBoost))) options.textBoost = Number(retrieval.textBoost);
    return options;
}

/** 从 Hit 提取片段 */
function hitToPassage(hit) {
    const payload = hit?.payload || {};
    return {
        text: String(payload.text ?? ''),
        source: payload.source ?? '',
        chapter: payload.chapter ?? null,
        score: Number(hit?.score) || 0,
    };
}

/**
 * 生成拦截器主体。
 * @param {any[]} chat
 * @param {number} _contextSize
 * @param {(immediately:boolean)=>void} _abort
 * @param {string} type
 */
export async function intercept(chat, _contextSize, _abort, type) {
    const settings = getSettings();

    // 先清空上一轮的注入，避免残留
    try {
        clearInjection();
    } catch (e) {
        warn('清空注入失败（忽略）', e);
    }

    // 跳过后台/工具类静默生成
    if (type === 'quiet') {
        return;
    }

    try {
        const lib = resolveActiveLibrary();
        if (!lib) {
            debug('无活动库，跳过召回');
            return;
        }

        // 未配置必要通道则静默跳过，避免每轮报错刷屏
        if (!settings.llm.endpoint || !settings.llm.secretId || !settings.llm.model) {
            debug('LLM 未配置完整，跳过召回');
            return;
        }
        if (!settings.embedding.endpoint || !settings.embedding.apiKey) {
            debug('Embedding 未配置完整，跳过召回');
            return;
        }

        const contextText = buildContextText(chat, settings.context.floors);
        if (!contextText) {
            debug('上下文为空，跳过召回');
            return;
        }

        // 1) 生成召回词（插件独立 LLM）
        const query = await writeQuery(contextText, settings.llm);
        log('召回词：', query);

        // 2) 查询向量
        const queryVec = await embedQuery(query, settings.embedding);

        // 3) 向量 + 文本混合检索
        const handle = await openLibraryDb(lib);
        const hits = await handle.search(queryVec, buildSearchOptions(settings.retrieval, query));
        debug('检索候选：', hits.map((h) => ({ id: h.id, score: Number(h.score).toFixed(3) })));

        if (!hits.length) {
            debug('检索无结果，清空注入');
            return;
        }

        const topN = Math.max(1, Number(settings.rerank.topN) || 5);
        let passages;

        // 4) 重排
        if (settings.rerank.enabled && hits.length > topN) {
            try {
                const documents = hits.map((h) => String(h.payload?.text ?? ''));
                const reranked = await rerank(query, documents, topN, settings.rerank);
                passages = reranked.slice(0, topN).map((r) => {
                    const p = hitToPassage(hits[r.index]);
                    p.score = r.score; // 用重排相关度覆盖
                    return p;
                });
                debug('重排结果：', reranked.slice(0, topN).map((r) => ({ index: r.index, score: r.score.toFixed(3) })));
            } catch (e) {
                warn('重排失败，回退到检索顺序：', e?.message || e);
                passages = hits.slice(0, topN).map(hitToPassage);
            }
        } else {
            passages = hits.slice(0, topN).map(hitToPassage);
        }

        // 5) 包裹 + 注入
        const wrapped = buildWrapped(passages, settings.inject.wrapTemplate, {
            perPassageCharCap: settings.inject.perPassageCharCap,
        });
        applyInjection(wrapped);
        log(`已注入 ${passages.length} 段原著参考（position=${settings.inject.position}, depth=${settings.inject.depth}, role=${settings.inject.role}）`);
        debug('注入内容预览：', truncate(wrapped, 500));
    } catch (e) {
        // fail-safe：不阻断生成
        error('召回流程失败（已跳过，不影响生成）：', e);
        try {
            clearInjection();
        } catch (_) { /* ignore */ }
    }
}

// 也可在需要时读取当前上下文（供面板诊断），此处仅导出核心。
export { buildContextText };
