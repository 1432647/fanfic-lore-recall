// 库注册表管理 + 建库流程：上传文本 → 切块 → 嵌入 → TriviumDB 建库 → 建文本索引。
// 建库遵循 fail-fast：任一批嵌入/写入失败即停止并抛错，不保留半成品索引。

import { db, uuid, sanitizeNamespace, ctx, currentCharacterKey, log, warn } from './util.js';
import { getSettings, saveSettings } from './settings.js';
import { chunkText } from './chunking.js';
import { embedPassages } from './embedding.js';

const EMBED_BATCH = 64;

/** @returns {Array<object>} 库注册表 */
export function getLibraries() {
    return getSettings().libraries;
}

export function findLibraryById(id) {
    return getLibraries().find((l) => l.id === id) || null;
}

/** 依据绑定 scope 计算绑定 key（chat=聊天id, character=avatar, global=null） */
function bindingKeyForScope(scope) {
    const context = ctx();
    if (scope === 'chat') {
        const chatId = context.getCurrentChatId();
        if (!chatId) {
            throw new Error('当前没有打开的聊天，无法绑定到“聊天”。请先打开一个聊天。');
        }
        return String(chatId);
    }
    if (scope === 'character') {
        const key = currentCharacterKey(context);
        if (!key) {
            throw new Error('当前没有选中单个角色卡（或处于群组），无法绑定到“角色卡”。请先进入某个角色卡。');
        }
        return key;
    }
    if (scope === 'global') {
        return null;
    }
    throw new Error(`未知绑定类型：${scope}`);
}

/** 打开某库对应的 TriviumDB 句柄 */
export async function openLibraryDb(lib) {
    return db().open(lib.namespace, { dim: lib.dim });
}

/** 读取库统计（nodeCount 等），失败返回 null */
export async function libraryStats(lib) {
    try {
        const handle = await openLibraryDb(lib);
        return await handle.stats();
    } catch (e) {
        warn('读取库统计失败', lib?.namespace, e);
        return null;
    }
}

/**
 * 建库。
 * @param {object} p
 * @param {string} p.name 库显示名
 * @param {'global'|'character'|'chat'} p.scope 绑定范围
 * @param {string} p.text 原文全文
 * @param {string} [p.fileName] 来源文件名
 * @param {string|null} [p.bindingKey] 绑定 key 覆盖（重建时保留原绑定；不传则按当前上下文计算）
 * @param {(progress:{phase:string,total:number,done:number})=>void} [p.onProgress]
 * @param {AbortSignal|null} [p.signal]
 * @returns {Promise<object>} 新建的库注册项
 */
export async function buildLibrary({ name, scope, text, fileName, bindingKey, onProgress, signal = null }) {
    const settings = getSettings();
    const embSettings = settings.embedding;

    if (!name || !name.trim()) {
        throw new Error('库名称不能为空');
    }
    if (!text || !text.trim()) {
        throw new Error('原文内容为空');
    }
    // 计算绑定 key：重建时用传入的原绑定；否则按当前上下文计算（可能 fail-fast）
    const resolvedBindingKey = bindingKey !== undefined ? bindingKey : bindingKeyForScope(scope);

    const chunks = chunkText(text, settings.chunking);
    if (!chunks.length) {
        throw new Error('切块结果为空，请检查切块参数或原文内容');
    }
    log(`建库「${name}」：切出 ${chunks.length} 块，开始嵌入...`);

    const id = uuid();
    const namespace = sanitizeNamespace(id);
    const dimensions = Number(embSettings.dimensions) > 0 ? Number(embSettings.dimensions) : null;
    const profile = {
        endpoint: embSettings.endpoint,
        model: embSettings.model,
        dimensions,
    };

    let handle = null;
    let dim = null;
    let inserted = 0;
    onProgress?.({ phase: 'start', total: chunks.length, done: 0 });

    try {
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            if (signal?.aborted) {
                throw new Error('已取消');
            }
            const batch = chunks.slice(i, i + EMBED_BATCH);
            const vectors = await embedPassages(batch.map((c) => c.text), embSettings, signal);

            if (dim === null) {
                dim = vectors[0].length;
                handle = await db().open(namespace, { dim });
                log(`探测到向量维度 ${dim}，已打开命名空间 ${namespace}`);
            } else if (vectors[0].length !== dim) {
                throw new Error(`向量维度不一致：第 ${i} 批为 ${vectors[0].length}，此前为 ${dim}`);
            }

            const payloads = batch.map((c) => ({
                text: c.text,
                source: fileName || name,
                chapter: c.chapter ?? null,
                chunkIndex: c.chunkIndex,
            }));
            const ids = await handle.batchInsert(vectors, payloads);
            for (let k = 0; k < ids.length; k++) {
                await handle.indexText(ids[k], batch[k].text);
            }
            inserted += batch.length;
            onProgress?.({ phase: 'embed', total: chunks.length, done: inserted });
        }

        await handle.buildTextIndex();
        onProgress?.({ phase: 'index', total: chunks.length, done: inserted });
    } catch (e) {
        // fail-fast：关闭句柄，抛出错误。命名空间为新 uuid 派生，
        // 半成品数据物理隔离且不会被注册，不影响其它库。
        try {
            if (handle) await handle.close();
        } catch (closeErr) {
            warn('回滚关闭句柄失败（忽略）', closeErr);
        }
        throw e;
    }

    const entry = {
        id,
        name: name.trim(),
        namespace,
        dim,
        embeddingProfile: profile,
        chunkCount: inserted,
        binding: { scope, key: resolvedBindingKey },
        status: 'ready',
        source: fileName || '',
        createdAt: Date.now(),
    };
    settings.libraries.push(entry);
    saveSettings();
    log(`建库完成「${name}」：${inserted} 块，命名空间 ${namespace}`);
    return entry;
}

/**
 * 删除库：关闭句柄并移除注册项。
 * 注意：底层 TriviumDB 数据文件（_tauritavern/databases/db-<ns>/）
 * 无前端删除 API，会作为孤儿保留在磁盘（物理隔离、无害）。
 */
export async function deleteLibrary(id) {
    const settings = getSettings();
    const idx = settings.libraries.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const lib = settings.libraries[idx];
    try {
        const handle = await db().open(lib.namespace, { dim: lib.dim });
        await handle.close();
    } catch (e) {
        warn('删除时关闭库句柄失败（忽略）', lib?.namespace, e);
    }
    settings.libraries.splice(idx, 1);
    saveSettings();
    log(`已删除库「${lib.name}」（命名空间 ${lib.namespace} 数据文件保留为孤儿）`);
}
