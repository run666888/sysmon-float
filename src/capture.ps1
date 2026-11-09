param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][int]$OwnerProcessId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 保存一张不含悬浮窗的桌面底图。窗口显示时只改变裁切位置，
# 隐藏到托盘后刷新底图。显示期间不写入截屏，彻底避免位置通知延迟造成重影。
$atlas = $null
$atlasGraphics = $null
$atlasDisplay = ''
$lastOwnerCheck = [DateTime]::MinValue
$lastErrorText = ''
$lastWindowKey = ''
$lastSent = [DateTime]::MinValue
$wasVisible = $false
$lastHiddenCapture = [DateTime]::MinValue

while ($true) {
  if (([DateTime]::UtcNow - $lastOwnerCheck).TotalSeconds -ge 2) {
    if (-not (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)) { break }
    $lastOwnerCheck = [DateTime]::UtcNow
  }

  try {
    if (-not [IO.File]::Exists($RequestPath)) {
      Start-Sleep -Milliseconds 120
      continue
    }
    $request = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    $display = $request.display
    $window = $request.window
    $dx = [int]$display.x
    $dy = [int]$display.y
    $dw = [int]$display.width
    $dh = [int]$display.height
    if ($dw -le 0 -or $dh -le 0) {
      Start-Sleep -Milliseconds 120
      continue
    }

    $displayKey = "$dx,$dy,$dw,$dh"
    $windowKey = "$($window.x),$($window.y),$($window.width),$($window.height)"
    if ($initialized -and -not $request.visible -and -not $wasVisible -and
        $displayKey -eq $atlasDisplay -and ([DateTime]::UtcNow - $lastHiddenCapture).TotalSeconds -lt 3) {
      Start-Sleep -Milliseconds 200
      continue
    }
    if ($initialized -and $request.visible -and $displayKey -eq $atlasDisplay -and
        $windowKey -eq $lastWindowKey -and ([DateTime]::UtcNow - $lastSent).TotalSeconds -lt 1) {
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($displayKey -ne $atlasDisplay) {
      if ($request.visible) {
        # 换屏时先等主进程隐藏窗口，再建立新显示器的干净底图。
        Start-Sleep -Milliseconds 120
        continue
      }
      if ($atlasGraphics) { $atlasGraphics.Dispose() }
      if ($atlas) { $atlas.Dispose() }
      $atlas = New-Object System.Drawing.Bitmap($dw, $dh)
      $atlasGraphics = [System.Drawing.Graphics]::FromImage($atlas)
      $atlasDisplay = $displayKey
      $initialized = $false
    }

    if (-not $initialized -or -not $request.visible) {
      $current = New-Object System.Drawing.Bitmap($dw, $dh)
      $currentGraphics = [System.Drawing.Graphics]::FromImage($current)
      try {
        $currentGraphics.CopyFromScreen(
          (New-Object System.Drawing.Point($dx, $dy)),
          [System.Drawing.Point]::Empty,
          $current.Size
        )
        # 初次取景在窗口显示之前完成；隐藏到托盘时刷新整张底图。
        $atlasGraphics.DrawImageUnscaled($current, 0, 0)
        $initialized = $true
        $lastHiddenCapture = [DateTime]::UtcNow
      } finally {
        $currentGraphics.Dispose()
        $current.Dispose()
      }
    }

    $padding = 28
    $left = [Math]::Max($dx, [int]$window.x - $padding)
    $top = [Math]::Max($dy, [int]$window.y - $padding)
    $right = [Math]::Min($dx + $dw, [int]$window.x + [int]$window.width + $padding)
    $bottom = [Math]::Min($dy + $dh, [int]$window.y + [int]$window.height + $padding)
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) {
      Start-Sleep -Milliseconds 120
      continue
    }

    $frame = New-Object System.Drawing.Bitmap($width, $height)
    $frameGraphics = [System.Drawing.Graphics]::FromImage($frame)
    $memory = New-Object System.IO.MemoryStream
    try {
      $source = [System.Drawing.Rectangle]::new(($left - $dx), ($top - $dy), $width, $height)
      $target = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
      $frameGraphics.DrawImage($atlas, $target, $source, [System.Drawing.GraphicsUnit]::Pixel)
      $frame.Save($memory, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $packet = @{
        capture = @{ x = $left; y = $top; width = $width; height = $height }
        window = @{ x = [int]$window.x; y = [int]$window.y; width = [int]$window.width; height = [int]$window.height }
        data = [Convert]::ToBase64String($memory.ToArray())
      } | ConvertTo-Json -Compress -Depth 3
      [Console]::Out.WriteLine($packet)
      $lastWindowKey = $windowKey
      $lastSent = [DateTime]::UtcNow
      $wasVisible = [bool]$request.visible
    } finally {
      $memory.Dispose()
      $frameGraphics.Dispose()
      $frame.Dispose()
    }
  } catch {
    $errorText = $_.Exception.Message
    if ($errorText -ne $lastErrorText) {
      [Console]::Error.WriteLine($errorText)
      $lastErrorText = $errorText
    }
  }
  Start-Sleep -Milliseconds 170
}

if ($atlasGraphics) { $atlasGraphics.Dispose() }
if ($atlas) { $atlas.Dispose() }
