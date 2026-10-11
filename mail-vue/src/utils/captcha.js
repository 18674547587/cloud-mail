/**
 * 人机验证统一封装（Turnstile / hCaptcha）
 *
 * 约定：由服务端决定用哪家（/api/setting/websiteConfig 或 /api/my/captchaConfig 下发 provider + siteKey），
 * 前端只负责按 provider 加载对应 SDK 并渲染，不做任何自主判断。
 */

export const CAPTCHA_PROVIDER = {
  AUTO: 0,
  TURNSTILE: 1,
  HCAPTCHA: 2
}

const SDK_CONFIG = {
  [CAPTCHA_PROVIDER.TURNSTILE]: {
    globalKey: 'turnstile',
    src: 'https://challenges.cloudflare.com/turnstile/v0/api.js'
  },
  [CAPTCHA_PROVIDER.HCAPTCHA]: {
    globalKey: 'hcaptcha',
    src: 'https://js.hcaptcha.com/1/api.js?render=explicit'
  }
}

// provider -> 加载中的 Promise（避免重复插入 script）
const loadingTasks = {}

export function providerName(provider) {
  return provider === CAPTCHA_PROVIDER.HCAPTCHA ? 'hCaptcha' : 'Turnstile'
}

/** 从 websiteConfig / captchaConfig 中取对应 provider 的公开 site key */
export function siteKeyOf(settings, provider) {
  if (!settings) return ''
  return provider === CAPTCHA_PROVIDER.HCAPTCHA
    ? (settings.hcaptchaSiteKey || '')
    : (settings.siteKey || '')
}

/** 按需加载 SDK，返回 Promise<api> */
export function loadCaptchaSdk(provider) {
  const conf = SDK_CONFIG[provider] || SDK_CONFIG[CAPTCHA_PROVIDER.TURNSTILE]

  if (typeof window !== 'undefined' && window[conf.globalKey]) {
    return Promise.resolve(window[conf.globalKey])
  }

  if (loadingTasks[provider]) {
    return loadingTasks[provider]
  }

  loadingTasks[provider] = new Promise((resolve, reject) => {

    const script = document.createElement('script')
    let src = conf.src

    // hCaptcha 在 render=explicit 下必须等 JS API 完全就绪才能 render，
    // 官方推荐用 onload 回调参数（否则会出现 "should not render before js api is fully loaded" 警告甚至渲染失败）
    if (provider === CAPTCHA_PROVIDER.HCAPTCHA) {
      const cbName = `__onHcaptchaLoad_${Date.now()}`
      window[cbName] = () => {
        try {
          delete window[cbName]
        } catch (e) { /* ignore */ }
        window[conf.globalKey] ? resolve(window[conf.globalKey]) : reject(new Error('hCaptcha SDK 未正确挂载'))
      }
      src += `${src.includes('?') ? '&' : '?'}onload=${cbName}`
    }

    script.src = src
    script.async = true
    script.defer = true
    script.onerror = () => {
      loadingTasks[provider] = null
      reject(new Error(`${providerName(provider)} SDK 加载失败`))
    }

    if (provider !== CAPTCHA_PROVIDER.HCAPTCHA) {
      script.onload = () => {
        if (window[conf.globalKey]) {
          resolve(window[conf.globalKey])
        } else {
          reject(new Error(`${providerName(provider)} SDK 未正确挂载`))
        }
      }
    }

    document.head.appendChild(script)
  })

  return loadingTasks[provider]
}

function apiOf(provider) {
  const conf = SDK_CONFIG[provider] || SDK_CONFIG[CAPTCHA_PROVIDER.TURNSTILE]
  return typeof window === 'undefined' ? null : window[conf.globalKey]
}

/**
 * 渲染验证组件
 * @param {number} provider
 * @param {HTMLElement|string} target 容器元素或选择器
 * @param {{siteKey: string, theme?: string, onSuccess?: Function, onError?: Function, onExpired?: Function}} options
 * @returns {Promise<number|null>} widget id
 */
export function renderCaptcha(provider, target, options = {}) {

  const { siteKey, theme = 'light', onSuccess, onError, onExpired } = options

  return loadCaptchaSdk(provider).then(api => {

    if (!api || typeof api.render !== 'function') {
      throw new Error(`${providerName(provider)} SDK 不可用`)
    }

    // 两家的渲染参数基本一致；language 仅 Turnstile 支持（hCaptcha 靠 script 的 hl 参数）
    const params = {
      sitekey: siteKey,
      theme,
      callback: (token) => onSuccess && onSuccess(token),
      'error-callback': (e) => onError && onError(e),
      'expired-callback': () => (onExpired ? onExpired() : onSuccess && onSuccess('')),
      'refresh-expired': 'manual'
    }

    if (provider === CAPTCHA_PROVIDER.TURNSTILE) {
      params.language = options.language || 'zh-CN'
    }

    return api.render(target, params)
  })
}

export function resetCaptcha(provider, id) {
  const api = apiOf(provider)
  if (id !== null && id !== undefined && api && typeof api.reset === 'function') {
    try {
      api.reset(id)
    } catch (e) {
      console.warn('验证组件重置失败:', e)
    }
  }
}

export function removeCaptcha(provider, id) {
  const api = apiOf(provider)
  if (id !== null && id !== undefined && api && typeof api.remove === 'function') {
    try {
      api.remove(id)
    } catch (e) {
      console.warn('验证组件移除失败:', e)
    }
  }
}
