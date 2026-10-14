---
name: dsh-speed-up-perf
description: DSHプラグインの起動、設定画面、Session処理、network、描画の性能を計測し、動作と所有関係を保って改善する。
license: MIT
---

# 利用経路の性能改善

利用者が遅いと感じる操作、対象版、入力規模、計測する時間・CPU・memoryを決めます。大きなfileや疑わしいloopだけでbottleneckと断定しません。

## 先に計測する

起動、設定表示、検索、model選択、会話の描画、reloadなど、productionのconsumerを通す条件で測ります。件数、byte、turn、tool、child、DOM数、cold/warmを、測る目的に応じて変えます。

同じ環境・入力・観測方法でbefore/afterを比較します。計測がない推定と、実測した値を分けます。極小の同じfixtureだけで、長いSessionや実画面を代表させません。

## 減らす処理を選ぶ

不要な全件fold、subscription、polling、再描画、重複要求、I/Oを追います。DSHのprojection・selector・共有処理で済む部分を、独自event購読とscanで再実装しません。

cacheには対象identity、失効、同時要求、取消、容量、秘密情報の分離を持たせます。性能改善でモデルに渡る履歴、保存完了、権限、結果を変えません。

## 確認と報告

観測した改善と、安定した動作を別に確認します。OFF/ON、再起動、失敗・取消でも資源が残らないことを該当箇所で確認します。

入力・環境・回数・ばらつきと、未検証の大きい条件を報告します。benchmarkの閾値や常設CI gateは、維持する目的と根拠がある場合に追加します。
