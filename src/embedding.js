// 直连 Jina embeddings（浏览器 fetch，依赖 Jina 放行 CORS）。
// jina-embeddings-v3 为非对称检索：passage 用 retrieval.passage，query 用 retrieval.query。

import { warn } from './util.js';

/**
 * 调用一次 embeddings 端点。
 * @param {object} embSettings settings.embedding
 * @param {'retrieval.passage'|'retrieval.query'} task
 * @param {string[]} inputs 文本数组
 * @param {AbortSignal|null} signal
 * @returns {Promise<number[][]>} 与 inputs 顺序对齐的向量数组
 */
export async function callEmbeddings(embSettings, task, inputs, signal = null) {
    if (!embSettings?.endpoint) {
        throw new Error('未配置 Embedding 端点');
    }
    if (!embSettings?.apiKey) {
        throw new Error('未配置 Embedding API Key');
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
        return [];
    }

    const body = {
        model: embSettings.model || 'jina-embeddings-v3',
        task,
        input: inputs,
    };
    const dim = Number(embSettings.dimensions);
    if (Number.isFinite(dim) && dim > 0) {
        body.dimensions = dim;
    }

    let response;
    try {
        response = await fetch(embSettings.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${embSettings.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: signal ?? undefined,
        });
    } catch (e) {
        throw new Error(`Embedding 请求失败（网络/CORS）：${e?.message || e}`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Embedding 端点返回 ${response.status}：${text.slice(0, 300)}`);
    }

    const json = await response.json();
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error(`Embedding 响应异常：期望 ${inputs.length} 条，实得 ${Array.isArray(data) ? data.length : 'N/A'}`);
    }

    // 按 index 对齐（Jina 通常按序返回，仍显式排序以防万一）
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((d) => d.embedding);
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
        throw new Error('Embedding 响应缺少有效向量');
    }
    return vectors;
}

/** 批量嵌入原文片段（passage） */
export async function embedPassages(texts, embSettings, signal = null) {
    return callEmbeddings(embSettings, 'retrieval.passage', texts, signal);
}

/** 嵌入单条查询（query），返回单个向量 */
export async function embedQuery(text, embSettings, signal = null) {
    const [vec] = await callEmbeddings(embSettings, 'retrieval.query', [text], signal);
    if (!vec) {
        throw new Error('查询向量为空');
    }
    return vec;
}

/**
 * 测试连接：发一条短文本，返回探测到的维度。
 * @returns {Promise<{ok: boolean, dim?: number, message: string}>}
 */
export async function testEmbedding(embSettings) {
    try {
        const [vec] = await callEmbeddings(embSettings, 'retrieval.query', ['连接测试 connection test'], null);
        return { ok: true, dim: vec.length, message: `成功，向量维度 ${vec.length}` };
    } catch (e) {
        warn('embedding 测试失败', e);
        return { ok: false, message: String(e?.message || e) };
    }
}
