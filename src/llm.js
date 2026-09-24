// 召回词生成：使用插件自己配置的 LLM（custom OpenAI 兼容端点 + secret_id），
// 经宿主 ChatCompletionService（走 Rust reqwest，免 CORS）。
// 绝不传 presetName —— 避免继承用户的 oai_settings，保持完全独立。

import { ctx, warn } from './util.js';

const SYSTEM_PROMPT = [
    '你是一个“原著检索词生成器”。',
    '根据给定的最近对话上下文，输出一条用于在原著语料库中做向量检索的简洁查询词。',
    '要求：',
    '1. 只输出查询词本身，覆盖当前场景的关键实体、地点、氛围、动作、物件等要素；',
    '2. 不要续写剧情，不要解释，不要输出任何多余文字或标点说明；',
    '3. 控制在一到两句话或若干关键词之内。',
].join('\n');

/**
 * 生成召回查询词。
 * @param {string} contextText 最近对话拼接文本
 * @param {object} llmSettings settings.llm
 * @param {AbortSignal|null} signal
 * @returns {Promise<string>}
 */
export async function writeQuery(contextText, llmSettings, signal = null) {
    if (!llmSettings?.endpoint) {
        throw new Error('未配置 LLM 端点');
    }
    if (!llmSettings?.secretId) {
        throw new Error('未配置 LLM API Key（secretId 为空）');
    }
    if (!llmSettings?.model) {
        throw new Error('未配置 LLM 模型');
    }

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `最近对话：\n${contextText}\n\n请输出用于检索原著片段的查询词：` },
    ];

    const requestData = {
        stream: false,
        messages,
        model: llmSettings.model,
        chat_completion_source: 'custom',
        custom_url: llmSettings.endpoint,
        secret_id: llmSettings.secretId,
        max_tokens: Number(llmSettings.maxTokens) || 200,
        temperature: Number.isFinite(Number(llmSettings.temperature)) ? Number(llmSettings.temperature) : 0.3,
    };

    // options 必须是对象（processRequest 会解构 presetName）；不传 presetName。
    const result = await ctx().ChatCompletionService.processRequest(requestData, {}, true, signal);
    const content = String(result?.content ?? '').trim();
    if (!content) {
        throw new Error('LLM 返回空内容');
    }
    return content;
}

/**
 * 测试 LLM 连接（首次会触发一次原生“允许自定义端点”确认框）。
 * @returns {Promise<{ok: boolean, message: string, sample?: string}>}
 */
export async function testLlm(llmSettings) {
    try {
        const sample = await writeQuery('用户：主角走进了古老的图书馆，四周一片寂静。', llmSettings, null);
        return { ok: true, message: '成功', sample };
    } catch (e) {
        warn('LLM 测试失败', e);
        return { ok: false, message: String(e?.message || e) };
    }
}

/**
 * 拉取 LLM 端点可用模型列表。
 * 走宿主 /api/backends/chat-completions/status（经 Rust，免 CORS，用 secret_id 取密钥）。
 * @param {object} llmSettings settings.llm
 * @returns {Promise<string[]>} 模型 id 列表
 */
export async function fetchModels(llmSettings) {
    if (!llmSettings?.endpoint) {
        throw new Error('未配置 LLM 端点');
    }
    if (!llmSettings?.secretId) {
        throw new Error('未配置 LLM API Key（请先在上方输入并保存密钥）');
    }

    const body = {
        chat_completion_source: 'custom',
        custom_url: llmSettings.endpoint,
        custom_api_format: 'openai',
        secret_id: llmSettings.secretId,
    };

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`状态检查失败 ${response.status}：${text.slice(0, 200)}`);
    }

    const json = await response.json();
    if (json?.error) {
        throw new Error(String(json.message || '端点返回错误'));
    }
    const list = Array.isArray(json?.data) ? json.data : [];
    const ids = list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    // 去重 + 排序
    return [...new Set(ids)].sort();
}
