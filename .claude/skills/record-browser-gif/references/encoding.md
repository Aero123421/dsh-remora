# ffmpegでの変換例

ffmpegが使える場合のローカル変換例です。`recording.mp4` を実際の録画fileに置き換え、開始時刻・長さ・幅を録画内容に合わせます。

```sh
ffmpeg -ss 0 -t 12 -i recording.mp4 \
  -filter_complex '[0:v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse' \
  -loop 0 demo.gif
```

幅を縮めてラベルが読めなくなる場合は、画面の撮り方を見直すか寸法を調整します。再生速度を変える場合は元の動作時間との差を示します。停止直前のframeや確認が必要なエラーを、短くするためだけに消しません。

出力を実際に開いて再生し、最初と最後、操作の結果、文字の読みやすさを確認します。この変換例の記載は、対象プラグインの録画や再生確認を実施したことを意味しません。
