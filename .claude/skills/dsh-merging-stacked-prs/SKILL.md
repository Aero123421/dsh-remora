---
name: dsh-merging-stacked-prs
description: 依存関係のあるDSHプラグインのPRを、現在のbase・head、検証、公開順序に合わせてマージする。
license: MIT
---

# 依存するPRのマージ

マージが依頼された範囲で、PRの依存関係、remote、base・head、未公開の変更を確認します。複数の無関係なPRを、名前の近さだけでstackへまとめません。

## 順序と検証

依存する下位PRから順に、今の差分と必要なchecksを確認します。GitHubのstack機能が実際に使われている場合は、その状態とルールに従います。普通のPRへstack機能やextensionを必須にしません。

baseが別のopen PRなら、下位を取り込んだ後に上位のbaseと差分を見直します。親の変更が上位へ残ったり、必要な修正が消えたりしていないか確認します。競合解消やbase更新が影響する検証は再実行します。

確認したheadとmerge対象を一致させます。新しいcommitが入った場合はその差分を確認し、checksやreviewが古いheadの結果なら成功として流用しません。

## 履歴と公開

merge method、base変更、必要なbranch更新は対象の方針へ合わせます。履歴を書き換える場合はremoteの現在値を確認し、leaseで他の更新を保護します。他人のbranchの再構成や削除を、マージのついでに行いません。

マージ後はPR状態と、実際のマージ先baseのcommit・treeを確認します。Releaseが依頼されている場合だけ、テストした公開物・tag・assetへ進みます。mergeだけで利用者へ配布済みとは報告しません。
