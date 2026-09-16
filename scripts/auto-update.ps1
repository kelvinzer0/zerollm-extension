# ZeroLLM Extension Auto-Updater PowerShell
$RepoDir = Split-Path -Parent $PSScriptRoot
Set-Location $RepoDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "⚡ ZeroLLM Extension Auto-Updater Active" -ForegroundColor Green
Write-Host "📁 Directory: $RepoDir" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan

while ($true) {
    try {
        git fetch origin main --quiet 2>$null
        $Local = git rev-parse HEAD 2>$null
        $Remote = git rev-parse origin/main 2>$null
        if ($Local -and $Remote -and ($Local -ne $Remote)) {
            $Time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Write-Host "[$Time] 🚀 Update baru ditemukan di GitHub! Memperbarui..." -ForegroundColor Cyan
            git pull origin main
            Write-Host "[$Time] ✅ Berhasil diperbarui ke versi terbaru!" -ForegroundColor Green
        }
    } catch {
        # Abaikan galat jaringan sementara
    }
    Start-Sleep -Seconds 60
}
