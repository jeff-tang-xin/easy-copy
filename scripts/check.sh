#!/usr/bin/env bash
# Easy-Copy 一键检查脚本
# 用法：bash scripts/check.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== TypeScript 检查 ==="
pnpm tsc --noEmit 2>&1 | head -50
TS_EXIT=$?
echo ""

echo "=== Rust 编译检查 ==="
cd src-tauri
cargo check --message-format=short 2>&1 | head -80
CARGO_EXIT=$?
echo ""

echo "=== Rust Clippy ==="
cargo clippy --message-format=short -- -D warnings 2>&1 | head -80
CLIPPY_EXIT=$?
echo ""

cd "$ROOT"

echo "========== 汇总 =========="
echo "TypeScript: $([ $TS_EXIT -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Cargo check: $([ $CARGO_EXIT -eq 0 ] && echo 'PASS' || echo 'FAIL')"
echo "Clippy: $([ $CLIPPY_EXIT -eq 0 ] && echo 'PASS' || echo 'FAIL')"

if [ $TS_EXIT -ne 0 ] || [ $CARGO_EXIT -ne 0 ] || [ $CLIPPY_EXIT -ne 0 ]; then
  exit 1
fi
