// 直连 Jina rerank（浏览器 fetch）。
// 请求 {model, query, top_n, documents, return_documents:false}
// 响应 {results:[{index, relevance_score}]}

import { warn } from './util.js';

/**
 * 重排序候选文档。
 * @param {string} query 查询词
 * @param {string[]} documents 候选原文片段
 * @param {number} topN 取前 N
 * @param {object} rerankSettings settings.rerank
 * @param {AbortSignal|null} signal
 * @returns {Promise<Array<{index: number, score: number}>>} 按相关度降序的原始下标 + 分数
 */
export async function rerank(query, documents, topN, rerankSettings, signal = null) {
    if (!rerankSettings?.endpoint) {
        throw new Error('未配置 Rerank 端点');
    }
    if (!rerankSettings?.apiKey) {
        throw new Error('未配置 Rerank API Key');
    }
    if (!Array.isArray(documents) || documents.length === 0) {
        return [];
    }

    const body = {
        model: rerankSettings.model || 'jina-reranker-v2-base-multilingual',
        query: String(query ?? ''),
        top_n: Math.max(1, Math.min(Number(topN) || documents.length, documents.length)),
        documents,
        return_documents: false,
    };

    let response;
    try {
        response = await fetch(rerankSettings.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${rerankSettings.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: signal ?? undefined,
        });
    } catch (e) {
        throw new Error(`Rerank 请求失败（网络/CORS）：${e?.message || e}`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Rerank 端点返回 ${response.status}：${text.slice(0, 300)}`);
    }

    const json = await response.json();
    const results = json?.results;
    if (!Array.isArray(results)) {
        throw new Error('Rerank 响应缺少 results');
    }

    return results
        .map((r) => ({ index: r.index, score: Number(r.relevance_score) }))
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
        .sort((a, b) => b.score - a.score);
}

/**
 * 测试连接。
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testRerank(rerankSettings) {
    try {
        const res = await rerank('测试查询 test query', ['第一段候选文本', '第二段候选文本'], 1, rerankSettings, null);
        return { ok: true, message: `成功，返回 ${res.length} 条重排结果` };
    } catch (e) {
        warn('rerank 测试失败', e);
        return { ok: false, message: String(e?.message || e) };
    }
}
