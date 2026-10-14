---
name: dsh-pre-push-checks
description: DSHプラグインのpushや検証報告の前に、差分、対象packageとCIから必要なローカル確認を選んで実行する。
license: MIT
---

# 差分に合う検証

実際のremote、base・head、未commitの変更を確認します。対象の `package.json`、lockfile、CI、既存テストからコマンドを選びます。DSH本体の検証コマンドが独立pluginにもあると仮定しません。

## 検証を選ぶ

| 変更 | 選ぶ確認 |
| --- | --- |
| 型・runtime処理 | 対象のtypecheck、lint、回帰を再現するテスト |
| lifecycle・通信・保存 | generation、取消、部分失敗、解除、再起動の該当経路 |
| Host/Client entry・exports・build | build、packの中身、隔離DSHでの導入・登録smoke |
| UI・locale | buildと実画面の操作、狭い内容幅、明暗・日本語、変更した期待値 |
| provider | keyless adapter確認、必要な実API smoke。鍵がなければ未検証 |
| 配布・更新 | tag/tarball、旧版からの導入、ON/OFF・保存値、再起動後の実行版 |
| 文書・Skills | 例と根拠、Markdownリンク、frontmatter、同梱参照とlicense |

全suite・全OSを毎回ローカルで回すのではなく、差分の境界を確かめます。失敗、新しい変更、base更新が結果を無効にした場合に確認を広げます。

## 結果とpush

成功した検証をcommit・pushのためだけに繰り返しません。自動修正や生成物で差分が変わったら、関連する確認を見直します。

失敗は原因と対象を調べ、検証を消して通過扱いにしません。missing SDK・鍵・OSと、動作の失敗を区別します。

履歴の書換えが依頼・作業範囲に含まれる場合はremoteの現在値を確認し、必要なら `--force-with-lease` を使います。報告は実行コマンド、結果、確認版、残る未検証を示します。
