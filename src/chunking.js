// txt 切块：按段落聚合到 ~targetTokens，相邻块按 overlapRatio 重叠，尽量不切断句子。
// 可选 chapterRegex：命中行作为硬边界，并把章节标题写入其后各块的 chapter 字段。

import { estimateTokens, warn } from './util.js';

function buildChapterRegex(pattern) {
    if (!pattern) return null;
    try {
        return new RegExp(pattern);
    } catch (e) {
        warn('章节正则无效，已忽略：', pattern, e?.message);
        return null;
    }
}

/** 按字符硬切超长单句（无句读的极端情况） */
function hardSplitByChar(text, targetTokens) {
    const charBudget = Math.max(50, Math.floor(targetTokens * 1.6));
    const out = [];
    for (let i = 0; i < text.length; i += charBudget) {
        out.push(text.slice(i, i + charBudget));
    }
    return out;
}

/** 将超过 target 的大段落按句子切分（带重叠） */
function splitLongParagraph(paragraph, targetTokens, overlapBudget) {
    const sentences = paragraph.match(/[^。！？!?\n]*[。！？!?]+|\S[^。！？!?\n]*$/g) || [paragraph];
    const out = [];
    let buf = [];
    let bufTokens = 0;

    const flush = () => {
        const body = buf.join('').trim();
        if (body) out.push(body);
        if (overlapBudget <= 0) {
            buf = [];
            bufTokens = 0;
            return;
        }
        const carry = [];
        let carryTokens = 0;
        for (let i = buf.length - 1; i >= 0; i--) {
            const t = estimateTokens(buf[i]);
            if (carry.length && carryTokens + t > overlapBudget) break;
            carry.unshift(buf[i]);
            carryTokens += t;
            if (carryTokens >= overlapBudget) break;
        }
        buf = carry;
        bufTokens = carryTokens;
    };

    for (const sentence of sentences) {
        const st = estimateTokens(sentence);
        if (st > targetTokens) {
            flush();
            const pieces = hardSplitByChar(sentence, targetTokens);
            for (let i = 0; i < pieces.length; i++) {
                if (i < pieces.length - 1) {
                    const body = pieces[i].trim();
                    if (body) out.push(body);
                } else {
                    buf = [pieces[i]];
                    bufTokens = estimateTokens(pieces[i]);
                }
            }
            continue;
        }
        if (buf.length && bufTokens + st > targetTokens) {
            flush();
        }
        buf.push(sentence);
        bufTokens += st;
    }
    const tail = buf.join('').trim();
    if (tail) out.push(tail);
    return out;
}

/**
 * 切块主入口。
 * @param {string} rawText 原始 txt 全文
 * @param {{targetTokens?:number, overlapRatio?:number, chapterRegex?:string}} opts
 * @returns {Array<{text:string, chapter:string|null, chunkIndex:number}>}
 */
export function chunkText(rawText, opts = {}) {
    const text = String(rawText ?? '').replace(/\r\n?/g, '\n');
    const targetTokens = Math.max(50, Number(opts.targetTokens) || 400);
    const overlapRatio = Math.max(0, Math.min(0.9, Number(opts.overlapRatio) || 0));
    const overlapBudget = Math.floor(targetTokens * overlapRatio);
    const chapRe = buildChapterRegex(opts.chapterRegex);

    // 1) 先分成“段落单元”：空行分隔；章节标题行单独成硬边界单元。
    const units = [];
    let paraLines = [];
    const flushPara = () => {
        if (paraLines.length) {
            const p = paraLines.join('\n').trim();
            if (p) units.push({ type: 'para', text: p });
            paraLines = [];
        }
    };
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (chapRe && trimmed && chapRe.test(trimmed)) {
            flushPara();
            units.push({ type: 'chapter', text: trimmed });
            continue;
        }
        if (trimmed === '') {
            flushPara();
            continue;
        }
        paraLines.push(line);
    }
    flushPara();

    // 2) 聚合成 chunk。
    const chunks = [];
    let chapter = null;
    let buf = [];
    let bufTokens = 0;
    let chunkIndex = 0;

    const pushChunk = (withOverlap) => {
        const body = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (body) {
            chunks.push({ text: body, chapter, chunkIndex: chunkIndex++ });
        }
        if (!withOverlap || overlapBudget <= 0) {
            buf = [];
            bufTokens = 0;
            return;
        }
        const carry = [];
        let carryTokens = 0;
        for (let i = buf.length - 1; i >= 0; i--) {
            const t = estimateTokens(buf[i]);
            if (carry.length && carryTokens + t > overlapBudget) break;
            carry.unshift(buf[i]);
            carryTokens += t;
            if (carryTokens >= overlapBudget) break;
        }
        buf = carry;
        bufTokens = carryTokens;
    };

    for (const unit of units) {
        if (unit.type === 'chapter') {
            pushChunk(false); // 硬边界：不跨章节重叠
            chapter = unit.text;
            continue;
        }
        const pt = estimateTokens(unit.text);
        if (pt > targetTokens) {
            pushChunk(false);
            for (const sub of splitLongParagraph(unit.text, targetTokens, overlapBudget)) {
                chunks.push({ text: sub, chapter, chunkIndex: chunkIndex++ });
            }
            continue;
        }
        if (buf.length && bufTokens + pt > targetTokens) {
            pushChunk(true);
        }
        buf.push(unit.text);
        bufTokens += pt;
    }
    pushChunk(false);

    return chunks;
}
