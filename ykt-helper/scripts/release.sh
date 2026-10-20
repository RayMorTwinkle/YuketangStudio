#!/bin/bash
# release.sh — YuketangStudio 一键构建 / 打标签 / 发 GitHub Release / 发国内渠道
#
# 用法：
#   bash scripts/release.sh [选项]
#
# 选项：
#   --check                只做环境与前置检查，不构建
#   --build-only           只构建，不提交/打标签/发布
#   --only userscript      只编译用户脚本（不碰 Android）
#   --only android         只编译 APK（用当前 assets 里的脚本）
#   --only all             两端都编译（默认）
#   --channel beta|stable  国内渠道（默认 beta）
#   --version X.Y.Z        指定版本（会同步 package.json + build.gradle.kts）
#   --notes "..."          更新说明（GitHub Release + 国内 latest.json）
#   --no-tag               不创建/推送 git tag
#   --no-github            不创建 GitHub Release
#   --no-domestic          不上传国内渠道
#   -h, --help             帮助
#
# 例：
#   bash scripts/release.sh --check
#   bash scripts/release.sh --build-only --only userscript
#   bash scripts/release.sh --version 0.6.3 --channel stable --notes "稳定版发布"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CHANNEL="beta"
ONLY="all"
DO_TAG=1
DO_GH=1
DO_DOMESTIC=1
BUILD_ONLY=0
CHECK_ONLY=0
VERSION=""
NOTES=""

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --channel) CHANNEL="${2:-}"; shift ;;
    --version) VERSION="${2:-}"; shift ;;
    --notes) NOTES="${2:-}"; shift ;;
    --no-tag) DO_TAG=0 ;;
    --no-github) DO_GH=0 ;;
    --no-domestic) DO_DOMESTIC=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1"; usage; exit 1 ;;
  esac
  shift
done

case "$ONLY" in userscript|android|all) ;; *) echo "--only 只能是 userscript/android/all"; exit 1 ;; esac
case "$CHANNEL" in stable|beta) ;; *) echo "--channel 只能是 stable/beta"; exit 1 ;; esac

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

FAIL=0
check_cmd() { if command -v "$1" >/dev/null 2>&1; then ok "$1"; else bad "$1 未安装"; FAIL=1; fi; }

step "环境检查"
check_cmd git
check_cmd node
check_cmd npm
check_cmd curl
check_cmd ssh
[ "$DO_GH" = 1 ] && check_cmd gh
[ -f "$ROOT/ykt-helper/package.json" ] && ok "仓库根目录" || { bad "找不到 ykt-helper/package.json"; FAIL=1; }

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then ok "git 仓库"; else bad "不是 git 仓库"; FAIL=1; fi
BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
[ "$BRANCH" = "main" ] && ok "分支 main" || warn "当前分支：${BRANCH:-未知}（发版建议 main）"

if [ "$BUILD_ONLY" = 0 ] && [ "$CHECK_ONLY" = 0 ]; then
  if [ -z "$(git -C "$ROOT" status --porcelain)" ]; then ok "工作区干净"; else bad "工作区有未提交改动（先 commit 或加 --build-only）"; FAIL=1; fi
fi

if [ "$DO_GH" = 1 ]; then
  if gh auth status >/dev/null 2>&1; then ok "gh 已登录"; else bad "gh 未登录（gh auth login）"; FAIL=1; fi
fi

if [ "$DO_DOMESTIC" = 1 ]; then
  if [ -n "${AXOOO_API_KEY:-}" ]; then ok "AXOOO_API_KEY"; else bad "缺少 AXOOO_API_KEY（见 ServerX/敏感/axooo-pan.md）"; FAIL=1; fi
fi

if [ "$ONLY" != "userscript" ]; then
  if [ -n "${ANDROID_HOME:-}" ] || [ -f "$ROOT/android/local.properties" ]; then ok "Android SDK"; else warn "未检测到 ANDROID_HOME / local.properties"; fi
  [ -f "$ROOT/android/app/build.gradle.kts" ] && ok "Android 工程" || { bad "缺少 android/app/build.gradle.kts"; FAIL=1; }
fi

VER="$(node -p "require('$ROOT/ykt-helper/package.json').version")"
ok "当前版本：v$VER"

if [ "$FAIL" = 1 ]; then echo; echo "❌ 前置检查未通过"; exit 1; fi
if [ "$CHECK_ONLY" = 1 ]; then echo; echo "✅ 检查通过"; exit 0; fi

# ---------- 版本号 ----------
if [ -n "$VERSION" ]; then
  step "设置版本 v$VERSION"
  node - "$ROOT/ykt-helper/package.json" "$VERSION" <<'PY'
import json,sys
p,ver=sys.argv[1],sys.argv[2]
d=json.load(open(p)); d["version"]=ver
open(p,"w").write(json.dumps(d,ensure_ascii=False,indent=2)+"\n")
PY
  python3 - "$ROOT/android/app/build.gradle.kts" "$VERSION" <<'PY'
import re,sys
p,ver=sys.argv[1],sys.argv[2]
s=open(p,encoding="utf-8").read()
m=re.search(r'versionCode\s*=\s*(\d+)',s)
code=int(m.group(1))+1 if m else 1
s=re.sub(r'versionCode\s*=\s*\d+',f'versionCode = {code}',s,1)
s=re.sub(r'versionName\s*=\s*"[^"]*"',f'versionName = "{ver}"',s,1)
open(p,"w",encoding="utf-8").write(s)
print(f"  Android versionCode={code} versionName={ver}")
PY
  VER="$VERSION"
fi

USCRIPT="$ROOT/ykt-helper/dist/YuketangStudio-$VER.user.js"
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"

# ---------- 构建 ----------
if [ "$ONLY" != "android" ]; then
  step "构建用户脚本"
  ( cd "$ROOT/ykt-helper" && npm run build )
  [ -f "$USCRIPT" ] || { echo "❌ 产物缺失：$USCRIPT"; exit 1; }
  ok "$(basename "$USCRIPT")"
fi

if [ "$ONLY" != "userscript" ]; then
  step "构建 Android APK"
  if [ "$ONLY" = "all" ]; then
    cp "$USCRIPT" "$ROOT/android/app/src/main/assets/yuketangstudio.user.js"
    ok "已同步 userscript 到 assets"
  fi
  ( cd "$ROOT/android" && ./gradlew assembleRelease )
  [ -f "$APK" ] || { echo "❌ APK 缺失：$APK"; exit 1; }
  ok "$(basename "$APK") ($(du -h "$APK" | cut -f1))"
fi

if [ "$BUILD_ONLY" = 1 ]; then
  echo; echo "✅ 构建完成（--build-only，未提交/未发布）"
  exit 0
fi

# ---------- 提交 ----------
step "提交改动"
git -C "$ROOT" add -A
if [ -z "$(git -C "$ROOT" status --porcelain)" ]; then
  ok "没有需要提交的改动"
else
  git -C "$ROOT" commit -m "release: v$VER（$CHANNEL）" >/dev/null
  ok "已提交"
fi

# ---------- tag ----------
if [ "$DO_TAG" = 1 ]; then
  step "创建 tag v$VER"
  if git -C "$ROOT" rev-parse "v$VER" >/dev/null 2>&1; then
    warn "tag v$VER 已存在，跳过创建"
  else
    git -C "$ROOT" tag -a "v$VER" -m "v$VER"
    ok "已创建 v$VER"
  fi
  git -C "$ROOT" push origin main
  git -C "$ROOT" push origin "v$VER"
  ok "已推送 main + tag"
fi

# ---------- GitHub Release ----------
if [ "$DO_GH" = 1 ]; then
  step "GitHub Release"
  TMP="$(mktemp -d)"
  ASSETS=()
  if [ -f "$USCRIPT" ]; then cp "$USCRIPT" "$TMP/YTS-$VER.user.js"; ASSETS+=("$TMP/YTS-$VER.user.js"); fi
  if [ -f "$APK" ]; then cp "$APK" "$TMP/YTS-$VER.apk"; ASSETS+=("$TMP/YTS-$VER.apk"); fi
  if gh release view "v$VER" >/dev/null 2>&1; then
    warn "Release v$VER 已存在，上传/覆盖资产"
    gh release upload "v$VER" "${ASSETS[@]}" --clobber
  else
    gh release create "v$VER" "${ASSETS[@]}" --title "v$VER" --notes "${NOTES:-v$VER 更新}"
  fi
  ok "GitHub Release：https://github.com/RayMorTwinkle/YuketangStudio/releases/tag/v$VER"
  rm -rf "$TMP"
fi

# ---------- 国内渠道 ----------
if [ "$DO_DOMESTIC" = 1 ]; then
  step "上传国内渠道（$CHANNEL）"
  ARGS=()
  [ -f "$APK" ] && ARGS+=("$APK")
  [ "$CHANNEL" = "stable" ] && ARGS+=("--stable")
  ( cd "$ROOT/ykt-helper" && PUBLISH_NOTES="${NOTES:-v$VER 更新}" bash scripts/publish-domestic.sh "${ARGS[@]}" )
fi

echo
echo "✅ 完成：v$VER（$CHANNEL）"
echo "   脚本：$USCRIPT"
echo "   APK ：$APK"
