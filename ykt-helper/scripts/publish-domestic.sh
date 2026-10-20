#!/bin/bash
# publish-domestic.sh — YuketangStudio 国内渠道发布
# 产物（dist .user.js + 可选 APK）→ axooo-pan 托管 → 更新 svc 的 yt-latest.json
#
# 用法：bash scripts/publish-domestic.sh [apk路径] [--stable]
#   默认发「测试渠道 beta」；只有显式 --stable 才更新稳定渠道。
#   两个渠道使用不同的远程路径，互不覆盖：
#     stable: /apps/yuketangstudio/YuketangStudio-latest.user.js
#     beta:   /apps/yuketangstudio/beta/YuketangStudio-latest.user.js
#
# 前置：export AXOOO_API_KEY=<见 ServerX/敏感/axooo-pan.md>
#       本机在 EasyTier 内（10.126.126.1 可达）
set -eu
cd "$(dirname "$0")/.."

CHANNEL="beta"
APK=""
APK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --stable)   CHANNEL="stable" ;;
    --beta)     CHANNEL="beta" ;;
    --apk-only) APK_ONLY=1 ;;
    *)          APK="$arg" ;;
  esac
done
if [ "$APK_ONLY" = 1 ] && { [ -z "$APK" ] || [ ! -f "$APK" ]; }; then
  echo "--apk-only 需要提供有效的 APK 路径"; exit 1
fi

H="${AXOOO_HOST:-http://10.126.126.1:3005}"
K="${AXOOO_API_KEY:?需要 AXOOO_API_KEY（见 ServerX/敏感/axooo-pan.md）}"
VER=$(node -p "require('./package.json').version")
JS="dist/YuketangStudio-${VER}.user.js"
LATEST_JS="dist/YuketangStudio-latest.user.js"
[ -f "$JS" ] || { echo "先 npm run build 产出 $JS"; exit 1; }

upload() {  # 覆盖式上传：先删同名（Cloudreve 不覆盖）再传
  local f="$1" path="$2"
  curl -s -X DELETE -H "X-API-Key: $K" "${H}/file?path=${path}" >/dev/null || true
  curl -s --max-time 300 -H "X-API-Key: $K" -F "file=@${f}" "${H}/upload?path=${path}&direct=1" >/dev/null
}
dl_host() {  # path → https://dl.raymor.top/f/<id>（幂等，同 path 同 id）
  curl -s -X POST -H "X-API-Key: $K" "${H}/host?path=$1" \
    | python3 -c 'import json,sys; u=json.load(sys.stdin).get("data",{}).get("url",""); fid=u.rstrip("/").rsplit("/",1)[-1]; print("https://dl.raymor.top/f/"+fid if fid else "")'
}

if [ "$CHANNEL" = "beta" ]; then
  REMOTE_DIR="/apps/yuketangstudio/beta"
else
  REMOTE_DIR="/apps/yuketangstudio"
fi
echo "▸ 渠道：$CHANNEL"
curl -s -X POST -H "X-API-Key: $K" "$H/mkdir?path=$REMOTE_DIR" >/dev/null || true

REMOTE_JS="$REMOTE_DIR/YuketangStudio-latest.user.js"
JS_URL=""
if [ "$APK_ONLY" = 0 ]; then
  echo "▸ 上传 $REMOTE_JS"
  upload "$LATEST_JS" "$REMOTE_JS"
  JS_URL=$(dl_host "$REMOTE_JS")
  echo "  $JS_URL"
else
  echo "▸ --apk-only：跳过脚本上传，沿用现有 userscript 链接"
fi

APK_URL=""
if [ -n "$APK" ] && [ -f "$APK" ]; then
  REMOTE_APK="$REMOTE_DIR/YuketangStudio-${VER}.apk"
  echo "▸ 上传 $REMOTE_APK"
  upload "$APK" "$REMOTE_APK"
  APK_URL=$(dl_host "$REMOTE_APK")
  echo "  $APK_URL"
fi

# 合并 svc yt-latest.json（保留另一个渠道，不覆盖）
NOTES="${PUBLISH_NOTES:-v${VER} 更新}"
TMP=$(mktemp)
ssh SM 'cat /root/app-configs/svc/data/yt-latest.json' > "$TMP" 2>/dev/null || echo '{}' > "$TMP"
python3 - "$VER" "$JS_URL" "$APK_URL" "$NOTES" "$CHANNEL" "$TMP" "$APK_ONLY" <<'PY'
import json, sys, datetime
ver, js, apk, notes, channel, path, apk_only = sys.argv[1:8]
try:
    d = json.load(open(path))
except Exception:
    d = {}
if "version" in d and "stable" not in d:
    d = {"stable": d}
d.setdefault("stable", {})
d.setdefault("beta", {})
if apk_only == "1":
    js = d.get(channel, {}).get("userscript", "")
    if not js:
        sys.exit("--apk-only 但该渠道没有已发布的 userscript 链接")
d[channel] = {
    "version": ver,
    "userscript": js,
    "apk": apk,
    "notes": notes,
    "publishedAt": datetime.datetime.now().isoformat(timespec="seconds"),
}
json.dump(d, open(path, "w"), ensure_ascii=False, indent=2)
print("  yt-latest.json channel:", channel)
PY
scp "$TMP" SM:/root/app-configs/svc/data/yt-latest.json
rm -f "$TMP"
echo "✅ 已发布 v${VER}（$CHANNEL）：https://api.raymor.top/yuketangstudio/latest?channel=$CHANNEL"
