# capture-region.ps1 -- DSH MC agent: fixed-rectangle screen capture + coarse frame diff.
#
# Two deliberate design choices, both learned the hard way:
#   1. PURE ASCII, no BOM. Windows PowerShell 5.1 reads .ps1 as ANSI unless the file has a
#      UTF-8 BOM; a Chinese comment would come back as mojibake and can break parsing.
#   2. ALL output goes to -Result (a JSON file), never to stdout. The caller runs us with
#      stdio ignored, so a pipe can never deadlock or hit a sandbox EPERM.
#
# Used by extensions/mc_danmaku.mjs. Can be run by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-region.ps1 `
#     -Out shot.png -Result shot.json -X 40 -Y 300 -W 420 -H 640
#
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Result,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 800,
  [int]$H = 400,
  [int]$MaxWidth = 0,          # >0 and the shot is wider: downscale before saving (layout preview)
  [string]$Prev = '',          # previous PNG; when given we also compute a coarse diff ratio
  [int]$GridX = 60,            # diff sampling grid, columns
  [int]$GridY = 20,            # diff sampling grid, rows
  [int]$Threshold = 18         # per-channel delta that counts as "this sample changed"
)

$ErrorActionPreference = 'Stop'
$ticks = [System.Diagnostics.Stopwatch]::StartNew()

$state = @{
  ok        = $false
  out       = $Out
  x         = $X
  y         = $Y
  w         = $W
  h         = $H
  savedW    = 0
  savedH    = 0
  diff      = $null
  prevFound = $false
  ms        = 0
  error     = $null
}

function Save-Result([hashtable]$o) {
  $json = $o | ConvertTo-Json -Compress -Depth 6
  # UTF8Encoding($false) => no BOM. A BOM here makes JSON.parse() in Node throw.
  $enc = New-Object System.Text.UTF8Encoding($false)
  $dir = [System.IO.Path]::GetDirectoryName($Result)
  if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
    [void][System.IO.Directory]::CreateDirectory($dir)
  }
  [System.IO.File]::WriteAllText($Result, $json, $enc)
}

try {
  Add-Type -AssemblyName System.Drawing

  # DPI awareness BEFORE any capture: without it the process is virtualized and a receiver
  # running at 125%/150% scaling gets a wrong (cropped) rectangle -- the single most common
  # "my screenshot is offset" bug.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshScreen {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
  [void][DshScreen]::SetProcessDPIAware()

  # SM_XVIRTUALSCREEN 76 / SM_YVIRTUALSCREEN 77 / SM_CXVIRTUALSCREEN 78 / SM_CYVIRTUALSCREEN 79
  $vsx = [DshScreen]::GetSystemMetrics(76)
  $vsy = [DshScreen]::GetSystemMetrics(77)
  $vsw = [DshScreen]::GetSystemMetrics(78)
  $vsh = [DshScreen]::GetSystemMetrics(79)
  if ($vsw -le 0 -or $vsh -le 0) { $vsx = 0; $vsy = 0; $vsw = 1920; $vsh = 1080 }
  $state.screen = @{ x = $vsx; y = $vsy; w = $vsw; h = $vsh }

  if ($W -lt 1) { $W = 1 }
  if ($H -lt 1) { $H = 1 }
  # Clamp into the virtual desktop. CopyFromScreen does not throw on an out-of-range rect,
  # it just returns black pixels -- which would look to the model like "an empty comment area".
  if ($X -lt $vsx) { $X = $vsx }
  if ($Y -lt $vsy) { $Y = $vsy }
  if ($X + $W -gt $vsx + $vsw) { $W = $vsx + $vsw - $X }
  if ($Y + $H -gt $vsy + $vsh) { $H = $vsy + $vsh - $Y }
  if ($W -lt 1 -or $H -lt 1) { throw "region is outside the virtual desktop ($vsx,$vsy ${vsw}x${vsh})" }
  $state.x = $X; $state.y = $Y; $state.w = $W; $state.h = $H

  $bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $g.Dispose()
  }

  if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
    $ratio = $MaxWidth / $bmp.Width
    $nw = [int][Math]::Round($bmp.Width * $ratio)
    $nh = [int][Math]::Round($bmp.Height * $ratio)
    if ($nw -lt 1) { $nw = 1 }
    if ($nh -lt 1) { $nh = 1 }
    $small = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gs = [System.Drawing.Graphics]::FromImage($small)
    try {
      $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $gs.DrawImage($bmp, 0, 0, $nw, $nh)
    } finally {
      $gs.Dispose()
      $bmp.Dispose()
    }
    $bmp = $small
  }

  $outDir = [System.IO.Path]::GetDirectoryName($Out)
  if ($outDir -and -not [System.IO.Directory]::Exists($outDir)) {
    [void][System.IO.Directory]::CreateDirectory($outDir)
  }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

  # Coarse diff: sample a grid instead of every pixel (60x20 = 1200 GetPixel calls, ~ms).
  # The point is not image fidelity, it is "did the comment area scroll since last time".
  if ($Prev -and (Test-Path -LiteralPath $Prev)) {
    $state.prevFound = $true
    try {
      $pb = [System.Drawing.Bitmap]::FromFile($Prev)
      try {
        if ($pb.Width -ne $bmp.Width -or $pb.Height -ne $bmp.Height) {
          $state.diff = 1.0
        } else {
          $tot = 0
          $hit = 0
          for ($i = 0; $i -lt $GridX; $i++) {
            $px = [int](($i + 0.5) * $bmp.Width / $GridX)
            if ($px -ge $bmp.Width) { $px = $bmp.Width - 1 }
            for ($j = 0; $j -lt $GridY; $j++) {
              $py = [int](($j + 0.5) * $bmp.Height / $GridY)
              if ($py -ge $bmp.Height) { $py = $bmp.Height - 1 }
              $a = $bmp.GetPixel($px, $py)
              $b = $pb.GetPixel($px, $py)
              $tot++
              if ([Math]::Abs($a.R - $b.R) -gt $Threshold -or
                  [Math]::Abs($a.G - $b.G) -gt $Threshold -or
                  [Math]::Abs($a.B - $b.B) -gt $Threshold) { $hit++ }
            }
          }
          if ($tot -gt 0) { $state.diff = [Math]::Round($hit / $tot, 4) }
        }
      } finally {
        $pb.Dispose()
      }
    } catch {
      # An unreadable previous frame must not fail the capture: no diff means "assume changed".
      $state.diff = $null
      $state.prevFound = $false
    }
  }

  $state.savedW = $bmp.Width
  $state.savedH = $bmp.Height
  $bmp.Dispose()

  $state.ok = $true
  $state.ms = $ticks.ElapsedMilliseconds
  Save-Result $state
  exit 0
} catch {
  $state.ok = $false
  $state.error = $_.Exception.Message
  $state.ms = $ticks.ElapsedMilliseconds
  try { Save-Result $state } catch { }
  exit 1
}
