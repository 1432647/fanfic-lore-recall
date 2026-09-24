// 设置面板：绑定所有配置输入、测试按钮、库管理 UI。
// 仅通过传入的 root 元素做局部 DOM 查询，避免与宿主 id 冲突。

import { writeSecret, rotateSecret, secret_state } from '/scripts/secrets.js';
import { CUSTOM_SECRET_KEY, log, warn } from './util.js';
import { getSettings, saveSettings, DEFAULT_WRAP_TEMPLATE } from './settings.js';
import { testEmbedding } from './embedding.js';
import { testRerank } from './rerank.js';
import { testLlm } from './llm.js';
import { buildLibrary, deleteLibrary, getLibraries, libraryStats } from './libraries.js';

function setStatus(el, ok, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('ok', 'err');
    el.classList.add(ok ? 'ok' : 'err');
}

/** 绑定文本/数字输入到配置对象 */
function bindInput(root, id, obj, key, { number = false, float = false, nullable = false } = {}) {
    const el = root.querySelector('#' + id);
    if (!el) return;
    const current = obj[key];
    if (current !== null && current !== undefined && current !== '') {
        el.value = current;
    }
    el.addEventListener('input', () => {
        const raw = el.value;
        if (number || float) {
            if (raw === '' || raw === null) {
                obj[key] = nullable ? null : (number ? 0 : 0);
            } else {
                const n = float ? parseFloat(raw) : parseInt(raw, 10);
                obj[key] = Number.isFinite(n) ? n : (nullable ? null : 0);
            }
        } else {
            obj[key] = raw;
        }
        saveSettings();
    });
}

function bindCheckbox(root, id, obj, key) {
    const el = root.querySelector('#' + id);
    if (!el) return;
    el.checked = !!obj[key];
    el.addEventListener('change', () => {
        obj[key] = el.checked;
        saveSettings();
    });
}

function bindSelect(root, id, obj, key, { number = false } = {}) {
    const el = root.querySelector('#' + id);
    if (!el) return;
    el.value = String(obj[key]);
    el.addEventListener('change', () => {
        obj[key] = number ? Number(el.value) : el.value;
        saveSettings();
    });
}

/** 明文 API Key（embedding/rerank）：不回显，仅在输入时更新 */
function bindPlainKey(root, id, obj, key) {
    const el = root.querySelector('#' + id);
    if (!el) return;
    if (obj[key]) {
        el.placeholder = '已保存（输入以更新）';
    }
    el.addEventListener('input', () => {
        obj[key] = el.value;
        saveSettings();
    });
}

/**
 * LLM Key → secret 存储。写入后恢复用户原本的活动 custom 密钥，
 * 避免影响用户主连接（写密钥会把新密钥置为 active）。
 */
function bindLlmKey(root, statusEl) {
    const el = root.querySelector('#fflr_llm_key');
    if (!el) return;
    const settings = getSettings();
    if (settings.llm.secretId) {
        el.placeholder = `已保存 (secretId ${String(settings.llm.secretId).slice(0, 6)}…)`;
    }
    el.addEventListener('change', async () => {
        const value = el.value.trim();
        if (!value) return;
        try {
            // 记录写入前用户活动的 custom 密钥
            const prevActive = Array.isArray(secret_state?.[CUSTOM_SECRET_KEY])
                ? secret_state[CUSTOM_SECRET_KEY].find((s) => s.active)?.id
                : undefined;

            const id = await writeSecret(CUSTOM_SECRET_KEY, value, 'FanficLoreRecall LLM');
            if (!id) {
                throw new Error('写入密钥失败（可能被服务端拒绝）');
            }
            settings.llm.secretId = id;
            saveSettings();

            // 恢复用户原活动密钥，隔离主连接
            if (prevActive && prevActive !== id) {
                try {
                    await rotateSecret(CUSTOM_SECRET_KEY, prevActive);
                } catch (e) {
                    warn('恢复用户活动 custom 密钥失败（忽略）', e);
                }
            }

            el.value = '';
            el.placeholder = `已保存 (secretId ${String(id).slice(0, 6)}…)`;
            setStatus(statusEl, true, 'LLM 密钥已保存');
        } catch (e) {
            setStatus(statusEl, false, String(e?.message || e));
        }
    });
}

function bindTestButton(root, btnId, statusEl, fn) {
    const btn = root.querySelector('#' + btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
        setStatus(statusEl, true, '测试中…');
        const res = await fn();
        setStatus(statusEl, res.ok, (res.ok ? '[OK] ' : '[X] ') + res.message + (res.sample ? `\n样例：${res.sample}` : ''));
    });
}

/** 渲染库列表 */
async function renderLibraryList(root) {
    const listEl = root.querySelector('#fflr_lib_list');
    if (!listEl) return;
    const libs = getLibraries();
    listEl.innerHTML = '';
    if (!libs.length) {
        const empty = document.createElement('div');
        empty.className = 'fflr-lib-empty';
        empty.textContent = '（暂无已建库）';
        listEl.appendChild(empty);
        return;
    }

    for (const lib of libs) {
        const item = document.createElement('div');
        item.className = 'fflr-lib-item';

        const meta = document.createElement('div');
        meta.className = 'fflr-lib-meta';
        const scopeLabel = { global: '全局', character: '角色卡', chat: '聊天' }[lib.binding?.scope] || lib.binding?.scope;
        const keyShort = lib.binding?.key ? `（${String(lib.binding.key).slice(0, 24)}）` : '';
        meta.innerHTML =
            `<b>${escapeHtml(lib.name)}</b><br>` +
            `绑定：${scopeLabel}${escapeHtml(keyShort)}<br>` +
            `块数：${lib.chunkCount} · 维度：${lib.dim} · 状态：${lib.status}` +
            (lib.source ? `<br>来源：${escapeHtml(lib.source)}` : '');

        const buttons = document.createElement('div');
        buttons.className = 'fflr-lib-buttons';

        const statBtn = document.createElement('div');
        statBtn.className = 'menu_button';
        statBtn.textContent = '统计';
        statBtn.addEventListener('click', async () => {
            const stats = await libraryStats(lib);
            if (stats) {
                toastr.info(`nodeCount=${stats.nodeCount} · dim=${stats.dim}`, lib.name);
            } else {
                toastr.warning('无法读取统计（库可能已损坏或缺失）', lib.name);
            }
        });

        const rebuildBtn = document.createElement('div');
        rebuildBtn.className = 'menu_button';
        rebuildBtn.textContent = '重建';
        rebuildBtn.addEventListener('click', () => rebuildLibrary(root, lib));

        const delBtn = document.createElement('div');
        delBtn.className = 'menu_button';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', async () => {
            if (!confirm(`确认删除库「${lib.name}」？（底层数据文件将保留为孤儿）`)) return;
            await deleteLibrary(lib.id);
            await renderLibraryList(root);
            toastr.success('已删除', lib.name);
        });

        buttons.append(statBtn, rebuildBtn, delBtn);
        item.append(meta, buttons);
        listEl.appendChild(item);
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 读取 File 为 UTF-8 文本 */
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsText(file, 'UTF-8');
    });
}

/** 重建：保留原名与原绑定，重新上传 txt */
function rebuildLibrary(root, lib) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.txt,text/plain';
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        if (!confirm(`将删除旧库「${lib.name}」并用新文件重建（保留原绑定），继续？`)) return;
        const progressEl = root.querySelector('#fflr_lib_progress');
        try {
            const text = await readFileAsText(file);
            await deleteLibrary(lib.id);
            await buildLibrary({
                name: lib.name,
                scope: lib.binding.scope,
                bindingKey: lib.binding.key,
                text,
                fileName: file.name,
                onProgress: (p) => setStatus(progressEl, true, `重建中… ${p.phase} ${p.done}/${p.total}`),
            });
            setStatus(progressEl, true, '重建完成');
            await renderLibraryList(root);
            toastr.success('重建完成', lib.name);
        } catch (e) {
            setStatus(progressEl, false, '重建失败：' + String(e?.message || e));
            toastr.error(String(e?.message || e), '重建失败');
            await renderLibraryList(root);
        }
    });
    picker.click();
}

/** 建库按钮 */
function bindBuild(root) {
    const btn = root.querySelector('#fflr_lib_build');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const nameEl = root.querySelector('#fflr_lib_name');
        const scopeEl = root.querySelector('#fflr_lib_scope');
        const fileEl = root.querySelector('#fflr_lib_file');
        const progressEl = root.querySelector('#fflr_lib_progress');

        const name = nameEl.value.trim();
        const scope = scopeEl.value;
        const file = fileEl.files?.[0];

        if (!name) {
            setStatus(progressEl, false, '请填写库名称');
            return;
        }
        if (!file) {
            setStatus(progressEl, false, '请选择 txt 文件');
            return;
        }

        btn.classList.add('disabled');
        try {
            const text = await readFileAsText(file);
            setStatus(progressEl, true, '开始建库…');
            const entry = await buildLibrary({
                name,
                scope,
                text,
                fileName: file.name,
                onProgress: (p) => setStatus(progressEl, true, `${p.phase} ${p.done}/${p.total}`),
            });
            setStatus(progressEl, true, `完成：${entry.chunkCount} 块（维度 ${entry.dim}）`);
            nameEl.value = '';
            fileEl.value = '';
            await renderLibraryList(root);
            toastr.success(`建库完成：${entry.chunkCount} 块`, name);
        } catch (e) {
            setStatus(progressEl, false, '建库失败：' + String(e?.message || e));
            toastr.error(String(e?.message || e), '建库失败');
        } finally {
            btn.classList.remove('disabled');
        }
    });
}

/**
 * 挂载并绑定整个面板。
 * @param {HTMLElement} root 面板根元素
 */
export async function mountPanel(root) {
    const settings = getSettings();

    // LLM
    bindInput(root, 'fflr_llm_endpoint', settings.llm, 'endpoint');
    bindInput(root, 'fflr_llm_model', settings.llm, 'model');
    bindInput(root, 'fflr_llm_maxtokens', settings.llm, 'maxTokens', { number: true });
    bindInput(root, 'fflr_llm_temp', settings.llm, 'temperature', { float: true });
    bindLlmKey(root, root.querySelector('#fflr_llm_status'));
    bindTestButton(root, 'fflr_llm_test', root.querySelector('#fflr_llm_status'), () => testLlm(settings.llm));

    // Embedding
    bindInput(root, 'fflr_emb_endpoint', settings.embedding, 'endpoint');
    bindInput(root, 'fflr_emb_model', settings.embedding, 'model');
    bindInput(root, 'fflr_emb_dim', settings.embedding, 'dimensions', { number: true, nullable: true });
    bindPlainKey(root, 'fflr_emb_key', settings.embedding, 'apiKey');
    bindTestButton(root, 'fflr_emb_test', root.querySelector('#fflr_emb_status'), () => testEmbedding(settings.embedding));

    // Rerank
    bindCheckbox(root, 'fflr_rr_enabled', settings.rerank, 'enabled');
    bindInput(root, 'fflr_rr_endpoint', settings.rerank, 'endpoint');
    bindInput(root, 'fflr_rr_model', settings.rerank, 'model');
    bindInput(root, 'fflr_rr_topn', settings.rerank, 'topN', { number: true });
    bindPlainKey(root, 'fflr_rr_key', settings.rerank, 'apiKey');
    bindTestButton(root, 'fflr_rr_test', root.querySelector('#fflr_rr_status'), () => testRerank(settings.rerank));

    // Retrieval
    bindInput(root, 'fflr_ret_topk', settings.retrieval, 'topK', { number: true });
    bindInput(root, 'fflr_ret_minscore', settings.retrieval, 'minScore', { float: true });
    bindCheckbox(root, 'fflr_ret_hybrid', settings.retrieval, 'enableTextHybridSearch');
    bindInput(root, 'fflr_ret_bm25k1', settings.retrieval, 'bm25K1', { float: true, nullable: true });
    bindInput(root, 'fflr_ret_bm25b', settings.retrieval, 'bm25B', { float: true, nullable: true });
    bindInput(root, 'fflr_ret_textboost', settings.retrieval, 'textBoost', { float: true, nullable: true });

    // Chunking
    bindInput(root, 'fflr_chunk_target', settings.chunking, 'targetTokens', { number: true });
    bindInput(root, 'fflr_chunk_overlap', settings.chunking, 'overlapRatio', { float: true });
    bindInput(root, 'fflr_chunk_chapter', settings.chunking, 'chapterRegex');

    // Context / Inject
    bindInput(root, 'fflr_ctx_floors', settings.context, 'floors', { number: true });
    bindSelect(root, 'fflr_inj_position', settings.inject, 'position', { number: true });
    bindInput(root, 'fflr_inj_depth', settings.inject, 'depth', { number: true });
    bindSelect(root, 'fflr_inj_role', settings.inject, 'role', { number: true });
    bindInput(root, 'fflr_inj_cap', settings.inject, 'perPassageCharCap', { number: true });

    const templateEl = root.querySelector('#fflr_inj_template');
    if (templateEl) {
        templateEl.value = settings.inject.wrapTemplate || DEFAULT_WRAP_TEMPLATE;
        templateEl.addEventListener('input', () => {
            settings.inject.wrapTemplate = templateEl.value;
            saveSettings();
        });
    }
    const resetBtn = root.querySelector('#fflr_inj_reset');
    if (resetBtn && templateEl) {
        resetBtn.addEventListener('click', () => {
            settings.inject.wrapTemplate = DEFAULT_WRAP_TEMPLATE;
            templateEl.value = DEFAULT_WRAP_TEMPLATE;
            saveSettings();
        });
    }

    // 库管理
    bindBuild(root);
    await renderLibraryList(root);

    log('设置面板已挂载');
}
