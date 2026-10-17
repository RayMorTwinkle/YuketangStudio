#!/bin/bash
# publish-domestic.sh — YuketangStudio 国内渠道发布
# 产物（dist .user.js + 可选 APK）→ axooo-pan 托管 → 更新 svc 的 yt-latest.json
#
# 前置：export AXOOO_API_KEY=<见 ServerX/敏感/axooo-pan.md>
#       本机在 EasyTier 内（10.126.126.1 可达）
# 用法：bash scripts/publish-domestic.sh [apk路径]
set -eu
cd "$(dirname "$0")/.."

H="${AXOOO_HOST:-http://10.126.126.1:3005}"
K="${AXOOO_API_KEY:?需要 AXOOO_API_KEY（见 ServerX/敏感/axooo-pan.md）}"
VER=$(node -p "require('./package.json').version")
JS="dist/YuketangStudio-${VER}.user.js"
LATEST_JS="dist/YuketangStudio-latest.user.js"
[ -f "$JS" ] || { echo "先 npm run build 产出 $JS"; exit 1; }

up() {  # up <本地文件> <远端路径> → 打印 https://dl.raymor.top/f/<id>
  local f="$1" path="$2"
  curl -s -H "X-API-Key: $K" -F "file=@${f}" "${H}/upload?path=${path}&direct=1" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);u=d.get("direct") or d.get("url") or "";print(u.replace("http://10.126.126.1:3005","https://dl.raymor.top") if "pan.axooo.cn" not in u else u)'
}

echo "▸ 上传 latest.user.js"
JS_URL=$(up "$LATEST_JS" "/apps/yuketangstudio/YuketangStudio-latest.user.js")
echo "  $JS_URL"

APK_URL=""
if [ $# -ge 1 ] && [ -f "$1" ]; then
  echo "▸ 上传 APK $1"
  curl -s -X POST -H "X-API-Key: $K" "$H/mkdir?path=/apps/yuketangstudio" >/dev/null || true
  APK_URL=$(up "$1" "/apps/yuketangstudio/YuketangStudio-${VER}.apk")
  echo "  $APK_URL"
fi

# 更新 svc yt-latest.json（官网+自更新检查读它）
NOTES="${PUBLISH_NOTES:-v${VER} 更新}"
python3 - "$VER" "$JS_URL" "$APK_URL" "$NOTES" > /tmp/yt-latest.json <<'PY'
import json,sys,datetime
print(json.dumps({"version":sys.argv[1],"userscript":sys.argv[2],"apk":sys.argv[3],
  "notes":sys.argv[4],"publishedAt":datetime.datetime.now().isoformat(timespec='seconds')},
  ensure_ascii=False,indent=2))
PY
scp /tmp/yt-latest.json SM:/root/app-configs/svc/data/yt-latest.json
echo "✅ 已发布 v${VER}：latest.json → svc/data（https://api.raymor.top/yuketangstudio/latest）"
