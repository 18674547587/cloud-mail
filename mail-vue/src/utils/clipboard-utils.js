/**
 * 剪贴板复制工具
 *
 * 背景：
 * 部分基于系统 WebView 的浏览器（如 Via）不响应 WebView 层的
 * clipboard-write 权限请求，导致 navigator.clipboard.writeText() 一律抛出
 *   NotAllowedError: Write permission denied.
 * 表现为页面提示“复制失败”，即使浏览器自身的站点设置里已开启剪贴板权限。
 *
 * 因此这里统一封装：优先使用异步 Clipboard API，失败时自动回退到
 * document.execCommand('copy')（该路径不经过权限请求，兼容性更好）。
 */

/**
 * 降级复制方案：document.execCommand('copy')
 *
 * @param {string} value 待复制文本
 * @returns {boolean} 是否复制成功
 */
export function legacyCopy(value) {
    if (typeof document.execCommand !== 'function') {
        return false;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    // readonly 可避免移动端弹出软键盘；同时不影响 select + execCommand
    textarea.setAttribute('readonly', '');
    textarea.style.cssText =
        'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;' +
        'outline:0;box-shadow:none;background:transparent;opacity:0;z-index:-1;';
    document.body.appendChild(textarea);

    let ok = false;
    let savedRange = null;
    const selection = document.getSelection();

    try {
        // 保存原有选区，复制完成后恢复
        if (selection && selection.rangeCount > 0) {
            savedRange = selection.getRangeAt(0);
        }

        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        ok = document.execCommand('copy');
    } catch (e) {
        ok = false;
    } finally {
        if (selection && savedRange) {
            try {
                selection.removeAllRanges();
                selection.addRange(savedRange);
            } catch (e) {
                // 忽略选区恢复失败
            }
        }
        if (textarea.parentNode) {
            textarea.parentNode.removeChild(textarea);
        }
    }

    return ok;
}

/**
 * 复制文本到剪贴板
 *
 * @param {string} text 待复制文本
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyText(text) {
    const value = text === null || text === undefined ? '' : String(text);

    // 优先使用异步 Clipboard API（要求安全上下文 + 宿主浏览器授权）
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch (e) {
            // 授权被拒（如 Via 等 WebView 浏览器），继续走降级方案
            console.warn('Clipboard API 写入失败，回退到 execCommand：', e);
        }
    }

    return legacyCopy(value);
}

export default copyText;
