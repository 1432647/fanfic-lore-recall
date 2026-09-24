// 活动库解析：按 specificity 顺序取唯一活动库 —— 聊天绑定 > 角色卡绑定 > 全局绑定。
// v1 为“单一活动库”策略（见计划 §12）。

import { ctx, currentCharacterKey, debug } from './util.js';
import { getLibraries } from './libraries.js';

/**
 * 解析当前上下文命中的唯一活动库。
 * @returns {object|null}
 */
export function resolveActiveLibrary() {
    const context = ctx();
    const libraries = getLibraries();
    if (!libraries.length) {
        return null;
    }

    const chatId = context.getCurrentChatId();
    const charKey = currentCharacterKey(context);

    // 1) 聊天绑定（最具体）
    if (chatId) {
        const hit = libraries.find((l) => l.binding?.scope === 'chat' && String(l.binding.key) === String(chatId));
        if (hit) {
            debug('活动库命中(chat)：', hit.name);
            return hit;
        }
    }

    // 2) 角色卡绑定
    if (charKey) {
        const hit = libraries.find((l) => l.binding?.scope === 'character' && l.binding.key === charKey);
        if (hit) {
            debug('活动库命中(character)：', hit.name);
            return hit;
        }
    }

    // 3) 全局绑定
    const global = libraries.find((l) => l.binding?.scope === 'global');
    if (global) {
        debug('活动库命中(global)：', global.name);
        return global;
    }

    return null;
}
