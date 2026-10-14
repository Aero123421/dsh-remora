---
name: dsh-code-review
description: 独立したDSHプラグインのPR・commit・差分をレビューし、動作、解除、権限、保存、配布と検証の問題を根拠付きで報告する。
license: MIT
---

# プラグインのレビュー

レビュー対象のbase・headを確認し、差分とその呼出し元・consumerを読みます。依頼がレビューだけなら指摘を返し、修正・push・Issue投稿・merge・releaseへ広げません。

## 追う経路

- 公開manifest、patch、Host/Client entry、依存と対象DSHのAPIを追います。Loaderへの登録が成功しても、実agentのtoolやUIから使えるとは限りません。
- 呼出し、入力検証、保存、外部副作用、結果表示、取消、解除をつなぎます。内部の型チェックだけでfile・wire・model入力の検証を代替しません。
- 世代が変わった認証・接続・編集の結果、同期throw、途中切断、保存失敗、再起動・再送を確認します。
- 共有namespace、CSS、route、tool、processを他pluginと併用したときの登録順・OFF/ON・復元を見ます。
- 更新は候補取得、配布物検査、manager導入、結果照合、再起動後の実行版を分けます。設定・資格情報・OFF状態の維持を確認します。
- GitHub tagと実tarballのentry・patch・資源、旧設定のmigration、利用者の導入手順を照合します。

## 指摘と検証

動作不良、データ損失、権限の変化、解除漏れ、配布不能を優先します。指摘には対象file・行、発生条件、結果、根拠を付けます。推測なら、その条件と追加で必要な観測を示します。styleの好みを障害として数えません。

差分に合うテスト・build・導入smokeを選びます。作者やCIの報告と、自分が実行した結果を分けます。レビュー途中でheadやbaseが変わった場合は、指摘と成功済み検証がどの変更へ有効かを見直します。

修正が依頼された場合は再現条件から直し、関連検証と修正後のdiffを確認します。既存Issue・PRへ報告する指示がある場合も、closed・merged・公開・利用者確認を同一視しません。

事例: [レビューの進め方](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/review.md)、[Issueから解決まで](https://github.com/Aero123421/dsh-plginreview/blob/main/docs/workflow/resolution.md)。
