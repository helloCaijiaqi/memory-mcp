# 图像解码辅助（image-phash.js 的子进程解码器）：
# 用 Windows 内置 System.Drawing 把任意格式图片（png/jpg/gif 首帧/webp…）解码为
# 32×32 灰度阵。透明像素平铺到纯白底（表情包 pHash 预处理的关键：固定平铺色，
# 否则同一张透明底图哈希漂移）。stdout 两行：第 1 行 "宽x高"，第 2 行 1024 个灰度值 CSV。
param([string]$Path)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($Path)
  $N = 32
  $bmp = New-Object System.Drawing.Bitmap($N, $N)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($img, 0, 0, $N, $N)
  $g.Dispose()
  [Console]::Out.WriteLine(('{0}x{1}' -f $img.Width, $img.Height))
  $vals = New-Object System.Text.StringBuilder
  for ($y = 0; $y -lt $N; $y++) {
    for ($x = 0; $x -lt $N; $x++) {
      $p = $bmp.GetPixel($x, $y)
      $gray = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B + 0.5)
      [void]$vals.Append($gray)
      if (-not ($y -eq ($N - 1) -and $x -eq ($N - 1))) { [void]$vals.Append(',') }
    }
  }
  [Console]::Out.WriteLine($vals.ToString())
  $bmp.Dispose()
  $img.Dispose()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
