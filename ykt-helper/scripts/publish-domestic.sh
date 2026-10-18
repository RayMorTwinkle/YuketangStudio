#!/bin/bash
# publish-domestic.sh — YuketangStudio 国内渠道发布
# 产物（dist .user.js + 可选 APK）→ axooo-pan 托管 → 更新 svc 的 yt-latest.json
#
# 前置：export AXOOO_API_KEY=<见 ServerX/敏感/axooo-pan.md>
#       本机在 EasyTier 内（10.126.126.1 可达）
# 用法：bash scripts/publish-domestic.sh [apk路径]
#
# 直链策略：POST /host 按 path 幂等注册 /f/<id>（永久），
# yt-latest.json 写 https://dl.raymor.top/f/<id>；svc /dl/{kind} 302 到这里。
# 每次重发版 path 不变 → /f/<id> 不变 → latest.json 里的 url 也不变。
set -eu
cd "$(dirname "$0")/.."

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
  # /host 返回的 url 是完整内网地址 http://10.126.126.1:3005/f/<id>，
  # 只取最后一段 id 再拼公网域名——直接拼会得到两个 URL 粘在一起
  curl -s -X POST -H "X-API-Key: $K" "${H}/host?path=$1" \
    | python3 -c 'import json,sys; u=json.load(sys.stdin).get("data",{}).get("url",""); fid=u.rstrip("/").rsplit("/",1)[-1]; print("https://dl.raymor.top/f/"+fid if fid else "")'
}

REMOTE_JS="/apps/yuketangstudio/YuketangStudio-latest.user.js"
echo "▸ 上传 $REMOTE_JS"
upload "$LATEST_JS" "$REMOTE_JS"
JS_URL=$(dl_host "$REMOTE_JS")
echo "  $JS_URL"

APK_URL=""
if [ $# -ge 1 ] && [ -f "$1" ]; then
  REMOTE_APK="/apps/yuketangstudio/YuketangStudio-${VER}.apk"
  echo "▸ 上传 $REMOTE_APK"
  curl -s -X POST -H "X-API-Key: $K" "$H/mkdir?path=/apps/yuketangstudio" >/dev/null || true
  upload "$1" "$REMOTE_APK"
  APK_URL=$(dl_host "$REMOTE_APK")
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
echo "   官网下载按钮 https://api.raymor.top/yuketangstudio/dl/{userscript,apk} 已指向最新"