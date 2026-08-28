# ============================================================
# Easy-Copy — one-shot build/quality check (Windows PowerShell).
# Runs TypeScript type-check, Rust cargo check, and clippy.
# Exits non-zero on the first failure so CI can catch it.
# ============================================================

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " 1/3  TypeScript (tsc --noEmit)" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
pnpm tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "✅ TypeScript OK" -ForegroundColor Green

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " 2/3  Rust (cargo check)" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Set-Location src-tauri
cargo check --message-format=short
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "✅ cargo check OK" -ForegroundColor Green

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " 3/3  Rust (cargo clippy)" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
cargo clippy --message-format=short -- -D warnings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "✅ clippy OK" -ForegroundColor Green

Write-Host ""
Write-Host "🎉 All checks passed!" -ForegroundColor Green
