#!/bin/bash
# ============================================================
# Cloud Mail 人机验证方式 —— 紧急/日常切换脚本
#
# 用法：bash captcha-fallback.sh <0|1|2>
#   0 = 自动（中国大陆访客 → hCaptcha，其余 → Turnstile）
#   1 = 强制 Turnstile（应急：当 hCaptcha 不可用/密钥配错时，让 CN 用户也能登录）
#   2 = 强制 hCaptcha
#
# 原理：同时改 D1 的 setting.captcha_provider 与 KV 缓存 "setting:"
#       （Worker 读的是 KV，只改 D1 不生效）
# 注意：KV 是最终一致的，边缘节点生效最长约 60 秒。
# ============================================================
set -e

PROVIDER="${1:-1}"
case "$PROVIDER" in
  0|1|2) ;;
  *) echo "参数必须是 0（自动）/ 1（强制 Turnstile）/ 2（强制 hCaptcha）"; exit 1 ;;
esac

export CLOUDFLARE_API_TOKEN="$(cat /workspace/.cloudflare/api_token)"
export CLOUDFLARE_ACCOUNT_ID="$(cat /workspace/.cloudflare/account_id)"

KV_ID="fab772c76ab34907bc07307a2703ca4a"
WORKER_DIR="/workspace/cloud-mail/mail-worker"
TMP_OLD="/tmp/captcha-kv-old.json"
TMP_NEW="/tmp/captcha-kv-new.json"

cd "$WORKER_DIR"

echo "[1/3] 更新 D1 setting.captcha_provider = $PROVIDER"
wrangler d1 execute cloud-mail-apac --remote \
  --command "UPDATE setting SET captcha_provider=$PROVIDER;" > /dev/null

echo "[2/3] 读取 KV 缓存 setting:"
wrangler kv key get "setting:" --namespace-id "$KV_ID" --remote --text > "$TMP_OLD"

echo "[3/3] 写回 KV 缓存"
node -e "
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('$TMP_OLD', 'utf8'));
j.captchaProvider = $PROVIDER;
fs.writeFileSync('$TMP_NEW', JSON.stringify(j));
console.log('  字段数:', Object.keys(j).length);
"
wrangler kv key put "setting:" --namespace-id "$KV_ID" --path "$TMP_NEW" --remote > /dev/null

case "$PROVIDER" in
  0) DESC="自动（CN → hCaptcha，其余 → Turnstile）" ;;
  1) DESC="强制 Turnstile" ;;
  2) DESC="强制 hCaptcha" ;;
esac

echo "✅ 已切换为：$DESC"
echo "   （KV 边缘生效最长约 60 秒；可用 curl -s https://m.1206201.xyz/api/setting/websiteConfig 检查 captchaProvider 字段）"
