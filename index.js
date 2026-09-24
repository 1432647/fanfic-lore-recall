// 同人原著向量召回插件 —— 入口
// - 注册 generate_interceptor 全局函数（manifest.generate_interceptor 指向它）
// - activate 钩子 init()：等待宿主就绪、挂载设置面板

import { INTERCEPTOR_NAME, hostReady, isTauri, log, warn, error } from './src/util.js';
import { getSettings } from './src/settings.js';
import { mountPanel } from './src/panel.js';
import { intercept, buildContextText } from './src/recall.js';
import { resolveActiveLibrary } from './src/binding.js';

// 生成拦截器：宿主在生成前 await globalThis[manifest.generate_interceptor](chat, contextSize, abort, type)
globalThis[INTERCEPTOR_NAME] = async (chat, contextSize, abort, type) => {
    return intercept(chat, contextSize, abort, type);
};

// 供手动验证/诊断的调试入口（控制台可调用）
globalThis.fanficLoreRecall_debug = {
    getSettings,
    resolveActiveLibrary,
    buildContextText,
};

let mounted = false;

async function mountSettingsPanel() {
    if (mounted) return;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        warn('未找到扩展设置容器 #extensions_settings2');
        return;
    }
    const url = new URL('./settings.html', import.meta.url);
    const html = await (await fetch(url)).text();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const root = wrapper.firstElementChild;
    if (!root) {
        warn('settings.html 解析为空');
        return;
    }
    container.appendChild(root);
    await mountPanel(root);
    mounted = true;
}

/** activate 钩子（manifest.hooks.activate = "init"），无参数，宿主 await 至多 5s */
export async function init() {
    try {
        await hostReady();
    } catch (e) {
        warn('等待宿主就绪时出错（继续）', e);
    }

    if (!isTauri()) {
        warn('未检测到 TauriTavern DB API；向量库功能将不可用（面板仍会挂载）');
    }

    // 初始化配置（补齐默认值）
    try {
        getSettings();
    } catch (e) {
        error('初始化配置失败', e);
    }

    // 挂载面板（面板挂载失败不应阻断拦截器注册）
    try {
        await mountSettingsPanel();
    } catch (e) {
        error('挂载设置面板失败', e);
    }

    log('初始化完成');
}
