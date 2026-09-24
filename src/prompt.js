// 注入包裹渲染 + setExtensionPrompt 封装。

import { ctx, esc, truncate, INJECT_KEY } from './util.js';
import { getSettings, PASSAGE_TEMPLATE } from './settings.js';

/**
 * 渲染包裹后的注入文本。
 * @param {Array<{text:string, source:string, chapter:string|null, score:number}>} passages
 * @param {string} wrapTemplate 含 {{passages}} 占位符
 * @param {{perPassageCharCap:number}} opts
 * @returns {string}
 */
export function buildWrapped(passages, wrapTemplate, { perPassageCharCap } = {}) {
    const cap = Number(perPassageCharCap) || 600;
    const rendered = passages.map((p) => {
        const text = truncate(p.text, cap);
        return PASSAGE_TEMPLATE
            .replace('{{source}}', esc(p.source || ''))
            .replace('{{chapter}}', esc(p.chapter || ''))
            .replace('{{score}}', esc(typeof p.score === 'number' ? p.score.toFixed(3) : ''))
            .replace('{{text}}', esc(text));
    }).join('\n');

    const template = wrapTemplate && wrapTemplate.includes('{{passages}}')
        ? wrapTemplate
        : '{{passages}}';
    return template.replace('{{passages}}', rendered);
}

/** 应用注入到当前提示词（同 key 覆盖） */
export function applyInjection(text) {
    const inject = getSettings().inject;
    ctx().setExtensionPrompt(
        INJECT_KEY,
        text,
        Number(inject.position),
        Number(inject.depth),
        false,
        Number(inject.role),
    );
}

/** 清空注入（写空串） */
export function clearInjection() {
    const inject = getSettings().inject;
    ctx().setExtensionPrompt(
        INJECT_KEY,
        '',
        Number(inject.position),
        Number(inject.depth),
        false,
        Number(inject.role),
    );
}
